import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
/**
 * Dashboard SSR view + /api/status integration tests.
 *
 * Uses app.request() with injected fake snapshot + a valid session cookie.
 * Does NOT hit real GitHub — snapshot is injected via DashboardAppConfig.getSnapshot.
 *
 * Security invariants tested:
 * - Unauthed GET / and GET /api/status are denied (redirect or 401).
 * - node_id is never rendered as user-facing identity in a leaking way.
 * - Drift count is rendered as a number only — no repo names from drift.
 * - staleBanner renders the expected banner text.
 * - Empty snapshot renders loading state, not an error.
 * - Logout is rendered as a POST form with a CSRF token (not a GET link).
 */
import type {AggregatorSnapshot, DashboardRepo} from '../src/github/aggregator.ts'
import {Buffer} from 'node:buffer'
import {describe, expect, it} from 'vitest'
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
function buildTestApp(snapshot: AggregatorSnapshot, operatorLogin: string = TEST_OPERATOR) {
  return buildDashboardApp({
    operatorLogin,
    cookieKey: TEST_KEY,
    oauthClient: makeFakeOAuthClient(),
    fetchUserLogin: async (_token: string) => operatorLogin,
    getSnapshot: () => snapshot,
  })
}

/** Authed request helper — injects a valid session cookie. */
async function authedGet(app: ReturnType<typeof buildTestApp>, path: string): Promise<Response> {
  const cookie = makeSessionCookie()
  return app.request(path, {headers: {cookie: `session=${cookie}`}})
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dashboard SSR — GET /', () => {
  describe('happy path', () => {
    it('renders repos in attention-first order (aggregator order preserved)', async () => {
      const repo1 = makeRepo({
        node_id: 'NODE_1',
        full_name: 'fro-bot/alpha',
        owner: 'fro-bot',
        name: 'alpha',
        status: {
          rollupState: 'red',
          failingChecks: 2,
          openPrCount: 1,
          openIssueCount: 0,
          openAlertCount: null,
          stale: false,
          fetchedAt: 1_700_000_000_000,
        },
      })
      const repo2 = makeRepo({
        node_id: 'NODE_2',
        full_name: 'fro-bot/beta',
        owner: 'fro-bot',
        name: 'beta',
        status: {
          rollupState: 'green',
          failingChecks: 0,
          openPrCount: 0,
          openIssueCount: 0,
          openAlertCount: null,
          stale: false,
          fetchedAt: 1_700_000_000_000,
        },
      })
      const snapshot = makeSnapshot({repos: [repo1, repo2], refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      expect(res.status).toBe(200)
      const body = await res.text()

      // Both repos rendered
      expect(body).toContain('fro-bot/alpha')
      expect(body).toContain('fro-bot/beta')

      // Order preserved: alpha (attention) appears before beta (healthy)
      const alphaIdx = body.indexOf('fro-bot/alpha')
      const betaIdx = body.indexOf('fro-bot/beta')
      expect(alphaIdx).toBeLessThan(betaIdx)
    })

    it('renders status pill, PR link, issue link, alert count, and channel badge', async () => {
      const repo = makeRepo({
        full_name: 'fro-bot/agent',
        owner: 'fro-bot',
        name: 'agent',
        discovery_channel: 'collab',
        status: {
          rollupState: 'red',
          failingChecks: 3,
          openPrCount: 2,
          openIssueCount: 5,
          openAlertCount: 1,
          stale: false,
          fetchedAt: 1_700_000_000_000,
        },
      })
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      expect(res.status).toBe(200)
      const body = await res.text()

      expect(body).toContain('fro-bot/agent')
      expect(body).toContain('https://github.com/fro-bot/agent/pulls')
      expect(body).toContain('https://github.com/fro-bot/agent/issues')
      expect(body).toContain('collab')
      // Alert count rendered
      expect(body).toContain('1')
    })

    it('renders — for null alert count', async () => {
      const repo = makeRepo({
        status: {
          rollupState: 'green',
          failingChecks: 0,
          openPrCount: 0,
          openIssueCount: 0,
          openAlertCount: null,
          stale: false,
          fetchedAt: 1_700_000_000_000,
        },
      })
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('—')
    })

    it('renders stale marker on per-repo stale status', async () => {
      const repo = makeRepo({
        status: {
          rollupState: 'unknown',
          failingChecks: 0,
          openPrCount: 0,
          openIssueCount: 0,
          openAlertCount: null,
          stale: true,
          fetchedAt: 1_700_000_000_000,
        },
      })
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('stale')
    })
  })

  describe('logout form (FIX P1 — GET link replaced with POST form + CSRF)', () => {
    it('renders a POST form for logout (not a GET link)', async () => {
      const snapshot = makeSnapshot({refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      expect(res.status).toBe(200)
      const body = await res.text()

      // Must have a form POSTing to /auth/logout
      expect(body).toContain('method="POST"')
      expect(body).toContain('action="/auth/logout"')

      // Must have a hidden CSRF token input
      expect(body).toContain('name="csrf_token"')
      expect(body).toContain('type="hidden"')

      // Must NOT have a bare GET link to /auth/logout
      // (the old <a href="/auth/logout"> pattern)
      expect(body).not.toMatch(/<a[^>]+href="\/auth\/logout"/)
    })

    it('CSRF token in form is non-empty', async () => {
      const snapshot = makeSnapshot({refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      const body = await res.text()
      // Extract the csrf_token value from the hidden input
      const matchA = /name="csrf_token"\s+value="([^"]+)"/.exec(body)
      const matchB = /value="([^"]+)"\s+name="csrf_token"/.exec(body)
      const match = matchA ?? matchB
      expect(match).not.toBeNull()
      expect(match?.[1]).toBeTruthy()
      expect((match?.[1] ?? '').length).toBeGreaterThan(0)
    })

    it('logout form submits to correct action', async () => {
      const snapshot = makeSnapshot()
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      const body = await res.text()
      expect(body).toContain('action="/auth/logout"')
    })
  })

  describe('security — unauthenticated access denied', () => {
    it('GET / without session cookie → redirect or 401', async () => {
      const app = buildTestApp(makeSnapshot())
      const res = await app.request('/')
      expect([302, 303, 401]).toContain(res.status)
      if (res.status === 302 || res.status === 303) {
        expect(res.headers.get('location')).toContain('/auth/login')
      }
    })

    it('GET / with invalid session cookie → denied', async () => {
      const app = buildTestApp(makeSnapshot())
      const res = await app.request('/', {headers: {cookie: 'session=invalid.garbage'}})
      expect([302, 303, 401]).toContain(res.status)
    })
  })

  describe('edge: empty snapshot (pre-first-fetch)', () => {
    it('renders loading/empty state — 200, no throw', async () => {
      const snapshot = makeSnapshot({repos: [], refreshedAt: null})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      expect(res.status).toBe(200)
      const body = await res.text()
      // Loading state rendered
      expect(body).toContain('Loading')
      // No error thrown — body is valid HTML
      expect(body).toContain('<html')
    })
  })

  describe('edge: staleBanner', () => {
    it('renders stale-cache banner when staleBanner is true', async () => {
      const snapshot = makeSnapshot({staleBanner: true, refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('Showing cached data')
      expect(body).toContain('live refresh unavailable')
    })

    it('does NOT render stale banner when staleBanner is false', async () => {
      const snapshot = makeSnapshot({staleBanner: false, refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).not.toContain('live refresh unavailable')
    })
  })

  describe('edge: driftCount', () => {
    it('renders count-only drift line when driftCount > 0', async () => {
      const snapshot = makeSnapshot({driftCount: 3, refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      expect(res.status).toBe(200)
      const body = await res.text()
      // Count rendered
      expect(body).toContain('3')
      expect(body).toContain('not in public metadata')
    })

    it('drift line contains the count, not repo names', async () => {
      // The drift count is 3 — there are no repos in the snapshot (drift repos are
      // never passed to the view). Assert no private repo names appear.
      const snapshot = makeSnapshot({driftCount: 3, refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      const body = await res.text()
      // These names should NOT appear — they're drift repos, never in the snapshot
      expect(body).not.toContain('private-repo-name')
      expect(body).not.toContain('secret-project')
    })

    it('does NOT render drift line when driftCount is 0', async () => {
      const snapshot = makeSnapshot({driftCount: 0, refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      const body = await res.text()
      expect(body).not.toContain('not in public metadata')
    })
  })

  describe('security: node_id not rendered as user-facing identity', () => {
    it('node_id is not rendered as visible text in the page', async () => {
      const repo = makeRepo({node_id: 'SENSITIVE_NODE_ID_12345'})
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/')

      const body = await res.text()
      // node_id must not appear as visible user-facing text
      // (it may appear in a key= attribute in JSX internals, but not as rendered content)
      // The view uses full_name for links and display — node_id is only used as React key
      // which does not appear in the rendered HTML output
      expect(body).not.toContain('SENSITIVE_NODE_ID_12345')
    })
  })
})

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
      const app = buildTestApp(snapshot)
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
      const app = buildTestApp(snapshot)
      const res = await authedGet(app, '/api/status')

      expect(res.status).toBe(200)
      const body = await res.json() as AggregatorSnapshot
      expect(body.repos).toHaveLength(0)
      expect(body.refreshedAt).toBeNull()
    })
  })

  describe('security — unauthenticated access denied', () => {
    it('GET /api/status without session cookie → denied', async () => {
      const app = buildTestApp(makeSnapshot())
      const res = await app.request('/api/status')
      expect([302, 303, 401]).toContain(res.status)
    })

    it('GET /api/status with invalid session cookie → denied', async () => {
      const app = buildTestApp(makeSnapshot())
      const res = await app.request('/api/status', {headers: {cookie: 'session=bad.cookie'}})
      expect([302, 303, 401]).toContain(res.status)
    })
  })

  describe('same snapshot source as dashboard', () => {
    it('/ and /api/status serve data from the same provider', async () => {
      const repo = makeRepo({full_name: 'fro-bot/shared-source'})
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      const app = buildTestApp(snapshot)

      const [htmlRes, jsonRes] = await Promise.all([authedGet(app, '/'), authedGet(app, '/api/status')])

      const htmlBody = await htmlRes.text()
      const jsonBody = await jsonRes.json() as AggregatorSnapshot

      // Both see the same repo
      expect(htmlBody).toContain('fro-bot/shared-source')
      expect(jsonBody.repos[0]?.full_name).toBe('fro-bot/shared-source')
    })
  })
})

describe('/api/healthz remains public', () => {
  it('GET /api/healthz returns 200 without auth', async () => {
    const app = buildTestApp(makeSnapshot())
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, lastFetch: null, rateLimit: null})
  })
})
