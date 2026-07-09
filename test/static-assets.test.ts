/**
 * Tests for security headers, CSP, and static asset serving.
 *
 * Covers:
 * - CSP header present on responses with script-src 'self' and no 'unsafe-inline'
 * - GET /static/operator.css → 200 with CSS body + correct content-type, no auth required
 * - When operatorUiEnabled=false: /static/operator.css is not served
 * - PWA SW assets: /sw.js + /registerSW.js served with correct MIME + no-cache, public pre-auth
 * - PWA manifest: /manifest.webmanifest served as application/manifest+json, public pre-auth
 * - CSP on /sw.js: no page CSP applied (workers don't inherit page CSP)
 */
import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
import {Buffer} from 'node:buffer'
import process from 'node:process'
import {afterEach, describe, expect, it} from 'vitest'
import {buildDashboardApp} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'

// ---------------------------------------------------------------------------
// Test helpers
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

  it("CSP contains connect-src 'self' (restricts XHR/fetch/WebSocket origins)", async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("connect-src 'self'")
  })

  it("CSP contains form-action 'self' (prevents form submission to external origins)", async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/api/healthz')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("form-action 'self'")
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
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('box-sizing')
  })

  it('GET /static/operator.css is reachable WITHOUT an auth session (public path)', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/static/operator.css')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(302)
    expect(res.status).not.toBe(303)
  })

  it('GET /static/operator.css is NOT served when operatorUiEnabled=false', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator.css')
    expect(res.status).not.toBe(200)
  })

  it('GET /static/nonexistent.txt returns 404 (not a catch-all)', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/static/nonexistent.txt')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// /operator → / redirect
// ---------------------------------------------------------------------------

describe('/operator → / redirect', () => {
  it('GET /operator redirects to / (302) when operatorUiEnabled=true', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  it('GET /operator redirects to / (302) when operatorUiEnabled=false', async () => {
    const app = await buildTestApp(false)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  it('GET /operator redirect response body does not contain monitoring or mock skeleton copy', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body.toLowerCase()).not.toContain('monitoring')
    expect(body).not.toContain('Gateway Operator Controls')
  })
})

// ---------------------------------------------------------------------------
// Flag-off: static route not mounted
// ---------------------------------------------------------------------------

describe('static route absent when operator UI disabled', () => {
  it('GET /static/operator.css is not served when flag is off', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator.css')
    expect(res.status).not.toBe(200)
  })

  it('existing public routes still work when flag is off', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Operator runtime JS assets — always served regardless of operatorUiEnabled
//
// Root / now owns the operator shell. The browser-side runtime modules
// (operator-stream.js, operator-launch.js) must be served unconditionally
// because the SPA shell at / always depends on them — the old operatorUiEnabled
// flag-gate was for the SSR /operator route, not the root app.
// ---------------------------------------------------------------------------

describe('operator runtime JS assets — served regardless of operatorUiEnabled flag', () => {
  it('GET /static/operator-stream.js returns 200 when operatorUiEnabled=false', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-stream.js')
    expect(res.status).toBe(200)
  })

  it('GET /static/operator-stream.js?manual=1 returns 200 when operatorUiEnabled=false', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-stream.js?manual=1')
    expect(res.status).toBe(200)
  })

  it('GET /static/operator-launch.js returns 200 when operatorUiEnabled=false', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-launch.js')
    expect(res.status).toBe(200)
  })

  it('GET /static/operator-launch.js?manual=1 returns 200 when operatorUiEnabled=false', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-launch.js?manual=1')
    expect(res.status).toBe(200)
  })

  it('GET /static/operator-stream.js returns 200 when operatorUiEnabled=true', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/static/operator-stream.js')
    expect(res.status).toBe(200)
  })

  it('GET /static/operator-launch.js returns 200 when operatorUiEnabled=true', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/static/operator-launch.js')
    expect(res.status).toBe(200)
  })

  it('GET /static/operator-stream.js is reachable WITHOUT an auth session (public path)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-stream.js')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(302)
    expect(res.status).not.toBe(401)
  })

  it('GET /static/operator-launch.js is reachable WITHOUT an auth session (public path)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-launch.js')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(302)
    expect(res.status).not.toBe(401)
  })

  it('GET /static/nonexistent.js is not served (not a catch-all for unknown paths)', async () => {
    // When operatorUiEnabled=false the /static/* catch-all is not mounted.
    // Unknown /static/* paths are not served as 200 — they get a redirect or 404.
    const app = await buildTestApp(false)
    const res = await app.request('/static/nonexistent.js')
    expect(res.status).not.toBe(200)
  })

  it('GET /static/nonexistent.js returns 404 when operatorUiEnabled=true (not a catch-all)', async () => {
    // When the /static/* catch-all IS mounted, missing files return 404.
    const app = await buildTestApp(true)
    const res = await app.request('/static/nonexistent.js')
    expect(res.status).toBe(404)
  })

  it('GET /static/operator-stream.js returns a JavaScript Content-Type', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-stream.js')
    expect(res.status).toBe(200)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).toMatch(/(?:text|application)\/javascript/)
  })

  it('GET /static/operator-launch.js returns a JavaScript Content-Type', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-launch.js')
    expect(res.status).toBe(200)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).toMatch(/(?:text|application)\/javascript/)
  })

  it('GET /static/operator-run-index.js returns 200 when operatorUiEnabled=false', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-run-index.js')
    expect(res.status).toBe(200)
  })

  it('GET /static/operator-run-index.js?manual=1 returns 200 when operatorUiEnabled=false', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-run-index.js?manual=1')
    expect(res.status).toBe(200)
  })

  it('GET /static/operator-run-index.js returns 200 when operatorUiEnabled=true', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/static/operator-run-index.js')
    expect(res.status).toBe(200)
  })

  it('GET /static/operator-run-index.js is reachable WITHOUT an auth session (public path)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-run-index.js')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(302)
    expect(res.status).not.toBe(401)
  })

  it('GET /static/operator-run-index.js returns a JavaScript Content-Type', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/static/operator-run-index.js')
    expect(res.status).toBe(200)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).toMatch(/(?:text|application)\/javascript/)
  })
})

