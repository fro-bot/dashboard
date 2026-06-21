---
title: 'feat: Consume the operator launch surface (repo list + launch + observe)'
type: feat
status: active
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-003-feat-operator-launch-surface-consumer-requirements.md
issue: fro-bot/dashboard#47
upstream: fro-bot/agent v0.73.0 (#968, operator contract 1.2.0)
---

# feat: Consume the operator launch surface (repo list + launch + observe)

## Overview

Build the operator launch loop in the dashboard against the released agent v0.73.0
operator contract `1.2.0`: list launchable repos (`GET /operator/repos`), launch a
run (`POST /operator/runs` → `202 {runId}`), and observe it live by reusing the
#63 SSE consumer. This is the dashboard's first mutating-route consumer, built
behind the operator-UI flag; the live connection is deferred to the auth cutover
(#53/#59). (see origin)

## Problem Frame

The gateway shipped + released the launch surface (v0.73.0, contract 1.2.0). The
dashboard pins `1.1.0`, shows a disabled launch skeleton + a "repository selection
unavailable" notice, and has only a mock `launchRun`. This is the launch slice of
#47 — the third capability after auth (#53) and SSE observation (#63).

## Requirements Trace

- R1 vendor contract 1.2.0 + `RepoSummary` guard → Unit 1.
- R2 `GET /operator/repos` consumer → Unit 2.
- R3 repo picker (normalized, no oracle) → Unit 5.
- R4 reconcile `launchRun` to the wire → Unit 3.
- R5 wire the launch POST (CSRF, all-400s-generic) → Unit 3/5.
- R6 launch→observe handoff (optimistic card) → Unit 5.
- R7 SSE first-frame timeout → Unit 4.
- R8 v1 caveats in copy → Unit 5.
- R9 build-behind-flag → all units. R10 tests → every unit.
- S1–S6 security → Units 2/3/4/5. (see origin R1–R10, S1–S6, D1–D6)

## Scope Boundaries

- Operator launch + repo list + launch→observe handoff only.
- No approval **decision** transport (gateway Unit 6; #48 waits on it).
- No run **output text** streaming (agent#965) — observation stays status-only.
- No live flag flip / auth cutover (#53/#59) — built behind the flag.
- No pagination for the repos list (v1 caps at 100).

### Deferred to Separate Tasks

- Approval decision UI + #48 deadline UI: separate slice, gated on gateway Unit 6.
- Output-text streaming consumer: separate slice, gated on agent#965.

## Context & Research

### Research-grounded facts (authoritative — from released v0.73.0 source + dashboard seams)

- **Contract 1.2.0 is purely additive**: the only new vendorable artifact is
  `RepoSummary { readonly owner: string; readonly repo: string; readonly
  channelName?: string }` (`channelName` key absent when empty). `OperatorRunStatus`
  + SSE frames are byte-identical to 1.1.0. No upstream parse helper for
  `RepoSummary` or the launch DTOs — author guards locally.
- **`GET /operator/repos`**: bare `RepoSummary[]` (not wrapped), cap 100, no
  pagination, `Cache-Control: no-store, private`, 20/min. Errors 401/429/503.
- **`POST /operator/runs`**: body `{repo:"owner/repo", prompt, idempotencyKey?}`,
  `X-CSRF-Token` header, → `202 {runId}`. 3/min + 10/hr. Errors `400 {error:'bad
  request'}`, `400 {error:'prompt is required'}` (post-authz), `404
  {error:'not-found'}` (uniform), `429 {error:'rate limited'}`. Server parses
  `owner/repo`.
- **CSRF**: `GET /operator/session/csrf` → `{csrfToken}` (already vendored as
  `parseOperatorCsrfToken`/`CsrfDto`).
- **Dashboard seams already present**: `src/gateway/operator-client.ts` has a mock
  `launchRun` (sends `x-csrf-token` + `idempotency-key` headers, rejects-before-
  fetch, `redirect:'error'`) but its `LaunchRunRequest` uses separate `{owner,
  repo}` — reconcile to the wire's single `repo` string. `refreshCsrf()` exists
  (`GET /operator/session/csrf`). The UI has a disabled `launchSection()` +
  `bindingUnavailableSection()` (the exact seams to replace). The #63
  `initOperatorStream` is exported and takes `{runId, statusEl, noticeEl}` (does
  NOT self-discover elements); `bootstrapOperatorStreams` scans `[data-run-id]`.
- **Browser-client gap**: today the operator client's injected `fetch` is
  server-side only (the cookie-forwarding adapter for `getCurrentSession`); the
  browser bundle uses raw `fetch`. The launch POST needs a NEW browser entrypoint
  that injects a browser fetch adapter into `createOperatorClient`.

### Institutional Learnings

- `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md`
  — the SSE consumer patterns this handoff reuses.
- `docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md`
  — the no-leak/no-oracle operator-client contract this extends.
- `docs/solutions/security-issues/gateway-operator-session-cookie-forwarding-trust-boundary-2026-06-20.md`
  — why the launch POST is browser-direct, not a dashboard proxy.

## Key Technical Decisions

- **KTD1 — Vendor `RepoSummary` + a local parse guard; version bump only.** Add
  `src/gateway/operator-contract/repo-summary.ts` (`RepoSummary` + a hand-rolled
  `parseRepoSummary`/`parseRepoSummaryList` following the existing no-oracle/
  fixed-reason-string pattern). Bump `version.ts` to `'1.2.0'`; update conformance
  + README provenance (tag v0.73.0). Do NOT touch run-status/SSE (unchanged).
- **KTD2 — `listRepos()` on the existing `OperatorClient` seam.** Reuse the
  injected-fetch + `Result` + route-template-logging discipline; expect a bare
  `RepoSummary[]`, parse each item, fail closed on 401/429/503.
- **KTD3 — Reconcile `launchRun` to the wire.** Body `{repo:"owner/repo", prompt,
  idempotencyKey}`; keep `x-csrf-token` + `idempotency-key` as headers,
  reject-before-fetch guards, `redirect:'error'`. Update fixtures/tests.
- **KTD4 — A new browser operator-client entrypoint.** A static `.js` (sibling to
  `operator-stream.js`) that constructs an `OperatorClient` with a browser fetch
  adapter (`credentials:'include'`, `redirect:'error'`), drives the repo picker +
  launch form, and performs the launch→observe handoff. Pure logic (CSRF-retry
  state, idempotency-key minting, handoff) factored as testable exports; DOM
  wiring browser-only-guarded.
- **KTD5 — Mandatory idempotency + one CSRF retry reusing the key.** Mint a fresh
  key per submit; the single retry on a post-selection 400 reuses it so a
  lost-response retry dedupes. Cap retry at one; no retry on 404/429/202.
- **KTD6 — Launch→observe via direct `initOperatorStream`.** On 202, insert an
  optimistic pending card into `#run-status-section` carrying `data-run-id` +
  `[data-role="run-status"]` + the shared `[data-role="stream-status"]`, then call
  `initOperatorStream` directly. Do NOT re-run `bootstrapOperatorStreams`.
- **KTD7 — SSE first-frame timeout as a distinct reducer state.** Add a
  `first-frame-timeout` event + a `submitted-unobservable` connection state to the
  pure state machine (must not overwrite `not-found`/`failed`/`closed`), with a
  bounded timer in `initOperatorStream` and a manual retry. Drives the agent#966
  never-streams degrade.
- **KTD8 — Normalized repo picker, all-400s-generic.** Render the picker from a
  single normalized success shape (no count/ordering/timing/per-item-denial
  inference). Treat ALL post-submit 400s as one generic failure (never special-
  case the post-authz `prompt is required`); the only prompt-required signal is a
  local pre-fetch validation. 404 → one uniform state.

## Open Questions

### Resolved During Planning (from research)

- Contract delta: `RepoSummary` only, version-only bump — KTD1.
- Launch POST path: browser-direct via a new entrypoint — KTD4.
- Handoff: direct `initOperatorStream`, not bootstrap re-run — KTD6.
- CSRF/idempotency: fresh-on-submit, mandatory key, one retry — KTD5.

### Deferred to Implementation

- The exact first-frame-timeout constant (KTD7) and reconnect interaction.
- Repo picker render form (`<select>` vs list) and how selection composes with the
  prompt field in the existing disabled skeleton.
- Whether the optimistic pending card reuses SSR run-card markup or a client-built
  element (must carry the same hooks).
- Idempotency-key generation (per-submit UUID) + double-click dedupe behavior.

## High-Level Technical Design

> *Directional guidance for review, not implementation specification.*

```
operator page (SSR, flag-gated)
  repo picker (from listRepos) + launch form  →  <script src=/static/operator-launch.js>
        │
public/operator-launch.js  (new browser entrypoint; pure core + DOM shell)
  client = createOperatorClient({ fetch: browserFetch(credentials:'include',redirect:'error'), createEventStream, logger })
  submit():
    csrf = await client.refreshCsrf()               # fresh on submit
    key  = mintIdempotencyKey()                      # mandatory, reused on retry
    res  = await client.launchRun({repo:"o/r", prompt, csrfToken:csrf, idempotencyKey:key})
       ├ 202 {runId} → insert optimistic pending card → initOperatorStream({runId, statusEl, noticeEl})
       ├ 400 (post-selection) → refreshCsrf + retry ONCE (same key) → else generic failure
       ├ 404 → uniform not-found    └ 429 → rate-limited copy
  SSE client (operator-stream.js): + first-frame-timeout → 'submitted-unobservable' (agent#966 degrade)
```

## Implementation Units

- [ ] **Unit 1: Vendor contract 1.2.0 + `RepoSummary` + parse guard**

**Goal:** Bump the pinned contract to 1.2.0 and add the `RepoSummary` type + a local parse guard.

**Requirements:** R1, KTD1

**Dependencies:** None

**Files:**
- Modify: `src/gateway/operator-contract/version.ts` (`'1.1.0'` → `'1.2.0'`)
- Create: `src/gateway/operator-contract/repo-summary.ts` (`RepoSummary` + `parseRepoSummary`/`parseRepoSummaryList`)
- Modify: `src/gateway/operator-contract/index.ts` (export), `README.md` (provenance → v0.73.0)
- Test: `test/operator-contract-conformance.test.ts` (version 1.2.0; RepoSummary type + guard accept/reject)

**Approach:** Add `RepoSummary` verbatim (readonly owner/repo/channelName?). Author `parseRepoSummary` with the existing hand-rolled type-guard + fixed-reason-string (no-oracle) pattern from `parse.ts`; `parseRepoSummaryList` validates a bare array and fails closed on any bad item. Bump version. Do NOT touch run-status.ts / sse-frames.ts.

**Execution note:** Test-first for the guard + version conformance.

**Patterns to follow:** `src/gateway/operator-contract/parse.ts` (the four `parseOperator*` guards); the #63 sse-frames vendoring + conformance style.

**Test scenarios:**
- Happy path: a valid `{owner, repo, channelName}` and a valid `{owner, repo}` (no channelName) parse; a bare array of valid items parses.
- Edge: `channelName` absent vs empty-string; extra fields ignored (existing extra-field policy).
- Error path: missing/non-string owner/repo → parse failure (fixed reason, no input echo); a list with one bad item fails the whole list closed; non-array input fails.
- Conformance: `OPERATOR_CONTRACT_VERSION === '1.2.0'`; `RepoSummary` assignable.

**Verification:** Version pinned 1.2.0; `RepoSummary` + guard vendored faithfully; gates green.

- [ ] **Unit 2: `listRepos()` consumer**

**Goal:** Add a `GET /operator/repos` consumer to the operator client.

**Requirements:** R2, S3, KTD2

**Dependencies:** Unit 1

**Files:**
- Modify: `src/gateway/operator-client.ts` (`listRepos()` method + `OperatorClient` interface)
- Test: `test/operator-client.test.ts` (listRepos path/parse/error scenarios), `test/operator-mock-client.ts` + `test/operator-ui.test.ts` fake (add a throwing `listRepos`)

**Approach:** `listRepos(): Promise<Result<RepoSummary[], GatewayClientError>>` via `fetchJson` against relative `/operator/repos` (route template for logs). Parse with `parseRepoSummaryList` (fail closed on bad shape → protocol error). Map 401→http, 429→http, 503→http; never assume pagination. Add `listRepos` to the throwing fakes so SSR render never calls it.

**Execution note:** Test-first.

**Patterns to follow:** `getCurrentSession`/`refreshCsrf` (parse + Result + route-template logging); the `makeFakeOperatorClient` throwing pattern.

**Test scenarios:**
- Happy path: 200 bare `RepoSummary[]` → ok with parsed items; path pinned `/operator/repos`.
- Edge: empty array → ok empty; a 200 with a non-array body → protocol error (fail closed).
- Error path: 401/429/503 → typed http error; malformed item in the array → protocol error, no partial list.
- No-leak: no repo names in any logged line (route template only).

**Verification:** Consumer parses + fails closed on every non-happy path; gates green.

- [ ] **Unit 3: Reconcile `launchRun` to the wire shape**

**Goal:** Align the mock `launchRun` to the released wire contract.

**Requirements:** R4, R5, S2, S6, KTD3, KTD5

**Dependencies:** Unit 1

**Files:**
- Modify: `src/gateway/operator-client.ts` (`LaunchRunRequest`/`launchRun` body → single `repo:"owner/repo"`; keep CSRF/idempotency headers + reject-before-fetch)
- Modify: `src/gateway/operator-fixtures.ts` (`FIXTURE_LAUNCH_REQUEST` to the new shape)
- Test: `test/operator-client.test.ts` (launchRun wire shape, header pinning, reject-before-fetch, 202/400/404/429 mapping)

**Approach:** Change `LaunchRunRequest` to carry `repo: string` ("owner/repo") instead of separate owner/repo (keep `prompt`, `idempotencyKey`, `csrfToken`). Body = `{repo, prompt}` only; `x-csrf-token` + `idempotency-key` stay headers; `redirect:'error'`. Keep `requireCsrf`/`requireIdempotencyKey` reject-before-fetch. Map `202 {runId}` to the response; map errors to the typed union. Update the launch fixture (a no-leak-pinned value).

**Execution note:** Test-first.

**Patterns to follow:** the existing `launchRun`/`decideApproval` mutating-call + CSRF/idempotency-header tests in `test/operator-client.test.ts`.

**Test scenarios:**
- Happy path: `launchRun({repo:'owner/repo', prompt, csrfToken, idempotencyKey})` → POST `/operator/runs`, body `{repo, prompt}`, headers carry the csrf + idempotency values (pinned); 202 `{runId}` → ok.
- Edge: blank csrfToken / blank idempotencyKey → validation error, `fetchCalled === false`.
- Error path: 400 → http error; 404 → http error (uniform); 429 → http error.
- No-leak: prompt/csrf/idempotency never in the body's csrf/idempotency slots or logs.

**Verification:** `launchRun` matches the released wire shape; reject-before-fetch holds; gates green.

- [ ] **Unit 4: SSE first-frame timeout (`submitted-unobservable`)**

**Goal:** Add a bounded first-frame timeout to the #63 SSE client for the never-streams degrade.

**Requirements:** R7, KTD7

**Dependencies:** None (extends the merged #63 client)

**Files:**
- Modify: `public/operator-stream.js` (a `first-frame-timeout` event + `submitted-unobservable` state in `nextStreamState`; a bounded timer in `initOperatorStream` cleared on the first frame)
- Modify: `public/operator-stream.d.ts` (the new event + state)
- Test: `test/operator-stream-core.test.ts` (reducer: first-frame-timeout → submitted-unobservable; does not overwrite not-found/failed/closed; a frame before timeout cancels it)

**Approach:** New reducer event `{type:'first-frame-timeout'}` → if still `connecting` (no frame yet), → `submitted-unobservable` (distinct, manual-retry-able); if already `live`/`drift`/terminal, no-op. In `initOperatorStream`, arm a bounded timer on open, clear it on the first dispatched frame; on fire, dispatch the event. Bounded constant (define value here).

**Execution note:** Test-first for the reducer transition + the no-overwrite guard.

**Patterns to follow:** the existing `nextStreamState` events + the bounded-timer/`MAX_SSE_BUFFER_BYTES` discipline in `operator-stream.js`.

**Test scenarios:**
- Happy path: timeout while connecting → `submitted-unobservable`.
- Edge: a `ready`/`status` frame before timeout cancels it (stays live); timeout after a terminal status is a no-op.
- Edge: timeout does NOT overwrite `not-found`, `failed`, or `closed`.

**Verification:** A launched-but-silent run degrades to a clear unobservable state, not a hang; gates green.

- [ ] **Unit 5: The browser launch entrypoint + UI wiring**

**Goal:** The new browser entrypoint + the operator UI: repo picker, launch form, launch→observe handoff, v1 caveat copy.

**Requirements:** R3, R5, R6, R8, R9, S1, S2, S3, S4, S5, KTD4, KTD6, KTD8

**Dependencies:** Units 1–4

**Files:**
- Create: `public/operator-launch.js` (browser entrypoint: pure core — CSRF-retry state, idempotency minting, handoff builder — + DOM shell) and `public/operator-launch.d.ts`
- Create: `test/operator-launch-core.test.ts`
- Modify: `src/routes/operator.ts` (replace `bindingUnavailableSection` with a repo-picker container fed at render or by the script; replace the disabled `launchSection` with a live form; reference `<script src="/static/operator-launch.js" type="module">`; v1-caveat copy)
- Modify: `test/operator-ui.test.ts` (repo picker + live form render; script referenced; no-leak; flag-off absence)

**Approach (KTD4/KTD6/KTD8):** The entrypoint builds an `OperatorClient` with a browser fetch adapter (`credentials:'include'`, `redirect:'error'`) and `createEventStream` (the #63 reader). Pure, testable exports: a `submitLaunch` state machine (mint key → refreshCsrf → launchRun → on post-selection 400, refresh + retry once same key → map 202/404/429 to outcomes), a `mintIdempotencyKey`, and a `buildPendingCard`/handoff that returns the element hooks. DOM shell: render the picker from `listRepos` (single normalized shape — no count/order/timing inference), wire submit, on 202 insert the optimistic pending card + call `initOperatorStream` directly. Browser-only-guard the DOM, keep pure logic importable by vitest. Render only safe fields; no `console.*`/`data-*`/error-copy leaks of prompt/csrf/idempotency/runId. Surface v1 caveats (status-only, tool-approval auto-deny, access-scoped repos) in copy.

**Execution note:** Test-first for the pure core (submit state machine, idempotency, handoff builder).

**Patterns to follow:** `public/operator-stream.js` (pure-core + browser-guarded shell + `.d.ts`); `runStatusSection` DOM hooks; the no-leak fixture-literal assertions in `test/operator-ui.test.ts`.

**Test scenarios (pure core):**
- Happy path: submit → mint key → refreshCsrf → launchRun → 202 → handoff returns `{runId, statusEl, noticeEl}`.
- CSRF retry: a post-selection 400 → one refresh+retry REUSING the same idempotency key → success; a second 400 → generic failure (no further retry).
- Error path: 404 → uniform not-found outcome; 429 → backpressure outcome; retry never fires on 404/429/202.
- Idempotency: a double-submit reuses the in-flight key (no second key minted).
- No-oracle: all post-submit 400s map to ONE generic outcome (the post-authz `prompt is required` is not special-cased); local empty-prompt is a pre-fetch validation only.
- Repo picker: renders from a normalized list; empty/error states carry no cause/timing/count inference.
- No-leak (UI test): prompt/csrf/idempotency fixture literals never in rendered HTML; runId-safe-field only.
- Flag-off: no launch script, no picker/form (operator route absent).

**Verification:** The full launch loop is built + unit-tested behind the flag; no security invariant weakened; gates green.

- [ ] **Unit 6: Documentation — launch-surface consumer learning (optional)**

**Goal:** Capture any non-obvious learning (the browser-client entrypoint pattern, the first-mutating-route posture) in `docs/solutions/` if warranted.

**Requirements:** (project convention)

**Dependencies:** Units 1–5

**Files:** Create `docs/solutions/<category>/<slug>-2026-06-20.md` (only if warranted)

**Approach:** Follow the solution-doc structure; skip if nothing non-obvious arose.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** Documented if warranted, else skipped.

## System-Wide Impact

- **First mutating-route consumer** in a read-only-by-construction app — bounded to
  the single audited `POST /operator/runs` (S5); no other write path; browser-direct
  (not a dashboard proxy).
- **First browser operator-client entrypoint** — establishes the browser-fetch-
  adapter pattern (`credentials:'include'`); the auth-middleware's server-side
  cookie-forwarding adapter and its throwing SSE stub stay unchanged.
- **Auth interaction:** the launch script + picker live under the operator UI
  (flag-gated, behind operator auth); the static `/static/*` path stays public so
  the script loads. Live launch is gated on the gateway session (#53/#59).
- **Redaction/no-leak:** the repos list + launch path render only display-safe
  fields; the runId is the first non-fixture value to enter render — same
  `toSafeRunView` discipline; uniform 404/400 — no client oracle.
- **Unchanged invariants:** `OperatorRunStatus`/SSE frames (1.2.0 additive only);
  the #63 SSE transport (only extended with the timeout state); the auth middleware.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| First mutating route in a read-only app | Bound to one audited route (S5); browser-direct; CSRF + mandatory idempotency |
| Retry-on-400 double-launch | Mandatory idempotency key reused on the single retry (KTD5/S6) |
| Repo picker enumeration oracle | Server denylist-before-authz + single normalized client shape, no inference (KTD8/S3) |
| Client-side leak (prompt/runId/csrf) | No console/data-*/error-copy leaks; safe-field render only (S2/S4) |
| Launched run never streams (agent#966) | First-frame timeout → submitted-unobservable degrade (Unit 4/KTD7) |
| Live path not testable until #53/#59 | Build + unit-test behind the flag/mock seam; live wiring deferred |
| Browser-client entrypoint is net-new | Mirror the #63 pure-core + browser-guarded-shell + `.d.ts` pattern (KTD4) |

## Documentation / Operational Notes

- New static asset `public/operator-launch.js` ships in the image (Dockerfile
  already copies `public/`). No new env vars. No new dependency.
- v1 caveats (status-only, tool-approval auto-deny) documented in the PR + UI copy.

## Sources & References

- Origin: docs/brainstorms/2026-06-20-003-feat-operator-launch-surface-consumer-requirements.md
- Upstream (verbatim): agent `packages/gateway/src/operator-contract/repo-summary.ts`,
  `packages/gateway/src/web/operator/{repos-route,launch-route,idempotency}.ts`,
  `web/auth/csrf-route.ts` @ v0.73.0 (#968)
- Dashboard seams: `src/gateway/operator-client.ts`, `src/gateway/operator-contract/`,
  `src/routes/operator.ts`, `public/operator-stream.js`, `test/operator-{client,ui,stream-core}.test.ts`
- Issues: advances #47; gated by #53/#59; degrade tracks agent#966; defers #48, agent#965
