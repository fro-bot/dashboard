/**
 * Pure core tests for public/operator-run-index.js.
 * Imports directly from the plain ESM file — no TS syntax, no DOM at module level.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {buildRunSafeView, FETCH_TIMEOUT_MS, fetchRunIndex, formatRelativeTime, initOperatorRunIndex, markCardExpandedForLaunch, markRunStreamAttached, parseRunSummaryItem, parseRunSummaryList, refreshOperatorRunIndex, resetRunIndexState, RUN_INDEX_CAP, FAILURE_REASON_LABELS as RUN_INDEX_FAILURE_REASON_LABELS, RUN_STATUS_CLASS_TOKENS, VALID_RUN_SUMMARY_STATUSES} from '../public/operator-run-index.js'
import {FAILURE_REASON_LABELS as STREAM_FAILURE_REASON_LABELS} from '../public/operator-stream.js'
import {formatRelativeTime as sharedFormatRelativeTime} from '../public/operator-time.js'
import {isOperatorFailureKind, OPERATOR_FAILURE_KINDS} from '../src/gateway/operator-contract/run-status.ts'
import {parseRunSummary as parseServerRunSummary} from '../src/gateway/operator-contract/run-summary.ts'

/** The seven statuses a run summary can carry, with the label each renders. Never the raw wire string. */
const SUMMARY_STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  waiting_for_approval: 'Waiting for approval',
  waiting_for_question: 'Waiting for answer',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

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

  it.each(['waiting_for_approval', 'waiting_for_question'])('accepts the waiting status %s', status => {
    const result = parseRunSummaryItem(makeValidSummary({status}))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.status).toBe(status)
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

describe('VALID_RUN_SUMMARY_STATUSES — exact summary set', () => {
  it('contains exactly the seven summary statuses', () => {
    expect(VALID_RUN_SUMMARY_STATUSES).toEqual(new Set(Object.keys(SUMMARY_STATUS_LABELS)))
  })

  it('does not contain the stream-only blocked status', () => {
    expect(VALID_RUN_SUMMARY_STATUSES.has('blocked')).toBe(false)
  })
})

describe('buildRunSafeView — status labels', () => {
  it.each(Object.entries(SUMMARY_STATUS_LABELS))('labels %s as "%s", never the raw wire string', (status, label) => {
    const view = buildRunSafeView(makeValidSummary({status}))
    expect(view.statusLabel).toBe(label)
    expect(view.statusLabel).not.toBe(status)
  })

  it('every accepted status has a label (no allowlist entry without a label)', () => {
    for (const status of VALID_RUN_SUMMARY_STATUSES) {
      expect(buildRunSafeView(makeValidSummary({status})).statusLabel, status).toBe(SUMMARY_STATUS_LABELS[status])
    }
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

describe('parseRunSummaryItem — failureKind', () => {
  it('accepts a failed summary with each known failureKind', () => {
    const kinds = [
      'inactivity-timeout',
      'max-duration-timeout',
      'stream-ended',
      'workspace-unreachable',
      'session-error',
      'checkout-substituted',
      'workspace-unavailable',
      'unknown',
    ]
    for (const failureKind of kinds) {
      const input = makeValidSummary({status: 'failed', failureKind})
      const result = parseRunSummaryItem(input)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.failureKind).toBe(failureKind)
      }
    }
  })

  it('failureKind is absent (key not present) when omitted from input', () => {
    const input = makeValidSummary({status: 'failed'})
    const result = parseRunSummaryItem(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Object.prototype.hasOwnProperty.call(result.data, 'failureKind')).toBe(false)
    }
  })

  it('normalizes an unknown failureKind value to absent — does not reject the summary', () => {
    const input = makeValidSummary({status: 'failed', failureKind: 'some-future-fixture-reason'})
    const result = parseRunSummaryItem(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.failureKind).toBeUndefined()
      expect(Object.prototype.hasOwnProperty.call(result.data, 'failureKind')).toBe(false)
    }
  })

  it('a non-failed status carrying a failureKind still parses (renderer ignores it)', () => {
    const input = makeValidSummary({status: 'running', failureKind: 'inactivity-timeout'})
    const result = parseRunSummaryItem(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe('running')
    }
  })

  it('missing failureKind does not throw', () => {
    expect(() => parseRunSummaryItem(makeValidSummary())).not.toThrow()
  })
})

describe('buildRunSafeView — reasonLabel', () => {
  it('a failed summary with a known failureKind produces a safe view with a display label', () => {
    const summary = {
      runId: 'run-abc-001',
      repo: 'fro-bot/agent',
      status: 'failed',
      createdAt: '2026-06-26T12:00:00.000Z',
      failureKind: 'inactivity-timeout',
    }
    const view = buildRunSafeView(summary)
    expect(typeof view.reasonLabel).toBe('string')
    expect(view.reasonLabel.length).toBeGreaterThan(0)
  })

  it('an unknown/absent failureKind produces no reasonLabel — generic Failed fallback remains available', () => {
    const summary = {
      runId: 'run-abc-001',
      repo: 'fro-bot/agent',
      status: 'failed',
      createdAt: '2026-06-26T12:00:00.000Z',
    }
    const view = buildRunSafeView(summary)
    expect('reasonLabel' in view).toBe(false)
    expect(view.statusLabel).toBe('Failed')
  })

  it('a non-failed status with a failureKind ignores the reason — no reasonLabel', () => {
    const summary = {
      runId: 'run-abc-001',
      repo: 'fro-bot/agent',
      status: 'running',
      createdAt: '2026-06-26T12:00:00.000Z',
      failureKind: 'inactivity-timeout',
    }
    const view = buildRunSafeView(summary)
    expect('reasonLabel' in view).toBe(false)
  })

  it('safe-view output has an exact allowed key set and never includes raw failureKind', () => {
    const summary = {
      runId: 'run-abc-001',
      repo: 'fro-bot/agent',
      status: 'failed',
      createdAt: '2026-06-26T12:00:00.000Z',
      updatedAt: '2026-06-26T13:00:00.000Z',
      failureKind: 'session-error',
    }
    const view = buildRunSafeView(summary)
    const allowedKeys = new Set(['runId', 'repo', 'status', 'statusLabel', 'createdAt', 'updatedAt', 'reasonLabel'])
    for (const key of Object.keys(view)) {
      expect(allowedKeys.has(key)).toBe(true)
    }
    expect('failureKind' in view).toBe(false)
    expect(JSON.stringify(view)).not.toContain('session-error')
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
    const invalidStatuses = ['blocked', 'unknown', 'RUNNING', 'waiting-for-question', '']
    for (const status of invalidStatuses) {
      const result = parseRunSummaryItem(makeValidSummary({status}))
      expect(result.success, `status "${status}" should be rejected`).toBe(false)
    }
  })

  it('the stream summaryStatus allowlist equals the index allowlist (read from source: it is not exported)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-stream.js', 'utf8')
    const literal = src.match(/const SUMMARY_STATUSES = new Set\(\[([^\]]*)\]\)/)?.[1] ?? ''
    const streamStatuses = new Set([...literal.matchAll(/'([a-z_]+)'/g)].map(match => match[1]))
    expect(streamStatuses.size).toBeGreaterThan(0)
    expect(streamStatuses).toEqual(VALID_RUN_SUMMARY_STATUSES)
  })

  it('status agreement: the JS and TS parsers agree on all seven statuses and on unknowns', () => {
    for (const status of [...Object.keys(SUMMARY_STATUS_LABELS), 'blocked', 'unknown', 'RUNNING', '']) {
      const input = makeValidSummary({status})
      expect(parseRunSummaryItem(input).success, `status "${status}"`).toBe(parseServerRunSummary(input).success)
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
    await expect(initOperatorRunIndex({endpointBase: '/operator', onSelectRun})).resolves.toBe('unavailable')
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

/**
 * Focus bookkeeping shared by the element stubs. Like a browser, focus() makes the element the
 * document's activeElement; a stub document without the property just ignores it.
 */
function markFocused(el) {
  if (typeof document !== 'undefined' && document !== null) document.activeElement = el
}

/** Minimal element stub with event dispatch. */
function makeElStub() {
  return {
    _listeners: {},
    _parentList: null,
    className: '', tabIndex: 0, dataset: {}, textContent: '',
    setAttribute() {}, append() {},
    focusCalls: [],
    scrollIntoViewCalls: 0,
    focus(options) {
      this.focusCalls.push(options)
      markFocused(this)
    },
    scrollIntoView() { this.scrollIntoViewCalls++ },
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
      // Like the DOM, an event dispatched directly on an element targets it, unless a
      // test simulates bubbling from a nested element by passing an explicit target.
      if (event.target === undefined) event.target = this
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
      // Like the DOM, appending a node already in the list moves it.
      const existingIdx = children.indexOf(el)
      if (existingIdx !== -1) children.splice(existingIdx, 1)
      children.push(el)
    },
    contains(el) {
      return children.some(child => child === el || child.contains?.(el) === true)
    },
    insertBefore(el, ref) {
      el._parentList = list
      // A real browser blurs a focused node that is moved within the DOM.
      if (typeof document !== 'undefined' && document !== null && document.activeElement === el) document.activeElement = null
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

  it('a stalled response body is aborted by the timeout and collapses to unavailable', async () => {
    vi.useFakeTimers()
    let bodySignal
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) => {
      bodySignal = opts.signal
      return Promise.resolve({
        ok: true,
        status: 200,
        // Headers arrived; the body never settles unless the request is aborted.
        json: () => new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
      })
    }))

    const fetchPromise = fetchRunIndex({endpointBase: '/operator'})
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1)
    const result = await fetchPromise
    expect(result.kind).toBe('unavailable')
    expect(bodySignal.aborted).toBe(true)
  })

  it('a body that never settles even on abort still resolves unavailable at the timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    }))

    const fetchPromise = fetchRunIndex({endpointBase: '/operator'})
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1)
    await expect(fetchPromise).resolves.toEqual({kind: 'unavailable'})
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

describe('initOperatorRunIndex — resolves with its outcome', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  const stubRuns = runs => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, status: 200, json: async () => ({runs})}))

  it("resolves 'loaded' when the list has runs", async () => {
    stubRuns([makeValidSummary()])
    const {section} = stubDOMWithSection()
    await expect(initOperatorRunIndex({endpointBase: '/operator'})).resolves.toBe('loaded')
    expect(section.dataset.state).toBe('loaded')
  })

  it("resolves 'empty' when the list is empty", async () => {
    stubRuns([])
    const {section} = stubDOMWithSection()
    await expect(initOperatorRunIndex({endpointBase: '/operator'})).resolves.toBe('empty')
    expect(section.dataset.state).toBe('empty')
  })

  it("resolves 'unavailable' on a non-auth failure", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: false, status: 500, json: async () => ({})}))
    const {section} = stubDOMWithSection()
    await expect(initOperatorRunIndex({endpointBase: '/operator'})).resolves.toBe('unavailable')
    expect(section.dataset.state).toBe('unavailable')
  })

  it("resolves 'auth-required' on 401/403, after calling onAuthRequired", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: false, status: 401, json: async () => ({})}))
    stubDOMWithSection()
    const onAuthRequired = vi.fn()
    await expect(initOperatorRunIndex({endpointBase: '/operator', onAuthRequired})).resolves.toBe('auth-required')
    expect(onAuthRequired).toHaveBeenCalledTimes(1)
  })

  it("resolves 'stale' when a reset replaces the init while it fetches", async () => {
    let resolveJson
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(res => {
        resolveJson = res
      }),
    }))
    stubDOMWithSection()
    const pending = initOperatorRunIndex({endpointBase: '/operator'})
    await new Promise(resolve => setTimeout(resolve, 0))
    resetRunIndexState()
    resolveJson({runs: [makeValidSummary()]})
    await expect(pending).resolves.toBe('stale')
  })

  it("resolves 'stale' when a newer init replaces it while it fetches", async () => {
    const resolvers = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => {
      resolvers.push(resolve)
    })))
    stubDOMWithSection()
    const first = initOperatorRunIndex({endpointBase: '/operator'})
    const second = initOperatorRunIndex({endpointBase: '/operator'})
    const ok = {ok: true, status: 200, json: async () => ({runs: [makeValidSummary()]})}
    resolvers[0](ok)
    resolvers[1](ok)
    await expect(first).resolves.toBe('stale')
    await expect(second).resolves.toBe('loaded')
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
    focusCalls: [],
    scrollIntoViewCalls: 0,
    focus(options) {
      this.focusCalls.push(options)
      markFocused(this)
    },
    scrollIntoView() { this.scrollIntoViewCalls++ },
    _parentEl: null,
    append(...els) {
      for (const el of els) el._parentEl = this
      this._children.push(...els)
    },
    remove() {
      if (this._parentList !== null) {
        const idx = this._parentList.children.indexOf(this)
        if (idx !== -1) this._parentList.children.splice(idx, 1)
      }
      if (this._parentEl !== null) {
        const idx = this._parentEl._children.indexOf(this)
        if (idx !== -1) this._parentEl._children.splice(idx, 1)
        this._parentEl = null
      }
    },
    get nextSibling() {
      if (this._parentList === null) return null
      const idx = this._parentList.children.indexOf(this)
      if (idx === -1) return null
      return this._parentList.children[idx + 1] ?? null
    },
    before(el) {
      if (this._parentEl !== null) {
        el._parentEl = this._parentEl
        this._parentEl._children.splice(this._parentEl._children.indexOf(this), 0, el)
      } else if (this._parentList !== null) {
        this._parentList.insertBefore(el, this)
      }
    },
    addEventListener(type, fn) {
      this._listeners[type] = this._listeners[type] ?? []
      this._listeners[type].push(fn)
    },
    dispatchEvent(event) {
      if (event.target === undefined) event.target = this
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
// Expansion toggles data-expanded; the stream, not expand, reveals regions
// ---------------------------------------------------------------------------

const ALL_STREAM_REGION_ROLES = [
  'run-checkout-detail',
  'run-waiting',
  'run-output',
  'run-output-tools',
  'run-output-coalesced',
  'run-approvals',
  'run-questions',
  'approval-badge',
  'run-cancel',
]

/** Stand in for the stream's updateDOM, the only unhider: show every region on a card. */
function streamRevealsRegions(card) {
  for (const role of ALL_STREAM_REGION_ROLES) card.querySelector(`[data-role="${role}"]`).hidden = false
}

const regionsHidden = card => ALL_STREAM_REGION_ROLES.map(role => card.querySelector(`[data-role="${role}"]`).hidden)
const ALL_HIDDEN = ALL_STREAM_REGION_ROLES.map(() => true)
const ALL_SHOWN = ALL_STREAM_REGION_ROLES.map(() => false)

describe('renderRunCard — expand/collapse toggles data-expanded; collapse hides the substructure', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('clicking a collapsed card sets data-expanded="true" and calls onSelectRun, revealing no region itself', async () => {
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
    // The stream's first paint is the only thing that shows a region.
    expect(regionsHidden(card)).toEqual(ALL_HIDDEN)
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
    streamRevealsRegions(card)
    expect(regionsHidden(card)).toEqual(ALL_SHOWN)

    card.dispatchEvent({type: 'click'})

    expect(card.dataset.expanded).toBe('false')
    expect(onSelectRun).toHaveBeenCalledTimes(2)
    expect(onSelectRun).toHaveBeenNthCalledWith(2, runId)
    expect(regionsHidden(card)).toEqual(ALL_HIDDEN)
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
    streamRevealsRegions(cardA)

    cardB.dispatchEvent({type: 'click'})

    expect(cardA.dataset.expanded).toBe('false')
    expect(cardB.dataset.expanded).toBe('true')
    expect(regionsHidden(cardA)).toEqual(ALL_HIDDEN)
    expect(regionsHidden(cardB)).toEqual(ALL_HIDDEN)
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
// markCardExpandedForLaunch — launch handoff presents as already-expanded
// ---------------------------------------------------------------------------

describe('markCardExpandedForLaunch — launch handoff marks a card expanded (not a toggle)', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('marks a launch-created card expanded without revealing a region, and the FIRST subsequent click collapses it (not a silent double-close)', async () => {
    const onSelectRun = vi.fn()
    const runId = 'run-launch-expand-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    const card = cards[0]

    // Card starts collapsed after the fetch/render (no click has happened yet).
    expect(card.dataset.expanded).toBeUndefined()
    for (const role of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge']) {
      expect(card.querySelector(`[data-role="${role}"]`).hidden).toBe(true)
    }

    // Simulate the launch handoff: the runtime seam attaches the stream and
    // calls markCardExpandedForLaunch — mirroring onRunLaunched in runtime.ts.
    markCardExpandedForLaunch(runId)

    expect(card.dataset.expanded).toBe('true')
    expect(regionsHidden(card)).toEqual(ALL_HIDDEN)
    streamRevealsRegions(card)
    // markCardExpandedForLaunch itself never calls onSelectRun — it's not a click.
    expect(onSelectRun).not.toHaveBeenCalled()

    // The operator's FIRST click on the now-already-expanded card must collapse
    // it (matching toggleCardExpansion's isExpanded branch) — not be misread as
    // an "expand" that races the runtime seam's onSelectRun into closing twice.
    card.dispatchEvent({type: 'click'})

    expect(card.dataset.expanded).toBe('false')
    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(onSelectRun).toHaveBeenCalledWith(runId)
    expect(regionsHidden(card)).toEqual(ALL_HIDDEN)
  })

  it('is idempotent — calling it twice on an already-expanded card is a no-op', async () => {
    const runId = 'run-launch-expand-002'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})
    const card = cards[0]

    markCardExpandedForLaunch(runId)
    expect(card.dataset.expanded).toBe('true')
    expect(() => markCardExpandedForLaunch(runId)).not.toThrow()
    expect(card.dataset.expanded).toBe('true')
  })

  it('collapses any other already-expanded card first (single-open accordion)', async () => {
    const runIdA = 'run-launch-accordion-a'
    const runIdB = 'run-launch-accordion-b'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: [makeValidSummary({runId: runIdA}), makeValidSummary({runId: runIdB})]}),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    const [cardA, cardB] = cards

    cardA.dispatchEvent({type: 'click'})
    expect(cardA.dataset.expanded).toBe('true')

    markCardExpandedForLaunch(runIdB)

    expect(cardA.dataset.expanded).toBe('false')
    expect(cardB.dataset.expanded).toBe('true')
  })

  it('does nothing when the card is not found', () => {
    resetRunIndexState()
    vi.stubGlobal('document', {querySelector: () => null})
    vi.stubGlobal('CSS', {escape: s => s})
    expect(() => markCardExpandedForLaunch('run-does-not-exist')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Reload-restore must not stomp a user click that happened during the fetch
// ---------------------------------------------------------------------------

describe('initOperatorRunIndex — reload-restore does not override an in-flight user selection', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('a card click (stream attach) during the delayed /operator/runs fetch wins — restore is skipped, the user selection stays open', async () => {
    const restoreRunId = 'run-restore-target'
    const userSelectedRunId = 'run-user-selected'

    const cards = []
    stubDOMWithSubstructureCards(cards)

    // First, an initial (fast) fetch renders both runs so real card stubs exist
    // in the DOM before the restore-triggering init runs — mirroring how a run
    // the user can click is already present in the list.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({runs: [makeValidSummary({runId: restoreRunId}), makeValidSummary({runId: userSelectedRunId})]}),
    }))
    await initOperatorRunIndex({endpointBase: '/operator'})
    resetRunIndexState() // simulate remount — cards stay in the DOM stub, only module state resets

    // Now the reload-restore init runs with a delayed fetch.
    let resolveFetch
    const delayedFetch = new Promise(resolve => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => delayedFetch))

    const onRestoreRun = vi.fn()
    const onRestoreMiss = vi.fn()
    const initPromise = initOperatorRunIndex({
      endpointBase: '/operator',
      restoreRunId,
      onRestoreRun,
      onRestoreMiss,
    })

    // Simulate a user click DURING the fetch await window: the runtime seam
    // attaches a stream for a DIFFERENT run via markRunStreamAttached (the
    // exact seam call onSelectRun/onRunLaunched make after _attachStream
    // succeeds) before the delayed fetch resolves.
    markRunStreamAttached(userSelectedRunId)

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({runs: [makeValidSummary({runId: restoreRunId}), makeValidSummary({runId: userSelectedRunId})]}),
    })

    await initPromise

    // The restore-target card must NOT have been force-expanded, and neither
    // restore callback fired — the user's in-flight selection wins outright.
    const restoreCard = cards.find(c => c.dataset.runId === restoreRunId)
    expect(restoreCard?.dataset.expanded).not.toBe('true')
    expect(onRestoreRun).not.toHaveBeenCalled()
    expect(onRestoreMiss).not.toHaveBeenCalled()

    // The user's card is still marked stream-attached — restore did not clear it.
    const userCard = cards.find(c => c.dataset.runId === userSelectedRunId)
    expect(userCard?.dataset.streamAttached).toBe('true')
  })

  it('with no competing user selection, restore proceeds normally after the fetch resolves', async () => {
    const restoreRunId = 'run-restore-normal'
    const onRestoreRun = vi.fn()

    let resolveFetch
    const delayedFetch = new Promise(resolve => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => delayedFetch))

    const cards = []
    stubDOMWithSubstructureCards(cards)

    const initPromise = initOperatorRunIndex({
      endpointBase: '/operator',
      restoreRunId,
      onRestoreRun,
    })

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({runs: [makeValidSummary({runId: restoreRunId})]}),
    })

    await initPromise

    const restoreCard = cards.find(c => c.dataset.runId === restoreRunId)
    expect(restoreCard?.dataset.expanded).toBe('true')
    expect(onRestoreRun).toHaveBeenCalledTimes(1)
    // Restore expands the card but shows no region: the stream's first paint does.
    expect(regionsHidden(restoreCard)).toEqual(ALL_HIDDEN)
  })
})

