/**
 * Tests for security headers, CSP, and static asset serving.
 *
 * Covers:
 * - CSP header present on responses with script-src 'self' and no 'unsafe-inline'
 * - GET /static/operator.css → 200 with CSS body + correct content-type, no auth required
 * - Operator page references <link rel="stylesheet"> and has no inline <style> block
 * - When operatorUiEnabled=false: /static/operator.css is not served (404/redirect)
 * - PWA SW assets: /sw.js + /registerSW.js served with correct MIME + no-cache, public pre-auth
 * - PWA manifest: /manifest.webmanifest served as application/manifest+json, public pre-auth
 * - CSP on /sw.js: no page CSP applied (workers don't inherit page CSP; over-restrictive CSP
 *   can block Workbox importScripts)
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

// ---------------------------------------------------------------------------
// PWA SW asset serving — /sw.js
// ---------------------------------------------------------------------------
// The MIME contract is load-bearing: a wrong Content-Type (e.g. text/html)
// causes the browser to reject SW registration entirely. Cache-Control must
// be no-store so SW updates are detected on every page load.

describe('PWA SW asset serving — /sw.js', () => {
  it('GET /sw.js returns 200', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
  })

  it('GET /sw.js returns a JavaScript Content-Type (load-bearing MIME — wrong type blocks SW registration)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
    const ct = res.headers.get('content-type') ?? ''
    // Must be a JavaScript MIME type — a wrong MIME (e.g. text/html) blocks SW registration.
    // Both text/javascript (RFC 9239 standard) and application/javascript (legacy) are valid.
    expect(ct).toMatch(/(?:text|application)\/javascript/)
  })

  it('GET /sw.js returns Cache-Control no-store so SW updates are detected', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toContain('no-store')
  })

  it('GET /sw.js is reachable WITHOUT an auth session (public path)', async () => {
    const app = await buildTestApp(false)
    // No session cookie — must NOT be 302'd to /auth/login
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(302)
    expect(res.status).not.toBe(401)
  })

  it('GET /sw.js does NOT carry the page CSP (workers do not inherit page CSP; over-restrictive CSP can block Workbox)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
    // The page CSP must not be applied to the SW response — it is irrelevant
    // for workers and a too-restrictive CSP can block Workbox importScripts.
    const csp = res.headers.get('content-security-policy')
    expect(csp).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PWA SW asset serving — /registerSW.js
// ---------------------------------------------------------------------------
// NOTE: vite-plugin-pwa only emits registerSW.js when the virtual module
// virtual:pwa-register/react is NOT consumed by the app bundle (i.e. when
// using the auto-register mode). Since the app uses useRegisterSW() in a
// component (ReloadPrompt), the registration code is bundled into the main
// JS chunk and registerSW.js is NOT emitted. The server-side route for
// /registerSW.js remains (it is harmless and in isPublicPath), but the file
// no longer exists in web/dist/ so requests return 404.
// The public-path allowlist and no-cache header middleware are still correct
// for forward-compatibility (if the build mode changes, the route is ready).

describe('PWA SW asset serving — /registerSW.js', () => {
  it('GET /registerSW.js is in the public allowlist (no auth redirect)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/registerSW.js')
    // The file is not emitted when useRegisterSW is used in a component, so
    // the response is 404 — but it must NOT be a 302 auth redirect or 401.
    // The public-path allowlist ensures unauthenticated access is permitted.
    expect(res.status).not.toBe(302)
    expect(res.status).not.toBe(401)
  })
})

// ---------------------------------------------------------------------------
// PWA manifest serving — /manifest.webmanifest
// ---------------------------------------------------------------------------

describe('PWA manifest serving — /manifest.webmanifest', () => {
  it('GET /manifest.webmanifest returns 200', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/manifest.webmanifest')
    expect(res.status).toBe(200)
  })

  it('GET /manifest.webmanifest returns Content-Type application/manifest+json (PWA installability)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/manifest.webmanifest')
    expect(res.status).toBe(200)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).toMatch(/application\/manifest\+json/)
  })

  it('GET /manifest.webmanifest is reachable WITHOUT an auth session (public path)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(302)
    expect(res.status).not.toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Auth boundary: SW assets are public but protected routes are still gated
// ---------------------------------------------------------------------------

describe('auth boundary — SW assets public, protected routes still gated', () => {
  it('/sw.js is public but / (the SPA shell) still requires auth', async () => {
    const app = await buildTestApp(false)
    // SW is public
    const swRes = await app.request('/sw.js')
    expect(swRes.status).toBe(200)
    // / requires auth — no session → redirect or deny
    const rootRes = await app.request('/')
    expect(rootRes.status).not.toBe(200)
  })

  it('/registerSW.js path is public (no auth redirect) but /api/monitoring still requires auth', async () => {
    const app = await buildTestApp(false)
    const swRes = await app.request('/registerSW.js')
    // registerSW.js is in the public allowlist — no auth redirect even if the
    // file is not emitted (useRegisterSW bundles registration into the main chunk).
    expect(swRes.status).not.toBe(302)
    expect(swRes.status).not.toBe(401)
    // /api/monitoring is protected — no session → deny
    const apiRes = await app.request('/api/monitoring')
    expect(apiRes.status).not.toBe(200)
  })
})

// ---------------------------------------------------------------------------
// CSP invariant: existing worker-src/manifest-src 'self' already covers SW+manifest
// ---------------------------------------------------------------------------

describe('CSP invariant — worker-src and manifest-src already cover SW+manifest', () => {
  it("CSP on a normal response contains worker-src 'self' (covers SW registration)", async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("worker-src 'self'")
  })

  it("CSP on a normal response contains manifest-src 'self' (covers manifest fetch)", async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("manifest-src 'self'")
  })
})
