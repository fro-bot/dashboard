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

## Current routing

The [Caddyfile in infra](https://github.com/marcusrbrown/infra/blob/main/apps/dashboard/config/Caddyfile) forwards `/operator/*` to the gateway. It forwards all other paths to `dashboard:3000` without rewriting them. The dashboard owns access and path handling for those requests. A new public URL outside `/operator/*` does not need a Caddy rule just because it has no file extension.

The [infra routing change](https://github.com/marcusrbrown/infra/pull/1564) removed both the rewrite and the `/privacy` exception described below.

## Problem

A public, unauthenticated privacy policy page shipped at `/privacy` ([#238](https://github.com/fro-bot/dashboard/issues/238), [#496](https://github.com/fro-bot/dashboard/pull/496), release `2026.09.13`). The route was correct in the application, passed every gate, and deployed cleanly — and returned `302` to the operator login in production.

The cause was not in this repository. At the time, Caddy's fallback rewrote requests such as `/privacy` to `/` before forwarding them. The dashboard received `GET /` and correctly redirected it to login.

## Incident symptoms

- `GET /privacy` → `302` to `/operator/auth/github/start?return_to=/operator` in production; `200` locally.
- `GET /privacy.html` → `302`, while `/sw.js`, `/manifest.webmanifest` and `/assets/*.css` → `200`. The old proxy let requests with a file extension through unchanged. That did not make every such path public in the app.
- All CI gates green. Deploy green, digest matched, container healthy.
- The production service worker contained the new `/privacy` navigation denylist, and the CSS chunk had renamed `index-*.css` → `src-*.css` — a fingerprint that only appears once the Vite build has two HTML entries. The client half of the image was provably current.

## What Didn't Work

Four wrong turns, in order. The invalid inferences cost more than the fix did.

- **Blamed the skipped infra deploy job.** The `deploy-dashboard` job did skip, guarded by `!startsWith(head_commit.message, 'chore(dashboard): pin image to ')`. That guard is correct by design — the dashboard release dispatches the deploy separately, so the pin commit must not deploy a second time. A real observation, entirely unrelated to the failure.

- **Exonerated the proxy on evidence that never supported it.** Response headers for `/privacy` (302) and `/registerSW.js` (404, a known dashboard route) matched on all eleven fields, which looked like proof the dashboard itself was redirecting. It was not. `/operator/health` had been used as the reference profile for the other upstream, but health endpoints routinely bypass middleware, so a bare header set proved nothing about where a request landed. **Matching security headers do not identify which upstream answered.** This wrong conclusion actively protected the real cause from scrutiny.

- **Overtrusted green deploy evidence.** Digest match, healthy container, and a verifiably current client bundle were all true and all irrelevant. The artifact was never in question; confirming it repeatedly felt like progress.

- **Overclaimed an earlier browser verification.** A real-browser check had confirmed the service worker did not intercept the route — against a **local dev server with no proxy in front**. It was recorded as end-to-end proof when it only ever covered two of three layers.

## Historical fix

The fix at the time added an exact path exception before the fallback rule in `apps/dashboard/config/Caddyfile`:

```caddyfile
@privacy path /privacy /privacy/
handle @privacy {
	reverse_proxy dashboard:3000
}
```

The exception matched only `/privacy` and `/privacy/`. A prefix match such as `/privacy*` also matches unrelated paths, and the app still controls which paths are public.

The old rules that caused the incident:

```caddyfile
@assets path_regexp \.[A-Za-z0-9]+$
handle @assets { reverse_proxy dashboard:3000 }
handle {
	rewrite * /
	reverse_proxy dashboard:3000
}
```

## Diagnosis

Probe the app **from inside the container**, bypassing the proxy entirely:

```bash
docker exec "$(docker compose ps -q dashboard)" node -e \
  "fetch('http://127.0.0.1:3000/privacy').then(r => console.log(r.status))"
```

In this incident, the direct request returned `200` and the request through Caddy returned `302`. That difference pointed to the proxy path rather than the app route.

To prove the shipped artifact itself is correct without a local Docker daemon, read it straight out of the registry:

```bash
crane export ghcr.io/fro-bot/dashboard@sha256:<digest> - > flat.tar
tar -xf flat.tar app/src/server.ts app/web/dist/privacy.html
```

Read the Caddyfile on the **running host**, not the copy in the repo — they can differ.

## Layers to check

Three layers affect whether a visitor can reach a public route:

| Layer | Where | Owned by |
|---|---|---|
| Auth allowlist (`isPublicPath`) | `src/server.ts` | this repo |
| Service worker navigation denylist | `web/src/sw.ts` | this repo |
| Reverse-proxy routing | `apps/dashboard/config/Caddyfile` | `marcusrbrown/infra` |

The old `@assets` rule let URLs with an extension through unchanged. Working assets did not prove that `/privacy` reached the app unchanged. The current proxy does not make that distinction. App and browser checks run without Caddy cannot prove that the deployed proxy sends the request to the right service.

A service worker can serve the cached app shell instead of passing a navigation request to the server. A fresh anonymous browser tests public access. A browser with an active service worker tests whether the worker passes the request through. Test both when the route must work in both states.

## Prevention

- **Verify the public URL, not the local one.** The acceptance check for a public route is `curl` against the deployed origin with no session, plus a real browser. A local dev server has no proxy in front of it and cannot prove reachability.
- **Bisect app versus edge before theorising.** In-container probe first. It is one command and it eliminates half the search space.
- **Never infer the upstream from response headers.** Two Hono services behind one proxy emit near-identical security headers. Identify the upstream by routing config or by probing each directly.
- Keep the app's public path rules exact. If local and deployed results differ, compare the deployed Caddyfile with the source before adding an exception.
- The [infra routing tests](https://github.com/marcusrbrown/infra/blob/main/apps/dashboard/config/Caddyfile.test.ts) cover the gateway split, the dashboard fallback, and the absence of a `rewrite` directive. These tests inspect the source file, not the running proxy.

## Related Issues

- [marcusrbrown/infra#1378](https://github.com/marcusrbrown/infra/issues/1378) — the closed incident for the original Caddy rewrite.
- [fro-bot/dashboard#238](https://github.com/fro-bot/dashboard/issues/238) — the privacy policy this surfaced through.
- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md` — same false-green family. Its lesson that browser verification is required still holds; this narrows it, because browser verification only covers repo-owned layers.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — the umbrella lesson. The assembled surface now has to mean the deployed surface, including layers another repository owns.
- `docs/solutions/workflow-issues/workflow-output-mode-auto-discarded-agent-fixes-2026-08-31.md` — the other green-but-silently-discarded failure in this repo.
- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md` — routing and reverse-proxy siblings.
