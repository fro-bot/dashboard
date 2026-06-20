/**
 * Tests for the server-side same-origin operator fetch adapter.
 *
 * TDD: written before implementation.
 *
 * Security invariants tested:
 * - The forwarded cookie is the end-user's inbound cookie, never a service credential.
 * - The adapter rejects (throws) when no inbound cookie is present — no request issued.
 * - No Authorization header or other service credential is ever attached by the adapter.
 * - Relative /operator/* paths are resolved to absolute same-origin URLs.
 * - Caller-supplied init.headers are merged but the forwarded cookie wins.
 */

import {describe, expect, it} from 'vitest'
import {createOperatorServerFetch} from '../src/gateway/operator-server-fetch.ts'

// ---------------------------------------------------------------------------
// Recording fake fetchImpl
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string
  init: RequestInit | undefined
}

function makeFakeFetch(status = 200): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({url, init})
    return new Response(JSON.stringify({ok: true}), {
      status,
      headers: {'content-type': 'application/json'},
    })
  }
  return {fetchImpl, calls}
}

// ---------------------------------------------------------------------------
// Happy path: relative path resolved to absolute same-origin URL
// ---------------------------------------------------------------------------

describe('createOperatorServerFetch — happy path', () => {
  it('resolves relative /operator/session against the provided origin', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://dashboard.fro.bot/operator/session')
  })

  it('forwards the inbound cookie verbatim in the outgoing request', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session')

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers?.cookie).toBe('gw=abc')
  })

  it('returns the Response from the underlying fetchImpl', async () => {
    const {fetchImpl} = makeFakeFetch(200)
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    const response = await fetch('/operator/session')

    expect(response.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Edge: different origin → different absolute URL
// ---------------------------------------------------------------------------

describe('createOperatorServerFetch — origin binding', () => {
  it('uses the provided origin to build the absolute URL (staging)', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://staging.dashboard.fro.bot',
      cookie: 'gw=staging-token',
      fetchImpl,
    })

    await fetch('/operator/session')

    expect(calls[0]?.url).toBe('https://staging.dashboard.fro.bot/operator/session')
  })

  it('uses the provided origin to build the absolute URL (localhost)', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'http://localhost:3000',
      cookie: 'gw=local-token',
      fetchImpl,
    })

    await fetch('/operator/session')

    expect(calls[0]?.url).toBe('http://localhost:3000/operator/session')
  })

  it('resolves different /operator/* paths correctly', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session/csrf')

    expect(calls[0]?.url).toBe('https://dashboard.fro.bot/operator/session/csrf')
  })
})

// ---------------------------------------------------------------------------
// Edge: missing or empty cookie → reject, no request issued
// ---------------------------------------------------------------------------

describe('createOperatorServerFetch — missing cookie rejects', () => {
  it('throws when cookie is undefined — no request issued', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: undefined,
      fetchImpl,
    })

    await expect(fetch('/operator/session')).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('throws when cookie is empty string — no request issued', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: '',
      fetchImpl,
    })

    await expect(fetch('/operator/session')).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('throws when cookie is whitespace-only — no request issued', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: '   ',
      fetchImpl,
    })

    await expect(fetch('/operator/session')).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Security: no service credential attached — no confused-deputy
// ---------------------------------------------------------------------------

describe('createOperatorServerFetch — no service credential', () => {
  it('does not attach an Authorization header', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session')

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers?.authorization).toBeUndefined()
    expect(headers?.Authorization).toBeUndefined()
  })

  it('does not attach an X-Service-Token or similar credential header', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session')

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    // The only auth-related header should be the forwarded cookie
    const headerKeys = Object.keys(headers ?? {}).map(k => k.toLowerCase())
    const credentialHeaders = headerKeys.filter(
      k => k === 'authorization' || k.startsWith('x-service') || k.startsWith('x-api-key'),
    )
    expect(credentialHeaders).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Edge: caller-supplied init.headers are merged; forwarded cookie wins
// ---------------------------------------------------------------------------

describe('createOperatorServerFetch — init.headers merge', () => {
  it('merges caller-supplied headers with the forwarded cookie', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session', {
      headers: {accept: 'application/json'},
    })

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers?.accept).toBe('application/json')
    expect(headers?.cookie).toBe('gw=abc')
  })

  it('forwarded cookie wins over any cookie in caller-supplied init.headers', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    // Caller tries to pass a different cookie — the forwarded inbound cookie must win
    await fetch('/operator/session', {
      headers: {cookie: 'gw=caller-override'},
    })

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers?.cookie).toBe('gw=abc')
  })

  it('passes through other init properties (method, body) unchanged', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session', {
      method: 'POST',
      body: '{"test":true}',
    })

    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBe('{"test":true}')
  })
})

// ---------------------------------------------------------------------------
// Edge: init is undefined (no init passed)
// ---------------------------------------------------------------------------

describe('createOperatorServerFetch — no init passed', () => {
  it('works correctly when no init is provided', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session')

    expect(calls).toHaveLength(1)
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers?.cookie).toBe('gw=abc')
  })
})
