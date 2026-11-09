/**
 * Operator listener channel route integration tests, through buildDashboardApp().
 */
import type {ListenerStore} from '../src/listener/store.ts'
import {Buffer} from 'node:buffer'
import {createHmac} from 'node:crypto'
import {beforeEach, describe, expect, it} from 'vitest'
import {createListenerStore} from '../src/listener/store.ts'
import {buildDashboardApp} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'

const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8') // 32 bytes
const INGEST_KEY = 'shared-ingest-key-for-tests'

function signBody(key: string, timestamp: string, rawBody: string): string {
  const hex = createHmac('sha256', key).update(`${timestamp}.${rawBody}`).digest('hex')
  return `sha256=${hex}`
}

function ingestHeaders(rawBody: string, key: string = INGEST_KEY, timestamp?: number): Record<string, string> {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000))
  return {
    'content-type': 'application/json',
    'x-listener-timestamp': ts,
    'x-listener-signature': signBody(key, ts, rawBody),
  }
}

const VALID_BODY = JSON.stringify({
  source: 'infra',
  kind: 'deploy-health',
  severity: 'warning',
  title: 'Autoheal restarted gateway',
  body: 'gateway health probe failed 3x; container restarted and recovered.',
  createdAt: '2026-07-11T12:00:00Z',
})

async function buildTestApp(opts: {listenerStore?: ListenerStore; listenerIngestKey?: string | null}) {
  return buildDashboardApp({
    operatorLogin: 'octocat',
    cookieKey: TEST_KEY,
    listenerStore: opts.listenerStore,
    listenerIngestKey: opts.listenerIngestKey,
  })
}

function sessionCookieHeader(): string {
  const sm = new SessionManager(TEST_KEY)
  return `session=${sm.sign('octocat')}`
}

