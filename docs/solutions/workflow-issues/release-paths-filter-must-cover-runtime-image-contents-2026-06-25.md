---
title: Release path filters must cover everything the Dockerfile bakes in
date: 2026-06-25
last_updated: 2026-08-03
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Adding a Dockerfile COPY for a new runtime-affecting directory (e.g. public/, a future assets/)
  - Changing a static asset, browser client, manifest, or icon that ships baked into the image
  - Touching a release-gating surface (release.yaml on.push.paths, scripts/should-release.ts isHardReleasePath)
  - Changing a root package.json devDependency used to build web/dist (e.g. react or react-dom)
tags: [release, ci, paths-filter, dockerfile, image-contents, parity-test, dev-dependencies, release-classifier]
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

The same stale-artifact failure can hide behind `package.json`: the Docker builder installs root
`devDependencies` before running `pnpm build:web`, so classification must follow artifact effect,
not the dependency section name.

## Guidance

### 1. The release trigger is the full release contract

A release is needed for any change that can alter the shipped image or the decision to produce it—not
only a Dockerfile `COPY` input. The current contract includes:

- shipped source and static inputs: `src/**`, `web/**`, and `public/**`;
- image and build inputs: the `Dockerfile`, root `package.json`, `pnpm-lock.yaml`, and root `tsconfig.json`;
- release controls: the release workflow, release guard, and release-tag script.

These are categories, not a claim that every literal path is independently release-worthy; keep
the trigger set aligned with the actual build and release behavior.

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

The test array is the source of truth for the directory-glob subset only. Package and lockfile
classification has separate behavior tests; the parity array does not define those cases.

### 4. Classify devDependencies by artifact effect, not by section name

The shipped classifier in `scripts/should-release.ts` is deliberately fail-open:

- Narrow, explicitly proven tooling-only exceptions may skip a release; this document does not
  duplicate the classifier's exact allowlist.
- Artifact-affecting or unknown `devDependencies` trigger a release, including frontend
  dependencies and browser build tooling because either can change `web/dist`.
- Broad organization-scope allowlists are rejected. An org prefix is not proof that every future
  package under that scope is tooling-only; exceptions must be explicit.

The React regression is the concrete boundary: changing `react` or `react-dom` in
`devDependencies` must release. `test/should-release.test.ts` covers package and lockfile behavior,
including artifact-affecting and unknown dependencies, proven tooling-only exceptions, and
lockfile-only changes. A lockfile-only change fails open and releases because the installed graph
may change; a lockfile plus only proven tooling-only changes may skip.

## Why This Matters

A silently-skipped release is the most dangerous release failure mode: every signal is green — merge succeeded, CI green, branch protection satisfied — but the artifact in `ghcr.io` is stale. Verified, merged fixes never reach production, with no error, no log, no notification. It only surfaces when a downstream symptom forces someone to diff the image against `main`. This is strictly worse than a release that *errors* (a red CI status is visible) — and it is the second release-config-vs-image bug here (the first, PR #97, was a build-fail: the `Dockerfile` didn't `COPY pnpm-workspace.yaml`). Same root theme, release config drifted from image reality; the fixes differ.

The devDependency variant is the same stale-artifact failure: a package can be development-only by
section name while still feeding `web/dist`. Lockfile changes likewise fail open because they can
change the installed graph.

## When to Apply

- The `Dockerfile` gains a `COPY` for a new runtime-affecting directory the image bakes in.
- `isHardReleasePath()` is modified — update the parity test in the same commit.
- `release.yaml`'s `on.push.paths` is touched.
- A new trigger path is needed: add it to the parity-test array first, then to both gates.
- A root `package.json` devDependency used by the browser build changes — classify it explicitly,
  and fail open unless it is proven tooling-only.

Treat any of these as a "release contract" change. A PR that touches only one gate without the parity test should fail review.

## Verification

The bug: a push touching only `public/operator-stream.js` was filtered out by the outer gate; the inner gate never ran; no release, no error, no log. The fix adds `public/**` to both gates plus the parity test above. Merging it (PR #103) immediately triggered release `2026.06.46`, which carried both the `#103` fix and the previously-unshipped `#86` fix.

The dependency incident was reproduced on August 3, 2026: release run `30781898156` skipped the
React update because it classified the `package.json` change as dev-only; the workflow was green,
but its Release and infra-dispatch jobs were skipped. PR #291 fixed the guard to fail open for
unknown or artifact-affecting `devDependencies`, and release `2026.08.1` shipped that previously
skipped React update together with the guard fix.

## Related

- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — the sibling "green ≠ shipped" lesson at the rendered-surface level.
- [Web bundle must not import from the server src tree](../build-errors/web-bundle-server-import-boundary-2026-07-04.md) — sibling "local green ≠ image build" failure, where a web→src import broke the Docker release build.
- PR #103 (this fix), PR #97 (the prior Dockerfile/pnpm-workspace release-build gap — the first of the release-config-vs-image pair).
