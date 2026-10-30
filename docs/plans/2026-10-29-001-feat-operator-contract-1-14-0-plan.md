---
title: "feat: Adopt operator contract 1.14.0 (run wait reason)"
type: feat
status: active
date: 2026-10-29
---

# feat: Adopt operator contract 1.14.0 (run wait reason)

## Overview

Gateway contract 1.14.0 (fro-bot/agent#1954, first released in agent v0.128.0) adds an optional `waitReason` to the SSE run status frame. It says why a draining run has not finished yet. The dashboard pins the contract version by exact match, so the gateway cannot move to 1.14.0 until the dashboard pins it too. This plan pins 1.14.0, parses `waitReason` tolerantly on the server and in the browser, and shows it as a quiet one-line label on the expanded running card.

## Problem Frame

Production runs contract 1.13.0. The SSE `ready` frame carries the contract version, and both the server reader and the browser stream treat any mismatch as drift and stop. A 1.14.0 gateway against this dashboard therefore drops every operator stream, and so does the reverse. The gateway and the dashboard deploy and roll back as a pair (#729, fro-bot/.github#3512).

`waitReason` is a closed enum with four values: `agent-working`, `awaiting-reply`, `awaiting-background-task` and `confirming-completion`. The gateway sends it only on a `running` status, and only while its completion gate is declining a draining run. Approval and question waits replace the status and carry no reason. Terminal statuses never carry one. It is never stored, never appears on `RunSummary`, and never carries raw text. Later minor versions may add values, so an unknown value means "no detail" and the frame is kept.

The gateway caches the overlaid status, wait reason included, and emits a status frame only when the status or reason changes. A reconnect replays the cached status, so the label comes back on reconnect without a fresh change.

## Requirements Trace

- R1. Pin contract 1.14.0 on the server and in the browser, with fixture `ready` frames following the constant.
- R2. Vendor the 1.14.0 wire constants for the wait reason, with a guard that cannot resolve prototype members.
- R3. Both status-frame parsers keep `waitReason` only on a `running` status with a known value. Every other case drops the field and keeps the frame. The two parsers agree on every input.
- R4. `waitReason` lives only on the live run entry. It never reaches run summaries, the safe run view, the finished-run cache, or a recorded re-expand.
- R5. An expanded running card shows a dashboard-owned label for the current reason. Terminal status, an approval or question overlay, a cancel in flight, a preparation headline, a non-live connection, and closing the stream all hide it.
- R8. A list refresh no longer wipes text the stream painted into the card header. This covers the wait label and the checkout preparation headline, which the refresh wipes today.
- R6. Fixture scenarios make each label transition checkable in a browser.
- R7. The paired deploy is a precondition of the release, with no supported skew window.

## Scope Boundaries

- No label on collapsed cards. A collapsed card has no stream, and its header is painted from the run list, which never carries `waitReason`.
- No push notification or notification copy for wait reasons.
- No acceptance tolerance for 1.13.0. The check stays an exact match.
- No hold-down or debounce on reason changes.

### Deferred to Separate Tasks

- Bumping the infra gateway pin from v0.125.3 to v0.128.0 or later, and the paired deploy: Marcus, in marcusrbrown/infra.
- Post-deploy acceptance and evidence on fro-bot/.github#3512: after the paired deploy.
- `src/routes/listener.ts` returns the raw schema-validation message in a 400: a separate PR after this one.

## Context & Research

### Relevant Code and Patterns

- Version pins: `src/gateway/operator-contract/version.ts` and `PINNED_CONTRACT_VERSION` in `public/operator-stream.js`. Tests compare the two constants and hold no literals.
- `providerFailureReason` is the pattern for an optional closed enum: `src/gateway/operator-contract/provider-failure-reason.ts` (Set-backed guard), its parse in `src/gateway/operator-sse-reader.ts`, and the browser Set check in the status branch of `parseSseFrame` in `public/operator-stream.js`.
- Vendoring precedent: `docs/plans/2026-10-18-001-feat-operator-contract-1-12-0-plan.md` Unit 1, and the omissions and import-rewrite lists in `src/gateway/operator-contract/README.md`.
- Live run state: `nextStreamState` in `public/operator-stream.js`. Its status branch spreads the previous entry, and `reasonLabel` (the failure reason) there is deliberately sticky. This plan leaves `reasonLabel` unchanged and adds `waitReason` as a separate field.
- Overlay precedence: `getEffectiveStatus` in `public/operator-stream.js`.
- Header line: `reasonEl` (`data-role="run-reason"`), painted in `updateDOM`, with the stream-ownership flag `paintedPreparationHeadline`. The run list repaints the same element in `updateCardInPlace` in `public/operator-run-index.js`.
- Allowlists that keep stream fields out of storage: `toSafeRunView` and `toFinishedRunRecord` in `public/operator-stream.js`.
- Fixtures: `src/gateway/operator-fixture-sse.ts` (`statusFrame`, scenario tables, `fixtureStreamPaceMs`), and `pacedStream` and `heldOpenStream` in `src/routes/operator-fixture-harness.ts`. Paced and held-open are mutually exclusive today.
- Conformance: the `satisfies Record<…, true>` table for provider failure reasons in `test/operator-contract-conformance.test.ts`.

### Institutional Learnings

- `docs/solutions/best-practices/consume-gateway-operator-contract-1-8-0-2026-10-07.md`: keep the server pin, the browser pin and the fixture `ready` frames in lockstep, and vendor only consumption types.
- `docs/solutions/best-practices/operator-failure-reason-rendering-contract-1-6-0-2026-07-08.md`: drop an unknown optional enum value without rejecting the frame.
- `docs/solutions/best-practices/operator-approval-channel-consumption-2026-06-22.md`: terminal status is absorbing, and approval and question waits have explicit precedence.
- `docs/solutions/best-practices/local-fixture-harness-must-mirror-wire-contract-2026-07-03.md`: build fixture frames in the real wire shape.
- `docs/solutions/workflow-issues/css-selector-emitter-mismatch-2026-07-04.md`: pin that a selector matches what the emitter writes, including non-default states.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`: check the assembled card in a browser.

### External References

- fro-bot/agent#1954: `packages/gateway/src/operator-contract/wait-reason.ts`, `run-status.ts`, `version.ts`, and `web/sse/manager.ts` and `projection.ts` (`overlayWaitReason`).

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "public/operator-stream.js, public/operator-run-index.js, public/operator-launch.js, web/src/operator, web/src/index.css, src/gateway, src/routes/operator-fixture-harness.ts, test/operator-*",
  "freshness": { "vcs_reference": "0c8f3e9" },
  "budget": {
    "max_search_passes": 15,
    "max_candidate_inspections": 25,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "public/operator-stream.js getEffectiveStatus",
      "description": "render-time status that folds open approvals and questions into the wire status; terminal wins; never stored",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "public/operator-stream.js nextStreamState status branch",
      "description": "per-run live state; spreads the previous entry, so a transient detail must be assigned on every frame",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "public/operator-stream.js toSafeRunView / toFinishedRunRecord",
      "description": "explicit allowlists with a terminal-only guard that keep stream fields out of storage",
      "disposition": "reuse"
    },
    {
      "path_or_symbol": "public/operator-stream.js reasonEl paint and paintedPreparationHeadline",
      "description": "header line with a flag for text the stream painted; close() does not clear it",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "public/operator-stream.js waitingEl",
      "description": "expanded-only waiting line",
      "disposition": "insufficient",
      "insufficiency_reason": "hidden once output, an approval or a question exists, and a draining run already has output"
    },
    {
      "path_or_symbol": "public/operator-stream.js STATUS_LABELS",
      "description": "labels keyed on status",
      "disposition": "insufficient",
      "insufficiency_reason": "keys on the status, not on a secondary detail value"
    },
    {
      "path_or_symbol": "src/gateway/operator-contract/provider-failure-reason.ts and both parsers",
      "description": "optional closed enum with a Set-backed guard, dropped when unknown",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "public/operator-run-index.js updateCardInPlace",
      "description": "list-owned repaint of the card header, including reasonEl",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/gateway/operator-fixture-sse.ts and the harness paced/held-open streams",
      "description": "scenario tables, statusFrame and pacing",
      "disposition": "extend"
    }
  ]
}
```

## Key Technical Decisions

- **The label lives in `reasonEl`, on the streamed card only.** It is the header line, and the only slot not hidden once output arrives. Collapsing a card closes its stream, so the label is effectively expanded-only.
- **The reason is assigned on every status frame.** The status branch sets `waitReason` from the frame, or removes it, instead of inheriting it through the entry spread. A `reset` with `no-snapshot` removes it too.
- **One precedence chain in the paint.** A failure or provider reason wins, then the preparation headline, then the wait label. The label is a function of the current state only: it shows when the stored reason is set, the effective status is `running`, the run is not terminal, the connection is live, no preparation is in progress, and no cancel is in flight. Every other paint clears it, including every non-live connection state, not only the failure states the non-live branch clears today.
- **The stream owns the line while it paints.** A `paintedWaitLabel` flag, like `paintedPreparationHeadline`, lets `close()` and attach start clear only what the stream wrote. While the stream has text painted in `reasonEl`, it sets `data-reason-owner="stream"` on it, and `updateCardInPlace` leaves an element with that marker alone. The stream removes the marker when it clears its text and in `close()`. The marker covers the preparation headline too (R8). The gateway does not re-send an unchanged status, so a wiped label would otherwise stay blank.
- **Copy is dashboard-owned and says what the run is doing.** A `Map` from wire value to label: `agent-working` → "Agent still working", `awaiting-reply` → "Finishing its reply", `awaiting-background-task` → "Waiting on a background task", `confirming-completion` → "Confirming it has finished". None of these asks the operator for anything, and none repeats the "Running" badge or the "Waiting for answer" status. The raw value never reaches the DOM, a class or an attribute.
- **The label is silent.** `reasonEl` is not a live region, and the label stays out of every `role="status"` region. The reason is informational and can change every few seconds while a run drains, so announcing it would be noise. A screen reader still reads it with the card header. A paint with unchanged text skips the DOM write.
- **A distinct reason state for styling.** The label sets `data-reason-state="wait"`, not `present`, so the failure-reason selectors that shift the repo row do not restyle it.
- **The vendored file holds wire constants only.** `OPERATOR_WAIT_REASONS`, the type and `isOperatorWaitReason`. `DRAIN_REJECT_CODE_TO_WAIT_REASON` and `toOperatorWaitReason` depend on gateway-only types and are listed as omissions.

## Open Questions

### Resolved During Planning

- Does a reconnect replay the reason? Yes. The gateway caches the overlaid status with its reason and replays it (agent#1954, `web/sse/manager.ts`).
- Collapsed cards: no label (R5, Scope Boundaries).
- Cancel in flight: the label hides.
- Approval or question mid-drain: the gateway turns the wire status into `waiting_for_approval` or `waiting_for_question` with no reason, so the reducer drops the stored reason. When the approval settles, the gateway sends `running` again, with a reason if the run is still draining. The dashboard's own overlay (an open approval on a `running` entry) only hides the label, and the label returns once the overlay closes if the stored reason is still set.
- `/operator/health`: a gateway endpoint, proxied by the dashboard host, that returns `contractVersion` (production returned `{"ok":true,"contractVersion":"1.13.0"}` on 2026-10-23).
- Preparation headline against the label: the preparation headline wins. In practice they don't overlap, because draining happens after execution starts.
- Skew tolerance: none. The check stays an exact match.

### Deferred to Implementation

- Whether the paced-then-held fixture mode is a flag on the scenario spec or a third stream function.

## High-Level Technical Design

> _This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce._

| Wire status                          | `waitReason` on frame         | Effective status                                                                                      | Connection                                 | Label                                                      |
| ------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| `running`                            | known value                   | `running`                                                                                             | live                                       | shown                                                      |
| `running`                            | unknown, empty or non-string  | `running`                                                                                             | live                                       | none (field dropped, frame kept)                           |
| `running`                            | known value                   | `waiting_for_approval` / `waiting_for_question` (dashboard overlay from an open approval or question) | live                                       | none (value kept, hidden; returns when the overlay closes) |
| `running`                            | known value                   | `running`                                                                                             | connecting / reconnecting / failed / drift | none                                                       |
| `running`                            | known value, cancel in flight | `running`                                                                                             | live                                       | none                                                       |
| `waiting_for_*`, `queued`, `blocked` | any                           | any                                                                                                   | any                                        | none (field dropped)                                       |
| terminal                             | any                           | terminal                                                                                              | any                                        | none (field dropped; failure reason may show)              |

## Implementation Units

- [x] **Unit 1: Contract pin, vendored wait reason, server reader**

**Goal:** The server side speaks 1.14.0 and parses `waitReason` tolerantly.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**

- Create: `src/gateway/operator-contract/wait-reason.ts`
- Modify: `src/gateway/operator-contract/version.ts`, `src/gateway/operator-contract/run-status.ts`, `src/gateway/operator-contract/index.ts`, `src/gateway/operator-contract/README.md`, `src/gateway/operator-sse-reader.ts`
- Test: `test/operator-contract-conformance.test.ts`, `test/operator-sse-reader.test.ts`

**Approach:**

- Vendor the four values, the type and a Set-backed guard, mirroring `provider-failure-reason.ts`. Add `waitReason?` to `OperatorRunStatus` with a type-only import, re-export from `index.ts`, and add the omissions and the import rewrite to the README.
- In the reader, keep `waitReason` only when `status` is `running` and the guard accepts it, checking `typeof` before Set membership.
- The run-summary parser builds a closed object and needs no change. A test pins that a `waitReason` key on a row is dropped.

**Execution note:** Test-first. Start with failing parser cases.

**Patterns to follow:** `provider-failure-reason.ts` and its reader parse and conformance table.

**Test scenarios:**

- Happy path: a `running` frame with each of the four values keeps the value.
- Edge case: a `running` frame with `future-reason`, `''`, `Agent-Working`, `__proto__`, `toString`, a number, `null`, an array or an object keeps the frame and drops the field.
- Edge case: `waiting_for_approval`, `waiting_for_question`, `queued`, `blocked` and each terminal status with a valid value keep the frame and drop the field.
- Edge case: a `running` frame with no `waitReason` parses as before.
- Happy path: the conformance table covers every member of `OPERATOR_WAIT_REASONS` (sorted equality, uniqueness), and the guard rejects prototype names.
- Integration: a `/operator/runs` row carrying `waitReason` parses without the key.

**Verification:** The contract version is 1.14.0, the version tests pass unchanged, and every reader case above passes.

- [x] **Unit 2: Browser parser and live run entry**

**Goal:** The browser pins 1.14.0, parses `waitReason` the same way as the server, and holds it only on the live entry.

**Requirements:** R1, R3, R4

**Dependencies:** Unit 1

**Files:**

- Modify: `public/operator-stream.js`, `public/operator-stream.d.ts`
- Test: `test/operator-stream-core.test.ts`, `test/operator-fixture-harness.test.ts`

**Approach:**

- Move `PINNED_CONTRACT_VERSION` to 1.14.0. Add a frozen Set of the four values and keep `waitReason` in the status branch of `parseSseFrame` under the same rule as the server.
- In `nextStreamState`, set or remove `waitReason` on every status frame. Both `reset` `no-snapshot` branches remove it: the non-terminal branch replaces the entry with a copy without the field, and the summary-terminal branch builds its terminal entry without it.
- Leave `toSafeRunView` and `toFinishedRunRecord` unchanged and pin with tests that the key never appears there.

**Execution note:** Test-first.

**Patterns to follow:** the `providerFailureReason` Set check in `parseSseFrame`, and the existing server-versus-browser parser comparison.

**Test scenarios:**

- Happy path: the browser keeps each of the four values on `running`.
- Integration: the server and browser parsers agree on a table of every input from Unit 1 crossed with `running`, `waiting_for_approval`, `waiting_for_question`, `queued`, `blocked` and every terminal status.
- Edge case: a `running` frame with a reason followed by a `running` frame with none leaves no reason on the entry.
- Edge case: a `running` frame with a reason followed by `succeeded` leaves no reason.
- Edge case: a `reset` `no-snapshot` after a reason leaves no reason, in both the non-terminal and the summary-terminal branch.
- Edge case: a `running` frame with a reason followed by `waiting_for_approval` leaves no reason.
- Edge case: a ready frame at 1.13.0 is drift.
- Happy path: `toSafeRunView` and `toFinishedRunRecord` of an entry that had a reason carry no `waitReason`.

**Verification:** The browser pin equals the server constant and the parity table passes.

- [x] **Unit 3: Wait-reason label on the streamed card**

**Goal:** An expanded running card shows the current reason as a quiet header line, under one precedence rule, and nothing else can leave it stale.

**Requirements:** R5, R8

**Dependencies:** Unit 2

**Files:**

- Modify: `public/operator-stream.js`, `public/operator-run-index.js`, `web/src/index.css`
- Test: `web/src/operator/wait-reason-label.test.ts` (new), `test/operator-run-index-core.test.js`, `test/operator-stream-core.test.ts`

**Approach:**

- Add the copy `Map`. In the `reasonEl` paint, put the wait label last in the chain, behind the failure or provider reason and the preparation headline, and gate it on the conditions in Key Technical Decisions.
- Track `paintedWaitLabel`. Clear it in `close()`, at attach start, and in the non-live paint branch for every connection state other than live. Skip the write when the text is unchanged.
- Set `data-reason-owner="stream"` on `reasonEl` while the stream has text painted there, and have `updateCardInPlace` leave an element with that marker alone.
- Style `data-reason-state="wait"` as a quiet line in `web/src/index.css`, and check that the selector matches what the stream emits.

**Execution note:** Test-first for the paint rules. The look is settled in the browser pass.

**Patterns to follow:** `paintedPreparationHeadline`, and the stream-reattach DOM tests in `web/src/operator/`.

**Test scenarios:**

- Happy path: a live `running` frame with `awaiting-background-task` shows "Waiting on a background task" in `reasonEl` with `data-reason-state="wait"`.
- Happy path: each of the four values shows its copy. A later frame with another value replaces the text. A frame with no reason clears it.
- Edge case: an open approval or question on a `running` entry hides the label, and closing it shows the stored reason again.
- Edge case: a `waiting_for_approval` frame clears the label, and the next `running` frame with a reason shows it.
- Edge case: a cancel in flight hides the label.
- Edge case: a preparation headline wins over a reason.
- Edge case: a `failed` frame after a reason leaves only the failure reason.
- Edge case: a `connecting` or `reconnecting` connection clears a painted label, and a replayed `running` frame with a reason shows it again.
- Edge case: `close()` clears the label, and re-expanding shows no label until a frame arrives.
- Integration: a list refresh while the stream owns `reasonEl` leaves the label (and a preparation headline) in place. After `close()`, the refresh repaints the list-owned text.
- Edge case: a recorded re-expand of a finished run and the optimistic launch card before its first frame show no label.
- Happy path: every copy string differs from its wire value, and no wire value appears in the DOM, a class or an attribute.

**Verification:** The label follows the decision table above, and no path leaves it painted on a non-running, closed or collapsed card.

- [x] **Unit 4: Fixture scenarios**

**Goal:** Every label transition can be checked in a browser against the fixture harness.

**Requirements:** R6

**Dependencies:** Unit 2

**Files:**

- Modify: `src/gateway/operator-fixture-sse.ts`, `src/gateway/operator-fixtures.ts`, `src/routes/operator-fixture-harness.ts`, `web/src/views/Operator.tsx`
- Test: `test/operator-fixture-harness.test.ts`, `test/operator-fixture-sanitization.test.ts`, `web/src/views/Operator.test.tsx`

**Approach:**

- Add a `waitReason` option to `statusFrame`, accepting any string so a fixture can send an unknown value.
- `wait_reason_draining`: paced `running` frames with `agent-working`, `awaiting-reply`, `awaiting-background-task`, `confirming-completion`, then no reason, then output and `succeeded`.
- `wait_reason_with_approval`: the wire sequence the gateway sends: `running` with a reason, an open approval, `waiting_for_approval` with no reason, and held open. Settling the approval in the browser sends `running` with a reason again. This needs a paced-then-held mode and a settle hook that emits the follow-up status.
- `wait_reason_unknown`: a held-open `running` frame with an unknown value.
- Register rows, run IDs and the selector entries. Allow `waitReason` in the sanitization key set.

**Patterns to follow:** the `provider_failure_*` scenario family and `markdown_streamed` pacing.

**Test scenarios:**

- Happy path: each scenario's frames parse through the server reader and the browser parser, with the expected `waitReason` kept or dropped.
- Happy path: the draining scenario ends with a terminal frame, and the stream closes normally.
- Happy path: the approval scenario's stream stays open after its paced frames, the harness approvals list returns its approval, and settling it emits `running` with a reason.
- Edge case: the unknown-value scenario's frame is kept with the field dropped.
- Integration: rows for the new scenarios carry no `waitReason`, and the selector lists them in development mode only.

**Verification:** The harness tests list the new scenarios, and each streams the frames above.

- [x] **Unit 5: Docs and browser pass**

**Goal:** The docs describe 1.14.0 as current, and the assembled card is checked in a browser.

**Requirements:** R6, R7

**Dependencies:** Units 3 and 4

**Files:**

- Modify: `docs/solutions/best-practices/consume-gateway-operator-contract-1-8-0-2026-10-07.md`, `docs/solutions/best-practices/operator-approval-channel-consumption-2026-06-22.md`
- Test expectation: none -- docs, plus a manual browser pass

**Approach:**

- State the current pin and the transient, running-only `waitReason` field. Rewrite in place, with no amendment history.
- Browser pass on the fixture harness, in light and dark, at desktop and 390 px. Check the draining sequence, the approval overlay winning, the unknown value showing nothing, collapse and re-expand, and a list refresh leaving the label in place.

**Verification:** Screenshots of each state, and the docs no longer present 1.13.0 as current.

## System-Wide Impact

- **Interaction graph:** `reasonEl` has two writers, the stream (`updateDOM`) and the run list (`updateCardInPlace`). This plan makes their ownership explicit.
- **State lifecycle risks:** the status branch spreads the previous entry. A transient field must be removed explicitly, or it outlives its frame.
- **API surface parity:** the server reader and the browser parser must agree on every input. The parity table pins it.
- **Unchanged invariants:** `RunSummary` parsing, the finished-run cache, the safe run view, the waiting line and the collapsed card header are unchanged. The exact-match contract check is unchanged.

## Risks & Dependencies

| Risk                                                                         | Mitigation                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract skew drops every operator stream                                    | Deploy the gateway and the dashboard in one window, check `/operator/health` and an authenticated `ready` frame at 1.14.0, and roll both back together       |
| A list refresh wipes the stream-painted label                                | `data-reason-owner="stream"` on `reasonEl`, tested through a refresh                                                                                         |
| The label goes stale after collapse, terminal, reset or a dropped connection | `paintedWaitLabel` cleared in `close()`, at attach start and on every non-live paint; fresh assignment per frame; both `no-snapshot` branches drop the field |
| A fixture shape that differs from the wire                                   | Fixture frames come from `statusFrame` with the vendored values                                                                                              |

## Documentation / Operational Notes

- Rollout precondition: merging cuts a dashboard release whose infra deploy waits for approval. Approve it only together with the infra change that moves the gateway pin to v0.128.0 or later, in one window. Merge this PR when that infra change is ready. Afterwards `/operator/health` reports `contractVersion` 1.14.0 and an authenticated `ready` frame matches the dashboard pin.
- Rollback: roll back both. A dashboard on 1.14.0 with a 1.13.0 gateway, or the reverse, leaves the run list and launch working but every stream in drift.
- #729's acceptance checks run after the paired deploy and are posted on fro-bot/.github#3512.

## Sources & References

- Issue: #729
- Upstream: fro-bot/agent#1954
- Related plans: `docs/plans/2026-10-18-001-feat-operator-contract-1-12-0-plan.md`, `docs/plans/2026-10-13-001-feat-operator-contract-1-11-0-plan.md`
- Tracker: fro-bot/.github#3512
