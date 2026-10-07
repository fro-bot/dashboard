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
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {parseSseFrame as browserParseSseFrame, nextStreamState, PINNED_CONTRACT_VERSION} from '../public/operator-stream.js'
import {CHECKOUT_REFUSAL_REASONS, OBSTRUCTION_KINDS, OPERATOR_CONTRACT_VERSION} from '../src/gateway/operator-contract/index.ts'
import {isOperatorFailureKind} from '../src/gateway/operator-contract/run-status.ts'
import {FIXTURE_OPERATOR_PREFIX} from '../src/gateway/operator-fixture-routes.ts'
import {FIXTURE_SCENARIO_NAMES, serializeScenarioToSse} from '../src/gateway/operator-fixture-sse.ts'
import {parseSseChunk as serverParseSseChunk} from '../src/gateway/operator-sse-reader.ts'
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

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${fixtureSessionId}`)
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

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/approvals?fixtureSessionId=${fixtureSessionId}`)
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

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${fixtureSessionId}`)
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

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${fixtureSessionId}`)
    expect(streamRes.status).toBe(200)
    expect(await streamRes.text()).toContain('failed')
  })
})

async function launchAndStream(scenario: string, idempotencyKey: string) {
  const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

  const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
  const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

  const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      scenario,
      idempotencyKey,
      fixtureSessionId,
      csrfToken: 'fixture-csrf-placeholder',
      repo: 'fixture-org/fixture-repo',
      prompt: '[Fixture prompt]',
    }),
  })
  expect(launchRes.status).toBe(200)
  const {runId} = await launchRes.json() as {runId: string}

  const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${fixtureSessionId}`)
  expect(streamRes.status).toBe(200)
  const sseText = await streamRes.text()
  return {app, runId, sseText}
}

describe('fixture launch — failure-reason scenarios', () => {
  it('terminal_failure_known_reason: failed status frame carries the expected reason and preserves final output', async () => {
    const {sseText} = await launchAndStream(
      FIXTURE_SCENARIO_NAMES.terminal_failure_known_reason,
      'fixture-idem-key-known-reason-001',
    )
    expect(sseText).toContain('failed')
    expect(sseText).toContain('inactivity-timeout')
    expect(sseText).toContain('[Fixture output — synthetic partial result before failure (final)]')
  })

  it('terminal_failure_unknown_reason: failed status frame carries a visibly synthetic, fixture-prefixed reason', async () => {
    const {sseText} = await launchAndStream(
      FIXTURE_SCENARIO_NAMES.terminal_failure_unknown_reason,
      'fixture-idem-key-unknown-reason-001',
    )
    expect(sseText).toContain('failed')
    expect(sseText).toContain('fixture-unrecognized-reason')
  })

  it('non_failed_with_reason: a succeeded status frame carries a reason that must be ignored by renderers', async () => {
    const {sseText} = await launchAndStream(
      FIXTURE_SCENARIO_NAMES.non_failed_with_reason,
      'fixture-idem-key-non-failed-reason-001',
    )
    expect(sseText).toContain('succeeded')
    expect(sseText).toContain('inactivity-timeout')
  })

  it('recent-run index exposes a failed entry with the known reason binding to terminal_failure_known_reason stream data', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const runsRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${fixtureSessionId}`)
    expect(runsRes.status).toBe(200)
    const {runs} = await runsRes.json() as {runs: Record<string, unknown>[]}
    const reasonRow = runs.find(r => r.runId === 'run-fixture-index-failed-reason-006')
    expect(reasonRow).toBeDefined()
    expect(reasonRow?.failureKind).toBe('inactivity-timeout')

    const streamRes = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/run-fixture-index-failed-reason-006/stream?fixtureSessionId=${fixtureSessionId}`,
    )
    expect(streamRes.status).toBe(200)
    const sseText = await streamRes.text()
    expect(sseText).toContain('inactivity-timeout')
  })

  it('recent-run index exposes a failed entry with an unknown reason that never appears without the fixture- prefix', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const runsRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${fixtureSessionId}`)
    const {runs} = await runsRes.json() as {runs: Record<string, unknown>[]}
    const unknownRow = runs.find(r => r.runId === 'run-fixture-index-failed-unknown-reason-007')
    expect(unknownRow).toBeDefined()
    expect(String(unknownRow?.failureKind)).toMatch(/^fixture-/)
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

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${fixtureSessionId}`)
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

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${fixtureSessionId}`)
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

    const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${fixtureSessionId}`)
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

// ---------------------------------------------------------------------------
// GET /__fixture/operator/runs — synthetic run index listing
// ---------------------------------------------------------------------------

describe('fixture runs index — GET /runs', () => {
  it('returns 200 with a JSON envelope {runs: [...]} — mirrors the gateway, not a bare array', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(false)
    expect(Array.isArray((body as {runs: unknown}).runs)).toBe(true)
  })

  it('returns at least one run summary entry', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    expect(res.status).toBe(200)
    const {runs: body} = await res.json() as {runs: unknown[]}
    expect(body.length).toBeGreaterThan(0)
  })

  it('each entry has runId, repo, status, and createdAt string fields', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    const {runs: body} = await res.json() as {runs: Record<string, unknown>[]}
    for (const entry of body) {
      expect(typeof entry.runId).toBe('string')
      expect(typeof entry.repo).toBe('string')
      expect(typeof entry.status).toBe('string')
      expect(typeof entry.createdAt).toBe('string')
    }
  })

  it('updatedAt is absent on some entries and a string when present', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    const {runs: body} = await res.json() as {runs: Record<string, unknown>[]}
    // At least one entry must have updatedAt absent
    const withoutUpdatedAt = body.filter(e => !('updatedAt' in e))
    expect(withoutUpdatedAt.length).toBeGreaterThan(0)
    // Any entry that has updatedAt must be a string
    for (const entry of body) {
      if ('updatedAt' in entry) {
        expect(typeof entry.updatedAt).toBe('string')
      }
    }
  })

  it('statuses use only the five index summary values', async () => {
    const ALLOWED_INDEX_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    const {runs: body} = await res.json() as {runs: Record<string, unknown>[]}
    for (const entry of body) {
      expect(ALLOWED_INDEX_STATUSES.has(entry.status as string)).toBe(true)
    }
  })

  it('statuses do NOT include stream-only values (blocked, waiting_for_approval)', async () => {
    const STREAM_ONLY_STATUSES = new Set(['blocked', 'waiting_for_approval'])
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    const {runs: body} = await res.json() as {runs: Record<string, unknown>[]}
    for (const entry of body) {
      expect(STREAM_ONLY_STATUSES.has(entry.status as string)).toBe(false)
    }
  })

  it('all runId values are fixture-prefixed (not UUID-shaped)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    const {runs: body} = await res.json() as {runs: Record<string, unknown>[]}
    for (const entry of body) {
      expect(String(entry.runId)).toMatch(/^run-fixture-/)
    }
  })

  it('all repo values are fixture-prefixed (no real repo names)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    const {runs: body} = await res.json() as {runs: Record<string, unknown>[]}
    for (const entry of body) {
      expect(String(entry.repo)).toMatch(/fixture/)
    }
  })

  it('response has Cache-Control: no-store', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control') ?? '').toContain('no-store')
  })

  it('response contains no real workspace paths, tokens, cookies, or CSRF values', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    const text = await res.text()
    expect(text).not.toMatch(/Bearer\s+[\w\-.~+/]+=*/i)
    expect(text).not.toMatch(/__Host-/)
    expect(text).not.toMatch(/\/(?:home|Users|workspace|workspaces|var\/run|tmp)\/[\w.-]+\/[\w.-]/)
    expect(text).not.toMatch(/\brun-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\b/i)
  })

  it('entries contain only allowed fields (no extra sensitive fields)', async () => {
    const ALLOWED_FIELDS = new Set(['runId', 'repo', 'status', 'createdAt', 'updatedAt', 'failureKind'])
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    const {runs: body} = await res.json() as {runs: Record<string, unknown>[]}
    for (const entry of body) {
      for (const key of Object.keys(entry)) {
        expect(ALLOWED_FIELDS.has(key)).toBe(true)
      }
    }
  })

  it('is reachable without auth when fixture flag is on', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    expect(res.status).toBe(200)
  })

  it('returns 404 when fixture flag is off', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedGet(app, `${FIXTURE_OPERATOR_PREFIX}/runs`)
    expect(res.status).toBe(404)
  })
})

describe('fixture runs index — GET /operator/runs still absent from dashboard', () => {
  it('GET /operator/runs returns 404 (not proxied) even when fixture harness is active', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await authedGet(app, '/operator/runs')
    expect(res.status).toBe(404)
  })

  it('GET /operator/runs returns 404 when fixture harness is off', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedGet(app, '/operator/runs')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// NODE_ENV guard — fail closed unless explicitly development or test
// ---------------------------------------------------------------------------

describe('fixture NODE_ENV guard — fail closed unless development or test', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV
    }
  })

  it('throws when NODE_ENV is undefined (not explicitly development or test)', async () => {
    delete process.env.NODE_ENV
    await expect(
      buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'}),
    ).rejects.toThrow()
  })

  it('throws when NODE_ENV=staging (not explicitly development or test)', async () => {
    process.env.NODE_ENV = 'staging'
    await expect(
      buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'}),
    ).rejects.toThrow()
  })

  it('throws when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production'
    await expect(
      buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'}),
    ).rejects.toThrow()
  })

  it('does NOT throw when NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development'
    await expect(
      buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'}),
    ).resolves.toBeDefined()
  })

  it('does NOT throw when NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test'
    await expect(
      buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'}),
    ).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Session ownership — stream/approvals/decision require matching fixtureSessionId
// ---------------------------------------------------------------------------

describe('fixture session ownership — stream requires matching fixtureSessionId', () => {
  it('GET /runs/:runId/stream without fixtureSessionId returns 400 or 404', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-ownership-stream-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    // No fixtureSessionId in request — must be rejected
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream`)
    expect([400, 404]).toContain(res.status)
  })

  it('GET /runs/:runId/stream with wrong fixtureSessionId returns 400 or 404 (non-echoing)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-ownership-stream-002',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    // Wrong session — must be rejected without echoing the wrong session ID
    const wrongSession = 'fixture-session-WRONG-9999'
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${wrongSession}`)
    expect([400, 404]).toContain(res.status)
    expect(await res.text()).not.toContain(wrongSession)
  })

  it('GET /runs/:runId/stream with correct fixtureSessionId returns 200', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-ownership-stream-003',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${fixtureSessionId}`)
    expect(res.status).toBe(200)
  })
})

