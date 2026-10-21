/**
 * Git Data client for the wiki repository.
 *
 * A transport seam (plain functions returning `{data}`) sits under a typed
 * client. The real transports take a token source and ask it for a token on each
 * request, so cached-token expiry stays the source's concern. Read and write
 * token sources are distinct types: a read call site cannot be handed the write
 * source, and the read transport carries no write or status methods.
 *
 * Snapshots list the whole `data` tree in one request but read only the blobs the
 * shared gates consume (`SNAPSHOT_PATH_PREFIXES`); the gates take a file map.
 * A content-addressed, byte-bounded in-process cache spares refetching unchanged
 * blobs. The cache is never persisted and never logged.
 */

import {Buffer} from 'node:buffer'
import {Octokit} from '@octokit/core'
import {withinBound} from '../bounded.ts'
import {sanitizeErrorMessage} from '../logger.ts'
import {statusOf} from './guards.ts'
import {assertAllowedTarget, isSnapshotPath, isWritablePath, WIKI_OWNER, WIKI_REF, WIKI_REPO, WIKI_REPOSITORY} from './paths.ts'

export const PROMOTE_DATA_EVENT = 'promote-data'
export const PROMOTION_WORKFLOW = 'merge-data.yaml'

const BLOB_READ_CONCURRENCY = 8
const DEFAULT_BLOB_CACHE_BYTES = 64 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const COMMIT_LIST_PAGE_SIZE = 100

// ---------------------------------------------------------------------------
// Token sources
// ---------------------------------------------------------------------------

/** Supplies installation tokens for list and page reads. */
export interface ReadTokenSource {
  readonly kind: 'read-token-source'
  readonly getToken: () => Promise<string>
}

/** Supplies installation tokens for the save path and promotion-status reads. */
export interface WriteTokenSource {
  readonly kind: 'write-token-source'
  readonly getToken: () => Promise<string>
  /** Drops a token GitHub rejected, so the next `getToken` mints a new one. Optional. */
  readonly invalidate?: ((token: string) => void) | undefined
}

export function readTokenSource(getToken: () => Promise<string>): ReadTokenSource {
  return {kind: 'read-token-source', getToken}
}

