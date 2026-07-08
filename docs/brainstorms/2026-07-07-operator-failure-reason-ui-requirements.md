---
date: 2026-07-07
topic: operator-failure-reason-ui
---

# Operator Failure Reason UI

## Summary

Add operator-safe failure reasons to the shipped run-centric PWA. Failed run rows and expanded stream details should show dashboard-owned labels for known Gateway reason codes, while missing or unknown reasons stay generic and never expose internal error detail.

---

## Problem Frame

The dashboard currently renders failed operator runs as a generic failed state. That was safe when the Gateway contract exposed only status, but it leaves the operator blind when failures are actionable, such as a run ending because no activity arrived within the inactivity window.

Gateway now exposes an operator-safe failure reason code in contract `1.6.0`. The dashboard still vendors contract `1.5.0`, so it neither accepts nor renders that failure context. Operators can see that a run failed, but not whether the failure was a timeout, stream interruption, workspace reachability problem, session error, or an intentionally generic unknown reason.

This document uses **reason code** for the Gateway contract value and **display label** for the dashboard-owned text shown to the operator. Reason codes are data; display labels are UI copy.

---

## Actors

- A1. Operator: the authenticated human using the run-centric PWA to launch, observe, approve, and diagnose runs.
- A2. Gateway: the same-origin authority for operator sessions, run summaries, stream frames, and safe failure projection.
- A3. Agent run output: untrusted streamed text that must remain inert and separate from trusted status copy.

---

## Key Flows

- F1. Failed run in the recent list
  - **Trigger:** Operator opens `/` and the recent-runs list includes a failed run with a known reason code.
  - **Actors:** A1, A2
  - **Steps:** The run list loads, the failed row renders its status, and the row shows a concise display label from the dashboard allowlist.
  - **Outcome:** The operator can distinguish broad failure classes without opening logs or seeing internal error detail.
  - **Covered by:** R1, R2, R6, R7, R10, R14

- F2. Failed active stream
  - **Trigger:** An observed run receives a terminal failed status while expanded.
  - **Actors:** A1, A2, A3
  - **Steps:** The stream status updates, live output remains inert, and the expanded run shows the same display label used by the row.
  - **Outcome:** The operator sees why the run failed without losing the final output already rendered.
  - **Covered by:** R1, R3, R7, R12, R16

- F3. Unknown or absent failure reason
  - **Trigger:** Gateway omits the reason code, sends a reason code for a non-failed run, or sends a reason code the dashboard does not recognize.
  - **Actors:** A1, A2
  - **Steps:** The dashboard keeps the status visible but suppresses the raw reason code.
  - **Outcome:** Unknown data stays generic rather than leaking or inventing detail.
  - **Covered by:** R6, R8, R9, R11

---

## Requirements

**Contract alignment**

- R1. The dashboard must consume Gateway operator contract `1.6.0` in both the vendored TypeScript contract and the browser stream runtime, with the contract pins kept in lockstep.
- R2. The run-summary model must accept the Gateway's optional operator-safe reason code for failed recent runs.
- R3. The stream status model must accept the same optional operator-safe reason code for failed status frames.
- R4. The dashboard must accept the additive `blocked` and `waiting_for_approval` web statuses introduced by the current Gateway contract as compatibility work, without changing the slice into a status-redesign feature.
- R5. Mixed-version contract consumers must fail closed at the parse boundary instead of rendering partial status or reason data.

**Failure reason rendering**

- R6. Display labels must come from a dashboard-owned allowlist keyed by known reason codes, not from raw wire values or internal Gateway error text.
- R7. Failed run rows and expanded failed stream details must render the same display label for the same reason code.
- R8. Failed runs with missing or unknown reason codes must render the generic failed state and must not surface the raw reason code.
- R9. Non-failed runs carrying any reason code must ignore the reason and render normal status.
- R10. Failure labels must not imply hidden repository existence, authorization cause, workspace path, prompt content, tool arguments, session IDs, tokens, or internal URLs.
- R11. Only known reason codes may enter persistent UI state; raw failure payloads must not be stored in component state, renderable props, DOM attributes, cache entries, console output, or logs.

**State and interaction**

- R12. Existing final output must remain visible when a run terminalizes as failed with a known reason code.
- R13. Reason display must work for page-load recent runs and live streams without requiring a refresh.
- R14. Compact rows must place the failure label as secondary status metadata; expanded details must show it near the status before output.
- R15. Failure labels must stay short enough for compact rows, wrap safely on narrow screens, and not displace core run metadata.
- R16. Assistive technology must receive the reason when a live stream terminalizes as failed, without duplicating announcements on static page-load rows.
- R17. Contract-version mismatch remains fail-closed: the dashboard must not render status or failure data from an incompatible stream.

**Verification and observability**

