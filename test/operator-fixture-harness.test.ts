/**
 * Operator fixture harness integration tests.
 *
 * Covers:
 * - Happy path: fixture mode returns synthetic session (with fixtureMode and
 *   fixtureSessionId), CSRF, repo list, launch, stream bytes, and approval state.
 * - Session response includes fixtureMode:true and a fixture-prefixed fixtureSessionId.
 * - Idempotency is scoped by fixtureSessionId: same session+key → same run ID;
 *   different sessions + same key → different run IDs.
 * - Missing/invalid fixtureSessionId on launch returns a non-echoing 400.
 * - Production mode returns 404 for every fixture route.
 * - Non-loopback bind with fixture flag throws at construction.
 * - Fixture flag disabled on loopback leaves routes unmounted.
 * - Inbound credentials (cookies, bearer tokens, CSRF) are never echoed.
 * - Two tabs with different scenarios receive their own stream timelines.
 * - /operator redirects to /; production /operator/* data routes remain absent.
 * - Fixture routes are public (no auth required) when flag is on.
 */
import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
import {Buffer} from 'node:buffer'
import {beforeEach, describe, expect, it} from 'vitest'
import {FIXTURE_OPERATOR_PREFIX} from '../src/gateway/operator-fixture-routes.ts'
import {FIXTURE_SCENARIO_NAMES} from '../src/gateway/operator-fixture-sse.ts'
import {resetFixtureHarnessForTesting} from '../src/routes/operator-fixture-harness.ts'
import {buildDashboardApp, resetRateLimitForTesting} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'

const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8') // 32 bytes
const TEST_OPERATOR = 'octocat'

function makeFakeOAuthClient(): GitHubOAuthClient {
  return {
    createAuthorizationURL: (state: string, _scopes: string[]) =>
      new URL(`https://github.com/login/oauth/authorize?state=${state}`),
    validateAuthorizationCode: async (_code: string) => ({
      accessToken: () => 'fake-access-token',
    }),
  }
}

function makeSessionCookie(login: string = TEST_OPERATOR): string {
  const sm = new SessionManager(TEST_KEY)
  return sm.sign(login)
}

interface FixtureAppOpts {
  fixtureHarnessEnabled?: boolean
  bindHost?: string
  operatorUiEnabled?: boolean
}

async function buildFixtureTestApp(opts: FixtureAppOpts = {}) {
  return buildDashboardApp({
    operatorLogin: TEST_OPERATOR,
    cookieKey: TEST_KEY,
    oauthClient: makeFakeOAuthClient(),
    fetchUserLogin: async (_token: string) => TEST_OPERATOR,
    getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
    operatorUiEnabled: opts.operatorUiEnabled ?? false,
    fixtureHarnessEnabled: opts.fixtureHarnessEnabled ?? false,
    fixtureBindHost: opts.bindHost ?? '127.0.0.1',
  })
}

// Authenticated GET — bypasses auth middleware to reach the route layer directly.
// Used to prove routes are not mounted (404) vs auth-blocked (302/401).
async function authedGet(app: Awaited<ReturnType<typeof buildFixtureTestApp>>, path: string): Promise<Response> {
  const cookie = makeSessionCookie()
  return app.request(path, {headers: {cookie: `session=${cookie}`}})
}

async function authedPost(
  app: Awaited<ReturnType<typeof buildFixtureTestApp>>,
  path: string,
  body: unknown,
): Promise<Response> {
  const cookie = makeSessionCookie()
  return app.request(path, {
    method: 'POST',
    headers: {cookie: `session=${cookie}`, 'content-type': 'application/json'},
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  resetRateLimitForTesting()
  resetFixtureHarnessForTesting()
})

describe('FIXTURE_OPERATOR_PREFIX constant', () => {
  it('is the reserved dev prefix /__fixture/operator', () => {
    expect(FIXTURE_OPERATOR_PREFIX).toBe('/__fixture/operator')
  })
})

describe('fixture session — fixtureMode and fixtureSessionId fields', () => {
  it('GET /session returns fixtureMode:true', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    expect(res.status).toBe(200)
    const body = await res.json() as {fixtureMode: boolean}
    expect(body.fixtureMode).toBe(true)
  })

  it('GET /session returns a fixture-prefixed fixtureSessionId', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    expect(res.status).toBe(200)
    const body = await res.json() as {fixtureSessionId: string}
    expect(typeof body.fixtureSessionId).toBe('string')
    expect(body.fixtureSessionId).toMatch(/^fixture-session-/)
  })

  it('GET /session still returns operatorId, login, and expiresAt', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    expect(res.status).toBe(200)
    const body = await res.json() as {operatorId: number; login: string; expiresAt: number}
    expect(body.operatorId).toBeGreaterThan(0)
    expect(body.login).toMatch(/fixture/)
    expect(body.expiresAt).toBeGreaterThan(Date.now())
  })

  it('two GET /session calls return different fixtureSessionIds', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const r1 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const r2 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const b1 = await r1.json() as {fixtureSessionId: string}
    const b2 = await r2.json() as {fixtureSessionId: string}
    expect(b1.fixtureSessionId).not.toBe(b2.fixtureSessionId)
  })
})

