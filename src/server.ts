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
import type {AggregatorSnapshot} from './github/aggregator.ts'
import type {MetadataReader} from './github/metadata.ts'
import {Buffer} from 'node:buffer'
import process from 'node:process'
import {serve} from '@hono/node-server'
import {getConnInfo} from '@hono/node-server/conninfo'
import {Octokit} from '@octokit/core'
import {graphql} from '@octokit/graphql'
import {Hono, type Context} from 'hono'
import {getCookie} from 'hono/cookie'
import {fetchGitHubUserLogin, makeGitHubOAuthClient} from './auth/oauth.ts'
import {readOperatorUiConfig} from './gateway/operator-config.ts'
import {createAggregator} from './github/aggregator.ts'
import {createDashboardAppClient} from './github/app-client.ts'
import {buildInstallationsClient, enumerateRepos, mintReadOnlyToken} from './github/installations.ts'
import {makeNotFoundError, readRepoMetadata} from './github/metadata.ts'
import {logger, sanitizeErrorMessage} from './logger.ts'
import {buildApiRouter} from './routes/api.ts'
import {buildAuthRouter} from './routes/auth.ts'
import {buildDashboardRouter} from './routes/dashboard.ts'
import {buildOperatorRouter} from './routes/operator.ts'
import {readOptionalMultilineSecret, readOptionalSecret} from './secrets.ts'
import {loadCookieKey, SessionManager} from './session.ts'

/** Hono context variables set by auth middleware */
interface Variables {
  sessionLogin: string
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
function buildDashboardApp(opts?: DashboardAppConfig): Hono<{Variables: Variables}> {
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

  const app = new Hono<{Variables: Variables}>()

  // ── Rate limiting middleware (applied to sensitive routes) ──────────────────
  // NOTE: Real per-client rate limiting belongs at Caddy (the reverse proxy).
  // This is defense-in-depth only. We key on the direct connection remote address
  // (not X-Forwarded-For) because the app only sees loopback connections from Caddy
  // and XFF is client-controlled — trusting it would allow spoofing the throttle key.
  app.use('*', async (c: Context, next) => {
    const path = new URL(c.req.url).pathname
    const sensitiveRoutes = ['/', '/auth/login', '/auth/callback']
    const isSensitive = sensitiveRoutes.includes(path) || path.startsWith('/api/')

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
  const isPublicPath = (path: string): boolean =>
    path === '/api/healthz' || path === '/auth/login' || path === '/auth/callback' || path === '/auth/logout'

  app.use('*', async (c: Context, next) => {
    const path = new URL(c.req.url).pathname

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
  })

  if (operatorLogin === undefined) {
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
    }),
  )

  // ── Operator UI skeleton route ────────────────────────────────────────────────
  // Only mounted when operatorUiEnabled is true (default: false).
  // When disabled, /operator is NOT mounted — zero operator objects are constructed.
  // The route falls through to the auth middleware which returns the standard
  // deny/redirect for protected unknown paths (Marcus's explicit decision).
  // MUST be inside the auth boundary (protected) — NOT added to isPublicPath.
  if (operatorUiEnabled) {
    app.route('/operator', buildOperatorRouter())
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

  const app = buildDashboardApp({cookieKey, getSnapshot})

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
