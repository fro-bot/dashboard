/**
 * Pure, Node-testable core of the Impeccable OpenCode bridge.
 *
 * After a file-mutating tool call, pipe a claude-shaped hook event to the
 * vendored Impeccable launcher (`.agents/skills/impeccable/scripts/impeccable hook`)
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

import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/**
 * The value the hook reads from the `IMPECCABLE_HOOK_HARNESS` env override. Our
 * payload is claude-shaped (`tool_name`/`tool_input.file_path`/`tool_input.command`),
 * and the claude harness takes it as-is. Another harness value would parse the
 * payload as that harness's event shape and drop the apply_patch multi-file input.
 */
export const IMPECCABLE_HOOK_HARNESS = 'claude'

/**
 * The environment the engine child gets, and nothing else: these exact names,
 * every name with one of these prefixes, and the harness and quiet signals the
 * bridge sets. Tokens and other secrets in the host's environment never reach
 * the child.
 */
export const CHILD_ENV_ALLOWLIST = {
  names: [
    'PATH',
    'HOME',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'LANG',
    // The launcher's curl or wget needs these behind a proxy or a TLS-intercepting CA. A proxy URL
    // with embedded credentials therefore reaches the engine. Exact names only, never prefixes.
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'all_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CURL_CA_BUNDLE',
  ],
  prefixes: ['LC_', 'IMPECCABLE_'],
  /** Names the prefixes would let through that the child must never get: either one makes the hook a no-op. */
  denied: ['IMPECCABLE_HOOK_DEPTH', 'CLAUDE_HOOK_DEPTH'],
} as const

/** Builds the child's environment from `source` by the allow-list, then sets the harness and quiet signals. */
export function buildChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const denied = (CHILD_ENV_ALLOWLIST.denied as readonly string[]).includes(name)
    const allowed =
      CHILD_ENV_ALLOWLIST.names.includes(name as (typeof CHILD_ENV_ALLOWLIST.names)[number]) ||
      CHILD_ENV_ALLOWLIST.prefixes.some((prefix) => name.startsWith(prefix))
    if (allowed && !denied) env[name] = value
  }
  env.IMPECCABLE_HOOK_HARNESS = IMPECCABLE_HOOK_HARNESS
  env.IMPECCABLE_HOOK_QUIET = '1'
  return env
}

/** Worktree-relative path to the vendored launcher. It is a POSIX shell script that execs the engine binary for the host platform. */
export const HOOK_LAUNCHER_RELATIVE_PATH = '.agents/skills/impeccable/scripts/impeccable'

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

/** The tool-arg keys that carry a path: `filePath` for edit/write, `patchText` for apply_patch. `extractTouchedPaths` reads only these, and `expectsPath` keys off the same set. */
export const PATH_ARG_KEYS = { file: 'filePath', patch: 'patchText' } as const

