/**
 * Web-local copy of the push DTOs and the HandoffState string set.
 *
 * This is duplicated here (rather than imported from
 * `src/gateway/operator-contract/push.ts`) because `web/` is the browser SPA
 * bundle and must never import from `src/` (the server) — the Docker builder
 * stage only copies `web/` into the image, so a `src/` import fails to
 * resolve at build time. Keep this in sync with the vendored copy; the
 * parity test in `push-types.test.ts` pins field names and the HandoffState
 * value set.
 */

/**
 * Canonical response shape for GET /operator/push/vapid-key.
 * EXACTLY these two fields — the Gateway returns no other fields.
 */
export interface VapidKeyResponse {
  readonly publicKey: string
  readonly keyVersion: string
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

/**
 * Client-derived push handoff state. NOT a wire field — computed from
 * PushSubscriptionMetadata plus local browser state (permission, local
 * PushSubscription presence/keyVersion).
 */
export type HandoffState = 'push_disabled' | 'not_subscribed' | 'subscribed' | 'stale_key' | 'inactive'

export const VALID_HANDOFF_STATES: ReadonlySet<string> = new Set([
  'push_disabled',
  'not_subscribed',
  'subscribed',
  'stale_key',
  'inactive',
])
