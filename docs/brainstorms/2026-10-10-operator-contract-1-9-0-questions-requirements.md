---
date: 2026-10-10
topic: operator-contract-1-9-0-questions
---

# Operator contract 1.9.0: agent questions on the dashboard

## Summary

The dashboard adopts gateway operator contract 1.9.0. When an agent asks a question, it appears on the run card and the operator answers or skips it there. The run shows that it is waiting for an answer (`waiting_for_question`), and a question push notification arrives. A completed run whose output has expired says its output is no longer available, instead of hanging on "Connecting…". This release ships in the same infra deploy that moves the gateway to a 1.9.0 release.

---

## Problem Frame

In production today the gateway ignores questions from OpenCode's question tool. A run that asks one hangs until the inactivity timeout and fails (fro-bot/agent#1736). The gateway fix (fro-bot/agent#1749, first released in `v0.119.0`) passes questions to operators at contract 1.9.0. Discord renders only a single question with up to 25 options and links every other shape to the web surface, so most questions can only be answered on the dashboard.

The dashboard pins the contract version by exact match and fails closed, so the gateway cannot deploy 1.9.0 until the dashboard supports it. agent#1749 says this outright: "do not deploy this gateway until fro-bot/dashboard ships 1.9.0 support. That release must render question and answer strings as inert text."

