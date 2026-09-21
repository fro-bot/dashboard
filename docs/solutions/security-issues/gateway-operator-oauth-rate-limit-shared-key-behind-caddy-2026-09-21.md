---
title: A reverse proxy collapsed every rate-limit identity into one and locked out the only operator
date: 2026-09-21
category: security-issues
module: dashboard
problem_type: security_issue
component: authentication
severity: high
symptoms:
  - "GET /operator/auth/github/start returns 429 {\"error\":\"rate limited\"} after a handful of unauthenticated page loads"
  - "audit: auth.start count equals maxOutstandingAttemptsPerKey exactly, while auth.callback.success AND auth.callback.failure both stay at zero"
  - "Reloading the dashboard re-triggers the redirect that mints the state, so the window never drains"
  - "Every device and browser is affected, including after clearing all site data"
root_cause: scope_issue
resolution_type: config_change
related_components:
  - fro-bot/agent
  - marcusrbrown/infra
tags:
  - oauth
  - rate-limit
  - reverse-proxy
  - caddy
  - lockout
  - x-forwarded-for
  - trust-boundary
  - operator-auth
---

# A reverse proxy collapsed every rate-limit identity into one and locked out the only operator

## Problem

`dashboard.fro.bot` proxies `/operator/*` through Caddy to the gateway. The gateway derives every unauthenticated rate-limit key from the TCP socket address — which, behind a proxy, is always the proxy's.

So every client shares one key. A cap written as per-client is global, and the only operator locked himself out of his own dashboard by reloading a page.

## Symptoms

- `429 {"error":"rate limited"}` from `/operator/auth/github/start`, on every device and browser, including with all site data cleared.
- The signature that identifies this specifically:

```
audit: auth.start                   5    ← exactly maxOutstandingAttemptsPerKey
outstanding attempt cap exceeded   21
auth.callback.success               0
auth.callback.failure               0
```

**Neither callback outcome.** Not a failure — the handler never ran. That single fact separates "blocked before reaching GitHub" from "failed after returning from GitHub", and it is the most useful discriminator in the whole incident.

## What Didn't Work

Three hypotheses, each plausible, each disproved by evidence. Worth recording because the wrong ones all *fit the symptom*.

**1. The unauthenticated request limiter.** `DEFAULT_UNAUTH_LIMIT = 20` per 60s, shared with `/operator/health`, in `fro-bot/agent` `packages/gateway/src/web/server.ts:90-91`. Tight enough to trip, and the symptom was a 429.

Disproved: **zero** `rate limited (unauthenticated)` lines in the logs. The limiter exists and was never the gate.

**2. The forwarded-header middleware.** `packages/gateway/src/web/server.ts:423-438` rejects a request whose `X-Forwarded-Host` doesn't match the configured public origin — with a 400, *before routing*. That would produce exactly the observed silence: no callback audit of either kind, because the handler never runs.

Disproved by ordering: every such rejection in the log window clustered *before* any `auth.start`. They were unrelated traffic.

**3. The service worker.** `web/src/sw.ts:51-54` registers `NetworkOnly` for `/operator/auth/*`. A `NetworkOnly` navigation whose response is a cross-origin redirect is a real trap — the SW fetches it (so the server records the hit) and the browser never leaves the origin. This matched *every* observation and was the best wrong answer of the night.

Disproved by clearing all site data, unregistering the worker, and still getting `429`.

Also wrong along the way: reporting that logout 404'd, having probed `GET` when the route is `POST /operator/auth/logout`.

What broke it open was the operator noting it had worked before — reframing the problem from misconfiguration to regression — and one `curl` reading the `Location` header:

```bash
curl -s -o /dev/null -w '%{redirect_url}' \
  'https://dashboard.fro.bot/operator/auth/github/start?return_to=/operator'
```

A correct `302` to `github.com` carrying the right `redirect_uri` eliminated hypotheses 2 and 3 and the entire "redirect is misconfigured" family in one request.

## Solution

**Immediate**, in `marcusrbrown/infra`, as a `gateway`-environment secret, then redeploy:

```
GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS=50
```

A workaround, not a fix. Keying is still global, so one client can still exhaust it — just not by reloading a page.

**Real fix:** `fro-bot/agent#1638` — a trusted-proxy allowlist. Honor `X-Forwarded-For` only when the socket address is a configured trusted proxy; otherwise keep using the socket address. That keeps the anti-spoofing property (an arbitrary caller still cannot forge a key) while restoring per-client isolation.

**When stuck right now:** the OAuth state store is an in-memory `Map`, so restarting the gateway clears it instantly. Otherwise entries expire only via `evictStale`, which runs *on a start request* — so draining requires a quiet window with zero attempts.

## Why This Works

The root cause is a trust-boundary mistake, and the fix restores the missing invariant: only a known proxy may supply forwarding identity.

It also resolves an inconsistency in the current design. The gateway already trusts forwarded headers for correctness — `packages/gateway/src/web/server.ts:423-438` *requires* `X-Forwarded-Host` to match the public origin — while rejecting `X-Forwarded-For` as spoofable for rate-limit keying, in the same request. That split is only coherent if the identity source is proxy-aware. Otherwise the proxy becomes the identity.

The collapse alone wasn't enough to cause an outage. Three facts had to combine:

1. **Keys collapse behind the proxy** — per-client becomes global.
2. **The dashboard auto-redirects every unauthenticated visit** to `/operator/auth/github/start` (`src/server.ts:111`, reached from six denial sites), and each visit mints an outstanding state entry consumed only by a successful callback. Page loads become cap-consuming traffic.
3. **Gateway sessions are in-memory**, so the deploy that enabled push wiped every session and forced a simultaneous re-login.

Any one is survivable. Together they produce a lockout that a reload actively deepens.

## Prevention

- **A per-client limit behind a reverse proxy must derive identity from a trusted-proxy-aware source**, or it is a global limit wearing a per-client name. This is the whole lesson.
- **Defaults sized for multi-tenant abuse are wrong for single-operator deployments.** A cap of 5 with a 10-minute TTL is sensible per user and absurd globally.
- **Never pair a tight global auth cap with an auto-redirect that mints state on every unauthenticated page load.** The retry path becomes the attack traffic.
- **An in-memory session store means every deploy is a forced re-login for everyone.** Fine alone; dangerous next to a tight global login cap.
- **Diagnostic rule worth memorizing:** when a `start` audit event fires but *neither* success nor failure follows, the handler never ran. Look upstream — proxying, rate limits, redirects — not inside the handler.
- **Verify a claim about a live system rather than reasoning about it.** One `curl` reading a `Location` header outperformed an hour of plausible theory.

## Related Issues

- [fro-bot/agent#1638](https://github.com/fro-bot/agent/issues/1638) — the trusted-proxy fix.
- `docs/solutions/security-issues/gateway-operator-auth-recovery-mode-aware-router-2026-06-21.md` — the nearest precedent. Same operator-login surface, also triggered by a gateway restart wiping in-memory sessions, but a different failure: that one minted a credential the authority rejected. It fixed recovery *routing*; this incident shows the surface still had a separate availability failure.
- `docs/solutions/integration-issues/public-route-swallowed-by-caddy-extensionless-rewrite-2026-09-20.md` — the other Caddy-layer failure on this deployment. Different mechanism, same lesson about an edge layer nobody models.
- `marcusrbrown/infra` `docs/runbooks/gateway-access.md` — how to read gateway logs and restart a service, including the log-shape triage used here.
