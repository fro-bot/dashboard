---
title: "feat: Run card time, content-only expand, and in-card waiting line"
type: feat
status: active
date: 2026-10-10
---

# feat: Run card time, content-only expand, and in-card waiting line

## Overview

Launched run cards show a time from the moment they appear, and switch to the run's start time once the stream reports it. Expanding any card shows only regions that have content. A short line inside the card says the run is waiting while the stream is live and nothing is showing. Streams attach only to expanded cards. Fixes fro-bot/dashboard#585.

## Problem Frame

A launched card has no `<time>`. The optimistic card in `public/operator-launch.js` never creates one. The run index's only time writer, `updateCardInPlace`, skips active cards. `updateDOM` in `public/operator-stream.js` is the active card's only writer, and it never writes time.

Expanding a card can leave empty boxes, with no sign inside the card that it is waiting. Two causes:
- `setSubstructureHidden(card, false)` unhides every substructure region on all three expand paths: launch, click and hash restore.
- Nothing re-hides those regions until `updateDOM` first runs, and nothing calls it at attach.

Two more regions are visible while empty:
- The approval badge's CSS overrides `[hidden]`.
- When a run finishes, the Cancel region is unhidden even if it holds no control.

Separately, `defaultRuntimeLoader` calls `bootstrapOperatorStreams` on every load. That attaches a stream to every card already in the list. Those streams keep writing into cards after they are collapsed, so "collapsed cards stay hidden" does not hold today. The issue's triage comment maps the first set of causes.

## Requirements Trace

- R1. A launched card shows a time from creation (the launch time). It switches to the run's start time once the stream sends a valid one, and it never goes blank.
- R2. While the stream owns a launched card, the time's relative text is recomputed on every paint. No timers.
- R3. Fetched cards keep the run list's last-update time (`updatedAt`). When the run list takes over a collapsed launched card, that card shows `updatedAt` too.
- R4. Expanding any card shows only regions with content. The approval badge and the Cancel region are never visible while empty.
- R5. A waiting line inside the card shows only when all of these hold: the stream is live, the run is not terminal, the effective status is not blocked, and nothing is showing (no output, open approval, open question or checkout detail). Its copy is "Waiting to start…" for queued runs and "Waiting for output…" otherwise. Answered-question notes and a stale `waiting_for_*` status do not hide it.
- R6. A collapsed card receives no stream writes: streams attach only to expanded cards.
- R7. All new text is written as text nodes. The three card builders keep the same anatomy. The relative-time formatter lives in one shared module.

## Scope Boundaries

- Connecting, reconnecting, "not yet observable" (a stream silent for 15 seconds) and failure states keep using the shared stream-status notice outside the card. The card body stays empty in those states.
- No per-minute ticker. A launched card whose stream sends nothing after launch keeps its launch-time text ("just now") until the next paint.
- The time stays unlabeled, as it is on run-list cards today.
- `public/operator-stream.js` still auto-starts `bootstrapOperatorStreams` when it is loaded without `?manual=1`. The PWA always loads it with `?manual=1`.

### Deferred to Separate Tasks

- Waiting state on collapsed run-list cards: blocked on fro-bot/agent#1780.
- Markdown output: fro-bot/dashboard#586.

## Context & Research

### Relevant Code and Patterns

- **Card builders** (must stay in anatomy parity):
  - `public/operator-run-index.js` `renderRunCard`. It sets both the `run-updated-at` class and its `data-role`.
  - `ensureRunCardAnatomy` / `insertBeforeFirstRole`, which upgrade an optimistic card in place.
  - The inline optimistic builder in the submit handler of `public/operator-launch.js`.
