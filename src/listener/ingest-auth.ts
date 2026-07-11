/**
 * HMAC signature verification for the operator listener ingest path.
 *
 * See docs/contracts/operator-listener-channel.md — signature scheme.
 * All error messages are generic ('unauthorized') — never echo body/signature.
 */
import type {Result} from '../result.ts'
import {Buffer} from 'node:buffer'
import {createHmac, timingSafeEqual} from 'node:crypto'
import {err, ok} from '../result.ts'

export interface IngestAuthInput {
  readonly key: string
  readonly rawBody: string
  readonly timestampHeader: string | null
  readonly signatureHeader: string | null
  readonly nowSeconds: number
  readonly windowSeconds?: number
}

const SIGNATURE_RE = /^sha256=([\da-f]+)$/i
const DEFAULT_WINDOW_SECONDS = 300

/**
 * Verifies the `x-listener-timestamp` / `x-listener-signature` HMAC pair over
 * the raw request body. Constant-time comparison via `timingSafeEqual`
 * (length-guarded to avoid a throw on mismatched lengths).
 */
export function verifyIngestSignature(input: IngestAuthInput): Result<true, Error> {
  const windowSeconds = input.windowSeconds ?? DEFAULT_WINDOW_SECONDS

  if (input.timestampHeader === null || input.signatureHeader === null) {
    return err(new Error('unauthorized'))
  }

  if (!/^\d+$/.test(input.timestampHeader)) {
    return err(new Error('unauthorized'))
  }
  const timestamp = Number.parseInt(input.timestampHeader, 10)
  if (!Number.isSafeInteger(timestamp)) {
    return err(new Error('unauthorized'))
  }

  if (Math.abs(input.nowSeconds - timestamp) > windowSeconds) {
    return err(new Error('unauthorized'))
  }

  const sigMatch = SIGNATURE_RE.exec(input.signatureHeader)
  if (sigMatch === null) {
    return err(new Error('unauthorized'))
  }
  const providedHex = sigMatch[1] ?? ''

  const expectedHex = createHmac('sha256', input.key).update(`${input.timestampHeader}.${input.rawBody}`).digest('hex')

  const expectedBuf = Buffer.from(expectedHex, 'hex')
  const providedBuf = Buffer.from(providedHex, 'hex')

  if (expectedBuf.length !== providedBuf.length) {
    return err(new Error('unauthorized'))
  }
  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return err(new Error('unauthorized'))
  }

  return ok(true)
}