describe('fixture session ownership — approvals requires matching fixtureSessionId', () => {
  it('GET /runs/:runId/approvals without fixtureSessionId returns 400 or 404', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-ownership-approvals-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/approvals`)
    expect([400, 404]).toContain(res.status)
  })

  it('GET /runs/:runId/approvals with wrong fixtureSessionId returns 400 or 404 (non-echoing)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-ownership-approvals-002',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const wrongSession = 'fixture-session-WRONG-8888'
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/approvals?fixtureSessionId=${wrongSession}`)
    expect([400, 404]).toContain(res.status)
    expect(await res.text()).not.toContain(wrongSession)
  })

  it('GET /runs/:runId/approvals with correct fixtureSessionId returns 200', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-ownership-approvals-003',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/approvals?fixtureSessionId=${fixtureSessionId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as {approvals: unknown[]}
    expect(Array.isArray(body.approvals)).toBe(true)
  })
})

describe('fixture session ownership — decision requires matching fixtureSessionId', () => {
  it('POST /runs/:runId/approvals/:reqId/decision without fixtureSessionId returns 400 or 404', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-ownership-decision-001',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const res = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/approvals/req-fixture-harness-001/decision`,
      {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({decision: 'once'})},
    )
    expect([400, 404]).toContain(res.status)
  })

  it('POST /runs/:runId/approvals/:reqId/decision with wrong fixtureSessionId returns 400 or 404 (non-echoing)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-ownership-decision-002',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const wrongSession = 'fixture-session-WRONG-7777'
    const res = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/approvals/req-fixture-harness-001/decision?fixtureSessionId=${wrongSession}`,
      {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({decision: 'once'})},
    )
    expect([400, 404]).toContain(res.status)
    expect(await res.text()).not.toContain(wrongSession)
  })

  it('POST /runs/:runId/approvals/:reqId/decision with correct fixtureSessionId returns 200 (happy path)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-ownership-decision-003',
        fixtureSessionId,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}

    const res = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/approvals/req-fixture-harness-001/decision?fixtureSessionId=${fixtureSessionId}`,
      {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({decision: 'once'})},
    )
    expect(res.status).toBe(200)
    const body = await res.json() as {state: string}
    expect(body.state).toBe('claimed')
  })
})