- **Region list and expand paths:** `SUBSTRUCTURE_ROLES`, and `setSubstructureHidden` with its callers `toggleCardExpansion`, `markCardExpandedForLaunch` and `expandCardForRestore`. Click and restore reveal before attaching; launch attaches first.
- **Active-card ownership:** `diffRunIndexList` write-protects the active, stream-attached card. Its header defines a closed set of attribute mutations. `updateCardInPlace` adopts an optimistic card on the first pass after it detaches.
- **Stream, `initOperatorStream`:**
  - The attach-time reset clears checkout, questions, approvals and cancel.
  - `updateDOM` is the only region writer, a hoisted function that reads the late `let state` and `cancelControl`.
  - `close()` sets `aborted`, which fences `updateDOM`. It then hides the Cancel region by hand.
  - `connect()` runs at the end.
- **Run entries and frames:**
  - The status reducer copies `startedAt` on every live status frame, empty strings included. The parser only `typeof`-checks it.
  - Placeholder run entries have an empty status.
  - After 15 seconds with no frame, the connection moves to `submitted-unobservable`.
  - The shared notice text is "Connecting to run stream…".
- **Runtime seam, `web/src/operator/runtime.ts`:**
  - `discoverCardStreamTargets` collects the card's stream targets.
  - `_attachStream` passes them on; its inline option type mirrors `InitOptions` in `public/operator-stream.d.ts`.
  - `defaultRuntimeLoader` resets, then calls `bootstrapOperatorStreams` on every loader run.
- **Time:** `formatRelativeTime` lives only in the run-index module, and the browser modules have no static imports between them. The run index caps `updatedAt` at `MAX_DATE_LENGTH`.
- **Serving:**
  - `src/server.ts` serves the three operator modules in an always-on group, with an `isPublicPath` entry each. `test/static-assets.test.ts` pins them as served with the operator UI flag off.
  - The service worker has no `/static/*` route, and the Dockerfile copies `public/` whole.
- **CSS, `web/src/index.css`:**
  - Full-width regions use the `grid-column: 1 / -1` selector list; the ≤480px block assigns rows.
  - `.run-updated-at` handles placement and typography.
  - The approval badge sets `display: inline-block` with no `[hidden]` override.

### Institutional Learnings

- `docs/solutions/workflow-issues/css-selector-emitter-mismatch-2026-07-04.md`: every emitted class and `data-role` needs a selector, plus a parity test covering the hidden state.
- `docs/solutions/best-practices/consume-gateway-operator-contract-1-8-0-2026-10-07.md`:
  - Every card shape carries the same regions through the runtime seam.
  - Render from painted state.
  - Use text nodes only.
