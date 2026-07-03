/**
 * Pure core tests for public/operator-run-index.js.
 * Imports directly from the plain ESM file — no TS syntax, no DOM at module level.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  buildRunSafeView,
  FETCH_TIMEOUT_MS,
  fetchRunIndex,
  initOperatorRunIndex,
  markRunStreamAttached,
  parseRunSummaryItem,
  parseRunSummaryList,
  resetRunIndexState,
  RUN_INDEX_CAP,
  VALID_RUN_SUMMARY_STATUSES,
} from '../public/operator-run-index.js'

function makeValidSummary(overrides = {}) {
  return {
    runId: 'run-abc-001',
    repo: 'fro-bot/agent',
    status: 'running',
    createdAt: '2026-06-26T12:00:00.000Z',
    ...overrides,
  }
}

describe('parseRunSummaryItem — happy path', () => {
  it('parses a minimal valid run summary', () => {
    const result = parseRunSummaryItem(makeValidSummary())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runId).toBe('run-abc-001')
      expect(result.data.repo).toBe('fro-bot/agent')
      expect(result.data.status).toBe('running')
      expect(result.data.createdAt).toBe('2026-06-26T12:00:00.000Z')
    }
  })

  it('parses a run summary with optional updatedAt present', () => {
    const result = parseRunSummaryItem(makeValidSummary({updatedAt: '2026-06-26T13:00:00.000Z'}))
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.updatedAt).toBe('2026-06-26T13:00:00.000Z')
    }
  })

  it('parses a run summary without updatedAt — field is absent', () => {
    const result = parseRunSummaryItem(makeValidSummary())
    expect(result.success).toBe(true)
    if (result.success) {
      expect('updatedAt' in result.data).toBe(false)
    }
  })

  it('accepts all valid index statuses', () => {
    const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
    for (const status of statuses) {
      const result = parseRunSummaryItem(makeValidSummary({status}))
      expect(result.success, `status ${status} should be valid`).toBe(true)
    }
  })

  it('ignores extra unknown fields', () => {
    const result = parseRunSummaryItem(makeValidSummary({unknownField: 'should-be-ignored', anotherField: 42}))
    expect(result.success).toBe(true)
    if (result.success) {
      expect('unknownField' in result.data).toBe(false)
      expect('anotherField' in result.data).toBe(false)
    }
  })
})

describe('parseRunSummaryItem — error paths', () => {
  it('rejects null', () => {
    const result = parseRunSummaryItem(null)
    expect(result.success).toBe(false)
  })

  it('rejects non-object', () => {
    const result = parseRunSummaryItem('not-an-object')
    expect(result.success).toBe(false)
  })

  it('rejects array', () => {
    const result = parseRunSummaryItem([])
    expect(result.success).toBe(false)
  })

  it('rejects missing runId', () => {
    const result = parseRunSummaryItem({repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-26T12:00:00.000Z'})
    expect(result.success).toBe(false)
  })

  it('rejects non-string runId', () => {
    const result = parseRunSummaryItem(makeValidSummary({runId: 42}))
    expect(result.success).toBe(false)
  })

  it('rejects missing repo', () => {
    const result = parseRunSummaryItem({runId: 'run-abc-001', status: 'running', createdAt: '2026-06-26T12:00:00.000Z'})
    expect(result.success).toBe(false)
  })

  it('rejects missing status', () => {
    const result = parseRunSummaryItem({runId: 'run-abc-001', repo: 'fro-bot/agent', createdAt: '2026-06-26T12:00:00.000Z'})
    expect(result.success).toBe(false)
  })

  it('rejects unknown status', () => {
    const result = parseRunSummaryItem(makeValidSummary({status: 'unknown-status'}))
    expect(result.success).toBe(false)
  })

  it('rejects stream-only status: waiting_for_approval', () => {
    const result = parseRunSummaryItem(makeValidSummary({status: 'waiting_for_approval'}))
    expect(result.success).toBe(false)
  })

  it('rejects stream-only status: blocked', () => {
    const result = parseRunSummaryItem(makeValidSummary({status: 'blocked'}))
    expect(result.success).toBe(false)
  })

  it('rejects missing createdAt', () => {
    const result = parseRunSummaryItem({runId: 'run-abc-001', repo: 'fro-bot/agent', status: 'running'})
    expect(result.success).toBe(false)
  })

  it('rejects oversized runId (>512 chars)', () => {
    const result = parseRunSummaryItem(makeValidSummary({runId: 'x'.repeat(513)}))
    expect(result.success).toBe(false)
  })

  it('rejects oversized repo (>512 chars)', () => {
    const result = parseRunSummaryItem(makeValidSummary({repo: 'x'.repeat(513)}))
    expect(result.success).toBe(false)
  })

  it('rejects oversized createdAt (>128 chars)', () => {
    const result = parseRunSummaryItem(makeValidSummary({createdAt: 'x'.repeat(129)}))
    expect(result.success).toBe(false)
  })

  it('rejects oversized updatedAt (>128 chars)', () => {
    const result = parseRunSummaryItem(makeValidSummary({updatedAt: 'x'.repeat(129)}))
    expect(result.success).toBe(false)
  })

  it('rejects non-string updatedAt when present', () => {
    const result = parseRunSummaryItem(makeValidSummary({updatedAt: 12345}))
    expect(result.success).toBe(false)
  })
})

describe('parseRunSummaryList — cap and dedupe', () => {
  it('returns empty array for empty input', () => {
    const result = parseRunSummaryList([])
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toHaveLength(0)
  })

  it('returns error for non-array input', () => {
    const result = parseRunSummaryList({})
    expect(result.success).toBe(false)
  })

  it('skips invalid items without failing the whole list', () => {
    const items = [makeValidSummary(), {invalid: true}, makeValidSummary({runId: 'run-002'})]
    const result = parseRunSummaryList(items)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toHaveLength(2)
  })

  it('caps at RUN_INDEX_CAP (100) items', () => {
    const items = Array.from({length: 150}, (_, i) => makeValidSummary({runId: `run-${i.toString().padStart(3, '0')}`}))
    const result = parseRunSummaryList(items)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toHaveLength(RUN_INDEX_CAP)
  })

  it('keeps first valid duplicate runId, suppresses later duplicates', () => {
    const items = [
      makeValidSummary({runId: 'run-dup', status: 'running'}),
      makeValidSummary({runId: 'run-dup', status: 'succeeded'}),
    ]
    const result = parseRunSummaryList(items)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(1)
      expect(result.data[0]?.status).toBe('running')
    }
  })

  it('preserves order (newest-first from Gateway)', () => {
    const items = [
      makeValidSummary({runId: 'run-001', createdAt: '2026-06-26T13:00:00.000Z'}),
      makeValidSummary({runId: 'run-002', createdAt: '2026-06-26T12:00:00.000Z'}),
    ]
    const result = parseRunSummaryList(items)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data[0]?.runId).toBe('run-001')
      expect(result.data[1]?.runId).toBe('run-002')
    }
  })
})

describe('VALID_RUN_SUMMARY_STATUSES — exact index-only set', () => {
  it('contains exactly the five index-only statuses', () => {
    const expected = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
    expect(VALID_RUN_SUMMARY_STATUSES).toEqual(expected)
  })

  it('does not contain stream-only statuses', () => {
    expect(VALID_RUN_SUMMARY_STATUSES.has('waiting_for_approval')).toBe(false)
    expect(VALID_RUN_SUMMARY_STATUSES.has('blocked')).toBe(false)
  })
})

describe('buildRunSafeView — closed safe-view boundary', () => {
  it('returns an object with exactly the allowed display keys', () => {
    const summary = {
      runId: 'run-abc-001',
      repo: 'fro-bot/agent',
      status: 'running',
      createdAt: '2026-06-26T12:00:00.000Z',
    }
    const view = buildRunSafeView(summary)
    const keys = Object.keys(view).sort()
    expect(keys).toContain('runId')
    expect(keys).toContain('repo')
    expect(keys).toContain('status')
    expect(keys).toContain('createdAt')
    expect(keys).toContain('statusLabel')
  })

  it('excludes unknown fields from the safe view', () => {
    const summaryWithExtra = {
      runId: 'run-abc-001',
      repo: 'fro-bot/agent',
      status: 'running',
      createdAt: '2026-06-26T12:00:00.000Z',
      unknownField: 'should-not-appear',
    }
    const view = buildRunSafeView(summaryWithExtra)
    expect('unknownField' in view).toBe(false)
  })

  it('omits updatedAt from safe view when absent in summary', () => {
    const summary = {
      runId: 'run-abc-001',
      repo: 'fro-bot/agent',
      status: 'running',
      createdAt: '2026-06-26T12:00:00.000Z',
    }
    const view = buildRunSafeView(summary)
    expect('updatedAt' in view).toBe(false)
  })

  it('includes updatedAt in safe view when present in summary', () => {
    const summary = {
      runId: 'run-abc-001',
      repo: 'fro-bot/agent',
      status: 'running',
      createdAt: '2026-06-26T12:00:00.000Z',
      updatedAt: '2026-06-26T13:00:00.000Z',
    }
    const view = buildRunSafeView(summary)
    expect(view.updatedAt).toBe('2026-06-26T13:00:00.000Z')
  })

  it('statusLabel is a human-readable string from a local map, not the raw status', () => {
    const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
    for (const status of statuses) {
      const summary = {runId: 'run-001', repo: 'fro-bot/agent', status, createdAt: '2026-06-26T12:00:00.000Z'}
      const view = buildRunSafeView(summary)
      expect(typeof view.statusLabel).toBe('string')
      expect(view.statusLabel.length).toBeGreaterThan(0)
    }
  })
})

describe('operator-run-index.js source — no-console invariant', () => {
  it('source does not contain console.log calls', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toMatch(/console\.log\s*\(/)
  })

  it('source does not contain console.error calls', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toMatch(/console\.error\s*\(/)
  })

  it('source does not contain console.warn calls', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toMatch(/console\.warn\s*\(/)
  })

  it('source does not contain /__fixture string (no hardcoded fixture routes)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toContain('/__fixture')
  })

  it('source does not contain fixtureMode flag strings', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toContain('fixtureMode')
    expect(src).not.toContain('fixture-runtime-loader')
  })
})

describe('operator-run-index.js — no-console behavior invariant', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parseRunSummaryItem does not call console.error or console.warn on valid input', () => {
    parseRunSummaryItem(makeValidSummary())
    expect(vi.mocked(console.error).mock.calls).toHaveLength(0)
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(0)
  })

  it('parseRunSummaryItem does not call console.error or console.warn on invalid input', () => {
    parseRunSummaryItem({runId: 'x', status: 'invalid-status', repo: 'r', createdAt: 'c'})
    expect(vi.mocked(console.error).mock.calls).toHaveLength(0)
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(0)
  })

  it('parseRunSummaryList does not call console.error or console.warn on any input', () => {
    parseRunSummaryList([makeValidSummary(), {invalid: true}])
    expect(vi.mocked(console.error).mock.calls).toHaveLength(0)
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(0)
  })
})

describe('fetchRunIndex — error paths collapse to neutral unavailable', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('401 response collapses to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  it('403 response collapses to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  it('404 response collapses to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  it('500 response collapses to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  it('network error collapses to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  it('non-JSON response collapses to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token') },
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  it('malformed response (non-array) collapses to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({not: 'an-array'}),
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  // Regression pin: the gateway wraps run listings in an envelope
  // ({runs: RunSummary[]}) — see fro-bot/agent packages/gateway/src/web/operator/runs-route.ts.
  // A bare array must no longer be accepted; it must collapse to unavailable.
  it('bare-array response body collapses to unavailable (gateway envelope required)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [makeValidSummary()],
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  it('{runs: "nope"} (non-array runs field) collapses to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: 'nope'}),
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  it('{} (missing runs field) collapses to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  it('valid envelope response returns loaded kind with summaries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: [makeValidSummary()]}),
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('loaded')
    if (result.kind === 'loaded') {
      expect(result.summaries).toHaveLength(1)
    }
  })

  it('{runs: []} returns loaded kind with empty summaries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: []}),
    }))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('loaded')
    if (result.kind === 'loaded') {
      expect(result.summaries).toHaveLength(0)
    }
  })
})

describe('fetchRunIndex — fixture endpointBase', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches from /__fixture/operator/runs when endpointBase is /__fixture/operator', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: []}),
    })
    vi.stubGlobal('fetch', mockFetch)
    await fetchRunIndex({endpointBase: '/__fixture/operator'})
    expect(mockFetch).toHaveBeenCalledWith(
      '/__fixture/operator/runs',
      expect.objectContaining({credentials: 'include', redirect: 'error'}),
    )
  })

  it('fetches from /operator/runs when endpointBase is /operator (default)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: []}),
    })
    vi.stubGlobal('fetch', mockFetch)
    await fetchRunIndex({endpointBase: '/operator'})
    expect(mockFetch).toHaveBeenCalledWith(
      '/operator/runs',
      expect.objectContaining({credentials: 'include', redirect: 'error'}),
    )
  })

  it('appends fixtureSessionId as query param when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: []}),
    })
    vi.stubGlobal('fetch', mockFetch)
    await fetchRunIndex({endpointBase: '/__fixture/operator', fixtureSessionId: 'fixture-session-0001'})
    expect(mockFetch).toHaveBeenCalledWith(
      '/__fixture/operator/runs?fixtureSessionId=fixture-session-0001',
      expect.objectContaining({credentials: 'include', redirect: 'error'}),
    )
  })

  it('does NOT append fixtureSessionId when not provided (production path)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: []}),
    })
    vi.stubGlobal('fetch', mockFetch)
    await fetchRunIndex({endpointBase: '/operator'})
    const calledUrl = mockFetch.mock.calls[0][0]
    expect(calledUrl).toBe('/operator/runs')
    expect(calledUrl).not.toContain('fixtureSessionId')
  })

  it('does NOT append fixtureSessionId when undefined (production path)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: []}),
    })
    vi.stubGlobal('fetch', mockFetch)
    await fetchRunIndex({endpointBase: '/operator', fixtureSessionId: undefined})
    const calledUrl = mockFetch.mock.calls[0][0]
    expect(calledUrl).toBe('/operator/runs')
    expect(calledUrl).not.toContain('fixtureSessionId')
  })
})

describe('fetchRunIndex — no-console on error paths', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not call console.error or console.warn on 401 error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: false, status: 401, json: async () => ({})}))
    await fetchRunIndex({endpointBase: '/operator'})
    expect(vi.mocked(console.error).mock.calls).toHaveLength(0)
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(0)
  })

  it('does not call console.error or console.warn on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    await fetchRunIndex({endpointBase: '/operator'})
    expect(vi.mocked(console.error).mock.calls).toHaveLength(0)
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(0)
  })

  it('does not call console.error or console.warn on malformed response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, status: 200, json: async () => ({not: 'array'})}))
    await fetchRunIndex({endpointBase: '/operator'})
    expect(vi.mocked(console.error).mock.calls).toHaveLength(0)
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(0)
  })
})

describe('resetRunIndexState — module lifecycle export', () => {
  it('is exported as a function', () => {
    expect(typeof resetRunIndexState).toBe('function')
  })

  it('does not throw when called', () => {
    expect(() => resetRunIndexState()).not.toThrow()
  })

  it('is idempotent — calling twice does not throw', () => {
    expect(() => {
      resetRunIndexState()
      resetRunIndexState()
    }).not.toThrow()
  })
})

describe('initOperatorRunIndex — module lifecycle export', () => {
  it('is exported as a function', () => {
    expect(typeof initOperatorRunIndex).toBe('function')
  })

  it('returns a promise', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, status: 200, json: async () => ({runs: []})}))
    const result = initOperatorRunIndex({endpointBase: '/operator'})
    expect(result).toBeInstanceOf(Promise)
    vi.restoreAllMocks()
  })
})

describe('parser parity — JS parser mirrors vendored TS parser behavior', () => {
  it('valid summary: JS parser accepts same shape as TS parser', () => {
    const input = makeValidSummary()
    const result = parseRunSummaryItem(input)
    expect(result.success).toBe(true)
  })

  it('invalid status: JS parser rejects same invalid statuses as TS parser', () => {
    const invalidStatuses = ['waiting_for_approval', 'blocked', 'unknown', 'RUNNING', '']
    for (const status of invalidStatuses) {
      const result = parseRunSummaryItem(makeValidSummary({status}))
      expect(result.success, `status "${status}" should be rejected`).toBe(false)
    }
  })

  it('oversized field: JS parser rejects same oversized fields as TS parser', () => {
    expect(parseRunSummaryItem(makeValidSummary({runId: 'x'.repeat(513)})).success).toBe(false)
    expect(parseRunSummaryItem(makeValidSummary({repo: 'x'.repeat(513)})).success).toBe(false)
    expect(parseRunSummaryItem(makeValidSummary({createdAt: 'x'.repeat(129)})).success).toBe(false)
    expect(parseRunSummaryItem(makeValidSummary({updatedAt: 'x'.repeat(129)})).success).toBe(false)
  })

  it('duplicate runId: JS parser keeps first valid entry like TS parser', () => {
    const items = [
      makeValidSummary({runId: 'run-dup', status: 'queued'}),
      makeValidSummary({runId: 'run-dup', status: 'succeeded'}),
    ]
    const result = parseRunSummaryList(items)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(1)
      expect(result.data[0]?.status).toBe('queued')
    }
  })

  it('missing updatedAt: JS parser treats absence as absence (not empty string)', () => {
    const result = parseRunSummaryItem(makeValidSummary())
    expect(result.success).toBe(true)
    if (result.success) {
      expect('updatedAt' in result.data).toBe(false)
      expect(result.data.updatedAt).toBeUndefined()
    }
  })

  it('extra field: JS parser excludes extra fields from parsed output', () => {
    const result = parseRunSummaryItem(makeValidSummary({extraField: 'extra-value'}))
    expect(result.success).toBe(true)
    if (result.success) {
      expect('extraField' in result.data).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Card selection and lifecycle
// ---------------------------------------------------------------------------

describe('initOperatorRunIndex — onSelectRun callback wired to card clicks', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('initOperatorRunIndex accepts an onSelectRun callback option without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: [makeValidSummary({runId: 'run-select-001'})]}),
    }))
    // No DOM — function bails early when document is undefined
    const onSelectRun = vi.fn()
    await expect(initOperatorRunIndex({endpointBase: '/operator', onSelectRun})).resolves.toBeUndefined()
    expect(onSelectRun).not.toHaveBeenCalled()
  })

  it('operator-run-index.js source contains onSelectRun callback wiring', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).toContain('onSelectRun')
  })

  it('operator-run-index.js source wires card click to onSelectRun', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    // The source must wire click events to onSelectRun
    expect(src).toContain('onSelectRun')
    expect(src).toContain('click')
  })

  it('operator-run-index.js source contains markRunStreamAttached export', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).toContain('markRunStreamAttached')
  })
})

describe('initOperatorRunIndex — stream-attached runId guard (index is seed state only)', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('markRunStreamAttached export exists and is a function', async () => {
    const mod = await import('../public/operator-run-index.js')
    expect(typeof mod.markRunStreamAttached).toBe('function')
  })

  it('markRunStreamAttached does not throw when called', async () => {
    const {markRunStreamAttached} = await import('../public/operator-run-index.js')
    expect(() => markRunStreamAttached('run-attached-001')).not.toThrow()
  })

  it('markRunStreamAttached is idempotent — calling twice does not throw', async () => {
    const {markRunStreamAttached} = await import('../public/operator-run-index.js')
    expect(() => {
      markRunStreamAttached('run-idempotent-001')
      markRunStreamAttached('run-idempotent-001')
    }).not.toThrow()
  })

  it('resetRunIndexState clears stream-attached set (markRunStreamAttached after reset does not throw)', async () => {
    const {markRunStreamAttached} = await import('../public/operator-run-index.js')
    markRunStreamAttached('run-reset-001')
    resetRunIndexState()
    // After reset, marking again should work without error
    expect(() => markRunStreamAttached('run-reset-001')).not.toThrow()
  })

  it('operator-run-index.js source contains _streamAttachedRunIds or similar guard set', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    // The source must contain the stream-attached guard
    expect(src).toContain('markRunStreamAttached')
    // And the guard must be used in the click handler
    expect(src).toContain('streamAttached')
  })
})

describe('initOperatorRunIndex — launched run convergence (no duplicate card)', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('operator-run-index.js source skips rendering a card if runId already exists in DOM', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    // The source must check for existing cards before inserting
    expect(src).toContain('data-run-id')
    // Must have a duplicate-check guard
    expect(src).toMatch(/querySelector.*data-run-id|data-run-id.*querySelector/)
  })
})

// ---------------------------------------------------------------------------
// markRunStreamAttached — A → B → A lifecycle (single active stream)
// ---------------------------------------------------------------------------

describe('markRunStreamAttached — A → B clears A, only B is inert', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('marking B removes data-stream-attached from A and sets it on B', async () => {
    const runIdA = 'run-lifecycle-A'
    const runIdB = 'run-lifecycle-B'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [makeValidSummary({runId: runIdA}), makeValidSummary({runId: runIdB})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})
    expect(cards).toHaveLength(2)

    const cardA = cards.find(c => c.dataset.runId === runIdA)
    const cardB = cards.find(c => c.dataset.runId === runIdB)

    markRunStreamAttached(runIdA)
    expect(cardA.dataset.streamAttached).toBe('true')

    markRunStreamAttached(runIdB)
    // A must be cleared
    expect(cardA.dataset.streamAttached).toBeUndefined()
    // B must be marked
    expect(cardB.dataset.streamAttached).toBe('true')
  })

  it('after A → B, clicking A calls onSelectRun (A is no longer suppressed)', async () => {
    const onSelectRun = vi.fn()
    const runIdA = 'run-lifecycle-click-A'
    const runIdB = 'run-lifecycle-click-B'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [makeValidSummary({runId: runIdA}), makeValidSummary({runId: runIdB})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    const cardA = cards.find(c => c.dataset.runId === runIdA)

    markRunStreamAttached(runIdA)
    markRunStreamAttached(runIdB)

    // A is no longer the active stream — clicking it must call onSelectRun
    cardA.dispatchEvent({type: 'click'})
    expect(onSelectRun).toHaveBeenCalledWith(runIdA)
  })

  it('after A → B, Enter on A calls onSelectRun (A is no longer suppressed)', async () => {
    const onSelectRun = vi.fn()
    const runIdA = 'run-lifecycle-kbd-A'
    const runIdB = 'run-lifecycle-kbd-B'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [makeValidSummary({runId: runIdA}), makeValidSummary({runId: runIdB})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    const cardA = cards.find(c => c.dataset.runId === runIdA)

    markRunStreamAttached(runIdA)
    markRunStreamAttached(runIdB)

    cardA.dispatchEvent({type: 'keydown', key: 'Enter', preventDefault: vi.fn()})
    expect(onSelectRun).toHaveBeenCalledWith(runIdA)
  })

  it('B remains suppressed after A → B transition', async () => {
    const onSelectRun = vi.fn()
    const runIdA = 'run-lifecycle-suppress-A'
    const runIdB = 'run-lifecycle-suppress-B'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [makeValidSummary({runId: runIdA}), makeValidSummary({runId: runIdB})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    const cardB = cards.find(c => c.dataset.runId === runIdB)

    markRunStreamAttached(runIdA)
    markRunStreamAttached(runIdB)

    cardB.dispatchEvent({type: 'click'})
    expect(onSelectRun).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// markRunStreamAttached — card DOM attribute
// ---------------------------------------------------------------------------

describe('markRunStreamAttached — sets data-stream-attached on matching card', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('sets data-stream-attached="true" on the card after markRunStreamAttached', async () => {
    const runId = 'run-stream-attr-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})
    expect(cards).toHaveLength(1)

    markRunStreamAttached(runId)

    expect(cards[0].dataset.streamAttached).toBe('true')
  })

  it('resetRunIndexState clears data-stream-attached from cards remaining in DOM', async () => {
    const runId = 'run-stream-reset-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})
    markRunStreamAttached(runId)
    expect(cards[0].dataset.streamAttached).toBe('true')

    resetRunIndexState()

    expect(cards[0].dataset.streamAttached).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Keyboard activation on run cards
// ---------------------------------------------------------------------------

/** Minimal element stub with event dispatch. */
function makeElStub() {
  return {
    _listeners: {},
    className: '', tabIndex: 0, dataset: {}, textContent: '',
    setAttribute() {}, append() {},
    addEventListener(type, fn) {
      this._listeners[type] = this._listeners[type] ?? []
      this._listeners[type].push(fn)
    },
    dispatchEvent(event) {
      const fns = this._listeners[event.type] ?? []
      for (const fn of fns) fn(event)
    },
  }
}

