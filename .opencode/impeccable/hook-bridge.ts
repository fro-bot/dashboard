/**
 * Pure, Node-testable core of the Impeccable OpenCode bridge.
 *
 * Mirrors `.github/hooks/impeccable.json`: after a file-mutating tool call,
 * pipe a hook.mjs-shaped event to `.agents/skills/impeccable/scripts/hook.mjs`
 * over stdin and surface any findings back to the agent in the same turn.
 *
 * Advisory only — never blocks a tool call. Fail-loud: each kind of degraded
 * outcome emits one warning per plugin instance instead of silently doing
 * nothing. Only parsed PostToolUse feedback and fixed warning text reach the
 * agent; raw hook stdout and stderr never do.
 *
 * This module must NOT import from `@opencode-ai/plugin`. The subprocess runner
 * uses `node:child_process`, so it behaves the same under the Bun host and under
 * Node tests. The OpenCode plugin loader iterates a plugin module's exports and
 * treats each as a candidate plugin factory, so `.opencode/impeccable/plugin.ts`
 * must export ONLY the plugin factory. Everything else lives here.
 */

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

/**
 * The value `hook.mjs`'s `resolveHarness()` reads via the `IMPECCABLE_HOOK_HARNESS`
 * env override. Our payload is claude-shaped
 * (`tool_name`/`tool_input.file_path`/`tool_input.command`), and
 * `normalizeHookEvent(event, cwd, 'claude')` passes claude-harness events
 * through UNCHANGED (hook-lib.mjs: `if (harness !== 'cursor') return event`).
 * 'github' would instead route through `normalizeGitHubEvent`, which expects
 * camelCase `toolName`/`toolArgs` and would only work by incidental spread of
 * our pre-set `tool_input` — silently dropping apply_patch multi-file parsing.
 */
export const IMPECCABLE_HOOK_HARNESS = 'claude'

/** Absolute-worktree-relative path to the shared hook script, matching `.github/hooks/impeccable.json`. */
export const HOOK_SCRIPT_RELATIVE_PATH = '.agents/skills/impeccable/scripts/hook.mjs'

/** Matches the Copilot hook's `timeoutSec: 5`. */
export const DETECTOR_TIMEOUT_MS = 5000

/** Time between SIGTERM and SIGKILL when the hook subprocess exceeds its timeout. */
export const DETECTOR_KILL_GRACE_MS = 2000

/** Time past timeout plus grace after which the runner resolves even if the child still holds its pipes open. */
export const DETECTOR_DEADLINE_SLACK_MS = 500

/** Most bytes kept from each of the child's stdout and stderr. */
export const DETECTOR_MAX_OUTPUT_BYTES = 1024 * 1024

const MUTATING_BASE_TOOLS = new Set(['edit', 'write', 'apply_patch'])
const MUTATING_SUFFIX_RE = /_(edit|write|apply_patch)$/

/** True for bare (`edit`/`write`/`apply_patch`) and MCP-namespaced-suffixed (`aft_edit`, `x_write`, …) mutating tool names. */
export function isMutatingTool(tool: string): boolean {
  if (typeof tool !== 'string' || !tool) return false
  if (MUTATING_BASE_TOOLS.has(tool)) return true
  return MUTATING_SUFFIX_RE.test(tool)
}

const APPLY_PATCH_FILE_LINE_RE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm
const APPLY_PATCH_MOVE_TO_RE = /^\*\*\* Move to: (.+)$/gm
const APPLY_PATCH_ADD_OR_UPDATE_RE = /^\*\*\* (?:Add File|Update File): (.+)$/gm

/** Arg keys `extractTouchedPaths` reads: `filePath` for edit/write, `patchText` for apply_patch. */
const PATH_ARG_KEYS = ['filePath', 'patchText'] as const

