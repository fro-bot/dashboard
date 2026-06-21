/**
 * Pure core tests for public/operator-launch.js.
 *
 * Imports directly from public/operator-launch.js (plain ESM, no TS syntax).
 * Vitest runs in Node 24 and can import .js ESM files directly.
 *
 * Security invariants tested:
 * - submitLaunch: happy path, CSRF retry (same key reused), no retry on 404/429.
 * - All post-submit 400s map to one generic failure outcome (no oracle).
 * - mintIdempotencyKey returns unique non-empty strings.
 * - buildPendingCardHooks returns the right runId + selectors.
 * - No DOM access at module top-level (safe to import in Node).
 */

import type {LaunchClient} from '../public/operator-launch.js'
import {describe, expect, it} from 'vitest'
import {buildPendingCardHooks, mintIdempotencyKey, submitLaunch} from '../public/operator-launch.js'

// ---------------------------------------------------------------------------
// Fake client builder
// ---------------------------------------------------------------------------

type CsrfResult = {success: true; csrfToken: string} | {success: false; status: number}
type LaunchResult = {success: true; runId: string} | {success: false; status: number}

interface FakeClientOpts {
  csrfResults?: CsrfResult[]
  launchResults?: LaunchResult[]
}

interface FakeClient extends LaunchClient {
  readonly csrfCallCount: number
  readonly launchCallCount: number
  readonly launchCallArgs: {repo: string; prompt: string; csrfToken: string; idempotencyKey: string}[]
}

function makeFakeClient(opts: FakeClientOpts = {}): FakeClient {
  const csrfResults: CsrfResult[] = opts.csrfResults ?? [{success: true, csrfToken: 'tok-1'}]
  const launchResults: LaunchResult[] = opts.launchResults ?? [{success: true, runId: 'run-abc-001'}]

  let csrfIdx = 0
  let launchIdx = 0
  const launchCallArgs: {repo: string; prompt: string; csrfToken: string; idempotencyKey: string}[] = []

  return {
    get csrfCallCount() { return csrfIdx },
    get launchCallCount() { return launchIdx },
    launchCallArgs,

    async refreshCsrf() {
      const r = csrfResults[csrfIdx] ?? csrfResults.at(-1)
      csrfIdx++
      if (r !== undefined && r.success) {
        return {success: true as const, data: {csrfToken: r.csrfToken}}
      }
      const status = (r !== undefined && !r.success) ? r.status : 500
      return {success: false as const, error: {kind: 'http', status}}
    },

    async launchRun(req) {
      launchCallArgs.push({...req})
      const r = launchResults[launchIdx] ?? launchResults.at(-1)
      launchIdx++
      if (r !== undefined && r.success) {
        return {success: true as const, data: {runId: r.runId}}
      }
      const status = (r !== undefined && !r.success) ? r.status : 400
      return {success: false as const, error: {kind: 'http', status}}
    },
  }
}

// ---------------------------------------------------------------------------
// submitLaunch — happy path
// ---------------------------------------------------------------------------

describe('submitLaunch — happy path', () => {
  it('refreshCsrf ok → launchRun 202 → launched outcome with runId', async () => {
    const client = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-happy'}],
      launchResults: [{success: true, runId: 'run-happy-001'}],
    })
    const key = 'key-happy-001'
    const outcome = await submitLaunch(client, {repo: 'owner/repo', prompt: 'do the thing'}, key)
    expect(outcome.kind).toBe('launched')
    if (outcome.kind === 'launched') {
      expect(outcome.runId).toBe('run-happy-001')
    }
    expect(client.csrfCallCount).toBe(1)
    expect(client.launchCallCount).toBe(1)
  })

  it('passes the idempotency key and csrf token to launchRun', async () => {
    const client = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-check'}],
      launchResults: [{success: true, runId: 'run-check-001'}],
    })
    const key = 'key-check-001'
    await submitLaunch(client, {repo: 'owner/repo', prompt: 'check args'}, key)
    expect(client.launchCallArgs[0]?.csrfToken).toBe('tok-check')
    expect(client.launchCallArgs[0]?.idempotencyKey).toBe('key-check-001')
    expect(client.launchCallArgs[0]?.repo).toBe('owner/repo')
  })
})