// ---------------------------------------------------------------------------
// PWA SW asset serving — /sw.js
// ---------------------------------------------------------------------------

describe('PWA SW asset serving — /sw.js', () => {
  it('GET /sw.js returns 200', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
  })

  it('GET /sw.js returns a JavaScript Content-Type (wrong type blocks SW registration)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
    const ct = res.headers.get('content-type') ?? ''
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
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(302)
    expect(res.status).not.toBe(401)
  })

  it('GET /sw.js does NOT carry the page CSP (workers do not inherit page CSP)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy')
    expect(csp).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PWA SW asset serving — /registerSW.js
// ---------------------------------------------------------------------------
// NOTE: vite-plugin-pwa only emits registerSW.js when using auto-register mode.
// Since the app uses useRegisterSW() in a component (ReloadPrompt), the
// registration code is bundled into the main JS chunk and registerSW.js is NOT
// emitted. The route remains in isPublicPath for forward-compatibility.

describe('PWA SW asset serving — /registerSW.js', () => {
  it('GET /registerSW.js is in the public allowlist (no auth redirect)', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/registerSW.js')
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
    expect(swRes.status).not.toBe(302)
    expect(swRes.status).not.toBe(401)
    const apiRes = await app.request('/api/monitoring')
    expect(apiRes.status).not.toBe(200)
  })
})

