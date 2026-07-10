---
date: 2026-07-08
topic: operator-push-notifications
---

# Operator Push Notifications Requirements

## Summary

Ship opt-in Web Push notifications for high-signal operator events: pending approvals and failed run outcomes. The Gateway is the authoritative owner of notification state, VAPID dispatch, cleanup, and trigger policy; the dashboard is a thin browser client for consent, browser subscription handoff, service-worker display, and logout teardown.

---

## Problem Frame

The operator PWA is now installable, run-centric, and able to render live run output, run history, approval prompts, and sanitized failure reasons. It still only helps when the operator is actively looking at the dashboard. A pending approval or failed run can sit unseen while the operator is away from the tab or device.

Push changes the privacy and persistence model. It introduces a persistent device subscription, a server-initiated outbound channel, browser permission state, VAPID key material, and third-party browser push relays. That makes the first slice a product/security decision as much as an implementation task.

---

## Actors

- A1. Operator: opts in or out, receives notifications, and returns to the dashboard to act.
- A2. Browser/PWA: owns browser permission state, the browser push subscription, notification display, and notification-click behavior.
- A3. Gateway: owns operator identity, Gateway subscription records, operator opt-in state, event triggers, VAPID dispatch, dead-subscription cleanup, and payload policy enforcement.
- A4. Dashboard: renders the consent/settings surface and hands browser push subscriptions to the Gateway without becoming the subscription authority.

---

## Terminology

- **Browser push subscription:** The browser-owned endpoint, `p256dh`, and `auth` key material returned by PushManager for one browser profile or installed PWA.
- **Gateway subscription record:** The Gateway-owned durable record that binds a browser push subscription to an authenticated operator identity, consent timestamp, key version, and active/inactive state.
- **Operator opt-in state:** The Gateway-authoritative preference that says whether an operator wants notifications for this browser/device. The dashboard can request changes but does not own the state.

---

## Key Flows

- F1. Opt in to notifications
  - **Trigger:** The operator enables notifications from an authenticated dashboard surface.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** The dashboard explains approval and failed-run notifications, handles unsupported/install-first states, requests browser permission from a user gesture, creates or reuses the browser push subscription, and registers it with the Gateway.
  - **Outcome:** The operator has an active Gateway subscription record tied to their identity and browser/device, and can disable it later.
  - **Covered by:** R1, R2, R3, R4, R5, R11

- F2. Receive an actionable notification
  - **Trigger:** A subscribed operator has a pending approval or a watched run fails.
  - **Actors:** A1, A2, A3
  - **Steps:** The Gateway applies trigger and frequency policy, sends a minimum-data push, the service worker displays safe copy, and a click opens or focuses a neutral dashboard entry point.
  - **Outcome:** The operator lands in the authenticated app where current run details are fetched live.
  - **Covered by:** R6, R7, R8, R9, R10, R12, R13, R24

- F3. Disable or invalidate notifications
  - **Trigger:** The operator opts out, logs out, the session expires, a subscription is revoked, or a push service reports the subscription dead.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** The Gateway marks the Gateway subscription record inactive immediately, while the dashboard or service worker attempts local browser unsubscribe when possible.
  - **Outcome:** Gateway dispatch stops for that browser/device even if the browser cannot immediately delete its local push subscription.
  - **Covered by:** R5, R15, R16, R17, R19

---

## Requirements

**Consent and permission**
- R1. Push notifications must be opt-in, never enabled by default or requested on page load.
- R2. The dashboard must use a two-step permission flow: in-app explanation first, native browser permission only from a trusted user gesture.
- R3. The consent UI must state the v1 notification classes: pending approvals and failed runs.
- R4. If the browser, permission state, service-worker state, or install context cannot support push, the dashboard must show a state-specific disabled or recovery state instead of attempting subscription.
- R5. The operator must have an obvious opt-out path that removes the browser subscription and the Gateway subscription record.

**Trigger policy**
- R6. The Gateway must send approval notifications only for open approval prompts that need operator attention.
- R7. The Gateway must send terminal run notifications only for failed runs in v1.
- R8. Active-view suppression is best-effort only and must depend on an explicit current-client signal; lack of that signal must not be documented as a hard no-notification guarantee.
- R9. Trigger policy must cap and coalesce repeated events for the same run or approval prompt so one run cannot spam the operator.
- R10. Notification clicks must route to a neutral dashboard entry point that revalidates auth and fetches fresh state; they must never approve, deny, launch, retry, queue work, or deep-link directly into action-bearing state.

