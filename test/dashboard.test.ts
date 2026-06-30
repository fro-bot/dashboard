import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
/**
 * Dashboard SPA root + /api/monitoring + /api/status integration tests.
 *
 * GET / now serves web/dist/index.html (SPA shell), not SSR HTML.
 * The monitoring data is fetched client-side via /api/monitoring (BFF JSON endpoint).
 *
 * Security invariants tested:
 * - Unauthed GET / and GET /api/monitoring are denied (redirect or 401).
 * - /api/monitoring NEVER emits internal fields (node_id, owner, name, fetchedAt,
 *   installation_id, redactedNodeIds, redactedDatabaseIds) as JSON keys.
 * - /api/monitoring carries Cache-Control: no-store.
 * - /api/monitoring is behind auth (not public).
 * - Drift count is a number only — no repo names from drift.
 * - staleBanner is present in the JSON response.
 * - Empty snapshot returns valid JSON with empty repos array.
 */
import type {AggregatorSnapshot, DashboardRepo} from '../src/github/aggregator.ts'
import {Buffer} from 'node:buffer'
import process from 'node:process'
import {afterEach, describe, expect, it} from 'vitest'
import {buildDashboardApp} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// Must be non-degenerate (mixed bytes) to pass the hardened decodeKey check
const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8') // 32 bytes, mixed
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

function makeRepo(overrides: Partial<DashboardRepo> = {}): DashboardRepo {
  return {
    node_id: 'NODE_AGENT',
    owner: 'fro-bot',
    name: 'agent',
    full_name: 'fro-bot/agent',
    discovery_channel: 'collab',
    status: {
      rollupState: 'green',
      failingChecks: 0,
      openPrCount: 0,
      openIssueCount: 0,
      openAlertCount: null,
      stale: false,
      fetchedAt: 1_700_000_000_000,
    },
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<AggregatorSnapshot> = {}): AggregatorSnapshot {
  return {
    repos: [],
    staleBanner: false,
    driftCount: 0,
    refreshedAt: null,
    ...overrides,
  }
}

/** Build a test app with injected snapshot + minimal auth config. */
async function buildTestApp(snapshot: AggregatorSnapshot, operatorLogin: string = TEST_OPERATOR) {
  return buildDashboardApp({
    operatorLogin,
    cookieKey: TEST_KEY,
    oauthClient: makeFakeOAuthClient(),
    fetchUserLogin: async (_token: string) => operatorLogin,
    getSnapshot: () => snapshot,
  })
}

/** Authed request helper — injects a valid session cookie. */
async function authedGet(app: Awaited<ReturnType<typeof buildTestApp>>, path: string): Promise<Response> {
  const cookie = makeSessionCookie()
  return app.request(path, {headers: {cookie: `session=${cookie}`}})
}

// ---------------------------------------------------------------------------
// SPA shell — GET /
// ---------------------------------------------------------------------------

describe('dashboard SPA root — GET /', () => {
  describe('security — unauthenticated access denied', () => {
    it('GET / without session cookie → redirect or 401', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await app.request('/')
      expect([302, 303, 401]).toContain(res.status)
      if (res.status === 302 || res.status === 303) {
        expect(res.headers.get('location')).toContain('/auth/login')
      }
    })

    it('GET / with invalid session cookie → denied', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await app.request('/', {headers: {cookie: 'session=invalid.garbage'}})
      expect([302, 303, 401]).toContain(res.status)
    })
  })

  describe('authenticated access — SPA shell', () => {
    it('authed GET / returns 200 (SPA index.html served)', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await authedGet(app, '/')
      expect(res.status).toBe(200)
    })

    it('authed GET / returns HTML content (SPA shell)', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await authedGet(app, '/')
      expect(res.status).toBe(200)
      const body = await res.text()
      // SPA shell contains the root div and script tag
      expect(body).toContain('<div id="root">')
      expect(body).toContain('Fro Bot Operator')
    })

    it('SPA shell does NOT contain SSR repo data (data is fetched client-side)', async () => {
      const repo = makeRepo({full_name: 'fro-bot/agent'})
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = await buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      expect(res.status).toBe(200)
      const body = await res.text()
      // The SPA shell is static HTML — repo data is NOT embedded in the HTML.
      // It is fetched client-side via /api/monitoring.
      // This is the key difference from the old SSR route.
      expect(body).not.toContain('fro-bot/agent')
    })
  })
})