- R18. Verification must prove the reason renders through the assembled run-centric surface, not only through isolated parsers.
- R19. Fixture coverage must include a recent failed row with a known reason, a live stream terminalizing as failed with the same known reason, an unknown reason, a missing reason, and a non-failed status carrying an ignored reason.
- R20. No browser console output, server log, DOM attribute, cache entry, rendered text, component state, or renderable prop may include raw failure payloads or internal error names.

---

## Failure Reason Matrix

Known reason codes map to these display labels. Planning may tune exact microcopy, but it must preserve the category meanings and length budget.

| Gateway reason code | Display label | Applies when |
|---|---|---|
| `inactivity-timeout` | No recent activity | Failed run only |
| `max-duration-timeout` | Run timed out | Failed run only |
| `stream-ended` | Stream ended early | Failed run only |
| `workspace-unreachable` | Workspace unavailable | Failed run only |
| `session-error` | Session error | Failed run only |
| `unknown` | Unknown failure | Failed run only |
| missing or unrecognized | Failed | Failed run fallback |
| any reason on non-failed status | none | Ignored |

---

## Acceptance Examples

- AE1. **Covers R2, R6, R7.** Given a recent failed run with `inactivity-timeout`, when the operator opens `/`, the row shows Failed plus the dashboard-owned label `No recent activity`.
- AE2. **Covers R3, R7, R12, R16.** Given an expanded run with visible output, when the stream terminalizes as failed with `inactivity-timeout`, the output remains visible and the expanded run announces and shows `No recent activity`.
- AE3. **Covers R6, R8, R20.** Given a failed status with an unknown reason code, when the dashboard renders the run, the UI shows the generic failed state and does not expose the raw code anywhere observable.
- AE4. **Covers R9, R13.** Given a non-failed run that carries a reason code, when the dashboard renders the run, the reason is ignored and normal status rendering wins.
- AE5. **Covers R5, R17.** Given a stream whose ready frame advertises an incompatible contract version, when later frames include status and reason data, the dashboard shows contract drift and renders none of that run data.

---

## Success Criteria

- Operators can distinguish timeout-style and stream/workspace/session failure categories from generic failed runs without opening Gateway logs.
- Unknown or missing reasons remain safe and boring rather than becoming a new leak surface.
- Planning can implement the slice without inventing product copy, scope boundaries, or contract behavior.
- The assembled fixture/browser check catches reason rendering in the actual run-centric PWA.

---

## Scope Boundaries

- Do not change Gateway timeout behavior or retry policy.
- Do not expose raw internal Gateway error messages or run-core error names.
- Do not add dashboard proxy routes for operator run data.
- Do not add push notifications, background sync, or persistent local run storage.
- Do not redesign the run-centric layout; this is an additive failed-state slice.
- Do not solve server-side logout invalidation in this work.

---

## Key Decisions

- **Field-level fail-closed behavior:** Unknown reason codes degrade to generic failed copy instead of dropping the whole run, because the status itself remains a valid operator-safe field.
- **Copy owned by dashboard:** The Gateway supplies a safe reason code; the dashboard supplies user-facing language so copy can stay consistent across row and expanded states.
- **One failure language across sources:** Recent-run summaries and live stream statuses use the same reason labels to avoid contradictory diagnosis for the same run.
- **Status compatibility is included:** The contract bump includes additive non-failed statuses; accepting them is compatibility work, not a new status-design project.

---

## Dependencies / Assumptions

- Gateway operator contract `1.6.0` is released and deployed in the active Gateway version.
- Gateway failure reasons are already allowlisted before reaching the dashboard contract.
- The existing run-centric PWA remains the active operator surface at `/`.
- The local fixture harness can add failure-reason scenarios without using live Gateway data.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R6, R7][Product copy] Tune the exact dashboard labels while preserving the matrix meanings and compact-row length budget.
- [Affects R18, R19][Verification] Decide whether to extend existing fixture scenarios or add a dedicated failed-reason scenario.

---

## Sources / Research

- `docs/brainstorms/2026-07-03-001-operator-home-run-centric-redesign-requirements.md`
- `docs/brainstorms/2026-06-20-002-feat-operator-run-stream-sse-consumer-requirements.md`
- `docs/brainstorms/2026-06-26-001-operator-run-index-demock-requirements.md`
- `src/gateway/operator-contract/version.ts`
- `src/gateway/operator-contract/run-status.ts`
- `src/gateway/operator-contract/run-summary.ts`
- `public/operator-stream.js`
- `public/operator-run-index.js`
- `web/src/operator/runtime.ts`
- `packages/gateway/src/operator-contract/version.ts` in `fro-bot/agent`
- `packages/gateway/src/operator-contract/run-status.ts` in `fro-bot/agent`
- `packages/gateway/src/operator-contract/run-summary.ts` in `fro-bot/agent`
- https://github.com/fro-bot/agent/issues/1099