function parseApplyPatchPaths(patchText: string): string[] {
  const out: string[] = []
  for (const match of patchText.matchAll(APPLY_PATCH_FILE_LINE_RE)) {
    const p = (match[1] ?? '').trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/**
 * The vendored hook recognizes only
 * `*** Add File:` and `*** Update File:` markers, not `*** Move to:`, so a
 * rename's destination would never be scanned. This appends one synthetic
 * `*** Update File: <dest>` marker per distinct Move-to destination that no
 * Add or Update marker already covers. The original patch text is kept
 * verbatim and the markers are appended after it, so the vendored hook's
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
    const patchText = args[PATH_ARG_KEYS.patch]
    if (typeof patchText === 'string' && patchText) return parseApplyPatchPaths(patchText)
    return []
  }

  const filePath = args[PATH_ARG_KEYS.file]
  if (typeof filePath === 'string' && filePath) return [filePath]
  return []
}

/** Strips an MCP namespace prefix (`aft_edit`→`edit`) so `tool_name` matches the bare form the hook special-cases (`tool_name === 'apply_patch'` exactly). Passes bare names and non-mutating names through unchanged. */
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
 * Shapes the stdin JSON the hook reads. `tool_name` is normalized to its
 * bare form. For `apply_patch` (bare or MCP-suffixed), `tool_input.command`
 * carries the raw patch text so the hook can
 * extract every touched file — the hook only reads `tool_input.command` when
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
 * - `overflow`: the child wrote more than the cap to stdout or stderr. The result carries at most the cap from each stream. It takes precedence over `timeout`.
 */
export type DetectorRunResult =
  | { kind: 'ok'; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'spawn-error' }
  | { kind: 'nonzero-exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'overflow'; stdout: string; stderr: string }

/** Injectable subprocess runner: given the hook payload and the worktree cwd, resolves with the outcome of one hook run. */
export type DetectorRunner = (
  payload: ReturnType<typeof buildHookPayload>,
  opts: { worktree: string },
) => Promise<DetectorRunResult>

/** Resolves true once the engine binary is fetched and answers its handshake. Never rejects when built by `createEngineWarmup`; `createHook` treats a rejection or throw as a failed warm-up. */
export type EngineWarmup = () => Promise<boolean>

export interface CreateHookOptions {
  runDetector: DetectorRunner
  worktree: string
  /**
   * Makes the engine ready before any scan. It runs once per hook instance,
   * on the first call that needs a scan, and its result is shared by every
   * call. When omitted, scans run without waiting for an engine.
   */
  warmEngine?: EngineWarmup
  /** Longest a single call waits for a pending warm-up. Defaults to `DETECTOR_TIMEOUT_MS`. */
  engineReadyWaitMs?: number
  /** Shortest time between a failed warm-up and the next attempt. Defaults to `ENGINE_RETRY_INTERVAL_MS`. */
  engineRetryMs?: number
  /** Clock in milliseconds. Defaults to `Date.now`. */
  now?: () => number
}

export interface CreateSpawnRunnerOptions {
  /** Absolute path to the file the run executes (the launcher, or an ephemeral test fixture). It must exist before the child is spawned. */
  scriptPath: string
  /** Time before the child is sent SIGTERM. Defaults to `DETECTOR_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Time between SIGTERM and SIGKILL. Defaults to `DETECTOR_KILL_GRACE_MS`. */
  killGraceMs?: number
  /** Time past timeout plus grace at which the runner resolves regardless of the child's pipes. Defaults to `DETECTOR_DEADLINE_SLACK_MS`. */
  deadlineSlackMs?: number
  /** Most bytes kept from each of stdout and stderr. Defaults to `DETECTOR_MAX_OUTPUT_BYTES`. */
  maxOutputBytes?: number
  /** Executable to spawn. Defaults to literal `node`. */
  command?: string
  /** Arguments for the executable. Defaults to `[scriptPath]`. */
  args?: string[]
  /** Pre-spawn check that the script exists; rejecting means it cannot run. Defaults to `fs.access`; override only for tests. */
  checkScript?: (scriptPath: string) => Promise<unknown>
}

function noop(): void {}

/** True where the child can lead its own process group and the group can be signalled (POSIX). */
const SUPPORTS_PROCESS_GROUPS = process.platform !== 'win32'

interface RunLimits {
  timeoutMs: number
  killGraceMs: number
  deadlineSlackMs: number
  maxOutputBytes: number
}

/** Why a run is ending. Together with the run's flags it decides the result. */
type SettleCause = { by: 'exit'; code: number | null } | { by: 'deadline' } | { by: 'spawn-error' }

/**
 * The lifecycle of one hook run: the child, its three timers, the bounded
 * capture of its output, and the flags that decide the result. `settle` is the
 * only place a run ends and the only place the result is chosen.
 */
class HookRun {
  settled = false
  private timedOut = false
  private overflowed = false
  private started = false
  private child: ChildProcess | undefined
  private readonly stdoutChunks: Buffer[] = []
  private readonly stderrChunks: Buffer[] = []
  private stdoutBytes = 0
  private stderrBytes = 0
  private hardTimer: ReturnType<typeof setTimeout> | undefined
  private killTimer: ReturnType<typeof setTimeout> | undefined
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined
  private readonly limits: RunLimits
  private readonly resolve: (result: DetectorRunResult) => void

  constructor(limits: RunLimits, resolve: (result: DetectorRunResult) => void) {
    this.limits = limits
    this.resolve = resolve
  }

  /** Bounds the whole run, including any pre-spawn check: it settles at timeout + grace + slack at the latest. */
  armDeadline(): void {
    const { timeoutMs, killGraceMs, deadlineSlackMs } = this.limits
    this.deadlineTimer = setTimeout(
      () => {
        // With no child there was nothing to scan, so the run never started.
        this.settle(this.child ? { by: 'deadline' } : { by: 'spawn-error' })
      },
      timeoutMs + killGraceMs + deadlineSlackMs,
    )
  }

  /** Takes over a spawned child: captures its output, arms SIGTERM then SIGKILL, and feeds it the payload. */
  attach(child: ChildProcess, payload: unknown): void {
    this.child = child

    child.once('spawn', () => {
      this.started = true
    })
    child.on('error', () => {
      // Before 'spawn' this is a failure to start. After it, 'close' or the
      // deadline settles the run.
      if (!this.started) this.settle({ by: 'spawn-error' })
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBytes = this.capture(this.stdoutChunks, this.stdoutBytes, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBytes = this.capture(this.stderrChunks, this.stderrBytes, chunk)
    })
    child.on('close', (code: number | null) => {
      this.settle({ by: 'exit', code })
    })

    this.hardTimer = setTimeout(() => {
      this.timedOut = true
      try {
        child.stdin?.end()
      } catch {
        // Stdin may already be closed.
      }
      this.signal('SIGTERM')
      this.killTimer = setTimeout(() => {
        this.signal('SIGKILL')
      }, this.limits.killGraceMs)
    }, this.limits.timeoutMs)

    // A child that exits without reading stdin can raise EPIPE on write. That is
    // not a spawn failure and must not crash the host.
    child.stdin?.on('error', noop)
    try {
      child.stdin?.end(JSON.stringify(payload))
    } catch {
      // If the write fails, the child's own error and close events settle the run.
    }
  }

  /**
   * Ends the run exactly once. Precedence: overflow, then timeout (the timer
   * fired or the deadline passed, even if the child then exited 0), then the
   * exit code.
   */
  settle(cause: SettleCause): void {
    if (this.settled) return
    this.settled = true

    if (cause.by === 'deadline') this.signal('SIGKILL')
    if (this.hardTimer) clearTimeout(this.hardTimer)
    if (this.killTimer) clearTimeout(this.killTimer)
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.release()

    this.resolve(this.outcome(cause))
  }

  private outcome(cause: SettleCause): DetectorRunResult {
    if (cause.by === 'spawn-error') return { kind: 'spawn-error' }

    const output = { stdout: decode(this.stdoutChunks), stderr: decode(this.stderrChunks) }
    if (this.overflowed) return { kind: 'overflow', ...output }
    if (this.timedOut || cause.by === 'deadline') return { kind: 'timeout', ...output }
    if (cause.code === 0) return { kind: 'ok', ...output }
    return { kind: 'nonzero-exit', exitCode: cause.code ?? -1, ...output }
  }

  /** Keeps at most maxOutputBytes in total and returns the new byte count. */
  private capture(chunks: Buffer[], currentBytes: number, chunk: Buffer): number {
    const { maxOutputBytes } = this.limits
    const remaining = maxOutputBytes - currentBytes
    if (chunk.length > remaining) {
      this.overflowed = true
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      return maxOutputBytes
    }
    chunks.push(chunk)
    return currentBytes + chunk.length
  }

  /**
   * Signals the child's whole process group, so grandchildren in that group
   * (the launcher's `curl` and `sh`) receive it too. Falls back to the direct
   * child when the child has no pid, the platform has no process groups, or
   * the group signal fails (for example ESRCH once the group is empty).
   */
  private signal(name: NodeJS.Signals): void {
    const child = this.child
    if (!child) return

    if (SUPPORTS_PROCESS_GROUPS && child.pid !== undefined) {
      try {
        process.kill(-child.pid, name)
        return
      } catch {
        // Fall through to the direct child.
      }
    }

    try {
      child.kill(name)
    } catch {
      // The process may already have exited.
    }
  }

  /** Detaches from the child so late events cannot throw, and drops our end of pipes a grandchild may hold open. */
  private release(): void {
    const child = this.child
    if (!child) return
    child.stdout?.removeAllListeners()
    child.stderr?.removeAllListeners()
    child.stdin?.removeAllListeners()
    child.removeAllListeners()
    child.stdout?.on('error', noop)
    child.stderr?.on('error', noop)
    child.stdin?.on('error', noop)
    child.on('error', noop)
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
}

// A StringDecoder that is never flushed drops an incomplete trailing multibyte
// sequence. Buffer#toString would turn it into U+FFFD, which is longer than the
// bytes it replaces and could push the string past the cap.
function decode(chunks: Buffer[]): string {
  const decoder = new StringDecoder('utf-8')
  return chunks.map((chunk) => decoder.write(chunk)).join('')
}

/**
 * Real `node:child_process.spawn` runner: `<command> <args>` with no shell, the
 * payload piped over stdin and cwd at the worktree. The defaults run
 * `node <scriptPath>`, a literal `node` rather than `process.execPath`, which
 * under a Bun host would be Bun.
 *
 * The child gets only the environment `buildChildEnv` builds from
 * `CHILD_ENV_ALLOWLIST`, with `IMPECCABLE_HOOK_HARNESS=claude` and
 * `IMPECCABLE_HOOK_QUIET=1` set. A depth variable makes the hook a no-op, so
 * the bridge never forwards or sets one.
 *
 * Each of stdout and stderr is capped at `maxOutputBytes` of UTF-8. Excess
 * bytes are discarded as they arrive, and the run resolves `overflow`.
 *
 * This runner is the sole authority over the run's lifetime: SIGTERM at the
 * timeout, SIGKILL after the grace period, and a final deadline just past
 * both at which it resolves even if a child or grandchild still holds the
 * pipes open. On POSIX each signal goes to the child's whole process group
 * (the child is spawned with `detached: true` so it leads one) and the final
 * deadline SIGKILLs the group, so a launcher's `curl` and `sh` die with it.
 * A grandchild that leaves the group (`setsid`, `detached`) is out of reach.
 * On Windows only the direct child is signalled. The deadline starts before the script existence check, so a
 * check that never settles resolves `spawn-error` at the deadline and the
 * child is never spawned after the run has resolved. A tool call therefore
 * waits at most timeout + grace + slack. Callers must not layer a second
 * timeout on top of it.
 */
export function createSpawnRunner(options: CreateSpawnRunnerOptions): DetectorRunner {
  const limits: RunLimits = {
    timeoutMs: options.timeoutMs ?? DETECTOR_TIMEOUT_MS,
    killGraceMs: options.killGraceMs ?? DETECTOR_KILL_GRACE_MS,
    deadlineSlackMs: options.deadlineSlackMs ?? DETECTOR_DEADLINE_SLACK_MS,
    maxOutputBytes: options.maxOutputBytes ?? DETECTOR_MAX_OUTPUT_BYTES,
  }
  const command = options.command ?? 'node'
  const args = options.args ?? [options.scriptPath]
  const checkScript = options.checkScript ?? ((path: string) => access(path))

  return (payload, opts) =>
    new Promise<DetectorRunResult>((resolve) => {
      const run = new HookRun(limits, resolve)
      run.armDeadline()

      const spawnChild = () => {
        // A check that settles after the run resolved must not start a child.
        if (run.settled) return

        const env = buildChildEnv(process.env)

        try {
          run.attach(
            spawn(command, args, {
              cwd: opts.worktree,
              env,
              stdio: ['pipe', 'pipe', 'pipe'],
              // On POSIX the child leads its own process group, so a timeout can signal it and its grandchildren together.
              detached: SUPPORTS_PROCESS_GROUPS,
            }),
            payload,
          )
        } catch {
          run.settle({ by: 'spawn-error' })
        }
      }

      // The check runs in a promise chain so a synchronous throw from it is a rejection too.
      Promise.resolve()
        .then(() => checkScript(options.scriptPath))
        .then(spawnChild, () => {
          run.settle({ by: 'spawn-error' })
        })
    })
}

/**
 * The production runner: executes the vendored launcher directly (no `node`,
 * no shell) with the `hook` subcommand. The launcher resolves the engine
 * binary for the host platform and execs it, so it needs no Node runtime.
 */
export function createLauncherRunner(launcherPath: string): DetectorRunner {
  return createSpawnRunner({ scriptPath: launcherPath, command: launcherPath, args: ['hook'] })
}

/** Budget for the first-use engine fetch, sized for a slow network. */
export const ENGINE_WARMUP_TIMEOUT_MS = 120_000

/** Shortest time between a failed engine warm-up and the next attempt. */
export const ENGINE_RETRY_INTERVAL_MS = 60_000

const ENGINE_HANDSHAKE_PREFIX = 'impeccable-engine'

export interface CreateEngineWarmupOptions {
  /** Time before the launcher is sent SIGTERM. Defaults to `ENGINE_WARMUP_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Time between SIGTERM and SIGKILL. Defaults to `DETECTOR_KILL_GRACE_MS`. */
  killGraceMs?: number
  /** Time past timeout plus grace at which the run resolves regardless of the child's pipes. Defaults to `DETECTOR_DEADLINE_SLACK_MS`. */
  deadlineSlackMs?: number
}

/**
 * Runs the launcher's `engine-probe` subcommand through the same spawn runner
 * as the hook, with the long first-use budget. On a cold machine the launcher
 * downloads the engine binary into `~/.impeccable/bin/<version>/` and verifies
 * its sha256 before answering; on a warm cache it answers at once. The result
 * is true only for a clean exit whose stdout starts with the engine handshake.
 * A timeout kills the launcher's whole process group, so a stalled `curl` goes
 * with it. It never rejects.
 */
export function createEngineWarmup(launcherPath: string, worktree: string, options: CreateEngineWarmupOptions = {}): EngineWarmup {
  const run = createSpawnRunner({
    scriptPath: launcherPath,
    command: launcherPath,
    args: ['engine-probe'],
    timeoutMs: options.timeoutMs ?? ENGINE_WARMUP_TIMEOUT_MS,
    killGraceMs: options.killGraceMs,
    deadlineSlackMs: options.deadlineSlackMs,
  })
  // engine-probe ignores stdin; the runner still writes a payload to it.
  const payload = buildHookPayload({ tool: 'edit', args: {}, cwd: worktree, sessionID: 'engine-warmup' })

  return async () => {
    let ready = false
    try {
      const result = await run(payload, { worktree })
      ready = result.kind === 'ok' && result.stdout.startsWith(ENGINE_HANDSHAKE_PREFIX)
    } catch {
      ready = false
    }
    if (!ready) removeEngineStagingFiles(launcherPath)
    return ready
  }
}

const ENGINE_STAGING_FILE_RE = /^\.impeccable\.part\.(\d+)(\.sha256)?$/

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes the download staging files a failed or timed-out warm-up leaves in
 * the launcher's cache directory: `<cache root>/bin/<version>/.impeccable.part.<pid>`
 * and its `.sha256` sidecar. The cache root is `IMPECCABLE_HOME`, or
 * `$HOME/.impeccable`; the version is the skill's `scripts/VERSION`. Only
 * regular files with exactly those names are removed (a symlink or directory is
 * skipped), and a file named for a process that is still running is skipped,
 * because that process may be mid-download. It never throws.
 */
function removeEngineStagingFiles(launcherPath: string): void {
  try {
    const env = buildChildEnv(process.env)
    // An empty IMPECCABLE_HOME falls back to $HOME/.impeccable, as the launcher's `${IMPECCABLE_HOME:-…}` does.
    const cacheRoot = env.IMPECCABLE_HOME || (env.HOME ? join(env.HOME, '.impeccable') : undefined)
    if (!cacheRoot) return
    const version = readFileSync(join(dirname(launcherPath), 'VERSION'), 'utf-8').trim()
    if (!version || version.includes('/') || version.includes('\\')) return

    const stagingDir = join(cacheRoot, 'bin', version)
    for (const name of readdirSync(stagingDir)) {
      const match = ENGINE_STAGING_FILE_RE.exec(name)
      if (!match || processIsAlive(Number(match[1]))) continue
      try {
        const path = join(stagingDir, name)
        if (lstatSync(path).isFile()) unlinkSync(path)
      } catch {
        // The file may already be gone, or not ours to remove.
      }
    }
  } catch {
    // No cache directory, no VERSION file, or an unreadable directory: nothing to clean.
  }
}

/** Most UTF-16 code units of feedback appended to a tool's output; longer feedback is truncated. */
export const FEEDBACK_MAX_CHARS = 64 * 1024

const FEEDBACK_TRUNCATED_MARKER = '[impeccable] feedback truncated'

/**
 * Cuts feedback to `FEEDBACK_MAX_CHARS` code units and adds the marker on its
 * own line. A cut that lands between the halves of a surrogate pair drops the
 * high half, so the result never ends in a lone surrogate. Feedback within the
 * cap is returned unchanged. This is not a warning and is never deduplicated.
 */
function capFeedback(feedback: string): string {
  if (feedback.length <= FEEDBACK_MAX_CHARS) return feedback

  let end = FEEDBACK_MAX_CHARS
  const last = feedback.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${feedback.slice(0, end)}\n${FEEDBACK_TRUNCATED_MARKER}`
}

const FEEDBACK_OPEN = '\n\n<impeccable_feedback>\n'
const FEEDBACK_CLOSE = '\n</impeccable_feedback>'

/**
 * Strictly extracts the human-readable feedback text from the hook's stdout.
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
  return isRecord(args) && Object.values(PATH_ARG_KEYS).some((key) => key in args)
}

type WarningKind =
  | 'timeout'
  | 'spawn-error'
  | 'nonzero-exit'
  | 'overflow'
  | 'stderr-on-clean'
  | 'malformed'
  | 'no-path'
  | 'engine-pending'
  | 'engine-unavailable'
  | 'bridge-error'

const WARNING_MESSAGES = {
  timeout: '[impeccable] design hook timed out before finishing its scan',
  'spawn-error': '[impeccable] design hook could not be started',
  'nonzero-exit': '[impeccable] design hook did not run cleanly',
  overflow: '[impeccable] design hook produced more output than the bridge keeps',
  'stderr-on-clean': '[impeccable] design hook produced unexpected diagnostic output',
  malformed: '[impeccable] design hook returned unrecognized output',
  'no-path': '[impeccable] design hook skipped a file-changing tool call with no extractable path',
  'engine-pending': '[impeccable] design engine is still downloading; scans resume when it is ready',
  'engine-unavailable': '[impeccable] design engine could not be fetched or started; scans are skipped and the fetch is retried periodically',
  'bridge-error': '[impeccable] design hook bridge hit an internal error',
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
 *  - exit 0, valid PostToolUse envelope: only its `additionalContext` is appended,
 *    cut to `FEEDBACK_MAX_CHARS` with a truncation marker when longer.
 *  - exit 0, empty stdout, non-empty stderr: `stderr-on-clean`.
 *  - exit 0, non-empty stdout that is not a valid envelope: `malformed`.
 *  - `timeout`, `spawn-error`, `nonzero-exit`, `overflow`: the matching warning kind.
 *  - a built-in `edit`/`write`/`apply_patch`, or a mutating tool with a path-like
 *    arg key, yielding no path: `no-path`, and the hook is not run. A mutating
 *    tool with no path-like arg key is silent and not run.
 *  - the engine warm-up still pending after `engineReadyWaitMs`: `engine-pending`,
 *    the hook is not run, and the warm-up keeps running. Calls after that skip
 *    at once, without waiting, until the warm-up settles.
 *  - the engine warm-up failed: `engine-unavailable`, the hook is not run, and
 *    the warm-up is attempted again no sooner than `engineRetryMs` after the
 *    failure.
 *  - the runner rejecting, or any other bridge fault: `bridge-error`.
 *
 * Each warning kind shows once per hook instance (one plugin process). Warning
 * text is fixed; hook stdout and stderr are never included. A non-string
 * `output.output` is left untouched and does not use up its kind. Never throws.
 */
export function createHook(options: CreateHookOptions) {
  const warned = new Set<WarningKind>()
  const readyWaitMs = options.engineReadyWaitMs ?? DETECTOR_TIMEOUT_MS
  const retryMs = options.engineRetryMs ?? ENGINE_RETRY_INTERVAL_MS
  const now = options.now ?? Date.now

  // One warm-up is in flight at a time. A hook call that stops waiting for it
  // does not stop it.
  type EngineState = 'idle' | 'warming' | 'ready' | 'failed'
  let engine: EngineState = options.warmEngine ? 'idle' : 'ready'
  // Read through a function so the state set by the warm-up is not narrowed away across an await.
  const engineState = (): EngineState => engine
  let warming: Promise<void> | undefined
  let failedAt = 0
  // Set once a call has waited out the budget on the current warm-up; later calls then skip without waiting.
  let seenPending = false

  const startWarmup = (warmEngine: EngineWarmup): Promise<void> => {
    engine = 'warming'
    seenPending = false
    const settled = (async () => warmEngine())().then(
      ready => ({ ready }),
      () => ({ ready: false }),
    )
    warming = settled.then(({ ready }) => {
      engine = ready ? 'ready' : 'failed'
      seenPending = false
      if (!ready) failedAt = now()
    })
    return warming
  }

  /** Whether the engine is ready, still warming after the wait, or unavailable. */
  const awaitEngine = async (): Promise<'ready' | 'pending' | 'unavailable'> => {
    const warmEngine = options.warmEngine
    if (!warmEngine) return 'ready'

    if (seenPending && engineState() === 'warming') {
      // Yield one macrotask so a warm-up that settled a moment ago is seen as settled.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
      if (engineState() === 'warming') return 'pending'
    }

    if (engineState() === 'ready') return 'ready'
    if (engineState() === 'failed' && now() - failedAt < retryMs) return 'unavailable'
    if (engineState() === 'idle' || engineState() === 'failed') startWarmup(warmEngine)

    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<'pending'>(resolve => {
      timer = setTimeout(() => {
        resolve('pending')
      }, readyWaitMs)
    })
    try {
      const outcome = await Promise.race([warming, waited])
      if (outcome === 'pending') {
        seenPending = true
        return 'pending'
      }
    } finally {
      clearTimeout(timer)
    }
    return engineState() === 'ready' ? 'ready' : 'unavailable'
  }

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

      const engineReadiness = await awaitEngine()
      if (engineReadiness !== 'ready') {
        warnOnce(engineReadiness === 'pending' ? 'engine-pending' : 'engine-unavailable')
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
        warnOnce('bridge-error')
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

      append(capFeedback(feedback))
    } catch {
      warnOnce('bridge-error')
    }
  }
}
