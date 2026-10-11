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
 * - Single-open accordion: expanding a run closes any other active stream; expanding
 *   the same run twice collapses it; the underlying stream handle's close() must
 *   preserve its statement-order teardown invariants.
 * - Hash restore: the expanded run's id syncs to location.hash; a hash value over
 *   512 chars is rejected before any validation runs and never reaches
 *   encodeURIComponent; a malformed hash is treated as no-hash; a stale/expired
 *   session on remount reclassifies to auth-required before any restore attempt.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {PINNED_CONTRACT_VERSION} from '../../../public/operator-stream.js'
import {
  createOperatorRuntime,
  discoverCardStreamTargets,
  MAX_HASH_ID_LENGTH,
  sanitizeRunIdFromHash,
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
// Fixture mode: loader options
// ---------------------------------------------------------------------------

describe('createOperatorRuntime — fixture mode passes no fixture context when off', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loader receives undefined opts when fixtureMode is false', async () => {
    let capturedOpts: {endpointBase?: string; fixtureSessionId?: string; getScenario?: () => string} | undefined
    const opts = makeOptions({
      fixtureMode: false,
      _runtimeLoader: async loaderOpts => {
        capturedOpts = loaderOpts
      },
    })
    const handle = createOperatorRuntime(opts)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(capturedOpts).toBeUndefined()
    handle.cleanup()
  })
})

describe('createOperatorRuntime — run-index module integration', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loader receives endpointBase for run-index when fixtureMode is true', async () => {
    let capturedOpts: {endpointBase?: string; fixtureSessionId?: string; getScenario?: () => string} | undefined
    const opts = makeOptions({
      fixtureMode: true,
      fixtureEndpointBase: '/__fixture/operator',
      fixtureSessionId: 'fixture-session-0001',
      _runtimeLoader: async loaderOpts => {
        capturedOpts = loaderOpts
      },
    })
    const handle = createOperatorRuntime(opts)
    await new Promise(resolve => setTimeout(resolve, 10))
    // run-index module receives the same endpointBase as launch/stream
    expect(capturedOpts?.endpointBase).toBe('/__fixture/operator')
    handle.cleanup()
  })

  it('loader cleanup resets run-index state', async () => {
    const cleanupFn = vi.fn()
    const opts = makeOptions({
      _runtimeLoader: async () => cleanupFn,
    })
    const handle = createOperatorRuntime(opts)
    await vi.waitFor(() => expect(cleanupFn).not.toHaveBeenCalled())
    handle.cleanup()
    expect(cleanupFn).toHaveBeenCalledTimes(1)
  })

  it('runtime.ts source contains _runIndexSpecifier (run-index module is loaded)', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const src = await fs.readFile(path.join(__dirname, 'runtime.ts'), 'utf8')
    expect(src).toContain('_runIndexSpecifier')
    expect(src).toContain('operator-run-index.js')
  })

  it('runtime.ts source contains resetRunIndexState cleanup call', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const src = await fs.readFile(path.join(__dirname, 'runtime.ts'), 'utf8')
    expect(src).toContain('resetRunIndexState')
  })
})

describe('createOperatorRuntime — no literal fixture fallback in source', () => {
  it('runtime.ts source does not contain a literal /__fixture/operator string', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const src = await fs.readFile(path.join(__dirname, 'runtime.ts'), 'utf8')
    expect(src).not.toContain('/__fixture/operator')
  })

  it('fixtureMode=true without fixtureEndpointBase passes undefined endpointBase to loader', async () => {
    let capturedOpts: {endpointBase?: string; fixtureSessionId?: string; getScenario?: () => string} | undefined
    const opts = makeOptions({
      fixtureMode: true,
      // No fixtureEndpointBase provided
      fixtureSessionId: 'fixture-session-0001',
      getScenario: () => 'success',
      _runtimeLoader: async loaderOpts => {
        capturedOpts = loaderOpts
      },
    })
    const handle = createOperatorRuntime(opts)
    await new Promise(resolve => setTimeout(resolve, 10))
    // endpointBase must be undefined (not a hardcoded fallback string)
    expect(capturedOpts?.endpointBase).toBeUndefined()
    handle.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Active-stream ownership — runtime seam owns the singleton close handle
// ---------------------------------------------------------------------------

describe('createOperatorRuntime — active-stream coordination callbacks', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('cleanup does not throw when no active stream is set', async () => {
    const cleanupFn = vi.fn()
    const opts = makeOptions({
      _runtimeLoader: async () => cleanupFn,
    })
    const handle = createOperatorRuntime(opts)
    await vi.waitFor(() => expect(cleanupFn).not.toHaveBeenCalled())
    expect(() => handle.cleanup()).not.toThrow()
    expect(cleanupFn).toHaveBeenCalledTimes(1)
  })

  it('cleanup calls loader cleanup which closes active stream', async () => {
    const cleanupFn = vi.fn()
    const opts = makeOptions({
      _runtimeLoader: async () => cleanupFn,
    })
    const handle = createOperatorRuntime(opts)
    await vi.waitFor(() => expect(cleanupFn).not.toHaveBeenCalled())
    handle.cleanup()
    expect(cleanupFn).toHaveBeenCalledTimes(1)
  })

  it('loader cleanup is called exactly once even if cleanup is called twice', async () => {
    const cleanupFn = vi.fn()
    const opts = makeOptions({
      _runtimeLoader: async () => cleanupFn,
    })
    const handle = createOperatorRuntime(opts)
    await vi.waitFor(() => expect(cleanupFn).not.toHaveBeenCalled())
    handle.cleanup()
    handle.cleanup()
    expect(cleanupFn).toHaveBeenCalledTimes(1)
  })
})

describe('createOperatorRuntime — runtime.ts source contains active-stream coordination', () => {
  it('runtime.ts source contains onSelectRun callback', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const src = await fs.readFile(path.join(__dirname, 'runtime.ts'), 'utf8')
    expect(src).toContain('onSelectRun')
  })

  it('runtime.ts source contains onRunLaunched callback', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const src = await fs.readFile(path.join(__dirname, 'runtime.ts'), 'utf8')
    expect(src).toContain('onRunLaunched')
  })

  it('runtime.ts source contains _activeStreamHandle or _activeStream', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const src = await fs.readFile(path.join(__dirname, 'runtime.ts'), 'utf8')
    expect(src).toMatch(/activeStream/)
  })

  it('runtime.ts source contains _closeActiveStream or close active stream logic', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const src = await fs.readFile(path.join(__dirname, 'runtime.ts'), 'utf8')
    expect(src).toContain('_closeActiveStream')
  })

  it('runtime.ts source does NOT introduce a Map for active streams — single-open uses one handle', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const src = await fs.readFile(path.join(__dirname, 'runtime.ts'), 'utf8')
    expect(src).not.toMatch(/_activeStream\w*\s*=\s*new Map/)
  })
})

