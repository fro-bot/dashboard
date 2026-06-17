/**
 * GitHub App client for the dashboard.
 *
 * Provides a throttled + retrying Octokit instance authenticated as the
 * fro-bot Agent App (second App private key). Used by `installations.ts` to
 * enumerate installations and mint read-only installation tokens.
 *
 * Security invariants:
 * - JWTs, private keys, and installation tokens are NEVER written to any log output.
 * - `safeErrorMessage` strips PEM blocks and JWT-shaped strings before surfacing errors.
 * - Octokit boundary casts use `as unknown as X`, never `any`.
 */

import {createAppAuth} from '@octokit/auth-app'
import {Octokit} from '@octokit/core'
import {retry} from '@octokit/plugin-retry'
import {throttling} from '@octokit/plugin-throttling'

import {logger, sanitizeErrorMessage} from '../logger.ts'

// ---------------------------------------------------------------------------
// Throttled + retrying Octokit class
// ---------------------------------------------------------------------------

const ThrottledOctokit = Octokit.plugin(throttling, retry)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppClientOptions {
  readonly appId: string
  readonly privateKey: string
}

export interface DashboardAppClient {
  /**
   * The underlying Octokit instance authenticated as the App (JWT-level).
   * Use for App-level endpoints like `apps.listInstallations` and
   * `GET /repos/{owner}/{repo}/installation`.
   */
  readonly octokit: InstanceType<typeof ThrottledOctokit>
  /**
   * Mint a read-only installation token for the given installation ID.
   * Returns the raw token string. NEVER log this value.
   *
   * The permissions type is `Record<string, 'read'>` — write/admin scopes are
   * unrepresentable at the dashboard boundary by construction.
   */
  readonly mintInstallationToken: (
    installationId: number,
    permissions: Record<string, 'read'>,
  ) => Promise<string>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a dashboard App client authenticated as the fro-bot Agent App.
 *
 * The returned `octokit` is JWT-authenticated (App-level) and is suitable for
 * `apps.listInstallations`. Use `mintInstallationToken` to get per-install tokens.
 */
export function createDashboardAppClient(options: AppClientOptions): DashboardAppClient {
  const {appId, privateKey} = options

  const octokit = new ThrottledOctokit({
    authStrategy: createAppAuth,
    auth: {appId, privateKey},
    throttle: {
      onRateLimit: (retryAfter: number, opts: Record<string, unknown>, _octokit: unknown, retryCount: number) => {
        logger.warning('GitHub rate limit hit', {retryAfter, url: opts.url, retryCount})
        return retryCount < 2
      },
      onSecondaryRateLimit: (retryAfter: number, opts: Record<string, unknown>, _octokit: unknown) => {
        logger.warning('GitHub secondary rate limit hit', {retryAfter, url: opts.url})
        return false
      },
    },
  })

  async function mintInstallationToken(
    installationId: number,
    permissions: Record<string, 'read'>,
  ): Promise<string> {
    const installAuth = createAppAuth({appId, privateKey, installationId})
    const result = await installAuth({
      type: 'installation',
      permissions,
    })
    return result.token
  }

  return {octokit, mintInstallationToken}
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Extract a safe error message that cannot contain sensitive material.
 *
 * Delegates to `sanitizeErrorMessage` from logger.ts — the single canonical
 * redactor that covers PEM blocks, JWT-shaped strings, GitHub tokens
 * (ghs_/gho_/ghp_/ghu_/github_pat_), and long opaque bearer strings.
 */
export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Unknown error'
  }
  return sanitizeErrorMessage(error.message)
}
