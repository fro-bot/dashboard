/**
 * Write credential seam and operator configuration.
 *
 * No network: the App-JWT request function is injected, and the clock is
 * controlled by the test.
 */

import type {WritePermissions} from '../src/github/fro-bot-app-client.ts'

import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  createFroBotAppClient,
  JWT_REQUEST_TIMEOUT_MS,
  MAX_RATE_LIMIT_WAIT_SECONDS,
  shouldRetryRateLimit,
  WRITE_PERMISSIONS,
  WriteCredentialError,
} from '../src/github/fro-bot-app-client.ts'
import {mintReadOnlyToken} from '../src/github/installations.ts'
import {logger} from '../src/logger.ts'
import {readWikiWriteConfig} from '../src/wiki/config.ts'
import {buildWikiWriteWiring} from '../src/wiki/wiring.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEfakefakefake\nZmFrZWZha2VmYWtl\n-----END RSA PRIVATE KEY-----'
const INSTALLATION_ROUTE = 'GET /repos/{owner}/{repo}/installation'
const TOKEN_ROUTE = 'POST /app/installations/{installation_id}/access_tokens'
const START = Date.parse('2030-01-01T00:00:00Z')

interface RequestCall {
  readonly route: string
  readonly params: Record<string, unknown>
}

function makeHarness(options: {installationId?: number; tokenLifetimeMs?: number} = {}) {
  const installationId = options.installationId ?? 777
  const tokenLifetimeMs = options.tokenLifetimeMs ?? 60 * 60 * 1000
  const state = {now: START, minted: 0}
  const calls: RequestCall[] = []

  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    const body = Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'request'))
    calls.push({route, params: body})
    if (route === INSTALLATION_ROUTE) return {data: {id: installationId}}
    if (route === TOKEN_ROUTE) {
      state.minted += 1
      return {data: {token: `minted-token-${state.minted}`, expires_at: new Date(state.now + tokenLifetimeMs).toISOString()}}
    }
    throw new Error(`unexpected route ${route}`)
  })

  const client = createFroBotAppClient({
    appId: '12345',
    privateKey: FAKE_PEM,
    request,
    now: () => state.now,
  })

  return {client, request, calls, state, count: (route: string) => calls.filter(c => c.route === route).length}
}

const ENV_NAMES = [
  'DASHBOARD_FRO_BOT_APP_ID',
  'DASHBOARD_FRO_BOT_APP_KEY',
  'DASHBOARD_FRO_BOT_APP_KEY_FILE',
  'DASHBOARD_OPERATOR_ID',
  'DASHBOARD_GATEWAY_OPERATOR_ORIGIN',
] as const

function clearEnv(): void {
  for (const name of ENV_NAMES) vi.stubEnv(name, undefined)
}

// ---------------------------------------------------------------------------
// Permission typing
// ---------------------------------------------------------------------------

describe('WritePermissions', () => {
  it('represents contents:write and nothing else', () => {
    const ok: WritePermissions = {contents: 'write'}
    // @ts-expect-error read access is not a write permission
    const readOnly: WritePermissions = {contents: 'read'}
    // @ts-expect-error a second scope is unrepresentable
    const extraScope: WritePermissions = {contents: 'write', workflows: 'write'}
    // @ts-expect-error administration is unrepresentable
    const admin: WritePermissions = {administration: 'write'}
    // @ts-expect-error the empty object is unrepresentable
    const empty: WritePermissions = {}

    expect(ok).toEqual({contents: 'write'})
    expect([readOnly, extraScope, admin, empty]).toHaveLength(4)
    expect(WRITE_PERMISSIONS).toEqual({contents: 'write'})
  })
})

// ---------------------------------------------------------------------------
// Token mint
// ---------------------------------------------------------------------------

