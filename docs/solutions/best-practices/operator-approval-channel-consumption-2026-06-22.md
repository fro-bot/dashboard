---
title: Consuming the gateway operator approval channel safely in a read-only dashboard
date: 2026-06-22
last_updated: 2026-10-13
category: best-practices
module: dashboard
component: authentication
problem_type: best_practice
severity: medium
applies_when:
  - Consuming a browser-facing approval channel delivered as discriminated settle/open SSE frames
  - You need tombstone and precedence handling for late, duplicate, or out-of-order approval frames
  - The client must distinguish denial, transport failure, already-settled, and session-expired outcomes
  - Gated-action strings originate from an agent and must render as inert text, not HTML
  - A read-only surface gains its first bounded mutating capability
tags: [operator, approval-channel, sse, contract-version, same-origin, textcontent, csrf, fail-closed]
---

# Consuming the gateway operator approval channel safely in a read-only dashboard

## Context

The dashboard is read-only-by-construction for repository data, but it grew one bounded
mutating capability: an operator watching a run can approve or reject the tool gates the
agent hits. The gateway owns the decision (it is authoritative and rejects late or
duplicate decisions); the dashboard renders the open gate, takes the operator's choice,
and keeps prompt state correct across settlement, reconnect, and read-only operators. The
prompt arrives over the same run-stream SSE as `event: approval`; decisions go back over
per-run REST routes. The hard parts are not the auth or the wire shape — they are the
**state races** and the **failure-class honesty**.

This extends the SSE-consumption pattern (see
[authenticated-sse-consumption-fetch-stream-no-leak](./authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md)
and [operator-sse-output-consumption](./operator-sse-output-consumption-2026-06-22.md))
from passive observation to an interactive decision loop.

## Guidance

### 1. Model settlement as a discriminated frame, and tombstone settled IDs

The approval frame is a discriminated union on `settled`:

```ts
interface OperatorApprovalFrameOpen   { readonly runId: string; readonly requestID: string; readonly permission: string; readonly command?: string; readonly filepath?: string; readonly settled: false }
interface OperatorApprovalFrameSettle { readonly runId: string; readonly requestID: string; readonly settled: true }
type OperatorApprovalFrame = OperatorApprovalFrameOpen | OperatorApprovalFrameSettle
```

The frames are wire-immutable (`readonly` throughout) and discriminated on `settled`.

A settle frame carries **no reason** — it does not say *why* the gate resolved (operator
decision, deadline, sibling cascade, or run teardown all produce the same settle). So the
consumer must not caption the dismissal; it dismisses silently and **tombstones the
`requestID`**. The tombstone is what makes the races safe:

- **open-after-settle** (a late or duplicate open frame for an already-settled id) → ignored.
- **settle-before-open** (settle arrives for an id never opened) → still tombstone it, so the subsequent open is ignored.
- **terminal-absorbing** — when the run reaches a terminal status, clear all open prompts (a gate cannot outlive its run), but keep the tombstones.

### 2. Bound the maps — a stream is untrusted input

A long-lived or hostile stream can emit unbounded distinct ids. Both approval maps
(open prompts and tombstones) need caps with deterministic eviction (FIFO for tombstones,
`MAX_APPROVAL_TOMBSTONES`; reject new opens past the cap rather than evicting a real pending
prompt). Question tombstones are the deliberate exception: they are unbounded for the page
lifetime, because evicting one would let a pending list re-add a settled question. The
open-question map is capped (`MAX_OPEN_QUESTIONS`, 50) and rejects excess opens; a list at the
gateway's pending cap (`GATEWAY_PENDING_QUESTIONS_CAP`) is additive only. This is the same
discipline the output channel applies to accumulated text — treat every per-id structure
fed from the wire as attacker-influenceable.

### 3. Optimistic affordance, honest failure classes

The gateway gives the client **no capability signal** — a read-only operator and an
authorized one are indistinguishable until a decision is attempted (denials are uniform
404s). So show the decide controls whenever a prompt is open (optimistic), and make the
*response* tell the truth by splitting it into distinct states:

| Outcome | Signal | UI state |
| --- | --- | --- |
| Not authorized | HTTP 404 on the decision POST | generic "you may not have approval access" |
| Transport failure | fetch threw / network | retryable "didn't go through" — **never** read as a denial |
| Already settled | decision state (`already_claimed`/`unavailable`/`scope_mismatch`) | inline "already settled" / scope-mismatch notice |
| Settle failed | decision state (`failed_to_settle`) | retryable — maps to the transport-failure path |
| Session expired | **400/401/403 on the CSRF refresh that precedes the POST** (or a persistent 400 after one retry) | "reload to approve" — not a retry loop |

The session-expired case is the subtle one: the decision POST is preceded by a CSRF
refresh, and a `401/403` *there* must propagate as an HTTP/session failure, not collapse
into the retryable transport class — otherwise an expired operator loops forever on "try
again" instead of being told to reload.

