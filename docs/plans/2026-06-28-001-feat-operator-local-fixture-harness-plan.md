---
title: "feat: Add operator local fixture harness"
type: feat
status: active
date: 2026-06-28
origin: docs/brainstorms/2026-06-27-operator-local-development-harness-requirements.md
deepened: 2026-06-28
---

# feat: Add operator local fixture harness

## Overview

Add a dashboard-local fixture harness for operator development. The harness gives the operator PWA a loopback, same-origin launch-to-observe path using synthetic fixture routes under `/__fixture/operator/*` while preserving the production no-dashboard-proxy invariant for real Gateway-owned operator data routes.

This plan targets Track 2 from the origin document. Track 1, the `1.5.0` contract drift repair, is already shipped. Track 3, real local Gateway operation, remains deferred. Gateway run timeout behavior is tracked upstream in `fro-bot/agent#1055` and is not part of this dashboard plan.

---

## Problem Frame

Dashboard operator work currently needs production-like Gateway behavior to verify the assembled browser surface. Only `marcusrbrown/infra` operational sessions can reach the live Gateway operator path, so ordinary dashboard development cannot reliably test launch behavior, stream parsing, service-worker interaction, or failure states before deploy.

The harness must create a fast local loop without weakening production safety. Production dashboard still must not serve real operator data routes. Fixture mode must be synthetic-only, loopback-gated, locally visible as fixture mode, and absent from production route tables and browser bundles.

---

## Requirements Trace

- R6. Provide a loopback local operator mode with one browser origin for the app shell, service worker, static runtime assets, and fixture-backed operator behavior.
- R7. Make route ownership explicit: dashboard owns shell/canonicalization/assets; fixture harness owns only dev fixture behavior.
- R8. Never forward live operator requests or credentials to production Gateway origins from fixture mode.
- R9. Use synthetic local identities, sessions, CSRF values, repos, run IDs, and approval state only.
- R10. Exercise the production parser/runtime path for the minimum local harness set: successful launch-to-output, terminal failure, contract drift, and malformed/unavailable stream behavior.
- R11. Block committed fixture artifacts that contain real operator data or secrets.
- R12. Deferred: real local Gateway topology remains a separate Track 3 plan.
- R13. Deferred: raw/pulled live capture workflows are out of scope until fixture sanitization has a stricter capture-review process.
- R14. Deferred: upstream Gateway timeout behavior is tracked in `fro-bot/agent#1055`.
- R15. Preserve the operator-first launch-to-observe surface.
- R16. Preserve output accumulation, final-output replacement, bounded text growth, and empty/delayed-output distinction for the scenarios this harness exercises.
- R17. Keep failure states user-visible and path-unaware.
- R18. Require assembled browser verification for root load, `/operator` canonicalization, module loading, fixture output rendering, contract-drift handling, and service-worker cache boundaries.

---

## Scope Boundaries

- Do not restore or relocate the monitoring UI.
- Do not add production dashboard routes that proxy real Gateway operator APIs.
- Do not weaken contract-version mismatch behavior.
- Do not use raw live captures as fixtures.
- Do not add dependencies or touch `pnpm-lock.yaml`.
- Do not implement real local Gateway OAuth/session topology in this plan.
- Do not implement a global browser `fetch` override.
- Do not make exhaustive parser-matrix coverage part of the MVP; cover the minimum scenarios needed to prove the harness path.

### Deferred to Separate Tasks

- **Real local Gateway mode:** Deferred until a separate plan proves a safe topology for bind host, HTTPS origin, OAuth client config, CSRF secret, and return-path allowlisting.
- **Gateway run timeout behavior:** Tracked in `fro-bot/agent#1055`; dashboard only consumes the terminal status it receives.
- **Fixture governance expansion:** A repo-wide fixture scanning policy and docs authoring policy can follow once the first concrete fixture files exist.
- **Full parser scenario matrix:** Broader CRLF, buffer overflow, reconnect, approval-settle, and auth-redirect matrices should be separate parser/contract hardening work unless implementation reveals they are required for MVP correctness.
- **Permanent solution documentation:** A `docs/solutions/` write-up should be captured after the harness is implemented and verified, not as part of the core harness build.

---

## Context & Research

### Relevant Code and Patterns

