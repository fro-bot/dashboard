import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
import type {GatewayClientError, OperatorClient, SessionDto} from '../src/gateway/operator-client.ts'
import type {Result} from '../src/result.ts'
/**
 * Operator UI integration tests.
 *
 * Post-Units-1-4 state:
 * - /operator unconditionally redirects to / (302), flag-independent.
 * - / serves the React SPA shell (index.html from web/dist).
 * - The old SSR skeleton at /operator is gone; all operator UI is client-side.
 *
 * Covers:
 * - /operator → 302 redirect to / (flag ON and OFF)
 * - Root / serves the SPA shell with no sensitive value leaks
 * - No-dashboard-proxy invariant: /operator/runs, /operator/repos, stream,
 *   approval decision, etc. are not dashboard-owned proxy routes (404)
 * - Gateway session validation trust-boundary tests (redirect, cookie-only
 *   principal, origin checks) remain intact
 * - No sensitive values in SPA shell: tokens, CSRF, session cookies, raw
 *   prompts, tool args, workspace paths, internal URLs, private repo text
 */
import {Buffer} from 'node:buffer'

import {beforeEach, describe, expect, it} from 'vitest'
import {ok} from '../src/result.ts'
import {buildDashboardApp, resetRateLimitForTesting} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'
import {createMockOperatorClient} from './operator-mock-client.ts'

