# Dashboard releases

A batch is the releasable work since the last published dashboard image. The `release/pending` pull request lists the batch. Merging an ordinary pull request updates the batch without publishing it.

## Release a batch

Review the notes and wait for the required checks. Approve the generated pull request to publish early. Do not merge it directly. The Held Release workflow verifies the approval and merges the approved revision.

The scheduled gate runs Sunday and Wednesday at 15:00 UTC. It can release a current, green batch without an approval. If the pull request has `release-hold`, the gate skips it. The hold stays in effect until you remove the label. You can still approve a held batch early.

An approval applies to the current head and base revisions. If `main` advances, review and approve the refreshed pull request. GitHub can replace a pending release run with a newer eligible run. If GitHub drops the review signal, run Held Release from `main` to reconsider a current approval. A missed schedule does not grant permission to publish outside that window.

## Recover a publication

A digest identifies the exact container image. The run summary identifies the selected source, version, and digest when they are known. The image does not go out until the smoke test and Trivy pass.

If the merge response is lost, run Held Release from `main` as the maintainer. The workflow must find the original authorization and prove which commit GitHub merged. It cannot use the current `main` tip as a substitute.

If publication stops partway through, keep the draft release, Git tag, image aliases, and Actions artifacts. Do not delete them to retry. If the evidence is incomplete or disagrees, reconcile those records before starting another batch.

The proof file on a GitHub Release lets a later batch verify a completed release after its Actions artifacts expire. It cannot authorize or recover an unfinished release.

The workflow does not request a deploy when it recovers a publication. If a deploy request is missing or unconfirmed, look up the exact version and digest in infra. Production deployment still requires approval in infra.

## Rehearse the cutover

Run these steps after the maintainer approves the cutover. During rehearsal the workflow can update the pending pull request, but cannot merge it, publish an image, or request a deploy.

1. Before merging the replacement, disable the legacy Release workflow, including manual runs.
2. Wait for all queued and running legacy releases to finish or reconcile them.
3. Record the last published release, its commit and image digest, and the successful image checks.
4. Make sure that the version tag, image aliases, and `latest` match the recorded release.
5. Merge the replacement with `HELD_RELEASE_ACTIVE` set to `'false'`. As the maintainer, run Held Release from `main` with **Prepare the pending release PR only** selected.
6. Make sure that the App opens one held pull request without a merge, publication, or deploy request.
7. Record the required checks, their providers, and the revision that GitHub evaluated.
8. While Held Release is disabled, verify that a maintainer review of the pending PR starts the controller without issuing a release token. A review of an ordinary PR must not start the controller.

If any evidence is missing or disagrees, keep release writes disabled. If the rehearsal passes, change `HELD_RELEASE_ACTIVE` to `'true'` in the Held Release workflow on `main`. Keep `release-hold` on the pending pull request. Approve the refreshed batch after activation. Review the published commit, image, proof file, and infra request before you clear the hold.

## Stop the workflow

If release automation must stop, set `HELD_RELEASE_ACTIVE` to `'false'` or disable Held Release in Actions. The hold stops only scheduled releases. A merge or publication in progress still needs reconciliation. Do not re-enable the legacy workflow.
