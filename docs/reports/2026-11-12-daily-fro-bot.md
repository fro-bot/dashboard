## Daily Fro Bot Report — 2026-11-12 (UTC)

### Run Summary

| Category | Status | Notes |
| --- | --- | --- |
| Errored PRs | ✅ | Both open PRs have successful CI; no repair needed. |
| Security | ⚠️ | Existing green Zod remediation #807 awaits merge; 46 high image findings report no fixed version. |
| Code Quality | ✅ | All four gates pass; 7,816 tests pass; all 66 production modules load under Node 24. |
| Workflow Integrity | ⚠️ | All 35 external action references SHA-pinned; seven version comments are major-only. Existing workflow concerns remain. |
| Progressive Improvement | ⚠️ | Existing test/scanner/documentation drift; routine dependency updates remain Renovate-owned. |
| Cross-Project Intelligence | ✅ | Four sibling repositories inspected; shared configs align; agent v0.139.1 pin matches latest release. |

### Errored PRs

- [#807](https://github.com/fro-bot/dashboard/pull/807) and [#768](https://github.com/fro-bot/dashboard/pull/768) have successful checks and are mergeable. #807 is behind main, not conflicted. Both are same-repository Fro Bot-authored branches. Neither requires repair; no PR branch was checked out or executed.

### Security

- `bun audit --json` reports ten advisories: one high, five moderate, four low. The high [Zod advisory GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) is already addressed by [#807](https://github.com/fro-bot/dashboard/pull/807); no duplicate remediation or unrelated dependency bump was made. Main still resolves the affected tooling dependency until merge. Audit exits 1, not clean.
- [Dependabot](https://github.com/fro-bot/dashboard/security/dependabot), [secret scanning](https://github.com/fro-bot/dashboard/security/secret-scanning), and repository security-advisory endpoints returned no open findings. This does not supersede the package audit.
- [Code scanning](https://github.com/fro-bot/dashboard/security/code-scanning) returns 52 open alerts: 46 high Trivy image-package findings and six Scorecard findings. All 46 Trivy records have an empty fixed-version field. No new direct production-package or Actions advisory was identified in the available data.
- Bounded inspection of `src/server.ts`, `src/logger.ts`, `src/routes/wiki.ts`, `src/wiki/authorize.ts`, `src/github/installations.ts`, and `src/github/fro-bot-app-client.ts` found no additional confirmed credential leak or protected-route authentication bypass. Global errors are sanitized with generic HTTP responses; protected routes use deny-by-default session middleware; wiki mutations add operator identity and exact-origin guards. Read-token permissions and the separate repository-scoped write-token permissions remain explicit. This is not a comprehensive security audit.
- Yesterday's privacy remediation [#806](https://github.com/fro-bot/dashboard/pull/806) is merged; the inspected main branch no longer logs client addresses in rate-limit warnings. Deployment status was not verified.

### Code Quality

- Baseline: [`993af068a42a8aa7fa38221cade6a032902a063e`](https://github.com/fro-bot/dashboard/commit/993af068a42a8aa7fa38221cade6a032902a063e), Node v24.22.2, Bun 1.4.4. Evidence: [scheduled run 43170995644](https://github.com/fro-bot/dashboard/actions/runs/43170995644).
- In order: `bun run bootstrap`, `bun run check-types`, `bun run lint`, `bun run test` all pass. Bootstrap leaves the lockfile unchanged. Tests: 55 server test files / 4,698 tests and 75 web test files / 3,118 tests.
- Recursive imports of all 66 non-test `src/**/*.ts` modules pass under Node 24 strip-only execution. Each process also had a 20-second hang limit; none timed out. No executable enum, namespace, parameter-property, or import-alias drift was found.
- No failing gate justified an autoheal. This PR adds audit evidence only to satisfy branch/PR delivery; it changes no runtime, dependency, workflow, automation prompt, or guardrail. No new behavioral tests are needed for a Markdown-only record.

### Workflow Integrity

- All 35 third-party references in `.github/workflows/*.yaml` and `.github/actions/**/action.yaml` use full 40-hex commit SHAs with version comments; no floating action tag was found.
- Seven comments do not meet the requested full `vX.Y.Z` annotation form: `github/codeql-action` uses `# v4` in `.github/workflows/codeql.yaml:32,38`, `.github/workflows/release.yaml:343`, and `.github/workflows/scorecard.yaml:42`; `actions/setup-node` uses `# v7` in `.github/workflows/release.yaml:51,153` and `.github/actions/setup/action.yaml:17`. Execution remains SHA-pinned. No workflow edit is justified by a failing run today.
- Workflow defaults are `contents: read` or `{}`; publication/scanning write permissions are job-specific. No new over-broad permission declaration was found. The model-job PAT isolation concern is already tracked in [#809](https://github.com/fro-bot/dashboard/issues/809); its actual token scope was not inspected or changed.
- Dependency-consuming CI jobs use `./.github/actions/setup`; release's Node-only scripts do not install project dependencies on the host, and image dependency installation happens inside Docker. No duplicate host dependency setup was found. CodeQL retains `build-mode: none` and the strip-only load job is present.
- Existing concerns: [release shell interpolation #784](https://github.com/fro-bot/dashboard/issues/784), [comment-trigger delivery #789](https://github.com/fro-bot/dashboard/issues/789), [release listener smoke #800](https://github.com/fro-bot/dashboard/issues/800), and [credential/concurrency gaps #809](https://github.com/fro-bot/dashboard/issues/809). No workflow or prompt edits made.

### Progressive Improvement

- `bun outdated` reports TypeScript 6.0.3 → 7.0.2 and jsdom 30.1.3 → 31.0.0, both major updates. Node 24 types intentionally match the runtime. Hono 4.13.13 → 4.13.17 and node-server 2.1.5 → 2.1.6 are patch drift, not more-than-minor drift. No newer ESLint/Vitest version appears; no standalone Prettier dependency exists. Routine updates remain with [Renovate #8](https://github.com/fro-bot/dashboard/issues/8).
- `.github/copilot-instructions.md:3-7` still describes JSX SSR/no build, while `AGENTS.md:3-8` and README describe the built React PWA. Report-only convention drift; automation instructions left untouched.
- Existing work: [scanner/lint scope #785](https://github.com/fro-bot/dashboard/issues/785), [contract/timing tests #786](https://github.com/fro-bot/dashboard/issues/786), [push cancellation cleanup #787](https://github.com/fro-bot/dashboard/issues/787), [unused type #788](https://github.com/fro-bot/dashboard/issues/788), [evidence learning #790](https://github.com/fro-bot/dashboard/issues/790), [plan frontmatter #791](https://github.com/fro-bot/dashboard/issues/791), [runtime-dependency assertion #815](https://github.com/fro-bot/dashboard/issues/815), and [vendored skill/advisory-floor drift #809](https://github.com/fro-bot/dashboard/issues/809). No TODO/FIXME annotations found in `src/`, `web/src/`, or `scripts/`.

### Cross-Project Intelligence

- [fro-bot/.github](https://github.com/fro-bot/.github/blob/94c37c8618165a8d082eb8c4e8abaac91c483cda/package.json), [fro-bot/agent](https://github.com/fro-bot/agent/blob/bb67b9289a2e4ed3edb654655cc526a21a3c744e/package.json), [marcusrbrown/infra](https://github.com/marcusrbrown/infra/blob/91c2a9ad6a20dd6fb3cce617544a720b59393252/package.json), and [bfra-me/.github](https://github.com/bfra-me/.github/blob/737d27ff96c848836cd46f38c7c6ac81cf488d53/package.json) align on `@bfra.me/eslint-config` 0.54.0 and `@bfra.me/tsconfig` 0.13.2. All four also use `@bfra.me/prettier-config` 0.16.13; this dashboard has no standalone Prettier package, so adoption would be a separate decision, not an automatic bump.
- Dashboard's `fro-bot/agent` SHA pin matches [latest v0.139.1](https://github.com/fro-bot/agent/releases/tag/v0.139.1). No action-pin update needed.
- [Sibling advisory gate](https://github.com/fro-bot/.github/blob/94c37c8618165a8d082eb8c4e8abaac91c483cda/packages/ci-checks/src/check-override-floors.ts) audits the whole locked tree, rejects malformed data, and distinguishes blocking severities from audit exit status. Useful prior art for existing [#809](https://github.com/fro-bot/dashboard/issues/809), not a change made today.
- [Agent Hono CSRF route](https://github.com/fro-bot/agent/blob/bb67b9289a2e4ed3edb654655cc526a21a3c744e/packages/gateway/src/web/auth/csrf-route.ts) uses privileged registration, fail-closed missing auth context, and uncached session-bound tokens. Its [allowlist](https://github.com/fro-bot/agent/blob/bb67b9289a2e4ed3edb654655cc526a21a3c744e/packages/gateway/src/web/auth/allowlist.ts) uses stable numeric IDs. Preserve separate dashboard and gateway credential domains.
- [Infra deploy workflow](https://github.com/marcusrbrown/infra/blob/91c2a9ad6a20dd6fb3cce617544a720b59393252/.github/workflows/deploy-dashboard.yaml) validates version/digest via quoted environment variables before its approval gate and rejects stale dispatches. [bfra CI](https://github.com/bfra-me/.github/blob/737d27ff96c848836cd46f38c7c6ac81cf488d53/.github/workflows/main.yaml) demonstrates SHA pins and explicit permissions. All observations were read-only; no sibling repository modified.

### Needs Human Attention

- Review [#807](https://github.com/fro-bot/dashboard/pull/807): `package.json` / `bun.lock` contain the isolated Zod floor and resolution. It is green and mergeable, so do not recreate it or mix unrelated upgrades into it. After merge run `bun audit --json` and require that GHSA-mrhx-c7xc-m3w5 is absent; moderate/low advisories can still make audit exit 1. No merge or approval performed.
- [Image findings](https://github.com/fro-bot/dashboard/security/code-scanning?query=is%3Aopen+tool%3ATrivy): `Dockerfile` pins Node 24 trixie-slim, and all 46 alert records omit fixed versions. Recheck upstream patched image availability before proposing a dedicated security digest change; verify via existing image scan and smoke gates. Do not switch distributions, suppress findings, or weaken release thresholds merely to turn alerts green.
- Full version-comment annotations: verify the release tag corresponding to each current SHA before replacing the seven major-only comments listed above. Do not infer patch versions or change action SHAs. Workflow edits remain deferred because no failing run established a genuine workflow bug under this run's narrower write policy.
- [#785](https://github.com/fro-bot/dashboard/issues/785), [#787](https://github.com/fro-bot/dashboard/issues/787), [#789](https://github.com/fro-bot/dashboard/issues/789), [#800](https://github.com/fro-bot/dashboard/issues/800), [#809](https://github.com/fro-bot/dashboard/issues/809), and [#815](https://github.com/fro-bot/dashboard/issues/815) already contain scoped paths, smallest-fix proposals, constraints, and verification. Reuse those notes; green current gates do not prove those missing guards. No follow-up assigned to a named agent.
- [Dispatch credential isolation #112](https://github.com/fro-bot/dashboard/issues/112) and [Scorecard policy findings](https://github.com/fro-bot/dashboard/security/code-scanning?query=is%3Aopen+tool%3AScorecard) require owner decisions. Secrets, settings, branch protection, caches, and environments were untouched.

<!-- fro-bot -->
<!-- fro-bot-run-summary: run=43170995644 date=2026-11-12 trigger=schedule -->
