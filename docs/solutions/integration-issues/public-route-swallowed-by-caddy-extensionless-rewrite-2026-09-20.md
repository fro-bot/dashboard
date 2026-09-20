---
title: A reverse proxy in another repo rewrote every extensionless path, so a correct public route was unreachable
date: 2026-09-20
category: integration-issues
module: dashboard
problem_type: integration_issue
component: tooling
severity: high
applies_when:
  - Adding a public, unauthenticated route that has no file extension
  - A route returns the expected status locally and in tests but redirects in production
  - Reasoning about which upstream answered a request behind a reverse proxy
  - Auditing whether repo-level verification actually covers the deployed request path
symptoms:
  - "GET /privacy returns 302 to the operator login in production while returning 200 locally"
  - "Every gate is green: types, lint, design check, full test suite, and a real-browser check"
  - "The deploy reports a matching runtime image digest and a healthy container"
  - "The production bundle is verifiably the new build, yet the server behaves like the old one"
  - "A sibling path with a file extension behaves correctly, masking the problem"
root_cause: config_error
resolution_type: config_change
tags: [caddy, reverse-proxy, rewrite, public-route, extensionless, false-green, cross-repo, deployment-boundary]
---

# A reverse proxy in another repo rewrote every extensionless path, so a correct public route was unreachable

## Problem

