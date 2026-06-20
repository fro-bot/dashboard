---
title: Consume the operator run-stream SSE endpoint
date: 2026-06-20
status: requirements
issue: fro-bot/dashboard#63
parent: fro-bot/dashboard#47
tracks: fro-bot/agent#907
upstream: fro-bot/agent v0.72.0 (#961, #962)
type: feat
scope: standard
---

# Consume the operator run-stream SSE endpoint

## Problem

The gateway shipped the authenticated operator run-stream route in
`fro-bot/agent` v0.72.0 (`GET /operator/runs/:runId/stream`), with a frozen
contract at `OPERATOR_CONTRACT_VERSION = 1.1.0`. The dashboard currently renders
mock run-observation fixtures and pins the operator contract at `1.0.0`; its
`RunStreamEvent` union is mock-only (`run.state` / `heartbeat` / `stream.reset`),
not the shipped named SSE frames (`ready` / `status` / `reset`). This is the
SSE run-stream slice of #47.

## Goal

Replace the mock run-observation with a real consumer of the gateway SSE
run-stream: a same-origin browser SSE consumer (a `fetch` + `ReadableStream`
reader, see D2a) that renders live run status with the full documented lifecycle,
aligned to the frozen 1.1.0 contract — without weakening the dashboard's
read-only and redaction invariants.

## Contract (from the issue + gateway v0.72.0 source)

- `GET /operator/runs/:runId/stream`; auth = the standard operator browser
  session (same guard/session/allowlist/CSRF as other `/operator/*` routes).
  Server resolves `runId → repo` and authorizes server-side; the client never
  supplies the repo.
- Success: `200 text/event-stream`. The stream IS the success signal (no
  non-stream JSON success response).
- Named SSE events: `ready` `{ contractVersion }` (first frame), `status`
  (`OperatorRunStatus` DTO), `reset` `{ runId, reason }`. Heartbeat is an
  unnamed SSE comment (`: heartbeat`, ~15s) — ignored by named handlers.
- `ResetReason` ∈ `no-snapshot | terminal | shutdown | max-duration |
  writer-error | overflow`.
- Denial: uniform `404 { error: "not-found" }` for every auth/redaction/authz
  failure — intentionally indistinguishable; the client must not branch on cause.
- `429 { error: "rate limited" }`: per-operator concurrent-stream cap exceeded
  (only after authorization); honest backpressure.
- No replay: snapshot-on-subscribe only; no Last-Event-ID.

## Decisions

- **D1 — Bump the vendored contract to 1.1.0 in this slice.** Vendor the 1.1.0
  additions (named `ready`/`status`/`reset` frame shapes, `ResetReason` enum, and
  any `OperatorRunStatus` change), bump `OPERATOR_CONTRACT_VERSION` to `1.1.0`,
  and replace the mock `RunStreamEvent` union with the canonical named-frame
  types. The exact 1.0.0 → 1.1.0 diff is pulled from agent v0.72.0 source during
  planning, not guessed.
- **D2 — Browser-side stream, same-origin, direct to the gateway.**
  Verified from gateway source: the GET stream requires no CSRF token (CSRF is
  mutating-routes-only), and the browser-origin guard (Origin / Sec-Fetch checked
  against the canonical origin) is satisfied natively by a same-origin browser
  request (cookie + Origin + Sec-Fetch sent automatically). The dashboard server
  stays out of the streaming path.
  - **D2a — Transport mechanism caveat (load-bearing).** Native `EventSource`
    does NOT expose the HTTP status or body on failure — it fires a generic
    `error` event, so it CANNOT distinguish `404` (uniform denial) from `429`
    (backpressure) from a network drop. Because R6 requires distinct 404 vs 429
    UX, the connect must go through a **`fetch` + `ReadableStream` SSE reader**
    (which sees status + body), not raw `EventSource`. The `fetch`-based reader is
    same-origin with `credentials: 'include'` (cookie rides) and parses the
    `text/event-stream` body manually for the named frames. This also removes
    `EventSource`'s built-in auto-reconnect, giving the client explicit control
    over the documented lifecycle (R5) instead of fighting it. The
    `createEventStream` seam wraps this fetch-stream reader.
  - **D2b — Same-origin is a security precondition.** This model relies on the
    deployment being same-origin (dashboard + gateway both behind
    `dashboard.fro.bot` via the reverse proxy) so the browser sends the operator
    session cookie and the gateway's Origin/Sec-Fetch guard authorizes it. If the
    topology is ever not same-origin, the browser cannot forward the dashboard's
    cookie and the stream must fail closed — it must NOT be worked around by
    proxying or URL-rewriting. The gateway's Origin guard (cross-origin pages
    cannot open the stream) is a relied-upon control and is documented as such.
