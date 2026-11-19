import {Buffer} from 'node:buffer'

const failure = () => new Error('GitHub API request failed')
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface GitHubApiOptions {
  repo: string
  repositoryId?: number
  readToken: string
  writeToken: string
  fetch?: typeof fetch
  timeoutMs?: number
}

/** A repo-bound API client. Credentials and server response bodies never enter errors. */
export function createGitHubApi(options: GitHubApiOptions) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(options.repo) || options.repo.split('/').some(part => part === '.' || part === '..') || !options.readToken || !options.writeToken ||
    (options.repositoryId !== undefined && (!Number.isSafeInteger(options.repositoryId) || options.repositoryId <= 0))) throw failure()
  const prefix = `/repos/${options.repo}`
  const fetcher = options.fetch ?? fetch
  const timeout = options.timeoutMs ?? 15_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw failure()

  function apiUrl(path: string): URL {
    if ((path !== '' && !path.startsWith('/')) || path.startsWith('//') || path.includes('\\')) throw failure()
    let url: URL
    try {
      url = new URL(`https://api.github.com${prefix}${path}`)
    } catch {
      throw failure()
    }
    if (url.origin !== 'https://api.github.com' || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) throw failure()
    return url
  }

  async function request(url: URL, method: 'GET' | 'PUT' | 'POST', body?: unknown, authenticated = true, appRead = false, binary = false): Promise<Response> {
    try {
      const headers = new Headers({accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'x-github-api-version': '2022-11-28'})
      if (authenticated) headers.set('authorization', `Bearer ${method === 'GET' && !appRead ? options.readToken : options.writeToken}`)
      if (body !== undefined) headers.set('content-type', 'application/json')
      return await fetcher(url, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeout)})
    } catch {
      throw failure()
    }
  }

  async function bytes(response: Response, limit: number): Promise<Uint8Array> {
    if (!response.ok || !response.body) throw failure()
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) throw failure()
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > limit) throw failure()
        chunks.push(next.value)
      }
    } catch {
      await reader.cancel().catch(() => {})
      throw failure()
    }
    return Buffer.concat(chunks, size)
  }

  async function jsonResponse(response: Response): Promise<{value: unknown; link: string | null}> {
    try {
      return {value: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await bytes(response, 4 * 1024 * 1024))) as unknown, link: response.headers.get('link')}
    } catch {
      throw failure()
    }
  }

  async function jsonUrl(url: URL): Promise<{value: unknown; link: string | null}> {
    return jsonResponse(await request(url, 'GET'))
  }

  async function pages(path: string, wrapper: string | undefined, appRead: boolean): Promise<unknown[]> {
    let url: URL | null = apiUrl(path)
    url.searchParams.set('per_page', '100')
    const initialPath = url.pathname
    const aliasPath = options.repositoryId === undefined ? null : `/repositories/${options.repositoryId}${initialPath.slice(prefix.length)}`
    const seen = new Set<string>()
    const result: unknown[] = []
    while (url !== null) {
      if (seen.has(url.href) || seen.size >= 100) throw failure()
      seen.add(url.href)
      const {value, link} = await jsonResponse(await request(url, 'GET', undefined, true, appRead))
      const items = wrapper === undefined ? value : object(value) ? value[wrapper] : null
      if (!Array.isArray(items)) throw failure()
      result.push(...items as unknown[])
      if (link === null || link === '') {
        url = null
        continue
      }
      const entries = link.split(',').map(part => /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/u.exec(part))
      if (entries.includes(null)) throw failure()
      const next = entries.filter(entry => entry?.[2] === 'next')
      if (next.length > 1) throw failure()
      if (next.length === 0) {
        url = null
        continue
      }
      const nextUrl = next[0]?.[1]
      if (nextUrl === undefined) throw failure()
      let target: URL
      try {
        target = new URL(nextUrl)
      } catch {
        throw failure()
      }
      if (target.origin !== 'https://api.github.com' || (target.pathname !== initialPath && target.pathname !== aliasPath) || target.username || target.password || target.hash) throw failure()
      const currentQuery = new URLSearchParams(url.search)
      const nextQuery = new URLSearchParams(target.search)
      const currentPage = currentQuery.get('page') ?? '1'
      const nextPage = nextQuery.get('page')
      currentQuery.delete('page')
      nextQuery.delete('page')
      currentQuery.sort()
      nextQuery.sort()
      if (!/^\d+$/u.test(currentPage) || nextPage === null || !/^\d+$/u.test(nextPage) ||
        Number(nextPage) !== Number(currentPage) + 1 || currentQuery.toString() !== nextQuery.toString()) throw failure()
      url = target
    }
    return result
  }

  return {
    repo: options.repo,
    async get(path: string): Promise<unknown> { return (await jsonUrl(apiUrl(path))).value },
    async getOptional(path: string): Promise<unknown | null> {
      if (path !== '/git/ref/heads/release/pending') throw failure()
      const response = await request(apiUrl(path), 'GET')
      if (response.status === 404) return null
      const value = (await jsonResponse(response)).value
      if (value === null) throw failure()
      return value
    },
    async appRuleset(rulesetId: number): Promise<unknown> {
      if (!Number.isSafeInteger(rulesetId) || rulesetId <= 0) throw failure()
      return (await jsonResponse(await request(apiUrl(`/rulesets/${rulesetId}`), 'GET', undefined, true, true))).value
    },
    /** slug must come from an independently authenticated App configuration/read. */
    async botUser(slug: string): Promise<{id: number; login: string} | null> {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u.test(slug)) return null
      const login = `${slug}[bot]`
      const user = (await jsonUrl(new URL(`https://api.github.com/users/${encodeURIComponent(login)}`))).value
      return object(user) && user.type === 'Bot' && user.login === login && typeof user.id === 'number' && Number.isSafeInteger(user.id) && user.id > 0
        ? {id: user.id, login}
        : null
    },
    async put(path: string, body: unknown): Promise<void> {
      if (!/^\/pulls\/[1-9]\d*\/merge$/u.test(path)) throw failure()
      const response = await request(apiUrl(path), 'PUT', body)
      if (!response.ok) throw failure()
      await bytes(response, 1024 * 1024)
    },
    async post(path: string, body: unknown): Promise<unknown> {
      if (path !== '/pulls' && !/^\/issues\/[1-9]\d*\/labels$/u.test(path)) throw failure()
      return (await jsonResponse(await request(apiUrl(path), 'POST', body))).value
    },
    async pages(path: string, wrapper?: string): Promise<unknown[]> { return pages(path, wrapper, false) },
    async releasePages(): Promise<unknown[]> { return pages('/releases', undefined, true) },
    async releaseAssetPages(releaseId: number): Promise<unknown[]> {
      if (!Number.isSafeInteger(releaseId) || releaseId <= 0) throw failure()
      return pages(`/releases/${releaseId}/assets`, undefined, true)
    },
    async releaseAssetBytes(assetId: number): Promise<Uint8Array> {
      if (!Number.isSafeInteger(assetId) || assetId <= 0) throw failure()
      const response = await request(apiUrl(`/releases/assets/${assetId}`), 'GET', undefined, true, true, true)
      if (response.status === 200) return bytes(response, 16 * 1024)
      if (![301, 302, 303, 307, 308].includes(response.status)) throw failure()
      let location: URL
      try {
        location = new URL(response.headers.get('location') ?? '')
      } catch { throw failure() }
      if (location.protocol !== 'https:' || location.username || location.password || location.hash) throw failure()
      const download = await request(location, 'GET', undefined, false, false, true)
      if (download.status !== 200) throw failure()
      return bytes(download, 16 * 1024)
    },
    async uploadReceipt(releaseId: number, content: Uint8Array): Promise<void> {
      if (!Number.isSafeInteger(releaseId) || releaseId <= 0 || content.length === 0 || content.length > 16 * 1024) throw failure()
      const url = new URL(`https://uploads.github.com/repos/${options.repo}/releases/${releaseId}/assets`)
      url.searchParams.set('name', 'release-proof.json')
      try {
        const response = await fetcher(url, {method: 'POST', headers: {authorization: `Bearer ${options.writeToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json'}, body: Buffer.from(content), redirect: 'manual', signal: AbortSignal.timeout(timeout)})
        if (response.status !== 201) throw failure()
        await bytes(response, 1024 * 1024)
      } catch { throw failure() }
    },
    async artifactZip(artifactId: number): Promise<Uint8Array> {
      if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw failure()
      const response = await request(apiUrl(`/actions/artifacts/${artifactId}/zip`), 'GET')
      if (![301, 302, 303, 307, 308].includes(response.status)) throw failure()
      let location: URL
      try {
        location = new URL(response.headers.get('location') ?? '')
      } catch {
        throw failure()
      }
      if (location.protocol !== 'https:' || location.username || location.password || location.hash) throw failure()
      return bytes(await request(location, 'GET', undefined, false), 16 * 1024 * 1024)
    },
  }
}

export type GitHubApi = ReturnType<typeof createGitHubApi>
