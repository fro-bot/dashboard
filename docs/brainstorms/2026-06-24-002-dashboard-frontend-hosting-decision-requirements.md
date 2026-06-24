---
date: 2026-06-24
topic: dashboard-frontend-hosting-decision
status: decided
supersedes: none
related:
  - docs/ideation/2026-06-24-dashboard-pwa-rebuild-ideation.md
---

# Dashboard frontend hosting decision

## Decision

**The rebuilt dashboard frontend stays on its current origin, `https://dashboard.fro.bot`.** The planned Vite + React PWA rebuild ships to the same origin behind the existing Caddy/droplet deploy. No change to the auth origin, OAuth callback, the dashboard `session` cookie, the gateway `__Host-session`, or `DASHBOARD_GATEWAY_OPERATOR_ORIGIN`.

This decision fixes only the **origin question**. The framework choice, PWA mechanics, design-token implementation, and component scope are deferred to the rebuild brainstorm.

## Why

Verified live/code state that drove the decision:

- **The `fro.bot` apex is GitHub Pages today** (static, currently a 404/placeholder), not a host application — *externally verified by HTTP probe (server: GitHub.com), not a repo-derived fact.* `https://dashboard.fro.bot` is the live Caddy/droplet app (302 → auth). So `fro.bot/dashboard` is **not** "mount a path in an existing app" — it would require making the apex a real reverse-proxy host first.
- **The operator session is same-origin by design** *(verified in `src/server.ts` and `src/gateway/operator-config.ts`)*. The gateway mints a `__Host-session` cookie (host-locked: no `Domain` attribute, `Secure`, `Path=/`), and the dashboard validates the operator session against a configured `DASHBOARD_GATEWAY_OPERATOR_ORIGIN` (default `https://dashboard.fro.bot`). The dashboard's own cookie is plain `session`. Moving origins forces re-minting the `__Host-session` against the new host and migrating the configured origin — a cross-repo (gateway + infra) auth change.
- **Brand unification is the only real benefit of moving, and it is not urgent.** The "detached ops island" feeling that motivated the `fro.bot/dashboard` leaning is better solved by a shared design-system package (consistent identity across properties) than by an origin migration.
- **Doing the origin migration and the framework rebuild at once doubles the risk surface** on a security-sensitive auth path. Approach A delivers the full modernization value (PWA, responsive, Fro Bot design language) at near-zero auth risk.

## Constraints this imposes on the rebuild

- **Same-origin BFF preserved.** The Hono backend stays the BFF on `dashboard.fro.bot`; the frontend calls it same-origin. No CORS, no cross-origin cookie handling introduced.
- **Auth/credential invariants unaffected by hosting.** Read-only-by-construction, the no-dashboard-proxy rule for `/operator/*`, the two-credential-domain split (dashboard `session` ≠ gateway `__Host-session`), and the mode-aware router all carry over unchanged. Hosting is not what changes them.
- **The "one coherent product" goal is reassigned** from hosting to a shared design-system package (tracked separately in the rebuild ideation, idea #7).

## Deferred option: `fro.bot/dashboard` (revisitable)

Recorded so the decision is not lost. Move to path-hosting under the apex **only** when these preconditions are met, as a deliberate platform-consolidation project separate from the framework rebuild:

1. The `fro.bot` apex becomes a real reverse-proxy host (off GitHub Pages, onto Caddy/droplet or an equivalent edge that can proxy `/dashboard/*` to the BFF).
2. The gateway operator-session origin migrates to `fro.bot`: re-mint `__Host-session` against the apex, update `DASHBOARD_GATEWAY_OPERATOR_ORIGIN`, and move the operator OAuth callback. Requires gateway (`fro-bot/agent`) + infra coordination.
3. The dashboard OAuth callback moves to `fro.bot/dashboard/auth/callback`.
4. **Migration sequencing + rollback:** the `__Host-session` re-mint, `DASHBOARD_GATEWAY_OPERATOR_ORIGIN` change, and OAuth-callback cutover must be ordered so a half-applied migration cannot strand operator auth (e.g., the gateway must accept the new origin before the dashboard redirects to it), with a documented rollback to `dashboard.fro.bot`.
5. **PWA service-worker scope** must be re-rooted to `/dashboard/` (a service worker registered at the apex controls a different scope than one at the subdomain root).
6. **CSP** must be re-checked: `connect-src`/`form-action`/`script-src` and the OAuth/login redirect targets change with the origin.

The split-static variant (static shell on the apex, credentialed BFF on `dashboard.fro.bot`) was considered and rejected. The decisive cost is not that a `__Host-` cookie is unreadable cross-origin (true, but not by itself fatal — a cross-origin shell can still make credentialed BFF calls with CORS) but the **added cross-origin complexity it forces**: CORS with credentials, CSRF re-hardening, and a redesigned browser/data boundary for the operator session — for the same brand-URL benefit that the deferred path-hosting option delivers without splitting the origin.

## Success criteria

- The rebuild proceeds against `dashboard.fro.bot` with no auth-origin, OAuth-callback, or gateway-session changes required.
- A future decision to adopt `fro.bot/dashboard` can be made from this record without re-deriving the cookie/OAuth/apex constraints.

## Non-goals

- Framework selection (Vite/React/PWA) — deferred to the rebuild brainstorm.
- Design-token / component / PWA-mechanics scope — deferred.
- Building the shared design-system package — separate ideation item, not part of the hosting decision.
