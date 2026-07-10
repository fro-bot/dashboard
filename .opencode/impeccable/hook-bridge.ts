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
 * This module must NOT import from `@opencode-ai/plugin` and must NOT use Bun
 * `$` — the OpenCode plugin loader iterates a plugin module's exports and
 * treats each as a candidate plugin factory, so `.opencode/impeccable/plugin.ts`
 * must export ONLY the plugin factory. Everything else lives here.
 */

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

export interface DetectorRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Injectable subprocess runner: given the hook payload and the worktree cwd, returns the detector's stdout/stderr/exitCode. */
export type DetectorRunner = (
  payload: ReturnType<typeof buildHookPayload>,
  opts: { worktree: string },
) => Promise<DetectorRunResult>

export interface CreateHookOptions {
  runDetector: DetectorRunner
  worktree: string
  timeoutMs?: number
}

const TIMEOUT_SENTINEL = Symbol('impeccable-hook-timeout')

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT_SENTINEL> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer!)
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
  const timeoutMs = options.timeoutMs ?? DETECTOR_TIMEOUT_MS
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

      let result: DetectorRunResult | typeof TIMEOUT_SENTINEL
      try {
        result = await withTimeout(options.runDetector(payload, { worktree: options.worktree }), timeoutMs)
      } catch (err) {
        warnOnce(`[impeccable] design hook bridge failed: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      if (result === TIMEOUT_SENTINEL) {
        // Degrade to no-op on timeout, no warning — this is expected
        // backpressure, not a broken bridge.
        return
      }

      // hook.mjs is contractually always-exit-0; a nonzero exit means the
      // invocation itself broke (bad node path, unreadable script, etc.), which
      // must fail loud rather than masquerade as a clean scan.
      if (result.exitCode !== 0) {
        const detail = result.stderr?.trim() || `exit ${result.exitCode}`
        warnOnce(`[impeccable] design hook did not run cleanly: ${detail}`)
        return
      }

      const feedback = extractFeedbackText(result.stdout ?? '')
      if (!feedback) return

      output.output += `${FEEDBACK_OPEN}${feedback}${FEEDBACK_CLOSE}`
    } catch (err) {
      warnOnce(`[impeccable] design hook bridge error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
