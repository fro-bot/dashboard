---
date: 2026-06-25
topic: dashboard-full-pwa
status: requirements
mode: repo-grounded
---

# Requirements: Full PWA for the Fro Bot monitoring dashboard

## Problem & Goal

The dashboard is a PWA in name only: `web/public/manifest.webmanifest` exists and is linked from `web/index.html`, but there is no `vite-plugin-pwa`, no service worker, no install affordance, and no offline/update behavior (`web/src/main.tsx` boots plain React). The goal is a **full PWA**: an installable, instantly-loading, offline-capable monitoring app with update handling and opt-in push — preserving the read-only posture and the opt-in-telemetry rule. (Redaction is enforced server-side and is not affected by client-side caching — see R3.)

## Confirmed Decisions

- **Primary value:** one-click-away + instant load — the dashboard installs as an app and opens instantly from a cached shell; live data comes fresh from the BFF when online.
- **Scope is the full PWA capability set** (none deferred):
  - Installability + custom install-prompt UI
  - Service-worker app-shell precaching (instant load)
  - Offline data caching at rest (last-known-good monitoring snapshot)
  - Update handling (prompt-to-refresh)
  - Opt-in push notifications / background sync
  - Mobile/responsive install
- **Offline behavior:** show this-session / last-cached data with a clear stale banner; explicit offline/unreachable state when there is nothing safe to show.
- **Updates:** prompt-to-refresh when a new version is ready (`registerType: 'prompt'`); never silently run a stale shell, never yank the page mid-triage.

## Requirements

### R1 — Installable app
- Add `vite-plugin-pwa` to `web/`; generate a valid, lint-clean SW + manifest integration (reconcile with the existing `web/public/manifest.webmanifest`).
- Provide a **custom install-prompt affordance** (capture `beforeinstallprompt`, present an in-app "Install" control) in addition to the browser default; dismissible and non-nagging.
- Installable on desktop and mobile; the existing responsive monitoring layout works in the installed standalone window.

### R2 — App-shell precaching (instant load)
- Service worker precaches the static shell (HTML/JS/CSS/icons/manifest) so the app opens instantly rather than cold-loading.
- Precache set must cover every CI-built `web/dist` asset; the precache manifest is build-generated, not hand-maintained.

### R3 — Offline data caching at rest (a staleness problem, not a redaction one)
- Cache the last monitoring snapshot so the app shows last-known-good repo state offline / on flaky network.
- The cached payload is the `/api/monitoring` DTO. That DTO is **already fully redacted server-side**: the BFF aggregator excludes denylisted repos before any per-repo query, so the client never receives private repo identity in the first place. Caching the DTO therefore caches only public data — there is no private identity at rest to protect, and no client-side redaction recheck is needed.
- The real concern is ordinary **staleness**: a cached snapshot shows older public data. Handle it as a freshness/UX problem, not a privacy one:
  - On reconnect, fresh data replaces the cache.
  - On fetch failure, fall back to the cached snapshot with a clear stale banner showing its age; an explicit offline state when there is no cached snapshot.
  - An optional freshness threshold may drive how loudly the staleness is surfaced (e.g. "data is 2h old"), but it is a UX signal, not a fail-closed privacy gate.

### R4 — Offline / unreachable UX
- Cached shell loads instantly; if `/api/monitoring` is unreachable, show this-session/last-cached data with a prominent **stale / offline** banner showing the data's age.
- If there is no cached snapshot yet, show an explicit "offline — can't reach live data" state with retry. Distinct from the loading and empty states.

### R5 — Update handling
- SW uses prompt-to-refresh: on a new build, present a non-intrusive "New version available — refresh" affordance; the operator chooses when to reload.
- No silent stale-shell; no forced reload mid-session.

### R6 — Opt-in push notifications / background sync — DEFERRED to a separate plan
- Push is **deferred entirely to its own follow-up plan** (tracked separately). It carries substantial server-side infrastructure (`web-push` + VAPID keypair + a subscription store + a dead-subscription sweeper + a notification-frequency policy) and forces a persistence decision for the currently-stateless dashboard, plus a privacy-policy requirement — all of which deserve their own brainstorm/plan rather than riding along here.
- When built, it stays opt-in only, privacy-policy-gated, minimum-data, self-hosted where feasible (the hard telemetry rule).
- This PWA plan ships the full installable + offline + update experience without push; the SW is structured so a future push-event listener can be added without rework.

### R7 — Mobile / responsive install
- The installed app is usable on mobile viewports; the monitoring triage view (already responsive from the rebuild) holds up in the standalone mobile window, including the install affordance and offline/stale states.

## Constraints (preserved invariants)

- **Read-only by construction** — no new write code path; push is outbound notification only, not a GitHub write.
- **Redaction is enforced server-side and is not a client-cache concern** — the `/api/monitoring` DTO is already redacted (denylisted repos excluded before query), so the client/cache never holds private repo identity. The offline cache stores only this already-public DTO.
- **Telemetry is opt-in + privacy-policy'd** — applies to push subscriptions and any off-device data (R6).
- **Node 24 strip-only native TS**, pnpm, no runtime build — Hono serves CI-built `web/dist`; the SW/precache assets are build artifacts.
- **Release-path parity** — the new SW + precache assets are baked into the image; `release.yaml` `on.push.paths` and `should-release`'s `isHardReleasePath` (and the parity test) must cover them so a SW/asset change triggers a release.
- **CSP** — the SW registration and any push must work under the pinned CSP in `src/server.ts`; reconcile CSP with SW scope.

## Success Criteria

- The dashboard is installable (desktop + mobile) and opens from the installed shell without a cold load.
- A new release surfaces a refresh prompt; the operator updates on their terms.
- Offline / BFF-unreachable shows last-known-good data with a clear stale banner showing its age, or an explicit offline state when there is no cached snapshot.
- Push notifications work only after explicit opt-in, with a privacy policy in place; no off-device data without consent.
- Read-only invariant holds (push is outbound-only, no GitHub writes); the offline cache stores only the already-redacted public DTO.
- Release pipeline triggers on SW/precache asset changes (parity test green).

## Open Questions (for planning)

- Caching strategy mechanics (Workbox via vite-plugin-pwa runtime caching vs a custom SW handler for the `/api/monitoring` snapshot) and where the staleness/age signal is computed.
- Push delivery channel: is there a self-hostable/compliant push path, or does R6 ship as consent-ready-but-inactive until one exists?
- Whether the snapshot cache lives in Cache Storage vs IndexedDB, and the exact TTL value.
- Update-prompt placement in the AppShell.

## Grounding (verified this session)

- `web/vite.config.ts` — React + Tailwind only; no `vite-plugin-pwa`.
- `web/src/main.tsx` — plain React boot; no SW registration.
- `web/public/manifest.webmanifest` + `web/index.html` — manifest exists and is linked.
- `web/src/views/Monitoring.tsx` — the monitoring view + its loading/empty/error/stale states (the offline/stale UX integrates here).
- `src/routes/api.ts` — `/api/monitoring` minimized DTO (the redaction-safe cache payload); `/api/healthz`.
- `src/server.ts` — pinned CSP + static `web/dist` serving (SW scope/CSP reconciliation).
- Release-path parity: `docs/solutions/workflow-issues/release-paths-filter-must-cover-runtime-image-contents-2026-06-25.md`.