A public, unauthenticated privacy policy page shipped at `/privacy` ([#238](https://github.com/fro-bot/dashboard/issues/238), [#496](https://github.com/fro-bot/dashboard/pull/496), release `2026.09.13`). The route was correct in the application, passed every gate, and deployed cleanly — and returned `302` to the operator login in production.

The cause was not in this repository. Caddy, configured in `marcusrbrown/infra`, rewrites every extensionless path to `/` before proxying. `GET /privacy` arrived at the dashboard as `GET /`, which is correctly behind auth.

## Symptoms

- `GET /privacy` → `302` to `/operator/auth/github/start?return_to=/operator` in production; `200` locally.
- `GET /privacy.html` → `302`, while `/sw.js`, `/manifest.webmanifest` and `/assets/*.css` → `200`. The asymmetry is the clue: paths **with** a file extension work.
- All CI gates green. Deploy green, digest matched, container healthy.
- The production service worker contained the new `/privacy` navigation denylist, and the CSS chunk had renamed `index-*.css` → `src-*.css` — a fingerprint that only appears once the Vite build has two HTML entries. The client half of the image was provably current.

## What Didn't Work

Four wrong turns, in order. The invalid inferences cost more than the fix did.

- **Blamed the skipped infra deploy job.** The `deploy-dashboard` job did skip, guarded by `!startsWith(head_commit.message, 'chore(dashboard): pin image to ')`. That guard is correct by design — the dashboard release dispatches the deploy separately, so the pin commit must not deploy a second time. A real observation, entirely unrelated to the failure.

- **Exonerated the proxy on evidence that never supported it.** Response headers for `/privacy` (302) and `/registerSW.js` (404, a known dashboard route) matched on all eleven fields, which looked like proof the dashboard itself was redirecting. It was not. `/operator/health` had been used as the reference profile for the other upstream, but health endpoints routinely bypass middleware, so a bare header set proved nothing about where a request landed. **Matching security headers do not identify which upstream answered.** This wrong conclusion actively protected the real cause from scrutiny.

- **Overtrusted green deploy evidence.** Digest match, healthy container, and a verifiably current client bundle were all true and all irrelevant. The artifact was never in question; confirming it repeatedly felt like progress.

- **Overclaimed an earlier browser verification.** A real-browser check had confirmed the service worker did not intercept the route — against a **local dev server with no proxy in front**. It was recorded as end-to-end proof when it only ever covered two of three layers.

## Solution

The fix is in `marcusrbrown/infra` → `apps/dashboard/config/Caddyfile`, added **before** the catch-all:

```caddyfile
@privacy path /privacy /privacy/
handle @privacy {
	reverse_proxy dashboard:3000
}
```

Exact paths, not `/privacy*`. A prefix match would also pass `/privacy-anything` through unrewritten, widening the public surface beyond what the app's own allowlist permits.

The offending catch-all, for reference:

```caddyfile
@assets path_regexp \.[A-Za-z0-9]+$
handle @assets { reverse_proxy dashboard:3000 }
handle {
	rewrite * /
	reverse_proxy dashboard:3000
}
```

### The diagnostic that actually worked

Probe the app **from inside the container**, bypassing the proxy entirely:

```bash
docker exec "$(docker compose ps -q dashboard)" node -e \
  "fetch('http://127.0.0.1:3000/privacy').then(r => console.log(r.status))"
```

`200` inside and `302` outside localises the fault to the edge in one step. This should be the second move, not the seventh.

To prove the shipped artifact itself is correct without a local Docker daemon, read it straight out of the registry:

```bash
crane export ghcr.io/fro-bot/dashboard@sha256:<digest> - > flat.tar
tar -xf flat.tar app/src/server.ts app/web/dist/privacy.html
```

Read the Caddyfile on the **running host**, not the copy in the repo — they can differ.

## Why This Works

Three interception layers sit between a visitor and this application, and each can independently make a route non-public:

| Layer | Where | Owned by |
|---|---|---|
| Auth allowlist (`isPublicPath`) | `src/server.ts` | this repo |
| Service worker navigation denylist | `web/src/sw.ts` | this repo |
| Reverse-proxy path rewrite | `apps/dashboard/config/Caddyfile` | `marcusrbrown/infra` |

A public extensionless route needs a change at all three. This repository can only test the first two, so nothing here could have caught the third.

The trap stays invisible until someone adds a clean URL: any public path **with** a file extension satisfies the `@assets` regex and reaches the app unrewritten, so layers 1 and 2 alone are sufficient for it. Extensionless paths are the only ones that reach the rewrite.

One asymmetry is worth knowing when verifying: an **unauthenticated** visitor never registers the service worker at all, because `/` redirects to GitHub before any dashboard document loads — `navigator.serviceWorker.getRegistrations()` returns `[]` on production for a fresh visitor. Layer 2 therefore only binds for an operator who has authenticated and has an active worker. A public page can be confirmed reachable for anonymous visitors without ever exercising the service-worker layer, so confirming one says nothing about the other.

## Prevention

- **Verify the public URL, not the local one.** The acceptance check for a public route is `curl` against the deployed origin with no session, plus a real browser. A local dev server has no proxy in front of it and cannot prove reachability.
- **Bisect app versus edge before theorising.** In-container probe first. It is one command and it eliminates half the search space.
- **Never infer the upstream from response headers.** Two Hono services behind one proxy emit near-identical security headers. Identify the upstream by routing config or by probing each directly.
- **Treat a clean URL as a cross-repo change.** Adding an extensionless public path requires a Caddyfile handle in `marcusrbrown/infra`, landed and deployed, or the route is dead on arrival.
- **Prefer exact-match path rules at the edge**, mirroring the app's own allowlist discipline. A prefix rule silently widens the public surface.
- There are currently **no routing assertions on the Caddyfile**. `apps/dashboard/docker-compose.test.ts` references the file but asserts nothing about `handle` or `rewrite`, so this class of gap produces no signal. Tracked at [marcusrbrown/infra#1378](https://github.com/marcusrbrown/infra/issues/1378).

## Related Issues

- [marcusrbrown/infra#1378](https://github.com/marcusrbrown/infra/issues/1378) — the Caddy rewrite and the missing routing assertions.
- [fro-bot/dashboard#238](https://github.com/fro-bot/dashboard/issues/238) — the privacy policy this surfaced through.
- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md` — same false-green family. Its lesson that browser verification is required still holds; this narrows it, because browser verification only covers repo-owned layers.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — the umbrella lesson. The assembled surface now has to mean the deployed surface, including layers another repository owns.
- `docs/solutions/workflow-issues/workflow-output-mode-auto-discarded-agent-fixes-2026-08-31.md` — the other green-but-silently-discarded failure in this repo.
- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md` — routing and reverse-proxy siblings.
