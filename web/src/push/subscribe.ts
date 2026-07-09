/**
 * Opt-in/opt-out push subscribe orchestration + reconcile-sweep trigger
 * wiring.
 *
 * Browser-direct `/operator/push/*` calls (never the server-side
 * `src/gateway/operator-client.ts` — `web/` must never import from `src/`).
 * The fetch/CSRF/idempotency/retry posture mirrors `public/operator-launch.js`
 * `buildLaunchClient` (`credentials:'include'`, `redirect:'error'`,
 * `x-csrf-token` + `idempotency-key` headers, one CSRF-400 retry reusing the
 * same idempotency key).
 *
 * Web-local — no import from `src/`.
 */
import type {Result} from '@bfra.me/es/result'
import {err, ok} from '@bfra.me/es/result'
import {getNotificationPermission, getPushSupport} from './capability.ts'
import {endpointHash} from './endpoint-hash.ts'
import type {HandoffState, PushSubscriptionMetadata, VapidKeyResponse} from './push-types.ts'
import {derivePushHandoffState, reconcile} from './reconcile.ts'
import {urlB64ToUint8Array} from './vapid-key.ts'

// ---------------------------------------------------------------------------
// Browser-direct push client
// ---------------------------------------------------------------------------

export interface PushClientError {
  readonly kind: 'http' | 'network' | 'protocol' | 'validation'
  readonly status?: number
}

export interface PushClient {
  refreshCsrf(): Promise<Result<string, PushClientError>>
  getVapidKey(): Promise<Result<VapidKeyResponse, PushClientError>>
  /**
   * `pushDisabled: true` is set only when the Gateway route returned HTTP
   * 404 — the synthetic push_disabled signal driven by status alone, never
   * response-body shape. A non-404 error stays a normal `PushClientError`.
   */
  getPushSubscriptionMetadata(): Promise<
    Result<{readonly pushDisabled: boolean; readonly metadata: PushSubscriptionMetadata | undefined}, PushClientError>
  >
  subscribePush(
    subscriptionJson: unknown,
    csrfToken: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<Result<void, PushClientError>>
  unsubscribePush(endpoint: string, csrfToken: string, idempotencyKey: string): Promise<Result<void, PushClientError>>
}

export interface BuildPushClientOptions {
  readonly endpointBase?: string
}

function hasValidSubscriptionMetadataShape(value: unknown): value is PushSubscriptionMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.endpointHash === 'string' &&
    typeof c.keyVersion === 'string' &&
    typeof c.active === 'boolean' &&
    typeof c.createdAt === 'string' &&
    typeof c.updatedAt === 'string'
  )
}

/**
 * Build the browser-direct push client. Same-origin `/operator/push/*`
 * routes only (reverse-proxied to the Gateway) — never a call into
 * server-side `src/` code.
 */
export function buildPushClient(opts?: BuildPushClientOptions): PushClient {
  const endpointBase = opts?.endpointBase ?? '/operator/push'

  const browserFetch = (input: string, init?: RequestInit): Promise<Response> =>
    globalThis.fetch(input, {
      ...init,
      credentials: 'include',
      redirect: 'error',
    })

  return {
    async refreshCsrf() {
      try {
        const res = await browserFetch('/operator/session/csrf', {
          headers: {'content-type': 'application/json'},
        })
        if (!res.ok) return err({kind: 'http', status: res.status})
        const data = (await res.json()) as unknown
        if (data === null || typeof data !== 'object' || typeof (data as {csrfToken?: unknown}).csrfToken !== 'string') {
          return err({kind: 'protocol'})
        }
        return ok((data as {csrfToken: string}).csrfToken)
      } catch {
        return err({kind: 'network'})
      }
    },

    async getVapidKey() {
      try {
        const res = await browserFetch(`${endpointBase}/vapid-key`, {
          headers: {'content-type': 'application/json'},
        })
        if (res.status === 404) return err({kind: 'protocol'})
        if (!res.ok) return err({kind: 'http', status: res.status})
        const data = (await res.json()) as unknown
        if (
          data === null ||
          typeof data !== 'object' ||
          typeof (data as {publicKey?: unknown}).publicKey !== 'string' ||
          typeof (data as {keyVersion?: unknown}).keyVersion !== 'string'
        ) {
          return err({kind: 'protocol'})
        }
        return ok(data as VapidKeyResponse)
      } catch {
        return err({kind: 'network'})
      }
    },

    async getPushSubscriptionMetadata() {
      try {
        const res = await browserFetch(`${endpointBase}/subscriptions`, {
          headers: {'content-type': 'application/json'},
        })
        if (res.status === 404) return ok({pushDisabled: true, metadata: undefined})
        if (!res.ok) return err({kind: 'http', status: res.status})
        const data = (await res.json()) as unknown
        if (data === null || typeof data !== 'object') {
          return ok({pushDisabled: false, metadata: undefined})
        }
        // Gateway returns either an empty object (no subscription) or the metadata shape.
        if (hasValidSubscriptionMetadataShape(data) === false) {
          return ok({pushDisabled: false, metadata: undefined})
        }
        return ok({pushDisabled: false, metadata: data})
      } catch {
        return err({kind: 'network'})
      }
    },

    async subscribePush(subscriptionJson, csrfToken, idempotencyKey, signal) {
      if (csrfToken.trim() === '') return err({kind: 'validation'})
      if (idempotencyKey.trim() === '') return err({kind: 'validation'})
      try {
        const res = await browserFetch(`${endpointBase}/subscriptions`, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(subscriptionJson),
        })
        if (res.ok) return ok(undefined)
        return err({kind: 'http', status: res.status})
      } catch {
        if (signal?.aborted === true) return err({kind: 'network'})
        return err({kind: 'network'})
      }
    },

    async unsubscribePush(endpoint, csrfToken, idempotencyKey) {
      if (csrfToken.trim() === '') return err({kind: 'validation'})
      if (idempotencyKey.trim() === '') return err({kind: 'validation'})
      try {
        const res = await browserFetch(`${endpointBase}/subscriptions/unsubscribe`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({endpoint}),
        })
        if (res.ok) return ok(undefined)
        return err({kind: 'http', status: res.status})
      } catch {
        return err({kind: 'network'})
      }
    },
  }
}

