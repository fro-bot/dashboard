---
title: 'refactor: Use three-part CalVer release tags'
type: refactor
status: active
date: 2026-06-15
---

# refactor: Use three-part CalVer release tags

## Overview

Future dashboard releases should use three-part CalVer tags shaped as `YYYY.MM.PATCH`
instead of day-shaped tags like `YYYY.MM.DD` and collision tags like `YYYY.MM.DD.N`.
The release pipeline already uses one computed tag for the Git tag, GitHub Release title, and
GHCR image tag; this plan keeps that coupling and changes only how the release tag is computed.

## Problem Frame

The current format starts clean on a UTC day (`2026.06.15`) but becomes four-part when multiple
releases happen the same day (`2026.06.15.1`, `2026.06.15.2`). Marcus prefers a consistent
three-part format. The tricky part is the cutover: because `2026.06.15*` already exists, a June
restart at `2026.06.1` would look like a downgrade to SemVer-ish consumers such as Renovate.

## Requirements Trace

- R1. Future release tags use `YYYY.MM.PATCH` exactly three numeric components.
- R2. Fresh months start at `.0`, e.g. `2026.07.0`.
- R3. The transition month remains monotonic: with existing `2026.06.15*` tags, the next June
  release is `2026.06.16`.
- R4. The computed tag remains the single source for Git tag, GitHub Release title, and GHCR
  image tag.
- R5. Existing release safety stays intact: smoke-test-before-tag, digest promotion verification,
  App-token tag/release identity, `GITHUB_TOKEN` GHCR auth, and the 5-attempt tag push retry loop;
  reduce `GITHUB_TOKEN` content-write privilege if verification confirms only the App token needs it.
- R6. The tag computation behavior gains direct test coverage before changing the workflow.

## Scope Boundaries

- Do not retag or delete historical releases/images; existing `2026.06.15*` artifacts remain valid.
- Do not change `latest` or `sha-<short>` image aliases.
- Do not change package metadata; `package.json` remains a private-package placeholder version.
- Do not change App-token usage, GHCR auth, or smoke-test order.
- Do not split the release job in this PR; privilege separation beyond reducing unnecessary
  `GITHUB_TOKEN` contents write is deferred.
- Do not broaden into downstream infra pin changes; downstream consumers can move to the next
  tag+digest when they choose.

### Deferred to Separate Tasks

- OCI version labels: adding `org.opencontainers.image.version` would be useful polish but is not
  required for this format migration.
- Release workflow hardening beyond this migration, such as a CODEOWNERS gate for release-critical
  files or splitting build/publish/release into separate jobs, should happen as a dedicated security
  hardening PR. This repo currently has no local `CODEOWNERS` file.

## Context & Research

### Relevant Code and Patterns

- `.github/workflows/release.yaml` computes the tag inline in the `Compute and push CalVer tag`
  step, then reuses that output for GHCR promotion and GitHub Release creation.
- `.github/workflows/release.yaml` already fetches full tag history and preserves a 5-attempt
  push/refetch retry loop for release races.
- `test/*.test.ts` contains no release-tag coverage today; the release computation is fully
  untested inline bash.
- No `scripts/` directory currently exists. A Node strip-only TypeScript script (`scripts/compute-release-tag.ts`) is the extraction target; it runs directly via `node` without a build step.

### Institutional Learnings

- No `docs/solutions/` entry covers CalVer, GHCR tag generation, or release workflows.
- Existing project constraints still matter: GHCR uses `GITHUB_TOKEN`, while tag push and release
  creation use the App token for `fro-bot[bot]` authorship.
- This repo has no local `CODEOWNERS`; release-critical review is enforced by branch protection and
  the explicit human merge gate rather than path ownership in this plan.

## Key Technical Decisions

- **Extract tag computation before changing behavior:** The current inline bash has no tests.
  Moving the pure tag-selection logic to a small script lets Vitest cover transition and rollover
  behavior without exercising the whole release workflow.
- **Use monotonic transition-month counting:** Same-month legacy day tags are interpreted as
  numeric patch candidates. That makes June continue from `2026.06.15*` to `2026.06.16` instead
  of regressing to `2026.06.1`.
- **Fresh month starts at `.0`:** Once no tags exist for `YYYY.MM.*`, the first release emits
  `YYYY.MM.0`.
- **Keep the workflow shape stable:** The extraction should feed the existing retry loop; the
  workflow still smoke-tests the candidate digest before computing/pushing the public release tag.
- **Narrow the default token where safe:** The App token handles checkout, tag push, release
  creation, and cleanup. `GITHUB_TOKEN` is only needed for GHCR login/push, so the workflow should
  avoid granting it `contents: write` if implementation verifies no step relies on that scope.

## Open Questions

### Resolved During Planning

