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
  - The repository is public or private and the link form depends on its visibility
  - The images must not land on the default branch
tags: [pull-request, screenshots, evidence, gh-cli, raw-githubusercontent, private-repos, agent-workflow]
---

# Attach PR screenshots from the CLI by pinning an evidence commit

## Context

A UI change needs screenshots in the PR description. Instead of uploading them through the browser, a CLI workflow can embed images from a commit on the PR branch.

## Guidance

Use Systematic's [PR attachments skill](https://github.com/marcusrbrown/systematic/blob/main/skills/pr-attachments/SKILL.md). It commits images under `docs/evidence/` on the PR branch and links to that commit, not to the branch name. It checks the images before updating the PR description and offers to remove them from the branch before merge.

### Public repositories

The skill uses `https://raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>` and makes sure that the URL serves an image. That check does not test how GitHub displays the PR.

### Private repositories

The skill requires explicit permission to publish in a non-public repository. It uses `https://github.com/<owner>/<repo>/blob/<commit>/<path>?raw=true` for viewers who are signed in and have access. [Systematic's measurement](https://github.com/marcusrbrown/systematic/blob/main/docs/solutions/best-practices/commit-pinned-urls-publish-pr-evidence-images-2026-10-24.md) found that the blob link rendered in a private PR where the raw link did not. It did not test the private link after branch deletion.

The skill does not fetch private links anonymously. It uses the authenticated `gh` CLI to read the file's `.sha` from `repos/<owner>/<repo>/contents/<path>?ref=<commit>`. A matching blob SHA means that GitHub stored the approved file bytes at that commit. It does not prove that the PR displays the image.

## Why This Matters

Inline evidence lets a reviewer see the rendered result without checking out the branch.

## Cleanup and retention

Use fixture data. Inspect the images and their metadata before approving the push. The skill does not strip metadata. Cleanup removes the files from the branch tip but does not revoke access or erase history. Images in a private repository can become public if its visibility changes or a fork exposes them.

If the images are only PR evidence, remove them before a squash merge so the default branch's tree and history do not gain them. A merge that preserves the evidence commits can still bring the images into default-branch history. If the images are part of the documentation, keep them in the change instead.

In [dashboard PR #599](https://github.com/fro-bot/dashboard/pull/599), commit `71a16fe` added six PNGs and `a4338c4` removed them. The raw link to the evidence commit still served an image after cleanup and squash merge. That result does not guarantee that a future link will survive.

## Related

- [Running the dev server for live verification](./dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md) — how to stand up the server the screenshots are captured from.
