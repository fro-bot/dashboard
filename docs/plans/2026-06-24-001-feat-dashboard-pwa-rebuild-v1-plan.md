---
title: "feat: Dashboard PWA rebuild v1 (tracer bullet)"
type: feat
status: active
date: 2026-06-24
origin: docs/brainstorms/2026-06-24-003-dashboard-pwa-rebuild-v1-requirements.md
---

# feat: Dashboard PWA rebuild v1 (tracer bullet)

## Overview

Transform `fro-bot/dashboard` from a static Hono SSR UI into a responsive, installable PWA in the Fro Bot design language. v1 is a tracer bullet: stand up the Vite + React frontend stack, executable design tokens, CI build, and the Impeccable quality gate, and prove them end-to-end on the `/` monitoring view. The Hono backend is frozen as the BFF on the same `dashboard.fro.bot` origin (see origin: docs/brainstorms/2026-06-24-002-dashboard-frontend-hosting-decision-requirements.md). The `/operator` rebuild and the PWA service worker are explicitly out of v1 scope.

## Problem Frame

The live UI is ad-hoc inline-CSS SSR with no design-token system; a full Fro Bot styleguide exists (`assets/styleguide.md`) but is unapplied. The goal is a modern responsive PWA. The Hono backend is already a textbook BFF (read-only token minting, redaction, OAuth, SSE origination) and stays server-side; only the render surface is replaced. Starting with `/` avoids the gateway-gated operator surface (blocked on `fro-bot/agent#1001`/`#1000`).

## Requirements Trace

- R1. Executable design token system from `assets/styleguide.md`, scoped to the `/` route's needs (D1).
- R2. Responsive React SPA shell with installable manifest (D2).
- R3. `/` monitoring view rebuilt responsive on real BFF data, replacing its SSR route (D3).
- R4. CI multi-stage build shipping hashed static assets; runtime stays no-build (D4).
- R5. Impeccable design-quality gate + `PRODUCT.md`/`DESIGN.md` context, calibrated to the Fro Bot brand (D5).
- R6. All SSR→SPA security boundaries explicit and preserved: server-only redaction, SW-no-data (n/a in v1, SW deferred), pinned CSP, no-`dangerouslySetInnerHTML`, same-origin BFF, root-route ownership.

## Scope Boundaries

- v1 proves the stack on `/` only. Other SSR routes keep serving until migrated.
- No new product features — this is a render-surface rebuild, not new monitoring capability.

### Deferred to Separate Tasks

- **D2b — PWA service worker + offline**: separate task after D3 proves the `/` rebuild. v1 ships installable-manifest-only.
- **`/operator` console rebuild**: separate tracer, gated on `fro-bot/agent#1001` + `#1000` shipping (live operator data).
- **Mobile-first approval/launch UX leap**: lands with the operator tracer.
- **Published `@fro-bot/ui` / `@fro-bot/operator-client` packages**: extract only when a second consumer exists.
- **Push notifications**; **`fro.bot/dashboard` hosting migration** (separate deferred decision).

## Context & Research

### Relevant Code and Patterns

- BFF (keep, backend-only, security-critical): `src/github/app-client.ts`, `src/github/metadata.ts`, `src/github/aggregator.ts`, `src/auth/oauth.ts`, `src/session.ts`, `src/secrets.ts`.
- Render surface (replaceable): `src/routes/dashboard.ts` (the `/` SSR view + inline `PAGE_STYLES`), `public/operator.css`.
- Static serving + auth gating + CSP: `src/server.ts` (`serveStatic` at `/static/*`, `secureHeaders` CSP, `isPublicPath`).
- Build/deploy: `Dockerfile` (runs `node src/server.ts`, no build), `.github/workflows/release.yaml`, `package.json` (no frontend build script; `pnpm@11.8.0`, Node ≥24).
- Design source: `assets/styleguide.md` (OKLCH tokens, dark-default, type/spacing/motion).

### Institutional Learnings

- `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md` — CSP `script-src 'self'`, `style-src 'unsafe-inline'` currently required, use Hono `secureHeaders`, allowlist enum values.
- `docs/solutions/best-practices/operator-approval-channel-consumption-2026-06-22.md` — textContent-only for agent-supplied strings.
- `docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md` — denylist-before-query, fail-closed, never leak private repo identifiers.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — render the assembled page to verify, not just units.

### External References

- Vite + `vite-plugin-pwa` (`injectManifest` strategy); Workbox deprecation hedge.
- Impeccable Style (github.com/pbakaus/impeccable, Apache-2.0): `npx impeccable detect --json .` standalone detector (no AI/browser); `/impeccable` skill; `PRODUCT.md`/`DESIGN.md`.