- Should June restart at `.1` or preserve monotonic ordering? Preserve monotonic ordering; next
  June release is `2026.06.16`.
- Should fresh months start at `.0` or `.1`? Start at `.0`.
- Are docs required? No durable docs currently mention the release tag format. The PR description
  should call out the cutover, but no repo doc update is required.

### Deferred to Implementation

- Exact script interface: prefer a `CALVER_MONTH` override for fixed-month tests and default to
  `date -u +%Y.%m` in the workflow. Tests should run the script inside temporary git repositories
  with seeded commits/tags, not mock `git tag` output or depend on the real repo's tag state.

## Implementation Units

- [ ] **Unit 1: Extract and test release tag computation**

**Goal:** Move the pure tag-selection logic into a small script and cover the new format before
the workflow depends on it.

**Requirements:** R1, R2, R3, R6

**Dependencies:** None

**Files:**
- Create: `scripts/compute-release-tag.ts`
- Create: `test/compute-release-tag.test.ts`

**Approach:**
- The script computes a candidate tag from existing Git tags in the current repository.
- Default the period to the current UTC month (`YYYY.MM`), with `CALVER_MONTH` as the test seam for
  fixed-month cases.
- Tests create isolated temporary git repositories, seed commits/tags there, and run the script with
  the temp repo as the working directory. The real repository's tag state is never part of the unit
  test fixture.
- Scan tags matching the current month, keep only numeric third components, and choose the next
  integer patch by numeric maximum, independent of `git tag` listing order or lexical sorting.
- For the transition month, legacy `YYYY.MM.DD` tags naturally participate as patch candidates;
  nested suffixes such as `YYYY.MM.DD.N` must not crash or create a four-part tag.
- Validate the final tag against `^[0-9]+\.[0-9]+\.[0-9]+$` before printing it.

**Execution note:** Implement test-first. The current behavior is untested and the transition rule
is the fragile part.

**Patterns to follow:**
- Existing `compute_tag` inline logic in `.github/workflows/release.yaml` for suffix parsing and
  numeric filtering.
- Existing Vitest style in `test/*.test.ts`.
- Node strip-only TypeScript conventions from `AGENTS.md`: no enums, namespaces, parameter properties, or TS import aliases.

**Test scenarios:**
- Happy path: no tags for `2026.07` -> script emits `2026.07.0`.
- Happy path: existing `2026.07.0` and `2026.07.2` -> script emits `2026.07.3`.
- Edge case: existing `2026.07.9` and `2026.07.10` in any listing order -> script emits
  `2026.07.11`.
- Edge case: existing `2026.06.15`, `2026.06.15.1`, and `2026.06.15.2` -> script emits
  `2026.06.16`.
- Edge case: existing transition-month tags include a higher manual or migrated patch such as
  `2026.06.20` -> script emits `2026.06.21`.
- Edge case: existing tags from other months do not affect the current month.
- Error/path hygiene: non-numeric or nested suffixes are ignored rather than producing invalid
  output.
- Error/path hygiene: final output is rejected if it is not exactly three numeric components.

**Verification:**
- Tests prove first-of-month reset, same-month increment, transition-month monotonicity, and
  malformed-tag resilience.

- [ ] **Unit 2: Wire the release workflow to the tested script**

**Goal:** Replace the inline tag-computation function with the tested script while preserving the
release pipeline's identity, promotion, verification, and retry behavior, and narrow the default
`GITHUB_TOKEN` scope if it is unnecessary.

**Requirements:** R1, R4, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `.github/workflows/release.yaml`

**Approach:**
- Keep `git fetch --tags --force` and the 5-attempt `git tag` / `git push` retry loop.
- Replace the inline `compute_tag` body with a call to the script.
- Keep the `calver` step output name as `tag` so promotion, release creation, and failure cleanup
  continue to use the same handle.
- Confirm checkout, tag push, release creation, and cleanup all use the App token; if so, set the
  job's `contents` permission to `read` and keep only `packages: write` for `GITHUB_TOKEN` GHCR
  auth.
- Update comments from day-shaped CalVer wording to release-tag wording where needed, without
  reformatting unrelated workflow sections.
- Do not move tag computation before the smoke test.

**Patterns to follow:**
- Current `Compute and push CalVer tag` retry loop in `.github/workflows/release.yaml`.
- Existing workflow style: full-SHA pinned actions, minimal permissions, `bash -Eeuo pipefail`.

**Test scenarios:**
- Test expectation: none in workflow YAML itself; behavior is covered by the script tests from
  Unit 1. Workflow verification is structural.

**Verification:**
- The workflow still exposes `steps.calver.outputs.tag`.
- The workflow still promotes the same smoke-tested digest to the computed tag, `latest`, and
  `sha-<short>`, then verifies all three resolve to the build digest.
