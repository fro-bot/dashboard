---
date: 2026-06-26
topic: operator-run-index-demock
---

# Operator Run Index De-Mock Requirements

## Summary

Replace the `/operator` mock skeleton with a real initial run index that helps an operator resume or inspect recent work faster. Recent authorized runs load when the page opens, and the existing launch, stream, and approval clients continue handling live interaction after that first view.

---

## Problem Frame

The operator page was built ahead of the Gateway operator API, so it stayed fixture-only and told operators that live observation was unavailable. Gateway now exposes a read-only run listing for authorized operator sessions, which removes the reason to keep the first screen mocked and lets operators return to existing work without launching something new first.

The risk is not only stale copy. A control surface can accidentally imply broader authority than the operator session has, leak private repository names, or introduce a dashboard-side proxy that bypasses the intended browser-to-Gateway boundary.

---

## Actors

- A1. Operator: opens `/operator`, launches runs, observes status, and responds to approval prompts.
- A2. Dashboard app: serves the authenticated operator shell and static browser clients.
- A3. Gateway operator API: authorizes the operator session and returns read-only run summaries, streams, repositories, and approval prompts.

---

## Key Flows

- F1. Initial run index
  - **Trigger:** A signed-in operator opens `/operator` while the dashboard operator UI flag is enabled and a Gateway operator session is available.
  - **Actors:** A1, A2, A3
  - **Steps:** The dashboard serves the operator shell, the browser client asks Gateway for recent authorized runs, and the page renders those runs as the primary panel above the launch form.
  - **Outcome:** The operator sees current recent activity instead of fixture-only placeholder data.
  - **Covered by:** R1, R2, R3, R4, R5, R6

- F2. Run observation takeover
  - **Trigger:** The operator selects a run card or launches a new run.
  - **Actors:** A1, A3
  - **Steps:** The existing browser stream client attaches to that run, receives live frames, updates status and output, and reconciles open approvals. Once attached, stream state replaces index-derived status for that run.
  - **Outcome:** The run index is only the page-load anchor; live stream data becomes the source for ongoing detail.
  - **Covered by:** R7, R8, R9, R10, R11

- F3. Empty or unavailable run index
  - **Trigger:** Gateway returns no visible runs, the operator lacks access, or Gateway cannot return the list.
  - **Actors:** A1, A3
  - **Steps:** The page renders a safe state that points the operator to retry, launch a new run, or keep using the launch form without revealing whether hidden repos or runs exist.
  - **Outcome:** The UI stays useful without becoming an authorization oracle.
  - **Covered by:** R5, R6, R16, R22, R23, R24

---

## Requirements

**Run index behavior**

- R1. The page must load recent runs visible to the current Gateway operator session when `/operator` opens.
- R2. Run cards must come from Gateway’s operator-safe run summary projection, not dashboard fixtures.
- R3. The run index must treat the returned list as capped and newest-first, with no pagination or load-more behavior in this version.
- R4. The recent-runs panel must be visually primary on first load, with the launch form still immediately available below it.
- R5. Empty, unauthorized, denied, malformed, and unavailable index states must not reveal whether hidden or denied repositories have runs.
- R6. Empty and unavailable states must give the operator a safe next action: retry, launch a new run, or continue with the launch form.

**Live interaction**

- R7. Selecting an existing run must reuse the current live stream path for status, output, and approval updates.
- R8. Launching a new run must continue using the current browser launch flow and must add or select the launched run without requiring a page reload.
- R9. The page-load index must not replace the live stream as the source of ongoing run detail.
- R10. After a stream attaches, stream state must win over index-derived status, ordering, and detail for that run.
- R11. Switching between run cards must close or replace the previous active stream without mixing output or approvals between runs.

**Security and trust boundaries**

- R12. The dashboard must not introduce proxy routes for Gateway operator APIs; only browser clients may call same-origin `/operator/*` Gateway routes.
- R13. The dashboard server must not terminate, forward, mint, broker, or translate Gateway operator credentials.
- R14. The server-rendered operator shell must not fetch live run data or render sensitive fixture/request values.
- R15. Operator copy must distinguish dashboard authentication from Gateway authorization and must remove mock-only/fixture-only wording once real data is wired.
- R16. Rendering, browser state, client errors, console output, telemetry, and operational logs must remain coarse: no prompts, tool arguments, workspace paths, internal URLs, tokens, cookies, CSRF values, or raw private repository names.
- R17. If run-summary data violates the expected safe shape or contains unexpected sensitive fields, the dashboard must fail closed to a neutral unavailable state instead of rendering or logging it.

**Contract alignment**

- R18. The dashboard must consume only the Gateway run-summary contract shape exposed for operator run indexes.
- R19. The dashboard must accept that index summaries expose a narrower status set than live stream updates, and the UI must not invent unavailable status detail from the index alone.
- R20. Missing `updatedAt` values must render cleanly without blank labels or misleading freshness copy.
- R21. Duplicate run IDs or malformed run summaries must be suppressed or collapsed without breaking the rest of the visible index.

**State and interaction semantics**