// ---------------------------------------------------------------------------
// BFF aggregation endpoint — /api/monitoring
// ---------------------------------------------------------------------------

describe('/api/monitoring — BFF aggregation endpoint', () => {
  describe('happy path', () => {
    it('authed GET /api/monitoring returns snapshot JSON shape', async () => {
      const repo = makeRepo()
      const snapshot = makeSnapshot({
        repos: [repo],
        staleBanner: false,
        driftCount: 1,
        refreshedAt: 1_700_000_000_000,
      })
      const app = await buildTestApp(snapshot)
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      const body = await res.json() as AggregatorSnapshot
      expect(body.repos).toHaveLength(1)
      expect(body.staleBanner).toBe(false)
      expect(body.driftCount).toBe(1)
      expect(body.refreshedAt).toBe(1_700_000_000_000)
      // Repo shape
      const r = body.repos[0]
      expect(r).toBeDefined()
      if (r !== undefined) {
        expect(r.full_name).toBe('fro-bot/agent')
        expect(r.discovery_channel).toBe('collab')
        expect(r.status.rollupState).toBe('green')
      }
    })

    it('returns empty snapshot when no repos', async () => {
      const snapshot = makeSnapshot()
      const app = await buildTestApp(snapshot)
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      const body = await res.json() as AggregatorSnapshot
      expect(body.repos).toHaveLength(0)
      expect(body.refreshedAt).toBeNull()
    })
  })

  describe('Cache-Control: no-store', () => {
    it('response carries Cache-Control: no-store', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      const cacheControl = res.headers.get('cache-control')
      expect(cacheControl).toBe('no-store')
    })

    it('Cache-Control: no-store is present even on empty snapshot', async () => {
      const app = await buildTestApp(makeSnapshot({repos: [], refreshedAt: null}))
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
    })
  })

  // ── Contract pin: Cache-Control: no-store must NOT change ───────────────────
  // The SW Cache Storage API (cache.put()) stores responses regardless of
  // Cache-Control — the SW cache is independent of the HTTP cache. Therefore:
  //   - no-store does NOT prevent the SW from caching /api/monitoring.
  //   - Changing no-store to 'private' would be a regression: it would allow
  //     the browser HTTP disk cache to store the response, which no-store
  //     correctly forbids.
  //   - The SW NetworkFirst strategy handles offline caching at the SW layer.
  // This test pins the exact header value so a "helpful" change is caught.
  describe('Cache-Control: no-store is UNCHANGED on /api/monitoring (SW caches independently)', () => {
    it('Cache-Control is exactly "no-store" — not "private", not "no-cache", not absent', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      // Exact match — any change to this header is a regression.
      // The SW Cache Storage API ignores Cache-Control; no-store is correct
      // and must not be changed to enable SW offline caching (it already works).
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('Cache-Control is not "private" (private would allow browser HTTP disk caching — regression)', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).not.toBe('private')
      expect(res.headers.get('cache-control')).not.toContain('private')
    })

    it('Cache-Control is not absent (must always be set to prevent intermediary caching)', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).not.toBeNull()
    })
  })

  describe('security — unauthenticated access denied', () => {
    it('GET /api/monitoring without session cookie → denied', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await app.request('/api/monitoring')
      expect([302, 303, 401]).toContain(res.status)
    })

    it('GET /api/monitoring with invalid session cookie → denied', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await app.request('/api/monitoring', {headers: {cookie: 'session=bad.cookie'}})
      expect([302, 303, 401]).toContain(res.status)
    })
  })

  describe('security — DTO whitelist: internal fields NEVER emitted', () => {
    /**
     * The /api/monitoring DTO mapper is the final whitelist. Internal fields
     * (node_id, owner, name, fetchedAt, installation_id, redactedNodeIds,
     * redactedDatabaseIds) must NEVER appear as JSON keys in the response,
     * regardless of what the aggregator snapshot contains.
     *
     * These are exact key-presence assertions — not string-absence checks.
     */
    it('response JSON does NOT contain node_id as a key', async () => {
      const repo = makeRepo({node_id: 'NODE_PUBLIC_AGENT'})
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = await buildTestApp(snapshot)
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      // Top-level keys
      expect(Object.keys(body)).not.toContain('node_id')
      // Repo-level keys
      const repos = body.repos as unknown[]
      expect(repos).toHaveLength(1)
      const r = repos[0] as Record<string, unknown>
      expect(Object.keys(r)).not.toContain('node_id')
      expect(Object.keys(r)).not.toContain('owner')
      expect(Object.keys(r)).not.toContain('name')
      // full_name IS present (it is part of the DTO)
      expect(Object.keys(r)).toContain('full_name')
    })

    it('response JSON does NOT contain fetchedAt as a key', async () => {
      const repo = makeRepo()
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = await buildTestApp(snapshot)
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      const repos = body.repos as unknown[]
      const r = repos[0] as Record<string, unknown>
      const status = r.status as Record<string, unknown>
      expect(Object.keys(status)).not.toContain('fetchedAt')
    })

    it('response JSON does NOT contain installation_id, redactedNodeIds, or redactedDatabaseIds', async () => {
      const repo = makeRepo()
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = await buildTestApp(snapshot)
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      const bodyText = await res.text()
      // These keys must never appear anywhere in the serialized response
      expect(bodyText).not.toContain('"installation_id"')
      expect(bodyText).not.toContain('"redactedNodeIds"')
      expect(bodyText).not.toContain('"redactedDatabaseIds"')
    })

    it('snapshot output contains no denylisted repo identifiers (owner/name/node_id/full_name)', async () => {
      // Simulate a snapshot where a private repo has been excluded by the denylist.
      // The snapshot only contains the public repo — the private one is absent.
      const publicRepo = makeRepo({
        node_id: 'NODE_PUBLIC',
        owner: 'fro-bot',
        name: 'agent',
        full_name: 'fro-bot/agent',
        discovery_channel: 'collab',
      })
      // The private/denylisted repo is NOT in the snapshot (excluded by aggregator).
      // We assert it does not appear in the response.
      const snapshot = makeSnapshot({repos: [publicRepo], refreshedAt: 1_700_000_000_000})
      const app = await buildTestApp(snapshot)
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      const body = await res.json() as {repos: {full_name: string}[]}

      // Public repo is present via full_name
      expect(body.repos).toHaveLength(1)
      expect(body.repos[0]?.full_name).toBe('fro-bot/agent')

      // Denylisted identifiers are absent from the response body
      const bodyText = JSON.stringify(body)
      expect(bodyText).not.toContain('PRIVATE_NODE_ID')
      expect(bodyText).not.toContain('private-secret-repo')
      expect(bodyText).not.toContain('private-org/secret-repo')
    })

    it('drift count is a number only — no repo names from drift repos', async () => {
      // driftCount=3 means 3 installation-only repos exist but are NOT in the snapshot.
      // Their names/node_ids must never appear in the response.
      const snapshot = makeSnapshot({driftCount: 3, refreshedAt: 1_700_000_000_000})
      const app = await buildTestApp(snapshot)
      const res = await authedGet(app, '/api/monitoring')

      expect(res.status).toBe(200)
      const body = await res.json() as {driftCount: number; repos: unknown[]}

      // driftCount is a number
      expect(body.driftCount).toBe(3)
      // repos array is empty — drift repos are NOT in the snapshot
      expect(body.repos).toHaveLength(0)

      // No private repo names in the response
      const bodyText = JSON.stringify(body)
      expect(bodyText).not.toContain('private-repo-name')
      expect(bodyText).not.toContain('secret-project')
    })
  })

  describe('same snapshot source as /api/status', () => {
    it('/api/monitoring and /api/status serve data from the same provider', async () => {
      const repo = makeRepo({full_name: 'fro-bot/shared-source'})
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = await buildTestApp(snapshot)

      const [monitoringRes, statusRes] = await Promise.all([
        authedGet(app, '/api/monitoring'),
        authedGet(app, '/api/status'),
      ])

      // /api/monitoring returns the minimized DTO; /api/status returns the full snapshot.
      // Both are sourced from the same provider — full_name and refreshedAt must match.
      const monitoringBody = await monitoringRes.json() as {repos: {full_name: string}[]; refreshedAt: number | null}
      const statusBody = await statusRes.json() as AggregatorSnapshot

      // Both see the same repo
      expect(monitoringBody.repos[0]?.full_name).toBe('fro-bot/shared-source')
      expect(statusBody.repos[0]?.full_name).toBe('fro-bot/shared-source')
      expect(monitoringBody.refreshedAt).toBe(statusBody.refreshedAt)
    })
  })
})