describe('production static JS assets — no fixture strings', () => {
  it('operator-stream.js source does not contain /__fixture string', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-stream.js', 'utf8')
    expect(src).not.toContain('/__fixture')
  })

  it('operator-launch.js source does not contain /__fixture string', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).not.toContain('/__fixture')
  })

  it('operator-run-index.js source does not contain /__fixture string', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toContain('/__fixture')
  })

  it('operator-stream.js source does not contain fixture-mode flag strings', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-stream.js', 'utf8')
    expect(src).not.toContain('fixtureMode')
    expect(src).not.toContain('fixture-runtime-loader')
  })

  it('operator-launch.js source does not contain fixture-mode flag strings', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).not.toContain('fixtureMode')
    expect(src).not.toContain('fixture-runtime-loader')
  })

  it('operator-run-index.js source does not contain fixture-mode flag strings', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).not.toContain('fixtureMode')
    expect(src).not.toContain('fixture-runtime-loader')
  })

  it('operator-stream.js default endpoint base is /operator (not fixture prefix)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-stream.js', 'utf8')
    // The default endpoint base must be /operator, not /__fixture/operator
    // The file may contain /operator as part of paths like /operator/session/csrf
    expect(src).toContain('/operator')
    expect(src).not.toContain('/__fixture/operator')
  })

  it('operator-launch.js default endpoint base is /operator (not fixture prefix)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-launch.js', 'utf8')
    expect(src).toContain('/operator')
    expect(src).not.toContain('/__fixture/operator')
  })

  it('operator-run-index.js default endpoint base is /operator (not fixture prefix)', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-run-index.js', 'utf8')
    expect(src).toContain('/operator')
    expect(src).not.toContain('/__fixture/operator')
  })
})

// ---------------------------------------------------------------------------
// Production build artifact assertions — web/dist must be fixture-free
//
// These tests scan the compiled browser bundle and service-worker output after
// `pnpm build:web`. Fixture imports are dev-gated so Vite removes the module
// request strings from production output. The pretest hook runs build:web before
// vitest, so web/dist is always fresh when these tests run.
// ---------------------------------------------------------------------------

describe('production build artifacts — no fixture strings in web/dist JS', () => {
  it('web/dist/sw.js does not contain /__fixture route string', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('web/dist/sw.js', 'utf8')
    expect(src).not.toContain('/__fixture')
  })

  it('web/dist/sw.js does not contain fixture-runtime-loader import path', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('web/dist/sw.js', 'utf8')
    expect(src).not.toContain('fixture-runtime-loader')
  })

  it('web/dist/index.html does not contain /__fixture string', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('web/dist/index.html', 'utf8')
    expect(src).not.toContain('/__fixture')
  })

  it('web/dist JS bundle does not contain /__fixture route string', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const assetsDir = 'web/dist/assets'
    const entries = await fs.readdir(assetsDir)
    const jsFiles = entries.filter(f => f.endsWith('.js'))
    for (const file of jsFiles) {
      const src = await fs.readFile(path.join(assetsDir, file), 'utf8')
      expect(src, `${file} must not contain /__fixture`).not.toContain('/__fixture')
    }
  })

  it('web/dist JS bundle does not contain fixture-runtime-loader import path', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const assetsDir = 'web/dist/assets'
    const entries = await fs.readdir(assetsDir)
    const jsFiles = entries.filter(f => f.endsWith('.js'))
    for (const file of jsFiles) {
      const src = await fs.readFile(path.join(assetsDir, file), 'utf8')
      expect(src, `${file} must not contain fixture-runtime-loader`).not.toContain('fixture-runtime-loader')
    }
  })

  it('web/dist JS bundle does not contain push fixture literals', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const assetsDir = 'web/dist/assets'
    const entries = await fs.readdir(assetsDir)
    const jsFiles = entries.filter(f => f.endsWith('.js'))
    const forbidden = ['endpoint-fixture-', '/__fixture/operator/push', 'FIXTURE_VAPID_PUBLIC_KEY', 'MOCK_SYNTHETIC_PUSH']
    for (const file of jsFiles) {
      const src = await fs.readFile(path.join(assetsDir, file), 'utf8')
      for (const literal of forbidden) {
        expect(src, `${file} must not contain ${literal}`).not.toContain(literal)
      }
    }
  })

  it('web/dist/index.html does not contain push fixture literals', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('web/dist/index.html', 'utf8')
    for (const literal of ['endpoint-fixture-', '/__fixture/operator/push', 'FIXTURE_VAPID_PUBLIC_KEY', 'MOCK_SYNTHETIC_PUSH']) {
      expect(src, `index.html must not contain ${literal}`).not.toContain(literal)
    }
  })
})

// ---------------------------------------------------------------------------
// Service worker cache boundary — fixture routes are not intercepted
//
// The SW uses a deny-by-default NavigationRoute with an explicit denylist.
// /__fixture/* paths are not in the SW route table, so they naturally pass
// through to the server. These tests prove the SW source does not add fixture
// route handling and does not precache or runtime-cache fixture paths.
// ---------------------------------------------------------------------------

