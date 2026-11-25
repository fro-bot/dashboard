---
title: Advisory override floors need a recurring check of the resolved tree
date: '2026-11-24'
category: workflow-issues
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Adding or raising an entry in the `overrides` map of `package.json` to clear an advisory
  - Deciding whether a dependency floor is still doing its job
  - Choosing which workflow should catch a vulnerable version already resting in `bun.lock`
tags: [overrides, advisory, bun-audit, bun-lock, dependency-review, scheduled-check]
---

# Advisory override floors need a recurring check of the resolved tree

## Context

[`package.json`](../../../package.json) `overrides` carries seven floors: `brace-expansion@2`, `brace-expansion@5`, `fast-uri@3`, `katex@0`, `toml@4`, `undici@7` and `zod@4`. Each records an intent: no copy below this version in the tree.

A floor records intent, not outcome. Whether it moves the resolver depends on how the package manager matches a version-scoped key against the dependent's declared range, which the Bun docs leave open, so the resolved `bun.lock` is the only proof. A floor can also stop applying quietly: a parent drops the dependency, a key stops matching, or a new advisory raises the version the floor needs to be.

Today nothing in the dashboard looks at the resolved tree after the day a floor is written:

- `bun run lint` is ESLint and does not read the lockfile.
- [`dependency-review.yaml`](../../../.github/workflows/dependency-review.yaml) runs on `pull_request` and scans manifests that change in that pull request. A vulnerable version already resting in `bun.lock` is invisible to it.
- The scheduled workflows (`codeql.yaml`, `scorecard.yaml`, `release-pending.yaml`) do not audit dependencies.

At the time of writing, `bun audit --json` on the lockfile reports no `high` or `critical` advisory (three `moderate`, one `low`), and every floored package resolves at or above its floor. That is a point-in-time reading, not a standing guarantee.

## Guidance

Check the outcome, not the edit. After changing a floor, read the resolved versions out of `bun.lock` and re-run `bun audit` to confirm the count that matters actually dropped. Then repeat that check on a schedule, because new advisories land without a pull request.

### Prior art: the `check-override-floors` gate in `fro-bot/.github`

`fro-bot/.github` has this gate:

- Implementation: [`packages/ci-checks/src/check-override-floors.ts`](https://github.com/fro-bot/.github/blob/2ac4d27f16c41c35797658f1363bceaca02502a6/packages/ci-checks/src/check-override-floors.ts), run through the entrypoint [`scripts/check-override-floors.ts`](https://github.com/fro-bot/.github/blob/2ac4d27f16c41c35797658f1363bceaca02502a6/scripts/check-override-floors.ts).
- Rationale and the exception list: [`docs/override-floors.md`](https://github.com/fro-bot/.github/blob/2ac4d27f16c41c35797658f1363bceaca02502a6/docs/override-floors.md).

Its shape:

- It runs `bun audit --json` against the locked tree and fails on any `high` or `critical` advisory. It does not read the `overrides` map: a locked copy inside a vulnerable range fails even when a floored copy of the same package sits beside it, so it checks the outcome the floors exist for.
- It fails closed. Empty or unparseable output, an unknown severity or a malformed record is a failure, not a skip, because `bun audit` exits non-zero whenever any advisory exists and the exit status alone is not the signal.
- An advisory with no fixed version goes in `accepted-advisories.json` with a reason and an expiry date. An expired entry fails the gate.
- It runs as part of that repo's `bun run lint` (`package.json` `lint` script), so it gates pull requests and pushes to `main`. A daily agent pass also runs it by hand and combines every flagged package into one remediation PR.

### What the dashboard does not have

The `.github` gate runs when someone pushes; it has no trigger of its own that fires without a change. The dashboard has no such gate at all, and a floor check there needs a trigger that fires without a pull request. This learning records the gap; it does not add the gate.

When the dashboard takes it on, the decisions that carry over are: audit the lockfile rather than the `overrides` map, fail closed on output the script cannot interpret, give accepted advisories an expiry, and add a `schedule` trigger next to the pull request one.

## Related

- [`docs/plans/2026-10-17-001-refactor-migrate-pnpm-to-bun-plan.md`](../../plans/2026-10-17-001-refactor-migrate-pnpm-to-bun-plan.md) — the one-time check of every floor against the resolved `bun.lock` during the pnpm-to-bun migration (R3, AE3).