// ---------------------------------------------------------------------------
// POST /runs/:runId/cancel — cancel route
// ---------------------------------------------------------------------------

async function launchIndexedCancelSession(app: Awaited<ReturnType<typeof buildFixtureTestApp>>): Promise<string> {
  const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
  const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}
  // Seed the indexed runs (mirrors GET /runs).
  await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${fixtureSessionId}`)
  return fixtureSessionId
}

describe('fixture cancel — POST /runs/:runId/cancel', () => {
  it('happy path: succeeded indexed run → 200 flat {ok,runId,phase:COMPLETED}', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)
    const runId = 'run-fixture-index-succeeded-003'

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf-placeholder',
        'idempotency-key': 'fixture-cancel-key-001',
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body).toEqual({ok: true, runId, phase: 'COMPLETED'})
  })

  it('happy path: failed indexed run → phase:FAILED', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)
    const runId = 'run-fixture-index-failed-004'

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf-placeholder',
        'idempotency-key': 'fixture-cancel-key-002',
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {phase: string}
    expect(body.phase).toBe('FAILED')
  })

  it('happy path: running indexed run → phase:CANCELLED', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)
    const runId = 'run-fixture-index-running-002'

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf-placeholder',
        'idempotency-key': 'fixture-cancel-key-003',
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {phase: string}
    expect(body.phase).toBe('CANCELLED')
  })

  it('idempotency replay: same session+key returns the same cached body', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)
    const runId = 'run-fixture-index-succeeded-003'
    const headers = {
      'x-fixture-session-id': fixtureSessionId,
      'x-csrf-token': 'fixture-csrf-placeholder',
      'idempotency-key': 'fixture-cancel-key-replay-001',
    }

    const first = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {method: 'POST', headers})
    const firstBody = await first.json()

    const second = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {method: 'POST', headers})
    const secondBody = await second.json()

    expect(second.status).toBe(200)
    expect(secondBody).toEqual(firstBody)
  })

  it('missing csrf → 400 {error:missing-csrf}', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)
    const runId = 'run-fixture-index-succeeded-003'

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'x-fixture-session-id': fixtureSessionId,
        'idempotency-key': 'fixture-cancel-key-004',
      },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({error: 'missing-csrf'})
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('missing idempotency-key → 400 {error:missing-idempotency-key}', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)
    const runId = 'run-fixture-index-succeeded-003'

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf-placeholder',
      },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({error: 'missing-idempotency-key'})
  })

  it('unknown/unauthorized run → 404 {error:not-found}', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/run-fixture-nonexistent-999/cancel`, {
      method: 'POST',
      headers: {
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf-placeholder',
        'idempotency-key': 'fixture-cancel-key-005',
      },
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({error: 'not-found'})
  })

  it('forced-503 sentinel: idempotency-key "force-503" → 503 {error:unavailable}', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)
    const runId = 'run-fixture-index-succeeded-003'

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf-placeholder',
        'idempotency-key': 'force-503',
      },
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({error: 'unavailable'})
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('browser-reachable retry fixture run: cancel → 503, second cancel also 503 (not cached)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)
    const runId = 'run-fixture-index-cancel-retry-008'

    const first = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf-placeholder',
        'idempotency-key': 'fixture-cancel-retry-key-001',
      },
    })
    expect(first.status).toBe(503)
    expect(await first.json()).toEqual({error: 'unavailable'})
    expect(first.headers.get('cache-control')).toBe('no-store')

    const second = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf-placeholder',
        'idempotency-key': 'fixture-cancel-retry-key-001',
      },
    })
    expect(second.status).toBe(503)
    expect(await second.json()).toEqual({error: 'unavailable'})
  })

  it('browser-reachable unavailable fixture run: cancel → 404 {error:not-found}', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)
    const runId = 'run-fixture-index-cancel-unavailable-009'

    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf-placeholder',
        'idempotency-key': 'fixture-cancel-unavailable-key-001',
      },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({error: 'not-found'})
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('production mode returns 404 for POST /runs/:runId/cancel', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedPost(
      app,
      `${FIXTURE_OPERATOR_PREFIX}/runs/run-fixture-index-succeeded-003/cancel`,
      {},
    )
    expect(res.status).toBe(404)
  })

  it('GET /runs includes the two browser-reachable cancel-fault fixture runs', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await launchIndexedCancelSession(app)

    const runsRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${fixtureSessionId}`)
    const {runs} = await runsRes.json() as {runs: {runId: string; status: string}[]}
    const runIds = runs.map(r => r.runId)

    expect(runIds).toContain('run-fixture-index-cancel-retry-008')
    expect(runIds).toContain('run-fixture-index-cancel-unavailable-009')

    const retryRun = runs.find(r => r.runId === 'run-fixture-index-cancel-retry-008')
    const unavailableRun = runs.find(r => r.runId === 'run-fixture-index-cancel-unavailable-009')
    expect(retryRun?.status).toBe('running')
    expect(unavailableRun?.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// Cheap hardening: malformed JSON and non-object JSON for POST /runs
// ---------------------------------------------------------------------------

describe('fixture launch — malformed and non-object JSON body', () => {
  it('POST /runs with malformed JSON body returns 400', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{not valid json',
    })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).not.toContain('not valid json')
  })

  it('POST /runs with JSON null body returns 400', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: 'null',
    })
    expect(res.status).toBe(400)
  })

  it('POST /runs with JSON array body returns 400', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '["scenario","success"]',
    })
    expect(res.status).toBe(400)
  })

  it('POST /runs with JSON string body returns 400', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '"just a string"',
    })
    expect(res.status).toBe(400)
  })

  it('POST /runs with JSON number body returns 400', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '42',
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Cheap hardening: root GET / manifest
// ---------------------------------------------------------------------------

describe('fixture harness — GET / manifest', () => {
  it('GET /__fixture/operator returns 200 with fixtureMode:true', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}`)
    expect(res.status).toBe(200)
    const body = await res.json() as {fixtureMode: boolean}
    expect(body.fixtureMode).toBe(true)
  })

  it('GET /__fixture/operator returns prefix field', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}`)
    expect(res.status).toBe(200)
    const body = await res.json() as {prefix: string}
    expect(body.prefix).toBe(FIXTURE_OPERATOR_PREFIX)
  })

  it('GET /__fixture/operator returns scenarios array', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}`)
    expect(res.status).toBe(200)
    const body = await res.json() as {scenarios: string[]}
    expect(Array.isArray(body.scenarios)).toBe(true)
    expect(body.scenarios.length).toBeGreaterThan(0)
  })

  it('GET /__fixture/operator manifest contains no secrets (no token, no cookie, no key)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(/Bearer\s+\w/i)
    expect(text).not.toMatch(/__Host-/)
    expect(text).not.toMatch(/ghp_|gho_|ghs_/)
  })

  it('GET /__fixture/operator is absent when fixture flag is off', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: false})
    const res = await authedGet(app, `${FIXTURE_OPERATOR_PREFIX}`)
    expect(res.status).toBe(404)
  })
})