**Privacy and data minimization**
- R11. A privacy policy or privacy-policy update must ship before production push is enabled and must describe stored subscription data, retention, export, deletion, and third-party push relay metadata.
- R12. Push payloads must follow a schema-level field allowlist and contain only minimum routing metadata plus safe notification copy; prompts, tool arguments, workspace paths, internal URLs, repo names, tokens, cookies, CSRF values, idempotency keys, session IDs, and raw wire values are forbidden.
- R13. Notification text must use allowlisted copy keys and labels for statuses and failure reasons; free-form backend text is forbidden in push bodies.
- R14. Payload builders, dispatch logs, worker logs, metrics, traces, and error paths must preserve the same redaction boundary as the visible notification body.
- R15. Subscription endpoints, browser keys, delivery metadata, consent timestamps, key versions, and active/inactive state must be treated as operator data with retention, export, and deletion semantics.
- R16. Logout, opt-out, session expiry, and dead-subscription detection must mark the Gateway subscription record inactive immediately and stop future dispatch even when client-side unsubscribe is best-effort.

**Ownership and boundaries**
- R17. The Gateway must own the authoritative subscription lifecycle: create, replace, revoke, export, mark inactive, dispatch, and cleanup.
- R18. The dashboard must not add a dashboard-owned persistent subscription store or proxy Gateway notification actions.
- R19. Subscription operations must be bound to an authenticated operator identity plus browser/device subscription and must not be accessible cross-account.
- R20. Dashboard-to-Gateway subscription handoff must use the production same-origin operator boundary, or planning must explicitly define the cross-origin credentials, CSRF, and allowed-origin alternative before implementation.
- R21. VAPID private key material must stay server-side, be separated per environment, have a rotation/leak-response story, and never enter the web bundle, service-worker payload, logs, metrics, traces, or client-visible configuration.
- R22. The VAPID public key may be exposed to authenticated clients for subscription, but it must not become an unauthenticated write path or subscription-spam vector.
- R23. The requirements accept standard Web Push relays, but push relay-visible metadata must be minimized and documented.

**Service worker and browser behavior**
- R24. The service worker must handle push and notification-click events with visible notifications and focus-or-open navigation.
- R25. Push handling must preserve the existing service-worker cache/auth invariants: shell/static assets may be cached, while operator auth/session/run data remains network-only or no-store.
- R26. The implementation must handle denied permission, dismissed permission, unsupported browsers, non-installed iOS PWA context, missing service-worker readiness, failed subscribe attempts, and dead subscriptions as distinct user-visible states.
- R27. The consent UI must be operable by keyboard, preserve focus, expose disabled/recovery states to screen readers, and avoid burning the native browser prompt when support or install prerequisites are not met.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3.** Given an authenticated operator with notification permission unset, when they enable notifications from the dashboard, the dashboard first explains approval and failed-run notifications, then requests native permission from that click.
- AE2. **Covers R4, R26, R27.** Given an iOS Safari browser tab that is not running as an installed PWA, when the operator views notification settings, the dashboard explains that installation is required and does not call the native permission prompt.
- AE3. **Covers R6, R9, R10.** Given a run emits the same pending approval more than once, when the Gateway applies notification policy, the operator receives at most one approval notification for that prompt and clicking it opens the dashboard.
- AE4. **Covers R7, R8, R9.** Given the operator is viewing a run and the client has recently signaled that active context, when that run fails, the Gateway may suppress the failed-run notification; without a current signal, suppression is best-effort and not guaranteed.
- AE5. **Covers R12, R13, R14.** Given a failed run includes a known sanitized failure reason, when the Gateway builds and logs a notification, the body and logs use allowlisted labels and exclude prompt text, repo names, workspace paths, and raw `failureKind` values.
- AE6. **Covers R16.** Given the operator logs out, when logout completes or falls back to login recovery, the Gateway marks the subscription record inactive even if the browser cannot immediately delete the browser push subscription.
- AE7. **Covers R24, R25.** Given a push arrives while the app is closed, when the service worker handles it, it shows a visible notification and does not read cached operator run details to compose the body.
- AE8. **Covers R10.** Given a notification points at a run that no longer exists or the operator is logged out, when the notification is clicked, the dashboard opens a neutral authenticated entry point and fetches current state instead of rendering stale privileged state.

---

## Success Criteria

- Operators can opt in with clear consent and receive only high-signal notifications for approvals and failed run outcomes.
- Operators miss fewer pending approvals without needing to keep the dashboard foregrounded.
- Failed runs become visible without adding notification noise for ordinary succeeded/cancelled runs.
- The dashboard remains non-authoritative for notification state; subscription persistence and delivery are owned by the Gateway.
- Push payloads, logs, metrics, traces, and errors cannot reveal prompts, repo identity, workspace paths, credentials, or raw backend reason codes.
- Unsupported browsers and non-installed iOS contexts degrade with clear explanations and no burned permission prompts.
- Logout, opt-out, and dead-subscription cleanup stop future notifications for that browser/device.
- Downstream planning has no unresolved product questions about triggers, ownership, privacy gates, or v1 scope boundaries.

