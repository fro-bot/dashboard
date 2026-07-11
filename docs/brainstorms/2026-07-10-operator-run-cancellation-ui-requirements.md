---
date: 2026-07-10
topic: operator-run-cancellation-ui
---

# Operator Run Cancellation UI

## Summary

Add a Cancel control to active operator runs that stops a run mid-flight through
the gateway's cancel endpoint. The operator clicks Cancel, confirms inline, and
the run view reflects the phase the gateway returns — including graceful handling
when the run is already terminal or the gateway asks to retry.

---

## Problem Frame

The gateway shipped run cancellation in operator contract 1.6.0, but the dashboard
consumes none of it. An operator who launches a run that goes wrong — a runaway
loop, a wrong target, an agent stuck in an unproductive path — has no way to stop
it from the dashboard. Their only recourse is to wait for the run to time out or
to act outside the operator surface entirely.

This is the last unshipped half of issue #179; the sanitized failure-reason half
already shipped. The capability exists end-to-end on the gateway and the deployed
gateway already speaks it — the gap is purely the dashboard UI.

---

## Actors

- A1. Operator: the authenticated single operator who launches and observes runs,
  and who decides to cancel one.
- A2. Gateway: owns run lifecycle and the cancel endpoint; returns the authoritative
  resulting phase, or a transient-retry / not-found signal.

---

## Requirements

**Cancel control**
- R1. Render a Cancel control on operator runs that are not in a terminal phase,
  on both the run-index list rows and the expanded run/stream view.
- R2. Hide or disable the Cancel control once a run has reached a terminal phase.
- R3. Guard the control with an inline two-step confirmation: the first interaction
  arms a confirm affordance in place, and only the confirming interaction issues
  the cancel. Provide a way to dismiss the armed state without cancelling.
- R4. The Cancel control and its armed, pending, and outcome states are
  keyboard-operable and announced to assistive technology: accessible name, focus
  management when arming and dismissing, and a status announcement for the pending,
  retrying, cancelled, and unavailable outcomes.

**Cancel request and outcome**
- R5. On confirm, issue the cancel request and reflect the resulting phase the
  gateway returns — whether the run transitioned to cancelled or was already
  terminal — without assuming success.
- R6. When the run is already terminal at cancel time, treat the outcome as a
  benign, honest result (the run is stopped), not an error.
- R7. When the gateway signals a transient retry, surface a distinct "retrying"
  state and retry within bounds: honor the gateway's retry guidance, stop once the
  run becomes terminal from any source, and fall to an honest unavailable state
  after a bounded number of attempts rather than retrying indefinitely.
- R8. When the run is not found, distinguish a run already absent from the current
  index/stream (mark the row stale or remove it) from a previously observed run that
  became unreachable (show an unavailable state), without leaking internal detail in
  either case.
- R9. Show a pending state on the control while a cancel is in flight, and prevent
  a second concurrent cancel for the same run.
- R10. When the live run stream marks a run terminal while a cancel is in flight, the
  stream's terminal state wins: abort the pending cancel or retry, fold any late
  cancel response into the current terminal state, and do not re-arm or re-open the
  control.

**Safety and consistency**
- R11. Issue the cancel as a direct same-origin browser call routed to the gateway by
  the reverse proxy; the dashboard does not proxy the cancel or forward credentials
  server-side.
- R12. The cancel request carries the same request-integrity posture as other
  mutating operator actions (CSRF and idempotency), and reuses the idempotency key
  across any retry of the same logical cancel.
- R13. Render cancel outcomes from a fixed allowlisted set of states (cancelled,
  already-terminal, retrying, unavailable) — never a raw gateway phase, wire string,
  run internal, or unsanitized error text in the DOM.

---

## Acceptance Examples

- AE1. Covers R1, R2, R3, R4. Given an active run, when the operator clicks Cancel,
  the control arms an inline confirm reachable by keyboard; when they confirm, the
  cancel is issued; a terminal run shows no actionable Cancel control.
