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
 *   Token = HMAC-SHA256(cookieKey, login + ':logout') truncated to 32 hex chars.
 *   Verified with timingSafeEqual to prevent timing attacks.
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

/**
 * Derives the logout CSRF token for a given login.
 * Token = first 32 hex chars of HMAC-SHA256(cookieKey, login + ':logout').
 * Binding to the login ensures the token is session-specific.
 */
export function deriveLogoutCsrfToken(cookieKey: Buffer, login: string): string {
  return createHmac('sha256', cookieKey).update(`${login}:logout`).digest('hex').slice(0, 32)
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

    const expectedToken = deriveLogoutCsrfToken(cookieKey, operatorLogin)

    // Constant-time comparison to prevent timing attacks
    const submittedBuf = Buffer.from(submittedToken, 'utf8')
    const expectedBuf = Buffer.from(expectedToken, 'utf8')

    if (submittedBuf.length !== expectedBuf.length || !timingSafeEqual(submittedBuf, expectedBuf)) {
      logger.warning('Logout: CSRF token mismatch')
      return c.text('Forbidden: invalid CSRF token', 403)
    }

    deleteCookie(c, SESSION_COOKIE_NAME, {path: '/'})
    return c.redirect('/auth/login', 302)
  })

  return router
}
