/**
 * Session cookie signing/verification tests.
 * Tests run BEFORE implementation (RED phase).
 *
 * Cookie format: `<base64url(json)>.<base64url(hmac-sha256)>`
 * HMAC covers the base64url-encoded payload (so exp is always in scope).
 */
import {Buffer} from 'node:buffer'
import {createHmac} from 'node:crypto'
import {describe, expect, it} from 'vitest'
import {SessionManager} from '../src/session.ts'

// 32-byte key (256-bit) — minimum valid key
const VALID_KEY = Buffer.from('a'.repeat(32), 'utf8') // 32 bytes

describe('SessionManager', () => {
  describe('constructor', () => {
    it('accepts a 32-byte key', () => {
      expect(() => new SessionManager(VALID_KEY)).not.toThrow()
    })

    it('accepts a key longer than 32 bytes', () => {
      const longKey = Buffer.from('b'.repeat(64), 'utf8')
      expect(() => new SessionManager(longKey)).not.toThrow()
    })

    it('throws on a key shorter than 32 bytes', () => {
      const weakKey = Buffer.from('short', 'utf8') // 5 bytes
      expect(() => new SessionManager(weakKey)).toThrow(/key.*32|32.*byte/i)
    })

    it('throws on a 31-byte key (boundary)', () => {
      const borderKey = Buffer.from('a'.repeat(31), 'utf8')
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
      const sm2 = new SessionManager(Buffer.from('b'.repeat(32), 'utf8'))
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
})
