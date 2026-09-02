import {Buffer} from 'node:buffer'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  authenticateInternalRequest,
  createRequestSignature,
  InMemoryReplayStore,
  loadInternalAuthSecret,
} from '../src/internal-auth.ts'

const SECRET = Buffer.from('wiki-writer-unit-one-secret-which-is-long-enough')
const NOW = 1_756_000_000

function signedInput(overrides: Partial<Parameters<typeof authenticateInternalRequest>[0]> = {}) {
  const method = overrides.method ?? 'POST'
  const path = overrides.path ?? '/write'
  const rawBody = overrides.rawBody ?? Buffer.from('{"operation":"write"}')
  const timestamp = overrides.headers?.get('x-timestamp') ?? String(NOW)
  const requestId = overrides.headers?.get('x-request-id') ?? 'request-001'
  const headers = new Headers({
    'x-request-id': requestId,
    'x-timestamp': timestamp,
    'x-signature': createRequestSignature(SECRET, method, path, timestamp, rawBody, requestId),
  })

  return {
    secret: SECRET,
    method,
    path,
    rawBody,
    headers,
    nowSeconds: NOW,
    ...overrides,
  }
}

describe('internal authentication', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(temporaryDirectories.splice(0).map(async directory => rm(directory, {recursive: true, force: true})))
  })

  it('loads the HMAC secret from a file and never interprets file contents as an environment value', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wiki-writer-auth-'))
    temporaryDirectories.push(directory)
    const secretPath = join(directory, 'secret')
    await writeFile(secretPath, SECRET)

    await expect(loadInternalAuthSecret(secretPath)).resolves.toEqual(SECRET)
    await expect(readFile(secretPath)).resolves.toEqual(SECRET)
  })

  it('fails closed when the secret is missing, unreadable, or too short', async () => {
    await expect(loadInternalAuthSecret('/path/that/does/not/exist')).rejects.toThrow()

    const directory = await mkdtemp(join(tmpdir(), 'wiki-writer-auth-'))
    temporaryDirectories.push(directory)
    const shortPath = join(directory, 'short-secret')
    await writeFile(shortPath, Buffer.alloc(31, 1))
    await expect(loadInternalAuthSecret(shortPath)).rejects.toThrow('32 bytes')
  })

  it('accepts a valid HMAC over the raw body bytes and rejects a reserialized body', () => {
    const rawBody = Buffer.from(String.raw`{"operation":"write", "content":"line 1\nline 2"}`)
    const input = signedInput({rawBody})
    expect(authenticateInternalRequest(input)).toEqual({ok: true, requestId: 'request-001'})

    const changedBody = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString('utf8'))))
    expect(authenticateInternalRequest({...input, rawBody: changedBody})).toEqual({
      ok: false,
      reasonClass: 'signature_mismatch',
      requestId: 'request-001',
    })
  })

  it('accepts the exact timestamp skew boundary and rejects timestamps outside it', () => {
    const atBoundary = signedInput({
      headers: new Headers({
        'x-request-id': 'boundary-001',
        'x-timestamp': String(NOW - 300),
        'x-signature': createRequestSignature(SECRET, 'POST', '/write', String(NOW - 300), Buffer.from('{"ok":true}'), 'boundary-001'),
      }),
      rawBody: Buffer.from('{"ok":true}'),
    })
    expect(authenticateInternalRequest(atBoundary)).toEqual({ok: true, requestId: 'boundary-001'})

    const outside = signedInput({
      headers: new Headers({
        'x-request-id': 'outside-001',
        'x-timestamp': String(NOW - 301),
        'x-signature': createRequestSignature(SECRET, 'POST', '/write', String(NOW - 301), Buffer.from('{"ok":true}'), 'outside-001'),
      }),
      rawBody: Buffer.from('{"ok":true}'),
    })
    expect(authenticateInternalRequest(outside)).toEqual({
      ok: false,
      reasonClass: 'stale_timestamp',
      requestId: 'outside-001',
    })
  })

  it('rejects malformed or mismatched signatures before the request can proceed', () => {
    const malformed = signedInput({headers: new Headers({'x-request-id': 'malformed-001', 'x-timestamp': String(NOW), 'x-signature': 'not-a-signature'})})
    expect(authenticateInternalRequest(malformed)).toEqual({
      ok: false,
      reasonClass: 'malformed_signature',
      requestId: 'malformed-001',
    })

    const mismatched = signedInput({headers: new Headers({'x-request-id': 'mismatch-001', 'x-timestamp': String(NOW), 'x-signature': `sha256=${'00'.repeat(32)}`})})
    expect(authenticateInternalRequest(mismatched)).toEqual({
      ok: false,
      reasonClass: 'signature_mismatch',
      requestId: 'mismatch-001',
    })
  })

  it('rejects a duplicate request ID after a prior successful request', () => {
    const replayStore = new InMemoryReplayStore()
    const input = signedInput({replayStore})
    expect(authenticateInternalRequest(input)).toEqual({ok: true, requestId: 'request-001'})
    expect(authenticateInternalRequest(input)).toEqual({
      ok: false,
      reasonClass: 'duplicate_request_id',
      requestId: 'request-001',
    })
  })

  it('bounds the replay store and documents eviction as bounded-window protection', () => {
    const replayStore = new InMemoryReplayStore(1)
    expect(replayStore.remember('first', NOW, 300)).toBe(true)
    expect(replayStore.remember('second', NOW, 300)).toBe(true)
    expect(replayStore.remember('first', NOW, 300)).toBe(true)
    expect(replayStore.size).toBe(1)
  })

  it('emits an exact secret-free audit event for HMAC and replay rejection', () => {
    const audit = vi.fn()
    const replayStore = new InMemoryReplayStore()
    const input = signedInput({replayStore, audit})
    expect(authenticateInternalRequest(input).ok).toBe(true)
    expect(authenticateInternalRequest({...input, rawBody: Buffer.from('secret body')})).toEqual({
      ok: false,
      reasonClass: 'signature_mismatch',
      requestId: 'request-001',
    })
    expect(audit).toHaveBeenCalledWith({outcome: 'rejected', reasonClass: 'signature_mismatch', requestId: 'request-001'})

    audit.mockClear()
    expect(authenticateInternalRequest(input)).toEqual({
      ok: false,
      reasonClass: 'duplicate_request_id',
      requestId: 'request-001',
    })
    expect(audit).toHaveBeenCalledWith({outcome: 'rejected', reasonClass: 'duplicate_request_id', requestId: 'request-001'})
  })
})