describe('fixture runs index — indexed run stream binding', () => {
  it('GET /runs with fixtureSessionId binds indexed run IDs to that session', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const runsRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${fixtureSessionId}`)
    expect(runsRes.status).toBe(200)
    const {runs} = await runsRes.json() as {runs: {runId: string}[]}
    expect(runs.length).toBeGreaterThan(0)

    const firstRun = runs[0] ?? {runId: ''}
    const streamRes = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${firstRun.runId}/stream?fixtureSessionId=${fixtureSessionId}`,
    )
    expect(streamRes.status).toBe(200)
    expect(streamRes.headers.get('content-type') ?? '').toMatch(/text\/event-stream/)
  })

  it('indexed run stream returns SSE bytes with event: and data: lines', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const runsRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${fixtureSessionId}`)
    const {runs} = await runsRes.json() as {runs: {runId: string}[]}
    const firstRun = runs[0] ?? {runId: ''}

    const streamRes = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${firstRun.runId}/stream?fixtureSessionId=${fixtureSessionId}`,
    )
    expect(streamRes.status).toBe(200)
    const body = await streamRes.text()
    expect(body).toContain('event:')
    expect(body).toContain('data:')
  })

  it('indexed run stream without fixtureSessionId returns 404 (not bound)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const runsRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    const {runs} = await runsRes.json() as {runs: {runId: string}[]}
    const firstRun = runs[0] ?? {runId: ''}

    const streamRes = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${firstRun.runId}/stream`,
    )
    expect(streamRes.status).toBe(404)
  })

  it('indexed run stream with wrong fixtureSessionId returns 400 (session mismatch)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const runsRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${fixtureSessionId}`)
    const {runs} = await runsRes.json() as {runs: {runId: string}[]}
    const firstRun = runs[0] ?? {runId: ''}

    const wrongSession = 'fixture-session-WRONG-6666'
    const streamRes = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${firstRun.runId}/stream?fixtureSessionId=${wrongSession}`,
    )
    expect([400, 404]).toContain(streamRes.status)
  })

  it('GET /runs without fixtureSessionId still returns the run list (no binding)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)
    expect(res.status).toBe(200)
    const {runs: body} = await res.json() as {runs: unknown[]}
    expect(body.length).toBeGreaterThan(0)
  })

  it('indexed runs are streamable by any minted session', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const s1Res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId: sid1} = await s1Res.json() as {fixtureSessionId: string}

    const s2Res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId: sid2} = await s2Res.json() as {fixtureSessionId: string}

    const runsRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${sid1}`)
    const {runs} = await runsRes.json() as {runs: {runId: string}[]}
    const firstRun = runs[0] ?? {runId: ''}

    const ok1 = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${firstRun.runId}/stream?fixtureSessionId=${sid1}`,
    )
    expect(ok1.status).toBe(200)

    const ok2 = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${firstRun.runId}/stream?fixtureSessionId=${sid2}`,
    )
    expect(ok2.status).toBe(200)
  })

  it('queued/running/succeeded indexed runs use success scenario; failed/cancelled use terminal_failure', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const runsRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${fixtureSessionId}`)
    const {runs} = await runsRes.json() as {runs: {runId: string; status: string}[]}

    const successRun = runs.find(r => ['queued', 'running', 'succeeded'].includes(r.status))
    expect(successRun).toBeDefined()
    if (successRun) {
      const streamRes = await app.request(
        `${FIXTURE_OPERATOR_PREFIX}/runs/${successRun.runId}/stream?fixtureSessionId=${fixtureSessionId}`,
      )
      expect(streamRes.status).toBe(200)
      const text = await streamRes.text()
      expect(text).toContain('succeeded')
    }

    const failRun = runs.find(r => ['failed', 'cancelled'].includes(r.status))
    expect(failRun).toBeDefined()
    if (failRun) {
      const streamRes = await app.request(
        `${FIXTURE_OPERATOR_PREFIX}/runs/${failRun.runId}/stream?fixtureSessionId=${fixtureSessionId}`,
      )
      expect(streamRes.status).toBe(200)
      const text = await streamRes.text()
      expect(text).toContain('failed')
    }
  })

  it('two sessions that each fetch /runs can both stream the same indexed run with their own fixtureSessionId', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const s1Res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId: sid1} = await s1Res.json() as {fixtureSessionId: string}

    const s2Res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId: sid2} = await s2Res.json() as {fixtureSessionId: string}

    expect(sid1).not.toBe(sid2)

    const runs1Res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${sid1}`)
    expect(runs1Res.status).toBe(200)
    const {runs: runs1} = await runs1Res.json() as {runs: {runId: string}[]}
    const indexedRunId = (runs1[0] ?? {runId: ''}).runId
    expect(indexedRunId).toMatch(/^run-fixture-index-/)

    const runs2Res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${sid2}`)
    expect(runs2Res.status).toBe(200)

    const stream1 = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${indexedRunId}/stream?fixtureSessionId=${sid1}`,
    )
    expect(stream1.status).toBe(200)
    expect(stream1.headers.get('content-type') ?? '').toMatch(/text\/event-stream/)

    const stream2 = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${indexedRunId}/stream?fixtureSessionId=${sid2}`,
    )
    expect(stream2.status).toBe(200)
    expect(stream2.headers.get('content-type') ?? '').toMatch(/text\/event-stream/)
  })

  it('an unminted fixture-session-prefixed ID cannot stream an indexed run', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const sessionRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId} = await sessionRes.json() as {fixtureSessionId: string}

    const runsRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${fixtureSessionId}`)
    const {runs} = await runsRes.json() as {runs: {runId: string}[]}
    const indexedRunId = (runs[0] ?? {runId: ''}).runId

    const unmintedSession = 'fixture-session-not-minted'
    const streamRes = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${indexedRunId}/stream?fixtureSessionId=${unmintedSession}`,
    )
    expect([400, 404]).toContain(streamRes.status)
    expect(await streamRes.text()).not.toContain(unmintedSession)
  })

  it('a launched run from session A cannot be streamed from session B (launched runs stay session-bound)', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})

    const s1Res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId: sid1} = await s1Res.json() as {fixtureSessionId: string}

    const s2Res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
    const {fixtureSessionId: sid2} = await s2Res.json() as {fixtureSessionId: string}

    const launchRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        scenario: FIXTURE_SCENARIO_NAMES.success,
        idempotencyKey: 'fixture-idem-key-cross-session-stream-001',
        fixtureSessionId: sid1,
        csrfToken: 'fixture-csrf-placeholder',
        repo: 'fixture-org/fixture-repo',
        prompt: '[Fixture prompt]',
      }),
    })
    expect(launchRes.status).toBe(200)
    const {runId} = await launchRes.json() as {runId: string}
    expect(runId).toMatch(/^run-fixture-harness-/)

    const ok = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${sid1}`,
    )
    expect(ok.status).toBe(200)

    const denied = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${sid2}`,
    )
    expect([400, 404]).toContain(denied.status)
  })
})

// ---------------------------------------------------------------------------
// Push notification fixture routes
// ---------------------------------------------------------------------------

const PUSH_SUBSCRIPTION_BODY = {
  endpoint: 'endpoint-fixture-push-001',
  keys: {p256dh: 'fixture-p256dh-key', auth: 'fixture-auth-key'},
}

async function mintFixtureSessionId(app: Awaited<ReturnType<typeof buildFixtureTestApp>>): Promise<string> {
  const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)
  const {fixtureSessionId} = await res.json() as {fixtureSessionId: string}
  return fixtureSessionId
}

describe('fixture push routes — vapid-key', () => {
  it('GET /push/vapid-key returns exactly {publicKey, keyVersion} with no-store', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/push/vapid-key`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['keyVersion', 'publicKey'])
    expect(typeof body.publicKey).toBe('string')
    expect(typeof body.keyVersion).toBe('string')
  })
})