// ---------------------------------------------------------------------------
// submitLaunch — CSRF retry (same idempotency key reused)
// ---------------------------------------------------------------------------

describe('submitLaunch — CSRF retry', () => {
  it('400 on first launchRun → refreshCsrf + retry ONCE reusing the SAME idempotency key → launched', async () => {
    const client = makeFakeClient({
      csrfResults: [
        {success: true, csrfToken: 'tok-first'},
        {success: true, csrfToken: 'tok-retry'},
      ],
      launchResults: [
        {success: false, status: 400},
        {success: true, runId: 'run-retry-001'},
      ],
    })
    const key = 'key-retry-001'
    const outcome = await submitLaunch(client, {repo: 'owner/repo', prompt: 'retry me'}, key)

    expect(outcome.kind).toBe('launched')
    if (outcome.kind === 'launched') {
      expect(outcome.runId).toBe('run-retry-001')
    }

    // CSRF was refreshed twice: once before first attempt, once for retry
    expect(client.csrfCallCount).toBe(2)
    // launchRun was called exactly twice
    expect(client.launchCallCount).toBe(2)

    // CRITICAL: both launchRun calls used the SAME idempotency key
    expect(client.launchCallArgs[0]?.idempotencyKey).toBe(key)
    expect(client.launchCallArgs[1]?.idempotencyKey).toBe(key)

    // The retry used the refreshed CSRF token
    expect(client.launchCallArgs[0]?.csrfToken).toBe('tok-first')
    expect(client.launchCallArgs[1]?.csrfToken).toBe('tok-retry')
  })

  it('400 on first launchRun → retry → 400 again → generic failure (no third attempt)', async () => {
    const client = makeFakeClient({
      csrfResults: [
        {success: true, csrfToken: 'tok-first'},
        {success: true, csrfToken: 'tok-retry'},
      ],
      launchResults: [
        {success: false, status: 400},
        {success: false, status: 400},
      ],
    })
    const key = 'key-double-400'
    const outcome = await submitLaunch(client, {repo: 'owner/repo', prompt: 'double fail'}, key)

    expect(outcome.kind).toBe('failure')
    // No third attempt
    expect(client.launchCallCount).toBe(2)
    // Same key on both calls
    expect(client.launchCallArgs[0]?.idempotencyKey).toBe(key)
    expect(client.launchCallArgs[1]?.idempotencyKey).toBe(key)
  })

  it('no-oracle: a 400 outcome is the same generic failure regardless of underlying cause', async () => {
    // Two different 400 scenarios — both must produce {kind:'failure'} with no cause
    const client1 = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-a'}, {success: true, csrfToken: 'tok-a2'}],
      launchResults: [{success: false, status: 400}, {success: false, status: 400}],
    })
    const client2 = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-b'}, {success: true, csrfToken: 'tok-b2'}],
      launchResults: [{success: false, status: 400}, {success: false, status: 400}],
    })

    const outcome1 = await submitLaunch(client1, {repo: 'owner/repo', prompt: 'p1'}, 'k1')
    const outcome2 = await submitLaunch(client2, {repo: 'owner/repo', prompt: 'p2'}, 'k2')

    // Both must be the same generic failure shape — no cause field
    expect(outcome1.kind).toBe('failure')
    expect(outcome2.kind).toBe('failure')
    expect(outcome1).toEqual(outcome2)
  })
})

// ---------------------------------------------------------------------------
// submitLaunch — no retry on 404 / 429
// ---------------------------------------------------------------------------

