/**
 * Dashboard app factory + server binding.
 *
 * `buildDashboardApp(opts?)` — constructs the Hono app with all middleware and routes.
 * Accepts an optional config object for testability (inject fake OAuth client,
 * cookie key, operator login). When called with no args, reads from env.
 *
 * `createDashboardServer()` — binds the app to `DASHBOARD_HOST:DASHBOARD_PORT`
 * (default `0.0.0.0:3000`) so a sibling reverse-proxy container can reach it.
 *
 * Mirrors the gateway's buildAnnounceApp/createAnnounceServer split for future
 * @fro.bot/runtime extraction.
 *
 * Auth middleware protects every route EXCEPT:
 * - `/api/healthz` (public health check)
 * - `/auth/*` (login/callback/logout)
 */
import type {ServerType} from '@hono/node-server'
import type {GitHubOAuthClient} from './auth/oauth.ts'
import type {OperatorClient, SessionDto} from './gateway/operator-client.ts'
import type {AggregatorSnapshot} from './github/aggregator.ts'
import type {MetadataReader} from './github/metadata.ts'
import {Buffer} from 'node:buffer'
import process from 'node:process'
import {serve} from '@hono/node-server'
import {getConnInfo} from '@hono/node-server/conninfo'
import {serveStatic} from '@hono/node-server/serve-static'
import {Octokit} from '@octokit/core'
import {graphql} from '@octokit/graphql'
import {Hono, type Context} from 'hono'
import {getCookie} from 'hono/cookie'
import {secureHeaders} from 'hono/secure-headers'
import {fetchGitHubUserLogin, makeGitHubOAuthClient} from './auth/oauth.ts'
import {createOperatorClient} from './gateway/operator-client.ts'
import {readGatewayOperatorOrigin, readGatewayOperatorSessionConfig, readOperatorUiConfig} from './gateway/operator-config.ts'
import {createOperatorServerFetch} from './gateway/operator-server-fetch.ts'
import {createAggregator} from './github/aggregator.ts'
import {createDashboardAppClient} from './github/app-client.ts'
import {buildInstallationsClient, enumerateRepos, mintReadOnlyToken} from './github/installations.ts'
import {makeNotFoundError, readRepoMetadata} from './github/metadata.ts'
import {logger, sanitizeErrorMessage} from './logger.ts'
import {isOk} from './result.ts'
import {buildApiRouter} from './routes/api.ts'
import {buildAuthRouter} from './routes/auth.ts'
import {buildDashboardRouter} from './routes/dashboard.ts'
import {readOptionalMultilineSecret, readOptionalSecret} from './secrets.ts'
import {loadCookieKey, SessionManager} from './session.ts'

/** Hono context variables set by auth middleware */
interface Variables {
  /**
   * Set by the Arctic branch only. Optional because the gateway branch does not
   * set this value — it sets gatewaySession instead.
   */
  sessionLogin?: string
  /**
   * Set by the gateway branch only. Contains the validated operator session from
   * the gateway's /operator/session endpoint. Never set by the Arctic branch.
   */
  gatewaySession?: SessionDto
}

/** Per-IP rate limiter state */
interface RateLimitEntry {
  count: number
  windowStart: number
}

/** Simple fixed-window in-memory rate limiter */
const rateLimitMap = new Map<string, RateLimitEntry>()
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX = 60 // requests per window per IP

/**
 * Eviction sweep counter. Every EVICT_INTERVAL calls we sweep the map for
 * entries older than 2× the window. This is cheap, non-blocking, and avoids
 * unbounded memory growth without a module-level setInterval.
 */
let rateLimitCallCount = 0
const EVICT_INTERVAL = 500 // sweep every 500 calls
const EVICT_STALE_AGE = 2 * RATE_LIMIT_WINDOW_MS

// In gateway operator-session mode, an unauthenticated/invalid request must recover
// through the GATEWAY operator login (which mints the __Host-session the gateway
// authority requires), never the dashboard's own Arctic flow (which mints a
// dashboard `session` cookie the gateway rejects, causing a re-auth loop on gateway
// restart — see issue #70). return_to is fixed to /operator: the gateway validates
// it against an exact allowlist (default ['/operator']) and rejects anything else.
// The value is a fixed same-origin relative literal — no request-derived component,
// so it introduces no open redirect.
const GATEWAY_LOGIN_REDIRECT = '/operator/auth/github/start?return_to=/operator'