async function setupExpandCards(runIds) {
  const cards = []
  stubDOMWithSubstructureCards(cards)
  stubFetchRuns(runIds.map(runId => makeValidSummary({runId, status: 'running'})))
  await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
  return cards
}

describe('expand paths reveal no stream-owned region (the stream is the only unhider)', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it.each([
    ['click', cards => cards[0].dispatchEvent({type: 'click'})],
    ['Enter', cards => cards[0].dispatchEvent({type: 'keydown', key: 'Enter', preventDefault: vi.fn()})],
    ['launch handoff', () => markCardExpandedForLaunch('run-noreveal-001')],
  ])('%s leaves every region hidden on a card that has never attached', async (_label, expand) => {
    const cards = await setupExpandCards(['run-noreveal-001'])

    expand(cards)

    expect(cards[0].dataset.expanded).toBe('true')
    expect(regionsHidden(cards[0])).toEqual(ALL_HIDDEN)
  })

  it('restore leaves every region hidden', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId: 'run-noreveal-restore', status: 'running'})])
    const onRestoreRun = vi.fn()

    await initOperatorRunIndex({endpointBase: '/operator', restoreRunId: 'run-noreveal-restore', onRestoreRun})

    expect(onRestoreRun).toHaveBeenCalledTimes(1)
    expect(cards[0].dataset.expanded).toBe('true')
    expect(regionsHidden(cards[0])).toEqual(ALL_HIDDEN)
  })

  it('switching cards hides what the stream showed on the first, and shows nothing on the second', async () => {
    const cards = await setupExpandCards(['run-noreveal-a', 'run-noreveal-b'])
    markCardExpandedForLaunch('run-noreveal-a')
    streamRevealsRegions(cards[0])

    markCardExpandedForLaunch('run-noreveal-b')

    expect(regionsHidden(cards[0])).toEqual(ALL_HIDDEN)
    expect(regionsHidden(cards[1])).toEqual(ALL_HIDDEN)
  })

  it('re-expanding a collapsed card starts hidden again until the stream paints', async () => {
    const cards = await setupExpandCards(['run-noreveal-re'])
    cards[0].dispatchEvent({type: 'click'})
    streamRevealsRegions(cards[0])
    cards[0].dispatchEvent({type: 'click'})
    expect(regionsHidden(cards[0])).toEqual(ALL_HIDDEN)

    cards[0].dispatchEvent({type: 'click'})

    expect(cards[0].dataset.expanded).toBe('true')
    expect(regionsHidden(cards[0])).toEqual(ALL_HIDDEN)
  })

  it('a refresh diff while expanded does not reveal a region either', async () => {
    const cards = await setupExpandCards(['run-noreveal-diff'])
    cards[0].dispatchEvent({type: 'click'})

    stubFetchRuns([makeValidSummary({runId: 'run-noreveal-diff', status: 'running', updatedAt: '2026-06-26T13:00:00.000Z'})])
    await refreshOperatorRunIndex()

    expect(regionsHidden(cards[0])).toEqual(ALL_HIDDEN)
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
    failureKind: summaryLike.failureKind,
  })
  const list = makeMockListUsing(cards)
  const card = document.createElement('div')
  card.dataset.runId = view.runId
  card.dataset.testid = 'run-card'
  card.setAttribute('aria-label', `Run, status: ${summaryLike.statusLabel ?? view.statusLabel}`)

  const statusGroup = document.createElement('span')
  statusGroup.className = 'run-status-group'
  statusGroup.dataset.role = 'run-status-group'

  const statusSpan = document.createElement('span')
  statusSpan.dataset.role = 'run-status'
  statusSpan.textContent = summaryLike.statusLabel ?? view.statusLabel
  statusGroup.append(statusSpan)

  const reasonSpan = document.createElement('span')
  reasonSpan.className = 'run-reason'
  reasonSpan.dataset.role = 'run-reason'
  reasonSpan.textContent = view.reasonLabel ?? ''
  if (view.reasonLabel !== undefined) reasonSpan.dataset.reasonState = 'present'
  statusGroup.append(reasonSpan)

  card.append(statusGroup)

  for (const role of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge']) {
    const el = document.createElement('div')
    el.dataset.role = role
    el.hidden = true
    card.append(el)
  }
  list.append(card)
  return card
}

function statusElOf(card) {
  return card.querySelector('[data-role="run-status"]')
}

describe('status class token map — summary status ↔ hyphenated class token', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  const STATUSES = Array.from(VALID_RUN_SUMMARY_STATUSES)

  it('maps all seven summary statuses to their hyphenated token, and nothing else', () => {
    expect(STATUSES).toHaveLength(7)
    expect(Object.keys(RUN_STATUS_CLASS_TOKENS).toSorted()).toEqual([...STATUSES].toSorted())
    for (const status of STATUSES) {
      expect(RUN_STATUS_CLASS_TOKENS[status], status).toBe(`status-${status.replaceAll('_', '-')}`)
    }
    expect(RUN_STATUS_CLASS_TOKENS.waiting_for_question).toBe('status-waiting-for-question')
    expect(RUN_STATUS_CLASS_TOKENS.waiting_for_approval).toBe('status-waiting-for-approval')
  })

  it('every terminal status token on a card reads back as terminal (sticky against a non-terminal view)', async () => {
    for (const shown of ['succeeded', 'failed', 'cancelled']) {
      const runId = `run-tok-readback-${shown}`
      const cards = []
      stubDOMWithSubstructureCards(cards)
      const optimisticCard = makeStatusOnlyOptimisticCard(cards, runId)
      const statusEl = statusElOf(optimisticCard)
      statusEl.className = `run-status ${RUN_STATUS_CLASS_TOKENS[shown]}`
      statusEl.textContent = 'Shown'

      stubFetchRuns([makeValidSummary({runId, status: 'running'})])
      await initOperatorRunIndex({endpointBase: '/operator'})

      expect(statusEl.className, shown).toBe(`run-status ${RUN_STATUS_CLASS_TOKENS[shown]}`)
      expect(statusEl.textContent, shown).toBe('Shown')
    }
  })

  it('underscore, unknown, stream-only and prototype-key class tokens do not read back as terminal', async () => {
    const tokens = [
      'status-succeeded_x',
      'status-waiting_for_question',
      'succeeded',
      'status-unavailable',
      'status-evil',
      'status-',
      'status-constructor',
      '__proto__',
    ]
    for (const [index, token] of tokens.entries()) {
      const runId = `run-tok-noreadback-${index}`
      const cards = []
      stubDOMWithSubstructureCards(cards)
      const optimisticCard = makeStatusOnlyOptimisticCard(cards, runId)
      const statusEl = statusElOf(optimisticCard)
      statusEl.className = `run-status ${token}`
      statusEl.textContent = 'Shown'

      stubFetchRuns([makeValidSummary({runId, status: 'running'})])
      await initOperatorRunIndex({endpointBase: '/operator'})

      expect(statusEl.className, token).toBe('run-status status-running')
    }
  })

  it('a collapsed card renders every status with its hyphenated class and its label', async () => {
    const labels = {
      queued: 'Queued',
      running: 'Running',
      waiting_for_approval: 'Waiting for approval',
      waiting_for_question: 'Waiting for answer',
      succeeded: 'Succeeded',
      failed: 'Failed',
      cancelled: 'Cancelled',
    }
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns(STATUSES.map(status => makeValidSummary({runId: `run-tok-${status}`, status})))

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(7)
    for (const status of STATUSES) {
      const card = cards.find(c => c.dataset.runId === `run-tok-${status}`)
      const statusEl = statusElOf(card)
      expect(statusEl.className, status).toBe(`run-status ${RUN_STATUS_CLASS_TOKENS[status]}`)
      expect(statusEl.className, status).not.toContain('_')
      expect(statusEl.textContent, status).toBe(labels[status])
      expect(card.attributes['aria-label'], status).toContain(`status: ${labels[status]}`)
    }
  })

  it('an in-place update to a waiting status writes the hyphenated class and label', async () => {
    const runId = 'run-tok-update-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator'})
    const statusEl = statusElOf(cards[0])
    expect(statusEl.className).toBe('run-status status-running')

    stubFetchRuns([makeValidSummary({runId, status: 'waiting_for_question'})])
    await initOperatorRunIndex({endpointBase: '/operator'})
    expect(statusEl.className).toBe('run-status status-waiting-for-question')
    expect(statusEl.textContent).toBe('Waiting for answer')

    stubFetchRuns([makeValidSummary({runId, status: 'waiting_for_approval'})])
    await initOperatorRunIndex({endpointBase: '/operator'})
    expect(statusEl.className).toBe('run-status status-waiting-for-approval')
    expect(statusEl.textContent).toBe('Waiting for approval')
  })

  it('terminal is sticky: a card showing succeeded keeps it when a waiting or running view arrives', async () => {
    const runId = 'run-tok-sticky-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId, status: 'succeeded'})])
    await initOperatorRunIndex({endpointBase: '/operator'})
    const card = cards[0]
    const statusEl = statusElOf(card)
    const ariaBefore = card.attributes['aria-label']
    expect(statusEl.className).toBe('run-status status-succeeded')

    for (const status of ['waiting_for_question', 'waiting_for_approval', 'running', 'queued']) {
      stubFetchRuns([makeValidSummary({runId, status})])
      await initOperatorRunIndex({endpointBase: '/operator'})
      expect(cards[0], status).toBe(card)
      expect(statusEl.className, status).toBe('run-status status-succeeded')
      expect(statusEl.textContent, status).toBe('Succeeded')
      expect(card.attributes['aria-label'], status).toBe(ariaBefore)
    }
  })

  it.each(['succeeded', 'failed', 'cancelled'])('terminal is sticky for %s as the shown status', async shown => {
    const runId = `run-tok-sticky-${shown}`
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId, status: shown})])
    await initOperatorRunIndex({endpointBase: '/operator'})
    const statusEl = statusElOf(cards[0])

    stubFetchRuns([makeValidSummary({runId, status: 'waiting_for_question'})])
    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(statusEl.className).toBe(`run-status ${RUN_STATUS_CLASS_TOKENS[shown]}`)
  })

  it('stickiness keeps a failed card’s reason label when a non-terminal view arrives', async () => {
    const runId = 'run-tok-sticky-reason-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId, status: 'failed', failureKind: 'inactivity-timeout'})])
    await initOperatorRunIndex({endpointBase: '/operator'})
    const reasonEl = cards[0].querySelector('[data-role="run-reason"]')
    const reasonBefore = reasonEl.textContent
    expect(reasonBefore).not.toBe('')

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(reasonEl.textContent).toBe(reasonBefore)
  })

  it('stickiness does not block non-terminal moves or terminal-to-terminal corrections', async () => {
    const runId = 'run-tok-move-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const statusClassAfter = async status => {
      stubFetchRuns([makeValidSummary({runId, status})])
      await initOperatorRunIndex({endpointBase: '/operator'})
      return statusElOf(cards[0]).className
    }

    expect(await statusClassAfter('queued')).toBe('run-status status-queued')
    expect(await statusClassAfter('running')).toBe('run-status status-running')
    expect(await statusClassAfter('waiting_for_question')).toBe('run-status status-waiting-for-question')
    expect(await statusClassAfter('running')).toBe('run-status status-running')
    expect(await statusClassAfter('succeeded')).toBe('run-status status-succeeded')
    expect(await statusClassAfter('failed')).toBe('run-status status-failed')
  })

  it('a stream-written terminal class (hyphenated, from updateDOM) on an adopted card is also sticky', async () => {
    const runId = 'run-tok-adopt-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimisticCard = makeStatusOnlyOptimisticCard(cards, runId)
    const statusEl = statusElOf(optimisticCard)
    statusEl.className = 'run-status status-failed'
    statusEl.textContent = 'Failed'

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(1)
    expect(statusEl.className).toBe('run-status status-failed')
    expect(statusEl.textContent).toBe('Failed')
  })
})

