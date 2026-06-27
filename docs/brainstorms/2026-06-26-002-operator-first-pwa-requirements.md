---
date: 2026-06-26
topic: operator-first-pwa
---

# Operator-First PWA Requirements

## Summary

Make the operator app the dashboard's only active PWA surface for this release. The app launches into operator work from `/`, monitoring is removed from the user-facing frontend path, and mobile/PWA failures become explicit auth, rate-limit, unavailable, or offline states instead of one generic offline notice.

---

## Problem Frame

The PWA now works well enough to expose product-shape problems that were hidden when monitoring was the only live surface. The installed app and Mobile Safari can show `Offline — no cached data available` even when the service is reachable elsewhere, because API failures such as auth expiry, redirect-to-login, rate limiting, and real network failure collapse into the same monitoring-oriented state.

The operator route also inherits monitoring-first assumptions. Browser navigation to `/operator` can be rewritten to the cached root shell, the manifest launches at `/`, and the client app mounts monitoring as the only primary shell. That creates an operator-control app that starts by showing the wrong product.

This release makes a product bet: operator control is the active surface, and monitoring is intentionally removed from the frontend app instead of preserved as a fallback. If monitoring returns, it should return through a separate product decision with a clear reason and a new implementation path.

---

## Terminology

- Operator app: the PWA frontend surface used to launch, observe, and approve Fro Bot runs.
- Gateway operator API: the same-origin backend surface that owns operator sessions, authorization, runs, streams, approvals, and rate limits.
- Monitoring: the previous read-only repository health dashboard, removed from the user-facing frontend path for this release.
- Unavailable: the neutral user-facing state for denied, malformed, contract-drifted, or otherwise unusable operator data that should not reveal protected state.

---

## Actors

- A1. Operator: opens the installed PWA or browser app to launch, observe, and approve Fro Bot runs.
- A2. Dashboard app: serves the authenticated operator app shell, routes first-load navigation, and renders operator state.
- A3. Gateway operator API: owns operator session, run, stream, approval, and rate-limit behavior.
- A4. Service worker: caches safe app-shell and read-only assets while refusing to manufacture stale operator control state.

---

## Key Flows

- F1. Operator app launch
  - **Trigger:** The operator opens `https://dashboard.fro.bot/`, the installed PWA, or an existing `/operator` link.
  - **Actors:** A1, A2, A4
  - **Steps:** The app resolves `/` as the canonical operator URL, redirects existing `/operator` links to `/`, avoids serving the monitoring shell for either path, and renders the operator loading or auth state.
  - **Outcome:** The first visible product is operator control, not monitoring.
  - **Covered by:** R1, R2, R3, R4, R5, R6

- F2. Explicit operator availability state
  - **Trigger:** The operator interface needs session, run, stream, approval, or launch data and the request does not return a usable success response.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** The app classifies the failure into a safe user-facing state, disables mutating controls when necessary, and offers the right recovery action without leaking hidden resources.
  - **Outcome:** The operator can tell whether to sign in, retry later, reconnect, or stop because the device is offline.
  - **Covered by:** R7, R8, R9, R10, R11, R12, R13

- F3. Monitoring pause
  - **Trigger:** The operator uses the app while monitoring is not the current product focus.
  - **Actors:** A1, A2
  - **Steps:** Monitoring is absent from the main route, PWA start path, and primary navigation; any remaining monitoring code is not presented as the app's active home.
  - **Outcome:** The product no longer competes between monitoring and operator-control modes.
  - **Covered by:** R14, R15, R16

---

## Requirements

**Operator-first launch and routing**

- R1. `/` must serve the operator app shell for authenticated browser and installed-PWA use.
- R2. Existing `/operator` links must redirect to `/` without serving or briefly rendering the monitoring shell.
- R3. PWA install metadata must use `/` as the canonical operator start URL and scope.
- R4. Service-worker navigation fallback must serve the operator app shell for `/` and must not rewrite `/operator` to a monitoring shell.
- R5. First-load unauthenticated behavior must send the operator into the existing Gateway login path without rendering monitoring as an intermediate state.
- R6. Existing installed clients must migrate safely through the service-worker update path with versioned cache invalidation and reload/update affordance.

**Failure and availability states**