function sweepRateLimitMap(now: number): void {
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > EVICT_STALE_AGE) {
      rateLimitMap.delete(key)
    }
  }
}

/**
 * Check rate limit for the given IP.
 * Accepts an optional `now` for testability (defaults to Date.now()).
 * Returns true if the request is allowed, false if rate-limited.
 */
export function checkRateLimit(ip: string, now: number = Date.now()): boolean {
  rateLimitCallCount++
  if (rateLimitCallCount >= EVICT_INTERVAL) {
    rateLimitCallCount = 0
    sweepRateLimitMap(now)
  }

  const entry = rateLimitMap.get(ip)

  if (entry === undefined || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, {count: 1, windowStart: now})
    return true
  }

  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
    return false
  }
  return true
}

/**
 * Injectable config for `buildDashboardApp`.
 * All fields are optional — production reads from env.
 * Tests inject fakes to avoid network/env dependencies.
 */
export interface DashboardAppConfig {
  /**
   * Exact GitHub login allowed to authenticate.
   * If undefined, reads from `DASHBOARD_OPERATOR_LOGIN` env.
   * If whitespace-only → throws (fail-closed).
   */
  operatorLogin?: string | undefined
  /**
   * Cookie signing key (≥32 bytes).
   * Required when `operatorLogin` is set (auth active). Throws at construction if absent.
   * When `operatorLogin` is unset (deny-all mode), no SessionManager is constructed
   * and this field is ignored.
   * Production: use `createDashboardServer()` which calls `loadCookieKey()`.
   */
  cookieKey?: Buffer | undefined
  /**
   * GitHub OAuth client. If undefined, constructs from env vars.
   */
  oauthClient?: GitHubOAuthClient | undefined
  /**
   * Fetches the GitHub login for an access token.
   * If undefined, uses the real GitHub API.
   */
  fetchUserLogin?: ((accessToken: string) => Promise<string>) | undefined
  /**
   * Aggregator snapshot provider. Both the dashboard SSR route and /api/status
   * read from this same provider so they always serve the same data.
   *
   * If undefined, defaults to a provider returning an empty snapshot
   * {repos:[], staleBanner:false, driftCount:0, refreshedAt:null}.
   * The real aggregator is wired here in production via createDashboardServer.
   * Tests inject a fake snapshot provider.
   */
  getSnapshot?: (() => AggregatorSnapshot) | undefined
  /**
   * Whether to mount the operator UI skeleton at /operator.
   * If undefined, reads from DASHBOARD_OPERATOR_UI_ENABLED env (default: false).
   * When false (default), /operator is NOT mounted — zero operator objects are
   * constructed in-process. The route falls through to the auth middleware which
   * returns the standard deny/redirect for protected unknown paths.
   * Tests inject this directly to avoid env dependencies.
   */
  operatorUiEnabled?: boolean | undefined
  /**
   * Whether to use the gateway operator session for auth instead of Arctic.
   * If undefined, reads from DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED env (default: false).
   * When false (default), the existing Arctic OAuth + signed-cookie session is used.
   * When true, the gateway operator session governs auth.
   * Tests inject this directly to avoid env dependencies.
   * Independent of operatorUiEnabled: separate env var, separate reader.
   */
  gatewayOperatorSessionEnabled?: boolean | undefined
  /**
   * Injectable OperatorClient for the gateway auth branch.
   * If undefined and gatewayOperatorSessionEnabled is true, a real client is built
   * per-request from the server-side fetch adapter (bound to the configured origin
   * and inbound cookie). Tests inject a fake to avoid network calls.
   * Never constructed when gatewayOperatorSessionEnabled is false, so the flag-off
   * path builds zero gateway objects.
   */
  operatorClient?: OperatorClient | undefined
  /**
   * Trusted gateway operator origin for the /operator/session endpoint.
   * If undefined, reads from DASHBOARD_GATEWAY_OPERATOR_ORIGIN env (default:
   * 'https://dashboard.fro.bot'). Must be an absolute http(s) origin.
   * On invalid/parse-failure the middleware fails closed (denies all requests).
   *
   * SECURITY: this must NEVER be derived from the inbound request Host header.
   * The Host header is attacker-influenceable; a spoofed Host could redirect the
   * forwarded cookie to an attacker-controlled server. This field is the seam
   * that lets tests set a known-good origin without touching env.
   */
  gatewayOperatorOrigin?: string | undefined
  /**
   * Injectable fetch implementation for the production gateway client path.
   * Only used when operatorClient is undefined (the production branch that builds
   * a real client from createOperatorServerFetch). Inject a recording/fake fetch
   * in tests to exercise the production client-construction path without network.
   * Ignored when operatorClient is injected directly.
   */
  gatewayFetchImpl?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined
}

