---
date: 2026-10-20
topic: wiki-editor-in-dashboard
---

# Wiki editor in the dashboard

## Summary

The dashboard gets a wiki page list and an in-place editor. Saving commits the page to `fro-bot/.github:data` as Fro Bot and starts the promotion. The page publishes when the operator merges the promotion PR. The write path runs inside the dashboard server. There is no separate writer service.

---

## Problem Frame

The Fro Bot wiki is generated and published from `fro-bot/.github`. To fix a wrong page today, the operator has to file an issue and wait for a regeneration. The editable-wiki work in fro-bot/.github (requirements R1–R18 in `docs/brainstorms/2026-08-29-editable-wiki-path-requirements.md`) defines an editing path for the operator. Its dashboard half was never built.

Write authority sits in the dashboard server, scoped to the single operator. The operator is the only user and signs in to the dashboard, so a separate writer service would add a service, a secret, an internal auth scheme, a replay store and an incident surface without isolating anything the operator does not already hold.

---

## Actors

- A1. Operator: the single authenticated dashboard user. Opens a page in the editor, edits it, and saves.
- A2. Fro Bot: the GitHub App identity that commits to `data` and dispatches the promotion.
- A3. Wiki pipeline (fro-bot/.github): regenerates pages, keeps marked corrections, checks promotions for private content, and publishes `main` to Pages.

---

## Key Flows

- F1. Correct a page
  - **Trigger:** The operator picks a page from the dashboard wiki list, or follows the published wiki's Edit link once fro-bot/.github enables it.
  - **Actors:** A1, A2, A3
  - **Steps:** The editor opens on the page's raw Markdown and shows the page's corrections. The operator edits, marks the corrected spans, and saves. The dashboard checks that the operator is allowed, runs the write gates, commits to `data` as Fro Bot, and dispatches the promotion. The editor shows the save as pending publication and links to the promotion PR.
  - **Outcome:** The change is on `data`, the open `data`→`main` promotion PR includes it, and it publishes once the operator merges that PR.
  - **Failure paths:** rejected, conflict, failed, gate-contract rejected, status unknown, saved but not promoted, and promotion blocked (R13).
  - **Covered by:** R1–R14

---

## Requirements

**Finding and opening a page**

- R1. The dashboard lists the wiki pages that can be edited. Each opens the editor for that page.
- R2. The editor's page route is the deep-link target for the published wiki's Edit link. It accepts a return link only to allowlisted same-origin targets. (Upstream R1.)

**Editing**

- R3. The editor works on the page's raw Markdown body, with no WYSIWYG conversion. Frontmatter is system-owned. The editor does not accept it, and a save keeps it. (Upstream R2, R3.)
- R4. The operator marks the spans being corrected. Only marked corrections survive regeneration. The editor says so at all times. If a save includes unmarked changes, the operator must confirm before it goes ahead. (Upstream R8.)
- R5. The editor lists the page's corrections with their status. It shows when a correction no longer matches the page, and lets the operator retire a correction or flag it for reconfirmation. A page with no corrections shows an empty state. (Upstream R10, R11.)
- R6. Editing is entered explicitly. Cancel asks whether to keep or discard the draft. Navigating away with unsaved changes is guarded. A draft survives a reload, a rejection, and a conflict, and is cleared by a successful save. A restored draft shows which page version it started from. (Upstream R15, R18.)

**Saving**

- R7. Every save first checks that the shared gate contract version matches upstream. It then runs the shared wiki write gates (lint, rendering policy, sanitization) before committing. Any rejection commits nothing. (Upstream R4, R5, R12.)
- R8. A save commits only if this page has not changed since the editor loaded it. Commits to other pages on `data` do not count as a conflict. On a conflict, the operator gets a compare-and-merge view and an explicit overwrite. (Upstream R7.)
- R9. Saves and promotion dispatches require an authenticated session whose identity matches the configured operator. They fail closed when the identity is missing or different. They also require a same-origin request with CSRF protection and a rate limit. (Upstream R7, R13.)
- R10. Fro Bot makes the commit. The server records the operator's identity and an operation ID in the commit. Neither is ever taken from the request. (Upstream R6, R9.)
- R11. The server derives the write path from an existing page ID and checks it against an allowlist of wiki pages and the corrections record on `fro-bot/.github:data`. Traversal, absolute paths, and unknown IDs are rejected before any gate runs.