---

## Scope Boundaries

- Background Sync, Periodic Sync, Background Fetch, silent push, offline approval, deferred approval, and offline run launch are not part of v1.
- Succeeded-run notifications, cancelled-run notifications, notification preference matrices, quiet hours, per-repo filtering, digests, snooze, and notification history are deferred.
- Self-hosting a browser push relay is not part of v1; standard Web Push relays are accepted with minimum-data encrypted payloads.
- Notification clicks do not perform mutating operator actions.
- Dashboard monitoring UI resurrection is not part of this work.
- Authenticated production operator regression verification remains tracked separately by note #196.

---

## Key Decisions

- **Gateway-owned subscriptions:** Subscription storage and dispatch belong with the Gateway because push state is tied to operator identity and Gateway events, while the dashboard should stay a browser UI/client.
- **Approvals plus failed outcomes:** v1 covers action-required approvals and failed runs, but excludes succeeded/cancelled outcomes, lower-signal status churn, and output activity.
- **Notifications only:** Background sync and offline actions stay out because browser support is uneven and the operator surface already forbids offline replay.
- **Minimum-data payloads:** Notifications should wake and route the operator, not carry sensitive run details.
- **Privacy policy as a gate:** Production push cannot ship without a privacy-policy story for subscription data, retention, export, and deletion.

---

## Dependencies / Assumptions

- Gateway must expose or own the subscription, unsubscribe, dispatch, and cleanup capabilities needed by the dashboard consent flow.
- Gateway and dashboard must share a same-origin deployment posture for browser subscription handoff and notification clicks, unless planning explicitly replaces it with a reviewed cross-origin contract.
- The browser Web Push stack is available on modern browsers, but iOS requires iOS 16.4+ and installed-PWA context.
- Adding a server-side Web Push dependency, VAPID secret provisioning, and any persistent store requires explicit planning approval before implementation.
- Existing service-worker registration and cache-routing invariants must remain intact.

---

## Permission and Notification States

| State | User-facing behavior | Primary CTA |
|---|---|---|
| Supported, not requested | Show what notifications include and what they exclude. | Enable notifications |
| Permission granted, subscribed | Show enabled state and the two v1 notification classes. | Disable notifications |
| Permission denied | Explain browser-level block and avoid re-prompting. | Open browser settings guidance |
| Prompt dismissed | Keep opt-in available without repeated automatic prompting. | Try again |
| Unsupported browser/API | Explain that this browser cannot receive Web Push. | None |
| iOS not installed as PWA | Explain that iOS requires the installed PWA context. | Install app |
| Service worker not ready | Show temporary unavailable state. | Retry |
| Subscribe failed | Explain that setup failed without assuming permission denial. | Retry |

---

## Notification Copy Rules

| Notification type | Title | Body rule |
|---|---|---|
| Pending approval | Approval needed | State that a run needs operator review; do not include prompt, repo, path, command, or request text. |
| Failed run | Run failed | State that a run failed and may include an allowlisted failure label; do not include raw failure codes or run output. |

Notification actions, if the browser supports them, must only open the dashboard. Browsers without actions must still receive a useful title/body fallback.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R6, R7, R9][Technical] What exact coalescing window and dedupe key should the Gateway use for approval and failed-run notifications?
- [Affects R11, R14][Product/legal] Where should the privacy policy live, and what retention/export/delete language is required for push subscription data?
- [Affects R21][Technical] What VAPID provisioning model should be used for dev, CI, staging, and production?
- [Affects R22][Technical] Should the public VAPID key endpoint require an authenticated Gateway session, or can it be public while subscribe/unsubscribe remain authenticated?
- [Affects R24, R26][Verification] What local fixture or browser-test harness should simulate push delivery without relying on production push services?

---

## Sources / Research

- GitHub issue: `fro-bot/dashboard#108`
- `docs/brainstorms/2026-06-25-001-dashboard-full-pwa-requirements.md`
- `docs/brainstorms/2026-06-26-002-operator-first-pwa-requirements.md`
- `docs/brainstorms/2026-06-22-001-feat-web-tool-approval-ux-requirements.md`
- `docs/plans/2026-07-03-001-feat-operator-home-run-centric-redesign-plan.md`
- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md`
- `docs/solutions/best-practices/operator-approval-channel-consumption-2026-06-22.md`
- `docs/solutions/best-practices/operator-failure-reason-rendering-contract-1-6-0-2026-07-08.md`
- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md`
- `docs/solutions/build-errors/web-bundle-server-import-boundary-2026-07-04.md`
- Browser/API research: Push API, Notifications API, Web Push VAPID, service-worker push and notification-click handlers, and Background Sync support constraints.
