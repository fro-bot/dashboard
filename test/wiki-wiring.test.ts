import {Buffer} from 'node:buffer'
import {describe, expect, it, vi} from 'vitest'
import {readTokenSource} from '../src/wiki/data-client.ts'
import {buildWikiAppDeps, createWikiReadTokenSource, type WikiWriteWiring} from '../src/wiki/wiring.ts'

const ORIGIN = 'https://dashboard.fro.bot'

describe('createWikiReadTokenSource', () => {
  it('resolves the installation once inside its lifetime and mints a read-only token for it', async () => {
    let now = 1000
    const resolveInstallationId = vi.fn(async () => 7_100_001)
    const mint = vi.fn(async (_installationId: number, _permissions: Record<string, 'read'>) => 'read-token')
    const source = createWikiReadTokenSource({resolveInstallationId, mint, now: () => now})

    await expect(source.getToken()).resolves.toBe('read-token')
    now += 60_000
    await expect(source.getToken()).resolves.toBe('read-token')

    expect(resolveInstallationId).toHaveBeenCalledTimes(1)
    expect(mint).toHaveBeenCalledTimes(1)
    expect(mint).toHaveBeenCalledWith(7_100_001, expect.objectContaining({contents: 'read'}))
    for (const level of Object.values(mint.mock.calls[0]?.[1] ?? {})) expect(level).toBe('read')
  })

  it('resolves the installation again after its bounded lifetime', async () => {
    let now = 1000
    const resolveInstallationId = vi.fn(async () => 7_100_002)
    const source = createWikiReadTokenSource({resolveInstallationId, mint: async () => 'read-token', now: () => now})

    await source.getToken()
    now += 10 * 60_000
    await source.getToken()

    expect(resolveInstallationId).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed installation lookup', async () => {
    const resolveInstallationId = vi.fn().mockRejectedValueOnce(new Error('lookup failed')).mockResolvedValue(7_100_003)
    const source = createWikiReadTokenSource({resolveInstallationId, mint: async () => 'read-token'})

    await expect(source.getToken()).rejects.toThrow('lookup failed')
    await expect(source.getToken()).resolves.toBe('read-token')
  })

  it.each([
    ['undefined', undefined],
    ['zero', 0],
    ['a negative ID', -4],
    ['a fraction', 1.5],
    ['a string', '7100001'],
    ['NaN', Number.NaN],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses %s as an installation ID and never mints or caches it', async (label, id) => {
    // The read mint caches per installation ID, so each case uses its own valid ID.
    const validId = 7_200_000 + label.length
    const resolveInstallationId = vi.fn().mockResolvedValueOnce(id).mockResolvedValue(validId)
    const mint = vi.fn(async () => 'read-token')
    const source = createWikiReadTokenSource({
      resolveInstallationId,
      mint,
    })

    await expect(source.getToken()).rejects.toThrow(/installation/iu)
    expect(mint).not.toHaveBeenCalled()
    await expect(source.getToken()).resolves.toBe('read-token')
    expect(resolveInstallationId).toHaveBeenCalledTimes(2)
    expect(mint).toHaveBeenCalledWith(validId, expect.anything())
  })

  it('is a read token source', () => {
    expect(createWikiReadTokenSource({resolveInstallationId: async () => 1, mint: async () => 't'}).kind).toBe('read-token-source')
  })
})

function recordingFetch() {
  const seen: {method: string; path: string; authorization: string}[] = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    seen.push({method: init?.method ?? 'GET', path: decodeURIComponent(url.pathname), authorization: headers.get('authorization') ?? ''})
    const path = decodeURIComponent(url.pathname)
    const json = (body: unknown) => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}})
    if (path.endsWith('/git/ref/heads/data')) return json({object: {sha: 'head-1'}})
    if (path.endsWith('/git/commits/head-1')) return json({sha: 'head-1', tree: {sha: 'tree-1'}, message: '', parents: []})
    if (path.includes('/git/trees/')) return json({tree: [{path: 'knowledge/wiki/topics/a.md', type: 'blob', sha: 'b1'}]})
    if (path.includes('/git/blobs/')) {
      const content = '---\ntype: topic\ntitle: A\ncreated: 2026-01-01\nupdated: 2026-01-02\n---\n\n# A\n'
      return json({content: Buffer.from(content).toString('base64'), encoding: 'base64'})
    }
    if (path.endsWith('/dispatches')) return new Response(null, {status: 204})
    return json({})
  })
  return {impl: impl as unknown as typeof fetch, seen}
}