**Publishing and outcomes**

- R12. After a successful commit, the dashboard sends the `promote-data` repository dispatch that `merge-data.yaml` listens for, with no operator-supplied payload. The editor shows the save as pending publication and links to the promotion PR. Merging that PR remains a manual step. (Upstream R16.)
- R13. The editor reports each outcome separately. (Upstream R17.)
  - **Saved, pending publication:** the change is committed.
  - **Rejected:** with the gate findings.
  - **Conflict:** see R8.
  - **Failed:** nothing was committed, and the save can be retried.
  - **Gate-contract rejected:** the upstream gate version differs, or its marker cannot be read.
  - **Save status unknown:** see R14.
  - **Saved, not promoted:** the dispatch failed. Retry dispatch sends it again without committing again.
  - **Promotion blocked:** the promotion's privacy check failed, and the editor shows the reason.
- R14. A save whose commit state is unknown is not retried automatically. When the editor reopens the page, it looks for the save's operation ID in the commit history. If the commit is missing, it restores the draft with Save again. If the commit is present, it shows the save as done.
- R15. While a save is running, Save is disabled and the editor shows that it is saving. A rate-limited save gets its own message.

**Authority and structure**

- R16. The write path runs in the dashboard server. Each write uses a Fro Bot App token scoped to `fro-bot/.github` with contents write only.
- R17. No separate writer service exists. The repository has no writer workspace, no internal HMAC auth or replay store, no writer image or Dockerfile COPY lines, and no writer secret.

  `@fro.bot/wiki-write-core` moves into the root dependencies. In the same change, AGENTS.md invariant 1 and its accepted-cost text are rewritten to describe the dashboard's write authority, scoped to the single operator.

- R18. Saving works in production gateway mode and in the local fixture harness, where a fake write target stands in for GitHub. Signed-cookie session mode does not support saving.

---

## Acceptance Examples

- AE1. **Covers R7.** Given an edit that breaks the rendering policy, when the operator saves, the editor lists the gate findings, nothing is committed, and the draft stays.
- AE2. **Covers R8, R6.** Given this page changed on `data` after the editor opened, when the operator saves, the editor shows a conflict with both versions to compare and merge. The draft is kept, and committing over the newer page needs an explicit overwrite.
- AE3. **Covers R8.** Given other pages on `data` changed while the operator edited, when the operator saves, the save commits normally.
- AE4. **Covers R12.** Given a successful save while a promotion PR is already open, the save joins that PR. The editor shows it as pending publication with a link to the PR.
- AE5. **Covers R14.** Given the commit request times out with no answer, the editor shows "Save status unknown" and does not retry. Reopening the page shows the save as done if the commit landed. If it didn't, it offers Save again with the draft restored.
- AE6. **Covers R13.** Given the commit succeeds and the dispatch call fails, the editor shows "Saved, not promoted" with a retry-dispatch action that does not commit again.
- AE7. **Covers R4.** Given an edit with unmarked changes, when the operator saves, the editor asks for confirmation and states that unmarked changes will be lost at the next regeneration.
- AE8. **Covers R9.** Given a valid gateway session for an identity other than the configured operator, a save is refused and nothing is committed or dispatched.

---

## Success Criteria

- The operator corrects a wrong wiki page from the dashboard, merges the promotion PR, and the fix appears on the published wiki. No issue is filed and nothing waits for a regeneration.
- A marked correction survives the next regeneration.
- There is no writer service or secret to deploy. The infra changes are limited to:
  - a second App key secret in the dashboard environment;
  - its read-only mount;
  - the environment variable that points at it;
  - the deploy payload field that publishes it.
- Planning can derive every unit from R1–R18 and the upstream requirements without inventing editor behaviour.

---

## Scope Boundaries

