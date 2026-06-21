/**
 * Gateway-session auth middleware integration tests.
 *
 * Tests the strategy branch in the auth middleware (second app.use('*')):
 * - flag-OFF → Arctic branch (byte-for-byte parity)
 * - flag-ON  → Gateway branch (fail-closed validation via OperatorClient)
 *
 * All tests use app.request() against buildDashboardApp() with injected config.
 * No real network calls are made — OperatorClient is injected as a fake, or
 * a recording fetchImpl is injected via gatewayFetchImpl for production-path tests.
 */
import type {GatewayClientError, OperatorClient, SessionDto} from '../src/gateway/operator-client.ts'
import type {Result} from '../src/result.ts'
import {Buffer} from 'node:buffer'
import {describe, expect, it, vi} from 'vitest'
import {createOperatorClient} from '../src/gateway/operator-client.ts'
import {createOperatorServerFetch} from '../src/gateway/operator-server-fetch.ts'
import {err, ok} from '../src/result.ts'
import {buildDashboardApp} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8') // 32 bytes
const TEST_OPERATOR = 'octocat'

// A valid future expiresAt (1 hour from a fixed reference point)
const FUTURE_EXPIRES_AT = Date.now() + 60 * 60 * 1000

// A valid SessionDto
const VALID_SESSION: SessionDto = {
  operatorId: 12345,
  login: 'octocat',
  expiresAt: FUTURE_EXPIRES_AT,
}

// ---------------------------------------------------------------------------
// Fake OperatorClient builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake OperatorClient with a controllable getCurrentSession.
 * All other methods throw — they must never be called in auth middleware.
 */
function makeFakeOperatorClient(
  getCurrentSessionImpl: () => Promise<Result<SessionDto, GatewayClientError>>,
): {client: OperatorClient; getCurrentSessionSpy: ReturnType<typeof vi.fn>} {
  const getCurrentSessionSpy = vi.fn(getCurrentSessionImpl)

  const client: OperatorClient = {
    getCurrentSession: getCurrentSessionSpy,
    refreshCsrf: () => {
      throw new Error('refreshCsrf must not be called in auth middleware')
    },
    launchRun: () => {
      throw new Error('launchRun must not be called in auth middleware')
    },
    getRunSnapshot: () => {
      throw new Error('getRunSnapshot must not be called in auth middleware')
    },
    connectRunStream: () => {
      throw new Error('connectRunStream must not be called in auth middleware')
    },
    listRepos: () => {
      throw new Error('listRepos must not be called in auth middleware')
    },
    listPendingApprovals: () => {
      throw new Error('listPendingApprovals must not be called in auth middleware')
    },
    decideApproval: () => {
      throw new Error('decideApproval must not be called in auth middleware')
    },
  }

  return {client, getCurrentSessionSpy}
}

// ---------------------------------------------------------------------------
// App builder helpers
// ---------------------------------------------------------------------------

/** Build app in gateway mode with an injected fake OperatorClient. */
async function buildGatewayApp(
  operatorClient: OperatorClient,
  extraOpts?: {operatorLogin?: string; cookieKey?: Buffer},
) {
  return buildDashboardApp({
    // In gateway mode, operatorLogin is not required for auth — but we still
    // need it for the Arctic branch to not throw. When testing gateway mode
    // we can omit it (deny-all Arctic mode) since the gateway branch runs first.
    operatorLogin: extraOpts?.operatorLogin,
    cookieKey: extraOpts?.cookieKey ?? TEST_KEY,
    gatewayOperatorSessionEnabled: true,
    operatorClient,
  })
}

/** Build app in Arctic mode (flag OFF). */
async function buildArcticApp(opts?: {operatorLogin?: string; cookieKey?: Buffer}) {
  return buildDashboardApp({
    operatorLogin: opts?.operatorLogin ?? TEST_OPERATOR,
    cookieKey: opts?.cookieKey ?? TEST_KEY,
    gatewayOperatorSessionEnabled: false,
  })
}

/** Sign an Arctic session cookie. */
function signArcticCookie(login: string = TEST_OPERATOR, key: Buffer = TEST_KEY): string {
  const sm = new SessionManager(key)
  return sm.sign(login)
}

// ---------------------------------------------------------------------------
// flag-OFF → Arctic branch parity
// ---------------------------------------------------------------------------

