/**
 * Session cookie signing/verification tests.
 * Tests run BEFORE implementation (RED phase).
 *
 * Cookie format: `<base64url(json)>.<base64url(hmac-sha256)>`
 * HMAC covers the base64url-encoded payload (so exp is always in scope).
 */
import {Buffer} from 'node:buffer'
import {createHmac} from 'node:crypto'
import process from 'node:process'
import {describe, expect, it} from 'vitest'
import {SessionManager} from '../src/session.ts'

// 32-byte key (256-bit) — minimum valid key
// Note: must NOT be all-same-byte (degenerate key check) — use mixed bytes
const VALID_KEY = Buffer.from('abcdefghijklmnopqrstuvwxyz123456', 'utf8') // 32 bytes, mixed

describe('SessionManager', () => {
  describe('constructor', () => {
    it('accepts a 32-byte key', () => {
      expect(() => new SessionManager(VALID_KEY)).not.toThrow()
    })

    it('accepts a key longer than 32 bytes', () => {
      const longKey = Buffer.from('abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz12', 'utf8')
      expect(() => new SessionManager(longKey)).not.toThrow()
    })

    it('throws on a key shorter than 32 bytes', () => {
      const weakKey = Buffer.from('short', 'utf8') // 5 bytes
      expect(() => new SessionManager(weakKey)).toThrow(/key.*32|32.*byte/i)
    })

    it('throws on a 31-byte key (boundary)', () => {
      const borderKey = Buffer.from('abcdefghijklmnopqrstuvwxyz12345', 'utf8') // 31 bytes
      expect(() => new SessionManager(borderKey)).toThrow(/key.*32|32.*byte/i)
    })

    it('throws on empty key', () => {
      expect(() => new SessionManager(Buffer.alloc(0))).toThrow(/key.*32|32.*byte/i)
    })
  })

  describe('sign + verify round-trip', () => {
    it('returns the login on a valid cookie', () => {
      const sm = new SessionManager(VALID_KEY)
      const cookie = sm.sign('octocat')
      const result = sm.verify(cookie)
      expect(result).not.toBeNull()
      expect(result?.login).toBe('octocat')
    })

    it('round-trips with a different login', () => {
      const sm = new SessionManager(VALID_KEY)
      const cookie = sm.sign('mrbrown')
      const result = sm.verify(cookie)
      expect(result?.login).toBe('mrbrown')
    })
  })

  describe('tamper resistance', () => {
    it('rejects a tampered payload (different login)', () => {
      const sm = new SessionManager(VALID_KEY)
      const cookie = sm.sign('octocat')
      // Replace the payload part with a different login
      const [, sig] = cookie.split('.')
      const fakePayload = Buffer.from(JSON.stringify({login: 'attacker', exp: Date.now() / 1000 + 3600})).toString('base64url')
      const tampered = `${fakePayload}.${sig ?? ''}`
      expect(sm.verify(tampered)).toBeNull()
    })

    it('rejects a tampered signature', () => {
      const sm = new SessionManager(VALID_KEY)
      const cookie = sm.sign('octocat')
      const [payload] = cookie.split('.')
      const fakeSig = Buffer.from('deadbeef'.repeat(8), 'hex').toString('base64url')
      const tampered = `${payload ?? ''}.${fakeSig}`
      expect(sm.verify(tampered)).toBeNull()
    })

    it('rejects a cookie signed with a different key', () => {
      const sm1 = new SessionManager(VALID_KEY)
      const sm2 = new SessionManager(Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'utf8'))
      const cookie = sm1.sign('octocat')
      expect(sm2.verify(cookie)).toBeNull()
    })
  })

  describe('expiry', () => {
    it('rejects an expired cookie (exp in the past)', () => {
      const sm = new SessionManager(VALID_KEY)
      // Manually craft an expired cookie
      const payload = Buffer.from(
        JSON.stringify({login: 'octocat', exp: Math.floor(Date.now() / 1000) - 1}),
      ).toString('base64url')
      // Sign it properly so only expiry is the issue
      const hmac = createHmac('sha256', VALID_KEY).update(payload).digest()
      const sig = Buffer.from(hmac).toString('base64url')
      const expiredCookie = `${payload}.${sig}`
      expect(sm.verify(expiredCookie)).toBeNull()
    })

    it('accepts a cookie that expires in the future', () => {
      const sm = new SessionManager(VALID_KEY)
      const cookie = sm.sign('octocat')
      // Should be valid immediately after signing
      expect(sm.verify(cookie)).not.toBeNull()
    })
  })

  describe('malformed input', () => {
    it('rejects an empty string', () => {
      const sm = new SessionManager(VALID_KEY)
      expect(sm.verify('')).toBeNull()
    })

    it('rejects a cookie with no dot separator', () => {
      const sm = new SessionManager(VALID_KEY)
      expect(sm.verify('nodothere')).toBeNull()
    })

    it('rejects a cookie with invalid base64url payload', () => {
      const sm = new SessionManager(VALID_KEY)
      expect(sm.verify('!!!invalid!!!.sig')).toBeNull()
    })

    it('rejects a cookie with non-JSON payload', () => {
      const sm = new SessionManager(VALID_KEY)
      const payload = Buffer.from('not-json').toString('base64url')
      const sig = Buffer.from('fakesig').toString('base64url')
      expect(sm.verify(`${payload}.${sig}`)).toBeNull()
    })
  })

  describe('canonical 2-part base64url enforcement (FIX #6)', () => {
    it('rejects a cookie with 0 dots (no separator)', () => {
      const sm = new SessionManager(VALID_KEY)
      expect(sm.verify('nodothere')).toBeNull()
    })

    it('rejects a cookie with 2 dots (3 parts)', () => {
      const sm = new SessionManager(VALID_KEY)
      const payload = Buffer.from(JSON.stringify({login: 'octocat', exp: Date.now() / 1000 + 3600})).toString('base64url')
      expect(sm.verify(`${payload}.fakesig.extra`)).toBeNull()
    })

    it('rejects a cookie with non-base64url chars in payload', () => {
      const sm = new SessionManager(VALID_KEY)
      // '+' and '/' are base64 but not base64url
      expect(sm.verify('abc+def/ghi.validpart')).toBeNull()
    })

    it('rejects a cookie with non-base64url chars in signature', () => {
      const sm = new SessionManager(VALID_KEY)
      const payload = Buffer.from(JSON.stringify({login: 'octocat', exp: Date.now() / 1000 + 3600})).toString('base64url')
      expect(sm.verify(`${payload}.abc+def/ghi`)).toBeNull()
    })

    it('rejects a cookie with spaces in it', () => {
      const sm = new SessionManager(VALID_KEY)
      expect(sm.verify('abc def.ghijkl')).toBeNull()
    })

    it('valid signed cookie still passes (regression guard)', () => {
      const sm = new SessionManager(VALID_KEY)
      const cookie = sm.sign('octocat')
      expect(sm.verify(cookie)).not.toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// decodeKey hardening tests (imported via loadCookieKey internals via env)
// We test decodeKey indirectly through SessionManager construction + loadCookieKey
// by exercising the exported loadCookieKey with env vars.
// ---------------------------------------------------------------------------

describe('decodeKey hardening (FIX P2 — weak key rejection)', () => {
  // We test the hardened decodeKey by importing loadCookieKey and setting env vars.
  // Since loadCookieKey is async and reads env, we use dynamic import + env manipulation.

  it('44 "A" chars (documented exploit) → rejected (hex-decodes to 22 bytes, too short)', async () => {
    // 44 'A's is a valid hex string (even length) but decodes to only 22 bytes
    const {loadCookieKey} = await import('../src/session.ts')
    const original = process.env.DASHBOARD_COOKIE_KEY
    process.env.DASHBOARD_COOKIE_KEY = 'A'.repeat(44)
    try {
      await expect(loadCookieKey()).rejects.toThrow(/too short|32 bytes/i)
    } finally {
      if (original === undefined) {
        delete process.env.DASHBOARD_COOKIE_KEY
      } else {
        process.env.DASHBOARD_COOKIE_KEY = original
      }
    }
  })

  it('all-zero 64-char hex key → rejected (degenerate key)', async () => {
    const {loadCookieKey} = await import('../src/session.ts')
    const original = process.env.DASHBOARD_COOKIE_KEY
    process.env.DASHBOARD_COOKIE_KEY = '0'.repeat(64) // 32 zero bytes
    try {
      await expect(loadCookieKey()).rejects.toThrow(/degenerate|forgeable/i)
    } finally {
      if (original === undefined) {
        delete process.env.DASHBOARD_COOKIE_KEY
      } else {
        process.env.DASHBOARD_COOKIE_KEY = original
      }
    }
  })

  it('valid 32-byte hex key → accepted', async () => {
    const {loadCookieKey} = await import('../src/session.ts')
    const original = process.env.DASHBOARD_COOKIE_KEY
    // 64 hex chars = 32 bytes, mixed values (not degenerate)
    process.env.DASHBOARD_COOKIE_KEY = 'deadbeefcafebabe0102030405060708090a0b0c0d0e0f101112131415161718'
    try {
      const key = await loadCookieKey()
      expect(key.length).toBe(32)
    } finally {
      if (original === undefined) {
        delete process.env.DASHBOARD_COOKIE_KEY
      } else {
        process.env.DASHBOARD_COOKIE_KEY = original
      }
    }
  })

  it('valid 32-byte base64 key → accepted', async () => {
    const {loadCookieKey} = await import('../src/session.ts')
    const original = process.env.DASHBOARD_COOKIE_KEY
    // 32 random-ish bytes encoded as base64 (not a hex string — contains non-hex chars)
    const rawKey = Buffer.from('deadbeefcafebabe0102030405060708090a0b0c0d0e0f101112131415161718', 'hex')
    process.env.DASHBOARD_COOKIE_KEY = rawKey.toString('base64')
    try {
      const key = await loadCookieKey()
      expect(key.length).toBe(32)
    } finally {
      if (original === undefined) {
        delete process.env.DASHBOARD_COOKIE_KEY
      } else {
        process.env.DASHBOARD_COOKIE_KEY = original
      }
    }
  })

  it('raw 32-byte random buffer (via env as base64) → accepted', async () => {
    const {loadCookieKey} = await import('../src/session.ts')
    const original = process.env.DASHBOARD_COOKIE_KEY
    // Simulate a raw key passed as base64url (non-hex chars ensure hex path is skipped)
    const rawKey = Buffer.from('xK9mP2nQ7rT4vW1yZ6aB3cD8eF5gH0iJ', 'utf8') // 32 bytes, mixed
    process.env.DASHBOARD_COOKIE_KEY = rawKey.toString('base64')
    try {
      const key = await loadCookieKey()
      expect(key.length).toBeGreaterThanOrEqual(32)
    } finally {
      if (original === undefined) {
        delete process.env.DASHBOARD_COOKIE_KEY
      } else {
        process.env.DASHBOARD_COOKIE_KEY = original
      }
    }
  })

  it('single-repeated-byte key (all 0xFF) → rejected (degenerate)', async () => {
    const {loadCookieKey} = await import('../src/session.ts')
    const original = process.env.DASHBOARD_COOKIE_KEY
    // 64 'f' chars = 32 bytes all 0xFF
    process.env.DASHBOARD_COOKIE_KEY = 'f'.repeat(64)
    try {
      await expect(loadCookieKey()).rejects.toThrow(/degenerate|forgeable/i)
    } finally {
      if (original === undefined) {
        delete process.env.DASHBOARD_COOKIE_KEY
      } else {
        process.env.DASHBOARD_COOKIE_KEY = original
      }
    }
  })
})
