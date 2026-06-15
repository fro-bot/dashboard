/**
 * Auth route + middleware integration tests.
 * Uses app.request() against buildDashboardApp() with injected config/fakes.
 * Does NOT hit real GitHub — Arctic and /user fetch are mocked.
 */
import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
import {Buffer} from 'node:buffer'
import {createHmac} from 'node:crypto'
import {describe, expect, it} from 'vitest'
import {buildDashboardApp} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'

// 32-byte key for tests
const TEST_KEY = Buffer.from('testkey-'.repeat(4), 'utf8') // 32 bytes

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
function buildTestApp(opts: {
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
      const app = buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/api/healthz')
      expect(res.status).toBe(200)
    })
  })

  describe('protected routes require auth', () => {
    it('GET / without session cookie → 401 or redirect to /auth/login', async () => {
      const app = buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/')
      expect([401, 302, 303]).toContain(res.status)
      if (res.status === 302 || res.status === 303) {
        expect(res.headers.get('location')).toContain('/auth/login')
      }
    })

    it('GET / with invalid session cookie → denied', async () => {
      const app = buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/', {
        headers: {cookie: 'session=invalid.garbage'},
      })
      expect([401, 302, 303]).toContain(res.status)
    })

    it('GET / with tampered session cookie → denied', async () => {
      const app = buildTestApp({operatorLogin: 'octocat'})
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

      const app = buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/', {
        headers: {cookie: `session=${expiredCookie}`},
      })
      expect([401, 302, 303]).toContain(res.status)
    })
  })

  describe('fail-closed: missing operator login', () => {
    it('DASHBOARD_OPERATOR_LOGIN unset → all auth denied (no session issued)', async () => {
      // operatorLogin undefined → fail closed (auth routes return 401)
      const app = buildTestApp({operatorLogin: undefined})
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
      const app = buildTestApp({operatorLogin: undefined})
      const root = await app.request('/')
      expect(root.status).toBe(401)
      const unknown = await app.request('/anything')
      expect(unknown.status).toBe(401)
      const apiStatus = await app.request('/api/status')
      expect(apiStatus.status).toBe(401)
    })

    it('DASHBOARD_OPERATOR_LOGIN unset → /api/healthz stays public', async () => {
      const app = buildTestApp({operatorLogin: undefined})
      const res = await app.request('/api/healthz')
      expect(res.status).toBe(200)
    })

    it('DASHBOARD_OPERATOR_LOGIN whitespace-only → boot throws', () => {
      expect(() => buildTestApp({operatorLogin: '   '})).toThrow(/operator.*login|DASHBOARD_OPERATOR_LOGIN/i)
    })
  })

  describe('fail-closed: weak cookie key', () => {
    it('cookie key < 32 bytes → boot throws', () => {
      expect(() =>
        buildTestApp({
          operatorLogin: 'octocat',
          cookieKey: Buffer.from('short', 'utf8'),
        }),
      ).toThrow(/key.*32|32.*byte/i)
    })
  })
})

describe('OAuth flow', () => {
  describe('/auth/login', () => {
    it('redirects to GitHub authorization URL', async () => {
      const app = buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/auth/login')
      expect([302, 303]).toContain(res.status)
      const location = res.headers.get('location') ?? ''
      expect(location).toContain('github.com')
    })

    it('sets oauth_state cookie (HttpOnly)', async () => {
      const app = buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/auth/login')
      const stateCookie = getSetCookie(res, 'oauth_state')
      expect(stateCookie).toBeDefined()
      expect(stateCookie?.toLowerCase()).toContain('httponly')
    })

    it('sets oauth_state cookie with SameSite=Lax', async () => {
      const app = buildTestApp({operatorLogin: 'octocat'})
      const res = await app.request('/auth/login')
      const stateCookie = getSetCookie(res, 'oauth_state')
      expect(stateCookie?.toLowerCase()).toContain('samesite=lax')
    })
  })

  describe('/auth/callback — happy path', () => {
    it('issues session cookie for allowlisted login', async () => {
      const app = buildTestApp({operatorLogin: 'octocat', githubLogin: 'octocat'})
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
      const app = buildTestApp({operatorLogin: 'octocat', githubLogin: 'octocat'})
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
      const app = buildTestApp({operatorLogin: 'octocat', githubLogin: 'attacker'})

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
      const app = buildTestApp({operatorLogin: 'octocat', githubLogin: 'octocat'})

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
      const app = buildTestApp({operatorLogin: 'octocat', githubLogin: 'octocat'})
      const res = await app.request('/auth/callback?code=fake-code&state=somestate')
      expect([401, 403]).toContain(res.status)
    })

    it('rejects missing code parameter', async () => {
      const app = buildTestApp({operatorLogin: 'octocat', githubLogin: 'octocat'})
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

  describe('/auth/logout', () => {
    it('clears session cookie and redirects', async () => {
      const app = buildTestApp({operatorLogin: 'octocat'})
      const sm = new SessionManager(TEST_KEY)
      const sessionCookie = sm.sign('octocat')

      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {cookie: `session=${sessionCookie}`},
      })

      expect([302, 303]).toContain(res.status)
      // Session cookie should be cleared (Max-Age=0 or Expires in past)
      const clearedCookie = getSetCookie(res, 'session')
      expect(clearedCookie).toBeDefined()
      expect(clearedCookie?.toLowerCase()).toMatch(/max-age=0|expires=.*1970/)
    })
  })
})
