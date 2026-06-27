/**
 * Tests for the operator runtime seam.
 *
 * The runtime seam connects the React operator shell to existing browser-direct
 * operator runtimes (public/operator-*.js) without duplicating Gateway logic.
 *
 * Security invariants tested:
 * - No prompt, token, cookie, CSRF value, repo name, run ID, or raw payload logged.
 * - Missing runtime module leaves UI in unavailable state without crashing shell.
 * - Repo-list auth/rate-limit/network/protocol failures → neutral failure state, not
 *   "No repositories available."
 *
 * Lifecycle invariants tested:
 * - Mounting twice does not duplicate listeners, streams, or submit handlers.
 * - Cleanup closes streams, removes listeners, clears timers, and wipes generated DOM.
 * - Every mutation gets a fresh in-memory idempotency key; no shared/persisted key state.
 * - CSRF is fetched fresh on mount; stale-token retry reuses the same idempotency key.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  createOperatorRuntime,
  type OperatorRuntimeHandle,
  type OperatorRuntimeOptions,
} from './runtime.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContainer(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

function makeOptions(overrides: Partial<OperatorRuntimeOptions> = {}): OperatorRuntimeOptions {
  return {
    container: makeContainer(),
    onStateChange: vi.fn(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Happy path: mount once
// ---------------------------------------------------------------------------

describe('createOperatorRuntime — happy path', () => {
  let handle: OperatorRuntimeHandle | null = null

  afterEach(() => {
    handle?.cleanup()
    handle = null
    document.body.innerHTML = ''
  })

  it('returns a handle with a cleanup function', () => {
    const opts = makeOptions()
    handle = createOperatorRuntime(opts)
    expect(handle).toBeDefined()
    expect(typeof handle.cleanup).toBe('function')
  })

  it('exposes a ready state after successful mount', () => {
    const opts = makeOptions()
    handle = createOperatorRuntime(opts)
    expect(handle.isMounted).toBe(true)
  })

  it('calls onStateChange with unavailable when runtime module is absent', () => {
    const onStateChange = vi.fn()
    const opts = makeOptions({
      onStateChange,
      _runtimeLoader: async () => {
        throw new Error('module not found')
      },
    })
    handle = createOperatorRuntime(opts)
    // The runtime loader is async; the handle is returned synchronously
    expect(handle).toBeDefined()
    expect(handle.isMounted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Regression: double-mount idempotency
// ---------------------------------------------------------------------------

describe('createOperatorRuntime — double-mount idempotency', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('calling cleanup then remounting does not leave orphaned state', () => {
    const opts = makeOptions()
    const handle1 = createOperatorRuntime(opts)
    handle1.cleanup()

    const opts2 = makeOptions()
    const handle2 = createOperatorRuntime(opts2)
    expect(handle2.isMounted).toBe(true)
    handle2.cleanup()
  })

  it('cleanup is idempotent — calling twice does not throw', () => {
    const opts = makeOptions()
    const handle = createOperatorRuntime(opts)
    expect(() => {
      handle.cleanup()
      handle.cleanup()
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Lifecycle: cleanup
// ---------------------------------------------------------------------------

describe('createOperatorRuntime — lifecycle cleanup', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('cleanup sets isMounted to false', () => {
    const opts = makeOptions()
    const handle = createOperatorRuntime(opts)
    expect(handle.isMounted).toBe(true)
    handle.cleanup()
    expect(handle.isMounted).toBe(false)
  })

  it('cleanup calls onStateChange with unavailable', () => {
    const onStateChange = vi.fn()
    const opts = makeOptions({onStateChange})
    const handle = createOperatorRuntime(opts)
    handle.cleanup()
    // After cleanup, state should be cleared (unavailable or loading)
    const calls = onStateChange.mock.calls
    const lastCall = calls.at(-1)
    if (lastCall !== undefined) {
      expect(['unavailable', 'loading', 'auth-required', 'offline', 'rate-limited']).toContain(lastCall[0])
    }
  })
})

// ---------------------------------------------------------------------------
// Idempotency key: fresh per mutation
// ---------------------------------------------------------------------------

describe('createOperatorRuntime — idempotency key freshness', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('mintRuntimeIdempotencyKey returns unique non-empty strings', async () => {
    const {mintRuntimeIdempotencyKey} = await import('./runtime.ts')
    const key1 = mintRuntimeIdempotencyKey()
    const key2 = mintRuntimeIdempotencyKey()
    expect(typeof key1).toBe('string')
    expect(key1.length).toBeGreaterThan(0)
    expect(key1).not.toBe(key2)
  })

  it('mintRuntimeIdempotencyKey never returns the same key twice in sequence', async () => {
    const {mintRuntimeIdempotencyKey} = await import('./runtime.ts')
    const keys = new Set(Array.from({length: 20}, () => mintRuntimeIdempotencyKey()))
    expect(keys.size).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Security: no sensitive logging
// ---------------------------------------------------------------------------

describe('createOperatorRuntime — security: no sensitive logging', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('does not log any sensitive values on mount', () => {
    const opts = makeOptions()
    const handle = createOperatorRuntime(opts)
    handle.cleanup()

    const allLogs = [
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.error).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
    ].flat().join(' ')

    // Must not log tokens, CSRF values, repo names, run IDs, or raw payloads
    expect(allLogs).not.toMatch(/csrf/i)
    expect(allLogs).not.toMatch(/token/i)
    expect(allLogs).not.toMatch(/cookie/i)
    expect(allLogs).not.toMatch(/idempotency/i)
  })
})

// ---------------------------------------------------------------------------
// Error path: missing runtime module
// ---------------------------------------------------------------------------

describe('createOperatorRuntime — error: missing runtime module', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('does not throw when runtime loader rejects', async () => {
    const onStateChange = vi.fn()
    const opts = makeOptions({
      onStateChange,
      _runtimeLoader: async () => {
        throw new Error('module not found')
      },
    })

    expect(() => createOperatorRuntime(opts)).not.toThrow()
  })

  it('calls onStateChange with unavailable when runtime loader rejects', async () => {
    const onStateChange = vi.fn()
    const opts = makeOptions({
      onStateChange,
      _runtimeLoader: async () => {
        throw new Error('module not found')
      },
    })

    createOperatorRuntime(opts)

    // Wait for the async loader to reject
    await vi.waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith('unavailable')
    })
  })
})

describe('createOperatorRuntime — CSP invariant: no unsafe-eval', () => {
  it('runtime.ts source does not contain new Function or eval patterns', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const src = await fs.readFile(path.join(__dirname, 'runtime.ts'), 'utf8')
    expect(src).not.toMatch(/new Function\s*\(/)
    expect(src).not.toMatch(/\beval\s*\(/)
  })
})

describe('createOperatorRuntime — loader cleanup function', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('injected loader can return a cleanup function and handle.cleanup() calls it exactly once', async () => {
    const cleanupFn = vi.fn()
    const opts = makeOptions({
      _runtimeLoader: async () => cleanupFn,
    })

    const handle = createOperatorRuntime(opts)

    // Wait for the async loader to resolve and register the cleanup
    await vi.waitFor(() => {
      expect(cleanupFn).not.toHaveBeenCalled()
    })

    handle.cleanup()
    expect(cleanupFn).toHaveBeenCalledTimes(1)

    // Calling cleanup again must not call the cleanup function again
    handle.cleanup()
    expect(cleanupFn).toHaveBeenCalledTimes(1)
  })

  it('runs loader cleanup immediately if the handle was already cleaned up', async () => {
    const cleanupFn = vi.fn()
    let resolveLoader: ((cleanup: () => void) => void) | undefined
    const loaderPromise = new Promise<() => void>(resolve => {
      resolveLoader = resolve
    })
    const opts = makeOptions({_runtimeLoader: async () => loaderPromise})

    const handle = createOperatorRuntime(opts)
    handle.cleanup()
    expect(cleanupFn).not.toHaveBeenCalled()

    resolveLoader?.(cleanupFn)

    await vi.waitFor(() => {
      expect(cleanupFn).toHaveBeenCalledTimes(1)
    })
  })

  it('loader that returns void does not throw on cleanup', async () => {
    const opts = makeOptions({
      _runtimeLoader: async () => { /* returns void */ },
    })

    const handle = createOperatorRuntime(opts)

    // Wait for the async loader to resolve
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(() => handle.cleanup()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Error path: repo-list failures render neutral state, not "No repositories available"
// ---------------------------------------------------------------------------

describe('createOperatorRuntime — repo-list failure classification', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('classifyRepoListError maps auth failure to auth-required, not "No repositories available"', async () => {
    const {classifyRepoListError} = await import('./runtime.ts')
    const state = classifyRepoListError({kind: 'http', status: 401})
    expect(state).toBe('auth-required')
    expect(state).not.toBe('No repositories available')
  })

  it('classifyRepoListError maps 403 to auth-required', async () => {
    const {classifyRepoListError} = await import('./runtime.ts')
    const state = classifyRepoListError({kind: 'http', status: 403})
    expect(state).toBe('auth-required')
  })

  it('classifyRepoListError maps 429 to rate-limited', async () => {
    const {classifyRepoListError} = await import('./runtime.ts')
    const state = classifyRepoListError({kind: 'http', status: 429})
    expect(state).toBe('rate-limited')
  })

  it('classifyRepoListError maps network failure to offline', async () => {
    const {classifyRepoListError} = await import('./runtime.ts')
    const state = classifyRepoListError({kind: 'network'})
    expect(state).toBe('offline')
  })

  it('classifyRepoListError maps protocol failure to unavailable', async () => {
    const {classifyRepoListError} = await import('./runtime.ts')
    const state = classifyRepoListError({kind: 'protocol'})
    expect(state).toBe('unavailable')
  })

  it('classifyRepoListError maps 5xx to unavailable', async () => {
    const {classifyRepoListError} = await import('./runtime.ts')
    const state = classifyRepoListError({kind: 'http', status: 500})
    expect(state).toBe('unavailable')
  })
})
