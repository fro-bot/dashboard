---
title: "fix: prune ghost operator-approval prompts left by a settle frame lost during disconnect"
type: fix
status: active
date: 2026-06-24
deepened: 2026-06-24
---

# fix: prune ghost operator-approval prompts left by a settle frame lost during disconnect

## Overview

In the operator run view, a tool-approval prompt is dismissed when its `settled:true` frame arrives over the SSE run stream. If that settle frame is lost while the connection is down (gateway restart, network blip), the open prompt lingers in the UI until the operator interacts with it. This change makes the reconnect reconcile **corrective** instead of additive-only: the gateway's recovered open-prompt set is treated as authoritative, and any locally-open prompt absent from it is pruned (and tombstoned) as settled-during-gap.

The failure is cosmetic, not a safety issue — the gateway is authoritative and rejects a late decision, so a ghost prompt cannot double-decide. But it undermines trust in the surface. Dashboard-side only, behind `DASHBOARD_OPERATOR_UI_ENABLED`; no production impact until the operator UI is enabled.

## Problem Frame

The reconnect reconcile (`reconcileApprovals` in `public/operator-stream.js`) currently does a one-shot `GET /operator/runs/:runId/approvals` and feeds each recovered open prompt back through the reducer as a synthetic open frame (`reconcile-additive-only`). The reducer's tombstones prevent resurrecting a prompt that settled during the gap *if a settle frame was seen*, and the additive replay can surface a prompt that opened during the gap. But neither path can **retract** a prompt that opened before the gap and settled during it: the settle frame was the only signal and it was lost. (Issue fro-bot/dashboard#86; Fro Bot triage confirmed the reducer gap with a reproduction.)

## Requirements Trace

- R1. On reconnect, treat the gateway's recovered open-prompt set as authoritative: any locally-open prompt for that run absent from the recovered set is dismissed and tombstoned.
- R2. Preserve existing tombstone precedence — a late open frame for a pruned/settled id stays ignored (no resurrection).
- R3. Never prune on an unsafe signal: a failed/malformed reconcile response, a truncated recovered set, or a prompt that opened during the reconcile window must all leave open prompts intact.
- R4. Regression test the gap scenario: open(A) → disconnect → A settles during gap → reconnect recovery returns a set without A → A is pruned from the UI.

## Scope Boundaries

- Dashboard-side only. No gateway/agent changes (the recovery endpoint already returns the authoritative open set — see Key Technical Decisions).
- Behind `DASHBOARD_OPERATOR_UI_ENABLED`; no behavior change when the operator UI is disabled.
- Does not change the SSE settle-frame path, the decision POST path, or terminal-status absorbing behavior.

### Deferred to Separate Tasks

- The symmetric lost-OPEN-frame case (a prompt that opened during the gap and whose open frame was lost) is already covered by additive replay and is out of scope here.
- Any gateway-side change to the recovery cap or response shape.

## Context & Research

### Relevant Code and Patterns

- `public/operator-stream.js` `reconcileApprovals()` (~L1380-1411): the one-shot reconnect GET that currently dispatches synthetic open frames only; the `reconcile-additive-only` comment marks the gap.
- `public/operator-stream.js` reducer approval branch (~L456-500): `settled` frames remove from `approvalOpenPrompts` and add to `approvalTombstones` (FIFO-capped at `MAX_APPROVAL_TOMBSTONES`); open frames are ignored if tombstoned. The prune action mirrors the settle branch's remove-and-tombstone.
- `public/operator-stream.js` constants: `MAX_OPEN_APPROVALS = 100`, `MAX_APPROVAL_TOMBSTONES = 1000`.
- `public/operator-stream.js` `getOpenApprovals` / `hasOpenApprovals` (~L740-766): open-set readers used by the DOM render and tests.
- `src/gateway/operator-client.ts` `listRunApprovals` (~L551): returns `RunApprovalsResponse` (open prompts only).
- `test/operator-stream-core.test.ts` (~L2473-2539): existing no-resurrect/tombstone coverage to mirror for the new prune test.

