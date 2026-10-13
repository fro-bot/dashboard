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
- The list refreshes when the window becomes visible again, and when a notification jumps to a run.
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
- R3. The vendored contract exports the push trigger kinds. The privacy page's list of notification events is pinned against them (closes smart note: "pin the privacy claim once the trigger set is exposed").
- R4. Every run-summary parser accepts `waiting_for_approval` and `waiting_for_question`. Collapsed cards show the existing labels and the hyphenated status classes the CSS already styles. A card showing a terminal status never moves back to a non-terminal one.
- R5. The run list refreshes in place when the window becomes visible (at most once every 30 seconds) and when a notification jumps to a run. A refresh never writes to the stream-attached card.
- R6. The client-side waiting derivation stays as a fallback, aligned with the gateway: terminal wins, approval beats question, and the overlay applies only on a `running` base.
- R7. A question notification click builds its target only from a `runId` matching `^[A-Za-z0-9_-]{1,128}$`. Any other type, or a question without a valid `runId`, opens or focuses `/`.
- R8. With a dashboard window already open, the click focuses that window and jumps to the run without a reload. The run's card expands (it never toggles closed), its stream attaches, and the URL hash updates. With no window open, the click opens `/#<runId>` and the existing mount-time restore handles it.
- R9. If the run is still missing after one refresh, a fixed notice appears. The current hash and the current expansion stay as they are, and the run ID is never echoed.
- R10. Fixtures include waiting summaries mapped to matching scenarios. A browser check on the fixture server covers waiting badges, refresh, and both jump paths.

## Scope Boundaries