/** Mint a fresh unique idempotency key. Memory-only — never persisted or logged. */
export function mintIdempotencyKey(): string {
  if (globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2)
  return `${ts}-${rand}`
}

// ---------------------------------------------------------------------------
// Subscribe orchestration
// ---------------------------------------------------------------------------

/** Minimal shape of a browser PushSubscription needed by this module. */
export interface MinimalPushSubscription {
  readonly endpoint: string
  toJSON(): unknown
  unsubscribe(): Promise<boolean>
}

export interface MinimalPushManager {
  subscribe(options: {userVisibleOnly: boolean; applicationServerKey: Uint8Array}): Promise<MinimalPushSubscription>
  getSubscription(): Promise<MinimalPushSubscription | null>
}

export interface MinimalServiceWorkerRegistration {
  readonly pushManager: MinimalPushManager
}

export type SubscribeOutcome =
  | {readonly kind: 'subscribed'}
  | {readonly kind: 'sw-not-ready'}
  | {readonly kind: 'ios-not-installed'}
  | {readonly kind: 'unsupported'}
  | {readonly kind: 'dismissed'}
  | {readonly kind: 'denied'}
  | {readonly kind: 'subscribe-failed'}
  | {readonly kind: 'aborted'}

export interface SubscribeDeps {
  /** Resolves once the SW is ready — normally `navigator.serviceWorker.ready`. */
  readonly serviceWorkerReady: () => Promise<MinimalServiceWorkerRegistration>
  readonly getSupport?: () => {readonly supported: boolean; readonly needsInstall: boolean}
  readonly getPermission?: () => NotificationPermission | 'unsupported'
  readonly requestPermission: () => Promise<NotificationPermission>
  readonly pushClient: PushClient
  readonly signal?: AbortSignal
  readonly swReadyTimeoutMs?: number
  readonly mintIdempotencyKey?: () => string
}

const DEFAULT_SW_READY_TIMEOUT_MS = 5000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve('timeout')
      },
    )
  })
}

/**
 * Opt-in orchestration: `serviceWorker.ready` (5s timeout) → capability/iOS
 * gate → `Notification.requestPermission()` (skipped if already granted,
 * e.g. on a retry) → `getVapidKey` → `pushManager.subscribe` →
 * `subscribePush` POST. On a Gateway-POST failure after a successful browser
 * subscribe, calls local `unsubscribe()` before surfacing subscribe-failed.
 * An `AbortSignal` (e.g. from a logout mid-flow) discards the result before
 * any POST — the caller passes `deps.signal` through.
 */
