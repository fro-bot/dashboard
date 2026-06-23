---
title: 'feat: web tool-approval UX against operator contract 1.4.0'
type: feat
status: active
date: 2026-06-22
issue: fro-bot/dashboard#81
contract: fro-bot/agent operator-contract 1.4.0 (v0.76.0, gateway PR #986)
---

# feat: web tool-approval UX against operator contract 1.4.0

## Overview

The gateway now exposes a full web tool-approval flow on the operator surface
(operator contract 1.4.0). When a web-launched run hits a tool gate (bash, edit,
external_directory, …), the gateway delivers the pending request over the existing
per-run SSE stream and accepts the operator's decision over per-run REST endpoints.
The dashboard must build the operator-facing UX: render the pending approval inline
with the run, let an authorized operator decide (`once` / `always` / `reject`), and
keep the prompt state correct across settlement, reconnect, and read-only operators.

This closes #48's deadline-dismissal ask (a deadline-expired request now sends a
canonical settle frame) and supersedes the dashboard's stale mock approval surface.

## Problem Frame

An operator watching a run in the dashboard currently sees a **fixture-only, disabled**
approval card with copy saying live approval is unavailable. The capability now exists
gateway-side; the dashboard is one contract version behind (pinned 1.3.0) and models no
approval frame, so a live `1.4.0` `ready` frame would fail-closed and an `event: approval`
frame would be dropped as unknown. The operator cannot act on tool gates from the web.

The product challenge is not the wiring (the contract fixes routes, verbs, and frames)
but the **operator experience under three hard constraints the contract imposes**: the
browser gets no signal for whether the operator may approve, a settle frame carries no
reason, and the gated action is free-form agent-originated text on a redaction-strict
surface.

**This is the dashboard's first mutating operator capability** — it shifts the dashboard
from a pure read-only monitor to a read-mostly surface with one bounded approval action.
The shift is intentional and bounded: the decision POST is the operator's own authenticated
write to the gateway (the dashboard never mints repo writes), it is flag-gated default-off,
and every other read-only invariant is preserved. See PD6.

## Requirements Trace

- R1 — An operator watching a run sees a pending tool-approval prompt inline with that
  run as soon as it arrives over the stream, showing the permission category and the
  actual gated action (command or filepath).
- R2 — An authorized operator can decide `once`, `always`, or `reject`; the decision is
  sent to the gateway and the outcome is reflected.
- R3 — `always` (a persistent standing grant) requires an explicit, distinct confirmation
  so it cannot be selected by accident.
- R4 — A prompt is dismissed when it is settled by any cause (the operator's decision,
  deadline expiry, sibling reject-cascade, another operator, run teardown) — signalled by
  a settle frame or, as a backstop, terminal run status.
- R5 — A reconnecting or late-joining operator recovers any open prompts it missed.
- R6 — A read-only operator can watch the prompt but, on attempting a decision, is shown a
  generic "you may not have approval access" state rather than a confusing error.
- R7 — The gated action and all prompt content render injection-safe (no leak, no HTML
  interpolation), consistent with the dashboard's read-only/redaction-strict posture.
- R8 — The whole surface stays behind `DASHBOARD_OPERATOR_UI_ENABLED` (default unchanged);
  enabling it is a separate deploy decision.
- R9 — The decision POST is CSRF-protected and replay-safe (idempotency + origin/session
  binding); the dashboard exposes no cross-site writable approval path. This is a hard
  requirement, not deferred — it is a mutating action on a read-only surface.
- R10 — The UI distinguishes three decision-failure classes rather than collapsing them: a
  denial-class (uniform not-found) outcome → "you may not have approval access"; a
  transport/network/protocol failure → a separate "decision didn't go through — try again"
  state; a `state` of `already_claimed`/`unavailable` → an inline "already settled" outcome.
  A transient failure must never be presented as a permission denial, or vice versa.
- R11 — Approval-prompt visibility and the `waiting_for_approval` status overlay derive from
  the same reducer state so they cannot disagree; terminal run status clears both; a settled
  prompt suppresses both.
- R12 — While the operator is in the dashboard, a lightweight in-page indicator surfaces that
  one or more runs have an open approval prompt (e.g. a count on the run-status region), so an
  open prompt is not missed when the operator is looking at a different run. No desktop/audio
  notification, no permission request.

## Scope Boundaries

- v1 is per-prompt, inline decisions within the run stream, plus the existing
  `waiting_for_approval` run-status overlay.