Expanding an older run already leaves "Connecting to run stream…" on screen indefinitely on gateway `v0.118.2` (fro-bot/dashboard#583). The client does not recover from the stream's `reset` (`no-snapshot`). The 1.9.0 gateway changes what follows that `reset` for a completed run: it now sends the terminal status and no output frame. The fix is needed for both gateway versions.

---

## Actors

- A1. Operator: watches runs on the dashboard, and answers or skips agent questions.
- A2. Agent run: asks one or more questions and waits; continues when answered, skipped, or past its deadline.
- A3. Gateway: delivers questions to the dashboard, accepts one decision per request, and settles the request for every surface.
- A4. Other surfaces: Discord or another dashboard session, which can settle the same request first.

---

## Key Flows

- F1. Answer a question
  - **Trigger:** A running run asks a question while the operator has the run card open, or the operator opens the card later.
  - **Actors:** A1, A2, A3
  - **Steps:** The run shows `waiting_for_question`, and the card shows the questions. The operator answers every question, then submits once. The question clears when the gateway settles it.
  - **Outcome:** The agent continues with the answer.
  - **Escape:** The card responds to whatever the gateway reports (R10). It keeps the question while another surface's answer is still in flight. It clears the question with a neutral note if another surface already answered. It keeps the operator's input on any failure.
  - **Covered by:** R3, R4, R5, R6, R7, R9, R10, R11, R12

- F2. Skip a question
  - **Trigger:** The operator does not want to answer.
  - **Actors:** A1, A2, A3
  - **Steps:** The operator chooses Skip. It submits immediately and discards anything already typed or selected.
  - **Outcome:** The agent continues without an answer.
  - **Covered by:** R8, R9, R10

- F3. Open an older completed run
  - **Trigger:** The operator expands a run that finished after its output expired from the gateway.
  - **Actors:** A1, A3
  - **Steps:** The stream reports that no snapshot exists and sends the run's terminal status.
  - **Outcome:** The card shows the terminal status and an "output no longer available" state, with no connection notice.
  - **Covered by:** R14, R15

---

## Requirements

**Contract adoption**
- R1. Every dashboard consumer that pins the contract accepts exactly 1.9.0 and keeps failing closed on any other version.
- R2. The dashboard's vendored contract carries the 1.9.0 question surface and the `waiting_for_question` status.

**Showing questions**
- R3. The expanded run card shows a pending question request. For each question it shows the header, the text, each option's label and description, and whether multiple choices and free text are allowed. Each question is a labelled group. Single-choice options behave as radio buttons and multiple-choice options as checkboxes. A newly arrived question is announced politely and does not take focus.
- R4. A request with several questions shows them all, in request order, and is answered in one submission.
- R5. A pending question appears both when it arrives live and when the operator opens or reopens a run that already has one pending. When the operator opens a run, or the stream resets, the gateway's pending-question list replaces the card's question set. Live frames and the list are deduplicated by request ID.
- R6. A settled request is removed from the card and never reappears. Settlement arrives as a settle frame, from any surface or the deadline. A run reaching a terminal status also clears its questions, because the gateway sends no settle frame for them. The dashboard remembers settled request IDs for the life of the page, so a late pending-question list cannot re-add one.

**Answering**
- R7. The operator answers each question by choosing one option, or several when multiple is allowed, and/or typing free text when free text is allowed. Options are identified by their position in the question, not by their label. One answer is sent per question, in request order.
- R8. Submit unlocks only when every answerable question has an answer. A question with no options and no free text cannot be answered and is sent unanswered. Skip covers the whole request: it submits immediately, without a confirmation step, and discards anything typed or selected.
- R9. While a submission is in flight, its controls are disabled, so one decision cannot be sent twice.
- R10. The card's outcome follows the gateway's reported decision state, not the HTTP status:
  - `claimed`: the question clears when its settle frame arrives.
  - `already_settled`: a neutral "answered elsewhere" note, then the question clears.
  - `already_claimed`: the question stays, with a neutral "being answered elsewhere" note. The gateway reopens the request if that other answer fails.
  - `failed_to_settle`: a retryable error.
  - Invalid answer: a retryable error on the question the gateway names, or on the whole request when it names none.
  - Masked not-found: the controls are removed, as in the approval flow's can't-approve state.

  The card shows only dashboard-written copy and never gateway response text. The operator's input survives every failure.
- R11. Free text is held to the gateway's 4,000 UTF-16 code-unit limit before submission. Text that is empty after trimming counts as no free-text answer.

**Status and notifications**
- R12. A running run with at least one open question on the card shows `waiting_for_question`, derived the same way the dashboard derives `waiting_for_approval` from open approvals. A pending approval takes precedence over a question, and a terminal status always wins. The status has its own label everywhere the dashboard labels stream statuses.
- R13. A question push notification is accepted, shown with fixed dashboard copy, and opens the dashboard. The payload carries no run identifier and never any question or answer content.

**Expired output (#583)**
- R14. A completed run whose output has expired shows its terminal status and an in-card "output no longer available" state, with no page-level connection notice.
- R15. A running run that receives `no-snapshot` keeps accepting status and output frames as they arrive.

**Text safety and privacy**
- R16. All question and answer text renders as inert plain text, never as HTML, Markdown, or links. Control and bidi characters are removed.
- R17. Question and answer text is kept only in in-memory browser state. It never reaches storage, caches, URLs, element attributes or class names, the console, push payloads, or logs.

---

## Acceptance Examples

- AE1. **Covers R4, R7, R8.** Given a request with two questions, one single-choice and one allowing several choices plus free text: the operator picks one option for the first and two options plus a note for the second. Submit unlocks only after both questions have an answer. One submission is sent, with the answers in order.
- AE2. **Covers R6, R10.** Given a question the operator has open: when it is answered in Discord first, the card shows a neutral "answered elsewhere" note, then clears the question. The question does not come back on later frames or from a later pending-question list.
- AE3. **Covers R10.** Given an operator who submits while another session's answer is still in flight: the gateway reports `already_claimed`, and the card keeps the question with a neutral note. If the other answer then fails and the request reopens, the operator can answer it.
- AE4. **Covers R5.** Given a run with a pending question: when the operator reloads the page and expands the run, the question appears without waiting for a new live frame.
- AE5. **Covers R6, R12.** Given a run waiting on a question: when the run fails, the card shows the failed status and the question disappears, though no settle frame arrived.
- AE6. **Covers R10.** Given an answer the gateway rejects as invalid for question 2: the card marks question 2, keeps the operator's other answers, and allows resubmitting.
- AE7. **Covers R13.** Given a question notification on a locked phone: the notification shows fixed copy with no question text, and tapping it opens the dashboard.
- AE8. **Covers R14.** Given a run that succeeded an hour ago, followed by a gateway restart: when the operator expands it, the card shows "Succeeded" and "output no longer available", and the page shows no "Connecting…" notice.
- AE9. **Covers R15.** Given a running run whose stream gets `no-snapshot`: when the next status and output frames arrive, the card renders them.
- AE10. **Covers R16, R17.** Given a question whose text contains HTML tags, a Markdown link, and bidi control characters: the card shows the tags and the link as literal text, with the controls removed. The text appears nowhere outside the card's text nodes.

---

## Success Criteria

- After the joint deploy, an operator answers a question-producing run from the dashboard and the run continues. A skipped question also lets the run continue.
- Opening an older completed run never leaves "Connecting…" on screen.
- #3512 credits the question surface only after these live checks pass in production: a question opens, it is answered and skipped, it is settled elsewhere, a run ends with a question pending, and an expired completed run shows its unavailable state.
- A planner can build this from the doc without inventing operator behavior. Fixture scenarios mirror the `v0.119.x` producer's actual frame and response shapes, including the status behavior in R12. They cover every question shape and every decision outcome.

---

## Scope Boundaries

- Run-card defects #584 (leftover Cancel controls), #585 (timestamps and waiting state), and #586 (Markdown run output) stay separate.
- No answer history: a settled question leaves no record on the card.
- No rejection or cancellation of a question from the dashboard. The contract offers only answer and skip.
- No deep link from a notification to a specific run. The payload carries none.
- No change to the approval flow.
- The infra deploy itself is coordinated in marcusrbrown/infra.

---

## Key Decisions

- **Every question shape is handled on the dashboard.** Discord sends every shape it can't render to the web surface, so nothing else can display them.
- **Every answerable question must be answered before submitting.** The gateway accepts blanks, but a blank looks the same as a skip to the agent. Requiring answers prevents accidental omissions. Skip remains the explicit way to decline.
- **Settled questions clear, as approvals do.** This matches the approval flow and keeps answer text off the card once a request is done.
- **Skip needs no confirmation.** Skipping lets the agent continue; it does not end the run. Discarding typed text on Skip is an accepted cost.
- **The waiting status comes from the card's open questions.** The gateway applies `waiting_for_question` to status frames only at lifecycle transitions, so the dashboard derives it as it already derives `waiting_for_approval`.
- **Question text follows the same rules as checkout detail and approval action text.** It stays in memory and is rendered as text nodes only, because the contract marks every string as untrusted.
- **#583 ships with 1.9.0.** The hang already happens on `v0.118.2`, and 1.9.0 changes the frames that follow `reset`. Fixing it now means one change covers both gateway versions.
- **Follow the approval pattern.** Open and settle frames, run state, a CSRF-guarded single-use decision, and an allowlisted push kind are already proven there.

---

## Dependencies / Assumptions

- Requires a gateway release carrying contract 1.9.0 (`v0.119.0` or later). Production runs `v0.118.2` on 1.8.0.
- Exact-match pinning means the dashboard release and the gateway pin move in the same infra deploy. A 1.9.0 dashboard against a 1.8.0 gateway drops every stream. The cutover and paired rollback belong to infra, as they did for 1.8.0. A browser tab still running the old dashboard fails closed until it reloads.
- The gateway enforces one decision per request, the 64 KiB body limit, and the free-text limit. The dashboard mirrors only the free-text limit, for usability. Enforcement stays with the gateway.
- Answering requires write-level repository access on the gateway. An operator with read access sees questions, but submitting returns the gateway's masked not-found response.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R12][Technical] Can the run list's data ever carry `waiting_for_question`? If it can, collapsed cards show a waiting cue. If it cannot, no new mechanism is added for one.
- [Affects R16][Technical] Can the checkout-detail sanitizer be reused for question text? No dashboard length caps beyond the gateway's bounds are planned.
- [Affects R10, R13][Technical] Exact copy for the decision outcomes and the question notification.
- [Affects R3, R7][Design] Layout of the question region on the run card, including several questions with long option lists at mobile width. Route to @designer and verify on the fixture server.

---

## Sources / Research

- fro-bot/agent#1749 and fro-bot/agent#1736: the question bridge and its deployment gate.
- fro-bot/agent `v0.119.0`, `packages/gateway/src/operator-contract/question-frame.ts`: frame, request, and decision types; the inert-text rule.
- fro-bot/agent `v0.119.0`, `packages/gateway/src/operator-contract/output.ts`: `no-snapshot` followed by terminal status only.
- fro-bot/agent `v0.119.1`, `packages/gateway/src/web/sse/manager.ts` (`observeQuestion`, terminal clearing of open questions) and `projection.ts` (`overlayWaitingStatus`): status overlay only at lifecycle transitions.
- fro-bot/agent `v0.119.0`, `packages/gateway/src/web/operator/question-decision-route.ts`, `question-choices.ts`, and `pending-questions-route.ts`: decision states, index-based options, and the reconnect list.
- fro-bot/agent `v0.119.0`, `packages/gateway/src/web/operator-push/payload-builder.ts`: the `question` push kind with fixed copy and no run identifier.
- fro-bot/dashboard#583: expired-snapshot behavior and the expected fix.
- fro-bot/.github#3512: rollout tracker.
- `docs/solutions/best-practices/consume-gateway-operator-contract-1-8-0-2026-10-07.md`: how the dashboard adopts a contract bump.
- Approval flow in `public/operator-stream.js` (`hasOpenApprovals`), `web/src/operator/runtime.ts`, and `web/src/push/sw-notification.ts`: the pattern to follow.
