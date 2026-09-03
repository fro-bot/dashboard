import type {WikiWriterApp} from '../src/contract.ts'
import {Buffer} from 'node:buffer'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {request as httpRequest} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createRequestSignature} from '../src/internal-auth.ts'
import {createWikiWriterApp, createWikiWriterAppWithInjectedSecret, createWikiWriterHttpServer, WIKI_WRITER_MAX_RAW_BYTES} from '../src/server.ts'

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

function sizedWriteBody(size: number): string {
  const emptyBody = JSON.stringify({operation: 'write', repository: 'fixture-org/fixture-repo', ref: 'data', path: 'fixture.md', content: ''})
  const contentLength = size - Buffer.byteLength(emptyBody)
  if (contentLength < 0) throw new Error('Requested body size is too small for the write envelope')
  return JSON.stringify({operation: 'write', repository: 'fixture-org/fixture-repo', ref: 'data', path: 'fixture.md', content: 'x'.repeat(contentLength)})
}

interface HttpResult {
  readonly status: number
  readonly body: string
}

async function invokeNodeServer(
  app: WikiWriterApp,
  body: Buffer,
  headers: Record<string, string>,
  contentLength: number | undefined,
  sendBody = true,
): Promise<HttpResult> {
  const server = createWikiWriterHttpServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Test server did not expose a TCP address')

  try {
    return await new Promise<HttpResult>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: '/write',
        headers: {
          ...headers,
          ...(contentLength === undefined ? {} : {'content-length': String(contentLength)}),
        },
      }, response => {
        response.setEncoding('utf8')
        const chunks: string[] = []
        response.on('data', (chunk: string) => chunks.push(chunk))
        response.on('end', () => resolve({status: response.statusCode ?? 0, body: chunks.join('')}))
      })
      request.on('error', reject)
      if (sendBody) {
        if (contentLength === undefined && body.length > WIKI_WRITER_MAX_RAW_BYTES) {
          request.write(body.subarray(0, WIKI_WRITER_MAX_RAW_BYTES))
          request.end(body.subarray(WIKI_WRITER_MAX_RAW_BYTES))
        } else {
          request.end(body)
        }
      } else {
        request.end()
      }
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error))))
  }
}

