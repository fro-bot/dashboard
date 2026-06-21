---
title: Consume the operator launch surface (repo list + launch + observe)
date: 2026-06-20
status: requirements
issue: fro-bot/dashboard#47
upstream: fro-bot/agent v0.73.0 (#968, operator contract 1.2.0)
type: feat
scope: standard
---

# Consume the operator launch surface (repo list + launch + observe)

## Problem

The gateway shipped the operator **launch surface** in the released agent v0.73.0
(operator contract `1.2.0`, additive): `GET /operator/repos` (repos the operator
may launch in) and `POST /operator/runs` (launch a run → `202 {runId}`). The
dashboard pins contract `1.1.0`, renders a **disabled** launch-form skeleton and a
"repository selection unavailable" notice, and has only a mock `launchRun`. This is
the launch slice of #47 — the third capability after auth (#53) and SSE
observation (#63).

## Goal

Build the full operator launch loop behind the operator-UI flag: pick a repo →
write a prompt → launch → observe the run go live by reusing the #63 SSE consumer.
Buildable + testable now against the released 1.2.0 contract; the live connection
is deferred to the auth cutover (#53/#59) like the rest of the operator surface.

## Contract (verbatim, from released agent v0.73.0 source)

- `OPERATOR_CONTRACT_VERSION = '1.2.0'`. Additive vs 1.1.0: only `RepoSummary`.
  `OperatorRunStatus` and the SSE frames are UNCHANGED.
- **`RepoSummary { readonly owner: string; readonly repo: string; readonly
  channelName?: string }`** — `channelName` is omitted (key absent) when empty.
  No upstream parse helper exists; the dashboard authors its own guard.
- **`GET /operator/repos`** — auth = operator browser session (guard/session/
  allowlist; no CSRF, safe method). 200 → **bare `RepoSummary[]`** (not wrapped),
  capped at 100 (no pagination), `Cache-Control: no-store, private`, 20/min per
  operator. Denylist-filtered BEFORE authz; unauthorized repos silently omitted.
  Errors: `401 {error:'unauthorized'}`, `429 {error:'rate limited'}`,
  `503 {error:'unavailable'}`.
- **`POST /operator/runs`** — auth + CSRF (Origin/Fetch-Metadata/CSRF for the
  mutating method). Body `{ repo: "owner/repo", prompt: string, idempotencyKey?:
  string }` (server parses `owner/repo`; a client-supplied binding is ignored).
  → `202 { runId: string }`, fire-and-return. Rate limit 3/min + 10/hr per
  operator (both must pass). Errors: `400 {error:'bad request'}` (bad body/repo/
  prompt/CSRF/Origin/Fetch-Metadata), `400 {error:'prompt is required'}` (empty
  prompt, AFTER authz), `404 {error:'not-found'}` (uniform: unknown/unbound/
  denylisted/unauthorized repo), `429 {error:'rate limited'}`. Idempotency:
  `idempotencyKey` makes a submit idempotent per operator for ~10 min (duplicate
  echoes the same `runId`).
- **CSRF acquisition:** `GET /operator/session/csrf` → `200 { csrfToken: string }`
  (already vendored as `parseOperatorCsrfToken`/`CsrfDto`). Token is body-only,
  sent back as the `X-CSRF-Token` header on the launch POST.

## v1 limitations (the consumer must handle)

- **Status-only observation** — the SSE stream carries run status/lifecycle, not
  the agent's output text yet (agent#965).
- **Queued/failed runs may never stream** (agent#966) — a run that queues behind
  the per-repo concurrency cap, or fails before execution starts, may not emit a
  run-state. The UX must degrade cleanly: a `runId` that never streams is treated
  as pending/unknown, never as a hang.
- **Tool approvals auto-deny** — until the interactive web approval transport
  ships, a web-launched run that hits a tool-permission gate is auto-denied, so v1
  launches complete only work needing no tool approval. Surface this in copy.

## Decisions

- **D1 — Full launch loop in scope.** Vendor 1.2.0, add the repos consumer + a
  real repo picker (replacing the "unavailable" notice), reconcile the launch
  request to the wire shape, wire the launch POST, and hand the `runId` to the #63
  SSE consumer to observe.
- **D2 — Never-streams UX (agent#966).** On `202`, insert an optimistic
  **pending** run card and open the stream. If no first frame arrives within a
  bounded window, surface a clear "submitted — not yet observable (queued or still
  starting)" state with manual retry — not an indefinite spinner. This needs a
  small **first-frame timeout** added to the #63 SSE client (an open-but-silent
  stream is not an error state today).
- **D3 — CSRF on submit + ONE best-effort retry, same idempotency key.** Acquire
  the CSRF token via `refreshCsrf()` at submit time (fresh, not page-load-stale).
  On a `400` after a valid repo selection, refresh the token once and retry the
  POST a single time — REUSING the same idempotency key (D6) so a retry of a
  request that actually succeeded server-side dedupes rather than double-launches.
  The retry is best-effort (CSRF 400s are wire-indistinguishable from other 400s)
  and is capped at exactly one; after that, surface a generic launch failure. Do
  NOT retry on `404`/`429`/`202`.
- **D4 — Reuse the existing `OperatorClient` seam, browser fetch injected, via a
  NEW browser entrypoint.** Today the client's injected `fetch` is server-side
  only and the browser bundle (`public/operator-stream.js`) uses raw `fetch`. This
  slice adds a browser bootstrap (a static `.js`, like operator-stream.js) that
  constructs an `OperatorClient` with a browser fetch adapter
  (`(input, init) => globalThis.fetch(input, {...init, credentials:'include',
  redirect:'error'})`) and drives the launch form. The POST is browser-direct, NOT
  the server-side cookie-forwarding adapter (that adapter is only the auth
  middleware's `getCurrentSession` path). Reconcile `LaunchRunRequest` to send the
  wire's single `repo: "owner/repo"` string (update the affected fixtures/tests).
- **D5 — Launch→observe handoff via the exported `initOperatorStream`.** On `202`,
  insert an optimistic pending card INTO `#run-status-section` carrying the exact
  hooks `initOperatorStream` needs — `data-run-id`, a `[data-role="run-status"]`
  child, and the shared `[data-role="stream-status"]` notice — then call
  `initOperatorStream({runId, statusEl, noticeEl})` directly (it does NOT
  self-discover elements). Do NOT re-run `bootstrapOperatorStreams` (that would
  duplicate streams for existing cards).
- **D6 — Idempotency is MANDATORY on every launch.** Every `POST /operator/runs`
  carries a fresh client-minted `idempotencyKey`; the CSRF retry (D3) reuses the
  SAME key so a retry of a request that already reached the server dedupes to the
  same run instead of double-launching. A double-click of the form reuses the
  in-flight submit's key.

## Requirements

- **R1** — Vendor operator contract `1.2.0`: add `RepoSummary` + a hand-rolled
  parse guard (mirroring the existing `parseOperator*` no-oracle/fixed-string
  pattern), bump `OPERATOR_CONTRACT_VERSION` to `'1.2.0'`, update the conformance
  test and README provenance (tag v0.73.0). `OperatorRunStatus`/SSE unchanged.
- **R2** — A `GET /operator/repos` consumer (`listRepos()` on the client seam):
  expect a bare `RepoSummary[]`, parse + validate each item, handle 401/429/503
  fail-closed, never assume pagination.
- **R3** — A real repo picker in the operator UI, fed by `listRepos()`, replacing
  the `bindingUnavailableSection` notice. Render only the display-safe
  `RepoSummary` fields from a SINGLE normalized success shape: no repo-count-based
  inference, no per-item denial/availability messaging, no distinction between
  "denied"/"unavailable"/"filtered" repos (they're simply absent), and the loading
  vs empty vs error states must not leak timing/cause. The picker adds no
  enumeration oracle beyond the server's denylist-before-authz gate.
- **R4** — Reconcile `launchRun` to the wire: body `{repo:"owner/repo", prompt,
  idempotencyKey}`, `X-CSRF-Token` + `idempotency-key` headers (never body), keep
  reject-before-fetch guards, `redirect:'error'`.
- **R5** — Wire the launch form to `POST /operator/runs`: CSRF-on-submit (D3),
  mandatory idempotency key (D6), map `202 {runId}` to the observe handoff. Treat
  ALL post-submit `400`s as ONE generic launch failure — do NOT special-case the
  gateway's post-authz `400 {error:'prompt is required'}` (surfacing it would be a
  weak oracle that the repo was found+authorized); the only prompt-required signal
  the UI shows is a PURELY LOCAL pre-fetch empty-prompt validation. `404` → one
  uniform not-found/unavailable state (no cause); `429` → rate-limited copy.
- **R6** — Launch→observe handoff (D5): on `202`, insert an optimistic pending run
  card with the `data-run-id`/`data-role` hooks and call `initOperatorStream`
  directly.
- **R7** — First-frame timeout in the SSE client (D2): add a DISTINCT reducer
  event (e.g. `first-frame-timeout`) and a distinct connection state (e.g.
  `submitted-unobservable`) — it must NOT overwrite `not-found` or a terminal
  `failed`/`closed`. If no `ready`/`status` frame arrives within a bounded window
  after opening (define the constant in planning), transition to that state with a
  manual retry. Drive it from the pure state machine so it's unit-testable; bounded,
  no indefinite spinner.
- **R8** — Surface the v1 caveats in copy: status-only observation, tool-approval
  auto-deny, repos are access-scoped. Keep dashboard-vs-gateway auth copy distinct.
- **R9** — Build + test all of the above NOW behind the operator-UI flag against
  the released contract; the live connection is gated on the auth cutover
  (#53/#59) and the flag — no live flip in this slice.
- **R10** — Tests: contract conformance (1.2.0 + RepoSummary guard accept/reject),
  repos consumer (parse, 401/429/503 fail-closed), launchRun wire shape + CSRF/
  idempotency reject-before-fetch + header pinning, the CSRF refresh-and-retry,
  the launch→observe handoff, the first-frame-timeout state, the never-streams
  degrade, and no-leak (prompt/csrf/idempotency never rendered or logged; runId
  not logged).

## Security invariants (load-bearing)

- **S1** — Browser-direct launch POST with `credentials:'include'` +
  `redirect:'error'`, using SAME-ORIGIN relative URLs only and relying on the
  gateway's server-side Origin + Fetch-Metadata enforcement (no CORS relaxation,
  no cross-origin call). The dashboard does NOT become a credential-forwarding
  proxy for `/operator/runs` (only the auth middleware forwards the cookie,
  server-side, for `getCurrentSession`).
- **S2** — CSRF + idempotency travel as headers, never in the body. Never log or
  render prompt, csrf token, idempotency key, or the dynamic runId. Browser-side
  specifically: no `console.*`, `data-*` attributes, analytics/telemetry, or error
  copy that echoes the prompt, csrf, idempotency key, request body, or response
  payload; the `runId` may appear in client state/the stream URL but stays a safe
  field only (never logged).
- **S3** — The repo picker renders only display-safe `RepoSummary` fields from a
  single normalized success shape (R3) and adds no enumeration oracle. On launch,
  ALL post-submit `400`s collapse to one generic failure and all `404`s to one
  uniform not-found state — the client never special-cases the post-authz
  `prompt is required` 400 (R5), so it reintroduces no cause oracle.
- **S4** — The launch response `runId` is the first non-fixture value to enter the
  render path — apply the same safe-field discipline as the SSE consumer
  (`toSafeRunView`); render only safe fields.
- **S5** — Read-only-by-construction is *intentionally* relaxed ONLY for this one
  audited mutating route (`POST /operator/runs`) behind operator auth + CSRF. The
  browser may invoke ONLY this single audited launch route — NOT any other
  write-capable gateway API, and not an arbitrary/client-controlled repo target
  (the repo is server-resolved). No other write path is introduced; the launch
  mints a run through the gateway's own engine and the dashboard gains no
  repo-write access.
- **S6** — Idempotency is mandatory (D6): every launch carries a fresh key and the
  one CSRF retry reuses it, so a lost-response retry cannot double-launch.

## Non-goals (deferred)

- **N1** — The approval **decision** transport (gateway Unit 6, still upstream);
  #48 (approval deadline UI) waits on its canonical signal.
- **N2** — Run **output text** streaming (agent#965) — observation stays
  status-only.
- **N3** — The live flag flip / auth cutover (#53/#59). This slice builds behind
  the flag; it does not flip it.
- **N4** — Pagination for the repos list (the v1 contract caps at 100, no pages).

## Constraints

- Node 24 strip-only TS server-side; `public/*.js` plain browser ESM, no build
  step. `Result<T,E>` boundaries; same-origin relative `/operator/*`.
- Vendored contract is the single pin; author parse guards locally (no upstream
  helper for `RepoSummary`/launch DTOs).
- Fail closed on every denial/error; never render a guessed or unconfirmed run
  outcome.

## Success criteria

- An operator can select a repo (from the access-scoped list), enter a prompt,
  launch, and watch the run go live via the SSE stream — when the gateway session
  is live and the flag is on.
- A launched run that never streams degrades to a clear pending/unknown state, not
  a hang.
- With the session not yet live, the whole loop is built + unit-tested behind the
  flag/mock seam; nothing live is wired beyond the existing posture.
- No security invariant (S1–S5) is weakened; gates green (`pnpm check-types`,
  `pnpm lint`, `pnpm test`).

## Open questions for planning

- Whether `listRepos()` is a new method on the existing `OperatorClient` seam (it
  should be — reuse the injected-fetch + Result + logging discipline).
- The exact bounded first-frame-timeout value (R7) and where it lives in the SSE
  client (a new timer in `initOperatorStream`, exposed/testable via the pure core).
- How the repo picker renders (a `<select>` vs a list) and how the launch form
  composes with it (the existing disabled skeleton is the starting shape).
- Whether the optimistic pending card reuses the SSR run-card markup or a new
  client-built element (must carry the same `data-run-id`/`data-role` hooks).
- Idempotency-key generation (a per-submit UUID) and whether a resubmit of the
  same form reuses the key (it should, to dedupe a double-click).