- `docs/solutions/logic-errors/state-machines-without-a-do-nothing-branch-2026-09-21.md`: unknown is not terminal. An expired terminal run shows "Output no longer available."
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`: handlers that rebuild an entry keep its other fields.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` and `docs/solutions/best-practices/operator-local-fixture-harness-2026-06-30.md`: verify on the fixture server. jsdom has no CSS.
- `docs/solutions/ui-bugs/nested-control-click-bubbles-to-run-card-2026-10-10.md`: the new elements are display-only and need no propagation guard.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "public/operator-run-index.js, public/operator-stream.js, public/operator-launch.js (+ .d.ts), web/src/operator/runtime.ts, web/src/index.css, src/server.ts static serving; run-card anatomy and stream attach only",
  "freshness": {"vcs_reference": "5535b0dbe6f9f152740468ddc56c50b41d78666a"},
  "budget": {"max_search_passes": 11, "max_candidate_inspections": 21, "exhausted": false},
  "candidates": [
    {"path_or_symbol": "public/operator-run-index.js:diffRunIndexList", "description": "Closed attribute-mutation set and active-card write protection; updateDOM is the sole writer while attached.", "disposition": "reuse"},
    {"path_or_symbol": "public/operator-run-index.js:updateCardInPlace", "description": "Index-owned run-updated-at writer and optimistic-card adoption for non-active cards.", "disposition": "extend"},
    {"path_or_symbol": "public/operator-run-index.js:renderRunCard", "description": "Full card anatomy builder; gains the waiting role.", "disposition": "extend"},
    {"path_or_symbol": "public/operator-run-index.js:ensureRunCardAnatomy + insertBeforeFirstRole", "description": "In-place optimistic-card upgrade; must create the waiting role idempotently.", "disposition": "extend"},
    {"path_or_symbol": "public/operator-run-index.js:setSubstructureHidden", "description": "Blanket unhide of every substructure region on expand.", "disposition": "insufficient", "insufficiency_reason": "The blanket reveal is the defect; it cannot express content-aware reveal."},
    {"path_or_symbol": "public/operator-run-index.js:markCardExpandedForLaunch / toggleCardExpansion / expandCardForRestore", "description": "Three expand entry points converging on one reveal call.", "disposition": "extend"},
    {"path_or_symbol": "public/operator-run-index.js:SUBSTRUCTURE_ROLES", "description": "Ordered region list driving hide/show, slot insertion and parity tests.", "disposition": "extend"},
    {"path_or_symbol": "public/operator-launch.js:submit handler optimistic card build", "description": "Inline duplicate of the card anatomy; needs the time seed and waiting role.", "disposition": "extend"},
    {"path_or_symbol": "public/operator-launch.js:buildPendingCardHooks", "description": "Selector-only descriptor.", "disposition": "insufficient", "insufficiency_reason": "Carries no time or region targets."},
    {"path_or_symbol": "public/operator-stream.js:updateDOM", "description": "Sole region writer for the attached card; extended with the time write and waiting visibility.", "disposition": "extend"},
    {"path_or_symbol": "public/operator-stream.js:initOperatorStream attach-time reset", "description": "Clears checkout, questions, approvals, cancel but not output, coalesced or badge.", "disposition": "insufficient", "insufficiency_reason": "Stale output and badge from a previous attachment survive re-expand."},
    {"path_or_symbol": "public/operator-stream.js:close", "description": "Fences updateDOM and hides cancel by hand; new stream-owned elements need the same.", "disposition": "extend"},
    {"path_or_symbol": "public/operator-stream.js:nextStreamState status case + parseSseFrame", "description": "Copies startedAt on every live status frame; parser only typeof-checks it.", "disposition": "extend"},
    {"path_or_symbol": "public/operator-stream.js:bootstrapOperatorStreams", "description": "Attaches a stream to every pre-rendered card; called by the runtime seam on every load.", "disposition": "insufficient", "insufficiency_reason": "Its handles write into collapsed cards; the seam must stop calling it."},
    {"path_or_symbol": "public/operator-run-index.js:formatRelativeTime", "description": "Pure relative-time formatter in a module with no static imports; moves to a shared module the stream and launch modules can import.", "disposition": "extend"},
    {"path_or_symbol": "web/src/operator/runtime.ts:discoverCardStreamTargets", "description": "Card target discovery; gains time and waiting targets.", "disposition": "extend"},
    {"path_or_symbol": "web/src/operator/runtime.ts:defaultRuntimeLoader + _attachStream", "description": "Loader bootstrap call and target hand-off; inline option type mirrors the .d.ts.", "disposition": "extend"},
    {"path_or_symbol": "web/src/operator/runtime.ts:onSelectRun / onRestoreRun / onRunLaunched", "description": "Attach/expand ordering; compatible with a reveal owned by updateDOM.", "disposition": "reuse"},
    {"path_or_symbol": "web/src/index.css run-card rules", "description": "Grid placement, region borders and :empty precedents; needs the waiting style, hidden rules and placement.", "disposition": "extend"},
    {"path_or_symbol": "CSS :empty collapse for empty regions", "description": "Content-only hiding.", "disposition": "insufficient", "insufficiency_reason": "Cannot express the live/non-terminal predicate or hide the questions region that keeps its announcer."},
    {"path_or_symbol": "test/operator-run-index-core.test.js fake-DOM harness", "description": "Node fake DOM for card tests.", "disposition": "reuse"}
  ]
}
```

## Key Technical Decisions

- **Shared time module, always served.**
  - `formatRelativeTime` moves to a new `public/operator-time.js`, together with a normalizer that returns a canonical ISO string or nothing. The normalizer trims, caps at 128 characters and requires a finite `Date.parse`.
  - The run-index, launch and stream modules import it with a relative path. The run-index module re-exports `formatRelativeTime` for existing imports.
  - `src/server.ts` serves the new module in the same always-on group as the other three, so it loads even with the operator UI flag off.
  - All four modules now fail together if it is missing. They deploy as one unit, and the shared module keeps its export names.
- **Streams attach only on expand.** `defaultRuntimeLoader` stops calling `bootstrapOperatorStreams`. It still calls `resetBootstrapState`, which is harmless. Every stream then comes from `_attachStream` on expand or launch and closes on collapse, so a collapsed card receives no writes.
- **Who writes the time.**
  - The launch builder creates the `<time>` with the `run-updated-at` class and `data-role`, seeded from the launch instant.
  - It marks the element with `data-time-source="launch"`. The marker sits on the `<time>` element rather than the card, so the card's run-metadata attributes stay within `diffRunIndexList`'s closed set.
  - `discoverCardStreamTargets` passes a time target only when that marker is present.
  - The stream writes only to that element.
  - When `updateCardInPlace` adopts a detached card, it writes `updatedAt` and removes the marker. From then on the card is an ordinary list card.
- **Latest valid start time, captured in dispatch.** On each status frame, the stream normalizes `startedAt`. It keeps the latest valid value in its closure and never reads it back from state, because the reducer copies empty strings. Each paint writes `datetime` and the relative text from that value, or else from the launch seed already on the element.
- **`updateDOM` is the only region unhider.**
  - Expand reveals no data region.
  - At attach, `initOperatorStream` clears and hides every stream-owned region: output text and its unavailable state, coalesced hint, badge, waiting line, and the regions it already resets.
  - Just before `connect()` it calls `updateDOM` once, after all closure bindings exist. That paints "Connecting to run stream…" at attach and gives the same result on every expand path.
  - Re-expanding a finished run blanks its body until the replay paints again, or shows "Output no longer available." if the replay has expired. The card shows what the stream reports now, not what was painted before.
- **One content predicate from rendered state.** Computed inside `updateDOM` from the same values that drive the regions: output text or the unavailable state, open approval prompts, open question requests, checkout detail. Answered-question notes and the Cancel control do not count.
- **Status inputs for the waiting line.** The line's status test uses the effective status, so a stale `waiting_for_*` status does not hide it. A placeholder entry (empty status) counts as "status not yet known" and gets "Waiting for output…".
- **Empty-region fixes.**
  - CSS: `[data-role="approval-badge"][hidden]` and `[data-role="run-waiting"][hidden]` both get `display: none`.
  - A terminal run hides the Cancel region unless the control shows visible content: its button or its cancelled message. An emptied control element still mounted in the region does not count.
- **The waiting line is display-only.** It has no `aria-live`, because the status badge and the shared notice already announce. It uses the full-width grid selector list and gets an explicit row in the ≤480px block.

## Open Questions

### Resolved During Planning

All of these were decided by the user:
- Fetched cards and adopted launched cards show the run list's time.
- Time refreshes on paint, with no timer.
- The formatter lives in a shared module.
- The waiting line is driven by open items only, with queued-aware copy.
- No waiting line in the "not yet observable" state.
- The badge and terminal Cancel fixes are in scope.
- The legacy bootstrap is fixed in this plan.

### Deferred to Implementation

- The exact grid row for the waiting line at ≤480px. Settle it against the real layout.
- Whether `insertBeforeFirstRole` needs changes to place the waiting role.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
    participant U as Operator
    participant L as Launch / Index
    participant R as Runtime seam
    participant S as Stream (updateDOM)
    U->>L: launch or expand card
    L->>L: build card (launch: seed <time data-time-source=launch>)
    L->>R: select / launch run
    R->>S: initOperatorStream(targets; time only if launch-seeded)
    S->>S: clear + hide stream-owned regions; updateDOM() before connect (notice: Connecting to run stream…)
    L->>L: expand reveals header only
    S-->>S: frames → capture valid startedAt; updateDOM shows regions with content, waiting line per predicate, time
    U->>L: collapse
    L->>S: close() → hide waiting line + cancel, fence updates
    L->>L: later index pass adopts detached launched card → updatedAt, marker removed
```

