---
date: 2026-06-24
topic: dashboard-pwa-rebuild
focus: transform the static Hono SSR dashboard into a responsive modern PWA in Fro Bot's design language
mode: repo-grounded
---

# Ideation: Dashboard → modern responsive PWA

## Grounding Context (Codebase + Research)

**Current state:** `fro-bot/dashboard` is a Hono + JSX SSR app, Node 24 strip-only, **no build step**, plain-ESM static client JS. Two pages: `/` (monitoring dashboard) and `/operator` (operator console, currently a half-migrated mock). Ad-hoc inline CSS, no design-token system applied. The operator client logic (`public/operator-stream.js`, `operator-launch.js`) is mostly framework-portable pure logic with thin DOM shells.

**Design system:** `assets/styleguide.md` holds a complete Afrofuturism×cyberpunk system — OKLCH-ish color tokens, dark-default + light themes, type scale, spacing, motion, component patterns (buttons/badges/cards/glow), Phosphor/Lucide icons — but **none of it is applied to the live UI**.

**Framework research (decisive):** Vite + React SPA + `vite-plugin-pwa`, **keeping the Hono backend as a BFF** (security-critical redaction/token-minting/OAuth stays server-side — it is already a textbook BFF). Real-time = fetch-based SSE (the established pattern). Next.js is over-built (2nd server, Turbopack/PWA friction); Astro is the wrong tool (the dashboard is one big island); htmx has the best SSE story but the worst PWA story.

**Cross-repo signal (Marcus-native):** React-first, pnpm-first, Tailwind-4-everywhere. Vite for standalone apps (`gpt`, `mrbro.dev`), Next for product/auth/web3 (`tokentoilet`), Astro/Starlight for docs (`systematic`). HeroUI is a real preference in `gpt`. No PWA precedent in any repo — new ground.

**Hard constraints (docs/solutions/):** textContent-only for agent strings; no-oracle on mutating paths; fail-closed everywhere; read-only-by-construction (dashboard must NOT proxy `/operator/*`); CSP `script-src 'self'`; `style-src 'unsafe-inline'` currently required; the "no build step" rule; dashboard session cookie ≠ gateway operator `__Host-session` (two credential domains, mode-aware router); cross-format denylist-before-query; contract-version lockstep.

## Ranked Ideas

### 1. Executable design tokens — convert assets/styleguide.md into code
**Description:** Convert the styleguide's OKLCH palette, spacing, type, motion, and component rules into versioned Tailwind 4 theme + CSS-var tokens consumed by components, docs, and tests.
**Warrant:** `direct:` a full token system exists in assets/styleguide.md but is unused; live CSS is ad-hoc inline. `reasoned:` Marcus is Tailwind-4-first across every repo.
**Rationale:** Foundation every other visual idea inherits; kills ad-hoc drift; makes "feels like Fro Bot" automatic.
**Downsides:** Foundational-but-invisible alone.
**Confidence:** 95% · **Complexity:** Low-Med · **Status:** Unexplored

