/**
 * Service Worker — deny-by-default fetch router.
 *
 * Registration order is load-bearing (specific before catch-all):
 *   1. /auth/*            → NetworkOnly  (OAuth must reach the server)
 *   2. /api/monitoring    → NetworkFirst (offline data cache + stale signal; Unit 3)
 *   3. /api/*             → NetworkOnly  (default-deny; all other API routes)
 *   4. navigate           → NavigationRoute(index.html) denylist [/auth/, /api/]
 *   5. precache           → precacheAndRoute(self.__WB_MANIFEST) + cleanupOutdatedCaches()
 *
 * SECURITY: A SW intercepts ALL same-origin navigations + fetches once registered.
 * The denylist on NavigationRoute and the NetworkOnly routes for /auth/* and /api/*
 * ensure OAuth callbacks and API calls always reach the server.
 *
 * CACHE-CONTROL NOTE: /api/monitoring sends Cache-Control: no-store. The SW Cache
 * Storage API (cache.put()) stores responses regardless of Cache-Control — the SW
 * cache is independent of the HTTP cache. no-store is intentionally kept unchanged:
 * it correctly prevents the browser HTTP disk cache from storing the response.
 * Changing it to 'private' would be a regression (allows HTTP disk caching).
 * See: W3C SW spec, MDN Cache, web.dev "Service workers and the Cache Storage API".
 */

import {cleanupOutdatedCaches, precacheAndRoute} from 'workbox-precaching'
import {NavigationRoute, registerRoute} from 'workbox-routing'
import {NetworkFirst, NetworkOnly} from 'workbox-strategies'
import {createHandlerBoundToURL} from 'workbox-precaching'
import {CacheableResponsePlugin} from 'workbox-cacheable-response'
import {ExpirationPlugin} from 'workbox-expiration'
import {addCachedAtHeader, markFromCache} from './sw-utils.ts'
import {MONITORING_CACHE} from './pwa/cache-names.ts'

export {addCachedAtHeader, markFromCache} from './sw-utils.ts'
// Re-export so any existing imports from sw.ts continue to work.
export {MONITORING_CACHE} from './pwa/cache-names.ts'

declare const self: ServiceWorkerGlobalScope

// ── Stale-signal plugin ──────────────────────────────────────────────────────
// Workbox plugin lifecycle callbacks that stamp stale-signal headers.
// Uses the pure functions above so the logic is independently testable.
// The full Workbox callback params are destructured to match the WorkboxPlugin
// interface (cachedResponse is optional per CachedResponseWillBeUsedCallbackParam).
const staleSignalPlugin = {
  cacheWillUpdate: async ({response}: {response: Response}) => addCachedAtHeader(response),
  cachedResponseWillBeUsed: async ({cachedResponse}: {cachedResponse?: Response}) =>
    markFromCache(cachedResponse),
}

// ── 1. Auth routes — NEVER intercept/cache ──────────────────────────────────
// OAuth /auth/login, /auth/callback?code=..., /auth/logout must reach the server.
registerRoute(
  ({url}) => url.pathname.startsWith('/auth/') || url.pathname === '/auth',
  new NetworkOnly(),
)

// ── 2. /api/monitoring — NetworkFirst with offline data cache ────────────────
// Registered BEFORE the /api/* NetworkOnly catch-all (Workbox evaluates routes
// in registration order — specific routes must come before catch-alls).
//
// NetworkFirst: tries the network first; falls back to the SW cache on failure.
// On a cache hit, the staleSignalPlugin adds X-From-Cache so the app can show
// a stale banner. On a cache write, X-Cached-At is stamped for age display.
//
// CacheableResponsePlugin: only cache 200 responses (not 401/5xx).
// ExpirationPlugin: cap at 1 entry, 7-day max age, purge on quota error.
registerRoute(
  ({url}) => url.pathname === '/api/monitoring',
  new NetworkFirst({
    cacheName: MONITORING_CACHE,
    networkTimeoutSeconds: 4,
    plugins: [
      staleSignalPlugin,
      new CacheableResponsePlugin({statuses: [200]}),
      new ExpirationPlugin({
        maxEntries: 1,
        maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
        purgeOnQuotaError: true,
      }),
    ],
  }),
)

// ── 3. API routes — default-deny caching ────────────────────────────────────
// All other /api/* routes (status, healthz, etc.) pass through to the network.
// /api/monitoring is handled above and will not reach this catch-all.
registerRoute(
  ({url}) => url.pathname.startsWith('/api/') || url.pathname === '/api',
  new NetworkOnly(),
)

// ── 4. Navigation requests → precached app shell ────────────────────────────
// index.html is precached; the auth gate runs in-app after hydration (SPA pattern).
// /auth/* and /api/* navigations are denylisted so those hit the network directly
// (server-side auth redirects must run for those paths).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/auth(\/|$)/, /^\/api(\/|$)/],
  }),
)

// ── 5. Precache hashed app-shell assets ─────────────────────────────────────
// self.__WB_MANIFEST is replaced at build time by vite-plugin-pwa (injectManifest).
// cleanupOutdatedCaches removes stale precache entries from previous builds.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// ── Logout purge handler ─────────────────────────────────────────────────────
// On logout, the page posts {type:'PURGE_RUNTIME'} to purge the /api/monitoring
// runtime cache. Without this, a logged-out user's NetworkFirst fetch would 401
// and the SW would fall back to the cached snapshot (serving auth-gated data).
//
// ONLY the runtime cache (MONITORING_CACHE) is deleted — NOT the precache.
// The app shell must survive logout so the next user gets an instant load.
//
// Type note: ExtendableMessageEvent is in the WebWorker lib (not DOM). We use
// a minimal inline interface to avoid adding the WebWorker lib to tsconfig
// (which would pull in conflicting globals). The cast is safe — this code only
// runs in a SW context where the event IS an ExtendableMessageEvent.
interface SWMessageEvent extends Event {
  readonly data: unknown
  waitUntil(f: Promise<unknown>): void
}

addEventListener('message', (event: Event) => {
  const e = event as SWMessageEvent
  if ((e.data as {type?: string} | null)?.type === 'PURGE_RUNTIME') {
    e.waitUntil(caches.delete(MONITORING_CACHE))
  }
})