## Implementation Units

- [ ] **Unit 1: Shared time module**

**Goal:** One relative-time formatter and ISO normalizer, served as reliably as the modules that import it.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Create: `public/operator-time.js`, `public/operator-time.d.ts`
- Modify: `public/operator-run-index.js` (import and re-export), `src/server.ts` (always-on static mount and `isPublicPath`)
- Test: `test/operator-time.test.ts`, `test/operator-run-index-core.test.js`, `test/static-assets.test.ts`

**Approach:** move `formatRelativeTime` without changing its output, and add the normalizer.

**Patterns to follow:** the existing operator `.d.ts` sidecars, and the `src/server.ts` entries for `operator-run-index.js`.

**Test scenarios:**
- Happy path: the formatter returns the same strings as before at the 59s/60s, 59m/60m and 23h/24h boundaries, plurals included.
- Edge case: a future timestamp clamps as it did before.
- Normalizer:
  - a valid ISO string returns its canonical form;
  - `''`, garbage and a 129-character string each return nothing.
- Integration: `/static/operator-time.js` returns 200 with the operator UI flag both on and off, without a session, like the other operator modules. All four modules resolve with the flag off.
- Regression: `run-updated-at` text in the run index is unchanged.

**Verification:** the run index output is unchanged, and the new module is served wherever its importers are.

