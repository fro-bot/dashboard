/**
 * Dashboard app factory + server binding.
 *
 * `buildDashboardApp(opts?)` — constructs the Hono app with all middleware and routes.
 * Accepts an optional config object for testability (inject fake OAuth client,
 * cookie key, operator login). When called with no args, reads from env.
 *
 * `createDashboardServer()` — binds the app to 127.0.0.1:3000.
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
import {Buffer} from 'node:buffer'
import process from 'node:process'
import {serve} from '@hono/node-server'
import {Hono} from 'hono'
import {getCookie} from 'hono/cookie'
import {fetchGitHubUserLogin, makeGitHubOAuthClient} from './auth/oauth.ts'
import {logger} from './logger.ts'
import {api} from './routes/api.ts'
import {buildAuthRouter} from './routes/auth.ts'
import {loadCookieKey, SessionManager} from './session.ts'

/** Per-IP rate limiter state */
interface RateLimitEntry {
  count: number
  windowStart: number
}

/** Simple fixed-window in-memory rate limiter */
const rateLimitMap = new Map<string, RateLimitEntry>()
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX = 60 // requests per window per IP

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
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
   * If undefined, uses a zero-filled 32-byte placeholder (production must use loadCookieKey).
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
}

/**
 * Constructs the Hono app with all middleware and routes mounted.
 * Separated from port binding so tests can call app.request() without a live server.
 *
 * Throws at construction time if:
 * - `operatorLogin` is whitespace-only or empty (fail-closed)
 * - `cookieKey` is <32 bytes (fail-closed)
 */
function buildDashboardApp(opts?: DashboardAppConfig): Hono {
  // Resolve operator login (fail-closed)
  const rawOperatorLogin = opts?.operatorLogin ?? process.env.DASHBOARD_OPERATOR_LOGIN
  if (typeof rawOperatorLogin === 'string' && rawOperatorLogin.trim() === '') {
    throw new Error('DASHBOARD_OPERATOR_LOGIN must not be whitespace-only (fail-closed)')
  }
  const operatorLogin = typeof rawOperatorLogin === 'string' ? rawOperatorLogin.trim() : undefined

  // Resolve cookie key — SessionManager validates key length (throws if <32 bytes)
  const cookieKey = opts?.cookieKey ?? Buffer.alloc(32)
  const sessionManager = new SessionManager(cookieKey)

  // Resolve OAuth client
  const oauthClient =
    opts?.oauthClient ??
    makeGitHubOAuthClient(
      process.env.DASHBOARD_OAUTH_CLIENT_ID ?? '',
      process.env.DASHBOARD_OAUTH_CLIENT_SECRET ?? '',
      process.env.DASHBOARD_OAUTH_REDIRECT_URI ?? 'http://localhost:3000/auth/callback',
    )

  const fetchUserLogin = opts?.fetchUserLogin ?? fetchGitHubUserLogin

  const app = new Hono()

  // ── Rate limiting middleware (applied to sensitive routes) ──────────────────
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    const sensitiveRoutes = ['/', '/auth/callback']
    const isSensitive = sensitiveRoutes.includes(path) || path.startsWith('/api/')

    if (isSensitive) {
      const forwarded = c.req.header('x-forwarded-for')
      const realIp = c.req.header('x-real-ip')
      let ip: string
      if (typeof forwarded === 'string') {
        ip = forwarded.split(',')[0]?.trim() ?? 'unknown'
      } else if (typeof realIp === 'string') {
        ip = realIp
      } else {
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

  app.use('*', async (c, next) => {
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
    const cookieValue = getCookie(c as unknown as Parameters<typeof getCookie>[0], 'session')
    if (typeof cookieValue !== 'string' || cookieValue.length === 0) {
      return c.redirect('/auth/login', 302)
    }

    const session = sessionManager.verify(cookieValue)
    if (session === null) {
      return c.redirect('/auth/login', 302)
    }

    // Attach session to context for downstream handlers
    c.set('sessionLogin' as never, session.login as never)
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
      sessionManager,
      oauthClient,
      fetchUserLogin,
    })
    app.route('/auth', authRouter)
  }

  // ── API routes ───────────────────────────────────────────────────────────────
  app.route('/api', api)

  return app
}

/**
 * Binds the app to 127.0.0.1:3000 via @hono/node-server.
 * Loads the cookie key asynchronously before starting.
 */
async function createDashboardServer(): Promise<ServerType> {
  const cookieKey = await loadCookieKey()
  const app = buildDashboardApp({cookieKey})

  const server = serve(
    {
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: 3000,
    },
    info => {
      console.warn(`Dashboard listening on http://${info.address}:${info.port}`)
    },
  )

  return server
}

// Only start the server when this module is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  createDashboardServer().catch((error: unknown) => {
    console.error('Failed to start dashboard server:', error)
    process.exit(1)
  })
}

export {buildDashboardApp, createDashboardServer}
