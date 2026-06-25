/**
 * Service Worker — deny-by-default fetch router.
 *
 * Registration order is load-bearing (specific before catch-all):
 *   1. /auth/*        → NetworkOnly  (OAuth must reach the server)
 *   2. /api/*         → NetworkOnly  (default-deny; Unit 3 inserts /api/monitoring NetworkFirst before this)
 *   3. navigate       → NavigationRoute(index.html) denylist [/auth/, /api/]
 *   4. precache       → precacheAndRoute(self.__WB_MANIFEST) + cleanupOutdatedCaches()
 *
 * SECURITY: A SW intercepts ALL same-origin navigations + fetches once registered.
 * The denylist on NavigationRoute and the NetworkOnly routes for /auth/* and /api/*
 * ensure OAuth callbacks and API calls always reach the server.
 */

import {cleanupOutdatedCaches, precacheAndRoute} from 'workbox-precaching'
import {NavigationRoute, registerRoute} from 'workbox-routing'
import {NetworkOnly} from 'workbox-strategies'
import {createHandlerBoundToURL} from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

// ── 1. Auth routes — NEVER intercept/cache ──────────────────────────────────
// OAuth /auth/login, /auth/callback?code=..., /auth/logout must reach the server.
registerRoute(
  ({url}) => url.pathname.startsWith('/auth/') || url.pathname === '/auth',
  new NetworkOnly(),
)

// ── 2. API routes — default-deny caching ────────────────────────────────────
// Unit 3 will register /api/monitoring NetworkFirst BEFORE this catch-all.
// All other /api/* routes (status, healthz, etc.) pass through to the network.
registerRoute(
  ({url}) => url.pathname.startsWith('/api/') || url.pathname === '/api',
  new NetworkOnly(),
)

// ── 3. Navigation requests → precached app shell ────────────────────────────
// index.html is precached; the auth gate runs in-app after hydration (SPA pattern).
// /auth/* and /api/* navigations are denylisted so those hit the network directly
// (server-side auth redirects must run for those paths).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/auth(\/|$)/, /^\/api(\/|$)/],
  }),
)

// ── 4. Precache hashed app-shell assets ─────────────────────────────────────
// self.__WB_MANIFEST is replaced at build time by vite-plugin-pwa (injectManifest).
// cleanupOutdatedCaches removes stale precache entries from previous builds.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
