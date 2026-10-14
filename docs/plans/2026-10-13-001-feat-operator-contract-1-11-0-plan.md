---
title: "feat: Adopt gateway operator contract 1.11.0"
type: feat
status: active
date: 2026-10-13
---

# feat: Adopt gateway operator contract 1.11.0

## Overview

Move the dashboard from operator contract 1.9.0 to 1.11.0, including the 1.10.0 additions:
- Waiting runs stay in the run list with a styled badge.
- The list refreshes itself every 30 seconds while the window is visible, right away when the window comes back, before a card expands, and when a notification jumps to a run.
- Tapping a question notification opens or focuses the dashboard on the run that asked, without reloading an open window.

## Problem Frame

Gateway `v0.122.1` serves contract 1.11.0 (fro-bot/agent#1825). Production runs 1.9.0, with the gateway pinned at `v0.119.2`. Both sides check the exact version, so the dashboard and gateway must ship together (fro-bot/.github#3512).

Without this work, a 1.11.0 gateway breaks the dashboard in two ways:
- Every operator stream goes into drift.
- `GET /operator/runs` now returns `waiting_for_approval` and `waiting_for_question` summaries. Every summary parser drops them, so runs waiting on the operator disappear from the list.

1.11.0 also adds a deep link to question pushes. The payload carries `route: '/operator#<runId>'` and `runId`, and the dashboard ignores both: `notificationclick` always opens or focuses `/`.

Two existing gaps make the new behavior hard to use:
- The run list is fetched once per mount, so a collapsed waiting badge goes stale.
- A run started from another surface is not in the list until a reload.

1.10.0 adds an optional push-health field to `GET /operator/session` and exposes the push trigger kinds. The dashboard only needs to parse these.

Out of scope: displaying push health, durable terminal replay (fro-bot/agent#1639), and the #585 card time and waiting line. The #585 plan rebases onto this work.

## Requirements Trace

- R1. Server, browser and fixtures pin exactly 1.11.0. A `ready` frame for 1.9.0 or 1.10.0 drifts.
- R2. The session parser copies a closed DTO. It keeps a valid `push: {status}` and drops a malformed one without rejecting the session. Nothing renders it.
- R3. The vendored contract exports the push trigger kinds. The privacy page names every kind as a notification event, and states that a question notification carries the ID of the run that asked. Tests pin both sentences against the vendored kinds.
- R4. Every run-summary parser accepts `waiting_for_approval` and `waiting_for_question`. Collapsed cards show the labels "Waiting for approval" and "Waiting for answer" (the stream's existing wording) and the hyphenated status classes the CSS already styles. A card showing a terminal status never moves back to a non-terminal one. A run ID never returns to a non-terminal status once terminal: upstream mints a fresh ID per launch and never re-queues one.
- R5. The run list refreshes in place:
  - every 30 seconds while the window is visible, paused while hidden;
  - immediately when the window becomes visible again;
  - before a card expands, so the stream starts from the current summary;
  - when a notification jumps to a run.

  A refresh never writes to the stream-attached card, keeps keyboard focus on the card that had it, and updates the empty and unavailable states. A 429 skips that cycle and leaves the list as it was.
- R6. The client-side waiting derivation stays as a fallback, aligned with the gateway: terminal wins, approval beats question, and the overlay applies only on a `running` base.
- R7. A question notification click builds its target only from a `runId` matching `^[A-Za-z0-9_-]{1,128}$`. Any other type, or a question without a valid `runId`, opens or focuses `/`.
- R8. With a dashboard window already open, the click focuses that window and jumps to the run without a reload. The run's card expands (it never toggles closed), its stream attaches, and the URL hash updates. With no window open, the click opens `/#<runId>` and the existing mount-time restore handles it.
- R9. For an in-page jump, if the run is missing after the jump's refresh, a dedicated notice says "That run isn't in your recent runs." The current hash and expansion stay as they are, and the notice clears on the next jump, expand or refresh that finds the run. The run ID is never echoed. A cold start keeps today's restore-miss behavior.
- R10. Fixtures include waiting summaries mapped to matching scenarios. A browser check on the fixture server covers waiting badges, refresh, and both jump paths.

## Scope Boundaries

- No version check on `/operator/runs` or `/operator/session`. The exact pin stays on the stream.
- Signed out: the notification link may not survive the OAuth redirect. After sign-in the operator lands on `/`. This is accepted, recorded in the deploy handoff and the live acceptance notes, and not fixed.
- No `hashchange` listener. `_writeRunHash` pushes history entries, so a hash listener would fire on the page's own writes, and Back would start changing which card is expanded. The SW message is the only in-page jump entry point.
- No `WindowClient.navigate()` and no manifest `launch_handler`. Both cause a full navigation, which reloads the page.
- The 30-second refresh stays well inside the gateway's operator-keyed limit on `GET /operator/runs` (20 per minute).

### Deferred to Separate Tasks

- #585 card time, content-only expand and in-card waiting line: rebase that plan onto this branch and drop its deferred run-list waiting item.
- Push-health display in the notifications settings: separate issue if wanted.
- A build-keyed query on `/static/operator-*.js` imports, if the cache check in Unit 1 shows these unhashed modules can be served stale.

## Context & Research

### Relevant Code and Patterns

- **Contract pins:**
  - `src/gateway/operator-contract/version.ts` `OPERATOR_CONTRACT_VERSION`.
  - `public/operator-stream.js` `PINNED_CONTRACT_VERSION` (ready-frame compare).
  - Parity tests: `test/operator-contract-conformance.test.ts` (static no-version-literal scan over the vendored directory) and `test/static-assets.test.ts`.
  - Fixture `ready` frames in `src/gateway/operator-fixture-sse.ts`, built from the constant.
- **Vendored files that change:**
  - `src/gateway/operator-contract/responses.ts`: push health and trigger kinds.
  - `parse.ts`: `parseOperatorSessionInfo` currently returns the raw input.
  - `run-summary.ts`: 5 statuses today, upstream has 7.
  - `index.ts`.
  - `README.md`: rewrite rules, and the omissions list, which gains `toRunSummary`.
  - `run-status.ts` already has all eight web statuses.
- **Summary status allowlists:**
  - `public/operator-run-index.js` `VALID_RUN_SUMMARY_STATUSES` and `STATUS_LABELS` (the label falls back to the raw string).
  - `public/operator-stream.js` `SUMMARY_STATUSES` and its labels.
  - `web/src/operator/runtime.ts` `SUMMARY_STATUSES`, `isRunSummaryStatus` and `discoverCardSummaryStatus` (reads the card's class token).
  - The `.d.ts` sidecars.
- **Status class emission:** the index writes `status-${status}` with underscores. The stream writes hyphens. `web/src/index.css` already has hyphenated rules for both waiting statuses in both themes.
- **Run list lifecycle:**
  - `initOperatorRunIndex` is the only caller of `fetchRunIndex`, called once from `runtime.ts`.
  - `diffRunIndexList` keeps fetch order and skips the stream-attached card.
  - `updateCardInPlace` adopts detached cards.
  - `expandCardForRestore` (not exported) and `markCardExpandedForLaunch` (exported) are the non-toggling expands.
  - The restore guard `userSelectedDuringFetch` silently skips the restore when another run is attached.
- **Effective status:** `public/operator-stream.js` `getEffectiveStatus`. The approval overlay currently also applies to a `waiting_for_question` base.
- **Service worker:**
  - `web/src/sw.ts` `notificationclick` picks the focused or visible client, then `focus()`; otherwise `openWindow('/')`. `SWWindowClient` declares `postMessage`.
  - `web/src/push/sw-notification.ts` `buildNotification` reads the nested `data` object (#615).
  - `web/src/sw.test.ts` has a source-text guard that forbids reading `notification.data`.
- **Page-side SW messages:** the only page listener is in `web/src/views/Notifications.tsx` (view-scoped, `PUSH_SUBSCRIPTION_CHANGE`). `App` keeps `Operator` mounted but hidden while the listener view is active.
- **Hash restore:**
  - `runtime.ts` reads the hash once at mount.
  - `sanitizeRunIdFromHash` applies a 512-character cap, then `validateDynamicId`.
  - `_writeRunHash` and `_clearRunHash` maintain the hash.
  - `onRestoreMiss` clears the hash and shows a notice.
- **Privacy:**
  - `web/privacy.html` lists the three notification events (#615).
  - `web/src/privacy/content.test.ts` has the "UNGUARDED, deliberately" comment, waiting for this exposure.
  - `web/src/push/push-types.test.ts` has the parity pattern between the web copy and the server contract.
- **Fixtures:**
  - `src/routes/operator-fixture-harness.ts` derives summary rows from the scenarios and maps them to streams by status.
  - The question scenarios in `src/gateway/operator-fixture-sse.ts` have `summaryStatus` `running` or `succeeded`.
  - PR #604 adds a scenario to the same files.

### Institutional Learnings

- `docs/solutions/best-practices/operator-failure-reason-rendering-contract-1-6-0-2026-07-08.md` and `docs/solutions/best-practices/consume-gateway-operator-contract-1-8-0-2026-10-07.md`:
  - Move every pin together.
  - Vendor a consumption-only copy.
  - Rebuild closed objects.
  - Soft optional fields drop, they never reject.
  - Labels come from allowlists.
  - Fixtures use actual upstream wire shapes.
- `docs/solutions/best-practices/operator-approval-channel-consumption-2026-06-22.md`: derive the waiting status at render, never store it. Terminal wins, then approval, then question.
- `docs/solutions/workflow-issues/css-selector-emitter-mismatch-2026-07-04.md`: the emitter hyphenates status classes. A parity test must cover every emitted token.
- `docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md`: validate dynamic IDs before building any path. Never navigate to request-derived URLs.
- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md`: keep the SW deny-by-default. Don't broaden routing.
- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md` and `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`: unit tests cannot prove the click flow. Verify in a real browser on the fixture bundle.
- `docs/solutions/logic-errors/state-machines-without-a-do-nothing-branch-2026-09-21.md`: unknown push health is not a negative state. Parsing it has no side effects.
- `docs/solutions/security-issues/privacy-policy-understated-run-linkage-2026-09-21.md`: a deep-linked notification is run-linked. Privacy wording must not claim otherwise.

### External References

- MDN `WindowClient.focus()`, `Clients.openWindow()` and `Client.postMessage()`. Focus or open must happen inside the `notificationclick` `waitUntil` chain.
- RFC 9110 §10.2.2: a redirect without a fragment inherits the original fragment. Opening `/#<runId>` directly avoids depending on the `/operator` 302.
- WebKit bugs 259212 and 268797: lifecycle and timing quirks in installed iOS PWAs. The cold-start and focused-window paths need a device check.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "web/src (sw.ts, push/, operator/, views/), public/operator-run-index.js, public/operator-stream.js, src/gateway/operator-contract/",
  "freshness": {"vcs_reference": "cf4c9a7c6068d33ffe838d39693aaa67ebcaa257"},
  "budget": {"max_search_passes": 6, "max_candidate_inspections": 14, "exhausted": false},
  "candidates": [
    {"path_or_symbol": "web/src/sw.ts:notificationclick", "description": "Notification click handler: focus the focused-or-visible client, else openWindow('/'); never reads notification.data.", "disposition": "extend"},
    {"path_or_symbol": "web/src/sw.ts:SWWindowClient", "description": "Inline WindowClient type exposing focused, visibilityState, focus(), postMessage().", "disposition": "reuse"},
    {"path_or_symbol": "web/src/push/sw-notification.ts:buildNotification", "description": "Reads type and failureLabel from the payload's nested data object and maps them to fixed copy; output data typed {type, route:'/'}.", "disposition": "extend"},
    {"path_or_symbol": "web/src/views/Notifications.tsx:handleMessage", "description": "Page-side navigator.serviceWorker message listener with effect cleanup; precedent for an SW-to-page message.", "disposition": "reuse"},
    {"path_or_symbol": "public/operator-run-index.js:expandCardForRestore", "description": "Non-toggling idempotent expand by runId; not exported; no scroll or focus.", "disposition": "extend"},
    {"path_or_symbol": "public/operator-run-index.js:markCardExpandedForLaunch", "description": "Exported non-toggling expand with single-open bookkeeping.", "disposition": "reuse"},
    {"path_or_symbol": "public/operator-run-index.js:initOperatorRunIndex (restore block)", "description": "Mount-only, fetch-gated hash restore.", "disposition": "insufficient", "insufficiency_reason": "Runs once per mount, bumps the init generation, flips the list to loading, and silently skips when another run is attached."},
    {"path_or_symbol": "public/operator-run-index.js:diffRunIndexList + updateCardInPlace", "description": "Keyed diff that skips the stream-attached card and adopts detached cards.", "disposition": "extend"},
    {"path_or_symbol": "web/src/operator/runtime.ts:sanitizeRunIdFromHash", "description": "Page-side runId sanitizer: 512-char cap then validateDynamicId.", "disposition": "reuse"},
    {"path_or_symbol": "web/src/operator/runtime.ts:_writeRunHash / _clearRunHash / onSelectRun", "description": "Hash maintenance and the single active stream handle.", "disposition": "reuse"},
    {"path_or_symbol": "public/operator-run-index.js:toggleCardExpansion", "description": "Click toggle; re-selecting an expanded card collapses it.", "disposition": "insufficient", "insufficiency_reason": "Toggle semantics would collapse an already-expanded target on a jump."},
    {"path_or_symbol": "src/server.ts:app.get('/operator') redirect", "description": "Server 302 from /operator to /.", "disposition": "insufficient", "insufficiency_reason": "Serves only fresh navigations and relies on redirect fragment inheritance; cannot reach an open window."},
    {"path_or_symbol": "WindowClient.navigate()", "description": "Platform navigation API, unused in the dashboard SW.", "disposition": "insufficient", "insufficiency_reason": "A full navigation reloads the document, violating the no-reload requirement."}
  ]
}
```

## Key Technical Decisions

- **One atomic contract commit.** Pins, vendored files, every summary allowlist and the label tables change together. Changing an allowlist without its label table would render the raw `waiting_for_question` string.
- **Deploy ordering.** The branch can merge before infra moves, because infra deploys only after approval. The dashboard deploy must not run until the gateway pin is at `v0.122.1` or later, in the same window. Against a 1.9.0 gateway, every stream drifts.
- **Closed session DTO.** `parseOperatorSessionInfo` copies the required fields. It keeps `push` only when `status` is in the vendored vocabulary, and omits it otherwise. No push state is derived from it.
- **Trigger-kind parity in root tests.** `web/src` must not import `src/`; `web/src/operator/no-server-imports.test.ts` enforces this, and the Docker builder copies only `web/`. The parity tests therefore live in root `test/`, which already imports both trees. They compare:
  - the vendored `OPERATOR_PUSH_TRIGGER_KINDS`;
  - a runtime `PUSH_NOTIFICATION_TYPES` tuple exported from `web/src/push/sw-notification.ts`;
  - the event and payload sentences read from `web/privacy.html`.

  The "UNGUARDED" comment in `web/src/privacy/content.test.ts` is removed.
- **One status-token map.** A single two-way mapping between summary status and class token (hyphenated) is used by the index emitter and `discoverCardSummaryStatus`. It accepts only hyphenated tokens.
- **Terminal is sticky on collapsed cards.** `updateCardInPlace` never replaces a terminal status with a non-terminal one. This holds because a run ID never returns to a non-terminal status (R4).
- **Single-flight refresh.** The run index exports a refresh that:
  - fetches, then diffs without the loading toggle;
  - never touches the stream-attached card;
  - updates the empty and unavailable states from the result, mirroring `initOperatorRunIndex`;
  - restores focus to the card that had it, without scrolling;
  - routes a 401 to the existing auth-required path and treats a 429 or network failure as "keep the current list".

  A request that arrives while a refresh is in flight joins it, and one more refresh runs after it completes, so responses can't arrive out of order. It never reuses `initOperatorRunIndex`.
- **Refresh triggers.** The runtime runs the refresh:
  - on a 30-second interval while `document.visibilityState` is `visible`, cleared while hidden and on cleanup;
  - immediately on becoming visible;
  - before an expand;
  - on a jump.

  A hash restore does not refresh first: it relies on init's own fetch, which ran moments before.

  Expand waits for the refresh, then reads the card's summary status from the refreshed card. If the refresh fails, it expands with the status already on the card.
- **Fallback alignment.** `getEffectiveStatus` applies the open-approval overlay only on a `running` base, so it matches the gateway. The existing test "wire waiting_for_question with an open approval is waiting_for_approval" (`test/operator-stream-core.test.ts`) flips on purpose to `waiting_for_question`. The existing demotion of a stale wire `waiting_for_question` with no open questions stays, and is pinned by a test.
- **Notification data carries a validated runId.** `SafeNotification.data` becomes a discriminated shape, read from the payload's nested `data` object. A `question` keeps `runId` only when it matches `^[A-Za-z0-9_-]{1,128}$` and the wire `route` equals exactly `/operator#<runId>`, the tracker's allowed shape. Everything else carries no `runId`. Gateway run IDs are UUIDs, so they match.
- **SW click logic in a pure module.** `notificationclick` is top-level code next to the Workbox precache, so tests cannot import it. A pure resolver beside `sw-notification.ts` takes the window clients and the notification data, and returns either "focus and post to this client" or "open this URL". `sw.ts` only wires it. The resolver:
  - considers only window clients whose URL path is `/`, the app shell; others, such as `/privacy`, don't count;
  - for a question with a valid `runId`, considers only windows the worker controls, because an uncontrolled page drops the message;
  - picks the focused app window, then a visible one, then any;
  - catches a `focus()` failure and still posts `{type: 'OPEN_RUN', runId}` to that one client;
  - with no suitable app window, opens `/#<runId>`.

  Other notification types focus any app window, or open `/`.
- **Jump intent through a runtime-module slot.** `App` registers the `navigator.serviceWorker` message listener once at mount. It requires `event.source` to be the worker that controls the page (`navigator.serviceWorker.controller`), compared by identity, and `event.data` to be exactly `{type: 'OPEN_RUN', runId}` with a valid `runId`. It then switches to the operator view and calls `requestRunJump(runId)`, exported from `web/src/operator/runtime.ts`.
  - The runtime module holds one pending ID; last wins.
  - `defaultRuntimeLoader` consumes the ID once `initOperatorRunIndex` returns loaded.
  - Any other result (unavailable, auth, stale) drops it, as does runtime cleanup.
  - It also drops an ID equal to the mount-time restore target, so there is only one attach.
- **Jump semantics.** The jump lives inside `defaultRuntimeLoader` next to `onRunLaunched`. It runs the refresh first, then:
  - Card collapsed: `markCardExpandedForLaunch`, `_attachStream`, `_writeRunHash`, then scroll the card into view and focus it.
  - Card expanded with a live or terminal stream: scroll and focus only.
  - Card expanded with a closed, failed or unavailable stream: `_attachStream` directly (it closes the prior handle). It never goes through `onSelectRun`, which would collapse the card.
  - Card missing: show the R9 notice through a miss handler that leaves the hash and expansion alone.

  The existing operator live region announces "Opened run" with the card's status label, never the ID. A jump that lands while another card holds a question draft switches runs anyway, and the page store keeps the draft.
- **No logging of run IDs.** The SW resolver, the App listener, the refresh and the jump add no `console.*` calls. Tests assert this.

## Open Questions

### Resolved During Planning

- Refresh policy: every 30 seconds while visible, on becoming visible, before expand, and on jump (user decision).
- Push health: parse only (user decision).
- Open-window behavior: focus and jump without reload (user decision).
- Client fallback: keep it, aligned to the gateway (user decision).
- Jump during a draft: jump anyway (user decision).
- Run not found: dedicated notice with fixed copy; the hash and expansion stay as they are.
- Dead stream on an expanded target: re-attach.
- URL source: the validated `runId` only, with the tracker's exact route shape required.
- Version check on REST routes: out of scope.
- Run ID checks: the SW and the jump use the strict pattern. Hash restore keeps `validateDynamicId`.

### Deferred to Implementation

- Whether `/static/operator-*.js` responses carry cache headers that let a new shell pair with an old module. Report the result. A fix is deferred (see Scope Boundaries).
- Whether the README provenance for `sse-frames.ts` (upstream path no longer exists) needs a correction, found while vendoring.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
    participant G as Gateway push
    participant SW as Service worker
    participant P as Page (App listener)
    participant R as Operator runtime
    participant I as Run index
    G->>SW: {data:{type:'question', runId, route}}
    SW->>SW: runId matches pattern and route == /operator#runId
    alt app window at / exists
        SW->>P: focus(); postMessage({type:'OPEN_RUN', runId})
        P->>P: check source + shape, switch to operator view
        P->>R: requestRunJump(runId) (held until run index loaded)
        R->>I: refresh (single-flight)
        R->>I: card present?
        alt missing
            R-->>P: dedicated notice, hash untouched
        else collapsed / dead stream
            R->>I: markCardExpandedForLaunch (collapsed only)
            R->>R: _attachStream, write hash, focus + announce
        else expanded and live
            R->>I: scroll + focus only
        end
    else no app window
        SW->>SW: openWindow('/#runId') → mount-time restore
    end
```

## Implementation Units

- [x] **Unit 1: Vendor contract 1.11.0 and accept waiting summaries**

**Goal:** Pin 1.11.0, vendor the 1.10.0 and 1.11.0 additions, and make every summary parser accept and label the waiting statuses.

**Requirements:** R1, R2, R3 (vendored kinds), R4 (parsing and labels)

**Dependencies:** None. The dashboard deploy waits for the gateway pin (Key Technical Decisions, deploy ordering).

**Files:**
- Modify:
  - `src/gateway/operator-contract/version.ts`
  - `src/gateway/operator-contract/responses.ts`
  - `src/gateway/operator-contract/parse.ts`
  - `src/gateway/operator-contract/run-summary.ts`
  - `src/gateway/operator-contract/index.ts`
  - `src/gateway/operator-contract/README.md`
  - `public/operator-stream.js` and `public/operator-stream.d.ts` (pin, `SUMMARY_STATUSES`)
  - `public/operator-run-index.js` and `public/operator-run-index.d.ts` (`VALID_RUN_SUMMARY_STATUSES`, `STATUS_LABELS`)
  - `web/src/operator/runtime.ts` (summary allowlist type)
  - `src/gateway/operator-fixtures.ts` (stale `'1.1.0'` contract literal → `OPERATOR_CONTRACT_VERSION`, unless a test needs it to drift)
- Test:
  - `test/operator-contract-conformance.test.ts`
  - `test/operator-run-index-core.test.js`
  - `test/operator-stream-core.test.ts`
  - `test/operator-fixture-harness.test.ts`
  - `test/operator-client.test.ts`
  - `test/static-assets.test.ts`
  - `web/src/operator/runtime.test.ts`

**Approach:**
- Copy the upstream changes from `a119ba4` (fro-bot/agent#1825), applying the README rewrite rules. Upstream comments contain version literals and must not be copied.
- The session parser becomes a closed copy that drops a malformed optional `push`.
- Add labels in both the index and the stream tables in the same change as the allowlists.
- Check the cache headers on `/static/operator-*.js` and record the result.

**Execution note:** Start with the tests that flip: the 7-status sets, waiting summaries accepted, the 1.11.0 `ready` accepted. The 1.10.0 drift case already passes and stays as a regression guard.

**Patterns to follow:** the 1.8.0 and 1.9.0 vendoring commits; `docs/solutions/best-practices/consume-gateway-operator-contract-1-8-0-2026-10-07.md`.

**Test scenarios:**
- Happy path: the server and browser pins equal `OPERATOR_CONTRACT_VERSION`. A `ready` at 1.11.0 is accepted. A `ready` at 1.9.0 and one at 1.10.0 each drift.
- Happy path: summaries with `waiting_for_approval` and `waiting_for_question` parse in the server parser and in the browser index. The two parsers agree on all seven statuses. An unknown status is still dropped.
- Happy path: each of the seven statuses has a label in the index and in the stream; the waiting labels are "Waiting for approval" and "Waiting for answer" in both. None renders the raw wire string.
- Edge case: a session with valid `push: {status: 'degraded'}` keeps it. A session with `push: {status: 'bad'}`, with `push: 'x'`, or with `push: null` keeps every other field and omits `push`. Extra session fields do not appear in the DTO.
- Error path: a session missing a required field is still rejected.
- Integration: the static no-literal scan passes over the vendored directory and README.

**Verification:** every pin and parity test passes at 1.11.0. Waiting summaries reach the run list with labels.

- [x] **Unit 2: Waiting badge on collapsed cards and terminal stickiness**

**Goal:** Collapsed cards show the waiting status with the right class. A finished card never regresses.

**Requirements:** R4

**Dependencies:** Unit 1

**Files:**
- Modify: `public/operator-run-index.js` (status-token map, emitter, `updateCardInPlace` guard), `web/src/operator/runtime.ts` (`discoverCardSummaryStatus`), `web/src/index.css` (only if light-theme contrast fails on collapsed cards)
- Test: `test/operator-run-index-core.test.js`, `web/src/operator/runtime.test.ts`, `test/operator-runtime.test.ts` if it pins the class token

**Approach:**
- One two-way status-to-token map, hyphenated, shared by the emitter and the discovery path.
- `updateCardInPlace` refuses to replace a terminal status with a non-terminal one.

**Patterns to follow:** the hyphenated class emission in `public/operator-stream.js`; `docs/solutions/workflow-issues/css-selector-emitter-mismatch-2026-07-04.md`.

**Test scenarios:**
- Happy path: each of the seven statuses round-trips (summary → `status-<hyphenated>` class → `discoverCardSummaryStatus` → summary). Underscore and unknown tokens are rejected.
- Happy path: a collapsed card for a waiting summary carries `status-waiting-for-question` or `status-waiting-for-approval` and its label.
- Edge case: a collapsed card showing `succeeded` that receives a `waiting_for_question` or `running` view keeps `succeeded`.
- Edge case: with the refresh-before-expand from Unit 3, a run that finished while its card was collapsed seeds the stream with its terminal summary, so `no-snapshot` closes it with "Output no longer available." If that refresh fails, the stream is seeded from the status already on the card.
- Integration: the CSS parity test covers both waiting class tokens in both themes.

**Verification:** collapsed waiting badges render styled. No test path shows a finished card moving back to a non-terminal status.

- [x] **Unit 3: Run-list refresh**

**Goal:** Keep collapsed badges and the run set current while the operator is looking.

**Requirements:** R5

**Dependencies:** Unit 2

**Files:**
- Modify:
  - `public/operator-run-index.js` and `public/operator-run-index.d.ts` (exported single-flight refresh)
  - `web/src/operator/runtime.ts` (30-second visible interval, visibility trigger, refresh before expand in `onSelectRun` (`onRestoreRun` relies on init's own fetch, which ran moments before), cleanup, inline `runIndexMod` cast)
- Test: `test/operator-run-index-core.test.js`, `web/src/operator/runtime.test.ts`

**Approach:** Follow the single-flight refresh and refresh-trigger decisions in Key Technical Decisions.

**Execution note:** Use fake timers for the interval and visibility tests.

**Test scenarios:**
- Happy path: while visible, a refresh runs every 30 seconds. While hidden, none runs. Becoming visible runs one immediately and restarts the interval.
- Happy path: a refresh adds a run started elsewhere, and moves a collapsed card from `running` to `waiting_for_question` and later to `succeeded`.
- Happy path: expanding a collapsed card runs a refresh first, and the stream is seeded from the refreshed status.
- Edge case: the stream-attached card is unchanged by a refresh, byte for byte.
- Edge case: three refresh requests during one in-flight fetch produce exactly one more fetch after it.
- Edge case: a list that mounted as unavailable becomes a populated list on a successful refresh; a refresh that returns no runs shows the empty state.
- Edge case: a focused collapsed card that moves during a refresh keeps focus, and the page does not scroll.
- Error path: a 401 enters auth-required and stops the interval. A 429 or network failure leaves the list as it was, and the next cycle tries again. A failed refresh before expand still expands.
- Integration: runtime cleanup clears the interval and the visibility listener, and no refresh fires after unmount.

**Verification:** on the fixture server, a collapsed run's badge changes within about 30 seconds without any interaction.

- [x] **Unit 4: Align the client waiting fallback**

**Goal:** `getEffectiveStatus` matches the gateway's overlay rules.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `public/operator-stream.js` (`getEffectiveStatus`)
- Test: `test/operator-stream-core.test.ts`. The existing test "wire waiting_for_question with an open approval is waiting_for_approval" flips on purpose.

**Approach:** Apply the open-approval overlay only when the wire status is `running`. A wire `waiting_for_approval` and terminal statuses keep their current handling.

**Execution note:** Write the truth-table test first.

**Test scenarios:**
- Happy path: a table of wire status (`running`, `waiting_for_approval`, `waiting_for_question`, each terminal status) × open approval × open question gives the gateway's result.
- Edge case: a wire `waiting_for_question` with no open questions after reconcile demotes to `running`. This heuristic is pinned.
- Regression: a terminal status always wins, whatever is open.

**Verification:** the truth-table test passes. Other existing approval and question status tests still pass.

- [x] **Unit 5: Service worker deep link**

**Goal:** A question notification click targets the asking run safely.

**Requirements:** R3, R7

**Dependencies:** #615 (merged; nested `data` reader is on main)

**Files:**
- Create: `web/src/push/notification-click.ts` (pure click resolver) and its test `web/src/push/notification-click.test.ts`; `test/operator-push-trigger-parity.test.ts` (root parity and privacy-sentence test)
- Modify:
  - `web/src/push/sw-notification.ts` (discriminated `data`, validated `runId`, exported `PUSH_NOTIFICATION_TYPES` tuple)
  - `web/src/sw.ts` (wire the resolver; add `data` to the local `SWNotification` type)
  - `web/privacy.html` (the "What notifications contain" sentence: question notifications carry the ID of the run that asked, used only to open it)
  - `web/src/privacy/content.test.ts` (remove the "UNGUARDED" comment)
- Test: `web/src/push/sw-notification.test.ts`, `web/src/sw.test.ts` (replace the source-text guard with a check that `sw.ts` delegates to the resolver)

**Approach:** Follow the notification-data and SW click decisions in Key Technical Decisions. The privacy page's "Last updated" date moves with the copy change.

**Execution note:** Write the resolver tests first, using fake window clients.

**Test scenarios:**
- Happy path: no app window → open `/#<runId>`.
- Happy path: with a focused, a visible and a hidden app window, the focused one gets `focus` and exactly one `{type:'OPEN_RUN', runId}` message, and nothing opens.
- Happy path: a hidden-only app window gets focus and the message.
- Edge case: the only window is `/privacy` → open `/#<runId>`; the `/privacy` window gets no message.
- Edge case: `focus()` rejects → the message is still posted.
- Edge case: `approval` and `run_failed` keep today's behavior, with no message.
- Error path: a question whose `runId` is missing, 129 characters, `../x`, `a/b`, `%2F`, has a space, or is `javascript:` falls back to `/`. So does a valid `runId` whose `route` is not exactly `/operator#<runId>`.
- Edge case: a notification shown by the previous SW (data without `runId`) opens `/`.
- Integration (root): the parity test fails if `PUSH_NOTIFICATION_TYPES` and the vendored kinds differ, if the privacy event sentence omits a kind, or if the payload sentence claims notifications never carry run identifiers.
- Safety: the resolver and `buildNotification` make no `console.*` calls.

**Verification:** the resolver tests pass, and `sw.ts` only wires them. The notification never carries a URL built from wire text.

- [x] **Unit 6: In-page jump to a run**

**Goal:** An open window jumps to the run on an `OPEN_RUN` message, without reloading.

**Requirements:** R8, R9

**Dependencies:** Units 3 and 5

**Files:**
- Modify:
  - `web/src/App.tsx` (service-worker message listener, view switch)
  - `web/src/operator/runtime.ts` (`requestRunJump`, the jump next to `onRunLaunched`, miss handler that keeps the hash, live-region announcement, inline `runIndexMod` cast)
  - `public/operator-run-index.js` and `public/operator-run-index.d.ts` (dedicated miss-notice element, if the run index owns that markup)
- Test: `web/src/operator/runtime.test.ts`, `web/src/App.test.tsx` (update the runtime mock), `test/operator-run-index-core.test.js` (extend `makeElStub` with `focus` and `scrollIntoView`)

**Approach:** Follow the jump-intent and jump-semantics decisions in Key Technical Decisions. Reuse `markCardExpandedForLaunch`; no new expand export. The miss notice uses fixed copy and never includes the run ID.

**Execution note:** Write the intent-ordering tests first, covering messages that arrive before, during, and after run-index init.

**Test scenarios:**
- Happy path: the run is in the list and collapsed. A refresh runs, the card expands without toggling, its stream attaches once, the hash is written, the card gets focus, and the live region announces it.
- Happy path: the message arrives while the listener view is active. The operator view shows and the run expands.
- Edge case: the run is already expanded with a live stream → no re-attach; scroll and focus only. Expanded with a closed or failed stream → re-attach without collapsing.
- Edge case: another run is expanded and has a question draft. The jump switches runs, and returning restores the draft from the page store.
- Edge case: the message arrives before run-index init resolves → it is applied once init loads. Init ends unavailable or stale → the jump is dropped. Two rapid messages → the last one wins. A message equal to the mount-time restore target → only one attach.
- Error path: the run is missing after the refresh → notice shown, current hash and expansion unchanged, no attach. The next jump or expand clears the notice.
- Error path: auth-required during the refresh clears the pending jump.
- Error path: a message whose source isn't the worker that controls the page (`navigator.serviceWorker.controller`, compared by identity), or whose data has the wrong type, an invalid `runId` or isn't an object, is ignored.
- Integration: the hash write does not trigger another jump, and nothing listens for `hashchange`.
- Safety: the listener and the jump make no `console.*` calls.

**Verification:** on the fixture server, posting the message to an open window expands the target run with no reload. Navigation timing and the absence of a document reload both confirm this.

- [x] **Unit 7: Fixtures and browser verification**

**Goal:** Fixture parity for waiting summaries, and an assembled-surface check.

**Requirements:** R10

**Dependencies:** Units 1–6. Rebase after #604 if it merges first.

**Files:**
- Modify: `src/gateway/operator-fixture-sse.ts`, `src/routes/operator-fixture-harness.ts`
- Test: `test/operator-fixture-harness.test.ts`, `test/operator-fixture-sanitization.test.ts`

**Approach:**
- Add summary rows for `waiting_for_approval` and `waiting_for_question`, mapped to the approval and question scenarios rather than the default success stream.
- Correct any fixture comment that says waiting summaries aren't modeled.

**Test scenarios:**
- Happy path: `GET /runs` in the harness lists the waiting rows, and each streams its matching scenario.
- Edge case: fixture scenario names stay out of the production bundle.

**Verification:**
- On the fixture bundle (backgrounded server, no `--watch`), in both themes at desktop and 390px:
  - collapsed waiting badges, and a badge changing on the 30-second refresh;
  - an `OPEN_RUN` jump into an open window;
  - an `openWindow('/#<runId>')` cold start;
  - the missing-run notice.
- A designer subagent runs the check on a fixture server the orchestrator starts and stops, and reports screenshots and computed styles.

## System-Wide Impact

- **Interaction graph:** SW → App listener → operator runtime → run index (refresh, expand) → stream (attach, `getEffectiveStatus`). The contract vendoring touches the server session parse, and nothing on the server renders it.
- **Error propagation:** a refresh 401 enters the existing auth-required path and stops the interval. A 429 or network failure leaves the list unchanged until the next cycle. SW focus failures still post the message.
- **State lifecycle risks:**
  - A refresh that races a stream frame: covered by the attached-card skip and terminal stickiness.
  - Overlapping refresh requests: single-flight, with one trailing fetch.
  - A pending jump across remounts or a failed init: dropped.
- **Load:** each visible tab polls `GET /operator/runs` about twice a minute against the gateway's 20-per-minute operator limit. Several open tabs plus expands stay under it, and a 429 just skips a cycle.
- **API surface parity:** the server and browser summary parsers, the index and stream label tables, the runtime allowlist, and the `.d.ts` sidecars change together.
- **Integration coverage:** only a real browser can prove the SW click flow, the no-reload jump, and iOS cold start.
- **Unchanged invariants:**
  - The exact version pin and fail-closed drift.
  - Fixed notification copy.
  - The SW deny-by-default routing.
  - The stream as the only writer to the attached card.
  - No GitHub write paths.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A gateway on 1.10.0 (`v0.120.0`–`v0.122.0`) or 1.9.0 paired with this dashboard drifts every stream | The infra pin moves from `v0.119.2` straight to a fixed tag of at least `v0.122.1`, in the same window as the dashboard deploy. |
| An installed PWA keeps an old 1.9.0 shell after the gateway moves: streams drift and waiting runs vanish until the update prompt is accepted | Accept the PWA update right after the deploy. Note it in the deploy handoff. |
| A notification tap reaches an app window that is still loading, before the listener registers, and the message is lost | Accepted for now: the listener registers at App mount, and the operator can tap again. Revisit with an SW-held pending ID if it shows up in the device check. |
| Rollback is one-way after the gateway migration | Rolling back the dashboard alone is not enough. Roll back both, per #3512. |
| An installed iOS app drops the `#runId` on a cold start, or doesn't deliver the message to a backgrounded client | Device check is part of acceptance. If the hash is dropped, follow up with an in-memory pending ID in the SW that the page requests on mount. |
| Upstream broadcasts pushes to every subscriber, so a `runId` can reach an operator who can't see that repo | The SW shows fixed copy only. The page attaches only to runs present in the operator's own list, so a missing run gets the neutral notice. |
| #604 conflicts in the fixture files | Land #604 first, or rebase Unit 7 onto it. |

## Documentation / Operational Notes

- After this lands, update these docs where they describe one-shot summary status or route-to-`/` clicks:
  - `docs/solutions/best-practices/operator-approval-channel-consumption-2026-06-22.md`
  - `docs/solutions/best-practices/consume-gateway-operator-contract-1-8-0-2026-10-07.md`
- Deploy handoff for the infra agent:
  - Gateway pin goes to a fixed tag of `v0.122.1` or later.
  - Deploy the gateway and dashboard together and supersede stale deploy runs. The dashboard deploy must not run against the old gateway.
  - Afterwards, confirm that `/operator/health` and the authenticated SSE `ready` both report 1.11.0.
  - Known limit: signed out, a notification lands on `/` after sign-in instead of the run.
- Live acceptance from #3512 after deploy:
  - answer and skip a question;
  - approve and deny;
  - reconnect before and after settlement;
  - the waiting run stays in the list;
  - a finished run never shows waiting;
  - the notification opens the right run, cold and warm, including on an installed iOS app.

## Sources & References

- fro-bot/.github#3512 (October 13 comments: dashboard requirements and deploy gates)
- fro-bot/agent#1825 (contract 1.11.0), #1787 and #1788 (contract 1.10.0), `docs/plans/2026-10-12-001-fix-operator-waiting-status-plan.md` at `a119ba4`
- Related: fro-bot/dashboard#615 (push payload fix), #604 (question-only fixture), #585 (card time and waiting line, rebases onto this)