describe('fixture launch — session-scoped idempotency', () => {
  it('same fixtureSessionId + same idempotencyKey returns the same run ID', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchBody = {
      scenario: FIXTURE_SCENARIO_NAMES.success,
      idempotencyKey: 'fixture-idem-key-scoped-001',
      fixtureSessionId,
      csrfToken: 'fixture-csrf-placeholder',
      repo: 'fixture-org/fixture-repo',
      prompt: '[Fixture prompt]',
    }

    const r1 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(launchBody),
    })
    expect(r1.status).toBe(200)
    const {runId: runId1} = await r1.json() as {runId: string}

    const r2 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(launchBody),
    })
    expect(r2.status).toBe(200)
    const {runId: runId2} = await r2.json() as {runId: string}

    expect(runId1).toBe(runId2)
  })

  it('different fixtureSessionIds + same idempotencyKey return different run IDs', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const s1 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId: sid1} = await s1.json() as {fixtureSessionId: string}

    const s2 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId: sid2} = await s2.json() as {fixtureSessionId: string}

    expect(sid1).not.toBe(sid2)

    const sharedKey = 'fixture-idem-key-cross-session-001'

    const r1 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: sharedKey,
        fixtureSessionId: sid1,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(r1.status).toBe(200)
    const {runId: runId1} = await r1.json() as {runId: string}

    const r2 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: sharedKey,
        fixtureSessionId: sid2,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(r2.status).toBe(200)
    const {runId: runId2} = await r2.json() as {runId: string}

    expect(runId1).not.toBe(runId2)
  })

  it('missing fixtureSessionId on launch returns 400 (non-echoing)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-nosession-001',
        // No fixtureSessionId
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).not.toContain('fixture-idem-key-nosession-001')
  })

  it('invalid (non-fixture-prefixed) fixtureSessionId on launch returns 400', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-badsession-001',
        fixtureSessionId: 'REAL_SESSION_ID_NOT_FIXTURE_PREFIXED',
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).not.toContain('REAL_SESSION_ID_NOT_FIXTURE_PREFIXED')
  })
})

describe('production mode — fixture routes absent (404)', () => {
  it('GET /__fixture/operator/session returns 404 when fixture flag is off', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedGet(app, `${FIXTURE_OPERATOR_PREFIX}/session`)
    expect(res.status).toBe(404)
  })

  it('GET /__fixture/operator/session/csrf returns 404 when fixture flag is off', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedGet(app, `${FIXTURE_OPERATOR_PREFIX}/session/csrf`)
    expect(res.status).toBe(404)
  })

  it('GET /__fixture/operator/repos returns 404 when fixture flag is off', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedGet(app, `${FIXTURE_OPERATOR_PREFIX}/repos`)
    expect(res.status).toBe(404)
  })

  it('POST /__fixture/operator/runs returns 404 when fixture flag is off', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedPost(app, `${FIXTURE_OPERATOR_PREFIX}/runs`, {
      scenario: 'success',
      idempotencyKey: 'key-001',
    })
    expect(res.status).toBe(404)
  })

  it('GET /__fixture/operator/runs/:runId/stream returns 404 when fixture flag is off', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedGet(app, `${FIXTURE_OPERATOR_PREFIX}/runs/run-fixture-001/stream`)
    expect(res.status).toBe(404)
  })

  it('GET /__fixture/operator/runs/:runId/approvals returns 404 when fixture flag is off', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedGet(app, `${FIXTURE_OPERATOR_PREFIX}/runs/run-fixture-001/approvals`)
    expect(res.status).toBe(404)
  })

  it('POST /__fixture/operator/runs/:runId/approvals/:reqId/decision returns 404 when fixture flag is off', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedPost(
      app,
      `${FIXTURE_OPERATOR_PREFIX}/runs/run-fixture-001/approvals/req-fixture-001/decision`,
      {decision: 'once'},
    )
    expect(res.status).toBe(404)
  })
})

