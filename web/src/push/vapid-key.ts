/**
 * VAPID public-key helpers: base64url→Uint8Array conversion for
 * `PushManager.subscribe({applicationServerKey})`, and a fail-closed parser
 * for the Gateway's `GET /operator/push/vapid-key` response.
 *
 * Web-local — no import from `src/`.
 */
import type {Result} from '@bfra.me/es/result'
import type {VapidKeyResponse} from './push-types.ts'

import {err, ok} from '@bfra.me/es/result'

/**
 * Convert a base64url string (VAPID public key) to a Uint8Array.
 *
 * Padding math MUST be `'='.repeat((4 - (base64url.length % 4)) % 4)` — the
 * outer `% 4` is essential so length-multiple-of-4 inputs don't get 4 `=`
 * appended (which throws in `atob`). This is the single most-reported Web
 * Push bug.
 */
export function urlB64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + padding).replaceAll('-', '+').replaceAll('_', '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.codePointAt(i) ?? 0
  }
  return outputArray
}

function hasValidVapidKeyShape(value: unknown): value is VapidKeyResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.publicKey !== 'string' || candidate.publicKey.length === 0) {
    return false
  }

  if (typeof candidate.keyVersion !== 'string' || candidate.keyVersion.length === 0) {
    return false
  }

  return true
}

/**
 * Parse an unknown value as VapidKeyResponse. Fail-closed on malformed or
 * missing `publicKey`/`keyVersion`; returns a fixed reason string on
 * failure — never echoes input. Extra fields are ignored.
 */
export function parseVapidKeyResponse(input: unknown): Result<VapidKeyResponse, Error> {
  if (hasValidVapidKeyShape(input) === false) {
    return err(new Error('invalid vapid key response shape'))
  }

  return ok({
    publicKey: input.publicKey,
    keyVersion: input.keyVersion,
  })
}