- R22. The recent-runs panel must have distinct loading, loaded-empty, loaded-with-runs, unavailable, and active-run states.
- R23. Loading state must not imply whether runs exist.
- R24. Unavailable state must be neutral across unauthorized, denied, network, and malformed-response cases.
- R25. Run cards must be keyboard-reachable and must expose the active run and live status updates accessibly.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3, R4.** Given Gateway returns several authorized recent runs, when the operator opens `/operator`, the page shows those runs as the primary recent-run cards above the launch form.
- AE2. **Covers R5, R6, R16, R24.** Given Gateway omits denied or unauthorized repositories, when the index is empty, the page shows a neutral state with a safe next action and does not name or count hidden repositories.
- AE3. **Covers R7, R9, R10, R19.** Given a run card is visible, when the operator selects it, the stream client attaches and later stream frames replace the index-derived status and approval state.
- AE4. **Covers R8.** Given the operator launches a new run successfully, when Gateway returns the new run ID, the page exposes that run through the same card and stream behavior as indexed runs.
- AE5. **Covers R12, R13, R14, R16.** Given the dashboard app is inspected, when `/operator/*` API-like paths are requested from the dashboard server, they are not proxied or forwarded.
- AE6. **Covers R14, R15, R16.** Given the server renders `/operator`, when the HTML and static operator bundles are inspected, they contain no fixture prompt, CSRF, idempotency, token, private repo, or mock-only copy.
- AE7. **Covers R17, R21, R24.** Given Gateway returns malformed or contract-drifted run-summary data, when the browser client parses it, the affected data is suppressed and the UI stays in a neutral unavailable or partial state without logging raw payloads.
- AE8. **Covers R20.** Given a run summary has no `updatedAt`, when its card renders, the page omits the updated timestamp rather than rendering an empty or fake value.
- AE9. **Covers R11, R25.** Given a stream is active, when the operator selects a different run card with the keyboard, focus and live updates move to the new active run without mixing output from the previous run.

---

## Success Criteria

- Operators can open `/operator` and quickly resume or inspect recent authorized runs without launching a new run first.
- The first screen no longer claims live observation is unavailable when Gateway run listing is available.
- Existing launch, stream, and approval behavior still works against the selected or newly launched run.
- The de-mocked page preserves the no-proxy, no-leak, and credential-domain boundaries already enforced by the skeleton.
- Empty and unavailable states give an operator a safe next action without exposing hidden authorization state.
- Planning can proceed without inventing product behavior for empty states, capped lists, or index-vs-stream responsibility.

---

## Scope Boundaries

- No pagination, cursoring, or load-more behavior for the run index.
- No push notifications, background sync, or offline operator actions.
- No dashboard-managed Gateway proxy endpoints.
- No broad redesign of the operator surface beyond the copy and state changes needed to remove fixture-only behavior.
- No search, pinning, or archival run browsing in this version; the run index is a capped recent-activity affordance.
- No shared SDK extraction or broader operator contract refactor.
- No changes to deployment auth or the dedicated infra-only GitHub App follow-up.

---

## Key Decisions

- Browser-direct Gateway calls stay in place: this preserves the existing trust boundary and avoids creating a second operator API surface in the dashboard.
- The run index is page-load state only: the stream remains responsible for live status, output, and approval detail.
- Recent runs are visually primary: the page should optimize for resuming or inspecting current work while keeping launch immediately available.
- Recent terminal runs are included: Gateway returns recent runs, not only in-flight runs, so the page should present the section as recent activity.
- Empty and unavailable states stay non-oracular: the operator can learn that nothing is visible or available, not whether hidden resources exist.

---

## Dependencies / Assumptions

- Gateway issues `fro-bot/agent#1000`, `#1001`, and `#1027` are closed and together unblock the live run index path.
- Gateway’s run index returns operator-safe summaries capped at 100, sorted newest-first by creation time, and filtered through denylist and per-repo authorization before run data is read.
- The dashboard consumes the Gateway operator contract version that includes run summaries; contract pinning and vendoring details belong in the plan.
- Same-origin `/operator/*` routing is owned outside the dashboard app. The dashboard app must keep its own API surface absent for Gateway operator routes.
- Environments with pre-redaction-gate bindings may need Gateway’s deny-key backfill before the index shows legacy runs.
- The current browser launch, stream, and approval clients remain the interaction layer after the initial index renders.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R5, R6, R24][UX copy] What exact empty and unavailable state copy best avoids implying whether hidden repos or runs exist?
- [Affects R18, R19][Technical] What contract boundary needs to exist in the dashboard for the run-summary surface without importing upstream internals?

---

## Sources / Research

- `src/routes/operator.ts` — current fixture-backed operator shell and mock-only copy.
- `src/gateway/operator-client.ts` — typed Gateway client boundary and no-proxy path validation.
- `public/operator-launch.js` — existing browser launch flow.
- `public/operator-stream.js` — existing stream, output, and approval reconciliation flow.
- `test/operator-ui.test.ts` — SSR no-leak, no-network, and no-dashboard-proxy invariants.
- `test/operator-contract-conformance.test.ts` — current contract pinning pattern.
- `docs/solutions/security-issues/operator-ui-mock-only-skeleton-pattern-2026-06-18.md` — skeleton security constraints to preserve while de-mocking.
- `fro-bot/agent` `packages/gateway/src/operator-contract/run-summary.ts` — Gateway run summary projection.
- `fro-bot/agent` `packages/gateway/src/web/operator/runs-route.ts` — Gateway run index behavior and security gates.
