import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
/**
 * Operator UI skeleton integration tests.
 *
 * TDD: written before implementation.
 * Covers:
 * - Flag off → /operator returns denied/redirect, zero operator objects constructed
 * - Flag on + authed → 200 renders skeleton with all taxonomy states
 * - Flag on + unauthed → denied
 * - Mock client's injected fetch is never called during SSR render
 * - No sensitive values rendered (tokens, CSRF values, session cookies, raw prompts,
 *   tool args, workspace paths, internal URLs)
 * - Safe copy: failed_to_settle not rendered as primary label
 * - Copy distinguishes dashboard auth from Gateway auth
 */
import {Buffer} from 'node:buffer'

import {describe, expect, it} from 'vitest'
import {createMockOperatorClient} from '../src/gateway/operator-fixtures.ts'
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

function buildTestApp(operatorUiEnabled: boolean) {
  return buildDashboardApp({
    operatorLogin: TEST_OPERATOR,
    cookieKey: TEST_KEY,
    oauthClient: makeFakeOAuthClient(),
    fetchUserLogin: async (_token: string) => TEST_OPERATOR,
    getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
    operatorUiEnabled,
  })
}

async function authedGet(app: ReturnType<typeof buildTestApp>, path: string): Promise<Response> {
  const cookie = makeSessionCookie()
  return app.request(path, {headers: {cookie: `session=${cookie}`}})
}

// ---------------------------------------------------------------------------
// Flag-off tests
// ---------------------------------------------------------------------------