/**
 * Constructs the Hono app with all middleware and routes mounted.
 * Separated from port binding so tests can call app.request() without a live server.
 *
 * Throws at construction time if:
 * - `operatorLogin` is whitespace-only or empty (fail-closed)
 * - `operatorLogin` is set but `cookieKey` is undefined (fail-closed — zero key is forgeable)
 * - `cookieKey` is <32 bytes (fail-closed)
 */
async function buildDashboardApp(opts?: DashboardAppConfig): Promise<Hono<{Variables: Variables}>> {
  // Resolve operator login (fail-closed)
  const rawOperatorLogin = opts?.operatorLogin ?? process.env.DASHBOARD_OPERATOR_LOGIN
  if (typeof rawOperatorLogin === 'string' && rawOperatorLogin.trim() === '') {
    throw new Error('DASHBOARD_OPERATOR_LOGIN must not be whitespace-only (fail-closed)')
  }
  const operatorLogin = typeof rawOperatorLogin === 'string' ? rawOperatorLogin.trim() : undefined

  // Resolve cookie key — only construct SessionManager when auth is active.
  // When operatorLogin is set, a real key is MANDATORY (fail-closed).
  // When operatorLogin is unset (deny-all mode), no session is ever issued so
  // no SessionManager is needed; skip construction to avoid a zero-key footgun.
  let sessionManager: SessionManager | undefined
  if (operatorLogin !== undefined) {
    if (opts?.cookieKey === undefined) {
      throw new Error(
        'cookie key required when DASHBOARD_OPERATOR_LOGIN is set (pass cookieKey or use createDashboardServer which calls loadCookieKey)',
      )
    }
    // SessionManager constructor validates key length (throws if <32 bytes)
    sessionManager = new SessionManager(opts.cookieKey)
  }

  // Resolve OAuth client
  const oauthClient =
    opts?.oauthClient ??
    makeGitHubOAuthClient(
      process.env.DASHBOARD_OAUTH_CLIENT_ID ?? '',
      process.env.DASHBOARD_OAUTH_CLIENT_SECRET ?? '',
      process.env.DASHBOARD_OAUTH_REDIRECT_URI ?? 'http://localhost:3000/auth/callback',
    )

  const fetchUserLogin = opts?.fetchUserLogin ?? fetchGitHubUserLogin

  // Resolve snapshot provider — both dashboard SSR and /api/status share the same source.
  // Default: empty snapshot (no aggregator wired yet; production wires the real one).
  const EMPTY_SNAPSHOT = {repos: [], staleBanner: false, driftCount: 0, refreshedAt: null} as const
  const getSnapshot = opts?.getSnapshot ?? (() => EMPTY_SNAPSHOT)

  // Resolve operator UI flag — default OFF (fail-closed).
  // When undefined, reads from env. Tests inject directly via opts.operatorUiEnabled.
  const operatorUiEnabled =
    opts?.operatorUiEnabled === undefined ? readOperatorUiConfig().enabled : opts.operatorUiEnabled

  // Resolve gateway operator session flag — default OFF (fail-closed).
  // When undefined, reads from env. Tests inject directly via opts.gatewayOperatorSessionEnabled.
  // Independent of operatorUiEnabled: separate env var, separate reader.
  const gatewayOperatorSessionEnabled =
    opts?.gatewayOperatorSessionEnabled === undefined
      ? readGatewayOperatorSessionConfig().enabled
      : opts.gatewayOperatorSessionEnabled

  // Resolve the trusted gateway operator origin — SECURITY CRITICAL.
  // Must be a configured, trusted value; never derived from the inbound request Host.
  // When opts.gatewayOperatorOrigin is provided (tests), use it directly after
  // validation. When undefined, read from env (with default fallback).
  // null means the configured value is invalid → fail closed at middleware time.
  let resolvedGatewayOrigin: string | null = null
  if (gatewayOperatorSessionEnabled) {
    if (opts?.gatewayOperatorOrigin === undefined) {
      resolvedGatewayOrigin = readGatewayOperatorOrigin()
    } else {
      // Validate the injected origin (same rules as readGatewayOperatorOrigin).
      try {
        const parsed = new URL(opts.gatewayOperatorOrigin)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          resolvedGatewayOrigin = parsed.origin
          // else: invalid scheme → stays null → fail closed
        }
      } catch {
        // Invalid URL → stays null → fail closed
      }
    }
  }

  const app = new Hono<{Variables: Variables}>()

  // ── Security headers + CSP (applied to all responses) ──────────────────────
  // Placed first so every response — including error responses — carries the
  // security headers. The tight CSP (script-src 'self', no unsafe-inline)
  // requires all styles to be external files (see public/operator.css).
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // The SSR pages use inline style attributes throughout, so style-src
        // permits inline styles. Scripts stay strict ('self', no inline) since
        // inline script is the meaningful XSS vector here.
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  )

  // ── Rate limiting middleware (applied to sensitive routes) ──────────────────
  // NOTE: Real per-client rate limiting belongs at Caddy (the reverse proxy).
  // This is defense-in-depth only. We key on the direct connection remote address
  // (not X-Forwarded-For) because the app only sees loopback connections from Caddy
  // and XFF is client-controlled — trusting it would allow spoofing the throttle key.
  app.use('*', async (c: Context, next) => {
    const path = new URL(c.req.url).pathname
    const sensitiveRoutes = ['/', '/auth/login', '/auth/callback', '/operator']
    const isSensitive = sensitiveRoutes.includes(path) || path.startsWith('/api/') || path.startsWith('/operator/')

    if (isSensitive) {
      // Use the direct connection remote address — not XFF (client-spoofable).
      // getConnInfo is only available in the real Node.js server context; in tests
      // (app.request()) it throws, so we fall back to 'unknown' gracefully.
      let ip: string
      try {
        ip = getConnInfo(c).remote.address ?? 'unknown'
      } catch {
        ip = 'unknown'
      }

      if (!checkRateLimit(ip)) {
        logger.warning('Rate limit exceeded', {ip, path})
        return c.text('Too Many Requests', 429)
      }
    }

    return next()
  })

  // ── Auth middleware (deny-by-default, fail-closed) ──────────────────────────
  // Public routes (always reachable without a session):
  //   - /api/healthz  (health check)
  //   - /auth/*       (login/callback/logout — themselves deny when unconfigured)
  // Every other route REQUIRES a valid operator session. When operatorLogin is
  // unset, the app fails CLOSED: every protected route is denied (401), and a
  // session can never be issued (the /auth flow is replaced by a denied router).
  // Deny-by-default beats 404 here — an unauthenticated caller must not be able
  // to probe which routes exist.
  //
  // Strategy branch: the flag selects exactly ONE branch at the top. The two
  // branches NEVER union and NEVER fall back to each other. Each branch runs its
  // OWN isPublicPath check — a path added to one mode's allowlist cannot silently
  // bypass the other.
  const isPublicPath = (path: string): boolean =>
    path === '/api/healthz' ||
    path === '/auth/login' ||
    path === '/auth/callback' ||
    path === '/auth/logout' ||
    (operatorUiEnabled && path.startsWith('/static/'))

  app.use('*', async (c: Context, next) => {
    const path = new URL(c.req.url).pathname

    if (gatewayOperatorSessionEnabled) {
      // ── GATEWAY BRANCH ────────────────────────────────────────────────────
      // Authorizes purely on a valid gateway operator session. There is no
      // DASHBOARD_OPERATOR_LOGIN check here, and no fallback to Arctic on failure.

      // Own public-path check — duplicated intentionally (see strategy-branch note).
      if (isPublicPath(path)) {
        return next()
      }

      // Require an inbound cookie to forward as the end-user principal. If absent
      // or whitespace-only, deny immediately — do NOT call getCurrentSession.
      const inboundCookie = c.req.header('cookie')
      if (inboundCookie === undefined || inboundCookie.trim() === '') {
        // Deny: no principal to forward. Recover through the gateway operator login so
        // the operator mints the __Host-session the gateway requires (see issue #70).
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }

      // Fail closed if the configured gateway origin is invalid or unparseable.
      // This protects against a misconfigured DASHBOARD_GATEWAY_OPERATOR_ORIGIN
      // causing the middleware to silently fall back to an unsafe origin.
      if (resolvedGatewayOrigin === null) {
        logger.warning('gateway-auth: configured gateway origin is invalid or missing', {path})
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }

      // Obtain the OperatorClient: use injected client (tests) or build per-request (production).
      // Per-request construction is correct: the cookie comes from the request.
      // The origin is ALWAYS the configured trusted value — never from the request Host.
      // Flag-OFF never reaches this branch, so zero gateway objects are constructed when off.
      let client: OperatorClient
      if (opts?.operatorClient === undefined) {
        // Production path: build a real client bound to the CONFIGURED origin and inbound cookie.
        // SECURITY: origin is resolvedGatewayOrigin (configured), NOT new URL(c.req.url).origin.
        // The inbound Host header is attacker-influenceable; using it would allow a spoofed
        // Host to redirect the forwarded cookie to an attacker-controlled server.
        const serverFetch = createOperatorServerFetch({
          origin: resolvedGatewayOrigin,
          cookie: inboundCookie,
          fetchImpl: opts?.gatewayFetchImpl,
        })
        // Minimal no-op createEventStream stub — getCurrentSession does not use SSE.
        // Throws if called to surface any accidental SSE usage loudly.
        const noopEventStream = (_streamPath: string) => ({
          start: () => {
            throw new Error('SSE transport not available in server-side auth middleware')
          },
          close: () => undefined,
        })
        client = createOperatorClient({
          fetch: serverFetch,
          createEventStream: noopEventStream,
          logger,
        })
      } else {
        client = opts.operatorClient
      }

      // Call the gateway session endpoint. Fail closed on every non-success path.
      // Coarse logging only — never log the cookie value or session body.
      const result = await client.getCurrentSession()
      if (!isOk(result)) {
        // Every error kind (http/network/protocol/validation) → deny.
        // Log only the path — never the error detail which may contain identity info.
        logger.warning('gateway-auth: session validation failed', {path})
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }

      // Expired-session defense — even on a 2xx, a non-future expiresAt → deny.
      // The gateway is the authority but we do not rely solely on it never returning expired.
      if (result.data.expiresAt <= Date.now()) {
        logger.warning('gateway-auth: session expired', {path})
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }

      // Nonsensical identity defense — deny sessions with a non-positive operatorId
      // or a blank login. These are structurally valid per the parse contract but
      // semantically impossible for a real operator account. Fail closed rather than
      // propagate a garbage identity downstream.
      if (result.data.operatorId <= 0) {
        logger.warning('gateway-auth: session has non-positive operatorId', {path})
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }
      if (result.data.login.trim() === '') {
        logger.warning('gateway-auth: session has empty login', {path})
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }

      // Valid gateway session: attach to context. Do NOT set sessionLogin —
      // gatewaySession is the only identity signal in gateway mode.
      c.set('gatewaySession', result.data)
      return next()
    } else {
      // ── ARCTIC BRANCH (byte-for-byte today's logic) ───────────────────────
      // Flag-OFF preserves the existing Arctic middleware behavior exactly.
      // Own public-path check — duplicated intentionally (see strategy-branch note).

      if (isPublicPath(path)) {
        return next()
      }

      // Fail closed: with no configured operator, no protected route is served.
      if (operatorLogin === undefined) {
        return c.text('Unauthorized', 401)
      }

      // Validate session cookie.
      // The middleware context type is slightly wider than getCookie's declared param type;
      // this cast is safe — getCookie only reads headers from the context.
      const cookieValue = getCookie(c, 'session')
      if (typeof cookieValue !== 'string' || cookieValue.length === 0) {
        return c.redirect('/auth/login', 302)
      }

      // sessionManager is guaranteed non-undefined here: operatorLogin is set (checked above)
      // and we only construct SessionManager when operatorLogin is set.
      const session = (sessionManager as SessionManager).verify(cookieValue)
      if (session === null) {
        return c.redirect('/auth/login', 302)
      }

      // FIX #4: Reject sessions minted for a different operator login.
      // A stale session from a previously-configured login must not grant access
      // after the operator changes.
      if (session.login !== operatorLogin) {
        return c.redirect('/auth/login', 302)
      }

      // Attach session login to context for downstream handlers (typed, no `as never`)
      c.set('sessionLogin', session.login)
      return next()
    }
  })

  if (gatewayOperatorSessionEnabled) {
    // Gateway operator-session mode: the gateway is the session authority. The
    // dashboard Arctic flow must NOT be reachable here — minting a dashboard
    // `session` cookie cannot satisfy the gateway and causes the re-auth loop on
    // gateway restart (issue #70). Mount a minimal router that sends /auth/login to
    // the gateway operator login; deliberately do NOT mount /auth/callback or any
    // other Arctic path, so the dashboard session-minting flow returns 404.
    const gatewayAuthRouter = new Hono()
    gatewayAuthRouter.get('/login', c => c.redirect(GATEWAY_LOGIN_REDIRECT, 302))
    app.route('/auth', gatewayAuthRouter)
  } else if (operatorLogin === undefined) {
    // Fail-closed: no operator login → the auth flow itself denies all requests,
    // so no session can ever be minted.
    const deniedRouter = new Hono()
    deniedRouter.all('*', c => c.text('Unauthorized', 401))
    app.route('/auth', deniedRouter)
  } else {
    const authRouter = buildAuthRouter({
      operatorLogin,
      sessionManager: sessionManager as SessionManager,
      oauthClient,
      fetchUserLogin,
      cookieKey: opts?.cookieKey as Buffer,
    })
    app.route('/auth', authRouter)
  }

  // ── API routes ───────────────────────────────────────────────────────────────
  // /api/healthz is public (exempted in isPublicPath above).
  // /api/status is protected — the auth middleware above already denies unauthenticated
  // requests to any path not in isPublicPath, so no extra guard is needed here.
  app.route('/api', buildApiRouter(getSnapshot))

  // ── Dashboard SSR route ──────────────────────────────────────────────────────
  // Mounted at `/` — protected by the auth middleware above.
  // Pass cookieKey + operatorLogin so the dashboard can render the CSRF token for logout.
  app.route(
    '/',
    buildDashboardRouter({
      getSnapshot,
      cookieKey: opts?.cookieKey,
      operatorLogin,
      gatewayOperatorSessionEnabled,
    }),
  )

  // ── Operator UI skeleton route ────────────────────────────────────────────────
  // Only mounted when operatorUiEnabled is true (default: false).
  // When disabled, /operator is NOT mounted — zero operator objects are constructed.
  // The route falls through to the auth middleware which returns the standard
  // deny/redirect for protected unknown paths (Marcus's explicit decision).
  // MUST be inside the auth boundary (protected) — NOT added to isPublicPath.
  if (operatorUiEnabled) {
    const {buildOperatorRouter} = await import('./routes/operator.ts')
    app.route('/operator', buildOperatorRouter(gatewayOperatorSessionEnabled))

    // ── Static asset serving ────────────────────────────────────────────────
    // Serves public/ at /static/* — flag-gated alongside the operator route.
    // The /static/ prefix is added to isPublicPath above so unauthenticated
    // browsers can load CSS/JS assets without being 302'd to /auth/login.
    // root is relative to WORKDIR (/app) in the container, matching Dockerfile.
    app.use('/static/*', serveStatic({root: './public', rewriteRequestPath: path => path.replace(/^\/static/, '')}))
  }

  return app
}

