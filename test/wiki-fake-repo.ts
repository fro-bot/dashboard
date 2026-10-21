/**
 * In-memory Git Data model for write-operation tests.
 *
 * Behaves like the `fro-bot/.github` `data` branch as far as the write path can
 * see: a head, commits with parents, trees built from a base tree plus changed
 * entries, blobs, path-scoped history, and a non-forced ref update that fails on
 * a moved head. Failures and head moves are injected through hooks.
 */

import type {GitHubDataTransport} from '../src/wiki/data-client.ts'
import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'

type Params = Record<string, unknown>

export interface FakeCommit {
  readonly sha: string
  readonly message: string
  readonly parents: readonly string[]
  readonly treeSha: string
  readonly committedAt: string
  readonly author: unknown
  readonly committer: unknown
  readonly touched: ReadonlySet<string>
}

export interface FakeRepoOptions {
  readonly files: Record<string, string>
  readonly startMs?: number
}

export interface FakeRepoHooks {
  /** Runs before the ref update is evaluated. May move the head or throw. */
  beforeUpdateRef?: (attempt: number) => void
  /** Runs after a ref update lands. May throw to lose the response. */
  afterUpdateRef?: (attempt: number) => void
  /** Throws for a transport method, or returns normally. */
  onCall?: (method: string, params: Params) => void
}

export class HttpError extends Error {
  readonly status: number | undefined
  readonly response: {readonly headers: Record<string, string>} | undefined

  constructor(message: string, status?: number, headers?: Record<string, string>) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.response = headers === undefined ? undefined : {headers}
  }
}

export function blobShaOf(content: string): string {
  return `blob-${createHash('sha1').update(content).digest('hex').slice(0, 12)}`
}

export class FakeRepo {
  readonly commits = new Map<string, FakeCommit>()
  readonly trees = new Map<string, Record<string, string>>()
  readonly blobs = new Map<string, string>()
  readonly calls: {method: string; params: Params}[] = []
  readonly hooks: FakeRepoHooks = {}
  head: string
  clockMs: number
  private treeCount = 0
  private commitCount = 0
  private updateAttempts = 0

  constructor(options: FakeRepoOptions) {
    this.clockMs = options.startMs ?? Date.parse('2030-01-01T00:00:00Z')
    const treeSha = this.storeTree(Object.fromEntries(Object.entries(options.files).map(([path, content]) => [path, this.storeBlob(content)])))
    this.head = this.storeCommit({message: 'initial', parents: [], treeSha, touched: new Set(Object.keys(options.files))})
  }

  /** Files at the current head. */
  files(): Record<string, string> {
    const tree = this.trees.get(this.commit(this.head).treeSha) ?? {}
    return Object.fromEntries(Object.entries(tree).map(([path, sha]) => [path, this.blobs.get(sha) ?? '']))
  }

  blobShaAt(path: string): string | undefined {
    return (this.trees.get(this.commit(this.head).treeSha) ?? {})[path]
  }

  commit(sha: string): FakeCommit {
    const commit = this.commits.get(sha)
    if (commit === undefined) throw new HttpError('Not Found', 404)
    return commit
  }

  count(method: string): number {
    return this.calls.filter(call => call.method === method).length
  }

  advance(ms: number): void {
    this.clockMs += ms
  }

  /** A pipeline commit: applies changes on top of the head and moves it. */
  pipelineCommit(changes: Record<string, string>, message = 'chore(pipeline): update'): string {
    const base = {...(this.trees.get(this.commit(this.head).treeSha) ?? {})}
    for (const [path, content] of Object.entries(changes)) base[path] = this.storeBlob(content)
    const treeSha = this.storeTree(base)
    this.advance(1000)
    this.head = this.storeCommit({message, parents: [this.head], treeSha, touched: new Set(Object.keys(changes))})
    return this.head
  }

  /** A pipeline commit that removes a file. */
  removeFile(path: string, message = 'chore(pipeline): remove'): string {
    const base = {...(this.trees.get(this.commit(this.head).treeSha) ?? {})}
    delete base[path]
    const treeSha = this.storeTree(base)
    this.advance(1000)
    this.head = this.storeCommit({message, parents: [this.head], treeSha, touched: new Set([path])})
    return this.head
  }

  /** Commits reachable from the head, newest first. */
  history(): FakeCommit[] {
    const chain: FakeCommit[] = []
    let sha: string | undefined = this.head
    while (sha !== undefined) {
      const commit: FakeCommit = this.commit(sha)
      chain.push(commit)
      sha = commit.parents[0]
    }
    return chain
  }

  /** Commits that carry a given trailer line. */
  commitsWithTrailer(operationId: string): FakeCommit[] {
    return [...this.commits.values()].filter(commit => commit.message.includes(`Fro-Operation-Id: ${operationId}`))
  }

