/**
 * Tests for the unconditional /operator → / redirect.
 *
 * Covers:
 * - /operator redirects to / regardless of operatorUiEnabled flag
 * - /operator redirect is a 302 (not 301 permanent, not 200)
 * - /operator redirect response body does not contain monitoring, fixture, or mock-only copy
 * - /operator redirect is mounted before any legacy operator route handler
 * - Gateway login recovery target is / (not /operator)
 * - Unauthenticated / still enters the configured Gateway login flow
 */
import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
import type {GatewayClientError, OperatorClient, SessionDto} from '../src/gateway/operator-client.ts'
import type {Result} from '../src/result.ts'
import {Buffer} from 'node:buffer'
import {beforeEach, describe, expect, it} from 'vitest'
import {ok} from '../src/result.ts'
import {buildDashboardApp, resetRateLimitForTesting} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'

beforeEach(() => {
  resetRateLimitForTesting()
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8') // 32 bytes
const TEST_OPERATOR = 'octocat'
const FUTURE_EXPIRES_AT = Date.now() + 60 * 60 * 1000
const VALID_GATEWAY_SESSION: SessionDto = {
  operatorId: 12345,
  login: 'octocat',
  expiresAt: FUTURE_EXPIRES_AT,
}

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

async function buildArcticApp(operatorUiEnabled: boolean) {
  return buildDashboardApp({
    operatorLogin: TEST_OPERATOR,
    cookieKey: TEST_KEY,
    oauthClient: makeFakeOAuthClient(),
    fetchUserLogin: async (_token: string) => TEST_OPERATOR,
    getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
    operatorUiEnabled,
  })
}

function makeFakeOperatorClient(
  getCurrentSessionImpl: () => Promise<Result<SessionDto, GatewayClientError>>,
): OperatorClient {
  return {
    getCurrentSession: getCurrentSessionImpl,
    refreshCsrf: () => {
      throw new Error('refreshCsrf must not be called during redirect')
    },
    launchRun: () => {
      throw new Error('launchRun must not be called during redirect')
    },
    listRepos: () => {
      throw new Error('listRepos must not be called during redirect')
    },
    getRunSnapshot: () => {
      throw new Error('getRunSnapshot must not be called during redirect')
    },
    connectRunStream: () => {
      throw new Error('connectRunStream must not be called during redirect')
    },
    listRunApprovals: () => {
      throw new Error('listRunApprovals must not be called during redirect')
    },
    decideRunApproval: () => {
      throw new Error('decideRunApproval must not be called during redirect')
    },
    getVapidKey: () => {
      throw new Error('getVapidKey must not be called during redirect')
    },
    getPushSubscriptionMetadata: () => {
      throw new Error('getPushSubscriptionMetadata must not be called during redirect')
    },
    subscribePush: () => {
      throw new Error('subscribePush must not be called during redirect')
    },
    unsubscribePush: () => {
      throw new Error('unsubscribePush must not be called during redirect')
    },
  }
}

async function buildGatewayApp(client: OperatorClient) {
  return buildDashboardApp({
    operatorLogin: TEST_OPERATOR,
    cookieKey: TEST_KEY,
    oauthClient: makeFakeOAuthClient(),
    fetchUserLogin: async (_token: string) => TEST_OPERATOR,
    getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
    operatorUiEnabled: false,
    gatewayOperatorSessionEnabled: true,
    gatewayOperatorOrigin: 'https://dashboard.fro.bot',
    operatorClient: client,
  })
}

// ---------------------------------------------------------------------------
// /operator → / redirect: happy path
// ---------------------------------------------------------------------------

describe('/operator → / redirect — happy path', () => {
  it('GET /operator returns a redirect (3xx) to / when operatorUiEnabled=true', async () => {
    const app = await buildArcticApp(true)
    const cookie = makeSessionCookie()
    const res = await app.request('/operator', {headers: {cookie: `session=${cookie}`}})
    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
    expect(res.headers.get('location')).toBe('/')
  })

  it('GET /operator returns 302 specifically (not 301 permanent)', async () => {
    const app = await buildArcticApp(true)
    const cookie = makeSessionCookie()
    const res = await app.request('/operator', {headers: {cookie: `session=${cookie}`}})
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })
})

// ---------------------------------------------------------------------------
// /operator → / redirect: flag-independent behavior
// ---------------------------------------------------------------------------

describe('/operator → / redirect — flag-independent', () => {
  it('GET /operator redirects to / even when operatorUiEnabled=false (authenticated)', async () => {
    const app = await buildArcticApp(false)
    const cookie = makeSessionCookie()
    const res = await app.request('/operator', {headers: {cookie: `session=${cookie}`}})
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  it('GET /operator redirects to / when operatorUiEnabled=true (authenticated)', async () => {
    const app = await buildArcticApp(true)
    const cookie = makeSessionCookie()
    const res = await app.request('/operator', {headers: {cookie: `session=${cookie}`}})
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })
})

// ---------------------------------------------------------------------------
// /operator redirect: response body must not contain monitoring/mock copy
// ---------------------------------------------------------------------------

describe('/operator redirect — response body safety', () => {
  it('GET /operator redirect response body does not contain "monitoring" text', async () => {
    const app = await buildArcticApp(true)
    const cookie = makeSessionCookie()
    const res = await app.request('/operator', {headers: {cookie: `session=${cookie}`}})
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body.toLowerCase()).not.toContain('monitoring')
  })

  it('GET /operator redirect response body does not contain fixture or mock-only copy', async () => {
    const app = await buildArcticApp(true)
    const cookie = makeSessionCookie()
    const res = await app.request('/operator', {headers: {cookie: `session=${cookie}`}})
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body).not.toContain('Gateway Operator Controls')
    expect(body).not.toContain('FIXTURE')
    expect(body).not.toContain('mock')
  })

  it('GET /operator redirect response body does not contain "Gateway Operator Controls" skeleton', async () => {
    const app = await buildArcticApp(false)
    const cookie = makeSessionCookie()
    const res = await app.request('/operator', {headers: {cookie: `session=${cookie}`}})
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body).not.toContain('Gateway Operator Controls')
  })
})

// ---------------------------------------------------------------------------
// Auth recovery: Gateway login redirects return to /, not /operator
// ---------------------------------------------------------------------------

// INVARIANT: return_to is fixed to /operator because Gateway validates against an
// exact allowlist. Do not derive from request. After gateway returns to /operator,
// the dashboard redirects to / server-side (see app.get('/operator', ...)).
describe('Gateway login recovery — return_to is /operator', () => {
  it('unauthenticated request in gateway mode redirects to /operator/auth/github/start?return_to=/operator', async () => {
    const client = makeFakeOperatorClient(async () => {
      throw new Error('getCurrentSession must not be called without a cookie')
    })
    const app = await buildGatewayApp(client)
    const res = await app.request('/')
    expect(res.status).toBe(302)
    // Exact match — Gateway allowlist requires return_to=/operator precisely.
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('gateway mode /auth/login redirects to /operator/auth/github/start?return_to=/operator', async () => {
    const client = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildGatewayApp(client)
    const res = await app.request('/auth/login')
    expect(res.status).toBe(302)
    // Exact match — Gateway allowlist requires return_to=/operator precisely.
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })
})

// ---------------------------------------------------------------------------
// Unauthenticated /operator — exact Location header
// ---------------------------------------------------------------------------

describe('/operator unauthenticated — exact Location header', () => {
  it('unauthenticated GET /operator in Arctic mode redirects to /auth/login (not /operator)', async () => {
    const app = await buildArcticApp(true)
    const res = await app.request('/operator')
    // /operator is auth-gated; unauthenticated requests redirect to login
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toBe('/auth/login')
  })

  it('unauthenticated GET /operator in Arctic mode (flag off) redirects to /auth/login', async () => {
    const app = await buildArcticApp(false)
    const res = await app.request('/operator')
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toBe('/auth/login')
  })
})

// ---------------------------------------------------------------------------
// Auth path: unauthenticated / still enters the configured login flow
// ---------------------------------------------------------------------------

describe('auth path — unauthenticated / enters login flow', () => {
  it('unauthenticated GET / in Arctic mode redirects to /auth/login (not 200)', async () => {
    const app = await buildArcticApp(false)
    const res = await app.request('/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('unauthenticated GET / in gateway mode redirects to gateway login', async () => {
    const client = makeFakeOperatorClient(async () => {
      throw new Error('getCurrentSession must not be called without a cookie')
    })
    const app = await buildGatewayApp(client)
    const res = await app.request('/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })
})

// ---------------------------------------------------------------------------
// Wiki deep link: the return cookie survives login and is consumed once
// ---------------------------------------------------------------------------

describe('/operator redirect — wiki return cookie', () => {
  const TARGET = '/wiki/repos.acme--alpha'
  const RETURN = `wiki_return=${encodeURIComponent(TARGET)}`

  it('lands an unauthenticated /wiki/<id> visit back on the page after the gateway returns to /operator', async () => {
    const app = await buildGatewayApp(makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION)))

    const first = await app.request(TARGET)
    expect(first.status).toBe(302)
    expect(first.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
    const setCookie = first.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(RETURN)

    const back = await app.request('/operator', {headers: {cookie: `__Host-session=x; ${RETURN}`}})
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe(TARGET)
    expect(back.headers.get('set-cookie') ?? '').toMatch(/wiki_return=;.*Max-Age=0/iu)

    const again = await app.request('/operator', {headers: {cookie: '__Host-session=x'}})
    expect(again.status).toBe(302)
    expect(again.headers.get('location')).toBe('/')
    expect(again.headers.get('set-cookie')).toBeNull()
  })

  it('lands an unauthenticated /wiki visit back on the list after the gateway returns to /operator', async () => {
    const app = await buildGatewayApp(makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION)))
    const listReturn = `wiki_return=${encodeURIComponent('/wiki')}`

    const first = await app.request('/wiki')
    expect(first.status).toBe(302)
    expect(first.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
    expect(first.headers.get('set-cookie') ?? '').toContain(listReturn)

    const back = await app.request('/operator', {headers: {cookie: `__Host-session=x; ${listReturn}`}})
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/wiki')
    expect(back.headers.get('set-cookie') ?? '').toMatch(/wiki_return=;.*Max-Age=0/iu)

    const again = await app.request('/operator', {headers: {cookie: '__Host-session=x'}})
    expect(again.headers.get('location')).toBe('/')
    expect(again.headers.get('set-cookie')).toBeNull()
  })

  it('also redirects /operator/ to the list and clears the cookie', async () => {
    const app = await buildGatewayApp(makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION)))

    const res = await app.request('/operator/', {
      headers: {cookie: `__Host-session=x; wiki_return=${encodeURIComponent('/wiki')}`},
    })

    expect(res.headers.get('location')).toBe('/wiki')
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/iu)
  })

  it('consumes a list cookie in Arctic mode as well', async () => {
    const app = await buildArcticApp(false)

    const res = await app.request('/operator', {
      headers: {cookie: `session=${makeSessionCookie()}; wiki_return=${encodeURIComponent('/wiki')}`},
    })

    expect(res.headers.get('location')).toBe('/wiki')
  })

  it('also redirects /operator/ to the target and clears the cookie', async () => {
    const app = await buildGatewayApp(makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION)))

    const res = await app.request('/operator/', {headers: {cookie: `__Host-session=x; ${RETURN}`}})

    expect(res.headers.get('location')).toBe(TARGET)
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/iu)
  })

  it.each([
    ['an absolute URL', 'https://evil.example/wiki/repos.a'],
    ['a nested path', '/wiki/repos.a/b'],
    ['the wiki index with a slash', '/wiki/'],
    ['the list with a query string', '/wiki?x=1'],
    ['the root', '/'],
    ['a malformed page ID', '/wiki/repos..'],
  ])('ignores and clears a cookie holding %s', async (_label, value) => {
    const app = await buildGatewayApp(makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION)))

    const res = await app.request('/operator', {headers: {cookie: `__Host-session=x; wiki_return=${encodeURIComponent(value)}`}})

    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/iu)
  })

  it('consumes the cookie in Arctic mode as well', async () => {
    const app = await buildArcticApp(false)

    const res = await app.request('/operator', {headers: {cookie: `session=${makeSessionCookie()}; ${RETURN}`}})

    expect(res.headers.get('location')).toBe(TARGET)
  })

  it('redirects to / with no cookie header when there is nothing to consume', async () => {
    const app = await buildArcticApp(false)

    const res = await app.request('/operator', {headers: {cookie: `session=${makeSessionCookie()}`}})

    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('does not honor the cookie on an unauthenticated /operator request', async () => {
    const app = await buildArcticApp(false)

    const res = await app.request('/operator', {headers: {cookie: RETURN}})

    expect(res.headers.get('location')).toBe('/auth/login')
  })
})
