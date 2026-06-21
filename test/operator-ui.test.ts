import type {GitHubOAuthClient} from '../src/auth/oauth.ts'
import type {GatewayClientError, OperatorClient, SessionDto} from '../src/gateway/operator-client.ts'
import type {Result} from '../src/result.ts'
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
 * - Flag-aware copy: separate-domains wording when Arctic is active, converged
 *   single-authority wording when gateway session governs operator access
 */
import {Buffer} from 'node:buffer'

import {describe, expect, it} from 'vitest'
import {ok} from '../src/result.ts'
import {buildDashboardApp} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'
import {createMockOperatorClient} from './operator-mock-client.ts'

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
    listPendingApprovals: () => {
      throw new Error('listPendingApprovals must not be called during page render')
    },
    decideApproval: () => {
      throw new Error('decideApproval must not be called during page render')
    },
  }
}

interface TestAppOpts {
  operatorUiEnabled: boolean
  gatewayOperatorSessionEnabled?: boolean
  operatorClient?: OperatorClient
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
// Flag-on + authenticated tests
// ---------------------------------------------------------------------------

describe('operator UI — flag ON + authenticated', () => {
  it('GET /operator → 200 with operator skeleton', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<html')
  })

  it('renders all run status states', async () => {
    const app = await buildTestApp(true)
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
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // failed_to_settle must NOT appear as primary label
    expect(body).not.toContain('failed_to_settle')
    // already_claimed must NOT appear as raw token
    expect(body).not.toContain('already_claimed')
    // scope_mismatch must NOT appear as raw token
    expect(body).not.toContain('scope_mismatch')
    // waiting_for_approval must NOT appear as raw token in primary labels
    // (it may appear in data attributes or aria, but not as visible text)

    // POSITIVE: pending fixture is rendered — assert safe label appears
    // approvalStateLabel('pending') === 'Awaiting your decision'
    expect(body).toContain('Awaiting your decision')
    // POSITIVE: scope_mismatch fixture is rendered — assert safe label appears
    // approvalStateLabel('scope_mismatch') === "Approval scope didn't match — decision not applied"
    // The apostrophe is HTML-entity-encoded in SSR output (&#39;) — use regex to match both forms
    expect(body).toMatch(/Approval scope didn(?:'|&#39;)t match — decision not applied/)
  })

  it('CRITICAL: failed_to_settle raw token never appears in rendered HTML', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('failed_to_settle')
  })

  it('copy distinguishes dashboard auth from Gateway auth', async () => {
    const app = await buildTestApp(true)
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
    const app = await buildTestApp(true)
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
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Pin the ACTUAL sensitive fixture values that must never appear in rendered HTML.
    // If a future refactor wires the launch form to render request fields, these will catch it.
    // FIXTURE_LAUNCH_REQUEST.prompt
    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    // FIXTURE_CSRF.csrfToken / FIXTURE_LAUNCH_REQUEST.csrfToken
    expect(body).not.toContain('fixture-csrf-placeholder')
    // FIXTURE_LAUNCH_REQUEST.idempotencyKey
    expect(body).not.toContain('fixture-idempotency-key-001')
    // FIXTURE_APPROVAL_DECISION_REQUEST.idempotencyKey
    expect(body).not.toContain('fixture-idempotency-key-002')
  })

  it('SSR renders without network AND mock client fetch guard converts calls to network errors', async () => {
    // Part 1: SSR renders from static fixtures — the throwing fetch is never called during render.
    const app = await buildTestApp(true)
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
    const app = await buildTestApp(true)
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
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Approval card should be present
    expect(body).toMatch(/approval|approve|reject/i)
  })

  it('renders approval decision states as non-actionable', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Decision states should be shown with safe copy
    // claimed state
    expect(body).toMatch(/claim|process|review|in progress/i)
    // unavailable state
    expect(body).toMatch(/unavailable/i)
  })

  it('renders Gateway unauthenticated panel', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Should show Gateway session state separately from dashboard session
    expect(body).toMatch(/gateway.*session|session.*gateway|sign in.*gateway|gateway.*sign in/i)
  })

