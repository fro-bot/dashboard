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
import {existsSync} from 'node:fs'
import process from 'node:process'
import {serve} from '@hono/node-server'
import {getConnInfo} from '@hono/node-server/conninfo'
import {serveStatic} from '@hono/node-server/serve-static'
import {Octokit} from '@octokit/core'
import {graphql} from '@octokit/graphql'
import {Hono, type Context} from 'hono'
import {getCookie, setCookie} from 'hono/cookie'
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

/**
 * Reset the rate limiter state. Tests only — prevents bleed between test cases.
 * @internal
 */
export function resetRateLimitForTesting(): void {
  rateLimitMap.clear()
  rateLimitCallCount = 0
}

// Gateway operator-session mode: unauthenticated/invalid requests must recover through
// the GATEWAY operator login (which mints the __Host-session the gateway requires),
// never the dashboard's Arctic flow (which mints a `session` cookie the gateway
// rejects, causing a re-auth loop on gateway restart — see issue #70).
// return_to=/ is a fixed same-origin literal — no request-derived component, no open redirect.
const GATEWAY_LOGIN_REDIRECT = '/operator/auth/github/start?return_to=/'

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
 * All fields optional — production reads from env; tests inject fakes.
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
   * Aggregator snapshot provider. Both the SPA monitoring view and /api/status
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
   * When false, /operator is not mounted — zero operator objects are constructed.
   */
  operatorUiEnabled?: boolean | undefined
  /**
   * Whether to use the gateway operator session for auth instead of Arctic.
   * If undefined, reads from DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED env (default: false).
   * Independent of operatorUiEnabled.
   */
  gatewayOperatorSessionEnabled?: boolean | undefined
  /**
   * Injectable OperatorClient for the gateway auth branch.
   * If undefined, a real client is built per-request from the server-side fetch adapter.
   * Never constructed when gatewayOperatorSessionEnabled is false.
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
   * Only used when operatorClient is undefined. Ignored when operatorClient is injected.
   */
  gatewayFetchImpl?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined
  /**
   * DEV-ONLY auto-login bypass. Skips OAuth and mints a real signed session for
   * the configured operatorLogin (Arctic branch only).
   *
   * SECURITY INVARIANTS (load-bearing):
   * - THROWS at startup if NODE_ENV === 'production' (fail loud, never silent).
   * - ENV-driven path (DASHBOARD_DEV_AUTOLOGIN) ALSO throws if DASHBOARD_HOST is
   *   not a loopback address (127.0.0.1/localhost/::1). Default host 0.0.0.0 fails.
   * - NEVER mints a session when operatorLogin is undefined.
   * - Only active in the Arctic branch (not gateway-session mode).
   *
   * If undefined, reads from DASHBOARD_DEV_AUTOLOGIN env. Default: OFF.
   */
  devAutoLogin?: boolean | undefined
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
  // When operatorLogin is unset (deny-all mode), no SessionManager is needed.
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

  // Resolve snapshot provider — default empty; production wires the real aggregator.
  const EMPTY_SNAPSHOT = {repos: [], staleBanner: false, driftCount: 0, refreshedAt: null} as const
  const getSnapshot = opts?.getSnapshot ?? (() => EMPTY_SNAPSHOT)

  // Resolve operator UI flag — default OFF (fail-closed).
  const operatorUiEnabled =
    opts?.operatorUiEnabled === undefined ? readOperatorUiConfig().enabled : opts.operatorUiEnabled

  // Resolve gateway operator session flag — default OFF (fail-closed).
  const gatewayOperatorSessionEnabled =
    opts?.gatewayOperatorSessionEnabled === undefined
      ? readGatewayOperatorSessionConfig().enabled
      : opts.gatewayOperatorSessionEnabled

  // Resolve devAutoLogin — DEV-ONLY auth bypass. Default OFF (fail-closed).
  //
  // SECURITY: Two independent guards must BOTH pass for the bypass to be effective.
  // If requested but either guard fails, THROW at startup (fail loud, never silent).
  //
  // Guard A — NODE_ENV must NOT be 'production' (applies to both paths).
  // Guard B — DASHBOARD_HOST must be a loopback address (ENV-driven path only).
  //   The injected opts.devAutoLogin path (test seam) bypasses the host check
  //   but still honors Guard A.
  const devAutoLoginRequested: boolean =
    opts?.devAutoLogin === undefined
      ? process.env.DASHBOARD_DEV_AUTOLOGIN?.trim().toLowerCase() === 'true'
      : opts.devAutoLogin

  const isEnvDrivenPath = opts?.devAutoLogin === undefined

  if (devAutoLoginRequested) {
    // Guard A: NODE_ENV production check
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'DASHBOARD_DEV_AUTOLOGIN refused: requires NODE_ENV!=production and DASHBOARD_HOST=127.0.0.1/localhost/::1 (dev-only auth bypass must never run in production)',
      )
    }

    // Guard B: loopback bind host check (ENV-driven path only)
    if (isEnvDrivenPath) {
      const configuredHost = process.env.DASHBOARD_HOST?.trim()
      if (!isLoopbackBindHost(configuredHost)) {
        throw new Error(
          'DASHBOARD_DEV_AUTOLOGIN refused: requires NODE_ENV!=production and DASHBOARD_HOST=127.0.0.1/localhost/::1 (dev-only auth bypass must never run in production)',
        )
      }
    }
  }

  const devAutoLogin = devAutoLoginRequested

  if (devAutoLogin) {
    logger.warning('DEV AUTO-LOGIN ENABLED — auth is bypassed; never use in production')
  }

  // Resolve the trusted gateway operator origin — SECURITY CRITICAL.
  // Must be a configured, trusted value; never derived from the inbound request Host.
  // null means the configured value is invalid → fail closed at middleware time.
  let resolvedGatewayOrigin: string | null = null
  if (gatewayOperatorSessionEnabled) {
    if (opts?.gatewayOperatorOrigin === undefined) {
      resolvedGatewayOrigin = readGatewayOperatorOrigin()
    } else {
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

  // ── PWA service worker CSP bypass (registered BEFORE secureHeaders) ──────────
  // Must be registered before secureHeaders (which runs post-next()) so this
  // middleware wraps it and can delete the CSP after secureHeaders sets it.
  // Workers do not inherit the page CSP; a too-restrictive CSP can block Workbox.
  app.use('/sw.js', async (c, next) => {
    await next()
    c.res.headers.delete('content-security-policy')
    // No-cache so the browser re-fetches on every load and detects SW updates.
    c.res.headers.set('cache-control', 'no-cache, no-store, must-revalidate')
  })

  // ── Security headers + CSP (applied to all responses) ──────────────────────
  // style-src allows 'unsafe-inline' because SSR pages use inline style attributes.
  // script-src stays strict ('self', no inline) — inline script is the XSS vector.
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  )

  // ── Rate limiting middleware (defense-in-depth; real limiting belongs at Caddy) ──
  // Keyed on the direct connection remote address, not X-Forwarded-For (client-spoofable).
  app.use('*', async (c: Context, next) => {
    const path = new URL(c.req.url).pathname
    const sensitiveRoutes = ['/', '/auth/login', '/auth/callback', '/operator']
    const isSensitive = sensitiveRoutes.includes(path) || path.startsWith('/api/') || path.startsWith('/operator/')

    if (isSensitive) {
      // getConnInfo throws in test context (app.request()); fall back to 'unknown'.
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
  // Public routes: /api/healthz, /auth/*, SPA static assets (see isPublicPath).
  // Every other route requires a valid operator session.
  // When operatorLogin is unset, the app fails closed: every protected route is
  // denied (401) and no session can ever be issued.
  //
  // Strategy branch: the flag selects exactly ONE branch. The two branches never
  // union and never fall back to each other. Each branch runs its OWN isPublicPath
  // check — a path added to one mode's allowlist cannot silently bypass the other.
  const isPublicPath = (path: string): boolean =>
    path === '/api/healthz' ||
    path === '/auth/login' ||
    path === '/auth/callback' ||
    path === '/auth/logout' ||
    // SPA static assets — public pre-auth so the PWA shell loads before the auth
    // redirect. JS/CSS/manifest/icons carry no sensitive data.
    path.startsWith('/assets/') ||
    path === '/manifest.webmanifest' ||
    path.startsWith('/icon-') ||
    path === '/sw.js' ||
    path === '/registerSW.js' ||
    (operatorUiEnabled && path.startsWith('/static/'))

  app.use('*', async (c: Context, next) => {
    const path = new URL(c.req.url).pathname

    if (gatewayOperatorSessionEnabled) {
      // ── GATEWAY BRANCH ────────────────────────────────────────────────────
      if (isPublicPath(path)) {
        return next()
      }

      // Require an inbound cookie to forward as the end-user principal.
      const inboundCookie = c.req.header('cookie')
      if (inboundCookie === undefined || inboundCookie.trim() === '') {
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }

      // Fail closed if the configured gateway origin is invalid or unparseable.
      if (resolvedGatewayOrigin === null) {
        logger.warning('gateway-auth: configured gateway origin is invalid or missing', {path})
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }

      // Build the OperatorClient: use injected client (tests) or build per-request (production).
      // SECURITY: origin is always resolvedGatewayOrigin (configured), never from the request Host.
      let client: OperatorClient
      if (opts?.operatorClient === undefined) {
        const serverFetch = createOperatorServerFetch({
          origin: resolvedGatewayOrigin,
          cookie: inboundCookie,
          fetchImpl: opts?.gatewayFetchImpl,
        })
        // No-op SSE stub — getCurrentSession does not use SSE; throws if called.
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
      // Log only the path — never the cookie value or error detail (may contain identity info).
      const result = await client.getCurrentSession()
      if (!isOk(result)) {
        logger.warning('gateway-auth: session validation failed', {path})
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }

      // Expired-session defense — even on a 2xx, a non-future expiresAt → deny.
      if (result.data.expiresAt <= Date.now()) {
        logger.warning('gateway-auth: session expired', {path})
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }

      // Nonsensical identity defense — non-positive operatorId or blank login → deny.
      if (result.data.operatorId <= 0) {
        logger.warning('gateway-auth: session has non-positive operatorId', {path})
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }
      if (result.data.login.trim() === '') {
        logger.warning('gateway-auth: session has empty login', {path})
        return c.redirect(GATEWAY_LOGIN_REDIRECT, 302)
      }

      // Valid gateway session: attach to context.
      c.set('gatewaySession', result.data)
      return next()
    } else {
      // ── ARCTIC BRANCH ────────────────────────────────────────────────────
      if (isPublicPath(path)) {
        return next()
      }

      // Fail closed: with no configured operator, no protected route is served.
      if (operatorLogin === undefined) {
        return c.text('Unauthorized', 401)
      }

      const cookieValue = getCookie(c, 'session')
      const sm = sessionManager as SessionManager

      const session =
        typeof cookieValue === 'string' && cookieValue.length > 0 ? sm.verify(cookieValue) : null

      // Reject sessions minted for a different operator login (stale session guard).
      const validSession = session !== null && session.login === operatorLogin ? session : null

      if (validSession === null) {
        if (devAutoLogin) {
          const sessionValue = sm.sign(operatorLogin)
          // secure:false — dev-only path runs over http://localhost; a Secure cookie
          // would be dropped by the browser. Production /auth/callback still sets Secure.
          setCookie(c, 'session', sessionValue, {
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
            maxAge: 24 * 60 * 60,
            path: '/',
          })
          c.set('sessionLogin', operatorLogin)
          return next()
        }

        return c.redirect('/auth/login', 302)
      }

      c.set('sessionLogin', validSession.login)
      return next()
    }
  })

  if (gatewayOperatorSessionEnabled) {
    // Gateway mode: /auth/login → gateway operator login. Do NOT mount /auth/callback
    // or any Arctic path — the dashboard session-minting flow must not be reachable
    // (a dashboard `session` cookie cannot satisfy the gateway; see issue #70).
    const gatewayAuthRouter = new Hono()
    gatewayAuthRouter.get('/login', c => c.redirect(GATEWAY_LOGIN_REDIRECT, 302))
    app.route('/auth', gatewayAuthRouter)
  } else if (operatorLogin === undefined) {
    // Fail-closed: no operator login → deny all auth routes; no session can be minted.
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
  app.route('/api', buildApiRouter(getSnapshot))

  // Serve the React SPA at /. index.html requires a session; shell assets are public.
  app.get('/', serveStatic({root: './web/dist', path: 'index.html'}))

  // ── /operator → / redirect (unconditional, flag-independent) ────────────────
  // / is the canonical operator launch route. Old /operator links redirect here.
  // Mounted before the operatorUiEnabled-gated handler so the flag has no effect.
  app.get('/operator', c => c.redirect('/', 302))

  // ── Operator UI skeleton route ────────────────────────────────────────────────
  // Only mounted when operatorUiEnabled is true (default: false).
  if (operatorUiEnabled) {
    const {buildOperatorRouter} = await import('./routes/operator.ts')
    app.route('/operator', buildOperatorRouter(gatewayOperatorSessionEnabled))

    // Serves public/ at /static/* — flag-gated alongside the operator route.
    // /static/ is in isPublicPath so unauthenticated browsers can load assets.
    app.use('/static/*', serveStatic({root: './public', rewriteRequestPath: path => path.replace(/^\/static/, '')}))
  }

  // ── SPA static asset serving ─────────────────────────────────────────────
  app.use('/assets/*', serveStatic({root: './web/dist'}))
  app.use('/icon-*', serveStatic({root: './web/dist'}))

  // ── PWA manifest ─────────────────────────────────────────────────────────
  // serveStatic serves .webmanifest as application/octet-stream by default.
  // This middleware must be registered BEFORE serveStatic to override Content-Type.
  // application/manifest+json is required for PWA installability.
  app.use('/manifest.webmanifest', async (c, next) => {
    await next()
    c.res.headers.set('content-type', 'application/manifest+json; charset=UTF-8')
  })
  app.use('/manifest.webmanifest', serveStatic({root: './web/dist'}))

  // ── PWA service worker + registration helper ──────────────────────────────
  // /sw.js and /registerSW.js must be served at root scope so the SW covers the
  // entire origin. CSP is removed from /sw.js by the pre-secureHeaders middleware.
  app.use('/sw.js', serveStatic({root: './web/dist'}))

  app.use('/registerSW.js', async (c, next) => {
    await next()
    c.res.headers.set('cache-control', 'no-cache, no-store, must-revalidate')
  })
  app.use('/registerSW.js', serveStatic({root: './web/dist'}))

  // Warn early if the SPA build artifact is missing (GET / will 404 silently).
  if (!existsSync('./web/dist/index.html')) {
    logger.warning(
      'web/dist/index.html not found — GET / will return 404. Run `pnpm build:web` to build the SPA.',
    )
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

/**
 * Returns true if the given bind host is a loopback address.
 * Accepts '127.0.0.1', 'localhost', and '::1'.
 * undefined or any other value (including '0.0.0.0') returns false.
 *
 * Used by the devAutoLogin guard: the ENV-driven bypass requires an explicit
 * loopback bind host so it cannot engage on a network-accessible address.
 */
export function isLoopbackBindHost(host: string | undefined): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
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
 *
 * Non-blocking startup: the server begins listening immediately after the cookie
 * key is loaded. The first aggregation refresh runs in the background — the
 * snapshot provider returns an empty snapshot until the first refresh completes,
 * and the UI handles the empty/loading state. This means the server is ready to
 * serve requests (including /api/healthz) within ~1-2s, not 15-20s.
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

  let provider: ReturnType<typeof buildSnapshotProvider> | undefined

  if (appId !== null && privateKey !== null) {
    // Construct the provider synchronously — no network calls yet.
    // start() (which triggers the first refresh) runs in the background after
    // the server is already listening.
    provider = buildSnapshotProvider({appId, privateKey})
    getSnapshot = provider.getSnapshot
    stopAggregator = provider.stop
  } else {
    logger.warning(
      'DASHBOARD_GITHUB_APP_ID or DASHBOARD_GITHUB_APP_KEY not set — GitHub data layer disabled; serving empty snapshot',
    )
  }

  const app = await buildDashboardApp({cookieKey, getSnapshot})

  const {host, port} = readServerBindConfig()

  // Bind and listen FIRST — the server is immediately ready to serve requests.
  // The snapshot provider returns an empty snapshot until the first refresh
  // completes; the UI handles the loading state gracefully.
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

  // Kick the first aggregation refresh in the background — does NOT block the
  // server from accepting requests. Failures are logged but do NOT crash the
  // server; the interval set by start() will retry on the next cycle.
  if (provider !== undefined) {
    const p = provider
    p.start().catch((error: unknown) => {
      logger.warning('Failed to start GitHub aggregator; serving empty snapshot until next retry', {
        error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      })
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