describe('service worker cache boundary — fixture routes not intercepted', () => {
  it('web/dist/sw.js does not register a route for /__fixture paths', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('web/dist/sw.js', 'utf8')
    expect(src).not.toContain('/__fixture')
  })

  it('web/src/sw.ts source does not contain /__fixture route registration', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('web/src/sw.ts', 'utf8')
    expect(src).not.toContain('/__fixture')
  })

  it('web/dist/sw.js NavigationRoute denylist does not include fixture prefix', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('web/dist/sw.js', 'utf8')
    // The denylist patterns are /^\/auth/, /^\/operator\/auth/, /^\/api/
    // /__fixture must not appear in any denylist or allowlist pattern
    expect(src).not.toContain('fixture')
  })
})

// ---------------------------------------------------------------------------
// DASHBOARD_WEB_DIST static root override
//
// The server must read DASHBOARD_WEB_DIST (defaulting to ./web/dist) and use it
// for all SPA static asset routes: /, /assets/*, /icon-*, /manifest.webmanifest,
// /sw.js, /registerSW.js, and the missing-index warning.
//
// Tests here verify:
// 1. Default root is ./web/dist (production unchanged).
// 2. DASHBOARD_WEB_DIST env var is forwarded to the app config.
// 3. package.json dev:fixture script sets DASHBOARD_WEB_DIST=./web/dist-fixture.
// ---------------------------------------------------------------------------

describe('DASHBOARD_WEB_DIST — static root override', () => {
  const ORIGINAL_WEB_DIST = process.env.DASHBOARD_WEB_DIST

  afterEach(() => {
    if (ORIGINAL_WEB_DIST === undefined) {
      delete process.env.DASHBOARD_WEB_DIST
    } else {
      process.env.DASHBOARD_WEB_DIST = ORIGINAL_WEB_DIST
    }
  })

  it('default webDistRoot is ./web/dist when DASHBOARD_WEB_DIST is unset', async () => {
    delete process.env.DASHBOARD_WEB_DIST
    // The app builds without error using the default root (web/dist exists from pretest build:web)
    const app = await buildDashboardApp({
      operatorLogin: TEST_OPERATOR,
      cookieKey: TEST_KEY,
      oauthClient: makeFakeOAuthClient(),
      fetchUserLogin: async (_token: string) => TEST_OPERATOR,
      getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
    })
    // /sw.js is served from web/dist — 200 confirms the default root is correct
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
  })

  it('injected webDistRoot=./web/dist-fixture serves assets from dist-fixture', async () => {
    // web/dist-fixture is built by pnpm build:web:fixture; skip if not present
    const fs = await import('node:fs')
    if (!fs.existsSync('./web/dist-fixture')) {
      return
    }
    const app = await buildDashboardApp({
      operatorLogin: TEST_OPERATOR,
      cookieKey: TEST_KEY,
      oauthClient: makeFakeOAuthClient(),
      fetchUserLogin: async (_token: string) => TEST_OPERATOR,
      getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
      webDistRoot: './web/dist-fixture',
    })
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
  })

  it('DASHBOARD_WEB_DIST env var is used as the static root when set', async () => {
    process.env.DASHBOARD_WEB_DIST = './web/dist'
    const app = await buildDashboardApp({
      operatorLogin: TEST_OPERATOR,
      cookieKey: TEST_KEY,
      oauthClient: makeFakeOAuthClient(),
      fetchUserLogin: async (_token: string) => TEST_OPERATOR,
      getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
      // No webDistRoot injected — reads from env
    })
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
  })
})

