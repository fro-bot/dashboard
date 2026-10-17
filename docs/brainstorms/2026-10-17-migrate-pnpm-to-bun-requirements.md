---
date: 2026-10-17
topic: migrate-pnpm-to-bun
---

# Migrate the package manager from pnpm to Bun

## Summary

Bun replaces pnpm as the package manager and script runner in local development, CI, the Docker build stages and Renovate. Node 24 remains the runtime for the server, the tests and the build tools. The shipped image remains `node:24-trixie-slim` and contains no package manager.

---

## Problem Frame

The dashboard is the only active Fro Bot repository still on pnpm. fro-bot/agent, marcusrbrown/infra and marcusrbrown/systematic install and run scripts with Bun. fro-bot/agent has the same shape this repo needs: Bun installs dependencies and runs scripts, and Node runs what ships. Running a second package manager costs every agent and contributor who moves between these repos. They meet a different install command, lockfile format, workspace file, supply-chain settings, CI setup action and Renovate post-upgrade task.

pnpm appears in these places:

- the root manifest's package-manager pin;
- the workspace file, which holds the `wiki-writer` package membership, six security overrides, an allow/deny list for dependency build scripts, a release-age gate with hand-maintained version exclusions, and a hoisted layout;
- the shared CI setup action;
- the Dockerfile build stages, through Corepack;
- the release workflow's paths filter, the release guard script and its parity test;
- Renovate's post-upgrade task;
- the contributor and agent instructions.

The Dockerfile's Corepack pnpm version has already drifted from the manifest's pin.

---

## Requirements

**Package management**

