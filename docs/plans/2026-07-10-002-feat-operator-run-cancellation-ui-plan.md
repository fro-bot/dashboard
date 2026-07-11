---
title: "feat: Operator run cancellation UI"
type: feat
status: active
date: 2026-07-10
origin: docs/brainstorms/2026-07-10-operator-run-cancellation-ui-requirements.md
---

# feat: Operator run cancellation UI

## Overview

Add a browser-direct Cancel control to active operator runs that POSTs to the
gateway cancel endpoint, mirroring the existing approval-decision client and its
inline two-step confirm. Vendor the cancel response contract first, resolve the
cancel-vs-stream-terminal race in the run-state reducer, render the control on
both the run-index rows and the expanded stream view, and add a fixture cancel
route so the assembled page can be verified against realistic outcomes.

## Problem Frame

The gateway shipped run cancellation in operator contract 1.6.0, but the dashboard
consumes none of it — an operator whose run goes wrong has no way to stop it from
the dashboard. This is the remaining half of #179 (the sanitized failure-reason
half shipped in #174). The capability is live on the deployed gateway; the gap is
purely the dashboard UI and its supporting client/contract surface.

## Requirements Trace

- R1. Render a Cancel control on non-terminal runs, on both run-index rows and the
  expanded stream view. (origin R1)
- R2. Hide/disable the control once a run is terminal. (origin R2)
- R3. Inline two-step confirmation with a dismiss path. (origin R3)
- R4. Keyboard-operable and announced to assistive tech. (origin R4)
- R5. Reflect the gateway-returned phase without assuming success. (origin R5)
- R6. Already-terminal is a benign result, not an error. (origin R6)
- R7. Transient-retry state, bounded, stops on terminal-from-any-source. (origin R7)
- R8. Not-found: distinguish already-absent from previously-observed-now-unreachable.
  (origin R8)
- R9. Pending state; prevent a second concurrent cancel. (origin R9)
- R10. Live stream terminal wins over an in-flight cancel. (origin R10)
- R11. Direct same-origin browser call; no server-side dashboard proxy. (origin R11)
- R12. CSRF + idempotency posture, idempotency key reused across retry. (origin R12)
- R13. Render outcomes from a fixed allowlisted state set; no raw wire strings in DOM.
  (origin R13)

## Scope Boundaries

