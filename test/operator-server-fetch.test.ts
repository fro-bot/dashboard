/**
 * Tests for the server-side same-origin operator fetch adapter.
 *
 * Security invariants tested:
 * - The forwarded cookie is the end-user's inbound cookie, never a service credential.
 * - The adapter rejects (throws) when no inbound cookie is present — no request issued.
 * - No Authorization header or other service credential is ever attached by the adapter.
 * - A caller-supplied Authorization header is stripped (confused-deputy defense).
 * - A caller-supplied Headers object is honored (not silently dropped).
 * - Relative /operator/* paths are resolved to absolute same-origin URLs.
 * - Caller-supplied init.headers are merged but the forwarded cookie wins.
 * - redirect:'error' is always set so the cookie is never forwarded across a redirect.
 * - A 10-second AbortSignal timeout is applied to every outgoing request.
 */

import {describe, expect, it} from 'vitest'
import {createOperatorServerFetch, GATEWAY_FETCH_TIMEOUT_MS} from '../src/gateway/operator-server-fetch.ts'

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

// ---------------------------------------------------------------------------
// Security: redirect:'error' is always set — cookie never forwarded across redirect
// ---------------------------------------------------------------------------

describe('createOperatorServerFetch — redirect:error', () => {
  it('always sets redirect:error on the outgoing request', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session')

    expect(calls[0]?.init?.redirect).toBe('error')
  })

  it('redirect:error cannot be overridden by caller-supplied init', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    // Caller tries to set redirect:'follow' — must be overridden to 'error'
    await fetch('/operator/session', {redirect: 'follow'})

    expect(calls[0]?.init?.redirect).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// Security: AbortSignal timeout — hanging gateway maps to abort → deny
// ---------------------------------------------------------------------------

describe('createOperatorServerFetch — fetch timeout', () => {
  it('sets a signal on the outgoing request', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session')

    expect(calls[0]?.init?.signal).toBeDefined()
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('an already-aborted signal causes the fetch to throw (simulating timeout)', async () => {
    // Simulate a timed-out fetch by using a fetchImpl that throws AbortError
    const abortingFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      const err = new DOMException('The operation was aborted.', 'AbortError')
      throw err
    }

    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl: abortingFetch,
    })

    // The adapter must propagate the AbortError (operator client maps it to GatewayNetworkError → deny)
    await expect(fetch('/operator/session')).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Security: Headers-object input is honored; Authorization is stripped
// ---------------------------------------------------------------------------

describe('createOperatorServerFetch — Headers normalization and Authorization stripping', () => {
  it('honors a real Headers object passed as init.headers', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    const headersObj = new Headers({accept: 'application/json', 'x-custom': 'value'})
    await fetch('/operator/session', {headers: headersObj})

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    // Headers object values must be preserved
    expect(headers?.accept).toBe('application/json')
    expect(headers?.['x-custom']).toBe('value')
    // Forwarded cookie must still win
    expect(headers?.cookie).toBe('gw=abc')
  })

  it('strips a caller-supplied Authorization header (confused-deputy defense)', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    await fetch('/operator/session', {
      headers: {authorization: 'Bearer some-service-token'},
    })

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    // Authorization must be stripped — never forwarded to the gateway
    expect(headers?.authorization).toBeUndefined()
    expect(headers?.Authorization).toBeUndefined()
    // Cookie must still be forwarded
    expect(headers?.cookie).toBe('gw=abc')
  })

  it('strips a caller-supplied Authorization header from a Headers object', async () => {
    const {fetchImpl, calls} = makeFakeFetch()
    const fetch = createOperatorServerFetch({
      origin: 'https://dashboard.fro.bot',
      cookie: 'gw=abc',
      fetchImpl,
    })

    const headersObj = new Headers({authorization: 'Bearer leaked-token', accept: 'application/json'})
    await fetch('/operator/session', {headers: headersObj})

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers?.authorization).toBeUndefined()
    expect(headers?.accept).toBe('application/json')
    expect(headers?.cookie).toBe('gw=abc')
  })

  it('GATEWAY_FETCH_TIMEOUT_MS is exported and is a positive number', () => {
    expect(typeof GATEWAY_FETCH_TIMEOUT_MS).toBe('number')
    expect(GATEWAY_FETCH_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