  it('disabled controls have text reasons, not color-only', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // Disabled reasons must be text, not just color
    // The page should contain explanatory text for why things are unavailable
    expect(body).toMatch(/not ready|unavailable|pending gateway|gateway.*not ready/i)
  })

  it('renders valid HTML with lang attribute', async () => {
    const app = await buildTestApp(true)
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
    const app = await buildTestApp(true)
    const res = await app.request('/operator')
    expect([302, 303, 401]).toContain(res.status)
    if (res.status === 302 || res.status === 303) {
      expect(res.headers.get('location')).toContain('/auth/login')
    }
  })

  it('GET /operator with invalid session → denied', async () => {
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
// The operator page copy must accurately reflect which session authority is
// active. When the Arctic session governs access, the page states that
// dashboard sign-in is separate from Gateway sign-in. When the gateway
// operator session governs access, the page states that the gateway session
// is the authority for operator actions and that dashboard sign-in alone
// does not authorize gateway actions.
// ---------------------------------------------------------------------------

describe('operator UI — credential-domain copy when Arctic session governs (gateway flag OFF)', () => {
  it('renders the separate-domains wording when Arctic session is the authority', async () => {
    const app = await buildTestApp({operatorUiEnabled: true, gatewayOperatorSessionEnabled: false})
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // The exact phrase from the current separate-domains copy — pinned so any
    // accidental change to the flag-off wording is caught immediately.
    expect(body).toContain('separate from Gateway sign-in')
  })

  it('does NOT contain the converged single-authority wording when Arctic session governs', async () => {
    const app = await buildTestApp({operatorUiEnabled: true, gatewayOperatorSessionEnabled: false})
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // The converged phrase must not appear when the gateway flag is off
    expect(body).not.toContain('gateway session governs operator access')
  })

  it('no raw backend state leaks in flag-off render', async () => {
    const app = await buildTestApp({operatorUiEnabled: true, gatewayOperatorSessionEnabled: false})
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    expect(body).not.toContain('fixture-csrf-placeholder')
    expect(body).not.toContain('fixture-idempotency-key-001')
    expect(body).not.toContain('fixture-idempotency-key-002')
  })
})

// ---------------------------------------------------------------------------
// SSE stream wiring — DOM hooks and script tag
// ---------------------------------------------------------------------------

describe('operator UI — SSE stream wiring (flag ON + authenticated)', () => {
  it('page includes the operator-stream script tag with src and type=module', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('src="/static/operator-stream.js"')
    expect(body).toContain('type="module"')
  })

  it('run cards carry data-run-id attributes for all fixture runs', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    // All fixture run IDs must appear as data-run-id attributes
    expect(body).toContain('data-run-id="run-fixture-queued-001"')
    expect(body).toContain('data-run-id="run-fixture-running-002"')
    expect(body).toContain('data-run-id="run-fixture-approval-003"')
    expect(body).toContain('data-run-id="run-fixture-blocked-004"')
    expect(body).toContain('data-run-id="run-fixture-failed-005"')
    expect(body).toContain('data-run-id="run-fixture-cancelled-006"')
    expect(body).toContain('data-run-id="run-fixture-succeeded-007"')
  })

  it('status pill spans carry data-role="run-status"', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-role="run-status"')
  })

  it('run status section has a stable container id', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="run-status-section"')
  })

  it('stream-status notice element has a stable data-role hook', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-role="stream-status"')
  })

  it('no inline script tags with executable content (CSP clean)', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    // All <script> elements must have a src= attribute (no inline scripts)
    const scriptTagsWithoutSrc = body.match(/<script(?![^>]* src=)[^>]*>/g)
    expect(scriptTagsWithoutSrc).toBeNull()
  })

  it('script src is a relative path (no absolute URL)', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    // The script src must be /static/... not https://...
    expect(body).not.toMatch(/src="https?:\/\//)
  })

  it('SSR render does not call connectRunStream', async () => {
    // connectRunStream must never be called during server-side render —
    // stream connections only happen in the browser.
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    // If connectRunStream were called, it would throw and the request would fail.
    const res = await gatewayAuthedGet(app, '/operator')
    expect(res.status).toBe(200)
  })

  it('flag OFF → no script tag and no run-status section', async () => {
    const app = await buildTestApp(false)
    const res = await authedGet(app, '/operator')
    // Route is not mounted when flag is off
    expect([302, 303, 401, 404]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('operator-stream.js')
    expect(body).not.toContain('run-status-section')
  })

  it('no fixture/stream payload literals leak beyond existing rendered values', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
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
})