- Bulk/multi-run cancellation — single run only.
- No new confirmation-modal system — reuse the inline two-step confirm pattern.
- No pause/resume or other run-lifecycle controls.
- No changes to the shipped failure-reason rendering (#174).

### Deferred to Separate Tasks

- Threading `cancelRun` into the mock server-side `src/gateway/operator-client.ts`:
  the shipping path is browser-direct (mirroring the approval/launch clients), so
  the mock client stays untouched this pass.

## Context & Research

### Relevant Code and Patterns

- `src/gateway/operator-client.ts` — `decideRunApproval` (POST + `x-csrf-token` +
  `idempotency-key` headers, `redirect: 'error'`, one-retry-on-400 with the same
  key, `requireRunId`/`requireCsrf`/`requireIdempotencyKey` guards, `validateDynamicId`
  on `:runId`, `Result<T, GatewayClientError>` with `http`/`network`/`protocol`/
  `validation` classes). Server-side client is mock-only.
- `public/operator-stream.js` — `buildApprovalClient` (browser-direct mutating client),
  `renderApprovalPrompt` (the inline two-step confirm: arm → Confirm/Cancel pair,
  Cancel is the sole dismiss, no Esc/click-outside), `nextStreamState` (pure reducer;
  `status` case already absorbs terminal via prior-entry spread), `TERMINAL_STATUSES`,
  `toSafeRunView` (closed whitelist), `renderedPrompts` (per-card DOM survival).
- `public/operator-run-index.js` — `renderRunCard`/`updateCardInPlace`/`diffRunIndexList`
  (safe-DOM, write-protected active-stream cards), `TERMINAL_RUN_STATUSES`,
  `cardShowsTerminalStatus`, the `[data-role="run-approvals"]` substructure region.
- `src/gateway/operator-contract/{responses,parse,run-status,index}.ts` — vendored
  contract barrel; `OperatorOk`/`OperatorError` present, `OperatorCancelResponse` absent.
- `src/routes/operator-fixture-harness.ts` — POST route preamble (session +
  `x-csrf-token` + `idempotency-key` header checks, `verifyRunOwnership`),
  `resetFixtureHarnessForTesting`. Mounted under `/__fixture/operator` in dev only.

### Institutional Learnings

- `docs/solutions/best-practices/operator-approval-channel-consumption-2026-06-22.md`
  — failure-class split is non-negotiable (404 ≠ transport ≠ already-settled ≠
  session-expired); tombstone terminal IDs; optimistic affordance, honest response.
- `docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md` —
  in-flight mutex in the handler (not just `disabled`); CSRF-400 retry MUST reuse the
  same idempotency key; validate response body before any wire field touches the DOM.
- `docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md`
  — coarse log metadata only (route template + status), never runId/CSRF/idempotency.
- `docs/solutions/best-practices/operator-failure-reason-rendering-contract-1-6-0-2026-07-08.md`
  — render wire values through a dashboard-owned allowlist map, never raw as text,
  `data-*`, or CSS class.
- `docs/solutions/best-practices/local-fixture-harness-must-mirror-wire-contract-2026-07-03.md`
  — derive the fixture from the gateway's actual `c.json(...)`; conformance-pin the
  response envelope, not just the item DTO.
- `docs/solutions/workflow-issues/css-selector-emitter-mismatch-2026-07-04.md` —
  CSS must target the exact class strings the JS emits; pin with a test.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`
  — open the assembled page on a real run before calling it done.

## Key Technical Decisions

- **Browser-direct cancel client, co-located in `public/operator-stream.js`.** The
  shipping mutating clients (approval, launch) are browser-direct; the server-side
  `operator-client.ts` is mock-only. Co-locating with `buildApprovalClient` reuses
  the per-card lifecycle and the two-step-confirm precedent rather than introducing
  a parallel module.
- **Phase→web-status translation is required.** The cancel response `phase` is
  UPPERCASE (`CANCELLED`/`COMPLETED`/`FAILED`); the render layer keys off lowercase
  `OperatorWebStatus` (`cancelled`/`succeeded`/`failed`). Vendor `PHASE_TO_WEB_STATUS`
  (currently omitted locally) so one mapper owns the translation. Never render the raw
  phase.
- **Terminal-wins race lives in the reducer.** `nextStreamState`'s `status` case
  already makes terminal absorbing; add a per-run `cancelInFlight` flag that a terminal
  frame clears. The button's meaningfulness derives from run status, not local optimism.
- **Failure-class split drives distinct UI states** (from the approval precedent):
  cancelled/already-terminal (benign), transient-retry (bounded), not-found
  (stale-vs-unreachable), session-expired (reload, not retry loop), transport (retryable).

## Open Questions

### Resolved During Planning

- Is the cancel response type vendored? No — `responses.ts` has only `OperatorOk`/
  `OperatorError`. Vendor `OperatorCancelResponse` + `parseOperatorCancelResponse` +
  `TerminalPhase` from the canonical upstream shape (`{ok:true, runId, phase}`).
- Client architecture? Browser-direct, co-located in `operator-stream.js` (see KTD).

### Deferred to Implementation

- Exact run-card markup for the control and the armed-confirm state in the safe-DOM
  renderer — settle against the real card structure during Unit 4.
- The precise retry bound (max attempts vs elapsed cap) and delay source, mirrored
  from the gateway's documented `Retry-After` — settle during Unit 3/5.

## Implementation Units

- [ ] **Unit 1: Vendor the cancel response contract**

**Goal:** Add the cancel response type, its parser, `TerminalPhase`, and the
phase→web-status mapper to the vendored contract barrel.

**Requirements:** R5, R6, R13

**Dependencies:** None

**Files:**
- Modify: `src/gateway/operator-contract/responses.ts` (add `OperatorCancelResponse`)
- Modify: `src/gateway/operator-contract/run-status.ts` (add `TerminalPhase`, `PHASE_TO_WEB_STATUS`)
- Modify: `src/gateway/operator-contract/parse.ts` (add `parseOperatorCancelResponse` + `VALID_CANCEL_PHASES`)
- Modify: `src/gateway/operator-contract/index.ts` (re-export the new symbols)
- Test: `test/operator-contract-conformance.test.ts`

**Approach:**
- Mirror the canonical shape verbatim: `OperatorCancelResponse = {readonly ok: true;
  readonly runId: string; readonly phase: TerminalPhase}`; `TerminalPhase = 'COMPLETED'
  | 'FAILED' | 'CANCELLED'` (inline literal — no `@fro-bot/runtime` import).
- `parseOperatorCancelResponse` fails closed on shape/`ok`/phase-not-in-set, returns a
  fixed error string (no echo of input).
- `PHASE_TO_WEB_STATUS`: `{PENDING:'queued', ACKNOWLEDGED:'running', EXECUTING:'running',
  COMPLETED:'succeeded', FAILED:'failed', CANCELLED:'cancelled'}`.
- `OPERATOR_CONTRACT_VERSION` stays `1.6.0` (additive; upstream already at 1.6.0).

**Patterns to follow:** existing `parseOperatorOk`/`parseOperatorError` in `parse.ts`;
the inlined `RunPhase` literal union in `run-status.ts`.

**Test scenarios:**
- Happy path: `parseOperatorCancelResponse` accepts `{ok:true, runId, phase:'CANCELLED'}`
  and each of `COMPLETED`/`FAILED`.
- Edge case: rejects missing `ok`, `ok:false`, non-string `runId`, and phase not in the
  UPPERCASE set (e.g. `EXECUTING`, `cancelled` lowercase).
- Conformance: local `OperatorCancelResponse` matches the upstream vendored shape;
  `PHASE_TO_WEB_STATUS` maps every `TerminalPhase` to a valid `OperatorWebStatus`.

**Verification:** `pnpm check-types` + the conformance suite pass; the new symbols are
re-exported from the contract barrel.

- [ ] **Unit 2: Browser-direct cancel client**

**Goal:** Add a browser-direct `cancelRun` in `public/operator-stream.js` mirroring
the approval client's CSRF + idempotency + retry + no-leak posture.

**Requirements:** R5, R11, R12, R13

**Dependencies:** Unit 1

**Files:**
- Modify: `public/operator-stream.js` (add `buildCancelClient` / `cancelRun`)
- Modify: `public/operator-stream.d.ts` (type surface)
- Test: `test/operator-stream-core.test.ts`

**Execution note:** Implement test-first — the CSRF-400 retry-with-same-key and the
no-leak boundary are exactly the invariants prior operator work regressed on.

**Approach:**
- POST `/operator/runs/${encodeURIComponent(runId)}/cancel`, route template
  `/operator/runs/:runId/cancel`, `redirect: 'error'`, `x-csrf-token` + `idempotency-key`
  headers, no body. One retry only on HTTP 400, reusing the same idempotency key.
- Validate `runId` via the existing dynamic-id validator before fetch; reject-before-fetch
  on blank CSRF/idempotency.
- Return a discriminated result mapping to the failure-class UI states; parse the 200 body
  through `parseOperatorCancelResponse`. Logger receives route template + status only.

**Patterns to follow:** `buildApprovalClient` / `decideRunApproval`; `validateOperatorPath`
+ `validateDynamicId`.

**Test scenarios:**
- Happy path: 200 `{ok, runId, phase}` parses; result carries the translated web status.
- Edge case: blank CSRF and blank idempotency each reject before fetch; invalid `runId`
  rejected.
- Error path: 400 retries once with the SAME idempotency key (assert header identity);
  persistent 400 → session-expired class; 404 → not-found class; 503 → transient class;
  network throw → transport class; malformed 200 body → protocol class.
- Integration: `redirect: 'error'` set; no runId/CSRF/idempotency value reaches the logger.

**Verification:** stream-core suite green; retry/no-leak assertions pass.

- [ ] **Unit 3: Reducer race handling (terminal-wins)**

**Goal:** Track an in-flight cancel per run and make a live-stream terminal frame win
over it, deterministically.

**Requirements:** R7, R9, R10

**Dependencies:** Unit 2

**Files:**
- Modify: `public/operator-stream.js` (`nextStreamState` + a `cancel` action)
- Test: `test/operator-stream-core.test.ts`

**Approach:**
- Add an optional `cancelInFlight` boolean to the run entry, set by a `cancel` action
  when the POST is dispatched and preserved across non-terminal status frames via the
  existing prior-entry spread.
- A terminal status frame (any source) sets `terminal: true` and clears `cancelInFlight`
  — the terminal-wins invariant; a late cancel response never re-opens it.
- Bounded retry: the transient state carries an attempt count; the reducer/handler stops
  retrying once terminal-from-any-source or the bound is hit, falling to an unavailable
  state.

**Patterns to follow:** the `status` case terminal-absorbing spread; `toSafeRunView`
whitelist (do not expose `cancelInFlight` or raw phase in the safe view).

**Test scenarios:**
- Happy path: live entry + cancel action → `cancelInFlight` set; cancel-completion with
  `phase:'CANCELLED'` → `terminal:true`, flag cleared.
- Edge case: `cancelInFlight` entry + later `succeeded`/`cancelled` status frame →
  `terminal:true`, flag cleared (terminal wins); late non-terminal frame preserves the flag.
- Error path: transient-retry reaches the attempt bound → unavailable state, no further retry;
  terminal frame mid-retry stops the loop.

**Verification:** reducer tests green; no terminal-wins race leaves the control re-armed.

- [ ] **Unit 4: Cancel control + two-step confirm UI**

**Goal:** Render the Cancel control with inline two-step confirm on both the run-index
rows and the expanded stream view, keyboard-operable and allowlist-rendered.

**Requirements:** R1, R2, R3, R4, R8, R13

**Dependencies:** Unit 2, Unit 3

**Files:**
- Modify: `public/operator-run-index.js` (control on list rows)
- Modify: `public/operator-stream.js` (control on expanded card; render/dismiss wiring)
- Modify: `web/src/index.css` (control + state styles)
- Test: `test/operator-stream-core.test.ts`, `test/operator-run-index-core.test.js`

**Approach:**
- Mirror `renderApprovalPrompt`'s two-step confirm: first click arms a Confirm/Cancel
  pair in place; Confirm issues the cancel; Cancel is the sole dismiss (no Esc/click-out).
- Gate visibility on non-terminal status via `cardShowsTerminalStatus`/`TERMINAL_STATUSES`;
  in-flight mutex in the handler (`if (canceling) return`), not just `disabled`.
- Render outcomes from a fixed allowlisted state set through the dashboard-owned label
  map; `textContent`/`setAttribute` only. Not-found distinguishes already-absent (row
  stale/removed) from previously-observed-now-unreachable (unavailable state).
- Accessibility: accessible name, focus management on arm/dismiss, status announcement
  for pending/retrying/cancelled/unavailable.
- CSS targets the exact emitted class strings; pin with a selector-emitter test.

**Patterns to follow:** `renderApprovalPrompt` arm/confirm/cancel closures; `renderRunCard`
safe-DOM substructure regions; the failure-reason allowlist-map render.

**Test scenarios:**
- Happy path: click arms confirm; confirm issues cancel; terminal run shows no actionable
  control; dismiss returns to idle.
- Edge case: keyboard operation reaches arm/confirm/dismiss; a11y status announced;
  in-flight mutex blocks a second concurrent cancel.
- Error path: 404 already-absent marks row stale/removed; previously-observed → unavailable;
  transient → retrying; session-expired → reload affordance (no loop).
- Integration: a CSS rule exists for every emitted cancel-state class token.

**Verification:** both core suites green; selector-emitter test passes; no raw wire string
in rendered output.

- [ ] **Unit 5: Fixture cancel route + no-proxy invariant**

**Goal:** Add a fixture cancel route exercising all outcomes (including a forced 503),
and pin the dashboard-does-not-proxy-cancel 404 invariant.

**Requirements:** R7, R8, R11 (verification support for R1–R13)

**Dependencies:** Unit 1

**Files:**
- Modify: `src/routes/operator-fixture-harness.ts` (POST `/runs/:runId/cancel`)
- Modify: `src/gateway/operator-fixture-routes.ts` (mount, if needed)
- Test: `test/operator-fixture-harness.test.ts`, `test/operator-ui.test.ts`

**Approach:**
- `POST /__fixture/operator/runs/:runId/cancel`: session + `x-csrf-token` +
  `idempotency-key` header checks, `verifyRunOwnership`, idempotency replay scoped by
  `(fixtureSessionId, idempotencyKey)`. Returns flat `{ok:true, runId, phase}` (NOT an
  envelope). Phase derived from the indexed run (`succeeded`→`COMPLETED`,
  `failed`→`FAILED`, `cancelled`→`CANCELLED`, else `CANCELLED`).
- 404 on unknown/unauthorized run (same `{error:'not-found'}` envelope as sibling routes);
  a documented sentinel (idempotency key or body flag) forces a 503 `{error:'unavailable'}`
  so the bounded-retry state is exercisable. Add to `resetFixtureHarnessForTesting`.
- Invariant test: `POST /operator/runs/:runId/cancel` against `buildDashboardApp` returns
  404 (dashboard never mounts/proxies it).

**Patterns to follow:** existing fixture POST preamble and `verifyRunOwnership`; the
sibling route envelopes (flat vs `{key:[]}` — cancel is flat).

**Test scenarios:**
- Happy path: valid session+CSRF+idempotency → 200 with the right phase per indexed run;
  replay with same key returns the same body.
- Edge case: missing CSRF/idempotency → 400; unknown/unauthorized run → 404.
- Error path: the 503 sentinel yields `{error:'unavailable'}`.
- Integration: dashboard app returns 404 for the real cancel path (no-proxy invariant).

**Verification:** harness suite green; no-proxy invariant test passes; fixture cancel body
matches the vendored contract shape.

- [ ] **Unit 6: Assembled-page browser verification**

**Goal:** Verify the Cancel control end-to-end on the assembled operator page against
fixture data, not just unit fixtures.

**Requirements:** All (feature-done gate)

**Dependencies:** Unit 4, Unit 5

**Files:**
- None (verification only; no production code change)

**Execution note:** Orchestrator owns the dev server (backgrounded, no `--watch`, loopback);
use `agent-browser`, never install Playwright.

**Approach:**
- Drive `pnpm dev:fixture`: select an active run, arm and confirm cancel, watch the state
  resolve; exercise the already-terminal (benign), transient-503 (bounded retry), and
  not-found outcomes; confirm the terminal-wins race (cancel in flight while a terminal
  stream frame lands) resolves with no re-arm; verify keyboard operation and zero console
  errors; screenshot each outcome.

**Test scenarios:** none — this unit is browser verification of the assembled surface.

**Verification:** each outcome renders the correct allowlisted state; no raw wire string,
runId, or internal detail in the DOM; no console errors; screenshots captured.

## System-Wide Impact

- **Interaction graph:** cancel POST is browser-direct to `/operator/*` (reverse-proxy
  routed); the run-state reducer mediates the cancel-vs-stream-terminal race; the run-index
  diff must not fight the control on active-stream (write-protected) cards.
- **Error propagation:** `Result<T, GatewayClientError>` failure classes map to distinct UI
  states; no class collapses into a retry loop (session-expired) or a false denial (transport).
- **State lifecycle risks:** `cancelInFlight` must clear on terminal-from-any-source;
  in-flight state must not survive navigation between runs (active-stream singleton).
- **API surface parity:** the no-dashboard-proxy 404 invariant matches the other operator
  routes; the fixture cancel envelope must mirror the gateway's flat `{ok,runId,phase}`.
- **Unchanged invariants:** failure-reason rendering (#174), approval/launch clients, and
  the contract version (1.6.0) are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Phase capitalization mismatch (UPPERCASE wire vs lowercase render) renders nothing | Vendor `PHASE_TO_WEB_STATUS`; one mapper owns translation; never render raw phase |
| Already-terminal cancel misimplemented as an error (409) | Contract returns 200; reducer treats `COMPLETED`/`FAILED` phase as benign success |
| CSRF-400 retry mints a fresh idempotency key → silent double-cancel | Reuse the same key on retry; pin header identity in a test |
| Cancel state placed in DOM code instead of the pure reducer | `cancelInFlight` lives on the run entry in `nextStreamState`; DOM only reads it |
| CSS targets classes the JS never emits → unstyled states | Selector-emitter parity test over the emitted cancel-state tokens |

## Sources & References

- **Origin document:** `docs/brainstorms/2026-07-10-operator-run-cancellation-ui-requirements.md`
- Canonical contract: `.slim/clonedeps/repos/fro-bot__agent/packages/gateway/src/operator-contract/responses.ts` (`OperatorCancelResponse`), `parse.ts`, `run-status.ts` (`PHASE_TO_WEB_STATUS`)
- Related issue: #179