describe('write token mint', () => {
  it('requests exactly contents:write scoped to the .github repository and returns the token', async () => {
    const {client, calls} = makeHarness({installationId: 4242})

    const token = await client.getWriteToken()

    expect(token).toBe('minted-token-1')
    expect(calls[0]).toEqual({route: INSTALLATION_ROUTE, params: {owner: 'fro-bot', repo: '.github'}})
    expect(calls[1]).toEqual({
      route: TOKEN_ROUTE,
      params: {
        installation_id: 4242,
        permissions: {contents: 'write'},
        repository_names: ['.github'],
      },
    })
    expect(calls).toHaveLength(2)
  })

  it('serves a second mint inside the expiry window from the cache', async () => {
    const {client, state, count} = makeHarness()

    const first = await client.getWriteToken()
    state.now += 30 * 60 * 1000
    const second = await client.getWriteToken()

    expect(second).toBe(first)
    expect(count(TOKEN_ROUTE)).toBe(1)
  })

  it('mints again once the token is inside the refresh buffer', async () => {
    const {client, state, count} = makeHarness({tokenLifetimeMs: 10 * 60 * 1000})

    await client.getWriteToken()
    state.now += 10 * 60 * 1000 - 120_000
    await client.getWriteToken()
    expect(count(TOKEN_ROUTE)).toBe(1)

    state.now += 90_000 // 30s before expiry, inside the 60s buffer
    const refreshed = await client.getWriteToken()

    expect(refreshed).toBe('minted-token-2')
    expect(count(TOKEN_ROUTE)).toBe(2)
  })

  it('mints again after expiry', async () => {
    const {client, state, count} = makeHarness({tokenLifetimeMs: 5 * 60 * 1000})

    await client.getWriteToken()
    state.now += 6 * 60 * 1000
    const next = await client.getWriteToken()

    expect(next).toBe('minted-token-2')
    expect(count(TOKEN_ROUTE)).toBe(2)
  })

  it('caches the installation id for a bounded time', async () => {
    const {client, state, count} = makeHarness({tokenLifetimeMs: 90_000})

    await client.getWriteToken()
    state.now += 61_000 // token inside refresh buffer, installation id still fresh
    await client.getWriteToken()
    expect(count(INSTALLATION_ROUTE)).toBe(1)
    expect(count(TOKEN_ROUTE)).toBe(2)

    state.now += 60 * 60 * 1000 // far past any bounded installation-id lifetime
    await client.getWriteToken()
    expect(count(INSTALLATION_ROUTE)).toBe(2)
  })

  it('keeps a separate cache per client instance', async () => {
    const a = makeHarness()
    const b = makeHarness()

    await a.client.getWriteToken()
    await b.client.getWriteToken()

    expect(a.count(TOKEN_ROUTE)).toBe(1)
    expect(b.count(TOKEN_ROUTE)).toBe(1)
  })

  it('does not populate the read-token cache for the same installation', async () => {
    const installationId = 9_001_001
    const {client} = makeHarness({installationId})
    await client.getWriteToken()

    const readMint = vi.fn().mockResolvedValue('read-token')
    const readToken = await mintReadOnlyToken(installationId, readMint)

    expect(readToken).toBe('read-token')
    expect(readMint).toHaveBeenCalledTimes(1)
    expect(readMint).toHaveBeenCalledWith(installationId, expect.objectContaining({contents: 'read'}))
  })

  it('does not read a cached read token as a write token', async () => {
    const installationId = 9_001_002
    await mintReadOnlyToken(installationId, vi.fn().mockResolvedValue('read-token'))
    const {client, count} = makeHarness({installationId})

    const token = await client.getWriteToken()

    expect(token).toBe('minted-token-1')
    expect(count(TOKEN_ROUTE)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe('write token failures', () => {
  const LEAKY =
    `boom ${FAKE_PEM} jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NSJ9.c2lnbmF0dXJlc2lnbmF0dXJl ` +
    'token ghs_abcdefghijklmnopqrstuvwxyz0123456789'

  async function failureFor(route: string): Promise<unknown> {
    const client = createFroBotAppClient({
      appId: '12345',
      privateKey: FAKE_PEM,
      now: () => START,
      request: async (requested: string) => {
        if (requested === route) throw new Error(LEAKY)
        if (requested === INSTALLATION_ROUTE) return {data: {id: 1}}
        return {data: {token: 'unused', expires_at: new Date(START + 3_600_000).toISOString()}}
      },
    })
    return client.getWriteToken().then(
      () => null,
      (error: unknown) => error,
    )
  }

  it.each([
    ['mint', TOKEN_ROUTE],
    ['installation lookup', INSTALLATION_ROUTE],
  ])('surfaces a sanitized error when the %s fails', async (_label, route) => {
    const error = await failureFor(route)

    expect(error).toBeInstanceOf(WriteCredentialError)
    const {message} = error as WriteCredentialError
    expect(message).not.toContain('BEGIN RSA')
    expect(message).not.toContain('MIIEfake')
    expect(message).not.toContain('eyJhbGciOiJSUzI1NiJ9')
    expect(message).not.toContain('ghs_abcdefghijklmnopqrstuvwxyz0123456789')
    expect((error as WriteCredentialError).cause).toBeUndefined()
  })

  it.each([
    ['no token', {expires_at: new Date(START + 3_600_000).toISOString()}],
    ['an empty token', {token: '', expires_at: new Date(START + 3_600_000).toISOString()}],
    ['no expiry', {token: 'abc'}],
    ['an unparseable expiry', {token: 'abc', expires_at: 'not-a-date'}],
    ['a non-object body', 'nope'],
  ])('rejects a mint response with %s', async (_label, data) => {
    const client = createFroBotAppClient({
      appId: '12345',
      privateKey: FAKE_PEM,
      now: () => START,
      request: async (route: string) => (route === INSTALLATION_ROUTE ? {data: {id: 1}} : {data}),
    })

    await expect(client.getWriteToken()).rejects.toBeInstanceOf(WriteCredentialError)
  })

  it.each([[{id: 'abc'}], [{id: 0}], [{id: 1.5}], [{}], [null]])(
    'rejects an installation response of %j',
    async data => {
      const client = createFroBotAppClient({
        appId: '12345',
        privateKey: FAKE_PEM,
        now: () => START,
        request: async () => ({data}),
      })

      await expect(client.getWriteToken()).rejects.toBeInstanceOf(WriteCredentialError)
    },
  )

  it('does not cache a failed mint', async () => {
    let fail = true
    const request = vi.fn(async (route: string) => {
      if (route === INSTALLATION_ROUTE) return {data: {id: 1}}
      if (fail) throw new Error('transient')
      return {data: {token: 'recovered', expires_at: new Date(START + 3_600_000).toISOString()}}
    })
    const client = createFroBotAppClient({appId: '12345', privateKey: FAKE_PEM, now: () => START, request})

    await expect(client.getWriteToken()).rejects.toBeInstanceOf(WriteCredentialError)
    fail = false

    await expect(client.getWriteToken()).resolves.toBe('recovered')
  })
})

function clientFailing(route: string, error: unknown) {
  return createFroBotAppClient({
    appId: '12345',
    privateKey: FAKE_PEM,
    now: () => START,
    request: async (requested: string) => {
      if (requested === route) throw error
      if (requested === INSTALLATION_ROUTE) return {data: {id: 1}}
      return {data: {token: 'unused', expires_at: new Date(START + 3_600_000).toISOString()}}
    },
  })
}

function slowHarness() {
  const gate: {release: (() => void) | undefined} = {release: undefined}
  const calls: string[] = []
  const request = vi.fn(async (route: string) => {
    calls.push(route)
    await new Promise<void>(resolve => {
      const previous = gate.release
      gate.release = () => {
        previous?.()
        resolve()
      }
    })
    if (route === INSTALLATION_ROUTE) return {data: {id: 9}}
    return {data: {token: `shared-${calls.length}`, expires_at: new Date(START + 3_600_000).toISOString()}}
  })
  const client = createFroBotAppClient({appId: '12345', privateKey: FAKE_PEM, request, now: () => START})
  return {client, gate, calls, request}
}

describe('write token eviction', () => {
  it('drops the cached token on invalidate, so the next call mints a new one without a new lookup', async () => {
    const {client, count, state} = makeHarness()
    const stale = await client.getWriteToken()

    client.invalidate(stale)
    const fresh = await client.getWriteToken()

    expect(stale).toBe('minted-token-1')
    expect(fresh).toBe('minted-token-2')
    expect(count(TOKEN_ROUTE)).toBe(2)
    expect(count(INSTALLATION_ROUTE)).toBe(1)
    expect(state.minted).toBe(2)
  })

  it('keeps a newer token when invalidate names an older one', async () => {
    const {client, count} = makeHarness()
    const first = await client.getWriteToken()
    client.invalidate(first)
    const second = await client.getWriteToken()

    client.invalidate(first)

    await expect(client.getWriteToken()).resolves.toBe(second)
    expect(count(TOKEN_ROUTE)).toBe(2)
  })

  it('ignores invalidate when nothing is cached', async () => {
    const {client, count} = makeHarness()

    client.invalidate('never-minted')

    await expect(client.getWriteToken()).resolves.toBe('minted-token-1')
    expect(count(TOKEN_ROUTE)).toBe(1)
  })
})

describe('concurrent cold write token calls', () => {
  it('makes one lookup and one mint for five simultaneous cold calls', async () => {
    const {client, gate, calls} = slowHarness()

    const pending = Array.from({length: 5}, async () => client.getWriteToken())
    for (let step = 0; step < 2; step += 1) {
      await vi.waitFor(() => {
        expect(gate.release).toBeDefined()
      })
      const release = gate.release
      gate.release = undefined
      release?.()
    }
    const tokens = await Promise.all(pending)

    expect(calls).toEqual([INSTALLATION_ROUTE, TOKEN_ROUTE])
    expect(new Set(tokens).size).toBe(1)
  })

  it('serves a call made after the flight from the cache', async () => {
    const {client, count} = makeHarness()

    await Promise.all(Array.from({length: 5}, async () => client.getWriteToken()))
    await client.getWriteToken()

    expect(count(INSTALLATION_ROUTE)).toBe(1)
    expect(count(TOKEN_ROUTE)).toBe(1)
  })

  it('does not cache a rejected flight: every waiter fails, and the next call retries', async () => {
    let fail = true
    const request = vi.fn(async (route: string) => {
      if (route === INSTALLATION_ROUTE) return {data: {id: 9}}
      if (fail) throw new Error('transient')
      return {data: {token: 'recovered', expires_at: new Date(START + 3_600_000).toISOString()}}
    })
    const client = createFroBotAppClient({appId: '12345', privateKey: FAKE_PEM, request, now: () => START})

    const settled = await Promise.allSettled(Array.from({length: 4}, async () => client.getWriteToken()))
    fail = false

    expect(settled.every(result => result.status === 'rejected')).toBe(true)
    expect(request.mock.calls.filter(([route]) => route === TOKEN_ROUTE)).toHaveLength(1)
    await expect(client.getWriteToken()).resolves.toBe('recovered')
  })

  it('keeps each instance on its own flight', async () => {
    const one = makeHarness()
    const two = makeHarness()

    await Promise.all([one.client.getWriteToken(), two.client.getWriteToken()])

    expect(one.count(TOKEN_ROUTE)).toBe(1)
    expect(two.count(TOKEN_ROUTE)).toBe(1)
  })
})

describe('write token failures keep the HTTP status', () => {
  const statusError = (status: number) => Object.assign(new Error(`HTTP ${status} ghs_abcdefghijklmnopqrstuvwxyz0123456789`), {status})

  it.each([401, 403, 404, 422, 500, 502])('carries %d from a refused mint as a number', async status => {
    const failure = await clientFailing(TOKEN_ROUTE, statusError(status))
      .getWriteToken()
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WriteCredentialError)
    expect((failure as WriteCredentialError).status).toBe(status)
    expect((failure as WriteCredentialError).message).not.toContain('ghs_')
  })

  it('carries the status of a failed installation lookup', async () => {
    const failure = await clientFailing(INSTALLATION_ROUTE, statusError(404))
      .getWriteToken()
      .catch((error: unknown) => error)

    expect((failure as WriteCredentialError).status).toBe(404)
  })

  it.each([
    ['a network failure', new Error('socket hang up')],
    ['a non-error throw', 'boom'],
    ['a non-numeric status', Object.assign(new Error('x'), {status: '403'})],
  ])('has no status for %s', async (_label, thrown) => {
    const failure = await clientFailing(TOKEN_ROUTE, thrown)
      .getWriteToken()
      .catch((error: unknown) => error)

    expect((failure as WriteCredentialError).status).toBeNull()
  })

  it('has no status for an unexpected response shape', async () => {
    const client = createFroBotAppClient({appId: '12345', privateKey: FAKE_PEM, now: () => START, request: async () => ({data: {}})})

    const failure = await client.getWriteToken().catch((error: unknown) => error)

    expect((failure as WriteCredentialError).status).toBeNull()
  })
})

describe('write token requests are bounded', () => {
  it('passes an abort signal on the installation lookup and on the mint', async () => {
    const harness = makeHarness()

    await harness.client.getWriteToken()

    expect(harness.request.mock.calls).toHaveLength(2)
    for (const [route, params] of harness.request.mock.calls) {
      const request = params.request as {signal?: unknown} | undefined
      expect(request?.signal, route).toBeInstanceOf(AbortSignal)
    }
  })

  it('rejects a lookup that never answers, with a credential error, inside the bound', async () => {
    const client = createFroBotAppClient({
      appId: '12345',
      privateKey: FAKE_PEM,
      timeoutMs: 40,
      request: async () => new Promise<never>(() => {}),
    })
    const started = Date.now()

    await expect(client.getWriteToken()).rejects.toBeInstanceOf(WriteCredentialError)

    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('rejects a mint that never answers, and does not cache the failure', async () => {
    let stall = true
    const client = createFroBotAppClient({
      appId: '12345',
      privateKey: FAKE_PEM,
      timeoutMs: 40,
      request: async (route: string) => {
        if (route === INSTALLATION_ROUTE) return {data: {id: 1}}
        if (stall) return new Promise<never>(() => {})
        return {data: {token: 'recovered', expires_at: new Date(Date.now() + 3_600_000).toISOString()}}
      },
    })

    await expect(client.getWriteToken()).rejects.toBeInstanceOf(WriteCredentialError)
    stall = false

    await expect(client.getWriteToken()).resolves.toBe('recovered')
  })

  it('has a default bound well under the data client request bound', () => {
    expect(JWT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(JWT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })
})

describe('rate-limit retry policy', () => {
  it('retries a short wait, for at most two retries', () => {
    expect(shouldRetryRateLimit(1, 0)).toBe(true)
    expect(shouldRetryRateLimit(MAX_RATE_LIMIT_WAIT_SECONDS, 1)).toBe(true)
    expect(shouldRetryRateLimit(1, 2)).toBe(false)
  })

  it('does not wait out a long reset window', () => {
    expect(shouldRetryRateLimit(MAX_RATE_LIMIT_WAIT_SECONDS + 1, 0)).toBe(false)
    expect(shouldRetryRateLimit(3600, 0)).toBe(false)
  })

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])('does not retry an unusable wait of %s', wait => {
    expect(shouldRetryRateLimit(wait, 0)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('readWikiWriteConfig', () => {
  beforeEach(() => {
    clearEnv()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function setCredentials(): void {
    vi.stubEnv('DASHBOARD_FRO_BOT_APP_ID', '98765')
    vi.stubEnv('DASHBOARD_FRO_BOT_APP_KEY', FAKE_PEM)
  }

  it('reports writes off with a reason when nothing is configured', () => {
    expect(readWikiWriteConfig()).toEqual({enabled: false, reason: 'app-credentials-absent'})
  })

  it('treats a whitespace-only key as absent', () => {
    vi.stubEnv('DASHBOARD_FRO_BOT_APP_KEY', '  \n ')

    expect(readWikiWriteConfig()).toEqual({enabled: false, reason: 'app-credentials-absent'})
  })

  it.each([
    ['only the App ID', 'DASHBOARD_FRO_BOT_APP_ID', '98765'],
    ['only the key', 'DASHBOARD_FRO_BOT_APP_KEY', FAKE_PEM],
  ])('reports writes off when there is %s', (_label, name, value) => {
    vi.stubEnv('DASHBOARD_OPERATOR_ID', '42')
    vi.stubEnv(name, value)

    expect(readWikiWriteConfig()).toEqual({enabled: false, reason: 'app-credentials-incomplete'})
  })

  it('reports writes off when the operator ID is unset', () => {
    setCredentials()

    expect(readWikiWriteConfig()).toEqual({enabled: false, reason: 'operator-id-unset'})
  })

  it('enables writes with a multiline key, a numeric operator ID, and the default origin', () => {
    setCredentials()
    vi.stubEnv('DASHBOARD_OPERATOR_ID', '1234567')

    expect(readWikiWriteConfig()).toEqual({
      enabled: true,
      appId: '98765',
      privateKey: FAKE_PEM,
      operatorId: 1_234_567,
      dashboardOrigin: 'https://dashboard.fro.bot',
    })
  })

  it('takes the expected origin from the gateway operator origin setting', () => {
    setCredentials()
    vi.stubEnv('DASHBOARD_OPERATOR_ID', '7')
    vi.stubEnv('DASHBOARD_GATEWAY_OPERATOR_ORIGIN', 'https://ops.example.test/')

    const config = readWikiWriteConfig()

    expect(config.enabled && config.dashboardOrigin).toBe('https://ops.example.test')
  })

  it('trims surrounding whitespace on the operator ID', () => {
    setCredentials()
    vi.stubEnv('DASHBOARD_OPERATOR_ID', ' 42 ')

    const config = readWikiWriteConfig()

    expect(config.enabled && config.operatorId).toBe(42)
  })

  it.each(['0', '-1', '1.5', 'abc', '1e3', '0x10', '007', '+5', '', '   ', '12 34', '9007199254740993'])(
    'throws at startup for an invalid operator ID %j',
    value => {
      vi.stubEnv('DASHBOARD_OPERATOR_ID', value)

      expect(() => readWikiWriteConfig()).toThrow(/DASHBOARD_OPERATOR_ID/)
    },
  )

  it('rejects an invalid operator ID even when no write credentials are configured', () => {
    vi.stubEnv('DASHBOARD_OPERATOR_ID', 'nope')

    expect(() => readWikiWriteConfig()).toThrow(/DASHBOARD_OPERATOR_ID/)
  })

  it('does not echo the invalid operator ID value', () => {
    vi.stubEnv('DASHBOARD_OPERATOR_ID', 'secret-looking-value')

    let message = ''
    try {
      readWikiWriteConfig()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toMatch(/DASHBOARD_OPERATOR_ID/)
    expect(message).not.toContain('secret-looking-value')
  })

  it('throws when an enabled configuration has an invalid gateway operator origin', () => {
    setCredentials()
    vi.stubEnv('DASHBOARD_OPERATOR_ID', '42')
    vi.stubEnv('DASHBOARD_GATEWAY_OPERATOR_ORIGIN', 'not a url')

    expect(() => readWikiWriteConfig()).toThrow(/DASHBOARD_GATEWAY_OPERATOR_ORIGIN/)
  })

  it('ignores an invalid origin while writes are off, so boot matches today', () => {
    vi.stubEnv('DASHBOARD_GATEWAY_OPERATOR_ORIGIN', 'not a url')

    expect(readWikiWriteConfig()).toEqual({enabled: false, reason: 'app-credentials-absent'})
  })

  it.each(['0', '-1', '1.5', 'abc', '1e3', '0x10', '007', '+5', '12 34', 'Iv1.abc123', '9007199254740993'])(
    'throws when the App ID is %j, naming the variable and not the value',
    value => {
      vi.stubEnv('DASHBOARD_FRO_BOT_APP_ID', value)
      vi.stubEnv('DASHBOARD_FRO_BOT_APP_KEY', FAKE_PEM)
      vi.stubEnv('DASHBOARD_OPERATOR_ID', '42')

      let message = ''
      try {
        readWikiWriteConfig()
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      expect(message).toMatch(/DASHBOARD_FRO_BOT_APP_ID/)
      expect(message).not.toContain(value)
    },
  )

  it('throws on an invalid App ID even when the key is absent', () => {
    vi.stubEnv('DASHBOARD_FRO_BOT_APP_ID', 'not-a-number')

    expect(() => readWikiWriteConfig()).toThrow(/DASHBOARD_FRO_BOT_APP_ID/)
  })

  it('trims whitespace around a valid App ID', () => {
    vi.stubEnv('DASHBOARD_FRO_BOT_APP_ID', '  98765  ')
    vi.stubEnv('DASHBOARD_FRO_BOT_APP_KEY', FAKE_PEM)
    vi.stubEnv('DASHBOARD_OPERATOR_ID', '42')

    expect(readWikiWriteConfig()).toMatchObject({enabled: true, appId: '98765'})
  })

  it('throws when the App ID contains a line break', () => {
    vi.stubEnv('DASHBOARD_FRO_BOT_APP_ID', '98765\n12')
    vi.stubEnv('DASHBOARD_FRO_BOT_APP_KEY', FAKE_PEM)

    expect(() => readWikiWriteConfig()).toThrow(/DASHBOARD_FRO_BOT_APP_ID/)
  })

  it('reads the key from the *_FILE path, newlines intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-key-'))
    try {
      const keyPath = join(dir, 'fro-bot-app.pem')
      await writeFile(keyPath, `${FAKE_PEM}\n`, {mode: 0o600})
      vi.stubEnv('DASHBOARD_FRO_BOT_APP_ID', '98765')
      vi.stubEnv('DASHBOARD_FRO_BOT_APP_KEY_FILE', keyPath)
      vi.stubEnv('DASHBOARD_OPERATOR_ID', '42')

      const config = readWikiWriteConfig()

      expect(config.enabled && config.privateKey).toBe(FAKE_PEM)
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('uses its own env names, not the read-side credential names', () => {
    vi.stubEnv('DASHBOARD_GITHUB_APP_ID', '1')
    vi.stubEnv('DASHBOARD_GITHUB_APP_KEY', FAKE_PEM)
    vi.stubEnv('DASHBOARD_OPERATOR_ID', '42')

    expect(readWikiWriteConfig()).toEqual({enabled: false, reason: 'app-credentials-absent'})
  })
})

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

describe('buildWikiWriteWiring', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const enabledConfig = {
    enabled: true,
    appId: '98765',
    privateKey: FAKE_PEM,
    operatorId: 42,
    dashboardOrigin: 'https://dashboard.fro.bot',
  } as const

  it('builds a write-token provider when writes are enabled', () => {
    const wiring = buildWikiWriteWiring(enabledConfig)

    expect(wiring.enabled).toBe(true)
    expect(wiring.enabled && typeof wiring.tokens.getWriteToken).toBe('function')
  })

  it('builds nothing and stays quiet when no credential is present', () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})

    const wiring = buildWikiWriteWiring({enabled: false, reason: 'app-credentials-absent'})

    expect(wiring).toEqual({enabled: false, reason: 'app-credentials-absent'})
    expect(warn).not.toHaveBeenCalled()
  })

  it('builds nothing and warns once when only part of the credential pair is present', () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})

    const wiring = buildWikiWriteWiring({enabled: false, reason: 'app-credentials-incomplete'})

    expect(wiring).toEqual({enabled: false, reason: 'app-credentials-incomplete'})
    expect(warn).toHaveBeenCalledTimes(1)
    const [message] = warn.mock.calls[0] ?? []
    expect(message).toContain('DASHBOARD_FRO_BOT_APP_ID')
    expect(message).toContain('DASHBOARD_FRO_BOT_APP_KEY')
  })

  it('builds nothing when the operator ID is unset', () => {
    const wiring = buildWikiWriteWiring({enabled: false, reason: 'operator-id-unset'})

    expect(wiring).toEqual({enabled: false, reason: 'operator-id-unset'})
  })
})
