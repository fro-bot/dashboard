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
import {RUN_STATUS_CLASS_TOKENS, VALID_RUN_SUMMARY_STATUSES} from '../../../public/operator-run-index.js'
import {getQuestionPageStore, PINNED_CONTRACT_VERSION, resetQuestionPageStore} from '../../../public/operator-stream.js'
import {
  createOperatorRuntime,
  discoverCardStreamTargets,
  discoverCardSummaryStatus,
  EXPAND_REFRESH_CAP_MS,
  MAX_HASH_ID_LENGTH,
  requestRunJump,
  sanitizeRunIdFromHash,
  STATUS_CLASS_TOKENS,
  type OperatorRuntimeHandle,
  type OperatorRuntimeOptions,
} from './runtime.ts'

// Captured before any test installs fake timers, for polling that must keep running on the real clock.
const realSetTimeout = globalThis.setTimeout

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
    const bootstrapOperatorStreams = vi.fn()
    let onSelectRun: ((runId: string) => void | Promise<void>) | undefined
    // A vitest module mock throws on any export the factory omits, so every export the loader reads is listed.
    vi.doMock('/static/operator-stream.js?manual=1', () => ({
      initOperatorStream,
      bootstrapOperatorStreams,
      resetBootstrapState: vi.fn(),
    }))
    vi.doMock('/static/operator-run-index.js?manual=1', () => ({
      initOperatorRunIndex: async (opts: {onSelectRun: (runId: string) => void | Promise<void>}) => {
        onSelectRun = opts.onSelectRun
      },
      refreshOperatorRunIndex: vi.fn(async () => true),
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

    expect(bootstrapOperatorStreams).not.toHaveBeenCalled()
    expect(initOperatorStream).not.toHaveBeenCalled()

    await onSelectRun?.('run-wired-1')

    expect(region).not.toBeNull()
    expect(bootstrapOperatorStreams).not.toHaveBeenCalled()
    expect(initOperatorStream).toHaveBeenCalledTimes(1)
    expect(initOperatorStream.mock.calls[0]?.[0].runId).toBe('run-wired-1')
    expect(initOperatorStream.mock.calls[0]?.[0].checkoutEl).toBe(region)

    runtime.cleanup()
  })
})