- `src/server.ts` exposes `buildDashboardApp`, loopback helpers, dev autologin guards, public path handling, production `/operator` canonicalization, and the auth middleware that fixture routes must deliberately bypass only in dev mode.
- `src/gateway/operator-client.ts` is the canonical client boundary with injectable `fetch` and `createEventStream` dependencies.
- `src/gateway/operator-sse-reader.ts` provides the server-side `fetch` plus `ReadableStream` SSE parser path.
- `src/gateway/operator-fixtures.ts` contains typed synthetic operator fixtures and the existing forbidden-content fixture header.
- `test/operator-mock-client.ts` demonstrates the throwing-fetch fixture-client pattern.
- `web/src/operator/runtime.ts` has a runtime-loader seam; fixture mode should use that seam instead of a global `fetch` override.
- `public/operator-stream.js` and `public/operator-launch.js` are production browser runtime modules with hardcoded `/operator/*` browser-direct paths today. Fixture mode needs optional endpoint-base hooks that default to `/operator` so production behavior stays aligned.
- `web/src/sw.ts` does not intentionally cache operator API/stream/approval data. Harness verification must prove fixture routes are not precached or runtime-cached.

### Institutional Learnings

- `docs/solutions/workflow-issues/dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md`: browser verification must use the no-watch, backgrounded, fresh-port dev-server recipe with the orchestrator owning the server.
- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md`: service-worker behavior needs real browser verification.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`: assembled-surface verification is required so stale fixture paths or SSR leftovers do not survive behind green units.
- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md`: `/` remains canonical, `/operator` redirects to `/`, public operator JS modules use `?manual=1`, and production operator data routes remain absent.
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`: drift is absorbing, final output replaces accumulated text, and completion is driven by terminal status.
- `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md`: use `fetch` plus `ReadableStream`, not `EventSource`, and keep redirect/content-type/drift failures fail-closed.
- `docs/solutions/security-issues/operator-ui-mock-only-skeleton-pattern-2026-06-18.md`: fixture surfaces need fail-closed flags, lazy construction, throwing network seams, and literal-pinned no-leak tests.

---

## Key Technical Decisions

- **Fixture routes use one reserved dev prefix:** The plan standardizes on `/__fixture/operator/*`. Unit 2 must expose that prefix as a named server constant; Unit 3 must consume the same route contract instead of hardcoding a second spelling.
- **Fixture mode fails loud on unsafe bind:** Fixture mode shares the same non-production and loopback-host safety posture as dev autologin, but it is an independent flag. If the fixture flag is enabled on a non-loopback bind such as `0.0.0.0`, app construction must throw with a clear error rather than silently skipping routes.
- **Fixture route access is public-before-auth only under the fixture gate:** `/__fixture/*` is public only when fixture mode is enabled, non-production, and loopback-bound. Otherwise fixture routes are not mounted and are not in `isPublicPath`.
- **Runtime seam over global `fetch` override:** Fixture mode configures the existing browser operator modules with an optional endpoint base that defaults to `/operator`; it must not override global network behavior or replace the parser/reducer path.
- **Fixture build mode for assembled verification:** Production builds must stay fixture-free, but assembled local browser verification needs compiled assets that retain fixture-mode code. Add a dedicated fixture build mode/flag for local verification rather than relying on the normal production `build:web` output.
- **Scenario selection is run-scoped:** The selected fixture scenario travels with the launch request and is bound to the generated synthetic run ID. It must not live in global process state or a shared “active scenario” variable.
- **Synthetic identifiers are visually distinct:** Fixture CSRF tokens, session values, idempotency keys, request IDs, and run IDs use a clear fixture prefix and must not match production token, cookie, or UUID formats.
- **Compile-time dev gating for browser fixture code:** Browser fixture loader code must be behind `import.meta.env.DEV` or equivalent so production browser bundles do not contain fixture route strings, flags, or fallback paths.
- **Fixture routes inherit production CSP:** Fixture responses must keep the same CSP header as normal app responses, or a stricter subset. They must never relax, remove, or omit CSP.
- **Visible fixture-mode indicator:** The assembled UI must show a local-only fixture-mode indicator so developers do not mistake synthetic success for live Gateway validation.
- **Typed fixtures over raw captures:** MVP stream scenarios are typed fixtures serialized into SSE bytes; raw logs and pulled live captures are out of scope.
- **No-store and no-cache fixture boundary:** Fixture responses must use no-store headers, and the service worker must not precache, runtime-cache, or synthesize production-equivalent cache keys for fixture responses.
- **Scoped in-memory state:** Idempotency and run replay state must be scoped by synthetic fixture session/run identifiers, not process-global key-only state.

---

## Open Questions

### Resolved During Planning

