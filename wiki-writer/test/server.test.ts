import {Buffer} from 'node:buffer'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createRequestSignature} from '../src/internal-auth.ts'
import {createWikiWriterApp} from '../src/server.ts'

const SECRET = Buffer.from('wiki-writer-server-secret-which-is-long-enough')
const NOW = 1_756_000_000

function signedRequest(method: string, path: string, body: string, requestId: string): Request {
  const timestamp = String(NOW)
  const rawBody = Buffer.from(body)
  return new Request(`http://wiki-writer.test${path}`, {
    method,
    headers: {
      'x-request-id': requestId,
      'x-timestamp': timestamp,
      'x-signature': createRequestSignature(SECRET, method, path, timestamp, rawBody, requestId),
    },
    body: method === 'GET' ? undefined : rawBody,
  })
}

describe('wiki-writer HTTP boundary', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(temporaryDirectories.splice(0).map(async directory => rm(directory, {recursive: true, force: true})))
  })

  async function createApp(authorizeOperation = vi.fn().mockResolvedValue({allowed: true})) {
    const directory = await mkdtemp(join(tmpdir(), 'wiki-writer-server-'))
    temporaryDirectories.push(directory)
    const secretPath = join(directory, 'secret')
    await writeFile(secretPath, SECRET)
    return {
      app: await createWikiWriterApp({secretFilePath: secretPath, nowSeconds: () => NOW, authorizeOperation}),
      authorizeOperation,
    }
  }

  it('returns only the documented readiness shape for an authenticated health request', async () => {
    const {app} = await createApp()
    const response = await app.fetch(signedRequest('GET', '/healthz', '', 'health-001'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ready: true})
  })

  it('sends an authenticated write envelope to the operation authorization seam', async () => {
    const authorizeOperation = vi.fn().mockResolvedValue({allowed: true})
    const {app} = await createApp(authorizeOperation)
    const body = JSON.stringify({operation: 'write', repository: 'fro-bot/.github', ref: 'data', path: 'knowledge/wiki/page.md', content: '# Test'})
    const response = await app.fetch(signedRequest('POST', '/write', body, 'write-001'))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({accepted: true})
    expect(authorizeOperation).toHaveBeenCalledWith({
      operation: 'write',
      repository: 'fro-bot/.github',
      ref: 'data',
      path: 'knowledge/wiki/page.md',
      content: '# Test',
    })
  })

  it('does not invoke the operation seam for rejected authentication or replay', async () => {
    const authorizeOperation = vi.fn().mockResolvedValue({allowed: true})
    const {app} = await createApp(authorizeOperation)
    const body = JSON.stringify({operation: 'write', repository: 'fro-bot/.github', ref: 'data', path: 'knowledge/wiki/page.md', content: '# Test'})
    const request = signedRequest('POST', '/write', body, 'rejection-001')
    const first = await app.fetch(request)
    const second = await app.fetch(signedRequest('POST', '/write', body, 'rejection-001'))
    expect(first.status).toBe(202)
    expect(second.status).toBe(401)
    expect(authorizeOperation).toHaveBeenCalledTimes(1)
  })

  it('rejects caller-supplied Authorization and alternate credential headers without treating them as auth', async () => {
    const authorizeOperation = vi.fn().mockResolvedValue({allowed: true})
    const {app} = await createApp(authorizeOperation)
    const body = JSON.stringify({operation: 'write', repository: 'fro-bot/.github', ref: 'data', path: 'knowledge/wiki/page.md', content: '# Test'})
    const request = signedRequest('POST', '/write', body, 'credential-001')
    request.headers.set('authorization', 'Bearer caller-token')
    request.headers.set('x-api-key', 'caller-key')

    const response = await app.fetch(request)
    expect(response.status).toBe(401)
    expect(authorizeOperation).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({error: 'unauthorized'})
  })

  it('never exposes credential material or request content in health and error responses', async () => {
    const {app} = await createApp()
    const response = await app.fetch(signedRequest('GET', '/healthz', '', 'safe-health-001'))
    const text = await response.text()
    expect(text).not.toContain('wiki-writer-server-secret')
    expect(text).not.toContain('safe-health-001')
    expect(text).not.toContain('repository')
  })
})