- Read access observes (stream + GET reconcile); write access approves (POST decision).
  The dashboard does not attempt to pre-detect which the operator has.

### Deferred to Separate Tasks

- **Diff/patch preview for edits** — deferred gateway-side; v1 shows `filepath` text only.
- **Approval history / audit trail** — the contract surfaces only open/actionable prompts
  (GET returns open only); history needs a gateway surface that does not exist.
- **Multi-operator coordination / presence signals** — no contract signal; `already_claimed`
  on a decision is the only (post-hoc, inline) concurrency feedback.
- **Bulk approve across runs** — v1 is per-prompt; bulk raises mis-grant risk.
- **Desktop/audio notifications (Notification API, sound)** — deferred to v2 (permission
  surface + privacy cost). v1 does NOT alert an operator who is not looking at the dashboard.
  A run blocked on a tool gate stalls until the operator returns; v1 success is therefore
  honestly scoped to **"approval while the operator is in the dashboard"** (see R12). A
  minimal in-page pending indicator (R12) keeps the operator oriented within the tab without
  the notification-permission surface.

## Contract Mechanics (fixed by 1.4.0 — inputs to planning, not product decisions)

These are settled by the gateway contract and carry into the plan as mechanics:

- **SSE `approval` frame** on `GET /operator/runs/:runId/stream`, discriminated on `settled`:
  - Open: `{ runId, requestID, permission, command?, filepath?, settled: false }` —
    `command` (bash) / `filepath` (edit/external_directory) present only when supplied and
    non-empty; gateway length-caps and control-char-strips them.
  - Settle: `{ runId, requestID, settled: true }` — emitted on every settlement path; carries
    no reason. On same-tick teardown it may be superseded by terminal status (R4 backstop).
- **Run status** overlays to `waiting_for_approval` while a request is pending.
- **GET `/operator/runs/:runId/approvals`** (read-gated, 30/min, capped) — returns open
  prompts only: `{ approvals: [{ requestID, permission, command?, filepath? }, …] }`. Use
  on reconnect/late-join only; SSE is the primary channel.
- **POST `/operator/runs/:runId/approvals/:requestId/decision`** (write-gated),
  body `{ decision: "once" | "always" | "reject" }` →
  `200 { state: "claimed" | "already_claimed" | "scope_mismatch" | "failed_to_settle" | "unavailable" }`.
- **Authorization:** observing needs repo read; approving needs repo write/admin. Every
  denial returns a uniform not-found response (no distinguishable error).
- **Contract version is 1.4.0** (the dashboard currently pins 1.3.0). The migration mechanics
  — bumping the pin in the two consumers, changing both parsers + the reducer in lockstep, and
  replacing the stale `/operator/approvals` + `approve|reject` client surface with the per-run
  1.4.0 routes/verbs — are execution details for the plan, not contract facts; their blast
  radius (operator-client DTOs, all `/operator/approvals` call sites, the approval-state copy
  layer, and the tests/fixtures encoding the old shape) is captured under System-Wide Impact.

## Key Product Decisions