- [ ] **Unit 2: Streams attach only on expand**

**Goal:** Collapsed cards never receive stream writes.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `web/src/operator/runtime.ts` (`defaultRuntimeLoader`)
- Test: `web/src/operator/runtime.test.ts`

**Approach:**
- Remove the `bootstrapOperatorStreams` call from the loader, and keep `resetBootstrapState`.
- Leave the function and its non-manual auto-start in place, along with their tests.

**Test scenarios:**
- Happy path: running the loader does not call `bootstrapOperatorStreams`.
- Integration: after a remount that leaves cards in the list, no stream starts until a card is expanded.
- Regression: expanding a card still attaches exactly one stream, and collapsing it closes that stream.

**Verification:** on the fixture server, no stream requests go out before a card is expanded.

- [ ] **Unit 3: Launch-seeded time and stream time writer**

**Goal:** A launched card shows a time immediately, and the stream keeps it current with the run's start time.

**Requirements:** R1, R2, R3, R7

**Dependencies:** Unit 1

**Files:**
- Modify:
  - `public/operator-launch.js`
  - `public/operator-stream.js`
  - `public/operator-stream.d.ts`
  - `web/src/operator/runtime.ts`
  - `public/operator-run-index.js` (`updateCardInPlace` removes the marker; `diffRunIndexList` header note)
- Test:
  - `web/src/operator/launch-card.test.ts`
  - `test/operator-stream-core.test.ts`
  - `web/src/operator/runtime.test.ts`
  - `test/operator-run-index-core.test.js`

**Approach:** follow the time decisions in Key Technical Decisions. The stream writes after the `aborted` guard, and never writes after `close()`.

**Execution note:** test-first for the validity and no-regression rules.

