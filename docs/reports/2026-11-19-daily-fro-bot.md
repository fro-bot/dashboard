## Daily Fro Bot Report — 2026-11-19 (UTC)

### Run Summary

| Category | Status | Notes |
| --- | --- | --- |
| Errored PRs | ✅ | Nine open PRs; no failing checks requiring repair. |
| Security | ⚠️ | Existing Zod fix #807 is green and mergeable; picomatch advisory withdrawn. |
| Code Quality | ✅ | Bootstrap, types, lint, 7,817 tests and 66 strip-only imports pass. |
| Workflow Integrity | ⚠️ | All 35 external references SHA-pinned; seven incomplete version comments. |
| Progressive Improvement | ⚠️ | Documentation and tooling drift remain report-only. |
| Cross-Project Intelligence | ✅ | Four siblings inspected; agent pin current; infra shared configs advanced. |

### Errored PRs

- Inspected all nine open PRs: #858, #855, #847, #839, #831, #826, #816, [security #807](https://github.com/fro-bot/dashboard/pull/807), and [Renovate #768](https://github.com/fro-bot/dashboard/pull/768). No failing checks; skipped Fro Bot checks are not failures. No branch repair was warranted and no PR-head commands were executed.
- Open issues and PRs were searched before delivery. Existing remediation and deferred root causes are reused by reference. No report PR exists for today's date; earlier daily audit PRs contain different dates' evidence.

### Security