- **PD1 — Optimistic approve affordance, with failure classes split.** Render
  `once`/`always`/`reject` whenever a prompt is open. The contract gives no client-side
  write-access signal (uniform 404 denials), so the UI does not pre-detect access. The
  decision outcome is mapped to **distinct** states, never collapsed (R10): a denial-class
  not-found → "you may not have approval access for this run" (stop attempts on that prompt);
  a transport/network/protocol failure → "decision didn't go through — try again" (retryable,
  NOT a permission claim); `already_claimed`/`unavailable` → inline "already settled". Pre-click
  copy sets the expectation ("approval requires write access; unavailable decisions fail
  safely") so a read-only operator is not surprised on first click. (R6, R10) Trade-off:
  read-only operators still discover access reactively — accepted; pre-detection has no
  contract support.
- **PD2 — `always` two-step inline confirm, copy bound to the gateway rule.** First activation
  of `always` reveals an inline confirmation; the POST fires only on the distinct confirm
  control; `once`/`reject` stay single-click. The consequence copy must describe the grant as
  the gateway's standing-grant rule actually scopes it — NOT an inferred summary. Until the
  exact OpenCode always-rule matching dimensions are confirmed against the gateway, the copy
  states scope conservatively ("this installs a standing approval that auto-approves matching
  requests for the rest of this run, as defined by the gateway's grant rule") rather than
  asserting a specific match key the UI cannot verify. (R3) Chosen over single-click distinct
  styling (too weak) and a full modal (heavier; unused pattern). *Planning must confirm the
  real grant scope with the gateway and finalize the copy.*
- **PD3 — Render the full gated action as strictly inert text.** Show the complete
  `command`/`filepath` via `textContent` / text node — never HTML interpolation, mirroring the
  run-output `text` discipline — in a demarcated monospace block labeled as the agent's
  requested action. The text is **inert and non-actionable**: no HTML, no Markdown, no
  autolinkification, no clickable/file-navigation/copy-to-execute affordance, no event handlers
  on the content. Render only `permission` + `command` + `filepath`; no other frame field.
  (R1, R7) The action is the informed-consent core — truncation/redaction is rejected
  (truncation risks blind approval; redaction is the wrong layer — these are tool args, not
  repo identities). Note an inherent v1 asymmetry: bash actions are fully inspectable
  (the command), but edit/external_directory show the filepath only (diff preview is
  gateway-deferred) — surface a brief "file-level only, contents not previewed" caveat for
  edit-class prompts so the operator knows the inspection is partial.
- **PD4 — Silent, honest settlement.** On any settle frame or terminal status for a prompt's
  `requestID`, remove the prompt with no toast and no invented reason — the settle frame
  carries none, so the UI cannot truthfully distinguish "you approved" from "expired" from
  "someone else won." A lost race on the operator's own click is explained inline by the
  decision response (`already_claimed` / `unavailable`). (R4) Chosen over a neutral residue
  note (implies the operator acted) and keep-disabled-until-acknowledged (clutters the stream,
  fights the contract's dismiss intent).
- **PD5 — Prompt identity, tombstoning, and precedence (the settlement/reconnect correctness
  boundary).** PD4's silent dismissal is only safe with explicit identity rules — promoted out
  of "deferred" because the races are correctness, not polish:
  - **Tombstone settled IDs.** A settled `requestID` is terminal: the reducer records it as
    settled and **ignores any later OPEN or reconcile entry for that same `requestID`** (guards
    open-after-settle reordering and a settle-then-reopen with a reused id). A settle for a
    `requestID` the client never saw open is a no-op (no spurious UI).
  - **Terminal status is absorbing.** When a run reaches terminal status, all approval UI for
    that run clears immediately and any later OPEN/reconcile for that run is ignored — the
    backstop is state precedence, not merely an effect of receiving a frame (guards same-tick
    teardown).
  - **Reconcile is settle-dominant and additive-only.** GET `/operator/runs/:runId/approvals`
    runs **once per (re)connect** (respecting 30/min, never on a timer). Its results add open
    prompts ONLY for `requestID`s not already tombstoned in reducer state; a reconciled open
    whose id is already settled is dropped (guards resurrecting a prompt settled during the
    reconnect gap).
  - **Single source of truth.** Prompt visibility and the `waiting_for_approval` overlay both
    derive from this reducer state, so they cannot desync (R11).
- **PD6 — Bounded mutating capability, read-only invariants preserved.** This is the dashboard's
  first write path. Guardrails, all explicit: the decision POST is the operator's own
  authenticated write forwarded to the gateway (the dashboard never mints repo writes and adds
  no service-credential path); CSRF-protected + replay-safe (R9); flag-gated default-off (R8);
  no cross-site writable approval path. The dashboard remains read-only-by-construction for
  repo data; the single approval action is a forwarded operator decision, not a dashboard-origin
  mutation.

## Open Questions

### Resolved During Brainstorm

- Approve affordance under unknown access → PD1 (optimistic, with denial/transport/already-settled
  split per R10).
- `always` friction → PD2 (two-step inline confirm, copy bound to the gateway's real grant scope).
- Gated-action rendering → PD3 (full string, strictly inert text; edit-class partial-inspection
  caveat).
- Settled-by-other-cause UX → PD4 (silent honest dismissal) + PD5 (tombstone/precedence/reconcile
  identity rules — promoted out of deferred because the races are correctness boundaries).
- First mutating capability → PD6 (bounded, read-only invariants preserved; CSRF/replay-safe per R9).
- v1 boundary → history/presence/diff-preview/bulk deferred; desktop/audio notifications deferred but
  v1 keeps a minimal in-page pending indicator (R12) and is honestly scoped to "approval while in the
  dashboard."

### Deferred to Planning

- Where pending-approval state lives in the stream reducer's `RunEntry` and how it composes
  with the existing output/status fields (the PD5 tombstone/precedence rules constrain this).
- The exact idempotency-key / CSRF mechanism on the decision POST — reuse vs adjust the
  existing launch-surface mutating pattern (the requirement that it be CSRF-protected and
  replay-safe is fixed by R9; the mechanism is the open detail).
- DOM/SSR hook shape and placement of the inline prompt: which `data-role` hooks, where the
  approval region sits relative to `run-status`/`run-output`, and how multiple concurrent
  prompts on one run stack/order.
- The prompt-interaction state model details: what cancels the two-step `always` confirm,
  whether `once`/`reject` hide or disable during confirm-pending, the in-flight (POST pending)
  control state, and focus/keyboard/ARIA treatment for a blocking decision (the states are
  enumerated in System-Wide Impact; planning specifies the exact transitions).
- Confirming the real OpenCode always-rule grant scope against the gateway to finalize PD2 copy.

## Prompt Interaction States

The approval prompt is a small state machine planning must specify transitions for (states
named here so they are not invented at implementation time):

- **open / awaiting-decision** — controls active: `once`, `always`, `reject`.
- **always-confirm-pending** — after first `always` activation: show confirm + cancel; per PD2,
  `once`/`reject` are suppressed during this substate; cancel returns to open.
- **decision-in-flight** — POST pending: all controls disabled with pending feedback.
- **denied / can't-approve** — terminal not-found outcome (R10): generic no-access copy, controls
  gone; persists in-place until the prompt settles or the run advances.
- **decision-failed (retryable)** — transport/protocol failure (R10): distinct "try again" state,
  controls re-enabled.
- **settled / dismissed** — settle frame or terminal status (PD4/PD5): prompt removed, no residue.

A blocking decision warrants focus management and an assertive ARIA live treatment; the exact
keyboard/focus/escape model is a planning detail.

## System-Wide Impact

- **Two SSE parsers + one reducer** change in lockstep (server `operator-sse-reader.ts`,
  browser `operator-stream.js` parser + `nextStreamState`) — drift risk; mirrored cases + tests.
- **Operator client** approval DTOs/routes/verbs are replaced (not added) — old `approve|reject`
  callers and tests update together.
- **Run-card SSR** gains an inline approval region; the existing run-status/run-output hooks and
  the no-leak rendering discipline are unchanged.
- **Auth model** introduces a read-vs-write expectation at the decision boundary, surfaced only
  reactively (PD1); no new dashboard auth code beyond reflecting the gateway's uniform denial.
- **Contract-drift gate** must accept 1.4.0 and fail-closed below it, as today.
- **Unchanged invariants:** read-only-by-construction posture (the decision POST is the
  operator's own write to the gateway, not the dashboard minting a write), redaction/denylist,
  flag-gating default-off, and the no-dashboard-proxy topology.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Read-only operator confused by failing controls | PD1 generic "can't approve" state + clear labeling |
| Accidental persistent `always` grant | PD2 two-step inline confirm with consequence copy |
| Injection/leak via free-form command/filepath | PD3 textContent-only render; no other field shown |
| Inventing a false settlement reason | PD4 silent honest dismissal; decision response explains own race |
| Server/browser parser drift on the new frame | mirrored fail-closed cases + parity tests |
| Reconcile duplicating/resurrecting a settled prompt | planning resolves merge semantics (deferred) |
| Contract skew (dashboard behind gateway) | bump pin 1.3.0→1.4.0 in both consumers; drift gate fails closed |

## Sources & References

- Issue: fro-bot/dashboard#81 (+ Fro Bot triage comment)
- Contract: fro-bot/agent operator-contract 1.4.0 (v0.76.0, gateway PR #986)
- Current surfaces: `src/gateway/operator-client.ts` (stale approval DTOs/routes),
  `src/gateway/operator-contract/approval.ts` (already vendors `PermissionReply`/`OperatorDecisionState`),
  `src/gateway/operator-contract/sse-frames.ts`, `src/gateway/operator-sse-reader.ts`,
  `public/operator-stream.js` (+ `.d.ts`), `src/routes/operator.ts` (fixture approval UI),
  `src/gateway/operator-copy.ts` (`approvalStateLabel`)
- Learnings: `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`
  (dual-parser parity, no-leak rendering, settle-as-absence discipline),
  `safe-operator-launch-surface-2026-06-20.md` (mutating decision POST, CSRF/idempotency, no-oracle)