- No version check on `/operator/runs` or `/operator/session`. The exact pin stays on the stream.
- Signed out: the notification link may not survive the OAuth redirect. After sign-in the operator lands on `/`. This is accepted and documented, not fixed.
- No `hashchange` listener. `_writeRunHash` pushes history entries, so a hash listener would fire on the page's own writes, and Back would start changing which card is expanded. The SW message is the only in-page jump entry point.
- No `WindowClient.navigate()` and no manifest `launch_handler`. Both cause a full navigation, which reloads the page.
- No background polling. The list refreshes only on visibility and on a jump.

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
  "freshness": {"vcs_reference": "1bcd98a45011fbdfdad58a0f85c59b464d8b2fe5"},
  "budget": {"max_search_passes": 6, "max_candidate_inspections": 14, "exhausted": false},
  "candidates": [
    {"path_or_symbol": "web/src/sw.ts:notificationclick", "description": "Notification click handler: focus the focused-or-visible client, else openWindow('/'); never reads notification.data.", "disposition": "extend"},
    {"path_or_symbol": "web/src/sw.ts:SWWindowClient", "description": "Inline WindowClient type exposing focused, visibilityState, focus(), postMessage().", "disposition": "reuse"},
    {"path_or_symbol": "web/src/push/sw-notification.ts:buildNotification", "description": "Maps the nested push payload to fixed copy; data typed {type, route:'/'}.", "disposition": "extend"},
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
- **Closed session DTO.** `parseOperatorSessionInfo` copies the required fields. It keeps `push` only when `status` is in the vendored vocabulary, and omits it otherwise. No push state is derived from it.
- **Trigger-kind parity.** The vendored `OPERATOR_PUSH_TRIGGER_KINDS` is tied to the SW's `PushNotificationType` by a parity test, following `push-types.test.ts`. The privacy content test pins the event sentence against the same list, and the "UNGUARDED" comment is removed.
- **One status-token map.** A single two-way mapping between summary status and class token (hyphenated) is used by the index emitter and `discoverCardSummaryStatus`. It accepts only hyphenated tokens.
- **Terminal is sticky on collapsed cards.** `updateCardInPlace` never replaces a terminal status with a non-terminal one. Each refresh carries a sequence token, and a response older than the latest applied refresh is dropped.
- **Refresh is a diff-only helper.** The run index exports a refresh that:
  - fetches, then diffs without the loading or hidden toggles;
  - never touches the stream-attached card;
  - routes a 401 to the existing auth-required path.

  The runtime triggers it on `visibilitychange` to visible (when 30 seconds or more have passed since the last fetch) and on a jump. It never reuses `initOperatorRunIndex` for this.
- **Fallback alignment.** `getEffectiveStatus` applies the open-approval overlay only on a `running` base, so it matches the gateway. The existing demotion of a stale wire `waiting_for_question` with no open questions stays, and is pinned by a test.
- **Notification data carries a validated runId.** `SafeNotification.data` becomes a discriminated shape. A question payload whose `runId` matches the pattern carries `runId`. Everything else carries none. `route` from the wire is never read.
- **SW click targeting.**
  - Target order: focused client, then visible, then any window client.
  - `focus()` failures are caught.
  - The `{type: 'OPEN_RUN', runId}` message goes to exactly one client.
  - With no client, `openWindow('/#<runId>')`.
  - Non-question types keep the current behavior.
- **Page listener at App level.** The `navigator.serviceWorker` message listener is registered once, early, and validates `event.data` shape and the `runId` pattern. It holds one pending intent (last wins), and hands it to the operator runtime once the run index has resolved:
  - It switches the view to the operator view.
  - It drops the intent on auth-required, on runtime cleanup, or when it equals the mount-time restore target.
- **Jump semantics.** The runtime resolves the intent as follows:
  - Card collapsed: non-toggling expand, stream attach, hash write, scroll into view and focus the card.
  - Card expanded and stream live or terminal: scroll and focus only.
  - Card expanded with a dead stream: re-attach.
  - Card missing: one refresh, then a fixed notice through a miss handler that does not clear the hash. The run index exports the non-toggling expand, with the same single-open bookkeeping as `markCardExpandedForLaunch`.

## Open Questions

### Resolved During Planning

- Refresh policy: on jump and on becoming visible, at most once every 30 seconds (user decision).
- Push health: parse only (user decision).
- Open-window behavior: focus and jump without reload (user decision).
- Client fallback: keep it, aligned to the gateway (user decision).
- Run not found: fixed notice; the hash and expansion stay as they are.
- Dead stream on an expanded target: re-attach.
- URL source: the validated `runId` only.
- Version check on REST routes: out of scope.

### Deferred to Implementation

- Notice copy for a missing run, and where it renders. Reuse the restore-miss notice region if it can avoid clearing the hash.
- Whether `/static/operator-*.js` responses carry cache headers that let a new shell pair with an old module. Report the result. A fix is deferred (see Scope Boundaries).
- Whether the README provenance for `sse-frames.ts` (upstream path no longer exists) needs a correction, found while vendoring.
- Whether `src/gateway/operator-fixtures.ts` and `test/operator-client.test.ts` still carry a stale `'1.1.0'` literal that should come from the constant.

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
    SW->>SW: validate runId pattern
    alt window exists
        SW->>P: focus(); postMessage({type:'OPEN_RUN', runId})
        P->>P: validate, store pending intent (last wins), switch to operator view
        P->>R: hand intent once run index is ready
        R->>I: card present?
        alt missing
            R->>I: refresh (diff-only)
            I-->>R: still missing → notice, hash untouched
        else collapsed / dead stream
            R->>I: non-toggling expand
            R->>R: attach stream, write hash, focus card
        else expanded and live
            R->>I: scroll + focus only
        end
    else no window
        SW->>SW: openWindow('/#runId') → mount-time restore
    end
```

## Implementation Units

- [ ] **Unit 1: Vendor contract 1.11.0 and accept waiting summaries**

**Goal:** Pin 1.11.0, vendor the 1.10.0 and 1.11.0 additions, and make every summary parser accept and label the waiting statuses.

**Requirements:** R1, R2, R4 (parsing and labels)

**Dependencies:** None

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

**Execution note:** Start with the failing tests that flip: the 7-status sets, waiting accepted, a 1.10.0 `ready` frame drifts.

**Patterns to follow:** the 1.8.0 and 1.9.0 vendoring commits; `docs/solutions/best-practices/consume-gateway-operator-contract-1-8-0-2026-10-07.md`.

**Test scenarios:**
- Happy path: the server and browser pins equal `OPERATOR_CONTRACT_VERSION`. A `ready` at 1.11.0 is accepted. A `ready` at 1.9.0 and one at 1.10.0 each drift.
- Happy path: summaries with `waiting_for_approval` and `waiting_for_question` parse in the server parser and in the browser index. The two parsers agree on all seven statuses. An unknown status is still dropped.
- Happy path: each of the seven statuses has a label in the index and in the stream. None renders the raw wire string.
- Edge case: a session with valid `push: {status: 'degraded'}` keeps it. A session with `push: {status: 'bad'}`, with `push: 'x'`, or with `push: null` keeps every other field and omits `push`. Extra session fields do not appear in the DTO.
- Error path: a session missing a required field is still rejected.
- Integration: the static no-literal scan passes over the vendored directory and README.

**Verification:** every pin and parity test passes at 1.11.0. Waiting summaries reach the run list with labels.

- [ ] **Unit 2: Waiting badge on collapsed cards and terminal stickiness**

**Goal:** Collapsed cards show the waiting status with the right class. A finished card never regresses.

**Requirements:** R4

**Dependencies:** Unit 1

**Files:**
- Modify: `public/operator-run-index.js` (status-token map, emitter, `updateCardInPlace` guard), `web/src/operator/runtime.ts` (`discoverCardSummaryStatus`), `web/src/index.css` (only if light-theme contrast fails on collapsed cards)
- Test: `test/operator-run-index-core.test.js`, `web/src/operator/runtime.test.ts`

**Approach:**
- One two-way status-to-token map, hyphenated, shared by the emitter and the discovery path.
- `updateCardInPlace` refuses to replace a terminal status with a non-terminal one.

**Patterns to follow:** the hyphenated class emission in `public/operator-stream.js`; `docs/solutions/workflow-issues/css-selector-emitter-mismatch-2026-07-04.md`.

**Test scenarios:**
- Happy path: each of the seven statuses round-trips (summary → `status-<hyphenated>` class → `discoverCardSummaryStatus` → summary). Underscore and unknown tokens are rejected.
- Happy path: a collapsed card for a waiting summary carries `status-waiting-for-question` or `status-waiting-for-approval` and its label.
- Edge case: a collapsed card showing `succeeded` that receives a `waiting_for_question` or `running` view keeps `succeeded`.
- Edge case: re-expanding a card whose last stream-written class is waiting seeds the stream with a non-terminal summary. `no-snapshot` then stays live, not closed.
- Integration: the CSS parity test covers both waiting class tokens in both themes.

**Verification:** collapsed waiting badges render styled. No test path shows a finished card moving back to a non-terminal status.

- [ ] **Unit 3: Run-list refresh**

**Goal:** Keep collapsed badges and the run set current without background polling.

**Requirements:** R5

**Dependencies:** Unit 2

**Files:**
- Modify:
  - `public/operator-run-index.js` and `public/operator-run-index.d.ts` (exported diff-only refresh, sequence token)
  - `web/src/operator/runtime.ts` (visibility trigger with 30-second minimum, cleanup)
- Test: `test/operator-run-index-core.test.js`, `web/src/operator/runtime.test.ts`

**Approach:**
- The refresh fetches and diffs, with no loading or hidden toggles.
- It skips the stream-attached card.
- It drops out-of-order responses.
- A 401 routes to the existing auth-required handling.
- The visibility listener is removed on runtime cleanup.

**Test scenarios:**
- Happy path: becoming visible 30 seconds or more after the last fetch triggers one refresh. Becoming visible within 30 seconds does not.
- Happy path: a refresh adds a run started elsewhere, and updates a collapsed card from `running` to `waiting_for_question` and later to `succeeded`.
- Edge case: the stream-attached card is unchanged by a refresh, byte for byte.
- Edge case: two overlapping refreshes, where the older response arrives last, leave the newer state.
- Error path: a refresh that gets a 401 enters auth-required. A network failure leaves the list as it was.
- Integration: runtime cleanup removes the visibility listener, and no refresh fires after unmount.

**Verification:** on the fixture server, a backgrounded window shows updated badges when brought back after 30 seconds.

- [ ] **Unit 4: Align the client waiting fallback**

**Goal:** `getEffectiveStatus` matches the gateway's overlay rules.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `public/operator-stream.js` (`getEffectiveStatus`)
- Test: `test/operator-stream-core.test.ts`

**Approach:** Apply the open-approval overlay only when the wire status is `running`. A wire `waiting_for_approval` and terminal statuses keep their current handling.

**Execution note:** Write the truth-table test first.

**Test scenarios:**
- Happy path: a table of wire status (`running`, `waiting_for_approval`, `waiting_for_question`, each terminal status) × open approval × open question gives the gateway's result.
- Edge case: a wire `waiting_for_question` with no open questions after reconcile demotes to `running`. This heuristic is pinned.
- Regression: a terminal status always wins, whatever is open.

**Verification:** the truth-table test passes and the existing approval and question status tests still pass.

- [ ] **Unit 5: Service worker deep link**

**Goal:** A question notification click targets the asking run safely.

**Requirements:** R3, R7

**Dependencies:** #615 merged (nested `data` reader)

**Files:**
- Modify: `web/src/push/sw-notification.ts` (discriminated `data`, validated `runId`), `web/src/sw.ts` (`notificationclick` targeting and message)
- Test:
  - `web/src/push/sw-notification.test.ts`
  - `web/src/sw.test.ts` (replace the source-text guard with behavioral tests)
  - `web/src/push/push-types.test.ts` (trigger-kind parity)
  - `web/src/privacy/content.test.ts` (pin the event sentence; remove the "UNGUARDED" comment)

**Approach:**
- `buildNotification` keeps fixed copy, and adds `runId` only for `question` with a valid ID.
- `notificationclick` follows the targeting rules in Key Technical Decisions.
- `route` is never read.

**Execution note:** Write the click tests first, using fake `clients`.

**Test scenarios:**
- Happy path: no window → `openWindow('/#<runId>')`.
- Happy path: with a focused window, a visible one, and a hidden one, the focused one gets `focus` and exactly one `postMessage({type:'OPEN_RUN', runId})`, and there is no `openWindow`.
- Happy path: a hidden-only window gets focus and the message.
- Edge case: `focus()` rejects → the message is still posted.
- Edge case: `approval` and `run_failed` open or focus `/` with no message.
- Error path: a question with no `runId`, one of 129 characters, `../x`, `a/b`, `%2F`, a space, or `javascript:` falls back to `/`. A `route` pointing elsewhere is ignored.
- Edge case: a notification shown by the previous SW (data without `runId`) opens `/`.
- Integration: the trigger-kind parity test fails if the SW type union and the vendored kinds differ. The privacy test fails if the page's event sentence omits a kind.

**Verification:** the SW tests pass with no source-text guards. The notification never carries a URL built from wire text.

- [ ] **Unit 6: In-page jump to a run**

**Goal:** An open window jumps to the run on an `OPEN_RUN` message, without reloading.

**Requirements:** R8, R9

**Dependencies:** Units 3 and 5

**Files:**
- Modify:
  - `web/src/App.tsx` (or the earliest app-level module: listener and pending intent)
  - `web/src/operator/runtime.ts` (intent consumer, miss handler that keeps the hash)
  - `public/operator-run-index.js` and `public/operator-run-index.d.ts` (exported non-toggling expand)
  - `web/src/views/Operator.tsx` (only if the runtime handle needs wiring)
- Test: `web/src/operator/runtime.test.ts`, `web/src/App.test.tsx` (or the matching app test), `test/operator-run-index-core.test.js`

**Approach:** Follow the page-listener and jump decisions in Key Technical Decisions. The miss notice uses fixed copy and never includes the run ID.

**Execution note:** Write the intent-ordering tests first, covering messages that arrive before, during, and after run-index init.

**Test scenarios:**
- Happy path: the run is in the list and collapsed. It expands without toggling, its stream attaches once, the hash is written, and the card gets focus.
- Happy path: the message arrives while the listener view is active. The operator view shows and the run expands.
- Edge case: the run is already expanded with a live stream → no re-attach; scroll and focus only. Expanded with a closed or failed stream → re-attach.
- Edge case: another run is expanded and has a question draft. The jump switches runs, and returning restores the draft from the page store.
- Edge case: the message arrives before run-index init resolves → it is applied once init resolves. Two rapid messages → the last one wins. A message equal to the mount-time restore target → only one attach.
- Error path: the run is missing → one refresh. Still missing → notice shown, current hash and expansion unchanged, no attach.
- Error path: auth-required during the refresh clears the pending intent.
- Error path: a malformed message (wrong type, invalid `runId`, a non-object) is ignored.
- Integration: the hash write does not trigger another jump, and nothing listens for `hashchange`.

**Verification:** on the fixture server, posting the message to an open window expands the target run with no reload. Navigation timing and the absence of a document reload both confirm this.

- [ ] **Unit 7: Fixtures and browser verification**

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
  - collapsed waiting badges;
  - a visibility refresh;
  - an `OPEN_RUN` jump into an open window;
  - an `openWindow('/#<runId>')` cold start;
  - the missing-run notice.
- Run the check with a designer on a server the orchestrator owns.

## System-Wide Impact

- **Interaction graph:** SW → App listener → operator runtime → run index (refresh, expand) → stream (attach, `getEffectiveStatus`). The contract vendoring touches the server session parse, and nothing on the server renders it.
- **Error propagation:** a refresh 401 enters the existing auth-required path. Network failures leave the list unchanged. SW focus failures still post the message.
- **State lifecycle risks:**
  - A refresh that races a stream frame: covered by the attached-card skip and terminal stickiness.
  - A pending intent across remounts: dropped on cleanup.
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
  - Deploy the gateway and dashboard together and supersede stale deploy runs.
  - Afterwards, confirm that `/operator/health` and the authenticated SSE `ready` both report 1.11.0.
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
