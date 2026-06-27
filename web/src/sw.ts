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
  if ((e.data as {type?: string} | null)?.type === 'PURGE_RUNTIME') {
    e.waitUntil(
      Promise.all([caches.delete(OPERATOR_RUNTIME_CACHE), caches.delete(LEGACY_MONITORING_CACHE)]).then(
        () => undefined,
      ),
    )
  }
})
