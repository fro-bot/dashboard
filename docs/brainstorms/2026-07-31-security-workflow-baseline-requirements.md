---
date: 2026-07-31
topic: security-workflow-baseline
---

# Security Workflow Baseline

## Summary

Add a strict, low-noise security baseline for dependency changes, source analysis, repository supply-chain posture, and the released container image. Remove package-manager tooling from the production image so artifact scanning can block on actionable findings without permanent exclusions.

---

## Problem Frame

The repository has strong test, type, lint, workflow, and release gates, but it does not run CodeQL, dependency review, OpenSSF Scorecard, or container vulnerability scanning. The README exposes a Scorecard badge without a repository workflow producing current results.

The current release image fails an unfiltered HIGH/CRITICAL vulnerability scan because the runtime stage retains npm and corepack tooling after installing production dependencies. The application dependencies and operating-system packages scan clean once those unused toolchain paths are excluded, so the findings describe removable image surface rather than required application behavior.

---

## Actors

- A1. Contributor: Opens dependency and source changes and needs actionable security feedback before merge.
- A2. Maintainer: Reviews findings, controls repository enforcement, and approves releases and deployments.
- A3. Release pipeline: Builds, scans, publishes, and dispatches deployment of the production image.
- A4. GitHub security services: Analyze source, dependency diffs, and repository posture and retain findings for review.

---

## Key Flows

- F1. Pull-request security review
  - **Trigger:** A pull request targets `main`.
  - **Actors:** A1, A2, A4
  - **Steps:** Dependency changes are reviewed for introduced vulnerabilities; TypeScript source is analyzed; actionable findings appear with the pull-request checks; configured severity violations block merge.
  - **Outcome:** New high-risk dependency or source vulnerabilities cannot merge unnoticed.
  - **Covered by:** R1, R2, R3, R4, R12, R13, R14, R15, R17, R18
- F2. Repository posture assessment
  - **Trigger:** A push reaches `main` or the recurring scheduled assessment runs.
  - **Actors:** A2, A4
  - **Steps:** Repository supply-chain practices are assessed; results are published for the badge and retained as security findings; score changes remain informational.
  - **Outcome:** The repository has current, inspectable posture data without chasing score changes as merge blockers.
  - **Covered by:** R5, R6, R12, R13, R14
- F3. Release artifact security gate
  - **Trigger:** The release pipeline builds a candidate production image.
  - **Actors:** A2, A3
  - **Steps:** The exact candidate artifact is scanned; actionable runtime findings stop promotion and deployment; a clean artifact continues through the existing release flow.
  - **Outcome:** A released or deployed image has no known fixed HIGH/CRITICAL vulnerability in its runtime contents.
  - **Covered by:** R7, R8, R9, R10, R11, R12, R13, R14, R15

---

## Requirements

**Pull-request security gates**
- R1. Every pull request must review newly introduced dependency changes for known vulnerabilities.
- R2. A newly introduced dependency vulnerability with HIGH or CRITICAL severity must block merging.
- R3. TypeScript source must be analyzed on pull requests, pushes to `main`, and a recurring schedule; pull-request analysis supplies enforcement while main and scheduled analysis detect baseline drift.
- R4. The repository must resolve existing HIGH or CRITICAL CodeQL alerts before enabling merge protection, after which newly introduced alerts at those severities must block merging.

**Repository posture**
- R5. OpenSSF Scorecard must assess the repository on pushes to `main` and a recurring schedule only.
- R6. Scorecard results must remain informational and publish current data for the existing badge and GitHub security views; a failed or stale assessment must be visible rather than silently preserving an old result.

**Release artifact gate**
- R7. The production image must not retain npm, pnpm, corepack caches, or other package-manager tooling after production dependencies are installed.
- R8. Removing package-manager tooling must not change application startup, health checks, or runtime behavior.
- R9. The exact candidate image digest produced by the release pipeline must be scanned, released, and passed to deployment without rebuilding or substituting a mutable tag. A failed release must not move mutable `latest`; `latest` is promoted and read back only as the terminal publication step after the Git ref, release-unique CalVer/SHA tags, their digest verification, and GitHub Release work succeed.
- R10. A fixed HIGH or CRITICAL vulnerability in the candidate image's runtime operating-system or application packages must fail the release.
- R11. The blocking image scan must not use directory skips, package allowlists, severity downgrades, ignored layers, or scanner exception files to bypass findings removed by R7; unfixed findings remain visible under the actionable-fixed-vulnerability policy.

