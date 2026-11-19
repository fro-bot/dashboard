---
date: 2026-11-19
topic: held-releases
---

# Held dashboard releases

## Summary

One pending release PR shows the dashboard changes ready to ship. The maintainer can approve it to release early. Scheduled releases run twice a week when the PR is green and the `release-hold` label is off.

---

## Problem Frame

An eligible merge to `main` can publish a new image and request a production deploy. Several changes in one day can produce several releases and deploy requests. The infra approval controls deployment, but it does not control when the dashboard publishes.

---

## Actors

- A1. Maintainer: Approves early releases, sets and clears the hold, and approves production deployment.
- A2. Dashboard release automation: Updates the pending PR, runs the scheduled gate, and merges and publishes authorized batches.
- A3. Infra deployment workflow: Receives the released version and digest and waits for the maintainer to approve deployment.

---

## Key Flows

- F1. Collect a batch
  - **Trigger:** A change merges to `main`.
  - **Actors:** A2.
  - **Steps:** Account for any batch still in publication. Compare against the last published release, assess what qualifies, and update the one pending PR.
  - **Outcome:** The PR shows what would ship. The merge itself does not publish an image.
  - **Covered by:** R1, R2.
- F2. Release a batch
  - **Trigger:** The maintainer approves the PR, or the scheduled window arrives.
  - **Actors:** A1, A2, A3.
  - **Steps:** Make sure that the candidate is current and green. Apply the approval rules for the trigger. Merge and publish that candidate, then request deployment of the published image.
  - **Outcome:** A batch that cannot merge stays pending. Publication and deployment request failures are reported separately.
  - **Covered by:** R3, R4, R5, R6, R7, R8.

---

## Requirements

**Pending batch**

- R1. Keep at most one pending release PR. Its changelog summarizes the unreleased changes that qualify under the current dashboard release policy. Docs-only and test-only changes that the policy excludes do not open a release PR by themselves.
- R2. Normal merges keep updating the batch without publishing. Changes that arrive after the release PR merges wait for the next batch. Resolve the current publication attempt before starting the next one.

**Release decision**

- R3. The maintainer's approval of the current green release PR authorizes automation to merge and publish it early, including during a hold.
- R4. The gate is scheduled for Sunday and Wednesday at 15:00 UTC. It can authorize at most one release per window without a maintainer review. It must establish that the exact candidate came from the release workflow. Only the generated release PR can merge automatically.
- R5. The maintainer controls the `release-hold` label on the release PR. The hold carries to the next batch until the maintainer clears it. The gate reads the hold again just before it merges. It records why it skips: a hold, no batch, non-green required checks, or an unknown candidate or hold state. A hold does not stop batch updates, close the PR, or undo a merge.
- R6. A candidate is the exact release PR revision and the `main` revision it targets. Required checks and authorization apply only to that candidate. If it changes before the merge, it needs fresh checks and authorization. Publication uses the source selected by the authorized merge, not a later `main` commit.

**Publication and deployment**

- R7. Publish one CalVer tag and one image for the merged batch through the existing smoke and vulnerability gates. If publication fails, report the failure. Recover by retrying the authorized batch or by including its unpublished changes in a newly authorized batch. Recovery must not duplicate a published release or bypass authorization.
- R8. After publication, request deployment of the exact version and immutable image digest. If the request fails, report it without invalidating the release. The maintainer can request deployment in infra without republishing. Production approval and paired dashboard and gateway deployment or rollback for operator contract changes stay in infra.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Two qualifying merges update the same PR and do not publish. A later docs-only change does not open a second PR. A docs-only change with no pending batch opens none.
- AE2. **Covers R3, R4, R5.** A green unheld batch can ship on schedule without a maintainer review. If the maintainer sets a hold before the final gate check, or the gate cannot establish hold state or candidate origin, it records the reason and skips. The maintainer can still approve a green held batch to ship early.
- AE3. **Covers R2, R6.** A qualifying change arrives after approval but before the release merge. The earlier approval cannot ship the refreshed candidate. If the change arrives after the merge, it waits for the next batch.
- AE4. **Covers R2, R7.** A batch fails its image smoke test while new work merges. No deployment starts and no change is lost. Recovery retries the authorized batch or combines the unpublished changes with new work under fresh authorization.
- AE5. **Covers R7, R8.** Publication succeeds but the infra request fails. The release stays published. The maintainer can request deployment of the same tag and digest in infra, with production approval still required.

---

## Success Criteria

- The maintainer can see what is queued in one PR and release a green batch without waiting for the schedule.
- The schedule ships a green batch at most once per window. A skipped window produces no release and records its reason.
- The released tag identifies the same source that passed the release decision. The published digest matches the infra deploy request.

---

## Scope Boundaries

- No change to how ordinary PRs merge, to CalVer, or to the production deployment and approval workflow in infra.
- No new release channels, separate hotfix branch, or change to how the dashboard and gateway coordinate contract versions. The early release path serves urgent fixes.

---

## Key Decisions

- Follow [Systematic's release policy](https://github.com/marcusrbrown/systematic/blob/main/RELEASING.md): show one candidate, allow early maintainer approval, and let a hold stop only the scheduled path. [Fro Bot Agent's release PR](https://github.com/fro-bot/agent/blob/main/.github/workflows/prepare-release-pr.yaml) is the batching precedent, not the hold policy.
- Preserve the boundary recorded in [gated-deploy requirements](2026-06-25-002-release-dispatches-gated-deploy-requirements.md) (status: requirements). A release PR controls publication, not production access.

---

## Outstanding Questions

### Deferred to Planning

- R1, R7. Choose the release baseline and changelog range. Keep the existing classifier coverage from `scripts/should-release.ts` and preserve it at cutover.
- R4–R6. Check live branch rules, required checks, and automation identities. Choose how the gate reads the hold and verifies candidate origin. Keep ordinary PRs outside the automated merge path.
- R6, R7. Prove how a merged release PR selects the exact source and how retries handle a partial publication. No manual publish path can bypass the release PR.
