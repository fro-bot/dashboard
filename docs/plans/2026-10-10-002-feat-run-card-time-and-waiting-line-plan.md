---
title: "feat: Run card time, content-only expand, and in-card waiting line"
type: feat
status: completed
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
- R2. While the stream owns a launched card, the time's relative text is recomputed on every paint. The launched card has no timer. Collapsed list cards repaint on the 30-second run-list refresh.
- R3. Fetched cards keep the run list's last-update time (`updatedAt`). When the run list takes over a collapsed launched card, that card shows `updatedAt` too.
- R4. Expanding any card shows only regions with content. The approval badge and the Cancel region are never visible while empty.
- R5. A waiting line inside the card shows only when all of these hold: the stream is live, the run is not terminal, the effective status is not blocked, and nothing is showing (no output, open approval or open question). Checkout detail is context, not output, so it does not hide the line. Its copy is "Waiting to start…" for queued runs and "Waiting for output…" otherwise. Answered-question notes and a stale `waiting_for_*` status do not hide it either.
- R6. A collapsed card receives no stream writes: streams attach only to expanded cards.
- R7. All new text is written as text nodes. The three card builders keep the same anatomy. The relative-time formatter lives in one shared module.

## Scope Boundaries

- Connecting, reconnecting, "not yet observable" (a stream silent for 15 seconds) and failure states keep using the shared stream-status notice outside the card. The card body stays empty in those states.
- No per-minute ticker. A launched card whose stream sends nothing after launch keeps its launch-time text ("just now") until the next paint.
- The time stays unlabeled, as it is on run-list cards today.
- `public/operator-stream.js` still auto-starts `bootstrapOperatorStreams` when it is loaded without `?manual=1`. The PWA always loads it with `?manual=1`.

### Deferred to Separate Tasks

- Markdown output: fro-bot/dashboard#586.

## Context & Research

### Relevant Code and Patterns

- **Card builders** (must stay in anatomy parity):
  - `public/operator-run-index.js` `renderRunCard`. It sets both the `run-updated-at` class and its `data-role`.
  - `ensureRunCardAnatomy` / `insertBeforeFirstRole`, which upgrade an optimistic card in place.
  - The inline optimistic builder in the `launchForm` submit listener of `public/operator-launch.js`.
- **Region list and expand paths:**
  - `SUBSTRUCTURE_ROLES`, and `setSubstructureHidden`, called from `toggleCardExpansion` (`public/operator-run-index.js:1094`), `markCardExpandedForLaunch` (1141) and `expandCardForRestore` (1175).
  - Four triggers reach those three functions: click, launch, restore and jump. `jumpToRun` also calls `markCardExpandedForLaunch` (`web/src/operator/runtime.ts:764-765`).
  - Click and restore reveal before attaching; launch attaches first; a jump expands, then attaches.
  - A click attach now runs after the pre-expand refresh, which waits up to 2 seconds (`runtime.ts:623-637`).
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
  - `_attachStream` passes them on. Its object literal (`runtime.ts:482-497`) is checked against `InitOptions` (`public/operator-stream.d.ts:809-850`) through the `Pick` on the dynamic import (`runtime.ts:447-450`), so `timeEl` goes into `InitOptions` first.
  - `defaultRuntimeLoader` resets, then calls `bootstrapOperatorStreams` on every loader run.
