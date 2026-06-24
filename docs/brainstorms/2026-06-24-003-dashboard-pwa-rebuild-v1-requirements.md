---
date: 2026-06-24
topic: dashboard-pwa-rebuild-v1
status: requirements
related:
  - docs/ideation/2026-06-24-dashboard-pwa-rebuild-ideation.md
  - docs/brainstorms/2026-06-24-002-dashboard-frontend-hosting-decision-requirements.md
---

# Dashboard PWA rebuild — v1 (tracer bullet)

## Overview

Transform `fro-bot/dashboard` from a static Hono SSR UI into a responsive, installable PWA in the Fro Bot design language. v1 is a **tracer bullet**: stand up the new frontend stack and design system, prove them end-to-end on the `/` monitoring view, and establish the patterns the rest of the UI follows. The Hono backend is frozen as the BFF; hosting stays on `dashboard.fro.bot` (per the hosting-decision doc).

## Confirmed decisions

1. **Stack:** Vite + React + `vite-plugin-pwa`. The Hono app is kept as the BFF (OAuth, read-only token minting, redaction, aggregation, SSE origination) on the same `dashboard.fro.bot` origin. The frontend calls it same-origin.
2. **Build:** the SPA is **built in CI** and ships hashed static assets; the droplet runtime stays no-build (Hono serves static files + BFF APIs). The "no build step" rule is preserved as **"no *runtime* build step."**
3. **Migration:** **tracer bullet.** Stand up the PWA shell + design tokens, rebuild the `/` monitoring view first (Caddy serves the SPA for that route; Hono SSR keeps serving the rest), then expand route-by-route.
4. **Components:** **headless primitives (Radix or Ark) styled entirely by Fro Bot tokens** — distinctive aesthetic, accessibility/behavior handled by the primitives, minimal bundle, no library visual opinions to override.
5. **Compounding scope:** **keep code locally modular in one repo with clean internal seams; do not publish `@fro-bot/*` packages and do not build extraction-ready public package APIs yet.** Extract only when a real second consumer appears.
6. **Design quality tooling — Impeccable Style** (github.com/pbakaus/impeccable, Apache-2.0): adopt it on two axes — (a) the **`/impeccable` agent skill** + `init`/`audit`/`polish`/`critique` as the design-judgment loop while building the React UI, with Fro Bot's styleguide as the design context; (b) the **standalone deterministic detector** (`npx impeccable detect --json .`, no AI/no browser) as a CI quality gate over the built UI. It is **not** a token set or component library — it is the *how-well* layer, complementary to D1's *what*.

## Deliverables

### D1 — Executable design token system (first deliverable; everything visual depends on it)
Convert `assets/styleguide.md` (Afrofuturism×cyberpunk OKLCH palette, dark-default + light themes, type scale, spacing, radius, motion) into **executable Tailwind 4 theme + CSS-variable tokens**. Semantic tokens (bg/surface/text/accent/cta/status) and the dark-default/light theming carry over verbatim. **Scoped to the minimum token set the `/` route needs** (colors, spacing, type, radius, motion) — deeper component-specific tokens are added per-route as needed, not built up-front as a standalone design-system project.
- **Success:** the `/` view is built entirely from tokens with no ad-hoc colors/spacing; both themes render; WCAG pairings from the styleguide hold; tokens are the single source of truth (no inline hex).

### D2 — Responsive SPA shell + manifest
Responsive React app shell with a web app **manifest** (installable) and the responsive nav frame. **Service worker, offline app-chrome, and the update-prompt loop are deferred** to D2b (after the basic `/` rebuild is proven) — they are a second product concern that shouldn't gate the tracer.
- **Success:** installable (manifest present); responsive shell renders desktop/tablet/phone; no SW/offline complexity in the first bite.

### D2b — PWA service worker + offline (after D3 proves the `/` rebuild)
Own the SW source (`injectManifest` strategy — clean hedge against the deprecating Workbox). Caches **shell/static assets only** (never BFF data — see security constraints). Update-available prompt with a security-sensitive invalidation policy (a stale SW must not mask redaction/auth fixes). Offline app-failure vs shell-failure behavior defined.
- **Success:** offline shows cached app chrome labeled stale (never sensitive data); update prompt invalidates promptly; passes an install/Lighthouse PWA check.

### D3 — `/` monitoring view, rebuilt
The read-only monitoring dashboard rebuilt as a responsive React view on real BFF aggregation data, in the new design language. Replaces the current SSR `/` for this route via Caddy.
- **Success:** renders real aggregation data responsively (desktop/tablet/phone); the assembled page is verified by rendering it, not just unit tests; no fixture/mock leftovers; capability-shipped vs surface-shipped reported honestly.

### D4 — CI build pipeline + deploy integration
Add the frontend build to CI via a **multi-stage Docker image**: a builder stage (dev deps) runs the Vite build; the runtime stage copies only `dist/` + server code and stays no-build. Update `release.yaml` smoke tests to verify the built static bundle is present and served. Validate CSP and cookie auth for the SPA under Caddy.
- **Success:** `dashboard.fro.bot/` serves the built SPA behind auth; CSP holds (`script-src 'self'`, no inline-script generated by the build — verified against emitted HTML); the `session` cookie auth + redirect flow work unchanged; release pipeline green; the backend runtime remains strip-only no-build.

