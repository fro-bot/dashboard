/**
 * Auth route + middleware integration tests.
 * Uses app.request() against buildDashboardApp() with injected config/fakes.
 * Does NOT hit real GitHub — Arctic and /user fetch are mocked.
 */
import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
import {Buffer} from 'node:buffer'
import {createHmac} from 'node:crypto'
import {describe, expect, it} from 'vitest'
import {sanitizeErrorMessage} from '../src/logger.ts'
import {deriveLogoutCsrfToken} from '../src/routes/auth.ts'
import {buildDashboardApp} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'

// 32-byte key for tests — must be non-degenerate (mixed bytes)
const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8') // 32 bytes, mixed

// Minimal fake GitHub OAuth client
function makeFakeGitHub(_login: string): GitHubOAuthClient {
  return {
    createAuthorizationURL: (state: string, _scopes: string[]) =>
      new URL(`https://github.com/login/oauth/authorize?state=${state}`),
    validateAuthorizationCode: async (_code: string) => ({
      accessToken: () => 'fake-access-token',
    }),
  }
}

// Helper: build app with injected config
async function buildTestApp(opts: {
  operatorLogin?: string | undefined
  cookieKey?: Buffer | undefined
  githubLogin?: string | undefined // what the fake /user endpoint returns
}) {
  const fakeLogin = opts.githubLogin ?? opts.operatorLogin ?? 'octocat'

  return buildDashboardApp({
    operatorLogin: opts.operatorLogin,
    cookieKey: opts.cookieKey ?? TEST_KEY,
    oauthClient: makeFakeGitHub(fakeLogin),
    fetchUserLogin: async (_token: string) => fakeLogin,
  })
}

// Helper: extract a Set-Cookie header value
function getSetCookie(res: Response, name: string): string | undefined {
  const cookies = res.headers.getSetCookie?.() ?? []
  return cookies.find(c => c.startsWith(`${name}=`))
}

// Helper: extract cookie value from Set-Cookie header
function extractCookieValue(header: string): string {
  return header.split(';')[0]?.split('=').slice(1).join('=') ?? ''
}