### Institutional Learnings

- `docs/solutions/best-practices/operator-approval-channel-consumption-2026-06-22.md` — tombstone/precedence races, additive-reconcile rationale, and the known lost-settle limitation this change closes.

### External References

- `fro-bot/agent` v0.76.2 `packages/gateway/src/web/operator/pending-approvals-route.ts` — the recovery endpoint contract (see Key Technical Decisions).

- **The recovered open-set is authoritative-complete (confirmed against the gateway source).** `GET /operator/runs/:runId/approvals` returns `registry.describePendingForScope(runId)` — the registry is the sole source of pending detail for the run, and an authorized operator with no open requests gets `200 {approvals: []}` (a real "nothing open" signal, not an oracle). This validates corrective pruning.
- **Pre-GET snapshot diff resolves the reconcile-window race (decided now, not deferred).** `reconcileApprovals` runs the GET behind an `await`; while it's pending, the live SSE reader can deliver a genuinely-new open frame for a prompt C through the same `dispatch`. If the prune were computed as "any currently-locally-open prompt absent from the recovered set," C would be wrongly pruned (it opened *after* the snapshot). Fix: **capture the local open-id set BEFORE the `await`, and compute `pruneIds = preGetLocalOpenIds ∖ recoveredOpenIds`.** Only prompts open *before* the snapshot are eligible for pruning; prompts that arrive during the GET window are never pruned. The reducer receives an explicit `pruneIds` list and an `addIds`/open set — it does not re-derive the diff at dispatch time, so there is no race. This also makes snapshot staleness a non-issue for the prune path (the diff is bounded to pre-snapshot prompts).
- **Client must surface success-vs-failure (a dedicated unit, not buried).** The browser `listRunApprovals` wrapper currently collapses every failure (network throw, non-2xx, malformed body) to `[]` — indistinguishable from a real `200 {approvals: []}`. Under corrective pruning, a failed reconcile returning `[]` would prune ALL open prompts (catastrophic wipe). Reshape the browser `listRunApprovals` to a discriminated `{success, data?, error?}` return matching its siblings `refreshCsrf`/`decideRunApproval` in the same factory (the browser ESM does not import `@bfra.me/es/result`, so it uses the sibling shape, not the app-client `Result<T,E>`). The corrective action is dispatched **only on `success:true`**; any failure (including a 200 with a malformed/missing `approvals` array → `protocol` error) aborts the reconcile and prunes nothing.
- **Truncation guard via the gateway cap (with an explicit boundary tradeoff).** The gateway hard-caps the response at `PENDING_APPROVALS_MAX_RESULTS = 50`; the dashboard allows up to `MAX_OPEN_APPROVALS = 100` locally. A recovered set whose size reaches the gateway cap may be truncated, so the dashboard mirrors the cap as a documented constant (`GATEWAY_PENDING_APPROVALS_CAP = 50`) and **only prunes when the recovered set size is strictly below the cap** (known-complete); at/above the cap it falls back to additive-only. Accepted tradeoff: a run with *exactly* 50 open prompts never prunes (`< cap`, not `<= cap`) — a single ghost among 50 real prompts is cosmetic noise at a pathological load, and the guard's job is to prevent catastrophic wipe, not handle every boundary. The cap is an external contract value with no in-repo source of truth; document the vendored agent source path on the constant and note that a gateway-side cap bump silently tightens the guard (ghosts persist) until the mirror is updated.
- **Prune as a dedicated reducer action, not derived in the client.** Add a new reducer event (e.g. `type: 'approval-reconcile'` carrying `runId`, the authoritative open set to add, and the explicit `pruneIds`) so the open-set/tombstone state stays owned by the pure reducer (testable in `operator-stream-core`), consistent with the existing approval-state design.
- **Tombstone-by-inference is sound.** Pruned ids are tombstoned even though no actual settle frame was seen. This is safe because `requestID` is a gateway-assigned per-request UUID that is never reused — a tombstoned id cannot be legitimately re-opened, so suppressing late opens for it is correct.
- **Dashboard-side is the right boundary (rationale recorded so review doesn't reopen it).** The gateway already exposes the authoritative open-set endpoint; the fix is a single client-owned reducer action + one GET, fully unit-testable, scope-limited to one dashboard tab. The gateway alternative (emitting catch-up settle frames / SSE replay) would require per-client state and a redundant second authority over the registry. No gateway/agent change is needed.
- **Precedence preserved.** Pruned ids are tombstoned, so the existing open-frame branch (ignore-if-tombstoned) keeps a late open frame for a pruned id suppressed. Terminal-status absorbing behavior is unchanged.

## Open Questions

### Resolved During Planning

- Is the recovery endpoint authoritative-complete? → Yes, confirmed against agent v0.76.2 source (sole-source registry, `{approvals: []}` is a real empty).
- What completeness threshold guards truncation? → The gateway cap of 50 (`PENDING_APPROVALS_MAX_RESULTS`), mirrored dashboard-side; prune only when recovered size < cap.
- Where does pruning live? → A dedicated reducer action, dispatched once by `reconcileApprovals` after the additive opens.

### Deferred to Implementation

- Exact action/event name and the precise reducer field-update shape — choose at implementation to match the existing `nextStreamState` style.

(The reconcile-window ordering question is resolved in Key Technical Decisions via the pre-GET snapshot diff — no longer deferred.)

## Implementation Units

- [ ] **Unit 1: Discriminated `listRunApprovals` browser client result**

**Goal:** Reshape the browser `listRunApprovals` wrapper from a bare `readonly ApprovalSummary[]` (which collapses every failure to `[]`) to a discriminated `{success, data?, error?}` return, so the reconcile caller can distinguish a real empty open-set from a failed fetch. This must land before the corrective prune is wired — without it, a failed reconcile would wipe all prompts.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `public/operator-stream.js` (the `listRunApprovals` wrapper ~L915-928; remove the "silently returning [] on failure is correct" comment, which is invalidated by corrective prune)
- Modify: `public/operator-stream.d.ts` (the `ApprovalClient.listRunApprovals` signature ~L224)
- Test: `test/operator-stream.test.ts` (or the browser-client test fixture exercising the wrapper)

**Approach:**
- Return `{success: true, data: {approvals: [...]}}` on a 2xx with a valid `approvals` array; `{success: false, error: {kind, status?}}` on failure. Mirror the sibling shape used by `refreshCsrf` and `decideRunApproval` in the same factory (NOT the app-client `Result<T,E>` — the browser ESM does not import `@bfra.me/es/result`).
- Map failure precisely: network throw → `{kind: 'network'}`; non-2xx → `{kind: 'http', status}`; **200 with missing/non-array `approvals` → `{kind: 'protocol'}`** (a malformed body is neither "nothing open" nor a transient failure — it must NOT be treated as success-empty, or corrective prune would still wipe).

**Execution note:** Test-first — this is the safety contract that prevents the catastrophic wipe.

**Patterns to follow:** `public/operator-stream.js` `refreshCsrf` (~L817) and `decideRunApproval` (~L844) discriminated returns.

**Test scenarios:**
- Happy path: 200 `{approvals:[]}` → `{success:true, data:{approvals:[]}}` (real empty, distinct from failure).
- Happy path: 200 `{approvals:[{requestID,permission}]}` → `{success:true, data:{approvals:[...]}}`.
- Error path: non-2xx → `{success:false, error:{kind:'http', status}}` (never `[]`).
- Error path: fetch throws → `{success:false, error:{kind:'network'}}`.
- Error path: 200 with missing/non-array `approvals` → `{success:false, error:{kind:'protocol'}}` (NOT success-empty).

**Verification:** every failure mode is a `{success:false}` discriminable result; only a real 2xx with a valid array is `success:true`; existing callers updated to the new shape; gates green.

- [ ] **Unit 2: Corrective reconcile reducer action**

**Goal:** Add a pure-reducer action that, given an explicit `pruneIds` list and the recovered open set to add, removes + tombstones the pruned prompts and adds any recovered-but-not-local prompts.

**Requirements:** R1, R2

**Dependencies:** Unit 1 (the client surfaces the recovered set + success signal that the wiring unit converts into `pruneIds`)

**Files:**
- Modify: `public/operator-stream.js` (reducer in `nextStreamState`; add the reconcile action branch; add the `GATEWAY_PENDING_APPROVALS_CAP` constant with a comment-link to the vendored agent source)
- Modify: `public/operator-stream.d.ts` (the new event/action type)
- Test: `test/operator-stream-core.test.ts`

**Approach:**
- The action carries `{runId, addPrompts: [...], pruneIds: string[]}` — the diff is computed by the caller (Unit 3) from the pre-GET snapshot, NOT re-derived in the reducer (this is what makes the race impossible). For the run entry: for each id in `pruneIds` still present in `approvalOpenPrompts`, remove it and add it to `approvalTombstones`, reusing the FIFO cap logic from the settle branch. For each prompt in `addPrompts` not already open and not tombstoned, add it (subsumes the additive path).
- Reducer stays a pure function of its input list — it does not know about truncation/completeness (the caller decides whether to populate `pruneIds` at all). Null-proto maps and `__proto__`-key guarding consistent with existing branches.

**Execution note:** Implement test-first — the reducer is the security-relevant state machine; write the failing prune/no-resurrect tests before the branch.

**Patterns to follow:** the existing settle branch (remove + FIFO-capped tombstone) and open branch (ignore-if-tombstoned) at `public/operator-stream.js` ~L456-500.

**Test scenarios:**
- Happy path: open(A), open(B) → reconcile `pruneIds:[A], addPrompts:[]` → A pruned (absent from `getOpenApprovals`) and tombstoned; B still open.
- Edge case: reconcile `pruneIds:[A,B]` → both pruned + tombstoned.
- Edge case (no-resurrect): A pruned → later open frame for A → A stays suppressed (tombstone precedence).
- Edge case (idempotent settle/prune overlap): A already settled (removed+tombstoned) then `pruneIds:[A]` → no-op, no error, A stays tombstoned (delete-absent is a no-op; re-tombstone is idempotent).
- Edge case: `addPrompts` containing an id already locally open → idempotent (no duplicate, stays open).
- Edge case: empty `pruneIds` and empty `addPrompts` → no-op, no spurious tombstones.

**Verification:** the reducer prunes exactly the ids the caller lists, adds recovered opens, and tombstone precedence prevents resurrection; `operator-stream-core` tests green.

- [ ] **Unit 3: Wire reconcileApprovals — pre-GET diff, truncation guard, fail-closed**

**Goal:** Rewrite `reconcileApprovals` to: snapshot the local open-id set before the GET, dispatch the corrective action only on a successful response, prune only when the recovered set is known-complete, and compute `pruneIds` from the pre-GET snapshot.

**Requirements:** R1, R3, R4

**Dependencies:** Unit 1 (discriminated client), Unit 2 (reducer action)

**Files:**
- Modify: `public/operator-stream.js` (`reconcileApprovals` ~L1380-1411; remove the `reconcile-additive-only` comment)
- Test: `test/operator-stream-core.test.ts` and the browser-client/`reconcileApprovals` test path

**Approach:**
1. **Capture `preGetLocalOpenIds`** (the run's currently-open ids) BEFORE `await listRunApprovals(runId)` — this bounds pruning to prompts open before the snapshot and makes the reconcile-window race impossible (a prompt opening via SSE during the await is never in this set).
2. **On `success:false` → abort:** dispatch nothing (no prune, no add). A failed reconcile must never wipe prompts.
3. **On `success:true`:** validate each recovered summary (existing `requestID`/`permission` checks) → recovered open-id set + add-prompts.
4. **Completeness:** if `recovered.length >= GATEWAY_PENDING_APPROVALS_CAP`, set `pruneIds = []` (truncation guard — additive only). Else `pruneIds = preGetLocalOpenIds ∖ recoveredOpenIds`.
5. Dispatch one `approval-reconcile` action with `{runId, addPrompts, pruneIds}`. Keep the one-shot-per-connect guard (`reconcileDone`).

**Execution note:** Test-first for the failure-vs-empty distinction and the pre-GET diff — the two safety-critical edges.

**Patterns to follow:** the existing `reconcileApprovals` validation loop and `reconcileDone` one-shot guard.

**Test scenarios:**
- Integration (the issue's scenario): open(A) → disconnect → A settles during gap → reconnect, recovery returns a complete set without A → A pruned from the open-set.
- Error path (catastrophic-wipe guard): reconnect, `listRunApprovals` returns `{success:false}` (network/http/protocol) → NO prune, open prompts preserved.
- Race guard: a new open frame for C arrives during the `await` (C not in `preGetLocalOpenIds`) → C is NOT pruned even though it's absent from the recovered snapshot.
- Happy path: recovery returns `[A,B]` while only A was locally open → B added, A retained, nothing pruned.
- Edge case (truncation): recovery returns a set of size ≥ gateway cap → `pruneIds=[]`, additive only.
- Edge case (one-shot + tombstone across reconnects): prune A → reconnect again → a late open frame for A stays suppressed by A's tombstone.

**Verification:** on reconnect the ghost is pruned when the gateway reports it closed, a failed reconcile never wipes prompts, a prompt opening during the GET window is never pruned, and one-shot-per-connect holds; full operator-stream tests green.

## System-Wide Impact

- **Interaction graph:** only the reconnect path of the operator run-stream client and the approval reducer. No change to the SSE frame parser, decision POST, or launch flow.
- **Error propagation:** a failed reconcile GET must remain non-destructive (no prune) — the key new failure-mode guard.
- **State lifecycle risks:** mis-pruning a real open prompt (guarded by the truncation cap + success-vs-failure distinction); tombstone-map growth (reuses the existing FIFO cap).
- **API surface parity:** none — dashboard-side reducer/client only.
- **Unchanged invariants:** the SSE settle-frame path, decision POST gateway-authoritative behavior, terminal-status absorbing, `textContent`-only rendering, and the no-dashboard-proxy 404 invariant are all unchanged. The gateway remains the authority; the dashboard only reflects its reported open-set.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A failed reconcile wrongly prunes all prompts (catastrophic wipe) | The browser `listRunApprovals` is reshaped to a discriminated result (Unit 1); the corrective action dispatches only on `success:true`, never on failure (Unit 3) |
| A genuinely-new prompt opening during the GET window is wrongly pruned (reconcile-window race) | Prune set is computed from the pre-GET local snapshot diff, not the live open-set; prompts arriving during the await are never eligible (Unit 3) |
| A 200 with a malformed body is treated as success-empty and prunes everything | Malformed body → `{kind:'protocol'}` failure, aborts the reconcile (Unit 1) |
| Recovered set truncated at the gateway cap → real open prompt wrongly pruned | Prune only when recovered size < gateway cap (mirrored constant); else additive-only |
| Pruned id later re-opened resurrects a ghost | Pruned ids are tombstoned (requestIDs are non-reused UUIDs); ignore-if-tombstoned suppresses late opens |
| Gateway cap bumped → mirrored constant silently tightens the guard (ghosts persist) | Document the vendored agent source path on `GATEWAY_PENDING_APPROVALS_CAP`; contract pinned to agent v0.76.2 |

## Sources & References

- Issue: fro-bot/dashboard#86 (+ Fro Bot triage with reducer reproduction)
- Related code: `public/operator-stream.js` (reducer + `reconcileApprovals`), `src/gateway/operator-client.ts` (`listRunApprovals`), `test/operator-stream-core.test.ts`
- Gateway contract: `fro-bot/agent` v0.76.2 `packages/gateway/src/web/operator/pending-approvals-route.ts`
- Learning: `docs/solutions/best-practices/operator-approval-channel-consumption-2026-06-22.md`
