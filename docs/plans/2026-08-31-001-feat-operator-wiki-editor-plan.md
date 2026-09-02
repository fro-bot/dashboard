---
title: 'feat: Add operator wiki editor and private writer'
type: feat
status: active
date: 2026-08-31
origin: 'fro-bot/.github → docs/plans/2026-08-29-001-feat-editable-wiki-path-plan.md Units 7a/7b'
---

# feat: Add operator wiki editor and private writer

**Target repo:** `fro-bot/dashboard`

## Overview

Add a dashboard-origin markdown editor and save API, backed by a private `wiki-writer`
service in the same repository. The dashboard remains read-only for GitHub: it owns
operator authentication, CSRF and origin checks, request validation, rate limits,
server-derived attribution, and the writer call. The writer alone owns the Fro Bot App
write key, gate execution, and commits to `fro-bot/.github:data`.

The dashboard is a Node 24 native-TypeScript Hono server plus a Vite/React PWA
(`AGENTS.md:3-8`; `package.json:7-18,62-65`). The existing contract is read-only by
default with one isolated wiki-write capability; the dashboard App credentials remain
read-only and the writer is a separate deployed authority (`AGENTS.md:10-44`).

## Problem Frame

The wiki has a sole-writer data-branch model, but an operator cannot correct a page in
place without an issue round trip. This plan adds the missing authenticated correction
path without giving the dashboard GitHub write authority.

The application factory is already separated from listener startup so tests can call
`app.request()` (`src/server.ts:286-295`). Its middleware order is security-worker
bypass, security headers, global IP limiting, authentication, auth routes, API routes,
listener routes, SPA shell, redirects, static assets, and optional operator/fixture
routes (`src/server.ts:466-523`, `src/server.ts:525-676`, `src/server.ts:701-783`).
The new API must therefore be mounted in the authenticated `/api` surface and must not
alter the gateway's `/operator/*` proxy boundary.

Production enables gateway mode through static deployment configuration; the gateway
operator credential is the single authority and the dashboard validates it through
`/operator/session` (`marcusrbrown/infra/apps/dashboard/README.md:55-59`). The code's
flag still defaults off when deployment configuration is absent
(`src/server.ts:332-340`). Gateway mode forwards the inbound cookie and never mints the
dashboard's signed cookie (`src/server.ts:564-675`). Session mode retains the signed
cookie path (`src/session.ts:31-115`) and its existing allowlist comparison
(`src/routes/auth.ts:138-170`). Both modes must be supported by the save path.

## Requirements Trace

The trace below covers R1-R15 from
`fro-bot/.github/docs/brainstorms/2026-08-29-editable-wiki-path-requirements.md`.
R16-R18 are also included because they define save-state and draft behavior for this
repository's half of the feature.

| Requirement | Dashboard / writer coverage |
|---|---|
| R1. Edit affordance and return path | The editor route contract is consumed by the wiki affordance; the dashboard owns the destination and return URL. |
| R2. Free-form raw markdown | Unit 3 loads and saves the page body; Unit 4 edits raw markdown without WYSIWYG conversion. |
| R3. System-owned frontmatter | Unit 2 reconstructs or preserves frontmatter through the pinned write-core contract; the request cannot replace it. |
| R4. All gates before commit | Unit 2 invokes the pinned `@fro-bot/wiki-write-core` gates before the GitHub write. |
| R5. Synchronous rejection | Units 2 and 3 return bounded gate findings before accepting the save. |
| R6. Fro Bot identity and sole writer | Unit 2 commits only through the private writer using the Fro Bot App; the dashboard has no GitHub write key. |
| R7. Auth, origin, CSRF, version, limits, and rate controls | Unit 3 revalidates the active credential on every save, handles both CSRF modes, enforces `If-Match`, route-scoped byte limits, and the authenticated limiter. The upstream 30-minute issued-at step-up is explicitly replaced by D1 below. |
| R8. Marked corrections | Unit 4 lets the operator mark correction spans; Unit 2 transports them as data for the shared metadata contract. |
| R9. Server-derived attribution | Unit 3 derives attribution from the validated operator identity; no client attribution field is trusted. |
| R10. Preservation during regeneration | The survey-side preservation check remains owned by `fro-bot/.github`; this repository persists the marked-correction data required by that contract. |
| R11. Correction lifecycle | The writer accepts lifecycle state from the shared contract but does not implement survey reconciliation; lifecycle semantics remain upstream-owned. |
| R12. Rendering safety | Unit 2 performs save-time feedback; the primary render-side sanitizer remains in `fro-bot/.github` and is a prerequisite, not a dashboard substitute. |
| R13. Dashboard-origin authentication | Units 3 and 4 keep the editor and API on the dashboard origin; no credentialed CORS or cross-origin handoff is introduced. |
| R14. Anonymous read parity | Unit 4 does not expose an authenticated affordance to anonymous readers; the wiki remains responsible for its static link behavior. |
| R15. Explicit edit entry and exit | Unit 4 provides entry, cancel/navigation exit, and an unsaved-change guard. |
| R16. Pending state | Unit 4 shows accepted-but-not-yet-published state and records the operation identifier needed for reconciliation. |
| R17. Observable outcomes | Units 2-4 distinguish rejection, validator conflict, semantic conflict, pending, and published states. |
| R18. Draft preservation | Unit 4 persists drafts through rejection, conflict, auth expiry, and network loss. |

