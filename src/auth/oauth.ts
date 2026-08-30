/**
 * GitHub OAuth client abstraction.
 *
 * The `GitHubOAuthClient` interface is the seam — tests inject a fake,
 * production uses direct GitHub OAuth calls from `makeGitHubOAuthClient()`.
 *
 * Security: tokens are never logged (redactSensitiveFields covers 'token'
 * and 'access_token' patterns). The operator allowlist check lives in the
 * route handler, not here.
 */
import {Buffer} from 'node:buffer'

const GITHUB_OAUTH_ERROR_CODES = new Set([
  'access_denied',
  'bad_verification_code',
  'incorrect_client_credentials',
  'invalid_client',
  'invalid_grant',
  'invalid_request',
  'redirect_uri_mismatch',
  'unsupported_grant_type',
  'unverified_user_email',
])

const GITHUB_FETCH_TIMEOUT_MS = 10_000

/**
 * Minimal interface for the GitHub OAuth client.
 * Uses function property style (not shorthand method signatures) per lint rules.
 */
export interface GitHubOAuthClient {
  readonly createAuthorizationURL: (state: string, scopes: string[]) => URL
  readonly validateAuthorizationCode: (code: string) => Promise<{accessToken: () => string}>
}

/**
 * Creates a production GitHub OAuth client using GitHub's documented OAuth endpoints.
 *
 * @param clientId - `DASHBOARD_OAUTH_CLIENT_ID`
 * @param clientSecret - `DASHBOARD_OAUTH_CLIENT_SECRET`
 * @param redirectURI - Full callback URL (e.g. `https://example.com/auth/callback`)
 */
export function makeGitHubOAuthClient(
  clientId: string,
  clientSecret: string,
  redirectURI: string,
): GitHubOAuthClient {
  return {
    createAuthorizationURL: (state: string, scopes: string[]): URL => {
      const url = new URL('https://github.com/login/oauth/authorize')
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectURI,
        state,
        scope: scopes.join(' '),
        response_type: 'code',
      }).toString()
      return url
    },
    validateAuthorizationCode: async (code: string): Promise<{accessToken: () => string}> => {
      let res: Response
      try {
        res = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
            'User-Agent': 'fro-bot-dashboard',
          },
          body: new URLSearchParams({
            client_id: clientId,
            code,
            redirect_uri: redirectURI,
            grant_type: 'authorization_code',
          }).toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
        })
      } catch {
        throw new Error('GitHub OAuth token request failed')
      }

      if (res.status !== 200) {
        throw new Error(`GitHub OAuth token request failed: ${res.status}`)
      }

      let data: unknown
      try {
        data = await res.json()
      } catch {
        throw new Error('GitHub OAuth token response was not valid JSON')
      }

      if (data === null || typeof data !== 'object') {
        throw new TypeError('GitHub OAuth token response is not an object')
      }
      const obj = data as Record<string, unknown>

      // GitHub reports invalid codes in a successful HTTP response.
      if ('error' in obj) {
        if (typeof obj.error !== 'string' || !GITHUB_OAUTH_ERROR_CODES.has(obj.error)) {
          throw new Error('GitHub OAuth token exchange failed')
        }
        throw new Error(`GitHub OAuth token exchange failed: ${obj.error}`)
      }

      if (typeof obj.access_token !== 'string' || obj.access_token.length === 0) {
        throw new TypeError('GitHub OAuth token response missing access_token field')
      }
      const token = obj.access_token
      return {accessToken: () => token}
    },
  }
}

/**
 * Fetches the authenticated user's GitHub login using the access token.
 * This is the production implementation — tests inject a fake via `fetchUserLogin`.
 *
 * Security: access token is never logged.
 */
export async function fetchGitHubUserLogin(accessToken: string): Promise<string> {
  let res: Response
  try {
    res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    })
  } catch {
    throw new Error('GitHub /user request failed')
  }

  if (!res.ok) {
    throw new Error(`GitHub /user request failed: ${res.status}`)
  }

  const data: unknown = await res.json()
  if (data === null || typeof data !== 'object') {
    throw new TypeError('GitHub /user response is not an object')
  }
  const obj = data as Record<string, unknown>
  if (typeof obj.login !== 'string') {
    throw new TypeError('GitHub /user response missing login field')
  }
  return obj.login
}
