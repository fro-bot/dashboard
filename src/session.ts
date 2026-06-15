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
      // FIX #6: Enforce canonical 2-part structure (exactly one dot separator).
      const parts = cookieValue.split('.')
      if (parts.length !== 2) return null

      const payloadB64 = parts[0] ?? ''
      const sigB64 = parts[1] ?? ''

      if (payloadB64.length === 0 || sigB64.length === 0) return null

      // Validate both parts are strict base64url (no padding, no non-base64url chars)
      const BASE64URL_RE = /^[\w-]+$/
      if (!BASE64URL_RE.test(payloadB64) || !BASE64URL_RE.test(sigB64)) return null

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
  const rawFile = await readFile(keyFile)

  // If the file is already ≥32 raw bytes and not obviously text-encoded, try raw first.
  // We detect "obviously text-encoded" by checking if the content is valid ASCII printable
  // (hex or base64 chars only). If it looks like raw binary, skip text decoding.
  const trimmed = rawFile.toString('utf8').trim()
  // Only treat as text-encoded if the trimmed content is entirely printable ASCII
  const isPrintableAscii = /^[\u0020-\u007E]+$/.test(trimmed)
  if (isPrintableAscii) {
    return decodeKey(trimmed)
  }

  // Raw binary file
  if (rawFile.length >= 32) {
    assertNonDegenerate(rawFile)
    return rawFile
  }

  throw new Error(`Cookie signing key must be at least 32 bytes (256-bit); file key is too short (${rawFile.length} bytes)`)
}

/**
 * Decodes a key string (hex or base64) to a Buffer.
 *
 * Hardened against the "44 A's" exploit:
 * - Only treats input as hex if it FULLY matches /^[0-9a-fA-F]+$/ AND has even length
 *   AND decodes to ≥32 bytes.
 * - Only treats as base64 if it matches base64 charset AND decodes to ≥32 bytes.
 * - Does NOT fall through to a weaker decoder if a stronger one yields <32 bytes.
 * - Rejects all-zero and single-repeated-byte keys (degenerate/forgeable).
 * - Does NOT round-trip through UTF-8 for raw bytes (avoids U+FFFD corruption).
 *
 * Throws if no candidate yields a ≥32-byte non-degenerate key.
 */
function decodeKey(input: string): Buffer {
  const candidates: Buffer[] = []

  // Try hex ONLY if input is a full hex string with even length
  if (/^[\da-f]+$/i.test(input) && input.length % 2 === 0) {
    const buf = Buffer.from(input, 'hex')
    if (buf.length >= 32) {
      candidates.push(buf)
    }
    // If it matched hex but decoded to <32 bytes, do NOT fall through to base64
    // (the 44-A exploit: 44 hex chars → 22 bytes, then base64 of "AAAA..." → 33 null bytes)
    // We only add to candidates if ≥32 bytes; if hex matched but was too short, stop here.
    if (candidates.length === 0) {
      throw new Error(`Cookie signing key must be at least 32 bytes (256-bit); hex-decoded key is too short`)
    }
  } else {
    // Try base64 (standard or URL-safe) — only if not a hex string
    const isBase64 = /^[\w+/=-]+$/.test(input)
    if (isBase64) {
      // Try base64url first, then standard base64
      const b64Buf = Buffer.from(input, 'base64')
      if (b64Buf.length >= 32) {
        candidates.push(b64Buf)
      } else {
        throw new Error(`Cookie signing key must be at least 32 bytes (256-bit); base64-decoded key is too short`)
      }
    } else {
      // Raw UTF-8 passthrough (e.g. a long passphrase)
      const rawBuf = Buffer.from(input, 'utf8')
      if (rawBuf.length >= 32) {
        candidates.push(rawBuf)
      } else {
        throw new Error(`Cookie signing key must be at least 32 bytes (256-bit); decoded key is too short`)
      }
    }
  }

  const key = candidates[0]
  if (key === undefined) {
    throw new Error(`Cookie signing key must be at least 32 bytes (256-bit); decoded key is too short`)
  }

  assertNonDegenerate(key)
  return key
}

/**
 * Rejects degenerate keys: all-zero or single-repeated-byte.
 * These indicate a misconfigured or zeroed-out key that would be trivially forgeable.
 */
function assertNonDegenerate(key: Buffer): void {
  const first = key[0]
  if (first === undefined) {
    throw new Error('Cookie signing key is empty')
  }
  // Check if all bytes are identical (covers all-zero and any single-repeated-byte pattern)
  let allSame = true
  for (let i = 1; i < key.length; i++) {
    if (key[i] !== first) {
      allSame = false
      break
    }
  }
  if (allSame) {
    throw new Error(
      `Cookie signing key is degenerate (all bytes are 0x${first.toString(16).padStart(2, '0')}); this key is trivially forgeable — use a cryptographically random key`,
    )
  }
}
