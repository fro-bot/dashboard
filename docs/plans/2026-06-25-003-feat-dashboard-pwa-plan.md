---
title: "feat: dashboard PWA — installable, offline-capable, prompt-to-update"
type: feat
status: active
date: 2026-06-25
origin: docs/brainstorms/2026-06-25-001-dashboard-full-pwa-requirements.md
deepened: 2026-06-25
---

# feat: dashboard PWA — installable, offline-capable, prompt-to-update

## Overview

Turn the metadata-only "PWA" into a real one: installable, instant-loading from a precached app shell, showing last-known-good monitoring data when the BFF is unreachable, and prompting the operator to refresh when a new build ships. Built on the existing Vite build + `web/dist` serving via Hono. Push notifications are explicitly out of scope (deferred to a separate plan).

## Problem Frame

`web/public/manifest.webmanifest` exists and is linked, but there is no `vite-plugin-pwa`, no service worker, no install affordance, and no offline/update behavior (`web/src/main.tsx` boots plain React). The operator gets a normal browser tab that cold-loads (and waits ~15-20s on the aggregation) every time. Goal: one-click-away + instant load, with graceful offline and a controlled update flow. (See origin: `docs/brainstorms/2026-06-25-001-dashboard-full-pwa-requirements.md`.)

## Requirements Trace

- R1. Installable app (desktop + mobile) with a custom in-app install affordance in addition to the browser default. (origin R1, R7)
- R2. Service worker precaches the app shell so the app opens instantly from cache. (origin R2)
- R3. Offline/unreachable: show last-known-good `/api/monitoring` data with a stale banner showing its age; explicit offline state when there is no cached snapshot. (origin R3, R4)
- R4. Update handling: prompt-to-refresh on a new build; never silently run a stale shell, never force a reload mid-session. (origin R5)
- R5. Preserve invariants: read-only, redaction-is-server-side (cache stores the already-redacted DTO), Node 24 strip-only, CSP, release-path coverage, opt-in telemetry. (origin Constraints)

## Scope Boundaries

- This plan ships install + shell precache + offline data cache + update prompt + mobile install.
- The offline data cache is a **staleness** mechanism, not a privacy one: the `/api/monitoring` DTO is already redacted server-side, so the cache stores only already-public data and needs no client-side redaction recheck.

### Deferred to Separate Tasks

- **Push notifications / background sync** — its own follow-up plan (server-side `web-push` + VAPID + subscription store + sweeper + frequency policy + persistence decision + privacy policy). File a tracking issue. The SW is structured so a `push` listener can be added later without rework.
- Any monitoring-view perf/a11y rework (virtualization, keyboard nav) — separate from the PWA effort.

## Context & Research

### Relevant Code and Patterns

