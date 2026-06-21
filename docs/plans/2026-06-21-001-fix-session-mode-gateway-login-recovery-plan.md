---
title: 'fix: SESSION-mode gateway-login recovery (stop the Arctic re-auth loop)'
type: fix
status: active
date: 2026-06-21
issue: fro-bot/dashboard#70
companion: fro-bot/agent#973 (callback return_to round-trip — OPEN, not required for this fix)
---

# fix: SESSION-mode gateway-login recovery (stop the Arctic re-auth loop)

## Overview

In gateway operator-session mode, a gateway restart wipes every in-memory
`__Host-session`. The dashboard then redirects auth failures to its own Arctic
flow (`/auth/login`), which mints the dashboard `session` cookie — a cookie the
gateway does not accept — so validation fails again in a loop, overwriting
`oauth_state` ("state mismatch") and tripping GitHub's re-auth rate limit. Fix:
in SESSION mode, route auth failures and `/auth/login` to the gateway operator
login (`/operator/auth/github/start?return_to=/operator`) so the operator mints
the correct `__Host-session` and self-heals. (see issue #70)

## Problem Frame

Two OAuth flows live behind the dashboard origin: dashboard Arctic
(`/auth/login`→`/auth/callback`, cookie `session`) and gateway operator
(`/operator/auth/github/start`→`/operator/auth/github/callback`, cookie
`__Host-session`, served by the reverse proxy → gateway). The gateway is the
session authority. In SESSION mode the dashboard validates every protected request
via `getCurrentSession()` (`GET /operator/session`); on failure it currently
redirects to the WRONG flow (`/auth/login`). Confirmed in code:
`src/server.ts` has three `c.redirect('/auth/login', 302)` sites in the gateway
branch (missing cookie, invalid origin, validation failure), and the Arctic
`/auth` router is mounted whenever `operatorLogin` is set — even in SESSION mode.

## Requirements Trace

- R1 — In SESSION mode, the three gateway-branch failures redirect to the gateway
  operator login, not Arctic. (issue Proposed fix #1)
- R2 — In SESSION mode, `/auth/login` redirects to the gateway operator login, and
  the Arctic callback that mints the dashboard `session` cookie is NOT reachable,
  so no dashboard-only session can be minted in SESSION mode. (issue Proposed fix
  #1; Fro Bot triage #2)
- R3 — The emitted `return_to` is always `/operator` (the gateway's default
  allowlist value) so the start route never rejects it. (research: exact-allowlist
  validation, default `['/operator']`)
- R4 — Replace the tests that encode the buggy `/auth/login` redirects with tests
  asserting the gateway-login redirect for missing cookie, 401 invalid_session,
  expired/invalid session, and validation failure. (Fro Bot triage #3)

## Scope Boundaries

- Dashboard recovery-path redirect only. This is independently shippable and is
  exactly the documented operator workaround (start at the gateway flow), made
  automatic.
- Non-Arctic-vs-gateway behavior is unchanged: Arctic mode (flag off) keeps
  `/auth/login`→`/auth/callback` exactly as today.

### Deferred to Separate Tasks

- The callback `return_to` round-trip that lands the operator back on the
  originating page: fro-bot/agent#973 (gateway-side, OPEN). Not required here —
  the dashboard emits `return_to=/operator` forward-compatibly; until #973 ships
  the gateway callback still returns JSON after minting the cookie, but the
  recovery (mint `__Host-session`, reload `/operator`) already works.

## Context & Research

### Verified contract (live fro-bot/agent v0.73.0)

- `GET /operator/auth/github/start` exists, is public, and ALREADY accepts +
  validates `return_to` (since ~v0.68.0). Validation is an EXACT allowlist
  (`validateReturnPath` vs `GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS`, default
  `['/operator']`, no prefix match); a non-allowlisted value is rejected as bad
  request. → emit exactly `/operator` (R3).
- `GET /operator/auth/github/callback` today returns identity JSON after minting
  `__Host-session`; it does NOT honor `return_to` yet (agent#973 OPEN). So the
  round-trip-to-page is deferred; the cookie mint + self-heal is not.
- Cookie `__Host-session`; minted by the start→callback PKCE flow.
- These `/operator/*` paths are served by the reverse proxy → gateway; the
  dashboard does NOT mount them (consistent with the no-proxy topology — the
  dashboard only emits the redirect URL).

### Relevant code

- `src/server.ts:369-437` — gateway branch; three `/auth/login` redirects at
  ~386 (missing cookie), ~394 (invalid origin), ~436 (validation failure).
- `src/server.ts:505-520` — `/auth` router mounting (denied if no operatorLogin,
  else Arctic authRouter — currently regardless of SESSION mode).
- `src/routes/auth.ts` — `buildAuthRouter` (Arctic `/login` + `/callback`).
- `test/gateway-auth.test.ts:207-217, 331-337` — encode the buggy `/auth/login`
  redirects (to be replaced).

### Institutional learnings

- `docs/solutions/security-issues/gateway-operator-session-cookie-forwarding-trust-boundary-2026-06-20.md`
  — the dual-mode auth + configured-origin discipline this fix extends.

## Key Technical Decisions

- **KTD1 — Single redirect target constant.** Introduce one constant for the
  gateway login URL `'/operator/auth/github/start?return_to=/operator'` and use it
  for all SESSION-mode redirects (the three gateway-branch sites + `/auth/login`),
  so the value is defined once. `/operator` is hardcoded (R3) — the gateway
  default allowlist; not configurable (YAGNI until the allowlist widens).
- **KTD2 — `/auth` mounting becomes mode-aware.** Extract the `/auth` mounting so
  that in SESSION mode it mounts a minimal router: `GET /auth/login` 302s to the
  gateway login constant; `/auth/callback` (and any other Arctic path) is NOT
  mounted (returns 404), so the dashboard `session` cookie cannot be minted in
  SESSION mode. In Arctic mode (flag off) the existing `buildAuthRouter` mounting
  is unchanged.
- **KTD3 — No open-redirect surface.** The redirect target is a fixed same-origin
  relative literal; no part is derived from the request (no Host, no user path),
  so the fix introduces no open redirect and no Host-header influence.

## Open Questions

### Resolved During Planning

- return_to value → `/operator` (exact-allowlist safe). (R3)
- `/auth/login` in SESSION mode → redirect to gateway login; don't mount the
  Arctic callback. (R2/KTD2)
- Sequencing vs agent#973 → ship the dashboard half now; emit return_to
  forward-compatibly. (Scope)

### Deferred to Implementation

- Whether the SESSION-mode `/auth` router also redirects non-`/login` Arctic paths
  (e.g. `/auth/callback`) to the gateway login or just 404s — default 404 unless a
  test shows a reachable callback hit needs friendlier handling.
- Exact helper placement for the redirect constant (server.ts module scope vs a
  small shared module).

## Implementation Units

- [ ] **Unit 1: Route SESSION-mode auth failures to the gateway login**

**Goal:** The three gateway-branch failure redirects point to the gateway operator login.

**Requirements:** R1, R3, KTD1, KTD3

**Dependencies:** None

**Files:**
- Modify: `src/server.ts` (add the gateway-login constant; replace the three
  `c.redirect('/auth/login', 302)` in the gateway branch at ~386/394/436)
- Test: `test/gateway-auth.test.ts`

**Approach:** Define `GATEWAY_LOGIN_REDIRECT = '/operator/auth/github/start?return_to=/operator'`. Replace the gateway-branch `/auth/login` redirects (missing cookie, invalid origin, validation failure) with a 302 to it. Leave the Arctic strategy branch (flag off) untouched.

**Execution note:** Test-first — flip the existing assertions to the new target (they currently pin the bug).

**Patterns to follow:** the existing gateway-branch redirect calls + coarse `logger.warning({path})` logging (no identity/cookie in logs).

**Test scenarios:**
- Happy path: SESSION mode, no inbound cookie on a protected path → 302 to the gateway login constant (exact Location, incl `return_to=/operator`).
- Error path: SESSION mode, `getCurrentSession()` returns http 401 invalid_session → 302 to the gateway login (not `/auth/login`).
- Error path: SESSION mode, network/protocol/validation failure → 302 to the gateway login.
- Edge: invalid configured gateway origin → 302 to the gateway login (still fails closed, correct target).
- Invariant: the redirect Location is a fixed relative literal — no request-derived component (no Host influence, no open redirect).
- Public path in SESSION mode still passes through (no redirect).

**Verification:** All gateway-branch denials in SESSION mode send the operator to the gateway login; no `/auth/login` redirect remains in that branch.

- [ ] **Unit 2: Make `/auth` mounting mode-aware (no dashboard session in SESSION mode)**

**Goal:** In SESSION mode, `/auth/login` redirects to the gateway login and the Arctic callback is not mounted.

**Requirements:** R2, R3, KTD2, KTD3

**Dependencies:** Unit 1 (shares the redirect constant)

**Files:**
- Modify: `src/server.ts:505-520` (mode-aware `/auth` mounting)
- Test: `test/gateway-auth.test.ts` (and `test/auth.test.ts` / `test/server.test.ts` if they assert `/auth` shape)

**Approach:** When `gatewayOperatorSessionEnabled` is true, mount a minimal `/auth` router: `GET /auth/login` → 302 to the gateway-login constant; do NOT mount `buildAuthRouter` (so `/auth/callback` and the dashboard `session`-minting path are unreachable → 404). When false, keep today's behavior exactly (denied router if no operatorLogin, else `buildAuthRouter`). Confirm the no-operatorLogin fail-closed case still holds in both modes.

**Execution note:** Test-first for the SESSION-mode `/auth/login` redirect + the `/auth/callback` 404.

**Patterns to follow:** the existing denied-router vs authRouter branch; the flag-gated mounting style elsewhere in `server.ts`.

**Test scenarios:**
- Happy path: SESSION mode → `GET /auth/login` 302s to the gateway login constant.
- Security: SESSION mode → `GET /auth/callback?...` is NOT handled (404) — no dashboard `session` cookie can be minted.
- Regression: Arctic mode (flag off) → `/auth/login` and `/auth/callback` behave exactly as today (Arctic flow intact).
- Fail-closed: no `operatorLogin` configured → `/auth` still denies (parity preserved) in the relevant mode.
- Invariant: the SESSION-mode `/auth/login` Location is the same fixed relative literal as Unit 1 (no open redirect).

**Verification:** In SESSION mode the only `/auth` behavior is a redirect to the gateway login; the Arctic session cannot be minted. Arctic mode is unchanged.

- [ ] **Unit 3: Documentation note (optional)**

**Goal:** Capture the dual-flow recovery learning if non-obvious after implementation.

**Requirements:** (convention)

**Dependencies:** Units 1–2

**Files:** Create `docs/solutions/security-issues/<slug>-2026-06-21.md` (only if warranted) — the "two OAuth flows / one origin, fail-into-the-authority's-flow" recovery pattern + the exact-allowlist return_to gotcha.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** Documented if warranted, else skipped (compound can capture post-merge).

## System-Wide Impact

- **Auth recovery path only:** changes where SESSION-mode denials redirect; does not
  touch the gateway-session validation logic, the cookie-forwarding adapter, or the
  Arctic flow when the flag is off.
- **No new open-redirect / Host influence:** the target is a fixed relative literal
  (KTD3).
- **Cross-repo:** forward-compatible with agent#973 (emits `return_to=/operator`);
  full return-to-page lands when #973 ships. No dashboard change needed then unless
  the allowlist widens.
- **Unchanged invariants:** the no-proxy topology (dashboard still doesn't mount
  `/operator/*`), the read-only posture, the gateway-session trust boundary, and
  Arctic-mode behavior.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| return_to rejected by the gateway exact-allowlist | Emit exactly `/operator` (the default allowlist value) (R3/KTD1) |
| A reachable Arctic path still mints a dashboard session in SESSION mode | Don't mount `buildAuthRouter` in SESSION mode; `/auth/callback` 404s (R2/KTD2) |
| Open redirect via the recovery target | Fixed relative literal, no request-derived part (KTD3) |
| Breaking Arctic mode (flag off) | Mode-aware branch leaves the flag-off path byte-for-byte; regression tests pin it |
| Round-trip-to-page not yet working | Deferred to agent#973; recovery (cookie mint + reload) works without it |

## Documentation / Operational Notes

- No new env var, no new dependency. The fix is purely the redirect target +
  mode-aware `/auth` mounting.
- Operator impact: a gateway restart becomes an automatic re-auth redirect instead
  of an outage + OAuth storm. Until agent#973, the operator lands on `/operator`
  after re-auth (not their exact prior page) — acceptable.

## Sources & References

- Origin issue: fro-bot/dashboard#70 (+ Fro Bot triage confirming code sites)
- Companion: fro-bot/agent#973 (callback return_to — OPEN, deferred)
- Verified contract: fro-bot/agent v0.73.0 `packages/gateway/src/web/auth/github.ts`
  (start route + `validateReturnPath` + callback), `config.ts`
  (`GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS`), `session.ts` (`__Host-session`)
- Code: `src/server.ts:369-437, 505-520`, `src/routes/auth.ts`,
  `test/gateway-auth.test.ts:207-217, 331-337`
