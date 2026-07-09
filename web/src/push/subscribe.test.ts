import {err, ok} from '@bfra.me/es/result'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {PushSubscriptionMetadata, VapidKeyResponse} from './push-types.ts'
import type {
  MinimalPushSubscription,
  MinimalServiceWorkerRegistration,
  PushClient,
  ReconcileSweepCache,
} from './subscribe.ts'
import {
  buildPushClient,
  INITIAL_RECONCILE_SWEEP_CACHE,
  resubscribeStaleKey,
  runReconcileSweep,
  subscribeOptIn,
  unsubscribeOptOut,
} from './subscribe.ts'

const VAPID: VapidKeyResponse = {publicKey: 'BNc3xVwB', keyVersion: 'v1'}

function fakeSubscription(endpoint = 'https://push.example/abc'): MinimalPushSubscription & {
  unsubscribeMock: ReturnType<typeof vi.fn>
} {
  const unsubscribeMock = vi.fn().mockResolvedValue(true)
  return {
    endpoint,
    toJSON: () => ({endpoint}),
    unsubscribe: unsubscribeMock,
    unsubscribeMock,
  }
}

function fakeRegistration(subscription: MinimalPushSubscription): MinimalServiceWorkerRegistration & {
  subscribeMock: ReturnType<typeof vi.fn>
} {
  const subscribeMock = vi.fn().mockResolvedValue(subscription)
  return {
    pushManager: {
      subscribe: subscribeMock,
      getSubscription: vi.fn().mockResolvedValue(null),
    },
    subscribeMock,
  }
}

function fakePushClient(overrides: Partial<PushClient> = {}): PushClient {
  return {
    refreshCsrf: vi.fn().mockResolvedValue(ok('csrf-token')),
    getVapidKey: vi.fn().mockResolvedValue(ok({pushDisabled: false, vapidKey: VAPID})),
    getPushSubscriptionMetadata: vi.fn().mockResolvedValue(ok({pushDisabled: false, metadata: undefined})),
    subscribePush: vi.fn().mockResolvedValue(ok(undefined)),
    unsubscribePush: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  }
}

describe('buildPushClient', () => {
  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'},
    })
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('subscribePush: 400 refreshes CSRF once and retries once reusing the same idempotency key', async () => {
    const fetchMock = vi.fn()
    // 1: initial POST -> 400
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {}))
    // 2: refreshCsrf -> new token
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {csrfToken: 'fresh-token'}))
    // 3: retry POST -> success
    fetchMock.mockResolvedValueOnce(new Response(null, {status: 200}))
    vi.stubGlobal('fetch', fetchMock)

    const client = buildPushClient()
    const result = await client.subscribePush({endpoint: 'x'}, 'stale-token', 'idem-key-1')

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const firstCallInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    const retryCallInit = fetchMock.mock.calls[2]?.[1] as RequestInit
    const firstHeaders = firstCallInit.headers as Record<string, string>
    const retryHeaders = retryCallInit.headers as Record<string, string>

    expect(firstHeaders['idempotency-key']).toBe('idem-key-1')
    expect(retryHeaders['idempotency-key']).toBe('idem-key-1')
    expect(retryHeaders['x-csrf-token']).toBe('fresh-token')
  })

  it('subscribePush: CSRF-refresh 401/403 surfaces as {kind:"http",status}, not {kind:"network"}', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {}))
    fetchMock.mockResolvedValueOnce(new Response(null, {status: 401}))
    vi.stubGlobal('fetch', fetchMock)

    const client = buildPushClient()
    const result = await client.subscribePush({endpoint: 'x'}, 'stale-token', 'idem-key-1')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toEqual({kind: 'http', status: 401})
    }
  })

  it('unsubscribePush: 400 refreshes CSRF once and retries once reusing the same idempotency key', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {}))
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {csrfToken: 'fresh-token'}))
    fetchMock.mockResolvedValueOnce(new Response(null, {status: 200}))
    vi.stubGlobal('fetch', fetchMock)

    const client = buildPushClient()
    const result = await client.unsubscribePush('https://push.example/ep', 'stale-token', 'idem-key-2')

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const retryCallInit = fetchMock.mock.calls[2]?.[1] as RequestInit
    const retryHeaders = retryCallInit.headers as Record<string, string>
    expect(retryHeaders['idempotency-key']).toBe('idem-key-2')
    expect(retryHeaders['x-csrf-token']).toBe('fresh-token')
  })

  it('getVapidKey: 404 -> pushDisabled success shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {status: 404}))
    vi.stubGlobal('fetch', fetchMock)

    const client = buildPushClient()
    const result = await client.getVapidKey()

    expect(result).toEqual(ok({pushDisabled: true, vapidKey: undefined}))
  })

  it('getVapidKey: success -> pushDisabled false with the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {publicKey: 'BNc3xVwB', keyVersion: 'v1'}))
    vi.stubGlobal('fetch', fetchMock)

    const client = buildPushClient()
    const result = await client.getVapidKey()

    expect(result).toEqual(ok({pushDisabled: false, vapidKey: {publicKey: 'BNc3xVwB', keyVersion: 'v1'}}))
  })
})