- `web/vite.config.ts` — Vite + React + Tailwind; no PWA plugin yet (greenfield). The build already emits `web/dist` (CI-built; runtime stays no-build).
- `web/src/main.tsx` (~15 lines) — React boot; the SW registration entrypoint.
- `web/src/shell/AppShell.tsx` (header nav ~L132-182) — where the install affordance + update prompt + offline/stale banner mount.
- `web/src/api/aggregation.ts` (~L67-80) — the single `/api/monitoring` fetch; the place to read the SW stale-signal headers.
- `web/src/views/Monitoring.tsx` (~L451-491) — the fetch-state discriminated union; the offline/stale branch integrates here.
- `web/public/manifest.webmanifest` + `web/index.html` — existing manifest; keep it (`manifest: false`), ensure the `<link rel="manifest">` + theme-color/apple-touch-icon/viewport tags.
- `src/server.ts` — CSP is already SW-shaped (`workerSrc`/`manifestSrc: 'self'` at ~L407-424, PWA comment ~L386-403). `isPublicPath` (~L471-484) allowlists `/assets/*`,`/manifest.webmanifest`,`/icon-*` but NOT `/sw.js`/`/registerSW.js`; static mounts (~L711-714) likewise. Both need a coordinated addition. CSP for `/sw.js` should be minimal (workers don't inherit page CSP).
- `src/routes/api.ts` (~L109) — `/api/monitoring` sends `Cache-Control: no-store`; the SW cache strategy must handle this (see Key Technical Decisions).
- `.github/workflows/release.yaml` `on.push.paths` + `scripts/should-release.ts` `isHardReleasePath` + the parity test (`test/should-release.test.ts:215-229`) — `web/**` already covers SW source and built `web/dist` artifacts, so no new release-path entry is needed (the SW lives under `web/src`/`web/dist`).
- `.github/workflows/release.yaml` (~L196-203) — the release smoke step; natural place to probe `/sw.js` + manifest.

### Institutional Learnings

- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — PWA failures (SW registration, install prompt, precache miss, update prompt, offline fallback) are silent in a unit suite. The "open the page" gate (DevTools → Application: SW registered, manifest valid, precache populated, offline works, update prompt fires) is a required DoD item, not a follow-up.
- `docs/solutions/workflow-issues/release-paths-filter-must-cover-runtime-image-contents-2026-06-25.md` — runtime-affecting assets must trigger releases; verified `web/**` already covers the SW/precache assets, so the existing parity test holds.
- `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md` — the no-build client-JS + CSP discipline; keep `script-src 'self'` strict.
- `docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md` — redaction is enforced at the aggregator; the SW must cache the response as-is (opaque, post-redaction), never synthesize/filter — caching the already-redacted DTO is correct, fail-closed on cache errors.

### External References

- `vite-plugin-pwa@1.3.0` (May 2026) + `workbox-*@7.4.x`. Use `strategies: 'injectManifest'` (a custom Workbox plugin is needed for the stale signal, which `generateSW` can't host), `srcDir: 'src'`, `filename: 'sw.ts'`, `manifest: false` (honor the hand-written manifest), `registerType` omitted (`'prompt'` is the v1 default). React: `virtual:pwa-register/react` `useRegisterSW()`. Docs: vite-pwa-org.netlify.app (react, inject-manifest, prompt-for-update); developer.chrome.com/docs/workbox.

## Key Technical Decisions

- **`injectManifest` over `generateSW`.** The offline stale-signal requires a custom Workbox plugin (stamp `X-Cached-At` in `cacheWillUpdate`, add `X-From-Cache` in `cachedResponseWillBeUsed`); `generateSW` can't host custom plugins. The custom SW (`web/src/sw.ts`) must call `precacheAndRoute(self.__WB_MANIFEST)` + `cleanupOutdatedCaches()` (the latter is automatic only under `generateSW`).
- **`manifest: false` — keep the hand-written manifest.** Avoids a second source of truth. The plugin then does not inject the `<link rel="manifest">`, so it stays hand-added in `web/index.html`. Hono must serve `/manifest.webmanifest` as `application/manifest+json`.
- **`registerType: 'prompt'` (default).** Forms/triage may be open; never silently reload. `updateServiceWorker()` (no args — the bool arg is a deprecated no-op) activates the waiting SW and reloads on the operator's command.
- **Offline cache = `NetworkFirst` on `/api/monitoring`. KEEP `/api/monitoring` `Cache-Control: no-store` unchanged.** The SW Cache Storage API is independent of the HTTP cache — `cache.put()` stores the response **regardless of `Cache-Control`** (confirmed against W3C SW spec, MDN `Cache`, Chrome Workbox docs, web.dev). So `no-store` does NOT prevent the SW from caching, and no header change is needed for offline caching to work. Changing it to `private` would be both unnecessary and a marginal regression (it lets the browser HTTP disk cache store the response, which `no-store` correctly forbids). The documented security invariant at `src/routes/api.ts:100-101` stays as-is. Add `CacheableResponsePlugin({statuses:[200]})` + `ExpirationPlugin({maxEntries:1, maxAgeSeconds: <7d>, purgeOnQuotaError:true})`. NetworkFirst tries network first and only serves cache on failure, preserving freshness; the cached payload is the already-redacted DTO.
- **The SW fetch handler is explicit and deny-by-default — this is the load-bearing safety design.** A registered SW intercepts ALL same-origin navigations and fetches, not just `/api/monitoring`. Without explicit scoping it breaks OAuth and can serve stale/unauthed responses. Required route structure (Workbox 7.4, registration order matters — specific before catch-all):
  1. `/auth/*` → `NetworkOnly` — never intercept/cache auth (OAuth `/auth/login`, `/auth/callback?code=...`, `/auth/logout` must reach the server).
  2. `/api/monitoring` → `NetworkFirst` (with the stale-signal plugin).
  3. `/api/*` (all other) → `NetworkOnly` — default-deny API caching (`/api/status`, `/api/healthz`).
  4. Navigation requests (`request.mode === 'navigate'`) → handled so the server still runs auth: use `NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/auth(\/|$)/, /^\/api(\/|$)/] })`. `index.html` IS precached and served for app navigations (the auth gate runs in-app after hydration, matching the existing SPA pattern); `/auth/*` and `/api/*` are denylisted so those navigations hit the network.
  5. Precache hashed `web/dist` assets via `precacheAndRoute(self.__WB_MANIFEST)` + `cleanupOutdatedCaches()`.
- **Cache-clear-on-logout.** Because `/api/monitoring` is NetworkFirst, a logged-out user's `/api/monitoring` fetch 401s and the SW falls back to the cached snapshot — serving auth-gated (though already-public) data without a session. On logout, purge the runtime cache: page-side `caches.delete(runtimeCacheName)` (works even if the SW is mid-update or the tab is closing) PLUS a SW `message` handler (`{type:'PURGE_RUNTIME'}` → `caches.delete`) as backup. Never purge the precache (the shell should survive logout for the next user). Known residual: idle session expiry / server-side revoke fire no logout event — accepted (data is already-public, staleness-bannered); namespacing the cache by session is a future option if needed.
- **Stale signal via response headers, read by the app.** The SW plugin adds `X-From-Cache`/`X-Cached-At`; `web/src/api/aggregation.ts` reads them and the result type carries `servedFromCache` + `cachedAt`; `Monitoring.tsx` renders a stale/offline banner with the data's age. No new endpoint.
- **SW asset serving + allowlist.** `/sw.js` (and `registerSW.js` if emitted) served at root scope with `Content-Type: application/javascript` and `Cache-Control: no-cache, no-store, must-revalidate` (so updates are detected), and added to `isPublicPath` + the static mounts. SW CSP is minimal/separate (workers don't inherit page CSP).
- **No new release-path entry.** Verified `web/**` already covers `web/src/sw.ts` + the built `web/dist` SW/precache assets; the existing parity test holds. (Recorded so review doesn't re-add it.)

## Open Questions

### Resolved During Planning

- Build-step tension (AGENTS.md "no build step") — resolved: the rebuild already moved to "no *runtime* build" with a CI Vite build emitting `web/dist`; `vite-plugin-pwa` fits that, no invariant change needed.
- `generateSW` vs `injectManifest` — `injectManifest` (custom stale-signal plugin required).
- Existing manifest vs generated — keep existing (`manifest: false`).
- Release-path coverage — already covered by `web/**`; no change.

### Deferred to Implementation

- The exact `cacheName` for the `/api/monitoring` runtime cache (used by both the NetworkFirst route and the logout purge) — name it once and share the constant between `sw.ts` and the page-side purge.
- Exact stale-banner copy + age formatting.
- `ExpirationPlugin` `maxAgeSeconds` value (a staleness ceiling for the cached snapshot).
- Whether the custom install affordance needs its own dismiss-persistence (localStorage) — decide when wiring `beforeinstallprompt`.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
Build (CI, Vite + vite-plugin-pwa injectManifest)
  web/src/sw.ts ──▶ web/dist/sw.js   (precache manifest injected: all hashed web/dist assets)
  web/dist/*                          (hashed JS/CSS/icons + manifest.webmanifest)

Runtime (Hono serves web/dist, no build)
  GET /                → index.html (Cache-Control: no-cache)         ── shell
  GET /sw.js           → application/javascript, no-store              ── SW script (public, root scope)
  GET /assets/*        → immutable                                     ── precached
  GET /manifest.webmanifest → application/manifest+json                ── public
  GET /api/monitoring  → already-redacted DTO, Cache-Control: no-store (UNCHANGED) ── SW NetworkFirst (SW ignores Cache-Control)

SW fetch router (deny-by-default, registration order)
  /auth/*            → NetworkOnly      (OAuth must reach server)
  /api/monitoring    → NetworkFirst     (stale signal)
  /api/* (other)     → NetworkOnly      (default-deny)
  navigate           → NavigationRoute(index.html) denylist [/^\/auth/, /^\/api/]
  hashed assets      → precacheAndRoute(self.__WB_MANIFEST)

Browser
  main.tsx → useRegisterSW() ─▶ SW registers, precaches shell + hashed assets
  online:  fetch /api/monitoring → network (fresh) → SW caches copy (X-Cached-At)
  offline: fetch fails → SW serves cached copy (X-From-Cache) → app shows stale banner w/ age
  logout:  page caches.delete(runtime) + postMessage(PURGE_RUNTIME) → SW caches.delete
  new build deployed → workbox-window detects waiting SW → needRefresh=true
                     → <ReloadPrompt> "New version — refresh" → updateServiceWorker() → reload
  install: beforeinstallprompt captured → in-app Install control → prompt()
```

## Implementation Units

- [ ] **Unit 1: Add vite-plugin-pwa with injectManifest + a minimal custom SW (precache only)**

**Goal:** Wire `vite-plugin-pwa` (injectManifest, `manifest:false`, prompt default) and a custom `web/src/sw.ts` that precaches the app shell and cleans up outdated caches. App installs and loads from precache; no offline-data or update-UI yet.

**Requirements:** R2 (partial R1)

**Dependencies:** None

**Files:**
- Modify: `web/vite.config.ts` (VitePWA plugin block), `web/package.json` (devDeps: `vite-plugin-pwa`, `workbox-*`), `web/tsconfig.json` (`vite-plugin-pwa/react` + `vite-plugin-pwa/client` types)
- Create: `web/src/sw.ts`
- Test: `web/src/sw.test.ts` (and/or a build-output assertion)

**Approach:**
- VitePWA: `strategies:'injectManifest'`, `srcDir:'src'`, `filename:'sw.ts'`, `manifest:false`, omit `registerType`. Default `globPatterns` over `web/dist`.
- `sw.ts` ships the **explicit deny-by-default fetch router from the start** (registration order matters): `/auth/*`→`NetworkOnly`; `/api/*`→`NetworkOnly` (the `/api/monitoring` `NetworkFirst` route is added in Unit 3, registered before this catch-all); a `NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/auth(\/|$)/, /^\/api(\/|$)/] })` for navigations; then `precacheAndRoute(self.__WB_MANIFEST)` + `cleanupOutdatedCaches()`. `index.html` stays precached (auth gate runs in-app after hydration; `/auth/*` + `/api/*` navigations are denylisted to the network).
- Confirm `web/dist/sw.js` is produced with `self.__WB_MANIFEST` substituted and excludes itself + `manifest.webmanifest` from precache.

**Execution note:** Adding a dependency — confirm the devDep additions are acceptable before installing (gate). The deny-by-default router is the load-bearing safety boundary — get it in this first unit so no intermediate state ships a catch-all SW.

**Patterns to follow:** research-canonical vite-plugin-pwa injectManifest + `NavigationRoute` denylist for auth-gated SPAs (Workbox 7.4 — `denylist`/`createHandlerBoundToURL` are the v5+ names).

**Test scenarios:**
- Happy path: build produces `web/dist/sw.js` containing the precache call with an injected manifest (non-empty asset list).
- Edge case: the SW file and `manifest.webmanifest` are not in their own precache list.
- Guard (CI-cheap, catches the auth-bypass class): a build-output assertion that the SW's navigation handling denylists `/auth/` and `/api/` (the regexes/route are present in the emitted `sw.js`), so a future edit can't silently drop them.

**Verification:** `pnpm build:web` emits a valid `sw.js` with the deny-by-default router + denylisted navigation; `pnpm check-types`/`lint`/`test` green; SW registration + auth flow verified in the assembled-page gate (Unit 6).

- [ ] **Unit 2: Serve SW assets correctly from Hono + allowlist them**

**Goal:** Serve `/sw.js` (and `registerSW.js` if emitted) at root scope with correct MIME + no-cache, serve `/manifest.webmanifest` as `application/manifest+json`, and add these to the pre-auth public allowlist so an unauthenticated SW registration works.

**Requirements:** R2, R5 (CSP/serving)

**Dependencies:** Unit 1 (assets exist)

**Files:**
- Modify: `src/server.ts` (`isPublicPath` ~L471-484; static mounts ~L711-714; per-path headers for `/sw.js` + `/manifest.webmanifest`; minimal CSP for `/sw.js`)
- Test: `test/server.test.ts` (or `test/static-assets.test.ts`)

**Approach:**
- Add `/sw.js`/`/registerSW.js` to `isPublicPath` and the static serving path.
- `/sw.js`: `Content-Type: application/javascript`, `Cache-Control: no-cache, no-store, must-revalidate`. For CSP, **omit it on `/sw.js` or set only `script-src 'self'`** — a too-restrictive CSP on the SW response can block Workbox's `importScripts` and break the SW (workers don't inherit the page CSP anyway; the page CSP's directives are mostly inert for the worker).
- `/manifest.webmanifest`: `Content-Type: application/manifest+json`.
- Confirm the existing CSP `worker-src`/`manifest-src 'self'` already cover SW + manifest (no widening needed; record it).

**Execution note:** Test-first — the MIME + no-cache + public-path behavior is the load-bearing contract (a wrong MIME blocks SW registration entirely).

**Patterns to follow:** the existing `isPublicPath` allowlist + static mount pattern in `src/server.ts`.

**Test scenarios:**
- Happy path: `GET /sw.js` → 200, `Content-Type: application/javascript`, `Cache-Control` no-store, served without auth.
- Happy path: `GET /manifest.webmanifest` → 200, `application/manifest+json`, no auth.
- Edge case: `/sw.js` is reachable pre-auth (public path) while a protected route still 302s/denies.
- Error path: a wrong MIME would block registration — assert the correct MIME explicitly.

**Verification:** SW + manifest are fetchable unauthenticated with correct headers; protected routes still gated; gates green.

- [ ] **Unit 3: Offline data cache — NetworkFirst + stale signal + logout purge**

**Goal:** Cache `/api/monitoring` with NetworkFirst so the app shows last-known-good data offline, with a `X-From-Cache`/`X-Cached-At` signal, and purge that cache on logout. The endpoint's `Cache-Control: no-store` stays unchanged (the SW Cache API ignores it).

**Requirements:** R3, R5 (redaction-as-server-side)

**Dependencies:** Unit 1

**Files:**
- Modify: `web/src/sw.ts` (NetworkFirst route for `/api/monitoring`, registered before the `/api/*` NetworkOnly catch-all; stale-signal plugin + CacheableResponse + Expiration; the `message` handler for logout purge)
- Test: `web/src/sw.test.ts` (the stale-signal plugin pure logic)
- (No change to `src/routes/api.ts` — see below.)

**Approach:**
- `registerRoute(pathname === '/api/monitoring', new NetworkFirst({cacheName, networkTimeoutSeconds:4, plugins:[staleSignalPlugin, CacheableResponsePlugin({statuses:[200]}), ExpirationPlugin({maxEntries:1, maxAgeSeconds, purgeOnQuotaError:true})]}))` — registered BEFORE the `/api/*` NetworkOnly catch-all from Unit 1.
- `staleSignalPlugin`: `cacheWillUpdate` stamps `X-Cached-At`; `cachedResponseWillBeUsed` adds `X-From-Cache: true`. Pure header transforms (body preserved) — extract as a testable pure function.
- **Leave `/api/monitoring` `Cache-Control: no-store` UNCHANGED.** The SW Cache Storage API ignores `Cache-Control` (`cache.put()` stores regardless), so `no-store` does not block SW caching and no header change is needed. Changing it to `private` would be unnecessary and would let the browser HTTP disk cache store the response, which `no-store` correctly forbids. The documented security invariant stays intact — record this in the plan so review doesn't "helpfully" change the header.
- **Logout cache purge** (the SW NetworkFirst would otherwise serve cached `/api/monitoring` to a logged-out user when the live fetch 401s): on logout, the page calls `caches.delete(runtimeCacheName)` directly (robust even if the SW is mid-update or the tab is closing) AND posts `{type:'PURGE_RUNTIME'}` to the SW, whose `message` handler also `caches.delete`s the runtime cache. The precache is NOT purged (the shell survives for the next user). Wire the page side into the existing logout action.

**Execution note:** Test-first for the stale-signal plugin and the purge handler.

**Patterns to follow:** Workbox NetworkFirst + plugin lifecycle (research §3); the redaction-as-server-side learning (cache the response opaque, no client filtering); the page↔SW `postMessage` purge pattern (research §3).

**Test scenarios:**
- Happy path: plugin stamps `X-Cached-At` on cache write; adds `X-From-Cache` on cache read; body unchanged.
- Edge case: a non-200 response is not cached (CacheableResponse).
- Edge case: cache holds at most 1 entry (Expiration), purges on quota error.
- Security: after a purge (logout), the runtime `/api/monitoring` cache is empty; the precache is untouched.
- Contract: `/api/monitoring` keeps `Cache-Control: no-store` (a test pins it unchanged).
- Integration (assembled, Unit 6): offline → app receives `X-From-Cache` → renders stale banner; logout → cached monitoring data is gone.

**Verification:** the stale-signal plugin + purge handler are unit-proven; `/api/monitoring` keeps `no-store`; logged-out users get no cached data; gates green.

- [ ] **Unit 4: App consumes the stale signal + offline/stale UI**

**Goal:** Read `X-From-Cache`/`X-Cached-At` in the monitoring fetch, thread `servedFromCache`/`cachedAt` through the result type, and render a stale banner (with age) when serving cached data, plus an explicit offline state when there's no cached snapshot.

**Requirements:** R3

**Dependencies:** Unit 3

**Files:**
- Modify: `web/src/api/aggregation.ts` (~L67-80 — read headers, extend result type)
- Modify: `web/src/views/Monitoring.tsx` (~L451-491 — stale/offline branch + banner)
- Test: `web/src/api/aggregation.test.ts`, `web/src/views/Monitoring.test.tsx`

**Approach:**
- Result type gains `servedFromCache: boolean` + `cachedAt: number | null`.
- Monitoring renders: fresh (normal), stale-from-cache (banner: "Showing data from N ago — connection lost"), offline-no-cache (explicit offline state w/ retry), distinct from loading/empty.
- Banner text uses `textContent`-safe React rendering (no HTML interpolation).

**Execution note:** Test-first for the new states.

**Patterns to follow:** the existing fetch-state discriminated union in `Monitoring.tsx`; the existing loading/empty/error states.

**Test scenarios:**
- Happy path: fresh response (no `X-From-Cache`) → normal render, no banner.
- Happy path: `X-From-Cache` present → stale banner with the cached age.
- Edge case: no cached snapshot + network fail → explicit offline state (distinct from empty/loading).
- Edge case: `X-Cached-At` missing/malformed → banner degrades to "offline" without crashing.

**Verification:** the three data states render distinctly on real signal; gates green.

- [ ] **Unit 5: Update prompt + custom install affordance in the shell**

**Goal:** Register the SW via `useRegisterSW` with an hourly update check, render a prompt-to-refresh when a new build is waiting, and add a custom in-app install affordance (`beforeinstallprompt`).

**Requirements:** R1, R4

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `web/src/main.tsx` (SW registration entry), `web/src/shell/AppShell.tsx` (mount the prompt + install control), the logout action site (wire the page-side cache purge — see Unit 3)
- Create: `web/src/pwa/ReloadPrompt.tsx`, `web/src/pwa/InstallPrompt.tsx` (or a combined PWA affordances module)
- Test: `web/src/pwa/ReloadPrompt.test.tsx`, `web/src/pwa/InstallPrompt.test.tsx`

**Approach:**
- `useRegisterSW({ onRegistered: r => setInterval(() => r.update(), 3.6e6) })`; render `<ReloadPrompt>` on `needRefresh`; button → `updateServiceWorker()` (no args). One-time `offlineReady` toast optional.
- `InstallPrompt`: capture `beforeinstallprompt` (preventDefault, stash the event), show an in-app "Install" control, call `prompt()` on click; hide once installed/`appinstalled`. Optional dismiss-persistence.
- Wire the logout cache purge (Unit 3's page side): on the logout action, `caches.delete(runtimeCacheName)` + `postMessage({type:'PURGE_RUNTIME'})` before/around the existing logout navigation.

**Execution note:** Test-first using a mocked `useRegisterSW` (needRefresh:[true,noop]) and a synthetic `beforeinstallprompt`.

**Patterns to follow:** research §4 (useRegisterSW prompt flow); AppShell header mount points (~L132-182); browser-only guards.

**Test scenarios:**
- Happy path: `needRefresh` true → prompt renders → button calls `updateServiceWorker()`.
- Happy path: `beforeinstallprompt` fired → Install control appears → click calls `prompt()`.
- Edge case: `appinstalled` / already installed → install control hidden.
- Edge case: dismiss → prompt hides; next update check re-triggers `needRefresh`.

**Verification:** update prompt and install control behave on mocked events; gates green.

- [ ] **Unit 6: Assembled-page PWA verification + index.html/manifest polish + mobile**

**Goal:** Finish `index.html` PWA head tags, confirm mobile installability/responsiveness, and run the "open the page" assembled-page verification (the load-bearing PWA DoD).

**Requirements:** R1, R7, R5

**Dependencies:** Units 1-5

**Files:**
- Modify: `web/index.html` (`<link rel="manifest">`, `theme-color`, `apple-touch-icon`, `viewport`), `web/public/manifest.webmanifest` (verify display/start_url/icons for install), possibly `.github/workflows/release.yaml` smoke step (probe `/sw.js`+manifest)
- Test: an assembled-page check (Playwright or equivalent) if introduced; otherwise a documented manual DoD checklist

**Approach:**
- Ensure the manifest meets installability (name, icons incl. maskable, display:standalone, start_url, theme/background color).
- Assembled-page gate (DevTools → Application): SW registered, manifest valid, precache populated, offline shows cached data + banner, new build → update prompt fires, install works — desktop and a mobile viewport.
- Optionally add a CI browser smoke that boots the app and asserts SW registration + manifest + no console errors (this also seeds the broader assembled-page-smoke idea).

**Execution note:** This unit is the "unit-green is not feature-done" gate — the page must be opened and exercised, not just unit-tested.

**Patterns to follow:** `unit-green-is-not-feature-done` learning's PWA checklist; the existing release smoke step.

**Test scenarios:**
- Integration: load app → SW registers → precache populated.
- Integration (auth not broken — the critical gate): with the SW active, `/auth/login` and `/auth/callback` reach the server (OAuth completes), and an unauthenticated navigation to `/` still hits the server (not served purely from the SW). A release-smoke probe asserts unauthenticated `GET /` does NOT return a cached 200 bypassing auth.
- Integration: go offline → cached data + stale banner; no cache → offline state.
- Integration: logout → cached `/api/monitoring` data is purged (a subsequent offline load shows offline, not the prior user's data).
- Integration: simulate a new build → update prompt fires → refresh activates it.
- Integration: install on desktop + mobile viewport → standalone window renders the monitoring view.

**Verification:** the full install → offline → update → logout-purge lifecycle works in a real browser on desktop and mobile; the OAuth flow still works with the SW active; manifest passes installability; gates green.

## System-Wide Impact

- **Interaction graph (the load-bearing one — a SW intercepts EVERYTHING in scope):** once registered, the SW sits between the browser and ALL same-origin navigations + fetches, not just `/api/monitoring`. This is why the deny-by-default fetch router (Unit 1 KTD) is mandatory: `/auth/*`→NetworkOnly (OAuth must reach the server), `/api/*`→NetworkOnly except `/api/monitoring`→NetworkFirst, navigations→`NavigationRoute` with `/auth/` + `/api/` denylisted, precache hashed assets only. `main.tsx` registers; `AppShell` mounts the prompts; `Monitoring.tsx` consumes the stale signal; the logout action purges the runtime cache; Hono gains per-path headers for `/sw.js`+manifest.
- **Auth interaction (CRITICAL — the main risk a SW introduces):** without the denylist/NetworkOnly scoping, the SW would (a) serve the cached shell for `/auth/login`/`/auth/callback?code=...` navigations → **OAuth dead-ends, app unusable**, and (b) serve cached `/api/monitoring` to a logged-out user when the live fetch 401s. Mitigations: the navigation denylist + `/auth/*` NetworkOnly (Unit 1), the logout cache purge (Unit 3/5), and an assembled-page gate asserting OAuth still works + unauthenticated `/` isn't served from cache (Unit 6). `index.html` stays precached (auth runs in-app after hydration + server-side for non-SPA navigations) — matching the existing SPA pattern.
- **Error propagation:** SW registration failure must not break the app — it still works as a plain SPA (`onRegisterError` logs, no crash). A cache-read failure falls back to the offline state (fail-closed).
- **State lifecycle risks:** stale shell after a deploy (mitigated by prompt-to-refresh + `no-cache` on `/sw.js`+index); cached authed data after logout (mitigated by the purge); cache growth (ExpirationPlugin maxEntries:1); DTO-shape drift if an operator delays an update while the SW caches a new-shape response into old React — accepted as a pre-existing SPA+API limitation, bounded by the next monitoring fetch.
- **API surface parity:** none — no new API contract; `/api/monitoring` keeps its shape AND its `no-store` header (the SW caches independent of Cache-Control).
- **Unchanged invariants:** read-only (no writes, no push in this plan); redaction stays server-side (cache holds the already-redacted DTO); `/api/monitoring` DTO shape + `Cache-Control: no-store` (unchanged); the existing CSP `worker-src`/`manifest-src` (already SW-ready, no widening); release-path coverage (`web/**` already covers SW assets); the auth gate (preserved via SW scoping).

## Risks & Dependencies

| Risk | Severity | Mitigation |
|------|----------|------------|
| **SW intercepts the OAuth flow → app becomes unusable** (serves cached shell for `/auth/login`/`/auth/callback`) | High (correctness) | Deny-by-default fetch router: `/auth/*` NetworkOnly + navigation denylist `[/^\/auth/, /^\/api/]` shipped in Unit 1; assembled-page gate asserts OAuth still works (Unit 6) |
| **SW serves cached `/api/monitoring` to a logged-out user** (NetworkFirst falls back to cache on 401) | Medium | Logout cache purge: page-side `caches.delete` + SW `message` handler (Unit 3/5); data is already-public so impact is low, but the auth-gated invariant is preserved |
| Misconception that `no-store` must change for SW caching (it must NOT — SW Cache Storage ignores Cache-Control) | Medium (avoided) | Keep `no-store`; plan records the SW-vs-HTTP-cache fact so review doesn't change the header; test pins `no-store` unchanged (Unit 3) |
| Wrong `/sw.js` MIME blocks SW registration entirely | Medium | Explicit `application/javascript` + a test asserting it (Unit 2) |
| Too-restrictive CSP on `/sw.js` breaks Workbox `importScripts` | Low | Omit CSP on `/sw.js` or set only `script-src 'self'` (Unit 2) |
| Stale app shell after a deploy | Low | `no-cache` on `/sw.js`+`index.html`; prompt-to-refresh; hourly `r.update()` (Units 2, 5) |
| PWA failures are silent in unit tests | Medium | Mandatory assembled-page "open the page" gate incl. auth + offline + logout-purge (Unit 6) |
| Build-step concern vs AGENTS.md | n/a | Already resolved — runtime stays no-build; Vite build is CI-time and predates this plan |
| Adding devDependencies (vite-plugin-pwa, workbox-*) | Low | Gated — confirm before install (Unit 1) |

## Documentation / Operational Notes

- After shipping, capture a `docs/solutions/` learning: the no-build-runtime + injectManifest + serve-SW-from-Hono pattern AND the deny-by-default SW fetch router (auth/api passthrough, navigation denylist) — this is the first PWA/SW in the repo, so the scoping precedent is load-bearing; document that the SW intentionally caches only hashed assets + `/api/monitoring`, and that the SW Cache API ignores `Cache-Control`.
- File the push-notifications follow-up issue (deferred scope) so it's tracked.
- Release smoke (`release.yaml`) gains a `/sw.js` + manifest probe AND an unauthenticated-`/`-not-served-from-cache probe (auth-bypass regression guard).

## Sources & References

- **Origin document:** `docs/brainstorms/2026-06-25-001-dashboard-full-pwa-requirements.md`
- Related code: `web/vite.config.ts`, `web/src/main.tsx`, `web/src/shell/AppShell.tsx`, `web/src/api/aggregation.ts`, `web/src/views/Monitoring.tsx`, `src/server.ts`, `src/routes/api.ts`
- Learnings: `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`, `docs/solutions/workflow-issues/release-paths-filter-must-cover-runtime-image-contents-2026-06-25.md`, `docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md`
- External: vite-plugin-pwa 1.3 (vite-pwa-org.netlify.app — react / inject-manifest / prompt-for-update), Workbox 7.4 (developer.chrome.com/docs/workbox — strategies, workbox-routing `NavigationRoute`/denylist, workbox-cacheable-response). SW Cache API ignores Cache-Control: W3C SW spec, MDN `Cache`, web.dev "Service workers and the Cache Storage API". Auth-vs-SW navigation denylist + logout cache purge: workbox-routing `NavigationRoute` docs, MDN `CacheStorage.delete`.
- Deepening pass (2026-06-25): security-sentinel + architecture-strategist + framework-docs-researcher converged on (a) keep `no-store` (SW ignores Cache-Control — the original change was unnecessary), (b) the deny-by-default SW router to prevent OAuth breakage, (c) logout cache purge.