- **D3 — Client JS as a served static `.js` asset.** Framework-free, no build
  step (honoring the AGENTS.md no-build-step invariant), referenced via
  `<script src>` from the operator run view. Plain browser ES that runs as-is.
- **D4 — Full documented lifecycle in this slice** (the contract is frozen).

## Requirements

- **R1** — Vendor + bump the operator contract to `1.1.0`: named `ready`/`status`/
  `reset` frame types, `ResetReason` enum, `OperatorRunStatus` aligned to v0.72.0;
  `OPERATOR_CONTRACT_VERSION = '1.1.0'`. Replace the mock `RunStreamEvent` union.
  Vendor the **full** upstream 1.1.0 shape, not only the three stream-control
  frames — the current local mock union carries extra frame variants
  (e.g. output/error/approval-style events); the bump must reconcile against what
  v0.72.0 actually freezes (additive vs removed), determined from the upstream
  diff in planning, not guessed.
- **R2** — A same-origin browser **`fetch` + `ReadableStream` SSE reader** (per
  D2a, not raw `EventSource`) behind the existing `createEventStream` seam,
  connecting to the relative `/operator/runs/${runId}/stream` with
  `credentials: 'include'`. It reads the `text/event-stream` body, dispatches
  named frames, and exposes the initial HTTP status (so R6 can distinguish
  404/429). The client never sends a repo identifier.
- **R3** — A served static, framework-free client `.js` asset (no build step) that
  opens the stream and updates the DOM, referenced from the operator run view.
- **R4** — Named-frame parsing: handle `ready` (gate on `contractVersion` vs the
  dashboard's pin), `status` (snapshot + live updates), `reset` (resubscribe /
  re-fetch). Ignore heartbeat comments (no named handler fires).
- **R5** — Lifecycle with EXPLICIT close-vs-retry rules (the fetch reader has no
  built-in auto-reconnect, so the client owns this): terminal `status` → close, no
  reconnect; `reset` → close + resubscribe (fresh snapshot); `max-duration` reset
  → reconnect only if the last `status` was non-terminal (run still active), with
  bounded backoff; unexpected close (read error / stream end without terminal) →
  treat as "access may have changed," re-establish only if still authorized, with
  a bounded retry count before surfacing a failed state. Define the backoff and
  max-retry constants in planning.
- **R6** — Denial/backpressure UI, driven by the initial HTTP status the fetch
  reader exposes: uniform `404` → a SINGLE not-found/unavailable state with NO
  cause-specific branching, copy, timing, or retry difference (S3); `429` → a
  distinct backpressure state ("close an existing stream / retry"). No assumptions
  about Last-Event-ID/replay.
- **R7** — Contract-version gate (a SECURITY gate, not just correctness): if the
  `ready` frame's `contractVersion` is incompatible with the dashboard's pin,
  fail closed — surface a contract-drift state and render NO `status` data, rather
  than risk rendering misparsed/misaligned frame fields as live run state.