- `bun audit --json` exits 1: **one high, 11 moderate, four low, zero critical** advisories. High [Zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) already has green, mergeable [#807](https://github.com/fro-bot/dashboard/pull/807). It is behind main, not conflicted; no repair, duplicate PR, or unrelated upgrade was made.
- Yesterday's high [picomatch GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) was **withdrawn at 2026-11-18T15:38:56Z**, confirmed through the advisory endpoint. It no longer appears in today's audit. Do not carry forward the prior unpatched-remediation request.
- Direct runtime resolutions remain Hono 4.13.13 and node-server 2.1.5. Moderate advisories include [wildcard middleware bypass](https://github.com/advisories/GHSA-h7mg-cq63-vhpq), [mount path handling](https://github.com/advisories/GHSA-4m76-xfj5-7975), [CSRF](https://github.com/advisories/GHSA-46wx-v44x-9hh2), and [node-server path normalization](https://github.com/advisories/GHSA-jpvv-r467-5p4w). Lower-severity dependency movement remains [Renovate-owned](https://github.com/fro-bot/dashboard/issues/8); green tests do not establish non-exploitability.
- Dependabot, secret scanning and repository advisory data were accessible: zero open Dependabot alerts, zero secret-scanning records and zero repository advisories. Package audit findings remain independent of these results.
- [Code scanning](https://github.com/fro-bot/dashboard/security/code-scanning) has 52 open records across refs: 46 Trivy instances covering 11 high CVEs, plus six Scorecard records. Every Trivy fixed-version cell is empty. Preserve the [accepted bounded base-image posture](../solutions/best-practices/trivy-base-image-alerts-unfixable-by-design-2026-08-30.md); no application workaround, broad base-image change or suppression is warranted solely to reduce alert counts. Latest [Release run](https://github.com/fro-bot/dashboard/actions/runs/44357209306) succeeded; no local image scan or deployment verification was performed.
- Pinned Trivy action v0.36.0 and CodeQL action v4 fall outside affected ranges of [GHSA-69fq-xp46-6x23](https://github.com/advisories/GHSA-69fq-xp46-6x23) and [GHSA-vqf5-2xx6-9wfm](https://github.com/advisories/GHSA-vqf5-2xx6-9wfm). No additional confirmed high/critical Actions fix was identified.
- Bounded inspection of `src/server.ts:594-906`, `src/logger.ts`, `src/wiki/authorize.ts`, `src/github/installations.ts`, and `src/github/fro-bot-app-client.ts` found no additional confirmed credential leak or absent protected-route middleware. Global errors sanitize text and return generic responses; deny-by-default session middleware precedes protected routers. Wiki writes separately require operator identity and exact origin/JSON checks. Read tokens use explicit read-only scopes; the separate write client restricts minting to `contents: write` and the target repository. This is not a comprehensive security audit.

### Code Quality

- Evidence: [run 44475930228](https://github.com/fro-bot/dashboard/actions/runs/44475930228). Audited baseline: [`1e4b4875393f2221666b016a965060b164c0cabe`](https://github.com/fro-bot/dashboard/commit/1e4b4875393f2221666b016a965060b164c0cabe), Node v24.22.2, Bun 1.4.4.
- In order, `bun run bootstrap`, `bun run check-types`, `bun run lint`, and `bun run test` passed (exit 0). Tests: 55 server files / 4,699 tests and 75 web files / 3,118 tests. Bootstrap made no dependency or tracked-file changes.
- Imported all 66 production `src/**/*.ts` modules, excluding tests, under Node 24 strip-only: zero failures. No enum, namespace, parameter-property or import-alias load drift was detected.
- Delivery changes only this Markdown evidence file. No runtime, dependency, lockfile, workflow, automation-prompt, settings or guardrail edits. No behavioral tests or screenshots are required for an additive audit record.

### Workflow Integrity

- All 35 external action/reusable-workflow references in seven workflow YAML files and the setup action are full-SHA pinned; no floating tags.
- Seven version comments are incomplete: `.github/workflows/codeql.yaml:32,38`, `.github/workflows/release.yaml:343`, and `.github/workflows/scorecard.yaml:42` use `# v4`; `.github/workflows/release.yaml:51,153` and `.github/actions/setup/action.yaml:17` use `# v7`. Execution remains immutable. The narrower workflow-write boundary requires a genuine failing-run bug; no such failure justifies editing these comments.
- Defaults are read-only or empty; scanning/publication writes are job-specific. No new over-broad permission declaration identified. Dependency-consuming host jobs use `./.github/actions/setup`; release host scripts use Node built-ins and dependencies install inside Docker, not duplicated host setup.
- Baseline [Main](https://github.com/fro-bot/dashboard/actions/runs/44442109799), [CodeQL](https://github.com/fro-bot/dashboard/actions/runs/44442109820), and [Scorecard](https://github.com/fro-bot/dashboard/actions/runs/44442109672) succeeded. Main retains Lint, Design Check, Check Types, Test, Check Workflows and Test Scripts Load jobs. Scheduled automation declares `branch-pr` delivery.
- Existing hardening records: [#784](https://github.com/fro-bot/dashboard/issues/784), [#789](https://github.com/fro-bot/dashboard/issues/789), [#800](https://github.com/fro-bot/dashboard/issues/800), [#809](https://github.com/fro-bot/dashboard/issues/809), and [#112](https://github.com/fro-bot/dashboard/issues/112). No duplicate issues.

### Progressive Improvement

- `bun outdated` reports TypeScript 6.0.3 → 7.0.2, jsdom 30.1.3 → 31.0.1 and node-diff3 3.2.1 → 4.0.0 major drift; ESLint config 0.54.0 → 0.54.1 patch drift. Hono 4.13.13 → 4.13.18 and node-server 2.1.5 → 2.1.8 are patch drift. ESLint 10.15.0 and Vitest 5.1.0 have no newer eligible version listed; minimum-release-age filtering applies. No standalone Prettier dependency. No routine upgrades made.
- `.github/copilot-instructions.md:3-7` still describes JSX SSR/no build instead of the React PWA and no-backend-build distinction in `AGENTS.md:3-8` and README. No TODO/FIXME annotations found in `src/`, `web/src/`, or `scripts/`.
- Existing bounded work remains in [#785](https://github.com/fro-bot/dashboard/issues/785), [#786](https://github.com/fro-bot/dashboard/issues/786), [#787](https://github.com/fro-bot/dashboard/issues/787), [#788](https://github.com/fro-bot/dashboard/issues/788), [#815](https://github.com/fro-bot/dashboard/issues/815), [#829](https://github.com/fro-bot/dashboard/issues/829), and [#861](https://github.com/fro-bot/dashboard/issues/861). Durable search skipped two invalid-frontmatter documents, already tracked in [#791](https://github.com/fro-bot/dashboard/issues/791). Report-only; no changes in this category.

### Cross-Project Intelligence

- Read-only manifests inspected: [fro-bot/.github](https://github.com/fro-bot/.github/blob/main/package.json), [fro-bot/agent](https://github.com/fro-bot/agent/blob/main/package.json), [marcusrbrown/infra](https://github.com/marcusrbrown/infra/blob/main/package.json), and [bfra-me/.github](https://github.com/bfra-me/.github/blob/main/package.json). Shared tsconfig remains 0.13.2 everywhere. Three siblings match dashboard's ESLint config 0.54.0; infra has advanced to 0.54.1. Infra's Prettier config is 0.16.14; the others use 0.16.13. These are Renovate/convention observations, not authorization to add or bump dependencies.
- Dashboard agent SHA `65239fc570b0e7adc3c0d0c263282ee91ff6108d` is labeled v0.146.0, matching the [latest release](https://github.com/fro-bot/agent/releases/tag/v0.146.0). The [gateway manifest](https://github.com/fro-bot/agent/blob/main/packages/gateway/package.json) uses Hono 4.13.18 and node-server 2.1.8, useful compatibility evidence for Renovate.
- [Gateway CSRF](https://github.com/fro-bot/agent/blob/main/packages/gateway/src/web/auth/csrf-route.ts) registers through the privileged-route guard, fails closed without auth context, and returns session-bound tokens with `no-store, private`. Keep gateway and dashboard credentials separate.
- [Infra deployment](https://github.com/marcusrbrown/infra/blob/main/.github/workflows/deploy-dashboard.yaml) passes version/digest inputs through environment variables. [bfra CI](https://github.com/bfra-me/.github/blob/main/.github/workflows/main.yaml) annotates the same setup-node SHA as v7.1.0. No sibling was modified; source links identify inspected default branches, not immutable evidence.

### Needs Human Attention

- **Existing high Zod remediation:** review [#807](https://github.com/fro-bot/dashboard/pull/807), limited to `package.json` / `bun.lock`. It is green and mergeable; do not duplicate or merge automatically. Verify the high advisory disappears, frozen install and full gates pass, and plugin tooling remains compatible. The withdrawn picomatch advisory requires no new remediation.
- **Moderate runtime advisories:** keep `package.json` / `bun.lock` movement Renovate-owned. Validate patched Hono/node-server resolutions and unauthorized-path/CSRF cases around `src/server.ts` and auth tests. Do not infer non-exploitability from green tests or weaken guards.
- **Version comments:** the seven exact locations above need verified full release labels when a narrowly authorized workflow edit is available. Preserve SHAs; do not guess patch labels or edit workflows absent a genuine failing-run cause/explicit owner authorization.
- **Convention drift:** smallest follow-up is correcting `.github/copilot-instructions.md:3-7` to match `AGENTS.md:3-8` and README. Preserve all security invariants; verify built-client/no-backend-build wording. Deferred because progressive improvement is report-only and automation instructions are protected.
- **Existing bounded fixes:** [#785](https://github.com/fro-bot/dashboard/issues/785) scopes import/fixture scanning and lint gaps in `web/src/operator/no-server-imports.test.ts`, `test/operator-fixture-sanitization.test.ts`, and `eslint.config.ts`; add negative controls without weakening checks. [#829](https://github.com/fro-bot/dashboard/issues/829) scopes rejected subscription reads in `web/src/push/subscribe.ts` and its tests; distinguish rejection from absence. [#815](https://github.com/fro-bot/dashboard/issues/815) scopes `test/runtime-dependencies.test.ts:113`; assert exact-pin shape rather than one version, retaining production/import guards. Read each issue's constraints before changing code; verify full gates.
- **Owner decisions and accepted posture:** [#112](https://github.com/fro-bot/dashboard/issues/112), [#809](https://github.com/fro-bot/dashboard/issues/809), and [Scorecard findings](https://github.com/fro-bot/dashboard/security/code-scanning?query=is%3Aopen+tool%3AScorecard) need credential/policy decisions, not autonomous settings changes. Do not modify secrets, environments, protection, settings or caches. Unfixed inherited OS alerts are not new application remediation tasks.
- **Report rotation:** supersede [yesterday's #859](https://github.com/fro-bot/dashboard/issues/859). Use this invocation's single permitted comment there to link today's report with bot and Run Summary markers, then close the old issue. Do not comment on PRs, approve, merge or close them.

<!-- fro-bot -->
<!-- fro-bot-run-summary: run=44475930228 date=2026-11-19 trigger=schedule -->
