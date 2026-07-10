/**
 * Push notification DTOs and parse helpers for the operator contract.
 *
 * VapidKeyResponse mirrors the Gateway's `GET /operator/push/vapid-key`
 * response: `{publicKey, keyVersion}` only — there is NO `contractVersion`
 * field on this response.
 *
 * PushSubscriptionMetadata mirrors the Gateway's safe-metadata response from
 * `GET /operator/push/subscriptions`: an opaque endpoint hash, timestamps,
 * key version, active state, and an optional coarse inactive reason. The
 * real `endpoint`/`p256dh`/`auth` subscription keys are never included.
 *
 * PushHandoffState is NOT a wire field — it is derived client-side from
 * PushSubscriptionMetadata plus local browser state (permission, local
 * PushSubscription presence/keyVersion). It is defined here so the vendored
 * contract and the web-side duplicate (web/src/push/push-types.ts) share one
 * canonical string set.
 *
 * Error messages are fixed strings — never echo or interpolate input.
 * Extra fields are ignored (permissive structural subtyping).
 */

import type {Result} from '../../result.ts'

import {err, ok} from '../../result.ts'

// Practical caps: keyVersion strings and endpoint hashes are well under 512
// chars; ISO 8601 dates are at most ~35 chars.
const MAX_ID_LENGTH = 512
const MAX_DATE_LENGTH = 128
const ENDPOINT_HASH_LENGTH = 64

/**
 * Canonical response shape for GET /operator/push/vapid-key.
 * EXACTLY these two fields — the Gateway returns no other fields.
 */
export interface VapidKeyResponse {
  readonly publicKey: string
  readonly keyVersion: string
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

/** Parse an unknown value as VapidKeyResponse. Returns err with a fixed reason string on failure. */
export function parseVapidKeyResponse(input: unknown): Result<VapidKeyResponse, Error> {
  if (hasValidVapidKeyShape(input) === false) {
    return err(new Error('invalid vapid key response shape'))
  }

  // Closed DTO — copy only declared fields; never spread input.
  const response: VapidKeyResponse = {
    publicKey: input.publicKey,
    keyVersion: input.keyVersion,
  }

  return ok(response)
}

/**
 * Client-derived push handoff state. NOT a wire field — computed from
 * PushSubscriptionMetadata plus local browser state. Defined here as the
 * single canonical string set shared between the vendored contract and the
 * web-side duplicate.
 */
export type PushHandoffState = 'push_disabled' | 'not_subscribed' | 'subscribed' | 'stale_key' | 'inactive'

const VALID_PUSH_HANDOFF_STATES: ReadonlySet<string> = new Set([
  'push_disabled',
  'not_subscribed',
  'subscribed',
  'stale_key',
  'inactive',
])

/** Parse an unknown value as PushHandoffState. Returns err with a fixed reason string on failure. */
export function parsePushHandoffState(input: unknown): Result<PushHandoffState, Error> {
  if (typeof input !== 'string' || !VALID_PUSH_HANDOFF_STATES.has(input)) {
    return err(new Error('invalid push handoff state'))
  }

  return ok(input as PushHandoffState)
}

/**
 * Safe subscription metadata, mirroring the Gateway's
 * `GET /operator/push/subscriptions` response. Opaque endpoint hash only —
 * NEVER the raw endpoint, p256dh, or auth subscription keys.
 */
export interface PushSubscriptionMetadata {
  readonly endpointHash: string
  readonly keyVersion: string
  readonly active: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly inactiveReason?: string
}

function hasValidPushSubscriptionMetadataShape(value: unknown): value is PushSubscriptionMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>

  if (
    typeof candidate.endpointHash !== 'string' ||
    candidate.endpointHash.length !== ENDPOINT_HASH_LENGTH
  ) {
    return false
  }

  if (typeof candidate.keyVersion !== 'string' || candidate.keyVersion.length > MAX_ID_LENGTH) {
    return false
  }

  if (typeof candidate.active !== 'boolean') {
    return false
  }

  if (typeof candidate.createdAt !== 'string' || candidate.createdAt.length > MAX_DATE_LENGTH) {
    return false
  }

  if (typeof candidate.updatedAt !== 'string' || candidate.updatedAt.length > MAX_DATE_LENGTH) {
    return false
  }

  // inactiveReason is optional — if present must be a length-capped string
  if (
    'inactiveReason' in candidate &&
    (typeof candidate.inactiveReason !== 'string' || candidate.inactiveReason.length > MAX_ID_LENGTH)
  ) {
    return false
  }

  return true
}

/** Parse an unknown value as PushSubscriptionMetadata. Returns err with a fixed reason string on failure. */
export function parsePushSubscriptionMetadata(input: unknown): Result<PushSubscriptionMetadata, Error> {
  if (hasValidPushSubscriptionMetadataShape(input) === false) {
    return err(new Error('invalid push subscription metadata shape'))
  }

  // Closed DTO — copy only declared fields; never spread input.
  const metadata: PushSubscriptionMetadata = {
    endpointHash: input.endpointHash,
    keyVersion: input.keyVersion,
    active: input.active,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...('inactiveReason' in input ? {inactiveReason: input.inactiveReason} : {}),
  }

  return ok(metadata)
}
