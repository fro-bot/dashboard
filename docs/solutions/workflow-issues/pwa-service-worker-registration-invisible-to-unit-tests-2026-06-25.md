---
title: A PWA service worker that passes unit + build tests can still fail to register — verify in a real browser
date: 2026-06-25
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Adding, swapping, or upgrading a service worker (vite-plugin-pwa, Workbox injectManifest, custom SW)
  - Editing precacheAndRoute / createHandlerBoundToURL / NavigationRoute order or URLs, or the precache manifest
  - Implementing or changing a prompt-mode update flow (registration.update() vs updateServiceWorker())
  - "Green CI" or "the page loads" is being offered as evidence the PWA works
tags: [pwa, service-worker, workbox, injectmanifest, precache, verification, definition-of-done]
---

# A PWA service worker that passes unit + build tests can still fail to register — verify in a real browser

## Context

A full PWA shipped on `feat/dashboard-pwa` (#107): vite-plugin-pwa `injectManifest`, a hand-written Workbox SW (`web/src/sw.ts`) with a deny-by-default fetch router, offline cache, and a prompt-to-refresh `ReloadPrompt`. `web/src/sw.test.ts` ran pure-function unit tests plus build-output **string assertions** against the emitted `web/dist/sw.js` and the SW source (route ordering, denylist regexes present, precache-before-NavigationRoute source order, cache name present). All gates were green; the page loaded with no console error.

Yet the service worker **never registered** — twice, in two distinct ways, each caught only by opening the page in a real browser and inspecting `navigator.serviceWorker.getRegistration()` / DevTools → Application. The "PWA" was a PWA in name only: no offline cache, no install, no update prompt — and CI never noticed. A third lifecycle bug (a silent self-reload) survived static code review and was caught only on a later browser-aware pass.

## Guidance

**Treat real-browser SW registration as a required definition-of-done gate for any PWA / service-worker work. Build-output tests are necessary, not sufficient** — they prove the config was written into the bundle, not that the browser installs and activates the SW. This is the SW-layer instance of the `unit-green-is-not-feature-done` lesson: for an SPA, "open the page"; for a PWA, "open the page **and** verify the SW registered, activated, controlling, with the precache populated and auth routes still hitting the network."

Three footguns account for nearly every silent-failure case; check all three.

### 1. precacheAndRoute must run before createHandlerBoundToURL

`createHandlerBoundToURL(url)` resolves the URL against the precache **at call time**. If the precache isn't registered yet, Workbox throws `non-precached-url: <url>` at SW evaluation and registration aborts — the app silently degrades to a plain SPA. Precache first, then the NavigationRoute:

```ts
// web/src/sw.ts
precacheAndRoute(self.__WB_MANIFEST)   // 4. precache first
cleanupOutdatedCaches()

registerRoute(                          // 5. then the navigation handler
  new NavigationRoute(createHandlerBoundToURL('/'), {
    denylist: [/^\/auth(\/|$)/, /^\/api(\/|$)/],
  }),
)
```

### 2. The precached shell URL must match what the server serves with a 200

injectManifest precaches `index.html` by default. If the server serves the shell only at `/` and 404s on `/index.html` (the common SPA-fallback case — here Hono's `app.get('/', serveStatic({path: 'index.html'}))`), Workbox's install-time `fetch('index.html')` 404s, the SW goes `redundant`, and registration aborts. Both halves of the contract must agree on `/`:

```ts
// web/vite.config.ts — rewrite the manifest entry
injectManifest: {
  globIgnores: ['**/sw.js', '**/manifest.webmanifest', '**/registerSW.js'],
  manifestTransforms: [
    entries => ({
      manifest: entries.map(e => (e.url === 'index.html' ? {...e, url: '/'} : e)),
      warnings: [],
    }),
  ],
},
```

```ts
// web/src/sw.ts — the handler references the SAME url
new NavigationRoute(createHandlerBoundToURL('/'), {/* … */})
```

If the handler drifts back to `createHandlerBoundToURL('index.html')` while the manifest serves `/`, you get footgun #1 again. Pin both ends with a build assertion (`"url":"/"` present, `"url":"index.html"` absent) — but remember that assertion verifies the bundle, not the runtime.

### 3. prompt-mode lifecycle: update() on the interval, updateServiceWorker() on the click

`useRegisterSW` exposes both, and they are not interchangeable:

- `registration.update()` — **checks** for a new SW; if found (now `waiting`), flips `needRefresh` → the prompt renders. No reload. The operator stays in control.
- `updateServiceWorker()` — `skipWaiting()` + claim + **reload**. The destructive activation. Reserve it for the explicit Refresh click.

Wiring the periodic check to `updateServiceWorker()` silently reloads the operator mid-session every interval, defeating prompt mode (the default when `registerType` is omitted):

```tsx
// web/src/pwa/ReloadPrompt.tsx
useRegisterSW({onRegisteredSW: (_url, reg) => { registrationRef.current = reg }, /* … */})

useEffect(() => {
  const id = setInterval(() => {
    registrationRef.current?.update().catch(() => {})  // CHECK only — never updateServiceWorker()
  }, 60 * 60 * 1000)
  return () => clearInterval(id)
}, [])
// updateServiceWorker() is called ONLY from the Refresh button's onClick.
```

## Why This Matters

A silently-unregistered SW is the worst failure mode: no error, no red CI, no happy-path regression — yet every PWA capability (offline, install, update) is dead. The PR reads "added PWA support" and ships a PWA in name only; the cost lands at the worst moment (offline, flaky wifi, a build that shipped but never prompted). "The app loads" proves the SPA works, not the PWA. Build-output assertions are a useful structural tripwire, but only a browser that actually registers and activates the SW proves the runtime effect.

## When to Apply

- Any service-worker work, especially Workbox + vite-plugin-pwa injectManifest.
- Adding/changing `precacheAndRoute` / `createHandlerBoundToURL` / `NavigationRoute`, or the precache manifest (`manifestTransforms` / `globPatterns`).
- Implementing or reviewing a prompt-mode update flow (any `useRegisterSW` / `registerType: 'prompt'`).
- Any time "the page loads / CI is green" is offered as evidence a SW change worked — use the checklist below instead.

## The browser-verification checklist (required DoD for SW/PWA work)

- [ ] DevTools → Application → Service Workers: the SW is `activated` for the page's scope (or `navigator.serviceWorker.getRegistration()` resolves with a non-null `.active`).
- [ ] Reload once; `navigator.serviceWorker.controller` is non-null on the second load.
- [ ] Cache Storage shows the `workbox-precache` cache populated with `/` + the hashed assets.
- [ ] Offline + reload still renders the shell from precache; `/api/monitoring` returns the stale `X-From-Cache` snapshot, not a network error.
- [ ] `/auth/login` + `/auth/callback` reach the network (the SW does NOT serve them from cache).
- [ ] Leaving the tab open across an update-check tick does NOT self-reload (prompt mode preserved).
- [ ] No SW-lifecycle errors (`non-precached-url`, install 404) in the console.

If any box is unchecked, the SW is broken regardless of CI color — fix it before merging, the same as a red type check.

## Related

- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — the parent "verify the assembled surface" lesson; this is its PWA/SW-specific sibling.
- `docs/solutions/workflow-issues/dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md` — *how* to stand up the server for the browser verification this doc requires.
- `docs/solutions/workflow-issues/release-paths-filter-must-cover-runtime-image-contents-2026-06-25.md` — same "green but broken because a contract boundary is wrong" family, at the release-config layer.
- PR #107 (the PWA); fix commits `807138b` (precache ordering), `075a2ee` (precache shell at `/`), `4eb8b3a` (prompt-mode update lifecycle).
