/**
 * Operator runtime seam.
 *
 * Connects the React operator shell to existing browser-direct operator runtimes
 * (public/operator-*.js) without duplicating Gateway logic or adding a proxy.
 *
 * Design:
 * - One lifecycle owner: React mounts the runtime once when the operator shell
 *   reaches ready state; cleanup is called on unmount or auth expiry.
 * - Idempotent: mounting twice (React Strict Mode) is safe — cleanup from the
 *   first mount prevents double-registration.
 * - Async runtime loading: if the runtime module is absent, the shell transitions
 *   to unavailable without crashing.
 * - CSRF and idempotency keys are memory-only; never persisted or logged.
 *
 * Security invariants:
 * - Never logs prompt, token, cookie, CSRF value, repo name, run ID, or raw payload.
 * - Repo-list failures use the canonical operator state classifier — never renders
 *   "No repositories available" for auth/rate-limit/network/protocol failures.
 * - All Gateway data flows through safe text paths only.
 */

import type {OperatorState} from './state.ts'

export interface RepoListError {
  readonly kind: 'http' | 'network' | 'protocol'
  readonly status?: number
}

export interface OperatorRuntimeOptions {
  readonly container: HTMLElement
  readonly onStateChange: (state: OperatorState) => void
  /**
   * Injectable runtime loader for testing.
   * In production, this dynamically imports the operator runtime modules.
   * May return a cleanup function that is called when the runtime is cleaned up.
   * If absent, the default loader is used.
   *
   * In fixture mode the loader receives {endpointBase, fixtureSessionId, getScenario}
   * so it can configure the public browser modules to use the fixture route prefix
   * and include fixture context in launch requests.
   */
  readonly _runtimeLoader?: (opts?: {
    endpointBase?: string
    fixtureSessionId?: string
    getScenario?: () => string
  }) => Promise<void | (() => void)>
  /**
   * When true, the runtime uses fixture routes instead of production routes.
   * Only active in development builds (import.meta.env.DEV).
   * Production browser bundles must not contain fixture route strings.
   */
  readonly fixtureMode?: boolean
  /**
   * The fixture endpoint base to pass to the runtime loader when fixtureMode is true.
   * Must be provided by the caller (App/fixture loader); no fallback is applied here.
   */
  readonly fixtureEndpointBase?: string
  /**
   * The fixture session ID from the fixture session response.
   * Passed to initOperatorLaunch so launch requests include it in the body.
   * Only used when fixtureMode is true.
   */
  readonly fixtureSessionId?: string
  /**
   * Returns the currently selected fixture scenario at call time.
   * Called at submit time so scenario changes after init are reflected.
   * Only used when fixtureMode is true.
   */
  readonly getScenario?: () => string
}

export interface OperatorRuntimeHandle {
  isMounted: boolean
  cleanup: () => void
}

/**
 * Mint a fresh unique idempotency key for a mutation.
 *
 * Uses crypto.randomUUID() with a fallback for environments that lack it.
 * Keys are memory-only — never persisted, logged, or shared across mutations.
 *
 * Exported for direct testing.
 */
export function mintRuntimeIdempotencyKey(): string {
  if (
    globalThis.crypto !== undefined &&
    typeof (globalThis.crypto as {randomUUID?: () => string}).randomUUID === 'function'
  ) {
    return (globalThis.crypto as {randomUUID: () => string}).randomUUID()
  }
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2)
  return `${ts}-${rand}`
}

/**
 * Classify a repo-list error into a canonical operator state.
 *
 * Never returns "No repositories available" — that string is reserved for the
 * case where the list is genuinely empty after a successful fetch.
 *
 * Auth/rate-limit/network/protocol failures map to their canonical states so
 * the UI can render the correct recovery action.
 *
 * Exported for direct testing.
 */
export function classifyRepoListError(error: RepoListError): OperatorState {
  if (error.kind === 'http') {
    const {status} = error
    if (status === 401 || status === 403) return 'auth-required'
    if (status === 429) return 'rate-limited'
    return 'unavailable'
  }
  return error.kind === 'network' ? 'offline' : 'unavailable'
}

