---
date: 2026-06-25
topic: dashboard-non-blocked-improvements
focus: non-upstream-gated dashboard improvements (PWA, reliability, observability, testing, DX)
mode: repo-grounded
status: closed-failed
---

# Ideation: Non-blocked dashboard improvements

> **CLOSED — FAILED.** This ideation veered off the intended PWA focus into reliability/CI/observability,
> and its top survivor (a redaction regression sentinel) was redundant: `fro-bot/.github` already keeps
> private repos out of the metadata, so the dashboard can assume that boundary holds. Superseded by a
> PWA-focused pass. Retained only as a record of what was cut.

Generated while the issue-driven backlog is fully upstream-gated (operator migration → `fro-bot/agent#1027`, #48 → `fro-bot/agent#907`). These survivors are all buildable now, on the rebuilt Vite+React PWA + Hono BFF, with no upstream dependency.

## Grounding Context (Codebase)

- Dashboard rebuilt as a Vite+React **PWA** (`web/`) + Hono **BFF** (`src/`), monitoring view at `/` on real GitHub App data: 130 repos, attention-first triage. Redaction (denylist-before-query, fail-closed). Released `2026.06.46`.
- **PWA is metadata-only**: `web/public/manifest.webmanifest` exists + linked, but no `vite-plugin-pwa`, no service worker (`web/src/main.tsx` boots plain React), no install/offline/update UX.
- **Monitoring view** (`web/src/views/Monitoring.tsx`): not virtualized — renders 4 full grids of 130 repos in-memory; loading state is a bare div (no `role=status`/`aria-busy`); empty state conflates loading-vs-empty; filters lack `aria-controls`/focus management.
- **BFF**: `/api/monitoring` minimized DTO; `/api/healthz` but no readiness endpoint; the 15-20s aggregation (`src/github/aggregator.ts`) logs success/failure but emits no duration/latency metrics; non-blocking startup serves an empty snapshot first (so first load shows empty for 15-20s).
- **Tests**: unit-heavy (`Monitoring.test` covers render/empty/error/stale/redaction); `App.test` smoke-only; **no assembled-page/e2e smoke**. CI release smoke checks healthz/manifest/CSP but no browser-level page check.
- **Constraints** (AGENTS.md): read-only by construction; redaction must hold (no private repo names rendered/cached/logged); Node 24 strip-only native TS; pnpm; telemetry opt-in + privacy-policy'd (hard rule — no analytics-by-default).
- **Learnings**: `unit-green-is-not-feature-done` prescribes an "open the page" gate; `release-paths-filter-must-cover-runtime-image-contents` warns PWA build outputs will need release-path parity; `cross-source-redaction-denylist-before-query` is the redaction invariant.

## Ranked Ideas

### 1. Redaction Regression Sentinel
**Description:** A permanent CI test that injects denylisted/private repo metadata and asserts those node_ids are excluded **before** any (spied) per-repo GraphQL query, and that no private name appears in the `/api/monitoring` DTO, rendered DOM, logs, or cache — across both `node_id` formats, with every metadata-failure mode failing closed.
**Warrant:** `direct:` AGENTS.md makes redaction-before-query + fail-closed a load-bearing security invariant; the R8 verification this session was a one-off harness, not a permanent guard.
**Rationale:** Turns the scariest possible regression (leaking a private repo's existence) from "code-review memory" into a tripwire that protects every future aggregation/query change. Highest-leverage because it guards the dashboard's entire reason to exist.
**Downsides:** Requires a spy-GraphQL fixture; some upfront test scaffolding.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

### 2. Assembled-Page Browser Smoke Gate
**Description:** A CI check (Playwright or equivalent) that boots the assembled app, loads `/` with authenticated fixture data, waits for the monitoring shell, verifies the count strip / filters / a run of repo cards render, asserts loading/empty semantics, and confirms zero console errors — the "open the page" gate.
**Warrant:** `direct:` the `unit-green-is-not-feature-done` learning explicitly prescribes this gate; this session twice caught surfaces that were unit-green but assembled-broken (the live `/operator` mock, the PWA dev-data).
**Rationale:** Every future UI/BFF change gets one high-leverage end-to-end confidence check instead of unit-test theater. Cheap to run, catches the class of bug that unit tests structurally miss.
**Downsides:** Adds a browser runtime to CI (time + a dependency); needs a stable fixture-data path.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 3. Aggregation Observability Spine
**Description:** Instrument the 15-20s aggregation path with structured local fields: total duration, per-phase timings (metadata → installations → filter → GraphQL batches), repos queried/skipped-by-redaction, GitHub rate-limit budget remaining, and failure class — surfaced via structured logs and/or a local read-only diagnostics view. Local-only, no telemetry off-device.
**Warrant:** `direct:` `aggregator.ts` logs success/failure but has no duration/latency metrics; this session repeatedly debugged aggregation timing by log archaeology.
**Rationale:** Every future "dashboard feels slow / stale / GitHub flaked" investigation starts with evidence instead of vibes. Compounds across all future debugging.
**Downsides:** Must keep strictly local to honor the opt-in-telemetry rule; some plumbing through the aggregator.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

### 4. Readiness + Staleness Contract (and UI state model)
**Description:** Add `/api/readyz` distinct from `/api/healthz` reporting whether the first safe aggregation completed, whether redaction metadata loaded, and snapshot age/freshness. The monitoring UI consumes the same state model to render explicit **loading-first-snapshot vs no-repos vs filter-zero-matches vs stale/degraded** states (folding in the empty-vs-loading fix) and a freshness watermark ("data as of …").
**Warrant:** `direct:` `/api/healthz` exists but no readiness; non-blocking startup serves an empty snapshot first; the empty state currently conflates loading-vs-empty.
**Rationale:** A triage dashboard is only trustworthy if the operator can tell "all clear" from "hasn't seen GitHub yet." One state model serves ops (readiness probe), CI, and UX.
**Downsides:** Touches both BFF and UI; needs care that readiness never leaks redaction detail.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

### 5. Real PWA Capability Layer (service worker + install + update + offline)
**Description:** Move from manifest-only to an actual PWA: add `vite-plugin-pwa`, register a service worker for app-shell caching, an install affordance, an update prompt, and an offline "showing last snapshot / currently offline" degraded UX. Runtime stays simple (Hono serves CI-built `web/dist`).
**Warrant:** `direct:` manifest exists + linked but there is no `vite-plugin-pwa`, no SW, no install/offline/update — the "PWA" is a PWA in name only (the deferred D2b from the rebuild plan).
**Rationale:** A monitoring surface benefits from being one click away and resilient to reload/network hiccups, with no telemetry. Future operator workflows can then assume resilient app behavior.
**Downsides:** SW caching + the release-path parity bug class (the SW/precache assets must be release-triggering); update UX needs care to avoid serving a stale shell. Highest design surface of the set.
**Confidence:** 70%
**Complexity:** High
**Status:** Unexplored

### 6. Last-Known-Good First Paint
**Description:** Persist the last successful minimized monitoring DTO (server-side and/or client cache) and render it immediately — clearly marked stale/freshening — while the 15-20s aggregation runs, instead of showing empty.
**Warrant:** `direct:` the BFF serves an empty snapshot first and aggregation takes 15-20s, so a cold load shows nothing useful for up to 20s.
**Rationale:** Inverts the cold-start delay from "nothing is happening" into instant situational awareness. Pairs naturally with #4's staleness model.
**Downsides:** Adds a persistence layer; must never serve a stale snapshot that includes a now-redacted repo (redaction recheck on rehydrate).
**Confidence:** 70%
**Complexity:** Medium
**Status:** Unexplored

### 7. Monitoring Virtualization + Keyboard/A11y Primitive
**Description:** Replace the four full in-memory grids with a reusable virtualized "attention list" primitive: windowed rendering, sticky severity headers, keyboard navigation (next/prev/jump-to-tier/focus card), filter-result announcements, and the missing `role=status`/`aria-busy`/`aria-controls`. Fold the "jump to failing repo" command-style navigation into this primitive.
**Warrant:** `direct:` the view renders all 130 repos un-virtualized with partial a11y (loading lacks `role=status`, filters lack `aria-controls`/focus management).
**Rationale:** Turns a one-off perf/a11y fix into a reusable triage-list foundation, and makes the operator move through problems like an inbox rather than mousing through grids.
**Downsides:** Virtualization + a11y is fiddly; at 130 repos the perf win is modest today (value grows with repo count) — a11y/keyboard is the stronger near-term driver.
**Confidence:** 65%
**Complexity:** Medium
**Status:** Unexplored

## Honorable mention (not top survivors)

- **Sanitized GitHub data replay fixtures / dev snapshot replay** — captured, redacted monitoring DTOs as stable test+dev fixtures; removes the 15-20s dev tax and gives #2 realistic data. Strong enabler; folds naturally into #2's fixture-data need.
- **DX learnings pack** (`docs/solutions/developer-experience/`) — documents the Node 24 strip-only / no-runtime-build / PWA gotchas; real gap but documentation-leverage, lower than executable guards.

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Explicit empty-vs-loading-vs-no-matches states | Subsumed by #4 (the readiness/staleness contract drives these UI states) |
| 2 | Dashboard design-system extraction | Premature abstraction — YAGNI until a second UI surface needs it (operator page deferred) |
| 3 | @fro.bot/runtime extraction readiness pass | Explicitly premature per AGENTS.md (no extraction until a 2nd consumer); reasoned-only, no current trigger |
| 4 | Local pull-to-push notifications / title-badging | Permission-UX complexity, telemetry-adjacent; lower leverage than the reliability cluster; better as a later brainstorm |
| 5 | Command-palette repo hunt | Overlaps #7 — folded "jump to repo" into the keyboard/a11y primitive |
| 6 | Attention delta mode ("what changed since last snapshot") | Needs snapshot-diff state + semantics; better as its own brainstorm than a filtered improvement; moderate cost |
| 7 | Sticky triage context bar | Useful but minor; folds into #4's freshness watermark + #7's sticky headers |