// Reset the module-level rate limiter before each test so tests don't bleed
// into each other. The rate limiter is shared module state (60 req/min per IP);
// without this reset, a large test suite exhausts the window and later tests
// get 429 responses that have nothing to do with the code under test.
beforeEach(() => {
  resetRateLimitForTesting()
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8') // 32 bytes
const TEST_OPERATOR = 'octocat'

// A valid future-expiry session for gateway-mode tests
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

/**
 * Minimal fake OperatorClient whose getCurrentSession returns a controllable result.
 * All other methods throw — they must never be called during operator page rendering.
 */
function makeFakeOperatorClient(
  getCurrentSessionImpl: () => Promise<Result<SessionDto, GatewayClientError>>,
): OperatorClient {
  return {
    getCurrentSession: getCurrentSessionImpl,
    refreshCsrf: () => {
      throw new Error('refreshCsrf must not be called during page render')
    },
    launchRun: () => {
      throw new Error('launchRun must not be called during page render')
    },
    getRunSnapshot: () => {
      throw new Error('getRunSnapshot must not be called during page render')
    },
    connectRunStream: () => {
      throw new Error('connectRunStream must not be called during page render')
    },
    listRepos: () => {
      throw new Error('listRepos must not be called during page render')
    },
    listRunApprovals: () => {
      throw new Error('listRunApprovals must not be called during page render')
    },
    decideRunApproval: () => {
      throw new Error('decideRunApproval must not be called during page render')
    },
    getVapidKey: () => {
      throw new Error('getVapidKey must not be called during page render')
    },
    getPushSubscriptionMetadata: () => {
      throw new Error('getPushSubscriptionMetadata must not be called during page render')
    },
    subscribePush: () => {
      throw new Error('subscribePush must not be called during page render')
    },
    unsubscribePush: () => {
      throw new Error('unsubscribePush must not be called during page render')
    },
  }
}

interface TestAppOpts {
  operatorUiEnabled: boolean
  gatewayOperatorSessionEnabled?: boolean
  operatorClient?: OperatorClient
  pushNotificationsEnabled?: boolean
}

async function buildTestApp(opts: TestAppOpts | boolean) {
  // Accept a plain boolean for backward compatibility with existing tests
  const resolved: TestAppOpts =
    typeof opts === 'boolean' ? {operatorUiEnabled: opts} : opts

  return buildDashboardApp({
    operatorLogin: TEST_OPERATOR,
    cookieKey: TEST_KEY,
    oauthClient: makeFakeOAuthClient(),
    fetchUserLogin: async (_token: string) => TEST_OPERATOR,
    getSnapshot: () => ({repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}),
    operatorUiEnabled: resolved.operatorUiEnabled,
    gatewayOperatorSessionEnabled: resolved.gatewayOperatorSessionEnabled,
    operatorClient: resolved.operatorClient,
    pushNotificationsEnabled: resolved.pushNotificationsEnabled,
  })
}

async function authedGet(app: Awaited<ReturnType<typeof buildTestApp>>, path: string): Promise<Response> {
  const cookie = makeSessionCookie()
  return app.request(path, {headers: {cookie: `session=${cookie}`}})
}

/**
 * Make an authenticated GET in gateway mode: sends a gateway cookie header
 * (no Arctic session cookie). The injected operatorClient fake returns a valid
 * session so the auth middleware passes and the page renders.
 */
async function gatewayAuthedGet(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  path: string,
): Promise<Response> {
  return app.request(path, {headers: {cookie: 'gateway_session=test-gateway-cookie'}})
}

// ---------------------------------------------------------------------------
// Flag-off tests
// ---------------------------------------------------------------------------

describe('operator UI — flag OFF (default)', () => {
  it('GET /operator without flag → denied (redirect or 401)', async () => {
    const app = await buildTestApp(false)
    const res = await authedGet(app, '/operator')
    // When flag is off, /operator still redirects to / (302) — the redirect is
    // flag-independent and mounted before the operatorUiEnabled-gated handler.
    expect([302, 303, 401, 404]).toContain(res.status)
    // Unconditionally assert no operator content — a redirect/401/404 body won't contain these;
    // an accidental mount would.
    const body = await res.text()
    expect(body).not.toContain('Gateway Operator Controls')
    expect(body).not.toContain('Mock skeleton')
  })

  it('GET /operator without flag → no operator skeleton content', async () => {
    const app = await buildTestApp(false)
    const res = await authedGet(app, '/operator')
    expect([302, 303, 401, 404]).toContain(res.status)
    // Must not serve operator UI content — assert unconditionally so the test
    // fails if the route is accidentally mounted regardless of status code.
    const body = await res.text()
    expect(body).not.toContain('Gateway Operator Controls')
    expect(body).not.toContain('Mock skeleton')
  })

  it('GET /operator unauthenticated without flag → denied', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/operator')
    expect([302, 303, 401, 404]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------
// /operator redirect tests (flag ON)
// ---------------------------------------------------------------------------

describe('operator UI — /operator redirect (flag ON)', () => {
  it('GET /operator → 302 redirect to /', async () => {
    // /operator unconditionally redirects to / regardless of flag state.
    // The React SPA shell at / is the canonical operator launch route.
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  it('GET /operator redirect body contains no sensitive values', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(302)
    const body = await res.text()
    // Redirect body must not leak any sensitive fixture or session values
    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    expect(body).not.toContain('fixture-csrf-placeholder')
    expect(body).not.toContain('fixture-idempotency-key-001')
    expect(body).not.toContain('fixture-idempotency-key-002')
    expect(body).not.toContain('test-gateway-cookie')
    expect(body).not.toContain('Gateway Operator Controls')
  })

  it('GET /operator redirect body contains no monitoring, mock skeleton, or private repo text', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body).not.toContain('Mock skeleton')
    expect(body).not.toContain('entityRef')
    expect(body).not.toContain('contractVersion')
  })
})

// ---------------------------------------------------------------------------
// SPA shell at / — no-leak assertions
// ---------------------------------------------------------------------------

describe('operator UI — SPA shell at / (flag ON + authenticated)', () => {
  it('GET / → 200 with SPA shell HTML', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<html')
  })

  it('SPA shell has valid HTML with lang attribute', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('lang="en"')
    expect(body).toContain('<!doctype html>')
  })

  it('CRITICAL: failed_to_settle raw token never appears in SPA shell', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('failed_to_settle')
  })

  it('no sensitive values in SPA shell: no CSRF tokens, session cookies, or raw tokens', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    // No raw CSRF token values
    expect(body).not.toContain('fixture-csrf-placeholder')
    // No session cookie values
    expect(body).not.toContain('test-gateway-cookie')
    // No internal URLs (only relative paths)
    expect(body).not.toMatch(/https?:\/\/(?!github\.com)[\w.-]+\/operator/i)
  })

  it('no raw prompts or tool args from fixtures in SPA shell', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    // Pin the ACTUAL sensitive fixture values that must never appear in rendered HTML.
    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    expect(body).not.toContain('fixture-csrf-placeholder')
    expect(body).not.toContain('fixture-idempotency-key-001')
    expect(body).not.toContain('fixture-idempotency-key-002')
  })

  it('no fixture/stream payload literals in SPA shell', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    // Existing no-leak assertions — these must continue to pass
    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    expect(body).not.toContain('fixture-csrf-placeholder')
    expect(body).not.toContain('fixture-idempotency-key-001')
    expect(body).not.toContain('fixture-idempotency-key-002')
    // Stream payload fields that must never appear in SSR output
    expect(body).not.toContain('entityRef')
    expect(body).not.toContain('contractVersion')
  })

  it('no approval fixture command/filepath text in SPA shell (inert SSR)', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    // The SPA shell must not render any fixture command or filepath text
    expect(body).not.toContain('echo hello')
    expect(body).not.toContain('/workspace/')
  })

  it('no "approval unavailable" fixture copy in SPA shell (misleading copy removed)', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    // The old fixture-only "approval unavailable" copy must be gone
    expect(body).not.toContain('Approval actions are disabled: the operator UI is not yet enabled')
    expect(body).not.toContain('Live approval actions will be available once the operator UI is enabled')
  })

  it('no raw fixture approval requestID in SPA shell', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    // The fixture requestID must not appear in the rendered HTML
    expect(body).not.toContain('req-fixture-001')
  })

  it('no inline script tags in SPA shell (CSP clean)', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    // All <script> elements must have a src= attribute (no inline scripts)
    const scriptTagsWithoutSrc = body.match(/<script(?![^>]* src=)[^>]*>/g)
    expect(scriptTagsWithoutSrc).toBeNull()
  })

  it('script src is a relative path in SPA shell (no absolute URL)', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    // The script src must be /assets/... not https://...
    expect(body).not.toMatch(/src="https?:\/\//)
  })

  it('mock client fetch guard: getCurrentSession and getRunSnapshot return network errors', async () => {
    // Prove the no-network guarantee at the client layer.
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
})

