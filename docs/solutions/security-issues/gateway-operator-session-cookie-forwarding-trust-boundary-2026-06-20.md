---
title: Gateway operator session auth — trust boundary for a server-side cookie-forwarding validator
date: 2026-06-20
category: security-issues
module: src/gateway/operator-server-fetch.ts
problem_type: security_issue
component: authentication
symptoms:
  - "Auth bypass: a spoofed Host header redirects the forwarded operator cookie to an attacker origin that returns a forged /operator/session"
  - "An exported cookie-forwarding adapter resolves absolute or protocol-relative URLs off the configured origin via new URL(input, origin)"
  - "The forwarded fetch follows a 3xx redirect, leaking the end-user's operator cookie off-origin"
  - "No timeout on the forwarded fetch; a hung gateway stalls the auth path instead of failing closed"
  - "A caller-supplied Authorization header is forwarded alongside the cookie, risking principal confusion"
root_cause: missing_validation
resolution_type: code_fix
severity: critical
tags: [credential-forwarding, trust-boundary, auth-bypass, host-header-injection, fail-closed, gateway-cookie]
---

# Gateway operator session auth — trust boundary for a server-side cookie-forwarding validator

## Problem

When the dashboard delegates operator authentication to the gateway (issue #53,
PR #57), the auth middleware validates the caller by forwarding the **end user's**
inbound cookie to `GET /operator/session` and trusting a valid response. If the
trust boundary of that forwarding step is fuzzy, the cookie can be sent somewhere
it shouldn't — turning an auth check into an auth bypass.

## Symptoms

- The validation origin was derived from the request (`new URL(c.req.url).origin`),
  which is built from the attacker-influenceable `Host` header.
- The exported `createOperatorServerFetch` adapter resolved any `input` via
  `new URL(input, origin)`, so an absolute (`https://attacker/operator/session`) or
  protocol-relative (`//attacker/...`) input silently bypassed the configured origin.
- The forwarded fetch would follow a 3xx redirect, carrying the operator cookie off-origin.
- No timeout: a hung gateway stalled the dashboard's auth path rather than failing closed.
- Caller-supplied headers (including `Authorization`) were merged onto the outbound request.

## What Didn't Work

The initial implementation derived the origin from the request and relied on the
**operator client's own** path validation to protect the exported adapter. That is
backwards: an exported, cookie-forwarding primitive must enforce its **own**
fail-closed boundary. Caller-side validation is not a security boundary — the next
caller (or a refactor) removes the protection without touching the adapter.

## Solution

**1. Bind the validation origin to a configured trusted value — never the request.**

```ts
// src/gateway/operator-config.ts
const DEFAULT_GATEWAY_OPERATOR_ORIGIN = 'https://dashboard.fro.bot'

export function readGatewayOperatorOrigin(): string | null {
  const candidate = raw ?? DEFAULT_GATEWAY_OPERATOR_ORIGIN
  const parsed = new URL(candidate)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.origin
}
```

The middleware uses `resolvedGatewayOrigin` (configured), never `new URL(c.req.url).origin`,
and denies when the configured origin is unusable.

**2. The exported adapter validates its own target.**

```ts
// src/gateway/operator-server-fetch.ts
if (
  input.startsWith('//') ||
  input.includes('..') ||
  (input !== '/operator' && !input.startsWith('/operator/'))
) {
  throw new Error('Refusing to forward cookie to a non-/operator path.')
}
const resolved = new URL(input, origin)
if (resolved.origin !== new URL(origin).origin) throw new Error('...different origin.')
if (resolved.pathname !== '/operator' && !resolved.pathname.startsWith('/operator/')) {
  throw new Error('...outside /operator.')
}
```

**3. Defense-in-depth on the forwarded request.**

```ts
normalized.delete('cookie')
normalized.delete('authorization') // never forward a caller credential
normalized.set('cookie', cookie)   // the end-user cookie is the only principal

const mergedInit: RequestInit = {
  ...init,
  headers: mergedHeaders,
  redirect: 'error',                                  // cookie must not follow a 3xx
  signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS), // hang → fail closed
}
```

**4. Fail closed on every path in an early, mutually-exclusive strategy branch.**

```ts
// src/server.ts — gateway branch
const inboundCookie = c.req.header('cookie')
if (inboundCookie === undefined || inboundCookie.trim() === '') return c.redirect('/auth/login', 302)
if (resolvedGatewayOrigin === null) return c.redirect('/auth/login', 302)
// ... getCurrentSession() err → deny ; expiresAt <= now → deny
if (result.data.operatorId <= 0) return c.redirect('/auth/login', 302)
if (result.data.login.trim() === '') return c.redirect('/auth/login', 302)
```

The flag selects exactly one branch (gateway OR the legacy session) at the top; the
two never union and never fall back to each other.

## Why This Works

- The request `Host` is attacker-influenceable, so it must **never** select the
  authorization oracle. The validation target is a fact about the deployment, not
  the request.
- The forwarded cookie is the **end-user principal** — a foreign credential. The
  threat model is therefore confused-deputy and off-origin forwarding, which the
  configured origin + self-path validation + `redirect: 'error'` + Authorization
  stripping close.
- An exported credential-forwarding adapter must own its fail-closed boundary; it
  cannot borrow safety from whoever happens to call it today.
- "Gateway-session presence is authorization" is sound only because the gateway's
  `/operator/session` returns success **only** for an allowlist-bound operator — a
  property of the upstream oracle, verified before the flag flips, not assumed by code.

## Prevention

- **Never derive a security-relevant origin from the request.** Pin it to config.
- **An exported credential-forwarding adapter validates its own target** (path,
  origin, redirect, headers, timeout) — caller validation is not a boundary.
- **Flag-gated dual-mode auth is an early, mutually-exclusive branch** with no
  fallback between modes; fail closed on every error.
- **"Presence is authorization" requires the upstream to be an allowlist-bound
  oracle.** Verify that before flipping the flag live (a pre-flip gate, issue #59).
- **Test the real production construction path**, not just an injected mock — assert
  a spoofed Host still targets the configured origin, and that the adapter rejects
  `//host`, absolute URLs, and `..` traversal.

## Related Issues

- Issue #53 — converge dashboard auth onto the gateway operator session (PR #57).
- Issue #59 — cutover gate: env vars + confirm the allowlist guarantee before flipping the flag.
- Extends the credential-domain series:
  - `github-app-credential-domain-conflation-2026-06-15.md` (the root credential-domain lesson)
  - `gateway-operator-client-no-leak-contract-2026-06-18.md` (client transport / no-leak contract)
  - `cross-source-redaction-denylist-before-query-2026-06-15.md` (fail-closed, no leak-by-query)
  - `operator-ui-mock-only-skeleton-pattern-2026-06-18.md` (flag-gated, credential domains distinct)