**Test scenarios:**
- Happy path: the launched card has exactly one `<time class="run-updated-at" data-role="run-updated-at" data-time-source="launch">`. Its `datetime` is a valid ISO string, its text is "just now", and it sits between the repo and the first region.
- Happy path: the first valid `startedAt` replaces the launch time, in both `datetime` and text.
- Edge case: a `startedAt` of `''`, garbage or 129 characters writes nothing, and the previous value stays.
- Edge case: a later frame with `''` after a valid value keeps the valid value.
- Edge case: placeholder entries never write.
- Edge case: a stream that goes reconnecting, failed or closed keeps the last time. Nothing is written after `close()`.
- Integration: a fetched card that is expanded and streamed keeps its list time. The stream gets no time target.
- Integration: after A→B, B's frames never touch A's time.
- Integration: `diffRunIndexList` leaves an attached launched card's time alone. On the first pass after it detaches, adoption writes `updatedAt`, removes the marker and leaves no duplicate `<time>`.
- Integration: collapse then re-expand before adoption keeps the stream writing the time. Re-expand after adoption gives the stream no time target.
- Regression: the launch-card slot tests and the index test "no `run-updated-at` after adoption" are updated to the new anatomy.

**Verification:** a launched card shows a time from creation through the run's start. Fetched cards are unaffected.

- [ ] **Unit 4: Stream-owned reveal and empty-region fixes**

**Goal:** Expanding any card never shows an empty or stale region.

**Requirements:** R4

**Dependencies:** Units 2 and 3 (shares `initOperatorStream` and `updateDOM` with Unit 3)

**Files:**
- Modify:
  - `public/operator-run-index.js` (expand reveal)
  - `public/operator-stream.js` (attach reset, `updateDOM` before `connect()`, terminal Cancel)
  - `web/src/index.css` (badge `[hidden]`)
- Test:
  - `test/operator-run-index-core.test.js`
  - `test/operator-stream-core.test.ts`
  - `web/src/operator/stream-reattach.test.ts`
  - `web/src/operator/runtime.test.ts`

**Approach:**
- Expand reveals no data region. Collapse still hides all regions.
- The attach reset and the one-time `updateDOM` follow Key Technical Decisions.

**Test scenarios:**
- Happy path: for each expand path (launch, click, restore) on a card that has never attached, no data region is visible before the first frame.
- Happy path: right after attach, the shared notice reads "Connecting to run stream…". Initialization throws no reference error.
- Edge case: re-expanding a card that showed output or "Output no longer available." does not show that text, the coalesced hint or a badge count from before, either before or after the first frame.
- Edge case: re-expanding A after A→B→A starts clean.
- Edge case: a questions region that holds only its announcer stays hidden.
- Error path: a run whose first frame is terminal, with no Cancel control, leaves the Cancel region hidden.
- Error path: a run seen live with a control that then goes terminal and neutral leaves the region hidden. A run cancelled from the card keeps showing its cancelled message.
- Regression: the expand tests that expect regions revealed on expand are updated to the new contract.
- CSS: the badge `[hidden]` rule is pinned in a test that reads the CSS source.

**Verification:** on the fixture server, every expand path shows only regions with content. The empty badge pill no longer renders on any card.

- [ ] **Unit 5: In-card waiting line**

**Goal:** The card says the run is waiting, without repeating the status.

**Requirements:** R5, R7

**Dependencies:** Unit 4

**Files:**
- Modify:
  - `public/operator-run-index.js` (`SUBSTRUCTURE_ROLES`, `renderRunCard`, `ensureRunCardAnatomy`)
  - `public/operator-launch.js`
  - `public/operator-stream.js` (predicate in `updateDOM`; hide in `close()`)
  - `public/operator-stream.d.ts`
  - `web/src/operator/runtime.ts`
  - `web/src/index.css` (style, `[hidden]`, full-width list, ≤480px row)
- Test:
  - `test/operator-stream-core.test.ts`
  - `test/operator-run-index-core.test.js` (including the CSS parity test)
  - `test/operator-launch-core.test.ts`
  - `web/src/operator/launch-card.test.ts`
  - `web/src/operator/runtime.test.ts`

**Approach:**
- Add a `run-waiting` role between checkout and output in all three builders. `ensureRunCardAnatomy` creates it once.
- `updateDOM` sets its fixed copy and its visibility from R5.
- It is one muted line built from existing tokens, with no border or minimum height.

