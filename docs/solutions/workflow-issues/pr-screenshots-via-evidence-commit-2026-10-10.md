---
title: Attach PR screenshots from the CLI by pinning an evidence commit
date: 2026-10-10
category: workflow-issues
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: low
applies_when:
  - A PR needs screenshots as evidence and the work is driven from the CLI or an agent
  - The repository is public
  - The images must not land on the default branch
tags: [pull-request, screenshots, evidence, gh-cli, raw-githubusercontent, agent-workflow]
---

# Attach PR screenshots from the CLI by pinning an evidence commit

## Context

A UI change needs screenshots in the PR description. The `gh` CLI has no attachment upload, and GitHub documents no API for its `user-attachments` image host. An agent or script cannot produce an inline image that way.

## Guidance

Commit the images to the PR branch, embed them by a raw URL pinned to that commit, then delete the files in a follow-up commit so the default branch's tree never carries them; under squash merge (as fro-bot/dashboard#599 landed) its history does not either.

```sh
# 1. Capture PNGs (fixture data only) and commit them to the PR branch.
mkdir -p docs/evidence/<feature>
cp /tmp/shots/*.png docs/evidence/<feature>/
git add docs/evidence/<feature>
# Review the staged set and look at every image before committing: public repo, permanent.
git diff --cached --name-only
git commit -m "docs(evidence): add <feature> screenshots for the PR"
EVIDENCE_SHA=$(git rev-parse HEAD)
git push

# 2. Embed in the PR body, pinned to the evidence commit (not the branch name).
#    https://raw.githubusercontent.com/<owner>/<repo>/$EVIDENCE_SHA/docs/evidence/<feature>/<name>.png

# 3. Remove the files before merge so the default branch's tree never carries them.
git rm -r docs/evidence/<feature>
git commit -m "docs(evidence): remove PR screenshots before merge"
git push
```

The pinned URL keeps resolving after the branch tip moves and after the PR is squash-merged. GitHub retains the PR's head ref (`refs/pull/<n>/head`), and the evidence commit is an ancestor of it. The same retention means removing the files does not purge them: anything committed stays readable at the pinned commit.

Worked example: fro-bot/dashboard#599. Commit `71a16fe` added six PNGs under `docs/evidence/operator-questions/`, and commit `a4338c4` removed them. After the squash merge, `refs/pull/599/head` still pointed at `a4338c4`, with `71a16fe` as its ancestor, and the URL pinned to `71a16fe` returned HTTP 200.

## Why This Matters

Inline evidence lets a reviewer see the rendered result without checking out the branch.

## When to Apply

- Public repository, fixture-only content. Images in a public repo are public, and the commit objects stay reachable through the PR ref, so treat them as effectively permanent. Capture fixture data only.
- Private repository: raw URLs require authentication and will not render for most viewers. Use the browser upload path instead.
- If the images are durable documentation rather than PR evidence, keep them on the default branch and skip step 3. marcusrbrown/panthea #134 (five PNGs under `docs/evidence/asset-studio/palette/`) and #104 (two under `docs/evidence/provider-settings/`) committed images this way and merged them.

## Related

- marcusrbrown/systematic#1073 (open) — a proposed skill for attaching screenshots to PRs.
- [Running the dev server for live verification](./dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md) — how to stand up the server the screenshots are captured from.