describe('fixture push routes — subscribe', () => {
  it('POST /push/subscriptions requires a valid fixture session', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/push/subscriptions`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-csrf-token': 'fixture-csrf', 'idempotency-key': 'key-001'},
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
    })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).not.toContain(PUSH_SUBSCRIPTION_BODY.endpoint)
  })

  it('POST /push/subscriptions requires a CSRF header', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await mintFixtureSessionId(app)
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/push/subscriptions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fixture-session-id': fixtureSessionId,
        'idempotency-key': 'key-002',
      },
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
    })
    expect(res.status).toBe(400)
  })

  it('POST /push/subscriptions rejects a wrong-shape body', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await mintFixtureSessionId(app)
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/push/subscriptions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf',
        'idempotency-key': 'key-003',
      },
      body: JSON.stringify({endpoint: 'endpoint-fixture-002'}), // missing keys
    })
    expect(res.status).toBe(400)
    const body = await res.json() as {error: string}
    expect(body.error).toBe('invalid-request')
  })

  it('POST /push/subscriptions is idempotent per session+idempotencyKey', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await mintFixtureSessionId(app)
    const headers = {
      'content-type': 'application/json',
      'x-fixture-session-id': fixtureSessionId,
      'x-csrf-token': 'fixture-csrf',
      'idempotency-key': 'key-idem-004',
    }
    const r1 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/push/subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
    })
    expect(r1.status).toBe(200)
    const r2 = await app.request(`${FIXTURE_OPERATOR_PREFIX}/push/subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
    })
    expect(r2.status).toBe(200)
    const b1 = await r1.json()
    const b2 = await r2.json()
    expect(b1).toEqual(b2)
  })
})

describe('fixture push routes — subscriptions metadata + unsubscribe', () => {
  it('GET /push/subscriptions returns not-subscribed shape with no active record', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await mintFixtureSessionId(app)
    const res = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/push/subscriptions?fixtureSessionId=${fixtureSessionId}`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json() as Record<string, unknown>
    expect(body.active).toBeUndefined()
    expect(body.endpointHash).toBeUndefined()
  })

  it('GET /push/subscriptions returns safe metadata after subscribe, never raw endpoint/keys', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await mintFixtureSessionId(app)
    await app.request(`${FIXTURE_OPERATOR_PREFIX}/push/subscriptions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf',
        'idempotency-key': 'key-meta-005',
      },
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
    })

    const res = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/push/subscriptions?fixtureSessionId=${fixtureSessionId}`,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.active).toBe(true)
    expect(typeof body.endpointHash).toBe('string')
    expect((body.endpointHash as string)).not.toContain(PUSH_SUBSCRIPTION_BODY.endpoint)
    expect(body.endpoint).toBeUndefined()
    expect(body.keys).toBeUndefined()
    expect(body.p256dh).toBeUndefined()
    expect(body.auth).toBeUndefined()
    const rawText = JSON.stringify(body)
    expect(rawText).not.toContain(PUSH_SUBSCRIPTION_BODY.endpoint)
    expect(rawText).not.toContain(PUSH_SUBSCRIPTION_BODY.keys.p256dh)
    expect(rawText).not.toContain(PUSH_SUBSCRIPTION_BODY.keys.auth)
  })

  it('POST /push/subscriptions/unsubscribe marks the record inactive', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const fixtureSessionId = await mintFixtureSessionId(app)
    await app.request(`${FIXTURE_OPERATOR_PREFIX}/push/subscriptions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf',
        'idempotency-key': 'key-unsub-006',
      },
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
    })

    const unsubRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/push/subscriptions/unsubscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fixture-session-id': fixtureSessionId,
        'x-csrf-token': 'fixture-csrf',
      },
      body: JSON.stringify({endpoint: PUSH_SUBSCRIPTION_BODY.endpoint}),
    })
    expect(unsubRes.status).toBe(200)

    const metaRes = await app.request(
      `${FIXTURE_OPERATOR_PREFIX}/push/subscriptions?fixtureSessionId=${fixtureSessionId}`,
    )
    const body = await metaRes.json() as Record<string, unknown>
    expect(body.active).toBe(false)
    expect(body.inactiveReason).toBe('unsubscribed')
  })

  it('POST /push/subscriptions/unsubscribe requires a valid fixture session', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const res = await app.request(`${FIXTURE_OPERATOR_PREFIX}/push/subscriptions/unsubscribe`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-csrf-token': 'fixture-csrf'},
      body: JSON.stringify({endpoint: PUSH_SUBSCRIPTION_BODY.endpoint}),
    })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).not.toContain(PUSH_SUBSCRIPTION_BODY.endpoint)
  })
})

