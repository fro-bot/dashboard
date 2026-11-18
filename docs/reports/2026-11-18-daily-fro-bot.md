## Daily Fro Bot Report — 2026-11-18 (UTC)

### Run Summary

| Category | Status | Notes |
| --- | --- | --- |
| Errored PRs | ✅ | Eight open PRs have no failing checks; all are mergeable. |
| Security | ⚠️ | Zod remediation #807 already exists; high picomatch advisory has no published patch. |
| Code Quality | ✅ | Bootstrap, types, lint, 7,817 tests, and 66 strip-only imports pass. |
| Workflow Integrity | ⚠️ | All 35 external references SHA-pinned; seven incomplete version comments. |
| Progressive Improvement | ⚠️ | Existing convention and test gaps; routine dependency changes remain Renovate-owned. |
| Cross-Project Intelligence | ✅ | Four sibling manifests inspected; shared configs and latest agent pin align. |

### Errored PRs

- [#855](https://github.com/fro-bot/dashboard/pull/855), [#847](https://github.com/fro-bot/dashboard/pull/847), [#839](https://github.com/fro-bot/dashboard/pull/839), [#831](https://github.com/fro-bot/dashboard/pull/831), [#826](https://github.com/fro-bot/dashboard/pull/826), [#816](https://github.com/fro-bot/dashboard/pull/816), [#807](https://github.com/fro-bot/dashboard/pull/807), and [#768](https://github.com/fro-bot/dashboard/pull/768) have no failing checks and report mergeable. No PR-head code was checked out or executed; no repair was warranted.
- Open PRs/issues were searched before delivery. Existing remediation and deferred root causes are linked rather than duplicated. Earlier daily audit PRs record different dates' evidence.

### Security

- `bun audit --json` exits 1: **two high, 11 moderate, four low, zero critical** advisories. [Zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) already has green, mergeable [#807](https://github.com/fro-bot/dashboard/pull/807); it is behind main, not conflicted. No duplicate or unrelated dependency change was made.
- Newly observed high [picomatch GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) affects `<=4.0.7`. The advisory's `first_patched_version` is null and `bun info picomatch version` returns 4.0.7. `bun pm why picomatch` identifies development/build/lint/test consumers (Vite, Vitest, tinyglobby, Rollup pluginutils, stylistic ESLint). No existing open picomatch PR/issue was found. No confirmed patched release exists to safely upgrade to; no override, guessed version, downgrade, or replacement was attempted.
- Direct runtime resolutions remain Hono 4.13.13 and node-server 2.1.5. Moderate advisories include [wildcard middleware bypass](https://github.com/advisories/GHSA-h7mg-cq63-vhpq), [mount path handling](https://github.com/advisories/GHSA-4m76-xfj5-7975), [CSRF](https://github.com/advisories/GHSA-46wx-v44x-9hh2), and [node-server path normalization](https://github.com/advisories/GHSA-jpvv-r467-5p4w). Lower-severity upgrades remain [Renovate-owned](https://github.com/fro-bot/dashboard/issues/8). Passing tests do not establish non-exploitability.
- Dependabot, secret-scanning, and repository advisory endpoints were accessible: zero open findings (37 Dependabot records, all fixed; zero secret-scanning or repository-advisory records). This does not supersede the package audit. Trivy action v0.36.0 and CodeQL action v4 fall outside affected ranges of [GHSA-69fq-xp46-6x23](https://github.com/advisories/GHSA-69fq-xp46-6x23) and [GHSA-vqf5-2xx6-9wfm](https://github.com/advisories/GHSA-vqf5-2xx6-9wfm); no additional confirmed high/critical Actions remediation was identified.
- [Code scanning](https://github.com/fro-bot/dashboard/security/code-scanning) has 52 open records: 46 Trivy instances covering 11 high CVEs and six Scorecard records. Every Trivy fixed-version field is empty. These inherited OS findings follow the [accepted bounded posture](../solutions/best-practices/trivy-base-image-alerts-unfixable-by-design-2026-08-30.md); do not invent application fixes or suppress alerts. The latest [Release](https://github.com/fro-bot/dashboard/actions/runs/44020532391) succeeded. No new local image scan or deployment verification was performed.
- Bounded inspection of `src/server.ts:594-906`, `src/logger.ts`, `src/wiki/authorize.ts`, `src/github/installations.ts`, and `src/github/fro-bot-app-client.ts` found no additional confirmed credential leak or missing protected-route middleware. Global errors sanitize messages and return generic responses; session middleware precedes protected routers. Wiki writes separately require configured operator identity and origin/content-type checks. Read tokens request explicit read-only permissions; the separate write client mints only `contents: write` for `.github`. This is not a comprehensive security audit or proof that advisory paths are unreachable.

### Code Quality

- Evidence: [run 44255058751](https://github.com/fro-bot/dashboard/actions/runs/44255058751). Audited baseline: [`552a869cbbaf12bb7f4e17afaaa4e6c45fe1fdf7`](https://github.com/fro-bot/dashboard/commit/552a869cbbaf12bb7f4e17afaaa4e6c45fe1fdf7), Node v24.22.2, Bun 1.4.4.
- In order, `bun run bootstrap`, `bun run check-types`, `bun run lint`, and `bun run test` passed (exit 0). Tests: 55 server files / 4,699 tests and 75 web files / 3,118 tests. Bootstrap reported no dependency changes and left tracked files unchanged.
- All 66 production `src/**/*.ts` modules, excluding tests, imported under Node 24 strip-only with zero failures. No enum, namespace, parameter-property, or import-alias runtime drift was found.
- Delivery adds only this Markdown evidence file; no runtime, dependency, lockfile, workflow, automation prompt, setting, or guardrail changes. No behavioral tests or screenshots are needed for an additive audit record.

### Workflow Integrity

- All 35 third-party action/reusable-workflow references across seven workflow YAML files and the setup action use full commit SHAs. No floating action tag was found.
- Seven version comments remain major-only instead of `vX.Y.Z`: `.github/workflows/codeql.yaml:32,38`, `.github/workflows/release.yaml:343`, and `.github/workflows/scorecard.yaml:42` use `# v4`; `.github/workflows/release.yaml:51,153` and `.github/actions/setup/action.yaml:17` use `# v7`. Execution is SHA-pinned. No genuine failing workflow justifies changing these under the narrower write boundary.
- Defaults are read-only or empty; publication/scanning write permissions are job-specific. No newly identified over-broad permission declaration. Dependency-consuming host jobs use `./.github/actions/setup`; release host scripts use Node built-ins and Docker installs dependencies inside the build. No duplicated host dependency setup was identified.
- Baseline [Main](https://github.com/fro-bot/dashboard/actions/runs/44194968646) passed all six jobs: Lint, Design Check, Check Types, Test, Check Workflows, Test Scripts Load. [CodeQL](https://github.com/fro-bot/dashboard/actions/runs/44194968628) and [Scorecard](https://github.com/fro-bot/dashboard/actions/runs/44194968716) also succeeded.
- Existing hardening remains tracked in [#784](https://github.com/fro-bot/dashboard/issues/784), [#789](https://github.com/fro-bot/dashboard/issues/789), [#800](https://github.com/fro-bot/dashboard/issues/800), [#809](https://github.com/fro-bot/dashboard/issues/809), and [#112](https://github.com/fro-bot/dashboard/issues/112). Current Fro Bot automation enables `isolate-agent` and scheduled `branch-pr` delivery.

### Progressive Improvement

- `bun outdated` reports TypeScript 6.0.3 → 7.0.2, jsdom 30.1.3 → 31.0.1, and node-diff3 3.2.1 → 4.0.0 major drift. Hono 4.13.13 → 4.13.18 and node-server 2.1.5 → 2.1.8 are patch drift. No newer ESLint 10.15.0 or Vitest 5.1.0 was listed; minimum-release-age filtering applies. No standalone Prettier dependency. No routine upgrades were made.
- `.github/copilot-instructions.md:3-7` still describes JSX SSR/no build rather than the React PWA in `AGENTS.md:3-8` and README. No TODO/FIXME annotations were found in `src/`, `web/src/`, or `scripts/`.
- Reuse existing scanner/test/push records [#785](https://github.com/fro-bot/dashboard/issues/785), [#786](https://github.com/fro-bot/dashboard/issues/786), [#787](https://github.com/fro-bot/dashboard/issues/787), [#788](https://github.com/fro-bot/dashboard/issues/788), [#815](https://github.com/fro-bot/dashboard/issues/815), and [#829](https://github.com/fro-bot/dashboard/issues/829). Durable search again skipped two invalid-frontmatter documents, already tracked in [#791](https://github.com/fro-bot/dashboard/issues/791). Progressive improvement is report-only.

### Cross-Project Intelligence

- Read-only manifest inspection of [fro-bot/.github](https://github.com/fro-bot/.github/blob/main/package.json), [fro-bot/agent](https://github.com/fro-bot/agent/blob/main/package.json), [marcusrbrown/infra](https://github.com/marcusrbrown/infra/blob/main/package.json), and [bfra-me/.github](https://github.com/bfra-me/.github/blob/main/package.json) found shared ESLint config 0.54.0 and tsconfig 0.13.2 matching dashboard. All four use Prettier config 0.16.13; adopting it here is a separate decision.
- Dashboard's agent SHA `f49a72e96e1d891c61cecd02a768d626817a7831` resolves to latest [v0.145.1](https://github.com/fro-bot/agent/releases/tag/v0.145.1). The [gateway manifest](https://github.com/fro-bot/agent/blob/main/packages/gateway/package.json) uses Hono 4.13.18 / node-server 2.1.8: useful Renovate compatibility evidence, not authorization for routine version changes.
- The [gateway CSRF route](https://github.com/fro-bot/agent/blob/main/packages/gateway/src/web/auth/csrf-route.ts) uses the privileged-route guard, fails closed on missing auth context, and returns uncached session-bound tokens. Preserve separate gateway/dashboard credential domains.
- [Infra deployment](https://github.com/marcusrbrown/infra/blob/main/.github/workflows/deploy-dashboard.yaml) passes version/digest through environment variables; [bfra CI](https://github.com/bfra-me/.github/blob/main/.github/workflows/main.yaml) labels the same setup-node SHA `v7.1.0`. No sibling repository was modified. Default-branch links identify inspected sources, not immutable evidence.

### Needs Human Attention

- **Unpatched high picomatch:** `bun.lock` resolves 4.0.7 through build/test/lint tooling; [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) describes repeated-extglob ReDoS and currently provides no patched version. Recheck the upstream advisory and registry before proposing any `package.json` override. The smallest future fix is an isolated patched resolution, once confirmed. Do not guess a fixed version, replace tooling broadly, or batch unrelated upgrades. Verify `bun audit --json`, frozen install, types, lint, tests, and strip-only imports; remaining findings can still make audit exit 1.
- **Existing high Zod fix:** review [#807](https://github.com/fro-bot/dashboard/pull/807), isolated to `package.json` / `bun.lock`. Do not duplicate or merge it automatically. Verify GHSA-mrhx-c7xc-m3w5 disappears and full gates pass.
- **Moderate runtime advisories:** dependency movement remains [Renovate-owned](https://github.com/fro-bot/dashboard/issues/8). Verify patched Hono/node-server lock resolutions and unauthorized-path/CSRF regression cases around `src/server.ts` and auth tests. Green tests alone do not prove advisory unreachability; never weaken guards.
- **Version comments:** verify full release labels for the seven exact Workflow Integrity locations without changing SHAs. Do not guess patch labels or edit workflows without a genuine failing-run cause or explicit owner authorization.
- **Convention drift:** the smallest follow-up is correcting `.github/copilot-instructions.md:3-7` to match `AGENTS.md:3-8` and README's built-client/no-backend-build distinction. Preserve security invariants and verify documentation consistency. Deferred because progressive improvement is report-only and automation instructions are protected.
- **Existing bounded work:** [#785](https://github.com/fro-bot/dashboard/issues/785) scopes `web/src/operator/no-server-imports.test.ts`, `test/operator-fixture-sanitization.test.ts`, and `eslint.config.ts`; add negative controls without weakening checks. [#829](https://github.com/fro-bot/dashboard/issues/829) scopes failed reads in `web/src/push/subscribe.ts`; distinguish rejected reads from absent subscriptions and test rejecting reads in `web/src/push/subscribe.test.ts`. [#815](https://github.com/fro-bot/dashboard/issues/815) scopes `test/runtime-dependencies.test.ts:113`; assert exact-pin shape rather than a particular version, retaining production/import guards. Read the linked constraints before implementing.
- **Owner-only decisions:** [#112](https://github.com/fro-bot/dashboard/issues/112), [#809](https://github.com/fro-bot/dashboard/issues/809), and [Scorecard](https://github.com/fro-bot/dashboard/security/code-scanning?query=is%3Aopen+tool%3AScorecard) require credential/policy decisions. Do not alter secrets, environments, settings, branch protection, or caches. Unfixed inherited OS alerts are not new application remediation tasks.
- **Report rotation:** retire yesterday's [#856](https://github.com/fro-bot/dashboard/issues/856), placing this invocation's single permitted comment there with a link to the new report and Run Summary markers. Do not post additional report/PR comments, approvals, or close any PR.

<!-- fro-bot -->
<!-- fro-bot-run-summary: run=44255058751 date=2026-11-18 trigger=schedule -->