describe('fixture flag + non-loopback bind — throws at construction', () => {
  it('throws when fixtureHarnessEnabled=true and bindHost=0.0.0.0', async () => {
    await expect(
      buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '0.0.0.0'}),
    ).rejects.toThrow(/fixture.*loopback|loopback.*fixture/i)
  })

  it('throws when fixtureHarnessEnabled=true and no fixtureBindHost (defaults to non-loopback)', async () => {
    await expect(
      buildDashboardApp({
        operatorLogin: TEST_OPERATOR,
        cookieKey: TEST_KEY,
        oauthClient: makeFakeOAuthClient(),
        fetchUserLogin: async (_token: string) => TEST_OPERATOR,
        getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
        fixtureHarnessEnabled: true,
      }),
    ).rejects.toThrow(/fixture.*loopback|loopback.*fixture/i)
  })

  it('does NOT throw when fixtureHarnessEnabled=true and bindHost=127.0.0.1', async () => {
    await expect(
      buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'}),
    ).resolves.toBeDefined()
  })

  it('does NOT throw when fixtureHarnessEnabled=true and bindHost=localhost', async () => {
    await expect(
      buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: 'localhost'}),
    ).resolves.toBeDefined()
  })

  it('does NOT throw when fixtureHarnessEnabled=true and bindHost=::1', async () => {
    await expect(
      buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '::1'}),
    ).resolves.toBeDefined()
  })
})

describe('fixture flag disabled on loopback — routes unmounted', () => {
  it('GET /__fixture/operator/session returns 404 when flag is off (authenticated)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false, bindHost: '127.0.0.1'})
    const res = await authedGet(app, `${FIXTURE_OPERATOR_PREFIX}/session`)
    expect(res.status).toBe(404)
  })

  it('/__fixture/* is not public when flag is off (unauthenticated gets redirect, not 200)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    expect(res.status).not.toBe(200)
  })
})

describe('fixture mode — happy path synthetic responses', () => {
  it('GET /session returns 200 with synthetic session JSON', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    expect(res.status).toBe(200)
    const body = await res.json() as {operatorId: number; login: string; expiresAt: number; fixtureMode: boolean; fixtureSessionId: string}
    expect(body.operatorId).toBeGreaterThan(0)
    expect(body.login).toMatch(/fixture/)
    expect(body.fixtureMode).toBe(true)
    expect(body.fixtureSessionId).toMatch(/^fixture-session-/)
  })

  it('GET /session/csrf returns 200 with synthetic CSRF JSON', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session/csrf`)
    expect(res.status).toBe(200)
    const body = await res.json() as {csrfToken: string}
    expect(body.csrfToken).toMatch(/fixture/)
  })

  it('GET /repos returns 200 with synthetic repo list JSON', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/repos`)
    expect(res.status).toBe(200)
    const body = await res.json() as {owner?: string; repo?: string}[]
    expect(body.length).toBeGreaterThan(0)
    const first = body[0] ?? {}
    expect(String(first.owner ?? '')).toMatch(/fixture/)
    expect(String(first.repo ?? '')).toMatch(/fixture/)
  })

  it('POST /runs returns 200 with fixture-prefixed run ID', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {runId: string}
    expect(body.runId).toMatch(/fixture/)
  })

  it('GET /runs/:runId/stream returns 200 with SSE content-type', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-stream-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream`)
    expect(streamRes.status).toBe(200)
    expect(streamRes.headers.get('content-type') ?? '').toMatch(/text\/event-stream/)
    const body = await streamRes.text()
    expect(body).toContain('event:')
    expect(body).toContain('data:')
  })

  it('GET /runs/:runId/approvals returns 200 with approvals array', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-approvals-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/approvals`)
    expect(res.status).toBe(200)
    const body = await res.json() as {approvals: unknown[]}
    expect(Array.isArray(body.approvals)).toBe(true)
  })
})