## Key Technical Decisions

- **Vite + React SPA, Hono frozen as BFF, same origin**: preserves server-side redaction/token-minting; UI is authed/interactivity-dominant (no SSR/SEO value). (see origin)
- **CI-built, runtime no-build**: multi-stage Docker image; builder stage runs Vite, runtime stage copies `dist/` + server code. The Node-24 strip-only backend gains no runtime build step.
- **Headless primitives (Radix/Ark) + own tokens**: distinctive aesthetic, a11y handled, minimal bundle.
- **Tokens scoped to `/`**: minimum set (color/spacing/type/radius/motion), not a standalone design-system project.
- **In-repo modular, no packages yet**: clean internal seams; extract later only with a second consumer.
- **Impeccable on two axes**: CI detector gate + agent design skill; calibrated so the Fro Bot purple/glow aesthetic reads as brand, not slop, without disabling genuine-quality detectors.

## Open Questions

### Resolved During Planning

- Hosting (subdomain vs path): stay on `dashboard.fro.bot` (see origin: hosting-decision doc).
- First route: `/` monitoring (avoids the gateway-gated operator surface).
- Component library: headless + own tokens.

### Deferred to Implementation

- Exact Radix vs Ark choice and which primitives `/` actually needs — decide when building D3.
- Precise CSP directive values after seeing Vite's emitted HTML — pin against real build output.
- Whether `style-src` can tighten from `'unsafe-inline'` once inline styles leave the SSR `/` — evaluate post-D3.
- Exact Impeccable config/ignore tuning to pass the brand aesthetic — iterate against `detect` output.

## Implementation Units

- [ ] **Unit 1: Frontend toolchain + Vite/React scaffold**

**Goal:** Add the Vite + React + TypeScript frontend workspace to the repo without touching the runtime backend.

**Requirements:** R2 (foundation), R4 (build foundation)

**Dependencies:** None

**Files:**
- Create: `web/` (Vite app root: `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/vite.config.ts`, `web/tsconfig.json`)
- Modify: `package.json` (add `build:web` script + frontend devDeps), `.gitignore` (`web/dist/`), `eslint.config.ts` (scope/ignore as needed)
- Test: `web/src/App.test.tsx`

**Approach:**
- Keep the frontend workspace isolated under `web/` so the backend's Node-24 strip-only runtime is untouched. Vite build outputs to `web/dist/`. pnpm workspace or a scoped devDep set — decide at build (avoid disrupting the existing single-package layout if a flat set works).
- React 19 + Tailwind 4 (`@tailwindcss/vite`) to match Marcus's repos.

**Patterns to follow:** `marcusrbrown/gpt` (React+HeroUI+Tailwind4+Vite layout, devDep set), `marcusrbrown/mrbro.dev` (Vite+React+Tailwind4+CSP).

**Test scenarios:**
- Happy path: the scaffold app renders a root element; `pnpm build:web` produces `web/dist/` with hashed assets.
- Edge case: build emits no inline `<script>` in `web/dist/index.html` (CSP precondition) — assert against emitted HTML.

**Verification:** `pnpm build:web` succeeds; `check-types`/`lint` clean across backend + web; backend still runs `node src/server.ts` unchanged.

- [ ] **Unit 2: Executable design tokens from the styleguide (`/`-scoped)**

**Goal:** Convert the styleguide's minimum token set into a Tailwind 4 theme + CSS variables, dark-default + light.

**Requirements:** R1

**Dependencies:** Unit 1

**Files:**
- Create: `web/src/styles/tokens.css` (CSS vars: bg/surface/text/accent/cta/status, both themes), `web/src/styles/theme.ts` or Tailwind theme extension
- Test: `web/src/styles/tokens.test.ts`

**Approach:**
- Port the semantic tokens and dark-default/light theming from `assets/styleguide.md` verbatim. Tokens are the single source of truth — no ad-hoc hex in components. Scope to color/spacing/type/radius/motion the `/` view needs; defer deeper component tokens.

**Patterns to follow:** `assets/styleguide.md` sections 5-7 (semantic tokens, CSS token file).

**Test scenarios:**
- Happy path: token module exposes the documented semantic tokens; dark and light themes resolve distinct values.
- Edge case: a WCAG pairing from the styleguide (e.g. text on surface) meets its documented ratio.

**Verification:** a sample component styled purely from tokens renders in both themes; no inline hex; WCAG pairings hold.

- [ ] **Unit 3: Responsive SPA shell + manifest**

**Goal:** Responsive app shell (nav frame, layout) with an installable web manifest. No service worker.

**Requirements:** R2

**Dependencies:** Unit 1, Unit 2