export async function subscribeOptIn(deps: SubscribeDeps): Promise<SubscribeOutcome> {
  const getSupport = deps.getSupport ?? getPushSupport
  const getPermission = deps.getPermission ?? getNotificationPermission
  const mintKey = deps.mintIdempotencyKey ?? mintIdempotencyKey

  const support = getSupport()
  if (support.needsInstall) return {kind: 'ios-not-installed'}
  if (support.supported === false) return {kind: 'unsupported'}

  const readyResult = await withTimeout(deps.serviceWorkerReady(), deps.swReadyTimeoutMs ?? DEFAULT_SW_READY_TIMEOUT_MS)
  if (readyResult === 'timeout') return {kind: 'sw-not-ready'}
  const registration = readyResult

  if (deps.signal?.aborted) return {kind: 'aborted'}

  const currentPermission = getPermission()
  let permission: NotificationPermission
  if (currentPermission === 'granted') {
    // Already granted (e.g. a subscribe-failed retry) — never re-prompt.
    permission = 'granted'
  } else {
    permission = await deps.requestPermission()
  }

  if (permission === 'denied') return {kind: 'denied'}
  if (permission !== 'granted') return {kind: 'dismissed'}

  if (deps.signal?.aborted) return {kind: 'aborted'}

  const vapidResult = await deps.pushClient.getVapidKey()
  if (!vapidResult.success) return {kind: 'subscribe-failed'}

  if (deps.signal?.aborted) return {kind: 'aborted'}

  let subscription: MinimalPushSubscription
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(vapidResult.data.publicKey),
    })
  } catch {
    return {kind: 'subscribe-failed'}
  }

  if (deps.signal?.aborted) return {kind: 'aborted'}

  const csrfResult = await deps.pushClient.refreshCsrf()
  if (!csrfResult.success) {
    await subscription.unsubscribe().catch(() => false)
    return {kind: 'subscribe-failed'}
  }

  if (deps.signal?.aborted) {
    return {kind: 'aborted'}
  }

  const postResult = await deps.pushClient.subscribePush(
    subscription.toJSON(),
    csrfResult.data,
    mintKey(),
    deps.signal,
  )

  if (deps.signal?.aborted) return {kind: 'aborted'}

  if (!postResult.success) {
    await subscription.unsubscribe().catch(() => false)
    return {kind: 'subscribe-failed'}
  }

  return {kind: 'subscribed'}
}

/**
 * `stale_key` resubscribe. Ordering (with an acknowledged no-coverage
 * window): fetch new key → local `unsubscribe()` (required before
 * `pushManager.subscribe()`, which rejects `InvalidStateError` if a
 * subscription already exists) → resubscribe → POST. Skips the native
 * permission prompt (only reachable when permission is already granted).
 * Failure → subscribe-failed; retry re-runs this same flow.
 */
export async function resubscribeStaleKey(deps: SubscribeDeps): Promise<SubscribeOutcome> {
  const mintKey = deps.mintIdempotencyKey ?? mintIdempotencyKey

  const readyResult = await withTimeout(deps.serviceWorkerReady(), deps.swReadyTimeoutMs ?? DEFAULT_SW_READY_TIMEOUT_MS)
  if (readyResult === 'timeout') return {kind: 'sw-not-ready'}
  const registration = readyResult

  if (deps.signal?.aborted) return {kind: 'aborted'}

  const vapidResult = await deps.pushClient.getVapidKey()
  if (!vapidResult.success) return {kind: 'subscribe-failed'}

  const existing = await registration.pushManager.getSubscription()
  if (existing !== null) {
    await existing.unsubscribe().catch(() => false)
  }

  if (deps.signal?.aborted) return {kind: 'aborted'}

  let subscription: MinimalPushSubscription
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(vapidResult.data.publicKey),
    })
  } catch {
    return {kind: 'subscribe-failed'}
  }

  if (deps.signal?.aborted) return {kind: 'aborted'}

  const csrfResult = await deps.pushClient.refreshCsrf()
  if (!csrfResult.success) {
    await subscription.unsubscribe().catch(() => false)
    return {kind: 'subscribe-failed'}
  }

  const postResult = await deps.pushClient.subscribePush(subscription.toJSON(), csrfResult.data, mintKey(), deps.signal)

  if (deps.signal?.aborted) return {kind: 'aborted'}

  if (!postResult.success) {
    await subscription.unsubscribe().catch(() => false)
    return {kind: 'subscribe-failed'}
  }

  return {kind: 'subscribed'}
}

export interface UnsubscribeDeps {
  readonly getLocalSubscription: () => Promise<MinimalPushSubscription | null>
  readonly pushClient: PushClient
  readonly mintIdempotencyKey?: () => string
}

/**
 * Opt-out / logout / revocation cleanup. Always attempts local
 * `unsubscribe()` first. Gateway unsubscribe requires `{endpoint}` — when no
 * concrete endpoint is available locally (no active `PushSubscription`), the
 * Gateway call is skipped entirely and cleanup relies on Gateway-side
 * cleanup (dead-sub detection, session revocation, privacy delete). The
 * endpoint is NEVER persisted solely to work around this.
 */