describe('fixture push routes — production guard (each route 404s when any single guard fails)', () => {
  const pushRoutes: {path: string; method: 'GET' | 'POST'}[] = [
    {path: '/push/vapid-key', method: 'GET'},
    {path: '/push/subscriptions', method: 'POST'},
    {path: '/push/subscriptions', method: 'GET'},
    {path: '/push/subscriptions/unsubscribe', method: 'POST'},
  ]

  for (const {path, method} of pushRoutes) {
    it(`${method} ${path} returns 404 when fixture flag is off`, async () => {
      const app = await buildFixtureTestApp({fixtureHarnessEnabled: false, bindHost: '127.0.0.1'})
      const res = await authedGet(app, `${FIXTURE_OPERATOR_PREFIX}${path}`)
      if (method === 'GET') {
        expect(res.status).toBe(404)
      } else {
        const postRes = await authedPost(app, `${FIXTURE_OPERATOR_PREFIX}${path}`, {})
        expect(postRes.status).toBe(404)
      }
    })

    it(`${method} ${path} returns 404/deny when bind host is non-loopback`, async () => {
      await expect(
        buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '0.0.0.0'}),
      ).rejects.toThrow(/fixture.*loopback|loopback.*fixture/i)
    })
  }
})

// ---------------------------------------------------------------------------
// Checkout provenance / preparation scenarios
// ---------------------------------------------------------------------------

type CheckoutScenarioKey = Extract<keyof typeof FIXTURE_SCENARIO_NAMES, `checkout_${string}` | 'workspace_unavailable'>

const CHECKOUT_SCENARIO_KEYS = Object.keys(FIXTURE_SCENARIO_NAMES).filter(
  (key): key is CheckoutScenarioKey => key.startsWith('checkout_') || key === 'workspace_unavailable',
)

interface ScenarioExpectation {
  /** The run reached EXECUTING: provenance on the running and terminal frames. */
  readonly provenance: boolean
  /** The terminal FAILED frame carries a valid preparation. */
  readonly preparation: boolean
  readonly failureKind?: string
}

function expectationFor(key: CheckoutScenarioKey): ScenarioExpectation {
  if (key.startsWith('checkout_provenance_')) return {provenance: true, preparation: false}
  if (key === 'workspace_unavailable') return {provenance: false, preparation: false, failureKind: 'workspace-unavailable'}
  // The malformed field must degrade to absent on both parsers.
  if (key === 'checkout_malformed_preparation') return {provenance: false, preparation: false, failureKind: 'checkout-substituted'}
  if (key === 'checkout_refused_substituted') return {provenance: false, preparation: true, failureKind: 'checkout-substituted'}
  return {provenance: false, preparation: true}
}

interface StatusView {
  readonly phase: string
  readonly status: string
  readonly failureKind: string | undefined
  readonly hasProvenance: boolean
  readonly hasPreparation: boolean
}

function viewOf(data: {phase: string; status: string; failureKind?: string}): StatusView & Record<string, unknown> {
  const record = data as Record<string, unknown>
  return {
    phase: data.phase,
    status: data.status,
    failureKind: data.failureKind,
    hasProvenance: 'checkoutProvenance' in record,
    hasPreparation: 'checkoutPreparation' in record,
  }
}

function serverStatusViews(sse: string): StatusView[] {
  const views: StatusView[] = []
  for (const result of serverParseSseChunk(sse)) {
    if (result.success && result.frame.type === 'status') views.push(viewOf(result.frame.data))
  }
  return views
}

function browserStatusViews(sse: string): StatusView[] {
  const views: StatusView[] = []
  for (const record of sse.split('\n\n')) {
    if (record.trim() === '') continue
    const result = browserParseSseFrame(record)
    if (result !== null && result.success && result.frame.type === 'status') views.push(viewOf(result.frame.data))
  }
  return views
}

function browserTerminalStatus(sse: string) {
  let terminal
  for (const record of sse.split('\n\n')) {
    if (record.trim() === '') continue
    const result = browserParseSseFrame(record)
    if (result !== null && result.success && result.frame.type === 'status') terminal = result.frame.data
  }
  return terminal
}

describe('checkout fixture scenarios — registry and manifest', () => {
  it('registers every checkout scenario and lists it in the manifest', async () => {
    expect(CHECKOUT_SCENARIO_KEYS).toHaveLength(24)
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const body = await (await app.request(`${FIXTURE_OPERATOR_PREFIX}`)).json() as {scenarios: string[]}
    for (const key of CHECKOUT_SCENARIO_KEYS) {
      expect(body.scenarios).toContain(FIXTURE_SCENARIO_NAMES[key])
    }
  })

  it('every scenario launches (valid scenario name) and serializes', async () => {
    for (const key of CHECKOUT_SCENARIO_KEYS) {
      const bytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES[key], 'run-fixture-serialize-001')
      expect(bytes.length).toBeGreaterThan(0)
    }
  })
})

