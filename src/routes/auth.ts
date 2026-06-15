/**
 * GitHub OAuth routes: /auth/login, /auth/callback, /auth/logout.
 *
 * Security invariants:
 * - State cookie is HttpOnly, Secure, SameSite=Lax, short-TTL (~10 min).
 * - State mismatch → 403 (CSRF protection).
 * - Non-allowlisted login → 403, no session issued.
 * - Session cookie is HttpOnly, Secure, SameSite=Lax, 24h TTL.
 * - Operator login check is case-sensitive exact match.
 */
import type {GitHubOAuthClient} from '../auth/oauth.ts'
import type {SessionManager} from '../session.ts'
import {randomBytes} from 'node:crypto'
import {Hono} from 'hono'
import {deleteCookie, getCookie, setCookie} from 'hono/cookie'
import {logger} from '../logger.ts'

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
}

/**
 * Builds the auth router with the given config.
 * Mounted at `/auth` in the main app.
 */
export function buildAuthRouter(config: AuthRouteConfig): Hono {
  const {operatorLogin, sessionManager, oauthClient, fetchUserLogin} = config
  const router = new Hono()

  /**
   * GET /auth/login
   * Generates OAuth state, stores it in a short-TTL HttpOnly cookie, redirects to GitHub.
   */
  router.get('/login', c => {
    const state = randomBytes(16).toString('hex')

    // Store state in a short-TTL HttpOnly cookie.
    // CSRF check compares query param state vs cookie state (exact match).
    setCookie(c, STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: STATE_COOKIE_MAX_AGE,
      path: '/',
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
    deleteCookie(c, STATE_COOKIE_NAME, {path: '/'})

    // Exchange code for access token
    let accessToken: string
    try {
      const tokens = await oauthClient.validateAuthorizationCode(code)
      accessToken = tokens.accessToken()
    } catch (error) {
      logger.error('OAuth callback: token exchange failed', {error: String(error)})
      return c.text('Authentication failed', 401)
    }

    // Fetch GitHub user login
    let login: string
    try {
      login = await fetchUserLogin(accessToken)
    } catch (error) {
      logger.error('OAuth callback: failed to fetch user login', {error: String(error)})
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
   * Clears the session cookie and redirects to /auth/login.
   */
  router.post('/logout', c => {
    deleteCookie(c, SESSION_COOKIE_NAME, {path: '/'})
    return c.redirect('/auth/login', 302)
  })

  return router
}
