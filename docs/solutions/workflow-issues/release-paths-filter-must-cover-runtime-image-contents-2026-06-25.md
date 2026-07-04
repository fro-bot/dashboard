---
title: Release path filters must cover everything the Dockerfile bakes in
date: 2026-06-25
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Adding a Dockerfile COPY for a new runtime-affecting directory (e.g. public/, a future assets/)
  - Changing a static asset, browser client, manifest, or icon that ships baked into the image
  - Touching a release-gating surface (release.yaml on.push.paths, scripts/should-release.ts isHardReleasePath)
tags: [release, ci, paths-filter, dockerfile, image-contents, gate-drift, parity-test, public-assets]
related:
  - docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md
---

# Release path filters must cover everything the Dockerfile bakes in

## Context

A runtime fix (PR #102) changed `public/operator-stream.js` — the operator browser client baked into the production image by `Dockerfile`'s `COPY public/ ./public/`. The merge was green. **No release was produced.** The fix sat unshipped on `main` until an unrelated `public/`/release-config change later carried it out in release `2026.06.46`.

The release is gated by **two independent filters**, and both listed `src/**` and `web/**` but not `public/**`:

1. **GitHub Actions `on.push.paths`** in `.github/workflows/release.yaml` — evaluated by the runner *before any job starts*. If the push touches no listed path, the workflow never starts.
2. **`isHardReleasePath()`** in `scripts/should-release.ts` — an in-workflow guard that re-checks the changed files.

A path filter that is too narrow cannot be rescued by an in-workflow guard: the guard never runs.

## Guidance

### 1. The release-trigger set is "everything the image bakes in that affects runtime"

A release is needed whenever a runtime-affecting file changes, and "runtime-affecting" is "anything the Dockerfile `COPY`s into the runtime image." For this repo that is three directories — `src/`, `public/`, and the build output `web/dist/` (whose input-side handle is `web/**`). Every one must be in the release-trigger set — no "add it later" exceptions.

### 2. When two gates exist, the outer gate is the bottleneck and must be the superset

- **Outer gate:** `on.push.paths` — a miss means the workflow never starts (silent skip).
- **Inner gate:** `isHardReleasePath()` — only runs if the outer gate passed.

Whatever the inner gate treats as a hard-release path must be a subset of the outer gate's `paths:`. Edit the two together; treat a mismatch as a bug.

### 3. Pin the two gates with a parity test so drift becomes a failing test

```ts
describe('should-release — workflow path filter parity', () => {
  // GitHub Actions filters on.push.paths BEFORE the guard runs, so any directory
  // the guard treats as a hard-release path must also appear in the workflow's
  // paths filter — otherwise the workflow never starts and the guard never runs.
  it('release.yaml on.push.paths includes every directory-glob hard-release path', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/release.yaml'),
      'utf8',
    )
    for (const dir of ['src/**', 'web/**', 'public/**']) {
      expect(workflow).toContain(`'${dir}'`)
    }
  })
})
```

The test array is the single source of truth for the directory set. Add a new entry there first; the test then forces both gates to include it.

## Why This Matters

A silently-skipped release is the most dangerous release failure mode: every signal is green — merge succeeded, CI green, branch protection satisfied — but the artifact in `ghcr.io` is stale. Verified, merged fixes never reach production, with no error, no log, no notification. It only surfaces when a downstream symptom forces someone to diff the image against `main`. This is strictly worse than a release that *errors* (a red CI status is visible) — and it is the second release-config-vs-image bug here (the first, PR #97, was a build-fail: the `Dockerfile` didn't `COPY pnpm-workspace.yaml`). Same root theme, release config drifted from image reality; the fixes differ.

## When to Apply

- The `Dockerfile` gains a `COPY` for a new runtime-affecting directory the image bakes in.
- `isHardReleasePath()` is modified — update the parity test in the same commit.
- `release.yaml`'s `on.push.paths` is touched.
- A new trigger path is needed: add it to the parity-test array first, then to both gates.

Treat any of these as a "release contract" change. A PR that touches only one gate without the parity test should fail review.

## Verification

The bug: a push touching only `public/operator-stream.js` was filtered out by the outer gate; the inner gate never ran; no release, no error, no log. The fix adds `public/**` to both gates plus the parity test above. Merging it (PR #103) immediately triggered release `2026.06.46`, which carried both the `#103` fix and the previously-unshipped `#86` fix.

## Related

- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — the sibling "green ≠ shipped" lesson at the rendered-surface level.
- `docs/solutions/build-errors/web-bundle-server-import-boundary-2026-07-04.md` — sibling "local green ≠ image build" failure, where a web→src import broke the Docker release build.
- PR #103 (this fix), PR #97 (the prior Dockerfile/pnpm-workspace release-build gap — the first of the release-config-vs-image pair).
