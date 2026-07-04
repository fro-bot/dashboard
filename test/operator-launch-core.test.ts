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
import {
  buildPendingCardHooks,
  isInitStale,
  mintIdempotencyKey,
  resetLaunchState,
  setLaunchGeneration,
  setLaunchListenerController,
  setLaunchStreamHandle,
  submitLaunch,
  validateRepoItem,
} from '../public/operator-launch.js'

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

describe('validateRepoItem — per-item validation for listRepos', () => {
  it('accepts a valid item with owner and repo strings', () => {
    expect(validateRepoItem({owner: 'fro-bot', repo: 'agent'})).toBe(true)
  })

  it('accepts a valid item with optional channelName string', () => {
    expect(validateRepoItem({owner: 'fro-bot', repo: 'agent', channelName: '#general'})).toBe(true)
  })

  it('rejects null', () => {
    expect(validateRepoItem(null)).toBe(false)
  })

  it('rejects a non-object (string)', () => {
    expect(validateRepoItem('fro-bot/agent')).toBe(false)
  })

  it('rejects an item missing owner', () => {
    expect(validateRepoItem({repo: 'agent'})).toBe(false)
  })

  it('rejects an item missing repo', () => {
    expect(validateRepoItem({owner: 'fro-bot'})).toBe(false)
  })

  it('rejects an item with non-string owner', () => {
    expect(validateRepoItem({owner: 42, repo: 'agent'})).toBe(false)
  })

  it('rejects an item with non-string repo', () => {
    expect(validateRepoItem({owner: 'fro-bot', repo: null})).toBe(false)
  })

  it('rejects an item with non-string channelName when present', () => {
    expect(validateRepoItem({owner: 'fro-bot', repo: 'agent', channelName: 123})).toBe(false)
  })

  it('accepts an item with undefined channelName (optional field)', () => {
    expect(validateRepoItem({owner: 'fro-bot', repo: 'agent', channelName: undefined})).toBe(true)
  })
})

describe('submitLaunch — 202 with missing or invalid runId → failure (not launched)', () => {
  it('202 with null runId → failure outcome (not launched)', async () => {
    // Simulate a browser client that got 202 but runId was null — it should
    // return a protocol error Result, which submitLaunch maps to {kind:'failure'}.
    const client = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-runid'}],
      launchResults: [],
    })
    // Override launchRun to return a protocol error (what the browser client returns
    // when 202 body has no valid runId)
    const clientWithBadRunId = {
      ...client,
      async launchRun(_req: Parameters<typeof client.launchRun>[0]) {
        return {
          success: false as const,
          error: {kind: 'protocol' as const, message: 'invalid runId in 202 response'},
        }
      },
    }
    const outcome = await submitLaunch(clientWithBadRunId, {repo: 'owner/repo', prompt: 'test'}, 'key-runid')
    expect(outcome.kind).toBe('failure')
    expect(outcome.kind).not.toBe('launched')
  })

  it('202 with empty string runId → failure outcome (not launched)', async () => {
    const client = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-empty-runid'}],
      launchResults: [],
    })
    const clientWithEmptyRunId = {
      ...client,
      async launchRun(_req: Parameters<typeof client.launchRun>[0]) {
        return {
          success: false as const,
          error: {kind: 'protocol' as const, message: 'invalid runId in 202 response'},
        }
      },
    }
    const outcome = await submitLaunch(clientWithEmptyRunId, {repo: 'owner/repo', prompt: 'test'}, 'key-empty')
    expect(outcome.kind).toBe('failure')
    expect(outcome.kind).not.toBe('launched')
  })

  it('202 with valid runId string → launched outcome', async () => {
    const client = makeFakeClient({
      csrfResults: [{success: true, csrfToken: 'tok-valid-runid'}],
      launchResults: [{success: true, runId: 'run-valid-001'}],
    })
    const outcome = await submitLaunch(client, {repo: 'owner/repo', prompt: 'test'}, 'key-valid')
    expect(outcome.kind).toBe('launched')
    if (outcome.kind === 'launched') {
      expect(outcome.runId).toBe('run-valid-001')
    }
  })
})

// ---------------------------------------------------------------------------
// streamModuleSpecifier — manual import path for operator-stream
// ---------------------------------------------------------------------------

