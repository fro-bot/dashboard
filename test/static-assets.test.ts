/**
 * Tests for security headers, CSP, and static asset serving.
 *
 * Covers:
 * - CSP header present on responses with script-src 'self' and no 'unsafe-inline'
 * - GET /static/operator.css → 200 with CSS body + correct content-type, no auth required
 * - Operator page references <link rel="stylesheet"> and has no inline <style> block
 * - When operatorUiEnabled=false: /static/operator.css is not served (404/redirect)
 */
import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
import {Buffer} from 'node:buffer'
import {describe, expect, it} from 'vitest'
import {buildDashboardApp} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'

// ---------------------------------------------------------------------------
// Test helpers (mirrors operator-ui.test.ts pattern)
// ---------------------------------------------------------------------------

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

async function buildTestApp(operatorUiEnabled: boolean) {
  return buildDashboardApp({
    operatorLogin: TEST_OPERATOR,
    cookieKey: TEST_KEY,
    oauthClient: makeFakeOAuthClient(),
    fetchUserLogin: async (_token: string) => TEST_OPERATOR,
    getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
    operatorUiEnabled,
  })
}

async function authedGet(app: Awaited<ReturnType<typeof buildTestApp>>, path: string): Promise<Response> {
  const cookie = makeSessionCookie()
  return app.request(path, {headers: {cookie: `session=${cookie}`}})
}

// ---------------------------------------------------------------------------
// CSP header tests
// ---------------------------------------------------------------------------

describe('security headers — CSP', () => {
  it('CSP header is present on a normal response', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy')
    expect(csp).not.toBeNull()
  })

  it("CSP contains script-src 'self'", async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy')
    expect(csp).toContain("script-src 'self'")
  })

  it("CSP keeps script-src strict — 'self' with no 'unsafe-inline'", async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    // Inline script is the meaningful XSS vector, so script-src must stay strict.
    const scriptSrc = csp.split(';').map(d => d.trim()).find(d => d.startsWith('script-src')) ?? ''
    expect(scriptSrc).toBe("script-src 'self'")
    expect(scriptSrc).not.toContain("'unsafe-inline'")
  })

  it("CSP allows inline styles (style-src has 'unsafe-inline' for SSR style attributes)", async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    const styleSrc = csp.split(';').map(d => d.trim()).find(d => d.startsWith('style-src')) ?? ''
    expect(styleSrc).toContain("'unsafe-inline'")
  })

  it("CSP contains default-src 'self'", async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy')
    expect(csp).toContain("default-src 'self'")
  })

  it("CSP contains frame-ancestors 'none'", async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy')
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('CSP is present on error responses too (applies to all routes)', async () => {
    const app = await buildTestApp(false)
    // An unauthenticated request to a protected route gets denied
    const res = await app.request('/not-a-real-route')
    const csp = res.headers.get('content-security-policy')
    expect(csp).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Static asset serving tests
// ---------------------------------------------------------------------------

describe('static asset serving — /static/operator.css', () => {
  it('GET /static/operator.css returns 200 when operatorUiEnabled=true', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/static/operator.css')
    expect(res.status).toBe(200)
  })

  it('GET /static/operator.css returns CSS content-type', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/static/operator.css')
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toMatch(/text\/css/)
  })

  it('GET /static/operator.css returns non-empty CSS body', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/static/operator.css')
    expect(res.status).toBe(200)
    const body = await res.text()
    // Should contain actual CSS content from the extracted styles
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('box-sizing')
  })

  it('GET /static/operator.css is reachable WITHOUT an auth session (public path)', async () => {
    const app = await buildTestApp(true)
    // No session cookie — should NOT be 302'd to /auth/login
    const res = await app.request('/static/operator.css')
    expect(res.status).toBe(200)
    // Explicitly not a redirect
    expect(res.status).not.toBe(302)
    expect(res.status).not.toBe(303)
  })

  it('GET /static/operator.css is NOT served when operatorUiEnabled=false', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator.css')
    // When flag is off, the static route is not mounted — should not return 200
    expect(res.status).not.toBe(200)
  })

  it('GET /static/nonexistent.txt returns 404 (not a catch-all)', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/static/nonexistent.txt')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Operator page — link tag instead of inline style
// ---------------------------------------------------------------------------

describe('operator page — external stylesheet link', () => {
  it('operator page references <link rel="stylesheet" href="/static/operator.css">', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<link rel="stylesheet" href="/static/operator.css"')
  })

  it('operator page does NOT contain an inline <style> block', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    // The inline style block must be gone — replaced by the external link
    expect(body).not.toContain('<style>')
    expect(body).not.toContain('</style>')
  })

  it('operator page still renders correctly after style extraction', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    // Core content still present
    expect(body).toContain('Gateway Operator Controls')
    expect(body).toContain('lang="en"')
    expect(body).toContain('<!doctype html>')
  })
})

// ---------------------------------------------------------------------------
// Flag-off: static route absent
// ---------------------------------------------------------------------------

describe('static route absent when operator UI disabled', () => {
  it('GET /static/operator.css is not served when flag is off', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator.css')
    // Not 200 — route not mounted
    expect(res.status).not.toBe(200)
  })

  it('existing public routes still work when flag is off', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
  })
})
