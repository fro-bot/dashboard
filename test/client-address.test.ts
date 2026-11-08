/**
 * Client address resolution and rate-limit bucketing.
 *
 * Covers the trusted-proxy policy (X-Forwarded-For is read only when the socket
 * peer is a configured proxy), IPv6 /64 grouping, the bounded rate-limit map, and
 * the middleware wiring through buildDashboardApp().
 */
import {Buffer} from 'node:buffer'
import {beforeEach, describe, expect, it} from 'vitest'
import {parseTrustedProxies, resolveClientKey} from '../src/client-address.ts'
import {
  buildDashboardApp,
  checkRateLimit,
  consumeRateLimit,
  MAX_RATE_LIMIT_KEYS,
  rateLimitKeyCountForTesting,
  resetRateLimitForTesting,
} from '../src/server.ts'

const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8')

describe('parseTrustedProxies', () => {
  it('treats unset, empty and blank values as direct (no proxy trusted)', () => {
    expect(parseTrustedProxies(undefined).kind).toBe('direct')
    expect(parseTrustedProxies('').kind).toBe('direct')
    expect(parseTrustedProxies('   ').kind).toBe('direct')
  })

  it('accepts exact addresses and CIDR ranges, comma separated', () => {
    expect(parseTrustedProxies('172.18.0.2, 10.0.0.0/8, 2001:db8::1, 2001:db8::/32').kind).toBe('trusted-proxy')
  })

  it.each(['not-an-address', '10.0.0.1,', '10.0.0.0/33', '10.0.0.0/abc', '2001:db8::/129', '0.0.0.0', '::', '0.0.0.0/0', '::/0'])(
    'rejects %j, naming the variable',
    raw => {
      expect(() => parseTrustedProxies(raw)).toThrow(/DASHBOARD_TRUSTED_PROXIES/)
    },
  )
})