**Workflow-level integrity and visibility**
- R12. Each security job must declare the minimum GitHub token permissions it needs, with read-only defaults; only the job publishing to GitHub security views may receive `security-events: write`, and only Scorecard result publishing may receive `id-token: write`.
- R13. Every third-party action and scanner image must be pinned immutably and upgraded through the repository's dependency-update process.
- R14. Security jobs must use bounded triggers and retain findings that identify the affected component, severity, commit or image digest, originating workflow run, and remediation path.
- R15. A required scanner failure, unavailable vulnerability database, failed results upload, or missing permission must fail closed for its protected operation; Scorecard failures remain visible but do not block merges or releases.
- R16. Pull-request security jobs must use the unprivileged `pull_request` trust boundary, receive no repository secrets, and never execute untrusted pull-request code with write-capable permissions.

**Repository enforcement policy**
- R17. A new ruleset for `main` must require the existing CI checks plus Dependency Review and CodeQL after each new check has reported successfully and the HIGH/CRITICAL baseline is clean; the same ruleset must use code-scanning merge protection so new HIGH/CRITICAL CodeQL alerts block merging rather than merely appearing in the Security tab.
- R18. The `main` ruleset must enforce required checks on administrators and define no standing actor-specific bypass that can merge after a failed gate; any emergency protection change is a separate, explicitly approved, audited action followed by immediate restoration and verification.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R15, R17, R18.** Given a pull request introduces a dependency with a known HIGH vulnerability, when dependency review runs, the security check fails and the pull request cannot merge, including for administrators.
- AE2. **Covers R3, R4, R15, R17, R18.** Given CodeQL has established a clean baseline, when a pull request introduces a new HIGH or CRITICAL alert, the configured merge protection blocks the pull request, including for administrators.
- AE3. **Covers R5, R6, R15.** Given a scheduled Scorecard run changes the repository score, when the workflow completes, the result is published but does not block unrelated pull requests or releases; a failed run is visibly stale or failed.
- AE4. **Covers R7, R8, R11.** Given the runtime image is built, when its filesystem is inspected, package-manager tooling and caches are absent while the application starts and passes its existing health check.
- AE5. **Covers R9, R10, R15.** Given the exact candidate image contains a fixed HIGH or CRITICAL runtime vulnerability, when the image scan runs, release publication and deploy dispatch do not occur.
- AE6. **Covers R9, R10, R11, R14.** Given a scanner reports only an unfixed vulnerability, when the release gate evaluates it, the finding remains visible and bound to the candidate digest but does not block under the actionable-fixed-vulnerability policy.
- AE7. **Covers R12, R16.** Given a pull request originates from a fork, when security checks run, they receive no repository secrets and cannot obtain write-capable repository or security-event permissions through untrusted code.
- AE8. **Covers R6, R15.** Given a required scanner or results upload is unavailable, when a protected pull request or release runs, that operation blocks; an unavailable Scorecard assessment reports failure without blocking unrelated work.
- AE9. **Covers R9, R10, R14, R15.** Given a release fails during scanning or publication, mutable `latest` is unchanged; after the Git ref, release-unique CalVer/SHA tags, digest verification, and GitHub Release work succeed, `latest` is promoted and read back as the terminal publication step, while release-unique tags may remain for deferred GHCR retention/cleanup.

---

## Success Criteria

- Pull requests receive dependency and source-security feedback with no duplicate or contradictory gates.
- Newly introduced HIGH/CRITICAL dependency and CodeQL findings are enforced through repository merge protection.
- The existing Scorecard badge is backed by a current repository-owned workflow.
- The production image passes a strict HIGH/CRITICAL runtime scan without skip-directory exceptions.
- The digest that passes the image scan is the same digest published in the release and sent to deployment.
- A vulnerable or unscanned candidate image cannot reach release publication or deployment dispatch.
- A failed release never intentionally advances mutable `latest`; `latest` is the terminal single-tag publication after all prior fallible release work.
- The added baseline does not materially increase ordinary pull-request latency or duplicate native GitHub security capabilities.

---

## Scope Boundaries

