/**
 * Pure, Node-testable core of the Impeccable OpenCode bridge.
 *
 * Mirrors `.github/hooks/impeccable.json`: after a file-mutating tool call,
 * pipe a hook.mjs-shaped event to `.agents/skills/impeccable/scripts/hook.mjs`
 * over stdin and surface any findings back to the agent in the same turn.
 *
 * Advisory only — never blocks a tool call. Fail-loud: bridge/parse failures
 * emit a one-time warning per session instead of silently doing nothing.
 *
 * This module must NOT import from `@opencode-ai/plugin`. The subprocess runner
 * uses `node:child_process`, so it behaves the same under the Bun host and under
 * Node tests. The OpenCode plugin loader iterates a plugin module's exports and
 * treats each as a candidate plugin factory, so `.opencode/impeccable/plugin.ts`
 * must export ONLY the plugin factory. Everything else lives here.
 */

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'

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

const MUTATING_BASE_TOOLS = new Set(['edit', 'write', 'apply_patch'])
const MUTATING_SUFFIX_RE = /_(edit|write|apply_patch)$/

/** True for bare (`edit`/`write`/`apply_patch`) and MCP-namespaced-suffixed (`aft_edit`, `x_write`, …) mutating tool names. */
export function isMutatingTool(tool: string): boolean {
  if (typeof tool !== 'string' || !tool) return false
  if (MUTATING_BASE_TOOLS.has(tool)) return true
  return MUTATING_SUFFIX_RE.test(tool)
}

const APPLY_PATCH_FILE_LINE_RE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm

function parseApplyPatchPaths(patchText: string): string[] {
  const out: string[] = []
  for (const match of patchText.matchAll(APPLY_PATCH_FILE_LINE_RE)) {
    const p = (match[1] ?? '').trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
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
 * silently drop all but incidental files. For edit/write, `tool_input.file_path`
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
    toolInput = { command: patchText }
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
 * - `overflow`: the child produced more output than the runner keeps.
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
      let started = false
      let timedOut = false
      let settled = false
      let hardTimer: ReturnType<typeof setTimeout> | undefined
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined

      const captured = () => ({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      })

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
        stdoutChunks.push(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk)
      })

      child.on('close', (code: number | null) => {
        if (timedOut) {
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
 * Extracts the human-readable feedback text from hook.mjs's stdout. For the
 * claude harness, hook.mjs writes a JSON envelope
 * `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`
 * — this pulls just the inner text so the agent doesn't see raw JSON.
 * Defensive: never drops content — falls back to the raw trimmed stdout on
 * parse failure or when no recognized field is present.
 */
export function extractFeedbackText(stdout: string): string {
  const trimmed = stdout.trim()
  if (!trimmed) return ''

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return trimmed
  }

  if (!isRecord(parsed)) return trimmed

  const hookSpecificOutput = isRecord(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput : undefined
  const candidates = [
    hookSpecificOutput?.additionalContext,
    parsed.additionalContext,
    parsed.additional_context,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }

  return trimmed
}

/**
 * Builds the `tool.execute.after` handler, with the subprocess runner
 * injected so all logic here is testable under Node.
 */
export function createHook(options: CreateHookOptions) {
  let hasWarned = false

  return async function toolExecuteAfter(
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ): Promise<void> {
    // Fail-loud: appends a one-time (per session) non-blocking warning to the
    // tool's model-visible output. Never throws.
    const warnOnce = (message: string) => {
      if (hasWarned) return
      hasWarned = true
      try {
        output.output += `${FEEDBACK_OPEN}${message}${FEEDBACK_CLOSE}`
      } catch {
        // Fail-loud must never itself throw.
      }
    }

    try {
      if (!isMutatingTool(input.tool)) return

      const touchedPaths = extractTouchedPaths(input.tool, input.args)
      if (touchedPaths.length === 0) return

      const payload = buildHookPayload({
        tool: input.tool,
        args: input.args,
        cwd: options.worktree,
        sessionID: input.sessionID,
      })

      let result: DetectorRunResult
      try {
        result = await options.runDetector(payload, { worktree: options.worktree })
      } catch (err) {
        warnOnce(`[impeccable] design hook bridge failed: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      // The runner owns the timeout. Only a clean exit counts as a scan; every
      // other outcome must fail loud rather than masquerade as a clean scan.
      switch (result.kind) {
        case 'ok':
          break
        case 'timeout':
          warnOnce('[impeccable] design hook timed out before finishing its scan')
          return
        case 'spawn-error':
          warnOnce('[impeccable] design hook could not be started')
          return
        case 'nonzero-exit': {
          // hook.mjs is contractually always-exit-0; a nonzero exit means the
          // invocation itself broke (unreadable script, crash, etc.).
          const detail = result.stderr.trim() || `exit ${result.exitCode}`
          warnOnce(`[impeccable] design hook did not run cleanly: ${detail}`)
          return
        }
        case 'overflow':
          warnOnce('[impeccable] design hook produced more output than the bridge keeps')
          return
      }

      const feedback = extractFeedbackText(result.stdout)
      if (!feedback) return

      output.output += `${FEEDBACK_OPEN}${feedback}${FEEDBACK_CLOSE}`
    } catch (err) {
      warnOnce(`[impeccable] design hook bridge error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
