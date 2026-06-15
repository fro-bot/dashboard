/**
 * GitHub OAuth client abstraction.
 *
 * Wraps Arctic v3's `GitHub` provider with a testable interface.
 * The `GitHubOAuthClient` interface is the seam — tests inject a fake,
 * production uses `makeGitHubOAuthClient()`.
 *
 * Security: tokens are never logged (redactSensitiveFields covers 'token'
 * and 'access_token' patterns). The operator allowlist check lives in the
 * route handler, not here.
 */
import {GitHub} from 'arctic'

/**
 * Minimal interface for the GitHub OAuth client.
 * Matches the Arctic v3 `GitHub` class surface we actually use.
 * Uses function property style (not shorthand method signatures) per lint rules.
 */
export interface GitHubOAuthClient {
  readonly createAuthorizationURL: (state: string, scopes: string[]) => URL
  readonly validateAuthorizationCode: (code: string) => Promise<{accessToken: () => string}>
}

/**
 * Creates a production GitHub OAuth client using Arctic v3.
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
  return new GitHub(clientId, clientSecret, redirectURI)
}

/**
 * Fetches the authenticated user's GitHub login using the access token.
 * This is the production implementation — tests inject a fake via `fetchUserLogin`.
 *
 * Security: access token is never logged.
 */
export async function fetchGitHubUserLogin(accessToken: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

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