**Files:**
- Create: `web/src/shell/AppShell.tsx`, `web/public/manifest.webmanifest`, icon assets (reuse `assets/fro-bot.png` derivatives)
- Modify: `web/index.html` (manifest link, theme-color)
- Test: `web/src/shell/AppShell.test.tsx`

**Approach:**
- Responsive shell built on tokens + headless primitives. Manifest only (installable); SW deferred to D2b. Mobile/tablet/desktop layout via token breakpoints.

**Patterns to follow:** styleguide breakpoints (§4.3); headless primitives (Radix/Ark) for any interactive chrome.

**Test scenarios:**
- Happy path: shell renders nav + content slot; manifest is linked and valid.
- Edge case: layout adapts across the styleguide breakpoints (assert responsive classes/structure).

**Verification:** shell renders responsively; an install prompt is offerable (manifest valid); no SW registered.

- [ ] **Unit 4: CI multi-stage build + deploy integration**

**Goal:** Build the SPA in CI, ship hashed assets in the image, keep the runtime no-build; serve the SPA under Caddy/Hono with CSP + cookie auth intact.

**Requirements:** R4, R6 (CSP, root-route ownership, same-origin)

**Dependencies:** Unit 1 (buildable app)

**Files:**
- Modify: `Dockerfile` (builder stage runs `pnpm build:web`; runtime stage copies `web/dist/` + `src/` + server), `.github/workflows/release.yaml` (build web, smoke-test built bundle present/served), `src/server.ts` (serve `web/dist/` for `/`, CSP directives pinned for the bundle), Caddy/infra note (root-route fallback — coordinate with infra)
- Test: `test/server.test.ts` (serves built SPA at `/`, CSP headers, auth still gates), `web` build smoke in CI

**Approach:**
- Multi-stage image: builder (dev deps + Vite) → runtime (copies `web/dist/` + backend, no build, no dev deps). `src/server.ts` serves the built SPA for `/` and keeps `/api/*`, `/auth/*`, and not-yet-migrated SSR routes. Pin CSP (`script-src 'self'`, no inline script — verify emitted HTML; add `worker-src`/`manifest-src`/`connect-src`/`img-src`/`font-src`/`base-uri`/`object-src`; no `unsafe-eval` in prod). Root-route ownership: Caddy/Hono serve `index.html` for SPA routes; client router treats unknown paths as SPA-only.

**Execution note:** verify CSP against the actual Vite-emitted HTML, not assumptions.

**Patterns to follow:** existing `release.yaml` build + smoke structure; `src/server.ts` `secureHeaders` + `serveStatic` + `isPublicPath`.

**Test scenarios:**
- Happy path: `/` serves the built SPA behind auth; built bundle present in image; release smoke green.
- Edge case: CSP response headers contain the pinned directives; no inline-script in served HTML.
- Error path: unauthenticated `/` still redirects to auth (gating unchanged); the `session` cookie flow works.
- Integration: backend runtime has no build step / no dev deps; SSR routes other than `/` still serve.

**Verification:** `dashboard.fro.bot/` serves the SPA behind unchanged auth; CSP holds; release pipeline green; runtime image is build-free.

- [ ] **Unit 5: Rebuild the `/` monitoring view (server-only redaction at the seam)**

**Goal:** Rebuild the read-only monitoring dashboard as a responsive React view on real BFF aggregation data, replacing its SSR route.

**Requirements:** R3, R6 (server-only redaction, textContent/no-innerHTML, `Cache-Control: no-store`)

**Dependencies:** Unit 2, Unit 3, Unit 4

**Files:**
- Create: `web/src/views/Monitoring.tsx` + sub-components (repo/status cards), `web/src/api/aggregation.ts` (typed fetch of the BFF aggregation endpoint)
- Modify: `src/server.ts` / a BFF route to expose the aggregation snapshot as JSON for the SPA (already-redacted, `Cache-Control: no-store`); retire the SSR `/` render path (`src/routes/dashboard.ts`) for this route
- Test: `web/src/views/Monitoring.test.tsx`, `test/` BFF-endpoint redaction test

**Approach:**
- The BFF returns an already-redacted aggregation snapshot — the SPA must never receive denylisted/private repo identifiers or pre-redaction records. Render with tokens + headless primitives; agent/dynamic strings via `textContent`/React text (no `dangerouslySetInnerHTML`). Responsive across breakpoints. Remove fixture/mock leftovers; verify the assembled page renders real data.

**Execution note:** render the assembled page and confirm real data + no leaks (the unit-green-is-not-feature-done gate), not just unit tests.

**Patterns to follow:** `src/github/aggregator.ts` output shape; the existing redaction guarantees in `metadata.ts`; styleguide card/badge patterns (§8).