// CSP-safe dynamic import helper.
//
// Vite's import-analysis plugin statically resolves string literals in import()
// calls, even when annotated with @vite-ignore, during Vitest's transform pass.
// Using a computed specifier (string concatenation) prevents static resolution
// while remaining CSP-safe — no eval or Function constructor is used.
//
// The ?manual=1 query param signals the public modules to skip auto-bootstrap
// on evaluation, giving the runtime seam deterministic lifecycle control.
const _streamSpecifier = '/static/operator-stream.js' + '?manual=1'
const _launchSpecifier = '/static/operator-launch.js' + '?manual=1'
const _runIndexSpecifier = '/static/operator-run-index.js' + '?manual=1'

// Active-stream state owned by the runtime seam.
// Only one stream is active at a time; switching cards closes the prior handle first.
let _activeStreamHandle: {close(): void} | null = null

// The runId whose stream is currently attached (mirrors _activeStreamHandle's target).
// Used by onSelectRun to distinguish "expand a new run" (attach) from "select the
// already-expanded run again" (collapse) — the single-open accordion's decision point.
let _activeStreamRunId: string | null = null

function _closeActiveStream(): void {
  if (_activeStreamHandle !== null) {
    try {
      _activeStreamHandle.close()
    } catch {
      // ignore close errors
    }
    _activeStreamHandle = null
  }
  _activeStreamRunId = null
}