function parseApplyPatchPaths(patchText: string): string[] {
  const out: string[] = []
  for (const match of patchText.matchAll(APPLY_PATCH_FILE_LINE_RE)) {
    const p = (match[1] ?? '').trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/**
 * The vendored `hook-lib.mjs` `parseApplyPatchPaths` recognizes only
 * `*** Add File:` and `*** Update File:` markers, not `*** Move to:`, so a
 * rename's destination would never be scanned. This appends one synthetic
 * `*** Update File: <dest>` marker per distinct Move-to destination that no
 * Add or Update marker already covers. The original patch text is kept
 * verbatim and the markers are appended after it, so the vendored script's
 * own parsing of the patch is not disturbed.
 */
function withMoveToScanMarkers(patchText: string): string {
  const covered = new Set<string>()
  for (const match of patchText.matchAll(APPLY_PATCH_ADD_OR_UPDATE_RE)) {
    const p = (match[1] ?? '').trim()
    if (p) covered.add(p)
  }

  const destinations: string[] = []
  for (const match of patchText.matchAll(APPLY_PATCH_MOVE_TO_RE)) {
    const p = (match[1] ?? '').trim()
    if (p && !covered.has(p) && !destinations.includes(p)) destinations.push(p)
  }

  if (destinations.length === 0) return patchText
  return `${patchText}\n${destinations.map((p) => `*** Update File: ${p}`).join('\n')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Pulls the file path(s) a tool call touched from its args: `filePath` for edit/write, patch marker lines for `apply_patch`. Returns `[]` for missing/malformed args. */
export function extractTouchedPaths(tool: string, args: unknown): string[] {
  if (!isRecord(args)) return []

  if (tool === 'apply_patch' || MUTATING_SUFFIX_RE.exec(tool)?.[1] === 'apply_patch') {
    const patchText = args.patchText
    if (typeof patchText === 'string' && patchText) return parseApplyPatchPaths(patchText)
    return []
  }

  const filePath = args.filePath
  if (typeof filePath === 'string' && filePath) return [filePath]
  return []
}

/** Strips an MCP namespace prefix (`aft_edit`→`edit`) so `tool_name` matches the bare form hook.mjs's `resolveTargetFiles` special-cases (`tool_name === 'apply_patch'` exactly). Passes bare names and non-mutating names through unchanged. */
export function bareToolName(tool: string): string {
  const match = MUTATING_SUFFIX_RE.exec(tool)
  return match?.[1] ?? tool
}

export interface BuildHookPayloadInput {
  tool: string
  args: unknown
  cwd: string
  sessionID: string
}

/**
 * Shapes the stdin JSON `hook.mjs` reads. `tool_name` is normalized to its
 * bare form. For `apply_patch` (bare or MCP-suffixed), `tool_input.command`
 * carries the raw patch text so hook.mjs's own `parseApplyPatchPaths` can
 * extract every touched file — hook.mjs only reads `tool_input.command` when
 * `tool_name === 'apply_patch'` exactly, so a `file_path`-only payload would
 * silently drop all but incidental files. Rename destinations are appended as
 * Update markers (see `withMoveToScanMarkers`). For edit/write, `tool_input.file_path`
 * carries the first touched path.
 */
export function buildHookPayload(input: BuildHookPayloadInput): {
  tool_name: string
  tool_input: { file_path: string } | { command: string }
  cwd: string
  session_id: string
} {
  const bareName = bareToolName(input.tool)

  let toolInput: { file_path: string } | { command: string }
  if (bareName === 'apply_patch') {
    const args = isRecord(input.args) ? input.args : {}
    const patchText = typeof args.patchText === 'string' ? args.patchText : ''
    toolInput = { command: withMoveToScanMarkers(patchText) }
  } else {
    const [firstPath] = extractTouchedPaths(input.tool, input.args)
    toolInput = { file_path: firstPath ?? '' }
  }

  return {
    tool_name: bareName,
    tool_input: toolInput,
    cwd: input.cwd,
    session_id: input.sessionID,
  }
}

/**
 * Outcome of one hook subprocess run. Every outcome is a value; a runner never rejects.
 *
 * - `ok`: the child exited 0 within its deadline.
 * - `timeout`: the child ran past its deadline, or exited without releasing its pipes. Output captured so far is carried.
 * - `spawn-error`: the child could not be started (missing script, missing executable, bad cwd).
 * - `nonzero-exit`: the child exited nonzero, or was killed by a signal it was not sent by the runner (`exitCode` is -1).
 * - `overflow`: the child wrote more than the cap to stdout or stderr. The result carries at most the cap from each stream.
 */
export type DetectorRunResult =
  | { kind: 'ok'; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'spawn-error'; message: string }
  | { kind: 'nonzero-exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'overflow'; stdout: string; stderr: string }

/** Injectable subprocess runner: given the hook payload and the worktree cwd, resolves with the outcome of one hook run. */
export type DetectorRunner = (
  payload: ReturnType<typeof buildHookPayload>,
  opts: { worktree: string },
) => Promise<DetectorRunResult>

export interface CreateHookOptions {
  runDetector: DetectorRunner
  worktree: string
}

export interface CreateSpawnRunnerOptions {
  /** Absolute path to `hook.mjs` (or an ephemeral test fixture). */
  scriptPath: string
  /** Time before the child is sent SIGTERM. Defaults to `DETECTOR_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Time between SIGTERM and SIGKILL. Defaults to `DETECTOR_KILL_GRACE_MS`. */
  killGraceMs?: number
  /** Time past timeout plus grace at which the runner resolves regardless of the child's pipes. Defaults to `DETECTOR_DEADLINE_SLACK_MS`. */
  deadlineSlackMs?: number
  /** Most bytes kept from each of stdout and stderr. Defaults to `DETECTOR_MAX_OUTPUT_BYTES`. */
  maxOutputBytes?: number
  /** Node executable to spawn. Defaults to literal `node`; override only for tests. */
  nodeExecutable?: string
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function noop(): void {}

/**
 * Real `node:child_process.spawn` runner: `node <scriptPath>` (no shell, a
 * literal `node` rather than `process.execPath`, which under a Bun host would
 * be Bun) with the payload piped over stdin and cwd at the worktree.
 *
 * The child inherits the environment minus both depth variables, with
 * `IMPECCABLE_HOOK_HARNESS=claude` and `IMPECCABLE_HOOK_QUIET=1` set. A depth
 * variable makes `hook.mjs` a no-op, so the bridge never sets one.
 *
 * Each of stdout and stderr is capped at `maxOutputBytes` of UTF-8. Excess
 * bytes are discarded as they arrive, and the run resolves `overflow`.
 *
 * This runner is the sole authority over the child's lifetime: SIGTERM at the
 * timeout, SIGKILL after the grace period, and a final deadline just past
 * both at which it resolves even if a child or grandchild still holds the
 * pipes open. A tool call therefore waits at most timeout + grace + slack.
 * Callers must not layer a second timeout on top of it.
 */
export function createSpawnRunner(options: CreateSpawnRunnerOptions): DetectorRunner {
  const timeoutMs = options.timeoutMs ?? DETECTOR_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? DETECTOR_KILL_GRACE_MS
  const deadlineSlackMs = options.deadlineSlackMs ?? DETECTOR_DEADLINE_SLACK_MS
  const maxOutputBytes = options.maxOutputBytes ?? DETECTOR_MAX_OUTPUT_BYTES
  const nodeExecutable = options.nodeExecutable ?? 'node'

  return async (payload, opts) => {
    try {
      await access(options.scriptPath)
    } catch (err) {
      return { kind: 'spawn-error', message: describeError(err) }
    }

    return new Promise<DetectorRunResult>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env }
      delete env.IMPECCABLE_HOOK_DEPTH
      delete env.CLAUDE_HOOK_DEPTH
      env.IMPECCABLE_HOOK_HARNESS = IMPECCABLE_HOOK_HARNESS
      env.IMPECCABLE_HOOK_QUIET = '1'

      let child: ReturnType<typeof spawn>
      try {
        child = spawn(nodeExecutable, [options.scriptPath], {
          cwd: opts.worktree,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        resolve({ kind: 'spawn-error', message: describeError(err) })
        return
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let started = false
      let timedOut = false
      let overflowed = false
      let settled = false
      let hardTimer: ReturnType<typeof setTimeout> | undefined
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined

      // A StringDecoder that is never flushed drops an incomplete trailing
      // multibyte sequence. Buffer#toString would turn it into U+FFFD, which is
      // longer than the bytes it replaces and could push the string past the cap.
      const decode = (chunks: Buffer[]): string => {
        const decoder = new StringDecoder('utf-8')
        return chunks.map((chunk) => decoder.write(chunk)).join('')
      }

      const captured = () => ({ stdout: decode(stdoutChunks), stderr: decode(stderrChunks) })

      // Keeps at most maxOutputBytes in total and returns the new byte count.
      const appendBounded = (chunks: Buffer[], currentBytes: number, chunk: Buffer): number => {
        const remaining = maxOutputBytes - currentBytes
        if (chunk.length > remaining) {
          overflowed = true
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
          return maxOutputBytes
        }
        chunks.push(chunk)
        return currentBytes + chunk.length
      }

      const signal = (name: NodeJS.Signals) => {
        try {
          child.kill(name)
        } catch {
          // The process may already have exited.
        }
      }

      const finish = (result: DetectorRunResult) => {
        if (settled) return
        settled = true
        if (hardTimer) clearTimeout(hardTimer)
        if (killTimer) clearTimeout(killTimer)
        if (deadlineTimer) clearTimeout(deadlineTimer)
        child.stdout?.removeAllListeners()
        child.stderr?.removeAllListeners()
        child.stdin?.removeAllListeners()
        child.removeAllListeners()
        // Late stream or process errors must not become uncaught exceptions once settled.
        child.stdout?.on('error', noop)
        child.stderr?.on('error', noop)
        child.stdin?.on('error', noop)
        child.on('error', noop)
        // Release our end of pipes a grandchild may still hold open.
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolve(result)
      }

      child.once('spawn', () => {
        started = true
      })

      child.on('error', (err) => {
        // Before 'spawn' this is a failure to start. After it, 'close' or the
        // final deadline settles the run.
        if (!started) finish({ kind: 'spawn-error', message: describeError(err) })
      })

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes = appendBounded(stdoutChunks, stdoutBytes, chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes = appendBounded(stderrChunks, stderrBytes, chunk)
      })

      child.on('close', (code: number | null) => {
        if (overflowed) {
          finish({ kind: 'overflow', ...captured() })
        } else if (timedOut) {
          // Exiting after the timeout, even cleanly via a handled SIGTERM, is not a clean scan.
          finish({ kind: 'timeout', ...captured() })
        } else if (code === 0) {
          finish({ kind: 'ok', ...captured() })
        } else {
          finish({ kind: 'nonzero-exit', exitCode: code ?? -1, ...captured() })
        }
      })

      hardTimer = setTimeout(() => {
        timedOut = true
        try {
          child.stdin?.end()
        } catch {
          // Stdin may already be closed.
        }
        signal('SIGTERM')
        killTimer = setTimeout(() => {
          signal('SIGKILL')
        }, killGraceMs)
      }, timeoutMs)

      deadlineTimer = setTimeout(
        () => {
          signal('SIGKILL')
          finish({ kind: 'timeout', ...captured() })
        },
        timeoutMs + killGraceMs + deadlineSlackMs,
      )

      // A child that exits without reading stdin can raise EPIPE on write. That is
      // not a spawn failure and must not crash the host.
      child.stdin?.on('error', noop)
      try {
        child.stdin?.end(JSON.stringify(payload))
      } catch {
        // If the write fails, the child's own error and close events settle the run.
      }
    })
  }
}

const FEEDBACK_OPEN = '\n\n<impeccable_feedback>\n'
const FEEDBACK_CLOSE = '\n</impeccable_feedback>'

/**
 * Strictly extracts the human-readable feedback text from hook.mjs's stdout.
 * Accepts ONLY the nested Claude-harness `PostToolUse` envelope:
 * `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`
 * with a non-empty string `additionalContext`.
 *
 * Every other shape returns `null`, so raw or malformed content never reaches
 * model-visible output: empty input, non-JSON text, non-object JSON, a missing
 * envelope, another event name, an empty or non-string `additionalContext`, and
 * `additionalContext` placed anywhere but inside `hookSpecificOutput`.
 */
export function extractFeedbackText(stdout: string): string | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (!isRecord(parsed)) return null

  const hookSpecificOutput = parsed.hookSpecificOutput
  if (!isRecord(hookSpecificOutput)) return null
  if (hookSpecificOutput.hookEventName !== 'PostToolUse') return null

  const additionalContext = hookSpecificOutput.additionalContext
  if (typeof additionalContext !== 'string' || !additionalContext) return null

  return additionalContext
}

/**
 * True when a mutating tool call should have yielded a path: the built-in
 * `edit`, `write` and `apply_patch`, or any other mutating tool whose args
 * carry a key `extractTouchedPaths` reads. A namespaced tool with no such key
 * is not known to touch a file the bridge can scan.
 */
function expectsPath(tool: string, args: unknown): boolean {
  if (MUTATING_BASE_TOOLS.has(tool)) return true
  return isRecord(args) && PATH_ARG_KEYS.some((key) => key in args)
}

type WarningKind =
  | 'timeout'
  | 'spawn-error'
  | 'nonzero-exit'
  | 'overflow'
  | 'stderr-on-clean'
  | 'malformed'
  | 'no-path'

const WARNING_MESSAGES = {
  timeout: '[impeccable] design hook timed out before finishing its scan',
  'spawn-error': '[impeccable] design hook could not be started',
  'nonzero-exit': '[impeccable] design hook did not run cleanly',
  overflow: '[impeccable] design hook produced more output than the bridge keeps',
  'stderr-on-clean': '[impeccable] design hook produced unexpected diagnostic output',
  malformed: '[impeccable] design hook returned unrecognized output',
  'no-path': '[impeccable] design hook skipped a file-changing tool call with no extractable path',
} as const satisfies Record<WarningKind, string>

/**
 * Builds the `tool.execute.after` handler, with the subprocess runner
 * injected so all logic here is testable under Node.
 *
 * The runner is the sole authority over its own timeout; this function never
 * races it with a second timer.
 *
 * Outcome table:
 *  - exit 0, empty stdout, empty stderr: a clean scan, silent.
 *  - exit 0, valid PostToolUse envelope: only its `additionalContext` is appended.
 *  - exit 0, empty stdout, non-empty stderr: `stderr-on-clean`.
 *  - exit 0, non-empty stdout that is not a valid envelope: `malformed`.
 *  - `timeout`, `spawn-error`, `nonzero-exit`, `overflow`: the matching warning kind.
 *  - a built-in `edit`/`write`/`apply_patch`, or a mutating tool with a path-like
 *    arg key, yielding no path: `no-path`, and the hook is not run. A mutating
 *    tool with no path-like arg key is silent and not run.
 *  - the runner rejecting, or any bridge fault: `spawn-error`.
 *
 * Each warning kind shows once per hook instance (one plugin process). Warning
 * text is fixed; hook stdout and stderr are never included. A non-string
 * `output.output` is left untouched and does not use up its kind. Never throws.
 */
export function createHook(options: CreateHookOptions) {
  const warned = new Set<WarningKind>()

  return async function toolExecuteAfter(
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ): Promise<void> {
    const append = (text: string): boolean => {
      if (typeof output.output !== 'string') return false
      try {
        output.output += `${FEEDBACK_OPEN}${text}${FEEDBACK_CLOSE}`
        return true
      } catch {
        // Fail-loud must never itself throw.
        return false
      }
    }

    const warnOnce = (kind: WarningKind) => {
      if (warned.has(kind)) return
      if (append(WARNING_MESSAGES[kind])) warned.add(kind)
    }

    try {
      if (!isMutatingTool(input.tool)) return

      const touchedPaths = extractTouchedPaths(input.tool, input.args)
      if (touchedPaths.length === 0) {
        // Silence is only right for an MCP tool that never carried a path.
        if (expectsPath(input.tool, input.args)) warnOnce('no-path')
        return
      }

      const payload = buildHookPayload({
        tool: input.tool,
        args: input.args,
        cwd: options.worktree,
        sessionID: input.sessionID,
      })

      let result: DetectorRunResult
      try {
        result = await options.runDetector(payload, { worktree: options.worktree })
      } catch {
        warnOnce('spawn-error')
        return
      }

      // Only a clean exit counts as a scan; every other outcome fails loud
      // rather than masquerading as a clean scan.
      if (result.kind !== 'ok') {
        warnOnce(result.kind)
        return
      }

      if (!result.stdout.trim()) {
        // Exit 0 with empty stdout is clean unless the child also wrote to stderr.
        if (result.stderr.trim()) warnOnce('stderr-on-clean')
        return
      }

      const feedback = extractFeedbackText(result.stdout)
      if (feedback === null) {
        warnOnce('malformed')
        return
      }

      append(feedback)
    } catch {
      warnOnce('spawn-error')
    }
  }
}