- R7. The operator app must use one canonical user-facing state set: auth required, rate limited, offline, and unavailable.
- R8. Auth and rate-limit failures must not render as `Offline — no cached data available`.
- R9. Offline state must disable launch and approval actions with a visible reason; operator actions must not be queued, persisted as deferred drafts, retried by background sync, or auto-replayed on reconnect.
- R10. Rate-limited state must preserve safety and give the operator a retry-later path without implying whether hidden repos or runs exist.
- R11. Gateway denied, malformed, contract-drifted, or otherwise unusable data must fail closed to the neutral unavailable state.
- R12. Recovery actions must be state-appropriate: sign in for auth, retry for temporary failures, and reconnect or reload for stream/session drift.
- R13. State detection must classify concrete signals before rendering so redirects, 401/403 responses, 429 responses, network failures, parse failures, and stream drift cannot collapse into offline by accident.

**Monitoring pause**

- R14. Monitoring frontend UI must be removed from the active app path for this release rather than moved to a secondary route.
- R15. Monitoring must not appear in primary navigation, PWA launch flow, root-route content, service-worker navigation fallback, or app-shell loading states.
- R16. Any remaining monitoring code must not fetch or render in the operator app path.

**Operator safety and continuity**

- R17. Operator session, repo, run-index, launch, stream, approval-list, and approval-decision behavior must preserve the browser-direct Gateway boundary.
- R18. Every operator request must be authorized by the Gateway operator API against the current operator session and scoped resources, independent of any dashboard session state.
- R19. Operator auth state must not be stored in local storage or service-worker caches; logout, session expiry, auth change, and app-version change must invalidate cached operator shell state that could imply an active session.
- R20. Dynamic operator content must render through safe text paths and must not expose prompts, tool arguments, workspace paths, internal URLs, tokens, cookies, CSRF values, or private repository names in UI, console output, caches, telemetry, error payloads, or logs.
- R21. Existing operator live-interaction work remains in scope for the operator app, but this brainstorm does not expand Gateway capabilities beyond already available contracts.
- R22. The interface must remain usable on mobile viewport sizes and as an installed PWA.

**Caching and accessibility**

- R23. Service-worker caching must be allowlisted to shell and static assets; operator session, stream, approval, launch, and run data must be network-only or no-store.
- R24. Sign-out, auth change, and app-version change must purge operator-sensitive caches before another principal can use the app.
- R25. The operator app must preserve keyboard focus order, screen-reader announcements for state changes, and touch targets suitable for mobile operation.

---

## Failure State Classification

| Signal | User-facing state | Primary action | Disabled controls |
|---|---|---|---|
| Redirect to login, 401, or 403 on session/bootstrap | Auth required | Sign in | Launch, approvals |
| 429 from Gateway operator API | Rate limited | Retry later | New launch or affected action |
| Browser network failure or explicit offline signal | Offline | Retry when online | Launch, approvals |
| 5xx, malformed response, contract drift, denied, unknown, or unusable operator data | Unavailable | Retry | Actions depending on unusable data |
| Stream drift or unexpected stream close after a run is selected | Unavailable | Reconnect | Approval decisions until state is current |

---

## Acceptance Examples

- AE1. **Covers R1, R3, R14, R15.** Given the operator opens the installed PWA, when the app launches, the first product surface is operator control and no monitoring dashboard is shown.
- AE2. **Covers R2, R4.** Given the operator opens an existing `/operator` link while the service worker is active, when navigation resolves, the app redirects to `/` and does not display the monitoring shell.
- AE3. **Covers R5, R7, R8, R12, R13.** Given the operator session is missing or expired, when the app needs protected operator data, the UI directs the operator to sign in instead of claiming the app is offline.
- AE4. **Covers R7, R8, R10, R12, R13.** Given the operator hits a rate limit, when the app receives the failure, the UI shows a rate-limit recovery state rather than a generic offline notice.
- AE5. **Covers R7, R9, R23.** Given the device is actually offline, when the operator opens the app, launch and approval actions are unavailable with a visible reason and no action is queued or replayed.
- AE6. **Covers R11, R20.** Given Gateway returns malformed or unexpected operator data, when the app parses it, the UI fails closed without rendering or logging raw sensitive payloads.
- AE7. **Covers R16.** Given the operator app route is open, when app data loading occurs, monitoring aggregation is not fetched or rendered as part of that path.
- AE8. **Covers R17, R18, R21.** Given the operator launches or observes a run, when browser clients call Gateway routes, the dashboard does not add a proxy or credential-brokering layer.
- AE9. **Covers R6, R24.** Given an existing installed PWA has old monitoring shell caches, when the updated app activates, old caches are invalidated and the operator app becomes the served shell.
- AE10. **Covers R22, R25.** Given the operator uses a phone or keyboard, when failure or stream state changes, focus, announcements, and touch targets remain usable.

