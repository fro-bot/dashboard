import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {describe, expect, it} from 'vitest'
import {createGitHubApi} from '../scripts/release/github-release-api.ts'

const expected = {repo: 'fro-bot/dashboard', releaseId: 42, version: '2026.11.1', source: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}`}
const bot = {id: 17, login: 'fro-bot[bot]'}
const content = JSON.stringify({schema: 1, ...expected})
const hash = (data: string) => `sha256:${createHash('sha256').update(data).digest('hex')}`
const asset = (overrides: Record<string, unknown> = {}) => ({id: 55, name: 'release-proof.json', state: 'uploaded', size: Buffer.byteLength(content), digest: hash(content), uploader: {...bot, type: 'Bot'}, ...overrides})

async function receiptModule() {
  return import('../scripts/release/release-receipt.ts')
}

describe('release receipt transport', () => {
  it('exposes the receipt reader and writer', async () => {
    const module = await receiptModule().catch(() => null)
    expect(module).not.toBeNull()
    expect(module?.readReleaseReceipt).toBeTypeOf('function')
    expect(module?.uploadReleaseReceipt).toBeTypeOf('function')
  })
  it('exposes scoped release asset operations', () => {
    const api = createGitHubApi({repo: 'fro-bot/dashboard', readToken: 'read', writeToken: 'app'})
    expect(Reflect.get(api, 'releaseAssetPages')).toBeTypeOf('function')
    expect(Reflect.get(api, 'releaseAssetBytes')).toBeTypeOf('function')
    expect(Reflect.get(api, 'uploadReceipt')).toBeTypeOf('function')
  })

  it('reads a unique exact receipt across pages with App auth and no CDN credentials', async () => {
    const {readReleaseReceipt} = await receiptModule()
    const calls: {url: string; headers: Headers}[] = []
    const api = createGitHubApi({repo: expected.repo, readToken: 'read', writeToken: 'app', fetch: async (input, init) => {
      const url = String(input)
      calls.push({url, headers: new Headers(init?.headers)})
      if (url.includes('/assets?') && !url.includes('page=2')) return Response.json([{id: 3, name: 'other'}], {headers: {link: '<https://api.github.com/repos/fro-bot/dashboard/releases/42/assets?per_page=100&page=2>; rel="next"'}})
      if (url.includes('page=2')) return Response.json([asset()])
      if (url.includes('/releases/assets/55')) return new Response(null, {status: 302, headers: {location: 'https://cdn.example/asset'}})
      return new Response(content)
    }})
    expect(await readReleaseReceipt(api, expected, bot)).toEqual({state: 'present', value: expected})
    expect(calls.map(c => c.headers.get('authorization'))).toEqual(['Bearer app', 'Bearer app', 'Bearer app', null])
    expect(calls[2]?.headers.get('accept')).toBe('application/octet-stream')
  })

  it('distinguishes absent from ambiguous, malformed, tampered or untrusted assets', async () => {
    const {readReleaseReceipt} = await receiptModule()
    const cases: {assets: unknown[]; body?: string; result: string}[] = [
      {assets: [], result: 'absent'},
      {assets: [asset(), asset({id: 56})], result: 'unknown'},
      {assets: [asset({id: 0})], result: 'unknown'},
      {assets: [asset({state: 'new'})], result: 'unknown'},
      {assets: [asset({size: 16385})], result: 'unknown'},
      {assets: [asset({uploader: {...bot, id: 18, type: 'Bot'}})], result: 'unknown'},
      {assets: [asset({uploader: {...bot, login: 'other[bot]', type: 'Bot'}})], result: 'unknown'},
      {assets: [asset({uploader: {...bot, type: 'User'}})], result: 'unknown'},
      {assets: [{}], result: 'unknown'},
      {assets: [asset()], body: content.replace('2026.11.1', '2026.11.2'), result: 'unknown'},
      {assets: [asset({digest: 'sha256:bad'})], result: 'unknown'},
      {assets: [asset({size: 1})], result: 'unknown'},
      {assets: [asset({size: Buffer.byteLength(`${content} `), digest: hash(`${content} `)})], body: `${content} `, result: 'unknown'},
      {assets: [asset({size: Buffer.byteLength(content.replace('"schema":1', '"schema":2')), digest: hash(content.replace('"schema":1', '"schema":2'))})], body: content.replace('"schema":1', '"schema":2'), result: 'unknown'},
    ]
    for (const test of cases) {
      const api = createGitHubApi({repo: expected.repo, readToken: 'read', writeToken: 'app', fetch: async input => String(input).includes('/assets?') ? Response.json(test.assets) : new Response(test.body ?? content)})
      expect((await readReleaseReceipt(api, expected, bot)).state).toBe(test.result)
    }
  })

  it('rejects a receipt for a different expected tuple and unreadable downloads', async () => {
    const {readReleaseReceipt} = await receiptModule()
    const api = createGitHubApi({repo: expected.repo, readToken: 'read', writeToken: 'app', fetch: async input => String(input).includes('/assets?') ? Response.json([asset()]) : new Response(content)})
    expect((await readReleaseReceipt(api, {...expected, source: 'c'.repeat(40)}, bot)).state).toBe('unknown')
    expect((await readReleaseReceipt(api, {...expected, releaseId: 43}, bot)).state).toBe('unknown')
    const broken = createGitHubApi({repo: expected.repo, readToken: 'read', writeToken: 'app', fetch: async input => String(input).includes('/assets?') ? Response.json([asset()]) : new Response(null, {status: 403})})
    expect((await readReleaseReceipt(broken, expected, bot)).state).toBe('unknown')
  })

  it('uploads canonical fixed-name JSON once using the App token', async () => {
    const {uploadReleaseReceipt} = await receiptModule()
    const calls: {url: string; init: RequestInit}[] = []
    const api = createGitHubApi({repo: expected.repo, readToken: 'read', writeToken: 'app', fetch: async (input, init) => {
      calls.push({url: String(input), init: init ?? {}})
      return Response.json({id: 55}, {status: 201})
    }})
    await uploadReleaseReceipt(api, expected)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://uploads.github.com/repos/fro-bot/dashboard/releases/42/assets?name=release-proof.json')
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer app')
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json')
    expect(Buffer.from(calls[0]?.init.body as Uint8Array).toString('utf8')).toBe(content)
  })

  it('rejects unsafe redirects and bounds streamed downloads', async () => {
    const {readReleaseReceipt} = await receiptModule()
    for (const response of [new Response(null, {status: 302, headers: {location: 'http://cdn.example/x'}}), new Response('x'.repeat(16385)), new Response(null, {status: 302, headers: {location: 'https://user:pass@cdn.example/x'}})]) {
      const api = createGitHubApi({repo: expected.repo, readToken: 'read', writeToken: 'app', fetch: async input => String(input).includes('/assets?') ? Response.json([asset()]) : response})
      expect((await readReleaseReceipt(api, expected, bot)).state).toBe('unknown')
    }
  })

  it('does not follow a second redirect or upload invalid identities', async () => {
    const {readReleaseReceipt, uploadReleaseReceipt} = await receiptModule()
    const calls: string[] = []
    const api = createGitHubApi({repo: expected.repo, readToken: 'read', writeToken: 'app', fetch: async input => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/assets?')) return Response.json([asset()])
      return new Response(null, {status: 302, headers: {location: 'https://cdn.example/next'}})
    }})
    expect((await readReleaseReceipt(api, expected, bot)).state).toBe('unknown')
    expect(calls).toHaveLength(3)
    await expect(uploadReleaseReceipt(api, {...expected, repo: 'other/repo'})).rejects.toThrow('Invalid release receipt')
    expect(calls).toHaveLength(3)
  })
})
