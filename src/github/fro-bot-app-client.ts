/**
 * Fro Bot App write-token client.
 *
 * Mints `contents: write` installation tokens scoped to the `fro-bot/.github`
 * repository. It is separate from the read-side App client: its own factory,
 * its own JWT-authenticated Octokit, its own per-instance token cache, and its
 * own permission type. It imports nothing from `app-client.ts` or
 * `installations.ts`, and shares no state with them.
 *
 * Boundary: only the server wiring and the wiki write modules may import this
 * module (enforced by `test/wiki-credential-boundary.test.ts`).
 *
 * Security invariants:
 * - The permission type admits `contents: 'write'` and nothing else.
 * - Every mint names the `.github` repository, so the token cannot reach others.
 * - JWTs, private keys, and tokens never appear in errors or logs.
 */

import {createAppAuth} from '@octokit/auth-app'
import {Octokit} from '@octokit/core'
import {retry} from '@octokit/plugin-retry'
import {throttling} from '@octokit/plugin-throttling'

import {logger, sanitizeErrorMessage} from '../logger.ts'

const ThrottledOctokit = Octokit.plugin(throttling, retry)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The only permission set a write token can carry. */
export interface WritePermissions {readonly contents: 'write'}

export const WRITE_PERMISSIONS = {contents: 'write'} as const satisfies WritePermissions

/** Supplies a `contents: write` installation token for `fro-bot/.github`. */
export interface WriteTokenProvider {
  /** Returns a cached or freshly minted token. NEVER log this value. */
  readonly getWriteToken: () => Promise<string>
}

/** App-JWT request function, the seam for tests. */
export type AppRequest = (route: string, params: Record<string, unknown>) => Promise<{readonly data: unknown}>

export interface FroBotAppClientOptions {
  readonly appId: string
  readonly privateKey: string
  /** Replaces the JWT-authenticated Octokit request. Tests only. */
  readonly request?: AppRequest | undefined
  /** Clock in ms since epoch. Tests only. */
  readonly now?: (() => number) | undefined
}

/** A credential failure whose message is safe to log. */
export class WriteCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WriteCredentialError'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_OWNER = 'fro-bot'
const TARGET_REPO = '.github'

/** Refresh a cached token this long before it expires. */
const TOKEN_REFRESH_BUFFER_MS = 60_000

/** How long a resolved installation ID is trusted. */
const INSTALLATION_ID_TTL_MS = 10 * 60_000

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseInstallationId(data: unknown): number {
  const id = typeof data === 'object' && data !== null ? (data as {id?: unknown}).id : undefined
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new WriteCredentialError('Installation lookup returned an unexpected response')
  }
  return id
}

function parseMintedToken(data: unknown): {token: string; expiresAt: number} {
  const body = typeof data === 'object' && data !== null ? (data as {token?: unknown; expires_at?: unknown}) : {}
  const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN
  if (typeof body.token !== 'string' || body.token === '' || Number.isNaN(expiresAt)) {
    throw new WriteCredentialError('Token mint returned an unexpected response')
  }
  return {token: body.token, expiresAt}
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown error'
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createJwtRequest(appId: string, privateKey: string): AppRequest {
  const octokit = new ThrottledOctokit({
    authStrategy: createAppAuth,
    auth: {appId, privateKey},
    throttle: {
      onRateLimit: (retryAfter: number, opts: Record<string, unknown>, _octokit: unknown, retryCount: number) => {
        logger.warning('GitHub rate limit hit (write client)', {retryAfter, url: opts.url, retryCount})
        return retryCount < 2
      },
      onSecondaryRateLimit: (retryAfter: number, opts: Record<string, unknown>) => {
        logger.warning('GitHub secondary rate limit hit (write client)', {retryAfter, url: opts.url})
        return false
      },
    },
  })
  return async (route, params) => octokit.request(route, params)
}

/**
 * Create a write-token provider authenticated as the Fro Bot App.
 *
 * Each instance owns its token cache (keyed by installation) and its resolved
 * installation ID. Nothing is shared across instances or with the read side.
 */
export function createFroBotAppClient(options: FroBotAppClientOptions): WriteTokenProvider {
  const request = options.request ?? createJwtRequest(options.appId, options.privateKey)
  const now = options.now ?? Date.now

  const tokenCache = new Map<number, {readonly token: string; readonly expiresAt: number}>()
  let resolvedInstallation: {readonly id: number; readonly resolvedAt: number} | null = null

  async function resolveInstallationId(): Promise<number> {
    if (resolvedInstallation !== null && now() - resolvedInstallation.resolvedAt < INSTALLATION_ID_TTL_MS) {
      return resolvedInstallation.id
    }
    let data: unknown
    try {
      data = (await request('GET /repos/{owner}/{repo}/installation', {owner: TARGET_OWNER, repo: TARGET_REPO})).data
    } catch (error) {
      throw new WriteCredentialError(`Failed to resolve the ${TARGET_OWNER}/${TARGET_REPO} installation: ${describeFailure(error)}`)
    }
    const id = parseInstallationId(data)
    resolvedInstallation = {id, resolvedAt: now()}
    return id
  }

  async function mint(installationId: number, permissions: WritePermissions): Promise<{token: string; expiresAt: number}> {
    let data: unknown
    try {
      data = (
        await request('POST /app/installations/{installation_id}/access_tokens', {
          installation_id: installationId,
          permissions: {...permissions},
          repository_names: [TARGET_REPO],
        })
      ).data
    } catch (error) {
      throw new WriteCredentialError(`Failed to mint a write token: ${describeFailure(error)}`)
    }
    return parseMintedToken(data)
  }

  async function getWriteToken(): Promise<string> {
    const installationId = await resolveInstallationId()
    const cached = tokenCache.get(installationId)
    if (cached !== undefined) {
      if (now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS) return cached.token
      tokenCache.delete(installationId)
    }
    const minted = await mint(installationId, WRITE_PERMISSIONS)
    tokenCache.set(installationId, minted)
    return minted.token
  }

  return {getWriteToken}
}