// ---------------------------------------------------------------------------
// Snapshot provider (testable wiring helper)
// ---------------------------------------------------------------------------

/**
 * Injectable deps for `buildSnapshotProvider` — allows tests to inject fakes
 * for the app client, enumerate fn, metadata reader, and graphql fn without
 * touching the network.
 */
export interface SnapshotProviderDeps {
  readonly appId: string
  readonly privateKey: string
  /** Override the enumerate function (default: real enumerateRepos) */
  readonly enumerateFn?: typeof enumerateRepos
  /** Override the metadata reader (default: real Octokit-backed reader) */
  readonly metadataReader?: MetadataReader
  /**
   * Override the per-installation graphql query function (default: real @octokit/graphql).
   * Signature: (installationId, query, variables) => Promise<unknown>
   */
  readonly graphqlQueryFn?: (installationId: number, query: string, variables: Record<string, unknown>) => Promise<unknown>
  /**
   * Override the installation resolver (default: real App JWT endpoint).
   * Used to find the installation ID for a repo by owner/name.
   */
  readonly resolveInstallationIdForRepo?: (owner: string, name: string) => Promise<number>
}

/**
 * Build the real aggregator snapshot provider from GitHub App credentials.
 *
 * Extracted from `createDashboardServer` so tests can assert the production
 * path uses the REAL aggregator (not the empty default). Inject fakes via
 * `deps` to avoid network calls in tests.
 *
 * Returns `{ getSnapshot, start, stop }` — the same shape as the aggregator.
 */