### 2. Vite+React PWA frontend, Hono frozen as BFF (core rebuild)
**Description:** Rebuild the render surface as a Vite+React installable PWA; keep Hono as the BFF for OAuth, read-only token minting, redaction, SSE origination.
**Warrant:** `external:` framework research recommends this over Next/Astro/htmx. `direct:` clean BFF split already exists (src/github/*, src/auth/*, src/session.ts backend-only; routes + public/* replaceable).
**Rationale:** Installable, responsive, real-time cockpit while preserving every security invariant server-side.
**Downsides:** Deliberately breaks the documented "no build step" constraint (see #3).
**Confidence:** 90% · **Complexity:** High · **Status:** Unexplored

### 3. CI-built PWA, runtime-stupid server (resolves the no-build tension)
**Description:** Build the SPA in CI, ship hashed static assets; the droplet still just runs Hono serving files + BFF APIs (no runtime build).
**Warrant:** `reasoned:` the "no build step" rule is really "no runtime build step"; CI build preserves the runtime simplicity.
**Rationale:** Unlocks modern tooling without runtime build complexity — reframes the hard constraint rather than ignoring it.
**Downsides:** Dockerfile/release-workflow changes; new build stage.
**Confidence:** 88% · **Complexity:** Med · **Status:** Unexplored

### 4. The hosting decision — dashboard.fro.bot vs fro.bot/dashboard (decide explicitly)
**Description:** Decide subdomain vs path-hosting vs split-static (static shell on fro.bot/CDN, credentialed BFF on secure origin). Marcus's original leaning is fro.bot/dashboard.
**Warrant:** `direct:` the gateway operator session uses a `__Host-`prefixed cookie bound to the current origin; dashboard session ≠ gateway operator session (docs #8/#9); path-hosting changes OAuth callbacks, cookie scoping, Caddy routing.
**Rationale:** Real fork with security consequences, not cosmetics; must be decided before the rebuild.
**Downsides:** `__Host-` cookie + gateway-origin coupling may favor the subdomain; needs gateway/infra in the loop.
**Confidence:** 85% · **Complexity:** Med (decision) / High (path-hosting) · **Status:** Explored (selected for first brainstorm)

### 5. Mobile-first approval + launch UX (operator UX leap)
**Description:** Thumb-safe approval triage deck (once/always/reject), guided launch composer, live run timeline; PWA install + in-app pending-approval notifications.
**Warrant:** `direct:` the decide-flow and launch logic already exist as portable logic; today they're tiny console buttons unusable on a phone.
**Rationale:** The felt win — turns the mock into an actual cockpit operators can use from anywhere.
**Downsides:** Must preserve textContent-only/no-oracle/fail-closed verbatim.
**Confidence:** 88% · **Complexity:** Med-High · **Status:** Unexplored

### 6. Extract @fro-bot/operator-client SDK + realtime hooks (compounding)
**Description:** Extract the SSE parsers, approval state machine, launch flow, and contract types into a typed package; wrap as useSseStream/useApprovals/useLaunchFlow hooks.
**Warrant:** `direct:` the logic is already mostly framework-portable pure logic with vendored contract types.
**Rationale:** Durable capability — future CLI/mobile/web operator surfaces share one tested control-plane SDK.
**Downsides:** Package/versioning overhead; only pays off with a 2nd consumer.
**Confidence:** 80% · **Complexity:** Med · **Status:** Unexplored

### 7. Shared @fro-bot/ui + design-system package across fro.bot properties (highest-upside challenger)
**Description:** Tokens + components package (Storybook + visual-regression as tooling) reused across fro.bot, dashboard, docs, future tools. Strongest if hosting goes fro.bot/dashboard (monorepo).
**Warrant:** `reasoned:` Marcus runs many web surfaces with divergent stacks; a shared package makes the rebuild the seed crystal for one Fro Bot interface layer.
**Rationale:** Converts a one-time UI rebuild into cross-property compounding identity infrastructure.
**Downsides:** Bigger scope; YAGNI risk before a 2nd consumer exists.
**Confidence:** 70% · **Complexity:** High · **Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Repo Footprint Constellation viz | Too expensive relative to value; signature polish, not load-bearing — defer to brainstorm variant |
| 2 | Command Palette | Below ambition floor; SPA affordance, not a direction |
| 3 | Operator Health Strip | Below floor; a component, not a direction |
| 4 | Offline Last-Known Snapshot / Installable Incident Console | Folded into the PWA-shell survivor (#2) |
| 5 | Fixture-to-Live Drift Detector | Folded into preservation/unit-green discipline |
| 6 | Self-Explaining Security Boundary UI | Secondary feature within the shell, not a top direction |
| 7 | Caddy as product-edge control plane | Folded into the hosting-decision survivor (#4) |
| 8 | Service-worker SSO UX | Reasoned-thin; folded into hosting (#4) |
| 9 | Agent-Consumable UI Contracts | Speculative; brainstorm variant once a design system exists |
| 10 | Storybook / Visual Regression | Folded into the design-system survivor (#7) as tooling |
| 11 | Realtime React Hooks (standalone) | Folded into the operator-client SDK (#6) |
| 12 | Status Timeline vs Grid | Merged with Live Run Timeline (#5) |
| 13 | Explicit credential-domain router | Already an existing invariant (docs #9), not new |