- **R8** — Build + test all of the above NOW against the frozen contract behind
  the existing mock/flag posture; real live connection is gated on the
  gateway-session auth (#53) being live (the #59 dependency).
- **R9** — Tests cover: contract-version match + mismatch (R7), named-frame
  parsing (`ready`/`status`/`reset`), heartbeat-ignored, reset→resubscribe,
  terminal close, max-duration reconnect, unexpected-close re-establish,
  uniform-404 UI, 429 backpressure, and the invariant that the client never sends
  a repo identifier.

## Security invariants (load-bearing)

- **S1** — Never render, cache, or log raw output, tool args, workspace paths,
  internal URLs, private repo names, tokens, session IDs/cookies, CSRF values, or
  **dynamic run IDs** in logs. `OperatorRunStatus` is phase/status/timestamps only
  — render only those. **Browser-side specifically:** no `console.log`/
  `console.error`/`console.warn` of frame data, run IDs, repo names, status
  payloads, or stream URLs; no `data-*` attributes or DOM text carrying those
  beyond the rendered phase/status/timestamps; no exception/error copy that echoes
  them; no analytics/telemetry beacon of any kind.
- **S1a — runId-in-URL exposure (explicit decision).** The stream URL necessarily
  contains the `runId` in its path. Accepted exposure: the `runId` rides the
  same-origin `fetch` URL (it must, to subscribe). Mitigations required: the
  client must NOT additionally log it, copy it into page-visible text/history/
  referrer-bearing navigations, or persist it; the run view must avoid leaking the
  `runId` through outbound navigations/referrers. Server-side dashboard logs must
  not record the dynamic `runId` (S1).
- **S2** — The client never supplies a repo identifier for stream auth; the server
  resolves `runId → repo`. The dashboard must not add a repo param.
- **S3** — `404` is uniform and indistinguishable across causes (unknown run, no
  access, denylisted repo). The UI/client must not infer or display the cause —
  including via distinct error copy, timing-based branches, or retry-vs-no-retry
  behavior that maps to a cause. All 404s collapse to one state with one retry
  policy. The client must not reintroduce an oracle the gateway deliberately removed.
- **S4** — Read-only invariant preserved: this consumes a GET stream; no write
  code path, no installation-token change. The client lifecycle issues NO
  POST/PUT/DELETE, no logging/telemetry endpoint call, and no reconnect path that
  mutates server state.
- **S5 — Same-origin trust precondition (per D2b).** The model relies on the
  gateway's Origin/Sec-Fetch guard so cross-origin pages cannot open the stream,
  and on same-origin so the cookie rides. The client must not weaken this by
  proxying or rewriting the URL; if the origin guard is absent/broken or the
  topology is not same-origin, stream access fails closed.

## Non-goals (deferred)

- **N1** — #47's other deferred routes (launch `POST /operator/runs`,
  approval-decision endpoint) — gated on gateway Unit 5/6.
- **N2** — #48 approval deadline/expiry UI — gated on a canonical Unit 6 signal.
- **N3** — The gateway-session auth cutover itself (#59 / #53 flag flip). This
  slice builds behind the existing posture; it does not flip the flag.
- **N4** — Last-Event-ID/replay (v1 contract has none).

## Constraints

- No build step; client JS is plain browser ES served as a static asset.
- Node 24 strip-only TS server-side; `Result<T,E>` boundaries; same-origin
  relative `/operator/*`.
- Vendored contract is the single pin; gate on `contractVersion`, never negotiate
  over the wire beyond the `ready` frame check.
- Fail closed: on contract drift, uniform 404, or unexpected close, do not render
  stale/guessed run state as live.

## Success criteria

- The operator run view renders live `status` from a real same-origin browser
  fetch-stream SSE reader against the 1.1.0 contract (when the gateway session is
  live), handling the full lifecycle and the 404/429 states.
- With the gateway session not yet live, the consumer + parsing + lifecycle are
  fully built and unit-tested behind the mock seam; nothing live is wired beyond
  the existing posture.
- No security invariant (S1–S4) is weakened; gates green
  (`pnpm check-types`, `pnpm lint`, `pnpm test`).

## Open questions for planning

- **Pull the exact 1.0.0 → 1.1.0 contract diff** from agent v0.72.0
  (`packages/gateway/src/operator-contract/`): what changed in `OperatorRunStatus`,
  the precise `ready`/`status`/`reset` frame shapes, and `ResetReason`. Vendor
  faithfully (byte-checked like #49).
- How the static `.js` asset is served (Hono static route / handler), its exact
  path, classic-vs-module script, how it's referenced from SSR, and a CSP posture
  with `script-src 'self'` and NO inline script.
- How the fetch-stream SSE reader (D2a) is unit-tested without a real browser:
  inject a fake `fetch` returning a synthetic `Response` with a `ReadableStream`
  body emitting `text/event-stream` bytes (status controllable for 404/429), at
  the `createEventStream` seam. Decide the client-`.js` test strategy: extract the
  frame-parser + lifecycle state machine as pure, server-importable functions
  (vitest-testable directly) and keep the thin DOM-wiring layer minimal, vs a
  DOM harness (happy-dom). Prefer pure-functions + injected fake.
- Reconnect/backoff constants (max-duration reconnect cadence + bounded backoff;
  max retries on unexpected close before a failed state) — R5.
- How "run still active" is determined client-side from the last `status` (phase
  predicate) to decide reconnect vs terminal.
- Exactly which `OperatorRunStatus` phases are terminal (drives R5 close logic) —
  from the vendored 1.1.0 contract.
- Which run(s) the view subscribes to (a selected run vs an active run) for the
  first integration.