- **Harness topology:** Use a dev-only fixture mode in the dashboard process, gated to local development and loopback.
- **Browser routing hook:** Use the operator runtime seam, not a global `fetch` override.
- **Fixture route contract:** Fixture behavior lives under `/__fixture/operator/*`; production `/operator/*` data routes stay absent.
- **Browser endpoint hook:** Extend the existing public browser modules with optional endpoint-base configuration that defaults to `/operator`; do not use the unrelated TS server client as the browser routing seam.
- **Fixture format:** Use typed TypeScript fixtures and a small SSE serializer helper, not raw event-stream files.
- **Upstream timeout:** Exclude from this plan; track in `fro-bot/agent#1055`.

### Deferred to Implementation

- **Exact dev flag handoff:** Implementation should choose the smallest CSP-safe mechanism, but it must satisfy the production bundle absence tests and must not expose fixture mode through cached HTML or shared runtime config in production.
- **Fixture scenario selector:** Implementation should choose the smallest stable interface for selecting MVP success, drift, malformed, unavailable, and terminal-failure scenarios.
- **Reconnect behavior:** Implementation should characterize current browser reducer behavior before adding any replay-resume semantics beyond the MVP path.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
flowchart TB
  Dev[Dashboard developer] --> App[Loopback dashboard app]
  App --> Shell[Operator PWA shell]
  Shell --> Indicator[Fixture mode indicator]
  Shell --> Loader[Dev-gated runtime seam]
  Loader --> Client[Operator browser client]
  Client --> DevRoutes[/__fixture/operator routes]
  DevRoutes --> Fixtures[Typed synthetic fixtures]
  Fixtures --> Sse[SSE serializer]
  Sse --> Parser[Production stream parser/reducer]
  Parser --> Ui[Run status and output UI]
  Prod[Production dashboard] -. 404 and bundle absence .-> DevRoutes
```

---

## Implementation Units

- [x] **Unit 1: Minimal fixture safety and SSE scenarios**

**Goal:** Add the smallest safe fixture data layer needed for a local launch-to-observe harness.

**Requirements:** R8, R9, R10, R11, R16, R17

**Dependencies:** None

**Files:**
- Create: `src/gateway/operator-fixture-sse.ts`
- Create: `test/operator-fixture-sanitization.test.ts`
- Modify: `src/gateway/operator-fixtures.ts`
- Test: `test/operator-sse-reader.test.ts`
- Test: `test/operator-stream-core.test.ts`

**Approach:**
- Add typed MVP stream scenarios for success with output, terminal failed after output, unsupported contract drift, and malformed/unavailable stream behavior.
- Serialize typed frames to real SSE records that the existing server and browser parsers consume.
- Define the canonical scenario names the router/browser use for MVP verification: success, terminal failure, contract drift, and malformed/unavailable.
- Emit `OPERATOR_CONTRACT_VERSION` for matching scenarios; make drift explicit and opt-in.
- Add a narrow fixture no-leak guard for the concrete fixture files changed by this plan. Keep generic fixture-governance policy deferred.
- Use synthetic allowlists for fixture repo names, logins, CSRF placeholders, idempotency placeholders, request IDs, and run ID prefixes. Fixture identifiers must be visually fixture-prefixed and must not look like production tokens or UUIDs.

**Execution note:** Start with parser and fixture-leak characterization tests before adding helper behavior.

**Patterns to follow:**
- `src/gateway/operator-fixtures.ts`
- `src/gateway/operator-sse-reader.ts`
- `test/operator-mock-client.ts`
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`

**Test scenarios:**
- Happy path: matching-contract `ready`, running status, output, and terminal succeeded status parse in both consumers.
- Error path: terminal failed status after visible output remains renderable by the browser reducer.
- Error path: unsupported contract version enters absorbing drift and ignores later frames.
- Error path: malformed fixture record fails closed with non-echoing error text.
- Error path: fixture file containing a bearer token, `__Host-` cookie, CSRF header, workspace path, private-looking URL, or real UUID run ID fails the sanitization test.
- Happy path: current synthetic fixtures pass the no-leak guard.

**Verification:**
- Fixture scenarios are typed, synthetic, and parsed by existing production parser paths.
- No live capture, secret, or real operator identifier is required.

- [x] **Unit 2: Dev-only fixture router and route absence gates**

**Goal:** Serve synthetic operator behavior from a reserved dev route prefix while proving production absence.

**Requirements:** R6, R7, R8, R9, R10, R15, R17

**Dependencies:** Unit 1