export function buildSnapshotProvider(deps: SnapshotProviderDeps): {
  getSnapshot: () => AggregatorSnapshot
  start: () => Promise<void>
  stop: () => void
} {
  const {appId, privateKey} = deps

  const appClient = createDashboardAppClient({appId, privateKey})
  const installationsClient = buildInstallationsClient(appClient)

  /**
   * Get a cached read-only token for the given installation.
   * Routes through mintReadOnlyToken (cache + optional-scope graceful fallback).
   * server.ts MUST NOT call appClient.mintInstallationToken directly.
   */
  async function getReadOnlyToken(installationId: number): Promise<string> {
    return mintReadOnlyToken(installationId, appClient.mintInstallationToken)
  }

  /**
   * Resolve the installation ID for a repo using the App JWT endpoint
   * GET /repos/{owner}/{repo}/installation — the only App-JWT endpoint valid
   * for this purpose (App JWT IS valid here per GitHub docs).
   */
  const resolveInstallationIdForRepo =
    deps.resolveInstallationIdForRepo ??
    (async (owner: string, name: string): Promise<number> => {
      const response = await appClient.octokit.request('GET /repos/{owner}/{repo}/installation', {
        owner,
        repo: name,
      })
      const data = response.data as unknown as {id: number}
      return data.id
    })

  // Real Octokit-backed metadata reader: fetches metadata/repos.yaml from
  // fro-bot/.github at ref=data via an INSTALLATION token (not App JWT).
  // The installation is resolved via resolveInstallationIdForRepo('fro-bot', '.github').
  const metadataReader: MetadataReader =
    deps.metadataReader ??
    (async (path: string, ref: string): Promise<string> => {
      // Resolve the installation for fro-bot/.github and mint a read-only token.
      // This uses an installation token (not App JWT) — App JWT cannot read repo contents.
      const installationId = await resolveInstallationIdForRepo('fro-bot', '.github')
      const token = await getReadOnlyToken(installationId)

      const installOctokit = new Octokit({auth: token})
      const response = await installOctokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: 'fro-bot',
        repo: '.github',
        path,
        ref,
      })
      const data = response.data as unknown as {type: string; encoding: string; content: string}
      if (data.type !== 'file' || data.encoding !== 'base64') {
        throw makeNotFoundError(`${path} at ref=${ref} is not a base64-encoded file`)
      }
      // base64-decode the content (GitHub wraps at 60 chars with newlines)
      return Buffer.from(data.content.replaceAll('\n', ''), 'base64').toString('utf8')
    })

  // Real per-installation graphql query function: mints a read-only token for
  // the given installationId and authenticates the graphql client with it.
  // NO "first installation" logic — each repo uses its own installation's token.
  const graphqlQueryFn =
    deps.graphqlQueryFn ??
    (async (installationId: number, query: string, variables: Record<string, unknown>): Promise<unknown> => {
      const token = await getReadOnlyToken(installationId)
      const gql = graphql.defaults({headers: {authorization: `token ${token}`}})
      return gql(query, variables)
    })

  const aggregator = createAggregator(installationsClient, metadataReader, {
    enumerate: deps.enumerateFn ?? enumerateRepos,
    readMetadata: readRepoMetadata,
    graphqlQueryForInstallation: graphqlQueryFn,
    resolveInstallationIdForRepo,
  })

  return {
    getSnapshot: aggregator.getSnapshot,
    start: aggregator.start,
    stop: aggregator.stop,
  }
}