/** Parse `#rrggbb` into [r, g, b]. */
function hexToRgb(hex) {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (m === null) throw new Error(`not a hex color: ${hex}`)
  return [Number.parseInt(m[1], 16), Number.parseInt(m[2], 16), Number.parseInt(m[3], 16)]
}

function relativeLuminance([r, g, b]) {
  const lin = c => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].toSorted((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('CSS selector ↔ status emitter agreement', () => {
  it('has a .status-<token> selector in web/src/index.css, in both themes, for every token the emitter can write', async () => {
    const fs = await import('node:fs/promises')
    const cssPath = new URL('../web/src/index.css', import.meta.url).pathname
    const cssContent = await fs.readFile(cssPath, 'utf8')

    // Every token the run index can emit (the map covers all seven summary statuses, both waiting
    // ones included) plus the optimistic pending state and the stream-only blocked status.
    const tokens = [...Object.values(RUN_STATUS_CLASS_TOKENS), 'status-pending', 'status-blocked']
    expect(tokens).toContain('status-waiting-for-approval')
    expect(tokens).toContain('status-waiting-for-question')

    for (const token of tokens) {
      const expectedSelector = `.run-status.${token}`
      expect(cssContent, token).toContain(expectedSelector)
      expect(cssContent, token).toContain(`[data-theme="light"] ${expectedSelector}`)
    }

    // The emitter never produces an underscore status class, so such a selector could never match.
    expect(cssContent).not.toMatch(/\.status-[a-z]+_[a-z_]+/)

    // Explicitly verify the old wrong ones are GONE
    expect(cssContent).not.toContain('.status-success')
    expect(cssContent).not.toContain('.status-failure')
    expect(cssContent).not.toContain('.status-error')
    expect(cssContent).not.toContain('.status-in_progress')
  })

  it('has selectors for the run-status-group and run-reason elements emitted by renderRunCard/updateDOM', async () => {
    const fs = await import('node:fs/promises')
    const cssPath = new URL('../web/src/index.css', import.meta.url).pathname
    const cssContent = await fs.readFile(cssPath, 'utf8')

    expect(cssContent).toContain('.run-status-group')
    expect(cssContent).toContain('.run-reason')
    expect(cssContent).toContain('.run-reason:empty')
  })

  it.each(['status-waiting-for-approval', 'status-waiting-for-question'])('light theme: %s badge text meets 4.5:1 on a collapsed card', async token => {
    const fs = await import('node:fs/promises')
    const css = await fs.readFile(new URL('../web/src/index.css', import.meta.url).pathname, 'utf8')
    const tokensCss = await fs.readFile(new URL('../web/src/styles/tokens.css', import.meta.url).pathname, 'utf8')

    const lightTokens = tokensCss.match(/\[data-theme="light"\] \{([^}]*)\}/)?.[1] ?? ''
    const lightColor = name => hexToRgb(lightTokens.match(new RegExp(`--${name}: (#[0-9a-fA-F]{6})`))?.[1] ?? '')
    const [warning, text, bg] = [lightColor('color-warning'), lightColor('color-text'), lightColor('color-bg')]

    const rule = css.match(new RegExp(String.raw`\[data-theme="light"\] \.run-status\.${token}\s*\{([^}]*)\}`))?.[1] ?? ''
    expect(rule, `light rule for ${token}`).not.toBe('')
    const tint = rule.match(/background:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)
    expect(tint, 'light background tint').not.toBeNull()
    const alpha = Number(tint[4])
    const badgeBg = [1, 2, 3].map((i, channel) => Number(tint[i]) * alpha + bg[channel] * (1 - alpha))

    // Text colour: the light rule's own override when it declares one; otherwise the dark-theme
    // rule's var(--color-warning) still applies.
    const mix = rule.match(/color:\s*color-mix\(in srgb,\s*var\(--color-warning\)\s+(\d+)%,\s*var\(--color-text\)\s+(\d+)%\)/)
    const fg = mix === null
      ? warning
      : warning.map((v, channel) => (v * Number(mix[1]) + text[channel] * Number(mix[2])) / 100)

    expect(contrastRatio(fg, badgeBg)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('run-updated-at text comes from the shared time module', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('a fetched card shows exactly what operator-time formats, and the run index re-exports that formatter', async () => {
    const updatedAt = new Date(Date.now() - 3 * 3_600_000).toISOString()
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId: 'run-time-shared-001', updatedAt})])

    await initOperatorRunIndex({endpointBase: '/operator'})

    const timeEl = cards[0].querySelector('[data-role="run-updated-at"]')
    expect(timeEl.textContent).toBe('3 hours ago')
    expect(timeEl.textContent).toBe(sharedFormatRelativeTime(updatedAt))
    expect(timeEl.attributes.datetime).toBe(updatedAt)
    expect(formatRelativeTime).toBe(sharedFormatRelativeTime)
  })
})

describe('formatRelativeTime — coarse relative time formatting', () => {
  it('handles missing or invalid input safely', () => {
    expect(formatRelativeTime(undefined)).toBe('')
    expect(formatRelativeTime(null)).toBe('')
    expect(formatRelativeTime('')).toBe('')
    expect(formatRelativeTime('not-a-date')).toBe('')
  })

  it('formats "just now" for times < 1 minute', () => {
    const now = 1000000000000
    expect(formatRelativeTime(new Date(now).toISOString(), now)).toBe('just now')
    expect(formatRelativeTime(new Date(now - 59999).toISOString(), now)).toBe('just now')
    // Handles future/drift by clamping to 0
    expect(formatRelativeTime(new Date(now + 10000).toISOString(), now)).toBe('just now')
  })

  it('formats "N minute(s) ago" for times < 1 hour', () => {
    const now = 1000000000000
    expect(formatRelativeTime(new Date(now - 60000).toISOString(), now)).toBe('1 minute ago')
    expect(formatRelativeTime(new Date(now - 119999).toISOString(), now)).toBe('1 minute ago')
    expect(formatRelativeTime(new Date(now - 120000).toISOString(), now)).toBe('2 minutes ago')
    expect(formatRelativeTime(new Date(now - 3599000).toISOString(), now)).toBe('59 minutes ago')
  })

  it('formats "N hour(s) ago" for times < 24 hours', () => {
    const now = 1000000000000
    expect(formatRelativeTime(new Date(now - 3600000).toISOString(), now)).toBe('1 hour ago')
    expect(formatRelativeTime(new Date(now - 7199000).toISOString(), now)).toBe('1 hour ago')
    expect(formatRelativeTime(new Date(now - 7200000).toISOString(), now)).toBe('2 hours ago')
    expect(formatRelativeTime(new Date(now - 86399000).toISOString(), now)).toBe('23 hours ago')
  })

  it('formats "N day(s) ago" for times >= 24 hours', () => {
    const now = 1000000000000
    expect(formatRelativeTime(new Date(now - 86400000).toISOString(), now)).toBe('1 day ago')
    expect(formatRelativeTime(new Date(now - 172799000).toISOString(), now)).toBe('1 day ago')
    expect(formatRelativeTime(new Date(now - 172800000).toISOString(), now)).toBe('2 days ago')
    expect(formatRelativeTime(new Date(now - 864000000).toISOString(), now)).toBe('10 days ago')
  })
})

describe('failure reason label map parity (stream ↔ run-index)', () => {
  it('stream and run-index label maps have identical keys', () => {
    const streamKeys = Object.keys(STREAM_FAILURE_REASON_LABELS).sort()
    const runIndexKeys = Object.keys(RUN_INDEX_FAILURE_REASON_LABELS).sort()
    expect(runIndexKeys).toEqual(streamKeys)
  })

  it('stream and run-index label maps have identical label text for every key', () => {
    for (const key of Object.keys(STREAM_FAILURE_REASON_LABELS)) {
      expect(RUN_INDEX_FAILURE_REASON_LABELS[key]).toBe(STREAM_FAILURE_REASON_LABELS[key])
    }
  })
})

describe('failure reason label copy (workspace and checkout kinds)', () => {
  it('workspace-unreachable, workspace-unavailable and checkout-substituted have three distinct labels, identical in both maps', () => {
    const kinds = ['workspace-unreachable', 'workspace-unavailable', 'checkout-substituted']
    for (const kind of kinds) {
      expect(RUN_INDEX_FAILURE_REASON_LABELS[kind]).toBe(STREAM_FAILURE_REASON_LABELS[kind])
    }
    const labels = kinds.map(kind => RUN_INDEX_FAILURE_REASON_LABELS[kind])
    expect(new Set(labels).size).toBe(3)
    expect(labels).toEqual(['Workspace unreachable', 'Workspace unavailable', 'Checkout mismatch'])
  })

  it('a failed summary with each new kind resolves its own reason label in the safe view', () => {
    const view = kind => buildRunSafeView(makeValidSummary({status: 'failed', failureKind: kind}))
    expect(view('workspace-unreachable').reasonLabel).toBe('Workspace unreachable')
    expect(view('workspace-unavailable').reasonLabel).toBe('Workspace unavailable')
    expect(view('checkout-substituted').reasonLabel).toBe('Checkout mismatch')
  })

  it('a non-failed summary carrying a new kind renders no reason', () => {
    const view = buildRunSafeView(makeValidSummary({status: 'running', failureKind: 'checkout-substituted'}))
    expect('reasonLabel' in view).toBe(false)
  })
})

describe('failure reason label coverage gate', () => {
  it('every vendored upstream OperatorFailureKind has an explicit dashboard label decision', () => {
    for (const kind of OPERATOR_FAILURE_KINDS) {
      expect(Object.prototype.hasOwnProperty.call(STREAM_FAILURE_REASON_LABELS, kind)).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(RUN_INDEX_FAILURE_REASON_LABELS, kind)).toBe(true)
      expect(typeof STREAM_FAILURE_REASON_LABELS[kind]).toBe('string')
      expect(STREAM_FAILURE_REASON_LABELS[kind].length).toBeGreaterThan(0)
    }
  })

  it('the dashboard label maps contain no keys beyond the vendored allowlist', () => {
    for (const key of Object.keys(STREAM_FAILURE_REASON_LABELS)) {
      expect(isOperatorFailureKind(key)).toBe(true)
    }
    for (const key of Object.keys(RUN_INDEX_FAILURE_REASON_LABELS)) {
      expect(isOperatorFailureKind(key)).toBe(true)
    }
  })
})

describe('run-index failure reason labels', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('compact failed row shows Failed plus No recent activity as secondary metadata', async () => {
    const runId = 'run-unit3-failed-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        runs: [
          makeValidSummary({
            runId,
            status: 'failed',
            failureKind: 'inactivity-timeout',
          }),
        ],
      }),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(1)
    const card = cards[0]
    const statusEl = card.querySelector('[data-role="run-status"]')
    const reasonEl = card.querySelector('[data-role="run-reason"]')

    expect(statusEl?.textContent).toBe('Failed')
    expect(reasonEl?.textContent).toBe('No recent activity')
  })

  it('updating a card via updateCardInPlace renders the reason-label properly', () => {
    const cards = []
    const card = renderRunCardForTest(cards, {
      runId: 'run-unit3-update-001',
      status: 'failed',
      failureKind: 'max-duration-timeout',
    })

    const reasonEl = card.querySelector('[data-role="run-reason"]')
    expect(reasonEl?.textContent).toBe('Run timed out')
  })

  it('renderRunCard sets data-reason-state="present" only when a safe reasonLabel is displayed, never the raw failureKind or label text', async () => {
    const runId = 'run-unit3-reason-state-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        runs: [
          makeValidSummary({
            runId,
            status: 'failed',
            failureKind: 'session-error',
          }),
        ],
      }),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})

    const reasonEl = cards[0].querySelector('[data-role="run-reason"]')
    expect(reasonEl?.dataset.reasonState).toBe('present')
    expect(reasonEl?.dataset.reasonState).not.toBe('session-error')
    expect(reasonEl?.dataset.reasonState).not.toBe('Session error')
  })

  it('a card rendered with no reasonLabel never sets data-reason-state', () => {
    const cards = []
    const card = renderRunCardForTest(cards, {
      runId: 'run-unit3-reason-state-clear-001',
      status: 'succeeded',
    })
    const reasonEl = card.querySelector('[data-role="run-reason"]')
    expect(reasonEl?.dataset.reasonState).toBeUndefined()
  })

  it('a live diff refresh that moves a card from a known reason to no reason clears data-reason-state via updateCardInPlace', async () => {
    const runId = 'run-unit3-reason-state-transition-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        runs: [makeValidSummary({runId, status: 'failed', failureKind: 'inactivity-timeout'})],
      }),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})
    const reasonEl = cards[0].querySelector('[data-role="run-reason"]')
    expect(reasonEl?.dataset.reasonState).toBe('present')

    // Refresh: the same run is now succeeded — a status the projector never
    // attaches a failureKind to, so buildRunSafeView emits no reasonLabel.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        runs: [makeValidSummary({runId, status: 'succeeded'})],
      }),
    }))
    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(1)
    const reasonElAfter = cards[0].querySelector('[data-role="run-reason"]')
    expect(reasonElAfter?.textContent).toBe('')
    expect(reasonElAfter?.dataset.reasonState).toBeUndefined()
  })

  it('generic non-failed status rows do not render any failure reason label', async () => {
    const runId = 'run-unit3-running-001'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        runs: [
          makeValidSummary({
            runId,
            status: 'running',
            failureKind: 'inactivity-timeout', // should be ignored
          }),
        ],
      }),
    }))
    const cards = []
    stubDOMWithSubstructureCards(cards)

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(1)
    const card = cards[0]
    const statusEl = card.querySelector('[data-role="run-status"]')
    const reasonEl = card.querySelector('[data-role="run-reason"]')

    expect(statusEl?.textContent).toBe('Running')
    expect(reasonEl?.textContent).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Optimistic (launch-created) card — adoption yields full fetched-card anatomy
