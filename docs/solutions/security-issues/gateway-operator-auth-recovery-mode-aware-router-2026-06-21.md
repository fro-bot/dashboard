---
module: src/server.ts
tags: [auth, oauth, session, gateway, recovery, mode-aware, open-redirect, csrf]
problem_type: security-issue
issue: fro-bot/dashboard#70
related:
  - docs/solutions/security-issues/gateway-operator-session-cookie-forwarding-trust-boundary-2026-06-20.md
  - docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md
  - docs/solutions/security-issues/github-app-credential-domain-conflation-2026-06-15.md
  - docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md
---

# Recover into the session authority's own login flow, not your own

## Problem

The dashboard runs in two mutually-exclusive auth modes behind one origin:

| Mode | Login flow | Cookie | Session authority |
| --- | --- | --- | --- |
| Arctic (flag off) | `/auth/login` → `/auth/callback` | `session` | the dashboard |
| Gateway (flag on) | `/operator/auth/github/start` → `/operator/auth/github/callback` | `__Host-session` | the **gateway** (reverse-proxy-routed) |

In gateway mode the gateway is the session authority and its session store is
**in-memory**, so a gateway restart wipes every `__Host-session`. The dashboard
validated each request against the gateway and, on failure, redirected to its OWN
Arctic flow (`/auth/login`). Arctic minted the dashboard `session` cookie — which
the gateway does not accept — so the next validation failed again. The operator
looped through re-auth until GitHub rate-limited them ("Reauthorization required"),
and the repeated Arctic re-auth overwrote `oauth_state` ("Forbidden state
mismatch"). The system could not self-heal from a routine gateway restart.

## Root cause

**Recovering into the wrong authority's login flow.** When the session authority
is a separate service, failing into your own login flow mints a credential the
authority rejects, producing an infinite loop instead of recovery. The bug was not
a single bad redirect — it was a whole mode minting the wrong credential.

## Solution

### 1. Fail into the authority's flow

Every gateway-branch denial redirects to the GATEWAY operator login, which mints
the `__Host-session` the gateway requires:

```
const GATEWAY_LOGIN_REDIRECT = '/operator/auth/github/start?return_to=/operator'
// used by ALL gateway-branch denials: missing cookie, invalid configured origin,
// session-validation failure, expired session, non-positive operatorId, blank login
```

A gateway restart now becomes a clean automatic re-auth redirect. Note the count:
the gateway branch had **six** denial sites, not the three the plan first
estimated — the post-validation semantic defenses (expired / non-positive
operatorId / blank login) are denial sites too. Find them all by reading the test
output, not by eyeballing the happy path.

### 2. Close the loop at its source: mode-aware router mounting

Patching the redirect target is not enough — a direct hit to `/auth/login` could
still mint a dashboard `session`. Make the `/auth` mounting mode-aware: in gateway
mode, mount a minimal router that redirects `/auth/login` to the gateway login and
do NOT mount the Arctic callback at all. Then a dashboard session is
**unmintable** in gateway mode (the callback 404s, no `Set-Cookie`) — the loop is
closed structurally, not just redirected around.

### 3. The exact-allowlist `return_to` gotcha

The gateway validates `return_to` against an **exact allowlist** (default
`['/operator']`, no prefix matching) and rejects a non-allowlisted value with a
bad request. The obvious-looking fix — send the operator's current path as
`return_to` so they land back where they were — would be **rejected** for any path
other than `/operator`, re-breaking recovery. Emit the known-safe allowlisted value
(`/operator`). It is also a fixed same-origin relative literal with no
request-derived component, so it introduces no open redirect.

### 4. Don't render a feature that lives only in the other mode

A companion bug the review caught: the SSR rendered a logout form POSTing to
`/auth/logout` — which is unmounted (404) in gateway mode. Any UI that targets a
route mounted in only one mode must be gated on that mode. Here: suppress the
dashboard logout form in gateway mode (the gateway owns the session; the dashboard
has nothing to log out).

## Prevention

- When a route's behavior forks on a mode flag, gate BOTH the route mounting AND
  any UI that targets it on the same flag — and add a test that the
  other-mode-only route 404s and mints no cookie.
- A redirect/recovery target that points at another service's contract must emit a
  value that service's validation will accept; verify the validation rule
  (exact-allowlist vs prefix) against source, and pin the emitted value with a test.
- Keep the recovery target a fixed same-origin relative literal — never derive it
  from the request (Host, path), or you reintroduce an open redirect.
- Count denial sites from the test output. A "change the 3 redirects" estimate hid
  3 more; the RED suite surfaced all six.

## Cross-repo sequencing

The dashboard half ships independently — redirecting to the gateway login is
exactly the documented operator workaround, made automatic. The round-trip that
lands the operator back on their EXACT prior page is a separate gateway change
(honoring `return_to` in the callback; fro-bot/agent#973, still open). The dashboard
emits `return_to` forward-compatibly, so no dashboard change is needed when that
ships — unless richer return-to-page support is wanted, which would require widening
the gateway allowlist AND emitting the actual path instead of the fixed `/operator`.

## See also

- `gateway-operator-session-cookie-forwarding-trust-boundary-2026-06-20.md` — the
  configured-origin / cookie-forwarding trust boundary in the same dual-mode auth.
- `safe-operator-launch-surface-2026-06-20.md` — the reverse-proxy-owns-the-route
  topology these `/operator/*` paths rely on.
