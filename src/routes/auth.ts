/**
 * GitHub OAuth routes: /auth/login, /auth/callback, /auth/logout.
 *
 * Security invariants:
 * - State cookie is HttpOnly, Secure, SameSite=Lax, short-TTL (~10 min), path=/auth.
 * - State mismatch → 403 (CSRF protection).
 * - Non-allowlisted login → 403, no session issued.
 * - Session cookie is HttpOnly, Secure, SameSite=Lax, 24h TTL.
 * - Operator login check is case-sensitive exact match.
 * - Logout requires a valid CSRF token (HMAC-derived, double-submit pattern).
 *   Token = HMAC-SHA256(cookieKey, login + ':logout:' + window) truncated to 32 hex chars,
 *   where window = floor(now / CSRF_WINDOW_MS). Binding to the time window means a leaked
 *   token expires after at most 2 windows (~2 hours). Verified with timingSafeEqual.
 */
import type {GitHubOAuthClient} from '../auth/oauth.ts'
import type {SessionManager} from '../session.ts'
import {Buffer} from 'node:buffer'
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto'
import {Hono} from 'hono'
import {deleteCookie, getCookie, setCookie} from 'hono/cookie'
import {logger, sanitizeErrorMessage} from '../logger.ts'

/** State cookie TTL: 10 minutes */
const STATE_COOKIE_MAX_AGE = 10 * 60

/** Name of the OAuth state cookie */
const STATE_COOKIE_NAME = 'oauth_state'

/** Name of the session cookie */
const SESSION_COOKIE_NAME = 'session'

export interface AuthRouteConfig {
  /** Exact GitHub login that is allowed to authenticate. */
  readonly operatorLogin: string
  /** Session manager for signing/verifying session cookies. */
  readonly sessionManager: SessionManager
  /** GitHub OAuth client (Arctic or fake for tests). */
  readonly oauthClient: GitHubOAuthClient
  /** Fetches the GitHub login for an access token. Injected for testability. */
  readonly fetchUserLogin: (accessToken: string) => Promise<string>
  /** Cookie signing key — used to derive the logout CSRF token. */
  readonly cookieKey: Buffer
}

/** CSRF token validity window (ms). A leaked logout token expires after at most 2 windows. */
const CSRF_WINDOW_MS = 60 * 60 * 1000

/**
 * Derives the logout CSRF token for a given login, bound to a coarse time window.
 * Token = first 32 hex chars of HMAC-SHA256(cookieKey, login + ':logout:' + window).
 * Binding to the login makes it operator-specific; binding to the time window means
 * a leaked token stops working after at most 2 windows (defeats permanent replay).
 */
export function deriveLogoutCsrfToken(cookieKey: Buffer, login: string, now: number = Date.now()): string {
  const window = Math.floor(now / CSRF_WINDOW_MS)
  return createHmac('sha256', cookieKey).update(`${login}:logout:${window}`).digest('hex').slice(0, 32)
}

/**
 * Builds the auth router with the given config.
 * Mounted at `/auth` in the main app.
 */