describe('checkout fixture scenarios — frames parse under both parsers to the expected presence', () => {
  for (const key of CHECKOUT_SCENARIO_KEYS) {
    it(`${key}: ready reads the pin, and server and browser agree frame by frame`, () => {
      const expected = expectationFor(key)
      const sse = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES[key], 'run-fixture-parity-001')

      // The ready frame carries the server constant and the browser accepts it (no drift).
      const ready = serverParseSseChunk(sse)[0]
      expect(ready?.success && ready.frame.type === 'ready' ? ready.frame.data.contractVersion : undefined).toBe(OPERATOR_CONTRACT_VERSION)
      let state = nextStreamState({connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}, {
        type: 'ready',
        data: {contractVersion: OPERATOR_CONTRACT_VERSION},
      })
      expect(state.connection).toBe('live')

      const server = serverStatusViews(sse)
      const browser = browserStatusViews(sse)
      expect(browser).toEqual(server.map(view => ({...view})))
      expect(server.length).toBeGreaterThanOrEqual(2)

      const terminal = server.at(-1)
      expect(terminal?.status).toBe(expected.provenance ? 'succeeded' : 'failed')
      expect(terminal?.failureKind).toBe(expected.failureKind)

      if (expected.provenance) {
        // Provenance only from EXECUTING on: not on the queued frame, on the running and terminal frames.
        expect(server.map(view => [view.phase, view.hasProvenance])).toEqual([
          ['PENDING', false],
          ['EXECUTING', true],
          ['COMPLETED', true],
        ])
        expect(server.some(view => view.hasPreparation)).toBe(false)
      } else {
        // Never reached EXECUTING: no EXECUTING frame, preparation only on the terminal frame, no provenance.
        expect(server.map(view => view.phase)).toEqual(['PENDING', 'FAILED'])
        expect(server.some(view => view.hasProvenance)).toBe(false)
        expect(server.map(view => view.hasPreparation)).toEqual([false, expected.preparation])
      }

      // The browser reducer terminalizes the run and stores the fields exactly as the parsers saw them.
      for (const record of sse.split('\n\n')) {
        if (record.trim() === '') continue
        const result = browserParseSseFrame(record)
        if (result !== null && result.success && result.frame.type !== 'ready') {
          state = nextStreamState(state, result.frame)
        }
      }
      const entry = state.runs['run-fixture-parity-001']
      expect(entry?.terminal).toBe(true)
      expect(state.connection).toBe('closed')
      expect(entry !== undefined && 'checkoutProvenance' in entry).toBe(expected.provenance)
      expect(entry !== undefined && 'checkoutPreparation' in entry).toBe(expected.preparation)
    })
  }

  it('the output frame always precedes the terminal status frame, empty for runs that never executed', () => {
    for (const key of CHECKOUT_SCENARIO_KEYS) {
      const sse = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES[key], 'run-fixture-order-001')
      const kinds = serverParseSseChunk(sse).flatMap(result => (result.success ? [result.frame.type] : []))
      expect(kinds.at(-1)).toBe('status')
      expect(kinds.lastIndexOf('output')).toBeLessThan(kinds.length - 1)
      expect(kinds.lastIndexOf('output')).toBeGreaterThan(-1)
    }
  })
})

describe('checkout fixture scenarios — the malformed scenario still terminalizes with its label', () => {
  it('both parsers drop the corrupted preparation and keep the failureKind; the card ends failed with "Checkout mismatch"', () => {
    const sse = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.checkout_malformed_preparation, 'run-fixture-malformed-prep-001')
    // The wire really does carry the corrupted field...
    expect(sse).toContain('"checkoutPreparation"')
    expect(sse).toContain('"changedPaths":["fixture/ok.txt",7]')
    // ...and both parsers accept the frame without it.
    const terminal = browserTerminalStatus(sse)
    expect(terminal?.status).toBe('failed')
    expect(terminal?.failureKind).toBe('checkout-substituted')
    expect('checkoutPreparation' in (terminal ?? {})).toBe(false)

    let state = nextStreamState({connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    for (const record of sse.split('\n\n')) {
      const result = record.trim() === '' ? null : browserParseSseFrame(record)
      if (result !== null && result.success && result.frame.type !== 'ready') state = nextStreamState(state, result.frame)
    }
    const entry = state.runs['run-fixture-malformed-prep-001']
    expect(entry?.status).toBe('failed')
    expect(entry?.terminal).toBe(true)
    expect(entry?.reasonLabel).toBe('Checkout mismatch')
    expect(entry !== undefined && 'checkoutPreparation' in entry).toBe(false)
  })
})

function serverTerminalData(sse: string) {
  let data
  for (const result of serverParseSseChunk(sse)) {
    if (result.success && result.frame.type === 'status') data = result.frame.data
  }
  return data
}

function terminalPreparation(key: CheckoutScenarioKey) {
  const sse = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES[key], 'run-fixture-values-001')
  return {server: serverTerminalData(sse)?.checkoutPreparation, browser: browserTerminalStatus(sse)?.checkoutPreparation}
}