describe('fixture responses — no-store and CSP', () => {
  it('GET /session has Cache-Control: no-store', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control') ?? '').toContain('no-store')
  })

  it('GET /repos has Cache-Control: no-store', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/repos`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control') ?? '').toContain('no-store')
  })

  it('GET /session carries CSP header with script-src self', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self'")
  })
})

describe('fixture routes — no credential echo in responses', () => {
  it('inbound cookie value is not reflected in session response', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`, {
      headers: {cookie: '__Host-session=REAL_SECRET_COOKIE_VALUE_12345'},
    })
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('REAL_SECRET_COOKIE_VALUE_12345')
  })

  it('inbound Authorization bearer token is not reflected in session response', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`, {
      headers: {authorization: 'Bearer REAL_BEARER_TOKEN_ABCDEFGHIJKLMNOP'},
    })
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('REAL_BEARER_TOKEN_ABCDEFGHIJKLMNOP')
  })

  it('inbound X-CSRF-Token value is not reflected in CSRF response', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session/csrf`, {
      headers: {'x-csrf-token': 'REAL_CSRF_TOKEN_VALUE_XYZ789'},
    })
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('REAL_CSRF_TOKEN_VALUE_XYZ789')
  })

  it('private repo name in launch body is not reflected in launch response', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-noleak-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'PRIVATE_REAL_ORG/PRIVATE_REAL_REPO',
        prompt: '[Fixture prompt]',
      }),
    })
    const body = await res.text()
    expect(body).not.toContain('PRIVATE_REAL_ORG')
    expect(body).not.toContain('PRIVATE_REAL_REPO')
  })

  it('real run ID in URL is not reflected in approvals 404 response', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/REAL_RUN_ID_12345/approvals`)
    expect(await res.text()).not.toContain('REAL_RUN_ID_12345')
  })
})

describe('fixture launch — idempotency (same session)', () => {
  it('same fixtureSessionId + same idempotencyKey returns same run ID', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchBody = {
      scenario: FIXTURE_SCENARIO_NAMES.success,
      idempotencyKey: 'fixture-idem-key-dedup-001',
      fixtureSessionId,
      csrfToken: 'fixture-csrf-placeholder',
      repo: 'fixture-org/fixture-repo',
      prompt: '[Fixture prompt]',
    }

    const r1 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(launchBody),
    })
    const r2 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(launchBody),
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const {runId: id1} = await r1.json() as {runId: string}
    const {runId: id2} = await r2.json() as {runId: string}
    expect(id1).toBe(id2)
  })

  it('different idempotencyKeys within same session produce different run IDs', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const base = {
      scenario: FIXTURE_SCENARIO_NAMES.success,
      fixtureSessionId,
      csrfToken: 'fixture-csrf-placeholder',
      repo: 'fixture-org/fixture-repo',
      prompt: '[Fixture prompt]',
    }

    const r1 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({...base, idempotencyKey: 'fixture-idem-key-unique-001'}),
    })
    const r2 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({...base, idempotencyKey: 'fixture-idem-key-unique-002'}),
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const {runId: id1} = await r1.json() as {runId: string}
    const {runId: id2} = await r2.json() as {runId: string}
    expect(id1).not.toBe(id2)
  })
})

describe('fixture launch — scenario isolation', () => {
  it('two launches with different scenarios produce different run IDs', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const s1 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId: sid1} = await s1.json() as {fixtureSessionId: string}
    const s2 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId: sid2} = await s2.json() as {fixtureSessionId: string}

    const r1 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-tab1-001',
        fixtureSessionId: sid1,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    const r2 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.terminal_failure,
        idempotencyKey: 'fixture-idem-key-tab2-001',
        fixtureSessionId: sid2,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const {runId: id1} = await r1.json() as {runId: string}
    const {runId: id2} = await r2.json() as {runId: string}
    expect(id1).not.toBe(id2)
  })

  it('stream for success scenario contains succeeded status', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-success-stream-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream`)
    expect(streamRes.status).toBe(200)
    expect(await streamRes.text()).toContain('succeeded')
  })

  it('stream for terminal_failure scenario contains failed status', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.terminal_failure,
        idempotencyKey: 'fixture-idem-key-failure-stream-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream`)
    expect(streamRes.status).toBe(200)
    expect(await streamRes.text()).toContain('failed')
  })
})

describe('fixture launch — scenario validation', () => {
  it('POST with unknown scenario name returns 400 (non-echoing)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: 'not-a-real-scenario',
        idempotencyKey: 'fixture-idem-key-invalid-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('not-a-real-scenario')
  })

  it('POST with missing idempotencyKey returns 400', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(res.status).toBe(400)
  })
})