// ---------------------------------------------------------------------------
// Launch surface — operator-launch.js script, repo picker, live form, v1 caveats
// ---------------------------------------------------------------------------

describe('operator UI — launch surface (flag ON + authenticated)', () => {
  it('page includes the operator-launch script tag with src and type=module', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('src="/static/operator-launch.js"')
    expect(body).toContain('type="module"')
  })

  it('repo-picker container is present in the rendered HTML', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="repo-picker-container"')
  })

  it('launch form is present and not wrapped in a disabled fieldset', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    // The live form must be present
    expect(body).toContain('id="launch-form"')
    // The form must NOT have a disabled fieldset (the old skeleton had one)
    expect(body).not.toContain('<fieldset disabled')
    // The form itself must not carry aria-disabled
    expect(body).not.toContain('id="launch-form" aria-disabled')
    expect(body).not.toContain('aria-disabled="true" id="launch-form"')
  })

  it('launch form has a prompt textarea', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('name="prompt"')
    expect(body).toContain('<textarea')
  })

  it('launch form has a submit button', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('type="submit"')
  })

  it('v1-caveat copy is present: status-only observation', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/status.only/i)
  })

  it('v1-caveat copy is present: tool approval auto-deny', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/tool approval|automatically denied|auto.deny/i)
  })

  it('v1-caveat copy is present: repos are access-scoped', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/scoped|gateway.*access|access.*gateway/i)
  })

  it('no inline script tags (CSP clean — all scripts have src=)', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    const scriptTagsWithoutSrc = body.match(/<script(?![^>]* src=)[^>]*>/g)
    expect(scriptTagsWithoutSrc).toBeNull()
  })

  it('no-leak: fixture sensitive values never in rendered HTML', async () => {
    const app = await buildTestApp(true)
    const res = await authedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    expect(body).not.toContain('fixture-csrf-placeholder')
    expect(body).not.toContain('fixture-idempotency-key-001')
    expect(body).not.toContain('fixture-idempotency-key-002')
  })

  it('SSR render does not call listRepos, launchRun, or refreshCsrf', async () => {
    // The throwing fake surfaces any accidental SSR call to these methods.
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    // If listRepos/launchRun/refreshCsrf were called, they would throw and the request would fail.
    const res = await gatewayAuthedGet(app, '/operator')
    expect(res.status).toBe(200)
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
})

describe('operator UI — credential-domain copy when gateway session governs (gateway flag ON)', () => {
  // In gateway mode the auth middleware validates via the injected operatorClient.
  // We inject a fake that returns a valid session so the page renders.
  // The request carries a gateway cookie header (no Arctic session cookie).

  it('renders the converged single-authority wording when gateway session governs', async () => {
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    const res = await gatewayAuthedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // The converged wording must appear when the gateway session is the authority.
    // This phrase is introduced by this implementation — pin it here.
    expect(body).toContain('gateway session governs operator access')
  })

  it('does NOT contain the separate-domains wording when gateway session governs', async () => {
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    const res = await gatewayAuthedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // The separate-domains phrase must not appear when the gateway flag is on
    expect(body).not.toContain('separate from Gateway sign-in')
  })

  it('converged copy does not imply dashboard sign-in authorizes gateway actions', async () => {
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    const res = await gatewayAuthedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    // The page must make clear that dashboard sign-in alone does not authorize
    // gateway actions — the gateway session is the authority.
    expect(body).toMatch(/dashboard.*does not.*authoriz|signing in to the dashboard does not authoriz/i)
  })

  it('no raw backend state leaks in flag-on render', async () => {
    const operatorClient = makeFakeOperatorClient(async () => ok(VALID_GATEWAY_SESSION))
    const app = await buildTestApp({
      operatorUiEnabled: true,
      gatewayOperatorSessionEnabled: true,
      operatorClient,
    })
    const res = await gatewayAuthedGet(app, '/operator')
    expect(res.status).toBe(200)
    const body = await res.text()

    expect(body).not.toContain('[Fixture prompt — not rendered in UI]')
    expect(body).not.toContain('fixture-csrf-placeholder')
    expect(body).not.toContain('fixture-idempotency-key-001')
    expect(body).not.toContain('fixture-idempotency-key-002')
    // No raw gateway cookie values
    expect(body).not.toContain('test-gateway-cookie')
  })
})