/** Resolved server bind address. */
export interface ServerBindConfig {
  readonly host: string
  readonly port: number
}

/**
 * Resolve the server bind host/port from the environment.
 *
 * Defaults to `0.0.0.0:3000`. The dashboard runs inside a container behind a
 * reverse proxy (Caddy) in a sibling container, so it MUST bind a non-loopback
 * address to be reachable across the Compose network — `127.0.0.1` only accepts
 * connections from inside the app's own network namespace, which makes the
 * container's own healthcheck pass while every proxied request 502s.
 *
 * Binding `0.0.0.0` does not expose the app publicly: the container only
 * publishes the port to the internal Compose network, and Caddy terminates TLS
 * and fronts auth. Override with `DASHBOARD_HOST` (e.g. `127.0.0.1` for a
 * non-containerized local run) and `DASHBOARD_PORT`.
 *
 * Extracted so the bind behavior is testable without opening a real port.
 * Throws on an invalid `DASHBOARD_PORT` (fail loud rather than bind a surprise port).
 */
export function readServerBindConfig(env: NodeJS.ProcessEnv = process.env): ServerBindConfig {
  const rawHost = env.DASHBOARD_HOST?.trim()
  const host = rawHost !== undefined && rawHost !== '' ? rawHost : '0.0.0.0'

  const rawPort = env.DASHBOARD_PORT?.trim()
  let port = 3000
  if (rawPort !== undefined && rawPort !== '') {
    const parsed = Number(rawPort)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`DASHBOARD_PORT must be an integer in 1-65535, got: ${rawPort}`)
    }
    port = parsed
  }

  return {host, port}
}