The upstream plan's original freshness requirement is not silently dropped. D1
replaces it: production uses gateway mode, `OperatorSessionInfo` is frozen at
`{operatorId, login, expiresAt}`, and `expiresAt` is the sooner of absolute or idle
expiry (`fro-bot/.github/docs/plans/2026-08-29-001-feat-editable-wiki-path-plan.md:120-128`; `src/gateway/operator-contract/responses.ts:16-27`). An idle-refreshed credential
cannot be distinguished from a fresh one, so issued-at age is underivable. The
gateway's 30-minute idle expiry is the freshness bound. Adding `issuedAt` to the frozen
contract would create a cross-repository release dependency for a marginal control;
deriving age from absolute TTL would hardcode another repository's constant into a
security check. The compensating controls are the reversible, path-allowlisted,
gate-validated, attributed commit plus CSRF, origin binding, and rate limits.

## Scope Boundaries

- Dashboard editor UI and dashboard-owned `/api/wiki/*` save/read routes.
- Private `wiki-writer` service code and its independently testable fixture seam.
- Exact pinned git consumption of `@fro-bot/wiki-write-core`, including committed
  compiled `dist/` consumption under Node 24.
- A second dashboard image and release workflow path for the writer image.
- Raw markdown body editing only; frontmatter, identity, dates, and source fields stay
  system-owned.
- Only `fro-bot/.github`, branch `data`, and the explicit wiki/corrections allowlist are
  valid writer targets.

### Deferred to Separate Tasks

- Compose service definition, private Docker network, secret mount, reverse-proxy
  configuration, and deployment rollout in `marcusrbrown/infra`.
- Wiki-side Edit-link rendering and anonymous-site affordance changes.
- Survey-loop correction injection, survival checking, correction lifecycle execution,
  and render-side sanitization in `fro-bot/.github`.
- Public or multi-operator editing, editing outside the wiki allowlist, WYSIWYG, edit
  history UI, and push/notification delivery.
- Any gateway contract change, including adding `issuedAt`.

## Context & Research

### Relevant Code and Patterns

- `src/server.ts:500-523` contains the existing fixed-window IP limiter: 60 seconds,
  60 requests, remote-address keyed, and applied before authentication. Do not modify
  it; the wiki routes add a separate authenticated limiter.
- `src/server.ts:645-674` contains the signed-cookie mode's exact login comparison;
  gateway mode must not consult that value (`src/server.ts:564-633`).
- `src/routes/listener.ts:14-32` is the route-scoped byte-limit precedent: read raw
  text, measure UTF-8 bytes, then reject with 413. Wiki routes should follow this shape
  with a 1 MiB request envelope and 512 KiB decoded content ceiling.
- `web/src/push/subscribe.ts:93-103,166-199` defines the browser mutation posture:
  `credentials: 'include'`, `redirect: 'error'`, JSON content type, CSRF header, and
  idempotency key. Its single CSRF-400 retry is intentionally not copied for saves;
  a GitHub commit is not safely retryable.
- `src/server.ts:582-603` and `src/gateway/operator-client.ts:293-309` establish the
  injectable-fetch client seam for dashboard-to-writer calls. The new internal client
  must use the same explicit transport injection and coarse logging discipline.
- `web/src/App.tsx:14-88` uses a two-value view union and no router. `AppShell` exposes
  navigation as plain buttons (`web/src/shell/AppShell.tsx:61-105,251-313`); the editor
  should extend that state model rather than introduce a routing dependency.
- `web/src/shell/AppShell.tsx:50-105` uses localStorage for small theme state. No larger
  browser storage pattern exists; draft content belongs in IndexedDB, with localStorage
  limited to a pointer or dirty marker.
- `web/src/sw.ts:44-60,79-90` makes auth and `/api/*` network-only. Wiki API paths must
  remain network-only and excluded from navigation fallback. Logout purges runtime
  caches but preserves the app shell (`web/src/pwa/logout-purge.ts:27-48`).
- `src/routes/operator-fixture-harness.ts:1-13,118-138` provides the dev-only,
  no-store, non-echoing fixture pattern. The writer must have an analogous seam that
  never loads a real private key or contacts GitHub.
- Server tests build the app and exercise `app.request()` (`test/server.test.ts:41-62`),
  while UI tests stub fetch by URL and assert request details
  (`web/src/shell/AppShell.test.tsx:68-82`). New tests should preserve both patterns.
- The runtime image is currently a single Node image with frozen pnpm installs and a
  direct `node src/server.ts` command (`Dockerfile:1-76`). The release workflow builds
  and pushes one candidate image (`.github/workflows/release.yaml:149-158`) and later
  promotes and verifies immutable digests (`.github/workflows/release.yaml:394-472`).
  A second writer image is therefore real release workflow work, not a Dockerfile-only
  change.

### Institutional Learnings

- `docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md:34-54`
  requires the dashboard not to mount or proxy gateway `/operator/*` routes. The wiki
  save API is a dashboard-owned `/api/` route; the internal writer call is not a
  credential-forwarding proxy.
- `docs/solutions/security-issues/gateway-operator-session-cookie-forwarding-trust-boundary-2026-06-20.md:51-99`
  establishes configured-origin binding, self-validating cookie-forwarding boundaries,
  redirect rejection, timeout behavior, and removal of caller credentials. The writer
  HMAC boundary follows the same explicit trust-boundary discipline.