---

## Success Criteria

- Opening the installed PWA or `/` lands on the operator app.
- Opening `/operator` no longer displays the monitoring dashboard under service-worker control.
- Mobile/PWA failures no longer collapse auth, redirect, rate-limit, and real offline cases into the same offline message.
- Offline operator state prevents mutating actions from being submitted or queued.
- Monitoring is no longer present in the user-facing frontend app path.
- Operators recover from auth expiry, rate limits, and offline transitions without reload loops or wrong-surface launches.
- Operators cannot accidentally submit launch or approval actions from stale, offline, or unauthenticated state.
- Planning can proceed without inventing the route strategy, failure-state taxonomy, or monitoring pause behavior.

---

## Scope Boundaries

- No monitoring redesign, aggregation improvement, or new monitoring route in this slice; monitoring revival is deferred to a separate product decision.
- No backend monitoring data-layer deletion unless it is required to stop active frontend fetching or rendering.
- No offline queueing, background sync, or optimistic replay of operator actions.
- No push notifications for approvals; `fro-bot/dashboard#108` remains the follow-up.
- No new Gateway capabilities beyond current operator session, run, stream, approval, repository, and run-index contracts.
- No dashboard-managed proxy for Gateway operator APIs.
- No dedicated infra GitHub App hardening; `fro-bot/dashboard#112` remains separate.

---

## Why This Now

- Operator-first routing beats preserving monitoring because the current pain blocks the active control loop: the installed app can open the wrong surface or mislabel auth/rate-limit failures as offline.
- Push notifications remain deferred because they depend on a trustworthy foreground operator surface first.
- Monitoring revival remains deferred because preserving a secondary frontend surface would keep the product split this slice is meant to remove.

---

## Key Decisions

- Operator owns root: `/` and the installed PWA start where the current product value is, not on the dormant monitoring view.
- `/operator` redirects to `/`: existing links keep working while `/` becomes the canonical shell URL.
- Monitoring frontend is deleted, not relocated: this avoids preserving a half-current secondary product surface while operator work is the focus.
- Failure states split by operator actionability: auth required, rate limited, unavailable, and offline lead to different safe next actions.
- Operator state is not offline-cached as truth: stale control data is more dangerous than a harder reload.
- Browser-direct Gateway calls stay intact: the route shift must not create a dashboard credential broker.

---

## Dependencies / Assumptions

- The Gateway operator session flow is the intended auth path for the active app surface.
- The current same-origin reverse-proxy deployment keeps browser-direct `/operator/*` calls viable.
- Existing operator launch, stream, approval, repository, session, and run-index client work remains the base for the primary interface.
- The service worker can keep caching safe shell/static assets while excluding or network-only handling operator session, stream, approval, and mutation state.
- A future monitoring revival can happen as a separate product decision rather than being preserved by default here.
- If same-origin browser-direct `/operator/*` calls are not available, the operator app must fail closed rather than add a dashboard proxy workaround.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7-R13][UX copy] What exact copy best separates auth required, rate limited, unavailable, and offline without leaking protected state?
- [Affects R14-R16][Technical] What is the lowest-risk frontend deletion boundary that removes monitoring from the active app without pulling unrelated backend cleanup into this slice?

---

## Sources / Research

- `web/src/sw.ts` — service worker route handling, API cache behavior, and navigation fallback behavior.
- `web/public/manifest.webmanifest` — current PWA launch path and app metadata.
- `web/src/App.tsx` — current monitoring-first client shell.
- `web/src/views/Monitoring.tsx` — current generic offline handling.
- `web/src/api/aggregation.ts` — monitoring API failure handling.
- `src/server.ts` — auth middleware, API rate limiting, operator route mounting, and static/PWA asset serving.
- `src/routes/operator.ts` — current operator SSR skeleton and auth/session affordances.
- `src/gateway/operator-client.ts` — browser-direct Gateway operator client boundary.
- `docs/brainstorms/2026-06-26-001-operator-run-index-demock-requirements.md` — prior run-index de-mock scope that remains relevant inside the operator-first surface.
