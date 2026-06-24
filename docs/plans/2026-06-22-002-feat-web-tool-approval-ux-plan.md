---
title: 'feat: web tool-approval UX against operator contract 1.4.0'
type: feat
status: active
date: 2026-06-22
origin: docs/brainstorms/2026-06-22-001-feat-web-tool-approval-ux-requirements.md
issue: fro-bot/dashboard#81
---

# feat: web tool-approval UX against operator contract 1.4.0

## Overview

Build the dashboard's v1 web tool-approval UX against gateway operator contract 1.4.0.
An operator watching a run can see the tool gate the agent hits and decide
`once` / `always` / `reject` inline. The work splits into a **consumable spine**
(contract + approval SSE frame + dual-parser + reducer with race-correct settlement)
and the **operator UI** (route migration + inline prompt). Behind
`DASHBOARD_OPERATOR_UI_ENABLED` (default unchanged). (see origin)

## Problem Frame

The capability exists gateway-side (contract 1.4.0, PR #986); the dashboard pins 1.3.0,
models no approval frame, and ships a fixture-only disabled approval card. A live 1.4.0
`ready` frame would fail-closed and `event: approval` would be dropped as unknown. The
product decisions (PD1–PD6) and correctness boundary (tombstone/precedence, PD5) are
settled in the origin doc; this plan sequences the implementation. (see origin)

## Requirements Trace

- R1 — Inline pending prompt showing permission + gated action. (origin R1)
- R2 — Authorized operator decides once/always/reject; outcome reflected. (origin R2)
- R3 — `always` requires explicit distinct confirmation. (origin R3)
- R4 — Prompt dismissed on settle frame or terminal status (any settlement cause). (origin R4)
- R5 — Reconnect/late-join recovers missed open prompts. (origin R5)
- R6 — Read-only operator watches but sees a generic can't-approve state on attempt. (origin R6)
- R7 — Prompt content renders injection-safe / no-leak. (origin R7)
- R8 — Behind `DASHBOARD_OPERATOR_UI_ENABLED`, default unchanged. (origin R8)
- R9 — Decision POST is CSRF-protected + replay-safe; no cross-site writable path. (origin R9)
- R10 — Decision-failure classes split: denial vs transport-failure vs already-settled. (origin R10)
- R11 — Prompt visibility and `waiting_for_approval` derive from one reducer state. (origin R11)
- R12 — Lightweight in-page indicator for open prompts on other runs; no desktop/audio. (origin R12)

## Scope Boundaries

- v1 = per-prompt inline decisions in the run stream + the `waiting_for_approval` overlay +
  an in-page open-prompt indicator. Behind the operator-UI flag (default off).

### Deferred to Separate Tasks

- Diff/patch preview for edits (gateway-deferred); approval history/audit; multi-operator
  presence; bulk approve; desktop/audio notifications. (origin "Deferred to Separate Tasks")

## Context & Research

### Relevant Code and Patterns

- `src/gateway/operator-contract/approval.ts` — already vendors `PermissionReply` =
  `'once'|'always'|'reject'` and `OperatorDecisionState` (the 1.4.0 decision verbs/states are
  already present; the gap is wiring, not types).
- `src/gateway/operator-contract/output.ts` + `sse-frames.ts` — the vendored-frame + union
  pattern to mirror for the approval frame (just shipped in #47).
- `src/gateway/operator-sse-reader.ts` `parseSseRecord` / `public/operator-stream.js`
  `parseSseFrame` — the two fail-closed parsers to extend in lockstep; `nextStreamState`
  reducer with per-run `RunEntry` state and the absorbing-drift/output-accumulation pattern.
- `src/gateway/operator-client.ts` — stale approval methods (`listPendingApprovals` →
  `/operator/approvals`, `decideApproval` → `/operator/approvals/:requestId/decision`,
  verbs `approve|reject`) to replace; the launch-surface mutating pattern (CSRF +
  idempotency-key + `redirect:'error'`) to reuse for the decision POST.
- `src/routes/operator.ts` — fixture-only `pendingApprovalSection()`; the run-card
  `data-role` hooks (`run-status`, `run-output`) the inline prompt mirrors.
- `src/gateway/operator-copy.ts` — `approvalStateLabel` map (the decision-state labels exist).

### Institutional Learnings

- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md` — dual-parser
  parity, no-leak inert-text rendering, settle-as-absence discipline, contract-drift fail-closed.
- `docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md` — mutating decision
  POST with CSRF/idempotency, no-oracle failure behavior, browser-direct-not-a-proxy posture.

## Key Technical Decisions

(Product decisions PD1–PD6 are settled in the origin doc and are constraints here. The
plan-level technical decisions:)

- KTD1 — **Vendor + dual-parser parity, mirroring #47.** The approval frame is vendored once
  (`approval-frame.ts`), added to the `RunStreamFrame` union, and parsed in BOTH the server
  reader and the browser parser with identical fail-closed validation. The frame is a
  discriminated union on `settled`; validate `runId`/`requestID` strings always, and
  `permission` (+ optional `command`/`filepath` strings) only on the open variant.
- KTD2 — **Approval state + tombstones live in the reducer's `RunEntry`** (origin PD5). Add an
  open-prompts map keyed by `requestID` and a settled-`requestID` tombstone set per run. The
  reducer enforces: tombstone-on-settle, ignore-open-after-settle, terminal-status-absorbing,
  reconcile-additive-only-vs-tombstones. Visibility + `waiting_for_approval` derive from this
  one state (R11).
- KTD3 — **Decision POST reuses the launch-surface mutating pattern** (CSRF header +
  idempotency-key + `redirect:'error'`), satisfying R9. One CSRF-400 retry reusing the same
  idempotency key (mirrors launch). The response `state` maps to the R10 failure-class split.
- KTD4 — **Reconcile is a one-shot GET on (re)connect**, merged settle-dominant against
  tombstones (origin PD5), never on a timer (respects 30/min).
- KTD5 — **Inline prompt is a static browser-client surface** mirroring the #63/#47 SSR
  `data-role` hook + static module-script pattern; the gated action renders via `textContent`
  only (origin PD3). No new modal pattern; the two-step `always` confirm is inline (origin PD2).

## Open Questions

### Resolved During Planning

- Decision verbs/states already vendored → migration is route/method + verb-union, not new types.
- Where approval state lives → reducer `RunEntry` (KTD2).
- CSRF/idempotency mechanism → reuse launch-surface pattern (KTD3).
- Delivery shape → phased: spine (Phase 1) then UI (Phase 2).

### Deferred to Implementation

- Exact `RunEntry` field names for the open-prompts map + tombstone set, and how they compose
  with the existing output/status fields.
- The exact SSR placement of the approval region relative to `run-status`/`run-output`, and
  multi-prompt stacking order (origin leaves IA specifics to planning→implementation).
- Confirming the real OpenCode always-rule grant scope against the gateway to finalize the PD2
  consequence copy (the requirement is conservative-until-confirmed copy; the exact wording is
  resolved when the grant scope is verified).
- Focus/keyboard/ARIA model for the blocking prompt (the states are enumerated; transitions are
  an implementation detail).

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Approval state machine in the reducer (per run, keyed by `requestID`):

```
            approval(open, requestID=R)         settle(R) | terminal-status
   (absent) ───────────────────────────▶ OPEN(R) ─────────────────────────▶ TOMBSTONED(R)
       ▲                                    │                                     │
       │ reconcile(R) if NOT tombstoned     │ decision POST → state               │ ignore later
       └────────────────────────────────────┘  (already_claimed/unavailable      │ open/reconcile(R)
                                                 shown inline; settle dismisses)   ▼
   open-after-settle(R) ─────────────────────────────────────────────▶ ignored (tombstone wins)
```

Visibility(run) = OPEN prompts not tombstoned; `waiting_for_approval` overlay = (OPEN prompts
exist). Both derive from this state — they cannot desync (R11).

## Implementation Units

### Phase 1 — Consumable spine (PR-A: contract + frame + parsers + reducer)

- [x] **Unit 1: Vendor the 1.4.0 approval frame + bump contract version**

**Goal:** `approval-frame.ts` vendored; `OPERATOR_CONTRACT_VERSION` 1.3.0 → 1.4.0; barrel exports;
`approval` added to the `RunStreamFrame` union.

**Requirements:** R1 (data shape), KTD1

**Dependencies:** None

**Files:**
- Create: `src/gateway/operator-contract/approval-frame.ts`
- Modify: `src/gateway/operator-contract/version.ts`, `index.ts`, `sse-frames.ts`
- Test: `test/operator-contract-conformance.test.ts`

**Approach:** Mirror `output.ts`'s vendored-comment + `export type` style. The frame is a
discriminated union on `settled`: open `{runId, requestID, permission, command?, filepath?,
settled:false}`, settle `{runId, requestID, settled:true}`. Add `{type:'approval'; data:...}`
to `RunStreamFrame`.

**Execution note:** Test-first — flip the conformance version assertion to 1.4.0 and add
assignability checks for both frame variants before vendoring.

**Patterns to follow:** `output.ts` / `sse-frames.ts` vendored shape; the #47 conformance checks.

**Test scenarios:**
- Happy: open + settle frame literals are assignable; `OPERATOR_CONTRACT_VERSION === '1.4.0'`.
- Edge: open frame with neither `command` nor `filepath` is valid; settle frame has only the 3 fields.

**Verification:** Conformance asserts 1.4.0 + both variants; CT green.

- [x] **Unit 2: Parse `event: approval` in both SSE parsers (lockstep, fail-closed)**

**Goal:** Server `parseSseRecord` and browser `parseSseFrame` parse the approval frame with
identical fail-closed validation.

**Requirements:** R1, R7, KTD1

**Dependencies:** Unit 1

**Files:**
- Modify: `src/gateway/operator-sse-reader.ts`, `public/operator-stream.js` (+ `.d.ts`)
- Test: `test/operator-sse-reader.test.ts`, `test/operator-stream-core.test.ts`

**Approach:** Add an `approval` branch before the unknown-event fallthrough in each parser.
Validate `runId`/`requestID` strings always; on `settled:false` require `permission` string and
accept optional `command`/`filepath` strings; reject malformed with a fixed, non-echoing error.
Add `1.4.0` ready-frame fixtures (sweep the 1.3.0 fixtures like #47 did, preserving the
deliberate drift values).

**Execution note:** Test-first — RED each malformed variant in both suites.

**Patterns to follow:** the #47 `output` parse branches + the fixed-error discipline; the
deliberate-drift-fixture preservation from #47's version sweep.

**Test scenarios:**
- Happy: open frame (with command; with filepath; with neither) and settle frame → typed frames, both parsers.
- Error: missing/wrong-typed `runId`/`requestID`/`permission` → fixed parse error, no wire echo.
- Edge: settle frame with extra fields ignored; open frame missing `permission` rejected.
- Integration: open → settle for same `requestID` in one chunk both parse in order.

**Verification:** Both parsers yield typed approval frames; malformed fail closed; parity holds; CT/tests green.

- [x] **Unit 3: Reducer approval state — open map, tombstones, precedence (PD5)**

**Goal:** `nextStreamState` tracks open prompts + settled tombstones per run with the PD5
precedence rules; visibility + `waiting_for_approval` derive from this state.

**Requirements:** R4, R5 (state side), R11, KTD2

**Dependencies:** Unit 2

**Files:**
- Modify: `public/operator-stream.js` (+ `.d.ts`)
- Test: `test/operator-stream-core.test.ts`

**Approach:** Per-run `RunEntry`: an open-prompts map keyed by `requestID` and a settled-id set.
Reducer cases: open frame adds a prompt UNLESS its id is tombstoned (ignore-after-settle); settle
frame removes the prompt and tombstones the id; a settle for an unseen id just tombstones (no UI);
terminal status clears all open prompts for the run and is absorbing (later open/reconcile ignored);
apply only once `connection==='live'` (parity with output/status). Expose a derived
`hasOpenApprovals` for the overlay.

**Execution note:** Test-first — RED the race cases explicitly (these are the adversarial-review findings).

**Patterns to follow:** the #47 output reducer case (null-proto maps, live-gating, absorbing drift).

**Test scenarios:**
- Happy: open(R) → prompt visible; settle(R) → gone + tombstoned.
- Edge (races): open after settle for same id → ignored; settle for never-seen id → no UI, tombstoned;
  terminal status with open prompts → all cleared, later open(R) ignored; duplicate open(R) → idempotent.
- Edge: id reuse — settle(R) then a fresh open(R) → ignored (tombstone wins); documents the safe choice.
- Derivation: `hasOpenApprovals` true iff ≥1 non-tombstoned open prompt; false after all settled.

**Verification:** All PD5 race cases green; visibility derivation correct; CT/tests green.

### Phase 2 — Operator UI (PR-B: client migration + inline prompt)

- [x] **Unit 4: Migrate the operator client to the 1.4.0 per-run approval routes**

**Goal:** Replace stale approval routes/verbs with per-run 1.4.0 routes; decision POST reuses
the mutating pattern and maps the response to the R10 failure classes.

**Requirements:** R2, R5 (fetch side), R9, R10, KTD3, KTD4

**Dependencies:** Unit 1 (types)

**Files:**
- Modify: `src/gateway/operator-client.ts`
- Test: `test/operator-client.test.ts`

**Approach:** Replace `listPendingApprovals` → `GET /operator/runs/:runId/approvals` (returns open
only) and `decideApproval` → `POST /operator/runs/:runId/approvals/:requestId/decision` with body
`{decision: 'once'|'always'|'reject'}`. Reuse the launch CSRF + idempotency-key + `redirect:'error'`
pattern (R9); one CSRF-400 retry reusing the same key. Surface the raw `state` to the caller so the
UI maps denial(404)/transport-failure/already-settled distinctly (R10). Update all call sites + tests
that encode the old `approve|reject` shape.

**Execution note:** Test-first — pin the new routes/verbs and the failure-class distinction; update
the stale-route tests rather than leaving them.

**Patterns to follow:** the launch-surface `launchRun` mutating method (CSRF/idempotency/retry).

**Test scenarios:**
- Happy: `listRunApprovals(runId)` hits the per-run GET; `decideRunApproval` hits the per-run POST
  with `once`/`always`/`reject`; success `state: 'claimed'`.
- Error: blank CSRF / blank idempotency key reject before fetch; uniform 404 surfaced as a
  denial-class signal distinct from a network throw; `already_claimed`/`unavailable` surfaced inline.
- Edge: CSRF-400 retried once with the same idempotency key.

**Verification:** Client uses 1.4.0 routes/verbs; failure classes distinguishable; no stale-route
references remain; tests green.

- [x] **Unit 5: Inline approval prompt UI — render, decide, confirm, dismiss**

**Goal:** Render the open prompt inline in the run card; once/reject single-click,
two-step `always` confirm; safe-DOM gated-action render; the R10 failure states; silent
dismissal; reconcile-on-reconnect; the R12 in-page indicator.

**Requirements:** R1, R2, R3, R5, R6, R7, R10, R12, KTD5

**Dependencies:** Units 3, 4

**Files:**
- Modify: `src/routes/operator.ts` (SSR prompt region + hooks; replace fixture-only section),
  `public/operator-stream.js` (or a sibling static client) for the decide/confirm/render handlers,
  `src/gateway/operator-copy.ts` (prompt + failure-class copy)
- Test: `test/operator-ui.test.ts`, `test/operator-stream-core.test.ts`, `test/operator-copy.test.ts`

**Approach:** SSR a flag-gated approval region in the run card with `data-role` hooks mirroring
run-status/run-output. The browser client renders open prompts (permission label + gated action via
`textContent`, strictly inert per PD3), wires once/reject (single POST) and the two-step `always`
(first click → inline confirm with conservative consequence copy; cancel returns to open; once/reject
suppressed during confirm-pending; second confirm POSTs). Map decision outcomes to the prompt
interaction states (decision-in-flight disables; denial → can't-approve copy; transport-failure →
retry state; already-settled → inline). On (re)connect, one-shot GET reconcile merged settle-dominant
(Unit 3 tombstones). Render the R12 open-prompt indicator from `hasOpenApprovals`. Edit-class prompts
show the partial-inspection caveat.

**Execution note:** Test-first for the no-leak render, the flag-gated presence, the read-only
can't-approve mapping, and the always-confirm gating; the focus/keyboard/ARIA model is implementation.

**Patterns to follow:** #47 run-output SSR hook + static module-script wiring; #67 launch UI submit
handler (in-flight disable, no-oracle failure); the label-map/no-leak rendering discipline.

**Test scenarios:**
- Flag on → approval region present with hooks; flag off → absent and no approval client constructed.
- Safe DOM: a `command`/`filepath` containing HTML/script renders as inert text (no element injection,
  no autolink); no other frame field rendered.
- once/reject → one POST; `always` first click → confirm substate (once/reject suppressed), cancel
  restores, confirm → POST.
- R10: denial(404) → can't-approve copy; transport throw → retry state; `already_claimed`/`unavailable`
  → inline already-settled; a transient failure never reads as a permission denial.
- Dismissal: settle frame / terminal status removes the prompt with no residue.
- R12: indicator reflects `hasOpenApprovals`; clears when all settled.

**Verification:** Operator can decide a prompt end-to-end (flag on); all interaction/failure states
render correctly; no leak; reconcile doesn't resurrect a settled prompt; tests green.

- [x] **Unit 6: Learning doc (optional, post-merge)**

**Goal:** Capture the durable learning (approval-frame consumption + tombstone/precedence race model
+ optimistic-affordance failure-class split) if warranted.

**Dependencies:** Units 1–5

**Files:** Create `docs/solutions/best-practices/<slug>-2026-06-22.md` (or defer to `ce:compound`).

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** Documented if warranted, else deferred to ce:compound after merge.

## System-Wide Impact

- **Interaction graph:** two SSE parsers + the reducer change in lockstep (drift risk → mirrored
  cases + parity tests); the operator client's approval surface is replaced (all `/operator/approvals`
  + `approve|reject` call sites + tests + the copy layer move together).
- **Error propagation:** decision-failure classes split at the client (R10) and surface as distinct
  prompt states; a transport failure must never present as a permission denial.
- **State lifecycle risks:** the PD5 tombstone/precedence rules are the load-bearing correctness layer
  — settle-after-unseen, open-after-settle, id-reuse, reconnect-resurrection, same-tick teardown.
- **API surface parity:** the server reader and browser parser must validate the approval frame
  identically; a divergence is a hostile-stream gap.
- **Integration coverage:** open→decide→settle and open→reconnect→reconcile flows exercised through
  the reducer with the real frame parser (not mocked).
- **Unchanged invariants:** read-only-by-construction for repo data (the decision POST is the
  operator's own forwarded write, not a dashboard-origin mutation — PD6); redaction/denylist;
  flag-gating default-off; no-dashboard-proxy topology; contract-drift fail-closed gate (now at 1.4.0).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Server/browser parser drift on the approval frame | mirrored fail-closed cases + parity tests (Unit 2) |
| Reconnect resurrects a settled prompt | PD5 tombstone + settle-dominant reconcile (Unit 3); explicit race tests |
| Read-only operator misled by failing controls / conflated failures | R10 failure-class split + pre-click copy (Unit 5) |
| Accidental persistent `always` grant | PD2 two-step inline confirm (Unit 5) |
| Injection/leak via free-form command/filepath | PD3 strictly-inert textContent render + no-leak test (Unit 5) |
| `always` copy misstates grant scope | conservative copy until grant scope confirmed against gateway (deferred Q) |
| Stale-route migration blast radius | enumerate + update all call sites/tests/copy in Unit 4 |
| Contract skew (dashboard behind gateway) | bump pin 1.3.0→1.4.0 in both consumers (Unit 1); drift gate fails closed |

## Documentation / Operational Notes

- No production behavior change until `DASHBOARD_OPERATOR_UI_ENABLED` is enabled (separate deploy
  decision). When enabled against a 1.4.0 gateway: an operator can decide tool gates inline.
- Post-deploy signals: a gated run renders an inline prompt; deciding clears it; a read-only operator
  gets the can't-approve state, not a hang; the contract-drift notice appearing means the gateway is
  not on 1.4.0.

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-22-001-feat-web-tool-approval-ux-requirements.md
- Issue: fro-bot/dashboard#81 (+ Fro Bot triage)
- Contract: fro-bot/agent operator-contract 1.4.0 (v0.76.0, gateway PR #986)
- Code: `src/gateway/operator-contract/{approval,output,sse-frames,version,index}.ts`,
  `src/gateway/operator-sse-reader.ts`, `src/gateway/operator-client.ts`,
  `public/operator-stream.js` (+ `.d.ts`), `src/routes/operator.ts`, `src/gateway/operator-copy.ts`
- Learnings: `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`,
  `safe-operator-launch-surface-2026-06-20.md`