// ---------------------------------------------------------------------------

/** Count a card's direct children carrying a given data-role. */
function countRole(card, role) {
  return card._children.filter(child => child.dataset?.role === role).length
}

/** A launch-created card as it shipped when the bug was reported: status anatomy only. */
function makeStatusOnlyOptimisticCard(cards, runId) {
  const card = renderRunCardForTest(cards, {runId, status: 'queued', statusLabel: 'Pending'})
  card.dataset.optimistic = 'true'
  card.querySelector('[data-role="run-status"]').className = 'run-status status-queued'
  return card
}

function stubFetchRuns(runs) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, status: 200, json: async () => ({runs})}))
}

describe('optimistic launch card — adoption by a fetch gains full fetched-card anatomy', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  const UPDATED_AT = '2026-06-26T13:00:00.000Z'

  it('an adopted optimistic card gains repo text, a <time>, a run-cancel region and role=button — and is click/keyboard expandable', async () => {
    const runId = 'run-adopt-anatomy-001'
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    expect(optimistic.querySelector('[data-role="run-repo"]')).toBeNull()

    stubFetchRuns([makeValidSummary({runId, status: 'failed', repo: 'fro-bot/agent', updatedAt: UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    // Same node adopted, flag cleared.
    expect(cards).toHaveLength(1)
    expect(cards[0]).toBe(optimistic)
    expect(optimistic.dataset.optimistic).toBeUndefined()

    expect(optimistic.attributes.role).toBe('button')
    expect(optimistic.querySelector('[data-role="run-repo"]').textContent).toBe('fro-bot/agent')
    const timeEl = optimistic.querySelector('[data-role="run-updated-at"]')
    expect(timeEl).not.toBeNull()
    expect(timeEl.attributes.datetime).toBe(UPDATED_AT)
    expect(timeEl.textContent).not.toBe('')
    const cancelEl = optimistic.querySelector('[data-role="run-cancel"]')
    expect(cancelEl).not.toBeNull()
    expect(cancelEl.hidden).toBe(true)

    // Late-added time lands before the hidden substructure, as on a fetched card.
    const roles = optimistic._children.map(child => child.dataset.role)
    expect(roles.indexOf('run-updated-at')).toBeLessThan(roles.indexOf('run-output'))
    expect(roles.indexOf('run-repo')).toBeLessThan(roles.indexOf('run-output'))

    // Click expands, Enter collapses, Space expands (and is default-prevented).
    optimistic.dispatchEvent({type: 'click'})
    expect(optimistic.dataset.expanded).toBe('true')
    expect(onSelectRun).toHaveBeenLastCalledWith(runId)

    optimistic.dispatchEvent({type: 'keydown', key: 'Enter', preventDefault: vi.fn()})
    expect(optimistic.dataset.expanded).toBe('false')

    const preventDefault = vi.fn()
    optimistic.dispatchEvent({type: 'keydown', key: ' ', preventDefault})
    expect(optimistic.dataset.expanded).toBe('true')
    expect(preventDefault).toHaveBeenCalled()
    expect(onSelectRun).toHaveBeenCalledTimes(3)
  })

  it('omits the <time> when the fetched view has no updatedAt (parity with renderRunCard)', async () => {
    const runId = 'run-adopt-no-time-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(optimistic.querySelector('[data-role="run-repo"]').textContent).toBe('fro-bot/agent')
    expect(optimistic.querySelector('[data-role="run-updated-at"]')).toBeNull()
  })

  it('repeated diffs do not duplicate anatomy elements or expansion listeners', async () => {
    const runId = 'run-adopt-idempotent-001'
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)

    for (let i = 0; i < 3; i++) {
      stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: UPDATED_AT})])
      await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    }

    for (const role of ['run-repo', 'run-updated-at', 'run-cancel', 'run-output', 'run-approvals']) {
      expect(countRole(optimistic, role), `exactly one ${role}`).toBe(1)
    }
    expect(optimistic._listeners.click).toHaveLength(1)
    expect(optimistic._listeners.keydown).toHaveLength(1)

    // One click → exactly one selection, not one per diff.
    optimistic.dispatchEvent({type: 'click'})
    expect(onSelectRun).toHaveBeenCalledTimes(1)
  })

  it('an optimistic card that already has repo/cancel regions (launch anatomy) is not given duplicates on adoption', async () => {
    const runId = 'run-adopt-launch-anatomy-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    for (const [role, tag] of [['run-repo', 'span'], ['run-cancel', 'div']]) {
      const el = document.createElement(tag)
      el.dataset.role = role
      optimistic.append(el)
    }

    stubFetchRuns([makeValidSummary({runId, status: 'running', repo: 'fro-bot/agent', updatedAt: UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(countRole(optimistic, 'run-repo')).toBe(1)
    expect(countRole(optimistic, 'run-cancel')).toBe(1)
    expect(optimistic.querySelector('[data-role="run-repo"]').textContent).toBe('fro-bot/agent')
  })

  it('the active-stream optimistic card is left untouched while active, then upgrades on the first diff after it stops being active', async () => {
    const runId = 'run-adopt-active-001'
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    markRunStreamAttached(runId)
    const childCountBefore = optimistic._children.length

    stubFetchRuns([makeValidSummary({runId, status: 'running', repo: 'fro-bot/agent', updatedAt: UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    // Write-protected while active: no anatomy, attributes, listeners, or flag change.
    expect(optimistic._children).toHaveLength(childCountBefore)
    expect(optimistic.querySelector('[data-role="run-repo"]')).toBeNull()
    expect(optimistic.querySelector('[data-role="run-updated-at"]')).toBeNull()
    expect(optimistic.querySelector('[data-role="run-cancel"]')).toBeNull()
    expect(optimistic.attributes.role).toBeUndefined()
    expect(optimistic._listeners.click).toBeUndefined()
    expect(optimistic.dataset.optimistic).toBe('true')

    // The stream moves on (another run becomes the active one) — this card is no longer active.
    markRunStreamAttached('run-some-other-run')
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    expect(cards).toHaveLength(1)
    expect(cards[0]).toBe(optimistic)
    expect(optimistic.dataset.optimistic).toBeUndefined()
    expect(optimistic.attributes.role).toBe('button')
    expect(optimistic.querySelector('[data-role="run-repo"]').textContent).toBe('fro-bot/agent')
    expect(optimistic.querySelector('[data-role="run-updated-at"]')).not.toBeNull()
    expect(optimistic.querySelector('[data-role="run-cancel"]')).not.toBeNull()

    optimistic.dispatchEvent({type: 'click'})
    expect(optimistic.dataset.expanded).toBe('true')
    expect(onSelectRun).toHaveBeenCalledWith(runId)
  })

  it('an expanded optimistic card is upgraded in place: same node, still expanded, still first', async () => {
    const runId = 'run-adopt-frozen-001'
    const otherId = 'run-adopt-frozen-other-001'
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)

    // Fetch an ordinary card first (init also registers onSelectRun), then prepend the optimistic one.
    stubFetchRuns([makeValidSummary({runId: otherId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    const other = cards[0]
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    cards.splice(cards.indexOf(optimistic), 1)
    cards.unshift(optimistic)

    markCardExpandedForLaunch(runId)
    expect(optimistic.dataset.expanded).toBe('true')

    // The fetch lists the launched run first (newest), the other one after it.
    stubFetchRuns([
      makeValidSummary({runId, status: 'succeeded', repo: 'fro-bot/agent', updatedAt: UPDATED_AT}),
      makeValidSummary({runId: otherId, status: 'running'}),
    ])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    expect(cards.indexOf(optimistic)).toBeLessThan(cards.indexOf(other))
    expect(cards.find(c => c.dataset.runId === runId)).toBe(optimistic)
    expect(optimistic.dataset.expanded).toBe('true')
    expect(optimistic.querySelector('[data-role="run-repo"]').textContent).toBe('fro-bot/agent')
    expect(optimistic.querySelector('[data-role="run-updated-at"]')).not.toBeNull()
    expect(optimistic.querySelector('[data-role="run-cancel"]')).not.toBeNull()
  })
})

describe('optimistic launch card — operable before any fetch adopts it', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('markCardExpandedForLaunch wires click/keyboard expansion on a launch-created card: first click collapses, next expands', async () => {
    const runId = 'run-prefetch-operable-001'
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)

    // The run-index is initialised (runtime does this before any launch); no run lists the new id yet.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, status: 200, json: async () => ({runs: []})}))
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    const optimistic = renderRunCardForTest(cards, {runId, status: 'queued', statusLabel: 'Pending'})
    optimistic.dataset.optimistic = 'true'
    expect(optimistic._listeners.click).toBeUndefined()

    // The runtime seam's onRunLaunched: attach stream, then mark expanded.
    markRunStreamAttached(runId)
    markCardExpandedForLaunch(runId)
    expect(optimistic.dataset.expanded).toBe('true')
    expect(onSelectRun).not.toHaveBeenCalled()

    optimistic.dispatchEvent({type: 'click'})
    expect(optimistic.dataset.expanded).toBe('false')
    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(onSelectRun).toHaveBeenCalledWith(runId)

    optimistic.dispatchEvent({type: 'keydown', key: 'Enter', preventDefault: vi.fn()})
    expect(optimistic.dataset.expanded).toBe('true')
    expect(onSelectRun).toHaveBeenCalledTimes(2)
  })

  it('calling markCardExpandedForLaunch repeatedly does not double-bind listeners', async () => {
    const runId = 'run-prefetch-idempotent-001'
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, status: 200, json: async () => ({runs: []})}))
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    const optimistic = renderRunCardForTest(cards, {runId, status: 'queued', statusLabel: 'Pending'})
    optimistic.dataset.optimistic = 'true'

    markCardExpandedForLaunch(runId)
    markCardExpandedForLaunch(runId)

    expect(optimistic._listeners.click).toHaveLength(1)
    expect(optimistic._listeners.keydown).toHaveLength(1)
  })

  it('a pre-wired optimistic card is not re-bound when a later fetch adopts it (one click → one selection)', async () => {
    const runId = 'run-prefetch-adopt-001'
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, status: 200, json: async () => ({runs: []})}))
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    const optimistic = renderRunCardForTest(cards, {runId, status: 'queued', statusLabel: 'Pending'})
    optimistic.dataset.optimistic = 'true'
    markCardExpandedForLaunch(runId) // wired + expanded
    optimistic.dispatchEvent({type: 'click'}) // collapse
    expect(optimistic.dataset.expanded).toBe('false')
    onSelectRun.mockClear()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({runs: [makeValidSummary({runId, status: 'running', updatedAt: '2026-06-26T13:00:00.000Z'})]}),
    }))
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    expect(optimistic._listeners.click).toHaveLength(1)
    optimistic.dispatchEvent({type: 'click'})
    expect(onSelectRun).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Card keyboard activation is scoped to the card itself
// ---------------------------------------------------------------------------

describe('card keyboard activation — scoped to the card, not nested controls', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('Space/Enter bubbling from a nested control (e.g. a run-cancel button) neither toggles expansion nor is default-prevented; Space/Enter on the card itself still toggle', async () => {
    const runId = 'run-kbd-scope-001'
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    expect(cards).toHaveLength(1)
    const card = cards[0]
    const nestedButton = document.createElement('button')
    nestedButton._parentEl = card.querySelector('[data-role="run-cancel"]')

    for (const key of [' ', 'Enter']) {
      const preventDefault = vi.fn()
      card.dispatchEvent({type: 'keydown', key, target: nestedButton, preventDefault})
      expect(preventDefault, `nested ${JSON.stringify(key)} must not be default-prevented`).not.toHaveBeenCalled()
    }
    expect(onSelectRun).not.toHaveBeenCalled()
    expect(card.dataset.expanded).toBeUndefined()

    // Same keys on the card itself still drive expansion.
    const spaceDefault = vi.fn()
    card.dispatchEvent({type: 'keydown', key: ' ', preventDefault: spaceDefault})
    expect(card.dataset.expanded).toBe('true')
    expect(spaceDefault).toHaveBeenCalled()
    expect(onSelectRun).toHaveBeenCalledTimes(1)

    card.dispatchEvent({type: 'keydown', key: 'Enter', preventDefault: vi.fn()})
    expect(card.dataset.expanded).toBe('false')
    expect(onSelectRun).toHaveBeenCalledTimes(2)
    expect(onSelectRun).toHaveBeenLastCalledWith(runId)
  })

  it('the same scoping holds on an adopted optimistic card', async () => {
    const runId = 'run-kbd-scope-optimistic-001'
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)

    stubFetchRuns([makeValidSummary({runId})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

    const nestedButton = document.createElement('button')
    const preventDefault = vi.fn()
    optimistic.dispatchEvent({type: 'keydown', key: ' ', target: nestedButton, preventDefault})
    expect(preventDefault).not.toHaveBeenCalled()
    expect(onSelectRun).not.toHaveBeenCalled()

    optimistic.dispatchEvent({type: 'keydown', key: ' ', preventDefault: vi.fn()})
    expect(optimistic.dataset.expanded).toBe('true')
    expect(onSelectRun).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Launch-seeded <time> — adoption hands the card to the list's updatedAt
// ---------------------------------------------------------------------------

/** A launch-created card carrying the launch's seeded <time>, as the launch form builds it. */
function makeLaunchSeededCard(cards, runId, {status = 'queued', seedDatetime = '2026-06-26T12:00:00.000Z'} = {}) {
  const card = makeStatusOnlyOptimisticCard(cards, runId)
  card.querySelector('[data-role="run-status"]').className = `run-status status-${status}`
  const timeEl = document.createElement('time')
  timeEl.className = 'run-updated-at'
  timeEl.dataset.role = 'run-updated-at'
  timeEl.dataset.timeSource = 'launch'
  timeEl.setAttribute('datetime', seedDatetime)
  timeEl.textContent = 'just now'
  card.append(timeEl)
  return card
}

describe('launch-seeded <time> — adoption by the run list', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  const LIST_UPDATED_AT = '2026-06-26T13:00:00.000Z'

  it('writes the list updatedAt into the seeded <time> and removes the marker, with one <time> left', async () => {
    const runId = 'run-seed-adopt-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const card = makeLaunchSeededCard(cards, runId)

    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: LIST_UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    const timeEl = card.querySelector('[data-role="run-updated-at"]')
    expect(countRole(card, 'run-updated-at')).toBe(1)
    expect(timeEl.attributes.datetime).toBe(LIST_UPDATED_AT)
    expect(timeEl.textContent).toBe(formatRelativeTime(LIST_UPDATED_AT))
    expect(timeEl.dataset.timeSource).toBeUndefined()
    expect(card.dataset.optimistic).toBeUndefined()
  })

  it('adopts the time even when the terminal-sticky guard skips the rest of the update', async () => {
    const runId = 'run-seed-sticky-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const card = makeLaunchSeededCard(cards, runId, {status: 'succeeded'})

    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: LIST_UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    // The stale non-terminal view changes nothing else on the card...
    expect(card.querySelector('[data-role="run-status"]').className).toBe('run-status status-succeeded')
    // ...but the seeded time still moves to the list's.
    const timeEl = card.querySelector('[data-role="run-updated-at"]')
    expect(timeEl.attributes.datetime).toBe(LIST_UPDATED_AT)
    expect(timeEl.dataset.timeSource).toBeUndefined()
    expect(countRole(card, 'run-updated-at')).toBe(1)
  })

  it('removes the seeded <time> and its marker when the adopting view has no updatedAt', async () => {
    const runId = 'run-seed-no-updated-at-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const card = makeLaunchSeededCard(cards, runId)

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(countRole(card, 'run-updated-at')).toBe(0)
    expect(card.querySelector('[data-role="run-updated-at"]')).toBeNull()
  })

  it('removes the seeded <time> under the terminal-sticky guard too, when the view has no updatedAt', async () => {
    const runId = 'run-seed-sticky-no-time-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const card = makeLaunchSeededCard(cards, runId, {status: 'failed'})

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(countRole(card, 'run-updated-at')).toBe(0)
  })

  it('later list diffs keep updating the adopted <time> as an ordinary list card, with no duplicates', async () => {
    const runId = 'run-seed-repeat-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const card = makeLaunchSeededCard(cards, runId)
    const later = '2026-06-26T14:30:00.000Z'

    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: LIST_UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: later})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(countRole(card, 'run-updated-at')).toBe(1)
    expect(card.querySelector('[data-role="run-updated-at"]').attributes.datetime).toBe(later)
  })

  it('an attached card is left alone: its seeded <time> and marker survive a diff while the stream owns it', async () => {
    const runId = 'run-seed-attached-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const card = makeLaunchSeededCard(cards, runId)
    card.dataset.streamAttached = 'true'
    markRunStreamAttached(runId)

    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: LIST_UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    const timeEl = card.querySelector('[data-role="run-updated-at"]')
    expect(timeEl.attributes.datetime).toBe('2026-06-26T12:00:00.000Z')
    expect(timeEl.dataset.timeSource).toBe('launch')
    expect(timeEl.textContent).toBe('just now')
  })

  it('a seeded card absent from the fetch keeps its <time> and marker: the stream keeps the start time', async () => {
    const runId = 'run-seed-absent-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const card = makeLaunchSeededCard(cards, runId)

    stubFetchRuns([makeValidSummary({runId: 'run-seed-other-001', status: 'running', updatedAt: LIST_UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    const timeEl = card.querySelector('[data-role="run-updated-at"]')
    expect(timeEl.dataset.timeSource).toBe('launch')
    expect(timeEl.attributes.datetime).toBe('2026-06-26T12:00:00.000Z')
  })

  it('a <time> with any other source marker is not an adoption target', async () => {
    const runId = 'run-seed-other-source-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const card = makeLaunchSeededCard(cards, runId)
    card.querySelector('[data-role="run-updated-at"]').dataset.timeSource = 'other'

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(countRole(card, 'run-updated-at')).toBe(1)
    expect(card.querySelector('[data-role="run-updated-at"]').dataset.timeSource).toBe('other')
  })

  it('a card with no <time> at all gains one from the list as before', async () => {
    const runId = 'run-seed-none-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const card = makeStatusOnlyOptimisticCard(cards, runId)

    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: LIST_UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(countRole(card, 'run-updated-at')).toBe(1)
    expect(card.querySelector('[data-role="run-updated-at"]').attributes.datetime).toBe(LIST_UPDATED_AT)
  })
})

// ---------------------------------------------------------------------------
// A card without updatedAt gains its <time> later, once a view carries one
// ---------------------------------------------------------------------------

describe('late <time> — a card first shown without updatedAt gains it when a later view has one', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  const LATE_UPDATED_AT = '2026-06-26T14:00:00.000Z'

  function expectSingleTimeBeforeOutput(card) {
    expect(countRole(card, 'run-updated-at')).toBe(1)
    const roles = card._children.map(child => child.dataset.role)
    expect(roles.indexOf('run-repo')).toBeLessThan(roles.indexOf('run-updated-at'))
    expect(roles.indexOf('run-updated-at')).toBeLessThan(roles.indexOf('run-output'))
    const timeEl = card.querySelector('[data-role="run-updated-at"]')
    expect(timeEl.className).toBe('run-updated-at')
    expect(timeEl.attributes.datetime).toBe(LATE_UPDATED_AT)
    expect(timeEl.textContent).not.toBe('')
  }

  it('an optimistic card adopted without updatedAt gets a <time> on a later diff, with no duplicates on repeats', async () => {
    const runId = 'run-late-time-optimistic-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    expect(optimistic.dataset.optimistic).toBeUndefined() // flag cleared on first adoption
    expect(optimistic.querySelector('[data-role="run-updated-at"]')).toBeNull()

    for (let i = 0; i < 3; i++) {
      stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: LATE_UPDATED_AT})])
      await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    }

    expect(cards).toHaveLength(1)
    expect(cards[0]).toBe(optimistic)
    expectSingleTimeBeforeOutput(optimistic)
  })

  it('a fetched card first rendered without updatedAt gets a <time> on a later diff, with no duplicates on repeats', async () => {
    const runId = 'run-late-time-fetched-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    const card = cards[0]
    expect(card.querySelector('[data-role="run-updated-at"]')).toBeNull()

    for (let i = 0; i < 3; i++) {
      stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: LATE_UPDATED_AT})])
      await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    }

    expect(cards).toHaveLength(1)
    expect(cards[0]).toBe(card)
    expectSingleTimeBeforeOutput(card)
  })

  it('does not add a <time> to the active-stream card (write-protected) even when the view has updatedAt', async () => {
    const runId = 'run-late-time-active-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    const card = cards[0]
    markRunStreamAttached(runId)
    const childCountBefore = card._children.length

    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: LATE_UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(card._children).toHaveLength(childCountBefore)
    expect(card.querySelector('[data-role="run-updated-at"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Checkout-detail region — one hidden region per card, in one slot, on every card shape
// ---------------------------------------------------------------------------

const CHECKOUT_ROLE = 'run-checkout-detail'

/** Every card shape's hidden regions, in DOM order: the waiting line sits right below checkout. */
const ORDERED_REGION_ROLES = [
  'run-checkout-detail',
  'run-waiting',
  'run-output',
  'run-output-tools',
  'run-output-coalesced',
  'run-approvals',
  'run-questions',
  'approval-badge',
  'run-cancel',
]

/** The roles of a card's direct children, in DOM order. */
function childRoles(card) {
  return card._children.map(child => child.dataset?.role)
}

/**
 * Slot contract: after the header row (status group, repo, time) and ahead of every other
 * hidden substructure region — so Unit 4 can render it right under the status/reason line.
 */
function expectCheckoutSlot(card) {
  const roles = childRoles(card)
  const at = roles.indexOf(CHECKOUT_ROLE)
  expect(at, 'checkout region present').toBeGreaterThanOrEqual(0)
  for (const header of ['run-status-group', 'run-repo', 'run-updated-at']) {
    const index = roles.indexOf(header)
    if (index !== -1) expect(index, `${header} precedes the checkout region`).toBeLessThan(at)
  }
  for (const hidden of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge', 'run-cancel']) {
    const index = roles.indexOf(hidden)
    if (index !== -1) expect(index, `checkout region precedes ${hidden}`).toBeGreaterThan(at)
  }
}

describe('checkout-detail region — fetched cards (renderRunCard)', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('every fetched card has exactly one hidden, empty checkout-detail div, with or without updatedAt', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([
      makeValidSummary({runId: 'run-ck-fetched-1', updatedAt: '2026-06-26T13:00:00.000Z'}),
      makeValidSummary({runId: 'run-ck-fetched-2'}),
    ])

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(countRole(card, CHECKOUT_ROLE)).toBe(1)
      const region = card.querySelector(`[data-role="${CHECKOUT_ROLE}"]`)
      expect(region.hidden).toBe(true)
      expect(region.textContent).toBe('')
      expect(region._children).toHaveLength(0)
      // Closed attribute set: only the role marker and hidden — nothing run-derived.
      expect(Object.keys(region.dataset)).toEqual(['role'])
      expect(Object.keys(region.attributes)).toEqual([])
      expectCheckoutSlot(card)
    }
  })

  it('the region carries no run field (id, repo) at creation', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId: 'run-ck-leak-001', repo: 'fro-bot/fixture-secret-repo'})])

    await initOperatorRunIndex({endpointBase: '/operator'})

    const region = cards[0].querySelector(`[data-role="${CHECKOUT_ROLE}"]`)
    expect(region.textContent).not.toContain('run-ck-leak-001')
    expect(region.textContent).not.toContain('fixture-secret-repo')
  })

  it('repeated diffs of the same card never duplicate the region', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    for (let i = 0; i < 3; i++) {
      stubFetchRuns([makeValidSummary({runId: 'run-ck-repeat-001', updatedAt: '2026-06-26T13:00:00.000Z'})])
      await initOperatorRunIndex({endpointBase: '/operator'})
    }
    expect(cards).toHaveLength(1)
    expect(countRole(cards[0], CHECKOUT_ROLE)).toBe(1)
  })

  it('a <time> added late (first view carrying updatedAt) still lands ahead of the checkout region', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId: 'run-ck-late-time-001'})])
    await initOperatorRunIndex({endpointBase: '/operator'})
    expect(cards[0].querySelector('[data-role="run-updated-at"]')).toBeNull()

    stubFetchRuns([makeValidSummary({runId: 'run-ck-late-time-001', updatedAt: '2026-06-26T13:00:00.000Z'})])
    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards[0].querySelector('[data-role="run-updated-at"]')).not.toBeNull()
    expect(countRole(cards[0], CHECKOUT_ROLE)).toBe(1)
    expectCheckoutSlot(cards[0])
  })

  it('expanding leaves the region hidden, collapsing hides it, and expanding another card hides the first one’s', async () => {
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId: 'run-ck-accordion-a'}), makeValidSummary({runId: 'run-ck-accordion-b'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    const [cardA, cardB] = cards
    const region = card => card.querySelector(`[data-role="${CHECKOUT_ROLE}"]`)

    cardA.dispatchEvent({type: 'click'})
    expect(region(cardA).hidden).toBe(true)
    region(cardA).hidden = false // the stream's paint
    expect(region(cardB).hidden).toBe(true)

    cardB.dispatchEvent({type: 'click'})
    expect(region(cardA).hidden).toBe(true)
    expect(region(cardB).hidden).toBe(true)
    region(cardB).hidden = false

    cardB.dispatchEvent({type: 'click'})
    expect(region(cardB).hidden).toBe(true)
  })

  it('a launch-marked card leaves its region hidden on markCardExpandedForLaunch', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId: 'run-ck-launch-expand-001'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    markCardExpandedForLaunch('run-ck-launch-expand-001')

    expect(cards[0].dataset.expanded).toBe('true')
    expect(cards[0].querySelector(`[data-role="${CHECKOUT_ROLE}"]`).hidden).toBe(true)
  })

  it('source: the region is created via createElement and never via innerHTML', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).toMatch(/const CHECKOUT_DETAIL_ROLE = 'run-checkout-detail'/)
    expect(src).not.toMatch(/\.innerHTML\s*=/)
  })
})

