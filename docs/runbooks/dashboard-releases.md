# Dashboard releases

Releasable changes on `main` collect in one `release/pending` pull request. Its notes show the changes ready to ship. An ordinary merge does not publish an image.

## Release a batch

Submit an **Approve** review after the pending pull request's required checks pass. Let the App merge the pull request; do not merge it yourself. The approval applies to that commit only. If the branch changes, review and approve it again.

If you approved while checks were still running, run Release Pending on `main` in `review` mode after they pass. This mode only rechecks the current approval.

To stop scheduled releases, add the `release-hold` label. The hold carries to the next pull request. To resume scheduled releases, remove the label. A current approval can release a held batch early.

The scheduled gate runs Sunday and Wednesday at 15:00 UTC. It skips a held batch or one that cannot merge. Read the Release Pending run summary for the reason.

The Release workflow publishes the exact squash commit from the pending pull request. It requests deployment of the published version and image digest. Production still requires approval in infra.

## Recover a failed release

The Release workflow cannot be started manually. If publication stops, open the Release run for the squash commit. Compare its commit, Git tag, GitHub Release, and image digest before you retry. A tag alone does not prove that publication finished. Do not rerun a completed release.

If the guard reports no associated pull request, make sure that GitHub now links the squash to the merged PR. If the publisher was skipped and no release exists for that squash, rerun the workflow for that commit.

If the image is published but the deployment request fails, request deployment in infra. Use the version and digest from the GitHub Release. Do not republish the image.

## First batch

Before the workflow change merges, make sure that all existing Release runs are complete and that the `release-hold` label exists. Leave the Release workflow enabled.

1. Make sure that the App opens one held `release/pending` pull request and that all required checks appear.
2. If the batch is ready to ship, approve its current commit while the hold remains on.
3. Make sure that the App squash starts Release for that exact commit and that the deployment request matches its digest.
4. If the release succeeds, remove the hold on a pending batch when scheduled releases can resume.