describe('subscribeOptIn', () => {
  it('happy path: full support + granted + subscribe + POST -> subscribed', async () => {
    const subscription = fakeSubscription()
    const registration = fakeRegistration(subscription)
    const pushClient = fakePushClient()

    const outcome = await subscribeOptIn({
      serviceWorkerReady: () => Promise.resolve(registration),
      getSupport: () => ({supported: true, needsInstall: false}),
      getPermission: () => 'default',
      requestPermission: vi.fn().mockResolvedValue('granted'),
      pushClient,
    })

    expect(outcome).toEqual({kind: 'subscribed'})
    expect(pushClient.subscribePush).toHaveBeenCalledTimes(1)
  })

  it('iOS non-installed -> needsInstall, no requestPermission call', async () => {
    const requestPermission = vi.fn()
    const outcome = await subscribeOptIn({
      serviceWorkerReady: () => Promise.resolve(fakeRegistration(fakeSubscription())),
      getSupport: () => ({supported: false, needsInstall: true}),
      getPermission: () => 'default',
      requestPermission,
      pushClient: fakePushClient(),
    })

    expect(outcome).toEqual({kind: 'ios-not-installed'})
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('serviceWorker.ready exceeding 5s -> sw-not-ready', async () => {
    vi.useFakeTimers()
    try {
      const neverResolves = new Promise<MinimalServiceWorkerRegistration>(() => {})
      const promise = subscribeOptIn({
        serviceWorkerReady: () => neverResolves,
        getSupport: () => ({supported: true, needsInstall: false}),
        getPermission: () => 'default',
        requestPermission: vi.fn().mockResolvedValue('granted'),
        pushClient: fakePushClient(),
        swReadyTimeoutMs: 5000,
      })
      await vi.advanceTimersByTimeAsync(5001)
      const outcome = await promise
      expect(outcome).toEqual({kind: 'sw-not-ready'})
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismissed (default) is distinct from denied', async () => {
    const outcome = await subscribeOptIn({
      serviceWorkerReady: () => Promise.resolve(fakeRegistration(fakeSubscription())),
      getSupport: () => ({supported: true, needsInstall: false}),
      getPermission: () => 'default',
      requestPermission: vi.fn().mockResolvedValue('default'),
      pushClient: fakePushClient(),
    })
    expect(outcome).toEqual({kind: 'dismissed'})
  })

  it('denied permission -> denied outcome', async () => {
    const outcome = await subscribeOptIn({
      serviceWorkerReady: () => Promise.resolve(fakeRegistration(fakeSubscription())),
      getSupport: () => ({supported: true, needsInstall: false}),
      getPermission: () => 'default',
      requestPermission: vi.fn().mockResolvedValue('denied'),
      pushClient: fakePushClient(),
    })
    expect(outcome).toEqual({kind: 'denied'})
  })

  it('VAPID fetch failure with granted permission -> subscribe-failed; retry skips native prompt', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    const pushClient = fakePushClient({getVapidKey: vi.fn().mockResolvedValue(err({kind: 'http', status: 401}))})
    const registration = fakeRegistration(fakeSubscription())

    const outcome = await subscribeOptIn({
      serviceWorkerReady: () => Promise.resolve(registration),
      getSupport: () => ({supported: true, needsInstall: false}),
      getPermission: () => 'default',
      requestPermission,
      pushClient,
    })
    expect(outcome).toEqual({kind: 'subscribe-failed'})

    // Retry: permission is now granted — must not re-prompt.
    requestPermission.mockClear()
    const retryOutcome = await subscribeOptIn({
      serviceWorkerReady: () => Promise.resolve(fakeRegistration(fakeSubscription())),
      getSupport: () => ({supported: true, needsInstall: false}),
      getPermission: () => 'granted',
      requestPermission,
      pushClient: fakePushClient(),
    })
    expect(retryOutcome).toEqual({kind: 'subscribed'})
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('browser subscribe ok but Gateway POST fails -> local unsubscribe() called, subscribe-failed', async () => {
    const subscription = fakeSubscription()
    const registration = fakeRegistration(subscription)
    const pushClient = fakePushClient({
      subscribePush: vi.fn().mockResolvedValue(err({kind: 'http', status: 500})),
    })

    const outcome = await subscribeOptIn({
      serviceWorkerReady: () => Promise.resolve(registration),
      getSupport: () => ({supported: true, needsInstall: false}),
      getPermission: () => 'default',
      requestPermission: vi.fn().mockResolvedValue('granted'),
      pushClient,
    })

    expect(outcome).toEqual({kind: 'subscribe-failed'})
    expect(subscription.unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it('race: logout mid-flight (abort) discards the result and never POSTs', async () => {
    const controller = new AbortController()
    const subscription = fakeSubscription()
    const registration = fakeRegistration(subscription)
    const pushClient = fakePushClient({
      getVapidKey: vi.fn().mockImplementation(async () => {
        controller.abort()
        return ok({pushDisabled: false, vapidKey: VAPID})
      }),
    })

    const outcome = await subscribeOptIn({
      serviceWorkerReady: () => Promise.resolve(registration),
      getSupport: () => ({supported: true, needsInstall: false}),
      getPermission: () => 'default',
      requestPermission: vi.fn().mockResolvedValue('granted'),
      pushClient,
      signal: controller.signal,
    })

    expect(outcome).toEqual({kind: 'aborted'})
    expect(pushClient.subscribePush).not.toHaveBeenCalled()
  })
})

describe('resubscribeStaleKey', () => {
  it('re-runs the full flow: unsubscribe old, fetch key, resubscribe, POST', async () => {
    const oldSubscription = fakeSubscription('https://push.example/old')
    const newSubscription = fakeSubscription('https://push.example/new')
    const registration = fakeRegistration(newSubscription)
    registration.pushManager.getSubscription = vi.fn().mockResolvedValue(oldSubscription)
    const pushClient = fakePushClient()

    const outcome = await resubscribeStaleKey({
      serviceWorkerReady: () => Promise.resolve(registration),
      requestPermission: vi.fn(),
      pushClient,
    })

    expect(outcome).toEqual({kind: 'subscribed'})
    expect(oldSubscription.unsubscribeMock).toHaveBeenCalledTimes(1)
    expect(registration.subscribeMock).toHaveBeenCalledTimes(1)
    expect(pushClient.subscribePush).toHaveBeenCalledTimes(1)
  })

  it('reachable from subscribed state (no permission re-prompt) and failure -> subscribe-failed', async () => {
    const requestPermission = vi.fn()
    const subscription = fakeSubscription()
    const registration = fakeRegistration(subscription)
    const pushClient = fakePushClient({
      subscribePush: vi.fn().mockResolvedValue(err({kind: 'http', status: 500})),
    })

    const outcome = await resubscribeStaleKey({
      serviceWorkerReady: () => Promise.resolve(registration),
      requestPermission,
      pushClient,
    })

    expect(outcome).toEqual({kind: 'subscribe-failed'})
    expect(requestPermission).not.toHaveBeenCalled()
    expect(subscription.unsubscribeMock).toHaveBeenCalledTimes(1)
  })
})

describe('unsubscribeOptOut', () => {
  it('local unsubscribe + Gateway unsubscribe when an endpoint is available', async () => {
    const subscription = fakeSubscription()
    const pushClient = fakePushClient()

    const result = await unsubscribeOptOut({
      getLocalSubscription: () => Promise.resolve(subscription),
      pushClient,
    })

    expect(result).toEqual({gatewayUnsubscribeCalled: true})
    expect(subscription.unsubscribeMock).toHaveBeenCalledTimes(1)
    expect(pushClient.unsubscribePush).toHaveBeenCalledTimes(1)
  })

  it('endpointless case: no local subscription -> cleanup without calling Gateway unsubscribe', async () => {
    const pushClient = fakePushClient()

    const result = await unsubscribeOptOut({
      getLocalSubscription: () => Promise.resolve(null),
      pushClient,
    })

    expect(result).toEqual({gatewayUnsubscribeCalled: false})
    expect(pushClient.unsubscribePush).not.toHaveBeenCalled()
  })
})

describe('runReconcileSweep', () => {
  let cache: ReconcileSweepCache

  beforeEach(() => {
    cache = INITIAL_RECONCILE_SWEEP_CACHE
  })

  it('guard: repeated sweep with unchanged permission/subscription/handoff state performs no Gateway GET or action', async () => {
    const pushClient = fakePushClient()
    const deps = {
      getLocalSubscription: () => Promise.resolve(null),
      getPermission: () => 'default' as const,
      pushClient,
      now: () => 1_000_000,
    }

    const first = await runReconcileSweep(deps, cache)
    expect(first.skipped).toBe(false)

    const second = await runReconcileSweep(deps, first.nextCache)
    expect(second.skipped).toBe(true)
    expect(pushClient.getPushSubscriptionMetadata).toHaveBeenCalledTimes(1)
  })

  it('derive-handoff-state match -> subscribed action none', async () => {
    const subscription = fakeSubscription('https://push.example/known')
    const hash = await import('./endpoint-hash.ts').then(m => m.endpointHash(subscription.endpoint))
    const metadata: PushSubscriptionMetadata = {
      endpointHash: hash,
      keyVersion: 'v1',
      active: true,
      createdAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
    }
    const pushClient = fakePushClient({
      getPushSubscriptionMetadata: vi.fn().mockResolvedValue(ok({pushDisabled: false, metadata})),
    })

    const result = await runReconcileSweep(
      {
        getLocalSubscription: () => Promise.resolve(subscription),
        getPermission: () => 'granted',
        pushClient,
        getCurrentKeyVersion: () => 'v1',
        now: () => 1,
      },
      cache,
    )

    expect(result.skipped).toBe(false)
    expect(result.uiState).toBe('subscribed')
    expect(result.action).toBe('none')
  })

  it('derive-handoff-state mismatch -> not treated as subscribed', async () => {
    const subscription = fakeSubscription('https://push.example/mine')
    const metadata: PushSubscriptionMetadata = {
      endpointHash: 'f'.repeat(64),
      keyVersion: 'v1',
      active: true,
      createdAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
    }
    const pushClient = fakePushClient({
      getPushSubscriptionMetadata: vi.fn().mockResolvedValue(ok({pushDisabled: false, metadata})),
    })

    const result = await runReconcileSweep(
      {
        getLocalSubscription: () => Promise.resolve(subscription),
        getPermission: () => 'granted',
        pushClient,
        getCurrentKeyVersion: () => 'v1',
        now: () => 1,
      },
      cache,
    )

    expect(result.uiState).not.toBe('subscribed')
  })

  it('endpointless: metadata present but no local subscription -> cleans up without Gateway unsubscribe call', async () => {
    const metadata: PushSubscriptionMetadata = {
      endpointHash: 'a'.repeat(64),
      keyVersion: 'v1',
      active: true,
      createdAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
    }
    const pushClient = fakePushClient({
      getPushSubscriptionMetadata: vi.fn().mockResolvedValue(ok({pushDisabled: false, metadata})),
    })

    const result = await runReconcileSweep(
      {
        getLocalSubscription: () => Promise.resolve(null),
        getPermission: () => 'granted',
        pushClient,
        now: () => 1,
      },
      cache,
    )

    expect(result.action).toBe('register')
    expect(pushClient.unsubscribePush).not.toHaveBeenCalled()
  })
})