- `GITHUB_TOKEN` no longer has content-write scope unless implementation proves it is still needed;
  App-token tag/release behavior, smoke-test order, and cleanup-on-failure behavior are unchanged.

- [ ] **Unit 3: Validate workflow and release gates**

**Goal:** Prove the repository accepts the migration before it reaches `main`, where editing
`release.yaml` itself will trigger the next release.

**Requirements:** R5, R6

**Dependencies:** Units 1-2

**Files:**
- Test: `.github/workflows/release.yaml`
- Test: `scripts/compute-release-tag.ts`
- Test: `test/compute-release-tag.test.ts`

**Approach:**
- Validate the new script via `pnpm check-types` and the full test suite.
- Run the normal project gates.
- Run `actionlint` against the workflow file when available locally; it is an external/manual tool,
  not declared in `package.json`, so absence in a clean contributor environment is not a project
  gate failure.
- Run the script locally (`node scripts/compute-release-tag.ts`) in a temporary git repository seeded with representative tags before merge, including `2026.06.15`, `2026.06.15.2`, `2026.06.20`, `2026.07.9`, and `2026.07.10`.
- Do not dispatch or push a release workflow from a branch; `workflow_dispatch` is intentionally
  main-only.

**Patterns to follow:**
- Project gates from `AGENTS.md`: `pnpm check-types`, `pnpm lint`, `pnpm test`.
- Existing release workflow path filter means the merge to `main` is the live release cutover.

**Test scenarios:**
- Integration: normal test suite includes the new release-tag tests.
- Merge-trigger safety: pre-merge dry-run in a temporary git repository proves the exact script
  that `release.yaml` calls emits only valid monotonic three-part tags for transition and fresh
  month cases.
- Workflow integrity: `actionlint` accepts the edited workflow when available.
- Release invariant: static review confirms App-token tag/release behavior is unchanged and
  `GITHUB_TOKEN` keeps only the scopes still required for GHCR publishing.
- Change-control invariant: implementation PR review explicitly treats `.github/workflows/release.yaml`
  and `scripts/compute-release-tag.ts` as release-critical write-path files; no direct push or
  bypass merge for this change.

**Verification:**
- Local gates pass; workflow lint passes when `actionlint` is available.
- The final diff contains no source-app changes outside the script, tests, and release workflow.
- `pnpm check-types` passes with the new script in place.

## System-Wide Impact

- **Interaction graph:** A push to `main` that changes `release.yaml` triggers the Release workflow;
  the first merged implementation commit will create the first new-format tag.
- **Error propagation:** Invalid tag output should fail before pushing a tag or promoting an image.
- **State lifecycle risks:** The existing cleanup step remains responsible for deleting a pushed tag
  and partial release if promotion or release creation fails.
- **API surface parity:** GitHub Release tags, GHCR CalVer tags, and release titles all stay in sync
  because they share `steps.calver.outputs.tag`.
- **Unchanged invariants:** Historical tags remain immutable; `latest` and `sha-<short>` remain
  moving/commit aliases; digest is still the deploy contract for downstream pins.
- **Change-control boundary:** The new script becomes release-critical supply-chain code because it
  feeds tag and release creation. Treat changes to it like release workflow changes in review.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `2026.06.1` would look older than existing `2026.06.15` to SemVer-ish consumers. | Transition month increments from existing numeric day tags, so June continues to `2026.06.16`. |
  | Inline logic refactor changes release behavior without coverage. | Extract the pure computation into a tested Node TS script and add Vitest coverage before wiring the workflow. |
| Workflow edit triggers a real release on merge to `main`. | Validate locally and in PR CI; call out in PR that merge performs the cutover release. |
| Token/identity conflation regresses GHCR or release authorship. | Keep App token for tag/release and `GITHUB_TOKEN` for GHCR; reduce unnecessary `GITHUB_TOKEN` `contents` write if verified safe. |
| Concurrent `main` pushes choose the same candidate tag. | Preserve the 5-attempt tag push/refetch retry loop. |
  | Release-critical script changes become an unreviewed tag/release write path. | Require explicit PR review attention for `scripts/compute-release-tag.ts` and `.github/workflows/release.yaml`; leave CODEOWNERS/split-job hardening to a separate PR. |

## Documentation / Operational Notes

- No repo docs currently need a tag-format update.
- The PR body should state the cutover rule: existing `2026.06.15*` stays historical; next June
  release is `2026.06.16`; fresh months start at `YYYY.MM.0`.
- Downstream image pins by tag+digest remain valid until manually advanced to a newer release.

## Sources & References

- Related workflow: `.github/workflows/release.yaml`
- Related release: `2026.06.15`
- Related tags: `2026.06.15`, `2026.06.15.1`, `2026.06.15.2`
- Project invariants: `AGENTS.md`
