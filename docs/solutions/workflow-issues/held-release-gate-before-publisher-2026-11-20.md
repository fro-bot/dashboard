---
title: Gate held releases in front of the existing publisher
date: '2026-11-20'
category: workflow-issues
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Adding a hold or approval to a working release pipeline
  - Choosing a publication baseline from pull requests that humans can also merge
tags: [release, github-actions, approval-gate, hold-label, github-app, publication-baseline]
---

# Gate held releases in front of the existing publisher

## Context

Dashboard needed to collect changes into one release while keeping its existing image build, scan, publication, and deploy request. The release gate decides when the App merges the pending PR. The existing publisher still cuts the release.

## Guidance

1. Separate batch preparation from publication. [`renderReleaseBatch`](../../../scripts/release-batch.ts) classifies changes since the last published source. The App collects them in one PR that changes only `docs/releases/batch.md`.
2. Let the owner approve without clicking Merge. The [review signal](../../../.github/workflows/release-pending-review.yaml) has no write permissions. [`canRelease`](../../../scripts/release-pending.ts) requires a current owner approval on the exact PR head. The gate checks required jobs and pins the App's squash request to that commit. Approval can release a held batch. Scheduled release requires proof that the hold is off.
3. Verify who merged the batch before publishing. The [release guard](../../../.github/workflows/release.yaml) requires a single-parent, notes-only commit and exactly one associated PR. That PR must come from the reserved branch in the same repository, with the App as both author and merger. Its merge SHA must equal the pushed commit.
4. Use the last published release as the baseline for counting changes. [`runPending`](../../../scripts/release-pending.ts) skips confirmed human mergers when it looks for the previous App merge. If the latest batch was merged by a human, its replacement starts held. An unknown merger or an App merge without matching publication evidence blocks the next batch. Require the Git tag to point to the release source and both the versioned and `latest` image tags to resolve to the digest in the release record.

## Why This Matters

When the branch does not require a review, GitHub auto-merge can merge on green checks alone. It cannot enforce the hold or the owner's approval. Keep approval as the operator's last action and let the App merge.

A PR's merge status does not tell you what shipped. The publisher treats a human squash as ineligible, even if the owner approved the same commit. If the batch gate waits for that squash to publish, it waits for a release that never started. Use the published tag and image digest as durable evidence instead of depending on retained workflow runs.

## When to Apply

Use this pattern when you need to hold or queue releases without changing the publisher. It also applies when several actors can merge PRs, but only one actor can authorize publication.

## Examples

In the manual-merge case, the publisher skipped the squash as designed. The recovery ignored that human merge and removed its unpublished notes snapshot. The workflow rebuilt the same batch with the hold in place.

In the approval-only case, the owner approved the green PR with the hold still on. The App merged it, and the publisher shipped the resulting squash commit. Both public image tags matched the digest in the release record. The separate infra deploy also succeeded. That run verified approval under hold, not a scheduled merge.

## Related

- [Dashboard release runbook](../../runbooks/dashboard-releases.md) for operation and recovery steps.
- [Release path coverage](release-paths-filter-must-cover-runtime-image-contents-2026-06-25.md) for the earlier artifact classification incident.