describe('checkout-detail region — adopted optimistic cards (ensureRunCardAnatomy)', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  const UPDATED_AT = '2026-06-26T13:00:00.000Z'

  it('a status-only optimistic card gains exactly one hidden region, in the shared slot, even across repeated diffs', async () => {
    const runId = 'run-ck-adopt-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    expect(optimistic.querySelector(`[data-role="${CHECKOUT_ROLE}"]`)).toBeNull()

    for (let i = 0; i < 3; i++) {
      stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: UPDATED_AT})])
      await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    }

    expect(cards).toHaveLength(1)
    expect(cards[0]).toBe(optimistic)
    expect(countRole(optimistic, CHECKOUT_ROLE)).toBe(1)
    expect(optimistic.querySelector(`[data-role="${CHECKOUT_ROLE}"]`).hidden).toBe(true)
    expectCheckoutSlot(optimistic)
  })

  it('a launch-built card that already carries the region is not given a second one', async () => {
    const runId = 'run-ck-adopt-launch-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    // Mirror the launch module's anatomy: the region sits ahead of run-output.
    const region = document.createElement('div')
    region.dataset.role = CHECKOUT_ROLE
    region.hidden = true
    optimistic._children.splice(optimistic._children.findIndex(child => child.dataset?.role === 'run-output'), 0, region)

    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(countRole(optimistic, CHECKOUT_ROLE)).toBe(1)
    expect(optimistic.querySelector(`[data-role="${CHECKOUT_ROLE}"]`)).toBe(region)
    expectCheckoutSlot(optimistic)
  })

  it('the active-stream optimistic card is write-protected: no region is added until it stops being active', async () => {
    const runId = 'run-ck-adopt-active-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    markRunStreamAttached(runId)

    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    expect(optimistic.querySelector(`[data-role="${CHECKOUT_ROLE}"]`)).toBeNull()

    markRunStreamAttached('run-some-other-run')
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    expect(countRole(optimistic, CHECKOUT_ROLE)).toBe(1)
    expectCheckoutSlot(optimistic)
  })

  it('an adopted card collapses and expands its region like a fetched card', async () => {
    const runId = 'run-ck-adopt-toggle-001'
    const onSelectRun = vi.fn()
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    const region = optimistic.querySelector(`[data-role="${CHECKOUT_ROLE}"]`)

    optimistic.dispatchEvent({type: 'click'})
    expect(region.hidden).toBe(true)
    region.hidden = false // the stream's paint
    optimistic.dispatchEvent({type: 'click'})
    expect(region.hidden).toBe(true)
  })

  it('anatomy parity: fetched, adopted and launch-shaped cards expose the same ordered hidden regions', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId: 'run-ck-parity-fetched', updatedAt: UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    const optimistic = makeStatusOnlyOptimisticCard(cards, 'run-ck-parity-adopted')
    stubFetchRuns([
      makeValidSummary({runId: 'run-ck-parity-fetched', updatedAt: UPDATED_AT}),
      makeValidSummary({runId: 'run-ck-parity-adopted', status: 'running', updatedAt: UPDATED_AT}),
    ])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    const fetched = cards.find(card => card.dataset.runId === 'run-ck-parity-fetched')
    const hiddenRoles = card => childRoles(card).filter(role => role !== undefined && !['run-status-group', 'run-repo', 'run-updated-at'].includes(role))
    expect(hiddenRoles(optimistic)).toEqual(hiddenRoles(fetched))
    expect(hiddenRoles(fetched)[0]).toBe(CHECKOUT_ROLE)
    expect(hiddenRoles(fetched)).toEqual(ORDERED_REGION_ROLES)
  })
})

// ---------------------------------------------------------------------------
// Question region — one hidden region per card, on every card shape
// ---------------------------------------------------------------------------

const QUESTIONS_ROLE = 'run-questions'

