import {describe, expect, it} from 'vitest'
import {parseVapidKeyResponse, urlB64ToUint8Array} from './vapid-key.ts'

describe('parseVapidKeyResponse', () => {
  it('accepts {publicKey, keyVersion} and ignores extra fields', () => {
    const result = parseVapidKeyResponse({publicKey: 'abc123', keyVersion: 'v1', extra: 'ignored'})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({publicKey: 'abc123', keyVersion: 'v1'})
    }
  })

  it('rejects missing publicKey', () => {
    const result = parseVapidKeyResponse({keyVersion: 'v1'})
    expect(result.success).toBe(false)
  })

  it('rejects empty publicKey', () => {
    const result = parseVapidKeyResponse({publicKey: '', keyVersion: 'v1'})
    expect(result.success).toBe(false)
  })

  it('rejects non-string keyVersion', () => {
    const result = parseVapidKeyResponse({publicKey: 'abc123', keyVersion: 42})
    expect(result.success).toBe(false)
  })

  it('rejects null/non-object input', () => {
    expect(parseVapidKeyResponse(null).success).toBe(false)
    expect(parseVapidKeyResponse('abc').success).toBe(false)
    expect(parseVapidKeyResponse(undefined).success).toBe(false)
  })

  it('failure reason is a fixed string that never echoes input', () => {
    const secret = 'super-secret-value-12345'
    const result = parseVapidKeyResponse({publicKey: secret, keyVersion: 42})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).not.toContain(secret)
      expect(result.error.message).toBe('invalid vapid key response shape')
    }
  })
})

describe('urlB64ToUint8Array', () => {
  it('decodes padded and unpadded inputs identically', () => {
    // "hello" base64: aGVsbG8= ; base64url unpadded: aGVsbG8
    const padded = urlB64ToUint8Array('aGVsbG8=')
    const unpadded = urlB64ToUint8Array('aGVsbG8')
    expect(Array.from(padded)).toEqual(Array.from(unpadded))
    expect(new TextDecoder().decode(padded)).toBe('hello')
  })

  it('does not throw on a length-multiple-of-4 input', () => {
    // "test" -> base64 "dGVzdA==" but let's use an already-multiple-of-4 unpadded string
    // "abcd" (4 chars) decodes fine; ensure no extra padding added incorrectly.
    expect(() => urlB64ToUint8Array('abcd')).not.toThrow()
  })

  it('converts base64url characters (- and _) correctly', () => {
    // bytes [0xfb, 0xff, 0xbf] -> base64 "+/+/" -> base64url "-_-_"
    const decoded = urlB64ToUint8Array('-_-_')
    expect(Array.from(decoded)).toEqual([0xfb, 0xff, 0xbf])
  })

  it('round-trips a realistic VAPID-length key without throwing', () => {
    // 65-byte uncompressed EC public key, base64url-encoded, no padding (typical VAPID key length: 87 chars)
    const key = 'BEl62iUYgUivxIkv69yViEuiBIa40HI0DLLuxvzeoCoJ_9mzYSvw3ZoyVKUV0PC7Z8IcZ2LqXKmxE6JYNQnJJVs'
    expect(() => urlB64ToUint8Array(key)).not.toThrow()
    expect(urlB64ToUint8Array(key).length).toBeGreaterThan(0)
  })
})