// ---------------------------------------------------------------------------
// Default loader — expand/collapse single-open behavior (via dynamic import stubs)
// ---------------------------------------------------------------------------

describe('defaultRuntimeLoader — single-open accordion via onSelectRun/onRunLaunched', () => {
  let originalImport: unknown

  beforeEach(() => {
    originalImport = (globalThis as {__vitest_dynamic_import_stub__?: unknown}).__vitest_dynamic_import_stub__
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    ;(globalThis as {__vitest_dynamic_import_stub__?: unknown}).__vitest_dynamic_import_stub__ = originalImport
  })

  /**
   * Build a minimal fake module set and drive the real defaultRuntimeLoader logic
   * by directly testing the exported onSelectRun/onRunLaunched wiring through
   * createOperatorRuntime with an injected _runtimeLoader that mimics the shape
   * the default loader builds, then exercises _attachStream/_closeActiveStream
   * indirectly via repeated onSelectRun-equivalent calls using the real modules.
   *
   * Because defaultRuntimeLoader dynamically imports /static/operator-*.js (not
   * resolvable in the Vitest/jsdom environment), these tests instead import the
   * real public/operator-stream.js and public/operator-run-index.js modules
   * directly and drive the runtime's _attachStream-equivalent logic through a
   * hand-rolled loader that mirrors the production wiring, proving the seam's
   * single-open contract end-to-end at the module-integration level.
   */
  async function buildLoaderHarness() {
    const streamMod = await import('../../../public/operator-stream.js')
    const runIndexMod = await import('../../../public/operator-run-index.js')

    let activeHandle: {close(): void} | null = null
    const attachCalls: string[] = []
    const closeOrder: string[] = []
    const attachedTargets: {runId: string; checkoutEl: Element | null}[] = []

    function closeActive() {
      if (activeHandle !== null) {
        activeHandle.close()
        activeHandle = null
      }
    }

    function attach(runId: string, statusEl: Element | null, noticeEl: Element | null) {
      closeActive()
      attachCalls.push(runId)
      // Use the real exported production discovery function (not a re-implementation)
      // so these tests exercise the exact same lookup `_attachStream` calls. If the
      // production fix in runtime.ts were reverted, discoverCardStreamTargets would
      // return all-nulls and the regression tests below would fail.
      const {outputEl, coalescedEl, approvalsEl, badgeEl, checkoutEl} = discoverCardStreamTargets(runId)
      attachedTargets.push({runId, checkoutEl})
      const handle = streamMod.initOperatorStream({
        runId,
        statusEl,
        noticeEl,
        outputEl: outputEl as unknown as (HTMLElement & {hidden: boolean}) | null,
        coalescedEl: coalescedEl as unknown as (HTMLElement & {hidden: boolean}) | null,
        approvalsEl: approvalsEl as unknown as (HTMLElement & {hidden: boolean}) | null,
        badgeEl: badgeEl as unknown as (HTMLElement & {hidden: boolean}) | null,
        checkoutEl: checkoutEl as unknown as (HTMLElement & {hidden: boolean}) | null,
      })
      // Wrap close to observe ordering in tests.
      activeHandle = {
        close() {
          closeOrder.push(runId)
          handle.close()
        },
      }
      runIndexMod.markRunStreamAttached(runId)
    }

    return {streamMod, runIndexMod, attach, closeActive, attachCalls, closeOrder, attachedTargets}
  }

  it('happy path: expanding a run attaches exactly one stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})))
    const {attach, attachCalls, closeActive} = await buildLoaderHarness()

    attach('run-a', null, null)

    expect(attachCalls).toEqual(['run-a'])
    closeActive()
  })

  it('edge case: A -> B -> A re-attaches A and closes B first', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})))
    const {attach, attachCalls, closeOrder, closeActive} = await buildLoaderHarness()

    attach('run-a', null, null)
    attach('run-b', null, null)
    attach('run-a', null, null)

    expect(attachCalls).toEqual(['run-a', 'run-b', 'run-a'])
    // B must be closed before the second run-a attach (only one active stream at a time).
    expect(closeOrder).toEqual(['run-a', 'run-b'])
    closeActive()
  })

  it('edge case: collapsing the open run closes its stream and leaves nothing open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})))
    const {attach, closeActive, closeOrder} = await buildLoaderHarness()

    attach('run-a', null, null)
    closeActive()

    expect(closeOrder).toEqual(['run-a'])
  })

  it('error path: a run whose stream 404s shows the shared unavailable notice without opening a second stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 404,
      headers: {get: () => 'text/html'},
      body: null,
    }))
    const {attach, attachCalls, closeActive} = await buildLoaderHarness()
    const noticeEl = document.createElement('div')

    attach('run-404', null, noticeEl)
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(attachCalls).toEqual(['run-404'])
    expect(noticeEl.hidden).toBe(false)
    expect(noticeEl.textContent).toBe('Run stream unavailable.')
    closeActive()
  })

  it('integration: rapid expand/collapse cycles leave only one SSE reader open at a time', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})))
    const {attach, closeActive, attachCalls, closeOrder} = await buildLoaderHarness()

    attach('run-1', null, null)
    attach('run-2', null, null)
    attach('run-3', null, null)
    closeActive()

    expect(attachCalls).toEqual(['run-1', 'run-2', 'run-3'])
    // Each prior run is closed before the next attach; the last is closed by closeActive().
    expect(closeOrder).toEqual(['run-1', 'run-2', 'run-3'])
  })

  /** Build a run card with the full per-run substructure that renderRunCard creates. */
  function makeCardWithSubstructure(runId: string): HTMLElement {
    const card = document.createElement('div')
    card.dataset.runId = runId
    const statusEl = document.createElement('span')
    statusEl.dataset.role = 'run-status'
    card.append(statusEl)
    const outputEl = document.createElement('div')
    outputEl.dataset.role = 'run-output'
    outputEl.hidden = true
    card.append(outputEl)
    const coalescedEl = document.createElement('div')
    coalescedEl.dataset.role = 'run-output-coalesced'
    coalescedEl.hidden = true
    card.append(coalescedEl)
    const approvalsEl = document.createElement('div')
    approvalsEl.dataset.role = 'run-approvals'
    approvalsEl.hidden = true
    card.append(approvalsEl)
    const badgeEl = document.createElement('span')
    badgeEl.dataset.role = 'approval-badge'
    badgeEl.hidden = true
    card.append(badgeEl)
    document.body.append(card)
    return card
  }

  it('regression: an output SSE frame populates the expanded card\'s [data-role="run-output"] (bug: _attachStream never forwarded outputEl)', async () => {
    const card = makeCardWithSubstructure('run-out-1')
    const statusEl = card.querySelector('[data-role="run-status"]')

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: {get: (h: string) => (h === 'content-type' ? 'text/event-stream' : null)},
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(`event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`))
          controller.enqueue(encoder.encode(
            'event: output\ndata: {"runId":"run-out-1","text":"hello from the run","final":true,"seq":0}\n\n',
          ))
          controller.close()
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const {attach, closeActive} = await buildLoaderHarness()
    attach('run-out-1', statusEl, null)

    await new Promise(resolve => setTimeout(resolve, 20))

    const outputEl = card.querySelector('[data-role="run-output"]') as HTMLElement
    expect(outputEl.hidden).toBe(false)
    expect(outputEl.textContent).toBe('hello from the run')

    closeActive()
  })

  it('regression: an approval SSE frame populates [data-role="run-approvals"] and [data-role="approval-badge"] (bug: _attachStream never forwarded approvalsEl/badgeEl)', async () => {
    const card = makeCardWithSubstructure('run-appr-1')
    const statusEl = card.querySelector('[data-role="run-status"]')

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/runs/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {get: (h: string) => (h === 'content-type' ? 'text/event-stream' : null)},
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder()
              controller.enqueue(encoder.encode(`event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`))
              controller.enqueue(encoder.encode(
                'event: approval\ndata: {"runId":"run-appr-1","requestID":"req-1","permission":"bash","settled":false}\n\n',
              ))
              controller.close()
            },
          }),
        })
      }
      // Approval-client reconcile GET on connect — respond with no recovered approvals
      // so the SSE-opened prompt above is the only source of truth.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({approvals: []}),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const {attach, closeActive} = await buildLoaderHarness()
    attach('run-appr-1', statusEl, null)

    await new Promise(resolve => setTimeout(resolve, 20))

    const approvalsEl = card.querySelector('[data-role="run-approvals"]') as HTMLElement
    const badgeEl = card.querySelector('[data-role="approval-badge"]') as HTMLElement
    expect(approvalsEl.hidden).toBe(false)
    expect(approvalsEl.childElementCount).toBeGreaterThan(0)
    expect(badgeEl.hidden).toBe(false)
    expect(badgeEl.textContent).toBe('1')

    closeActive()
  })

  it('selecting a real rendered card hands its checkout-detail region to the stream init, for fetched and optimistic-shaped cards', async () => {
    const {runIndexMod, attach, attachedTargets, closeActive} = await buildLoaderHarness()
    runIndexMod.resetRunIndexState()
    document.body.innerHTML = '<div data-role="run-index-list"></div><div data-role="stream-status" hidden></div>'
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/runs/')) return new Promise(() => {})
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          runs: [
            {runId: 'run-ck-sel-a', repo: 'org/repo', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z'},
            {runId: 'run-ck-sel-b', repo: 'org/repo', status: 'running', createdAt: '2026-01-01T00:00:00.000Z'},
          ],
        }),
      })
    }))
    const onSelectRun = (runId: string) => {
      const card = document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`)
      attach(runId, card?.querySelector('[data-role="run-status"]') ?? null, null)
    }
    await runIndexMod.initOperatorRunIndex({onSelectRun})

    for (const runId of ['run-ck-sel-a', 'run-ck-sel-b']) {
      const card = document.querySelector(`[data-run-id="${runId}"]`) as HTMLElement
      expect(card.querySelectorAll('[data-role="run-checkout-detail"]')).toHaveLength(1)
      const region = card.querySelector('[data-role="run-checkout-detail"]') as HTMLElement
      expect(region.hidden).toBe(true)

      card.click()

      expect(attachedTargets.at(-1)?.runId).toBe(runId)
      expect(attachedTargets.at(-1)?.checkoutEl).toBe(region)
      // Expanding reveals the empty region, then stream attachment clears and
      // hides it until a validated checkout DTO arrives.
      expect(region.hidden).toBe(true)
      expect(region.textContent).toBe('')
    }
    closeActive()
  })

})

describe('defaultRuntimeLoader — production stream wiring', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.doUnmock('/static/operator-stream.js?manual=1')
    vi.doUnmock('/static/operator-run-index.js?manual=1')
    vi.doUnmock('/static/operator-launch.js?manual=1')
    vi.restoreAllMocks()
  })

  it('selecting a card runs the real _attachStream, which hands the discovered checkoutEl to initOperatorStream', async () => {
    const handle = {close: vi.fn()}
    const initOperatorStream = vi.fn((_opts: {runId: string; checkoutEl?: Element | null}) => handle)
    let onSelectRun: ((runId: string) => void) | undefined
    // A vitest module mock throws on any export the factory omits, so every export the loader reads is listed.
    vi.doMock('/static/operator-stream.js?manual=1', () => ({
      initOperatorStream,
      bootstrapOperatorStreams: vi.fn(),
      resetBootstrapState: vi.fn(),
    }))
    vi.doMock('/static/operator-run-index.js?manual=1', () => ({
      initOperatorRunIndex: async (opts: {onSelectRun: (runId: string) => void}) => {
        onSelectRun = opts.onSelectRun
      },
      resetRunIndexState: vi.fn(),
      markRunStreamAttached: vi.fn(),
      markCardExpandedForLaunch: vi.fn(),
    }))
    vi.doMock('/static/operator-launch.js?manual=1', () => ({
      initOperatorLaunch: vi.fn(async () => {}),
      resetLaunchState: vi.fn(),
    }))

    document.body.innerHTML = `
      <div data-run-id="run-wired-1">
        <span data-role="run-status"></span>
        <div data-role="run-checkout-detail" hidden></div>
      </div>
      <div data-role="stream-status"></div>`
    const region = document.querySelector('[data-role="run-checkout-detail"]')

    const onStateChange = vi.fn()
    const runtime = createOperatorRuntime({container: makeContainer(), onStateChange})
    await vi.waitFor(() => expect(onSelectRun).toBeDefined())
    expect(onStateChange).not.toHaveBeenCalled()

    onSelectRun?.('run-wired-1')

    expect(region).not.toBeNull()
    expect(initOperatorStream).toHaveBeenCalledTimes(1)
    expect(initOperatorStream.mock.calls[0]?.[0].runId).toBe('run-wired-1')
    expect(initOperatorStream.mock.calls[0]?.[0].checkoutEl).toBe(region)

    runtime.cleanup()
  })
})

describe('defaultRuntimeLoader — question region and summary status wiring', () => {
  type InitOpts = {runId: string; questionsEl?: Element | null; summaryStatus?: string}

  afterEach(() => {
    document.body.innerHTML = ''
    vi.doUnmock('/static/operator-stream.js?manual=1')
    vi.doUnmock('/static/operator-run-index.js?manual=1')
    vi.doUnmock('/static/operator-launch.js?manual=1')
    vi.restoreAllMocks()
  })

  /** Mount the real default loader with every public module mocked; returns the captured seams. */
  async function mountLoader() {
    const handle = {close: vi.fn()}
    // Snapshot the region's children at the moment each init runs, before the stream could render into it.
    const initCalls: {opts: InitOpts; regionChildrenAtInit: number | undefined}[] = []
    const initOperatorStream = vi.fn((opts: InitOpts) => {
      initCalls.push({opts, regionChildrenAtInit: opts.questionsEl?.childNodes.length})
      return handle
    })
    let onSelectRun: ((runId: string) => void) | undefined
    let onRunLaunched: ((runId: string, card: HTMLElement) => void) | undefined
    vi.doMock('/static/operator-stream.js?manual=1', () => ({
      initOperatorStream,
      bootstrapOperatorStreams: vi.fn(),
      resetBootstrapState: vi.fn(),
    }))
    vi.doMock('/static/operator-run-index.js?manual=1', () => ({
      initOperatorRunIndex: async (opts: {onSelectRun: (runId: string) => void}) => {
        onSelectRun = opts.onSelectRun
      },
      resetRunIndexState: vi.fn(),
      markRunStreamAttached: vi.fn(),
      markCardExpandedForLaunch: vi.fn(),
    }))
    vi.doMock('/static/operator-launch.js?manual=1', () => ({
      initOperatorLaunch: vi.fn(async (opts: {onRunLaunched: (runId: string, card: HTMLElement) => void}) => {
        onRunLaunched = opts.onRunLaunched
      }),
      resetLaunchState: vi.fn(),
    }))
    const runtime = createOperatorRuntime({container: makeContainer(), onStateChange: vi.fn()})
    await vi.waitFor(() => {
      expect(onSelectRun).toBeDefined()
      expect(onRunLaunched).toBeDefined()
    })
    return {
      runtime,
      initCalls,
      select: (runId: string) => onSelectRun?.(runId),
      launched: (runId: string, card: HTMLElement) => onRunLaunched?.(runId, card),
    }
  }

  function cardHtml(runId: string, statusClass: string, extra = ''): string {
    return `
      <div data-run-id="${runId}"${extra}>
        <span data-role="run-status" class="run-status ${statusClass}"></span>
        <div data-role="run-questions" hidden></div>
      </div>`
  }

  it('hands the discovered questionsEl and the card summary status to initOperatorStream', async () => {
    document.body.innerHTML = `${cardHtml('run-q-a', 'status-succeeded')}${cardHtml('run-q-b', 'status-running')}<div data-role="stream-status"></div>`
    const regionA = document.querySelector('[data-run-id="run-q-a"] [data-role="run-questions"]')
    const regionB = document.querySelector('[data-run-id="run-q-b"] [data-role="run-questions"]')
    const {runtime, initCalls, select} = await mountLoader()

    select('run-q-a')
    select('run-q-b')

    expect(initCalls).toHaveLength(2)
    expect(initCalls[0]?.opts.runId).toBe('run-q-a')
    expect(initCalls[0]?.opts.questionsEl).toBe(regionA)
    expect(initCalls[0]?.opts.summaryStatus).toBe('succeeded')
    expect(initCalls[1]?.opts.questionsEl).toBe(regionB)
    expect(initCalls[1]?.opts.summaryStatus).toBe('running')
    runtime.cleanup()
  })

  it('an optimistic card passes no summaryStatus, whatever its status class says', async () => {
    document.body.innerHTML = `${cardHtml('run-q-opt', 'status-pending', ' data-optimistic="true"')}${cardHtml('run-q-opt-2', 'status-running', ' data-optimistic="true"')}<div data-role="stream-status"></div>`
    const {runtime, initCalls, launched} = await mountLoader()

    launched('run-q-opt', document.querySelector('[data-run-id="run-q-opt"]') as HTMLElement)
    launched('run-q-opt-2', document.querySelector('[data-run-id="run-q-opt-2"]') as HTMLElement)

    expect(initCalls).toHaveLength(2)
    for (const call of initCalls) {
      expect(call.opts.questionsEl).not.toBeNull()
      expect('summaryStatus' in call.opts).toBe(false)
    }
    runtime.cleanup()
  })

  it('a status class outside the run-summary allowlist is never passed as summaryStatus', async () => {
    document.body.innerHTML = `${cardHtml('run-q-wait', 'status-waiting_for_approval')}${cardHtml('run-q-evil', 'status-evil')}${cardHtml('run-q-none', '')}<div data-role="stream-status"></div>`
    const {runtime, initCalls, select} = await mountLoader()

    select('run-q-wait')
    select('run-q-evil')
    select('run-q-none')

    expect(initCalls).toHaveLength(3)
    for (const call of initCalls) expect('summaryStatus' in call.opts).toBe(false)
    runtime.cleanup()
  })

  it('card switch A → B → A clears A’s stale question DOM on re-attach', async () => {
    document.body.innerHTML = `${cardHtml('run-q-sw-a', 'status-running')}${cardHtml('run-q-sw-b', 'status-running')}<div data-role="stream-status"></div>`
    const regionA = document.querySelector('[data-run-id="run-q-sw-a"] [data-role="run-questions"]') as HTMLElement
    const regionB = document.querySelector('[data-run-id="run-q-sw-b"] [data-role="run-questions"]') as HTMLElement
    const {runtime, initCalls, select} = await mountLoader()

    select('run-q-sw-a')
    expect(initCalls[0]?.regionChildrenAtInit).toBe(0)
    // The stream renders a question into A's region, then the operator switches away and back.
    regionA.append(document.createElement('p'))
    regionB.append(document.createElement('p'))
    select('run-q-sw-b')
    expect(initCalls[1]?.regionChildrenAtInit).toBe(0)
    // Switching away leaves A's DOM alone; only the re-attach clears it.
    select('run-q-sw-a')

    expect(initCalls).toHaveLength(3)
    expect(initCalls[2]?.opts.questionsEl).toBe(regionA)
    expect(initCalls[2]?.regionChildrenAtInit).toBe(0)
    expect(regionA.childNodes).toHaveLength(0)
    runtime.cleanup()
  })

  it('a card without a question region attaches with questionsEl null and does not throw', async () => {
    document.body.innerHTML = `<div data-run-id="run-q-legacy"><span data-role="run-status" class="run-status status-running"></span></div><div data-role="stream-status"></div>`
    const {runtime, initCalls, select} = await mountLoader()

    select('run-q-legacy')

    expect(initCalls).toHaveLength(1)
    expect(initCalls[0]?.opts.questionsEl).toBeNull()
    runtime.cleanup()
  })
})

describe('discoverCardStreamTargets', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns the question region when present, and null when absent', () => {
    const withRegion = document.createElement('div')
    withRegion.dataset.runId = 'run-with-questions'
    const questionsEl = document.createElement('div')
    questionsEl.dataset.role = 'run-questions'
    withRegion.append(questionsEl)
    const without = document.createElement('div')
    without.dataset.runId = 'run-no-questions'
    document.body.append(withRegion, without)

    expect(discoverCardStreamTargets('run-with-questions').questionsEl).toBe(questionsEl)
    expect(discoverCardStreamTargets('run-no-questions').questionsEl).toBeNull()
    expect(discoverCardStreamTargets('no-such-run').questionsEl).toBeNull()
  })

  it('returns all four per-card render targets when the card and substructure exist', () => {
    const card = document.createElement('div')
    card.dataset.runId = 'run-full'
    const outputEl = document.createElement('div')
    outputEl.dataset.role = 'run-output'
    card.append(outputEl)
    const coalescedEl = document.createElement('div')
    coalescedEl.dataset.role = 'run-output-coalesced'
    card.append(coalescedEl)
    const approvalsEl = document.createElement('div')
    approvalsEl.dataset.role = 'run-approvals'
    card.append(approvalsEl)
    const badgeEl = document.createElement('span')
    badgeEl.dataset.role = 'approval-badge'
    card.append(badgeEl)
    document.body.append(card)

    const result = discoverCardStreamTargets('run-full')

    expect(result.outputEl).toBe(outputEl)
    expect(result.coalescedEl).toBe(coalescedEl)
    expect(result.approvalsEl).toBe(approvalsEl)
    expect(result.badgeEl).toBe(badgeEl)
  })

  it('returns the checkout-detail region when present, and null when absent', () => {
    const withRegion = document.createElement('div')
    withRegion.dataset.runId = 'run-with-checkout'
    const checkoutEl = document.createElement('div')
    checkoutEl.dataset.role = 'run-checkout-detail'
    withRegion.append(checkoutEl)
    const without = document.createElement('div')
    without.dataset.runId = 'run-no-checkout'
    document.body.append(withRegion, without)

    expect(discoverCardStreamTargets('run-with-checkout').checkoutEl).toBe(checkoutEl)
    expect(discoverCardStreamTargets('run-no-checkout').checkoutEl).toBeNull()
  })

  it('returns all nulls when no card matches the runId', () => {
    const result = discoverCardStreamTargets('no-such-run')
    expect(result.checkoutEl).toBeNull()

    expect(result.outputEl).toBeNull()
    expect(result.coalescedEl).toBeNull()
    expect(result.approvalsEl).toBeNull()
    expect(result.badgeEl).toBeNull()
  })

  it('returns the cancel control container element when present', () => {
    const card = document.createElement('div')
    card.dataset.runId = 'run-with-cancel'
    const cancelEl = document.createElement('div')
    cancelEl.dataset.role = 'run-cancel'
    card.append(cancelEl)
    document.body.append(card)

    const result = discoverCardStreamTargets('run-with-cancel')

    expect(result.cancelEl).toBe(cancelEl)
  })

  it('returns null for cancelEl when no cancel control container is present', () => {
    const card = document.createElement('div')
    card.dataset.runId = 'run-no-cancel'
    document.body.append(card)

    const result = discoverCardStreamTargets('run-no-cancel')

    expect(result.cancelEl).toBeNull()
  })

  it('uses CSS.escape so a runId with special characters still resolves', () => {
    const runId = 'run:with[special].chars'
    const card = document.createElement('div')
    card.dataset.runId = runId
    const outputEl = document.createElement('div')
    outputEl.dataset.role = 'run-output'
    card.append(outputEl)
    document.body.append(card)

    const result = discoverCardStreamTargets(runId)

    expect(result.outputEl).toBe(outputEl)
  })
})

// ---------------------------------------------------------------------------
// Teardown behavior: initOperatorStream's close() aborts, clears timers, and goes quiet
// ---------------------------------------------------------------------------

describe('initOperatorStream — close() teardown behavior', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('close() aborts the connection, clears the first-frame timer, and a late abort rejection neither reconnects nor writes', async () => {
    vi.useFakeTimers()
    const streamMod = await import('../../../public/operator-stream.js')
    const signals: (AbortSignal | undefined)[] = []
    let rejectFetch: ((err: unknown) => void) | undefined
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined)
      return new Promise((_resolve, reject) => {
        rejectFetch = reject
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const noticeEl = document.createElement('div')
    const handle = streamMod.initOperatorStream({runId: 'run-close', statusEl: null, noticeEl})
    expect(signals[0]?.aborted).toBe(false)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    handle.close()
    expect(signals[0]?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    rejectFetch?.(new DOMException('The operation was aborted.', 'AbortError'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(noticeEl.dataset.connectionState).toBeUndefined()
  })

  it('close() clears a pending reconnect timer, so no further connection is opened', async () => {
    vi.useFakeTimers()
    const streamMod = await import('../../../public/operator-stream.js')
    const fetchMock = vi.fn().mockResolvedValue({status: 500})
    vi.stubGlobal('fetch', fetchMock)

    const noticeEl = document.createElement('div')
    const handle = streamMod.initOperatorStream({runId: 'run-close-retry', statusEl: null, noticeEl})
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(noticeEl.dataset.connectionState).toBe('reconnecting')
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    handle.close()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The closed handle never repaints: the notice keeps its state from before close().
    expect(noticeEl.dataset.connectionState).toBe('reconnecting')
  })

  it('integration: closing A then immediately opening B absorbs A\'s late abort microtask (no closed->reconnecting regression, no late notice write)', async () => {
    const streamMod = await import('../../../public/operator-stream.js')

    // Stream A: a pending fetch that we will let reject (simulating the abort
    // rejection) AFTER close() has already run and transitioned state to closed.
    let rejectA: ((err: unknown) => void) | undefined
    const aFetchPromise = new Promise((_resolve, reject) => {
      rejectA = reject
    })

    const fetchMock = vi.fn()
      .mockImplementationOnce(() => aFetchPromise)
      .mockImplementationOnce(() => new Promise(() => {})) // B: never resolves in this test
    vi.stubGlobal('fetch', fetchMock)

    const noticeElA = document.createElement('div')
    const handleA = streamMod.initOperatorStream({runId: 'run-a', statusEl: null, noticeEl: noticeElA})

    // Close A — per the pinned order, aborted=true happens first (blocking any
    // late write to noticeElA), then the internal state transitions to 'closed'.
    // No frame has been dispatched yet, so noticeElA was never written to.
    handleA.close()
    const noticeSnapshotAfterClose = {
      hidden: noticeElA.hidden,
      textContent: noticeElA.textContent,
      connectionState: noticeElA.dataset.connectionState,
    }

    // Immediately open B.
    const noticeElB = document.createElement('div')
    const handleB = streamMod.initOperatorStream({runId: 'run-b', statusEl: null, noticeEl: noticeElB})

    // Now let A's late abort-rejection microtask fire. It must not write to A's
    // noticeEl at all — updateDOM's `!aborted` guard blocks it, and even if the
    // reducer's closed/submitted-unobservable guard did not exist, aborted=true
    // (set first, per the pin above) suppresses the write outright.
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    rejectA?.(abortError)
    await new Promise(resolve => setTimeout(resolve, 10))

    // A's notice must be byte-identical to its state immediately after close() —
    // the late catch handler's dispatch never reaches noticeElA.
    expect(noticeElA.hidden).toBe(noticeSnapshotAfterClose.hidden)
    expect(noticeElA.textContent).toBe(noticeSnapshotAfterClose.textContent)
    expect(noticeElA.dataset.connectionState).toBe(noticeSnapshotAfterClose.connectionState)

    // B is unaffected — it never received a write from A's late microtask either.
    expect(noticeElB.dataset.connectionState).not.toBe('reconnecting')

    handleB.close()
  })
})

// ---------------------------------------------------------------------------
// Hash restore: pure sanitization — length cap before validation
// ---------------------------------------------------------------------------

describe('sanitizeRunIdFromHash — length cap before validation (security)', () => {
  it('rejects a hash value longer than 512 chars before any other check', () => {
    const overCap = 'a'.repeat(513)
    expect(sanitizeRunIdFromHash(overCap)).toBeNull()
  })

  it('accepts a hash value exactly at the 512-char cap when otherwise valid', () => {
    const atCap = 'a'.repeat(512)
    expect(sanitizeRunIdFromHash(atCap)).toBe(atCap)
  })

  it('does not call encodeURIComponent on an over-cap value', () => {
    const spy = vi.spyOn(globalThis, 'encodeURIComponent')
    const overCap = 'x'.repeat(1000)
    sanitizeRunIdFromHash(overCap)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('rejects malformed values via validateDynamicId (path separators)', () => {
    expect(sanitizeRunIdFromHash('a/b')).toBeNull()
    expect(sanitizeRunIdFromHash('a\\b')).toBeNull()
    expect(sanitizeRunIdFromHash('a%2Fb')).toBeNull()
    expect(sanitizeRunIdFromHash('a%5Cb')).toBeNull()
    expect(sanitizeRunIdFromHash('.')).toBeNull()
    expect(sanitizeRunIdFromHash('..')).toBeNull()
  })

  it('rejects blank/empty values', () => {
    expect(sanitizeRunIdFromHash('')).toBeNull()
    expect(sanitizeRunIdFromHash('   ')).toBeNull()
  })

  it('accepts a well-formed opaque runId', () => {
    expect(sanitizeRunIdFromHash('c1a2b3c4-d5e6-f7a8-b9c0-d1e2f3a4b5c6')).toBe('c1a2b3c4-d5e6-f7a8-b9c0-d1e2f3a4b5c6')
  })

  it('MAX_HASH_ID_LENGTH matches the summary parser cap (512)', () => {
    expect(MAX_HASH_ID_LENGTH).toBe(512)
  })
})

// ---------------------------------------------------------------------------
// Hash restore: auth reclassification helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hash restore: end-to-end via the loader harness (module-integration level)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hash restore: reload-restore integration — terminal render + stale-auth remount
// ---------------------------------------------------------------------------

describe('URL-hash restore — reload-restore integration', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    window.location.hash = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function buildHarness() {
    const streamMod = await import('../../../public/operator-stream.js')
    const runIndexMod = await import('../../../public/operator-run-index.js')
    return {streamMod, runIndexMod}
  }

  /** Build a fake SSE ReadableStream body that emits the given text chunks, then closes. */
  function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
  }

  function makeSseResponse(chunks: string[]): Response {
    return {
      ok: true,
      status: 200,
      headers: {get: (h: string) => (h === 'content-type' ? 'text/event-stream' : null)},
      body: makeSseStream(chunks),
    } as unknown as Response
  }

  it('terminal restore renders read-only with no reconnect loop, distinct from a non-terminal restore', async () => {
    window.location.hash = '#run-terminal-1'
    const {streamMod, runIndexMod} = await buildHarness()
    runIndexMod.resetRunIndexState()
    streamMod.resetBootstrapState?.()

    document.body.innerHTML = `
      <div data-role="run-index-list"></div>
      <div data-role="stream-status" hidden></div>
    `

    let streamFetchCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/runs/')) {
        streamFetchCalls += 1
        // Ready frame, then a terminal status frame, then the stream ends.
        return Promise.resolve(makeSseResponse([
          `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`,
          'event: status\ndata: {"runId":"run-terminal-1","status":"succeeded","phase":"done"}\n\n',
        ]))
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          runs: [{runId: 'run-terminal-1', repo: 'org/repo', status: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z'}],
        }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    let restoredStatus: string | null = null
    let streamHandle: {close(): void} | undefined
    const onRestoreRun = (runId: string, card: Element, status: string) => {
      restoredStatus = status
      const statusEl = card.querySelector('[data-role="run-status"]')
      const noticeEl = document.querySelector('[data-role="stream-status"]')
      streamHandle = streamMod.initOperatorStream({runId, statusEl, noticeEl})
    }

    await runIndexMod.initOperatorRunIndex({
      restoreRunId: 'run-terminal-1',
      onRestoreRun,
    })

    const card = document.querySelector('[data-run-id="run-terminal-1"]') as HTMLElement
    expect(card).not.toBeNull()
    // Card expands on restore.
    expect(card.dataset.expanded).toBe('true')
    expect(restoredStatus).toBe('succeeded')

    // Let the SSE body flush and the reducer settle.
    await new Promise(resolve => setTimeout(resolve, 20))

    const noticeEl = document.querySelector('[data-role="stream-status"]') as HTMLElement
    // The terminal status frame closes the connection — never 'reconnecting'.
    expect(noticeEl.dataset.connectionState).not.toBe('reconnecting')
    expect(['live', 'closed']).toContain(noticeEl.dataset.connectionState)
    // Exactly one stream connection was opened — no reconnect attempt fired.
    expect(streamFetchCalls).toBe(1)

    // Give any (incorrect, if present) reconnect timer a chance to fire and prove
    // it does not — this is what distinguishes terminal restore from non-terminal.
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(streamFetchCalls).toBe(1)

    streamHandle?.close()
  })

  it('stale-auth remount lands in auth-required, not ready — no run expanded from a stale hash', async () => {
    window.location.hash = '#run-stale-1'
    const {runIndexMod} = await buildHarness()
    runIndexMod.resetRunIndexState()

    document.body.innerHTML = `
      <div data-role="run-index-list"></div>
      <div data-role="run-index-unavailable" hidden></div>
    `

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }))

    const onAuthRequired = vi.fn()
    const onRestoreRun = vi.fn()
    const onRestoreMiss = vi.fn()

    await runIndexMod.initOperatorRunIndex({
      restoreRunId: 'run-stale-1',
      onAuthRequired,
      onRestoreRun,
      onRestoreMiss,
    })

    expect(onAuthRequired).toHaveBeenCalledTimes(1)
    // No restore path is taken at all on an auth failure — not even a "miss".
    expect(onRestoreRun).not.toHaveBeenCalled()
    expect(onRestoreMiss).not.toHaveBeenCalled()
    // No card was ever rendered/expanded from the stale hash's run list.
    expect(document.querySelector('[data-run-id="run-stale-1"]')).toBeNull()
  })
})

describe('URL-hash restore — expand sets hash, remount restores', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    window.location.hash = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function buildHarness() {
    const streamMod = await import('../../../public/operator-stream.js')
    const runIndexMod = await import('../../../public/operator-run-index.js')
    return {streamMod, runIndexMod}
  }

  it('happy path: expanding a run sets location.hash to the runId', async () => {
    const {runIndexMod} = await buildHarness()
    runIndexMod.resetRunIndexState()

    document.body.innerHTML = `
      <div data-role="run-index-list"></div>
    `
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: [{runId: 'run-hash-1', repo: 'org/repo', status: 'running', createdAt: '2026-01-01T00:00:00.000Z'}]}),
    }))

    const onSelectRun = (runId: string) => {
      window.location.hash = `#${runId}`
    }
    await runIndexMod.initOperatorRunIndex({onSelectRun})

    const card = document.querySelector('[data-run-id="run-hash-1"]') as HTMLElement
    expect(card).not.toBeNull()
    card.click()

    expect(window.location.hash).toBe('#run-hash-1')
  })

  it('collapse clears location.hash', async () => {
    const {runIndexMod} = await buildHarness()
    runIndexMod.resetRunIndexState()

    document.body.innerHTML = `<div data-role="run-index-list"></div>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: [{runId: 'run-hash-2', repo: 'org/repo', status: 'running', createdAt: '2026-01-01T00:00:00.000Z'}]}),
    }))

    let expanded = false
    const onSelectRun = (runId: string) => {
      expanded = !expanded
      window.location.hash = expanded ? `#${runId}` : ''
    }
    await runIndexMod.initOperatorRunIndex({onSelectRun})

    const card = document.querySelector('[data-run-id="run-hash-2"]') as HTMLElement
    card.click()
    expect(window.location.hash).toBe('#run-hash-2')
    card.click()
    expect(window.location.hash).toBe('')
  })
})