export function writeTokenSource(
  getToken: () => Promise<string>,
  invalidate?: (token: string) => void,
): WriteTokenSource {
  return {kind: 'write-token-source', getToken, invalidate}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TransportCall = (params: Record<string, unknown>) => Promise<{data: unknown}>

export interface GitHubDataTransport {
  readonly getRef?: TransportCall
  readonly getCommit?: TransportCall
  readonly getTree?: TransportCall
  readonly getBlob?: TransportCall
  readonly createBlob?: TransportCall
  readonly createTree?: TransportCall
  readonly createCommit?: TransportCall
  readonly updateRef?: TransportCall
  readonly listCommitsByPath?: TransportCall
  readonly createDispatch?: TransportCall
  readonly listPulls?: TransportCall
  readonly listWorkflowRuns?: TransportCall
  readonly listRunJobs?: TransportCall
}

export type ReadTransport = Required<Pick<GitHubDataTransport, 'getBlob' | 'getCommit' | 'getRef' | 'getTree'>>

export interface TransportOptions {
  /** Replaces the global fetch. Tests only. */
  readonly fetch?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
}

export interface GitHubSnapshot {
  readonly headSha: string
  readonly treeSha: string
  readonly files: Record<string, string>
  readonly fileShas: Record<string, string>
}

export interface GitHubCommit {
  readonly sha: string
  readonly message: string
  readonly parents: readonly string[]
  readonly treeSha?: string
  readonly committedAt?: string
}

export interface TreeEntry {
  readonly path: string
  /** Blob SHA. A tree entry never deletes. */
  readonly sha: string | null
}

export interface CreateCommitInput {
  readonly treeSha: string
  readonly parentSha: string
  readonly message: string
  readonly author?: {readonly name: string; readonly email: string}
  readonly committer?: {readonly name: string; readonly email: string}
}

export interface CreatedCommit {
  readonly sha: string
  readonly committedAt: string | null
}

export interface PromotionPull {
  readonly number: number
  readonly url: string
  readonly createdAt: string
}

export interface PromotionRun {
  readonly id: number
  readonly status: string
  readonly conclusion: string | null
  readonly event: string
  readonly createdAt: string
  readonly url: string
}

export interface RunJob {
  readonly name: string
  readonly conclusion: string | null
  readonly steps: readonly {readonly name: string; readonly conclusion: string | null}[]
}

export interface WikiDataClient {
  readonly getSnapshot: () => Promise<GitHubSnapshot>
  readonly getHeadSha: () => Promise<string>
  readonly getCommit: (commitSha: string) => Promise<GitHubCommit>
  readonly createBlob: (content: string) => Promise<string>
  readonly createTree: (baseTreeSha: string, entries: readonly TreeEntry[]) => Promise<string>
  readonly createCommit: (input: CreateCommitInput) => Promise<CreatedCommit>
  readonly updateRef: (commitSha: string) => Promise<void>
  readonly listCommitsByPath: (path: string, options?: {readonly since?: string}) => Promise<GitHubCommit[]>
  readonly createPromotionDispatch: () => Promise<void>
  readonly listPromotionPulls: () => Promise<PromotionPull[]>
  readonly getLatestPromotionRun: () => Promise<PromotionRun | null>
  readonly listRunJobs: (runId: number) => Promise<RunJob[]>
}

export interface WikiDataClientOptions {
  readonly blobCache?: BlobCache | undefined
}

/** A snapshot read that could not complete. Carries no GitHub error object. */
export class WikiDataUnavailableError extends Error {
  readonly reason: 'read-failed' | 'tree-truncated'
  readonly status: number | null
  readonly rateLimit: RateLimitInfo | null

  constructor(
    reason: 'read-failed' | 'tree-truncated',
    status: number | null,
    detail?: string,
    rateLimit: RateLimitInfo | null = null,
  ) {
    super(detail === undefined ? `Wiki data unavailable: ${reason}` : `Wiki data unavailable: ${reason}: ${detail}`)
    this.name = 'WikiDataUnavailableError'
    this.reason = reason
    this.status = status
    this.rateLimit = rateLimit
  }
}

/**
 * The request never reached GitHub: the token could not be obtained. `status` is the
 * HTTP status of the failed mint or lookup when GitHub answered it, so a refused
 * credential still reads as a refusal. Carries no token, key or cause.
 */
export class RequestNotSentError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'RequestNotSentError'
    this.status = status
  }
}

export interface RateLimitInfo {
  readonly retryAfterSeconds: number | null
}

const MAX_RETRY_HINT_SECONDS = 3600