**Files:**
- Create: `src/routes/operator-fixture-harness.ts`
- Create: `src/gateway/operator-fixture-config.ts`
- Create: `src/gateway/operator-fixture-routes.ts`
- Modify: `src/server.ts`
- Test: `test/operator-fixture-harness.test.ts`
- Test: `test/static-assets.test.ts`
- Test: `test/operator-ui.test.ts`
- Test: `test/server.test.ts`

**Approach:**
- Add a fixture-harness flag reader that defaults off and only treats exact trimmed `true` as enabled.
- Extend `DashboardAppConfig` with fixture-harness options independent from `devAutoLogin`, `operatorUiEnabled`, and `gatewayOperatorSessionEnabled`.
- Register fixture routes only when the app is non-production and loopback-bound. If the fixture flag is enabled on a non-loopback bind, app construction must throw instead of silently omitting routes.
- Define the reserved prefix `/__fixture/operator/*` once in `src/gateway/operator-fixture-routes.ts` and use it for route registration, public-path checks, browser endpoint configuration, and production absence assertions.
- Add the reserved dev prefix to `isPublicPath` only when the full fixture gate is active so browser fixture calls do not get intercepted by auth middleware.
- Mount synthetic session, CSRF, repo list, launch, stream, approvals, and decision routes under the dev prefix only.
- Accept a scenario selector on launch, validate it against the Unit 1 scenario names, and bind it to the newly minted synthetic run ID.
- Keep production `/operator` as a redirect to `/`; keep production `/operator/*` data routes absent.
- Use non-echoing validation errors and sanitized logs for every fixture route.
- Ignore inbound cookies, authorization headers, and real CSRF values; tests must prove those values are neither accepted as evidence nor reflected in responses/logs.
- Scope in-memory idempotency and stream state by fixture session/run identifier, and reset it with the dev server process.
- Set no-store headers on every fixture response.
- Keep fixture logging at debug level. Logs use route templates, status, and coarse error class only; they must not include request URLs with identifiers, headers, body text, synthetic values, or validation message detail.
- Fixture responses inherit normal app CSP and may only tighten it.

**Execution note:** Start with production 404/public-path/auth-boundary tests, then add successful fixture responses.

**Patterns to follow:**
- `src/server.ts` public-path and auth middleware ordering
- `src/gateway/operator-config.ts`
- `docs/solutions/security-issues/operator-ui-mock-only-skeleton-pattern-2026-06-18.md`

**Test scenarios:**
- Happy path: fixture mode returns synthetic session, CSRF, repo list, launch response, stream bytes, and approval state from `/__fixture/operator/*`.
- Error path: production mode returns 404 for every fixture route even if the fixture env var is set.
- Error path: fixture flag enabled with a non-loopback bind causes app construction to fail with a clear error.
- Error path: fixture flag disabled on loopback leaves fixture routes unmounted and not public-allowed.
- Error path: fixture route requests with fake real cookies, bearer tokens, CSRF values, private repo names, or request IDs never reflect those values in responses or logs.
- Edge case: duplicate launch with the same idempotency key and same synthetic fixture session returns the same synthetic run ID.
- Edge case: two synthetic sessions or two tabs do not reuse each other's run IDs.
- Edge case: two tabs choosing different scenarios receive stream timelines for their own run IDs without cross-talk.
- Integration: `/operator` redirects to `/`; `/operator/repos`, `/operator/runs`, stream, and approval paths remain absent on the dashboard app.

**Verification:**
- Fixture routes are reachable only in dev fixture mode.
- Auth middleware ordering and public-path policy are explicitly covered by tests.
- Production route absence is proven for both fixture routes and real operator data routes.

- [x] **Unit 3: Fixture-aware browser entry and visible mode state**

**Goal:** Let the assembled operator PWA use fixture routes in dev mode without changing production runtime modules or broadening network behavior.

**Requirements:** R6, R7, R10, R15, R16, R17, R18

**Dependencies:** Unit 1, Unit 2

**Files:**
- Create: `web/src/operator/fixture-runtime-loader.ts`
- Modify: `web/src/operator/runtime.ts`
- Modify: `web/src/views/Operator.tsx`
- Modify: `public/operator-stream.js`
- Modify: `public/operator-launch.js`
- Test: `web/src/operator/runtime.test.ts`
- Test: `web/src/views/Operator.test.tsx`
- Test: `test/operator-launch-core.test.ts`
- Test: `test/operator-stream-core.test.ts`
- Test: `test/static-assets.test.ts`

