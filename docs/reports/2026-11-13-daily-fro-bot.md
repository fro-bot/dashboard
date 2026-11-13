## Daily Fro Bot Report — 2026-11-13 (UTC)

### Run Summary

| Category | Status | Notes |
| --- | --- | --- |
| Errored PRs | ✅ | All three open PRs have successful checks; no repairs needed. |
| Security | ⚠️ | One high package advisory has existing remediation #807; 46 high image findings have no fixed version reported. |
| Code Quality | ✅ | Bootstrap, types, lint, 7,816 tests, and 66 Node strip-only imports pass. |
| Workflow Integrity | ⚠️ | All 35 external action references SHA-pinned; seven major-only version annotations and existing hardening gaps remain. |
| Progressive Improvement | ⚠️ | Existing convention/test drift; routine dependency updates remain Renovate-owned. |
| Cross-Project Intelligence | ✅ | Four sibling repositories inspected; shared configs align and agent v0.140.3 pin is current. |

### Errored PRs

- [#816](https://github.com/fro-bot/dashboard/pull/816), [#807](https://github.com/fro-bot/dashboard/pull/807), and [#768](https://github.com/fro-bot/dashboard/pull/768) have successful checks and are mergeable. #807 is behind main, not conflicted. No failed check required diagnosis or a branch repair. No project commands were executed from any existing PR branch.
- Open PRs and issues were searched before delivery. The Zod root cause reuses #807; existing hardening issues are linked below. #816 contains yesterday's audit evidence, not today's independently dated pass; this run makes no duplicate remediation PR.

### Security

- Supplemental `bun audit --json` exits 1 with 17 advisories: one high, 11 moderate, five low, zero critical. The high [Zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) is already addressed by green, mergeable [#807](https://github.com/fro-bot/dashboard/pull/807). No unrelated upgrade or duplicate security PR was made.
- Moderate direct-dependency advisories remain for the locked Hono 4.13.13 and `@hono/node-server` 2.1.5, including middleware/path handling, CSRF, form validation, and WebSocket upgrade handling. Patched versions are available (Hono 4.13.17 and node-server 2.1.6). These are below this run's high/critical autoheal threshold; routine dependency ownership remains with [Renovate #8](https://github.com/fro-bot/dashboard/issues/8). Passing tests do not constitute proof of non-exploitability.
- [Dependabot](https://github.com/fro-bot/dashboard/security/dependabot), [secret scanning](https://github.com/fro-bot/dashboard/security/secret-scanning), and repository security-advisory endpoints were accessible and returned no open findings. This does not supersede the package audit. No confirmed high/critical direct-package or Actions advisory requiring a new dedicated PR was identified in the available sources.
- [Code scanning](https://github.com/fro-bot/dashboard/security/code-scanning) returns 52 open alerts: 46 high Trivy image-package findings and six Scorecard findings. All 46 Trivy records have empty fixed-version fields; no critical finding was returned. The image findings' latest instances reference commit `8c22aba98f9d6c5486abef3bf084d1e3fbffb891`, not this run's HEAD; current-image remediation still needs verification.
- Bounded inspection of `src/server.ts`, `src/logger.ts`, `src/secrets.ts`, `src/routes/wiki.ts`, `src/wiki/authorize.ts`, `src/github/installations.ts`, and `src/github/fro-bot-app-client.ts` found no additional confirmed credential leak or protected-route authentication bypass. Global errors are sanitized with generic HTTP responses. Session middleware precedes protected routes; wiki mutations add operator identity, exact-origin, content-type and body-size checks. Read-token scopes remain explicit and read-only; write-token minting separately names `.github` and only `contents: write`. This is a bounded review, not a comprehensive security audit or deployment verification.

### Code Quality

- Baseline: [`e4c79add1548541cba72f41be63365ac2c21bd0f`](https://github.com/fro-bot/dashboard/commit/e4c79add1548541cba72f41be63365ac2c21bd0f), Node v24.22.2, Bun 1.4.4. Evidence: [scheduled run 43376716309](https://github.com/fro-bot/dashboard/actions/runs/43376716309).
- In order, `bun run bootstrap`, `bun run check-types`, `bun run lint`, and `bun run test` all pass. Bootstrap leaves tracked files, including the lockfile, unchanged. Tests: 55 server files / 4,698 tests and 75 web files / 3,118 tests.
- Recursive imports of all 66 non-test `src/**/*.ts` modules pass under Node 24 strip-only. Each import also had a 20-second hang limit; none timed out. No enum, namespace, parameter-property, or TypeScript import-alias runtime drift was found.
- No failing gate justified an autoheal. Delivery adds this audit record only; runtime, dependencies, workflows, automation prompts, settings, and guardrails are untouched. No behavioral test additions are needed for a Markdown-only record. Inline self-review checks source counts, links, scope, and deferred-work constraints against the existing report pattern.

### Workflow Integrity

- All 35 third-party references in `.github/workflows/*.yaml` and `.github/actions/**/action.yaml` use full 40-hex commit SHAs with version comments. No floating action tag was found.
- Seven comments lack full `vX.Y.Z` annotations: `github/codeql-action` has `# v4` in `.github/workflows/codeql.yaml:32,38`, `.github/workflows/release.yaml:343`, and `.github/workflows/scorecard.yaml:42`; `actions/setup-node` has `# v7` in `.github/workflows/release.yaml:51,153` and `.github/actions/setup/action.yaml:17`. Execution is still SHA-pinned. No failing workflow run establishes grounds to edit these files under today's narrower write policy.
- Default permissions are `contents: read` or `{}`; release/scanning writes are job-specific. No new over-broad permission declaration was identified. Actual model-job PAT scope was not inspected; the known credential-isolation residual is tracked by [#809](https://github.com/fro-bot/dashboard/issues/809).
- Dependency-consuming CI jobs use `./.github/actions/setup`. Release host scripts use Node built-ins and container dependency installs happen in Docker; these are not duplicated host dependency setup. CodeQL has `build-mode: none`; Test Scripts Load is present.
- Existing concerns are reused, not refiled: [release shell interpolation #784](https://github.com/fro-bot/dashboard/issues/784), [comment-trigger delivery #789](https://github.com/fro-bot/dashboard/issues/789), [listener release smoke #800](https://github.com/fro-bot/dashboard/issues/800), and [credential/concurrency gaps #809](https://github.com/fro-bot/dashboard/issues/809).

### Progressive Improvement

- `bun outdated` reports TypeScript 6.0.3 → 7.0.2 and jsdom 30.1.3 → 31.0.0 (major updates). Hono and node-server have patch drift, not more-than-minor drift. ESLint/Vitest have no newer version listed; no standalone Prettier dependency exists. Node 24 types deliberately follow the runtime. No dependency version was changed.
- `.github/copilot-instructions.md:3-7` still describes JSX SSR/no build, unlike the built React PWA in `AGENTS.md:3-8` and README. Report-only convention drift; automation instructions remain untouched.
- Existing scanner/test gaps: [#785](https://github.com/fro-bot/dashboard/issues/785), [#786](https://github.com/fro-bot/dashboard/issues/786), [#787](https://github.com/fro-bot/dashboard/issues/787), [#788](https://github.com/fro-bot/dashboard/issues/788), [#815](https://github.com/fro-bot/dashboard/issues/815), and [#809](https://github.com/fro-bot/dashboard/issues/809). Existing learning/document drift: [#790](https://github.com/fro-bot/dashboard/issues/790), [#791](https://github.com/fro-bot/dashboard/issues/791), and [#814](https://github.com/fro-bot/dashboard/issues/814). No TODO/FIXME annotations found in `src/`, `web/src/`, or `scripts/`.

### Cross-Project Intelligence

- [fro-bot/.github](https://github.com/fro-bot/.github/blob/1557f67642473e90867a19324b166c7ea0a9a67a/package.json), [fro-bot/agent](https://github.com/fro-bot/agent/blob/e8b5fbd4da5648f619f5bbd59379ea3d5430408a/package.json), [marcusrbrown/infra](https://github.com/marcusrbrown/infra/blob/78669352af635f22a3637e1cfd83aa4782a4e71e/package.json), and [bfra-me/.github](https://github.com/bfra-me/.github/blob/737d27ff96c848836cd46f38c7c6ac81cf488d53/package.json) all use `@bfra.me/eslint-config` 0.54.0 and `@bfra.me/tsconfig` 0.13.2, matching dashboard. All four use `@bfra.me/prettier-config` 0.16.13; dashboard has no standalone Prettier package, so adoption is a separate decision.
- Dashboard pins `fro-bot/agent` v0.140.3 at `07d68366b7d95d9e7311dfeece99ccbbbd2738d7`, matching the [latest release](https://github.com/fro-bot/agent/releases/tag/v0.140.3). No update needed.
- [Sibling advisory gate](https://github.com/fro-bot/.github/blob/1557f67642473e90867a19324b166c7ea0a9a67a/packages/ci-checks/src/check-override-floors.ts) checks the locked tree, fails closed on malformed audit data, and interprets severity rather than treating every nonzero audit exit identically. Useful prior art for existing [#809](https://github.com/fro-bot/dashboard/issues/809).
- [Agent CSRF endpoint](https://github.com/fro-bot/agent/blob/e8b5fbd4da5648f619f5bbd59379ea3d5430408a/packages/gateway/src/web/auth/csrf-route.ts) uses privileged registration, uncached session-bound tokens, and fail-closed missing auth context. Its [allowlist](https://github.com/fro-bot/agent/blob/e8b5fbd4da5648f619f5bbd59379ea3d5430408a/packages/gateway/src/web/auth/allowlist.ts) uses stable numeric IDs. Preserve separate gateway and dashboard credential domains.
- [Infra deploy inputs](https://github.com/marcusrbrown/infra/blob/78669352af635f22a3637e1cfd83aa4782a4e71e/.github/workflows/deploy-dashboard.yaml) validate version/digest through quoted environment variables before deployment approval. [bfra CI](https://github.com/bfra-me/.github/blob/737d27ff96c848836cd46f38c7c6ac81cf488d53/.github/workflows/main.yaml) illustrates explicit permissions and complete version comments for pinned setup actions. All sibling observations were read-only.

### Needs Human Attention

- Review existing [#807](https://github.com/fro-bot/dashboard/pull/807): isolated Zod remediation in `package.json` / `bun.lock` is green, mergeable, and behind main. Do not recreate it or mix unrelated updates into it. After merge, run `bun audit --json` and verify GHSA-mrhx-c7xc-m3w5 is absent; lower-severity findings may still produce exit 1. No merge or approval performed.
- [46 image findings](https://github.com/fro-bot/dashboard/security/code-scanning?query=is%3Aopen+tool%3ATrivy): `Dockerfile` pins the Node 24 trixie-slim image. Alert data lists no patched version and is not an attestation of current HEAD. Recheck patched upstream image availability before a dedicated security digest PR; verify with the existing image scan and smoke gates. Do not switch distributions, suppress findings, or weaken release thresholds just to turn alerts green.
- Direct-package moderate advisories: leave Hono and `@hono/node-server` routine bumps to [Renovate](https://github.com/fro-bot/dashboard/issues/8). Verify resolved patched versions in `bun.lock` and rerun audit, types, lint, tests, and strip-only imports. The path/middleware advisories deserve explicit regression review in `src/server.ts` and auth tests; do not infer safety from a clean ordinary test suite.
- Seven major-only action comments: verify the exact release tag for each existing SHA before changing comments at the paths listed under Workflow Integrity. Do not infer patch versions or change SHAs; workflow edits remain deferred because no failing run established a genuine workflow bug.
- [#785](https://github.com/fro-bot/dashboard/issues/785), [#787](https://github.com/fro-bot/dashboard/issues/787), [#789](https://github.com/fro-bot/dashboard/issues/789), [#800](https://github.com/fro-bot/dashboard/issues/800), [#809](https://github.com/fro-bot/dashboard/issues/809), and [#815](https://github.com/fro-bot/dashboard/issues/815) contain the exact paths, smallest-fix guidance, constraints, and verification for existing work. Reuse those notes; green gates do not establish the missing guards. No follow-up is assigned to a named agent.
- [Dispatch credential isolation #112](https://github.com/fro-bot/dashboard/issues/112) and [Scorecard policy findings](https://github.com/fro-bot/dashboard/security/code-scanning?query=is%3Aopen+tool%3AScorecard) need owner decisions. Secrets, settings, environments, branch protection, and caches were untouched.

<!-- fro-bot -->
<!-- fro-bot-run-summary: run=43376716309 date=2026-11-13 trigger=schedule -->