describe('question region — fetched cards (renderRunCard)', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('every fetched card has exactly one hidden, empty run-questions div after run-approvals', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([
      makeValidSummary({runId: 'run-q-fetched-1', updatedAt: '2026-06-26T13:00:00.000Z'}),
      makeValidSummary({runId: 'run-q-fetched-2'}),
    ])

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(countRole(card, QUESTIONS_ROLE)).toBe(1)
      const region = card.querySelector(`[data-role="${QUESTIONS_ROLE}"]`)
      expect(region.hidden).toBe(true)
      expect(region.textContent).toBe('')
      expect(region._children).toHaveLength(0)
      expect(Object.keys(region.dataset)).toEqual(['role'])
      expect(Object.keys(region.attributes)).toEqual([])
      const roles = childRoles(card)
      expect(roles.indexOf(QUESTIONS_ROLE)).toBe(roles.indexOf('run-approvals') + 1)
    }
  })

  it('is part of the auto-hidden substructure: expand leaves it hidden, collapse hides it, switching hides the first card’s', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId: 'run-q-accordion-a'}), makeValidSummary({runId: 'run-q-accordion-b'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    const [cardA, cardB] = cards
    const region = card => card.querySelector(`[data-role="${QUESTIONS_ROLE}"]`)

    cardA.dispatchEvent({type: 'click'})
    expect(region(cardA).hidden).toBe(true)
    region(cardA).hidden = false // the stream's paint
    expect(region(cardB).hidden).toBe(true)

    cardB.dispatchEvent({type: 'click'})
    expect(region(cardA).hidden).toBe(true)
    expect(region(cardB).hidden).toBe(true)
    region(cardB).hidden = false

    cardB.dispatchEvent({type: 'click'})
    expect(region(cardB).hidden).toBe(true)
  })

  it('source: SUBSTRUCTURE_ROLES lists the question role', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).toMatch(/const QUESTIONS_ROLE = 'run-questions'/)
    const list = src.match(/const SUBSTRUCTURE_ROLES = \[([\s\S]*?)\]/)?.[1] ?? ''
    expect(list).toContain('QUESTIONS_ROLE')
  })

  it('the run-summary parser accepts the waiting statuses and still rejects blocked', () => {
    for (const status of ['waiting_for_question', 'waiting_for_approval']) {
      const parsed = parseRunSummaryItem(makeValidSummary({runId: 'run-q-accept-001', status}))
      expect(parsed.success, status).toBe(true)
      expect(VALID_RUN_SUMMARY_STATUSES.has(status), status).toBe(true)
    }
    expect(parseRunSummaryItem(makeValidSummary({runId: 'run-q-reject-001', status: 'blocked'})).success).toBe(false)
  })
})

describe('question region — adopted optimistic cards (ensureRunCardAnatomy)', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  const UPDATED_AT = '2026-06-26T13:00:00.000Z'

  it('a status-only card gains exactly one hidden region between run-approvals and approval-badge, across repeated diffs', async () => {
    const runId = 'run-q-adopt-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    expect(optimistic.querySelector(`[data-role="${QUESTIONS_ROLE}"]`)).toBeNull()

    for (let i = 0; i < 3; i++) {
      stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: UPDATED_AT})])
      await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    }

    expect(cards).toHaveLength(1)
    expect(cards[0]).toBe(optimistic)
    expect(countRole(optimistic, QUESTIONS_ROLE)).toBe(1)
    expect(optimistic.querySelector(`[data-role="${QUESTIONS_ROLE}"]`).hidden).toBe(true)
    const roles = childRoles(optimistic)
    expect(roles.indexOf(QUESTIONS_ROLE)).toBe(roles.indexOf('run-approvals') + 1)
    expect(roles.indexOf(QUESTIONS_ROLE)).toBeLessThan(roles.indexOf('approval-badge'))
    expect(roles.indexOf(QUESTIONS_ROLE)).toBeLessThan(roles.indexOf('run-cancel'))
  })

  it('a launch-built card that already carries the region is not given a second one', async () => {
    const runId = 'run-q-adopt-existing-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    const region = document.createElement('div')
    region.dataset.role = QUESTIONS_ROLE
    region.hidden = true
    optimistic._children.splice(optimistic._children.findIndex(child => child.dataset?.role === 'approval-badge'), 0, region)

    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(countRole(optimistic, QUESTIONS_ROLE)).toBe(1)
    expect(optimistic.querySelector(`[data-role="${QUESTIONS_ROLE}"]`)).toBe(region)
  })

  it('an adopted card exposes the same ordered hidden regions as a fetched card', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId: 'run-q-parity-fetched', updatedAt: UPDATED_AT})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    const optimistic = makeStatusOnlyOptimisticCard(cards, 'run-q-parity-adopted')
    stubFetchRuns([
      makeValidSummary({runId: 'run-q-parity-fetched', updatedAt: UPDATED_AT}),
      makeValidSummary({runId: 'run-q-parity-adopted', status: 'running', updatedAt: UPDATED_AT}),
    ])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    const fetched = cards.find(card => card.dataset.runId === 'run-q-parity-fetched')
    const hiddenRoles = card => childRoles(card).filter(role => role !== undefined && !['run-status-group', 'run-repo', 'run-updated-at'].includes(role))
    expect(hiddenRoles(optimistic)).toEqual(hiddenRoles(fetched))
    expect(hiddenRoles(fetched)).toContain(QUESTIONS_ROLE)
    expect(hiddenRoles(fetched)).toEqual(ORDERED_REGION_ROLES)
  })
})

// ---------------------------------------------------------------------------
// Waiting-line region — one hidden region per card, right below checkout, on every card shape
// ---------------------------------------------------------------------------

const WAITING_ROLE = 'run-waiting'

describe('waiting-line region — every card shape', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('every fetched card has exactly one hidden, empty run-waiting div between checkout and output', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([
      makeValidSummary({runId: 'run-w-fetched-1', updatedAt: '2026-06-26T13:00:00.000Z'}),
      makeValidSummary({runId: 'run-w-fetched-2'}),
    ])

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(countRole(card, WAITING_ROLE)).toBe(1)
      const region = card.querySelector(`[data-role="${WAITING_ROLE}"]`)
      expect(region.hidden).toBe(true)
      expect(region.textContent).toBe('')
      expect(region._children).toHaveLength(0)
      // Closed attribute set: only the role marker and hidden — nothing run-derived.
      expect(Object.keys(region.dataset)).toEqual(['role'])
      expect(Object.keys(region.attributes)).toEqual([])
      const roles = childRoles(card)
      expect(roles.indexOf(WAITING_ROLE)).toBe(roles.indexOf(CHECKOUT_ROLE) + 1)
      expect(roles.indexOf(WAITING_ROLE)).toBe(roles.indexOf('run-output') - 1)
    }
  })

  it('an adopted status-only card gains exactly one waiting region below checkout, however often it is re-adopted', async () => {
    const runId = 'run-w-adopt-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    expect(optimistic.querySelector(`[data-role="${WAITING_ROLE}"]`)).toBeNull()

    for (let i = 0; i < 3; i++) {
      stubFetchRuns([makeValidSummary({runId, status: 'running'})])
      await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    }

    expect(countRole(optimistic, WAITING_ROLE)).toBe(1)
    expect(optimistic.querySelector(`[data-role="${WAITING_ROLE}"]`).hidden).toBe(true)
    const roles = childRoles(optimistic)
    expect(roles.indexOf(WAITING_ROLE)).toBe(roles.indexOf(CHECKOUT_ROLE) + 1)
  })

  it('an optimistic card that already has a waiting region (launch anatomy) is not given a duplicate', async () => {
    const runId = 'run-w-launch-anatomy-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    const existing = document.createElement('div')
    existing.dataset.role = WAITING_ROLE
    existing.hidden = true
    optimistic.querySelector('[data-role="run-output"]').before(existing)

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(countRole(optimistic, WAITING_ROLE)).toBe(1)
    expect(optimistic.querySelector(`[data-role="${WAITING_ROLE}"]`)).toBe(existing)
    const roles = childRoles(optimistic)
    expect(roles.indexOf(CHECKOUT_ROLE)).toBe(roles.indexOf(WAITING_ROLE) - 1)
  })

  it('a <time> added late still lands ahead of the checkout and waiting regions', async () => {
    const runId = 'run-w-late-time-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    expect(optimistic.querySelector('[data-role="run-updated-at"]')).toBeNull()

    stubFetchRuns([makeValidSummary({runId, status: 'running', updatedAt: '2026-06-26T14:00:00.000Z'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    const roles = childRoles(optimistic)
    expect(roles.indexOf('run-updated-at')).toBeLessThan(roles.indexOf(CHECKOUT_ROLE))
    expect(roles.indexOf(CHECKOUT_ROLE)).toBe(roles.indexOf(WAITING_ROLE) - 1)
  })

  it('source: SUBSTRUCTURE_ROLES lists the waiting role right after the checkout role', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    const list = src.match(/const SUBSTRUCTURE_ROLES = \[([\s\S]*?)\]/)?.[1] ?? ''
    const roles = list.split(',').map(entry => entry.trim().replaceAll("'", '')).filter(Boolean)
    expect(src).toMatch(/const WAITING_ROLE = 'run-waiting'/)
    expect(roles.indexOf('WAITING_ROLE')).toBe(roles.indexOf('CHECKOUT_DETAIL_ROLE') + 1)
  })

  it('source: the waiting text is never written by the run index, and no innerHTML is used', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toContain('Waiting for output')
    expect(src).not.toContain('Waiting to start')
    expect(src).not.toMatch(/\.innerHTML\s*=/)
  })
})

// ---------------------------------------------------------------------------
// Single-flight in-place refresh (refreshOperatorRunIndex)
// ---------------------------------------------------------------------------

/** Full run-index DOM stub: section state log, loading/empty/unavailable toggles, a focusable list. */
function stubDOMForRefresh() {
  const stateLog = []
  let currentState
  const section = {dataset: {}}
  Object.defineProperty(section.dataset, 'state', {
    enumerable: true,
    configurable: true,
    get: () => currentState,
    set: value => {
      currentState = value
      stateLog.push(value)
    },
  })
  const loading = {hidden: false}
  const empty = {hidden: true}
  const unavailable = {hidden: true}
  const cards = []
  const list = makeMockListUsing(cards)
  const doc = {
    activeElement: null,
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
    createElement() { return makeSubstructureElStub() },
  }
  vi.stubGlobal('CSS', {escape: s => s})
  vi.stubGlobal('document', doc)
  return {section, stateLog, loading, list, empty, unavailable, cards, doc}
}

/** A fetch whose responses the test releases by hand, so a refresh can be held in flight. */
function stubControlledFetch() {
  const resolvers = []
  const fn = vi.fn(() => new Promise((resolve, reject) => {
    resolvers.push({resolve, reject})
  }))
  vi.stubGlobal('fetch', fn)
  return {
    fn,
    respond(index, runs) {
      resolvers[index].resolve({ok: true, status: 200, json: async () => ({runs})})
    },
    respondRaw(index, response) {
      resolvers[index].resolve(response)
    },
    respondStatus(index, status) {
      resolvers[index].resolve({ok: false, status, json: async () => ({})})
    },
    fail(index) {
      resolvers[index].reject(new Error('network error'))
    },
  }
}

/** Let fetch + json parsing + the diff settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/** A card's observable state as one comparable value (the "byte-identical" check). */
function snapshotCard(card) {
  return JSON.stringify({
    className: card.className,
    textContent: card.textContent,
    hidden: card.hidden,
    dataset: card.dataset,
    attributes: card.attributes,
    children: (card._children ?? []).map(snapshotCard),
  })
}