### D5 — Impeccable design-quality gate + context
Install Impeccable (`npx impeccable install`), run `/impeccable init` to write `PRODUCT.md` (brand/product lane, audience, voice) and generate `DESIGN.md` design context grounded in the Fro Bot styleguide. Wire `npx impeccable detect --json .` into CI as a quality gate over the built UI.
- **Calibration caveat (load-bearing):** Impeccable's slop-detectors specifically flag "purple gradients" and "dark glows" — which are **intentional Fro Bot brand elements** (deep-purple-dark-default + cyan/magenta glow). The detector must be calibrated (via `PRODUCT.md` brand-lane context + config/inline-ignores) to treat the Fro Bot aesthetic as deliberate brand, not slop, **without** disabling the detectors that catch genuine quality issues (touch targets, line length, heading order, cramped padding).
- **Success:** `impeccable detect` runs in CI and passes on the `/` rebuild with the brand aesthetic intact; `PRODUCT.md`/`DESIGN.md` exist and reflect Fro Bot; genuine-quality detectors remain active.

## Constraints (must survive the rebuild)

- **All 11 `docs/solutions/` security/UX learnings carry over unchanged** — the React port does not get to soften them. Specifically: read-only-by-construction, the no-dashboard-proxy rule for `/operator/*`, the two-credential-domain split, cross-format denylist-before-query, fail-closed everywhere, no-oracle on mutating paths, contract-version lockstep.
- **SSR→SPA security boundaries (new surface, must be explicit):**
  - **Server-only redaction at the BFF seam.** The SPA is untrusted display-only and must **never receive** denylisted/private repo identifiers or raw pre-redaction records. Redaction stays server-side; the API returns already-filtered data — never "hidden-in-UI" data the client could leak via devtools/logs. (SSR got this for free; the API boundary must now guarantee it.)
  - **Service worker caches shell/static assets ONLY.** The SW must **never** cache BFF JSON, SSE responses, or auth redirects. No sensitive aggregation/operator data may persist in the client cache. Offline = app-chrome only, explicitly labeled stale; no offline data.
  - **`Cache-Control: no-store` on sensitive BFF responses;** auth/fetch invariants explicit at the API boundary.
  - **textContent / no-`dangerouslySetInnerHTML`:** React auto-escaping is the floor, not the ceiling. Explicitly ban `dangerouslySetInnerHTML`, HTML/markdown rendering, and any agent-supplied rich-text path. Agent-supplied strings render as inert text only.
- **CSP (pinned for a Vite/PWA build):** `script-src 'self'` stays strict — **no inline script generated by the build** (verify the emitted HTML; don't assume hashes solve it). Pin `worker-src`/`manifest-src`/`connect-src`/`img-src`/`font-src`/`base-uri`/`object-src`; no `unsafe-eval` in production (guard against dev-tooling divergence leaking in). `style-src` posture re-evaluated but no inline-script regression.
- **No *runtime* build** — the droplet runs prebuilt assets via a multi-stage image (builder stage runs Vite with dev deps; runtime stage copies only `dist/` + server code). The Node-24 strip-only backend must **not** gain a runtime build step.
- **Same-origin BFF** — no CORS introduced; the frontend and BFF share `dashboard.fro.bot`. (If origins ever split, the cookie/CORS problem appears immediately — out of scope here.)
- **Root-route ownership:** Caddy serves `index.html` for SPA client routes at `/`; Hono keeps `/api/*`, `/auth/*`, and the not-yet-migrated SSR routes. The client router treats unknown paths as SPA-only (never asks Hono); a documented cutover rule prevents maintaining two root experiences.
- **Verification gate:** render the assembled page and check it (the "unit-green is not feature-done" rule), not just unit tests. Plus the **Impeccable detector gate** (see D5).

## Non-goals (explicitly deferred)

- **The `/operator` console rebuild** — a later tracer, gated on gateway `fro-bot/agent#1001` + `#1000` (the empty-repos / unmounted-route bugs) shipping so the operator surface has live data to validate against.
- **The mobile-first approval/launch UX leap** (approval triage deck, launch composer, live run timeline) — lands with the operator tracer.
- **Published `@fro-bot/ui` and `@fro-bot/operator-client` packages** — keep code locally modular with clean internal seams; package later only when a second consumer exists (no extraction-ready public APIs in v1).
- **PWA service worker / offline (D2b)** — deferred until after D3 proves the `/` rebuild; v1 ships installable-manifest-only.
- **Push notifications** for pending approvals.
- **The `fro.bot/dashboard` hosting migration** — separate deferred decision (see the hosting-decision doc).

## Success criteria (phase)

- `dashboard.fro.bot/` serves an installable (manifest), responsive React app on real monitoring data, in the Fro Bot design language, behind unchanged auth, with CSP and security invariants intact and the release pipeline green.
- Server-only redaction holds at the BFF seam (the SPA never receives private/denylisted data); the Impeccable detector gate passes with the brand aesthetic intact.
- The token system, shell, and build pipeline are reusable for the next route (operator) without rework.
- Every deferred item has a clear unblocking condition recorded.