describe('integration — /operator redirect and production data routes absent', () => {
  it('GET /operator redirects to / (302) in fixture mode', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  it('GET /operator/repos returns 404 (not proxied) in fixture mode', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await authedGet(app, '/operator/repos')
    expect(res.status).toBe(404)
  })

  it('POST /operator/runs returns 404 (not proxied) in fixture mode', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await authedPost(app, '/operator/runs', {repo: 'fro-bot/agent', prompt: 'x'})
    expect(res.status).toBe(404)
  })

  it('GET /operator/runs/:id/stream returns 404 (not proxied) in fixture mode', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await authedGet(app, '/operator/runs/run-001/stream')
    expect(res.status).toBe(404)
  })

  it('GET /operator/runs/:id/approvals returns 404 (not proxied) in fixture mode', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await authedGet(app, '/operator/runs/run-001/approvals')
    expect(res.status).toBe(404)
  })
})

describe('fixture routes — public when flag is on', () => {
  it('GET /session is reachable without auth when fixture flag is on', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    expect(res.status).toBe(200)
  })

  it('GET /repos is reachable without auth when fixture flag is on', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/repos`)
    expect(res.status).toBe(200)
  })
})

describe('fixture stream — run ID binding', () => {
  it('success scenario: all runId fields in SSE frames match the launched run ID', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-runid-binding-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream`)
    expect(streamRes.status).toBe(200)
    const sseText = await streamRes.text()

    // Extract all runId values from SSE data payloads
    const dataLines = sseText.split('\n').filter(line => line.startsWith('data:'))
    const runIdsInFrames: string[] = []
    for (const line of dataLines) {
      try {
        const payload = JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>
        if (typeof payload.runId === 'string') {
          runIdsInFrames.push(payload.runId)
        }
      } catch {
        // skip non-JSON lines
      }
    }

    // Must have at least one run-scoped frame
    expect(runIdsInFrames.length).toBeGreaterThan(0)
    // Every run-scoped frame must use the launched run ID, not a template ID
    for (const frameRunId of runIdsInFrames) {
      expect(frameRunId).toBe(runId)
    }
  })

  it('terminal_failure scenario: all runId fields in SSE frames match the launched run ID', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.terminal_failure,
        idempotencyKey: 'fixture-idem-key-runid-binding-002',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream`)
    expect(streamRes.status).toBe(200)
    const sseText = await streamRes.text()

    const dataLines = sseText.split('\n').filter(line => line.startsWith('data:'))
    const runIdsInFrames: string[] = []
    for (const line of dataLines) {
      try {
        const payload = JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>
        if (typeof payload.runId === 'string') {
          runIdsInFrames.push(payload.runId)
        }
      } catch {
        // skip non-JSON lines
      }
    }

    expect(runIdsInFrames.length).toBeGreaterThan(0)
    for (const frameRunId of runIdsInFrames) {
      expect(frameRunId).toBe(runId)
    }
  })

  it('contract_drift scenario: ready frame has drift version; run-scoped frames (if any) use launched run ID', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.contract_drift,
        idempotencyKey: 'fixture-idem-key-runid-binding-003',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream`)
    expect(streamRes.status).toBe(200)
    const sseText = await streamRes.text()

    // Drift scenario must still have a ready frame with a non-matching contract version
    expect(sseText).toContain('event: ready')

    // Any run-scoped frames must use the launched run ID
    const dataLines = sseText.split('\n').filter(line => line.startsWith('data:'))
    for (const line of dataLines) {
      try {
        const payload = JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>
        if (typeof payload.runId === 'string') {
          expect(payload.runId).toBe(runId)
        }
      } catch {
        // skip non-JSON lines
      }
    }
  })
})

describe('fixture repos — browser-compatible shape {owner, repo}', () => {
  it('GET /repos returns items with owner and repo string fields', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/repos`)
    expect(res.status).toBe(200)
    const body = await res.json() as {owner?: unknown; repo?: unknown}[]
    expect(body.length).toBeGreaterThan(0)
    for (const item of body) {
      expect(typeof item.owner).toBe('string')
      expect(typeof item.repo).toBe('string')
    }
  })

  it('GET /repos items do NOT use name field instead of repo', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/repos`)
    expect(res.status).toBe(200)
    const body = await res.json() as {name?: unknown}[]
    for (const item of body) {
      // name field must not be the primary repo identifier (repo field must exist)
      expect(typeof (item as {repo?: unknown}).repo).toBe('string')
    }
  })
})
