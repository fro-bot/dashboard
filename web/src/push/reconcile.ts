/**
 * Pure browser↔Gateway push drift decision.
 *
 * Two pure functions, no I/O:
 *  - `derivePushHandoffState` correlates local browser state (endpoint hash,
 *    current key version) against the Gateway's safe subscription metadata
 *    to derive a `HandoffState`. The join key is `sha256(endpoint)`
 *    (`endpoint-hash.ts`) — the caller computes it before calling in.
 *  - `reconcile` maps (permission, local-subscription-presence, handoffState)
 *    to a `{uiState, action}` pair implementing the drift matrix from the
 *    plan's High-Level Technical Design.
 *
 * Web-local — no import from `src/`.
 */
import type {HandoffState, PushSubscriptionMetadata} from './push-types.ts'

/**
 * Input to `derivePushHandoffState`.
 *
 * `pushDisabled: true` is the caller's translation of a Gateway 404 into the
 * synthetic push_disabled signal (HTTP status alone, never response-body
 * shape) — see `getPushSubscriptionMetadata`. When set, it always wins
 * over `metadata`.
 */
export interface DeriveHandoffStateInput {
  readonly pushDisabled: boolean
  readonly metadata: PushSubscriptionMetadata | undefined
}

/**
 * Derive the client-side `HandoffState` from local browser state plus the
 * Gateway's safe subscription metadata.
 *
 * Correlation rule: the local subscription is considered "the same
 * subscription" as a Gateway record only when `metadata.endpointHash`
 * equals the caller-computed `localEndpointHash` — a matching Gateway record
 * with a *different* endpoint hash belongs to another device/subscription
 * and must never be treated as `subscribed`.
 *
 * `localEndpointHash === undefined` (no local `PushSubscription`, or its
 * endpoint hash hasn't been computed yet) is treated as an unknown match —
 * conservatively `not_subscribed`, never a false `subscribed`. Callers that
 * need "unknown → cleanup" route through `reconcile`'s not_subscribed/
 * inactive + present branch, which already issues cleanup.
 */
export function derivePushHandoffState(
  localEndpointHash: string | undefined,
  currentKeyVersion: string | undefined,
  input: DeriveHandoffStateInput,
): HandoffState {
  if (input.pushDisabled) return 'push_disabled'

  const {metadata} = input

  if (metadata === undefined) return 'not_subscribed'

  // Unknown local endpoint hash: never claim a match, however tempting.
  if (localEndpointHash === undefined) return 'not_subscribed'

  const matches = metadata.endpointHash === localEndpointHash

  if (matches === false) return 'not_subscribed'

  if (metadata.active === false) return 'inactive'

  if (currentKeyVersion !== undefined && metadata.keyVersion !== currentKeyVersion) {
    return 'stale_key'
  }

  return 'subscribed'
}

export type ReconcileUiState =
  | 'not-requested'
  | 'subscribed'
  | 'denied'
  | 'unsupported'

export type ReconcileAction = 'none' | 'register' | 'resubscribe' | 'cleanup' | 'cleanup-and-unsubscribe'

export interface ReconcileResult {
  readonly uiState: ReconcileUiState
  readonly action: ReconcileAction
}

/**
 * Pure drift decision. Implements every row of the drift matrix in the
 * plan's High-Level Technical Design.
 *
 * `permission` is the browser's `Notification.permission` read
 * ('default' | 'granted' | 'denied'). `localSubscriptionPresent` is whether
 * a local `PushSubscription` currently exists.
 */
export function reconcile(
  permission: NotificationPermission,
  localSubscriptionPresent: boolean,
  handoffState: HandoffState,
): ReconcileResult {
  // push_disabled wins regardless of permission/local state.
  if (handoffState === 'push_disabled') {
    return {
      uiState: 'unsupported',
      action: localSubscriptionPresent ? 'cleanup' : 'none',
    }
  }

  if (permission === 'denied') {
    return {
      uiState: 'denied',
      action: localSubscriptionPresent ? 'cleanup-and-unsubscribe' : 'cleanup',
    }
  }

  if (permission === 'default') {
    return {
      uiState: 'not-requested',
      action: localSubscriptionPresent ? 'cleanup-and-unsubscribe' : 'none',
    }
  }

  // permission === 'granted' from here down.

  if (handoffState === 'subscribed') {
    return {uiState: 'subscribed', action: 'none'}
  }

  if (handoffState === 'stale_key') {
    return {uiState: 'subscribed', action: 'resubscribe'}
  }

  // not_subscribed / inactive
  return {
    uiState: 'not-requested',
    action: localSubscriptionPresent ? 'cleanup' : 'register',
  }
}
