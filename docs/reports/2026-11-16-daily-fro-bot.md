## Daily Fro Bot Report — 2026-11-16 (UTC)

### Run Summary

| Category | Status | Notes |
| --- | --- | --- |
| Errored PRs | ✅ | Six preexisting open PRs have no failing checks; no repair needed. |
| Security | ⚠️ | Existing high Zod remediation #807; moderate runtime advisories remain. |
| Code Quality | ✅ | Bootstrap, types, lint, 7,817 tests, and 66 strip-only imports pass. |
| Workflow Integrity | ⚠️ | All 35 external references SHA-pinned; seven incomplete version comments. |
| Progressive Improvement | ⚠️ | Existing convention, scanner, and test gaps remain report-only. |
| Cross-Project Intelligence | ✅ | Four sibling repos inspected; shared configs and latest agent pin align. |

### Errored PRs

- [#839](https://github.com/fro-bot/dashboard/pull/839), [#831](https://github.com/fro-bot/dashboard/pull/831), [#826](https://github.com/fro-bot/dashboard/pull/826), [#816](https://github.com/fro-bot/dashboard/pull/816), [#807](https://github.com/fro-bot/dashboard/pull/807), and [#768](https://github.com/fro-bot/dashboard/pull/768) have no failing checks. No PR branch was checked out or executed. No autoheal was warranted.
- Open PRs/issues were searched for duplicate root causes. Existing remediation is reused below. Earlier audit PRs hold different dates' evidence; this record contains today's measurements only.

### Security

- `bun audit --json` exits 1: **one high, 11 moderate, five low, zero critical** advisories. The high [Zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) already has green [#807](https://github.com/fro-bot/dashboard/pull/807). GitHub returned unknown mergeability; `git merge-tree --write-tree origin/main origin/fix/security-zod-ghsa-mrhx-c7xc-m3w5` succeeded against the audited baseline, without checkout or executing branch code. No duplicate security PR or unrelated upgrade was made.
- Direct runtime resolutions remain Hono 4.13.13 and node-server 2.1.5. Moderate advisories include [wildcard middleware bypass](https://github.com/advisories/GHSA-h7mg-cq63-vhpq), [mount path handling](https://github.com/advisories/GHSA-4m76-xfj5-7975), [CSRF](https://github.com/advisories/GHSA-46wx-v44x-9hh2), and [node-server path normalization](https://github.com/advisories/GHSA-jpvv-r467-5p4w). These dependency updates remain [Renovate-owned](https://github.com/fro-bot/dashboard/issues/8); ordinary passing tests do not establish non-exploitability.
- Dependabot alerts, secret-scanning alerts, and repository advisories were accessible and returned no open findings. This does not override the package audit. Public Actions advisory ranges were checked: the pinned Trivy action v0.36.0 and CodeQL action v4 are outside the affected ranges in [GHSA-69fq-xp46-6x23](https://github.com/advisories/GHSA-69fq-xp46-6x23) and [GHSA-vqf5-2xx6-9wfm](https://github.com/advisories/GHSA-vqf5-2xx6-9wfm). No additional confirmed high/critical Actions remediation was identified.
- [Code scanning](https://github.com/fro-bot/dashboard/security/code-scanning) has 52 open records: 46 Trivy records across 11 high-severity CVEs and six Scorecard records. All Trivy fixed-version fields are empty; latest instances reference audited commit `1578d67f8dfc9aca8a96ae862340a8cf5e599f5a`. These inherited OS findings follow the [documented bounded posture](../solutions/best-practices/trivy-base-image-alerts-unfixable-by-design-2026-08-30.md): preserve visibility, enforce fixable high/critical failures, and do not swap base images merely to lower counts. No fresh local image scan or deployment verification was performed.
- Bounded inspection of `src/server.ts:594-606,682-906`, `src/logger.ts`, `src/routes/wiki.ts:149-182`, `src/wiki/authorize.ts`, `src/github/installations.ts`, and `src/github/fro-bot-app-client.ts:198-211` found no additional confirmed credential leak or protected-route auth omission. Global errors sanitize messages and return generic responses; routers follow fail-closed session middleware. Wiki writes additionally require configured operator identity, exact origin, JSON content type, and rate limits. Read tokens have explicit read-only permissions; the separate write token names only `.github` with `contents: write`. This bounded review is not a comprehensive security audit.

### Code Quality

- Evidence: [run 43813434452](https://github.com/fro-bot/dashboard/actions/runs/43813434452). Node v24.22.2, Bun 1.4.4. Main advanced during the audit with [#846](https://github.com/fro-bot/dashboard/pull/846); the clean tree was fast-forwarded and all gates rerun on [`1578d67f8dfc9aca8a96ae862340a8cf5e599f5a`](https://github.com/fro-bot/dashboard/commit/1578d67f8dfc9aca8a96ae862340a8cf5e599f5a).
- In order, `bun run bootstrap`, `bun run check-types`, `bun run lint`, and `bun run test` pass. Final tests: 55 server files / 4,699 tests and 75 web files / 3,118 tests. Bootstrap leaves tracked files unchanged.
- All 66 production `src/**/*.ts` modules, excluding tests, import under Node 24 strip-only with a 20-second per-module timeout. No runtime enum, namespace, parameter-property, or import-alias drift was found.
- Delivery adds this Markdown file only. No runtime, dependency, lockfile, workflow, prompt, setting, or guardrail changes. No behavioral tests or screenshots are needed for the additive audit record.

### Workflow Integrity

- All 35 external action/reusable-workflow references across seven workflow YAML files and the setup action use full commit SHAs. No floating action tag was found.
- Seven comments are major-only rather than `vX.Y.Z`: `.github/workflows/codeql.yaml:32,38`, `.github/workflows/release.yaml:343`, `.github/workflows/scorecard.yaml:42` use `# v4`; `.github/workflows/release.yaml:51,153` and `.github/actions/setup/action.yaml:17` use `# v7`. These remain execution-pinned; no genuine failing workflow justified editing them under the narrower write boundary.
- Workflow defaults are read-only or empty; scanning/publication writes are job-specific. No newly identified over-broad declaration. Dependency-consuming host jobs use `./.github/actions/setup`; release host scripts use Node built-ins and Docker installs its own dependencies. No duplicated host dependency setup was identified.
- Main retains Lint, Design Check, Check Types, Test, Check Workflows, and Test Scripts Load. Latest baseline [Main](https://github.com/fro-bot/dashboard/actions/runs/43813783643), [CodeQL](https://github.com/fro-bot/dashboard/actions/runs/43813783666), [Scorecard](https://github.com/fro-bot/dashboard/actions/runs/43813783742), and [Release](https://github.com/fro-bot/dashboard/actions/runs/43813783656) runs succeeded. No approval, merge, branch deletion, history rewrite, cache purge, or secrets/settings change was performed.
- Existing hardening remains tracked in [#784](https://github.com/fro-bot/dashboard/issues/784), [#789](https://github.com/fro-bot/dashboard/issues/789), [#800](https://github.com/fro-bot/dashboard/issues/800), [#809](https://github.com/fro-bot/dashboard/issues/809), and [#112](https://github.com/fro-bot/dashboard/issues/112). Today's workflow uses `isolate-agent`; token availability alone does not establish the credential's full scope.

### Progressive Improvement

- `bun outdated` reports TypeScript 6.0.3 → 7.0.2 major drift and jsdom 30.1.3 → 31.0.0. Hono 4.13.13 → 4.13.18 and node-server 2.1.5 → 2.1.8 are patch drift. ESLint 10.14.0 / Vitest 5.1.0 have no newer release listed by this query; minimum-release-age filtering applies. No standalone Prettier dependency. No versions were changed.
- `.github/copilot-instructions.md:3-7` still describes JSX SSR/no build rather than the built React PWA in `AGENTS.md:3-8` and README. No TODO/FIXME annotations found in `src/`, `web/src/`, or `scripts/`.
- Reuse existing scanner/test/push findings [#785](https://github.com/fro-bot/dashboard/issues/785), [#786](https://github.com/fro-bot/dashboard/issues/786), [#787](https://github.com/fro-bot/dashboard/issues/787), [#788](https://github.com/fro-bot/dashboard/issues/788), [#815](https://github.com/fro-bot/dashboard/issues/815), and [#829](https://github.com/fro-bot/dashboard/issues/829). Durable search still reports two invalid-frontmatter documents, already tracked in [#791](https://github.com/fro-bot/dashboard/issues/791). No report-only finding was autohealed.

### Cross-Project Intelligence

- Read-only manifest inspection of [fro-bot/.github](https://github.com/fro-bot/.github/blob/main/package.json), [fro-bot/agent](https://github.com/fro-bot/agent/blob/main/package.json), [marcusrbrown/infra](https://github.com/marcusrbrown/infra/blob/main/package.json), and [bfra-me/.github](https://github.com/bfra-me/.github/blob/main/package.json) found shared ESLint config 0.54.0 and tsconfig 0.13.2 matching dashboard. All four use Prettier config 0.16.13; adoption here remains a separate decision.
- Dashboard's SHA `b3d5cd8de673ba285160777aa1eab3d4e5c0b03a` matches the resolved latest [agent v0.144.4](https://github.com/fro-bot/agent/releases/tag/v0.144.4). The [gateway manifest](https://github.com/fro-bot/agent/blob/main/packages/gateway/package.json) uses Hono 4.13.18 / node-server 2.1.8, useful compatibility evidence for Renovate, not authorization to bump this repository.
- The [gateway CSRF route](https://github.com/fro-bot/agent/blob/main/packages/gateway/src/web/auth/csrf-route.ts) registers privileged routes, fails closed on missing context, and returns uncached session-bound tokens. Preserve the gateway/dashboard credential-domain separation.
- [Infra deployment](https://github.com/marcusrbrown/infra/blob/main/.github/workflows/deploy-dashboard.yaml) passes version/digest through environment variables; [bfra CI](https://github.com/bfra-me/.github/blob/main/.github/workflows/main.yaml) uses full setup-node version comments. No sibling repository was modified. These default-branch links identify sources inspected today, not immutable evidence.

### Needs Human Attention

- **Existing high advisory:** review [#807](https://github.com/fro-bot/dashboard/pull/807), the isolated Zod floor in `package.json` / `bun.lock`. Do not recreate it or bundle unrelated upgrades. Verify GHSA-mrhx-c7xc-m3w5 disappears from `bun audit --json` and all validation gates pass; lower-severity findings may still yield exit 1. No approval or merge was performed.
- **Runtime advisory follow-up:** dependency movement remains [Renovate-owned](https://github.com/fro-bot/dashboard/issues/8). Verify patched lock resolutions and explicit unauthorized-path/CSRF cases in `src/server.ts` and auth tests; ordinary green tests do not prove affected middleware unreachable. Do not weaken guards.
- **Version comments:** verify full release labels for the seven exact Workflow Integrity locations without changing SHAs. Do not guess patch versions or edit workflows absent a genuine failing-run cause or explicit owner authorization.
- **Convention drift:** smallest follow-up is correcting `.github/copilot-instructions.md:3-7` to match `AGENTS.md:3-8` and README's built-client/no-backend-build distinction. Verify documentation consistency; do not modify security invariants. Deferred because progressive improvement is report-only and automation instructions are protected.
- **Existing bounded work:** [#785](https://github.com/fro-bot/dashboard/issues/785) scopes `web/src/operator/no-server-imports.test.ts`, `test/operator-fixture-sanitization.test.ts`, and `eslint.config.ts`; add scanner-negative controls without weakening checks. [#829](https://github.com/fro-bot/dashboard/issues/829) scopes failed reads in `web/src/push/subscribe.ts`; distinguish failed reads from absent subscriptions and add rejecting-read tests in `web/src/push/subscribe.test.ts`. [#815](https://github.com/fro-bot/dashboard/issues/815) scopes `test/runtime-dependencies.test.ts:113`; assert exact-pin shape rather than one version, retaining production/import guards. Consult each issue's constraints before changing code.
- **Owner-only decisions:** [#112](https://github.com/fro-bot/dashboard/issues/112), [#809](https://github.com/fro-bot/dashboard/issues/809), and [Scorecard](https://github.com/fro-bot/dashboard/security/code-scanning?query=is%3Aopen+tool%3AScorecard) require credential/policy decisions. Do not alter secrets, environments, settings, branch protection, or caches. Unfixed OS alerts are not new application remediation tasks.
- **Report rotation conflict:** this task both requests closing older daily issues and prohibits closing/reopening issues. Reuse and retitle the sole existing daily report [#840](https://github.com/fro-bot/dashboard/issues/840) for today instead of creating a second open report or closing anything. Historical audit records remain in their dated PRs; one run comment links today's evidence.

<!-- fro-bot -->
<!-- fro-bot-run-summary: run=43813434452 date=2026-11-16 trigger=schedule -->