/**
 * Binds the app to `DASHBOARD_HOST:DASHBOARD_PORT` (default `0.0.0.0:3000`) via
 * @hono/node-server. Loads the cookie key asynchronously before starting.
 */
async function createDashboardServer(): Promise<ServerType> {
  const cookieKey = await loadCookieKey()

  // Wire the real GitHub data layer when credentials are present.
  // If creds are absent (dev/test context), fall back to the empty provider
  // with a clear warning — the server still boots, just serves empty data.
  let getSnapshot: (() => AggregatorSnapshot) | undefined
  let stopAggregator: (() => void) | undefined

  const appId = readOptionalSecret('DASHBOARD_GITHUB_APP_ID')
  const privateKey = readOptionalMultilineSecret('DASHBOARD_GITHUB_APP_KEY')

  if (appId !== null && privateKey !== null) {
    try {
      const provider = buildSnapshotProvider({appId, privateKey})
      await provider.start()
      getSnapshot = provider.getSnapshot
      stopAggregator = provider.stop
    } catch (error) {
      logger.warning('Failed to start GitHub aggregator; serving empty snapshot', {
        error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      })
    }
  } else {
    logger.warning(
      'DASHBOARD_GITHUB_APP_ID or DASHBOARD_GITHUB_APP_KEY not set — GitHub data layer disabled; serving empty snapshot',
    )
  }

  const app = await buildDashboardApp({cookieKey, getSnapshot})

  const {host, port} = readServerBindConfig()
  const server = serve(
    {
      fetch: app.fetch,
      hostname: host,
      port,
    },
    info => {
      console.warn(`Dashboard listening on http://${info.address}:${info.port}`)
    },
  )

  // Attach stop handler for graceful shutdown
  if (stopAggregator !== undefined) {
    const stop = stopAggregator
    server.addListener('close', () => {
      stop()
    })
  }

  return server
}

// Only start the server when this module is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  createDashboardServer().catch((error: unknown) => {
    logger.error('Failed to start dashboard server', {
      error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    })
    process.exit(1)
  })
}

export {buildDashboardApp, createDashboardServer}