describe('operator listener channel routes', () => {
  let store: ListenerStore

  beforeEach(() => {
    store = createListenerStore(':memory:')
  })

  it('POST /api/listener/ingest with a correctly-signed body → 202, id returned; visible via GET', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})

    const ingestRes = await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: ingestHeaders(VALID_BODY),
      body: VALID_BODY,
    })
    expect(ingestRes.status).toBe(202)
    const ingestJson = (await ingestRes.json()) as {id: string; receivedAt: string}
    expect(typeof ingestJson.id).toBe('string')
    expect(typeof ingestJson.receivedAt).toBe('string')

    const getRes = await app.request('/api/listener/messages', {
      headers: {cookie: sessionCookieHeader()},
    })
    expect(getRes.status).toBe(200)
    const getJson = (await getRes.json()) as {messages: {id: string}[]; unreadCount: number}
    expect(getJson.messages).toHaveLength(1)
    expect(getJson.messages[0]?.id).toBe(ingestJson.id)
    expect(getJson.unreadCount).toBe(1)
  })

  it('POST /ingest with bad signature → 401', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const res = await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: ingestHeaders(VALID_BODY, 'wrong-key'),
      body: VALID_BODY,
    })
    expect(res.status).toBe(401)
    const json = (await res.json()) as {error: string}
    expect(json.error).toBe('unauthorized')
  })

  it('POST /ingest with bad body → 400', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const badBody = JSON.stringify({source: 'not-a-valid-source'})
    const res = await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: ingestHeaders(badBody),
      body: badBody,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({error: 'invalid request body'})
  })

  it('POST /ingest with malformed JSON → 400', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const badBody = '{not json'
    const res = await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: ingestHeaders(badBody),
      body: badBody,
    })
    expect(res.status).toBe(400)
  })

  it('POST /ingest oversized → 413', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const hugeBody = JSON.stringify({
      source: 'infra',
      kind: 'deploy-health',
      severity: 'warning',
      title: 'x',
      body: 'x'.repeat(20_000),
      createdAt: '2026-07-11T12:00:00Z',
    })
    const res = await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: ingestHeaders(hugeBody),
      body: hugeBody,
    })
    expect(res.status).toBe(413)
  })

  it('POST /ingest oversized stream with no declared length → 413 without reading past the cap', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const chunk = new Uint8Array(4096).fill(0x78)
    const chunkCount = 1000
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunkCount) {
          controller.close()
          return
        }
        pulled += 1
        controller.enqueue(chunk)
      },
    })

    const res = await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-listener-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-listener-signature': 'sha256=00',
      },
      body: stream,
      duplex: 'half',
    })

    expect(res.status).toBe(413)
    // 16384-byte cap / 4096-byte chunks: the fifth chunk crosses the cap. A small read-ahead
    // from the stream queue is fine; buffering the whole body is not.
    expect(pulled).toBeLessThan(chunkCount / 10)
  })

  it('POST /ingest oversized body with a declared length → 413 before any read', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const res = await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '1000000',
        'x-listener-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-listener-signature': 'sha256=00',
      },
      body: 'x',
    })
    expect(res.status).toBe(413)
  })

  it('POST /ingest body exactly at the cap is still read and verified', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const base = JSON.stringify({
      source: 'infra',
      kind: 'deploy-health',
      severity: 'warning',
      title: 'x',
      body: '',
      createdAt: '2026-07-11T12:00:00Z',
    })
    const atCap = base.replace('"body":""', `"body":"${'y'.repeat(16384 - base.length)}"`)
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(16384)
    const res = await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: ingestHeaders(atCap),
      body: atCap,
    })
    expect(res.status).not.toBe(413)
    expect(res.status).not.toBe(401)
  })

  it('GET /api/listener/messages WITHOUT a session cookie → denied', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const res = await app.request('/api/listener/messages')
    expect([401, 302, 303]).toContain(res.status)
  })

  it('GET with a valid session cookie → 200 with messages + unreadCount', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const res = await app.request('/api/listener/messages', {
      headers: {cookie: sessionCookieHeader()},
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {messages: unknown[]; unreadCount: number}
    expect(Array.isArray(json.messages)).toBe(true)
    expect(json.unreadCount).toBe(0)
  })

  it('POST ack with session → 202; ack unknown id → 404', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const ingestRes = await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: ingestHeaders(VALID_BODY),
      body: VALID_BODY,
    })
    const {id} = (await ingestRes.json()) as {id: string}

    const ackRes = await app.request(`/api/listener/messages/${id}/ack`, {
      method: 'POST',
      headers: {cookie: sessionCookieHeader()},
    })
    expect(ackRes.status).toBe(202)

    const notFoundRes = await app.request('/api/listener/messages/does-not-exist/ack', {
      method: 'POST',
      headers: {cookie: sessionCookieHeader()},
    })
    expect(notFoundRes.status).toBe(404)
  })

  it('POST ack-all with session → 202', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: ingestHeaders(VALID_BODY),
      body: VALID_BODY,
    })

    const res = await app.request('/api/listener/ack-all', {
      method: 'POST',
      headers: {cookie: sessionCookieHeader()},
    })
    expect(res.status).toBe(202)
    const json = (await res.json()) as {acked: number}
    expect(json.acked).toBe(1)
  })

  it('POST ack-all WITHOUT a session cookie → denied', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: INGEST_KEY})
    const res = await app.request('/api/listener/ack-all', {method: 'POST'})
    expect([401, 302, 303]).toContain(res.status)
  })

  it('when no ingest key is configured, POST /api/listener/ingest → 404', async () => {
    const app = await buildTestApp({listenerStore: store, listenerIngestKey: null})
    const res = await app.request('/api/listener/ingest', {
      method: 'POST',
      headers: ingestHeaders(VALID_BODY),
      body: VALID_BODY,
    })
    expect(res.status).toBe(404)
  })

  it('when no listenerStore is provided, the entire channel is not mounted → 404', async () => {
    const app = await buildDashboardApp({
      operatorLogin: 'octocat',
      cookieKey: TEST_KEY,
    })
    const res = await app.request('/api/listener/messages', {
      headers: {cookie: sessionCookieHeader()},
    })
    expect(res.status).toBe(404)
  })
})
