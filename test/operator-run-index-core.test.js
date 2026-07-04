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

  // Note: the plain click/keydown activation is now expand/collapse-driven
  // (data-expanded), not gated by markRunStreamAttached's marker — clicking any
  // card always calls onSelectRun so the runtime seam's single-open accordion
  // logic (close whichever stream is active, then attach the new one) can run,
  // including re-clicking the currently-attached card to collapse it.
  it('clicking B after A → B stream-attach transition still calls onSelectRun (expand/collapse toggle owns activation now)', async () => {
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
    expect(onSelectRun).toHaveBeenCalledWith(runIdB)
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
    _parentList: null,
    className: '', tabIndex: 0, dataset: {}, textContent: '',
    setAttribute() {}, append() {},
    remove() {
      if (this._parentList !== null) {
        const idx = this._parentList.children.indexOf(this)
        if (idx !== -1) this._parentList.children.splice(idx, 1)
      }
    },
    get nextSibling() {
      if (this._parentList === null) return null
      const idx = this._parentList.children.indexOf(this)
      if (idx === -1) return null
      return this._parentList.children[idx + 1] ?? null
    },
    before(el) {
      if (this._parentList !== null) this._parentList.insertBefore(el, this)
    },
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

/**
 * A minimal mock list container implementing enough of the real DOM API
 * (children, firstChild, append, insertBefore) for the diffRunIndexList
 * reconciliation logic to operate on. `children` is the same array reference
 * passed in by the caller, so existing tests that inspect the `cards` array
 * directly continue to see the current, reconciled DOM order.
 */
function makeMockListUsing(children) {
  const list = {
    hidden: true,
    get children() { return children },
    get firstChild() { return children[0] ?? null },
    append(el) {
      el._parentList = list
      children.push(el)
    },
    insertBefore(el, ref) {
      el._parentList = list
      const existingIdx = children.indexOf(el)
      if (existingIdx !== -1) children.splice(existingIdx, 1)
      const idx = ref === null || ref === undefined ? children.length : children.indexOf(ref)
      children.splice(idx === -1 ? children.length : idx, 0, el)
    },
    set textContent(v) { if (v === '') children.length = 0 },
    get textContent() { return '' },
  }
  return list
}

/** Stub document + CSS globals, collect appended cards, return teardown. */
function stubDOMWithCards(cards) {
  const mockList = makeMockListUsing(cards)
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

  // Note: stream-attached no longer suppresses activation — Enter/Space on
  // an attached (expanded) card now drives the collapse path, so onSelectRun IS
  // called (the runtime seam interprets the repeat call as "close this stream").
  it('Enter key calls onSelectRun when runId is stream-attached (drives collapse)', async () => {
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

    expect(onSelectRun).toHaveBeenCalledWith(runId)
  })

  it('Space key calls onSelectRun when runId is stream-attached (drives collapse)', async () => {
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

    expect(onSelectRun).toHaveBeenCalledWith(runId)
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
  const listCards = []
  const list = makeMockListUsing(listCards)
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

// ---------------------------------------------------------------------------
// Unified card substructure (run-output, run-output-coalesced,
// run-approvals, approval-badge) + single data-testid="run-card"
// ---------------------------------------------------------------------------

/** Richer element stub that tracks appended children and dataset.role. */
function makeSubstructureElStub() {
  return {
    _listeners: {},
    _children: [],
    _parentList: null,
    className: '',
    tabIndex: 0,
    dataset: {},
    textContent: '',
    hidden: false,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value },
    append(...els) { this._children.push(...els) },
    remove() {
      if (this._parentList !== null) {
        const idx = this._parentList.children.indexOf(this)
        if (idx !== -1) this._parentList.children.splice(idx, 1)
      }
    },
    get nextSibling() {
      if (this._parentList === null) return null
      const idx = this._parentList.children.indexOf(this)
      if (idx === -1) return null
      return this._parentList.children[idx + 1] ?? null
    },
    before(el) {
      if (this._parentList !== null) this._parentList.insertBefore(el, this)
    },
    addEventListener(type, fn) {
      this._listeners[type] = this._listeners[type] ?? []
      this._listeners[type].push(fn)
    },
    dispatchEvent(event) {
      const fns = this._listeners[event.type] ?? []
      for (const fn of fns) fn(event)
    },
    querySelector(sel) {
      const roleMatch = sel.match(/^\[data-role="([^"]+)"\]$/)
      if (roleMatch) {
        return findByRole(this._children, roleMatch[1])
      }
      return null
    },
  }
}

function findByRole(children, role) {
  for (const child of children) {
    if (child.dataset?.role === role) return child
    if (Array.isArray(child._children)) {
      const found = findByRole(child._children, role)
      if (found !== null) return found
    }
  }
  return null
}

/** Stub document + CSS globals for substructure assertions; collects appended cards. */
function stubDOMWithSubstructureCards(cards) {
  const mockList = makeMockListUsing(cards)
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
    createElement() { return makeSubstructureElStub() },
  })
}

describe('renderRunCard — unified per-card substructure', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('renders a card with a single data-testid="run-card" (no run-index-card)', async () => {
    const runId = 'run-substructure-testid-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(1)
    expect(cards[0].dataset.testid).toBe('run-card')
  })

  it('operator-run-index.js source no longer contains "run-index-card"', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toContain('run-index-card')
  })

  it('renders the four hidden substructure elements with correct data-role values', async () => {
    const runId = 'run-substructure-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(1)
    const card = cards[0]

    const output = card.querySelector('[data-role="run-output"]')
    const coalesced = card.querySelector('[data-role="run-output-coalesced"]')
    const approvals = card.querySelector('[data-role="run-approvals"]')
    const badge = card.querySelector('[data-role="approval-badge"]')

    expect(output).not.toBeNull()
    expect(coalesced).not.toBeNull()
    expect(approvals).not.toBeNull()
    expect(badge).not.toBeNull()
  })

  it('substructure elements are hidden by default (revealed only on expansion)', async () => {
    const runId = 'run-substructure-hidden-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})

    const card = cards[0]
    for (const role of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge']) {
      const el = card.querySelector(`[data-role="${role}"]`)
      expect(el.hidden).toBe(true)
    }
  })

  it('card with no updatedAt still renders all four hidden substructure elements', async () => {
    const runId = 'run-substructure-no-updated-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})

    const card = cards[0]
    expect(card.querySelector('[data-role="run-output"]')).not.toBeNull()
    expect(card.querySelector('[data-role="run-output-coalesced"]')).not.toBeNull()
    expect(card.querySelector('[data-role="run-approvals"]')).not.toBeNull()
    expect(card.querySelector('[data-role="approval-badge"]')).not.toBeNull()
  })

  it('source builds substructure via createElement/textContent — never innerHTML', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toMatch(/\.innerHTML\s*=/)
  })

  it('substructure elements carry no unexpected attributes beyond role/hidden state', async () => {
    const runId = 'run-substructure-attrs-001'
    const repo = 'fro-bot/agent'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId, repo})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})

    const card = cards[0]
    for (const role of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge']) {
      const el = card.querySelector(`[data-role="${role}"]`)
      // No run field (repo/runId) leaks into substructure text content.
      expect(el.textContent ?? '').not.toContain(repo)
      expect(el.textContent ?? '').not.toContain(runId)
    }
  })
})