describe('wiki-writer HTTP boundary', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(temporaryDirectories.splice(0).map(async directory => rm(directory, {recursive: true, force: true})))
  })

  async function createApp(
    authorizeOperation = vi.fn().mockResolvedValue({allowed: true}),
    audit = vi.fn(),
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'wiki-writer-server-'))
    temporaryDirectories.push(directory)
    const secretPath = join(directory, 'secret')
    await writeFile(secretPath, SECRET)
    return {
      app: await createWikiWriterApp({secretFilePath: secretPath, nowSeconds: () => NOW, authorizeOperation, audit}),
      authorizeOperation,
      audit,
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

  it('maps the injected write operation result onto the writer wire contract', async () => {
    const writeOperation = {
      execute: vi.fn().mockResolvedValue({state: 'indeterminate', operationId: '11111111-1111-4111-8111-111111111111'}),
    }
    const body = JSON.stringify({
      operation: 'write',
      repository: 'fro-bot/.github',
      ref: 'data',
      path: 'knowledge/wiki/page.md',
      content: '# Test',
      operationId: '11111111-1111-4111-8111-111111111111',
      expectedParentSha: 'head-1',
    })
    const injectedApp = createWikiWriterAppWithInjectedSecret(SECRET, {
      nowSeconds: () => NOW,
      writeOperation,
    })

    const response = await injectedApp.fetch(signedRequest('POST', '/write', body, 'write-operation-001'))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({accepted: true, status: 'indeterminate', operationId: '11111111-1111-4111-8111-111111111111'})
    expect(writeOperation.execute).toHaveBeenCalledOnce()
  })

  it('rejects malformed corrections before invoking the write operation', async () => {
    const writeOperation = {execute: vi.fn().mockResolvedValue({state: 'succeeded', operationId: 'op', commitSha: 'sha'})}
    const body = JSON.stringify({
      operation: 'write',
      repository: 'fro-bot/.github',
      ref: 'data',
      path: 'knowledge/wiki/page.md',
      content: '# Test',
      operationId: '11111111-1111-4111-8111-111111111111',
      expectedParentSha: 'head-1',
      corrections: [{}],
    })
    const injectedApp = createWikiWriterAppWithInjectedSecret(SECRET, {nowSeconds: () => NOW, writeOperation})

    const response = await injectedApp.fetch(signedRequest('POST', '/write', body, 'malformed-corrections-001'))

    expect(response.status).toBe(400)
    expect(writeOperation.execute).not.toHaveBeenCalled()
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

  it('accepts a write body exactly at the one MiB raw envelope ceiling', async () => {
    const authorizeOperation = vi.fn().mockResolvedValue({allowed: true})
    const {app} = await createApp(authorizeOperation)
    const body = sizedWriteBody(WIKI_WRITER_MAX_RAW_BYTES)
    expect(Buffer.byteLength(body)).toBe(WIKI_WRITER_MAX_RAW_BYTES)

    const response = await app.fetch(signedRequest('POST', '/write', body, 'limit-boundary-001'))
    expect(response.status).toBe(202)
    expect(authorizeOperation).toHaveBeenCalledOnce()
  })

  it('rejects a validly signed body one byte over the ceiling before HMAC or operation authorization', async () => {
    const authorizeOperation = vi.fn().mockResolvedValue({allowed: true})
    const {app, audit} = await createApp(authorizeOperation)
    const body = sizedWriteBody(WIKI_WRITER_MAX_RAW_BYTES + 1)
    const response = await app.fetch(signedRequest('POST', '/write', body, 'limit-over-001'))

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({error: 'payload-too-large'})
    expect(authorizeOperation).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith({outcome: 'rejected', reasonClass: 'body_too_large', requestId: 'limit-over-001'})
  })

  it('emits only the bounded audit event for an oversize direct request, never the body', async () => {
    const audit = vi.fn()
    const {app} = await createApp(vi.fn().mockResolvedValue({allowed: true}), audit)
    const body = sizedWriteBody(WIKI_WRITER_MAX_RAW_BYTES + 1)
    const response = await app.fetch(signedRequest('POST', '/write', body, 'limit-audit-001'))
    expect(response.status).toBe(413)
    expect(audit).toHaveBeenCalledWith({outcome: 'rejected', reasonClass: 'body_too_large', requestId: 'limit-audit-001'})
    expect(JSON.stringify(audit.mock.calls)).not.toContain(body)
  })

  it('rejects an oversize chunked Node request with no content-length while reading it', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({accepted: true}), {status: 202}))
    const rejectBodyTooLarge = vi.fn(() => new Response(JSON.stringify({error: 'payload-too-large'}), {status: 413}))
    const app: WikiWriterApp = {fetch, rejectBodyTooLarge}
    const body = Buffer.from(sizedWriteBody(WIKI_WRITER_MAX_RAW_BYTES + 1))
    const timestamp = String(NOW)
    const requestId = 'limit-stream-001'
    const headers = {
      'x-request-id': requestId,
      'x-timestamp': timestamp,
      'x-signature': createRequestSignature(SECRET, 'POST', '/write', timestamp, body, requestId),
    }

    const result = await invokeNodeServer(app, body, headers, undefined)
    expect(result.status).toBe(413)
    expect(fetch).not.toHaveBeenCalled()
    expect(rejectBodyTooLarge).toHaveBeenCalledWith(requestId)
  })

  it('rejects a content-length oversize request before reading or invoking the app boundary', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('fetch must not be called'))
    const rejectBodyTooLarge = vi.fn(() => new Response(JSON.stringify({error: 'payload-too-large'}), {status: 413}))
    const app: WikiWriterApp = {fetch, rejectBodyTooLarge}

    const result = await invokeNodeServer(app, Buffer.alloc(0), {'x-request-id': 'limit-header-001'}, WIKI_WRITER_MAX_RAW_BYTES + 1, false)
    expect(result.status).toBe(413)
    expect(fetch).not.toHaveBeenCalled()
    expect(rejectBodyTooLarge).toHaveBeenCalledWith('limit-header-001')
  })
})