describe('resolveClientKey', () => {
  const direct = parseTrustedProxies(undefined)
  const viaProxy = parseTrustedProxies('172.18.0.0/16')

  it('uses the socket address when no proxy is trusted, ignoring X-Forwarded-For', () => {
    const key = resolveClientKey({socketAddress: '203.0.113.9', forwardedFor: '198.51.100.7'}, direct)
    expect(key).toBe(resolveClientKey({socketAddress: '203.0.113.9', forwardedFor: null}, direct))
    expect(key).not.toBe(resolveClientKey({socketAddress: '198.51.100.7', forwardedFor: null}, direct))
  })

  it('ignores X-Forwarded-For when the socket peer is not a trusted proxy', () => {
    const spoofed = resolveClientKey({socketAddress: '203.0.113.9', forwardedFor: '198.51.100.7'}, viaProxy)
    expect(spoofed).toBe(resolveClientKey({socketAddress: '203.0.113.9', forwardedFor: null}, viaProxy))
  })

  it('keys on the forwarded client when the socket peer is a trusted proxy', () => {
    const a = resolveClientKey({socketAddress: '172.18.0.2', forwardedFor: '198.51.100.7'}, viaProxy)
    const b = resolveClientKey({socketAddress: '172.18.0.2', forwardedFor: '198.51.100.8'}, viaProxy)
    expect(a).not.toBe(b)
    // The forwarded client is bucketed exactly as if it had connected directly.
    expect(a).toBe(resolveClientKey({socketAddress: '198.51.100.7', forwardedFor: null}, direct))
  })

  it('walks the chain from the right and never trusts a forged leftmost entry', () => {
    const forged = resolveClientKey({socketAddress: '172.18.0.2', forwardedFor: '1.2.3.4, 198.51.100.7'}, viaProxy)
    const honest = resolveClientKey({socketAddress: '172.18.0.2', forwardedFor: '198.51.100.7'}, viaProxy)
    expect(forged).toBe(honest)
  })

  it('skips trusted hops in the chain', () => {
    const chained = resolveClientKey({socketAddress: '172.18.0.2', forwardedFor: '198.51.100.7, 172.18.0.9'}, viaProxy)
    expect(chained).toBe(resolveClientKey({socketAddress: '172.18.0.2', forwardedFor: '198.51.100.7'}, viaProxy))
  })

  it.each([null, '', '  ', 'garbage', '198.51.100.7, garbage', '172.18.0.9', 'x,'.repeat(40), `1.2.3.4${' '.repeat(5000)}`])(
    'falls back to the proxy socket key for an absent or unusable header (%j)',
    forwardedFor => {
      const fallback = resolveClientKey({socketAddress: '172.18.0.2', forwardedFor: null}, viaProxy)
      expect(resolveClientKey({socketAddress: '172.18.0.2', forwardedFor}, viaProxy)).toBe(fallback)
    },
  )

  it("returns 'unknown' when there is no socket address", () => {
    expect(resolveClientKey({socketAddress: undefined, forwardedFor: '198.51.100.7'}, viaProxy)).toBe('unknown')
    expect(resolveClientKey({socketAddress: 'garbage', forwardedFor: null}, viaProxy)).toBe('unknown')
  })

  it('treats an IPv4-mapped IPv6 socket address as the IPv4 address', () => {
    expect(resolveClientKey({socketAddress: '::ffff:172.18.0.2', forwardedFor: '198.51.100.7'}, viaProxy)).toBe(
      resolveClientKey({socketAddress: '172.18.0.2', forwardedFor: '198.51.100.7'}, viaProxy),
    )
    expect(resolveClientKey({socketAddress: '::ffff:203.0.113.9', forwardedFor: null}, direct)).toBe(
      resolveClientKey({socketAddress: '203.0.113.9', forwardedFor: null}, direct),
    )
  })

  describe('IPv6 grouping', () => {
    it('puts addresses in the same /64 in one bucket, in any spelling', () => {
      const a = resolveClientKey({socketAddress: '2001:db8:1:2::1', forwardedFor: null}, direct)
      const b = resolveClientKey({socketAddress: '2001:0db8:0001:0002:ffff:ffff:ffff:ffff', forwardedFor: null}, direct)
      const c = resolveClientKey({socketAddress: '2001:DB8:1:2:abcd::5', forwardedFor: null}, direct)
      expect(b).toBe(a)
      expect(c).toBe(a)
    })

    it('separates different /64 prefixes', () => {
      const a = resolveClientKey({socketAddress: '2001:db8:1:2::1', forwardedFor: null}, direct)
      const b = resolveClientKey({socketAddress: '2001:db8:1:3::1', forwardedFor: null}, direct)
      expect(b).not.toBe(a)
    })

    it('groups forwarded IPv6 clients by /64 too', () => {
      const a = resolveClientKey({socketAddress: '172.18.0.2', forwardedFor: '2001:db8:1:2::1'}, viaProxy)
      const b = resolveClientKey({socketAddress: '172.18.0.2', forwardedFor: '2001:db8:1:2:9::9'}, viaProxy)
      expect(b).toBe(a)
    })

    it('keeps a lookalike IPv4 address in a separate bucket from an IPv6 one', () => {
      const v4 = resolveClientKey({socketAddress: '32.1.13.184', forwardedFor: null}, direct)
      const v6 = resolveClientKey({socketAddress: '2001:db8::1', forwardedFor: null}, direct)
      expect(v4).not.toBe(v6)
    })
  })
})