- AE2. Covers R5, R6. Given the gateway returns an already-terminal phase, when the
  cancel resolves, the run view shows the run stopped without an error state.
- AE3. Covers R7. Given the gateway signals a transient retry, when the cancel is in
  flight, the control shows a retrying state, does not present success until a
  terminal/cancelled phase is confirmed, and stops after a bounded number of attempts.
- AE4. Covers R8. Given the run is not found, when the cancel resolves, a row already
  absent from the index/stream is marked stale or removed, while a previously observed
  run shows an unavailable state — neither leaking internal detail.
- AE5. Covers R9. Given a cancel is already in flight for a run, when the operator
  interacts with the control again, no second concurrent cancel is issued.
- AE6. Covers R10. Given a cancel is in flight, when the live stream marks the run
  terminal, the control resolves to that terminal state without re-arming, and a late
  cancel response does not reopen it.

---

## Success Criteria

- An operator can stop an active run from the dashboard and see an honest, correct
  reflection of what happened.
- A misclick cannot cancel a run — the inline confirm is a required second step.
- The control resolves to a single deterministic state when a cancel and a live
  stream terminalization race, with no flicker or re-arm.
- The assembled operator page (index rows and expanded stream view) is verified to
  render and drive the control against realistic run data, not just unit fixtures.
- Downstream planning has an unambiguous response-contract mapping (cancelled /
  already-terminal / retry / not-found) and no product behavior left to invent.

---

## Scope Boundaries

- Bulk or multi-run cancellation — single-run only for v1.
- Any new confirmation-modal system — the confirm reuses the existing inline in-card
  interaction pattern; no modal infrastructure.
- Pause/resume or other run-lifecycle controls beyond cancel.
- Changes to the failure-reason rendering already shipped in #174.

---

## Key Decisions

- Inline two-step confirm over one-click or an undo window: cancelling stops an
  agent mid-run, so a misclick guard is warranted; the inline two-step mirrors the
  existing approval-confirm interaction operators already know, and avoids modal or
  timer machinery.
- Honest phase reflection over optimistic success: the gateway returns the resulting
  phase precisely so the dashboard can render whether the run actually transitioned;
  the UI renders that phase rather than assuming cancellation succeeded.
- Cancel appears on both the run-index rows and the expanded stream view, because
  both surfaces render active runs and an operator may act from either.
- Live stream terminal state wins over an in-flight cancel: the run's real lifecycle
  is authoritative, so a stream terminalization aborts the cancel/retry and the late
  cancel response is folded in, never used to re-open the control. This keeps the
  control's state machine deterministic in the race the operator is most likely to hit.

---

## Dependencies / Assumptions

- The deployed gateway speaks operator contract 1.6.0 and serves the cancel endpoint
  (already true; the dashboard pins 1.6.0). Same-origin `/operator/*` routing to the
  gateway is owned by the reverse proxy, consistent with the existing operator
  surfaces — the dashboard does not proxy the cancel call server-side.
- The cancel response type and a client method are not yet present on the dashboard
  side — the vendored contract defines only the generic ok/error shapes, and the
  operator client has no cancel method. Both must be added alongside this work,
  mirroring the existing mutating-action client pattern; this is the first
  implementation prerequisite, before any UI.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R3][Technical] Exact placement and markup of the Cancel control within
  the existing run-card structure, and how the armed confirm state is represented in
  the safe-DOM renderer.
- [Affects R7][Technical] The precise retry bound (max attempts or elapsed-time cap)
  and delay source for the transient-retry signal, mirrored from how the gateway
  documents its `Retry-After`.
- [Affects Success Criteria][Technical] The dev fixture harness has no cancel route, so
  assembled-page verification needs a fixture cancel path that can exercise the
  cancelled, already-terminal, retry, and not-found outcomes.