- `docs/solutions/best-practices/local-fixture-harness-must-mirror-wire-contract-2026-07-03.md:24-49`
  requires fixtures to mirror the complete wire envelope and reject stale shapes.
- `docs/solutions/best-practices/operator-local-fixture-harness-2026-06-30.md:51-113`
  requires one reserved fixture prefix, independent production guards, synthetic values,
  no-store responses, and scoped state.
- `AGENTS.md:55-65` requires pnpm, Node 24 strip-only server code, `Result<T,E>` seams,
  and the full repository quality gate.

### Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "fro-bot/dashboard repository root, with fro-bot/.github Unit 7a/7b as the upstream contract",
  "freshness": {
    "vcs_reference": "docs/wiki-editor-plan branch at planning start"
  },
  "budget": {
    "max_search_passes": 1,
    "max_candidate_inspections": 1,
    "exhausted": true
  },
  "candidates": [
    {
      "path_or_symbol": "src/server.ts:buildDashboardApp",
      "description": "Testable Hono application factory with ordered middleware and injectable dependencies.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/routes/operator-fixture-harness.ts",
      "description": "Loopback-guarded synthetic HTTP boundary with no-store, non-echoing responses and scoped idempotency.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/gateway/operator-client.ts:createOperatorClient",
      "description": "Explicit injectable transport and Result-based client boundary.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "src/listener/store.ts:createListenerStore",
      "description": "Node 24 node:sqlite persistence with explicit count/age retention.",
      "disposition": "extend"
    }
  ]
}
```

## Key Technical Decisions

- **D1 — No step-up authentication.** The deployed gateway mode does not mint the
  dashboard's signed cookie (`src/server.ts:564-675`), and the frozen contract has no
  derivable issuance time (`src/gateway/operator-contract/responses.ts:16-27`). Use
  the gateway's 30-minute idle expiry as the freshness bound. Do not expand the frozen
  contract or hardcode another repository's absolute-expiry constant.
- **D2 — Strong validators and atomic compare-and-write.** `GET` returns a strong opaque
  ETag, never `W/`. `PUT` requires `If-Match`: missing is 428, stale/nonmatching is
  412, and 409 is reserved for semantic deletion or identity migration. The writer's
  Git Data API ref update uses the expected parent SHA atomically; never replace it with
  a check-then-write sequence.
- **D3 — Preserve useful distinctions without creating an oracle.** Writer-internal
  failures collapse to one generic failure plus correlation ID, matching the safe
  launch-surface learning. 428, 412, and 409 remain distinct because reload, merge,
  and abandonment require different operator actions. Gate rejection may quote only
  spans present in the submitted content.
- **D4 — Durable operation ledger and no blind retry.** Create an operation ID before
  the first write; persist repository, ref, path, expected parent commit, and content
  digest. Stamp `Fro-Operation-Id: <uuid>` into the commit. Reconcile only when the ref
  contains the matching trailer, expected parent, and content digest. Persist and
  surface `succeeded`, `failed`, or `indeterminate`; never discard indeterminate state.
  Use a bounded `node:sqlite` ledger, following the existing persistence technology
  (`src/listener/store.ts:1-19,37-39`), with explicit count and age retention.
- **D5 — HMAC dashboard-to-writer authentication.** A private Docker network is routing,
  not identity. Sign each request as
  `method || path || timestamp || bodyHash || requestId` with a file-mounted secret;
  require `X-Request-Id`, `X-Timestamp`, and `X-Signature`; reject stale timestamps and
  duplicate request IDs. The writer authorizes the requested repository, ref, path,
  and operation instead of trusting caller authentication alone.
- **D6 — IndexedDB drafts.** Store content keyed by operator, repository, and path,
  alongside base ETag, content digest, updatedAt, and sync state. Keep only a pointer
  and dirty marker in localStorage. Never persist tokens. After reauthentication,
  reload the server document and compare its ETag with the stored base; offer merge or
  explicit overwrite, never silent replacement. Browser storage remains best-effort and
  evictable.
- **D7 — Route-scoped limits.** Add no global body cap. Wiki routes enforce a 1 MiB raw
  request envelope and 512 KiB decoded content limit, following the listener's
  route-local byte measurement (`src/routes/listener.ts:14-32`).
- **D8 — Separate authenticated limiter.** Leave the pre-auth 60/min IP limiter
  unchanged (`src/server.ts:72-145,500-523`). Add save burst 3, sustained 10/min per
  operator, and one in-flight save per page.
- **D9 — Exact git-subdirectory package pin.** Consume
  `@fro-bot/wiki-write-core` from a git dependency pinned to an exact commit SHA with
  the `packages/wiki-write-core` subdirectory selector. Consume committed `dist/`:
  Node 24 cannot strip TypeScript inside `node_modules`, so reverting to source imports
  would break the container install/runtime boundary. The upstream package and
  codeload availability are recorded in the originating plan
  (`fro-bot/.github/docs/plans/2026-08-29-001-feat-editable-wiki-path-plan.md:118-128`).
- **D10 — Gate-contract drift behavior.** The writer fetches
  `packages/wiki-write-core/dist/gate-contract.json` from `fro-bot/.github:main` and
  compares `version` with pinned `GATE_CONTRACT_VERSION`. A mismatch refuses writes.
  Fetch failure uses a cached marker by head SHA within a bounded staleness ceiling,
  logs and surfaces staleness, and refuses only with no cache or an expired cache.
  `sourceTreeHash` is diagnostic only; it changes on unrelated source edits and must
  not gate writes.
- **D11 — Network-only wiki API.** Add wiki API patterns to the existing service-worker
  network-only policy (`web/src/sw.ts:44-60,79-90`). No page body, ETag, draft, or
  writer response is cached by the service worker.
- **D12 — Not a proxy.** Do not mount or proxy gateway `/operator/*` routes. The editor
  may have a dashboard-owned browser entry route, but the save/read API is under
  dashboard-owned `/api/wiki/*`; the private writer is an internal backend call, not a
  credential-forwarding hop.

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

```mermaid
sequenceDiagram
  participant B as Browser editor
  participant D as Dashboard API
  participant W as Private wiki-writer
  participant G as GitHub Data API
  participant P as Publish pipeline

  B->>D: GET page with credentials
  D->>D: Revalidate gateway or signed-cookie authority
  D-->>B: Body + strong ETag + correction metadata
  B->>D: PUT body + If-Match + CSRF + idempotency key
  D->>D: Validate origin, CSRF, bytes, identity limit, page mutex
  D->>W: HMAC-signed operation request
  W->>W: Validate target, contract version, gates, ledger intent
  W->>G: Atomic ref update with expected parent SHA
  G-->>W: Commit/ref result or ambiguous transport outcome
  W->>W: Reconcile trailer + parent + digest; classify outcome
  W-->>D: Accepted, bounded rejection, conflict, or indeterminate
  D-->>B: Published/pending/rejected/conflicted state
  W->>P: Existing promotion trigger after accepted commit
```

The dashboard never receives the Fro Bot App key. The writer has no public port or
reverse-proxy route; Compose wiring is an external `marcusrbrown/infra` dependency.
The exact browser editor pathname is a cross-repository link contract, while the API
contract remains dashboard-owned under `/api/wiki/*`.

## Implementation Units

- [ ] **Unit 1: Private writer skeleton and authenticated health boundary**

**Goal:** Create an independently testable `wiki-writer` service boundary with HMAC
request authentication, replay protection, operation authorization scaffolding, and a
safe health/readiness surface.

**Requirements:** R6, R7, R13, R17; D5.

**Dependencies:** None.

**Files:**
- Create: `wiki-writer/package.json`
- Create: `wiki-writer/src/server.ts`
- Create: `wiki-writer/src/internal-auth.ts`
- Create: `wiki-writer/src/contract.ts`
- Create: `wiki-writer/src/fixture.ts`
- Test: `wiki-writer/test/internal-auth.test.ts`
- Test: `wiki-writer/test/server.test.ts`
- Test: `wiki-writer/test/fixture.test.ts`

**Approach:** Define a narrow HTTP contract for health and write requests. Verify the
HMAC over method, path, timestamp, raw-body hash, and request ID; reject stale timestamps,
duplicate IDs, malformed signatures, and caller-supplied authorization confusion. Load
the secret from a file path matching the existing file-mounted secret posture
(`marcusrbrown/infra/apps/dashboard/README.md:67-70`), never from an environment value.
Keep health responses free of keys, bodies, repository names, and internal details.
Create a fixture implementation that mirrors the loopback/no-store/non-echoing guards
of `src/routes/operator-fixture-harness.ts:1-13,118-138` and cannot instantiate a real
GitHub client.

**Patterns to follow:** `src/gateway/operator-client.ts:293-309` for explicit transport
injection; `src/routes/operator-fixture-harness.ts:1-13,118-138` for synthetic fixtures;
`src/listener/store.ts:59-85` for Node 24 persistence boundaries when the replay ledger
is added in Unit 2.

**Test scenarios:**
- Happy path: a correctly signed health request returns only the documented readiness shape.
- Happy path: a correctly signed write envelope reaches the operation authorization seam.
- Edge case: timestamp at the accepted skew boundary succeeds; outside the boundary fails.
- Error path: missing, malformed, or mismatched signature fails without invoking the writer operation.
- Error path: duplicate request ID fails, including after a prior successful request.
- Error path: caller-supplied `Authorization` or alternate credential header is ignored/rejected.
- Integration: fixture mode accepts synthetic requests, never reads a key file, never contacts GitHub, and returns `no-store` responses.

**Verification:** The writer starts with no GitHub dependency, accepts only valid HMAC
requests, exposes no credential material in health or errors, and has a fixture path
that exercises the same request envelope without external writes.

**Not in this unit:** GitHub commits, gate execution, correction persistence, dashboard
routes, image publication, and deployment wiring.

- [ ] **Unit 2: Gated GitHub write path, contract drift, and operation ledger**

**Goal:** Make the writer the only component capable of the allowed wiki commit, with
atomic validator enforcement, shared gates, identity checks, and durable ambiguity
reconciliation.

**Requirements:** R2-R7, R8-R12, R16-R18; D2-D4, D7, D9-D10.

**Dependencies:** Unit 1; upstream `@fro-bot/wiki-write-core` package and generated
`gate-contract.json` available at the pinned commit.

**Files:**
- Modify: `wiki-writer/package.json` (exact git SHA and `packages/wiki-write-core` selector)
- Create: `wiki-writer/src/write-operation.ts`
- Create: `wiki-writer/src/github-data-client.ts`
- Create: `wiki-writer/src/gate-contract.ts`
- Create: `wiki-writer/src/operation-ledger.ts`
- Create: `wiki-writer/src/retention.ts`
- Test: `wiki-writer/test/write-operation.test.ts`
- Test: `wiki-writer/test/operation-ledger.test.ts`
- Test: `wiki-writer/test/gate-contract.test.ts`
- Test: `wiki-writer/test/github-data-client.test.ts`

**Approach:** Accept only the hardcoded repository, `data` ref, and explicit wiki or
corrections paths. Preserve system-owned frontmatter and reject malformed identity or
content. Enforce the 1 MiB envelope and 512 KiB decoded-body limit before expensive
work. Fetch and cache the gate marker by `main` head SHA, compare only `version`, and
apply the bounded stale-cache behavior from D10. Run the shared gates before creating
the ledger intent. Use the expected parent SHA in the atomic ref update. Stamp the
operation trailer and reconcile ambiguous results only with all three signals: trailer,
expected parent, and content digest. Store ledger entries in bounded `node:sqlite`
storage with explicit count and age pruning; expose indeterminate entries through a
coarse operator-resolution result, never as a false failure or silent success.

**Patterns to follow:** `src/listener/store.ts:1-19,37-39,59-109` for durable bounded
storage; `src/routes/listener.ts:14-32` for raw UTF-8 byte limits; the upstream write
core contract and `fro-bot/.github/docs/plans/2026-08-29-001-feat-editable-wiki-path-plan.md:120-128,328-340`
for target and reconciliation boundaries.

**Test scenarios:**
- Happy path: valid raw markdown with valid frontmatter, target, parent SHA, and gate marker produces one Fro Bot-attributed commit intent.
- Happy path: accepted marked corrections persist as system-owned metadata without entering page frontmatter.
- Error path: wrong repository, ref, or path is rejected before GitHub access.
- Error path: oversized raw envelope or decoded body returns bounded rejection before parsing downstream content.
- Error path: stale parent/blob validator returns conflict and performs no ref update.
- Error path: gate rejection surfaces only bounded submitted-content spans and creates no commit.
- Error path: gate version mismatch refuses writes; marker fetch failure uses fresh cache, while absent/expired cache refuses.
- Edge case: `sourceTreeHash` changes while `version` remains equal; writes remain permitted and staleness is diagnostic.
- Integration: GitHub ref update uses the expected parent SHA and commit trailer; a ref race cannot become check-then-write last-writer-wins.
- Integration: response loss after an accepted write reconciles only on matching trailer, parent, and digest; matching content alone remains indeterminate.
- Integration: ambiguous outcomes are persisted as `indeterminate`, surfaced for resolution, and never blindly retried.
- Edge case: retention removes entries by the configured age/count bounds without deleting unresolved indeterminate records prematurely.
- Security: the dashboard-side test process cannot read the writer key file or instantiate the GitHub write client.

**Verification:** The writer independently rejects every out-of-scope target and gate
failure, consumes the pinned compiled package under Node 24, produces Fro Bot identity
commits in a disposable-branch canary, and preserves an auditable ledger for every
ambiguous outcome.

**Not in this unit:** Dashboard authentication, browser drafts, UI states, Docker image
publication, and `marcusrbrown/infra` Compose/network/secret changes.

- [ ] **Unit 3: Dashboard wiki API and writer client**

**Goal:** Add dashboard-owned page read/save routes under `/api/wiki/*` with complete
request protection and a narrow HMAC writer client, without performing GitHub writes in
the dashboard runtime.

**Requirements:** R2-R7, R9, R12-R14, R16-R18; D2, D3, D5, D7-D8, D12.

**Dependencies:** Units 1-2; existing gateway and signed-cookie auth paths.

**Files:**
- Modify: `src/server.ts` (mount wiki API and inject writer client/config)
- Create: `src/routes/wiki.ts`
- Create: `src/wiki/request-contract.ts`
- Create: `src/wiki/page-service.ts`
- Create: `src/wiki/writer-client.ts`
- Create: `src/wiki/rate-limit.ts`
- Create: `src/wiki/csrf.ts`
- Test: `test/wiki-routes.test.ts`
- Test: `test/wiki-writer-client.test.ts`
- Test: `test/wiki-csrf.test.ts`
- Modify: `test/operator-ui.test.ts` or add a focused no-proxy regression assertion

**Approach:** Read the active operator identity from the existing auth boundary on every
request. In gateway mode, use the inbound gateway cookie and gateway CSRF endpoint;
in signed-cookie mode, use the existing dashboard CSRF pattern at `/auth/logout-csrf`
as the mode-specific source and add a distinct action binding for wiki mutation rather
than reusing a logout token (`src/routes/auth.ts:158-170`). Reject wrong origin and
missing/invalid CSRF before parsing or forwarding the body. Use `GET` to return the
editable body, system-owned metadata needed by the editor, and a strong opaque ETag;
use `PUT` with mandatory `If-Match`. Return 428, 412, and 409 according to D2. Map
writer-internal failures to one generic response with a correlation ID; preserve
bounded gate rejection and precondition outcomes. Apply the per-operator limiter and
one in-flight mutex per page. The writer client signs the exact raw body and passes the
operation ID; it has no GitHub SDK or App-key dependency.

**Patterns to follow:** `buildDashboardApp` injection and `app.request()` tests
(`src/server.ts:286-295`; `test/server.test.ts:41-62`); the existing browser mutation
headers (`web/src/push/subscribe.ts:166-199`); the explicit `createOperatorClient`
transport boundary (`src/server.ts:582-603`).

**Test scenarios:**
- Happy path: authenticated gateway-mode `GET` returns page body, strong ETag, and only system-approved metadata.
- Happy path: authenticated signed-cookie-mode `GET` uses the dashboard authority and returns the same transport shape.
- Happy path: valid `PUT` with matching `If-Match`, CSRF, origin, and idempotency key reaches the writer exactly once.
- Error path: anonymous, expired, revoked, or malformed authentication is denied without a writer call.
- Error path: gateway-mode CSRF uses `/operator/session/csrf`; signed-cookie mode uses the dashboard-specific source; neither mode accepts the other's token.
- Error path: missing/invalid origin or CSRF is rejected before body parsing.
- Error path: missing `If-Match` returns 428; stale/nonmatching validator or lost-validator race returns 412; draft data is not echoed into logs.
- Error path: page deletion or identity migration returns 409; no generic validator loss is mislabeled as semantic conflict.
- Error path: writer credential/upstream/unexpected failures collapse to generic failure plus correlation ID.
- Error path: gate rejection returns bounded reason spans drawn only from submitted content.
- Edge case: 1 MiB envelope and 512 KiB decoded-body boundaries are accepted/rejected exactly at the documented limits.
- Edge case: fourth burst save, sustained 11th save in a minute, and concurrent same-page save are limited while another page remains available.
- Integration: dashboard requests carry `credentials: include`, `redirect: error`, CSRF, idempotency, and no GitHub credential.
- Integration: dashboard does not mount or proxy gateway `/operator/*` data/write paths; those paths remain outside this API.
- Integration: an ambiguous writer result is returned as pending/indeterminate and is not retried by the dashboard.

**Verification:** Route tests prove both authentication modes, complete mutation headers,
validator semantics, limits, rate controls, error distinguishability, and no proxying.
The writer client can be replaced with a fake, and no dashboard code path can access
the Fro Bot App key or call GitHub's Data API.

**Not in this unit:** Editor rendering, IndexedDB, service-worker changes, writer
GitHub implementation, image builds, and deployment wiring.

- [ ] **Unit 4: Editor UI, correction marking, and draft persistence**

**Goal:** Add a dashboard editor view with explicit entry/exit, raw markdown editing,
marked-correction selection, pending/conflict/rejection states, and durable local drafts.

**Requirements:** R1-R3, R5, R8-R9, R13-R18; D3, D6, D11-D12.

**Dependencies:** Unit 3 API contract; the upstream correction metadata contract.

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/shell/AppShell.tsx`
- Create: `web/src/views/WikiEditor.tsx`
- Create: `web/src/wiki/api.ts`
- Create: `web/src/wiki/drafts.ts`
- Create: `web/src/wiki/editor-state.ts`
- Create: `web/src/wiki/correction-spans.ts`
- Modify: `web/src/sw.ts`
- Test: `web/src/views/WikiEditor.test.tsx`
- Test: `web/src/wiki/api.test.ts`
- Test: `web/src/wiki/drafts.test.ts`
- Test: `web/src/wiki/editor-state.test.ts`

**Approach:** Extend the existing view union rather than adding a router. Load page
identity and return target from the dashboard editor entry contract, fetch the server
document, and retain the base ETag. Edit the raw body in a plain text control. Let the
operator select spans as corrections; serialize selected spans as data, not prompt or
markup instructions. Save through the API with a fresh idempotency key per submit and
never retry a writer-ambiguous response. Store drafts in IndexedDB by operator/repo/path
with base ETag, digest, timestamps, and sync state. Keep localStorage to a pointer and
dirty flag. Preserve drafts across 401/403, 412, 409, gate rejection, network failure,
and service-worker reload. On reauthentication, reload and compare ETags, offering
merge or explicit overwrite. Add wiki API paths to the service worker's NetworkOnly
rules; do not cache page bodies or writer results.

**Patterns to follow:** `web/src/App.tsx:14-88` for view state; `web/src/shell/AppShell.tsx:61-105`
for persistent small browser state; `web/src/push/subscribe.ts:166-199` for mutation
headers; `web/src/sw.ts:44-60,79-90` and `web/src/pwa/logout-purge.ts:27-48` for
network-only and logout behavior.

**Test scenarios:**
- Happy path: authenticated entry loads raw body and strong ETag, edits text, submits, and shows pending then accepted state.
- Happy path: selected correction spans round-trip as structured data while ordinary wording edits remain unmarked.
- Happy path: cancel with no changes exits; cancel/navigation with dirty content warns before discard.
- Error path: rejected gate displays bounded reason and leaves the exact editable draft intact.
- Error path: 428 prompts a reload; 412 offers comparison/merge; 409 offers abandon or explicit resolution without replacing the draft.
- Error path: auth expiry or network failure preserves the draft and never persists tokens.
- Error path: ambiguous writer response enters an indeterminate/pending state and does not issue a blind retry.
- Edge case: a 130.8 KiB page loads and edits without localStorage overflow; IndexedDB is used for body content.
- Edge case: IndexedDB eviction or unavailable storage degrades with a visible unsaved-state warning rather than claiming durable storage.
- Integration: after reauthentication, changed server ETag triggers merge/overwrite choice; unchanged ETag restores the draft safely.
- Integration: service-worker interception never serves a cached wiki API response, including after logout or offline navigation.
- Security: anonymous dashboard state has no usable editor affordance and no page body is included in the SPA shell.

**Verification:** Browser and unit tests prove the complete editor state machine, draft
survival, correction serialization, dual-mode CSRF API use, pending/conflict behavior,
and network-only wiki paths. The editor never stores a token or treats an accepted
writer response as published content before the pending state resolves.

**Not in this unit:** Wiki-side link generation, survey preservation, GitHub writes,
writer ledger implementation, Docker release wiring, and deployment configuration.

- [ ] **Unit 5: Second image and release wiring**

**Goal:** Build and publish a separate writer image while preserving the dashboard image
and its direct Node startup. Make the writer image consume the pinned package and file
mounted key without exposing a public port.

**Requirements:** R6-R7, R12-R13, R16-R17; D5, D9-D12.

**Dependencies:** Units 1-4; `marcusrbrown/infra` deployment contract for the eventual
service name, secret path, network, and image tag.

**Files:**
- Create: `wiki-writer/Dockerfile`
- Modify: `.github/workflows/release.yaml`
- Modify: `README.md` or deployment-facing documentation only if the image contract requires a tracked reference
- Test: `wiki-writer/test/image-contract.test.ts`

**Approach:** Add a writer-specific build/runtime path using pnpm only and frozen
lockfile resolution. Copy only writer runtime assets and committed compiled package
artifacts into the final image; do not copy the dashboard App key into the dashboard
image. Keep the writer listener internal to the container network and do not add a
Caddy route or host-published port. Extend release orchestration to build, push, and
verify a distinct writer image digest alongside the existing dashboard candidate, with
immutable references and explicit ordering. Do not add Compose or reverse-proxy files
here; those belong to `marcusrbrown/infra`.

**Patterns to follow:** `Dockerfile:1-76` for frozen pnpm/build/runtime separation and
direct Node startup; `.github/workflows/release.yaml:149-158` for candidate image
publication and `.github/workflows/release.yaml:394-472` for digest promotion/readback.

**Test scenarios:**
- Happy path: writer image builds from the pinned package and starts its internal health endpoint.
- Hardening: the final writer image contains no dashboard App key, source checkout, development dependencies, or package-manager cache beyond the required runtime artifacts.
- Boundary: the writer image has no published host port and no workflow-created proxy route.
- Identity: the image reads the key only from the configured file mount at runtime; absent or malformed key fails readiness without logging key material.
- Integration: release workflow publishes distinct dashboard and writer digests and preserves each digest through verification.
- Failure path: writer image build, health, or digest verification failure prevents its image from being treated as deployable.
- Regression: existing dashboard image startup, health, non-root behavior, and release digest path remain unchanged.

**Verification:** Local image checks and the release workflow prove two independently
identified images, frozen package consumption, no credential leakage into the dashboard
image, and no public writer route. Infra can then wire the verified writer digest without
changing this repository's application boundary.

**Not in this unit:** Compose service definitions, private network creation, secret
rotation, Caddy routing, host firewall policy, or production rollout.

## System-Wide Impact

- **Interaction graph:** Browser editor → dashboard `/api/wiki/*` → HMAC writer →
  GitHub Data API → existing `data` promotion path. The gateway remains the authority
  for operator authentication, and the dashboard does not proxy its `/operator/*`
  routes (`docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md:34-54`).
- **Error propagation:** Authentication, CSRF, origin, limits, and validators are
  rejected by the dashboard. Gate findings are returned synchronously with bounded
  submitted-content spans. Writer-internal failures become generic plus correlation
  ID. GitHub ambiguity becomes durable indeterminate state and visible pending/error
  state, never a blind retry.
- **State lifecycle risks:** The server gains a bounded operation ledger; the browser
  gains evictable IndexedDB drafts. ETags cover the editable representation and relevant
  correction state. The writer's expected-parent ref update is the atomic boundary.
- **API surface parity:** `/api/wiki/*`, the HMAC writer contract, the operation trailer,
  the gate marker version, the image names, and the editor-link target become contracts.
  The frozen gateway operator contract remains unchanged.
- **Integration coverage:** `app.request()` tests cover route/middleware behavior;
  injected writer fakes cover API mapping; writer fixture tests cover the internal
  boundary without GitHub; browser tests cover draft and service-worker behavior; image
  and release checks cover the second runtime artifact.
- **Unchanged invariants:** Existing read-only GitHub App credentials remain read-only;
  global pre-auth rate limiting remains unchanged; `/operator/*` gateway routes remain
  outside the dashboard application; anonymous wiki reading remains unchanged; the
  Fro Bot identity and data-branch authority remain writer-owned.

## Risks

| Risk | Mitigation |
|---|---|
| First multi-container boundary in this repository creates hidden trust assumptions | HMAC every request, reject replay, authorize target operations in the writer, add fixture and health tests, and keep the network boundary owned by infra rather than treating it as authentication. |
| Second container image drifts from the dashboard release path | Build and verify a distinct immutable writer digest in the existing release workflow; keep image contracts and runtime tests explicit. |
| Credential-holding writer expands blast radius | Mount the Fro Bot App key only in the writer, hardcode repo/ref/path allowlists, run shared gates, verify Fro Bot tip identity, and never expose a public port. |
| Dashboard compromise submits valid in-scope edits | State the honest boundary: separation prevents key exfiltration and arbitrary GitHub operations, not abuse of the authenticated dashboard's allowed edit capability. Keep edits reversible, gated, attributed, and auditable. |
| Drafts are evicted or unavailable | Treat IndexedDB as best-effort, retain explicit dirty state, warn when persistence fails, provide clear-local-drafts control, and never claim durability without a successful write. |
| Gate contract drifts from the pinned writer package | Compare marker `version`, cache by `main` head SHA with bounded staleness, refuse mismatches, and treat `sourceTreeHash` as diagnostic only. |
| Writer becomes a confused deputy | HMAC binds the operation request, the writer rechecks repository/ref/path/body limits/gates, and dashboard credentials cannot mint GitHub write tokens. |
| Indeterminate reconciliation records accumulate | Bound ledger count and age, preserve unresolved records until explicit resolution, surface readiness/audit staleness, and add operational metrics for the unresolved set. |
| Validator semantics are weakened into last-writer-wins | Make strong ETag/If-Match behavior and 428/412/409 distinctions contract tests; use GitHub expected-parent atomicity rather than a separate preflight check. |
| CSRF mode confusion creates a false security check | Test gateway and signed-cookie modes independently, keep action binding distinct, and reject a token issued by the wrong authority or action. |
| Pending state never learns publication outcome | Return operation ID and commit correlation data, retain pending until the existing promotion signal or reconciliation endpoint resolves it, and keep a bounded timeout state that does not discard the draft. |

## Open Questions

### Resolved During Planning

- **Where does mutation live?** Only in the private `wiki-writer`; the dashboard owns
  validation and delegation but performs no GitHub write.
- **Which API namespace is dashboard-owned?** Read/save routes use `/api/wiki/*`; the
  dashboard must not mount or proxy gateway `/operator/*` routes.
- **What is the validator contract?** Strong opaque ETag, mandatory `If-Match`, 428 for
  missing, 412 for stale/lost validator, and 409 only for semantic deletion or identity
  migration.
- **How are ambiguous writes handled?** Ledger intent before write, commit trailer,
  three-signal reconciliation, durable `indeterminate`, no blind retry.
- **How is the writer authenticated?** Per-request HMAC with file-mounted secret,
  timestamp, body hash, and unique request ID.
- **How are drafts stored?** IndexedDB for content and metadata; localStorage only for a
  pointer/dirty marker; tokens are never persisted.
- **How are limits scoped?** Wiki routes only: 1 MiB envelope and 512 KiB decoded body;
  existing global IP limiting is unchanged.
- **Is step-up auth required?** No. D1 records why the frozen gateway contract cannot
  provide issued-at age and why the gateway idle expiry is the accepted freshness bound.
- **What does deployment own?** `marcusrbrown/infra` owns Compose wiring, private
  network, secret mount, reverse proxy, and rollout; this plan owns application and
  image artifacts only.

### Deferred to Implementation

- Exact editor browser pathname and query parameter names, subject to the wiki-side
  link contract and the no-proxy invariant.
- Exact Hono request-origin extraction and the action-bound signed-cookie CSRF endpoint
  shape, after confirming the existing auth router's response conventions.
- Exact `node:sqlite` ledger schema and retention thresholds, provided count and age
  bounds preserve unresolved indeterminate records.
- Exact gate-finding projection fields and correction-span normalization, constrained by
  the pinned write-core contract.
- Exact publication acknowledgement source for transitioning pending to published;
  implementation should use the existing promotion signal rather than inventing a new
  public callback.
- Exact release job names and image tags, provided both immutable writer and dashboard
  digests are independently verified.

## Sources

- **Origin:** `fro-bot/.github/docs/plans/2026-08-29-001-feat-editable-wiki-path-plan.md:314-340` (Units 7a/7b).
- **Requirements:** `fro-bot/.github/docs/brainstorms/2026-08-29-editable-wiki-path-requirements.md:63-99` (R1-R18).
- **Dashboard authority invariant:** `AGENTS.md:10-44`.
- **Application factory and middleware order:** `src/server.ts:286-295,466-523,525-676,701-783`.
- **Gateway deployment mode:** `marcusrbrown/infra/apps/dashboard/README.md:55-59`.
- **Signed-cookie authority:** `src/session.ts:31-115`; `src/routes/auth.ts:138-170`.
- **Frozen operator contract:** `src/gateway/operator-contract/responses.ts:16-36`.
- **Existing client seam:** `src/server.ts:582-603`; `src/gateway/operator-client.ts:293-309`.
- **Mutation headers and retry boundary:** `web/src/push/subscribe.ts:93-103,166-199`.
- **Body-limit and rate-limit precedents:** `src/routes/listener.ts:14-32`; `src/server.ts:72-145,500-523`.
- **Frontend state/storage/service-worker patterns:** `web/src/App.tsx:14-88`; `web/src/shell/AppShell.tsx:50-105,251-313`; `web/src/sw.ts:44-60,79-90`; `web/src/pwa/logout-purge.ts:27-48`.
- **Fixture and persistence patterns:** `src/routes/operator-fixture-harness.ts:1-13,118-138`; `src/listener/store.ts:1-19,37-39,59-109`.
- **Image and release contracts:** `Dockerfile:1-76`; `.github/workflows/release.yaml:149-158,394-472`.
- **Institutional learnings:** `docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md:34-54`; `docs/solutions/security-issues/gateway-operator-session-cookie-forwarding-trust-boundary-2026-06-20.md:51-99`; `docs/solutions/best-practices/local-fixture-harness-must-mirror-wire-contract-2026-07-03.md:24-49`; `docs/solutions/best-practices/operator-local-fixture-harness-2026-06-30.md:51-113`.