// ---------------------------------------------------------------------------
// Flag-on + unauthenticated tests
// ---------------------------------------------------------------------------

describe('operator UI — flag ON + unauthenticated', () => {
  it('GET /operator without session → redirect (302 to /)', async () => {
    // /operator redirects unconditionally — even unauthenticated requests get 302
    const app = await buildTestApp(true)
    const res = await app.request('/operator')
    // The redirect is flag-independent and mounted before auth middleware for /operator
    expect([302, 303, 401]).toContain(res.status)
  })

  it('GET /operator with invalid session → redirect or denied', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/operator', {headers: {cookie: 'session=invalid.garbage'}})
    expect([302, 303, 401]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------
// Existing routes unaffected
// ---------------------------------------------------------------------------

describe('existing routes unaffected by operator flag', () => {
  it('GET /api/healthz still returns 200 when flag is off', async () => {
    const app = await buildTestApp(false)
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
  })

  it('GET /api/healthz still returns 200 when flag is on', async () => {
    const app = await buildTestApp(true)
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
  })

  it('GET / (dashboard) still works when flag is on', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Flag-aware credential-domain copy
//
// The /operator route now redirects to / unconditionally. The credential-domain
// copy tests verify that the redirect response itself does not leak backend state
// and that the redirect target (/) serves the SPA shell without sensitive values.
// The old SSR copy assertions (separate-domains wording, converged wording) are
// removed because the SSR operator page no longer exists.
// ---------------------------------------------------------------------------

describe('operator UI — credential-domain: /operator redirect contains no backend state (gateway flag OFF)', () => {
  it('/operator redirect contains no raw backend state (flag-off render)', async () => {
    const app = await buildTestApp({operatorUiEnabled: true, gatewayOperatorSessionEnabled: false})
    const res = await authedGet(app, '/operator')
    // /operator redirects to / regardless of flag state
    expect([302, 303]).toContain(res.status)
    const body = await res.text()

    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    expect(body).not.toContain('fixture-csrf-placeholder')
    expect(body).not.toContain('fixture-idempotency-key-001')
    expect(body).not.toContain('fixture-idempotency-key-002')
  })

  it('/operator redirect does not contain converged single-authority wording', async () => {
    const app = await buildTestApp({operatorUiEnabled: true, gatewayOperatorSessionEnabled: false})
    const res = await authedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
    const body = await res.text()
    // The converged phrase must not appear in the redirect response
    expect(body).not.toContain('gateway session governs operator access')
  })
})

// ---------------------------------------------------------------------------
// SSE stream wiring — no-proxy invariant (flag ON)
// ---------------------------------------------------------------------------

describe('operator UI — SSE stream wiring: no-proxy invariant (flag ON + authenticated)', () => {
  it('/operator → 302 redirect (no SSR, no connectRunStream called)', async () => {
    // connectRunStream must never be called — /operator redirects before any SSR.
    // The throwing fake surfaces any accidental call to this method.
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    // /operator redirects to / — no SSR, no stream connection
    const res = await gatewayAuthedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
  })

  it('flag OFF → no script tag and no run-status section', async () => {
    const app = await buildTestApp(false)
    const res = await authedGet(app, '/operator')
    // Route redirects to / when flag is off too
    expect([302, 303, 401, 404]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('operator-stream.js')
    expect(body).not.toContain('run-status-section')
  })
})

// ---------------------------------------------------------------------------
// Launch surface — no-proxy invariant (flag ON)
// ---------------------------------------------------------------------------

describe('operator UI — launch surface: no-proxy invariant (flag ON + authenticated)', () => {
  it('/operator → 302 redirect (no SSR, no listRepos/launchRun/refreshCsrf called)', async () => {
    // The throwing fake surfaces any accidental SSR call to these methods.
    // /operator redirects before any SSR, so none of these should be called.
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    const res = await gatewayAuthedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
  })

  it('flag OFF → no operator-launch.js script, no launch form', async () => {
    const app = await buildTestApp(false)
    const res = await authedGet(app, '/operator')
    expect([302, 303, 401, 404]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('operator-launch.js')
    expect(body).not.toContain('launch-form')
    expect(body).not.toContain('repo-picker-container')
  })

  it('no-leak: fixture sensitive values never in /operator redirect response', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    expect(body).not.toContain('fixture-csrf-placeholder')
    expect(body).not.toContain('fixture-idempotency-key-001')
    expect(body).not.toContain('fixture-idempotency-key-002')
  })
})

// ---------------------------------------------------------------------------
// Inline approval prompt UI — no-dashboard-proxy invariant
// ---------------------------------------------------------------------------

describe('operator UI — approval region: no-dashboard-proxy invariant (flag ON)', () => {
  it('flag OFF → no approval region in rendered HTML', async () => {
    const app = await buildTestApp(false)
    const res = await authedGet(app, '/operator')
    expect([302, 303, 401, 404]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('run-approvals')
  })
})

describe('operator UI — no-dashboard-proxy 404 invariant for approval routes', () => {
  // The dashboard app deliberately does NOT serve the operator approval endpoints.
  // The public reverse proxy routes those same-origin paths to the gateway.
  // These assertions pin that invariant for the 1.4.0 per-run approval routes.
  it('GET /operator/runs/:id/approvals returns 404 from buildDashboardApp (not proxied)', async () => {
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    const res = await app.request('/operator/runs/run-001/approvals', {
      headers: {cookie: 'gateway_session=test-gateway-cookie'},
    })
    expect(res.status).toBe(404)
  })

  it('POST /operator/runs/:id/approvals/:reqId/decision returns 404 from buildDashboardApp (not proxied)', async () => {
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    const res = await app.request('/operator/runs/run-001/approvals/req-001/decision', {
      method: 'POST',
      headers: {
        cookie: 'gateway_session=test-gateway-cookie',
        'content-type': 'application/json',
      },
      body: JSON.stringify({decision: 'once'}),
    })
    expect(res.status).toBe(404)
  })

  it('SSR render does not call listRunApprovals or decideRunApproval', async () => {
    // The throwing fake surfaces any accidental SSR call to these methods.
    // /operator redirects before any SSR, so none of these should be called.
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    // /operator redirects to / — no SSR, no approval calls
    const res = await gatewayAuthedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
  })
})

describe('operator UI — credential-domain: /operator redirect contains no backend state (gateway flag ON)', () => {
  // /operator now redirects to / unconditionally. The old SSR copy tests
  // (converged wording, separate-domains wording) are removed because the SSR
  // operator page no longer exists. These tests verify the redirect response
  // itself does not leak backend state.

  it('/operator → 302 redirect (no SSR, no operator client calls)', async () => {
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    const res = await gatewayAuthedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
    expect(res.headers.get('location')).toBe('/')
  })

  it('/operator redirect contains no raw backend state (flag-on render)', async () => {
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    const res = await gatewayAuthedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
    const body = await res.text()

    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    expect(body).not.toContain('fixture-csrf-placeholder')
    expect(body).not.toContain('fixture-idempotency-key-001')
    expect(body).not.toContain('fixture-idempotency-key-002')
    // No raw gateway cookie values
    expect(body).not.toContain('test-gateway-cookie')
  })

  // The dashboard app deliberately does NOT serve the operator data/launch
  // endpoints — the public reverse proxy routes those same-origin paths to the
  // gateway. Serving them here would make this read-only app a
  // credential-forwarding proxy. These assertions pin that invariant: even with
  // the operator UI mounted and an authenticated operator, /operator/repos and
  // POST /operator/runs are not handled by the dashboard (Hono 404s the
  // unmounted sub-paths after auth passes).
  it('does not mount the operator data/launch endpoints (reverse proxy owns them)', async () => {
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })

    const repos = await app.request('/operator/repos', {
      headers: {cookie: 'gateway_session=test-gateway-cookie'},
    })
    expect(repos.status).toBe(404)

    const launch = await app.request('/operator/runs', {
      method: 'POST',
      headers: {cookie: 'gateway_session=test-gateway-cookie', 'content-type': 'application/json'},
      body: JSON.stringify({repo: 'fro-bot/agent', prompt: 'x'}),
    })
    expect(launch.status).toBe(404)

    const csrf = await app.request('/operator/session/csrf', {
      headers: {cookie: 'gateway_session=test-gateway-cookie'},
    })
    expect(csrf.status).toBe(404)
  })
})

// Fixture-absence assertions — /operator redirect and SPA shell

describe('operator UI — fixture-absence: /operator redirect body', () => {
  const fixtureRunIds = [
    'run-fixture-queued-001',
    'run-fixture-running-002',
    'run-fixture-approval-003',
    'run-fixture-blocked-004',
    'run-fixture-failed-005',
    'run-fixture-cancelled-006',
    'run-fixture-succeeded-007',
  ]

  for (const runId of fixtureRunIds) {
    it(`/operator redirect body does not contain fixture run ID: ${runId}`, async () => {
      const app = await buildTestApp(true)
      const res = await authedGet(app, '/operator')
      expect([302, 303]).toContain(res.status)
      const body = await res.text()
      expect(body).not.toContain(runId)
    })
  }

  it('/operator redirect body does not contain fixture request ID', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('req-fixture-001')
    expect(body).not.toContain('req-fixture-pending-001')
  })

  it('/operator redirect body does not contain timeline tokens (entityRef, contractVersion)', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('entityRef')
    expect(body).not.toContain('contractVersion')
  })

  it('/operator redirect body does not contain mock badge copy', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('Mock skeleton')
    expect(body).not.toContain('badge-mock')
    expect(body).not.toContain('fixture data')
    expect(body).not.toContain('fixture events')
  })

  it('/operator redirect body does not contain fixture run cards or timeline sections', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect([302, 303]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('run-card')
    expect(body).not.toContain('run-status-section')
    expect(body).not.toContain('timeline-heading')
    expect(body).not.toContain('Run Event Timeline')
  })
})

describe('operator UI — fixture-absence: GET /operator/runs returns 404 (no-proxy invariant)', () => {
  it('GET /operator/runs returns 404 from buildDashboardApp (not proxied)', async () => {
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    const res = await app.request('/operator/runs', {
      headers: {cookie: 'gateway_session=test-gateway-cookie'},
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// /operator/ trailing-slash redirect — inert surface regression
//
// /operator (exact) → 302 to / (unconditional redirect, pinned above).
// /operator/ (trailing slash) → 302 to / (unconditional redirect, flag-independent).
//
// Both are handled directly in server.ts. The sub-router (buildOperatorRouter)
// does NOT handle /operator/ — Hono's app.route('/operator', router) does not
// strip the trailing slash, so router.get('/') never fires for /operator/.
// The /operator/ redirect is therefore mounted unconditionally in server.ts.
//
// Invariants pinned here:
// - /operator/ is a 302 redirect to / (not 200, not 404, not data surface)
// - /operator/ redirect body contains no fixture strings, run data, or /__fixture paths
// - /operator/ and /operator behave identically (both 302 → /)
// - No operator client methods are called (no SSR gateway calls)
// ---------------------------------------------------------------------------

describe('operator UI — /operator/ trailing-slash redirect (flag ON + authenticated)', () => {
  it('GET /operator/ returns 302 redirect to / (not 200, not 404)', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  it('GET /operator/ redirect body contains no fixture run IDs', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator/')
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body).not.toContain('run-fixture-queued-001')
    expect(body).not.toContain('run-fixture-running-002')
    expect(body).not.toContain('run-fixture-approval-003')
    expect(body).not.toContain('run-fixture-failed-005')
  })

  it('GET /operator/ redirect body contains no /__fixture path strings', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator/')
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body).not.toContain('/__fixture')
    expect(body).not.toContain('__fixture')
  })

  it('GET /operator/ redirect body contains no run summary or timeline tokens', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator/')
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body).not.toContain('entityRef')
    expect(body).not.toContain('contractVersion')
    expect(body).not.toContain('run-status-section')
    expect(body).not.toContain('Run Event Timeline')
    expect(body).not.toContain('timeline-heading')
  })

  it('GET /operator/ redirect body contains no fixture CSRF or idempotency key strings', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator/')
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body).not.toContain('fixture-csrf-placeholder')
    expect(body).not.toContain('fixture-idempotency-key-001')
    expect(body).not.toContain('fixture-idempotency-key-002')
    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
  })

  it('GET /operator/ redirect body contains no mock badge or skeleton copy', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator/')
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body).not.toContain('Mock skeleton')
    expect(body).not.toContain('badge-mock')
    expect(body).not.toContain('Gateway Operator Controls')
    expect(body).not.toContain('fixture data')
  })

  it('GET /operator/ redirect body contains no raw gateway cookie values', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator/')
    expect(res.status).toBe(302)
    const body = await res.text()
    expect(body).not.toContain('test-gateway-cookie')
  })

  it('GET /operator/ does not call any operator client methods (no SSR gateway calls)', async () => {
    // The throwing fake surfaces any accidental gateway call during /operator/ handling.
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    // Should redirect without calling getCurrentSession or any other method
    const res = await authedGet(app, '/operator/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })
})

describe('operator UI — /operator/ trailing-slash: same behavior as /operator exact', () => {
  it('/operator and /operator/ both return 302 to / (flag-independent, identical behavior)', async () => {
    const app = await buildTestApp(true)
    const cookie = makeSessionCookie()
    const [exactRes, trailingRes] = await Promise.all([
      app.request('/operator', {headers: {cookie: `session=${cookie}`}}),
      app.request('/operator/', {headers: {cookie: `session=${cookie}`}}),
    ])
    expect(exactRes.status).toBe(302)
    expect(exactRes.headers.get('location')).toBe('/')
    expect(trailingRes.status).toBe(302)
    expect(trailingRes.headers.get('location')).toBe('/')
  })

  it('/operator/ redirect is flag-independent (flag OFF also redirects to /)', async () => {
    const app = await buildTestApp(false)
    const cookie = makeSessionCookie()
    const res = await app.request('/operator/', {headers: {cookie: `session=${cookie}`}})
    // /operator/ redirects unconditionally regardless of operatorUiEnabled
    expect([302, 303]).toContain(res.status)
    if (res.status === 302 || res.status === 303) {
      expect(res.headers.get('location')).toBe('/')
    }
  })
})

// ---------------------------------------------------------------------------
// Push notification routes — no-dashboard-proxy 404 invariant
//
// The dashboard depends on these 4 Gateway v1 routes but never mounts them —
// they are reverse-proxied to the Gateway. Every verb must 404 from
// buildDashboardApp (HEAD/OPTIONS must not leak existence or allowed methods).
// ---------------------------------------------------------------------------

describe('push routes — no-dashboard-proxy 404 invariant', () => {
  const pushPaths = [
    '/operator/push/vapid-key',
    '/operator/push/subscriptions',
    '/operator/push/subscriptions/unsubscribe',
  ]
  const verbs: ('GET' | 'POST' | 'HEAD' | 'OPTIONS' | 'PUT' | 'PATCH' | 'DELETE')[] = [
    'GET',
    'POST',
    'HEAD',
    'OPTIONS',
    'PUT',
    'PATCH',
    'DELETE',
  ]

  for (const path of pushPaths) {
    for (const method of verbs) {
      it(`${method} ${path} returns 404 from buildDashboardApp (not proxied)`, async () => {
        const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
        const app = await buildTestApp({
          operatorUiEnabled: true,
          gatewayOperatorSessionEnabled: true,
          operatorClient,
        })
        const res = await app.request(path, {
          method,
          headers: {cookie: 'gateway_session=test-gateway-cookie'},
        })
        expect(res.status).toBe(404)
      })
    }
  }
})

describe('push-enabled meta injection — served SPA shell integrity', () => {
  it('serves a COMPLETE index.html (root mount target present) with the injected meta when push is enabled', async () => {
    const app = await buildTestApp({operatorUiEnabled: true, pushNotificationsEnabled: true})
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    // The injected meta must be present...
    expect(body).toContain('<meta name="push-enabled" content="true">')
    // ...AND the response must NOT be truncated: the React mount target must
    // survive injection. A stale Content-Length after injection dropped the
    // tail of the document (regression: blank page / "Root element not found").
    expect(body).toContain('<div id="root">')
    expect(body).toContain('</html>')
    // Content-Length, when present, must match the actual (post-injection) body
    // byte length — a mismatch is exactly what truncated the served shell.
    const contentLength = res.headers.get('content-length')
    if (contentLength !== null) {
      expect(Number(contentLength)).toBe(Buffer.byteLength(body))
    }
  })

  it('does not inject the meta when push is disabled', async () => {
    const app = await buildTestApp({operatorUiEnabled: true, pushNotificationsEnabled: false})
    const res = await authedGet(app, '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('push-enabled')
    expect(body).toContain('<div id="root">')
  })
})