async function defaultRuntimeLoader(opts?: {
  endpointBase?: string
  fixtureSessionId?: string
  getScenario?: () => string
  onSelectRun?: (runId: string) => void
  onRunLaunched?: (runId: string, card: HTMLElement) => void
}): Promise<() => void> {
  const streamMod = await import(/* @vite-ignore */ _streamSpecifier) as {
    bootstrapOperatorStreams?: (opts?: {endpointBase?: string; fixtureSessionId?: string}) => void
    resetBootstrapState?: () => void
    initOperatorStream?: (opts: {runId: string; statusEl?: Element | null; noticeEl?: Element | null; endpointBase?: string; fixtureSessionId?: string}) => {close(): void}
  }
  if (typeof streamMod.resetBootstrapState === 'function') {
    streamMod.resetBootstrapState()
  }
  if (typeof streamMod.bootstrapOperatorStreams === 'function') {
    const streamOpts = opts?.endpointBase !== undefined || opts?.fixtureSessionId !== undefined
      ? {endpointBase: opts.endpointBase, fixtureSessionId: opts.fixtureSessionId}
      : undefined
    streamMod.bootstrapOperatorStreams(streamOpts)
  }

  const runIndexMod = await import(/* @vite-ignore */ _runIndexSpecifier) as {
    initOperatorRunIndex?: (opts?: {endpointBase?: string; fixtureSessionId?: string; onSelectRun?: (runId: string) => void}) => Promise<void>
    resetRunIndexState?: () => void
    markRunStreamAttached?: (runId: string) => void
  }

  const launchMod = await import(/* @vite-ignore */ _launchSpecifier) as {
    initOperatorLaunch?: (opts?: {endpointBase?: string; getScenario?: () => string; fixtureSessionId?: string; onRunLaunched?: (runId: string, card: HTMLElement) => void}) => Promise<void>
    resetLaunchState?: () => void
  }

  function _attachStream(runId: string, statusEl: Element | null, noticeEl: Element | null): void {
    _closeActiveStream()

    if (typeof streamMod.initOperatorStream !== 'function') return

    try {
      const handle = streamMod.initOperatorStream({
        runId,
        statusEl,
        noticeEl,
        endpointBase: opts?.endpointBase,
        fixtureSessionId: opts?.fixtureSessionId,
      })
      _activeStreamHandle = handle
      _activeStreamRunId = runId
      if (typeof runIndexMod.markRunStreamAttached === 'function') {
        runIndexMod.markRunStreamAttached(runId)
      }
    } catch {
      if (statusEl !== null) {
        statusEl.textContent = 'Unavailable'
        statusEl.className = 'status-unavailable'
      }
    }
  }

  // Build the active-stream coordination callbacks. These are passed to run-index and
  // launch modules so the runtime seam owns the single active stream handle.
  //
  // Single-open accordion: the run-index DOM shell calls this on every card
  // click/keydown activation, whether the card is being expanded or collapsed
  // (it decides that via data-expanded before calling here). This callback is
  // the single decision point for "attach" vs "collapse":
  // - If runId is already the active stream, the card was just collapsed —
  //   close the stream and attach nothing new.
  // - Otherwise the card was just expanded — close whichever stream is active
  //   (if any) and attach the new one. _attachStream already closes the prior
  //   handle first, so this covers both "nothing was open" and "switching cards."
  const onSelectRun = (runId: string) => {
    if (_activeStreamRunId === runId) {
      _closeActiveStream()
      return
    }
    // Find the card element for this runId to get its statusEl and noticeEl.
    const card = typeof document !== 'undefined'
      ? document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`)
      : null
    const statusEl = card?.querySelector('[data-role="run-status"]') ?? null
    const noticeEl = typeof document !== 'undefined'
      ? document.querySelector('[data-role="stream-status"]')
      : null
    _attachStream(runId, statusEl, noticeEl)
  }

  const onRunLaunched = (runId: string, card: HTMLElement) => {
    const statusEl = card.querySelector('[data-role="run-status"]') ?? null
    const noticeEl = typeof document !== 'undefined'
      ? document.querySelector('[data-role="stream-status"]')
      : null
    _attachStream(runId, statusEl, noticeEl)
  }

  if (typeof runIndexMod.resetRunIndexState === 'function') {
    runIndexMod.resetRunIndexState()
  }
  if (typeof runIndexMod.initOperatorRunIndex === 'function') {
    const runIndexOpts = opts?.endpointBase !== undefined
      ? {endpointBase: opts.endpointBase, fixtureSessionId: opts.fixtureSessionId, onSelectRun}
      : {onSelectRun}
    await runIndexMod.initOperatorRunIndex(runIndexOpts)
  }

  if (typeof launchMod.resetLaunchState === 'function') {
    launchMod.resetLaunchState()
  }
  if (typeof launchMod.initOperatorLaunch === 'function') {
    const launchOpts = opts?.endpointBase !== undefined
      ? {endpointBase: opts.endpointBase, getScenario: opts.getScenario, fixtureSessionId: opts.fixtureSessionId, onRunLaunched}
      : {onRunLaunched}
    await launchMod.initOperatorLaunch(launchOpts)
  }

  return () => {
    // Close the active stream handle on cleanup.
    _closeActiveStream()
    if (typeof streamMod.resetBootstrapState === 'function') {
      streamMod.resetBootstrapState()
    }
    if (typeof launchMod.resetLaunchState === 'function') {
      launchMod.resetLaunchState()
    }
    if (typeof runIndexMod.resetRunIndexState === 'function') {
      runIndexMod.resetRunIndexState()
    }
  }
}

/**
 * Create an operator runtime handle.
 *
 * Loads or initializes existing public/operator-*.js modules after the React
 * operator shell reaches ready state. Returns a handle with a cleanup function
 * that closes streams, removes listeners, clears timers, and wipes generated DOM.
 *
 * One lifecycle owner: React calls this once when the shell is ready and calls
 * cleanup() on unmount or auth expiry. React Strict Mode double-effects are safe
 * because cleanup() is idempotent.
 *
 * @param opts - Runtime options including container, state change callback, and
 *               optional injectable runtime loader for testing.
 * @returns A handle with isMounted and cleanup().
 */
export function createOperatorRuntime(opts: OperatorRuntimeOptions): OperatorRuntimeHandle {
  const {container: _container, onStateChange, _runtimeLoader, fixtureMode, fixtureEndpointBase, fixtureSessionId, getScenario} = opts

  let mounted = true
  let cleanupFns: Array<() => void> = []

  const handle: OperatorRuntimeHandle = {
    get isMounted() {
      return mounted
    },
    cleanup() {
      if (!mounted) return
      mounted = false
      for (const fn of cleanupFns) {
        try {
          fn()
        } catch {
          // Cleanup errors are swallowed — never log sensitive context
        }
      }
      cleanupFns = []
    },
  }

  const loader = _runtimeLoader ?? defaultRuntimeLoader

  // Build loader options: only pass fixture context in fixture mode (dev builds only).
  // Production bundles must not contain fixture route strings.
  const loaderOpts =
    fixtureMode === true
      ? {
          endpointBase: fixtureEndpointBase,
          fixtureSessionId,
          getScenario,
        }
      : undefined

  loader(loaderOpts).then(maybeCleanup => {
    if (typeof maybeCleanup !== 'function') return
    if (mounted) {
      cleanupFns.push(maybeCleanup)
    } else {
      maybeCleanup()
    }
  }).catch(() => {
    if (mounted) {
      onStateChange('unavailable')
    }
  })

  return handle
}