**Approach:**
- Select fixture behavior through the runtime-loader seam only in development builds; production browser bundles must not contain fixture route strings or fallback paths.
- Keep production module resolution intact: non-fixture mode still imports the two production runtime modules with `?manual=1`.
- Add optional endpoint-base/path-builder hooks to the existing public browser modules. The default remains `/operator`, and fixture mode passes `/__fixture/operator` through the loader.
- Apply the endpoint base to the full browser operator surface: session CSRF, repo list, launch, stream, approvals, and decisions. Do not only redirect launch and stream.
- Add a fixture-only scenario selector to the local launch surface so developers can trigger success, terminal failure, contract drift, and malformed/unavailable streams without editing code.
- Keep parser, reducer, output accumulation, terminal-status handling, and approval rendering on the production module path.
- Add a visible local fixture-mode indicator in the operator shell. The indicator should make clear that repos, runs, CSRF, approvals, and output are synthetic.
- Define visible state behavior for fixture mode MVP: loading, ready with fixture indicator, empty repo list, launch in progress, streaming output, terminal success/failure, contract drift/unavailable, and malformed stream failure.
- Preserve keyboard access, focus after launch/error state changes, and existing ARIA live behavior for status/output transitions.

**Execution note:** Characterize non-fixture runtime imports and Strict Mode cleanup before adding fixture selection.