function headerOf(error: unknown, name: string): string | undefined {
  const response = typeof error === 'object' && error !== null ? (error as {response?: unknown}).response : undefined
  const headers = typeof response === 'object' && response !== null ? (response as {headers?: unknown}).headers : undefined
  if (typeof headers !== 'object' || headers === null) return undefined
  const value = (headers as Record<string, unknown>)[name]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

/**
 * Recognises a GitHub rate-limit response (429, or 403 with no quota left or a
 * rate-limit message) and returns a retry hint in seconds when GitHub gave one.
 */
export function rateLimitOf(error: unknown): RateLimitInfo | null {
  const status = statusOf(error)
  const message = error instanceof Error ? error.message : ''
  const exhausted = headerOf(error, 'x-ratelimit-remaining') === '0'
  const named = /rate limit/iu.test(message)
  if (status !== 429 && !(status === 403 && (exhausted || named))) return null

  const retryAfter = Number(headerOf(error, 'retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return {retryAfterSeconds: Math.min(Math.ceil(retryAfter), MAX_RETRY_HINT_SECONDS)}
  }
  const reset = Number(headerOf(error, 'x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    const seconds = Math.ceil(reset - Date.now() / 1000)
    if (seconds > 0) return {retryAfterSeconds: Math.min(seconds, MAX_RETRY_HINT_SECONDS)}
  }
  return {retryAfterSeconds: null}
}

/**
 * A refusal (401, 403, 404) that is not a rate limit. Retrying cannot fix it: the
 * credential or its target is wrong.
 */
export function isRefusal(error: unknown): boolean {
  const status = statusOf(error)
  return (status === 401 || status === 403 || status === 404) && rateLimitOf(error) === null
}

// ---------------------------------------------------------------------------
// Blob cache
// ---------------------------------------------------------------------------

/** Content-addressed blob cache, least-recently-used, bounded by total UTF-8 bytes. */
export interface BlobCache {
  readonly get: (sha: string) => string | undefined
  readonly set: (sha: string, content: string) => void
  readonly sizeBytes: () => number
}

export function createBlobCache(options: {readonly maxBytes?: number} = {}): BlobCache {
  const maxBytes = options.maxBytes ?? DEFAULT_BLOB_CACHE_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive number')

  const entries = new Map<string, {readonly content: string; readonly bytes: number}>()
  let total = 0

  function remove(sha: string): void {
    const existing = entries.get(sha)
    if (existing === undefined) return
    total -= existing.bytes
    entries.delete(sha)
  }

  return {
    get(sha) {
      const entry = entries.get(sha)
      if (entry === undefined) return undefined
      entries.delete(sha)
      entries.set(sha, entry)
      return entry.content
    },
    set(sha, content) {
      remove(sha)
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > maxBytes) return
      entries.set(sha, {content, bytes})
      total += bytes
      for (const oldest of entries.keys()) {
        if (total <= maxBytes) break
        remove(oldest)
      }
    },
    sizeBytes: () => total,
  }
}

// ---------------------------------------------------------------------------
// Real transports
// ---------------------------------------------------------------------------

function createRequester(
  getToken: () => Promise<string>,
  options: TransportOptions,
  invalidate?: (token: string) => void,
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  let current: {readonly token: string; readonly octokit: Octokit} | null = null

  return async (route: string, params: Record<string, unknown>): Promise<{data: unknown}> => {
    // One deadline covers token acquisition, the request, and the one retry after a 401.
    const deadline = Date.now() + timeoutMs
    const remaining = (): number => Math.max(deadline - Date.now(), 0)
    let usedToken: string | null = null

    const attempt = async (): Promise<{data: unknown}> => {
      let token: string
      try {
        token = await withinBound(getToken(), remaining(), 'GitHub request timed out')
      } catch (error) {
        // No request was sent. Keep the status so a refused credential still reads as a refusal.
        throw new RequestNotSentError(
          error instanceof Error ? sanitizeErrorMessage(error.message) : 'Token unavailable',
          statusOf(error),
        )
      }
      usedToken = token
      if (current === null || current.token !== token) {
        const octokit = new Octokit({auth: token, ...(options.fetch === undefined ? {} : {request: {fetch: options.fetch}})})
        current = {token, octokit}
      }
      const response = await current.octokit.request(route, {...params, request: {signal: AbortSignal.timeout(remaining())}})
      return {data: response.data as unknown}
    }

    try {
      return await attempt()
    } catch (error) {
      // A 401 means GitHub processed nothing, so one retry with a fresh token is safe.
      if (
        invalidate === undefined ||
        usedToken === null ||
        error instanceof RequestNotSentError ||
        statusOf(error) !== 401
      ) {
        throw error
      }
      invalidate(usedToken)
      return attempt()
    }
  }
}

function readCalls(request: ReturnType<typeof createRequester>): ReadTransport {
  return {
    getRef: async params => request('GET /repos/{owner}/{repo}/git/ref/{ref}', params),
    getCommit: async params => request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', params),
    getTree: async params => request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', params),
    getBlob: async params => request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', params),
  }
}

/** Transport for list and page reads. Read methods only. */
export function createReadTransport(source: ReadTokenSource, options: TransportOptions = {}): ReadTransport {
  return readCalls(createRequester(source.getToken, options))
}

/** Transport for the save path and promotion-status reads. */
export function createWriteTransport(
  source: WriteTokenSource,
  options: TransportOptions = {},
): Required<GitHubDataTransport> {
  const request = createRequester(source.getToken, options, source.invalidate)
  return {
    ...readCalls(request),
    createBlob: async params => request('POST /repos/{owner}/{repo}/git/blobs', params),
    createTree: async params => request('POST /repos/{owner}/{repo}/git/trees', params),
    createCommit: async params => request('POST /repos/{owner}/{repo}/git/commits', params),
    updateRef: async params => request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', params),
    listCommitsByPath: async params => request('GET /repos/{owner}/{repo}/commits', params),
    createDispatch: async params => request('POST /repos/{owner}/{repo}/dispatches', params),
    listPulls: async params => request('GET /repos/{owner}/{repo}/pulls', params),
    listWorkflowRuns: async params => request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', params),
    listRunJobs: async params => request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', params),
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createWikiDataClient(
  transport: GitHubDataTransport,
  options: WikiDataClientOptions = {},
): WikiDataClient {
  const blobCache = options.blobCache ?? createBlobCache()
  const inflightBlobs = new Map<string, Promise<string>>()

  const call = async <T>(name: keyof GitHubDataTransport, params: Record<string, unknown>): Promise<T> => {
    const method = transport[name]
    if (method === undefined) throw new Error(`GitHub transport method ${name} is unavailable`)
    const response = await method(params)
    return response.data as T
  }

  async function readBlob(sha: string): Promise<string> {
    const cached = blobCache.get(sha)
    if (cached !== undefined) return cached
    const pending = inflightBlobs.get(sha)
    if (pending !== undefined) return pending

    const fetching = call<{content?: unknown; encoding?: unknown}>('getBlob', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      file_sha: sha,
    })
      .then(decodeBlob)
      .then(content => {
        blobCache.set(sha, content)
        return content
      })
      .finally(() => {
        inflightBlobs.delete(sha)
      })
    inflightBlobs.set(sha, fetching)
    return fetching
  }

  async function readSnapshot(): Promise<GitHubSnapshot> {
    const ref = await call<{object?: {sha?: unknown}}>('getRef', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      ref: `heads/${WIKI_REF}`,
    })
    const headSha = requireString(ref.object?.sha, 'GitHub ref did not return a head SHA')
    const commit = await getCommit(headSha)
    const treeSha = requireString(commit.treeSha, 'GitHub commit did not return a tree')
    const tree = await call<{tree?: unknown; truncated?: unknown}>('getTree', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      tree_sha: treeSha,
      recursive: '1',
    })
    if (tree.truncated === true) throw new WikiDataUnavailableError('tree-truncated', null)
    if (!Array.isArray(tree.tree)) throw new Error('GitHub tree response was invalid')

    const blobs = (tree.tree as {path?: unknown; type?: unknown; sha?: unknown}[]).flatMap(entry =>
      entry?.type === 'blob' &&
      typeof entry.path === 'string' &&
      typeof entry.sha === 'string' &&
      isSnapshotPath(entry.path)
        ? [{path: entry.path, sha: entry.sha}]
        : [],
    )
    const contents: string[] = Array.from({length: blobs.length}, () => '')
    let next = 0
    let failed = false
    const worker = async (): Promise<void> => {
      while (!failed) {
        const index = next
        next += 1
        const blob = blobs[index]
        if (blob === undefined) return
        try {
          contents[index] = await readBlob(blob.sha)
        } catch (error) {
          failed = true
          throw error
        }
      }
    }
    await Promise.all(Array.from({length: Math.min(BLOB_READ_CONCURRENCY, blobs.length)}, worker))

    return {
      headSha,
      treeSha,
      files: Object.fromEntries(blobs.map((blob, index) => [blob.path, contents[index] ?? ''])),
      fileShas: Object.fromEntries(blobs.map(blob => [blob.path, blob.sha])),
    }
  }

  async function getSnapshot(): Promise<GitHubSnapshot> {
    try {
      return await readSnapshot()
    } catch (error) {
      if (error instanceof WikiDataUnavailableError) throw error
      throw new WikiDataUnavailableError(
        'read-failed',
        statusOf(error),
        error instanceof Error ? sanitizeErrorMessage(error.message) : undefined,
        rateLimitOf(error),
      )
    }
  }

  async function getHeadSha(): Promise<string> {
    const ref = await call<{object?: {sha?: unknown}}>('getRef', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      ref: `heads/${WIKI_REF}`,
    })
    return requireString(ref.object?.sha, 'GitHub ref did not return a head SHA')
  }

  async function getCommit(commitSha: string): Promise<GitHubCommit> {
    const response = await call<{sha?: unknown; message?: unknown; parents?: unknown; tree?: unknown}>('getCommit', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      commit_sha: commitSha,
    })
    return {
      sha: requireString(response.sha, 'GitHub commit did not return a SHA'),
      message: typeof response.message === 'string' ? response.message : '',
      parents: parentShas(response.parents),
      treeSha: commitTreeSha(response),
    }
  }

  async function createBlob(content: string): Promise<string> {
    const response = await call<{sha?: unknown}>('createBlob', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      content,
      encoding: 'utf-8',
    })
    return requireString(response.sha, 'GitHub blob creation did not return a SHA')
  }

  async function createTree(baseTreeSha: string, entries: readonly TreeEntry[]): Promise<string> {
    for (const entry of entries) {
      if (!isWritablePath(entry.path)) throw new Error('tree entry path is not allowed')
      if (entry.sha === null) throw new Error('tree entries cannot delete files')
    }
    const response = await call<{sha?: unknown}>('createTree', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      base_tree: baseTreeSha,
      tree: entries.map(entry => ({path: entry.path, mode: '100644', type: 'blob', sha: entry.sha})),
    })
    return requireString(response.sha, 'GitHub tree creation did not return a SHA')
  }

  async function createCommit(input: CreateCommitInput): Promise<CreatedCommit> {
    const response = await call<{sha?: unknown; committer?: {date?: unknown}}>('createCommit', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      message: input.message,
      tree: input.treeSha,
      parents: [input.parentSha],
      ...(input.author === undefined ? {} : {author: input.author}),
      ...(input.committer === undefined ? {} : {committer: input.committer}),
    })
    const date = response.committer?.date
    return {
      sha: requireString(response.sha, 'GitHub commit creation did not return a SHA'),
      committedAt: typeof date === 'string' && date !== '' ? date : null,
    }
  }

  async function updateRef(commitSha: string): Promise<void> {
    await call('updateRef', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      ref: `heads/${WIKI_REF}`,
      sha: commitSha,
      force: false,
    })
  }

  async function listCommitsByPath(path: string, listOptions: {readonly since?: string} = {}): Promise<GitHubCommit[]> {
    assertAllowedTarget(WIKI_REPOSITORY, WIKI_REF, path)
    const data = await call<unknown>('listCommitsByPath', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      sha: WIKI_REF,
      path,
      ...(listOptions.since === undefined ? {} : {since: listOptions.since}),
      per_page: COMMIT_LIST_PAGE_SIZE,
    })
    if (!Array.isArray(data)) throw new Error('GitHub commit list response was invalid')
    return data.map(item => {
      const entry = asRecord(item, 'GitHub commit list entry was invalid')
      const detail = typeof entry.commit === 'object' && entry.commit !== null ? (entry.commit as Record<string, unknown>) : {}
      const treeSha =
        typeof detail.tree === 'object' && detail.tree !== null ? (detail.tree as {sha?: unknown}).sha : undefined
      const committedAt =
        typeof detail.committer === 'object' && detail.committer !== null
          ? (detail.committer as {date?: unknown}).date
          : undefined
      return {
        sha: requireString(entry.sha, 'GitHub commit list entry did not return a SHA'),
        message: typeof detail.message === 'string' ? detail.message : '',
        parents: parentShas(entry.parents),
        ...(typeof treeSha === 'string' ? {treeSha} : {}),
        ...(typeof committedAt === 'string' ? {committedAt} : {}),
      }
    })
  }

  async function createPromotionDispatch(): Promise<void> {
    await call('createDispatch', {owner: WIKI_OWNER, repo: WIKI_REPO, event_type: PROMOTE_DATA_EVENT})
  }

  async function listPromotionPulls(): Promise<PromotionPull[]> {
    const data = await call<unknown>('listPulls', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      state: 'open',
      head: `${WIKI_OWNER}:${WIKI_REF}`,
      base: 'main',
      per_page: 10,
    })
    if (!Array.isArray(data)) throw new Error('GitHub pull list response was invalid')
    return data.map(item => {
      const pull = asRecord(item, 'GitHub pull entry was invalid')
      return {
        number: requirePositiveInteger(pull.number, 'GitHub pull entry did not return a number'),
        url: requireString(pull.html_url, 'GitHub pull entry did not return a URL'),
        createdAt: requireString(pull.created_at, 'GitHub pull entry did not return a creation time'),
      }
    })
  }

  async function getLatestPromotionRun(): Promise<PromotionRun | null> {
    const data = asRecord(
      await call<unknown>('listWorkflowRuns', {
        owner: WIKI_OWNER,
        repo: WIKI_REPO,
        workflow_id: PROMOTION_WORKFLOW,
        per_page: 1,
      }),
      'GitHub workflow run response was invalid',
    )
    if (!Array.isArray(data.workflow_runs)) throw new Error('GitHub workflow run response was invalid')
    const first: unknown = data.workflow_runs[0]
    if (first === undefined) return null
    const run = asRecord(first, 'GitHub workflow run entry was invalid')
    return {
      id: requirePositiveInteger(run.id, 'GitHub workflow run did not return an ID'),
      status: requireString(run.status, 'GitHub workflow run did not return a status'),
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      event: requireString(run.event, 'GitHub workflow run did not return an event'),
      createdAt: requireString(run.created_at, 'GitHub workflow run did not return a creation time'),
      url: requireString(run.html_url, 'GitHub workflow run did not return a URL'),
    }
  }

  async function listRunJobs(runId: number): Promise<RunJob[]> {
    requirePositiveInteger(runId, 'run ID must be a positive integer')
    const data = asRecord(
      await call<unknown>('listRunJobs', {owner: WIKI_OWNER, repo: WIKI_REPO, run_id: runId, per_page: 100}),
      'GitHub run jobs response was invalid',
    )
    if (!Array.isArray(data.jobs)) throw new Error('GitHub run jobs response was invalid')
    return data.jobs.map((item: unknown) => {
      const job = asRecord(item, 'GitHub job entry was invalid')
      const steps: unknown[] = Array.isArray(job.steps) ? job.steps : []
      return {
        name: requireString(job.name, 'GitHub job did not return a name'),
        conclusion: typeof job.conclusion === 'string' ? job.conclusion : null,
        steps: steps.map(step => {
          const record = asRecord(step, 'GitHub job step was invalid')
          return {
            name: requireString(record.name, 'GitHub job step did not return a name'),
            conclusion: typeof record.conclusion === 'string' ? record.conclusion : null,
          }
        }),
      }
    })
  }

  return {
    getSnapshot,
    getHeadSha,
    getCommit,
    createBlob,
    createTree,
    createCommit,
    updateRef,
    listCommitsByPath,
    createPromotionDispatch,
    listPromotionPulls,
    getLatestPromotionRun,
    listRunJobs,
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parentShas(parents: unknown): string[] {
  if (!Array.isArray(parents)) return []
  return parents
    .map((parent: unknown) =>
      parent !== null && typeof parent === 'object' ? (parent as {sha?: unknown}).sha : undefined,
    )
    .filter((parent): parent is string => typeof parent === 'string')
}

function commitTreeSha(commit: {tree?: unknown}): string {
  if (commit.tree === null || typeof commit.tree !== 'object') throw new Error('GitHub commit did not return a tree')
  return requireString((commit.tree as {sha?: unknown}).sha, 'GitHub commit tree did not return a SHA')
}

function decodeBlob(blob: {content?: unknown; encoding?: unknown}): string {
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('GitHub blob response was invalid')
  return Buffer.from(blob.content.replaceAll(/\s+/gu, ''), 'base64').toString('utf8')
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message)
  return value
}

function requirePositiveInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(message)
  return value
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}