### 4. Render the gated action as inert text

The open frame's `command`/`filepath` is the actual agent tool call — attacker-influenceable
content. Render it with `textContent` only, in a demarcated block; never interpolate it as
HTML. Client-built DOM does not get the SSR auto-escaping, so this is a hard rule — and
`textContent` is the right choice precisely because it nullifies both HTML injection and
auto-linkification. The reducer stores the raw string verbatim (a test pins this for
HTML/script payloads); rendering safety is the `textContent` assignment, not escaping.
`permission` is additionally allowlist-mapped at render time, so an unknown value becomes a
fixed label rather than raw wire text.

### 5. Two-step confirm for the persistent grant

`once` and `reject` are single-click; `always` installs a persistent standing grant
(broader than the immediate action), so it takes a two-step inline confirm with explicit
consequence copy. Bind the copy to the gateway's actual grant scope — do not infer a
broader or narrower scope than the contract states.

### 6. Browser-direct, not a proxy; dashboard returns 404 for approval routes

Same discipline as the launch path: the browser calls same-origin `/operator/*` paths the
**reverse proxy** routes to the gateway; the dashboard must **not** mount the approval
routes (they 404 from the dashboard app, even with the operator flag on and an
authenticated request — pin it with an invariant test) and must never forward operator
credentials as a proxy. The decision is the operator's own authenticated write. See
[safe-operator-launch-surface](./safe-operator-launch-surface-2026-06-20.md) for the
pattern.

### 7. Version-lock the contract on both sides

The vendored contract version and the browser's pinned contract version must move
together. If only one moves, the drift gate fail-closes live streams (the gateway's `ready`
frame advertises a version the client rejects, so nothing renders). Bump them in the same
change and assert the pin in tests.

> The auth surface was clean in review; **every real bug clustered in lifecycle and
> failure-class handling** (transport message erased by a control re-render, decisions left
> in disabled limbo, session-expiry looping instead of prompting reload). When a read-only
> surface takes its first mutating action, a misleading state erodes trust in the one place
> the human is in the loop — so spend the rigor there, not on the wire shape.

**Known limitation (dashboard #86):** reconnect reconciliation is additive-only — it cannot
retract a prompt that opened before a disconnect and settled during it (the lost settle frame
was the only signal). The result is a cosmetic ghost prompt that clears inline on click.
Making reconcile corrective needs the gateway recovery response to be a complete authoritative
open-set.

## Question channel

Contract 1.9.0 adds agent questions to the run stream: `event: question` frames (open or
settle, discriminated like approvals) plus a pending-list GET and a per-request decision POST.
The approval rules above apply unchanged (inert text, browser-direct, version-locked pins).
These are the places the question channel differs. Code lives in `public/operator-stream.js`
and `src/gateway/operator-contract/question-frame.ts`.

### Key the outcome on the body, never the status

`classifyQuestionDecisionResponse` reads the 200 body's `state` (`claimed`, `already_claimed`,
`already_settled`, `failed_to_settle`). Everything else maps by class:

| Response | Outcome |
| --- | --- |
| 200, known `state` | decided (by `state`) |
| 200, unrecognized `state` | failed (request-level, retryable) |
| 401 / 403 | session expired |
| 404 (masked denial) | cannot answer |
| 429, 5xx, unreadable 200, timeout | unknown: re-list, never resubmit |

`readQuestionBadRequest` splits the 400. A body with a `reason` is an invalid answer and is
never retried. A body without one is the browser guard's refusal (CSRF, Origin, Fetch
Metadata): refresh CSRF and retry once. There is no idempotency key; the gateway's question
route does not read one, and single settlement comes from its claim states.

### Tombstone only on evidence of settlement

A tombstone comes from a settle frame or from this tab's own `claimed` / `already_settled`
response (`settleQuestionInState`, `applyQuestionOutcome`), never from a request's absence
in the pending list. The list omits requests mid-claim, and a claim that fails reopens the
request with no frame, so absence proves nothing.

### Claimed elsewhere

An `already_claimed` response marks the request exempt from removal by absence
(`questionClaimedExempt`). The exemption survives reconnects and ends only on a settle frame,
a terminal status, or a list that shows the request open. While it holds, the client re-lists
on a bounded schedule (`QUESTION_CLAIM_RECHECK_DELAYS_MS`: 2, 5, 10, 20 s, restarted on each
live transition), then leaves a manual "Check again".

Submit and Skip stay enabled from claimed-elsewhere. `QUESTION_SEND_BLOCKED_KINDS` holds only
`in-flight` and `checking`, so a settle frame the client missed resolves as `already_settled`.
The gateway's single settlement makes a second decision safe.

> Pitfall: keeping the exemption across reconnects while still blocking sends left the card
> with no way out. Allow sends.

### Bound every fetch

