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

import {withinBound} from '../bounded.ts'
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
  /**
   * Drops the cached token when it is `token`, so the next call mints a new one. A newer
   * cached token is kept. Used when GitHub rejects a token the cache still holds.
   */
  readonly invalidate: (token: string) => void
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
  /** Per-request bound. Tests only. */
  readonly timeoutMs?: number | undefined
}

/**
 * A credential failure whose message is safe to log. `status` is the HTTP status of
 * the failed request when GitHub answered, so callers can tell a refused credential
 * (401, 403, 404) from a transient failure. It is null otherwise.
 */
export class WriteCredentialError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'WriteCredentialError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_OWNER = 'fro-bot'
const TARGET_REPO = '.github'

/** Refresh a cached token this long before it expires. */
const TOKEN_REFRESH_BUFFER_MS = 60_000

/** Bound on each App-JWT request, the installation lookup and the mint. */
export const JWT_REQUEST_TIMEOUT_MS = 15_000

/** The longest rate-limit wait the client will sit through before it fails. */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 10

const MAX_RATE_LIMIT_RETRIES = 2

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

function statusOf(error: unknown): number | null {
  const status = typeof error === 'object' && error !== null ? (error as {status?: unknown}).status : undefined
  return typeof status === 'number' ? status : null
}

/** Retry a rate-limited request only for a short, finite wait. */
export function shouldRetryRateLimit(retryAfterSeconds: number, retryCount: number): boolean {
  return (
    retryCount < MAX_RATE_LIMIT_RETRIES &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0 &&
    retryAfterSeconds <= MAX_RATE_LIMIT_WAIT_SECONDS
  )
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
        return shouldRetryRateLimit(retryAfter, retryCount)
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
 * Each instance owns its token cache (keyed by installation), its resolved
 * installation ID and one in-flight lookup-and-mint that concurrent callers share.
 * Nothing is shared across instances or with the read side.
 */
export function createFroBotAppClient(options: FroBotAppClientOptions): WriteTokenProvider {
  const send = options.request ?? createJwtRequest(options.appId, options.privateKey)
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? JWT_REQUEST_TIMEOUT_MS

  // The signal aborts the real request; the deadline also bounds an injected one.
  const request: AppRequest = async (route, params) =>
    withinBound(send(route, {...params, request: {signal: AbortSignal.timeout(timeoutMs)}}), timeoutMs, 'Request timed out')

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
      throw new WriteCredentialError(
        `Failed to resolve the ${TARGET_OWNER}/${TARGET_REPO} installation: ${describeFailure(error)}`,
        statusOf(error),
      )
    }
    const id = parseInstallationId(data)
    resolvedInstallation = {id, resolvedAt: now()}
    return id
  }

  async function mint(installationId: number): Promise<{token: string; expiresAt: number}> {
    let data: unknown
    try {
      data = (
        await request('POST /app/installations/{installation_id}/access_tokens', {
          installation_id: installationId,
          permissions: {...WRITE_PERMISSIONS},
          repository_names: [TARGET_REPO],
        })
      ).data
    } catch (error) {
      throw new WriteCredentialError(`Failed to mint a write token: ${describeFailure(error)}`, statusOf(error))
    }
    return parseMintedToken(data)
  }

  async function obtainWriteToken(): Promise<string> {
    const installationId = await resolveInstallationId()
    const cached = tokenCache.get(installationId)
    if (cached !== undefined) {
      if (now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS) return cached.token
      tokenCache.delete(installationId)
    }
    const minted = await mint(installationId)
    tokenCache.set(installationId, minted)
    return minted.token
  }

  // One flight at a time: simultaneous cold callers share one lookup and one mint. The
  // flight is cleared when it settles, so a rejection is never remembered.
  let flight: Promise<string> | undefined
  async function getWriteToken(): Promise<string> {
    flight ??= obtainWriteToken().finally(() => {
      flight = undefined
    })
    return flight
  }

  function invalidate(token: string): void {
    for (const [installationId, cached] of tokenCache) {
      if (cached.token === token) tokenCache.delete(installationId)
    }
  }

  return {getWriteToken, invalidate}
}
