/**
 * Service Worker — deny-by-default fetch router.
 *
 * Registration order is load-bearing (specific before catch-all):
 *   1. /auth/*            → NetworkOnly  (OAuth must reach the server)
 *   2. /operator/auth/*   → NetworkOnly  (operator auth must reach the server)
 *   3. /api/*             → NetworkOnly  (default-deny; all API routes)
 *   4. precache           → precacheAndRoute(self.__WB_MANIFEST) + cleanupOutdatedCaches()
 *   5. /operator nav      → local redirect to / (canonicalize old links offline)
 *   6. navigate           → NavigationRoute(/) denylist [/auth/, /operator/auth/, /api/]
 *
 * Precache (4) MUST come before the NavigationRoute (6): createHandlerBoundToURL
 * resolves '/' against the precache at call time, so the manifest must be
 * precached first or SW registration throws non-precached-url and aborts.
 *
 * SECURITY: A SW intercepts ALL same-origin navigations + fetches once registered.
 * The denylist on NavigationRoute and the NetworkOnly routes for /auth/* and /api/*
 * ensure OAuth callbacks and API calls always reach the server.
 *
 * OPERATOR DATA POLICY: operator session, run, stream, approval, launch, and
 * run-index responses are network-only/no-store. Only the static shell and
 * hashed assets are precached. Runtime caches are purged on logout, auth change,
 * and app-version change via the PURGE_RUNTIME message handler.
 *
 * INSTALLED-CLIENT MIGRATION: old installed clients running the previous SW may
 * briefly serve the old monitoring shell for /operator until they open the app,
 * see the update prompt, and activate the new SW. This is an accepted version-
 * gated cutover caveat — do not add forced activation outside the prompt-mode
 * discipline. The /operator redirect handler below ensures that once the new SW
 * is active, offline /operator navigations canonicalize to the cached / shell.
 */

import {cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute} from 'workbox-precaching'
import {NavigationRoute, registerRoute} from 'workbox-routing'
import {NetworkOnly} from 'workbox-strategies'
import {OPERATOR_RUNTIME_CACHE} from './pwa/cache-names.ts'
// The only non-Workbox import in this file: a pure payload→safe-notification
// mapping module. Any future non-Workbox import here should be a conscious
// decision (the no-server-imports guard does not cover new web-side imports).
import {buildNotification} from './push/sw-notification.ts'

declare const self: ServiceWorkerGlobalScope

// 1. Auth routes — OAuth callbacks must reach the server.
registerRoute(
  ({url}) => url.pathname.startsWith('/auth/') || url.pathname === '/auth',
  new NetworkOnly(),
)

// 2. Operator auth routes — operator session auth must reach the server.
registerRoute(
  ({url}) => url.pathname.startsWith('/operator/auth/') || url.pathname === '/operator/auth',
  new NetworkOnly(),
)

// 3. API routes — default-deny; operator data must never be cached by the SW.
registerRoute(
  ({url}) => url.pathname.startsWith('/api/') || url.pathname === '/api',
  new NetworkOnly(),
)

// 4. Precache hashed app-shell assets.
// ORDER: precacheAndRoute MUST run before the NavigationRoute below.
// createHandlerBoundToURL('/') resolves against the precache at call time —
// if the manifest isn't precached yet, Workbox throws non-precached-url and aborts.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// 5. /operator navigation — redirect to / before the generic NavigationRoute fires.
// Ensures offline old links canonicalize to the cached operator shell.
// The server also redirects /operator → / unconditionally; this is the offline guard.
registerRoute(
  ({request, url}) =>
    request.mode === 'navigate' &&
    (url.pathname === '/operator' || url.pathname === '/operator/'),
  () => Promise.resolve(Response.redirect('/', 302)),
)

// 6. Navigation requests → precached app shell.
// /auth/*, /operator/auth/*, and /api/* are denylisted so server-side auth
// redirects run for those paths.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/'), {
    denylist: [/^\/auth(\/|$)/, /^\/operator\/auth(\/|$)/, /^\/api(\/|$)/],
  }),
)

// Logout purge handler — page posts {type:'PURGE_RUNTIME'} on logout, auth
// change, or app-version change. Only runtime caches are deleted — NOT the
// precache (app shell must survive logout for instant next-user load).
//
// Legacy purge: monitoring-v1 is the orphaned cache from the pre-migration SW.
// Clients that installed the old SW may still have it on disk; delete it here
// so stale monitoring data does not linger after migration.
//
// Type note: ExtendableMessageEvent is in the WebWorker lib (not DOM). Minimal
// inline interface avoids adding the WebWorker lib to tsconfig (conflicting globals).
interface SWMessageEvent extends Event {
  readonly data: unknown
  waitUntil(f: Promise<unknown>): void
}

const LEGACY_MONITORING_CACHE = 'monitoring-v1'