/** Stub document + CSS globals, collect appended cards, return teardown. */
function stubDOMWithCards(cards) {
  const mockList = {
    hidden: true,
    textContent: '',
    append(el) { cards.push(el) },
  }
  const mockSection = {dataset: {}}
  vi.stubGlobal('CSS', {escape: s => s})
  vi.stubGlobal('document', {
    querySelector(sel) {
      if (sel === '[data-role="run-index-list"]') return mockList
      if (sel === '[data-role="run-index"]') return mockSection
      const runIdMatch = sel.match(/^\[data-run-id="([^"]+)"\]$/)
      if (runIdMatch) return cards.find(c => c.dataset.runId === runIdMatch[1]) ?? null
      return null
    },
    createElement() { return makeElStub() },
  })
}

describe('renderRunCard — keyboard activation (Enter / Space)', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('operator-run-index.js source wires keydown to onSelectRun', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).toContain('keydown')
  })

  it('Enter key calls onSelectRun(runId)', async () => {
    const onSelectRun = vi.fn()
    const runId = 'run-kbd-enter-001'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    expect(cards).toHaveLength(1)
    cards[0].dispatchEvent({type: 'keydown', key: 'Enter', preventDefault: vi.fn()})

    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(onSelectRun).toHaveBeenCalledWith(runId)
  })

  it('Space key calls onSelectRun(runId) and calls preventDefault', async () => {
    const onSelectRun = vi.fn()
    const runId = 'run-kbd-space-001'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    const spaceEvent = {type: 'keydown', key: ' ', preventDefault: vi.fn()}
    cards[0].dispatchEvent(spaceEvent)

    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(onSelectRun).toHaveBeenCalledWith(runId)
    expect(spaceEvent.preventDefault).toHaveBeenCalled()
  })

  it('other keys (ArrowDown, Tab, a) do not call onSelectRun', async () => {
    const onSelectRun = vi.fn()
    const runId = 'run-kbd-other-001'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    for (const key of ['ArrowDown', 'Tab', 'a', 'Escape']) {
      cards[0].dispatchEvent({type: 'keydown', key, preventDefault: vi.fn()})
    }

    expect(onSelectRun).not.toHaveBeenCalled()
  })

  it('Enter key does not call onSelectRun when runId is stream-attached', async () => {
    const onSelectRun = vi.fn()
    const runId = 'run-kbd-attached-001'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    markRunStreamAttached(runId)

    cards[0].dispatchEvent({type: 'keydown', key: 'Enter', preventDefault: vi.fn()})

    expect(onSelectRun).not.toHaveBeenCalled()
  })

  it('Space key does not call onSelectRun when runId is stream-attached', async () => {
    const onSelectRun = vi.fn()
    const runId = 'run-kbd-attached-space-001'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    markRunStreamAttached(runId)

    const spaceEvent = {type: 'keydown', key: ' ', preventDefault: vi.fn()}
    cards[0].dispatchEvent(spaceEvent)

    expect(onSelectRun).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// fetchRunIndex — AbortSignal / timeout
// ---------------------------------------------------------------------------

describe('fetchRunIndex — passes AbortSignal to fetch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('passes a signal property in fetch options', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: []}),
    })
    vi.stubGlobal('fetch', mockFetch)
    await fetchRunIndex({endpointBase: '/operator'})
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts).toHaveProperty('signal')
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('preserves credentials:include and redirect:error alongside signal', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: []}),
    })
    vi.stubGlobal('fetch', mockFetch)
    await fetchRunIndex({endpointBase: '/operator'})
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.credentials).toBe('include')
    expect(opts.redirect).toBe('error')
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('FETCH_TIMEOUT_MS is exported and equals 10_000', () => {
    expect(FETCH_TIMEOUT_MS).toBe(10_000)
  })

  it('AbortError from fetch collapses to unavailable', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError))
    const result = await fetchRunIndex({endpointBase: '/operator'})
    expect(result.kind).toBe('unavailable')
  })

  it('timeout fires and fetch rejection collapses to unavailable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        // Simulate abort signal listener
        opts.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }))

    const fetchPromise = fetchRunIndex({endpointBase: '/operator'})
    // Advance past the timeout
    vi.advanceTimersByTime(FETCH_TIMEOUT_MS + 1)
    const result = await fetchPromise
    expect(result.kind).toBe('unavailable')
  })

  it('does not log on timeout/AbortError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError))
    await fetchRunIndex({endpointBase: '/operator'})
    expect(vi.mocked(console.error).mock.calls).toHaveLength(0)
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// section data-state transitions
// ---------------------------------------------------------------------------

/** Stub document with all four run-index roles + section, collect state snapshots. */
function stubDOMWithSection() {
  const section = {dataset: {}}
  const loading = {hidden: false}
  const list = {hidden: true, textContent: '', append() {}}
  const empty = {hidden: true}
  const unavailable = {hidden: true}
  const cards = []

  vi.stubGlobal('CSS', {escape: s => s})
  vi.stubGlobal('document', {
    querySelector(sel) {
      if (sel === '[data-role="run-index"]') return section
      if (sel === '[data-role="run-index-loading"]') return loading
      if (sel === '[data-role="run-index-list"]') return list
      if (sel === '[data-role="run-index-empty"]') return empty
      if (sel === '[data-role="run-index-unavailable"]') return unavailable
      const runIdMatch = sel.match(/^\[data-run-id="([^"]+)"\]$/)
      if (runIdMatch) return cards.find(c => c.dataset?.runId === runIdMatch[1]) ?? null
      return null
    },
    createElement() {
      return makeElStub()
    },
  })

  return {section, loading, list, empty, unavailable, cards}
}

describe('initOperatorRunIndex — section data-state transitions', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('sets data-state="loading" on section before fetch resolves', async () => {
    let resolveJson
    const jsonPromise = new Promise(res => {
      resolveJson = res
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => jsonPromise,
    }))
    const {section} = stubDOMWithSection()

    const initPromise = initOperatorRunIndex({endpointBase: '/operator'})
    // Before fetch resolves, state must be 'loading'
    expect(section.dataset.state).toBe('loading')

    resolveJson({runs: [makeValidSummary()]})
    await initPromise
  })

  it('sets data-state="loaded" on section when list has runs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: [makeValidSummary()]}),
    }))
    const {section} = stubDOMWithSection()

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(section.dataset.state).toBe('loaded')
  })

  it('sets data-state="empty" on section when list is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: []}),
    }))
    const {section} = stubDOMWithSection()

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(section.dataset.state).toBe('empty')
  })

  it('sets data-state="unavailable" on section on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const {section} = stubDOMWithSection()

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(section.dataset.state).toBe('unavailable')
  })

  it('sets data-state="unavailable" on section on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }))
    const {section} = stubDOMWithSection()

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(section.dataset.state).toBe('unavailable')
  })
})
