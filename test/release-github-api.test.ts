import {describe, expect, it} from 'vitest'
import {createGitHubApi} from '../scripts/release/github-release-api.ts'

describe('release GitHub API', () => {
  it('reads all pages using only the read credential', async () => {
    const calls: {url: string; init: RequestInit}[] = []
    const api = createGitHubApi({repo: 'fro-bot/dashboard', readToken: 'read-secret', writeToken: 'write-secret', fetch: async (input, init) => {
      calls.push({url: String(input), init: init ?? {}})
      return new Response(JSON.stringify(calls.length === 1 ? {items: [1]} : {items: [2]}), {headers: calls.length === 1 ? {link: '<https://api.github.com/repos/fro-bot/dashboard/things?per_page=100&page=2>; rel="next"'} : {}})
    }})
    expect(await api.pages('/things', 'items')).toEqual([1, 2])
    expect(calls).toHaveLength(2)
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer read-secret')
  })

  it('rejects foreign pagination and sanitizes failures', async () => {
    const api = createGitHubApi({repo: 'fro-bot/dashboard', readToken: 'secret', writeToken: 'other', fetch: async () => new Response('[]', {headers: {link: '<https://evil.example/next>; rel="next"'}})})
    await expect(api.pages('/things')).rejects.toThrow('GitHub API request failed')
  })

  it('reads the independently specified App bot user with the read credential', async () => {
    const calls: {url: string; headers: Headers}[] = []
    const api = createGitHubApi({repo: 'fro-bot/dashboard', readToken: 'read', writeToken: 'write', fetch: async (input, init) => {
      calls.push({url: String(input), headers: new Headers(init?.headers)})
      return Response.json({id: 345, login: 'fro-bot[bot]', type: 'Bot'})
    }})
    expect(await api.botUser('fro-bot')).toEqual({id: 345, login: 'fro-bot[bot]'})
    expect(calls[0]?.url).toBe('https://api.github.com/users/fro-bot%5Bbot%5D')
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer read')
    expect(await api.botUser('../oops')).toBeNull()
    expect(calls).toHaveLength(1)
    await expect(api.put('/contents/main', {})).rejects.toThrow('GitHub API request failed')
  })

  it('limits app-scoped reads and candidate writes to fixed endpoints', async () => {
    const calls: {url: string; headers: Headers; method: string}[] = []
    const api = createGitHubApi({repo: 'fro-bot/dashboard', readToken: 'read', writeToken: 'app', fetch: async (input, init) => {
      const url = String(input)
      calls.push({url, headers: new Headers(init?.headers), method: String(init?.method)})
      if (url.endsWith('/git/ref/heads/release/pending')) return new Response(null, {status: 404})
      return Response.json({id: 1})
    }})
    expect(await api.get('')).toEqual({id: 1})
    expect(await api.getOptional('/git/ref/heads/release/pending')).toBeNull()
    expect(await api.appRuleset(23)).toEqual({id: 1})
    await api.post('/pulls', {title: 'candidate'})
    await api.post('/issues/7/labels', {labels: ['hold']})
    expect(calls[2]?.headers.get('authorization')).toBe('Bearer app')
    expect(calls.slice(3).map(call => call.method)).toEqual(['POST', 'POST'])
    await expect(api.post('/issues/7/comments', {})).rejects.toThrow('GitHub API request failed')
    await expect(api.getOptional('/anything')).rejects.toThrow('GitHub API request failed')
  })

  it('follows a numeric repository alias only when independently bound', async () => {
    let calls = 0
    const api = createGitHubApi({repo: 'fro-bot/dashboard', repositoryId: 99, readToken: 'read', writeToken: 'app', fetch: async () => {
      calls++
      return Response.json(calls === 1 ? [1] : [2], {headers: calls === 1 ? {link: '<https://api.github.com/repositories/99/things?per_page=100&page=2>; rel="next"'} : {}})
    }})
    expect(await api.pages('/things')).toEqual([1, 2])
  })

  it('never turns other optional-read failures into absence', async () => {
    for (const response of [new Response(null, {status: 403}), Response.json(null)]) {
      const api = createGitHubApi({repo: 'fro-bot/dashboard', readToken: 'read', writeToken: 'app', fetch: async () => response})
      await expect(api.getOptional('/git/ref/heads/release/pending')).rejects.toThrow('GitHub API request failed')
    }
  })

  it('rejects pagination that changes filters or repository identity', async () => {
    for (const link of ['https://api.github.com/repositories/100/things?state=open&per_page=100&page=2', 'https://api.github.com/repositories/99/things?state=closed&per_page=100&page=2']) {
      const api = createGitHubApi({repo: 'fro-bot/dashboard', repositoryId: 99, readToken: 'read', writeToken: 'app', fetch: async () => Response.json([], {headers: {link: `<${link}>; rel="next"`}})})
      await expect(api.pages('/things?state=open')).rejects.toThrow('GitHub API request failed')
    }
  })

  it('paginates release drafts with the App token, not the read token', async () => {
    const calls: {url: string; token: string | null}[] = []
    const api = createGitHubApi({repo: 'fro-bot/dashboard', readToken: 'read', writeToken: 'app', fetch: async (input, init) => {
      calls.push({url: String(input), token: new Headers(init?.headers).get('authorization')})
      return Response.json(calls.length === 1 ? [{id: 1, draft: true}] : [{id: 2}], {headers: calls.length === 1 ? {link: '<https://api.github.com/repos/fro-bot/dashboard/releases?per_page=100&page=2>; rel="next"'} : {}})
    }})
    expect(await api.releasePages()).toEqual([{id: 1, draft: true}, {id: 2}])
    expect(calls.map(call => call.token)).toEqual(['Bearer app', 'Bearer app'])
  })
})