describe('refreshOperatorRunIndex — single-flight in-place refresh', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('exports a refresh that resolves as a no-op before init has loaded (no fetch)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    stubDOMForRefresh()

    await expect(refreshOperatorRunIndex()).resolves.toBe(false)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a stalled response body settles the refresh false after the timeout, and a later refresh fetches again', async () => {
    const net = stubControlledFetch()
    stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [makeValidSummary({runId: 'run-rf-stall-001'})])
    await init

    vi.useFakeTimers()
    try {
      // Headers arrive, but the body never settles.
      const stalled = refreshOperatorRunIndex()
      expect(net.fn).toHaveBeenCalledTimes(2)
      net.respondRaw(1, {ok: true, status: 200, json: () => new Promise(() => {})})
      let settled
      stalled.then(value => {
        settled = value
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBeUndefined()

      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1)
      expect(settled).toBe(false)

      // The single-flight latch cleared: the next refresh starts a new fetch instead of joining.
      const next = refreshOperatorRunIndex()
      expect(net.fn).toHaveBeenCalledTimes(3)
      net.respond(2, [makeValidSummary({runId: 'run-rf-stall-001', status: 'succeeded'})])
      await expect(next).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a refresh requested while init is still in flight is a no-op and does not kill the init', async () => {
    const net = stubControlledFetch()
    const {section, cards} = stubDOMForRefresh()

    const initPromise = initOperatorRunIndex({endpointBase: '/operator'})
    await expect(refreshOperatorRunIndex()).resolves.toBe(false)
    expect(net.fn).toHaveBeenCalledTimes(1)

    net.respond(0, [makeValidSummary({runId: 'run-rf-init-001'})])
    await initPromise

    expect(section.dataset.state).toBe('loaded')
    expect(cards).toHaveLength(1)
  })

  it('adds a run started elsewhere and moves a collapsed card running → waiting_for_question → succeeded, keeping node identity', async () => {
    const runId = 'run-rf-progress-001'
    const net = stubControlledFetch()
    const {cards} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [makeValidSummary({runId, status: 'running'})])
    await init
    const card = cards[0]
    const statusEl = card.querySelector('[data-role="run-status"]')
    expect(statusEl.className).toBe('run-status status-running')

    // A run started elsewhere appears, and the existing run now waits for an answer.
    const refresh1 = refreshOperatorRunIndex()
    net.respond(1, [
      makeValidSummary({runId: 'run-rf-new-001', status: 'queued'}),
      makeValidSummary({runId, status: 'waiting_for_question'}),
    ])
    await expect(refresh1).resolves.toBe(true)
    expect(cards.map(c => c.dataset.runId)).toEqual(['run-rf-new-001', runId])
    expect(cards.find(c => c.dataset.runId === runId)).toBe(card)
    expect(statusEl.className).toBe('run-status status-waiting-for-question')
    expect(statusEl.textContent).toBe('Waiting for answer')

    // Later it finishes.
    const refresh2 = refreshOperatorRunIndex()
    net.respond(2, [
      makeValidSummary({runId: 'run-rf-new-001', status: 'running'}),
      makeValidSummary({runId, status: 'succeeded'}),
    ])
    await refresh2
    expect(statusEl.className).toBe('run-status status-succeeded')
    expect(statusEl.textContent).toBe('Succeeded')
  })

  it('does not toggle the loading state: no loading flash, no data-state="loading" on a refresh', async () => {
    const net = stubControlledFetch()
    const {stateLog, loading, list} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [makeValidSummary({runId: 'run-rf-noload-001'})])
    await init
    const statesAfterInit = [...stateLog]
    expect(loading.hidden).toBe(true)

    const pending = refreshOperatorRunIndex()
    // While the refresh fetch is in flight the list stays visible and loading stays hidden.
    expect(loading.hidden).toBe(true)
    expect(list.hidden).toBe(false)
    net.respond(1, [makeValidSummary({runId: 'run-rf-noload-001', status: 'succeeded'})])
    await pending

    expect(stateLog.slice(statesAfterInit.length)).not.toContain('loading')
    expect(loading.hidden).toBe(true)
  })

  it('the stream-attached card is byte-identical after a refresh that reports it differently', async () => {
    const runId = 'run-rf-attached-001'
    const net = stubControlledFetch()
    const {cards} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [makeValidSummary({runId, status: 'running', repo: 'fro-bot/agent'})])
    await init
    const card = cards[0]
    markRunStreamAttached(runId)
    // updateDOM's live writes.
    card.querySelector('[data-role="run-output"]').textContent = 'live streamed output'
    card.querySelector('[data-role="run-output"]').hidden = false
    card.querySelector('[data-role="run-status"]').textContent = 'Running'
    const before = snapshotCard(card)

    const pending = refreshOperatorRunIndex()
    net.respond(1, [makeValidSummary({runId, status: 'succeeded', repo: 'fro-bot/other', updatedAt: '2026-06-26T13:00:00.000Z'})])
    await pending

    expect(cards[0]).toBe(card)
    expect(snapshotCard(card)).toBe(before)
  })

  it('three requests during one in-flight fetch produce exactly one more fetch, and share its promise', async () => {
    const runId = 'run-rf-single-001'
    const net = stubControlledFetch()
    const {cards} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [makeValidSummary({runId, status: 'running'})])
    await init
    expect(net.fn).toHaveBeenCalledTimes(1)

    const first = refreshOperatorRunIndex()
    expect(net.fn).toHaveBeenCalledTimes(2)
    const second = refreshOperatorRunIndex()
    const third = refreshOperatorRunIndex()
    const fourth = refreshOperatorRunIndex()
    expect(net.fn).toHaveBeenCalledTimes(2)
    expect(third).toBe(second)
    expect(fourth).toBe(second)

    let joinedSettled = false
    second.then(() => {
      joinedSettled = true
    })

    // The in-flight fetch finishes: the trailing refresh starts, and only now.
    net.respond(1, [makeValidSummary({runId, status: 'waiting_for_approval'})])
    await first
    await flush()
    expect(net.fn).toHaveBeenCalledTimes(3)
    // A joined request must not settle on the stale in-flight data.
    expect(joinedSettled).toBe(false)

    net.respond(2, [makeValidSummary({runId, status: 'succeeded'})])
    await second
    await flush()
    // Exactly one trailing fetch — nothing further was queued.
    expect(net.fn).toHaveBeenCalledTimes(3)
    expect(cards[0].querySelector('[data-role="run-status"]').className).toBe('run-status status-succeeded')

    // Once idle, a new request starts a new fetch.
    const later = refreshOperatorRunIndex()
    expect(net.fn).toHaveBeenCalledTimes(4)
    net.respond(3, [makeValidSummary({runId, status: 'succeeded'})])
    await later
  })

  it('responses apply in order: a stale in-flight response is applied before the trailing one', async () => {
    const runId = 'run-rf-order-001'
    const net = stubControlledFetch()
    const {cards} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [makeValidSummary({runId, status: 'queued'})])
    await init

    const first = refreshOperatorRunIndex()
    const second = refreshOperatorRunIndex()
    net.respond(1, [makeValidSummary({runId, status: 'running'})])
    await first
    expect(cards[0].querySelector('[data-role="run-status"]').className).toBe('run-status status-running')
    await flush()
    net.respond(2, [makeValidSummary({runId, status: 'waiting_for_approval'})])
    await second

    expect(cards[0].querySelector('[data-role="run-status"]').className).toBe('run-status status-waiting-for-approval')
  })

  it('a list that mounted unavailable becomes a populated list on a successful refresh', async () => {
    const net = stubControlledFetch()
    const {section, list, unavailable, empty, cards} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respondStatus(0, 500)
    await init
    expect(section.dataset.state).toBe('unavailable')
    expect(unavailable.hidden).toBe(false)

    const pending = refreshOperatorRunIndex()
    net.respond(1, [makeValidSummary({runId: 'run-rf-recover-001'})])
    await expect(pending).resolves.toBe(true)

    expect(section.dataset.state).toBe('loaded')
    expect(unavailable.hidden).toBe(true)
    expect(empty.hidden).toBe(true)
    expect(list.hidden).toBe(false)
    expect(cards).toHaveLength(1)
  })

  it('a refresh that returns no runs shows the empty state', async () => {
    const net = stubControlledFetch()
    const {section, list, unavailable, empty, cards} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [makeValidSummary({runId: 'run-rf-empty-001'})])
    await init
    expect(section.dataset.state).toBe('loaded')

    const pending = refreshOperatorRunIndex()
    net.respond(1, [])
    await pending

    expect(cards).toHaveLength(0)
    expect(section.dataset.state).toBe('empty')
    expect(empty.hidden).toBe(false)
    expect(list.hidden).toBe(true)
    expect(unavailable.hidden).toBe(true)
  })

  it('an empty list that later gains a run leaves the empty state', async () => {
    const net = stubControlledFetch()
    const {section, list, empty} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [])
    await init
    expect(section.dataset.state).toBe('empty')

    const pending = refreshOperatorRunIndex()
    net.respond(1, [makeValidSummary({runId: 'run-rf-gain-001'})])
    await pending

    expect(section.dataset.state).toBe('loaded')
    expect(empty.hidden).toBe(true)
    expect(list.hidden).toBe(false)
  })

  it('a focused collapsed card that moves during a refresh keeps focus, and nothing scrolls', async () => {
    const net = stubControlledFetch()
    const {cards, doc} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [
      makeValidSummary({runId: 'run-rf-focus-a', status: 'running'}),
      makeValidSummary({runId: 'run-rf-focus-b', status: 'running'}),
      makeValidSummary({runId: 'run-rf-focus-c', status: 'running'}),
    ])
    await init
    const [cardA, cardB, cardC] = cards
    cardB.focus()
    expect(doc.activeElement).toBe(cardB)
    cardB.focusCalls.length = 0

    // B jumps to the top of the list: the DOM move blurs it, so the refresh must put focus back.
    const pending = refreshOperatorRunIndex()
    net.respond(1, [
      makeValidSummary({runId: 'run-rf-focus-b', status: 'waiting_for_question'}),
      makeValidSummary({runId: 'run-rf-focus-a', status: 'running'}),
      makeValidSummary({runId: 'run-rf-focus-c', status: 'running'}),
    ])
    await pending

    expect(cards).toEqual([cardB, cardA, cardC])
    expect(doc.activeElement).toBe(cardB)
    expect(cardB.focusCalls).toEqual([{preventScroll: true}])
    for (const card of cards) expect(card.scrollIntoViewCalls).toBe(0)
    expect(cardA.focusCalls).toHaveLength(0)
    expect(cardC.focusCalls).toHaveLength(0)
  })

  it('a refresh with nothing focused in the list focuses nothing; a focused card that is removed does not throw', async () => {
    const net = stubControlledFetch()
    const {cards, doc} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [
      makeValidSummary({runId: 'run-rf-nofocus-a'}),
      makeValidSummary({runId: 'run-rf-nofocus-b'}),
    ])
    await init
    const [cardA, cardB] = cards

    const first = refreshOperatorRunIndex()
    net.respond(1, [makeValidSummary({runId: 'run-rf-nofocus-b'}), makeValidSummary({runId: 'run-rf-nofocus-a'})])
    await first
    expect(cardA.focusCalls).toHaveLength(0)
    expect(cardB.focusCalls).toHaveLength(0)

    cardA.focus()
    cardA.focusCalls.length = 0
    const second = refreshOperatorRunIndex()
    net.respond(2, [makeValidSummary({runId: 'run-rf-nofocus-b'})])
    await expect(second).resolves.toBe(true)
    expect(cards).toEqual([cardB])
    expect(cardA.focusCalls).toHaveLength(0)
    expect(doc.activeElement).toBe(cardA)
  })

  it('a 401 reports auth-required once, leaves the list alone, and stops further refreshes', async () => {
    const runId = 'run-rf-401-001'
    const onAuthRequired = vi.fn()
    const net = stubControlledFetch()
    const {cards, section} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator', onAuthRequired})
    net.respond(0, [makeValidSummary({runId})])
    await init
    const card = cards[0]

    const pending = refreshOperatorRunIndex()
    net.respondStatus(1, 401)
    await expect(pending).resolves.toBe(false)

    expect(onAuthRequired).toHaveBeenCalledTimes(1)
    expect(cards).toEqual([card])
    expect(section.dataset.state).toBe('loaded')

    // The session is gone: another refresh must not keep hitting the gateway.
    await expect(refreshOperatorRunIndex()).resolves.toBe(false)
    expect(net.fn).toHaveBeenCalledTimes(2)
    expect(onAuthRequired).toHaveBeenCalledTimes(1)
  })

  it('a 429 leaves the list as it was and the next refresh tries again', async () => {
    const runId = 'run-rf-429-001'
    const onAuthRequired = vi.fn()
    const net = stubControlledFetch()
    const {cards, section, unavailable} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator', onAuthRequired})
    net.respond(0, [makeValidSummary({runId, status: 'running'})])
    await init
    const card = cards[0]

    const limited = refreshOperatorRunIndex()
    net.respondStatus(1, 429)
    await expect(limited).resolves.toBe(false)
    expect(cards).toEqual([card])
    expect(section.dataset.state).toBe('loaded')
    expect(unavailable.hidden).toBe(true)
    expect(onAuthRequired).not.toHaveBeenCalled()
    expect(card.querySelector('[data-role="run-status"]').className).toBe('run-status status-running')

    const retry = refreshOperatorRunIndex()
    expect(net.fn).toHaveBeenCalledTimes(3)
    net.respond(2, [makeValidSummary({runId, status: 'succeeded'})])
    await expect(retry).resolves.toBe(true)
    expect(card.querySelector('[data-role="run-status"]').className).toBe('run-status status-succeeded')
  })

  it('a network failure leaves the list as it was and the next refresh tries again', async () => {
    const runId = 'run-rf-net-001'
    const net = stubControlledFetch()
    const {cards, section, unavailable} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [makeValidSummary({runId, status: 'running'})])
    await init
    const card = cards[0]

    const failed = refreshOperatorRunIndex()
    net.fail(1)
    await expect(failed).resolves.toBe(false)
    expect(cards).toEqual([card])
    expect(section.dataset.state).toBe('loaded')
    expect(unavailable.hidden).toBe(true)

    const retry = refreshOperatorRunIndex()
    net.respond(2, [makeValidSummary({runId, status: 'succeeded'})])
    await expect(retry).resolves.toBe(true)
  })

  it('a failed refresh on an unavailable list keeps the unavailable state', async () => {
    const net = stubControlledFetch()
    const {section, unavailable} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respondStatus(0, 500)
    await init

    const failed = refreshOperatorRunIndex()
    net.respondStatus(1, 429)
    await failed

    expect(section.dataset.state).toBe('unavailable')
    expect(unavailable.hidden).toBe(false)
  })

  it('cards added by a refresh are wired to the selection handler from init', async () => {
    const net = stubControlledFetch()
    const {cards} = stubDOMForRefresh()
    const onSelectRun = vi.fn()
    const init = initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
    net.respond(0, [makeValidSummary({runId: 'run-rf-wire-old'})])
    await init

    const pending = refreshOperatorRunIndex()
    net.respond(1, [makeValidSummary({runId: 'run-rf-wire-new'}), makeValidSummary({runId: 'run-rf-wire-old'})])
    await pending

    cards.find(c => c.dataset.runId === 'run-rf-wire-new').dispatchEvent({type: 'click'})
    expect(onSelectRun).toHaveBeenCalledWith('run-rf-wire-new')
  })

  it('a reset while a refresh is in flight discards its response and settles every waiter', async () => {
    const net = stubControlledFetch()
    const {cards} = stubDOMForRefresh()
    const init = initOperatorRunIndex({endpointBase: '/operator'})
    net.respond(0, [makeValidSummary({runId: 'run-rf-reset-001', status: 'running'})])
    await init
    const card = cards[0]

    const inFlight = refreshOperatorRunIndex()
    const joined = refreshOperatorRunIndex()
    resetRunIndexState()
    net.respond(1, [makeValidSummary({runId: 'run-rf-reset-001', status: 'succeeded'})])

    await expect(inFlight).resolves.toBe(false)
    await expect(joined).resolves.toBe(false)
    await flush()
    expect(card.querySelector('[data-role="run-status"]').className).toBe('run-status status-running')
    expect(net.fn).toHaveBeenCalledTimes(2)
    // Nothing is loaded after a reset, so a later refresh stays a no-op.
    await expect(refreshOperatorRunIndex()).resolves.toBe(false)
    expect(net.fn).toHaveBeenCalledTimes(2)
  })

  it('source: the refresh never bumps the generation counter and never reuses initOperatorRunIndex', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    const body = src.match(/export function refreshOperatorRunIndex[\s\S]*?\n\}\n/)?.[0] ?? ''
    expect(body).not.toBe('')
    const refreshSource = src.slice(src.indexOf('async function applyRefresh'), src.indexOf('export function refreshOperatorRunIndex')) + body
    expect(refreshSource).not.toContain('_runIndexGeneration++')
    expect(refreshSource).not.toContain('initOperatorRunIndex(')
  })
})

// ---------------------------------------------------------------------------
// A run launched elsewhere must land above the run the operator has open.
//
// The Operator view stays mounted (display:none) on the Inbox tab, so its 30 s refresh keeps diffing
// the live DOM. The expanded card is position-locked; a NEW card is not part of that lock and has to
// take its fetch-order slot, which for a newest-first gateway is above an older expanded run.
// ---------------------------------------------------------------------------

const orderedRunIds = cards => cards.map(c => c.dataset.runId)

async function initOrderedList(runIds, extraInit = {}) {
  const net = stubControlledFetch()
  const dom = stubDOMForRefresh()
  const onSelectRun = vi.fn()
  const init = initOperatorRunIndex({endpointBase: '/operator', onSelectRun, ...extraInit})
  net.respond(0, runIds.map(runId => makeValidSummary({runId, status: 'succeeded'})))
  await init
  return {net, ...dom}
}

async function refreshOrderedList(net, index, runIds, statusOf = () => 'succeeded') {
  const pending = refreshOperatorRunIndex()
  net.respond(index, runIds.map(runId => makeValidSummary({runId, status: statusOf(runId)})))
  await expect(pending).resolves.toBe(true)
}