describe('buildWikiAppDeps', () => {
  const enabled = (getWriteToken: () => Promise<string>, invalidate: (token: string) => void = () => {}): WikiWriteWiring => ({
    enabled: true,
    config: {enabled: true, appId: '1', privateKey: 'k', operatorId: 4242, dashboardOrigin: ORIGIN},
    tokens: {getWriteToken, invalidate},
  })

  it('reads pages with the read token only and sends the dispatch with the write token only', async () => {
    const getWriteToken = vi.fn(async () => 'write-token')
    const read = vi.fn(async () => 'read-token')
    const net = recordingFetch()
    const deps = buildWikiAppDeps({readTokens: readTokenSource(read), write: enabled(getWriteToken), fetch: net.impl})

    const listed = await deps.pages?.listPages()
    expect(listed?.success).toBe(true)
    expect(getWriteToken).not.toHaveBeenCalled()
    expect(net.seen.length).toBeGreaterThan(0)
    expect(net.seen.every(entry => entry.authorization.includes('read-token'))).toBe(true)

    net.seen.length = 0
    const readCalls = read.mock.calls.length
    await expect(deps.write?.dispatch.dispatch()).resolves.toEqual({ok: true})
    expect(read).toHaveBeenCalledTimes(readCalls)
    expect(net.seen).toEqual([{method: 'POST', path: '/repos/fro-bot/.github/dispatches', authorization: expect.stringContaining('write-token') as string}])
    expect(getWriteToken).toHaveBeenCalledTimes(1)
  })

  it('evicts the write token and retries once when GitHub answers 401, through the token provider', async () => {
    const getWriteToken = vi.fn().mockResolvedValueOnce('stale-write-token').mockResolvedValue('fresh-write-token')
    const invalidate = vi.fn()
    const seen: string[] = []
    const net = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      seen.push(authorization)
      return authorization.includes('stale') ? new Response('{}', {status: 401}) : new Response(null, {status: 204})
    })
    const deps = buildWikiAppDeps({
      readTokens: readTokenSource(async () => 'read-token'),
      write: enabled(getWriteToken, invalidate),
      fetch: net,
    })

    await expect(deps.write?.dispatch.dispatch()).resolves.toEqual({ok: true})

    expect(invalidate).toHaveBeenCalledExactlyOnceWith('stale-write-token')
    expect(seen).toEqual(['token stale-write-token', 'token fresh-write-token'])
  })

  it('reports a persistent 401 on the dispatch as a failure after one retry', async () => {
    const invalidate = vi.fn()
    const net = vi.fn(async () => new Response('{}', {status: 401}))
    const deps = buildWikiAppDeps({
      readTokens: readTokenSource(async () => 'read-token'),
      write: enabled(async () => 'write-token', invalidate),
      fetch: net,
    })

    await expect(deps.write?.dispatch.dispatch()).resolves.toMatchObject({ok: false})

    expect(net).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('carries the configured operator ID and origin into the policy, with no fixture identity', () => {
    const deps = buildWikiAppDeps({readTokens: readTokenSource(async () => 't'), write: enabled(async () => 'w')})

    expect(deps.policy).toEqual({
      capability: {enabled: true, operatorId: 4242, dashboardOrigin: ORIGIN},
      fixtureOperatorLogin: null,
    })
    expect(deps.write).not.toBeNull()
  })

  it.each(['app-credentials-absent', 'app-credentials-incomplete', 'operator-id-unset'] as const)(
    'builds no write side and reports %s when write capability is off',
    reason => {
      const deps = buildWikiAppDeps({readTokens: readTokenSource(async () => 't'), write: {enabled: false, reason}})

      expect(deps.write).toBeNull()
      expect(deps.pages).not.toBeNull()
      expect(deps.policy).toEqual({capability: {enabled: false, reason}, fixtureOperatorLogin: null})
    },
  )

  it('leaves pages unavailable when there are no read credentials, and still builds the write side', () => {
    const deps = buildWikiAppDeps({readTokens: null, write: enabled(async () => 'w')})

    expect(deps.pages).toBeNull()
    expect(deps.write).not.toBeNull()
  })

  it('shares nothing it should not: a write token failure never reaches the read side', async () => {
    const net = recordingFetch()
    const deps = buildWikiAppDeps({
      readTokens: readTokenSource(async () => 'read-token'),
      write: enabled(async () => {
        throw new Error('mint failed')
      }),
      fetch: net.impl,
    })

    await expect(deps.write?.dispatch.dispatch()).resolves.toMatchObject({ok: false})
    expect((await deps.pages?.listPages())?.success).toBe(true)
  })
})