describe('DASHBOARD_WEB_DIST — production guard: dist-fixture must not be used in production', () => {
  it('buildDashboardApp throws when webDistRoot is ./web/dist-fixture and NODE_ENV=production', async () => {
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await expect(
        buildDashboardApp({
          operatorLogin: TEST_OPERATOR,
          cookieKey: TEST_KEY,
          oauthClient: makeFakeOAuthClient(),
          fetchUserLogin: async (_token: string) => TEST_OPERATOR,
          getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
          webDistRoot: './web/dist-fixture',
        }),
      ).rejects.toThrow(/dist-fixture.*production|production.*dist-fixture/i)
    } finally {
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  it('buildDashboardApp does NOT throw when webDistRoot is ./web/dist-fixture and NODE_ENV=development', async () => {
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      await expect(
        buildDashboardApp({
          operatorLogin: TEST_OPERATOR,
          cookieKey: TEST_KEY,
          oauthClient: makeFakeOAuthClient(),
          fetchUserLogin: async (_token: string) => TEST_OPERATOR,
          getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
          webDistRoot: './web/dist-fixture',
        }),
      ).resolves.toBeDefined()
    } finally {
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  it('buildDashboardApp does NOT throw when webDistRoot is ./web/dist (production-safe root)', async () => {
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await expect(
        buildDashboardApp({
          operatorLogin: TEST_OPERATOR,
          cookieKey: TEST_KEY,
          oauthClient: makeFakeOAuthClient(),
          fetchUserLogin: async (_token: string) => TEST_OPERATOR,
          getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
          webDistRoot: './web/dist',
        }),
      ).resolves.toBeDefined()
    } finally {
      process.env.NODE_ENV = originalNodeEnv
    }
  })
})

describe('dev:fixture script — package.json content', () => {
  it('dev:fixture script sets DASHBOARD_WEB_DIST=./web/dist-fixture', async () => {
    const fs = await import('node:fs/promises')
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {scripts: Record<string, string>}
    const script = pkg.scripts['dev:fixture'] ?? ''
    expect(script).toContain('DASHBOARD_WEB_DIST=./web/dist-fixture')
  })

  it('dev:fixture script chains build:web:fixture before starting the server', async () => {
    const fs = await import('node:fs/promises')
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {scripts: Record<string, string>}
    const script = pkg.scripts['dev:fixture'] ?? ''
    expect(script).toContain('build:web:fixture')
  })

  it('dev:fixture script sets DASHBOARD_HOST=127.0.0.1 (loopback safety)', async () => {
    const fs = await import('node:fs/promises')
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {scripts: Record<string, string>}
    const script = pkg.scripts['dev:fixture'] ?? ''
    expect(script).toContain('DASHBOARD_HOST=127.0.0.1')
  })

  it('dev:fixture script enables the dashboard fixture harness flag', async () => {
    const fs = await import('node:fs/promises')
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {scripts: Record<string, string>}
    const script = pkg.scripts['dev:fixture'] ?? ''
    expect(script).toContain('DASHBOARD_FIXTURE_HARNESS_ENABLED=true')
  })

  it('dev:fixture script enables dashboard dev autologin', async () => {
    const fs = await import('node:fs/promises')
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {scripts: Record<string, string>}
    const script = pkg.scripts['dev:fixture'] ?? ''
    expect(script).toContain('DASHBOARD_DEV_AUTOLOGIN=true')
  })

  it('dev:fixture script does not use stale fixture/autologin env aliases', async () => {
    const fs = await import('node:fs/promises')
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {scripts: Record<string, string>}
    const script = pkg.scripts['dev:fixture'] ?? ''
    expect(script).not.toContain('FIXTURE_HARNESS=true')
    expect(script).not.toContain('DEV_AUTO_LOGIN=true')
  })

  it('dev:fixture script sets NODE_ENV=development (fixture guard requires explicit development or test)', async () => {
    const fs = await import('node:fs/promises')
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {scripts: Record<string, string>}
    const script = pkg.scripts['dev:fixture'] ?? ''
    expect(script).toContain('NODE_ENV=development')
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

describe('security — raw failure reason codes security invariants', () => {
  it('production static files do not contain dynamic CSS classes or custom properties derived from raw reason codes', async () => {
    const fs = await import('node:fs/promises')
    const files = [
      'public/operator-stream.js',
      'public/operator-run-index.js',
    ]
    for (const filePath of files) {
      const src = await fs.readFile(filePath, 'utf8')
      // Ensure no raw codes are interpolated into classList.add, className, or CSS variables
      expect(src).not.toMatch(/classList\.add\([^)]*failureKind/)
      expect(src).not.toMatch(/className[^;\n]*failureKind/)
      expect(src).not.toMatch(/setProperty\([^)]*failureKind/)
    }
  })
})
