---
title: Classify releases by what the Dockerfile ships
date: 2026-06-25
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Adding an input to the Docker build or changing a dependency that builds web/dist
  - Updating the release classifier or diagnosing a change missing from the pending batch
tags: [release, ci, paths-filter, dockerfile, image-contents, release-batch, dev-dependencies, release-classifier]
related:
  - docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md
---

# Classify releases by what the Dockerfile ships

## Context

A runtime fix (PR #102) changed `public/operator-stream.js`, which the Dockerfile copies into the image. The checks passed, but the merge did not start a release.

At the time, the release workflow and `isHardReleasePath()` both omitted `public/**`. The workflow's path filter stopped the run before the classifier could inspect the change. PR #103 added `public/**` to both filters and tested that they agreed. Release `2026.06.46` shipped the browser fix.

A later React update exposed the same problem. The Release guard passed, but the publication and deploy jobs skipped. PR #291 made the classifier treat unknown or build-affecting development dependencies as release-worthy. Release `2026.08.1` included that classifier fix and the React update.

## Guidance

[Release Pending](../../../.github/workflows/release-pending.yaml) runs on pushes to `main` without a path filter. [Batch preparation](../../../scripts/release-batch.ts) uses [`should-release.ts`](../../../scripts/should-release.ts) to classify changes since the last published commit.

The [Release workflow](../../../.github/workflows/release.yaml) filters for `docs/releases/batch.md` because it publishes after the App merges the pending pull request. Its guard checks that merge. It does not classify the files that go into the image. The old test that compared the two filters was removed. Do not add runtime paths to the publisher filter to repair a missing batch entry.

Compare the classifier with the [Dockerfile](../../../Dockerfile) when build inputs change. Include source and static assets, build configuration, and dependencies that change the installed packages or the browser bundle. The builder installs development dependencies with Bun before it builds `web/dist`. If a dependency can change the bundle, its `devDependencies` label does not make it tooling-only.

The classifier includes unknown or build-affecting development dependencies. It also includes a `bun.lock` change without a `package.json` change because the installed package versions can change. Narrow, proven tooling-only changes can skip the batch. Keep those exceptions explicit. An organization prefix does not prove that a package is tooling-only.

## Why This Matters

A green merge shows that checks passed, not that the image changed. A held batch explains why a change listed in its notes has not shipped. If a runtime change since the last release is missing from those notes, inspect batch preparation and classification.

## When to Apply

Use this guidance when a Docker build input changes or when a change that affects the image is missing from the pending batch. Keep the relevant [classifier tests](../../../test/should-release.test.ts) aligned with the build inputs.

## Verification

If a change is missing from the pending batch, read the Release Pending summary. Run the classifier with the changed paths and the package manifests from before and after that change. If the App merged the batch but publication is missing, follow the [release runbook](../../runbooks/dashboard-releases.md).

## Related

- [Held-release gate](held-release-gate-before-publisher-2026-11-20.md) for the merge and publication boundary.
- [Verify the assembled surface](unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md) for another case where green checks did not prove what shipped.
- [Web bundle must not import from the server src tree](../build-errors/web-bundle-server-import-boundary-2026-07-04.md) for a browser import that broke the image build.