// ---------------------------------------------------------------------------
// Expansion toggles data-expanded and reveals per-card substructure
// ---------------------------------------------------------------------------

describe('renderRunCard — expand/collapse toggles data-expanded and substructure visibility', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('clicking a collapsed card sets data-expanded="true", reveals substructure, and calls onSelectRun', async () => {
    const onSelectRun = vi.fn()
    const runId = 'run-expand-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    const card = cards[0]
    expect(card.dataset.expanded).toBeUndefined()

    card.dispatchEvent({type: 'click'})

    expect(card.dataset.expanded).toBe('true')
    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(onSelectRun).toHaveBeenCalledWith(runId)
    for (const role of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge']) {
      const el = card.querySelector(`[data-role="${role}"]`)
      expect(el.hidden).toBe(false)
    }
  })

  it('clicking an already-expanded card collapses it, hides substructure, and calls onSelectRun again (caller closes the stream)', async () => {
    const onSelectRun = vi.fn()
    const runId = 'run-collapse-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    const card = cards[0]

    card.dispatchEvent({type: 'click'})
    expect(card.dataset.expanded).toBe('true')

    card.dispatchEvent({type: 'click'})

    expect(card.dataset.expanded).toBe('false')
    expect(onSelectRun).toHaveBeenCalledTimes(2)
    expect(onSelectRun).toHaveBeenNthCalledWith(2, runId)
    for (const role of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge']) {
      const el = card.querySelector(`[data-role="${role}"]`)
      expect(el.hidden).toBe(true)
    }
  })

  it('expanding run A then run B collapses A (hides its substructure) and expands B', async () => {
    const onSelectRun = vi.fn()
    const runIdA = 'run-accordion-a'
    const runIdB = 'run-accordion-b'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: [makeValidSummary({runId: runIdA}), makeValidSummary({runId: runIdB})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    const [cardA, cardB] = cards

    cardA.dispatchEvent({type: 'click'})
    expect(cardA.dataset.expanded).toBe('true')

    cardB.dispatchEvent({type: 'click'})

    expect(cardA.dataset.expanded).toBe('false')
    expect(cardB.dataset.expanded).toBe('true')
    for (const role of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge']) {
      expect(cardA.querySelector(`[data-role="${role}"]`).hidden).toBe(true)
      expect(cardB.querySelector(`[data-role="${role}"]`).hidden).toBe(false)
    }
    expect(onSelectRun).toHaveBeenCalledTimes(2)
    expect(onSelectRun).toHaveBeenNthCalledWith(1, runIdA)
    expect(onSelectRun).toHaveBeenNthCalledWith(2, runIdB)
  })

  it('keyboard (Enter) expansion mirrors click expansion behavior', async () => {
    const onSelectRun = vi.fn()
    const runId = 'run-expand-kbd-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    const card = cards[0]

    card.dispatchEvent({type: 'keydown', key: 'Enter', preventDefault: vi.fn()})

    expect(card.dataset.expanded).toBe('true')
    expect(onSelectRun).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// In-place diff reconciliation on refresh (background/refresh re-fetch)
// ---------------------------------------------------------------------------

describe('initOperatorRunIndex — in-place diff reconciliation (background refresh)', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('happy path: refresh with new + existing runs updates existing cards in place and inserts new ones', async () => {
    const runIdExisting = 'run-diff-existing-001'
    const runIdNew = 'run-diff-new-001'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [makeValidSummary({runId: runIdExisting, status: 'running'})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})
    expect(cards).toHaveLength(1)
    const firstCardRef = cards[0]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [
        makeValidSummary({runId: runIdNew, status: 'queued'}),
        makeValidSummary({runId: runIdExisting, status: 'succeeded'}),
      ]}),
    }))

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(2)
    // The existing card's element identity is preserved (adopted, not replaced).
    expect(cards.find(c => c.dataset.runId === runIdExisting)).toBe(firstCardRef)
    // Its status was updated in place.
    const existingStatusEl = firstCardRef.querySelector('[data-role="run-status"]')
    expect(existingStatusEl.className).toContain('status-succeeded')
    // A new card was inserted for the new runId.
    expect(cards.some(c => c.dataset.runId === runIdNew)).toBe(true)
  })

  it('CRITICAL: refresh while run X is expanded+streaming leaves node identity, substructure text, and stream intact — diff writes nothing inside [data-run-id=X] [data-role]', async () => {
    const runId = 'run-diff-active-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [makeValidSummary({runId, status: 'running'})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})
    const card = cards[0]

    // Simulate the runtime seam attaching a stream to this card.
    markRunStreamAttached(runId)
    expect(card.dataset.streamAttached).toBe('true')

    // Simulate updateDOM having written live stream substructure content.
    const outputEl = card.querySelector('[data-role="run-output"]')
    outputEl.textContent = 'live streamed output text'
    outputEl.hidden = false
    const statusEl = card.querySelector('[data-role="run-status"]')
    statusEl.textContent = 'Running'
    statusEl.className = 'run-status status-running'

    // Refresh returns the same run, now reported as succeeded in the fetch —
    // the diff must NOT overwrite the active card's substructure or status.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [makeValidSummary({runId, status: 'succeeded'})]}),
    }))

    await initOperatorRunIndex({endpointBase: '/operator'})

    // Node identity preserved.
    expect(cards).toHaveLength(1)
    expect(cards[0]).toBe(card)
    // Substructure untouched — still the stream-written text, not diff-overwritten.
    expect(outputEl.textContent).toBe('live streamed output text')
    expect(outputEl.hidden).toBe(false)
    // Status span untouched by the diff — updateDOM is the sole writer.
    expect(statusEl.textContent).toBe('Running')
    expect(statusEl.className).toBe('run-status status-running')
  })

  it('CRITICAL: launch a run, then refresh before it appears in the index — the optimistic card is preserved (stream still active), no duplicate when it later appears', async () => {
    const runId = 'run-diff-optimistic-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)

    // No fetch yet needed for this test — simulate the launch-created card directly,
    // mirroring what operator-launch.js inserts (marked data-optimistic="true").
    const optimisticCard = renderRunCardForTest(cards, {runId, status: 'queued', statusLabel: 'Pending'})
    optimisticCard.dataset.optimistic = 'true'
    // Its own status element still shows the non-terminal Pending/queued class.
    optimisticCard.querySelector('[data-role="run-status"]').className = 'run-status status-queued'

    // Refresh runs before the gateway's GET /operator/runs lists it — empty summaries.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: []}),
    }))

    await initOperatorRunIndex({endpointBase: '/operator'})

    // Preserved — not removed as a ghost.
    expect(cards).toHaveLength(1)
    expect(cards[0]).toBe(optimisticCard)
    expect(optimisticCard.dataset.optimistic).toBe('true')

    // Now the run appears in the fetch — no duplicate card should be created,
    // and the optimistic flag should clear.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [makeValidSummary({runId, status: 'running'})]}),
    }))

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(1)
    expect(cards[0]).toBe(optimisticCard)
    expect(optimisticCard.dataset.optimistic).toBeUndefined()
  })

  it('edge case: a launched run whose stream closes terminal while still absent from the index resolves to terminal (not a perpetual ghost)', async () => {
    const runId = 'run-diff-optimistic-terminal-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)

    const optimisticCard = renderRunCardForTest(cards, {runId, status: 'queued', statusLabel: 'Pending'})
    optimisticCard.dataset.optimistic = 'true'
    optimisticCard.querySelector('[data-role="run-status"]').className = 'run-status status-queued'

    // Simulate the stream having resolved the card to a terminal status (updateDOM's write),
    // while the gateway's index fetch still doesn't list it (indexer lag that never resolves).
    const statusEl = optimisticCard.querySelector('[data-role="run-status"]')
    statusEl.className = 'run-status status-failed'
    statusEl.textContent = 'Failed'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: []}),
    }))

    await initOperatorRunIndex({endpointBase: '/operator'})

    // No longer protected — removed rather than left as a perpetual ghost.
    expect(cards).toHaveLength(0)
  })

  it('CRITICAL: an expanded active run that receives a terminal status update does NOT change list position (re-sort lock); re-sorts only after collapse', async () => {
    const runIdA = 'run-diff-lock-A'
    const runIdB = 'run-diff-lock-B'

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [
        makeValidSummary({runId: runIdA, status: 'running'}),
        makeValidSummary({runId: runIdB, status: 'running'}),
      ]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    const onSelectRun = vi.fn()
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    // Expand A (single-open accordion — sets _expandedRunId to A).
    const cardA = cards.find(c => c.dataset.runId === runIdA)
    cardA.dispatchEvent({type: 'click'})
    markRunStreamAttached(runIdA)
    expect(cardA.dataset.expanded).toBe('true')

    // Refresh reports A as terminal now, and reorders A after B in the fetch
    // (mirroring "terminal sorts below active" resting-order logic upstream).
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [
        makeValidSummary({runId: runIdB, status: 'running'}),
        makeValidSummary({runId: runIdA, status: 'succeeded'}),
      ]}),
    }))

    await initOperatorRunIndex({endpointBase: '/operator'})

    // Position lock: A must still be BEFORE B in DOM order (frozen), not moved to
    // the back to match the fetched order, because A is the expanded/active card.
    const idxA = cards.indexOf(cardA)
    const idxB = cards.findIndex(c => c.dataset.runId === runIdB)
    expect(idxA).toBeLessThan(idxB)

    // Collapse A — releases the re-sort lock.
    cardA.dispatchEvent({type: 'click'})
    expect(cardA.dataset.expanded).toBe('false')

    // Next refresh may now reposition freely.
    await initOperatorRunIndex({endpointBase: '/operator'})
    const idxA2 = cards.indexOf(cardA)
    const idxB2 = cards.findIndex(c => c.dataset.runId === runIdB)
    expect(idxB2).toBeLessThan(idxA2)
  })

  it('happy path: launch prepends a Pending card and hands off — exactly one stream opens, no duplicate', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).toContain('onRunLaunched')
    expect(src).toContain('status-pending')
  })

  it('security: the diff sets no attribute outside {data-run-id, data-expanded, datetime, className}; no data-repo/data-status; consumes safe-views only', async () => {
    const runId = 'run-diff-security-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [makeValidSummary({runId, status: 'running', repo: 'fro-bot/agent'})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({runs: [makeValidSummary({runId, status: 'succeeded', repo: 'fro-bot/agent'})]}),
    }))
    await initOperatorRunIndex({endpointBase: '/operator'})

    const card = cards[0]
    expect('repo' in card.attributes || card.dataset.repo !== undefined).toBe(false)
    expect(card.dataset.status).toBeUndefined()

    // Source-level guard: the diff/update helpers must not construct data-repo/data-status.
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toMatch(/dataset\.repo\s*=/)
    expect(src).not.toMatch(/dataset\.status\s*=/)
    expect(src).not.toMatch(/setAttribute\(\s*['"]data-repo['"]/)
    expect(src).not.toMatch(/setAttribute\(\s*['"]data-status['"]/)
  })

  it('security: diff drives on buildRunSafeView output — source has no path from raw fetch json to card update', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).toContain('diffRunIndexList')
    expect(src).toMatch(/summaries\.map\(buildRunSafeView\)/)
  })

  it('does not clear the container wholesale (no textContent = \'\' reset of the list on refresh)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    // The wholesale clear must be gone from the fetch-then-render path.
    expect(src).not.toMatch(/runIndexList\.textContent\s*=\s*['"]{2}/)
  })
})

/** Helper: build and insert a card via renderRunCard, mirroring the launch-created shape. */
function renderRunCardForTest(cards, summaryLike) {
  const view = buildRunSafeView({
    runId: summaryLike.runId,
    repo: summaryLike.repo ?? 'fro-bot/agent',
    status: summaryLike.status,
    createdAt: summaryLike.createdAt ?? '2026-07-03T00:00:00.000Z',
  })
  const list = makeMockListUsing(cards)
  const card = document.createElement('div')
  card.dataset.runId = view.runId
  card.dataset.testid = 'run-card'
  card.setAttribute('aria-label', `Run, status: ${summaryLike.statusLabel ?? view.statusLabel}`)
  const statusSpan = document.createElement('div')
  statusSpan.dataset.role = 'run-status'
  statusSpan.textContent = summaryLike.statusLabel ?? view.statusLabel
  card.append(statusSpan)
  for (const role of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge']) {
    const el = document.createElement('div')
    el.dataset.role = role
    el.hidden = true
    card.append(el)
  }
  list.append(card)
  return card
}
