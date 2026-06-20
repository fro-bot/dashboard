---
title: Dashboard auth convergence onto the gateway operator session
date: 2026-06-20
status: requirements
issue: fro-bot/dashboard#53
tracks: fro-bot/agent#907
authority_decision: fro-bot/agent#951
type: feat
scope: standard
---

# Dashboard auth convergence onto the gateway operator session

## Problem

The dashboard runs its own operator authentication: an Arctic GitHub OAuth flow
plus a signed-cookie session (`src/auth/oauth.ts`, `src/session.ts`,
`src/routes/auth.ts`), gated by a dashboard-local login allowlist
(`DASHBOARD_OPERATOR_LOGIN`). The ratified S2 decision (fro-bot/agent#951) makes
the gateway operator-auth surface the single authority, with a numeric
GitHub-user-ID allowlist as the single source of truth. The dashboard's
independent auth stack and login-string allowlist now conflict with that
authority and must converge onto the gateway operator session.

## Goal

Let the dashboard delegate operator authentication to the gateway operator
session, removing the dashboard as an independent auth authority — without
breaking the live read-only dashboard during the transition.

## Sequencing reality (verified)

The gateway operator surface is served same-origin through
`https://dashboard.fro.bot` (`GATEWAY_OPERATOR_PUBLIC_ORIGIN`). Live probe on
2026-06-20:

- `GET /operator/auth/github/start` → `302` — gateway **auth path is live**.
- `GET /operator/session` → `404` — gateway **session read surface is NOT live yet**.

The session read surface is the hard dependency for cutover. Therefore this work
builds the delegation path **behind a flag, default OFF**, and **defers** the
actual cutover and the retirement of the Arctic stack until the gateway read
surface is live (coordinated with the gateway/agent session).

## Trust boundary (load-bearing — read before the decisions)

The entire convergence rests on three trust-boundary properties. If any is
violated the dashboard has an auth bypass, so they are stated explicitly and
must be preserved by the implementation and verified by tests.

- **TB1 — The validated principal is the END USER, not the dashboard.** The
  dashboard's `GET /operator/session` call must carry the **end user's** gateway
  session cookie (forwarded from the inbound request), never the dashboard's own
  server identity or a shared service credential. Validating "can the dashboard
  reach the gateway" instead of "is THIS user's session a valid operator" is a
  confused-deputy bypass and is forbidden.
- **TB2 — `/operator/session` is an AUTHORIZATION oracle, not a presence check.**
  "Gateway-session presence is authorization" (D3) is only sound because the
  gateway returns a successful operator identity **only** for a session that has
  already passed the gateway's numeric-user-ID allowlist, and returns non-2xx /
  non-operator for any merely-authenticated-but-not-authorized principal. The
  dashboard depends on this guarantee; planning must confirm it against the
  gateway contract and the implementation must treat any ambiguity as deny.
- **TB3 — Fail closed on EVERY non-success path, with zero fallback.** Deny on:
  404, 5xx, timeout, network error, empty/malformed body, schema drift, a 2xx
  with an expired or non-operator identity, or any unexpected shape. No failure
  mode may fall back to the Arctic path or to anonymous/default-allow access.

## Decisions

- **D1 — Session validation by read-call, not cookie parsing.** The dashboard
  resolves operator identity by making a server-side, same-origin call to the
  gateway's `GET /operator/session`, **forwarding the end user's gateway session
  cookie** (TB1), and trusting the gateway's answer. The dashboard never parses,
  forges, re-signs, or substitutes the gateway cookie.
- **D2 — Flag-gated dual-mode, mutually exclusive.** A feature flag selects
  exactly one authority: flag-OFF = today's Arctic session (the live default),
  flag-ON = gateway-session delegation. The two are never unioned. Default OFF.
- **D3 — Gateway-session presence is authorization.** In flag-ON mode, a valid
  gateway operator session is sufficient; the dashboard performs **no** identity
  or allowlist check of its own (the gateway already enforced its numeric
  user-ID allowlist before issuing the session). `DASHBOARD_OPERATOR_LOGIN` is
  irrelevant in flag-ON mode and governs only the legacy Arctic path until it is
  retired.
- **D4 — Flag-aware UI copy.** The operator route renders the converged
  "single gateway session" wording in flag-ON mode and keeps the current
  "separate credential domains" wording in flag-OFF mode, so the UI never
  misrepresents the active model.

## Requirements

- **R1** — A gateway-session validation primitive that calls `GET /operator/session`
  same-origin server-side **forwarding the inbound end-user gateway session
  cookie** (TB1), returns the resolved operator identity on success, and **fails
  closed** (denies) on every non-success path enumerated in TB3 — 404, 5xx,
  timeout, network error, empty/malformed body, schema drift, or a 2xx carrying an
  expired or non-operator identity. (D1, TB1, TB3)
- **R2** — A feature flag (default OFF, fail-closed parse like the existing
  operator-UI flag `DASHBOARD_OPERATOR_UI_ENABLED` / `readOperatorUiConfig()`)
  that selects gateway-session mode vs Arctic mode in the protected-route
  middleware. (D2)
- **R3** — In flag-ON mode the protected-route middleware authorizes purely on a
  valid gateway operator session (TB2); it performs no `DASHBOARD_OPERATOR_LOGIN`
  / login-allowlist check and consults no dashboard-local identity source. (D3, TB2)
- **R3a** — The protected-route middleware is restructured as an **early strategy
  branch** (flag selects Arctic-path OR gateway-path at the top), not a
  post-verify fallback or a layered check. The gateway-path branch shares no
  login-equality comparison with the Arctic path. This structural split is what
  makes R5 enforceable rather than aspirational. (D2, R5)
- **R4** — In flag-OFF mode the existing Arctic middleware behavior is byte-for-byte
  unchanged (deny-by-default, session-cookie verify, `session.login === operatorLogin`). (D2)
- **R5** — The two auth modes are mutually exclusive: no request path may consult
  both authorities, and neither mode may fall back to the other (including on
  failure — TB3). (D2)
- **R6** — Flag-aware operator UI copy: converged wording flag-ON, current wording
  flag-OFF. (D4)
- **R7** — Tests cover, at the **middleware-integration level** (exercising the real
  protected-route chain, not just the primitive in isolation): gateway-session
  valid → access; gateway-session invalid/expired → denied; `/operator/session`
  404/5xx/timeout/malformed/empty/schema-drift → fail-closed denied (TB3); a 2xx
  with a non-operator identity → denied (TB2); the end-user cookie is the
  forwarded principal (TB1); flag-OFF preserves existing Arctic behavior
  byte-for-byte; the two modes never union and never cross-fall-back (R5); and
  flag-aware copy renders correctly in each mode.

## Non-goals (explicitly deferred)

- **N1** — Retiring the Arctic stack (`src/auth/oauth.ts`, `src/session.ts`,
  `src/routes/auth.ts`) and removing `DASHBOARD_OPERATOR_LOGIN`. Follow-up PR
  after the flag is flipped live.
- **N2** — The flag flip / cutover deploy itself. Owned by the deploy step once
  `GET /operator/session` is live; coordinated with the agent session.
- **N3** — Rewiring the dashboard's monitoring read data onto gateway read
  surfaces (binding reads). The GitHub App installation-token read path is
  untouched here.
- **N4** — Any change to repository data-access permissions. This work changes
  operator/human **session authority** only; the read-only installation-token
  invariant is preserved.

## Constraints

- Fail closed on any gateway session/read failure; never serve an unprotected
  read view during the transition.
- Never union local + gateway auth (R5).
- Never parse, forge, or re-sign gateway cookies; treat the gateway as the
  authority (D1).
- Do not extend `src/auth/oauth.ts` (the retiring path).
- Preserve the read-only dashboard invariant for GitHub App installation tokens.
- Node 24 strip-only TS; `Result<T,E>` boundaries; same-origin relative
  `/operator/*` contract via the injected-fetch operator client.

## Success criteria

- With the flag OFF (live default), dashboard auth behaves exactly as today.
- With the flag ON against a live `GET /operator/session`, a valid gateway
  operator session grants access and the dashboard makes no independent identity
  decision; an invalid/absent/failed session is denied (fail-closed).
- The Arctic stack is still present but cleanly separable for the deferred
  retirement PR.
- Gates green (`pnpm check-types`, `pnpm lint`, `pnpm test`).

## Open questions for planning

- **Confirm TB2 against the gateway contract.** Before implementing, verify that
  the gateway's `GET /operator/session` returns a successful operator identity
  ONLY for a session that passed the gateway's numeric-user-ID allowlist (not for
  any merely-authenticated user). If the gateway does not guarantee this, the
  "zero dashboard allowlist" decision (D3) must be revisited. Coordinate with the
  agent/gateway session.
- **Audit read-path coupling to `c.get('sessionLogin')` (N3 safety).** Today the
  middleware sets `sessionLogin` on context from the Arctic session. Planning must
  confirm no read-data / authorization path depends on `sessionLogin` in a way
  that breaks when identity comes from the gateway session instead — otherwise N3
  (read-data untouched) is not cleanly separable.
- Flag name + config seam (mirror `DASHBOARD_OPERATOR_UI_ENABLED` /
  `readOperatorUiConfig()` shape).
- Whether the gateway-session validation result should be briefly cached per
  request vs called once per protected request (latency vs freshness) — a
  HOW decision for planning.
- Exact injected-fetch/transport wiring for the server-side same-origin
  `/operator/session` call (forwarding the end-user cookie per TB1) within the
  existing operator-client boundary, which is currently mock-only/contract-only
  and needs a real server-side relative-path fetch adapter.