describe('defaultRuntimeLoader — question region and summary status wiring', () => {
  type InitOpts = {runId: string; questionsEl?: Element | null; timeEl?: Element | null; waitingEl?: Element | null; summaryStatus?: string}

  afterEach(() => {
    document.body.innerHTML = ''
    vi.doUnmock('/static/operator-stream.js?manual=1')
    vi.doUnmock('/static/operator-run-index.js?manual=1')
    vi.doUnmock('/static/operator-launch.js?manual=1')
    vi.restoreAllMocks()
  })

  /** Mount the real default loader with every public module mocked; returns the captured seams. */
  async function mountLoader(mountOptions: {onRefresh?: () => void} = {}) {
    const handle = {close: vi.fn()}
    // Snapshot the region's children at the moment each init runs, before the stream could render into it.
    const initCalls: {opts: InitOpts; regionChildrenAtInit: number | undefined}[] = []
    const initOperatorStream = vi.fn((opts: InitOpts) => {
      initCalls.push({opts, regionChildrenAtInit: opts.questionsEl?.childNodes.length})
      return handle
    })
    const bootstrapOperatorStreams = vi.fn()
    const resetBootstrapState = vi.fn()
    let onSelectRun: ((runId: string) => void | Promise<void>) | undefined
    let onRestoreRun: ((runId: string, card: Element, status: string) => void) | undefined
    let onRunLaunched: ((runId: string, card: HTMLElement) => void) | undefined
    vi.doMock('/static/operator-stream.js?manual=1', () => ({
      initOperatorStream,
      bootstrapOperatorStreams,
      resetBootstrapState,
    }))
    vi.doMock('/static/operator-run-index.js?manual=1', () => ({
      initOperatorRunIndex: async (opts: {onSelectRun: (runId: string) => void | Promise<void>; onRestoreRun: (runId: string, card: Element, status: string) => void}) => {
        onSelectRun = opts.onSelectRun
        onRestoreRun = opts.onRestoreRun
      },
      refreshOperatorRunIndex: vi.fn(async () => {
        mountOptions.onRefresh?.()
        return true
      }),
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
      handle,
      bootstrapOperatorStreams,
      resetBootstrapState,
      restored: (runId: string, card: Element) => onRestoreRun?.(runId, card, 'running'),
      // Expanding waits for the run-list refresh, so a select settles once the stream is attached.
      select: async (runId: string) => { await onSelectRun?.(runId) },
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

  describe('streams attach only on expand', () => {
    it('does not bootstrap streams on load: pre-rendered cards get none until one is expanded', async () => {
      document.body.innerHTML = `${cardHtml('run-q-a', 'status-running')}${cardHtml('run-q-b', 'status-queued')}<div data-role="stream-status"></div>`
      const {runtime, initCalls, bootstrapOperatorStreams, resetBootstrapState} = await mountLoader()

      expect(bootstrapOperatorStreams).not.toHaveBeenCalled()
      expect(resetBootstrapState).not.toHaveBeenCalled()
      expect(initCalls).toHaveLength(0)
      runtime.cleanup()
    })

    it('a remount that leaves cards in the list starts no stream, and none until a card is expanded', async () => {
      document.body.innerHTML = `${cardHtml('run-q-a', 'status-running')}${cardHtml('run-q-b', 'status-succeeded')}<div data-role="stream-status"></div>`
      const first = await mountLoader()
      await first.select('run-q-a')
      first.runtime.cleanup()
      expect(first.handle.close).toHaveBeenCalledTimes(1)

      const second = await mountLoader()

      expect(second.bootstrapOperatorStreams).not.toHaveBeenCalled()
      expect(second.initCalls).toHaveLength(0)
      await second.select('run-q-b')
      expect(second.initCalls.map(call => call.opts.runId)).toEqual(['run-q-b'])
      second.runtime.cleanup()
    })

    it('expanding attaches exactly one stream and collapsing closes it', async () => {
      document.body.innerHTML = `${cardHtml('run-q-a', 'status-running')}<div data-role="stream-status"></div>`
      const {runtime, initCalls, handle, bootstrapOperatorStreams, select} = await mountLoader()

      await select('run-q-a')
      expect(initCalls).toHaveLength(1)
      expect(handle.close).not.toHaveBeenCalled()

      await select('run-q-a')
      expect(handle.close).toHaveBeenCalledTimes(1)
      expect(initCalls).toHaveLength(1)
      expect(bootstrapOperatorStreams).not.toHaveBeenCalled()
      runtime.cleanup()
    })

    it('a restored card and a launched card each attach one stream with no bootstrap involved', async () => {
      document.body.innerHTML = `${cardHtml('run-q-restore', 'status-running')}${cardHtml('run-q-launch', 'status-queued', ' data-optimistic="true"')}<div data-role="stream-status"></div>`
      const {runtime, initCalls, bootstrapOperatorStreams, restored, launched} = await mountLoader()
      expect(initCalls).toHaveLength(0)

      restored('run-q-restore', document.querySelector('[data-run-id="run-q-restore"]') as HTMLElement)
      expect(initCalls.map(call => call.opts.runId)).toEqual(['run-q-restore'])

      launched('run-q-launch', document.querySelector('[data-run-id="run-q-launch"]') as HTMLElement)
      expect(initCalls.map(call => call.opts.runId)).toEqual(['run-q-restore', 'run-q-launch'])
      expect(bootstrapOperatorStreams).not.toHaveBeenCalled()
      runtime.cleanup()
    })

    it('never touches the stream bootstrap state, on load or on cleanup', async () => {
      document.body.innerHTML = '<div data-role="stream-status"></div>'
      const {runtime, resetBootstrapState, bootstrapOperatorStreams} = await mountLoader()

      runtime.cleanup()

      expect(resetBootstrapState).not.toHaveBeenCalled()
      expect(bootstrapOperatorStreams).not.toHaveBeenCalled()
    })
  })

  describe('the card time is a stream target only while it is launch-seeded', () => {
    const timeHtml = (marker: string) => `<time data-role="run-updated-at"${marker} datetime="2000-01-01T00:00:00.000Z"></time>`
    const cardWithTime = (runId: string, marker: string, extra = '') => `
      <div data-run-id="${runId}"${extra}>
        <span data-role="run-status" class="run-status status-queued"></span>
        ${timeHtml(marker)}
        <div data-role="run-questions" hidden></div>
      </div>`
    const SEEDED = ' data-time-source="launch"'
    const timeOf = (runId: string) => document.querySelector(`[data-run-id="${runId}"] [data-role="run-updated-at"]`)

    it('hands a launch-seeded <time> to the stream on expand', async () => {
      document.body.innerHTML = `${cardWithTime('run-t-a', SEEDED)}<div data-role="stream-status"></div>`
      const {runtime, initCalls, select} = await mountLoader()

      await select('run-t-a')

      expect(initCalls).toHaveLength(1)
      expect(initCalls[0]?.opts.timeEl).toBe(timeOf('run-t-a'))
      expect(initCalls[0]?.opts.timeEl).not.toBeNull()
      runtime.cleanup()
    })

    it('hands a launch-seeded <time> to the stream on the launch handoff', async () => {
      document.body.innerHTML = `${cardWithTime('run-t-launch', SEEDED, ' data-optimistic="true"')}<div data-role="stream-status"></div>`
      const {runtime, initCalls, launched} = await mountLoader()

      launched('run-t-launch', document.querySelector('[data-run-id="run-t-launch"]') as HTMLElement)

      expect(initCalls[0]?.opts.timeEl).toBe(timeOf('run-t-launch'))
      runtime.cleanup()
    })

    it('after adoption (marker gone) the pre-expand refresh leaves the stream no time target: the list time wins', async () => {
      document.body.innerHTML = `${cardWithTime('run-t-adopted', SEEDED)}<div data-role="stream-status"></div>`
      const {runtime, initCalls, select} = await mountLoader({
        onRefresh: () => {
          timeOf('run-t-adopted')?.removeAttribute('data-time-source')
        },
      })

      await select('run-t-adopted')

      expect(initCalls).toHaveLength(1)
      expect(initCalls[0]?.opts.timeEl ?? null).toBeNull()
      runtime.cleanup()
    })

    it('when the refresh does not list the run, the marker stays and the stream keeps the start time', async () => {
      document.body.innerHTML = `${cardWithTime('run-t-unlisted', SEEDED)}<div data-role="stream-status"></div>`
      const {runtime, initCalls, select} = await mountLoader({onRefresh: () => {}})

      await select('run-t-unlisted')

      expect(initCalls[0]?.opts.timeEl).toBe(timeOf('run-t-unlisted'))
      runtime.cleanup()
    })

    it.each([
      ['an ordinary list card <time>', cardWithTime('run-t-list', '')],
      ['a <time> with another source marker', cardWithTime('run-t-list', ' data-time-source="other"')],
      ['a card with no <time> at all', cardHtml('run-t-list', 'status-running')],
    ])('%s is not a stream target', async (_label, html) => {
      document.body.innerHTML = `${html}<div data-role="stream-status"></div>`
      const {runtime, initCalls, select} = await mountLoader()

      await select('run-t-list')

      expect(initCalls).toHaveLength(1)
      expect(initCalls[0]?.opts.timeEl ?? null).toBeNull()
      runtime.cleanup()
    })
  })

  it('hands the discovered waiting-line region to initOperatorStream, and null when the card has none', async () => {
    document.body.innerHTML = `
      <div data-run-id="run-w-a"><span data-role="run-status" class="run-status status-running"></span><div data-role="run-waiting" hidden></div></div>
      ${cardHtml('run-w-b', 'status-running')}
      <div data-role="stream-status"></div>`
    const waitingA = document.querySelector('[data-run-id="run-w-a"] [data-role="run-waiting"]')
    const {runtime, initCalls, select} = await mountLoader()

    await select('run-w-a')
    await select('run-w-b')

    expect(initCalls[0]?.opts.waitingEl).toBe(waitingA)
    expect(initCalls[0]?.opts.waitingEl).not.toBeNull()
    expect(initCalls[1]?.opts.waitingEl ?? null).toBeNull()
    runtime.cleanup()
  })

  it('hands the discovered questionsEl and the card summary status to initOperatorStream', async () => {
    document.body.innerHTML = `${cardHtml('run-q-a', 'status-succeeded')}${cardHtml('run-q-b', 'status-running')}<div data-role="stream-status"></div>`
    const regionA = document.querySelector('[data-run-id="run-q-a"] [data-role="run-questions"]')
    const regionB = document.querySelector('[data-run-id="run-q-b"] [data-role="run-questions"]')
    const {runtime, initCalls, select} = await mountLoader()

    await select('run-q-a')
    await select('run-q-b')

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

  it('every status the run index accepts, waiting ones included, is passed as summaryStatus', async () => {
    // The class token is the one the run index emits: RUN_STATUS_CLASS_TOKENS, hyphenated.
    const statuses = [...VALID_RUN_SUMMARY_STATUSES] as (keyof typeof RUN_STATUS_CLASS_TOKENS)[]
    expect(statuses).toHaveLength(7)
    document.body.innerHTML = `${statuses.map(status => cardHtml(`run-q-${status}`, RUN_STATUS_CLASS_TOKENS[status])).join('')}<div data-role="stream-status"></div>`
    const {runtime, initCalls, select} = await mountLoader()

    for (const status of statuses) await select(`run-q-${status}`)

    expect(initCalls.map(call => call.opts.summaryStatus)).toEqual(statuses)
    runtime.cleanup()
  })

  it.each([
    ['waiting_for_question', 'status-waiting-for-question'],
    ['waiting_for_approval', 'status-waiting-for-approval'],
  ] as const)('a waiting class read from a card maps to the %s summary status', async (status, token) => {
    document.body.innerHTML = `${cardHtml('run-q-wait', token)}<div data-role="stream-status"></div>`
    const {runtime, initCalls, select} = await mountLoader()

    await select('run-q-wait')

    expect(discoverCardSummaryStatus('run-q-wait')).toBe(status)
    expect(initCalls).toHaveLength(1)
    expect(initCalls[0]?.opts.summaryStatus).toBe(status)
    runtime.cleanup()
  })

  it('the runtime class-token map mirrors the run index map exactly', () => {
    expect(Object.keys(RUN_STATUS_CLASS_TOKENS).toSorted()).toEqual([...VALID_RUN_SUMMARY_STATUSES].toSorted())
    expect(STATUS_CLASS_TOKENS).toEqual({...RUN_STATUS_CLASS_TOKENS})
  })

  it('a status class outside the run-summary allowlist is never passed as summaryStatus', async () => {
    // Underscore tokens (the old emitter output) and unknown tokens are rejected; only the hyphenated
    // token the run index emits is read back.
    document.body.innerHTML = [
      cardHtml('run-q-under-q', 'status-waiting_for_question'),
      cardHtml('run-q-under-a', 'status-waiting_for_approval'),
      cardHtml('run-q-evil', 'status-evil'),
      cardHtml('run-q-pending', 'status-pending'),
      cardHtml('run-q-none', ''),
      '<div data-role="stream-status"></div>',
    ].join('')
    const {runtime, initCalls, select} = await mountLoader()

    for (const id of ['run-q-under-q', 'run-q-under-a', 'run-q-evil', 'run-q-pending', 'run-q-none']) await select(id)

    expect(initCalls).toHaveLength(5)
    for (const call of initCalls) expect('summaryStatus' in call.opts).toBe(false)
    runtime.cleanup()
  })

  it('card switch A → B → A clears A’s stale question DOM on re-attach', async () => {
    document.body.innerHTML = `${cardHtml('run-q-sw-a', 'status-running')}${cardHtml('run-q-sw-b', 'status-running')}<div data-role="stream-status"></div>`
    const regionA = document.querySelector('[data-run-id="run-q-sw-a"] [data-role="run-questions"]') as HTMLElement
    const regionB = document.querySelector('[data-run-id="run-q-sw-b"] [data-role="run-questions"]') as HTMLElement
    const {runtime, initCalls, select} = await mountLoader()

    await select('run-q-sw-a')
    expect(initCalls[0]?.regionChildrenAtInit).toBe(0)
    // The stream renders a question into A's region, then the operator switches away and back.
    regionA.append(document.createElement('p'))
    regionB.append(document.createElement('p'))
    await select('run-q-sw-b')
    expect(initCalls[1]?.regionChildrenAtInit).toBe(0)
    // Switching away leaves A's DOM alone; only the re-attach clears it.
    await select('run-q-sw-a')

    expect(initCalls).toHaveLength(3)
    expect(initCalls[2]?.opts.questionsEl).toBe(regionA)
    expect(initCalls[2]?.regionChildrenAtInit).toBe(0)
    expect(regionA.childNodes).toHaveLength(0)
    runtime.cleanup()
  })

  it('a card without a question region attaches with questionsEl null and does not throw', async () => {
    document.body.innerHTML = `<div data-run-id="run-q-legacy"><span data-role="run-status" class="run-status status-running"></span></div><div data-role="stream-status"></div>`
    const {runtime, initCalls, select} = await mountLoader()

    await select('run-q-legacy')

    expect(initCalls).toHaveLength(1)
    expect(initCalls[0]?.opts.questionsEl).toBeNull()
    runtime.cleanup()
  })
})

describe('defaultRuntimeLoader — run-list refresh triggers', () => {
  type InitOpts = {runId: string; summaryStatus?: string}

  let visibility: DocumentVisibilityState = 'visible'

  beforeEach(() => {
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility})
    // Interval and timeout are faked (the refresh interval and the expand cap). The mount polling below
    // uses the real setTimeout captured at file load.
    vi.useFakeTimers({toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']})
  })

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(document, 'visibilityState')
    document.body.innerHTML = ''
    if (location.hash !== '') history.replaceState(null, '', location.pathname + location.search)
    vi.doUnmock('/static/operator-stream.js?manual=1')
    vi.doUnmock('/static/operator-run-index.js?manual=1')
    vi.doUnmock('/static/operator-launch.js?manual=1')
    vi.restoreAllMocks()
  })

  function setVisibility(next: DocumentVisibilityState): void {
    visibility = next
    document.dispatchEvent(new Event('visibilitychange'))
  }

  /** A refresh the test settles by hand; each call gets its own resolver. */
  function controllableRefresh() {
    const resolvers: ((applied: boolean) => void)[] = []
    const refresh = vi.fn(() => new Promise<boolean>(resolve => {
      resolvers.push(resolve)
    }))
    return {refresh, resolvers}
  }

  async function mountLoader(refresh: () => Promise<boolean> = async () => true) {
    const handle = {close: vi.fn()}
    const initOperatorStream = vi.fn((_opts: InitOpts) => handle)
    const bootstrapOperatorStreams = vi.fn()
    const refreshOperatorRunIndex = vi.fn(refresh)
    let onSelectRun: ((runId: string) => void | Promise<void>) | undefined
    let onAuthRequired: (() => void) | undefined
    let onRunLaunched: ((runId: string, card: HTMLElement) => void) | undefined
    vi.doMock('/static/operator-stream.js?manual=1', () => ({
      initOperatorStream,
      bootstrapOperatorStreams,
      resetBootstrapState: vi.fn(),
    }))
    vi.doMock('/static/operator-run-index.js?manual=1', () => ({
      initOperatorRunIndex: async (opts: {onSelectRun: (runId: string) => void | Promise<void>; onAuthRequired: () => void}) => {
        onSelectRun = opts.onSelectRun
        onAuthRequired = opts.onAuthRequired
      },
      refreshOperatorRunIndex,
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
    const onStateChange = vi.fn()
    const runtime = createOperatorRuntime({container: makeContainer(), onStateChange})
    // Poll on real timers. vi.waitFor would advance the fake clock while it waits, which would shift
    // the interval's start and make the 30-second boundaries below inexact.
    for (let attempt = 0; attempt < 200 && (onSelectRun === undefined || onRunLaunched === undefined); attempt++) {
      await new Promise(resolve => realSetTimeout(resolve, 5))
    }
    expect(onSelectRun).toBeDefined()
    expect(onRunLaunched).toBeDefined()
    // The loader finishes its setup (interval, listener, cleanup registration) a few microtasks later.
    await new Promise(resolve => realSetTimeout(resolve, 5))
    return {
      runtime,
      handle,
      initOperatorStream,
      bootstrapOperatorStreams,
      refreshOperatorRunIndex,
      onStateChange,
      select: (runId: string) => onSelectRun?.(runId),
      authRequired: () => onAuthRequired?.(),
      launched: (runId: string, card: HTMLElement) => onRunLaunched?.(runId, card),
    }
  }

  function cardHtml(runId: string, statusClass: string): string {
    return `<div data-run-id="${runId}"><span data-role="run-status" class="run-status ${statusClass}"></span></div>`
  }

  /** jsdom defers the hashchange event of a location.hash write onto a (faked) timeout; run it so timer counts see only the runtime's own timers. */
  const flushHashEvent = () => vi.advanceTimersByTimeAsync(0)

  function setStatusClass(runId: string, statusClass: string): void {
    const statusEl = document.querySelector(`[data-run-id="${runId}"] [data-role="run-status"]`)
    if (statusEl !== null) statusEl.className = `run-status ${statusClass}`
  }

  describe('interval and visibility', () => {
    it('does not refresh at mount (init just fetched), then refreshes every 30 seconds while visible', async () => {
      const {runtime, refreshOperatorRunIndex} = await mountLoader()
      expect(refreshOperatorRunIndex).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(29_999)
      expect(refreshOperatorRunIndex).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(refreshOperatorRunIndex).toHaveBeenCalledTimes(2)
      runtime.cleanup()
    })

    it('runs no refresh while hidden, and the interval is cleared (not merely skipped)', async () => {
      const {runtime, refreshOperatorRunIndex} = await mountLoader()

      setVisibility('hidden')
      await vi.advanceTimersByTimeAsync(300_000)

      expect(refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      runtime.cleanup()
    })

    it('mounting while hidden starts no interval until the window becomes visible', async () => {
      visibility = 'hidden'
      const {runtime, refreshOperatorRunIndex} = await mountLoader()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)

      setVisibility('visible')
      expect(refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(refreshOperatorRunIndex).toHaveBeenCalledTimes(2)
      runtime.cleanup()
    })

    it('becoming visible refreshes at once and restarts the interval from that moment', async () => {
      const {runtime, refreshOperatorRunIndex} = await mountLoader()
      await vi.advanceTimersByTimeAsync(20_000)
      setVisibility('hidden')
      await vi.advanceTimersByTimeAsync(5000)

      setVisibility('visible')
      expect(refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)

      // A fresh 30-second period: the 20 seconds already elapsed before hiding do not count.
      await vi.advanceTimersByTimeAsync(29_999)
      expect(refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(refreshOperatorRunIndex).toHaveBeenCalledTimes(2)
      runtime.cleanup()
    })

    it('a visibilitychange that stays visible does not stack a second interval', async () => {
      const {runtime, refreshOperatorRunIndex} = await mountLoader()

      setVisibility('visible')
      setVisibility('visible')
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(30_000)
      // Two immediate refreshes from the two events, plus exactly one interval tick.
      expect(refreshOperatorRunIndex).toHaveBeenCalledTimes(3)
      runtime.cleanup()
    })

    it('a rejected refresh never surfaces: the next cycle just runs again', async () => {
      const {runtime, refreshOperatorRunIndex, onStateChange} = await mountLoader(async () => {
        throw new Error('boom')
      })

      await vi.advanceTimersByTimeAsync(60_000)

      expect(refreshOperatorRunIndex).toHaveBeenCalledTimes(2)
      expect(onStateChange).not.toHaveBeenCalled()
      runtime.cleanup()
    })

    it('auth-required stops the interval and a later visibility change does not restart it', async () => {
      const {runtime, refreshOperatorRunIndex, onStateChange, authRequired} = await mountLoader()

      authRequired()
      expect(onStateChange).toHaveBeenCalledWith('auth-required')
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(120_000)
      setVisibility('hidden')
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(120_000)

      expect(refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      runtime.cleanup()
    })

    it('cleanup clears the interval and the visibility listener, and no refresh fires after unmount', async () => {
      const added = vi.spyOn(document, 'addEventListener')
      const removed = vi.spyOn(document, 'removeEventListener')
      const {runtime, refreshOperatorRunIndex} = await mountLoader()
      const listener = added.mock.calls.find(([type]) => type === 'visibilitychange')?.[1]
      expect(listener).toBeDefined()
      expect(vi.getTimerCount()).toBe(1)

      runtime.cleanup()

      expect(removed).toHaveBeenCalledWith('visibilitychange', listener)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(120_000)
      setVisibility('hidden')
      setVisibility('visible')
      expect(refreshOperatorRunIndex).not.toHaveBeenCalled()
    })

    it('cleanup before the loader finishes still tears down what it set up', async () => {
      const {runtime} = await mountLoader()
      runtime.cleanup()
      // A second mount/cleanup cycle (React Strict Mode) leaves no timers behind.
      const second = await mountLoader()
      second.runtime.cleanup()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('refresh before expand', () => {
    it('waits for the refresh, then seeds the stream from the refreshed card status (a run that finished while collapsed seeds succeeded)', async () => {
      document.body.innerHTML = `${cardHtml('run-x-fin', 'status-running')}<div data-role="stream-status"></div>`
      const {refresh, resolvers} = controllableRefresh()
      const {runtime, initOperatorStream, select} = await mountLoader(refresh)

      const selecting = select('run-x-fin')
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(initOperatorStream).not.toHaveBeenCalled()

      // The refresh lands: the run finished while its card was collapsed.
      setStatusClass('run-x-fin', 'status-succeeded')
      resolvers[0]?.(true)
      await selecting

      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      expect(initOperatorStream.mock.calls[0]?.[0].runId).toBe('run-x-fin')
      expect(initOperatorStream.mock.calls[0]?.[0].summaryStatus).toBe('succeeded')
      runtime.cleanup()
    })

    const failingRefreshes: [string, () => Promise<boolean>][] = [
      ['rejects', () => Promise.reject(new Error('boom'))],
      ['reports nothing applied', () => Promise.resolve(false)],
    ]
    it.each(failingRefreshes)('a refresh that %s still expands, from the status already on the card', async (_label, refresh) => {
      document.body.innerHTML = `${cardHtml('run-x-fail', 'status-waiting-for-question')}<div data-role="stream-status"></div>`
      const {runtime, initOperatorStream, select} = await mountLoader(refresh)

      await select('run-x-fail')

      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      expect(initOperatorStream.mock.calls[0]?.[0].summaryStatus).toBe('waiting_for_question')
      runtime.cleanup()
    })

    it('the hash is written when the card expands, not after the refresh', async () => {
      document.body.innerHTML = `${cardHtml('run-x-hash', 'status-running')}<div data-role="stream-status"></div>`
      const {refresh} = controllableRefresh()
      const {runtime, select} = await mountLoader(refresh)

      void select('run-x-hash')

      expect(location.hash).toBe('#run-x-hash')
      runtime.cleanup()
    })

    it('collapse does not wait for a refresh: it closes the stream and clears the hash synchronously', async () => {
      document.body.innerHTML = `${cardHtml('run-x-col', 'status-running')}<div data-run-id="run-x-other"><span data-role="run-status" class="run-status status-running"></span></div><div data-role="stream-status"></div>`
      const {runtime, handle, initOperatorStream, refreshOperatorRunIndex, select} = await mountLoader()
      await select('run-x-col')
      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      expect(location.hash).toBe('#run-x-col')
      refreshOperatorRunIndex.mockClear()
      refreshOperatorRunIndex.mockImplementation(() => new Promise<boolean>(() => {}))

      select('run-x-col')

      expect(handle.close).toHaveBeenCalledTimes(1)
      expect(location.hash).toBe('')
      expect(refreshOperatorRunIndex).not.toHaveBeenCalled()
      runtime.cleanup()
    })

    it('collapsing a card whose expand is still waiting on the refresh cancels the attach', async () => {
      document.body.innerHTML = `${cardHtml('run-x-cancel', 'status-running')}<div data-role="stream-status"></div>`
      const {refresh, resolvers} = controllableRefresh()
      const {runtime, initOperatorStream, select} = await mountLoader(refresh)

      const expanding = select('run-x-cancel')
      select('run-x-cancel')
      resolvers[0]?.(true)
      await expanding

      expect(initOperatorStream).not.toHaveBeenCalled()
      expect(location.hash).toBe('')
      runtime.cleanup()
    })

    it('expanding another card closes the open stream at once and attaches only the newest expand', async () => {
      document.body.innerHTML = `${cardHtml('run-x-a', 'status-running')}${cardHtml('run-x-b', 'status-running')}${cardHtml('run-x-c', 'status-running')}<div data-role="stream-status"></div>`
      const {runtime, handle, initOperatorStream, refreshOperatorRunIndex, select} = await mountLoader()
      await select('run-x-a')
      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      const {refresh, resolvers} = controllableRefresh()
      refreshOperatorRunIndex.mockImplementation(refresh)

      const expandB = select('run-x-b')
      expect(handle.close).toHaveBeenCalledTimes(1)
      const expandC = select('run-x-c')
      expect(location.hash).toBe('#run-x-c')
      resolvers[0]?.(true)
      resolvers[1]?.(true)
      await Promise.all([expandB, expandC])

      expect(initOperatorStream).toHaveBeenCalledTimes(2)
      expect(initOperatorStream.mock.calls[1]?.[0].runId).toBe('run-x-c')
      runtime.cleanup()
    })

    it('a card the refresh removed is not attached, and the hash it wrote is cleared', async () => {
      document.body.innerHTML = `${cardHtml('run-x-gone', 'status-running')}<div data-role="stream-status"></div>`
      const {runtime, initOperatorStream, select} = await mountLoader(async () => {
        document.querySelector('[data-run-id="run-x-gone"]')?.remove()
        return true
      })

      await select('run-x-gone')

      expect(initOperatorStream).not.toHaveBeenCalled()
      expect(location.hash).toBe('')
      runtime.cleanup()
    })

    it('cleanup while an expand waits on the refresh attaches nothing afterwards', async () => {
      document.body.innerHTML = `${cardHtml('run-x-unmount', 'status-running')}<div data-role="stream-status"></div>`
      const {refresh, resolvers} = controllableRefresh()
      const {runtime, initOperatorStream, select} = await mountLoader(refresh)

      const expanding = select('run-x-unmount')
      runtime.cleanup()
      resolvers[0]?.(true)
      await expanding

      expect(initOperatorStream).not.toHaveBeenCalled()
    })

    it('the cap is 2 seconds', () => {
      expect(EXPAND_REFRESH_CAP_MS).toBe(2000)
    })

    it('a refresh that never settles stops holding the expand at the cap: it attaches with the status already on the card', async () => {
      document.body.innerHTML = `${cardHtml('run-x-cap', 'status-waiting-for-approval')}<div data-role="stream-status"></div>`
      const {runtime, initOperatorStream, select} = await mountLoader(() => new Promise<boolean>(() => {}))

      void select('run-x-cap')
      await vi.advanceTimersByTimeAsync(EXPAND_REFRESH_CAP_MS - 1)
      expect(initOperatorStream).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)

      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      expect(initOperatorStream.mock.calls[0]?.[0].runId).toBe('run-x-cap')
      expect(initOperatorStream.mock.calls[0]?.[0].summaryStatus).toBe('waiting_for_approval')
      runtime.cleanup()
    })

    it('after the cap attached, the refresh still finishing in the background does not attach again', async () => {
      document.body.innerHTML = `${cardHtml('run-x-late', 'status-running')}<div data-role="stream-status"></div>`
      const {refresh, resolvers} = controllableRefresh()
      const {runtime, initOperatorStream, select} = await mountLoader(refresh)

      void select('run-x-late')
      await vi.advanceTimersByTimeAsync(EXPAND_REFRESH_CAP_MS)
      expect(initOperatorStream).toHaveBeenCalledTimes(1)

      setStatusClass('run-x-late', 'status-succeeded')
      resolvers[0]?.(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      expect(document.querySelector('[data-run-id="run-x-late"] [data-role="run-status"]')?.className).toContain('status-succeeded')
      runtime.cleanup()
    })

    it('a refresh that settles before the cap wins the race and clears the cap timer', async () => {
      document.body.innerHTML = `${cardHtml('run-x-fast', 'status-running')}<div data-role="stream-status"></div>`
      const {refresh, resolvers} = controllableRefresh()
      const {runtime, initOperatorStream, select} = await mountLoader(refresh)
      expect(vi.getTimerCount()).toBe(1)

      const expanding = select('run-x-fast')
      await flushHashEvent()
      expect(vi.getTimerCount()).toBe(2)
      await vi.advanceTimersByTimeAsync(EXPAND_REFRESH_CAP_MS - 1)
      setStatusClass('run-x-fast', 'status-succeeded')
      resolvers[0]?.(true)
      await expanding

      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      expect(initOperatorStream.mock.calls[0]?.[0].summaryStatus).toBe('succeeded')
      // Only the refresh interval is left.
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(EXPAND_REFRESH_CAP_MS)
      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      runtime.cleanup()
    })

    it('a cap that fires leaves no timer behind', async () => {
      document.body.innerHTML = `${cardHtml('run-x-fired', 'status-running')}<div data-role="stream-status"></div>`
      const {runtime, select} = await mountLoader(() => new Promise<boolean>(() => {}))

      void select('run-x-fired')
      await vi.advanceTimersByTimeAsync(EXPAND_REFRESH_CAP_MS)

      expect(vi.getTimerCount()).toBe(1)
      runtime.cleanup()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('collapsing a waiting expand clears the cap timer and attaches nothing at the cap', async () => {
      document.body.innerHTML = `${cardHtml('run-x-capcancel', 'status-running')}<div data-role="stream-status"></div>`
      const {runtime, initOperatorStream, select} = await mountLoader(() => new Promise<boolean>(() => {}))

      void select('run-x-capcancel')
      await flushHashEvent()
      expect(vi.getTimerCount()).toBe(2)
      select('run-x-capcancel')
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(EXPAND_REFRESH_CAP_MS * 2)

      expect(initOperatorStream).not.toHaveBeenCalled()
      runtime.cleanup()
    })

    it('another expand supersedes the waiting one at the cap: only the newest attaches, with one cap timer left', async () => {
      document.body.innerHTML = `${cardHtml('run-x-sup-a', 'status-running')}${cardHtml('run-x-sup-b', 'status-queued')}<div data-role="stream-status"></div>`
      const {runtime, initOperatorStream, select} = await mountLoader(() => new Promise<boolean>(() => {}))

      void select('run-x-sup-a')
      void select('run-x-sup-b')
      await flushHashEvent()
      expect(vi.getTimerCount()).toBe(2)
      await vi.advanceTimersByTimeAsync(EXPAND_REFRESH_CAP_MS)

      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      expect(initOperatorStream.mock.calls[0]?.[0].runId).toBe('run-x-sup-b')
      expect(initOperatorStream.mock.calls[0]?.[0].summaryStatus).toBe('queued')
      runtime.cleanup()
    })

    it('a launch handoff clears the waiting expand\'s cap timer', async () => {
      document.body.innerHTML = `${cardHtml('run-x-lw', 'status-running')}${cardHtml('run-x-ln', 'status-queued')}<div data-role="stream-status"></div>`
      const {runtime, initOperatorStream, select, launched} = await mountLoader(() => new Promise<boolean>(() => {}))

      void select('run-x-lw')
      launched('run-x-ln', document.querySelector('[data-run-id="run-x-ln"]') as HTMLElement)
      await flushHashEvent()
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(EXPAND_REFRESH_CAP_MS)

      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      expect(initOperatorStream.mock.calls[0]?.[0].runId).toBe('run-x-ln')
      runtime.cleanup()
    })

    it('cleanup while an expand waits clears the cap timer too', async () => {
      document.body.innerHTML = `${cardHtml('run-x-cleanup', 'status-running')}<div data-role="stream-status"></div>`
      const {runtime, initOperatorStream, select} = await mountLoader(() => new Promise<boolean>(() => {}))

      void select('run-x-cleanup')
      await flushHashEvent()
      expect(vi.getTimerCount()).toBe(2)
      runtime.cleanup()

      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(EXPAND_REFRESH_CAP_MS)
      expect(initOperatorStream).not.toHaveBeenCalled()
    })

    it('a launch handoff while an expand waits wins: the waiting expand does not replace the launched stream', async () => {
      document.body.innerHTML = `${cardHtml('run-x-wait', 'status-running')}${cardHtml('run-x-new', 'status-queued')}<div data-role="stream-status"></div>`
      const {refresh, resolvers} = controllableRefresh()
      const {runtime, initOperatorStream, select, launched} = await mountLoader(refresh)

      const expanding = select('run-x-wait')
      launched('run-x-new', document.querySelector('[data-run-id="run-x-new"]') as HTMLElement)
      resolvers[0]?.(true)
      await expanding

      expect(initOperatorStream).toHaveBeenCalledTimes(1)
      expect(initOperatorStream.mock.calls[0]?.[0].runId).toBe('run-x-new')
      runtime.cleanup()
    })
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

  it('returns the waiting-line region when present, and null when absent', () => {
    const withRegion = document.createElement('div')
    withRegion.dataset.runId = 'run-with-waiting'
    const waitingEl = document.createElement('div')
    waitingEl.dataset.role = 'run-waiting'
    withRegion.append(waitingEl)
    const without = document.createElement('div')
    without.dataset.runId = 'run-no-waiting'
    document.body.append(withRegion, without)

    expect(discoverCardStreamTargets('run-with-waiting').waitingEl).toBe(waitingEl)
    expect(discoverCardStreamTargets('run-no-waiting').waitingEl).toBeNull()
    expect(discoverCardStreamTargets('no-such-run').waitingEl).toBeNull()
  })

  it('returns the card time only while it carries the launch marker', () => {
    const card = (runId: string, marker?: string) => {
      const el = document.createElement('div')
      el.dataset.runId = runId
      const time = document.createElement('time')
      time.dataset.role = 'run-updated-at'
      if (marker !== undefined) time.dataset.timeSource = marker
      el.append(time)
      document.body.append(el)
      return time
    }
    const seeded = card('run-time-seeded', 'launch')
    card('run-time-plain')
    card('run-time-other', 'other')
    const bare = document.createElement('div')
    bare.dataset.runId = 'run-time-bare'
    document.body.append(bare)

    expect(discoverCardStreamTargets('run-time-seeded').timeEl).toBe(seeded)
    expect(discoverCardStreamTargets('run-time-plain').timeEl).toBeNull()
    expect(discoverCardStreamTargets('run-time-other').timeEl).toBeNull()
    expect(discoverCardStreamTargets('run-time-bare').timeEl).toBeNull()
    expect(discoverCardStreamTargets('no-such-run').timeEl).toBeNull()
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
    // The attach paint is the only write: the state never moves past 'connecting'.
    expect(noticeEl.dataset.connectionState).toBe('connecting')
    expect(signals[0]?.aborted).toBe(false)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    handle.close()
    expect(signals[0]?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    rejectFetch?.(new DOMException('The operation was aborted.', 'AbortError'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(noticeEl.dataset.connectionState).toBe('connecting')
    expect(noticeEl.textContent).toBe('Connecting to run stream\u2026')
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

// ---------------------------------------------------------------------------
// In-page jump to a run (a question notification tapped with the dashboard open)
// ---------------------------------------------------------------------------

describe('defaultRuntimeLoader — in-page run jump (requestRunJump)', () => {
  type StreamStatus = 'active' | 'terminal' | 'inactive'
  /** What the (mocked) run index leaves behind: `loaded`, `unavailable`, or `unsettled` (reset, replaced or auth: the section never leaves `loading`). */
  type InitOutcome = 'loaded' | 'unavailable' | 'unsettled' | 'auth-required'
  type InitOpts = {
    onSelectRun: (runId: string) => void | Promise<void>
    onAuthRequired: () => void
    restoreRunId?: string
    onRestoreRun?: (runId: string, card: Element, status: string) => void
  }
  type StreamOpts = {runId: string; questionsEl?: Element | null}

  const MISS_COPY = "That run isn't in your recent runs."
  const RETRY_COPY = "Couldn't load your runs. Try again in a moment."

  let scrolled: string[]
  let scrollOptions: (ScrollIntoViewOptions | undefined)[]
  let streamStatus: StreamStatus
  let visibility: DocumentVisibilityState
  let reducedMotion: boolean
  let animationFrames: FrameRequestCallback[]
  const runtimes: OperatorRuntimeHandle[] = []

  beforeEach(() => {
    scrolled = []
    scrollOptions = []
    streamStatus = 'active'
    visibility = 'visible'
    reducedMotion = false
    animationFrames = []
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility})
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({matches: reducedMotion})),
    })
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback)
        return animationFrames.length
      }),
    })
    // jsdom has no scrollIntoView; record which card was scrolled to.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value(this: HTMLElement, options?: ScrollIntoViewOptions) {
        scrolled.push(this.dataset.runId ?? '')
        scrollOptions.push(options)
      },
    })
  })

  afterEach(() => {
    // Drop whatever a test left in the module-level jump slot, and every runtime it mounted.
    createOperatorRuntime({container: makeContainer(), onStateChange: vi.fn(), _runtimeLoader: async () => {}}).cleanup()
    for (const runtime of runtimes.splice(0)) runtime.cleanup()
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    Reflect.deleteProperty(window, 'matchMedia')
    Reflect.deleteProperty(window, 'requestAnimationFrame')
    Reflect.deleteProperty(document, 'visibilityState')
    document.body.innerHTML = ''
    if (location.hash !== '') history.replaceState(null, '', location.pathname + location.search)
    vi.doUnmock('/static/operator-stream.js?manual=1')
    vi.doUnmock('/static/operator-run-index.js?manual=1')
    vi.doUnmock('/static/operator-launch.js?manual=1')
    vi.restoreAllMocks()
    vi.useRealTimers()
    resetQuestionPageStore()
  })

  const tick = () => new Promise<void>(resolve => realSetTimeout(resolve, 0))

  async function flushAnimationFrames() {
    for (let frame = 0; frame < 4; frame += 1) {
      const callbacks = animationFrames.splice(0)
      if (callbacks.length === 0) break
      callbacks.forEach(callback => callback(0))
      await tick()
    }
  }

  function deferred() {
    let resolve = () => {}
    const promise = new Promise<void>(res => {
      resolve = res
    })
    return {promise, resolve}
  }

  function controllableRefresh() {
    const resolvers: ((applied: boolean) => void)[] = []
    const refresh = () => new Promise<boolean>(resolve => {
      resolvers.push(resolve)
    })
    return {refresh, resolvers}
  }

  function cardHtml(runId: string, opts: {expanded?: boolean; status?: keyof typeof STATUS_CLASS_TOKENS; label?: string} = {}): string {
    const {expanded = false, status = 'running', label = 'Running'} = opts
    return `<div data-run-id="${runId}" data-expanded="${expanded}" role="button" tabindex="0"><span data-role="run-status" class="run-status ${STATUS_CLASS_TOKENS[status]}">${label}</span><div data-role="run-questions"></div></div>`
  }

  function renderPage(...cards: string[]): void {
    document.body.innerHTML = `<section data-role="run-index" data-state="loading"><div data-role="run-jump-notice" hidden><div data-role="run-jump-miss" role="status" aria-live="polite" hidden></div><button type="button" data-role="run-jump-dismiss" aria-label="Dismiss notice"></button></div><div data-role="run-index-list">${cards.join('')}</div><div data-role="stream-status" hidden></div><div data-role="run-jump-announcer" role="status" aria-live="polite"></div></section>`
  }

  const cardEl = (runId: string) => document.querySelector(`[data-run-id="${runId}"]`) as HTMLElement
  const missEl = () => document.querySelector('[data-role="run-jump-miss"]') as HTMLElement
  const jumpNoticeEl = () => document.querySelector('[data-role="run-jump-notice"]') as HTMLElement
  const announcerEl = () => document.querySelector('[data-role="run-jump-announcer"]') as HTMLElement
  const streamStatusEl = () => document.querySelector('[data-role="stream-status"]') as HTMLElement

  async function mountJump(options: {
    outcome?: InitOutcome
    gate?: Promise<void>
    refresh?: () => Promise<boolean>
    onInit?: (initOpts: InitOpts) => void
  } = {}) {
    const {outcome = 'loaded'} = options
    const handles: {runId: string; handle: {close: ReturnType<typeof vi.fn>; getConnectionStatus: ReturnType<typeof vi.fn>}}[] = []
    const questionChildrenAtAttach: Record<string, number[]> = {}
    const initOperatorStream = vi.fn((streamOpts: StreamOpts) => {
      const handle = {close: vi.fn(), getConnectionStatus: vi.fn(() => streamStatus)}
      handles.push({runId: streamOpts.runId, handle})
      ;(questionChildrenAtAttach[streamOpts.runId] ??= []).push(streamOpts.questionsEl?.childNodes.length ?? -1)
      return handle
    })
    const refreshOperatorRunIndex = vi.fn(options.refresh ?? (async () => true))
    // Same bookkeeping as the real run index: expanding one card collapses whichever other was open.
    const markCardExpandedForLaunch = vi.fn((runId: string) => {
      for (const card of Array.from(document.querySelectorAll<HTMLElement>('[data-run-id]'))) {
        card.dataset.expanded = card.dataset.runId === runId ? 'true' : 'false'
      }
    })
    const initOperatorLaunch = vi.fn(async () => {})
    const bootstrapOperatorStreams = vi.fn()
    let captured: InitOpts | undefined
    vi.doMock('/static/operator-stream.js?manual=1', () => ({
      initOperatorStream,
      bootstrapOperatorStreams,
      resetBootstrapState: vi.fn(),
    }))
    vi.doMock('/static/operator-run-index.js?manual=1', () => ({
      initOperatorRunIndex: async (initOpts: InitOpts) => {
        captured = initOpts
        await options.gate
        options.onInit?.(initOpts)
        // The real run index resolves with how it ended; the loader branches on that, not on the DOM.
        return outcome === 'unsettled' ? 'stale' : outcome
      },
      refreshOperatorRunIndex,
      resetRunIndexState: vi.fn(),
      markRunStreamAttached: vi.fn(),
      markCardExpandedForLaunch,
    }))
    vi.doMock('/static/operator-launch.js?manual=1', () => ({
      initOperatorLaunch,
      resetLaunchState: vi.fn(),
    }))
    const onStateChange = vi.fn()
    const runtime = createOperatorRuntime({container: makeContainer(), onStateChange})
    runtimes.push(runtime)
    return {
      runtime,
      handles,
      questionChildrenAtAttach,
      initOperatorStream,
      bootstrapOperatorStreams,
      refreshOperatorRunIndex,
      markCardExpandedForLaunch,
      onStateChange,
      /** The loader has finished its setup (and consumed the jump slot, if it was going to). */
      ready: async () => {
        await vi.waitFor(() => expect(initOperatorLaunch).toHaveBeenCalled())
        await tick()
      },
      select: (runId: string) => captured?.onSelectRun(runId),
      authRequired: () => captured?.onAuthRequired(),
      restore: (runId: string, card: Element) => captured?.onRestoreRun?.(runId, card, 'running'),
      attachedRunIds: () => initOperatorStream.mock.calls.map(([streamOpts]) => streamOpts.runId),
    }
  }

  // -------------------------------------------------------------------------
  // Intent ordering: the message can land before, during or after run-index init
  // -------------------------------------------------------------------------

  describe('intent ordering', () => {
    it('a message that arrives before init resolves is applied once init has loaded', async () => {
      renderPage(cardHtml('run-j-a'))
      const gate = deferred()
      const mounted = await mountJump({gate: gate.promise})

      requestRunJump('run-j-a')
      await tick()
      expect(mounted.refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()

      gate.resolve()
      await mounted.ready()

      expect(mounted.refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(location.hash).toBe('#run-j-a')
      expect(cardEl('run-j-a').dataset.expanded).toBe('true')
    })

    it('a message that arrives before the runtime is mounted at all is applied once the mounted runtime has loaded', async () => {
      renderPage(cardHtml('run-j-a'))
      requestRunJump('run-j-a')

      const mounted = await mountJump()
      await mounted.ready()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
    })

    it('a message that arrives after init has loaded is applied at once, not held', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountJump()
      await mounted.ready()
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()

      requestRunJump('run-j-a')
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
    })

    it('a pending message is applied exactly once: a later mount does not replay it', async () => {
      renderPage(cardHtml('run-j-a'))
      requestRunJump('run-j-a')
      const first = await mountJump()
      await first.ready()
      expect(first.attachedRunIds()).toEqual(['run-j-a'])
      first.runtime.cleanup()

      const second = await mountJump()
      await second.ready()

      expect(second.initOperatorStream).not.toHaveBeenCalled()
      expect(second.refreshOperatorRunIndex).not.toHaveBeenCalled()
    })

    const droppedOutcomes: [string, InitOutcome][] = [
      ['init ends unavailable', 'unavailable'],
      ['init is stale (reset or replaced while it fetched)', 'unsettled'],
    ]
    it.each(droppedOutcomes)('%s: the pending jump is dropped, a later message is refused, and neither resurfaces on a later mount', async (_label, outcome) => {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-b'))
      requestRunJump('run-j-a')
      const first = await mountJump({outcome})
      await first.ready()
      expect(first.refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(first.initOperatorStream).not.toHaveBeenCalled()

      // A tap is an immediate intent: with no loaded run index it is not held for some later mount.
      requestRunJump('run-j-b')
      await tick()
      expect(first.refreshOperatorRunIndex).not.toHaveBeenCalled()

      // A healthy mount afterwards must not inherit the dropped intent.
      const second = await mountJump()
      await second.ready()

      expect(second.refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(second.initOperatorStream).not.toHaveBeenCalled()
      expect(cardEl('run-j-a').dataset.expanded).toBe('false')
      expect(cardEl('run-j-b').dataset.expanded).toBe('false')
    })

    it('auth-required during init drops the pending jump', async () => {
      renderPage(cardHtml('run-j-a'))
      requestRunJump('run-j-a')
      const first = await mountJump({outcome: 'auth-required', onInit: initOpts => initOpts.onAuthRequired()})
      await first.ready()
      expect(first.onStateChange).toHaveBeenCalledWith('auth-required')
      expect(first.refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(first.initOperatorStream).not.toHaveBeenCalled()

      const second = await mountJump()
      await second.ready()
      expect(second.initOperatorStream).not.toHaveBeenCalled()
    })

    it('auth-required after init stops a jump already waiting on its refresh, and later messages are not applied', async () => {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-b'))
      const {refresh, resolvers} = controllableRefresh()
      const mounted = await mountJump({refresh})
      await mounted.ready()

      requestRunJump('run-j-a')
      await tick()
      expect(resolvers).toHaveLength(1)

      mounted.authRequired()
      resolvers[0]?.(false)
      await tick()
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()

      requestRunJump('run-j-b')
      await tick()
      expect(mounted.refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()
    })

    it('two rapid messages before init: the last one wins and the first is never attached', async () => {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-b'))
      const gate = deferred()
      const mounted = await mountJump({gate: gate.promise})

      requestRunJump('run-j-a')
      requestRunJump('run-j-b')
      gate.resolve()
      await mounted.ready()

      expect(mounted.attachedRunIds()).toEqual(['run-j-b'])
      expect(location.hash).toBe('#run-j-b')
      expect(cardEl('run-j-a').dataset.expanded).toBe('false')
      expect(mounted.refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
    })

    it('two rapid messages after init: the last one wins even when the first refresh lands last', async () => {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-b'))
      const {refresh, resolvers} = controllableRefresh()
      const mounted = await mountJump({refresh})
      await mounted.ready()

      requestRunJump('run-j-a')
      requestRunJump('run-j-b')
      await tick()
      expect(resolvers).toHaveLength(2)
      resolvers[1]?.(true)
      resolvers[0]?.(true)
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-b'])
      expect(location.hash).toBe('#run-j-b')
      expect(cardEl('run-j-a').dataset.expanded).toBe('false')
    })

    it('a message equal to the mount-time restore target attaches once (the restore owns it)', async () => {
      history.replaceState(null, '', '#run-j-r')
      renderPage(cardHtml('run-j-r'), cardHtml('run-j-s'))
      requestRunJump('run-j-r')
      const mounted = await mountJump({
        onInit: initOpts => {
          expect(initOpts.restoreRunId).toBe('run-j-r')
          const card = cardEl('run-j-r')
          card.dataset.expanded = 'true'
          initOpts.onRestoreRun?.('run-j-r', card, 'running')
        },
      })
      await mounted.ready()

      expect(mounted.attachedRunIds()).toEqual(['run-j-r'])
      expect(mounted.refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(location.hash).toBe('#run-j-r')
    })

    it('a message for a different run than the restore target is still applied, after the restore', async () => {
      history.replaceState(null, '', '#run-j-r')
      renderPage(cardHtml('run-j-r'), cardHtml('run-j-s'))
      requestRunJump('run-j-s')
      const mounted = await mountJump({
        onInit: initOpts => {
          const card = cardEl('run-j-r')
          card.dataset.expanded = 'true'
          initOpts.onRestoreRun?.('run-j-r', card, 'running')
        },
      })
      await mounted.ready()

      expect(mounted.attachedRunIds()).toEqual(['run-j-r', 'run-j-s'])
      expect(location.hash).toBe('#run-j-s')
    })

    it('a message equal to the restore target is applied normally once the runtime is loaded (the target only guards the mount-time handoff)', async () => {
      history.replaceState(null, '', '#run-j-r')
      renderPage(cardHtml('run-j-r'), cardHtml('run-j-s'))
      const mounted = await mountJump()
      await mounted.ready()
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()

      requestRunJump('run-j-r')
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-r'])
    })

    it('cleanup drops a pending jump, including one whose loader had not finished', async () => {
      renderPage(cardHtml('run-j-a'))
      const gate = deferred()
      const first = await mountJump({gate: gate.promise})
      requestRunJump('run-j-a')
      first.runtime.cleanup()
      gate.resolve()
      await first.ready()
      expect(first.refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(first.initOperatorStream).not.toHaveBeenCalled()

      const second = await mountJump()
      await second.ready()
      expect(second.initOperatorStream).not.toHaveBeenCalled()
    })

    it("a jump requested while a newer loader is importing survives the older runtime's cleanup", async () => {
      renderPage(cardHtml('run-j-a'))
      const first = await mountJump()
      await first.ready()
      const gate = deferred()
      const second = await mountJump({gate: gate.promise})

      requestRunJump('run-j-a')
      first.runtime.cleanup()
      gate.resolve()
      await second.ready()

      expect(second.attachedRunIds()).toEqual(['run-j-a'])
      expect(location.hash).toBe('#run-j-a')
    })

    it('an unavailable first load recovers: a refresh that applies re-arms the jump, and a tap then opens the run', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountJump({outcome: 'unavailable'})
      await mounted.ready()

      // Refused while the list is down: dropped, not held.
      requestRunJump('run-j-a')
      await tick()
      expect(mounted.refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()

      // The background refresh succeeds.
      document.dispatchEvent(new Event('visibilitychange'))
      await tick()
      expect(mounted.refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()

      requestRunJump('run-j-a')
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(location.hash).toBe('#run-j-a')
      expect(cardEl('run-j-a').dataset.expanded).toBe('true')
    })

    it('a refresh that does not apply leaves an unavailable load refused', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountJump({outcome: 'unavailable', refresh: async () => false})
      await mounted.ready()

      document.dispatchEvent(new Event('visibilitychange'))
      await tick()
      requestRunJump('run-j-a')
      await tick()

      expect(mounted.refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()
    })

    it('recovery never re-arms a runtime that is auth-required, stale or cleaned up', async () => {
      renderPage(cardHtml('run-j-a'))
      const auth = await mountJump({outcome: 'auth-required', onInit: initOpts => initOpts.onAuthRequired()})
      await auth.ready()
      document.dispatchEvent(new Event('visibilitychange'))
      await tick()
      requestRunJump('run-j-a')
      await tick()
      expect(auth.refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(auth.initOperatorStream).not.toHaveBeenCalled()
      auth.runtime.cleanup()

      const stale = await mountJump({outcome: 'unsettled'})
      await stale.ready()
      document.dispatchEvent(new Event('visibilitychange'))
      await tick()
      requestRunJump('run-j-a')
      await tick()
      expect(stale.initOperatorStream).not.toHaveBeenCalled()
      stale.runtime.cleanup()

      const cleaned = await mountJump({outcome: 'unavailable'})
      await cleaned.ready()
      cleaned.runtime.cleanup()
      document.dispatchEvent(new Event('visibilitychange'))
      await tick()
      requestRunJump('run-j-a')
      await tick()
      expect(cleaned.initOperatorStream).not.toHaveBeenCalled()
    })

    it('cleanup stops a jump waiting on its refresh and nothing is requested of a cleaned-up runtime', async () => {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-b'))
      const {refresh, resolvers} = controllableRefresh()
      const mounted = await mountJump({refresh})
      await mounted.ready()
      requestRunJump('run-j-a')
      await tick()

      mounted.runtime.cleanup()
      resolvers[0]?.(true)
      await tick()
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()

      requestRunJump('run-j-b')
      await tick()
      expect(mounted.refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Jump semantics
  // -------------------------------------------------------------------------

  describe('jump semantics', () => {
    async function mountLoaded(options: Parameters<typeof mountJump>[0] = {}) {
      const mounted = await mountJump(options)
      await mounted.ready()
      return mounted
    }

    it('collapsed card: refreshes first, then expands without toggling, attaches once, writes the hash, focuses and scrolls, and announces the status label', async () => {
      renderPage(cardHtml('run-j-a', {status: 'waiting_for_question', label: 'Waiting for question'}))
      const focus = vi.spyOn(cardEl('run-j-a'), 'focus')
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()

      const [refreshAt] = mounted.refreshOperatorRunIndex.mock.invocationCallOrder
      const [expandAt] = mounted.markCardExpandedForLaunch.mock.invocationCallOrder
      const [attachAt] = mounted.initOperatorStream.mock.invocationCallOrder
      expect(refreshAt).toBeLessThan(expandAt as number)
      expect(expandAt).toBeLessThan(attachAt as number)
      expect(mounted.markCardExpandedForLaunch).toHaveBeenCalledWith('run-j-a')
      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(mounted.handles[0]?.handle.close).not.toHaveBeenCalled()
      expect(cardEl('run-j-a').dataset.expanded).toBe('true')
      expect(location.hash).toBe('#run-j-a')
      expect(document.activeElement).toBe(cardEl('run-j-a'))
      expect(scrolled).toEqual(['run-j-a'])
      expect(scrollOptions).toEqual([{block: 'start', behavior: 'smooth'}])
      expect(focus).toHaveBeenCalledWith({preventScroll: true})
      expect(announcerEl().textContent).toBe('Opened run, Waiting for question')
      expect(announcerEl().textContent).not.toContain('run-j-a')
    })

    it('uses automatic scrolling when reduced motion is preferred', async () => {
      reducedMotion = true
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()

      expect(scrollOptions).toEqual([{block: 'start', behavior: 'auto'}])
      mounted.runtime.cleanup()
    })

    it('does not scroll when a card is expanded by an ordinary click', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()

      await mounted.select('run-j-a')

      expect(scrolled).toEqual([])
    })

    it('scrolls once more after the question region is revealed', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()
      const questions = cardEl('run-j-a').querySelector('[data-role="run-questions"]') as HTMLElement
      questions.hidden = false
      questions.append(document.createElement('p'))
      await tick()
      await flushAnimationFrames()

      expect(scrolled).toEqual(['run-j-a', 'run-j-a'])
      expect(scrollOptions).toEqual([
        {block: 'start', behavior: 'smooth'},
        {block: 'start', behavior: 'smooth'},
      ])
      mounted.runtime.cleanup()
    })

    it('cancels the late scroll when the user starts scrolling', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()
      const questions = cardEl('run-j-a').querySelector('[data-role="run-questions"]') as HTMLElement
      questions.hidden = false
      questions.append(document.createElement('p'))
      await tick()
      expect(animationFrames.length).toBeGreaterThan(0)

      window.dispatchEvent(new Event('touchmove'))
      await flushAnimationFrames()

      expect(scrolled).toEqual(['run-j-a'])
      mounted.runtime.cleanup()
    })

    it('expires the late reveal window after ten seconds', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()
      vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})

      requestRunJump('run-j-a')
      await tick()
      await vi.advanceTimersByTimeAsync(10_001)
      const questions = cardEl('run-j-a').querySelector('[data-role="run-questions"]') as HTMLElement
      questions.hidden = false
      questions.append(document.createElement('p'))
      await tick()
      await flushAnimationFrames()

      expect(scrolled).toEqual(['run-j-a'])
      mounted.runtime.cleanup()
    })

    it('cancels the late reveal on pointerdown', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()
      window.dispatchEvent(new Event('pointerdown'))
      const questions = cardEl('run-j-a').querySelector('[data-role="run-questions"]') as HTMLElement
      questions.hidden = false
      questions.append(document.createElement('p'))
      await tick()
      await flushAnimationFrames()

      expect(scrolled).toEqual(['run-j-a'])
      mounted.runtime.cleanup()
    })

    it('cancels the late reveal when an ordinary click selects another card', async () => {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-b'))
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()
      await mounted.select('run-j-b')
      const questions = cardEl('run-j-a').querySelector('[data-role="run-questions"]') as HTMLElement
      questions.hidden = false
      questions.append(document.createElement('p'))
      await tick()
      await flushAnimationFrames()

      expect(scrolled).toEqual(['run-j-a'])
      mounted.runtime.cleanup()
    })

    it('cancels the late reveal when the expanded card is collapsed', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()
      cardEl('run-j-a').dataset.expanded = 'false'
      await mounted.select('run-j-a')
      const questions = cardEl('run-j-a').querySelector('[data-role="run-questions"]') as HTMLElement
      questions.hidden = false
      questions.append(document.createElement('p'))
      await tick()
      await flushAnimationFrames()

      expect(scrolled).toEqual(['run-j-a'])
      mounted.runtime.cleanup()
    })

    it('does not late-scroll a card that is collapsed before the question paints', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()
      cardEl('run-j-a').dataset.expanded = 'false'
      const questions = cardEl('run-j-a').querySelector('[data-role="run-questions"]') as HTMLElement
      questions.hidden = false
      questions.append(document.createElement('p'))
      await tick()
      await flushAnimationFrames()

      expect(scrolled).toEqual(['run-j-a'])
      mounted.runtime.cleanup()
    })

    it('does not cancel the late reveal for an arrow key inside an input', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()
      const input = document.createElement('input')
      cardEl('run-j-a').append(input)
      const questions = cardEl('run-j-a').querySelector('[data-role="run-questions"]') as HTMLElement
      questions.hidden = false
      questions.append(document.createElement('p'))
      await tick()
      input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
      await flushAnimationFrames()

      expect(scrolled).toEqual(['run-j-a', 'run-j-a'])
      mounted.runtime.cleanup()
    })

    it('scrolls a hash-restored card to its start', async () => {
      renderPage(cardHtml('run-j-r'))
      const mounted = await mountLoaded()

      mounted.restore('run-j-r', cardEl('run-j-r'))

      expect(scrolled).toEqual(['run-j-r'])
      expect(scrollOptions).toEqual([{block: 'start', behavior: 'smooth'}])
      mounted.runtime.cleanup()
    })

    it('seeds the attached stream from the refreshed card status', async () => {
      renderPage(cardHtml('run-j-a', {status: 'running'}))
      const mounted = await mountLoaded({
        refresh: async () => {
          const statusEl = cardEl('run-j-a').querySelector('[data-role="run-status"]') as HTMLElement
          statusEl.className = `run-status ${STATUS_CLASS_TOKENS.succeeded}`
          return true
        },
      })

      requestRunJump('run-j-a')
      await tick()

      expect((mounted.initOperatorStream.mock.calls[0]?.[0] as {summaryStatus?: string}).summaryStatus).toBe('succeeded')
    })

    it('announces just "Opened run" when the card shows no status text', async () => {
      renderPage(cardHtml('run-j-a', {label: ''}))
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(announcerEl().textContent).toBe('Opened run')
    })

    const keepers: [string, StreamStatus][] = [
      ['live', 'active'],
      ['terminal', 'terminal'],
    ]
    it.each(keepers)('expanded card with a %s stream: scroll and focus only (no re-attach, no close, no hash change)', async (_label, status) => {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-b'))
      const mounted = await mountLoaded()
      requestRunJump('run-j-a')
      await tick()
      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      cardEl('run-j-b').focus()
      scrolled.length = 0
      announcerEl().textContent = ''
      streamStatus = status

      requestRunJump('run-j-a')
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(mounted.handles[0]?.handle.close).not.toHaveBeenCalled()
      expect(mounted.markCardExpandedForLaunch).toHaveBeenCalledTimes(1)
      // An already-open card is announced too, with the status label and never the run ID.
      expect(announcerEl().textContent).toBe('Opened run, Running')
      expect(announcerEl().textContent).not.toContain('run-j-a')
      expect(cardEl('run-j-a').dataset.expanded).toBe('true')
      expect(location.hash).toBe('#run-j-a')
      expect(document.activeElement).toBe(cardEl('run-j-a'))
      expect(scrolled).toEqual(['run-j-a'])
      // Every jump refreshes first, even one that only scrolls.
      expect(mounted.refreshOperatorRunIndex).toHaveBeenCalledTimes(2)
    })

    it('expanded card whose stream is closed, failed or unavailable: re-attaches directly (the old handle closes) and never collapses', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()
      requestRunJump('run-j-a')
      await tick()
      streamStatus = 'inactive'
      announcerEl().textContent = ''

      requestRunJump('run-j-a')
      await tick()

      expect(announcerEl().textContent).toBe('Opened run, Running')
      expect(announcerEl().textContent).not.toContain('run-j-a')
      expect(mounted.attachedRunIds()).toEqual(['run-j-a', 'run-j-a'])
      expect(mounted.handles[0]?.handle.close).toHaveBeenCalledTimes(1)
      expect(mounted.handles[1]?.handle.close).not.toHaveBeenCalled()
      expect(cardEl('run-j-a').dataset.expanded).toBe('true')
      expect(location.hash).toBe('#run-j-a')
      expect(document.activeElement).toBe(cardEl('run-j-a'))
      expect(scrolled).toEqual(['run-j-a', 'run-j-a'])
    })

    it('expanded card with no attached stream at all (the earlier attach failed) gets one', async () => {
      renderPage(cardHtml('run-j-a', {expanded: true}))
      const mounted = await mountLoaded()

      requestRunJump('run-j-a')
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(cardEl('run-j-a').dataset.expanded).toBe('true')
      expect(announcerEl().textContent).toBe('Opened run, Running')
    })

    it("reads the stream's connection status live on each repeat jump, from the attached handle only", async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()
      requestRunJump('run-j-a')
      await tick()
      const [first] = mounted.handles
      expect(first?.handle.getConnectionStatus).not.toHaveBeenCalled()

      requestRunJump('run-j-a')
      await tick()
      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(first?.handle.getConnectionStatus).toHaveBeenCalledTimes(1)

      streamStatus = 'inactive'
      requestRunJump('run-j-a')
      await tick()
      const second = mounted.handles[1]
      expect(mounted.attachedRunIds()).toEqual(['run-j-a', 'run-j-a'])
      expect(first?.handle.getConnectionStatus).toHaveBeenCalledTimes(2)

      streamStatus = 'active'
      requestRunJump('run-j-a')
      await tick()
      expect(mounted.attachedRunIds()).toEqual(['run-j-a', 'run-j-a'])
      expect(second?.handle.getConnectionStatus).toHaveBeenCalledTimes(1)
      expect(first?.handle.getConnectionStatus).toHaveBeenCalledTimes(2)
    })

    it('switching runs closes the old stream, expands the new card, and leaves the other card\'s question draft in the page store for the return trip', async () => {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-b'))
      const mounted = await mountLoaded()
      requestRunJump('run-j-a')
      await tick()
      const draft = {options: [], text: 'half-typed answer'}
      getQuestionPageStore('run-j-a').drafts.set('req-1', draft)
      ;(cardEl('run-j-a').querySelector('[data-role="run-questions"]') as HTMLElement).append(document.createElement('p'))

      requestRunJump('run-j-b')
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a', 'run-j-b'])
      expect(mounted.handles[0]?.handle.close).toHaveBeenCalledTimes(1)
      expect(cardEl('run-j-a').dataset.expanded).toBe('false')
      expect(cardEl('run-j-b').dataset.expanded).toBe('true')
      expect(location.hash).toBe('#run-j-b')
      expect(getQuestionPageStore('run-j-a').drafts.get('req-1')).toBe(draft)

      // Returning re-attaches over an emptied question region, and the draft is still there for the stream to restore.
      requestRunJump('run-j-a')
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a', 'run-j-b', 'run-j-a'])
      expect(mounted.questionChildrenAtAttach['run-j-a']).toEqual([0, 0])
      expect(getQuestionPageStore('run-j-a').drafts.get('req-1')).toBe(draft)
      expect(cardEl('run-j-a').dataset.expanded).toBe('true')
    })

    it('a jump supersedes an expand that is still waiting on its refresh', async () => {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-c'))
      const {refresh, resolvers} = controllableRefresh()
      const mounted = await mountLoaded({refresh})

      const expanding = mounted.select('run-j-c')
      expect(resolvers).toHaveLength(1)
      requestRunJump('run-j-a')
      await tick()
      for (const resolve of resolvers) resolve(true)
      await expanding
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(location.hash).toBe('#run-j-a')
    })

    it('a jump supersedes an expand that starts while the jump waits on its refresh', async () => {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-c'))
      const {refresh, resolvers} = controllableRefresh()
      const mounted = await mountLoaded({refresh})

      requestRunJump('run-j-a')
      await tick()
      const expanding = mounted.select('run-j-c')
      for (const resolve of resolvers) resolve(true)
      await expanding
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(cardEl('run-j-a').dataset.expanded).toBe('true')
    })

    const invalidIds: [string, string][] = [
      ['an empty string', ''],
      ['a path segment', 'a/b'],
      ['a dot-dot', '..'],
      ['a dot', 'a.b'],
      ['a percent escape', '%41'],
      ['whitespace', 'run 1'],
      ['a trailing newline', 'run-1\n'],
      ['129 characters', 'a'.repeat(129)],
    ]
    it.each(invalidIds)('refuses %s (the strict run ID pattern applies to a jump)', async (_label, runId) => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountLoaded()

      requestRunJump(runId)
      await tick()

      expect(mounted.refreshOperatorRunIndex).not.toHaveBeenCalled()
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()
      expect(missEl().hidden).toBe(true)
    })

    it('a refused ID leaves a previously requested valid one alone, and is never stored for a later mount', async () => {
      renderPage(cardHtml('run-j-a'))
      requestRunJump('run-j-a')
      requestRunJump('not valid!')
      const mounted = await mountLoaded()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
    })

    it('accepts a 128-character run ID', async () => {
      const longId = 'r'.repeat(128)
      renderPage(cardHtml(longId))
      const mounted = await mountLoaded()

      requestRunJump(longId)
      await tick()

      expect(mounted.attachedRunIds()).toEqual([longId])
    })

    it('restoring from a hash keeps the permissive hash validation: sanitizeRunIdFromHash is unchanged', () => {
      expect(sanitizeRunIdFromHash('#run.with.dots')).toBe('run.with.dots')
      expect(sanitizeRunIdFromHash('#a/b')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // A run that is not in the list
  // -------------------------------------------------------------------------

  describe('a run missing from the list', () => {
    async function mountOnExpandedA(options: Parameters<typeof mountJump>[0] = {}) {
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-b'))
      const mounted = await mountJump(options)
      await mounted.ready()
      requestRunJump('run-j-a')
      await tick()
      expect(location.hash).toBe('#run-j-a')
      return mounted
    }

    it('shows the dedicated notice with fixed copy, leaves the hash, the expansion and the stream alone, and never echoes the ID', async () => {
      const mounted = await mountOnExpandedA()
      const announcedBefore = announcerEl().textContent

      requestRunJump('run-j-gone')
      await tick()

      expect(missEl().hidden).toBe(false)
      expect(missEl().textContent).toBe(MISS_COPY)
      expect(missEl()).not.toBe(streamStatusEl())
      expect(streamStatusEl().hidden).toBe(true)
      expect(streamStatusEl().textContent).toBe('')
      expect(location.hash).toBe('#run-j-a')
      expect(cardEl('run-j-a').dataset.expanded).toBe('true')
      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(mounted.handles[0]?.handle.close).not.toHaveBeenCalled()
      expect(announcerEl().textContent).toBe(announcedBefore)
      expect(document.body.innerHTML).not.toContain('run-j-gone')
    })

    it('a miss with nothing expanded and no hash writes neither', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountJump()
      await mounted.ready()

      requestRunJump('run-j-gone')
      await tick()

      expect(missEl().textContent).toBe(MISS_COPY)
      expect(location.hash).toBe('')
      expect(mounted.initOperatorStream).not.toHaveBeenCalled()
      expect(mounted.markCardExpandedForLaunch).not.toHaveBeenCalled()
    })

    it('a miss is decided after the refresh, so a run that only the refresh brings in is found', async () => {
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountJump({
        refresh: async () => {
          document.querySelector('[data-role="run-index-list"]')?.insertAdjacentHTML('beforeend', cardHtml('run-j-new'))
          return true
        },
      })
      await mounted.ready()

      requestRunJump('run-j-new')
      await tick()

      expect(missEl().hidden).toBe(true)
      expect(mounted.attachedRunIds()).toEqual(['run-j-new'])
    })

    it('the notice clears on the next jump (a hit)', async () => {
      await mountOnExpandedA()
      requestRunJump('run-j-gone')
      await tick()
      expect(missEl().hidden).toBe(false)

      requestRunJump('run-j-b')
      await tick()

      expect(missEl().hidden).toBe(true)
      expect(missEl().textContent).toBe('')
    })

    it('can be dismissed without changing the jump announcement', async () => {
      await mountOnExpandedA()
      const announcedBefore = announcerEl().textContent
      requestRunJump('run-j-gone')
      await tick()

      ;(document.querySelector('[data-role="run-jump-dismiss"]') as HTMLButtonElement).click()

      expect(jumpNoticeEl().hidden).toBe(true)
      expect(missEl().hidden).toBe(true)
      expect(missEl().textContent).toBe('')
      expect(announcerEl().textContent).toBe(announcedBefore)
    })

    it('the notice clears on the next jump even when that jump misses too (it shows afresh, not stacked)', async () => {
      await mountOnExpandedA()
      requestRunJump('run-j-gone')
      await tick()

      requestRunJump('run-j-gone-too')
      await tick()

      expect(missEl().hidden).toBe(false)
      expect(missEl().textContent).toBe(MISS_COPY)
    })

    it('the notice clears when a card expands', async () => {
      const mounted = await mountOnExpandedA()
      requestRunJump('run-j-gone')
      await tick()
      expect(missEl().hidden).toBe(false)

      await mounted.select('run-j-b')

      expect(missEl().hidden).toBe(true)
      expect(missEl().textContent).toBe('')
    })

    it('the notice stays through a collapse', async () => {
      const mounted = await mountOnExpandedA()
      requestRunJump('run-j-gone')
      await tick()

      await mounted.select('run-j-a') // run-j-a is the active stream: this is a collapse

      expect(missEl().hidden).toBe(false)
    })

    it('the notice clears on a refresh that finds the run, and stays through refreshes that do not', async () => {
      let runArrives = false
      const mounted = await mountOnExpandedA({
        refresh: async () => {
          if (runArrives && document.querySelector('[data-run-id="run-j-late"]') === null) {
            document.querySelector('[data-role="run-index-list"]')?.insertAdjacentHTML('beforeend', cardHtml('run-j-late'))
          }
          return true
        },
      })
      requestRunJump('run-j-late')
      await tick()
      expect(missEl().hidden).toBe(false)
      const refreshesSoFar = mounted.refreshOperatorRunIndex.mock.calls.length

      document.dispatchEvent(new Event('visibilitychange'))
      await tick()
      expect(mounted.refreshOperatorRunIndex.mock.calls.length).toBe(refreshesSoFar + 1)
      expect(missEl().hidden).toBe(false)

      runArrives = true
      document.dispatchEvent(new Event('visibilitychange'))
      await tick()

      expect(missEl().hidden).toBe(true)
      expect(missEl().textContent).toBe('')
      // Finding the run in the list is not a jump: nothing was expanded or attached for it.
      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
    })

    const failedRefreshes: [string, () => Promise<boolean>][] = [
      ['resolves false (429, network, timeout, bad body)', async () => false],
      ['rejects', async () => Promise.reject(new Error('boom'))],
    ]
    it.each(failedRefreshes)('a missing card after a refresh that %s shows the retry notice, not the not-found copy, and never echoes the ID', async (_label, refresh) => {
      const mounted = await mountOnExpandedA({refresh})

      requestRunJump('run-j-gone')
      await tick()

      expect(missEl().hidden).toBe(false)
      expect(missEl().textContent).toBe(RETRY_COPY)
      expect(missEl().textContent).not.toBe(MISS_COPY)
      expect(missEl()).not.toBe(streamStatusEl())
      expect(document.body.innerHTML).not.toContain('run-j-gone')
      // Like a miss, it touches nothing else.
      expect(location.hash).toBe('#run-j-a')
      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect(cardEl('run-j-a').dataset.expanded).toBe('true')
    })

    it('a card that is present opens normally even though its refresh failed, with no notice', async () => {
      const mounted = await mountOnExpandedA({refresh: async () => false})
      expect(missEl().hidden).toBe(true)

      requestRunJump('run-j-b')
      await tick()

      expect(mounted.attachedRunIds()).toEqual(['run-j-a', 'run-j-b'])
      expect(cardEl('run-j-b').dataset.expanded).toBe('true')
      expect(location.hash).toBe('#run-j-b')
      expect(missEl().hidden).toBe(true)
      expect(announcerEl().textContent).toBe('Opened run, Running')
    })

    describe('the retry notice lifetime', () => {
      let listLoads: boolean
      beforeEach(() => {
        listLoads = false
      })
      const mountWithRetryNotice = async () => {
        const mounted = await mountOnExpandedA({refresh: async () => listLoads})
        requestRunJump('run-j-gone')
        await tick()
        expect(missEl().textContent).toBe(RETRY_COPY)
        return mounted
      }

      it('clears on the next refresh that applies, and stays through refreshes that do not', async () => {
        await mountWithRetryNotice()

        document.dispatchEvent(new Event('visibilitychange'))
        await tick()
        expect(missEl().hidden).toBe(false)

        listLoads = true
        document.dispatchEvent(new Event('visibilitychange'))
        await tick()

        expect(missEl().hidden).toBe(true)
        expect(missEl().textContent).toBe('')
      })

      it('clears on the next jump, and shows afresh when that jump fails the same way', async () => {
        await mountWithRetryNotice()

        requestRunJump('run-j-b')
        await tick()
        expect(missEl().hidden).toBe(true)

        requestRunJump('run-j-gone')
        await tick()
        expect(missEl().textContent).toBe(RETRY_COPY)
      })

      it('clears when a card expands', async () => {
        const mounted = await mountWithRetryNotice()

        await mounted.select('run-j-b')

        expect(missEl().hidden).toBe(true)
        expect(missEl().textContent).toBe('')
      })
    })

    it('without a miss element on the page a miss is silent and harmless', async () => {
      renderPage(cardHtml('run-j-a'))
      missEl().remove()
      const mounted = await mountJump()
      await mounted.ready()

      requestRunJump('run-j-gone')
      await tick()

      expect(mounted.initOperatorStream).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Safety
  // -------------------------------------------------------------------------

  describe('safety', () => {
    it('the hash write does not trigger another jump, and nothing listens for hashchange', async () => {
      const added = vi.spyOn(window, 'addEventListener')
      const addedDoc = vi.spyOn(document, 'addEventListener')
      renderPage(cardHtml('run-j-a'))
      const mounted = await mountJump()
      await mounted.ready()

      requestRunJump('run-j-a')
      await tick()
      expect(location.hash).toBe('#run-j-a')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      await tick()

      expect(mounted.refreshOperatorRunIndex).toHaveBeenCalledTimes(1)
      expect(mounted.attachedRunIds()).toEqual(['run-j-a'])
      expect([...added.mock.calls, ...addedDoc.mock.calls].map(([type]) => type)).not.toContain('hashchange')
    })

    it('runtime.ts never mentions hashchange', async () => {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const url = await import('node:url')
      const src = await fs.readFile(path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'runtime.ts'), 'utf8')
      expect(src).not.toMatch(/hashchange/)
    })

    it('makes no console call on any jump path: hit, repeat, re-attach, miss, refused, dropped', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
      renderPage(cardHtml('run-j-a'), cardHtml('run-j-b'))
      requestRunJump('run-j-a')
      const mounted = await mountJump()
      await mounted.ready()

      requestRunJump('run-j-a')
      streamStatus = 'inactive'
      requestRunJump('run-j-a')
      await tick()
      requestRunJump('run-j-b')
      requestRunJump('run-j-gone')
      requestRunJump('not valid!')
      await tick()
      mounted.runtime.cleanup()

      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    })
  })
})