- Turning on the Edit link on the published wiki. fro-bot/.github turns it on after the dashboard editor ships.
- The unauthenticated wiki's behaviour, which stays unchanged (upstream R14).
- Creating, renaming, or deleting wiki pages. The editor only corrects existing pages.
- Any GitHub write other than wiki pages and corrections on `fro-bot/.github:data` and the promotion dispatch.
- Merging the promotion PR automatically.
- A rendered preview in the editor.

---

## Key Decisions

- **The dashboard holds write authority.** The operator is the only user and signs in to the dashboard. An isolated writer service adds a service, a secret, and an incident surface without changing who can edit, because a compromised dashboard could call it anyway. Binding writes to the configured operator identity (R9) is what scopes that authority to the operator.
- **Commits come from Fro Bot through a scoped App token.** This keeps the `data` branch's single-writer model and upstream R6. The promotion is a repository dispatch, so contents write is the only permission needed.
- **The editor follows the full upstream spec (R1–R18).** That includes durable drafts, compare-and-merge, and every outcome the write path can produce.
- **Every save dispatches the promotion.** Saves made while a promotion PR is open land in that same PR, so frequent saves do not open extra PRs.
- **The editor shows raw `data` content without redacting private repo names.** The operator owns those repos. Placeholders would round-trip into commits. The promotion's private-content check is the boundary that keeps private names off `main`, and a failure surfaces as "Promotion blocked".
- **Indeterminate saves are resolved from the commit history.** The editor looks up the operation ID trailer instead of keeping an operation ledger.
- **The conflict guard is per page.** `data` takes frequent pipeline commits, so a branch-wide guard would make conflicts routine.
- **Saving is not supported in signed-cookie session mode.** Production runs gateway mode, and the fixture harness covers local verification.

---

## Dependencies / Assumptions

- Infra adds the Fro Bot App private key to the dashboard as a second key alongside the existing read key. The current deploy publishes a single key slot and accepts a fixed set of payload fields, so it needs a new secret, mount, environment variable, and payload field.
- The Fro Bot App installation covers `fro-bot/.github` with contents write. `merge-data.yaml` already mints Fro Bot tokens with contents write and listens for the `promote-data` repository dispatch.
- `@fro.bot/wiki-write-core` (pinned in `package.json`) supplies the gates, the gate contract, and corrections handling.
- The configured operator identity is available to the dashboard in gateway mode.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4, R5][Design] How span marking works: the gesture, the visual state, how to unmark, and whether marks are text anchors or offsets. Also, where `pageNodeId` and correction IDs come from.
- [Affects R8][Design] The compare-and-merge layout, and how marks carry through a merge.
- [Affects R2][Needs research] The Edit deep-link URL and return-link contract, which is shared with fro-bot/.github's wiki pages.
- [Affects R6][Technical] Where drafts are stored on the client, and whether they clear on sign-out.
- [Affects R12][Needs research] How the dashboard finds the open promotion PR, including when the dispatch has not created it yet. How a `merge-data` run cancelled by a newer dispatch affects the PR.
- [Affects R9][Technical] Where the configured operator identity comes from in gateway mode.
- [Affects R7][Technical] Where gate findings point in the text, and whether gates run only on save.

---

## Sources / Research

- Upstream requirements: `fro-bot/.github` `docs/brainstorms/2026-08-29-editable-wiki-path-requirements.md` (R1–R18) and plan `docs/plans/2026-08-29-001-feat-editable-wiki-path-plan.md`.
- Earlier dashboard plan: `docs/plans/2026-08-31-001-feat-operator-wiki-editor-plan.md`. It assumes the separate writer service and pnpm, so use it as background only.
- Write-path code: `src/wiki/write-operation.ts` (gates, commit flow, outcome states, page-blob guard, trailer reconcile), `src/wiki/data-client.ts` (target allowlist), and `src/wiki/gate-contract.ts` (contract check).
- Promotion workflow: `fro-bot/.github` `.github/workflows/merge-data.yaml` (`repository_dispatch` type `promote-data`, privacy checks).
- Infra key and deploy pattern: `marcusrbrown/infra` `apps/dashboard/AGENTS.md` (App key at `/run/secrets/github-app.pem`) and `remote-deploy.ts` (fixed payload fields).