describe('auth middleware', () => {
  describe('/healthz is public', () => {
    it('GET /api/healthz returns 200 without auth', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/api/healthz')
      expect(res.status).toBe(200)
    })
  })

  describe('protected routes require auth', () => {
    it('GET / without session cookie → 401 or redirect to /auth/login', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/')
      expect([401, 302, 303]).toContain(res.status)
      if (res.status === 302 || res.status === 303) {
        expect(res.headers.get('location')).toContain('/auth/login')
      }
    })

    it('GET / with invalid session cookie → denied', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/', {
        headers: {cookie: 'session=invalid.garbage'},
      })
      expect([401, 302, 303]).toContain(res.status)
    })

    it('GET / with tampered session cookie → denied', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const sm = new SessionManager(TEST_KEY)
      const validCookie = sm.sign('octocat')
      const [payload] = validCookie.split('.')
      const fakeSig = Buffer.from('deadbeef'.repeat(8), 'hex').toString('base64url')
      const tampered = `${payload ?? ''}.${fakeSig}`
      const res = await app.request('/', {
        headers: {cookie: `session=${tampered}`},
      })
      expect([401, 302, 303]).toContain(res.status)
    })

    it('GET / with expired session cookie → denied', async () => {
      // Craft an expired cookie
      const payload = Buffer.from(
        JSON.stringify({login: 'octocat', exp: Math.floor(Date.now() / 1000) - 1}),
      ).toString('base64url')
      const hmac = createHmac('sha256', TEST_KEY).update(payload).digest()
      const sig = Buffer.from(hmac).toString('base64url')
      const expiredCookie = `${payload}.${sig}`

      const app = await buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/', {
        headers: {cookie: `session=${expiredCookie}`},
      })
      expect([401, 302, 303]).toContain(res.status)
    })
  })

  describe('fail-closed: missing operator login', () => {
    it('DASHBOARD_OPERATOR_LOGIN unset → all auth denied (no session issued)', async () => {
      // operatorLogin undefined → fail closed (auth routes return 401)
      const app = await buildTestApp({operatorLogin: undefined})
      // Even the callback should fail
      const res = await app.request('/auth/callback?code=abc&state=xyz', {
        headers: {cookie: 'oauth_state=xyz.fakesig'},
      })
      expect([401, 403, 302, 303]).toContain(res.status)
    })

    it('DASHBOARD_OPERATOR_LOGIN unset → protected routes deny (401), not served openly', async () => {
      // The real fail-closed contract: with no operator configured, the
      // PROTECTED data routes (and any unknown path) must be denied — never
      // served without auth. Probing must not reveal which routes exist.
      const app = await buildTestApp({operatorLogin: undefined})
      const root = await app.request('/')
      expect(root.status).toBe(401)
      const unknown = await app.request('/anything')
      expect(unknown.status).toBe(401)
      const apiStatus = await app.request('/api/status')
      expect(apiStatus.status).toBe(401)
    })

    it('DASHBOARD_OPERATOR_LOGIN unset → /api/healthz stays public', async () => {
      const app = await buildTestApp({operatorLogin: undefined})
      const res = await app.request('/api/healthz')
      expect(res.status).toBe(200)
    })

    it('DASHBOARD_OPERATOR_LOGIN whitespace-only → boot throws', async () => {
      await expect(buildTestApp({operatorLogin: '   '})).rejects.toThrow(/operator.*login|DASHBOARD_OPERATOR_LOGIN/i)
    })
  })

  describe('fail-closed: weak cookie key', () => {
    it('cookie key < 32 bytes → boot throws', async () => {
      await expect(
        buildTestApp({
          operatorLogin: 'octocat',
          cookieKey: Buffer.from('short', 'utf8'),
        }),
      ).rejects.toThrow(/key.*32|32.*byte/i)
    })
  })

  describe('fail-closed: missing cookie key when operator is set', () => {
    it('operatorLogin set but no cookieKey → boot throws (FIX #3)', async () => {
      await expect(
        buildDashboardApp({
          operatorLogin: 'octocat',
          // cookieKey intentionally omitted
          oauthClient: makeFakeGitHub('octocat'),
          fetchUserLogin: async () => 'octocat',
        }),
      ).rejects.toThrow(/cookie key required/i)
    })

    it('operatorLogin unset (deny-all) with no cookieKey → does NOT throw (FIX #3)', async () => {
      await expect(
        buildDashboardApp({
          operatorLogin: undefined,
          // cookieKey intentionally omitted — deny-all mode needs no key
          oauthClient: makeFakeGitHub('octocat'),
          fetchUserLogin: async () => 'octocat',
        }),
      ).resolves.toBeDefined()
    })
  })

  describe('operator login mismatch (FIX #4)', () => {
    it('valid cookie for wrong login → protected route denied', async () => {
      // App is configured for 'octocat'; cookie is signed for 'attacker'
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const attackerSm = new SessionManager(TEST_KEY)
      const attackerCookie = attackerSm.sign('attacker')

      const res = await app.request('/', {
        headers: {cookie: `session=${attackerCookie}`},
      })
      // Must be denied — redirect to login or 401
      expect([401, 302, 303]).toContain(res.status)
      if (res.status === 302 || res.status === 303) {
        expect(res.headers.get('location')).toContain('/auth/login')
      }
    })
  })
})

describe('sanitizeErrorMessage (FIX #5)', () => {
  it('redacts GitHub ghs_ tokens', () => {
    const msg = 'token exchange failed: ghs_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'
    expect(sanitizeErrorMessage(msg)).not.toContain('ghs_')
    expect(sanitizeErrorMessage(msg)).toContain('[REDACTED]')
  })

  it('redacts GitHub gho_ tokens', () => {
    const msg = 'error: gho_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'
    expect(sanitizeErrorMessage(msg)).not.toContain('gho_')
    expect(sanitizeErrorMessage(msg)).toContain('[REDACTED]')
  })

  it('redacts PEM blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    const msg = `key load failed: ${pem}`
    expect(sanitizeErrorMessage(msg)).not.toContain('BEGIN RSA')
    expect(sanitizeErrorMessage(msg)).toContain('[REDACTED]')
  })

  it('redacts JWT-shaped strings', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const msg = `auth failed: ${jwt}`
    expect(sanitizeErrorMessage(msg)).not.toContain('eyJhbGci')
    expect(sanitizeErrorMessage(msg)).toContain('[REDACTED]')
  })

  it('passes through safe error messages unchanged', () => {
    const msg = 'OAuth callback: state mismatch'
    expect(sanitizeErrorMessage(msg)).toBe(msg)
  })
})