**Patterns to follow:**
- `web/src/operator/runtime.ts`
- `web/src/views/Operator.tsx`
- `public/operator-stream.js`
- `public/operator-launch.js`
- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md`

**Test scenarios:**
- Happy path: fixture mode uses the fixture endpoint base and renders the fixture-mode indicator.
- Happy path: selecting a fixture scenario sends it with launch and the resulting stream uses that scenario for the returned run ID.
- Happy path: fixture launch renders a run card, running status, output text, and terminal status.
- Edge case: non-fixture mode still imports `/static/operator-stream.js?manual=1` and `/static/operator-launch.js?manual=1`.
- Edge case: non-fixture mode uses default `/operator/*` paths for session CSRF, repos, launch, stream, approvals, and decisions.
- Error path: fixture flag/config failure maps to the existing unavailable state without path-specific copy.
- Error path: contract drift renders no guessed run data and remains path-unaware.
- Edge case: React Strict Mode double mount does not duplicate launch handlers or stream handles.
- Accessibility: keyboard launch/retry path works, focus moves to the relevant status/error region, and status/output changes remain announced.
- Build guard: production browser bundles/static assets do not contain `/__fixture`, the fixture-loader path, fixture-mode flag, or fallback route strings.

**Verification:**
- Fixture behavior is scoped to dev fixture mode.
- Production runtime imports, CSP posture, and browser bundles remain fixture-free.
- Developers can tell from the UI that the run is synthetic.

- [x] **Unit 4: Assembled browser verification and cache boundaries**

**Goal:** Prove the local fixture harness works in the assembled PWA without turning documentation and long-term policy work into core implementation scope.

**Requirements:** R6, R8, R10, R11, R18

**Dependencies:** Unit 1, Unit 2, Unit 3

**Files:**
- Modify: `package.json`
- Modify: `web/vite.config.ts`
- Test: `test/static-assets.test.ts`

**Approach:**
- Add only the minimal dev command or script needed to start fixture mode with the documented no-watch, loopback, dev-autologin posture. The command must set `DASHBOARD_HOST=127.0.0.1` so unsafe default binding cannot accidentally enable fixture mode.
- Add a fixture-specific web build mode or flag for assembled local verification so fixture-only browser code exists in local compiled assets but remains absent from normal production builds.
- Do not add fixture route handling to `web/src/sw.ts` unless tests prove it is necessary. Unknown fixture paths naturally bypass the current SW route set; the plan's SW requirement is to prove that behavior and guard it from future route expansion.
- Add static/source assertions for production browser assets and service-worker output: no `/__fixture`, fixture flag, fixture loader, or fixture fallback path in production build artifacts.
- Scan production `web/dist` JavaScript, HTML, and service-worker files after build. Fixture imports must be fully dev-gated so Vite removes the module request strings from production output.
- Run assembled browser verification as the completion gate, not as a separate docs deliverable.
- Leave permanent `docs/solutions/` capture for after the implementation proves the final shape.

**Execution note:** Use the orchestrator-owned dev server recipe for browser verification; subagents should consume only the running URL.

**Patterns to follow:**
- `docs/solutions/workflow-issues/dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md`
- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md`
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`

**Test scenarios:**
- Integration: production static checks prove `/__fixture`, fixture route strings, and fixture flags are absent from browser build artifacts and service-worker output.
- Integration: SW route/cache checks prove fixture responses are not intercepted, precached, runtime-cached, or stored under production-equivalent keys.
- Browser: root loads operator shell in fixture mode and displays the fixture-mode indicator.
- Browser: synthetic success launch renders a run card, status, streamed output, and terminal status.
- Browser: selected terminal-failure scenario renders visible failed status after output.
- Browser: unsupported contract scenario renders drift/unavailable behavior without guessed run data.
- Browser: malformed/unavailable scenario reaches the path-unaware failure surface.
- Browser: `/operator` canonicalizes to `/` and offline `/operator` still redirects to `/`.
- Browser: no stale monitoring, mock skeleton, or old fixture-only copy appears in the assembled surface.

**Verification:**
- Unit, type, lint, build, and browser verification all pass.
- Fixture behavior is demonstrably local-only and does not rely on live Gateway access.

---

## System-Wide Impact

- **Interaction graph:** Local fixture mode spans server config, dev routes, fixture data, browser runtime loader, operator client behavior, SSE parsing, and PWA verification.
- **Error propagation:** Fixture failures must map to existing path-unaware operator states; no route-specific or permission-specific oracle copy.
- **State lifecycle risks:** In-memory launch idempotency and stream replay state must be scoped by synthetic fixture session/run and reset with the dev server process.
- **API surface parity:** Fixture routes are intentionally not the production API surface; production `/operator/*` absence remains an invariant.
- **Integration coverage:** Browser verification is required because unit tests cannot prove CSP, SW, dynamic module import, route ordering, cache behavior, or assembled DOM behavior.
- **Unchanged invariants:** Read-only dashboard construction remains intact; production dashboard still does not write through to GitHub or proxy Gateway operator data routes.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Fixture routes leak into production | Strict dev/loopback gate, public-path tests, production 404 tests, and browser build absence assertions. |
| Fixture browser code ships in production bundles | Compile-time dev gating plus static checks for dev prefix, fixture flag, and fixture loader strings. |
| Fixture mode silently inactive due to unsafe bind | Fixture flag on a non-loopback bind fails app construction; the dev command sets `DASHBOARD_HOST=127.0.0.1`. |
| Fixture files accidentally contain real operator data | Narrow no-leak guard for changed fixture files and concrete forbidden-value tests. |
| Fixture responses echo credentials | Non-echoing errors/logs and tests with fake cookies, bearer tokens, CSRF, repo names, and request IDs. |
| Service worker stores fixture responses | Explicit SW/cache invariants and browser cache verification. |
| Harness hides contract drift | Matching scenarios use the vendored contract constant; drift scenarios are explicit and fail closed. |
| Browser wiring becomes magical | Use scoped runtime-loader seam, not global `fetch` override. |
| Fixture green is mistaken for live Gateway proof | Visible fixture-mode indicator and docs/copy that label all local data synthetic. |
| Unit tests pass while assembled surface fails | Real-browser assembled verification is required before completion. |

---

## Documentation / Operational Notes

- Do not add a permanent solution doc until the implementation proves the final harness shape.
- Update `AGENTS.md` only if the implemented command becomes the canonical browser-verification entrypoint.
- Keep any infra/Gateway timeout follow-up linked to `fro-bot/agent#1055`, not this plan.
- Fixture mode is developer-only local tooling. Before enabling it, the dev server must be bound to `127.0.0.1`, `localhost`, or `::1`; `NODE_ENV` must not be `production`; and the fixture dev command must set the loopback host explicitly instead of relying on documentation.

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-06-27-operator-local-development-harness-requirements.md`
- `src/server.ts`
- `src/gateway/operator-client.ts`
- `src/gateway/operator-fixtures.ts`
- `src/gateway/operator-sse-reader.ts`
- `web/src/operator/runtime.ts`
- `web/src/views/Operator.tsx`
- `web/src/sw.ts`
- `public/operator-stream.js`
- `public/operator-launch.js`
- `test/operator-mock-client.ts`
- `test/operator-ui.test.ts`
- `test/operator-stream-core.test.ts`
- `test/operator-sse-reader.test.ts`
- `test/static-assets.test.ts`
- `docs/solutions/workflow-issues/dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md`
- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md`
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`
- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md`
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`
- `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md`
- `docs/solutions/security-issues/operator-ui-mock-only-skeleton-pattern-2026-06-18.md`
- `fro-bot/agent#1055`