**Test scenarios:**
- Happy path: live with only a placeholder entry shows "Waiting for output…".
- Happy path: live and running with nothing showing shows "Waiting for output…".
- Happy path: live and queued shows "Waiting to start…".
- Edge case: after an approval is answered, a stale wire status of `waiting_for_approval` with no open prompt shows the line.
- Edge case: an answered-question note alone does not hide the line.
- Edge case: blocked and every terminal status hide the line. The expired terminal shows "Output no longer available." instead.
- Edge case: connecting, reconnecting, backpressure, `submitted-unobservable`, failed, not-found, drift and closed all hide the line.
- Edge case: output, an open approval, an open question or checkout detail each hide the line. It comes back when the last open item settles and nothing else is showing.
- Edge case: a Cancel control alone does not hide the line.
- Integration: the line is never visible on a collapsed card, and it hides on `close()`.
- Parity: all three builders produce the same role sequence, including `run-waiting`. `ensureRunCardAnatomy` is idempotent. `discoverCardStreamTargets` returns the waiting target.
- CSS: the parity test covers the `run-waiting` selector and its `[hidden]` rule.
- Safe DOM: the text is set with `textContent` from fixed copy.

**Verification:** on the fixture server, an expanded running card shows the waiting line until its first content. It never shows next to output or an open prompt. It renders full width at desktop and 390px in both themes.

## System-Wide Impact

- **Interaction graph:** run index (builders, expand, diff, adoption) ↔ runtime seam (loader, `discoverCardStreamTargets`, `_attachStream`) ↔ stream (`initOperatorStream`, `updateDOM`, `close`). The server's always-on static group gains one module.
- **State lifecycle risks:** clearing output at attach changes re-expand of a finished run. The body is empty until the replay paints, or shows "Output no longer available." once the replay has expired.
- **API surface parity:** these change together:
  - the three card builders
  - the stream `.d.ts`
  - the runtime's inline option type
  - `diffRunIndexList`'s header note
- **Integration coverage:** reveal order across the three expand paths, badge visibility, grid layout and the absence of stream requests before expand all need the fixture server in a browser.
- **Unchanged invariants:**
  - `diffRunIndexList` never writes the attached card.
  - The run list owns fetched cards' time.
  - No new GitHub calls, write paths or timers.
  - The shared notice owns connecting, "not yet observable" and failure copy.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A missing or broken `operator-time.js` stops the run index, launch and stream modules from loading together | Serve it in the always-on group, test that all four resolve with the flag off, and ship it in the same image as `public/`. The service worker does not cache `/static/*`. |
| Removing the loader's bootstrap call drops something a fixture or test relied on | Unit 2's regression tests. The function and its own tests stay. |
| Clock skew makes the time jump from the launch time to the start time | Accepted. The formatter clamps future times. |
| A quiet launched card keeps saying "just now" | Accepted under refresh-on-paint. |
| The waiting line flickers between `ready` and the first status, or on reconnect | Accepted. The browser check watches for layout shift. |
| Existing tests pin reveal-all on expand and the launch-card slots | Units 3–5 list them, and they are updated to the new contract. |

## Documentation / Operational Notes

- After this lands, update the card-anatomy and expand wording in `docs/solutions/best-practices/consume-gateway-operator-contract-1-8-0-2026-10-07.md` and `operator-sse-output-consumption-2026-06-22.md`, where they describe it.
- Browser verification uses the fixture bundle (`pnpm build:web:fixture`), served in the background without `--watch`, at desktop and 390px in both themes.

## Sources & References

- fro-bot/dashboard#585 and its triage comment
- Related:
  - fro-bot/dashboard#570 (optimistic card anatomy)
  - #584 and #600 (re-attach cleanup)
  - #599 (question region)
  - #602 (approval precedence)
  - #604 (question-only fixture)
  - fro-bot/agent#1780