addEventListener('message', (event: Event) => {
  const e = event as SWMessageEvent
  const messageType = (e.data as {type?: string} | null)?.type
  if (messageType === 'PURGE_RUNTIME') {
    e.waitUntil(
      Promise.all([caches.delete(OPERATOR_RUNTIME_CACHE), caches.delete(LEGACY_MONITORING_CACHE)]).then(
        () => undefined,
      ),
    )
  }
  // Dev-only synthetic push: the notifications consent surface posts
  // {type:'MOCK_SYNTHETIC_PUSH', payload} to the SW for visual verification
  // without a real push subscription/relay round-trip. Routed through the
  // same safe-copy mapping as a real push — never renders raw payload text.
  if (messageType === 'MOCK_SYNTHETIC_PUSH') {
    const {title, body, data} = buildNotification((e.data as {payload?: unknown} | null)?.payload)
    e.waitUntil(registration.showNotification(title, {body, data}))
  }
})

// Push, notificationclick, and pushsubscriptionchange handlers.
//
// Touch NO cache — these are notification-lifecycle concerns, orthogonal to
// the fetch/cache routing above. Registered after the message handler per
// plan ordering; does not affect the load-bearing precache/navigation order.
//
// Type note: PushEvent, NotificationEvent, PushSubscriptionChangeEvent, and
// the Clients/WindowClient/ServiceWorkerRegistration.pushManager surface are
// WebWorker-lib types (not DOM). Minimal inline interfaces — same pattern as
// SWMessageEvent above — avoid adding the WebWorker lib to tsconfig
// (conflicting globals with the DOM lib this file otherwise uses).

interface SWPushEvent extends Event {
  readonly data: {json(): unknown} | null
  waitUntil(f: Promise<unknown>): void
}

interface SWWindowClient {
  readonly focused: boolean
  readonly visibilityState: string
  focus(): Promise<unknown>
  postMessage(message: unknown): void
}

interface SWClients {
  matchAll(options: {type: 'window'; includeUncontrolled?: boolean}): Promise<SWWindowClient[]>
  openWindow(url: string): Promise<unknown>
}

interface SWNotification {
  close(): void
}

interface SWNotificationEvent extends Event {
  readonly notification: SWNotification
  waitUntil(f: Promise<unknown>): void
}

interface SWPushSubscription {
  readonly options: {readonly applicationServerKey: unknown}
}

interface SWPushManager {
  getSubscription(): Promise<SWPushSubscription | null>
  subscribe(options: {userVisibleOnly: boolean; applicationServerKey: unknown}): Promise<unknown>
}

interface SWPushSubscriptionChangeEvent extends Event {
  readonly oldSubscription: SWPushSubscription | null
  waitUntil(f: Promise<unknown>): void
}

declare const clients: SWClients
declare const registration: {
  showNotification(title: string, options: {body: string; data: unknown}): Promise<void>
  readonly pushManager: SWPushManager
}

/**
 * `push`: parse defensively; always show a notification (never silent) via
 * the fixed safe-copy mapping in `sw-notification.ts`. The SW push handler
 * is an always-safe fallback — it renders regardless of the dashboard's
 * consent-UI flag state, because a subscription created during a prior
 * enablement can outlive a flag flip.
 */
addEventListener('push', (event: Event) => {
  const e = event as SWPushEvent
  let rawPayload: unknown
  try {
    rawPayload = e.data?.json()
  } catch {
    rawPayload = undefined
  }

  const {title, body, data} = buildNotification(rawPayload)
  e.waitUntil(registration.showNotification(title, {body, data}))
})

/**
 * `notificationclick`: neutral click routing. Always opens/focuses the
 * literal `/` — never reads `notification.data.route` or any payload field
 * as a navigation target (open-redirect guard). Prefers an existing
 * focused window, then any visible window, before opening a new one.
 */
addEventListener('notificationclick', (event: Event) => {
  const e = event as SWNotificationEvent
  e.notification.close()
  e.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(windowClients => {
      const focused = windowClients.find(client => client.focused)
      const visible = windowClients.find(client => client.visibilityState === 'visible')
      const target = focused ?? visible
      if (target !== undefined) {
        return target.focus()
      }
      return clients.openWindow('/')
    }),
  )
})

/**
 * `pushsubscriptionchange`: best-effort only. Push is a non-authoritative
 * channel — the page-driven reconcile owns correctness. No durable
 * queue: the postMessage hint is in-memory only and is simply dropped if no
 * client is open. The SW persists nothing about the subscription. Never
 * throws — any failure here is recovered by the page's next load/visibility
 * reconcile, not by retry logic in the SW.
 */
addEventListener('pushsubscriptionchange', (event: Event) => {
  const e = event as SWPushSubscriptionChangeEvent
  e.waitUntil(
    (async () => {
      try {
        const oldSubscription = e.oldSubscription ?? (await registration.pushManager.getSubscription())
        const applicationServerKey = oldSubscription?.options.applicationServerKey ?? undefined

        if (applicationServerKey != null) {
          try {
            await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey,
            })
          } catch {
            // Best-effort resubscribe failed (e.g. VAPID key rotated). No
            // recovery is attempted here — the page's next load/visibility
            // reconcile detects stale_key and corrects.
          }
        }

        const windowClients = await clients.matchAll({type: 'window'})
        for (const client of windowClients) {
          client.postMessage({type: 'PUSH_SUBSCRIPTION_CHANGE'})
        }
      } catch {
        // Best-effort only — never throws out of the event handler.
      }
    })(),
  )
})
