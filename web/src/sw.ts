/**
 * Service Worker — deny-by-default fetch router.
 *
 * Registration order is load-bearing (specific before catch-all):
 *   1. /auth/*            → NetworkOnly  (OAuth must reach the server)
 *   2. /api/monitoring    → NetworkFirst (offline data cache + stale signal)
 *   3. /api/*             → NetworkOnly  (default-deny; all other API routes)
 *   4. precache           → precacheAndRoute(self.__WB_MANIFEST) + cleanupOutdatedCaches()
 *   5. navigate           → NavigationRoute(index.html) denylist [/auth/, /api/]
 *
 * Precache (4) MUST come before the NavigationRoute (5): createHandlerBoundToURL
 * resolves index.html against the precache at call time, so the manifest must be
 * precached first or SW registration throws non-precached-url and aborts.
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

import {cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute} from 'workbox-precaching'
import {NavigationRoute, registerRoute} from 'workbox-routing'
import {NetworkFirst, NetworkOnly} from 'workbox-strategies'
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
  // Guard against cross-origin redirect poisoning: if a logged-out fetch to
  // /api/monitoring follows the auth redirect chain (e.g. GitHub OAuth 200 HTML),
  // the resolved response.url will be cross-origin. Caching that HTML as if it
  // were the monitoring DTO would corrupt the cache — a later offline load would
  // serve HTML that fails res.json(). Return null (skip caching) unless the
  // response origin provably matches the request origin.
  // Empty response.url (opaque responses) is treated conservatively: skip caching.
  cacheWillUpdate: async ({request, response}: {request: Request; response: Response}) => {
    const responseOrigin = response.url ? new URL(response.url).origin : null
    const requestOrigin = new URL(request.url).origin
    if (responseOrigin !== requestOrigin) return null
    return addCachedAtHeader(response)
  },
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

// ── 4. Precache hashed app-shell assets ─────────────────────────────────────
// self.__WB_MANIFEST is replaced at build time by vite-plugin-pwa (injectManifest).
// cleanupOutdatedCaches removes stale precache entries from previous builds.
//
// ORDER: precacheAndRoute MUST run before the NavigationRoute below.
// createHandlerBoundToURL('index.html') resolves the URL against the precache
// AT CALL TIME — if the manifest isn't precached yet, Workbox throws
// `non-precached-url: index.html` and SW registration aborts entirely (the app
// silently falls back to a plain SPA). Precache first, then bind the handler.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// ── 5. Navigation requests → precached app shell ────────────────────────────
// '/' is precached (above); the auth gate runs in-app after hydration
// (SPA pattern). /auth/* and /api/* navigations are denylisted so those hit the
// network directly (server-side auth redirects must run for those paths).
//
// URL NOTE: the precache manifest rewrites index.html → '/' (via manifestTransforms
// in vite.config.ts) so that Workbox's install-time fetch hits GET / (200) instead
// of GET /index.html (404 — no route). createHandlerBoundToURL MUST reference the
// same URL as the precache entry or Workbox throws non-precached-url and aborts.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/'), {
    denylist: [/^\/auth(\/|$)/, /^\/api(\/|$)/],
  }),
)

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
