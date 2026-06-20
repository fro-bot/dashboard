---
title: 'feat: Dashboard auth convergence onto the gateway operator session'
type: feat
status: active
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-001-feat-dashboard-auth-convergence-requirements.md
issue: fro-bot/dashboard#53
---

# feat: Dashboard auth convergence onto the gateway operator session

## Overview

Add a flag-gated path that lets the dashboard delegate operator authentication to
the gateway operator session (calling `GET /operator/session` same-origin,
forwarding the end-user's gateway cookie, treating gateway-session presence as
authorization) instead of its own Arctic OAuth + signed-cookie session. The flag
defaults OFF; the Arctic stack stays the live authority until the gateway read
surface is live and the flag is flipped. Retiring the Arctic stack and the
cutover deploy are out of scope (deferred).

## Problem Frame

The ratified S2 decision (fro-bot/agent#951) makes the gateway operator-auth
surface the single authority, with a numeric GitHub-user-ID allowlist as the
single source of truth. The dashboard currently runs an independent Arctic OAuth
+ signed-cookie session gated by a dashboard-local login allowlist
(`DASHBOARD_OPERATOR_LOGIN`), which conflicts with that authority. This plan
builds the consumer-side delegation, behind a flag, without breaking the live
read-only dashboard. (see origin: docs/brainstorms/2026-06-20-001-feat-dashboard-auth-convergence-requirements.md)

Verified sequencing reality (2026-06-20 live probe, same-origin via
`https://dashboard.fro.bot`): `GET /operator/auth/github/start` → 302 (gateway
auth live); `GET /operator/session` → 404 (gateway session read surface NOT live
yet). The delegation path is therefore buildable + testable now against a mocked
surface; the flag flip and Arctic retirement wait on the live surface.

## Requirements Trace

- R1. Gateway-session validation primitive: calls `GET /operator/session`
  same-origin server-side forwarding the inbound end-user gateway cookie (TB1),
  returns resolved operator identity on success, fails closed on every
  non-success path (TB3). (origin R1)
- R2. Fail-closed boolean feature flag (default OFF) selecting gateway-session vs
  Arctic mode, mirroring `readOperatorUiConfig()`. (origin R2)
- R3. Flag-ON middleware authorizes purely on a valid gateway operator session;
  no dashboard allowlist check, no dashboard-local identity source. (origin R3, TB2)
- R3a. Middleware restructured as an early strategy branch (flag selects Arctic OR
  gateway at the top), no post-verify fallback, no shared login-equality on the
  gateway branch — this is what makes R5 enforceable. (origin R3a)
- R4. Flag-OFF preserves existing Arctic middleware behavior byte-for-byte. (origin R4)
- R5. The two modes are mutually exclusive: no path consults both authorities;
  neither falls back to the other, including on failure (TB3). (origin R5)
- R6. Flag-aware operator UI copy: converged wording flag-ON, current wording
  flag-OFF. (origin R6)
- R7. Middleware-integration-level tests covering TB1/TB2/TB3, flag-OFF parity,
  no-union, and flag-aware copy. (origin R7)

## Trust boundary (load-bearing — carried from origin)

- **TB1** — the validated principal is the END USER: the dashboard's
  `/operator/session` call forwards the inbound end-user gateway cookie, never the
  dashboard's own/service credentials. Confused-deputy bypass otherwise.
- **TB2** — `/operator/session` is an AUTHORIZATION oracle: a successful operator
  identity is returned only for a session that passed the gateway's numeric-user-ID
  allowlist. The dashboard depends on this; it is verified as a pre-flip gate
  (Open Questions), not assumed by code.
- **TB3** — fail closed on EVERY non-success path (404/5xx/timeout/network/
  empty/malformed/schema-drift/expired-or-non-operator 2xx), zero fallback.

## Scope Boundaries

- Operator/human **session authority** only — repository data-access permissions
  and the read-only GitHub App installation-token path are unchanged.
- The new auth flag is independent of `DASHBOARD_OPERATOR_UI_ENABLED` (the operator
  UI flag); they are separate concerns and must not be coupled.

### Deferred to Separate Tasks

- Retiring the Arctic stack (`src/auth/oauth.ts`, `src/session.ts`,
  `src/routes/auth.ts`, `DASHBOARD_OPERATOR_LOGIN`): follow-up PR after the flag is
  flipped live (origin N1).
- The flag flip / cutover deploy: owned by the deploy step once `/operator/session`
  is live; coordinated with the agent session (origin N2).
- Rewiring monitoring read data onto gateway read surfaces / binding reads (origin N3).

## Context & Research

### Relevant Code and Patterns

- `src/server.ts` `buildDashboardApp` — the auth middleware is the second
  `app.use('*', ...)` (rate-limit middleware runs first and is unchanged). The
  strategy branch slots into the top of that middleware body. `DashboardAppConfig`
  is the injectable config object (mirror `operatorUiEnabled`/`oauthClient`
  injection for the new flag + client). `isPublicPath` is closure-local.
- `src/gateway/operator-config.ts` `readOperatorUiConfig()` — the canonical
  fail-closed boolean-flag pattern (only trimmed case-insensitive `'true'`
  enables; `readOptionalSecret` throw → disabled). Mirror for the new flag. Test:
  `test/operator-config.test.ts` (env-var mutation in before/afterEach).
- `src/gateway/operator-client.ts` — `createOperatorClient({fetch, createEventStream, logger?})`
  with injected `fetch`; `getCurrentSession()` calls `/operator/session` and
  parses via `parseOperatorSessionInfo`; `validateOperatorPath` guards paths;
  returns `Result<SessionDto, GatewayClientError>`. The `fetch` field is the seam
  for a real server-side adapter. No production server-side fetch adapter exists
  today (client is mock/contract-only).
- `src/gateway/operator-contract/` — vendored contract v1.0.0;
  `OperatorSessionInfo = {operatorId: number, login: string, expiresAt: number}`;
  `parseOperatorSessionInfo` already fails closed on shape drift (string
  `expiresAt`, non-integer `operatorId`, non-finite values).
- Test harness: `test/auth.test.ts` (`buildTestApp(opts)`, `SessionManager.sign`,
  `app.request()` pattern), `test/operator-ui.test.ts` (flag-gated
  `buildTestApp(flag)` + per-mode assertions), `test/operator-mock-client.ts`
  (throwing-fetch proves no network).

### Institutional Learnings

- `docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md`
  — dashboard session and gateway operator session are distinct credential
  domains; the gateway cookie is forwarded as a *foreign* credential, never merged.
  All `/operator/*` calls go through `validateOperatorPath`; coarse logging only
  (never the cookie value or response body); injectable transport.
- `docs/solutions/security-issues/operator-ui-mock-only-skeleton-pattern-2026-06-18.md`
  — flag is exact-`true` match; flag-gated code uses dynamic `import()` in the
  enabled branch; no-leak tests pin real literals and assert absence; a throwing
  fetch turns "no network" into a test.
- `docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md`
  — fail closed on every failure mode; the call itself can be the leak (flag-OFF
  must issue zero `/operator/session` calls); assert absence-of-action, not
  absence-from-output.
- `docs/solutions/security-issues/github-app-credential-domain-conflation-2026-06-15.md`
  — model credential domains explicitly before coding; test fixtures must
  distinguish (no session / non-allowlisted session / allowlisted session).

## Key Technical Decisions

- **KTD1 — Separate context value, no identity forging.** The gateway branch sets
  a new `Variables.gatewaySession?: SessionDto` and does NOT set/forge
  `sessionLogin`. `sessionLogin` becomes optional and is set only by the Arctic
  branch. Rationale: research confirmed `sessionLogin` has ZERO consumers
  (set-but-never-read), so there is no coupling to preserve; synthesizing a string
  identity from `operatorId` would lie about the trust boundary.
- **KTD2 — No caching; validate per protected request.** Each protected request
  calls `/operator/session`. Rationale: a cached authorization is stale; the
  gateway is the authority and may revoke upstream. Per-request memoization keyed
  on the inbound cookie within a single request is an acceptable later refinement
  that does not change posture; cross-request caching is forbidden.
- **KTD3 — Server-side fetch adapter bound to the inbound request origin.** The
  adapter resolves the relative `/operator/session` against the inbound request's
  origin and forwards the inbound `Cookie` header verbatim; it rejects when no
  inbound cookie is present. Rationale: same-origin in the server-process sense,
  survives staging/prod/local origin changes without config, and forwards the
  end-user principal (TB1). No service-to-service credential is ever used.
- **KTD4 — Early strategy branch, duplicated public-path check.** The flag selects
  Arctic OR gateway at the top of the auth middleware; each branch keeps its own
  `isPublicPath` check rather than sharing one, so a path added to one mode's
  allowlist can't silently bypass the other (R5/R3a).
- **KTD5 — New flag is independent of the operator-UI flag.** A distinct env var
  + reader; never gate the auth branch on `DASHBOARD_OPERATOR_UI_ENABLED`.
- **KTD6 — Expired-session defense at the seam.** Even on a 2xx, the gateway branch
  treats a non-future `expiresAt` as deny (TB3), not only relying on the gateway
  to never return an expired session.

## Open Questions

### Resolved During Planning

- N3 read-path coupling audit: RESOLVED — `sessionLogin` has zero consumers; no
  read-data/authorization path couples to the Arctic identity. N3 is cleanly
  separable.
- Caching: RESOLVED — no caching (KTD2).
- Context-variable shape: RESOLVED — separate `gatewaySession` value (KTD1).
- Relative-path/cookie-forwarding adapter shape: RESOLVED — bound to inbound
  request origin, forward inbound cookie verbatim, reject on missing cookie (KTD3).

### Deferred to Implementation

- Exact env var name (proposed `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED`) and
  reader home (`src/gateway/operator-config.ts` vs a new `operator-auth-config.ts`).
- Exact Hono API for reading the inbound request origin + cookie header within the
  middleware context.

### Pre-flip gate (NOT a code task — must hold before the flag is ever flipped live)

- **Confirm TB2 against the gateway contract** (coordinate with the agent/gateway
  session): `GET /operator/session` returns a successful operator identity ONLY
  for a session that passed the gateway's numeric-user-ID allowlist, and non-2xx /
  non-operator for any merely-authenticated user. If this does not hold, D3
  ("presence is authorization") must be revisited before cutover.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Auth middleware (second `app.use('*')`), flag selects exactly one branch:

```
on each request:
  if gatewayOperatorSessionEnabled:        # GATEWAY branch
    if isPublicPath(path): next()
    cookie = inbound Cookie header
    if no cookie: deny (401/redirect)                      # TB1: no principal
    result = operatorClient.getCurrentSession()            # forwards end-user cookie (TB1)
    if result is err: deny                                 # TB3: every failure → deny
    if result.expiresAt <= now: deny                       # TB3/KTD6
    c.set('gatewaySession', result.data); next()           # KTD1: no sessionLogin
  else:                                     # ARCTIC branch (byte-for-byte today)
    if isPublicPath(path): next()
    if operatorLogin === undefined: 401
    verify signed session cookie; login must equal operatorLogin
    c.set('sessionLogin', session.login); next()
```

Decision matrix (flag × gateway-session state → outcome, GATEWAY branch):

| Flag | /operator/session result | Outcome |
|------|--------------------------|---------|
| OFF | (not called) | Arctic behavior, unchanged |
| ON | valid operator SessionDto, future expiry | allow |
| ON | 404 / 5xx / timeout / network | deny (TB3) |
| ON | 2xx empty/malformed/schema-drift | deny (TB3) |
| ON | 2xx non-operator / expired | deny (TB2/TB3) |
| ON | no inbound cookie | deny (TB1) |

## Implementation Units

- [ ] **Unit 1: Gateway-operator-session feature flag**

**Goal:** A fail-closed boolean flag selecting gateway-session vs Arctic mode.

**Requirements:** R2, R5

**Dependencies:** None

**Files:**
- Modify: `src/gateway/operator-config.ts` (add `readGatewayOperatorSessionConfig()`)
- Modify: `src/server.ts` (`DashboardAppConfig.gatewayOperatorSessionEnabled?: boolean`; resolve from reader when undefined, mirroring `operatorUiEnabled`)
- Test: `test/operator-config.test.ts` (extend) or `test/gateway-operator-config.test.ts` (new)

**Approach:** Mirror `readOperatorUiConfig()` exactly: read via `readOptionalSecret`, throw → disabled, `null` → disabled, only trimmed case-insensitive `'true'` → enabled. Distinct env var (KTD5), independent of `DASHBOARD_OPERATOR_UI_ENABLED`.

**Execution note:** Test-first.

**Patterns to follow:** `src/gateway/operator-config.ts` `readOperatorUiConfig`; `test/operator-config.test.ts` env-var mutation in before/afterEach.

**Test scenarios:**
- Happy path: env unset → `{enabled: false}`.
- Happy path: `'true'`/`'TRUE'`/`'  true  '` → `{enabled: true}`.
- Edge: `'false'`/`'1'`/`'yes'`/`''` → `{enabled: false}`.
- Error path: `readOptionalSecret` throws (embedded newline) → `{enabled: false}` (fail-closed).

**Verification:** New reader returns the fail-closed config; flag is injectable through `DashboardAppConfig`; gates green.

- [ ] **Unit 2: Server-side same-origin operator fetch adapter (cookie-forwarding)**

**Goal:** A real `fetch` adapter (matching `OperatorClientOptions.fetch`) that resolves relative `/operator/*` against the inbound request origin and forwards the end-user cookie (TB1).

**Requirements:** R1, TB1, TB3

**Dependencies:** None (consumed by Unit 3)

**Files:**
- Create: `src/gateway/operator-server-fetch.ts`
- Test: `test/operator-server-fetch.test.ts`

**Approach (KTD3):** Factory takes the inbound request origin + inbound `Cookie` header (sourced from the Hono context by the caller) and returns `(input, init?) => Promise<Response>`. Resolves `input` (`/operator/session`) to an absolute same-origin URL; sets outgoing `headers.cookie` to the forwarded inbound cookie; uses no service credential. Rejects (throws → mapped to `GatewayNetworkError` by the client's `fetchJson`) when no inbound cookie is present. Keep the existing `validateOperatorPath` guard in the client; this adapter only resolves origin + forwards cookie.

**Execution note:** Test-first.

**Patterns to follow:** `OperatorClientOptions.fetch` signature in `src/gateway/operator-client.ts`; injected-fetch test fakes in `test/operator-client.test.ts`; coarse-logging discipline (never log the cookie value).

**Test scenarios:**
- Happy path: relative `/operator/session` + inbound cookie → outbound request to same-origin absolute URL with the cookie forwarded verbatim.
- Edge: inbound cookie absent → adapter rejects/throws (no request issued).
- Edge: origin derived from inbound request (different origin in → different absolute URL out).
- Error path: no service credential is ever attached (assert outgoing headers contain only the forwarded cookie, not a dashboard credential).

**Verification:** Adapter forwards the end-user cookie, never a service credential, and refuses to issue a request without an inbound cookie; gates green.

- [ ] **Unit 3: Gateway-session middleware strategy branch**

**Goal:** Restructure the auth middleware into an early strategy branch; implement the gateway branch (fail-closed validation via the operator client) while keeping the Arctic branch byte-for-byte.

**Requirements:** R1, R3, R3a, R4, R5, TB1, TB2, TB3

**Dependencies:** Unit 1 (flag), Unit 2 (adapter)

**Files:**
- Modify: `src/server.ts` (`Variables` → add `gatewaySession?: SessionDto`, make `sessionLogin?` optional; the second `app.use('*')` auth middleware; `DashboardAppConfig.operatorClient?: OperatorClient` injection)
- Test: `test/gateway-auth.test.ts` (new)

**Approach:** At the top of the auth middleware, branch on the flag (KTD4). Gateway branch: `isPublicPath` check → require inbound cookie (TB1) → construct/obtain the operator client (built from Unit 2 adapter using the inbound context; injectable via `opts.operatorClient` for tests) → `getCurrentSession()` → deny on `err` (TB3) → deny on non-future `expiresAt` (KTD6) → `c.set('gatewaySession', ...)` → next. No `DASHBOARD_OPERATOR_LOGIN` check anywhere in this branch (R3). Arctic branch: today's logic unchanged (R4). The two branches share no login-equality and no fallback (R5). Set `gatewaySession` only in gateway mode, `sessionLogin` only in Arctic mode (KTD1).

**Execution note:** Test-first; write the failing middleware-integration test before restructuring.

**Patterns to follow:** existing auth middleware in `src/server.ts`; `buildTestApp`/`app.request()` in `test/auth.test.ts`; injection pattern of `oauthClient`/`operatorClient`.

**Test scenarios (middleware-integration level, real protected-route chain):**
- Integration: flag-OFF + valid Arctic session → existing 200 behavior unchanged (R4).
- Integration: flag-ON + valid operator `SessionDto` (future expiry) → allowed.
- Error path: flag-ON + `/operator/session` 404 → denied (TB3).
- Error path: flag-ON + 5xx → denied (TB3).
- Error path: flag-ON + network error/timeout → denied (TB3).
- Edge: flag-ON + 2xx empty/malformed body → denied (TB3 schema-drift).
- Edge: flag-ON + legacy string `expiresAt` / non-integer `operatorId` → denied (TB3).
- Edge: flag-ON + expired (`expiresAt <= now`) → denied (KTD6/TB3).
- Edge: flag-ON + no inbound cookie → denied (TB1).
- Integration: flag-ON + inbound cookie forwarded verbatim on the `/operator/session` call (TB1) — asserted via the injected client/adapter recording the request.
- Integration: flag-ON path never consults `DASHBOARD_OPERATOR_LOGIN` (R3) — set a conflicting `operatorLogin` and confirm it has no effect.
- Integration: no union — flag-ON failure never falls back to Arctic (R5); flag-OFF never calls `/operator/session` (assert zero call attempts).

**Verification:** Both modes work in isolation, never union, fail closed on every TB3 path; flag-OFF parity preserved; gates green.

- [ ] **Unit 4: Flag-aware operator UI copy**

**Goal:** Operator UI copy reflects the active authority — converged "single gateway session" flag-ON, current "separate credential domains" flag-OFF.

**Requirements:** R6

**Dependencies:** Unit 1 (flag)

**Files:**
- Modify: `src/routes/operator.ts` (copy conditioned on the flag)
- Test: `test/operator-ui.test.ts` (extend the existing copy-distinction test to per-mode)

**Approach:** Thread the flag into the operator route's copy selection. Flag-OFF keeps today's wording (accurate while Arctic is live). Flag-ON renders converged wording that does not imply dashboard sign-in authorizes gateway actions. No raw backend tokens in copy (existing invariant).

**Patterns to follow:** existing copy in `src/routes/operator.ts`; the "copy distinguishes dashboard auth from Gateway auth" assertion in `test/operator-ui.test.ts`.

**Test scenarios:**
- Happy path: flag-OFF render contains the current separate-domains wording.
- Happy path: flag-ON render contains the converged single-authority wording.
- Edge: neither render leaks raw backend state tokens / fixture literals.

**Verification:** Copy matches the active mode in both states; no-leak assertions hold; gates green.

- [ ] **Unit 5: Documentation — credential-domain learning (optional, if a non-obvious problem surfaces)**

**Goal:** Capture any non-obvious implementation problem (e.g. inbound-cookie parsing quirk, Hono test-context limitation) as a `docs/solutions/` entry, extending the credential-domain series.

**Requirements:** (project convention)

**Dependencies:** Units 1–4

**Files:**
- Create: `docs/solutions/security-issues/<slug>-2026-06-20.md` (only if warranted)

**Approach:** Follow the existing `docs/solutions/security-issues/` frontmatter + structure. Skip entirely if no non-obvious problem surfaced.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** If a non-obvious problem surfaced, it is documented; otherwise unit is skipped.

## System-Wide Impact

- **Interaction graph:** Only the auth middleware (second `app.use('*')`) changes
  behavior; rate-limit middleware (first) is untouched. The gateway branch adds one
  outbound `/operator/session` call per protected request in flag-ON mode.
- **Error propagation:** Gateway-session validation returns `Result`; the middleware
  treats `err` as deny — never throws past the middleware, never falls back (R5/TB3).
- **State lifecycle risks:** No persisted state added. No caching (KTD2), so no stale
  authorization window.
- **API surface parity:** `Variables.sessionLogin` becomes optional; verified to have
  zero consumers, so no downstream breakage. New `Variables.gatewaySession` is set
  only in gateway mode and consumed by nothing today.
- **Integration coverage:** Unit 3's middleware-integration tests exercise the real
  protected-route chain (not the primitive in isolation), covering both modes and all
  TB3 failure paths.
- **Unchanged invariants:** Read-only GitHub App installation-token path; the
  redaction invariants; the dashboard `session` cookie vs gateway cookie domain
  separation; rate-limiting; deny-by-default posture. Flag-OFF is byte-for-byte today.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| TB2 unverified — gateway `/operator/session` might 200 for a non-allowlisted user, making "presence is authorization" unsound | Pre-flip gate (Open Questions): confirm against the gateway contract before flipping the flag live; KTD6 + TB3 deny-on-anomaly are the structural defenses |
| Confused-deputy: dashboard validates its own credential instead of the end user's | KTD3 forwards the inbound cookie verbatim, uses no service credential, rejects on missing cookie; Unit 2 tests assert this |
| Accidental union/fallback between modes | KTD4 early strategy branch + duplicated public-path check; Unit 3 tests assert no-union and zero `/operator/session` calls in flag-OFF |
| Read surface not live (404 today) | Flag default OFF; build/test against mocked surface; flag flip deferred (N2) |
| Latency of per-request validation | Bounded by Caddy internal-network latency; acceptable for fail-closed correctness; per-request memoization is a later non-posture-changing refinement |

## Documentation / Operational Notes

- The flag flip is an operational step (deferred N2) gated on the live
  `/operator/session` surface and the TB2 confirmation; not part of this PR.
- New env var must be documented for the deploy repo when the cutover is scheduled.

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-20-001-feat-dashboard-auth-convergence-requirements.md
- Related code: `src/server.ts`, `src/gateway/operator-client.ts`, `src/gateway/operator-config.ts`, `src/gateway/operator-contract/`
- Related issues: fro-bot/dashboard#53; tracks fro-bot/agent#907; authority fro-bot/agent#951
- Learnings: `docs/solutions/security-issues/` (the four credential-domain entries)