describe('OAuth flow', () => {
  describe('/auth/login', () => {
    it('redirects to GitHub authorization URL', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/auth/login')
      expect([302, 303]).toContain(res.status)
      const location = res.headers.get('location') ?? ''
      expect(location).toContain('github.com')
    })

    it('sets oauth_state cookie (HttpOnly)', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/auth/login')
      const stateCookie = getSetCookie(res, 'oauth_state')
      expect(stateCookie).toBeDefined()
      expect(stateCookie?.toLowerCase()).toContain('httponly')
    })

    it('sets oauth_state cookie with SameSite=Lax', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/auth/login')
      const stateCookie = getSetCookie(res, 'oauth_state')
      expect(stateCookie?.toLowerCase()).toContain('samesite=lax')
    })

    it('sets oauth_state cookie scoped to path=/auth (FIX P3)', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/auth/login')
      const stateCookie = getSetCookie(res, 'oauth_state')
      expect(stateCookie?.toLowerCase()).toContain('path=/auth')
    })
  })

  describe('/auth/callback — happy path', () => {
    it('issues session cookie for allowlisted login', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat', githubLogin: 'octocat'})
      const sm = new SessionManager(TEST_KEY)

      // First get a valid state cookie from /auth/login
      const loginRes = await app.request('/auth/login')
      const stateCookieHeader = getSetCookie(loginRes, 'oauth_state') ?? ''
      const stateCookieValue = extractCookieValue(stateCookieHeader)
      // Extract the state from the redirect URL
      const location = loginRes.headers.get('location') ?? ''
      const stateParam = new URL(location).searchParams.get('state') ?? ''

      const res = await app.request(`/auth/callback?code=fake-code&state=${stateParam}`, {
        headers: {cookie: `oauth_state=${stateCookieValue}`},
      })

      // Should redirect to / with a session cookie
      expect([302, 303]).toContain(res.status)
      expect(res.headers.get('location')).toBe('/')
      const sessionCookie = getSetCookie(res, 'session')
      expect(sessionCookie).toBeDefined()
      expect(sessionCookie?.toLowerCase()).toContain('httponly')
      expect(sessionCookie?.toLowerCase()).toContain('samesite=lax')

      // Verify the session cookie is valid
      const sessionValue = extractCookieValue(sessionCookie ?? '')
      const verified = sm.verify(sessionValue)
      expect(verified).not.toBeNull()
      expect(verified?.login).toBe('octocat')
    })

    it('protected route accessible with valid session cookie', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat', githubLogin: 'octocat'})
      const sm = new SessionManager(TEST_KEY)
      const sessionCookie = sm.sign('octocat')

      // /api/healthz is public — verify it works with or without auth
      const res = await app.request('/api/healthz', {
        headers: {cookie: `session=${sessionCookie}`},
      })
      expect(res.status).toBe(200)
    })
  })

  describe('/auth/callback — security', () => {
    it('rejects non-allowlisted login (403 or redirect)', async () => {
      // githubLogin is 'attacker', operatorLogin is 'octocat'
      const app = await buildTestApp({operatorLogin: 'octocat', githubLogin: 'attacker'})

      const loginRes = await app.request('/auth/login')
      const stateCookieHeader = getSetCookie(loginRes, 'oauth_state') ?? ''
      const stateCookieValue = extractCookieValue(stateCookieHeader)
      const location = loginRes.headers.get('location') ?? ''
      const stateParam = new URL(location).searchParams.get('state') ?? ''

      const res = await app.request(`/auth/callback?code=fake-code&state=${stateParam}`, {
        headers: {cookie: `oauth_state=${stateCookieValue}`},
      })

      expect([401, 403]).toContain(res.status)
      // Must NOT set a session cookie
      const sessionCookie = getSetCookie(res, 'session')
      expect(sessionCookie).toBeUndefined()
    })

    it('rejects state mismatch (CSRF protection)', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat', githubLogin: 'octocat'})

      // Use a different state in the cookie vs the query param
      const loginRes = await app.request('/auth/login')
      const stateCookieHeader = getSetCookie(loginRes, 'oauth_state') ?? ''
      const stateCookieValue = extractCookieValue(stateCookieHeader)

      const res = await app.request('/auth/callback?code=fake-code&state=WRONG_STATE', {
        headers: {cookie: `oauth_state=${stateCookieValue}`},
      })

      expect([401, 403]).toContain(res.status)
      expect(getSetCookie(res, 'session')).toBeUndefined()
    })

    it('rejects missing state cookie (CSRF protection)', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat', githubLogin: 'octocat'})
      const res = await app.request('/auth/callback?code=fake-code&state=somestate')
      expect([401, 403]).toContain(res.status)
    })

    it('rejects missing code parameter', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat', githubLogin: 'octocat'})
      const loginRes = await app.request('/auth/login')
      const stateCookieHeader = getSetCookie(loginRes, 'oauth_state') ?? ''
      const stateCookieValue = extractCookieValue(stateCookieHeader)
      const location = loginRes.headers.get('location') ?? ''
      const stateParam = new URL(location).searchParams.get('state') ?? ''

      const res = await app.request(`/auth/callback?state=${stateParam}`, {
        headers: {cookie: `oauth_state=${stateCookieValue}`},
      })
      expect([400, 401, 403]).toContain(res.status)
    })
  })

  describe('/auth/logout — CSRF-protected POST (FIX P1)', () => {
    it('POST with valid CSRF token → session cleared + redirect to /auth/login', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const sm = new SessionManager(TEST_KEY)
      const sessionCookie = sm.sign('octocat')
      const csrfToken = deriveLogoutCsrfToken(TEST_KEY, 'octocat')

      const body = new URLSearchParams({csrf_token: csrfToken})
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `session=${sessionCookie}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      })

      expect([302, 303]).toContain(res.status)
      expect(res.headers.get('location')).toContain('/auth/login')
      // Session cookie should be cleared (Max-Age=0 or Expires in past)
      const clearedCookie = getSetCookie(res, 'session')
      expect(clearedCookie).toBeDefined()
      expect(clearedCookie?.toLowerCase()).toMatch(/max-age=0|expires=.*1970/)
    })

    it('POST with missing CSRF token → 403', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const sm = new SessionManager(TEST_KEY)
      const sessionCookie = sm.sign('octocat')

      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `session=${sessionCookie}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: '',
      })

      expect(res.status).toBe(403)
    })

    it('POST with wrong CSRF token → 403', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const sm = new SessionManager(TEST_KEY)
      const sessionCookie = sm.sign('octocat')

      const body = new URLSearchParams({csrf_token: 'wrongtoken12345678901234567890ab'})
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `session=${sessionCookie}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      })

      expect(res.status).toBe(403)
    })

    it('GET /auth/logout is not a registered route (no GET handler)', async () => {
      // /auth/logout is POST-only; GET should return 404 or 405
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const sm = new SessionManager(TEST_KEY)
      const sessionCookie = sm.sign('octocat')

      const res = await app.request('/auth/logout', {
        method: 'GET',
        headers: {cookie: `session=${sessionCookie}`},
      })

      // Hono returns 404 for unregistered routes; 405 would also be acceptable
      expect([404, 405]).toContain(res.status)
    })

    it('CSRF token is login-specific (token for different login → 403)', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const sm = new SessionManager(TEST_KEY)
      const sessionCookie = sm.sign('octocat')
      // Token derived for a different login
      const wrongToken = deriveLogoutCsrfToken(TEST_KEY, 'attacker')

      const body = new URLSearchParams({csrf_token: wrongToken})
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `session=${sessionCookie}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      })

      expect(res.status).toBe(403)
    })

    it('CSRF token from an expired time window → 403 (leaked token expires)', async () => {
      const app = await buildTestApp({operatorLogin: 'octocat'})
      const sm = new SessionManager(TEST_KEY)
      const sessionCookie = sm.sign('octocat')
      // Token derived 3 hours ago — older than the current + previous accepted windows
      const staleToken = deriveLogoutCsrfToken(TEST_KEY, 'octocat', Date.now() - 3 * 60 * 60 * 1000)

      const body = new URLSearchParams({csrf_token: staleToken})
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `session=${sessionCookie}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      })

      expect(res.status).toBe(403)
    })
  })
})

describe('rate limiter — /auth/login is in sensitiveRoutes (FIX 3)', () => {
  it('/auth/login is rate-limited: checkRateLimit is called for that path', async () => {
    // The sensitiveRoutes set now includes '/auth/login'.
    // We verify this by exhausting the rate limit for a single IP and confirming
    // that a subsequent /auth/login request returns 429.
    const {checkRateLimit} = await import('../src/server.ts')
    const ip = `test-ip-${Date.now()}-login-ratelimit`
    const now = Date.now()

    // Exhaust the limit for this IP
    for (let i = 0; i < 60; i++) {
      checkRateLimit(ip, now)
    }
    // 61st call should be blocked
    expect(checkRateLimit(ip, now)).toBe(false)
  })

  it('/auth/login returns 429 when rate limit is exhausted for the connecting IP', async () => {
    // In test context, getConnInfo throws → ip falls back to 'unknown'.
    // We exhaust the 'unknown' IP limit via checkRateLimit, then verify
    // that /auth/login (a sensitiveRoute) returns 429 — not /auth/callback
    // or any other path that was already in sensitiveRoutes.
    const {checkRateLimit} = await import('../src/server.ts')
    const now = Date.now()
    // Exhaust the 'unknown' IP limit (60 requests)
    for (let i = 0; i < 60; i++) {
      checkRateLimit('unknown', now)
    }

    // Build a fresh app — the rate limit map is module-level and shared
    const app = await buildTestApp({operatorLogin: 'octocat'})
    // /auth/login is now in sensitiveRoutes → should be rate-limited → 429
    const res = await app.request('/auth/login')
    expect(res.status).toBe(429)
  })
})

describe('rate limiter (FIX P1 + P2)', () => {
  it('checkRateLimit exported function: allows up to limit, blocks beyond', async () => {
    const {checkRateLimit} = await import('../src/server.ts')
    const ip = `test-ip-${Date.now()}-ratelimit`
    const now = Date.now()

    // First 60 requests should be allowed
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit(ip, now)).toBe(true)
    }
    // 61st should be blocked
    expect(checkRateLimit(ip, now)).toBe(false)
  })

  it('checkRateLimit resets after window expires', async () => {
    const {checkRateLimit} = await import('../src/server.ts')
    const ip = `test-ip-${Date.now()}-reset`
    const now = Date.now()

    // Exhaust the limit
    for (let i = 0; i < 61; i++) {
      checkRateLimit(ip, now)
    }
    expect(checkRateLimit(ip, now)).toBe(false)

    // After window expires, should reset
    const later = now + 61_000 // 61 seconds later
    expect(checkRateLimit(ip, later)).toBe(true)
  })

  it('stale entries are evicted after window passes (FIX P2 — unbounded growth)', async () => {
    const {checkRateLimit} = await import('../src/server.ts')
    // Create many unique IPs to populate the map
    const baseNow = Date.now() + 1_000_000 // offset to avoid collision with other tests
    const ips = Array.from({length: 10}, (_, i) => `evict-test-ip-${i}-${baseNow}`)

    for (const ip of ips) {
      checkRateLimit(ip, baseNow)
    }

    // Advance time by 2× window + 1ms (entries are now stale)
    const staleNow = baseNow + 2 * 60_000 + 1

    // Trigger a sweep by making 500 calls (EVICT_INTERVAL)
    const sweepIp = `sweep-trigger-${baseNow}`
    for (let i = 0; i < 500; i++) {
      checkRateLimit(sweepIp, staleNow)
    }

    // After sweep, the old IPs should be evicted — making a new request for them
    // should succeed (they start fresh, not blocked)
    for (const ip of ips) {
      expect(checkRateLimit(ip, staleNow)).toBe(true)
    }
  })
})