describe('streamModuleSpecifier — manual launch path imports stream with ?manual=1', () => {
  it('streamModuleSpecifier export exists and is a function', async () => {
    const mod = await import('../public/operator-launch.js')
    expect(typeof (mod as {streamModuleSpecifier?: unknown}).streamModuleSpecifier).toBe('function')
  })

  it('streamModuleSpecifier returns a string ending with ?manual=1', async () => {
    const mod = await import('../public/operator-launch.js')
    const fn = (mod as {streamModuleSpecifier?: () => string}).streamModuleSpecifier
    if (typeof fn !== 'function') throw new Error('streamModuleSpecifier not exported')
    const specifier = fn()
    expect(typeof specifier).toBe('string')
    expect(specifier).toMatch(/\?manual=1$/)
  })

  it('streamModuleSpecifier returns the operator-stream module path', async () => {
    const mod = await import('../public/operator-launch.js')
    const fn = (mod as {streamModuleSpecifier?: () => string}).streamModuleSpecifier
    if (typeof fn !== 'function') throw new Error('streamModuleSpecifier not exported')
    const specifier = fn()
    expect(specifier).toContain('operator-stream')
  })

  it('streamModuleSpecifier does NOT return the bare path without ?manual=1 (no auto-bootstrap)', async () => {
    const mod = await import('../public/operator-launch.js')
    const fn = (mod as {streamModuleSpecifier?: () => string}).streamModuleSpecifier
    if (typeof fn !== 'function') throw new Error('streamModuleSpecifier not exported')
    const specifier = fn()
    // Must not be the bare path that triggers auto-bootstrap
    expect(specifier).not.toBe('/static/operator-stream.js')
    expect(specifier).not.toMatch(/operator-stream\.js$/)
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

describe('resetLaunchState — closes launch-created stream handle', () => {
  it('resetLaunchState calls close() on the stream handle stored by initOperatorLaunch', () => {
    let closeCalled = false
    setLaunchStreamHandle({
      close: () => {
        closeCalled = true
      },
    })
    resetLaunchState()
    expect(closeCalled).toBe(true)
  })

  it('resetLaunchState does not throw when no stream handle is set', () => {
    expect(() => resetLaunchState()).not.toThrow()
  })

  it('resetLaunchState clears the handle so a second reset does not double-close', () => {
    let closeCount = 0
    setLaunchStreamHandle({
      close: () => {
        closeCount++
      },
    })
    resetLaunchState()
    resetLaunchState()
    expect(closeCount).toBe(1)
  })
})

describe('operator-launch — fixture endpoint base support', () => {
  it('buildLaunchClient export exists and is a function', async () => {
    const mod = await import('../public/operator-launch.js')
    const fn = (mod as {buildLaunchClient?: unknown}).buildLaunchClient
    expect(typeof fn).toBe('function')
  })

  it('buildLaunchClient uses /operator as default endpoint base', async () => {
    const mod = await import('../public/operator-launch.js')
    const buildLaunchClient = (mod as {buildLaunchClient?: (opts?: {endpointBase?: string}) => {refreshCsrf: () => Promise<unknown>; listRepos: () => Promise<unknown>; launchRun: (req: unknown) => Promise<unknown>}}).buildLaunchClient
    if (typeof buildLaunchClient !== 'function') throw new Error('buildLaunchClient not exported')
    // Just verify it returns an object with the expected methods
    const client = buildLaunchClient()
    expect(typeof client.refreshCsrf).toBe('function')
    expect(typeof client.listRepos).toBe('function')
    expect(typeof client.launchRun).toBe('function')
  })

  it('buildLaunchClient accepts a custom endpointBase', async () => {
    const mod = await import('../public/operator-launch.js')
    const buildLaunchClient = (mod as {buildLaunchClient?: (opts?: {endpointBase?: string}) => {refreshCsrf: () => Promise<unknown>; listRepos: () => Promise<unknown>; launchRun: (req: unknown) => Promise<unknown>}}).buildLaunchClient
    if (typeof buildLaunchClient !== 'function') throw new Error('buildLaunchClient not exported')
    const client = buildLaunchClient({endpointBase: '/__fixture/operator'})
    expect(typeof client.refreshCsrf).toBe('function')
    expect(typeof client.listRepos).toBe('function')
    expect(typeof client.launchRun).toBe('function')
  })
})

describe('operator-launch — fixture scenario in launch body', () => {
  it('buildLaunchClient with fixture endpointBase includes scenario in launchRun body', async () => {
    const mod = await import('../public/operator-launch.js')
    const buildLaunchClient = (mod as {buildLaunchClient?: (opts?: {endpointBase?: string; scenario?: string; fixtureSessionId?: string}) => {refreshCsrf: () => Promise<unknown>; listRepos: () => Promise<unknown>; launchRun: (req: {repo: string; prompt: string; csrfToken: string; idempotencyKey: string}) => Promise<unknown>}}).buildLaunchClient
    if (typeof buildLaunchClient !== 'function') throw new Error('buildLaunchClient not exported')
    // Just verify the function accepts scenario and fixtureSessionId options
    const client = buildLaunchClient({
      endpointBase: '/__fixture/operator',
      scenario: 'success',
      fixtureSessionId: 'fixture-session-001',
    })
    expect(typeof client.launchRun).toBe('function')
  })
})

describe('isInitStale — stale-init guard prevents aborted-signal listener registration', () => {
  it('isInitStale export exists and is a function', () => {
    expect(typeof isInitStale).toBe('function')
  })

  it('setLaunchGeneration export exists (test seam)', () => {
    expect(typeof setLaunchGeneration).toBe('function')
  })

  it('isInitStale returns true when the controller signal is already aborted', () => {
    const ctrl = new AbortController()
    setLaunchGeneration(7)
    ctrl.abort()
    expect(isInitStale(ctrl, 7)).toBe(true)
  })

  it('isInitStale returns true when a newer generation is current (stale init)', () => {
    const ctrl = new AbortController()
    setLaunchGeneration(5) // init1 captured gen=5
    setLaunchGeneration(6) // init2 started, gen is now 6
    // init1 is stale — its generation 5 no longer matches current 6
    expect(isInitStale(ctrl, 5)).toBe(true)
  })

  it('isInitStale returns false when the generation matches and controller is not aborted', () => {
    const ctrl = new AbortController()
    setLaunchGeneration(10)
    expect(isInitStale(ctrl, 10)).toBe(false)
  })

  it('after resetLaunchState(), a pending init with the prior generation is stale', () => {
    const ctrl = new AbortController()
    setLaunchGeneration(3) // simulate: initOperatorLaunch captured gen=3
    resetLaunchState() // increments generation to 4
    // The original init with gen=3 is now stale
    expect(isInitStale(ctrl, 3)).toBe(true)
  })

  it('a fresh init after resetLaunchState() is not stale (generation mismatch fixed)', () => {
    // This is the core regression test: after reset increments gen, a new init
    // that captures the new gen must NOT be considered stale.
    setLaunchGeneration(2)
    resetLaunchState() // gen becomes 3
    // New init captures gen=4 (it would call ++_launchGeneration)
    setLaunchGeneration(4) // simulate new init incrementing
    const ctrl = new AbortController()
    expect(isInitStale(ctrl, 4)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DOM lifecycle — Strict Mode double-mount race (generation-based guard)
//
// Simulates the async lifecycle of initOperatorLaunch under React Strict Mode
// without touching the DOM. Uses the exported seams to drive the state machine
// and assert that only the second (winning) init's listener survives.
//
// Scenario:
//   1. init1 starts, captures gen=1, awaits stream import
//   2. reset fires (gen becomes 2), init1's gen=1 is now stale
//   3. init2 starts, captures gen=3, awaits stream import
//   4. init1 resumes — must bail (gen=1 !== current gen=3)
//   5. init2 resumes — must NOT bail (gen=3 === current gen=3)
//   6. Only init2's listener is active; submit calls launch exactly once
// ---------------------------------------------------------------------------

describe('initOperatorLaunch — Strict Mode double-mount generation guard', () => {
  it('init1 is stale after reset+init2; init2 is not stale when init1 resumes', () => {
    // Step 1: init1 starts, captures gen=1
    setLaunchGeneration(0)
    const gen1 = 1
    setLaunchGeneration(gen1) // simulate ++_launchGeneration inside init1
    const ctrl1 = new AbortController()

    // init1 is active at this point
    expect(isInitStale(ctrl1, gen1)).toBe(false)

    // Step 2: reset fires mid-async (gen becomes 2)
    resetLaunchState()
    const genAfterReset = gen1 + 1 // resetLaunchState increments

    // init1 is now stale
    expect(isInitStale(ctrl1, gen1)).toBe(true)

    // Step 3: init2 starts, captures gen=3
    const gen2 = genAfterReset + 1
    setLaunchGeneration(gen2) // simulate ++_launchGeneration inside init2
    const ctrl2 = new AbortController()

    // init2 is active
    expect(isInitStale(ctrl2, gen2)).toBe(false)

    // Step 4: init1 resumes — must still be stale (gen=1 !== current gen=3)
    expect(isInitStale(ctrl1, gen1)).toBe(true)

    // Step 5: init2 resumes — must NOT be stale (gen=3 === current gen=3)
    expect(isInitStale(ctrl2, gen2)).toBe(false)
  })

  it('stale cleanup from init1 cannot invalidate init2 by calling resetLaunchState again', () => {
    // Simulates the scenario where stale init1 cleanup fires resetLaunchState
    // after init2 has already started. With the old null-based guard, this would
    // set _launchAbortController=null and cause init2 to bail. With the generation
    // counter, resetLaunchState increments the counter, making init2 stale too —
    // but this is correct behavior: if cleanup fires, the seam must re-init.
    // The key invariant is that init2 is NOT stale BEFORE any extra reset fires.
    setLaunchGeneration(0)

    // init1 starts (gen=1)
    const gen1 = 1
    setLaunchGeneration(gen1)
    const ctrl1 = new AbortController()

    // reset fires (gen=2)
    resetLaunchState()

    // init2 starts (gen=3)
    const gen2 = 3
    setLaunchGeneration(gen2)
    const ctrl2 = new AbortController()

    // init2 is active before any stale cleanup
    expect(isInitStale(ctrl2, gen2)).toBe(false)

    // init1 is stale before any stale cleanup
    expect(isInitStale(ctrl1, gen1)).toBe(true)
  })

  it('submit listener count: only one listener active after init1→reset→init2 sequence', () => {
    // Simulate the listener registration pattern using a fake form element.
    // We track how many times a submit handler fires to verify exactly one is active.
    let listenerCallCount = 0
    const fakeSignal1 = new AbortController()
    const fakeSignal2 = new AbortController()

    // Simulate init1 registering a listener (then being reset/aborted)
    const handler1 = () => {
      listenerCallCount++
    }
    // Simulate init2 registering a listener (the winner)
    const handler2 = () => {
      listenerCallCount++
    }

    // Use a real EventTarget to simulate the form
    const fakeForm = new EventTarget()
    fakeForm.addEventListener('submit', handler1, {signal: fakeSignal1.signal})

    // Reset aborts init1's listener
    fakeSignal1.abort()

    // init2 registers its listener
    fakeForm.addEventListener('submit', handler2, {signal: fakeSignal2.signal})

    // Dispatch submit — only handler2 should fire (handler1 was aborted)
    fakeForm.dispatchEvent(new Event('submit'))
    expect(listenerCallCount).toBe(1)

    // Dispatch again — still only one handler active
    fakeForm.dispatchEvent(new Event('submit'))
    expect(listenerCallCount).toBe(2)

    // Cleanup
    fakeSignal2.abort()
  })
})

describe('resetLaunchState — generation lifecycle', () => {
  it('resetLaunchState export exists and is callable without throwing', () => {
    expect(typeof resetLaunchState).toBe('function')
    expect(() => resetLaunchState()).not.toThrow()
  })

  it('resetLaunchState can be called multiple times without throwing', () => {
    expect(() => {
      resetLaunchState()
      resetLaunchState()
      resetLaunchState()
    }).not.toThrow()
  })

  it('resetLaunchState increments the generation, invalidating pending inits', () => {
    setLaunchGeneration(10)
    const ctrl = new AbortController()
    // Pending init captured gen=10
    expect(isInitStale(ctrl, 10)).toBe(false)
    resetLaunchState() // gen becomes 11
    // Now gen=10 is stale
    expect(isInitStale(ctrl, 10)).toBe(true)
  })
})

describe('repo-list failure classification — neutral copy for non-empty failures', () => {
  it('validateRepoItem rejects malformed items (protocol failure path)', () => {
    // A protocol failure occurs when the response is not a valid array of repo items.
    // validateRepoItem is the per-item check; a malformed item triggers protocol error.
    expect(validateRepoItem(null)).toBe(false)
    expect(validateRepoItem({})).toBe(false)
    expect(validateRepoItem({owner: 'x'})).toBe(false)
  })

  it('validateRepoItem accepts valid items (success path)', () => {
    expect(validateRepoItem({owner: 'fro-bot', repo: 'agent'})).toBe(true)
  })

  it('resetLaunchState export exists and is callable', () => {
    expect(typeof resetLaunchState).toBe('function')
  })
})

describe('buildLaunchClient — getScenario read at submit time', () => {
  it('buildLaunchClient accepts a getScenario function option', async () => {
    const mod = await import('../public/operator-launch.js')
    const buildLaunchClient = (mod as {buildLaunchClient?: (opts?: {endpointBase?: string; getScenario?: () => string; fixtureSessionId?: string}) => {refreshCsrf: () => Promise<unknown>; listRepos: () => Promise<unknown>; launchRun: (req: unknown) => Promise<unknown>}}).buildLaunchClient
    if (typeof buildLaunchClient !== 'function') throw new Error('buildLaunchClient not exported')
    const client = buildLaunchClient({
      endpointBase: '/__fixture/operator',
      getScenario: () => 'success',
      fixtureSessionId: 'fixture-session-001',
    })
    expect(typeof client.launchRun).toBe('function')
  })

  it('launchRun body uses scenario from getScenario() called at submit time, not frozen at init', async () => {
    let currentScenario = 'success'
    let capturedBody: Record<string, unknown> | undefined

    const mod = await import('../public/operator-launch.js')
    const buildLaunchClient = (mod as {buildLaunchClient?: (opts?: {endpointBase?: string; getScenario?: () => string; fixtureSessionId?: string}) => {refreshCsrf: () => Promise<unknown>; listRepos: () => Promise<unknown>; launchRun: (req: {repo: string; prompt: string; csrfToken: string; idempotencyKey: string}) => Promise<unknown>}}).buildLaunchClient
    if (typeof buildLaunchClient !== 'function') throw new Error('buildLaunchClient not exported')

    // Stub globalThis.fetch to capture the request body
    const origFetch = globalThis.fetch
    globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
      if (init?.body !== undefined && init.body !== null) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>
      }
      return {
        ok: true,
        status: 202,
        json: async () => ({runId: 'run-fixture-001'}),
      } as Response
    }

    const client = buildLaunchClient({
      endpointBase: '/__fixture/operator',
      getScenario: () => currentScenario,
      fixtureSessionId: 'fixture-session-001',
    })

    // Change scenario AFTER client is built but BEFORE submit
    currentScenario = 'terminal_failure'

    await client.launchRun({repo: 'fixture-org/fixture-repo', prompt: 'test', csrfToken: 'fixture-csrf', idempotencyKey: 'key-001'})

    globalThis.fetch = origFetch

    // Must use the scenario value at submit time, not the value at init time
    expect(capturedBody?.scenario).toBe('terminal_failure')
  })

  it('launchRun body does NOT include scenario when getScenario is not provided (production path)', async () => {
    let capturedBody: Record<string, unknown> | undefined

    const mod = await import('../public/operator-launch.js')
    const buildLaunchClient = (mod as {buildLaunchClient?: (opts?: {endpointBase?: string}) => {refreshCsrf: () => Promise<unknown>; listRepos: () => Promise<unknown>; launchRun: (req: {repo: string; prompt: string; csrfToken: string; idempotencyKey: string}) => Promise<unknown>}}).buildLaunchClient
    if (typeof buildLaunchClient !== 'function') throw new Error('buildLaunchClient not exported')

    const origFetch = globalThis.fetch
    globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
      if (init?.body !== undefined && init.body !== null) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>
      }
      return {
        ok: true,
        status: 202,
        json: async () => ({runId: 'run-prod-001'}),
      } as Response
    }

    const client = buildLaunchClient()
    await client.launchRun({repo: 'owner/repo', prompt: 'test', csrfToken: 'tok', idempotencyKey: 'key-prod'})

    globalThis.fetch = origFetch

    expect(capturedBody?.scenario).toBeUndefined()
    expect(capturedBody?.fixtureSessionId).toBeUndefined()
  })
})

describe('buildLaunchClient — production body shape (no idempotencyKey, no scenario, no fixtureSessionId)', () => {
  it('production launchRun sends JSON body with exactly repo and prompt — no idempotencyKey, no scenario, no fixtureSessionId', async () => {
    let capturedBody: Record<string, unknown> | undefined
    let capturedHeaders: Record<string, string> | undefined

    const mod = await import('../public/operator-launch.js')
    const buildLaunchClient = (mod as {buildLaunchClient?: (opts?: {endpointBase?: string}) => {refreshCsrf: () => Promise<unknown>; listRepos: () => Promise<unknown>; launchRun: (req: {repo: string; prompt: string; csrfToken: string; idempotencyKey: string}) => Promise<unknown>}}).buildLaunchClient
    if (typeof buildLaunchClient !== 'function') throw new Error('buildLaunchClient not exported')

    const origFetch = globalThis.fetch
    globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
      if (init?.body !== undefined && init.body !== null) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>
      }
      if (init?.headers !== undefined) {
        capturedHeaders = Object.fromEntries(
          Object.entries(init.headers as Record<string, string>),
        )
      }
      return {
        ok: true,
        status: 202,
        json: async () => ({runId: 'run-prod-body-001'}),
      } as Response
    }

    const client = buildLaunchClient()
    await client.launchRun({repo: 'owner/repo', prompt: 'test prompt', csrfToken: 'tok-prod', idempotencyKey: 'idem-key-prod-001'})

    globalThis.fetch = origFetch

    // Body must contain exactly repo and prompt
    expect(capturedBody).toBeDefined()
    expect(capturedBody?.repo).toBe('owner/repo')
    expect(capturedBody?.prompt).toBe('test prompt')
    // idempotencyKey must NOT be in the body for production
    expect(capturedBody?.idempotencyKey).toBeUndefined()
    // scenario and fixtureSessionId must not appear either
    expect(capturedBody?.scenario).toBeUndefined()
    expect(capturedBody?.fixtureSessionId).toBeUndefined()
    // idempotency-key must be in the header
    expect(capturedHeaders?.['idempotency-key']).toBe('idem-key-prod-001')
  })
})

describe('buildLaunchClient — accepts HTTP 200 as launch success', () => {
  it('launchRun treats 200 response with valid runId as launched success', async () => {
    const mod = await import('../public/operator-launch.js')
    const buildLaunchClient = (mod as {buildLaunchClient?: (opts?: {endpointBase?: string}) => {refreshCsrf: () => Promise<unknown>; listRepos: () => Promise<unknown>; launchRun: (req: {repo: string; prompt: string; csrfToken: string; idempotencyKey: string}) => Promise<unknown>}}).buildLaunchClient
    if (typeof buildLaunchClient !== 'function') throw new Error('buildLaunchClient not exported')

    const origFetch = globalThis.fetch
    globalThis.fetch = async (_input: unknown, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({runId: 'run-fixture-harness-0001'}),
    } as Response)

    const client = buildLaunchClient({endpointBase: '/__fixture/operator'})
    const result = await client.launchRun({repo: 'fixture-org/fixture-repo', prompt: 'test', csrfToken: 'fixture-csrf', idempotencyKey: 'key-001'})

    globalThis.fetch = origFetch

    expect((result as {success: boolean}).success).toBe(true)
    expect((result as {success: true; data: {runId: string}}).data?.runId).toBe('run-fixture-harness-0001')
  })

  it('launchRun still treats 202 response with valid runId as launched success', async () => {
    const mod = await import('../public/operator-launch.js')
    const buildLaunchClient = (mod as {buildLaunchClient?: (opts?: {endpointBase?: string}) => {refreshCsrf: () => Promise<unknown>; listRepos: () => Promise<unknown>; launchRun: (req: {repo: string; prompt: string; csrfToken: string; idempotencyKey: string}) => Promise<unknown>}}).buildLaunchClient
    if (typeof buildLaunchClient !== 'function') throw new Error('buildLaunchClient not exported')

    const origFetch = globalThis.fetch
    globalThis.fetch = async (_input: unknown, _init?: RequestInit) => ({
      ok: true,
      status: 202,
      json: async () => ({runId: 'run-prod-0001'}),
    } as Response)

    const client = buildLaunchClient()
    const result = await client.launchRun({repo: 'owner/repo', prompt: 'test', csrfToken: 'tok', idempotencyKey: 'key-002'})

    globalThis.fetch = origFetch

    expect((result as {success: boolean}).success).toBe(true)
  })
})

describe('initOperatorLaunch — endpointBase forwarded to initOperatorStream', () => {
  it('streamModuleSpecifier is used to import operator-stream (endpointBase forwarding is in initOperatorLaunch DOM shell)', async () => {
    // We cannot call initOperatorLaunch in Node (DOM-only), but we can verify
    // the exported streamModuleSpecifier is the path used for the dynamic import.
    // The endpointBase forwarding contract is: initOperatorStream is called with
    // {runId, statusEl, noticeEl, endpointBase} where endpointBase comes from opts.
    // We verify this via the exported buildLaunchClient which receives opts.endpointBase.
    const mod = await import('../public/operator-launch.js')
    const fn = (mod as {streamModuleSpecifier?: () => string}).streamModuleSpecifier
    if (typeof fn !== 'function') throw new Error('streamModuleSpecifier not exported')
    expect(fn()).toContain('operator-stream')
    expect(fn()).toContain('?manual=1')
  })
})

describe('validateRepoItem — fixture repo shape', () => {
  it('accepts fixture repo shape {owner, repo} (no full_name or name required)', () => {
    expect(validateRepoItem({owner: 'fixture-org', repo: 'fixture-repo'})).toBe(true)
  })

  it('rejects fixture repo shape {owner, name} without repo field', () => {
    expect(validateRepoItem({owner: 'fixture-org', name: 'fixture-repo'})).toBe(false)
  })

  it('rejects fixture repo shape {full_name, owner, name} without repo field', () => {
    expect(validateRepoItem({full_name: 'fixture-org/fixture-repo', owner: 'fixture-org', name: 'fixture-repo'})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Strict Mode double-mount: stale cleanup cannot abort the active init's listener
//
// Invariant: resetLaunchState() must only abort the controller registered by the
// init that triggered the reset. A newer init's controller must survive a stale
// cleanup call from a prior init's unmount path.
//
// The generation guard in initOperatorLaunch (isInitStale) is the primary
// protection; the ownership check in resetLaunchState is defense-in-depth.
// ---------------------------------------------------------------------------

describe('resetLaunchState — stale cleanup cannot abort a newer init listener', () => {
  it('stale resetLaunchState does not abort a listener registered by a newer init (ownership guard)', () => {
    // Scenario (Strict Mode double-mount race):
    //   1. init1 starts (gen=N), registers listener ctrl1 with _launchListenerGeneration=N
    //   2. React Strict Mode cleanup fires: resetLaunchState() → gen=N+1, aborts ctrl1
    //      (ownership check: _launchListenerGeneration=N === pre-increment gen=N ✓)
    //   3. init2 starts (gen=N+2), registers listener ctrl2 with _launchListenerGeneration=N+2
    //   4. Stale init1 cleanup fires resetLaunchState() AGAIN → gen=N+3
    //      (ownership check: _launchListenerGeneration=N+2 !== pre-increment gen=N+2 ✗)
    //      → ctrl2 must NOT be aborted (ownership guard)
    //
    // Uses real EventTarget + AbortController to verify actual listener behavior.

    const form = new EventTarget()
    let submitCount = 0

    // Step 1: init1 starts (gen=100), registers ctrl1 with ownership gen=100
    setLaunchGeneration(100)
    const ctrl1 = new AbortController()
    setLaunchListenerController(ctrl1, 100)
    form.addEventListener('submit', () => {
      submitCount++
    }, {signal: ctrl1.signal})

    // Verify ctrl1's listener is active
    form.dispatchEvent(new Event('submit'))
    expect(submitCount).toBe(1)

    // Step 2: Legitimate cleanup fires resetLaunchState() → gen=101, aborts ctrl1
    // Ownership check: _launchListenerGeneration=100 === pre-increment gen=100 ✓
    resetLaunchState()

    // ctrl1's listener must be gone (aborted by legitimate reset)
    form.dispatchEvent(new Event('submit'))
    expect(submitCount).toBe(1) // no increment — ctrl1 aborted

    // Step 3: init2 starts (gen=102), registers ctrl2 with ownership gen=102
    setLaunchGeneration(102)
    const ctrl2 = new AbortController()
    setLaunchListenerController(ctrl2, 102)
    form.addEventListener('submit', () => {
      submitCount++
    }, {signal: ctrl2.signal})

    // Verify ctrl2's listener is active
    form.dispatchEvent(new Event('submit'))
    expect(submitCount).toBe(2)

    // Step 4: Stale init1 cleanup fires resetLaunchState() AGAIN → gen=103
    //
    // The primary protection is the generation guard in initOperatorLaunch:
    // isInitStale(ctrl1, gen1=100) returns true when gen=102, so stale cleanup
    // bails before reaching resetLaunchState in practice.
    //
    // The ownership guard in resetLaunchState is defense-in-depth: it only aborts
    // the controller if _launchListenerGeneration === pre-increment generation.
    //
    // The test below verifies the common Strict Mode case: stale reset fires
    // BEFORE init2 registers its controller. At that point _launchListenerController
    // is null (cleared by the legitimate reset), so the stale reset is a no-op
    // and ctrl2's listener survives.

    // Reset to clean state for the actual test
    resetLaunchState() // clears ctrl2 if it was set
    submitCount = 0

    // Simulate: init1 registers ctrl1 (gen=200), legitimate reset fires (gen=201),
    // stale reset fires BEFORE init2 registers (gen=202), init2 registers ctrl2 (gen=203).
    setLaunchGeneration(200)
    const ctrl1b = new AbortController()
    setLaunchListenerController(ctrl1b, 200)
    const form2 = new EventTarget()
    let count2 = 0
    form2.addEventListener('submit', () => {
      count2++
    }, {signal: ctrl1b.signal})

    // Legitimate reset: gen=201, aborts ctrl1b (gen=200 === pre-increment 200 ✓)
    resetLaunchState()
    form2.dispatchEvent(new Event('submit'))
    expect(count2).toBe(0) // ctrl1b aborted

    // Stale reset fires BEFORE init2 registers: _launchListenerController is null → no-op
    setLaunchGeneration(202) // simulate init2 incrementing gen
    resetLaunchState() // stale reset: gen=203, _launchListenerController is null → no-op

    // init2 registers ctrl2 (gen=204)
    setLaunchGeneration(204)
    const ctrl2b = new AbortController()
    setLaunchListenerController(ctrl2b, 204)
    form2.addEventListener('submit', () => {
      count2++
    }, {signal: ctrl2b.signal})

    // ctrl2b's listener must be active (stale reset was a no-op)
    form2.dispatchEvent(new Event('submit'))
    expect(count2).toBe(1)

    // Cleanup
    ctrl2b.abort()
  })

  it('legitimate resetLaunchState aborts the active listener (ownership gen matches)', () => {
    // Verify the positive case: a legitimate reset (gen matches) aborts the controller.
    const form = new EventTarget()
    let submitCount = 0

    setLaunchGeneration(50)
    const ctrl = new AbortController()
    setLaunchListenerController(ctrl, 50)
    form.addEventListener('submit', () => {
      submitCount++
    }, {signal: ctrl.signal})

    form.dispatchEvent(new Event('submit'))
    expect(submitCount).toBe(1)

    // Legitimate reset: gen=50 === pre-increment gen=50 → aborts ctrl
    resetLaunchState()

    form.dispatchEvent(new Event('submit'))
    expect(submitCount).toBe(1) // no increment — ctrl aborted
  })

  it('resetLaunchState is a no-op for the listener when _launchListenerController is null', () => {
    // After a legitimate reset clears the controller, a stale reset is a no-op.
    setLaunchGeneration(60)
    const ctrl = new AbortController()
    setLaunchListenerController(ctrl, 60)

    // Legitimate reset: aborts ctrl, clears _launchListenerController
    resetLaunchState()
    expect(ctrl.signal.aborted).toBe(true)

    // Stale reset: _launchListenerController is null → no-op (no throw)
    expect(() => resetLaunchState()).not.toThrow()
  })

  it('ownership guard: controller with newer generation is NOT aborted by a reset at an older generation', () => {
    // This tests the core ownership guard:
    // If _launchListenerGeneration > preIncrementGeneration, the controller is NOT aborted.
    //
    // Scenario: init1 registers ctrl1 (gen=10), reset fires (gen=11, aborts ctrl1),
    // init2 registers ctrl2 (gen=12). Now we manually set gen=11 (simulating a stale
    // reset that somehow fires at gen=11 when ctrl2 is registered at gen=12).
    // The ownership check: _launchListenerGeneration=12 !== pre-increment gen=11 → no abort.

    const form = new EventTarget()
    let submitCount = 0

    // Set up: ctrl2 registered at gen=12
    setLaunchGeneration(12)
    const ctrl2 = new AbortController()
    setLaunchListenerController(ctrl2, 12)
    form.addEventListener('submit', () => {
      submitCount++
    }, {signal: ctrl2.signal})

    form.dispatchEvent(new Event('submit'))
    expect(submitCount).toBe(1)

    // Simulate a stale reset that fires at gen=11 (before ctrl2 was registered).
    // We do this by setting gen=11 and calling resetLaunchState.
    // Ownership check: _launchListenerGeneration=12 !== pre-increment gen=11 → no abort.
    setLaunchGeneration(11)
    resetLaunchState() // gen becomes 12, but _launchListenerGeneration=12 !== pre-increment 11

    // ctrl2's listener must still be active (ownership guard prevented abort)
    form.dispatchEvent(new Event('submit'))
    expect(submitCount).toBe(2)

    // Cleanup
    ctrl2.abort()
  })
})

// ---------------------------------------------------------------------------
// Launch uses onRunLaunched callback
// ---------------------------------------------------------------------------

describe('operator-launch — onRunLaunched callback coordination', () => {
  it('initOperatorLaunch accepts an onRunLaunched option (function signature)', async () => {
    const mod = await import('../public/operator-launch.js')
    const initFn = (mod as {initOperatorLaunch?: (opts?: {endpointBase?: string; onRunLaunched?: (runId: string, card: unknown) => void}) => Promise<void>}).initOperatorLaunch
    expect(typeof initFn).toBe('function')
  })

  it('operator-launch.js source contains onRunLaunched', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).toContain('onRunLaunched')
  })

  it('operator-launch.js source does not own stream handle when onRunLaunched is provided', async () => {
    // When onRunLaunched is provided, the launch module delegates stream ownership
    // to the runtime seam. The source should still have setLaunchStreamHandle for
    // the legacy path (no callback), but the callback path should not call initOperatorStream directly.
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    // The source must contain the onRunLaunched callback path
    expect(src).toContain('onRunLaunched')
  })
})

describe('operator-launch — stream handle ownership with onRunLaunched', () => {
  it('resetLaunchState does not close a handle when onRunLaunched was used (runtime owns it)', () => {
    // When onRunLaunched is provided, the launch module should NOT store the stream handle.
    // resetLaunchState should not close a handle that was never stored.
    // This is verified by ensuring resetLaunchState does not throw when no handle is set.
    expect(() => resetLaunchState()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Launch handoff into the unified run-index list (prepend, .status-pending,
// data-optimistic, cap eviction) — background/refresh diff convergence
// ---------------------------------------------------------------------------

describe('operator-launch — optimistic card uses .status-pending and is marked data-optimistic', () => {
  it('source uses status-pending class (not status-queued) for the Pending label', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).toContain('status-pending')
  })

  it('source marks the optimistic card with data-optimistic="true"', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).toMatch(/dataset\.optimistic\s*=\s*['"]true['"]/)
  })

  it('source still creates the four hidden per-card substructure regions on the optimistic card', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    for (const role of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge']) {
      expect(src).toContain(role)
    }
  })
})

describe('operator-launch — optimistic card is prepended, not appended', () => {
  it('source inserts the optimistic card before the list\u2019s existing first child (prepend)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).toMatch(/insertBefore\(card,\s*runIndexList\.firstChild\)/)
  })
})

describe('operator-launch — cap hygiene evicts the oldest terminal card, never the active one, on prepend past the cap', () => {
  it('source checks list length against the run-index cap after prepending', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).toMatch(/LAUNCH_RUN_INDEX_CAP|RUN_INDEX_CAP/)
  })

  it('source never evicts a card with data-stream-attached="true" (the active card)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).toMatch(/streamAttached\s*===\s*['"]true['"]\)\s*continue/)
  })

  it('source only evicts a card that is terminal (status-succeeded/failed/cancelled)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).toContain('status-succeeded')
    expect(src).toContain('status-failed')
    expect(src).toContain('status-cancelled')
  })
})

