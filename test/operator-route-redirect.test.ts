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
    getRepos: () => {
      throw new Error('getRepos must not be called during redirect')
    },
    getRunIndex: () => {
      throw new Error('getRunIndex must not be called during redirect')
    },
    approveRun: () => {
      throw new Error('approveRun must not be called during redirect')
    },
    denyRun: () => {
      throw new Error('denyRun must not be called during redirect')
    },
    createEventStream: () => {
      throw new Error('createEventStream must not be called during redirect')
    },
  } as unknown as OperatorClient
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

describe('Gateway login recovery — return_to is /', () => {
  it('unauthenticated request in gateway mode redirects to /operator/auth/github/start?return_to=/', async () => {
    const client = makeFakeOperatorClient(async () => {
      throw new Error('getCurrentSession must not be called without a cookie')
    })
    const app = await buildGatewayApp(client)
    const res = await app.request('/')
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/operator/auth/github/start')
    expect(location).toContain('return_to=/')
    expect(location).not.toContain('return_to=/operator')
  })

  it('gateway mode /auth/login redirects to /operator/auth/github/start?return_to=/', async () => {
    const client = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildGatewayApp(client)
    const res = await app.request('/auth/login')
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/operator/auth/github/start')
    expect(location).toContain('return_to=/')
    expect(location).not.toContain('return_to=/operator')
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
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/operator/auth/github/start')
  })
})