export function buildAuthRouter(config: AuthRouteConfig): Hono {
  const {operatorLogin, sessionManager, oauthClient, fetchUserLogin, cookieKey} = config
  const router = new Hono()

  /**
   * GET /auth/login
   * Generates OAuth state, stores it in a short-TTL HttpOnly cookie, redirects to GitHub.
   */
  router.get('/login', c => {
    const state = randomBytes(16).toString('hex')

    // Store state in a short-TTL HttpOnly cookie scoped to /auth (only read on /auth/callback).
    // CSRF check compares query param state vs cookie state (exact match).
    setCookie(c, STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: STATE_COOKIE_MAX_AGE,
      path: '/auth',
    })

    const authURL = oauthClient.createAuthorizationURL(state, ['read:user'])
    return c.redirect(authURL.toString(), 302)
  })

  /**
   * GET /auth/callback
   * Validates state (CSRF), exchanges code for token, checks operator allowlist,
   * issues session cookie.
   */
  router.get('/callback', async c => {
    const code = c.req.query('code')
    const stateParam = c.req.query('state')
    const stateCookie = getCookie(c, STATE_COOKIE_NAME)

    // Validate required params
    if (typeof code !== 'string' || code.length === 0) {
      logger.warning('OAuth callback: missing code parameter')
      return c.text('Bad Request: missing code', 400)
    }

    // CSRF: state must be present in both cookie and query, and must match
    if (
      typeof stateParam !== 'string' ||
      stateParam.length === 0 ||
      typeof stateCookie !== 'string' ||
      stateCookie.length === 0 ||
      stateParam !== stateCookie
    ) {
      logger.warning('OAuth callback: state mismatch (CSRF attempt or stale session)')
      return c.text('Forbidden: state mismatch', 403)
    }

    // Clear the state cookie immediately (one-time use)
    deleteCookie(c, STATE_COOKIE_NAME, {path: '/auth'})

    // Exchange code for access token
    let accessToken: string
    try {
      const tokens = await oauthClient.validateAuthorizationCode(code)
      accessToken = tokens.accessToken()
    } catch (error) {
      logger.error('OAuth callback: token exchange failed', {error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error))})
      return c.text('Authentication failed', 401)
    }

    // Fetch GitHub user login
    let login: string
    try {
      login = await fetchUserLogin(accessToken)
    } catch (error) {
      logger.error('OAuth callback: failed to fetch user login', {error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error))})
      return c.text('Authentication failed', 401)
    }

    // Operator allowlist check (exact, case-sensitive)
    if (login !== operatorLogin) {
      logger.warning('OAuth callback: login not in allowlist', {login})
      return c.text('Forbidden: not authorized', 403)
    }

    // Issue session cookie
    const sessionValue = sessionManager.sign(login)
    setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 24 * 60 * 60,
      path: '/',
    })

    logger.info('OAuth callback: session issued', {login})
    return c.redirect('/', 302)
  })

  /**
   * GET /auth/logout-csrf
   * Returns the CSRF token for the logout form POST. Requires a valid session.
   * The SPA fetches this token before submitting the logout form.
   *
   * The token is HMAC-derived (cookieKey + operatorLogin + time window) and
   * expires after at most 2 windows (~2 hours). It is safe to expose to the
   * authenticated operator — an attacker without the session cookie cannot
   * obtain it (the route is behind the auth middleware).
   */
  router.get('/logout-csrf', c => {
    const token = deriveLogoutCsrfToken(cookieKey, operatorLogin)
    return c.json({csrfToken: token})
  })

  /**
   * POST /auth/logout
   * Validates the CSRF token (derived from cookieKey + operatorLogin), clears the
   * session cookie, and redirects to /auth/login.
   *
   * CSRF design: double-submit pattern using an HMAC-derived token.
   * The dashboard renders the token as a hidden form field; on POST we recompute
   * and compare with timingSafeEqual. This binds logout to the operator's session
   * and blocks cross-site POST (the attacker cannot know the HMAC value).
   *
   * Rejects with 403 on missing or mismatched CSRF token.
   */
  router.post('/logout', async c => {
    const formData = await c.req.formData()
    const submittedToken = formData.get('csrf_token')

    if (typeof submittedToken !== 'string' || submittedToken.length === 0) {
      logger.warning('Logout: missing CSRF token')
      return c.text('Forbidden: missing CSRF token', 403)
    }

    // Accept the current OR previous time window so a token rendered just before a
    // window boundary still validates on submit. A leaked token expires within 2 windows.
    const now = Date.now()
    const submittedBuf = Buffer.from(submittedToken, 'utf8')
    const candidates = [
      deriveLogoutCsrfToken(cookieKey, operatorLogin, now),
      deriveLogoutCsrfToken(cookieKey, operatorLogin, now - CSRF_WINDOW_MS),
    ]
    const matched = candidates.some(expected => {
      const expectedBuf = Buffer.from(expected, 'utf8')
      return submittedBuf.length === expectedBuf.length && timingSafeEqual(submittedBuf, expectedBuf)
    })

    if (!matched) {
      logger.warning('Logout: CSRF token mismatch')
      return c.text('Forbidden: invalid CSRF token', 403)
    }

    deleteCookie(c, SESSION_COOKIE_NAME, {path: '/'})
    return c.redirect('/auth/login', 302)
  })

  return router
}