describe('submitLaunch — no retry on 404 or 429', () => {
  it('404 → not-found outcome, launchRun called exactly once', async () => {
    const client = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-404'}],
      launchResults: [{success: false, status: 404}],
    })
    const outcome = await submitLaunch(client, {repo: 'owner/repo', prompt: 'not found'}, 'key-404')

    expect(outcome.kind).toBe('not-found')
    expect(client.launchCallCount).toBe(1)
    // No second CSRF refresh
    expect(client.csrfCallCount).toBe(1)
  })

  it('404 outcome has no cause field (uniform, no oracle)', async () => {
    const client = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-404b'}],
      launchResults: [{success: false, status: 404}],
    })
    const outcome = await submitLaunch(client, {repo: 'owner/repo', prompt: 'not found 2'}, 'key-404b')

    expect(outcome.kind).toBe('not-found')
    // Must not carry any cause/status/message field
    expect('cause' in outcome).toBe(false)
    expect('status' in outcome).toBe(false)
    expect('message' in outcome).toBe(false)
  })

  it('429 → rate-limited outcome, launchRun called exactly once', async () => {
    const client = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-429'}],
      launchResults: [{success: false, status: 429}],
    })
    const outcome = await submitLaunch(client, {repo: 'owner/repo', prompt: 'rate limited'}, 'key-429')

    expect(outcome.kind).toBe('rate-limited')
    expect(client.launchCallCount).toBe(1)
    expect(client.csrfCallCount).toBe(1)
  })

  it('network error → failure outcome, launchRun called exactly once', async () => {
    const client = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-net'}],
      launchResults: [{success: false, status: 0}],
    })
    const outcome = await submitLaunch(client, {repo: 'owner/repo', prompt: 'network fail'}, 'key-net')

    // Non-400/404/429 errors → failure
    expect(outcome.kind).toBe('failure')
    expect(client.launchCallCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// submitLaunch — refreshCsrf failure
// ---------------------------------------------------------------------------

describe('submitLaunch — refreshCsrf failure', () => {
  it('refreshCsrf failure → failure outcome, launchRun never called', async () => {
    const client = makeFakeClient({
      csrfResults: [{success: false, status: 401}],
      launchResults: [],
    })
    const outcome = await submitLaunch(client, {repo: 'owner/repo', prompt: 'csrf fail'}, 'key-csrf-fail')

    expect(outcome.kind).toBe('failure')
    expect(client.launchCallCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// mintIdempotencyKey
// ---------------------------------------------------------------------------

describe('mintIdempotencyKey', () => {
  it('returns a non-empty string', () => {
    const key = mintIdempotencyKey()
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
  })

  it('returns unique values on successive calls', () => {
    const keys = new Set(Array.from({length: 20}, () => mintIdempotencyKey()))
    expect(keys.size).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// buildPendingCardHooks
// ---------------------------------------------------------------------------

describe('buildPendingCardHooks', () => {
  it('returns the runId and the expected selectors', () => {
    const hooks = buildPendingCardHooks('run-test-001')
    expect(hooks.runId).toBe('run-test-001')
    expect(typeof hooks.statusElSelector).toBe('string')
    expect(typeof hooks.noticeElSelector).toBe('string')
    expect(hooks.statusElSelector.length).toBeGreaterThan(0)
    expect(hooks.noticeElSelector.length).toBeGreaterThan(0)
  })

  it('statusElSelector targets the run-status role within the card', () => {
    const hooks = buildPendingCardHooks('run-test-002')
    // Must reference data-role="run-status" (the per-card status element)
    expect(hooks.statusElSelector).toContain('run-status')
  })

  it('noticeElSelector targets the shared stream-status notice', () => {
    const hooks = buildPendingCardHooks('run-test-003')
    // Must reference data-role="stream-status" (the shared notice element)
    expect(hooks.noticeElSelector).toContain('stream-status')
  })

  it('different runIds produce hooks with the same selector shape', () => {
    const hooks1 = buildPendingCardHooks('run-aaa')
    const hooks2 = buildPendingCardHooks('run-bbb')
    expect(hooks1.statusElSelector).toBe(hooks2.statusElSelector)
    expect(hooks1.noticeElSelector).toBe(hooks2.noticeElSelector)
    expect(hooks1.runId).not.toBe(hooks2.runId)
  })
})

// ---------------------------------------------------------------------------
// No DOM access at module top-level (safe to import in Node)
// ---------------------------------------------------------------------------

describe('module-level safety', () => {
  it('importing operator-launch.js in Node does not throw (no DOM access at top level)', () => {
    // The fact that this test file imported the module without error proves this.
    // If the module touched document/window at top-level, the import would have thrown.
    expect(true).toBe(true)
  })
})