// ---------------------------------------------------------------------------
// /api/status — existing endpoint (unchanged)
// ---------------------------------------------------------------------------

describe('/api/status', () => {
  describe('happy path', () => {
    it('authed GET /api/status returns snapshot JSON shape', async () => {
      const repo = makeRepo()
      const snapshot = makeSnapshot({
        repos: [repo],
        staleBanner: false,
        driftCount: 1,
        refreshedAt: 1_700_000_000_000,
      })
      const app = await buildTestApp(snapshot)
      const res = await authedGet(app, '/api/status')

      expect(res.status).toBe(200)
      const body = await res.json() as AggregatorSnapshot
      expect(body.repos).toHaveLength(1)
      expect(body.staleBanner).toBe(false)
      expect(body.driftCount).toBe(1)
      expect(body.refreshedAt).toBe(1_700_000_000_000)
      // Repo shape
      const r = body.repos[0]
      expect(r).toBeDefined()
      if (r !== undefined) {
        expect(r.full_name).toBe('fro-bot/agent')
        expect(r.discovery_channel).toBe('collab')
        expect(r.status.rollupState).toBe('green')
      }
    })

    it('returns empty snapshot when no repos', async () => {
      const snapshot = makeSnapshot()
      const app = await buildTestApp(snapshot)
      const res = await authedGet(app, '/api/status')

      expect(res.status).toBe(200)
      const body = await res.json() as AggregatorSnapshot
      expect(body.repos).toHaveLength(0)
      expect(body.refreshedAt).toBeNull()
    })
  })

  describe('security — unauthenticated access denied', () => {
    it('GET /api/status without session cookie → denied', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await app.request('/api/status')
      expect([302, 303, 401]).toContain(res.status)
    })

    it('GET /api/status with invalid session cookie → denied', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await app.request('/api/status', {headers: {cookie: 'session=bad.cookie'}})
      expect([302, 303, 401]).toContain(res.status)
    })
  })

  describe('Cache-Control: no-store', () => {
    it('response carries Cache-Control: no-store', async () => {
      const app = await buildTestApp(makeSnapshot())
      const res = await authedGet(app, '/api/status')

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
    })
  })

  describe('same snapshot source as /api/monitoring', () => {
    it('/api/status and /api/monitoring serve data from the same provider', async () => {
      const repo = makeRepo({full_name: 'fro-bot/shared-source'})
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = await buildTestApp(snapshot)

      const [monitoringRes, statusRes] = await Promise.all([
        authedGet(app, '/api/monitoring'),
        authedGet(app, '/api/status'),
      ])

      const monitoringBody = await monitoringRes.json() as {repos: {full_name: string}[]}
      const statusBody = await statusRes.json() as AggregatorSnapshot

      // Both see the same repo
      expect(monitoringBody.repos[0]?.full_name).toBe('fro-bot/shared-source')
      expect(statusBody.repos[0]?.full_name).toBe('fro-bot/shared-source')
    })
  })
})