The list GET, CSRF fetch and decision POST each carry `AbortSignal.timeout`
(`QUESTION_FETCH_TIMEOUT_MS`, 10 s), like the cancel client. A timed-out decision is an
unknown outcome: re-list, never resubmit. A timed-out list is a failed check and prunes nothing.

### Keep tombstones and drafts for the page, not the stream

`getQuestionPageStore` holds tombstones and drafts per run outside the per-attach stream state,
so collapsing and re-expanding a card, or switching cards, never resurrects a settled
question or drops a draft. A terminal status clears that run's drafts.

### Waiting statuses: the gateway first, the client fills in only on `running`

Run summaries now carry `waiting_for_approval` and `waiting_for_question` as ordinary
statuses. The gateway overlays them on a running run only, with approval winning, so a
collapsed card shows a waiting run without opening a stream.

For an expanded card, `getEffectiveStatus` fills the same overlay in from the wire status and
the open prompts. It is never stored: the next `running` frame would overwrite a stored value.
The rules, in order:

- A terminal status wins.
- Wire `waiting_for_approval` stays. It is never replaced by a question.
- Only a wire `running` is overlaid, as the gateway does: an open approval gives
  `waiting_for_approval`, otherwise an open question gives `waiting_for_question`.
- A wire `waiting_for_question` with an open question stays. With none, it reads as `running`
  once a question reconcile has completed in the current connection, and not before: until then
  a missed settle frame cannot be told from a list that has not shown the question yet.

### The run list stays current, and terminal is sticky

The list refreshes in place while the window is visible: on an interval, on becoming visible,
and before a card expands, so a stream starts from the current status instead of one that went
stale while the card was collapsed. Refresh is single-flight, and a request that arrives
mid-flight shares one trailing refresh, so responses never apply out of order. A failed refresh
keeps the list as it was and the expand goes ahead; a 401 or 403 stops refreshing and moves the
shell to auth-required.

A card that already shows a terminal status never takes a non-terminal one. A run ID does not
come back from terminal, so a later non-terminal view is stale: a list fetched before the run
finished, or one racing the stream's own terminal write. The whole update is skipped, so the
label, the accessible name and the reason line stay consistent.

Class tokens are hyphenated and written from one map in the run index. The stream emitter and
the runtime mirror it, with parity tests, and a token outside the map never reads back as a
status.

### A question notification opens the asking run in place

The push payload carries a `runId` only on a `question`, and only when it matches the strict run
ID pattern and its route is exactly the run's own. Everything else carries none, so the stored
notification data stays `{type, route}` plus that one validated ID.

On a tap, the service worker looks only at app windows its worker controls, because the page
accepts the message only from its controlling worker. It focuses one and posts `OPEN_RUN` with
the ID. With none, it opens `/#<runId>` in a new window, and the hash restore does the rest. Other
notification types still focus any app window and post nothing.

The page checks the message source by identity against its controlling worker and re-checks the
ID, then asks the operator runtime to jump. The runtime refreshes the list, expands the card
without toggling, attaches the stream, writes the hash, and focuses the card. It announces
"Opened run" with the status label, never the ID. A card that is already open is revealed and
announced too, and re-attached only if its stream has gone inactive.

If the card is missing after a refresh that applied, a fixed "not in your recent runs" notice
shows. If the refresh itself failed, the notice says the runs could not be loaded instead,
because the run may exist. Neither notice echoes the ID. A tap that arrives before the list has
loaded waits for it. One that arrives while the list is unavailable or the session has ended is
dropped, not held for a later page, and an unavailable list accepts taps again once a refresh
lands.

### Parse closed, render inert

The parsers (`question-frame.ts` and the browser mirror) reject over-bound text rather than
truncating it, rebuild closed objects, and reject extra keys, including an own `__proto__`.
Question text, option labels and descriptions render through text nodes only.

### A request that reopens gets a real card

A request shown as a "gone" note card can reopen when a later list shows it open. The note
must give way to the question card (`syncQuestionStatuses` drops a note whose request is open
again).

## Related

- [consume-gateway-operator-contract-1-8-0](./consume-gateway-operator-contract-1-8-0-2026-10-07.md) — the per-bump checklist ("Every contract bump").
- [authenticated-sse-consumption-fetch-stream-no-leak](./authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md) — the underlying authenticated SSE fetch-stream consumer this builds on.
- [operator-sse-output-consumption](./operator-sse-output-consumption-2026-06-22.md) — the output channel; same dual-parser/contract-drift discipline, different frame.
- [safe-operator-launch-surface](./safe-operator-launch-surface-2026-06-20.md) — the browser-direct `/operator/*` + CSRF/idempotency posture and the no-dashboard-proxy invariant.
- [gateway-operator-client-no-leak-contract](../security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md) — the no-leak boundaries for the operator client.
- [gateway-operator-session-cookie-forwarding-trust-boundary](../security-issues/gateway-operator-session-cookie-forwarding-trust-boundary-2026-06-20.md) — the fail-closed gateway-session auth boundary.
