## Daily Fro Bot Report — 2026-11-17 (UTC)

### Run Summary

| Category | Status | Notes |
| --- | --- | --- |
| Errored PRs | ✅ | Seven existing open PRs have no failing checks; no repair needed. |
| Security | ⚠️ | High Zod advisory already has green remediation #807; moderate runtime advisories remain. |
| Code Quality | ✅ | Bootstrap, types, lint, 7,817 tests, and 66 Node strip-only imports pass. |
| Workflow Integrity | ⚠️ | All 35 external references SHA-pinned; seven incomplete version comments. |
| Progressive Improvement | ⚠️ | Existing convention, scanner, and test gaps; dependency movement remains Renovate-owned. |
| Cross-Project Intelligence | ✅ | Four sibling repos inspected; shared configs and latest agent pin align. |

### Errored PRs

- [#847](https://github.com/fro-bot/dashboard/pull/847), [#839](https://github.com/fro-bot/dashboard/pull/839), [#831](https://github.com/fro-bot/dashboard/pull/831), [#826](https://github.com/fro-bot/dashboard/pull/826), [#816](https://github.com/fro-bot/dashboard/pull/816), [#807](https://github.com/fro-bot/dashboard/pull/807), and [#768](https://github.com/fro-bot/dashboard/pull/768) have no failing checks and report mergeable. No PR branch was checked out or executed; no repair was warranted.
- Existing open PRs/issues were searched for duplicate root causes. The high-advisory remediation and deferred findings below reuse existing records. Earlier audit PRs contain different dates' evidence; this document records today's measurements.

### Security

- `bun audit --json` exits 1: **one high, 11 moderate, four low, zero critical** advisories. High [Zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) already has green, mergeable [#807](https://github.com/fro-bot/dashboard/pull/807). No duplicate security fix or unrelated upgrade was made.
- Direct runtime resolutions are Hono 4.13.13 and node-server 2.1.5. Moderate advisories include [wildcard middleware bypass](https://github.com/advisories/GHSA-h7mg-cq63-vhpq), [mount path handling](https://github.com/advisories/GHSA-4m76-xfj5-7975), [CSRF](https://github.com/advisories/GHSA-46wx-v44x-9hh2), and [node-server path normalization](https://github.com/advisories/GHSA-jpvv-r467-5p4w). Updates below high severity remain [Renovate-owned](https://github.com/fro-bot/dashboard/issues/8); green tests alone do not establish non-exploitability.
- Dependabot, secret-scanning, and repository advisory data were accessible: zero open findings (all 37 Dependabot records are fixed). This does not override the package audit. The pinned Trivy action v0.36.0 and CodeQL action v4 are outside the affected ranges in [GHSA-69fq-xp46-6x23](https://github.com/advisories/GHSA-69fq-xp46-6x23) and [GHSA-vqf5-2xx6-9wfm](https://github.com/advisories/GHSA-vqf5-2xx6-9wfm). No additional confirmed high/critical Actions remediation was identified.
- [Code scanning](https://github.com/fro-bot/dashboard/security/code-scanning) has 52 open records: 46 Trivy records covering 11 high-severity CVEs and six Scorecard records. Every Trivy instance has an empty fixed-version field; latest instances reference the audited baseline. These are inherited OS findings under the [documented bounded posture](../solutions/best-practices/trivy-base-image-alerts-unfixable-by-design-2026-08-30.md), not application fixes to invent. The latest [Release](https://github.com/fro-bot/dashboard/actions/runs/44020532391) actually built the image and passed both reporting and fixed-HIGH/CRITICAL enforcement. No new local image scan or deployment verification was performed.
- Bounded inspection of `src/server.ts:594-606,682-906`, `src/logger.ts`, `src/routes/wiki.ts:149-182`, `src/wiki/authorize.ts`, `src/github/installations.ts`, and `src/github/fro-bot-app-client.ts:198-211` found no additional confirmed credential leak or protected-route auth omission. Global errors sanitize messages and return generic responses; protected routers follow fail-closed session middleware. Wiki writes additionally check configured operator identity, exact origin, JSON content type, and rate limits. Read tokens explicitly request read-only permissions; the separate write token names only `.github` and `contents: write`. This is a bounded inspection, not a comprehensive security audit or advisory exploitability proof.

### Code Quality

- Evidence: [run 44039568448](https://github.com/fro-bot/dashboard/actions/runs/44039568448). Audited baseline: [`bd66e4d4af528ea2088b3ead81b53977817e4d51`](https://github.com/fro-bot/dashboard/commit/bd66e4d4af528ea2088b3ead81b53977817e4d51), Node v24.22.2, Bun 1.4.4.
- In order, `bun run bootstrap`, `bun run check-types`, `bun run lint`, and `bun run test` pass. Tests: 55 server files / 4,699 tests and 75 web files / 3,118 tests. The first combined shell invocation reached its 120-second harness limit during testing; the complete standalone rerun passed. Bootstrap left tracked files unchanged.
- All 66 production `src/**/*.ts` modules, excluding tests, import under Node 24 strip-only with zero failures. No enum, namespace, parameter-property, or import-alias runtime drift was found.
- Delivery adds this Markdown evidence file only. No runtime, dependency, lockfile, workflow, prompt, setting, or guardrail changes. No new behavioral tests or screenshots are needed for an additive audit record.

### Workflow Integrity

- All 35 external action/reusable-workflow references across seven workflow YAML files and the setup action use full commit SHAs. No floating action tag was found.
- Seven version comments remain major-only rather than `vX.Y.Z`: `.github/workflows/codeql.yaml:32,38`, `.github/workflows/release.yaml:343`, and `.github/workflows/scorecard.yaml:42` use `# v4`; `.github/workflows/release.yaml:51,153` and `.github/actions/setup/action.yaml:17` use `# v7`. Execution is SHA-pinned. No genuine failing workflow justified editing these under the narrower write boundary.
- Workflow defaults are read-only or empty; scanning/publication writes are job-specific. No newly identified over-broad permission declaration. Dependency-consuming host jobs use `./.github/actions/setup`; release host scripts use Node built-ins and Docker installs dependencies inside the build. No duplicated host dependency setup was identified.
- Main retains Lint, Design Check, Check Types, Test, Check Workflows, and Test Scripts Load. Baseline [Main](https://github.com/fro-bot/dashboard/actions/runs/44020532484), [CodeQL](https://github.com/fro-bot/dashboard/actions/runs/44020532392), [Scorecard](https://github.com/fro-bot/dashboard/actions/runs/44020532400), and [Release](https://github.com/fro-bot/dashboard/actions/runs/44020532391) runs succeeded.
- Existing workflow/credential hardening remains tracked in [#784](https://github.com/fro-bot/dashboard/issues/784), [#789](https://github.com/fro-bot/dashboard/issues/789), [#800](https://github.com/fro-bot/dashboard/issues/800), [#809](https://github.com/fro-bot/dashboard/issues/809), and [#112](https://github.com/fro-bot/dashboard/issues/112). The current Fro Bot workflow enables `isolate-agent`; do not infer the credential's full scope from availability alone.

### Progressive Improvement

- `bun outdated` reports TypeScript 6.0.3 → 7.0.2, jsdom 30.1.3 → 31.0.1, and node-diff3 3.2.1 → 4.0.0 major drift. Hono 4.13.13 → 4.13.18 and node-server 2.1.5 → 2.1.8 are patch drift. No newer ESLint 10.15.0 or Vitest 5.1.0 was listed; minimum-release-age filtering applies. No standalone Prettier dependency. No versions were changed.
- `.github/copilot-instructions.md:3-7` still describes JSX SSR/no build rather than the built React PWA in `AGENTS.md:3-8` and README. No TODO/FIXME annotations found in `src/`, `web/src/`, or `scripts/`.
- Reuse existing scanner/test/push findings [#785](https://github.com/fro-bot/dashboard/issues/785), [#786](https://github.com/fro-bot/dashboard/issues/786), [#787](https://github.com/fro-bot/dashboard/issues/787), [#788](https://github.com/fro-bot/dashboard/issues/788), [#815](https://github.com/fro-bot/dashboard/issues/815), and [#829](https://github.com/fro-bot/dashboard/issues/829). Durable search skipped two invalid-frontmatter documents, already tracked in [#791](https://github.com/fro-bot/dashboard/issues/791). No report-only finding was autohealed.

### Cross-Project Intelligence

- Read-only manifest inspection of [fro-bot/.github](https://github.com/fro-bot/.github/blob/main/package.json), [fro-bot/agent](https://github.com/fro-bot/agent/blob/main/package.json), [marcusrbrown/infra](https://github.com/marcusrbrown/infra/blob/main/package.json), and [bfra-me/.github](https://github.com/bfra-me/.github/blob/main/package.json) found shared ESLint config 0.54.0 and tsconfig 0.13.2 matching dashboard. All four use Prettier config 0.16.13; adopting it here is a separate decision.
- Dashboard's agent SHA `b70e54edc0333fbf97ca4d4204775ce33158b3b3` matches the resolved latest [v0.145.0](https://github.com/fro-bot/agent/releases/tag/v0.145.0). The [gateway manifest](https://github.com/fro-bot/agent/blob/main/packages/gateway/package.json) uses Hono 4.13.18 / node-server 2.1.8: useful compatibility evidence for Renovate, not authorization to bump this repository.
- The [gateway CSRF route](https://github.com/fro-bot/agent/blob/main/packages/gateway/src/web/auth/csrf-route.ts) registers a privileged route, fails closed on absent auth context, and returns uncached session-bound tokens. Preserve separate gateway/dashboard credential domains.
- [Infra deployment](https://github.com/marcusrbrown/infra/blob/main/.github/workflows/deploy-dashboard.yaml) passes version/digest through environment variables; [bfra CI](https://github.com/bfra-me/.github/blob/main/.github/workflows/main.yaml) uses full setup-node version comments. No sibling repository was modified. Default-branch links identify sources inspected today, not immutable evidence.

### Needs Human Attention

- **Existing high advisory:** review [#807](https://github.com/fro-bot/dashboard/pull/807), the isolated Zod floor in `package.json` / `bun.lock`. Do not recreate it or bundle unrelated upgrades. Verify GHSA-mrhx-c7xc-m3w5 disappears from `bun audit --json` and all gates pass; lower-severity findings may still yield exit 1. No approval or merge was performed.
- **Runtime advisory follow-up:** dependency movement remains [Renovate-owned](https://github.com/fro-bot/dashboard/issues/8). Verify patched lock resolutions and unauthorized-path/CSRF regression cases around `src/server.ts` and auth tests; green tests do not prove affected middleware unreachable. Do not weaken guards.
- **Version comments:** verify full release labels for the seven exact Workflow Integrity locations without changing SHAs. Do not guess patch versions or edit workflows without a genuine failing-run cause or explicit owner authorization.
- **Convention drift:** the smallest follow-up is correcting `.github/copilot-instructions.md:3-7` to match `AGENTS.md:3-8` and README's built-client/no-backend-build distinction. Verify documentation consistency and preserve all security invariants. Deferred because progressive improvement is report-only and automation instructions are protected.
- **Existing bounded work:** [#785](https://github.com/fro-bot/dashboard/issues/785) scopes `web/src/operator/no-server-imports.test.ts`, `test/operator-fixture-sanitization.test.ts`, and `eslint.config.ts`; add scanner-negative controls without weakening checks. [#829](https://github.com/fro-bot/dashboard/issues/829) scopes failed reads in `web/src/push/subscribe.ts`; distinguish rejected reads from absent subscriptions and add rejecting-read tests in `web/src/push/subscribe.test.ts`. [#815](https://github.com/fro-bot/dashboard/issues/815) scopes `test/runtime-dependencies.test.ts:113`; assert exact-pin shape rather than one version while retaining production/import guards. Read each issue's constraints before implementing.
- **Owner-only decisions:** [#112](https://github.com/fro-bot/dashboard/issues/112), [#809](https://github.com/fro-bot/dashboard/issues/809), and [Scorecard](https://github.com/fro-bot/dashboard/security/code-scanning?query=is%3Aopen+tool%3AScorecard) require credential/policy decisions. Do not alter secrets, environments, settings, branch protection, or caches. Unfixed inherited OS alerts are not new application remediation tasks.
- **Report rotation:** create today's report and close yesterday's [#840](https://github.com/fro-bot/dashboard/issues/840), placing this invocation's single permitted comment on the older issue with a link to its replacement and the Run Summary. Closing an issue is permitted; the hard boundary prohibits closing PRs. Do not post an additional comment on the new issue or on PRs.

<!-- fro-bot -->
<!-- fro-bot-run-summary: run=44039568448 date=2026-11-17 trigger=schedule -->
