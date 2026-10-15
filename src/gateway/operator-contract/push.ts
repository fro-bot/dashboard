/**
 * Push notification DTOs and parse helpers for the operator contract.
 *
 * VapidKeyResponse mirrors the Gateway's `GET /operator/push/vapid-key`
 * response: `{publicKey, keyVersion}` only — there is NO `contractVersion`
 * field on this response.
 *
 * PushSubscriptionMetadata mirrors one entry of the Gateway's
 * `GET /operator/push/subscriptions` response (`{subscriptions: [...]}`): an
 * opaque endpoint hash, numeric timestamps, key version, active state, and an
 * optional coarse inactive reason. The real `endpoint`/`p256dh`/`auth`
 * subscription keys are never included.
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

// Practical cap: keyVersion strings are well under 512 chars.
const MAX_ID_LENGTH = 512
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

export type PushInactiveReason = 'unsubscribed' | 'dead' | 'revoked' | 'session-revoked'

const VALID_PUSH_INACTIVE_REASONS: ReadonlySet<string> = new Set(['unsubscribed', 'dead', 'revoked', 'session-revoked'])

/**
 * Safe subscription metadata, mirroring one entry of the Gateway's
 * `GET /operator/push/subscriptions` response. Opaque endpoint hash only —
 * NEVER the raw endpoint, p256dh, or auth subscription keys. Timestamps are
 * epoch-millisecond numbers.
 */
export interface PushSubscriptionMetadata {
  readonly endpointHash: string
  readonly keyVersion: string
  readonly active: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly inactiveReason?: PushInactiveReason
}

/** Canonical response shape for GET /operator/push/subscriptions. */
export interface PushSubscriptionListResponse {
  readonly subscriptions: readonly PushSubscriptionMetadata[]
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Parse one list entry field by field; undefined when any field is invalid. */
function parsePushSubscriptionMetadataEntry(value: unknown): PushSubscriptionMetadata | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.endpointHash !== 'string' || candidate.endpointHash.length !== ENDPOINT_HASH_LENGTH) {
    return undefined
  }

  if (typeof candidate.keyVersion !== 'string' || candidate.keyVersion.length > MAX_ID_LENGTH) {
    return undefined
  }

  if (typeof candidate.active !== 'boolean') {
    return undefined
  }

  if (!isTimestamp(candidate.createdAt) || !isTimestamp(candidate.updatedAt)) {
    return undefined
  }

  // Closed DTO — copy only declared fields; never spread input. An unknown
  // inactiveReason is dropped rather than rejecting the entry.
  return {
    endpointHash: candidate.endpointHash,
    keyVersion: candidate.keyVersion,
    active: candidate.active,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    ...(typeof candidate.inactiveReason === 'string' && VALID_PUSH_INACTIVE_REASONS.has(candidate.inactiveReason)
      ? {inactiveReason: candidate.inactiveReason as PushInactiveReason}
      : {}),
  }
}

/**
 * Parse an unknown value as the Gateway's subscription list. Invalid entries
 * are dropped; a value that is not `{subscriptions: [...]}` returns err with a
 * fixed reason string.
 */
export function parsePushSubscriptionListResponse(input: unknown): Result<PushSubscriptionListResponse, Error> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err(new Error('invalid push subscription list shape'))
  }

  const {subscriptions} = input as Record<string, unknown>
  if (!Array.isArray(subscriptions)) {
    return err(new Error('invalid push subscription list shape'))
  }

  const valid: PushSubscriptionMetadata[] = []
  for (const entry of subscriptions) {
    const parsed = parsePushSubscriptionMetadataEntry(entry)
    if (parsed !== undefined) valid.push(parsed)
  }

  return ok({subscriptions: valid})
}