describe('flag-OFF: Arctic branch parity', () => {
  it('valid Arctic session → 200 on protected route', async () => {
    const app = await buildArcticApp()
    const cookie = signArcticCookie()
    const res = await app.request('/', {headers: {cookie: `session=${cookie}`}})
    expect(res.status).toBe(200)
  })

  it('no session cookie → redirect to /auth/login', async () => {
    const app = await buildArcticApp()
    const res = await app.request('/')
    expect([302, 303]).toContain(res.status)
    expect(res.headers.get('location')).toContain('/auth/login')
  })

  it('invalid session cookie → redirect to /auth/login', async () => {
    const app = await buildArcticApp()
    const res = await app.request('/', {headers: {cookie: 'session=invalid.garbage'}})
    expect([302, 303]).toContain(res.status)
  })

  it('flag-OFF: getCurrentSession is NEVER called — zero /operator/session calls', async () => {
    const {client, getCurrentSessionSpy} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    // Build with flag OFF but inject the client to detect any accidental call
    const app = await buildDashboardApp({
      operatorLogin: TEST_OPERATOR,
      cookieKey: TEST_KEY,
      gatewayOperatorSessionEnabled: false,
      operatorClient: client,
    })
    // Make a request (even with a valid Arctic cookie)
    const cookie = signArcticCookie()
    await app.request('/', {headers: {cookie: `session=${cookie}`}})
    // getCurrentSession must NEVER be called in flag-OFF mode
    expect(getCurrentSessionSpy).not.toHaveBeenCalled()
  })

  it('flag-OFF: getCurrentSession not called even on unauthenticated request', async () => {
    const {client, getCurrentSessionSpy} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildDashboardApp({
      operatorLogin: TEST_OPERATOR,
      cookieKey: TEST_KEY,
      gatewayOperatorSessionEnabled: false,
      operatorClient: client,
    })
    await app.request('/')
    expect(getCurrentSessionSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// flag-ON: Gateway branch — happy path
// ---------------------------------------------------------------------------

describe('flag-ON: Gateway branch — happy path', () => {
  it('valid SessionDto with future expiresAt → 200 on protected route', async () => {
    const {client} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-gateway-cookie-value'},
    })
    expect(res.status).toBe(200)
  })

  it('public path /api/healthz → 200 without calling getCurrentSession', async () => {
    const {client, getCurrentSessionSpy} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildGatewayApp(client)
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
    expect(getCurrentSessionSpy).not.toHaveBeenCalled()
  })

  it('public path /auth/login → redirects to the gateway operator login without calling getCurrentSession', async () => {
    const {client, getCurrentSessionSpy} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildGatewayApp(client)
    const res = await app.request('/auth/login')
    // /auth/login is in isPublicPath — the auth middleware passes it through. In
    // gateway-session mode the /auth router redirects /login to the gateway operator
    // login so a direct hit self-heals into the correct flow instead of minting a
    // dashboard `session` cookie. getCurrentSession is NOT called for public paths.
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
    expect(getCurrentSessionSpy).not.toHaveBeenCalled()
  })

  it('gateway mode: /auth/callback is NOT mounted — no dashboard session can be minted', async () => {
    const {client} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildGatewayApp(client)
    const res = await app.request('/auth/callback?code=x&state=y')
    // The Arctic callback (which mints the dashboard `session` cookie) must be
    // unreachable in gateway-session mode — it returns 404, not a Set-Cookie.
    expect(res.status).toBe(404)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('gateway mode: POST /auth/logout is NOT mounted (404) — gateway owns the session', async () => {
    const {client} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildGatewayApp(client)
    const res = await app.request('/auth/logout', {method: 'POST'})
    expect(res.status).toBe(404)
  })

  it('gateway mode + operatorLogin set: the SSR page renders NO dashboard logout form', async () => {
    // Mixed config (gateway mode AND an operator login configured) must not render
    // the dashboard logout form — it would POST to /auth/logout, which is not
    // mounted in gateway mode. The gateway owns __Host-session.
    const {client} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildGatewayApp(client, {operatorLogin: 'octocat'})
    const res = await app.request('/', {headers: {cookie: 'gateway_session=valid'}})
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('/auth/logout')
  })
})

// ---------------------------------------------------------------------------
// flag-ON: Gateway branch — fail-closed on every error kind
// ---------------------------------------------------------------------------

describe('flag-ON: Gateway branch — fail-closed on validation failure', () => {
  it('getCurrentSession → err {kind:"http", status:404} → 302 redirect to the gateway login', async () => {
    const {client} = makeFakeOperatorClient(async () =>
      err({kind: 'http', status: 404} satisfies GatewayClientError),
    )
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('getCurrentSession → err {kind:"http", status:500} → 302 redirect to the gateway login', async () => {
    const {client} = makeFakeOperatorClient(async () =>
      err({kind: 'http', status: 500} satisfies GatewayClientError),
    )
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('getCurrentSession → err {kind:"network"} (timeout/network failure) → 302 redirect to the gateway login', async () => {
    const {client} = makeFakeOperatorClient(async () =>
      err({kind: 'network', message: 'Network error'} satisfies GatewayClientError),
    )
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('getCurrentSession → err {kind:"protocol"} (malformed/empty body) → 302 redirect to the gateway login', async () => {
    const {client} = makeFakeOperatorClient(async () =>
      err({kind: 'protocol', message: 'Failed to parse response JSON'} satisfies GatewayClientError),
    )
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('getCurrentSession → err {kind:"validation"} (schema-drift / legacy string expiresAt) → 302 redirect to the gateway login', async () => {
    // The operator client's parseOperatorSessionInfo rejects non-integer expiresAt
    // and returns a protocol error. We simulate the validation error kind here.
    const {client} = makeFakeOperatorClient(async () =>
      err({
        kind: 'validation',
        code: 'invalid_path',
        message: 'Validation error',
      } satisfies GatewayClientError),
    )
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })
})

// ---------------------------------------------------------------------------
// flag-ON: expired session defense
// ---------------------------------------------------------------------------

describe('flag-ON: expired session defense', () => {
  it('ok but expiresAt <= Date.now() (expired) → 302 redirect to the gateway login', async () => {
    const expiredSession: SessionDto = {
      operatorId: 12345,
      login: 'octocat',
      expiresAt: Date.now() - 1000, // 1 second in the past
    }
    const {client} = makeFakeOperatorClient(async () => ok(expiredSession))
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('ok but expiresAt === Date.now() (exactly now, not future) → 302 redirect to the gateway login', async () => {
    const now = Date.now()
    const exactNowSession: SessionDto = {
      operatorId: 12345,
      login: 'octocat',
      expiresAt: now,
    }
    const {client} = makeFakeOperatorClient(async () => ok(exactNowSession))
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('ok with future expiresAt → allowed', async () => {
    const futureSession: SessionDto = {
      operatorId: 12345,
      login: 'octocat',
      expiresAt: Date.now() + 3600_000, // 1 hour in the future
    }
    const {client} = makeFakeOperatorClient(async () => ok(futureSession))
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// flag-ON: no inbound cookie → denied, getCurrentSession NOT called
// ---------------------------------------------------------------------------

describe('flag-ON: no inbound cookie', () => {
  it('no cookie header → 302 redirect to the gateway login', async () => {
    const {client} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildGatewayApp(client)
    // No cookie header at all
    const res = await app.request('/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('no cookie header → getCurrentSession is NEVER called', async () => {
    const {client, getCurrentSessionSpy} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildGatewayApp(client)
    await app.request('/')
    // Must not call getCurrentSession when there is no cookie to forward
    expect(getCurrentSessionSpy).not.toHaveBeenCalled()
  })

  it('empty cookie header → 302 redirect without calling getCurrentSession', async () => {
    const {client, getCurrentSessionSpy} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {headers: {cookie: ''}})
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
    expect(getCurrentSessionSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// flag-ON: end-to-end — inbound cookie forwarded to /operator/session
// ---------------------------------------------------------------------------

describe('flag-ON: end-to-end — cookie forwarding via real adapter', () => {
  it('inbound cookie is forwarded verbatim to /operator/session call', async () => {
    // Use a real createOperatorClient + createOperatorServerFetch with a recording fetchImpl
    // to assert the outbound /operator/session request carried the inbound cookie.
    const inboundCookie = 'gateway_session=test-gateway-cookie-abc123'
    const capturedRequests: {url: string; headers: Record<string, string>}[] = []

    const recordingFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      capturedRequests.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      // Return a valid session response
      const body = JSON.stringify({
        operatorId: 42,
        login: 'octocat',
        expiresAt: Date.now() + 3600_000,
      })
      return new Response(body, {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    }

    // Build the app with a real client constructed from the server-fetch adapter
    // We inject it as operatorClient so the middleware uses it directly
    const serverFetch = createOperatorServerFetch({
      origin: 'http://localhost:3000',
      cookie: inboundCookie,
      fetchImpl: recordingFetch,
    })

    const noopEventStream = (_path: string) => ({
      start: () => {
        throw new Error('SSE not used in getCurrentSession')
      },
      close: () => undefined,
    })

    const realClient = createOperatorClient({
      fetch: serverFetch,
      createEventStream: noopEventStream,
    })

    const app = await buildGatewayApp(realClient)
    const res = await app.request('/', {
      headers: {cookie: inboundCookie},
    })

    // Should succeed
    expect(res.status).toBe(200)

    // Assert the outbound request carried the inbound cookie
    expect(capturedRequests.length).toBeGreaterThan(0)
    const sessionRequest = capturedRequests.find(r => r.url.includes('/operator/session'))
    expect(sessionRequest).toBeDefined()
    expect(sessionRequest?.headers.cookie).toBe(inboundCookie)
  })
})

// ---------------------------------------------------------------------------
// flag-ON: no DASHBOARD_OPERATOR_LOGIN check in gateway branch
// ---------------------------------------------------------------------------

describe('flag-ON: gateway branch ignores DASHBOARD_OPERATOR_LOGIN', () => {
  it('conflicting operatorLogin set → gateway session still governs access', async () => {
    // operatorLogin is set to 'octocat' but gateway session has a different login
    // The gateway branch must NOT check operatorLogin — access is governed by gateway session only
    const differentLoginSession: SessionDto = {
      operatorId: 99999,
      login: 'different-operator',
      expiresAt: Date.now() + 3600_000,
    }
    const {client} = makeFakeOperatorClient(async () => ok(differentLoginSession))

    // Build with both operatorLogin AND gateway flag — gateway should win
    const app = await buildDashboardApp({
      operatorLogin: TEST_OPERATOR, // 'octocat'
      cookieKey: TEST_KEY,
      gatewayOperatorSessionEnabled: true,
      operatorClient: client,
    })

    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    // Gateway session is valid → should be allowed regardless of operatorLogin mismatch
    expect(res.status).toBe(200)
  })

  it('operatorLogin set but gateway session fails → 302 redirect (gateway governs, not Arctic)', async () => {
    // Even though operatorLogin is configured, gateway branch failure → deny
    // This proves the gateway branch does NOT fall back to Arctic
    const {client} = makeFakeOperatorClient(async () =>
      err({kind: 'http', status: 401} satisfies GatewayClientError),
    )

    const app = await buildDashboardApp({
      operatorLogin: TEST_OPERATOR,
      cookieKey: TEST_KEY,
      gatewayOperatorSessionEnabled: true,
      operatorClient: client,
    })

    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    // Gateway failed → 302 redirect, even though a valid Arctic operatorLogin is configured
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })
})

// ---------------------------------------------------------------------------
// flag-ON: no union, no fallback between modes
// ---------------------------------------------------------------------------

describe('flag-ON: no union, no fallback between modes', () => {
  it('flag-ON + gateway fails + valid Arctic cookie present → 302 redirect (no fallback to Arctic)', async () => {
    // A valid Arctic session cookie is present, but gateway fails.
    // The gateway branch must NOT fall back to Arctic — deny is the only outcome.
    const {client} = makeFakeOperatorClient(async () =>
      err({kind: 'http', status: 503} satisfies GatewayClientError),
    )

    const app = await buildDashboardApp({
      operatorLogin: TEST_OPERATOR,
      cookieKey: TEST_KEY,
      gatewayOperatorSessionEnabled: true,
      operatorClient: client,
    })

    // Send BOTH a valid Arctic session cookie AND a gateway cookie
    const arcticCookie = signArcticCookie()
    const res = await app.request('/', {
      headers: {cookie: `session=${arcticCookie}; gateway_session=some-cookie`},
    })
    // Gateway failed → 302 redirect, even though Arctic cookie is valid
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('flag-ON + no cookie + valid Arctic cookie → 302 redirect (gateway branch runs, no fallback)', async () => {
    // Even with a valid Arctic cookie, if gateway mode is ON and no cookie is forwarded
    // to the gateway check, the request is denied.
    const {client, getCurrentSessionSpy} = makeFakeOperatorClient(async () => ok(VALID_SESSION))

    const app = await buildDashboardApp({
      operatorLogin: TEST_OPERATOR,
      cookieKey: TEST_KEY,
      gatewayOperatorSessionEnabled: true,
      operatorClient: client,
    })

    // No cookie at all
    const res = await app.request('/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
    // getCurrentSession must not be called (no cookie to forward)
    expect(getCurrentSessionSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// gateway branch sets gatewaySession, NOT sessionLogin
// ---------------------------------------------------------------------------

describe('gateway branch sets gatewaySession context, not sessionLogin', () => {
  it('gateway mode: /api/status accessible with valid gateway session', async () => {
    const {client} = makeFakeOperatorClient(async () => ok(VALID_SESSION))
    const app = await buildGatewayApp(client)
    const res = await app.request('/api/status', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    // /api/status is a protected route — should be accessible with valid gateway session
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Fix 1: configured origin — spoofed Host does NOT change /operator/session target
// ---------------------------------------------------------------------------

describe('flag-ON: configured origin is always used, not the inbound Host', () => {
  it('a spoofed Host header does not change the /operator/session target origin', async () => {
    // This test exercises the production client-construction path (no operatorClient injected).
    // We inject a recording gatewayFetchImpl to capture the outbound URL.
    const capturedUrls: string[] = []

    const recordingFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
      capturedUrls.push(url)
      const body = JSON.stringify({
        operatorId: 1,
        login: 'octocat',
        expiresAt: Date.now() + 3600_000,
      })
      return new Response(body, {status: 200, headers: {'content-type': 'application/json'}})
    }

    // Configure a specific trusted origin
    const trustedOrigin = 'https://dashboard.fro.bot'
    const app = await buildDashboardApp({
      gatewayOperatorSessionEnabled: true,
      gatewayOperatorOrigin: trustedOrigin,
      gatewayFetchImpl: recordingFetch,
    })

    // Send a request with a spoofed Host header pointing to an attacker origin
    const res = await app.request('http://attacker.example.com/', {
      headers: {
        cookie: 'gateway_session=some-cookie',
        host: 'attacker.example.com',
      },
    })

    // The request should succeed (valid session returned by recordingFetch)
    expect(res.status).toBe(200)

    // The outbound /operator/session URL must use the CONFIGURED origin, not the attacker's
    const sessionCall = capturedUrls.find(u => u.includes('/operator/session'))
    expect(sessionCall).toBeDefined()
    expect(sessionCall).toMatch(/^https:\/\/dashboard\.fro\.bot\//)
    expect(sessionCall).not.toMatch(/attacker\.example\.com/)
  })

  it('different inbound Host headers always produce the same configured-origin target', async () => {
    const capturedUrls: string[] = []

    const recordingFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
      capturedUrls.push(url)
      const body = JSON.stringify({
        operatorId: 1,
        login: 'octocat',
        expiresAt: Date.now() + 3600_000,
      })
      return new Response(body, {status: 200, headers: {'content-type': 'application/json'}})
    }

    const trustedOrigin = 'https://dashboard.fro.bot'
    const app = await buildDashboardApp({
      gatewayOperatorSessionEnabled: true,
      gatewayOperatorOrigin: trustedOrigin,
      gatewayFetchImpl: recordingFetch,
    })

    // First request with one Host
    await app.request('http://host-a.example.com/', {
      headers: {cookie: 'gw=cookie1', host: 'host-a.example.com'},
    })
    // Second request with a different Host
    await app.request('http://host-b.example.com/', {
      headers: {cookie: 'gw=cookie2', host: 'host-b.example.com'},
    })

    // Both outbound calls must target the configured origin
    const sessionCalls = capturedUrls.filter(u => u.includes('/operator/session'))
    expect(sessionCalls).toHaveLength(2)
    for (const url of sessionCalls) {
      expect(url).toMatch(/^https:\/\/dashboard\.fro\.bot\//)
    }
  })

  it('invalid configured origin → fail closed (302 redirect, no request issued)', async () => {
    const capturedUrls: string[] = []
    const recordingFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
      capturedUrls.push(url)
      return new Response('{}', {status: 200})
    }

    // Inject an invalid origin — should cause fail-closed behavior
    const app = await buildDashboardApp({
      gatewayOperatorSessionEnabled: true,
      gatewayOperatorOrigin: 'not-a-valid-url',
      gatewayFetchImpl: recordingFetch,
    })

    const res = await app.request('/', {
      headers: {cookie: 'gw=some-cookie'},
    })

    // Must fail closed — no request to the gateway, 302 redirect
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
    expect(capturedUrls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Fix 2: production client-construction path (no operatorClient injected)
// ---------------------------------------------------------------------------

describe('flag-ON: production client-construction path (gatewayFetchImpl seam)', () => {
  it('production path: outbound request goes to configured origin + /operator/session', async () => {
    const capturedRequests: {url: string; headers: Record<string, string>}[] = []

    const recordingFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      capturedRequests.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      const body = JSON.stringify({
        operatorId: 42,
        login: 'octocat',
        expiresAt: Date.now() + 3600_000,
      })
      return new Response(body, {status: 200, headers: {'content-type': 'application/json'}})
    }

    const inboundCookie = 'gateway_session=prod-path-cookie-xyz'
    const app = await buildDashboardApp({
      gatewayOperatorSessionEnabled: true,
      gatewayOperatorOrigin: 'https://dashboard.fro.bot',
      gatewayFetchImpl: recordingFetch,
      // operatorClient is NOT injected — the production branch runs
    })

    const res = await app.request('/', {
      headers: {cookie: inboundCookie},
    })

    // Valid session → access granted
    expect(res.status).toBe(200)

    // The outbound request must go to the configured origin + /operator/session
    const sessionCall = capturedRequests.find(r => r.url.includes('/operator/session'))
    expect(sessionCall).toBeDefined()
    expect(sessionCall?.url).toBe('https://dashboard.fro.bot/operator/session')

    // The inbound end-user cookie must be forwarded
    expect(sessionCall?.headers.cookie).toBe(inboundCookie)
  })

  it('production path: 404 from gateway → denied (fail-closed)', async () => {
    const recordingFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      return new Response('Not Found', {status: 404})
    }

    const app = await buildDashboardApp({
      gatewayOperatorSessionEnabled: true,
      gatewayOperatorOrigin: 'https://dashboard.fro.bot',
      gatewayFetchImpl: recordingFetch,
    })

    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('production path: aborted/timed-out fetch → denied (fail-closed)', async () => {
    // Simulate a timeout by throwing an AbortError from the fetch
    const abortingFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    const app = await buildDashboardApp({
      gatewayOperatorSessionEnabled: true,
      gatewayOperatorOrigin: 'https://dashboard.fro.bot',
      gatewayFetchImpl: abortingFetch,
    })

    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })

    // Timeout/abort → network error → deny
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })
})

// ---------------------------------------------------------------------------
// Fix 6: nonsensical identity rejection (operatorId <= 0, empty login)
// ---------------------------------------------------------------------------

describe('flag-ON: nonsensical identity rejection', () => {
  it('operatorId === 0 → 302 redirect (non-positive operatorId denied)', async () => {
    const zeroIdSession: SessionDto = {
      operatorId: 0,
      login: 'octocat',
      expiresAt: Date.now() + 3600_000,
    }
    const {client} = makeFakeOperatorClient(async () => ok(zeroIdSession))
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('operatorId === -1 → 302 redirect (negative operatorId denied)', async () => {
    const negativeIdSession: SessionDto = {
      operatorId: -1,
      login: 'octocat',
      expiresAt: Date.now() + 3600_000,
    }
    const {client} = makeFakeOperatorClient(async () => ok(negativeIdSession))
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('empty login string → 302 redirect (blank login denied)', async () => {
    const emptyLoginSession: SessionDto = {
      operatorId: 12345,
      login: '',
      expiresAt: Date.now() + 3600_000,
    }
    const {client} = makeFakeOperatorClient(async () => ok(emptyLoginSession))
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('whitespace-only login → 302 redirect (blank login denied)', async () => {
    const whitespaceLoginSession: SessionDto = {
      operatorId: 12345,
      login: '   ',
      expiresAt: Date.now() + 3600_000,
    }
    const {client} = makeFakeOperatorClient(async () => ok(whitespaceLoginSession))
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('valid operatorId > 0 and non-empty login → allowed', async () => {
    const validSession: SessionDto = {
      operatorId: 1,
      login: 'octocat',
      expiresAt: Date.now() + 3600_000,
    }
    const {client} = makeFakeOperatorClient(async () => ok(validSession))
    const app = await buildGatewayApp(client)
    const res = await app.request('/', {
      headers: {cookie: 'gateway_session=some-cookie'},
    })
    expect(res.status).toBe(200)
  })
})
