---
title: Install impeccable into .agents/skills/ once — not per-harness, and the agent skill is not the CI detector
date: 2026-06-25
module: dashboard
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - Adding the impeccable skill (or any agent skill) to be shared by both OpenCode and GitHub Copilot
  - Running `npx impeccable skills install` (or any installer that auto-detects provider dirs)
  - Wiring a design gate and deciding whether the CI detector alone is enough
tags: [impeccable, agent-skills, agents-dir, shared-skills, provider-auto-detect, opencode, copilot, eslint-ignore]
---

# Install impeccable into .agents/skills/ once — not per-harness, and the agent skill is not the CI detector

## Context

The PWA rebuild wired Impeccable's **CI detector** (`design-check` in `.github/workflows/main.yaml` → `npx --yes impeccable detect --json web/src`) and the design-context docs (`PRODUCT.md`, `DESIGN.md`, `.impeccable/config.json`), but never installed the agent **design skill** itself. So design work never consulted Impeccable while it was being built — the detector only fires in CI, after the fact, and catches only the structural half (gradients, gratuitous glow, identical card grids). The agent skill catches what a regex over files can't: missing hover/focus states, ARIA gaps, interaction affordances. A designer pass on the PWA UI surfaced exactly those — which the detector had passed. Installing the skill correctly shipped as PR #106.

## Guidance

### 1. `.agents/skills/<name>/SKILL.md` is the shared location — install once

Both OpenCode (skill discovery reads `EXTERNAL_DIRS=[".claude", ".agents"]`) and GitHub Copilot (`gh skill install` + GitHub docs) read from `.agents/skills/`. A single install there serves both. Do not duplicate into `.opencode/skills/` and `.github/skills/`.

### 2. The right command — pass `--providers=agents` explicitly

```bash
npx impeccable skills install --providers=agents --scope=project
```

Without `--providers=agents`, the installer **auto-detects existing harness dirs** (`.opencode/`, `.github/`) and writes a per-harness copy — ~97 duplicated files across `.opencode/skills/impeccable/` and `.github/skills/impeccable/`, plus hooks into `.github/hooks/impeccable.json` and `.codex/hooks.json`. That's the pitfall that wasted the first attempt. `--scope=project` keeps it in the repo (not user-global).

- **Do NOT use `impeccable skills link`** — it needs a built submodule checkout that doesn't exist here.
- **Do NOT hand-copy** a `.opencode/skills/impeccable/` install to `.agents/`. The skill's script paths are rendered per-provider at install time; a copy leaves `.opencode/skills/impeccable/scripts/...` strings baked into every SKILL.md/reference path. Re-install with `--providers=agents` so paths render as `.agents/skills/impeccable/scripts/...`.

### 3. Impeccable is two complementary halves — wire both

- **CI detector** (`npx impeccable detect`): static, deterministic, catches structural slop. Already wired in `design-check`.
- **Agent design skill** (the `/impeccable` workflow — `polish`/`audit`/`critique`/etc., reads `PRODUCT.md`/`DESIGN.md` via `scripts/context.mjs`, plus post-edit hooks): the half that makes design work actually consult the brand's guidance *before* code lands. **This was the missing half.**

### 4. eslint ignore is mandatory

Add `.agents/**` to the `ignores` array in `eslint.config.ts` (alongside `docs/**`, `web/**`). The skill bundles ~99 `.mjs`/`.md` files; without the ignore, lint reports tens of thousands of errors.

### 5. Keep — don't regenerate

`PRODUCT.md` + `DESIGN.md` (codebase-grounded, from `/impeccable init` — re-running `init` overwrites them with guesses), `.impeccable/config.json` (the detector allowlist, including the brand's `bounce-easing`/`--ease-spring` exception that the detector would otherwise fail CI on), and the `design-check` CI job. Only the install **location** was wrong.

## Why This Matters

Wiring only the detector gives the worst of both worlds: CI failing on legitimate brand motion *and* shipped UI nobody critiqued, because nothing consulted the brand guidance while the code was written. And the per-harness auto-detect default fails silently — it exits 0, so the split install looks fine until the next skill update drifts the two copies apart (and lint chokes on the duplicated bundle). The `--providers=agents` flag is the entire fix.

## When to Apply

- Installing impeccable (or any shared agent skill) on a repo with both `.opencode/` and `.github/` present — pass `--providers=agents` every time.
- Auditing an existing install: if `.opencode/skills/impeccable/`, `.github/skills/impeccable/`, `.github/hooks/impeccable.json`, or `.codex/hooks.json` exist, the installer ran without the flag and the install is split — clean those up and re-install.
- Auditing whether a "design gate" is detector-only vs detector + skill. The detector is a tripwire; the skill is the guidance.

## Verification

```bash
# No per-harness copies (no output = clean):
ls -d .opencode/skills/impeccable .github/skills/impeccable 2>/dev/null
# Installed SKILL.md paths render for the agents provider (expect 0):
grep -c '\.opencode/skills/impeccable' .agents/skills/impeccable/SKILL.md
# Then: pnpm lint clean, design-check job green.
```

## Related

- `docs/solutions/workflow-issues/release-paths-filter-must-cover-runtime-image-contents-2026-06-25.md` — same "half-configured / config in the wrong place" family, at the release layer.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — the "a gate exists but the real outcome isn't covered" sibling.
- PRs: #106 (the shared install), #107 (the PWA, where the missing skill surfaced).