describe('rate-limit map bound', () => {
  beforeEach(() => {
    resetRateLimitForTesting()
  })

  it('never grows past the cap, and still admits new keys when full', () => {
    const now = Date.now()
    for (let i = 0; i < MAX_RATE_LIMIT_KEYS + 500; i++) {
      expect(consumeRateLimit(`key-${i}`, 60, now).allowed).toBe(true)
    }
    expect(rateLimitKeyCountForTesting()).toBeLessThanOrEqual(MAX_RATE_LIMIT_KEYS)
  })

  it('evicts the oldest key when full rather than refusing the new one', () => {
    const now = Date.now()
    // Exhaust `oldest`, then fill the map with other keys.
    for (let i = 0; i < 61; i++) consumeRateLimit('oldest', 60, now)
    expect(consumeRateLimit('oldest', 60, now).allowed).toBe(false)
    for (let i = 0; i < MAX_RATE_LIMIT_KEYS; i++) consumeRateLimit(`filler-${i}`, 60, now)
    // `oldest` was dropped to make room, so it starts a fresh window.
    expect(consumeRateLimit('oldest', 60, now).allowed).toBe(true)
    // A key that was recently added is still tracked.
    const recent = `filler-${MAX_RATE_LIMIT_KEYS - 1}`
    for (let i = 0; i < 59; i++) consumeRateLimit(recent, 60, now)
    expect(consumeRateLimit(recent, 60, now).allowed).toBe(false)
  })

  it('still limits a key that stays under the cap', () => {
    const now = Date.now()
    for (let i = 0; i < 60; i++) expect(checkRateLimit('steady', now)).toBe(true)
    expect(checkRateLimit('steady', now)).toBe(false)
  })
})

function env(remoteAddress: string) {
  return {incoming: {socket: {remoteAddress, remotePort: 40_000, remoteFamily: 'IPv4'}}}
}

async function hit(
  app: Awaited<ReturnType<typeof buildDashboardApp>>,
  socket: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const res = await app.request('/api/healthz', {headers}, env(socket))
  return res.status
}

describe('rate-limit middleware client keying', () => {
  beforeEach(() => {
    resetRateLimitForTesting()
  })

  it('gives each forwarded client its own bucket behind a trusted proxy', async () => {
    const app = await buildDashboardApp({operatorLogin: 'octocat', cookieKey: TEST_KEY, trustedProxies: '172.18.0.0/16'})
    for (let i = 0; i < 60; i++) expect(await hit(app, '172.18.0.2', {'x-forwarded-for': '198.51.100.7'})).toBe(200)
    expect(await hit(app, '172.18.0.2', {'x-forwarded-for': '198.51.100.7'})).toBe(429)
    // A different client behind the same proxy is unaffected.
    expect(await hit(app, '172.18.0.2', {'x-forwarded-for': '198.51.100.8'})).toBe(200)
  })

  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', async () => {
    const app = await buildDashboardApp({operatorLogin: 'octocat', cookieKey: TEST_KEY, trustedProxies: '172.18.0.0/16'})
    for (let i = 0; i < 60; i++) expect(await hit(app, '203.0.113.9', {'x-forwarded-for': `198.51.100.${i}`})).toBe(200)
    expect(await hit(app, '203.0.113.9', {'x-forwarded-for': '198.51.100.200'})).toBe(429)
  })

  it('keys on the socket address when no proxy is configured', async () => {
    const app = await buildDashboardApp({operatorLogin: 'octocat', cookieKey: TEST_KEY})
    for (let i = 0; i < 60; i++) expect(await hit(app, '172.18.0.2', {'x-forwarded-for': `198.51.100.${i}`})).toBe(200)
    expect(await hit(app, '172.18.0.2', {'x-forwarded-for': '198.51.100.250'})).toBe(429)
  })

  it('shares one bucket across a /64 of IPv6 clients', async () => {
    const app = await buildDashboardApp({operatorLogin: 'octocat', cookieKey: TEST_KEY})
    for (let i = 0; i < 60; i++) expect(await hit(app, `2001:db8:1:2::${(i + 1).toString(16)}`)).toBe(200)
    expect(await hit(app, '2001:db8:1:2:ffff::1')).toBe(429)
    expect(await hit(app, '2001:db8:1:3::1')).toBe(200)
  })

  it('fails loudly at construction on an invalid trusted-proxy value', async () => {
    await expect(buildDashboardApp({operatorLogin: 'octocat', cookieKey: TEST_KEY, trustedProxies: 'nope'})).rejects.toThrow(
      /DASHBOARD_TRUSTED_PROXIES/,
    )
  })
})
