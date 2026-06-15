/**
 * Signed-cookie session management.
 *
 * Cookie format: `<base64url(json)>.<base64url(hmac-sha256)>`
 *
 * The HMAC is computed over the base64url-encoded JSON payload, so the `exp`
 * field is always covered by the signature. Tampering with either the payload
 * or the signature is detected via `timingSafeEqual`.
 *
 * Security invariants:
 * - Key MUST be ≥32 bytes (256-bit). Constructor throws on weaker keys.
 * - `exp` is checked AFTER signature verification (fail-closed order).
 * - Comparison uses `timingSafeEqual` to prevent timing attacks.
 */
import {Buffer} from 'node:buffer'
import {createHmac, timingSafeEqual} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import process from 'node:process'

/** Verified session payload returned by `SessionManager.verify`. */
export interface SessionPayload {
  readonly login: string
}

/** Raw cookie payload stored in the signed cookie. */
interface CookiePayload {
  login: string
  exp: number // Unix epoch seconds
}

/** Session duration: 24 hours in seconds. */
const SESSION_TTL_SECONDS = 24 * 60 * 60

/**
 * Manages signed session cookies using HMAC-SHA256.
 *
 * Cookie format: `<base64url(json)>.<base64url(hmac)>`
 * The HMAC covers the base64url-encoded payload string (not the raw JSON),
 * ensuring the `exp` field is always within the signed scope.
 */
export class SessionManager {
  private readonly key: Buffer

  constructor(key: Buffer) {
    if (key.length < 32) {
      throw new Error(`Cookie signing key must be at least 32 bytes (256-bit); got ${key.length} bytes`)
    }
    this.key = key
  }

  /**
   * Signs a session for the given login.
   * Returns a cookie value string: `<base64url(payload)>.<base64url(hmac)>`
   */
  sign(login: string): string {
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
    const payload: CookiePayload = {login, exp}
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const hmac = this.computeHmac(payloadB64)
    return `${payloadB64}.${hmac}`
  }

  /**
   * Verifies a cookie value.
   * Returns the session payload if valid, or `null` if invalid/expired/tampered.
   *
   * Verification order (fail-closed):
   * 1. Parse structure (must have exactly one dot separator)
   * 2. Recompute HMAC and compare with `timingSafeEqual`
   * 3. Decode and parse JSON payload
   * 4. Check expiry
   */
  verify(cookieValue: string): SessionPayload | null {
    try {
      const dotIndex = cookieValue.indexOf('.')
      if (dotIndex === -1) return null

      const payloadB64 = cookieValue.slice(0, dotIndex)
      const sigB64 = cookieValue.slice(dotIndex + 1)

      if (payloadB64.length === 0 || sigB64.length === 0) return null

      // Recompute HMAC and compare (timing-safe)
      const expectedSig = this.computeHmac(payloadB64)
      const expectedBuf = Buffer.from(expectedSig, 'base64url')
      const actualBuf = Buffer.from(sigB64, 'base64url')

      // Length check before timingSafeEqual (different lengths = definitely tampered)
      if (expectedBuf.length !== actualBuf.length) return null
      if (!timingSafeEqual(expectedBuf, actualBuf)) return null

      // Decode payload
      const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf8')
      const payload = JSON.parse(jsonStr) as unknown

      if (!isCookiePayload(payload)) return null

      // Check expiry
      const nowSeconds = Math.floor(Date.now() / 1000)
      if (payload.exp <= nowSeconds) return null

      return {login: payload.login}
    } catch {
      return null
    }
  }

  private computeHmac(data: string): string {
    return createHmac('sha256', this.key).update(data).digest('base64url')
  }
}

function isCookiePayload(value: unknown): value is CookiePayload {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.login === 'string' && typeof obj.exp === 'number'
}

/**
 * Loads the cookie signing key from env or file.
 *
 * Priority:
 * 1. `DASHBOARD_COOKIE_KEY` env var (hex or base64 encoded, decoded to raw bytes)
 * 2. File at `DASHBOARD_COOKIE_KEY_FILE` env var (or `/data/cookie.key`)
 *
 * Throws if the resolved key is <32 bytes (fail-closed).
 */
export async function loadCookieKey(): Promise<Buffer> {
  const envKey = process.env.DASHBOARD_COOKIE_KEY
  if (typeof envKey === 'string' && envKey.length > 0) {
    return decodeKey(envKey)
  }

  const keyFile = process.env.DASHBOARD_COOKIE_KEY_FILE ?? '/data/cookie.key'
  const raw = await readFile(keyFile)
  // File may contain hex/base64 text or raw bytes
  const trimmed = raw.toString('utf8').trim()
  return decodeKey(trimmed)
}

/**
 * Decodes a key string (hex, base64, or raw UTF-8) to a Buffer.
 * Tries hex first, then base64, then falls back to raw UTF-8.
 * Validates that the result is ≥32 bytes.
 */
function decodeKey(input: string): Buffer {
  // Try hex (64 hex chars = 32 bytes)
  if (/^[\da-f]+$/i.test(input) && input.length % 2 === 0) {
    const buf = Buffer.from(input, 'hex')
    if (buf.length >= 32) return buf
  }

  // Try base64
  const b64Buf = Buffer.from(input, 'base64')
  if (b64Buf.length >= 32) return b64Buf

  // Raw UTF-8
  const rawBuf = Buffer.from(input, 'utf8')
  if (rawBuf.length >= 32) return rawBuf

  throw new Error(`Cookie signing key must be at least 32 bytes (256-bit); decoded key is too short`)
}