// ---------------------------------------------------------------------------
// /auth/logout-csrf — auth-gate pin
// ---------------------------------------------------------------------------
// Pins that GET /auth/logout-csrf is behind the auth middleware. A future
// isPublicPath drift that accidentally exposes this route would silently hand
// an unauthenticated caller a valid CSRF token — this test catches that.

describe('/auth/logout-csrf — auth-gate', () => {
  it('GET /auth/logout-csrf without session → 302/401 (not 200)', async () => {
    const app = await buildTestApp(makeSnapshot())
    const res = await app.request('/auth/logout-csrf')
    expect([302, 303, 401]).toContain(res.status)
    expect(res.status).not.toBe(200)
  })

  it('GET /auth/logout-csrf with invalid session → 302/401 (not 200)', async () => {
    const app = await buildTestApp(makeSnapshot())
    const res = await app.request('/auth/logout-csrf', {headers: {cookie: 'session=bad.garbage'}})
    expect([302, 303, 401]).toContain(res.status)
    expect(res.status).not.toBe(200)
  })

  it('GET /auth/logout-csrf with valid session → 200 + {csrfToken} is 32 hex chars', async () => {
    const app = await buildTestApp(makeSnapshot())
    const res = await authedGet(app, '/auth/logout-csrf')
    expect(res.status).toBe(200)
    const body = await res.json() as {csrfToken: string}
    expect(typeof body.csrfToken).toBe('string')
    expect(body.csrfToken).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('/api/healthz remains public', () => {
  it('GET /api/healthz returns 200 without auth', async () => {
    const app = await buildTestApp(makeSnapshot())
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, lastFetch: null, rateLimit: null})
  })
})

// ---------------------------------------------------------------------------
// FIX B — devAutoLogin: DEV-ONLY auth bypass
// ---------------------------------------------------------------------------

describe('devAutoLogin — DEV-ONLY auth bypass', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV
  const ORIGINAL_DASHBOARD_HOST = process.env.DASHBOARD_HOST

  // Restore NODE_ENV and DASHBOARD_HOST after each test that mutates them
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    if (ORIGINAL_DASHBOARD_HOST === undefined) {
      delete process.env.DASHBOARD_HOST
    } else {
      process.env.DASHBOARD_HOST = ORIGINAL_DASHBOARD_HOST
    }
  })

  // ── Injected opts.devAutoLogin path (test seam) ─────────────────────────────
  // opts.devAutoLogin bypasses the DASHBOARD_HOST loopback check (test seam)
  // but still throws if NODE_ENV==='production'.

  describe('injected opts.devAutoLogin=true + non-production → effective', () => {
    it('unauthenticated GET / returns 200 (SPA served, not redirect to /auth/login)', async () => {
      process.env.NODE_ENV = 'development'
      const app = await buildDashboardApp({
        operatorLogin: TEST_OPERATOR,
        cookieKey: TEST_KEY,
        oauthClient: makeFakeOAuthClient(),
        fetchUserLogin: async (_token: string) => TEST_OPERATOR,
        getSnapshot: () => makeSnapshot(),
        devAutoLogin: true,
      })
      const res = await app.request('/')
      expect(res.status).toBe(200)
    })

    it('unauthenticated GET / sets a valid session cookie (not a redirect)', async () => {
      process.env.NODE_ENV = 'development'
      const app = await buildDashboardApp({
        operatorLogin: TEST_OPERATOR,
        cookieKey: TEST_KEY,
        oauthClient: makeFakeOAuthClient(),
        fetchUserLogin: async (_token: string) => TEST_OPERATOR,
        getSnapshot: () => makeSnapshot(),
        devAutoLogin: true,
      })
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const setCookieHeader = res.headers.get('set-cookie')
      expect(setCookieHeader).not.toBeNull()
      expect(setCookieHeader).toContain('session=')
      expect(setCookieHeader).toContain('HttpOnly')
      expect(setCookieHeader).toContain('SameSite=Lax')
    })

    it('minted session cookie round-trips through SessionManager (genuine signed session)', async () => {
      process.env.NODE_ENV = 'development'
      const app = await buildDashboardApp({
        operatorLogin: TEST_OPERATOR,
        cookieKey: TEST_KEY,
        oauthClient: makeFakeOAuthClient(),
        fetchUserLogin: async (_token: string) => TEST_OPERATOR,
        getSnapshot: () => makeSnapshot(),
        devAutoLogin: true,
      })
      const res = await app.request('/')
      expect(res.status).toBe(200)

      // Extract the session cookie value
      const setCookieHeader = res.headers.get('set-cookie') ?? ''
      const match = /session=([^;]+)/.exec(setCookieHeader)
      expect(match).not.toBeNull()
      const sessionValue = (match as RegExpExecArray)[1] as string

      // Verify it round-trips through SessionManager
      const sm = new SessionManager(TEST_KEY)
      const payload = sm.verify(sessionValue)
      expect(payload).not.toBeNull()
      expect(payload?.login).toBe(TEST_OPERATOR)
    })

    it('replaying the minted session cookie on a subsequent request returns 200', async () => {
      process.env.NODE_ENV = 'development'
      const app = await buildDashboardApp({
        operatorLogin: TEST_OPERATOR,
        cookieKey: TEST_KEY,
        oauthClient: makeFakeOAuthClient(),
        fetchUserLogin: async (_token: string) => TEST_OPERATOR,
        getSnapshot: () => makeSnapshot(),
        devAutoLogin: true,
      })

      // First request: get the minted cookie
      const firstRes = await app.request('/')
      const setCookieHeader = firstRes.headers.get('set-cookie') ?? ''
      const match = /session=([^;]+)/.exec(setCookieHeader)
      expect(match).not.toBeNull()
      const sessionValue = (match as RegExpExecArray)[1] as string

      // Second request: replay the cookie — should still be 200
      const secondRes = await app.request('/', {headers: {cookie: `session=${sessionValue}`}})
      expect(secondRes.status).toBe(200)
    })
  })

  // ── PROD GUARD: injected opts.devAutoLogin=true + NODE_ENV=production → THROWS ──
  // The previous behavior was silent disable + redirect. Now it throws at startup.

  describe('PROD GUARD: injected opts.devAutoLogin=true + NODE_ENV=production → THROWS at startup', () => {
    it('buildDashboardApp throws when devAutoLogin requested in production (injected path)', async () => {
      process.env.NODE_ENV = 'production'
      await expect(
        buildDashboardApp({
          operatorLogin: TEST_OPERATOR,
          cookieKey: TEST_KEY,
          oauthClient: makeFakeOAuthClient(),
          fetchUserLogin: async (_token: string) => TEST_OPERATOR,
          getSnapshot: () => makeSnapshot(),
          devAutoLogin: true,
        }),
      ).rejects.toThrow('DASHBOARD_DEV_AUTOLOGIN refused')
    })

    it('throw message mentions production and loopback requirement', async () => {
      process.env.NODE_ENV = 'production'
      await expect(
        buildDashboardApp({
          operatorLogin: TEST_OPERATOR,
          cookieKey: TEST_KEY,
          oauthClient: makeFakeOAuthClient(),
          fetchUserLogin: async (_token: string) => TEST_OPERATOR,
          getSnapshot: () => makeSnapshot(),
          devAutoLogin: true,
        }),
      ).rejects.toThrow('dev-only auth bypass must never run in production')
    })
  })

  // ── ENV path: DASHBOARD_DEV_AUTOLOGIN + loopback host → effective ───────────

  describe('ENV path: DASHBOARD_DEV_AUTOLOGIN=true + DASHBOARD_HOST=127.0.0.1 + non-prod → effective', () => {
    it('unauthenticated GET / returns 200 (bypass active)', async () => {
      process.env.NODE_ENV = 'development'
      process.env.DASHBOARD_HOST = '127.0.0.1'
      process.env.DASHBOARD_DEV_AUTOLOGIN = 'true'
      try {
        const app = await buildDashboardApp({
          operatorLogin: TEST_OPERATOR,
          cookieKey: TEST_KEY,
          oauthClient: makeFakeOAuthClient(),
          fetchUserLogin: async (_token: string) => TEST_OPERATOR,
          getSnapshot: () => makeSnapshot(),
          // No devAutoLogin injected — reads from env
        })
        const res = await app.request('/')
        expect(res.status).toBe(200)
        const setCookieHeader = res.headers.get('set-cookie')
        expect(setCookieHeader).toContain('session=')
      } finally {
        delete process.env.DASHBOARD_DEV_AUTOLOGIN
      }
    })
  })

  // ── ENV path: DASHBOARD_DEV_AUTOLOGIN + non-loopback host → THROWS ──────────

  describe('ENV path: DASHBOARD_DEV_AUTOLOGIN=true + DASHBOARD_HOST unset/0.0.0.0 → THROWS at startup', () => {
    it('throws when DASHBOARD_HOST is unset (default 0.0.0.0 is not loopback)', async () => {
      process.env.NODE_ENV = 'development'
      delete process.env.DASHBOARD_HOST
      process.env.DASHBOARD_DEV_AUTOLOGIN = 'true'
      try {
        await expect(
          buildDashboardApp({
            operatorLogin: TEST_OPERATOR,
            cookieKey: TEST_KEY,
            oauthClient: makeFakeOAuthClient(),
            fetchUserLogin: async (_token: string) => TEST_OPERATOR,
            getSnapshot: () => makeSnapshot(),
          }),
        ).rejects.toThrow('DASHBOARD_DEV_AUTOLOGIN refused')
      } finally {
        delete process.env.DASHBOARD_DEV_AUTOLOGIN
      }
    })

    it('throws when DASHBOARD_HOST=0.0.0.0 (non-loopback)', async () => {
      process.env.NODE_ENV = 'development'
      process.env.DASHBOARD_HOST = '0.0.0.0'
      process.env.DASHBOARD_DEV_AUTOLOGIN = 'true'
      try {
        await expect(
          buildDashboardApp({
            operatorLogin: TEST_OPERATOR,
            cookieKey: TEST_KEY,
            oauthClient: makeFakeOAuthClient(),
            fetchUserLogin: async (_token: string) => TEST_OPERATOR,
            getSnapshot: () => makeSnapshot(),
          }),
        ).rejects.toThrow('DASHBOARD_DEV_AUTOLOGIN refused')
      } finally {
        delete process.env.DASHBOARD_DEV_AUTOLOGIN
      }
    })
  })

  // ── ENV path: DASHBOARD_DEV_AUTOLOGIN + NODE_ENV=production → THROWS ────────

  describe('ENV path: DASHBOARD_DEV_AUTOLOGIN=true + NODE_ENV=production → THROWS at startup', () => {
    it('throws even when DASHBOARD_HOST is loopback (production guard fires first)', async () => {
      process.env.NODE_ENV = 'production'
      process.env.DASHBOARD_HOST = '127.0.0.1'
      process.env.DASHBOARD_DEV_AUTOLOGIN = 'true'
      try {
        await expect(
          buildDashboardApp({
            operatorLogin: TEST_OPERATOR,
            cookieKey: TEST_KEY,
            oauthClient: makeFakeOAuthClient(),
            fetchUserLogin: async (_token: string) => TEST_OPERATOR,
            getSnapshot: () => makeSnapshot(),
          }),
        ).rejects.toThrow('DASHBOARD_DEV_AUTOLOGIN refused')
      } finally {
        delete process.env.DASHBOARD_DEV_AUTOLOGIN
      }
    })
  })

  // ── devAutoLogin=false (default) → unchanged behavior ───────────────────────

  describe('devAutoLogin=false (default) → unchanged behavior', () => {
    it('unauthenticated GET / redirects to /auth/login', async () => {
      process.env.NODE_ENV = 'development'
      const app = await buildDashboardApp({
        operatorLogin: TEST_OPERATOR,
        cookieKey: TEST_KEY,
        oauthClient: makeFakeOAuthClient(),
        fetchUserLogin: async (_token: string) => TEST_OPERATOR,
        getSnapshot: () => makeSnapshot(),
        devAutoLogin: false,
      })
      const res = await app.request('/')
      expect([302, 303]).toContain(res.status)
      expect(res.headers.get('location')).toContain('/auth/login')
    })
  })

  // ── devAutoLogin=true but operatorLogin=undefined (deny-all) → no bypass ────

  describe('devAutoLogin=true but operatorLogin=undefined (deny-all) → no bypass', () => {
    it('unauthenticated GET / returns 401 (deny-all mode, no session minted)', async () => {
      process.env.NODE_ENV = 'development'
      // operatorLogin is undefined → deny-all mode; devAutoLogin must not mint a session
      // Note: cookieKey is not required when operatorLogin is undefined
      const app = await buildDashboardApp({
        operatorLogin: undefined,
        oauthClient: makeFakeOAuthClient(),
        fetchUserLogin: async (_token: string) => TEST_OPERATOR,
        getSnapshot: () => makeSnapshot(),
        devAutoLogin: true,
      })
      const res = await app.request('/')
      expect(res.status).toBe(401)
    })

    it('no session cookie is set in deny-all mode', async () => {
      process.env.NODE_ENV = 'development'
      const app = await buildDashboardApp({
        operatorLogin: undefined,
        oauthClient: makeFakeOAuthClient(),
        fetchUserLogin: async (_token: string) => TEST_OPERATOR,
        getSnapshot: () => makeSnapshot(),
        devAutoLogin: true,
      })
      const res = await app.request('/')
      expect(res.status).toBe(401)
      const setCookieHeader = res.headers.get('set-cookie')
      if (setCookieHeader !== null) {
        expect(setCookieHeader).not.toContain('session=')
      }
    })
  })
})
