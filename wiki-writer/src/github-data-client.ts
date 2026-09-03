import {Buffer} from 'node:buffer'
import {readFile} from 'node:fs/promises'
import {createAppAuth} from '@octokit/auth-app'
import {Octokit} from '@octokit/core'

export const WIKI_REPOSITORY = 'fro-bot/.github'
export const WIKI_REF = 'data'
export const WIKI_OWNER = 'fro-bot'
export const WIKI_REPO = '.github'

const ALLOWED_PATH = /^knowledge\/wiki\/(?:repos|topics|entities|comparisons)\/[^/]+\.md$/u
const CORRECTIONS_PATH = 'knowledge/corrections.yaml'

export interface GitHubTreeEntry {
  readonly path?: string
  readonly type?: string
  readonly sha?: string
}

export interface GitHubDataTransport {
  readonly getRef?: (params: Record<string, unknown>) => Promise<{data: unknown}>
  readonly getCommit?: (params: Record<string, unknown>) => Promise<{data: unknown}>
  readonly getTree?: (params: Record<string, unknown>) => Promise<{data: unknown}>
  readonly getBlob?: (params: Record<string, unknown>) => Promise<{data: unknown}>
  readonly createBlob?: (params: Record<string, unknown>) => Promise<{data: unknown}>
  readonly createTree?: (params: Record<string, unknown>) => Promise<{data: unknown}>
  readonly createCommit?: (params: Record<string, unknown>) => Promise<{data: unknown}>
  readonly updateRef?: (params: Record<string, unknown>) => Promise<{data: unknown}>
}

export interface GitHubFile {
  readonly content: string
  readonly sha: string
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
}

export interface TreeEntry {
  readonly path: string
  readonly sha: string | null
}

export interface CreateCommitInput {
  readonly treeSha: string
  readonly parentSha: string
  readonly message: string
  readonly author?: {readonly name: string; readonly email: string}
  readonly committer?: {readonly name: string; readonly email: string}
}

export interface GitHubDataClient {
  readonly getSnapshot: () => Promise<GitHubSnapshot>
  readonly createBlob: (content: string) => Promise<string>
  readonly createTree: (baseTreeSha: string, entries: readonly TreeEntry[]) => Promise<string>
  readonly createCommit: (input: CreateCommitInput) => Promise<string>
  readonly updateRef: (commitSha: string) => Promise<void>
  readonly getCommit: (commitSha: string) => Promise<GitHubCommit>
}

export interface GitHubAppClientOptions {
  readonly appId: string | number
  readonly installationId: number
  readonly privateKeyFilePath: string
}

export function assertAllowedTarget(repository: string, ref: string, path: string): void {
  if (repository !== WIKI_REPOSITORY) throw new Error('repository is not allowed')
  if (ref !== WIKI_REF) throw new Error('ref is not allowed')
  if (!isAllowedWikiPath(path)) throw new Error('path is not allowed')
}

export function isAllowedWikiPath(path: string): boolean {
  return path === CORRECTIONS_PATH || ALLOWED_PATH.test(path)
}

export async function createGitHubDataClient(options: GitHubAppClientOptions): Promise<GitHubDataClient> {
  const privateKey = await readFile(options.privateKeyFilePath, 'utf8')
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: options.appId,
      privateKey,
      installationId: options.installationId,
    },
  })

  return createGitHubDataClientWithTransport({
    getRef: async params => request(octokit, 'GET /repos/{owner}/{repo}/git/ref/{ref}', params),
    getCommit: async params => request(octokit, 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}', params),
    getTree: async params => request(octokit, 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}', params),
    getBlob: async params => request(octokit, 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}', params),
    createBlob: async params => request(octokit, 'POST /repos/{owner}/{repo}/git/blobs', params),
    createTree: async params => request(octokit, 'POST /repos/{owner}/{repo}/git/trees', params),
    createCommit: async params => request(octokit, 'POST /repos/{owner}/{repo}/git/commits', params),
    updateRef: async params => request(octokit, 'PATCH /repos/{owner}/{repo}/git/refs/{ref}', params),
  })
}

export function createGitHubDataClientWithTransport(transport: GitHubDataTransport): GitHubDataClient {
  const call = async <T>(name: keyof GitHubDataTransport, params: Record<string, unknown>): Promise<T> => {
    const method = transport[name]
    if (method === undefined) throw new Error(`GitHub transport method ${String(name)} is unavailable`)
    return method(params).then(response => response.data as T)
  }

  async function getSnapshot(): Promise<GitHubSnapshot> {
    const ref = await call<{object?: {sha?: unknown}}>('getRef', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      ref: `heads/${WIKI_REF}`,
    })
    const headSha = requireString(ref.object?.sha, 'GitHub ref did not return a head SHA')
    const commit = await getCommit(headSha)
    const tree = await call<{tree?: unknown}>('getTree', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      tree_sha: requireString(commit.treeSha, 'GitHub commit did not return a tree'),
      recursive: '1',
    })
    const entries = Array.isArray(tree.tree) ? tree.tree as GitHubTreeEntry[] : []
    const files: Record<string, string> = {}
    const fileShas: Record<string, string> = {}
    for (const entry of entries) {
      if (entry.type !== 'blob' || typeof entry.path !== 'string' || typeof entry.sha !== 'string') continue
      const blob = await call<{content?: unknown; encoding?: unknown}>('getBlob', {
        owner: WIKI_OWNER,
        repo: WIKI_REPO,
        file_sha: entry.sha,
      })
      files[entry.path] = decodeBlob(blob)
      fileShas[entry.path] = entry.sha
    }
    return {headSha, treeSha: requireString(commit.treeSha, 'GitHub commit did not return a tree'), files, fileShas}
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
    const response = await call<{sha?: unknown}>('createTree', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      base_tree: baseTreeSha,
      tree: entries.map(entry => ({path: entry.path, mode: '100644', type: 'blob', sha: entry.sha})),
    })
    return requireString(response.sha, 'GitHub tree creation did not return a SHA')
  }

  async function createCommit(input: CreateCommitInput): Promise<string> {
    const response = await call<{sha?: unknown}>('createCommit', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      message: input.message,
      tree: input.treeSha,
      parents: [input.parentSha],
      author: input.author ?? {name: 'Fro Bot', email: '41898282+github-actions[bot]@users.noreply.github.com'},
      committer: input.committer ?? {name: 'Fro Bot', email: '41898282+github-actions[bot]@users.noreply.github.com'},
    })
    return requireString(response.sha, 'GitHub commit creation did not return a SHA')
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

  async function getCommit(commitSha: string): Promise<GitHubCommit> {
    const response = await call<{sha?: unknown; message?: unknown; parents?: unknown; tree?: unknown}>('getCommit', {
      owner: WIKI_OWNER,
      repo: WIKI_REPO,
      commit_sha: commitSha,
    })
    const parents = Array.isArray(response.parents)
      ? response.parents
          .map(parent => parent !== null && typeof parent === 'object' ? (parent as {sha?: unknown}).sha : undefined)
          .filter((parent): parent is string => typeof parent === 'string')
      : []
    return {
      sha: requireString(response.sha, 'GitHub commit did not return a SHA'),
      message: typeof response.message === 'string' ? response.message : '',
      parents,
      treeSha: commitTreeSha(response),
    }
  }

  return {getSnapshot, createBlob, createTree, createCommit, updateRef, getCommit}
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

async function request(octokit: Octokit, route: string, params: Record<string, unknown>): Promise<{data: unknown}> {
  return octokit.request(route, params)
}