- R1. Bun is the only package manager, and `bun.lock` is the only lockfile.
  - `wiki-writer` is outside this migration. Bun has no git-subdirectory dependency selector, so `@fro-bot/wiki-write-core` (a `github:…#<sha>&path:` spec) cannot be installed.
  - `wiki-writer` is not a Bun workspace member. The root tsconfig, ESLint and Vitest gates exclude it, except `wiki-writer/test/security-boundary.test.ts`, which all three keep. The Dockerfile copies nothing from it.
  - It returns once the package is published as `@fro.bot/wiki-write-core` (fro-bot/.github#3998).
  - Overrides and trusted dependencies live in `package.json`.
  - The release-age gate and the linker setting live in `bunfig.toml`.
- R2. CI and Docker install from the lockfile frozen, and fail on manifest drift. Renovate's post-upgrade install runs unfrozen so it regenerates the lockfile after Renovate edits the manifest, and CI's frozen install then verifies the result.
- R3. Dependencies resolve fresh from the `package.json` ranges. Every existing security override still holds as a version floor in the resolved graph.
- R4. Installs keep a hoisted `node_modules` layout.
- R5. Dependency install scripts run only for the packages that need them today, `@swc/core` and `unrs-resolver`. All other install scripts stay blocked, including `msgpackr-extract`.
- R6. The release-age gate is 3 days.
  - First-party `@bfra.me` packages are exempt, listed by plain package name, because Bun's exclusions do not take globs and ignore `name@version` entries. The list changes only when the repo adds a first-party package.
  - The gate applies only when versions resolve: in Renovate's post-upgrade install and in local installs. A frozen install does not enforce it.
- R7. If an override floor can only be met by a version younger than 3 days, resolution fails rather than choosing a version below the floor. The sanctioned path is a temporary plain-name exclusion, which exempts every version of that package and is removed once the window passes.

**Scripts and runtime**

- R8. Repository scripts and documented commands run through Bun's script runner. The server, Vitest, Vite, ESLint and TypeScript still execute on Node 24.
- R9. The strip-only server invariant holds: the server starts with `node src/server.ts`, and the `erasableSyntaxOnly` lint stays the enforcement gate.

**CI, release and Docker**

- R10. The shared CI setup installs Bun alongside Node 24, using a SHA-pinned action. It caches Bun's package cache, keyed on the lockfile.
- R11. The Bun lockfile replaces `pnpm-lock.yaml` in the release workflow's paths filter, in the release guard script and in the guard's parity test. A change to any Bun config file that the image build copies also triggers a release.
- R12. The Docker build stages install and build with Bun. The Bun binary enters them only through a digest-pinned image or a checksum-verified download.
- R13. The runtime stage stays on `node:24-trixie-slim`, runs `node`, and holds no package manager.

**Pins and Renovate**

- R14. `packageManager` in `package.json` is the only hand-set Bun version.
  - CI reads that field.
  - Docker derives its version from the same field, or uses a digest-pinned image that Renovate updates in the same PR, with a check that the two match.
- R15. Renovate maintains the Bun lockfile and runs its post-upgrade install and fix through Bun.

**Instructions**

- R16. `AGENTS.md`, `README.md`, `.github/copilot-instructions.md` and the Fro Bot workflow prompt give Bun commands.

---

## Acceptance Examples

- AE1. **Covers R2.** Given a `package.json` change without a matching lockfile update, a CI install fails and leaves the lockfile unchanged.
- AE2. **Covers R5.** Given a clean checkout, after a frozen install the only dependency install scripts that have run belong to `@swc/core` and `unrs-resolver`, checked across every installed package, and both native bindings work.
- AE3. **Covers R3.** After the fresh resolve, the lockfile resolves `brace-expansion@2`, `brace-expansion@5`, `fast-uri@3`, `katex@0`, `toml@4` and `undici@7` only to versions that meet each override's existing floor.
- AE4. **Covers R6.** Given a third-party dependency published less than 3 days ago, an install refuses that version, while a listed first-party `@bfra.me` release of the same age installs.
- AE5. **Covers R7.** Given an override floor whose only satisfying version is 2 days old, resolution fails. Adding a temporary plain-name exclusion for that package lets it resolve.
- AE6. **Covers R11.** A push that changes only the Bun lockfile starts the release workflow, and the guard decides to release.
- AE7. **Covers R13.** Given the release image, the smoke check finds no `bun`, `npm`, `npx`, `pnpm`, `pnpx`, `corepack`, `yarn` or `yarnpkg` executable, and the container starts with `node src/server.ts`.

---

## Success Criteria

- In CI on Bun, check-types, lint, test, the strip-only load check and the Design Check pass. A release builds an image that passes the smoke checks and Trivy enforcement.
- One fixture-mode browser smoke pass on this PR: the app loads, the runs list and a run stream work, the service worker registers, and the console shows no errors. It is a manual, agent-driven check, not a new CI job.
- On a fresh clone, `bun install` and then `bun run test` work. The Fro Bot workflow runs its gates with Bun.
- After merge, Renovate opens a dependency PR whose regenerated lockfile installs frozen and passes CI without a manual fix.
- A planner can sequence the work without deciding scope, runtime, resolution policy, gate window, version source or install layout.

---

## Scope Boundaries

- Bun as the production runtime, including `Bun.serve` or an `oven/bun` runtime image.
- Replacing Vitest with `bun test`.
- Rewriting existing plans, brainstorms and docs/solutions pages that mention pnpm. They record past work.
- New supply-chain gates such as `bun audit`. The existing policy moves to Bun, and the release-age window changes to 3 days.
- A scripted browser gate in CI.
- Changes to marcusrbrown/infra. It deploys the published image, and the image's runtime does not change.

---

## Key Decisions

- **Package manager and scripts only:** keeps the blast radius small. Production, the tests and the Trivy-scanned base image stay on Node, so Bun never has to prove compatibility with the SSE proxy, `node:sqlite` or jsdom.
- **Fresh resolve:** simpler than reproducing pnpm's resolution. Transitive bumps land in the migration PR.
  - The CI gates and the one-time fixture browser pass guard against behavior regressions.
  - The release-age gate and the lockfile diff review are the supply-chain controls.
- **3-day release-age gate, first-party exempt by name:** matches fro-bot/agent. A name list changes only when a first-party package is added. A version list would change on every first-party release.
- **Security fixes inside the window fail loudly:** a temporary plain-name exclusion is an explicit, reviewable exception. The resolver never quietly falls back below a floor.
- **Hoisted layout:** matches today's `shamefullyHoist` and fro-bot/agent. fro-bot/agent hit TypeScript resolution and duplicate-instance problems under Bun's isolated layout.
- **`packageManager` as the version source:** setup-bun reads the field directly, so the manifest is the one place a person edits the Bun version.
- **One PR:** the lockfile, CI setup, Dockerfile and Renovate config must change together, because no intermediate state installs consistently.

---

## Dependencies / Assumptions

- The migration touches the CI setup action, the workflows, the release smoke checks, the Dockerfile, the Renovate config, the root manifest and the lockfile. Each of these needs Marcus's sign-off under the repo's ask-first rules.
- The Fro Bot review workflow runs its gates through the shared setup action and the prompt text in `.github/workflows/fro-bot.yaml`, so its review of the migration PR exercises the new setup.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Needs research] Does each per-major override key (for example `katex@0`) keep its meaning in Bun's `overrides`, or does it need a different selector for the same floor?
- [Affects R5][Needs research] Does setting Bun's trusted-dependency list replace Bun's default trusted set?
- [Affects R12, R14][Technical] How does Docker get Bun and its version from `packageManager`? Options are reading the field during the build, or a Renovate-updated, digest-pinned image with a match check.
- [Affects R15][Needs research] Does Renovate's built-in Bun lockfile update work in this repo's Renovate run? Or does it need the skip-and-regenerate workaround that marcusrbrown/systematic uses?
- [Affects R8][Technical] Which commands need `bun run`, and which already call `node` directly? Does the script runner execute any node-shebang tool bin under Bun?
- [Affects R8][Technical] Does `bun run test` run the `pretest` hook that builds `web/dist` before Vitest? Yes; the plan records it as resolved.
- [Affects R1][Technical] The vendored Impeccable skill lists `pnpm-workspace.yaml` as a monorepo marker. Its project detection works without that file: `context.mjs` prints the project context.

---

## Sources / Research

- fro-bot/agent:
  - `.github/actions/setup/action.yaml`: SHA-pinned setup-bun, a cache keyed on the lockfile, and a frozen install.
  - `bunfig.toml`: hoisted linker, and a 3-day gate whose exclusions are exact names.
  - `deploy/gateway.Dockerfile`: Bun installs and builds, Node runs the result, and production dependencies are reinstalled with `--ignore-scripts`.
  - Its Bun version has drifted between the root manifest, the setup action and the Dockerfile. R14 prevents that here.
- marcusrbrown/systematic `.github/renovate.json5`: skips Renovate's Bun artifact update and regenerates `bun.lock` in post-upgrade tasks.
- `docs/solutions/workflow-issues/release-paths-filter-must-cover-runtime-image-contents-2026-06-25.md`: a release that is silently skipped is the failure R11 guards against.
- Bun docs: [workspaces](https://bun.sh/docs/pm/workspaces), [install and bunfig settings](https://bun.sh/docs/pm/cli/install), [overrides](https://bun.sh/docs/pm/overrides), [lockfile](https://bun.sh/docs/pm/lockfile).
- [Renovate Bun manager](https://docs.renovatebot.com/modules/manager/bun/).