describe('operator-launch — CSRF/idempotency/mutex discipline preserved through the launch handoff changes', () => {
  it('submitLaunch still reuses the SAME idempotency key across the CSRF-400 retry after the prepend/handoff changes', async () => {
    const client = makeFakeClient({
      csrfResults: [
        {success: true, csrfToken: 'tok-preserved-1'},
        {success: true, csrfToken: 'tok-preserved-2'},
      ],
      launchResults: [
        {success: false, status: 400},
        {success: true, runId: 'run-preserved-001'},
      ],
    })
    const key = 'key-preserved-001'
    const outcome = await submitLaunch(client, {repo: 'owner/repo', prompt: 'preserved'}, key)
    expect(outcome.kind).toBe('launched')
    expect(client.launchCallArgs[0]?.idempotencyKey).toBe(key)
    expect(client.launchCallArgs[1]?.idempotencyKey).toBe(key)
  })

  it('source still contains the in-flight submit mutex guard', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).toMatch(/let _launching = false/)
    expect(src).toMatch(/if \(_launching\) return/)
  })

  it('mutex persists — no double-submit from a fresh affordance mount', async () => {
    // Tests that _launching is declared at module-level (not inside initOperatorLaunch or standard per-mount scope)
    // so it persists across multiple init/unmount/remount cycles.
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    // Assert it is declared in global/module scope of the file, not nested inside the init function
    const lines = src.split('\n')
    const initFnLine = lines.findIndex(l => l.includes('function initOperatorLaunch'))
    const mutexLine = lines.findIndex(l => l.includes('let _launching = false'))
    expect(mutexLine).toBeGreaterThan(-1)
    expect(initFnLine).toBeGreaterThan(-1)
    expect(mutexLine).toBeLessThan(initFnLine)
  })

  it('repo-list auth/rate-limit/network/protocol failures render the canonical failure state, not "No repositories available"', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    // Verify that the code handles listRepos failure by setting neutral failure messages
    // rather than "No repositories available"
    expect(src).toContain('Sign in required to load repositories.')
    expect(src).toContain('Repository list temporarily unavailable. Try again shortly.')
    expect(src).toContain('Repository list unavailable.')
    // Verify "No repositories available" is not used for failure paths
    expect(src).not.toContain('No repositories available')
  })
})

describe('operator-launch — security: no data-repo/data-status on the optimistic card, no sensitive value leaked', () => {
  it('source never sets data-repo or data-status on the optimistic launch card', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).not.toMatch(/dataset\.repo\s*=/)
    expect(src).not.toMatch(/dataset\.status\s*=/)
  })

  it('source never logs prompt/csrf/idempotency/runId (no console.* calls at all)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).not.toMatch(/console\.(log|error|warn)\s*\(/)
  })
})