- Defer SBOM publication, build provenance, artifact attestations, image signing, and deploy-time signature verification to a later supply-chain program.
- Do not add a custom secret-scanning workflow; GitHub's native secret scanning remains the repository control.
- Keep Dependabot alerts authoritative for existing dependency debt; Dependency Review governs newly introduced pull-request changes.
- Do not make Scorecard scores merge or release blockers.
- Do not remediate unrelated development-only dependency alerts as part of the workflow adoption unless they block a required baseline check.
- Allow release-unique CalVer/SHA image tags to remain as scanned residue after a partial publication failure; deferred GHCR retention/cleanup owns that residue because the release job does not receive `packages:delete`.
- Do not expand this work into the dedicated release-to-infra GitHub App migration tracked separately.
- Do not layer classic branch protection and a separate code-scanning ruleset; establish one ruleset for the currently-unprotected `main` branch.

---

## Key Decisions

- Remove unused runtime tooling instead of suppressing its findings: this reduces attack surface and keeps the image policy understandable.
- Block only actionable HIGH/CRITICAL findings: strict enforcement stays focused on risks with an available remediation.
- Treat Scorecard as posture data, not a quality target: the score informs maintenance without encouraging badge-driven churn.
- Deliver one baseline in three independently verifiable stages: pull-request gates, repository posture reporting, and release-image hardening plus scanning.
- Stages one and three enforce; stage two reports posture and never blocks merges or releases.
- Keep runtime cleanup inseparable from the strict image gate: the cleanup removes the current false-positive attack surface and lets the scan run without permanent exceptions.
- Make mutable `latest` the terminal single-tag publication: create the Git ref, promote and verify release-unique CalVer/SHA tags, create/edit the GitHub Release, then promote and read back `latest`; partial failures may leave release-unique tags for deferred GHCR retention/cleanup, with no `packages:delete` authority.
- Separate security analysis from ordinary test CI while keeping dependency review attached to pull requests and artifact scanning attached to release.
- Require a clean CodeQL baseline before enabling merge protection: do not grandfather existing HIGH/CRITICAL alerts or activate protection against an unknown backlog.
- Establish one `main` ruleset after the new workflows report cleanly; include the existing CI checks, the new security checks, CodeQL `high_or_higher` protection, administrator enforcement, and no standing bypass actors.
- Prefer GitHub-provided short-lived tokens and OIDC for Scorecard publishing; introduce a dedicated read-only token only if planning verifies a concrete coverage gap.

---

## Dependencies / Assumptions

- The repository remains public and has GitHub code scanning, dependency graph, Dependabot alerts, and secret scanning available.
- Repository administration access is available to establish the `main` ruleset after the workflows establish clean baselines.
- Existing Dependabot alert generation and remediation remain unchanged; the new dependency gate applies only to pull-request deltas.
- The production process continues to launch the server directly with Node and does not require npm, pnpm, or corepack at runtime.
- The release pipeline continues to identify the candidate image by immutable digest before deployment dispatch.
- Scorecard publishing can use short-lived repository credentials and OIDC without broad repository write access.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3, R5, R12, R13, R14][Needs research] Which current immutable action and scanner-image digests, minimal permission sets, and supported result formats should be pinned when implementation starts?
- [Affects R7, R8][Technical] What cleanup sequence removes package-manager tooling while preserving the existing non-root runtime and health check?
- [Affects R9, R10, R14, R15][Technical] How should the existing release job carry one digest through build, smoke test, vulnerability scan, release publication, and deployment dispatch without rebuilding or retagging the artifact?
- [Affects R5, R6, R12][Needs research] Does the repository-token and OIDC Scorecard pattern provide complete results, or is a repository-scoped read-only token required for a verified missing signal?

---

## Sources / Research

- `.github/workflows/main.yaml` — current pull-request CI and permission conventions.
- `.github/workflows/release.yaml` — current image build, smoke-test, release, and deploy-dispatch sequence.
- `Dockerfile` — current multi-stage build and retained runtime package-manager tooling.
- `.impeccable/config.json` — existing security-adjacent CI configuration with version-sensitive behavior.
- `fro-bot/.github/.github/workflows/codeql-analysis.yaml` — sibling CodeQL trigger, permission, and pinning pattern.
- `fro-bot/.github/.github/workflows/dependency-review.yaml` — sibling dependency-review pattern.
- `fro-bot/.github/.github/workflows/scorecard.yaml` — sibling Scorecard publishing and SARIF pattern.
- GitHub CodeQL and dependency-review action documentation; OpenSSF Scorecard action documentation; Trivy image-scanning documentation.
