---
title: Operator-first PWA routing and fail-state pattern
date: 2026-06-26
category: best-practices
module: operator-first-pwa
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - Making the app root the canonical operator surface
  - Keeping a legacy route as a compatibility alias
  - Reusing plain browser modules inside a React-owned shell
  - Adding service-worker behavior around auth-sensitive routes
  - Rendering operator failure states without authorization oracles
tags: [pwa, operator-shell, service-worker, routing, fail-state, static-assets, browser-verification, no-proxy]
related_components:
  - src/server.ts
  - web/src/App.tsx
  - web/src/views/Operator.tsx
  - web/src/pwa/ReloadPrompt.tsx
  - web/src/sw.ts
  - public/operator-launch.js
  - public/operator-stream.js
---

# Operator-first PWA routing and fail-state pattern

## Context

The dashboard root is now the operator surface. `/` renders the operator React
shell, and `/operator` is only a compatibility entrypoint that redirects to `/`.
The monitoring frontend is not a fallback surface, and the dashboard still must
not proxy Gateway operator data routes.

This combines routing, service-worker, static-asset, and failure-state behavior.
Unit tests are necessary, but the load-bearing proof is opening the assembled PWA
in a browser and checking the shell, runtime modules, service worker, and offline
navigation together.

## Guidance

### Make `/` canonical and keep `/operator` a redirect

`/operator` should not render a second copy of the app or depend on the old
operator UI flag. It should redirect before any flag-gated legacy route can run:

```ts
app.get('/', serveStatic({root: './web/dist', path: 'index.html'}))
app.get('/operator', c => c.redirect('/', 302))
```

Gateway operator data routes stay absent from the dashboard app. Tests should keep
`/operator/repos`, `/operator/runs`, approval routes, and stream paths as 404s so
the reverse proxy remains the owner of browser-direct operator traffic.

### Start the root app in operator-ready mode

If no session-check wiring exists in the root shell, do not default the assembled
app to an indefinite loading state. Render the operator shell ready and let the
runtime classify live failures:

```tsx
export function App() {
  return <Operator state="ready" />
}
```

Keep non-ready states supported as explicit props for tests.

### Serve only the runtime JS assets that root needs

The root shell imports the existing plain browser modules from `/static/*`, so the
two runtime JS files must be public even when the old `operatorUiEnabled` route is
off:

```ts
const rewriteRequestPath = (path: string) => path.replace(/^\/static/, '')

app.use('/static/operator-stream.js', serveStatic({root: './public', rewriteRequestPath}))
app.use('/static/operator-launch.js', serveStatic({root: './public', rewriteRequestPath}))
```

The auth allowlist must include those two exact paths. See `src/server.ts` for the
complete `isPublicPath` list; do not replace it with this focused snippet.

Keep the broader `/static/*` catch-all flag-gated. Root needs exactly the two JS
modules; it does not need to revive the old SSR asset surface.

### Let React own the runtime lifecycle

The root React shell renders stable DOM hooks, then imports the browser modules in
manual mode:

```ts
const streamSpecifier = '/static/operator-stream.js' + '?manual=1'
const launchSpecifier = '/static/operator-launch.js' + '?manual=1'

await import(/* @vite-ignore */ streamSpecifier)
await import(/* @vite-ignore */ launchSpecifier)
```

Use computed specifiers inside Vite-processed code. Bare string-literal imports of
`/static/*` paths can be resolved by Vite at build time instead of left for the
browser.

Every import in the React-owned path must preserve `?manual=1`. If
`operator-launch.js` imports stream, route it through a tested seam:

```js
export function streamModuleSpecifier() {
  return '/static/operator-stream.js?manual=1'
}

const {initOperatorStream} = await import(streamModuleSpecifier())
```

Without that query string, `operator-stream.js` can run its legacy top-level
auto-bootstrap and compete with React cleanup.

### Keep the service worker auth-safe

Do not cache operator API/auth paths. They must hit the network so auth expiry,
CSRF, rate limiting, and unavailable states are live signals, not stale cache
artifacts.

Use a local navigation redirect for `/operator` so offline aliases still land on
the cached root shell:

```ts
registerRoute(
  ({request, url}) => request.mode === 'navigate' && /^\/operator\/?$/.test(url.pathname),
  () => Response.redirect('/', 302),
)
```

For prompt-mode SW updates, the Refresh button must activate the waiting worker:

```tsx
updateServiceWorker(true)
```

The no-argument call can leave the new worker waiting while the tab continues
running the old asset.

### Keep operator failure copy path-unaware

Use a fixed, safe state set:

```ts
type OperatorState =
  | 'ready'
  | 'loading'
  | 'auth-required'
  | 'rate-limited'
  | 'offline'
  | 'unavailable'
```

Denied, malformed, unknown, and internal failures should collapse into the same
safe unavailable treatment. Copy should not mention protected paths, repo names,
permission distinctions, or raw Gateway payload details.

## Why This Matters

The operator-first PWA can fail while every isolated unit still looks green:

- `/` can render a permanent loading state and never mount runtime modules.
- The browser can be controlled by an old service worker while a new one waits.
- A root shell can depend on `/static/*` assets that auth middleware still blocks.
- A manual React import can accidentally import a non-manual legacy module and
  re-enable top-level auto-bootstrap.

All four failures were only visible after opening the assembled page in a browser.
The pattern keeps one product surface, one lifecycle owner, and one trust boundary:
dashboard serves the shell and static modules; the browser talks to Gateway
operator routes directly.

## When to Apply

- The app root becomes a single operator/control surface.
- A legacy route must remain for links but must not become a second app surface.
- Plain browser modules are reused inside a React shell.
- Service-worker navigation behavior touches auth-sensitive routes.
- Failure UI could leak whether a protected operator resource exists.

## Examples

Regression coverage should include:

- `App` renders the ready operator runtime shell by default.
- `ReloadPrompt` calls `updateServiceWorker(true)` on Refresh.
- `/static/operator-stream.js?manual=1` and `/static/operator-launch.js?manual=1`
  return 200 when `operatorUiEnabled` is false.
- `operator-launch.js` imports stream through a specifier ending in `?manual=1`.
- `/operator` redirects to `/` flag-independently.
- Dashboard-owned `/operator/*` data routes remain 404.

Browser verification should use the no-watch loopback server recipe. Expected
checks:

- `/` renders `Fro Bot Operator`, `Operator`, the launch form, repo picker, and run
  status region.
- Static runtime requests are exactly the manual module paths and return 200.
- after the service worker activates, reloading the page produces a non-null
  `navigator.serviceWorker.controller`.
- `/operator` resolves to `/` online and offline.
- Offline reload still serves the operator shell and does not queue actions.
- Console has no CSP, dynamic-import, service-worker, or runtime bootstrap errors.

## Related

- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md`
  — browser-level SW verification and prompt-mode update flow.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`
  — why unit-green does not prove a multi-surface UI works.
- `docs/solutions/workflow-issues/dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md`
  — the live verification server recipe.
- `docs/solutions/security-issues/operator-ui-mock-only-skeleton-pattern-2026-06-18.md`
  — prior operator UI safety boundaries.
- `docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md`
  — browser-direct Gateway operator call pattern and no dashboard proxy.
- `docs/solutions/security-issues/gateway-operator-auth-recovery-mode-aware-router-2026-06-21.md`
  — mode-aware operator auth routing and recovery.