**Test scenarios:**
- Happy path: the view renders real aggregation data responsively (desktop/tablet/phone).
- Edge case: empty/stale snapshot renders a labeled state, not a dead screen.
- Error path: BFF aggregation failure renders fail-closed (no unfiltered union, no leak).
- Integration: the BFF aggregation endpoint never emits a denylisted repo's identifiers; response carries `Cache-Control: no-store`.

**Verification:** `/` shows real monitoring data in the Fro Bot design language, responsive, with redaction holding at the API seam and no fixture leftovers.

- [ ] **Unit 6: Impeccable quality gate + design context**

**Goal:** Install Impeccable, write Fro Bot design context, and wire the deterministic detector into CI calibrated to the brand.

**Requirements:** R5

**Dependencies:** Unit 5 (a real UI to detect against)

**Files:**
- Create: `PRODUCT.md`, `DESIGN.md` (Fro Bot brand/product lane, audience, voice, grounded in `assets/styleguide.md`), Impeccable config (ignore/inline-ignore tuning)
- Modify: `.github/workflows/main.yaml` (add `npx impeccable detect --json .` gate), `.opencode/` (skill install if adopting the agent loop)
- Test expectation: none — CI gate + docs; behavior covered by the gate itself.

**Approach:**
- `npx impeccable install`; `/impeccable init` → `PRODUCT.md` (brand lane) + `DESIGN.md`. Wire `detect --json .` as a CI gate. Calibrate so intentional Fro Bot brand elements (deep-purple-dark-default, cyan/magenta glow) are not flagged as slop, while genuine-quality detectors (touch targets, line length, heading order, cramped padding) stay active.

**Execution note:** iterate the config against real `detect` output until the brand passes and quality detectors remain on.

**Patterns to follow:** existing CI job structure in `.github/workflows/main.yaml`; SHA-pinned action convention if a marketplace action is used (else `npx`).

**Test scenarios:**
- Happy path: `impeccable detect` runs in CI and passes on the `/` rebuild.
- Edge case: a deliberately-bad UI change (tiny touch target / skipped heading) is caught by the gate.

**Verification:** CI runs the detector; the brand aesthetic passes; genuine-quality regressions are caught; `PRODUCT.md`/`DESIGN.md` reflect Fro Bot.

## System-Wide Impact

- **Interaction graph:** new `web/` build feeds the runtime image; `src/server.ts` static serving + CSP + auth gating now front the SPA at `/`; the BFF gains a JSON aggregation endpoint consumed by the SPA.
- **Error propagation:** BFF aggregation failures must stay fail-closed through the new JSON endpoint (no unfiltered union to the SPA).
- **State lifecycle risks:** none new in v1 (no SW/offline cache; that risk arrives with deferred D2b).
- **API surface parity:** the new aggregation JSON endpoint must enforce the same redaction the SSR path did.
- **Unchanged invariants:** read-only-by-construction, no-dashboard-proxy for `/operator/*`, two-credential-domain split, OAuth/`session` cookie flow, Node-24 strip-only backend runtime — all unchanged by this plan.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| CSP regression from bundler-emitted inline scripts | Verify emitted HTML; pin `script-src 'self'`, no `unsafe-eval` in prod; test CSP headers |
| BFF JSON endpoint leaks pre-redaction data the SSR path filtered | Redact server-side; test the endpoint never emits denylisted identifiers; `no-store` |
| Multi-stage image accidentally adds a backend runtime build | Runtime stage copies only `web/dist/` + `src/`; backend stays strip-only; smoke-test |
| Impeccable flags the Fro Bot brand (purple/glow) as slop | Calibrate via `PRODUCT.md` brand lane + config; keep quality detectors active |
| Hybrid SPA `/` + SSR routes create messy interim | Explicit root-route ownership + documented cutover rule |
| Infra/Caddy coordination for root-route fallback | Coordinate the Caddy fallback with infra before cutover |

## Documentation / Operational Notes

- Infra coordination: Caddy root-route fallback for SPA client routes; confirm before cutover.
- `PRODUCT.md`/`DESIGN.md` become living design context for future UI work and the agent design loop.

## Sources & References

- **Origin document:** docs/brainstorms/2026-06-24-003-dashboard-pwa-rebuild-v1-requirements.md
- Hosting decision: docs/brainstorms/2026-06-24-002-dashboard-frontend-hosting-decision-requirements.md
- Ideation: docs/ideation/2026-06-24-dashboard-pwa-rebuild-ideation.md
- Impeccable Style: github.com/pbakaus/impeccable
- Blocking operator deps (deferred surface): fro-bot/agent#1001, fro-bot/agent#1000