  transport(): Required<GitHubDataTransport> {
    const call = async (method: string, params: Params, run: () => unknown): Promise<{data: unknown}> => {
      this.calls.push({method, params})
      this.hooks.onCall?.(method, params)
      return {data: run()}
    }
    return {
      getRef: async params => call('getRef', params, () => ({object: {sha: this.head}})),
      getCommit: async params =>
        call('getCommit', params, () => {
          const commit = this.commit(String(params.commit_sha))
          return {sha: commit.sha, message: commit.message, parents: commit.parents.map(sha => ({sha})), tree: {sha: commit.treeSha}}
        }),
      getTree: async params =>
        call('getTree', params, () => {
          const tree = this.trees.get(String(params.tree_sha))
          if (tree === undefined) throw new HttpError('Not Found', 404)
          return {truncated: false, tree: Object.entries(tree).map(([path, sha]) => ({path, type: 'blob', sha}))}
        }),
      getBlob: async params =>
        call('getBlob', params, () => {
          const content = this.blobs.get(String(params.file_sha))
          if (content === undefined) throw new HttpError('Not Found', 404)
          return {content: Buffer.from(content).toString('base64'), encoding: 'base64'}
        }),
      createBlob: async params => call('createBlob', params, () => ({sha: this.storeBlob(String(params.content))})),
      createTree: async params =>
        call('createTree', params, () => {
          const base = {...(this.trees.get(String(params.base_tree)) ?? {})}
          for (const entry of params.tree as {path: string; sha: string}[]) base[entry.path] = entry.sha
          return {sha: this.storeTree(base)}
        }),
      createCommit: async params =>
        call('createCommit', params, () => {
          const parents = params.parents as string[]
          const parentTree = this.trees.get(this.commit(parents[0] ?? '').treeSha) ?? {}
          const nextTree = this.trees.get(String(params.tree)) ?? {}
          const touched = new Set(
            Object.keys({...parentTree, ...nextTree}).filter(path => parentTree[path] !== nextTree[path]),
          )
          this.advance(1000)
          const sha = this.storeCommit({
            message: String(params.message),
            parents,
            treeSha: String(params.tree),
            touched,
            author: params.author,
            committer: params.committer,
          })
          return {sha, committer: {date: this.commit(sha).committedAt}}
        }),
      updateRef: async params => {
        this.updateAttempts += 1
        const attempt = this.updateAttempts
        this.hooks.beforeUpdateRef?.(attempt)
        return call('updateRef', params, () => {
          const commit = this.commit(String(params.sha))
          if (params.force === true) throw new Error('forced ref updates are not allowed')
          if (commit.parents[0] !== this.head) throw new HttpError('Update is not a fast forward', 422)
          this.head = commit.sha
          this.hooks.afterUpdateRef?.(attempt)
          return {}
        })
      },
      listCommitsByPath: async params =>
        call('listCommitsByPath', params, () => {
          const since = typeof params.since === 'string' ? Date.parse(params.since) : Number.NEGATIVE_INFINITY
          const limit = Number(params.per_page ?? 30)
          const found: unknown[] = []
          let sha: string | undefined = this.head
          while (sha !== undefined && found.length < limit) {
            const commit: FakeCommit = this.commit(sha)
            if (Date.parse(commit.committedAt) < since) break
            if (commit.touched.has(String(params.path))) {
              found.push({
                sha: commit.sha,
                commit: {message: commit.message, tree: {sha: commit.treeSha}, committer: {date: commit.committedAt}},
                parents: commit.parents.map(parent => ({sha: parent})),
              })
            }
            sha = commit.parents[0]
          }
          return found
        }),
      createDispatch: async params => call('createDispatch', params, () => ({})),
      listPulls: async params => call('listPulls', params, () => []),
      listWorkflowRuns: async params => call('listWorkflowRuns', params, () => ({workflow_runs: []})),
      listRunJobs: async params => call('listRunJobs', params, () => ({jobs: []})),
    }
  }

  private storeBlob(content: string): string {
    const sha = blobShaOf(content)
    this.blobs.set(sha, content)
    return sha
  }

  private storeTree(tree: Record<string, string>): string {
    this.treeCount += 1
    const sha = `tree-${this.treeCount}`
    this.trees.set(sha, tree)
    return sha
  }

  private storeCommit(input: {
    message: string
    parents: readonly string[]
    treeSha: string
    touched: ReadonlySet<string>
    author?: unknown
    committer?: unknown
  }): string {
    this.commitCount += 1
    const sha = `commit-${this.commitCount}`
    this.commits.set(sha, {
      sha,
      message: input.message,
      parents: input.parents,
      treeSha: input.treeSha,
      committedAt: new Date(this.clockMs).toISOString(),
      author: input.author,
      committer: input.committer,
      touched: input.touched,
    })
    return sha
  }
}
