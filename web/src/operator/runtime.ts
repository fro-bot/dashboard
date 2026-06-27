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
   */
  readonly _runtimeLoader?: () => Promise<void | (() => void)>
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

/**
 * Default runtime loader: dynamically imports the operator runtime modules.
 *
 * In the React shell, the operator runtime scripts are served as static assets.
 * This loader is async so that a missing module transitions the shell to
 * unavailable without crashing.
 *
 * The loader imports with `?manual=1` so the public modules skip their
 * auto-bootstrap on evaluation. The runtime seam then calls the start hooks
 * explicitly, giving it deterministic lifecycle control.
 *
 * Returns a cleanup function that calls the public modules' reset functions,
 * closing handles and removing listeners registered during this load.
 *
 * Uses `@vite-ignore` to prevent Vite from trying to resolve the browser-only
 * /static/* paths at build time. This is CSP-safe (no eval/Function constructor).
 */
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

async function defaultRuntimeLoader(): Promise<() => void> {
  const streamMod = await import(/* @vite-ignore */ _streamSpecifier) as {
    bootstrapOperatorStreams?: () => void
    resetBootstrapState?: () => void
  }
  if (typeof streamMod.resetBootstrapState === 'function') {
    streamMod.resetBootstrapState()
  }
  if (typeof streamMod.bootstrapOperatorStreams === 'function') {
    streamMod.bootstrapOperatorStreams()
  }

  const launchMod = await import(/* @vite-ignore */ _launchSpecifier) as {
    initOperatorLaunch?: () => Promise<void>
    resetLaunchState?: () => void
  }
  if (typeof launchMod.resetLaunchState === 'function') {
    launchMod.resetLaunchState()
  }
  if (typeof launchMod.initOperatorLaunch === 'function') {
    await launchMod.initOperatorLaunch()
  }

  return () => {
    if (typeof streamMod.resetBootstrapState === 'function') {
      streamMod.resetBootstrapState()
    }
    if (typeof launchMod.resetLaunchState === 'function') {
      launchMod.resetLaunchState()
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
  const {container: _container, onStateChange, _runtimeLoader} = opts

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
  loader().then(maybeCleanup => {
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