- **Time:** `formatRelativeTime` lives only in the run-index module, and the browser modules have no static imports between them, so the shared module adds the first static import between `public/*.js` modules. The run index caps `updatedAt` at `MAX_DATE_LENGTH`.
- **Serving:**
  - `src/server.ts` serves the three operator modules in an always-on group, with an `isPublicPath` entry each. `test/static-assets.test.ts` pins them as served with the operator UI flag off.
  - `createPublicStatic` (`src/static-files.ts:29-76`, mounted at `src/server.ts:772-773`) already applies `Cache-Control: no-cache` and a content-hash ETag to all of `/static/*`. The new module needs no new middleware.
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
  "freshness": {"vcs_reference": "c13d4efec4f5207be3ccb9fa2d55446750a1c193"},
  "budget": {"max_search_passes": 11, "max_candidate_inspections": 21, "exhausted": false},
  "candidates": [
    {"path_or_symbol": "public/operator-run-index.js:diffRunIndexList", "description": "Closed attribute-mutation set and active-card write protection; updateDOM is the sole writer while attached.", "disposition": "reuse"},
    {"path_or_symbol": "public/operator-run-index.js:updateCardInPlace", "description": "Index-owned run-updated-at writer and optimistic-card adoption for non-active cards. Its terminal-sticky guard (public/operator-run-index.js:805-813) returns before the time block, so adoption must handle the time first.", "disposition": "extend"},
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
    {"path_or_symbol": "web/src/operator/runtime.ts:defaultRuntimeLoader + _attachStream", "description": "Loader bootstrap call and target hand-off; the _attachStream object literal is checked against InitOptions through the dynamic-import Pick.", "disposition": "extend"},
    {"path_or_symbol": "web/src/operator/runtime.ts:onSelectRun / onRestoreRun / onRunLaunched", "description": "Changed since the previous baseline: onSelectRun now waits on the run-list refresh, capped at 2 s, before it attaches (runtime.ts:589-638). Attach/expand ordering is compatible with a reveal owned by updateDOM.", "disposition": "reuse"},
    {"path_or_symbol": "public/operator-run-index.js:refreshOperatorRunIndex", "description": "Single-flight in-place run-list refresh (public/operator-run-index.js:610-640); the pre-expand and jump refreshes adopt a launched card before its stream attaches.", "disposition": "reuse"},
    {"path_or_symbol": "web/src/operator/runtime.ts:jumpToRun", "description": "Fourth expand trigger (runtime.ts:740-780): refreshes, then calls markCardExpandedForLaunch and _attachStream.", "disposition": "reuse"},
    {"path_or_symbol": "web/src/operator/runtime.ts:requestRunJump", "description": "Entry point for a notification jump (runtime.ts:348); hands the run ID to jumpToRun.", "disposition": "reuse"},
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
  - The existing `/static/*` revalidate layer (`createPublicStatic`) already covers it with `no-cache` and a content ETag. Only an `isPublicPath` entry and a `publicStatic.serve` mount are added.
  - All four modules now fail together if it is missing. They deploy as one unit, and the shared module keeps its export names.
- **Streams attach only on expand.** `defaultRuntimeLoader` stops calling `bootstrapOperatorStreams`. It still calls `resetBootstrapState`, which is harmless. Every stream then comes from `_attachStream` on expand or launch and closes on collapse, so a collapsed card receives no writes.
- **Who writes the time.**
  - The launch builder creates the `<time>` with the `run-updated-at` class and `data-role`, seeded from the launch instant.
  - It marks the element with `data-time-source="launch"`. The marker sits on the `<time>` element rather than the card, so the card's run-metadata attributes stay within `diffRunIndexList`'s closed set.
  - `discoverCardStreamTargets` passes a time target only when that marker is present.
  - The stream writes only to that element.
  - When `updateCardInPlace` adopts a detached card, it writes `updatedAt` and removes the marker *before* its terminal-sticky return (`public/operator-run-index.js:813`). Today the time block (832-844) runs after that return. From then on the card is an ordinary list card.
  - If the adopting view has no `updatedAt`, adoption removes the `<time>` and its `data-time-source` marker. `renderRunCard` omits the time in that case (`public/operator-run-index.js:902`), and the test at `test/operator-run-index-core.test.js:3009` pins it.
  - Re-expanding a collapsed launched card shows the list's `updatedAt`. The pre-expand refresh (`web/src/operator/runtime.ts:623`) and the jump refresh (`runtime.ts:744`) adopt the card before attach, so the list time wins.
  - Collapsed list cards repaint their relative time on the 30-second run-list refresh (`runtime.ts:265`, `689-691`). Launched cards still have no timer.
- **Latest valid start time, captured in dispatch.** On each status frame, the stream normalizes `startedAt`. It keeps the latest valid value in its closure and never reads it back from state, because the reducer copies empty strings. Each paint writes `datetime` and the relative text from that value, or else from the launch seed already on the element.
- **`updateDOM` is the only region unhider.**
  - Expand reveals no data region.
  - At attach, `initOperatorStream` clears and hides every stream-owned region: output text and its unavailable state, coalesced hint, badge, waiting line, and the regions it already resets.
  - Just before `connect()` it calls `updateDOM` once, after all closure bindings exist. That paints "Connecting to run stream…" at attach and gives the same result on every expand path.
  - Re-expanding a finished run blanks its body until the replay paints again, or shows "Output no longer available." if the replay has expired. The card shows what the stream reports now, not what was painted before.
- **One content predicate from rendered state.** Computed inside `updateDOM` from the same values that drive the regions: output text or the unavailable state, open approval prompts, open question requests. Checkout detail, answered-question notes and the Cancel control do not count.
- **Status inputs for the waiting line.** The line's status test uses the effective status, so a stale `waiting_for_*` status does not hide it. A placeholder entry (empty status) counts as "status not yet known" and gets "Waiting for output…".
- **Empty-region fixes.**
  - CSS: `[data-role="approval-badge"][hidden]` and `[data-role="run-waiting"][hidden]` both get `display: none`. The badge rule follows the `run-cancel` precedent at `web/src/index.css:1157`; today the badge block at 625-635 has no `[hidden]` override.
  - A terminal run hides the Cancel region unless the control shows visible content: its button or its cancelled message. An emptied control element still mounted in the region does not count.
- **The waiting line is display-only.** It has no `aria-live`, because the status badge and the shared notice already announce. It uses the full-width grid selector list (`web/src/index.css:1341-1345`).
- **Waiting line at ≤480px.**
  - The ≤480px block declares three rows (`index.css:1365`): repo at row 2 (1384), reason at row 3 (1397), checkout at row 4 (1402-1404).
  - The waiting line takes row 5. Output moves from row 5 to row 6 under `.run-card:has([data-role="run-waiting"]:not([hidden]))`, next to the existing checkout rule for output (1406-1408).

## Open Questions

### Resolved During Planning

All of these were decided by the user:
- Fetched cards and adopted launched cards show the run list's time.
- Time refreshes on paint. Launched cards have no timer. Collapsed list cards repaint on the 30-second run-list refresh.
- Re-expanding a collapsed launched card shows the run list's time.
- The waiting line takes grid row 5 at ≤480px, and output moves to row 6 while the line is visible.
- The window between expand and attach, up to 2 seconds, shows only the card header. That is accepted.
- The formatter lives in a shared module.
- The waiting line is driven by open items only, with queued-aware copy.
- No waiting line in the "not yet observable" state.
- The badge and terminal Cancel fixes are in scope.
- The legacy bootstrap is fixed in this plan.

### Deferred to Implementation

None.

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

- [x] **Unit 1: Shared time module**

**Goal:** One relative-time formatter and ISO normalizer, served as reliably as the modules that import it.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Create: `public/operator-time.js`
- Modify:
  - `public/operator-run-index.js` (import and re-export)
  - `src/server.ts` (an `isPublicPath` entry at 577-580, and `app.use('/static/operator-time.js', publicStatic.serve)` after line 781)
- Test: `test/operator-time.test.js`, `test/operator-run-index-core.test.js`, `test/static-assets.test.ts`

**Approach:**
- Move `formatRelativeTime` without changing its output, and add the normalizer.
- Typing: no `.d.ts` export is needed unless a TS consumer appears.
- Serving: the existing `/static/*` revalidate layer covers the new path, so no middleware changes.
- Tests: add the path to `unconditionalModules` (`test/static-assets.test.ts:245-249`) and to both fixture-leak scans (841-847, 866-872).

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

- [x] **Unit 2: Streams attach only on expand**

**Goal:** Collapsed cards never receive stream writes.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `web/src/operator/runtime.ts` (`defaultRuntimeLoader`)
- Test: `web/src/operator/runtime.test.ts`

**Approach:**
- Remove the `bootstrapOperatorStreams` call from the loader (`web/src/operator/runtime.ts:455`), and keep `resetBootstrapState`.
- `web/tsconfig.json:17` sets `noUnusedLocals`, so the removal also deletes `streamOpts` (`runtime.ts:452-454`) and drops `'bootstrapOperatorStreams'` from the `Pick` at `runtime.ts:449`.
- Leave the function and its non-manual auto-start (`public/operator-stream.js:4778-4796`) in place, along with their tests.
- Collapsed-card status is owned by the 30-second run-list refresh (`public/operator-run-index.js:598-622`), so status does not regress.

**Test scenarios:**
- Happy path: running the loader does not call `bootstrapOperatorStreams`. The four inline `bootstrapOperatorStreams: vi.fn()` mocks (`web/src/operator/runtime.test.ts:737`, `802`, `1010`, `2064`) are hoisted into named spies so the test can assert on one.
- Integration: after a remount that leaves cards in the list, no stream starts until a card is expanded.
- Regression: expanding a card still attaches exactly one stream, and collapsing it closes that stream.

**Verification:** on the fixture server, no stream requests go out before a card is expanded.

- [x] **Unit 3: Launch-seeded time and stream time writer**

**Goal:** A launched card shows a time immediately, and the stream keeps it current with the run's start time.

**Requirements:** R1, R2, R3, R7

**Dependencies:** Unit 1

**Files:**
- Modify:
  - `public/operator-launch.js`
  - `public/operator-stream.js`
  - `public/operator-stream.d.ts`
  - `web/src/operator/runtime.ts`
  - `public/operator-run-index.js` (`updateCardInPlace` removes the marker; the `diffRunIndexList` header note, whose closed set of mutations at 669-674 gains `<time>` removal and `data-time-source` removal)
- Test:
  - `web/src/operator/launch-card.test.ts`
  - `test/operator-stream-core.test.ts`
  - `web/src/operator/runtime.test.ts`
  - `test/operator-run-index-core.test.js`

**Approach:**
- Follow the time decisions in Key Technical Decisions. The stream writes after the `aborted` guard (`public/operator-stream.js:3685`), and never writes after `close()`. It captures `startedAt` in `dispatch` (3995).
- Launch builder: the `launchForm` submit listener (`public/operator-launch.js:552-789`, card built at 641-721), not `submitLaunch` (106-160). Insert the `<time>` after `repoSpan` (678) and before `checkoutEl` (684).
- Runtime seam: add `timeEl` to `InitOptions` (`public/operator-stream.d.ts:809-850`) first, then to the `discoverCardStreamTargets` return type (`web/src/operator/runtime.ts:59-68`) and the `_attachStream` literal.

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
- Integration: `diffRunIndexList` leaves an attached launched card's time alone. On the first pass after it detaches, adoption writes `updatedAt`, removes the marker and leaves no duplicate `<time>`. Adoption does this even when the terminal-sticky guard skips the rest of the update.
- Integration: adopting a launch-seeded card whose view has no `updatedAt` removes its `<time>` and the `data-time-source` marker.
- Integration: re-expanding a collapsed launched card whose run the pre-expand refresh lists shows the list's `updatedAt`, and the stream gets no time target.
- Regression: the launch-card slot tests and the index tests at `test/operator-run-index-core.test.js:3009` and `3304` are updated to the new anatomy.

**Verification:** a launched card shows a time from creation through the run's start. Fetched cards are unaffected.

- [x] **Unit 4: Stream-owned reveal and empty-region fixes**

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
- Expand makes no `setSubstructureHidden` reveal call. Remove the reveal at each of the three sites: `public/operator-run-index.js:1094` (`toggleCardExpansion`, which keeps the hide on collapse), `1141` (`markCardExpandedForLaunch`) and `1175` (`expandCardForRestore`). Collapse still hides all regions.
- Attach reset (`public/operator-stream.js:3323-3344`, which clears checkout, questions, approvals and cancel today): also clear `outputEl`, `coalescedEl` and `badgeEl`.
- Early `updateDOM()`: place it at `operator-stream.js:4654`, just before `connect()` at 4655. Its bindings are declared earlier: `state` at 3665, `aborted` at 3676 and `cancelControl` at 3389. The initial state is `'connecting'` (3666), which paints "Connecting to run stream…" (3713).
- Terminal Cancel (`operator-stream.js:3960-3964`): the region is unhidden whenever the run is terminal. Unhide it only when it holds visible content: a `.run-cancel-btn-cancel` button or a non-empty `.run-cancel-status`.
- Badge: add `[data-role="approval-badge"][hidden] { display: none; }` after the block at `web/src/index.css:625-635`, following the precedent at 1157.

**Test scenarios:**
- Happy path: for each expand path (launch, click, restore) on a card that has never attached, no data region is visible before the first frame.
- Happy path: right after attach, the shared notice reads "Connecting to run stream…". Initialization throws no reference error.
- Edge case: re-expanding a card that showed output or "Output no longer available." does not show that text, the coalesced hint or a badge count from before, either before or after the first frame.
- Edge case: re-expanding A after A→B→A starts clean.
- Edge case: a questions region that holds only its announcer stays hidden.
- Error path: a run whose first frame is terminal, with no Cancel control, leaves the Cancel region hidden.
- Error path: a run seen live with a control that then goes terminal and neutral leaves the region hidden. A run cancelled from the card keeps showing its cancelled message.
- Regression: the expand tests that expect regions revealed on expand are updated to the new contract. They are in `test/operator-run-index-core.test.js` at 1728, 1799, 1909, 3461, 3482, 3564 and 3635.
- CSS: the badge `[hidden]` rule is pinned in a test that reads the CSS source.

**Verification:** on the fixture server, every expand path shows only regions with content. The empty badge pill no longer renders on any card.

- [x] **Unit 5: In-card waiting line**

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
  - Adding `run-waiting` to `SUBSTRUCTURE_ROLES` (`public/operator-run-index.js:84-92`) is safe only after Unit 4 stops expand from revealing regions.
  - `insertBeforeFirstRole` (1004-1013) checks roles in list order. Pass a list without `CHECKOUT_DETAIL_ROLE`, for example `['run-output', 'run-output-coalesced', 'run-approvals', QUESTIONS_ROLE, 'approval-badge', 'run-cancel']`, so the line lands before output and after checkout. No change to `insertBeforeFirstRole` itself.
  - In `renderRunCard`, insert it after checkout (921-924) and before output (926). In the launch builder, insert it after `public/operator-launch.js:687`.
- `updateDOM` sets its fixed copy and its visibility from R5.
  - Compute the predicate after the questions block (`public/operator-stream.js:3951`) and before the cancel block (3956).
  - Use `getQuestions()` for open requests, not `presentIds`, which also holds answered-question notes (3930-3940).
  - `close()` hides the line at 4684, next to the cancel hide.
- It is one muted line built from existing tokens, with no border or minimum height.
- CSS (`web/src/index.css`): add `[data-role="run-waiting"]` to the full-width list (1341-1345), add its `[hidden]` rule, and add the ≤480px rows (waiting at row 5, output at row 6 while the line is visible).

**Test scenarios:**
- Happy path: live with only a placeholder entry shows "Waiting for output…".
- Happy path: live and running with nothing showing shows "Waiting for output…".
- Happy path: live and queued shows "Waiting to start…".
- Edge case: after an approval is answered, a stale wire status of `waiting_for_approval` with no open prompt shows the line.
- Edge case: an answered-question note alone does not hide the line.
- Edge case: blocked and every terminal status hide the line. The expired terminal shows "Output no longer available." instead.
- Edge case: connecting, reconnecting, backpressure, `submitted-unobservable`, failed, not-found, drift and closed all hide the line.
- Edge case: output, an open approval or an open question each hide the line. It comes back when the last open item settles and nothing else is showing.
- Edge case: checkout detail does not hide the line. A running run with checkout provenance and no output shows "Waiting for output…", and a queued run with checkout preparation shows "Waiting to start…".
- Edge case: a Cancel control alone does not hide the line.
- Integration: the line is never visible on a collapsed card, and it hides on `close()`.
- Parity: all three builders produce the same role sequence, including `run-waiting`. `ensureRunCardAnatomy` is idempotent. `discoverCardStreamTargets` returns the waiting target. The parity tests are at `test/operator-run-index-core.test.js:3580` and `3720`, and `test/operator-launch-core.test.ts:324`.
- CSS: the parity test covers the `run-waiting` selector and its `[hidden]` rule.
- Safe DOM: the text is set with `textContent` from fixed copy.

**Verification:** on the fixture server, an expanded running card shows the waiting line until its first content. It never shows next to output or an open prompt. It renders full width at desktop and 390px in both themes.

## System-Wide Impact

- **Interaction graph:** run index (builders, expand, diff, adoption) ↔ runtime seam (loader, `discoverCardStreamTargets`, `_attachStream`) ↔ stream (`initOperatorStream`, `updateDOM`, `close`). The server's always-on static group gains one module.
- **State lifecycle risks:** clearing output at attach changes re-expand of a finished run. The body is empty until the replay paints, or shows "Output no longer available." once the replay has expired.
- **API surface parity:** these change together:
  - the three card builders
  - the stream `.d.ts`
  - the runtime's `_attachStream` literal, which is checked against `InitOptions`
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
| For up to 2 seconds between expand and attach (`EXPAND_REFRESH_CAP_MS`, `web/src/operator/runtime.ts:272`), the card shows only its header and no waiting line, because R5 requires a live stream | Accepted. "Connecting to run stream…" appears once the stream attaches. |
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