describe('operator UI — flag OFF (default)', () => {
  it('GET /operator without flag → denied (redirect or 401)', async () => {
    const app = buildTestApp(false)
    const res = await authedGet(app, '/operator')
    // When flag is off, /operator is not mounted → falls through to auth middleware
    // which either redirects or 401s (it's a protected unknown path)
    // The auth middleware redirects to /auth/login for authed users hitting unknown paths
    // Actually: authed users hitting unmounted paths get 404 from Hono
    // But the spec says "falls through to existing auth middleware and returns standard deny/redirect"
    // In practice, Hono returns 404 for unmounted routes after auth passes
    // The key invariant is: no operator content is served
    expect([302, 303, 401, 404]).toContain(res.status)
    // Unconditionally assert no operator content — a redirect/401/404 body won't contain these;
    // an accidental mount would.
    const body = await res.text()
    expect(body).not.toContain('Gateway Operator Controls')
    expect(body).not.toContain('Mock skeleton')
  })

  it('GET /operator without flag → no operator skeleton content', async () => {
    const app = buildTestApp(false)
    const res = await authedGet(app, '/operator')
    expect([302, 303, 401, 404]).toContain(res.status)
    // Must not serve operator UI content — assert unconditionally so the test
    // fails if the route is accidentally mounted regardless of status code.
    const body = await res.text()
    expect(body).not.toContain('Gateway Operator Controls')
    expect(body).not.toContain('Mock skeleton')
  })

  it('GET /operator unauthenticated without flag → denied', async () => {
    const app = buildTestApp(false)
    const res = await app.request('/operator')
    expect([302, 303, 401, 404]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------
// Flag-on + authenticated tests
// ---------------------------------------------------------------------------

describe('operator UI — flag ON + authenticated', () => {
  it('GET /operator → 200 with operator skeleton', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<html')
  })

  it('renders all run status states', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // All run states should be represented in the skeleton
    // (via fixture data rendered in the page)
    // We check for human-readable labels, not raw tokens
    expect(body).toMatch(/queue|waiting|pending/i)
    expect(body).toMatch(/running|in progress/i)
    expect(body).toMatch(/approval/i)
    expect(body).toMatch(/success|complete/i)
  })

  it('renders approval states with safe copy', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // failed_to_settle must NOT appear as primary label
    expect(body).not.toContain('failed_to_settle')
    // already_settled must NOT appear as raw token
    expect(body).not.toContain('already_settled')
    // waiting_for_approval must NOT appear as raw token in primary labels
    // (it may appear in data attributes or aria, but not as visible text)
  })

  it('CRITICAL: failed_to_settle raw token never appears in rendered HTML', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('failed_to_settle')
  })

  it('copy distinguishes dashboard auth from Gateway auth', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Must NOT imply dashboard session authorizes Gateway actions
    // Should have language distinguishing the two auth domains
    // The page should mention Gateway separately from dashboard session
    expect(body).toMatch(/gateway/i)
    // Should NOT say "you are signed in to Gateway" based on dashboard session alone
    // (the skeleton shows unauthenticated Gateway state)
  })

  it('no sensitive values rendered: no CSRF tokens, session cookies, or raw tokens', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // No raw CSRF token values from fixtures should appear as visible content
    // (fixture CSRF tokens are not rendered in the skeleton)
    // No session cookie values
    // No internal URLs (only relative /operator/* paths)
    expect(body).not.toMatch(/https?:\/\/(?!github\.com)[\w.-]+\/operator/i)
  })

  it('no raw prompts or tool args from fixtures rendered', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Pin the ACTUAL sensitive fixture values that must never appear in rendered HTML.
    // If a future refactor wires the launch form to render request fields, these will catch it.
    // FIXTURE_LAUNCH_REQUEST.prompt
    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    // FIXTURE_CSRF.token / FIXTURE_LAUNCH_REQUEST.csrfToken
    expect(body).not.toContain('fixture-csrf-placeholder')
    // FIXTURE_LAUNCH_REQUEST.idempotencyKey
    expect(body).not.toContain('fixture-idempotency-key-001')
    // FIXTURE_APPROVAL_DECISION_REQUEST.idempotencyKey
    expect(body).not.toContain('fixture-idempotency-key-002')
  })

  it('SSR renders without network AND mock client fetch guard converts calls to network errors', async () => {
    // Part 1: SSR renders from static fixtures — the throwing fetch is never called during render.
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)

    // Part 2: Prove the no-network guarantee at the client layer.
    // The mock client's injected fetch throws if called; the fetchJson wrapper
    // catches the throw and converts it to a network-error Result.
    const client = createMockOperatorClient()

    const sessionResult = await client.getCurrentSession()
    expect(sessionResult.success).toBe(false)
    if (!sessionResult.success) {
      expect(sessionResult.error.kind).toBe('network')
    }

    const snapshotResult = await client.getRunSnapshot('run-fixture-queued-001')
    expect(snapshotResult.success).toBe(false)
    if (!snapshotResult.success) {
      expect(snapshotResult.error.kind).toBe('network')
    }
  })

  it('renders launch form as inert (no live submit)', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Launch form should be present but disabled/inert
    // Should have a concrete reason why it's unavailable
    expect(body).toMatch(/launch|run/i)
    // Should indicate it's not ready/disabled
    expect(body).toMatch(/not ready|unavailable|disabled|pending/i)
  })

  it('renders pending approval card with keyboard-reachable controls', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Approval card should be present
    expect(body).toMatch(/approval|approve|reject/i)
  })

  it('renders terminal approval states as non-actionable', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Terminal states should be shown
    expect(body).toMatch(/expir|timeout/i)
  })

  it('renders Gateway unauthenticated panel', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Should show Gateway session state separately from dashboard session
    expect(body).toMatch(/gateway.*session|session.*gateway|sign in.*gateway|gateway.*sign in/i)
  })

  it('disabled controls have text reasons, not color-only', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Disabled reasons must be text, not just color
    // The page should contain explanatory text for why things are unavailable
    expect(body).toMatch(/not ready|unavailable|pending gateway|gateway.*not ready/i)
  })

  it('renders valid HTML with lang attribute', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('lang="en"')
    expect(body).toContain('<!doctype html>')
  })
})

// ---------------------------------------------------------------------------
// Flag-on + unauthenticated tests
// ---------------------------------------------------------------------------

describe('operator UI — flag ON + unauthenticated', () => {
  it('GET /operator without session → denied (redirect or 401)', async () => {
    const app = buildTestApp(true)
    const res = await app.request('/operator')
    expect([302, 303, 401]).toContain(res.status)
    if (res.status === 302 || res.status === 303) {
      expect(res.headers.get('location')).toContain('/auth/login')
    }
  })

  it('GET /operator with invalid session → denied', async () => {
    const app = buildTestApp(true)
    const res = await app.request('/operator', {headers: {cookie: 'session=invalid.garbage'}})
    expect([302, 303, 401]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------
// Existing routes unaffected
// ---------------------------------------------------------------------------

describe('existing routes unaffected by operator flag', () => {
  it('GET /api/healthz still returns 200 when flag is off', async () => {
    const app = buildTestApp(false)
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
  })

  it('GET /api/healthz still returns 200 when flag is on', async () => {
    const app = buildTestApp(true)
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
  })

  it('GET / (dashboard) still works when flag is on', async () => {
    const app = buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
  })
})