export async function unsubscribeOptOut(deps: UnsubscribeDeps): Promise<{readonly gatewayUnsubscribeCalled: boolean}> {
  const mintKey = deps.mintIdempotencyKey ?? mintIdempotencyKey
  const subscription = await deps.getLocalSubscription().catch(() => null)

  if (subscription === null) {
    // Endpointless case — nothing to unsubscribe locally or remotely.
    return {gatewayUnsubscribeCalled: false}
  }

  const {endpoint} = subscription
  await subscription.unsubscribe().catch(() => false)

  const csrfResult = await deps.pushClient.refreshCsrf()
  if (!csrfResult.success) return {gatewayUnsubscribeCalled: false}

  await deps.pushClient.unsubscribePush(endpoint, csrfResult.data, mintKey())
  return {gatewayUnsubscribeCalled: true}
}

// ---------------------------------------------------------------------------
// Reconcile sweep trigger wiring
// ---------------------------------------------------------------------------

export interface ReconcileSweepCache {
  readonly permission: NotificationPermission | 'unsupported'
  readonly subscriptionPresent: boolean
  readonly handoffState: HandoffState | undefined
  readonly lastActionAt: number
}

export const INITIAL_RECONCILE_SWEEP_CACHE: ReconcileSweepCache = {
  permission: 'default',
  subscriptionPresent: false,
  handoffState: undefined,
  lastActionAt: 0,
}

export interface ReconcileSweepDeps {
  readonly getLocalSubscription: () => Promise<MinimalPushSubscription | null>
  readonly getPermission?: () => NotificationPermission | 'unsupported'
  readonly pushClient: PushClient
  /** Current Gateway VAPID key version, if known (fetched separately/cached by the caller). */
  readonly getCurrentKeyVersion?: () => string | undefined
  readonly now?: () => number
  readonly minIntervalMs?: number
}

export interface ReconcileSweepResult {
  readonly skipped: boolean
  readonly action: import('./reconcile.ts').ReconcileAction | undefined
  readonly uiState: import('./reconcile.ts').ReconcileUiState | undefined
  readonly nextCache: ReconcileSweepCache
}

const DEFAULT_MIN_INTERVAL_MS = 30_000

/**
 * Run one reconcile sweep: computes `endpointHash(subscription.endpoint)`
 * when a local subscription exists, fetches Gateway metadata, derives the
 * handoff state, and returns the reconcile action.
 *
 * Debounce/no-change guard: skips the Gateway GET (and any action) when
 * permission + local-subscription-presence are unchanged since the cached
 * sweep, or when the minimum interval between reconcile actions hasn't
 * elapsed — so rapid `visibilitychange`/`focus` cycling cannot trigger
 * subscribe/unsubscribe storms.
 */
export async function runReconcileSweep(
  deps: ReconcileSweepDeps,
  cache: ReconcileSweepCache,
): Promise<ReconcileSweepResult> {
  const getPermission = deps.getPermission ?? getNotificationPermission
  const now = deps.now ?? Date.now
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS

  const permission = getPermission()
  const localSubscription = await deps.getLocalSubscription().catch(() => null)
  const subscriptionPresent = localSubscription !== null

  // cache.handoffState === undefined means no sweep has run yet — always run the
  // first sweep regardless of how the cache's other fields happen to be seeded.
  const unchanged =
    cache.handoffState !== undefined &&
    permission === cache.permission &&
    subscriptionPresent === cache.subscriptionPresent
  const withinMinInterval = cache.handoffState !== undefined && now() - cache.lastActionAt < minIntervalMs

  if (unchanged || withinMinInterval) {
    return {skipped: true, action: undefined, uiState: undefined, nextCache: cache}
  }

  const metadataResult = await deps.pushClient.getPushSubscriptionMetadata()
  if (!metadataResult.success) {
    // Transport/protocol error — do not mutate state on an inconclusive read.
    return {skipped: true, action: undefined, uiState: undefined, nextCache: cache}
  }

  const localHash = subscriptionPresent && localSubscription !== null ? await endpointHash(localSubscription.endpoint) : undefined
  const currentKeyVersion = deps.getCurrentKeyVersion?.()

  const handoffState = derivePushHandoffState(localHash, currentKeyVersion, metadataResult.data)

  const permissionForReconcile: NotificationPermission = permission === 'unsupported' ? 'denied' : permission
  const {uiState, action} = reconcile(permissionForReconcile, subscriptionPresent, handoffState)

  const nextCache: ReconcileSweepCache = {
    permission,
    subscriptionPresent,
    handoffState,
    lastActionAt: now(),
  }

  return {skipped: false, action, uiState, nextCache}
}
