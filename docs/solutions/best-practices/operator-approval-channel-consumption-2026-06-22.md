---
title: Consuming the gateway operator approval channel safely in a read-only dashboard
date: 2026-06-22
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

A long-lived or hostile stream can emit unbounded distinct ids. Both the open-prompt map
and the tombstone map need caps with deterministic eviction (FIFO for tombstones; reject
new opens past the cap rather than evicting a real pending prompt). This is the same
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

## Related

- [authenticated-sse-consumption-fetch-stream-no-leak](./authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md) — the underlying authenticated SSE fetch-stream consumer this builds on.
- [operator-sse-output-consumption](./operator-sse-output-consumption-2026-06-22.md) — the output channel; same dual-parser/contract-drift discipline, different frame.
- [safe-operator-launch-surface](./safe-operator-launch-surface-2026-06-20.md) — the browser-direct `/operator/*` + CSRF/idempotency posture and the no-dashboard-proxy invariant.
- [gateway-operator-client-no-leak-contract](../security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md) — the no-leak boundaries for the operator client.
- [gateway-operator-session-cookie-forwarding-trust-boundary](../security-issues/gateway-operator-session-cookie-forwarding-trust-boundary-2026-06-20.md) — the fail-closed gateway-session auth boundary.
