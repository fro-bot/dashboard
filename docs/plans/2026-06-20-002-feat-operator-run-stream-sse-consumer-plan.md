---
title: 'feat: Consume the operator run-stream SSE endpoint'
type: feat
status: active
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-002-feat-operator-run-stream-sse-consumer-requirements.md
issue: fro-bot/dashboard#63
parent: fro-bot/dashboard#47
upstream: fro-bot/agent v0.72.0 (#955 version bump, #961/#962 SSE)
---

# feat: Consume the operator run-stream SSE endpoint

## Overview

Replace the dashboard's mock run-observation with a real consumer of the gateway
SSE run-stream (`GET /operator/runs/:runId/stream`, contract 1.1.0). A same-origin
browser fetch-stream SSE reader renders live run status with the full documented
lifecycle. Built now behind the existing mock seam; real live connection is gated
on the gateway-session auth (#53) being live. (see origin)

## Problem Frame

Gateway v0.72.0 shipped the authenticated SSE run-stream; the dashboard renders
fixtures and pins contract `1.0.0` with a mock `RunStreamEvent` union. This is the
SSE run-stream slice of #47.

## Research-grounded facts (authoritative — supersede assumptions)

- **The contract DTO did NOT change 1.0.0 → 1.1.0.** `OperatorRunStatus` and
  `OperatorWebStatus` are byte-identical. The 1.1.0 bump (agent PR #955) was an
  internal `toOperatorRunStatus`/`RunStatusRepoKey` change the dashboard does not
  vendor. So the bump is: set `OPERATOR_CONTRACT_VERSION = '1.1.0'` + add the SSE
  frame types. No edit to the vendored `run-status.ts` DTO.
- **The SSE frames live in `web/sse/`, NOT the contract barrel.** Vendor them as a
  dashboard-local `src/gateway/operator-contract/sse-frames.ts` (a parallel local
  file), not as a contract-barrel mirror. Wire frames (verbatim from source):
  - `event: ready`  → `{ contractVersion: string }`
  - `event: status` → `OperatorRunStatus` (`{runId, entityRef, surface, phase, status, startedAt, stale}`)
  - `event: reset`  → `{ runId: string, reason: ResetReason }`
  - `ResetReason = 'no-snapshot' | 'terminal' | 'shutdown' | 'max-duration' | 'writer-error' | 'overflow'`
  - heartbeat is an SSE comment `: heartbeat` (no named event) — ignored.
- **Terminal `OperatorWebStatus`:** `succeeded`, `failed`, `cancelled`. Active:
  `queued`, `running`, `waiting_for_approval`, `blocked`.
- **Errors:** `404 {"error":"not-found"}`, `429 {"error":"rate limited"}` (note the
  space), success `Content-Type: text/event-stream` (the stream IS the success).
- **Native `EventSource` cannot read HTTP status on failure** → use a `fetch` +
  `ReadableStream` SSE reader (sees status + body), `credentials: 'include'`,
  same-origin. This also removes EventSource auto-reconnect, giving explicit
  lifecycle control. (origin D2a)
- **Net-new infra:** the dashboard has NO static-serving, NO CSP/security headers,
  and NO client JS today. `serveStatic` and `secureHeaders` ship inside `hono`
  (no new dependency). A tight CSP (`script-src 'self'`, no inline) requires
  **extracting the existing inline `<style>${raw(OPERATOR_PAGE_STYLES)}</style>`
  (operator.ts) to an external CSS file**.
- **Logger:** `runId` is NOT auto-redacted (no matching sensitive pattern) — never
  put it in a log line; log the route template `'/operator/runs/:runId/stream'`.
- **Seam:** `OperatorClient.connectRunStream(runId, {onEvent,onError,onClose,lastEventId})`
  → `Result<EventStreamHandle>`; validates runId before creating the stream;
  transport injected via `OperatorClientOptions.createEventStream(path, opts)`.
  The auth-middleware stub throws and MUST stay throwing — build the real stream
  client in the operator route path.

## Requirements Trace

- R1 contract bump → Unit 1. R2 fetch-stream transport → Unit 3. R3 static client
  asset → Unit 4. R4 named-frame parsing → Units 1/3/5. R5 lifecycle → Unit 5.
  R6 404/429 UI → Unit 5/6. R7 contract-version fail-closed gate → Unit 3/5.
  R8 build-behind-mock → all units. R9 tests → every unit. S1–S5 security → Units
  2/3/5/6. (origin R1–R9, S1–S5, D1–D4)

## Security Trace (load-bearing)

- **S1/S1a** — no client `console.*`/`data-*`/error-copy leaks of frame data, run
  IDs, repo names, status payloads, or stream URLs; render only phase/status/
  timestamps; runId rides the URL (accepted) but is never logged/copied/persisted.
- **S2** — client never sends a repo identifier; server resolves runId→repo.
- **S3** — all 404s collapse to ONE state, ONE retry policy; no cause inference via
  copy/timing/retry (no client-side oracle).
- **S4** — read-only: GET stream only; lifecycle issues no POST/PUT/DELETE, no
  telemetry/logging endpoint, no state-mutating reconnect.
- **S5** — same-origin precondition; rely on the gateway Origin/Sec-Fetch guard;
  fail closed if not same-origin; never proxy/rewrite the URL to work around it.

## Scope Boundaries

- Operator run **observation** only. No launch/approval routes (#47 N1, gated on
  Unit 5/6), no approval expiry UI (#48 N2), no flag flip / cutover (#59/#53 N3),
  no Last-Event-ID replay (contract has none — N4).
- The SSE frame types are dashboard-local (not a contract-barrel mirror); they may
  evolve without a contract-version bump, like the current mock union.

### Deferred to Separate Tasks

- #47 launch + approval-decision routes; #48 deadline UI; #59/#53 cutover.

## Key Technical Decisions

- **KTD1 — `sse-frames.ts` as a local file, version bump only.** Add
  `src/gateway/operator-contract/sse-frames.ts` with `ReadyFrame`,
  `StatusFrameData = OperatorRunStatus`, `ResetFrameData`, `ResetReason`. Bump
  `version.ts` to `'1.1.0'`; update the README provenance + conformance test. Do
  NOT edit the vendored `run-status.ts` DTO (unchanged upstream).
- **KTD2 — Replace the mock `RunStreamEvent` union** in `operator-client.ts` with
  the canonical named frames (`ready`/`status`/`reset`) for this endpoint, typed
  off `sse-frames.ts`. Keep `connectRunStream`'s runId-validation-before-create
  and route-template-only logging.
- **KTD3 — fetch-stream SSE reader** (not EventSource). A `createServerSentEventReader`
  factory: `fetch(path, {credentials:'include', signal})`, branch on
  `response.status` (200 → read body; 404/429 → typed denial/backpressure; else →
  network error), parse the `text/event-stream` body incrementally (split on
  `\n\n`, parse `event:`/`data:` lines, ignore `:` comments), dispatch named
  frames, no auto-reconnect (caller owns it). Fail closed.
- **KTD4 — Contract-version gate is fail-closed (security).** On the `ready` frame,
  compare `contractVersion` to `OPERATOR_CONTRACT_VERSION`; on mismatch, surface a
  drift state and render NO `status`.
- **KTD5 — Client JS as an external static asset + tight CSP.** New `public/`
  served via `hono/serveStatic` at a flag-gated path added to `isPublicPath`;
  `hono/secureHeaders` adds CSP (`default-src 'self'`, `script-src 'self'`,
  `style-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, etc., no
  inline). Extract `OPERATOR_PAGE_STYLES` to `public/operator.css`. Dockerfile
  copies `public/`.
- **KTD6 — Pure client core + thin DOM layer.** The client `.js` factors into pure,
  vitest-testable functions (frame parser + lifecycle state machine) and a minimal
  DOM-wiring shell, so the lifecycle/parse logic is unit-tested without a browser.
- **KTD7 — Lifecycle close-vs-retry rules** (R5): terminal status → close;
  reset → close + resubscribe; max-duration reset → reconnect iff last status
  non-terminal, bounded backoff; unexpected close → re-establish if authorized,
  bounded retries → failed state.

## Open Questions

### Resolved During Planning (from research)

- Contract delta: version-only + SSE frames (no DTO change) — KTD1.
- Transport: fetch-stream reader, not EventSource — KTD3.
- Static/CSP: hono built-ins, extract inline style — KTD5.
- runId logging: route template only — research §7e.

### Deferred to Implementation

- Cache-Control for the static asset (`no-cache` vs content-hashed name).
- Exact backoff/max-retry constants (KTD7).
- Which run(s) the view subscribes to first (a selected run vs all active).
- Whether streamed status adopts the full `OperatorRunStatus` shape in the UI or a
  reduced render model (render only phase/status/timestamps per S1 regardless).

### Pre-flip gate (NOT a code task)

- Real live connection requires the gateway-session auth (#53) live (#59). This
  slice builds + tests behind the mock seam only.

## High-Level Technical Design

> *Directional guidance for review, not implementation specification.*

```
operator run view (SSR)
  renders run cards with data-run-id / data-role hooks + <link operator.css> + <script src=/static/operator-stream.js>
        │
public/operator-stream.js  (pure core + thin DOM)
  core: parseSseFrame(bytes) → ready|status|reset ; lifecycle state machine (terminal/reset/max-duration/unexpected)
  shell: fetch('/operator/runs/:id/stream', {credentials:'include', signal})
        → 200: read ReadableStream, dispatch frames, update DOM cards
        → 404: single not-found state (no cause)   → 429: backpressure state
        → ready.contractVersion mismatch: drift state, render no status (fail closed)
        → terminal status: close ; reset: resubscribe ; max-duration: reconnect-if-active ; unexpected: bounded retry
```

## Implementation Units

- [ ] **Unit 1: Vendor contract 1.1.0 + SSE frame types**

**Goal:** Bump the pinned contract to 1.1.0 and add canonical SSE frame types.

**Requirements:** R1, R4 (types), KTD1, KTD2

**Dependencies:** None

**Files:**
- Modify: `src/gateway/operator-contract/version.ts` (`'1.0.0'` → `'1.1.0'`)
- Create: `src/gateway/operator-contract/sse-frames.ts` (`ReadyFrame`, `StatusFrameData`, `ResetFrameData`, `ResetReason`)
- Modify: `src/gateway/operator-contract/index.ts` (export sse-frames), `README.md` (provenance → v0.72.0)
- Modify: `src/gateway/operator-client.ts` (replace mock `RunStreamEvent` union with canonical frames; keep RunStatus alias)
- Test: `test/operator-contract-conformance.test.ts` (version → 1.1.0; sse-frame type assignability), `test/operator-client.test.ts` (union rename)

**Approach:** Add `sse-frames.ts` with the verbatim wire shapes (KTD1). Bump version. Replace `RunStreamEvent` with `ready`/`status`/`reset`. Byte-check the frame shapes against agent v0.72.0 source. Do NOT touch the vendored `run-status.ts` DTO (unchanged).

**Execution note:** Test-first for the type assignability + version conformance.

**Patterns to follow:** the #49 vendoring pattern; `version.ts` increment-policy comment; conformance-test style.

**Test scenarios:**
- Conformance: `OPERATOR_CONTRACT_VERSION === '1.1.0'`.
- Type: a `ReadyFrame`/`ResetFrameData`/`StatusFrameData` literal is assignable; `ResetReason` accepts the 6 values and rejects others (compile-level).
- Edge: heartbeat is not a named frame (documented; no type).

**Verification:** Version pinned 1.1.0, frames vendored faithfully; gates green.

- [ ] **Unit 2: Security headers + CSP + static-style extraction (prerequisite infra)**

**Goal:** Add `secureHeaders`/CSP and move the inline operator styles to an external CSS asset, so a tight `script-src 'self'` CSP is possible for Unit 4.

**Requirements:** S1, S5, KTD5

**Dependencies:** None (independent of Unit 1)

**Files:**
- Modify: `src/server.ts` (add `hono/secureHeaders` middleware with the CSP; ensure it applies to all responses)
- Create: `public/operator.css` (extracted `OPERATOR_PAGE_STYLES`)
- Modify: `src/routes/operator.ts` (replace inline `<style>${raw(...)}</style>` with `<link rel="stylesheet" href="/static/operator.css">`)
- Modify: `src/server.ts` (mount `serveStatic` for `/static/*`, flag-gated, added to `isPublicPath`)
- Modify: `Dockerfile` (`COPY public/ ./public/`)
- Test: `test/server.test.ts` / a new `test/static-assets.test.ts` (CSP header present + correct; `/static/operator.css` served; static path is public/no-auth-redirect; static route absent when operator UI disabled)

**Approach:** `secureHeaders({contentSecurityPolicy: {...}})` with `default-src/script-src/style-src/connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`. Mount `serveStatic({root:'./public'})` at `/static/*` only when `operatorUiEnabled` (mirror the dynamic-import gating); add `/static/` to `isPublicPath` so unauthenticated asset GETs aren't 302'd. Extract the CSS string verbatim.

**Execution note:** Test-first for header presence + static serving + public-path behavior.

**Patterns to follow:** the existing `app.use('*', ...)` middleware order; `isPublicPath`; the operator dynamic-import gating; non-root container path (`./public` resolves from WORKDIR).

**Test scenarios:**
- CSP header present with `script-src 'self'`, no `'unsafe-inline'`.
- `/static/operator.css` returns 200 with the extracted CSS; correct content-type.
- Static path is reachable WITHOUT auth (not 302'd) — it's public.
- Operator page still renders with the `<link>` (no inline style).
- When `operatorUiEnabled` is false, the `/static/*` route is absent.

**Verification:** Tight CSP active, styles externalized, static serving works + flag-gated; gates green; container path resolves (smoke).

- [ ] **Unit 3: fetch-stream SSE reader transport**

**Goal:** A browser-and-test-friendly fetch-stream SSE reader that sees HTTP status, parses named frames, and fails closed — wired behind the `createEventStream` seam.

**Requirements:** R2, R6 (status), R7, S2, S3, S4, KTD3, KTD4

**Dependencies:** Unit 1 (frame types)

**Files:**
- Create: `src/gateway/operator-sse-reader.ts` (the fetch-stream reader factory + a pure SSE frame parser)
- Modify: `src/gateway/operator-client.ts` (the reader satisfies `EventStreamHandle`; surface initial status for 404/429)
- Test: `test/operator-sse-reader.test.ts` (inject a fake `fetch` returning a synthetic `Response` with a `ReadableStream` body + controllable status)

**Approach (KTD3/KTD4):** factory takes the relative path + a fetch impl; `fetch(path,{credentials:'include',signal})`; on `response.status` 200 read the body stream, incrementally split `\n\n`, parse `event:`/`data:` lines, ignore `:` comments, JSON-parse `data`, dispatch typed frames; 404 → typed `not-found` denial; 429 → typed `rate-limited`; other/throw → network error. On `ready`, enforce the contract-version gate (KTD4) — mismatch → fail closed, no status dispatched. Never include runId in any log (route template only). Client never adds a repo param (S2).

**Execution note:** Test-first; pure parser tested directly, reader tested with injected fetch.

**Patterns to follow:** `OperatorClientOptions.fetch` seam; `createOperatorServerFetch` injected-fetch test style; fixed-reason-string / no-oracle parse discipline (parse.ts); route-template logging (operator-client.ts:550).

**Test scenarios:**
- 200 + `ready{1.1.0}` then `status` → frames dispatched in order; status carries OperatorRunStatus.
- `ready` with mismatched contractVersion → fail closed, NO status dispatched (R7/KTD4).
- `reset{reason}` frame parsed for each ResetReason value.
- heartbeat comment line ignored (no frame).
- malformed/partial `data` → fail closed (no misparsed dispatch).
- 404 → typed not-found, body not branched on cause (S3); 429 → typed rate-limited.
- network throw/timeout (abort) → network error, fail closed.
- client never sends a repo identifier (assert the outgoing path/init).
- no runId in any logged line.

**Verification:** Reader distinguishes 200/404/429/network, parses named frames, gates on version, fails closed; gates green.

- [ ] **Unit 4: Static client script (pure core + DOM shell)**

**Goal:** The framework-free browser `.js` that opens the stream and updates the run cards, with a unit-tested pure core.

**Requirements:** R3, R4, R5, R6, S1, S1a, S4, KTD5, KTD6, KTD7

**Dependencies:** Unit 1 (frame shapes), Unit 2 (serving/CSP), Unit 3 (reader semantics mirrored client-side)

**Files:**
- Create: `public/operator-stream.js` (DOM shell) + a pure core module the tests import
- Create: `test/operator-stream-core.test.ts`
- Modify: `src/routes/operator.ts` (run cards get `data-run-id`/`data-role`/container id; `<script src>` referenced; stream-status notice hooks)

**Approach (KTD6/KTD7):** Factor the frame parser + lifecycle state machine as pure functions (no DOM) imported by vitest; the DOM shell is thin (querySelector + textContent/class updates only). Browser ES that runs as-is (no build). Lifecycle per KTD7. Render only phase/status/timestamps; never console-log or embed frame data beyond that (S1). All 404s → one not-found state, one retry policy (S3). No mutating calls (S4).

**Execution note:** Test-first for the pure core (parser + state machine); the DOM shell stays minimal.

**Patterns to follow:** the `makeEventStream` replay test pattern; `hono/html` auto-escape for interpolated `data-run-id`; no-leak fixture-literal pinning.

**Test scenarios (pure core):**
- parse ready/status/reset from raw SSE text; ignore heartbeat comment.
- state machine: terminal status → closed; reset → resubscribe; max-duration + active → reconnect; max-duration + terminal → no reconnect; unexpected close → bounded retries then failed.
- contract-version mismatch → drift state, no status applied.
- 404 → single not-found state; 429 → backpressure state (no cause branching).
- render model exposes only phase/status/timestamps (no raw output/tool/path/repo-name fields); no console output of frame data.

**Verification:** Pure core fully unit-tested; DOM shell minimal; no client leak; gates green.

- [ ] **Unit 5: Wire the operator run view to live status**

**Goal:** The SSR operator run view subscribes via the client script and renders live `status`, with the documented lifecycle + 404/429 + drift states surfaced in the UI.

**Requirements:** R4, R5, R6, R7, R8, S1, S3

**Dependencies:** Units 1–4

**Files:**
- Modify: `src/routes/operator.ts` (run-status section: live container, stream-status notice, drift/404/429 states; reference the script)
- Modify: `src/routes/operator.ts` / `src/server.ts` as needed to provide the run id(s) the view subscribes to
- Test: `test/operator-ui.test.ts` (extend: live container hooks present; no fixture/event-data leak; script referenced; flag-gated absence; the `connectRunStream` fake captures callbacks)

**Approach:** Add the stable DOM hooks + `<script src>` to `runStatusSection`. Keep SSR rendering the safe initial state; the script attaches live updates. Surface drift/404/429 as distinct (but cause-uniform for 404) UI states. Replace the operator-ui test's throwing `connectRunStream` fake with a controllable one. Behind the existing mock/flag posture (R8) — no live wiring beyond the seam.

**Execution note:** Test-first for the render hooks + no-leak.

**Patterns to follow:** `runStatusSection` structure; `makeFakeOperatorClient`; the fixture-literal no-leak assertions; flag-gated mounting.

**Test scenarios:**
- run cards carry `data-run-id`/`data-role` + container id; script referenced.
- no fixture/event payload literal leaks into rendered HTML (pin real values).
- drift/not-found/backpressure states render distinct copy (404 cause-uniform).
- operator UI disabled → no script, no stream container.

**Verification:** View renders live-ready hooks + states; no leak; flag-gated; gates green.

- [ ] **Unit 6: Documentation — SSE consumer learning (optional)**

**Goal:** If a non-obvious problem surfaces (CSP/static-serving in the container, fetch-stream parsing edge), capture it in `docs/solutions/`.

**Requirements:** (project convention)

**Dependencies:** Units 1–5

**Files:** Create `docs/solutions/<category>/<slug>-2026-06-20.md` (only if warranted)

**Approach:** Follow the existing solution-doc frontmatter/structure. Skip if nothing non-obvious arose.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** Documented if warranted, else skipped.

## System-Wide Impact

- **First client-side JS + first static-serving + first CSP** in the dashboard —
  Unit 2 establishes the infra (hono built-ins, no new dependency) and is a
  prerequisite for Unit 4. The inline-style extraction is required, not optional.
- **Auth interaction:** the static `/static/*` path must be public (not auth-gated)
  so the browser can load the script/CSS before/independent of operator auth;
  flag-gated so it's absent when the operator UI is off.
- **Streaming path stays out of the dashboard server** (browser → gateway direct);
  the dashboard server only serves SSR + the static asset.
- **Read-only invariant preserved** (GET stream; no write path). Redaction: the
  stream renders only phase/status/timestamps; the gateway applies denylist before
  streaming; the client adds no repo param and renders no repo-identifying data.
- **Contract-version pin** advances to 1.1.0; the SSE frame types are dashboard-local
  and may evolve without a future bump (like the current mock union).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Native EventSource can't see status (404/429) | KTD3 fetch-stream reader reads status before streaming |
| Tight CSP breaks the existing inline `<style>` | Unit 2 extracts it to external CSS first (prerequisite) |
| Static path 302'd by auth, or present when flag off | Add to `isPublicPath`; flag-gate the mount; tests pin both |
| runId leaking into logs | route-template-only logging; no runId in log context |
| Client-side oracle reintroducing 404 cause | S3: one state, one retry policy; tests assert uniform handling |
| Real connection not testable until #53 live | Build + unit-test behind mock seam; live path is smoke-only later |
| Container static path resolution (non-root) | `./public` from WORKDIR; Dockerfile COPY; smoke the path |

## Documentation / Operational Notes

- The static asset + CSP are new operational surface; document the `/static/*` path
  and CSP in the PR. No new env vars. No dependency added (hono built-ins).

## Sources & References

- Origin: docs/brainstorms/2026-06-20-002-feat-operator-run-stream-sse-consumer-requirements.md
- Upstream contract (verbatim): agent `packages/gateway/src/operator-contract/{version,run-status}.ts`,
  `packages/gateway/src/web/sse/{manager,run-stream-route}.ts`, `web/safe-response.ts`
  @ v0.72.0 / #955 (`9fdaa19`) / #961 (`48ff4e6`) / #962 (`908c95a`)
- Dashboard seams: `src/gateway/operator-client.ts`, `src/gateway/operator-contract/`,
  `src/routes/operator.ts`, `src/server.ts`, `src/logger.ts`, `test/operator-{ui,client}.test.ts`
- Issues: closes part of #47 via #63; tracks #907; gated by #53/#59