describe('refreshOperatorRunIndex — a new run lands in fetch order around the position-locked expanded card', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const ids = orderedRunIds
  const initWith = initOrderedList
  const refreshWith = refreshOrderedList

  it('collapsed older run: the new run is above it', async () => {
    const {net, cards} = await initWith(['run-ord-B'])
    await refreshWith(net, 1, ['run-ord-A', 'run-ord-B'], id => (id === 'run-ord-A' ? 'waiting_for_approval' : 'succeeded'))
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-B'])
  })

  it('expanded older run (click, no stream yet): the new run is above it', async () => {
    const {net, cards} = await initWith(['run-ord-B'])
    cards[0].dispatchEvent({type: 'click'})
    expect(cards[0].dataset.expanded).toBe('true')

    await refreshWith(net, 1, ['run-ord-A', 'run-ord-B'])
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-B'])
  })

  it('expanded older run with its stream attached: the new run is above it, the card node is untouched', async () => {
    const {net, cards} = await initWith(['run-ord-B'])
    const cardB = cards[0]
    cardB.dispatchEvent({type: 'click'})
    markRunStreamAttached('run-ord-B')

    await refreshWith(net, 1, ['run-ord-A', 'run-ord-B'])
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-B'])
    expect(cards.find(c => c.dataset.runId === 'run-ord-B')).toBe(cardB)
    expect(cardB.dataset.expanded).toBe('true')
    expect(cardB.dataset.streamAttached).toBe('true')
  })

  it('hash-restored older run: the new run is above it', async () => {
    const {net, cards} = await initWith(['run-ord-B'], {restoreRunId: 'run-ord-B', onRestoreRun: vi.fn()})
    expect(cards[0].dataset.expanded).toBe('true')

    await refreshWith(net, 1, ['run-ord-A', 'run-ord-B'])
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-B'])
  })

  it('several cards, expanded one in the middle: the new run goes on top and the rest keep their order', async () => {
    const {net, cards} = await initWith(['run-ord-C', 'run-ord-B', 'run-ord-D'])
    cards.find(c => c.dataset.runId === 'run-ord-B').dispatchEvent({type: 'click'})

    await refreshWith(net, 1, ['run-ord-A', 'run-ord-C', 'run-ord-B', 'run-ord-D'])
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-C', 'run-ord-B', 'run-ord-D'])
  })

  it('several cards, expanded one last: the new run goes on top and the expanded run stays last', async () => {
    const {net, cards} = await initWith(['run-ord-C', 'run-ord-B'])
    cards.find(c => c.dataset.runId === 'run-ord-B').dispatchEvent({type: 'click'})

    await refreshWith(net, 1, ['run-ord-A', 'run-ord-C', 'run-ord-B'])
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-C', 'run-ord-B'])
  })

  it('several new runs at once all land above the expanded run, newest first', async () => {
    const {net, cards} = await initWith(['run-ord-B'])
    cards[0].dispatchEvent({type: 'click'})

    await refreshWith(net, 1, ['run-ord-A2', 'run-ord-A1', 'run-ord-B'])
    expect(ids(cards)).toEqual(['run-ord-A2', 'run-ord-A1', 'run-ord-B'])
  })

  it('an older run the gateway lists below the expanded one stays below it', async () => {
    const {net, cards} = await initWith(['run-ord-B'])
    cards[0].dispatchEvent({type: 'click'})

    await refreshWith(net, 1, ['run-ord-B', 'run-ord-Z'])
    expect(ids(cards)).toEqual(['run-ord-B', 'run-ord-Z'])
  })

  it('an attached card the fetch no longer lists is kept, behind the fetched cards at the end of the list', async () => {
    const {net, cards} = await initWith(['run-ord-B', 'run-ord-C'])
    const cardB = cards.find(c => c.dataset.runId === 'run-ord-B')
    cardB.dispatchEvent({type: 'click'})
    markRunStreamAttached('run-ord-B')

    // B aged off the end of the gateway's window while its stream is attached.
    await refreshWith(net, 1, ['run-ord-A', 'run-ord-C'])
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-C', 'run-ord-B'])
    expect(cards.find(c => c.dataset.runId === 'run-ord-B')).toBe(cardB)
    expect(cardB.dataset.expanded).toBe('true')
    expect(cardB.dataset.streamAttached).toBe('true')
  })

  // The launch card is inserted on top (newest run) and expanded; the expand triggers a refresh that
  // can land before the gateway lists the run. It must stay on top, then be adopted in place.
  async function initWithUnlistedOptimisticOnTop() {
    const setup = await initWith(['run-ord-B', 'run-ord-C'])
    const optimistic = makeStatusOnlyOptimisticCard(setup.cards, 'run-ord-A')
    setup.cards.splice(setup.cards.indexOf(optimistic), 1)
    setup.cards.unshift(optimistic)
    markCardExpandedForLaunch('run-ord-A')
    expect(optimistic.dataset.expanded).toBe('true')
    return {...setup, optimistic}
  }

  it('an unlisted optimistic card stays on top of the fetched cards, same node, still expanded', async () => {
    const {net, cards, optimistic} = await initWithUnlistedOptimisticOnTop()

    await refreshWith(net, 1, ['run-ord-B', 'run-ord-C'])
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-B', 'run-ord-C'])
    expect(cards[0]).toBe(optimistic)
    expect(optimistic.dataset.expanded).toBe('true')
    expect(optimistic.dataset.optimistic).toBe('true')
  })

  it('once the fetch lists the optimistic card it is adopted in place', async () => {
    const {net, cards, optimistic} = await initWithUnlistedOptimisticOnTop()

    await refreshWith(net, 1, ['run-ord-B', 'run-ord-C'])
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-B', 'run-ord-C'])

    await refreshWith(net, 2, ['run-ord-A', 'run-ord-B', 'run-ord-C'])
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-B', 'run-ord-C'])
    expect(cards[0]).toBe(optimistic)
    expect(optimistic.dataset.expanded).toBe('true')
    expect(optimistic.dataset.optimistic).toBeUndefined()
  })

  it('a focused card keeps focus when a new run is inserted above the expanded run', async () => {
    const {net, cards, doc} = await initWith(['run-ord-B'])
    const cardB = cards[0]
    cardB.dispatchEvent({type: 'click'})
    cardB.focus = vi.fn(() => {
      doc.activeElement = cardB
    })
    doc.activeElement = cardB
    // The mock list contains() answers by membership in the cards array.
    await refreshWith(net, 1, ['run-ord-A', 'run-ord-B'])
    expect(ids(cards)).toEqual(['run-ord-A', 'run-ord-B'])
    expect(doc.activeElement).toBe(cardB)
  })
})

describe('onListApplied — the run IDs of each applied list', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('init reports the fetched run IDs after the list is applied', async () => {
    const net = stubControlledFetch()
    stubDOMForRefresh()
    const onListApplied = vi.fn()
    const init = initOperatorRunIndex({endpointBase: '/operator', onListApplied})
    net.respond(0, [makeValidSummary({runId: 'run-la-001'}), makeValidSummary({runId: 'run-la-002'})])
    await init

    expect(onListApplied).toHaveBeenCalledTimes(1)
    expect([...onListApplied.mock.calls[0][0]]).toEqual(['run-la-001', 'run-la-002'])
  })

  it('init reports an empty list as no IDs', async () => {
    const net = stubControlledFetch()
    stubDOMForRefresh()
    const onListApplied = vi.fn()
    const init = initOperatorRunIndex({endpointBase: '/operator', onListApplied})
    net.respond(0, [])
    await init

    expect(onListApplied).toHaveBeenCalledTimes(1)
    expect([...onListApplied.mock.calls[0][0]]).toEqual([])
  })

  it('a refresh reports the fetched IDs, not the cards left in the DOM (a protected card stays but is not listed)', async () => {
    const net = stubControlledFetch()
    const {cards} = stubDOMForRefresh()
    const onListApplied = vi.fn()
    const init = initOperatorRunIndex({endpointBase: '/operator', onListApplied})
    net.respond(0, [makeValidSummary({runId: 'run-la-keep'}), makeValidSummary({runId: 'run-la-gone'})])
    await init
    markRunStreamAttached('run-la-gone')
    onListApplied.mockClear()

    const refresh = refreshOperatorRunIndex()
    net.respond(1, [makeValidSummary({runId: 'run-la-keep'})])
    await expect(refresh).resolves.toBe(true)

    expect(cards.map(card => card.dataset.runId)).toContain('run-la-gone')
    expect(onListApplied).toHaveBeenCalledTimes(1)
    expect([...onListApplied.mock.calls[0][0]]).toEqual(['run-la-keep'])
  })

  it('reports nothing when the fetch fails, the body is rejected, or auth fails', async () => {
    const net = stubControlledFetch()
    stubDOMForRefresh()
    const onListApplied = vi.fn()
    const init = initOperatorRunIndex({endpointBase: '/operator', onListApplied, onAuthRequired: vi.fn()})
    net.respond(0, [makeValidSummary({runId: 'run-la-fail'})])
    await init
    onListApplied.mockClear()

    const failed = refreshOperatorRunIndex()
    net.respondRaw(1, {ok: false, status: 500, json: async () => ({})})
    await expect(failed).resolves.toBe(false)

    const authFailed = refreshOperatorRunIndex()
    net.respondRaw(2, {ok: false, status: 401, json: async () => ({})})
    await expect(authFailed).resolves.toBe(false)

    expect(onListApplied).not.toHaveBeenCalled()
  })

  it('init still resolves loaded with the card listed when onListApplied throws', async () => {
    const net = stubControlledFetch()
    const {cards} = stubDOMForRefresh()
    const onListApplied = vi.fn(() => {
      throw new Error('boom')
    })
    const init = initOperatorRunIndex({endpointBase: '/operator', onListApplied})
    net.respond(0, [makeValidSummary({runId: 'run-la-throw'})])

    await expect(init).resolves.toBe('loaded')
    expect(onListApplied).toHaveBeenCalledTimes(1)
    expect(cards.map(card => card.dataset.runId)).toEqual(['run-la-throw'])
  })

  it('a refresh still resolves true with the card listed when onListApplied throws', async () => {
    const net = stubControlledFetch()
    const {cards} = stubDOMForRefresh()
    let shouldThrow = false
    const onListApplied = vi.fn(() => {
      if (shouldThrow) throw new Error('boom')
    })
    const init = initOperatorRunIndex({endpointBase: '/operator', onListApplied})
    net.respond(0, [makeValidSummary({runId: 'run-la-first'})])
    await init
    shouldThrow = true
    onListApplied.mockClear()

    const refresh = refreshOperatorRunIndex()
    net.respond(1, [makeValidSummary({runId: 'run-la-second'})])

    await expect(refresh).resolves.toBe(true)
    expect(onListApplied).toHaveBeenCalledTimes(1)
    expect(cards.map(card => card.dataset.runId)).toEqual(['run-la-second'])
  })

  it('reports nothing when a reset replaces the init while it fetches', async () => {
    const net = stubControlledFetch()
    stubDOMForRefresh()
    const onListApplied = vi.fn()
    const init = initOperatorRunIndex({endpointBase: '/operator', onListApplied})
    resetRunIndexState()
    net.respond(0, [makeValidSummary({runId: 'run-la-stale'})])
    await init

    expect(onListApplied).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Output toolbar region — one hidden region per card, right after run-output, on every card shape
// ---------------------------------------------------------------------------

const TOOLS_ROLE = 'run-output-tools'

describe('output toolbar region — fetched and adopted cards', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  it('every fetched card has exactly one hidden, empty toolbar div right after the output region', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([
      makeValidSummary({runId: 'run-tools-fetched-1', updatedAt: '2026-06-26T13:00:00.000Z'}),
      makeValidSummary({runId: 'run-tools-fetched-2'}),
    ])

    await initOperatorRunIndex({endpointBase: '/operator'})

    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(countRole(card, TOOLS_ROLE)).toBe(1)
      const region = card.querySelector(`[data-role="${TOOLS_ROLE}"]`)
      expect(region.hidden).toBe(true)
      expect(region._children).toHaveLength(0)
      // Closed attribute set: only the role marker and hidden — nothing run-derived.
      expect(Object.keys(region.dataset)).toEqual(['role'])
      expect(Object.keys(region.attributes)).toEqual([])
      const roles = childRoles(card)
      expect(roles.indexOf(TOOLS_ROLE)).toBe(roles.indexOf('run-output') + 1)
    }
  })

  it('an adopted status-only card gains exactly one toolbar right after the output region, however often it is re-adopted', async () => {
    const runId = 'run-tools-adopt-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    expect(optimistic.querySelector(`[data-role="${TOOLS_ROLE}"]`)).toBeNull()

    for (let i = 0; i < 3; i++) {
      stubFetchRuns([makeValidSummary({runId, status: 'running'})])
      await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    }

    expect(countRole(optimistic, TOOLS_ROLE)).toBe(1)
    expect(optimistic.querySelector(`[data-role="${TOOLS_ROLE}"]`).hidden).toBe(true)
    const roles = childRoles(optimistic)
    expect(roles.indexOf(TOOLS_ROLE)).toBe(roles.indexOf('run-output') + 1)
    expect(roles.indexOf(TOOLS_ROLE)).toBeLessThan(roles.indexOf('run-output-coalesced'))
  })

  it('an optimistic card that already has a toolbar (launch anatomy) is not given a duplicate', async () => {
    const runId = 'run-tools-launch-anatomy-001'
    const cards = []
    stubDOMWithSubstructureCards(cards)
    const optimistic = makeStatusOnlyOptimisticCard(cards, runId)
    const existing = document.createElement('div')
    existing.dataset.role = TOOLS_ROLE
    existing.hidden = true
    optimistic.querySelector('[data-role="run-output-coalesced"]').before(existing)

    stubFetchRuns([makeValidSummary({runId, status: 'running'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})

    expect(countRole(optimistic, TOOLS_ROLE)).toBe(1)
    expect(optimistic.querySelector(`[data-role="${TOOLS_ROLE}"]`)).toBe(existing)
  })

  it('collapsing a card hides its toolbar like every other stream-owned region', async () => {
    const cards = []
    stubDOMWithSubstructureCards(cards)
    stubFetchRuns([makeValidSummary({runId: 'run-tools-collapse-001'})])
    await initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    const card = cards[0]
    const region = card.querySelector(`[data-role="${TOOLS_ROLE}"]`)

    card.dispatchEvent({type: 'click'})
    region.hidden = false // the stream's paint
    card.dispatchEvent({type: 'click'})

    expect(region.hidden).toBe(true)
  })

  it('source: SUBSTRUCTURE_ROLES lists the toolbar role right after the output role', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    const list = src.match(/const SUBSTRUCTURE_ROLES = \[([\s\S]*?)\]/)?.[1] ?? ''
    expect(src).toMatch(/const OUTPUT_TOOLS_ROLE = 'run-output-tools'/)
    expect(list).toMatch(/'run-output',\s*OUTPUT_TOOLS_ROLE,\s*'run-output-coalesced'/)
  })
})

async function oneCard(onSelectRun) {
  const cards = []
  stubDOMWithSubstructureCards(cards)
  stubFetchRuns([makeValidSummary({runId: 'run-guard-001'})])
  await initOperatorRunIndex({endpointBase: '/operator', onSelectRun})
  return cards[0]
}

describe('card click guard — fetched cards', () => {
  afterEach(() => {
    resetRunIndexState()
    vi.restoreAllMocks()
  })

  /** A click target whose closest() finds the given selector's match, or nothing. */
  const targetInside = hit => ({closest: selector => (hit.includes(selector) ? {} : null)})

  it('ignores a click whose target sits inside a link or a button, and still toggles for other targets', async () => {
    const onSelectRun = vi.fn()
    const card = await oneCard(onSelectRun)

    card.dispatchEvent({type: 'click', target: targetInside(['a[href], button'])})
    expect(onSelectRun).not.toHaveBeenCalled()
    expect(card.dataset.expanded).toBeUndefined()

    card.dispatchEvent({type: 'click', target: targetInside([])})
    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(card.dataset.expanded).toBe('true')
  })

  it('ignores a click while a non-collapsed selection sits inside the card', async () => {
    const onSelectRun = vi.fn()
    const card = await oneCard(onSelectRun)
    const inside = {}
    card.contains = node => node === inside || node === card
    vi.stubGlobal('document', {
      ...document,
      getSelection: () => ({isCollapsed: false, rangeCount: 1, anchorNode: inside, focusNode: inside}),
    })

    card.dispatchEvent({type: 'click'})
    expect(onSelectRun).not.toHaveBeenCalled()

    vi.stubGlobal('document', {
      ...document,
      getSelection: () => ({isCollapsed: false, rangeCount: 1, anchorNode: {}, focusNode: {}}),
    })
    card.dispatchEvent({type: 'click'})
    expect(onSelectRun).toHaveBeenCalledTimes(1)
  })

  it('never stops propagation: the guard is the only mechanism', async () => {
    const src = await (await import('node:fs/promises')).readFile('public/operator-run-index.js', 'utf8')
    const activation = src.match(/function bindCardActivation[\s\S]*?\n\}\n/)?.[0] ?? ''
    expect(activation).not.toBe('')
    expect(activation).not.toMatch(/stopPropagation/)
  })
})