describe('checkout fixture scenarios — values and bounds', () => {
  it('checkout_refused_dirty: 14 wire paths become 10 entries plus "4 more", none over 256 characters', () => {
    const {server, browser} = terminalPreparation('checkout_refused_dirty')
    expect(server?.outcome === 'refused' && server.reason === 'dirty' ? server.changedPaths : []).toHaveLength(14)
    expect(browser?.outcome === 'refused' && browser.reason === 'dirty' ? browser.changedPaths.items : []).toHaveLength(10)
    expect(browser?.outcome === 'refused' && browser.reason === 'dirty' ? browser.changedPaths.more : -1).toBe(4)
    for (const entry of browser?.outcome === 'refused' && browser.reason === 'dirty' ? browser.changedPaths.items : []) {
      expect(entry.length).toBeLessThanOrEqual(256)
    }
  })

  it('checkout_refused_obstructed: every obstruction kind appears with its path', () => {
    const {browser} = terminalPreparation('checkout_refused_obstructed')
    const items = browser?.outcome === 'refused' && browser.reason === 'obstructed' ? browser.obstructions.items : []
    expect(items.map(item => item.kind).toSorted()).toEqual([...OBSTRUCTION_KINDS].toSorted())
  })

  it('checkout_refused_bidi_path: the server keeps the raw strings; the browser strips bidi/control characters and drops the bidi-only path', () => {
    const {server, browser} = terminalPreparation('checkout_refused_bidi_path')
    const raw = server?.outcome === 'refused' && server.reason === 'dirty' ? server.changedPaths : []
    expect(raw).toHaveLength(5)
    // eslint-disable-next-line no-control-regex
    const unsafe = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/
    expect(raw.some(path => unsafe.test(path))).toBe(true)

    const items = browser?.outcome === 'refused' && browser.reason === 'dirty' ? browser.changedPaths.items : []
    expect(items).toHaveLength(4)
    expect(items.some(path => unsafe.test(path))).toBe(false)
    expect(items).toContain('fixture/gpj.txt')
  })

  it('failed updates cover each flag line: permanent+possibly, mutated, and transient (none)', () => {
    const flags = (key: CheckoutScenarioKey) => {
      const {browser} = terminalPreparation(key)
      return browser?.outcome === 'failed' ? [browser.permanent, browser.mutationStarted] : undefined
    }
    expect(flags('checkout_update_failed_permanent')).toEqual([true, 'possibly'])
    expect(flags('checkout_update_failed_mutated')).toEqual([false, true])
    expect(flags('checkout_update_failed_transient')).toEqual([false, false])
  })

  it('the scenarios together cover every refusal reason, every remote variant, and both new failure kinds', () => {
    const reasons = new Set<string>()
    const remotes = new Set<string>()
    const failureKinds = new Set<string>()
    for (const key of CHECKOUT_SCENARIO_KEYS) {
      const data = browserTerminalStatus(serializeScenarioToSse(FIXTURE_SCENARIO_NAMES[key], 'run-fixture-coverage-001'))
      if (data?.failureKind !== undefined) failureKinds.add(data.failureKind)
      if (data?.checkoutPreparation?.outcome === 'refused') reasons.add(data.checkoutPreparation.reason)
      const provenance = data?.checkoutProvenance
      if (provenance !== undefined) {
        remotes.add(provenance.remote.kind === 'checked' ? `checked-${provenance.remote.change}` : provenance.remote.kind)
        if (provenance.kind === 'unavailable') remotes.add('unavailable-provenance')
        else if (provenance.worktree.kind === 'dirty') remotes.add('dirty-worktree')
        if (provenance.kind === 'observed' && provenance.operation !== 'none') remotes.add('operation-in-progress')
      }
    }
    expect([...reasons].toSorted()).toEqual([...CHECKOUT_REFUSAL_REASONS].toSorted())
    for (const variant of ['not-checked', 'checked-unchanged', 'checked-fast-forward', 'unavailable-provenance', 'dirty-worktree', 'operation-in-progress']) {
      expect(remotes.has(variant), variant).toBe(true)
    }
    expect(failureKinds.has('workspace-unavailable')).toBe(true)
    expect(failureKinds.has('checkout-substituted')).toBe(true)
  })
})

describe('checkout fixture scenarios — recent-runs rows', () => {
  it('every checkout scenario has a fixture-prefixed row bound to its own stream, with a valid status and failureKind', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const {fixtureSessionId} = await (await app.request(`${FIXTURE_OPERATOR_PREFIX}/session`)).json() as {fixtureSessionId: string}
    const {runs} = await (await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs?fixtureSessionId=${fixtureSessionId}`)).json() as {
      runs: {runId: string; repo: string; status: string; failureKind?: string}[]
    }

    for (const key of CHECKOUT_SCENARIO_KEYS) {
      const runId = `run-fixture-index-${key.replaceAll('_', '-')}`
      const row = runs.find(candidate => candidate.runId === runId)
      expect(row, `${key} row`).toBeDefined()
      expect(row?.repo).toMatch(/fixture/)
      expect(['running', 'failed']).toContain(row?.status)
      if (row?.failureKind !== undefined) expect(isOperatorFailureKind(row.failureKind)).toBe(true)
      expect(row?.failureKind).toBe(expectationFor(key).failureKind)

      const streamRes = await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs/${runId}/stream?fixtureSessionId=${fixtureSessionId}`)
      expect(streamRes.status).toBe(200)
      expect(await streamRes.text()).toBe(serializeScenarioToSse(FIXTURE_SCENARIO_NAMES[key], runId))
    }
  })

  it('the original rows keep their order at the top of the list', async () => {
    const app = await buildFixtureTestApp({fixtureHarnessEnabled: true, bindHost: '127.0.0.1'})
    const {runs} = await (await app.request(`${FIXTURE_OPERATOR_PREFIX}/runs`)).json() as {runs: {runId: string}[]}
    expect(runs.slice(0, 3).map(run => run.runId)).toEqual([
      'run-fixture-index-queued-001',
      'run-fixture-index-running-002',
      'run-fixture-index-succeeded-003',
    ])
    expect(runs.length).toBeLessThanOrEqual(100)
    expect(new Set(runs.map(run => run.runId)).size).toBe(runs.length)
  })

  it('a launched run can use any checkout scenario (POST /runs accepts every name)', async () => {
    for (const key of CHECKOUT_SCENARIO_KEYS) {
      const {sseText} = await launchAndStream(FIXTURE_SCENARIO_NAMES[key], `fixture-idem-key-checkout-${key}`)
      expect(sseText).toContain('event: ready')
    }
  })
})

describe('checkout fixture scenarios — production artifacts carry no scenario names or fixture values', () => {
  const DISTINCTIVE_VALUES = ['fixture-vendor/alpha', 'fixture.hooksPath', 'fixture-feature/checkout-detail', 'fixture/changed-01.txt']

  it('web/dist, the service worker, and the shipped browser modules contain none of them', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const files = ['web/dist/sw.js', 'web/dist/index.html', 'public/operator-stream.js', 'public/operator-launch.js', 'public/operator-run-index.js']
    for (const file of await fs.readdir('web/dist/assets')) {
      if (file.endsWith('.js') || file.endsWith('.css')) files.push(path.join('web/dist/assets', file))
    }
    for (const file of files) {
      const src = await fs.readFile(file, 'utf8')
      for (const key of CHECKOUT_SCENARIO_KEYS) {
        expect(src, `${file} must not contain scenario ${key}`).not.toContain(FIXTURE_SCENARIO_NAMES[key])
      }
      for (const value of DISTINCTIVE_VALUES) {
        expect(src, `${file} must not contain ${value}`).not.toContain(value)
      }
    }
  })

  it('the fixture row run IDs never appear in production files', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toContain('run-fixture-index-')
  })
})
