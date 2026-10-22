# Wiki Editor

The dashboard edits the `fro-bot/.github` wiki in place. A save commits to the `data` branch as the
Fro Bot App, then sends one `promote-data` repository dispatch. The promotion PR (`data` → `main`)
is merged by hand.

This runbook is the handoff for infra, the `fro-bot/.github` Edit-link task, and anyone debugging a
save. The security model is invariant 1 in `AGENTS.md`.

The wiki read routes serve only content that is already public on `fro-bot/.github`, a public repository whose `data` branch anyone can read, so they need a dashboard session but no operator identity match.

---

## Credentials and configuration

| Variable                                                  | Meaning                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DASHBOARD_FRO_BOT_APP_ID`                                | Fro Bot App ID. Single line. `_FILE` form supported.                                  |
| `DASHBOARD_FRO_BOT_APP_KEY` / `DASHBOARD_FRO_BOT_APP_KEY_FILE` | Fro Bot App private key (PEM, multiline). Production uses the `_FILE` form.      |
| `DASHBOARD_OPERATOR_ID`                                   | The operator's numeric GitHub ID. A positive integer. A set but invalid value stops startup. |
| `DASHBOARD_GATEWAY_OPERATOR_ORIGIN`                       | Existing setting. The origin a write request must come from. See below.               |

These are separate from `DASHBOARD_GITHUB_APP_*`, which stays read-only. The two Apps never share
a credential, a token cache, or a module.

**Write capability is off** unless the App ID, the key and the operator ID are all present. Reads
keep working. The page list and page read report `canWrite: false` with a reason code:

| Reason code                  | Cause                                         |
| ---------------------------- | --------------------------------------------- |
| `app-credentials-absent`     | Neither the App ID nor the key is set.        |
| `app-credentials-incomplete` | Exactly one of the two is set. Startup logs a warning. |
| `operator-id-unset`          | Credentials set, `DASHBOARD_OPERATOR_ID` unset. |
| `not-operator`               | The session's `operatorId` differs from the configured one. |
| `session-not-supported`      | A plain Arctic OAuth session. Only gateway sessions write. |

Write routes answer `403 {"state":"forbidden"}` for every refused chain step, so the response does
not say which check failed.

### Origin

A write request must carry an `Origin` header equal to the configured origin, exactly. A missing,
`null`, different-port or different-scheme value is refused. The `Host` header is never used.

The origin is `DASHBOARD_GATEWAY_OPERATOR_ORIGIN`. Production leaves it unset, so it defaults to
`https://dashboard.fro.bot`, which is the public dashboard origin. Set it only if the public origin
changes.

### Token scope

Each write mints an installation token on demand with `permissions: {contents: 'write'}` and
`repositoryNames: ['.github']`. GitHub returns `{contents: write, metadata: read}`. The token is
cached per process and refreshed shortly before expiry. Simultaneous requests share one lookup and one mint. When GitHub answers a write-path request with 401, the cached token is dropped, a new one is minted and that request is retried once. A second 401 is reported as a refusal.

Checked against the real App: that token can read the `data` ref, the open `data` → `main` PRs,
the `merge-data.yaml` runs, and a run's jobs and steps. Promotion status therefore needs no scope
beyond `contents: write`, and the infra handoff adds no App permission.

The App installation itself is broad (it includes `administration`, `secrets` and `workflows`
write). Only the mint-time `permissions` subset keeps a token narrow. The `data` branch and the
path allowlist are enforced in application code (`src/wiki/paths.ts`).

---

## Infra handoff

The change lands in `marcusrbrown/infra`. `apps/dashboard/src/remote-deploy.ts` uses payload v2
with exactly five named fields. An unknown field is rejected and a missing field fails. Publishing
a second key needs all of these:

- A new case branch for the new field in the payload reader.
- A seen flag for it, with duplicate detection.
- A required-field check that includes it.
- A size constant for it, counted in the total payload limit.
- A second publish step to a new active path, with its own allowlisted failure detail.
- The TypeScript payload type change.
- The compose read-only mount for the new path.

The field loop in the same file is hard-coded to five and must become six.

Then set three environment variables on the dashboard service:

- `DASHBOARD_FRO_BOT_APP_KEY_FILE`: the mounted key path.
- `DASHBOARD_FRO_BOT_APP_ID`: the Fro Bot App ID.
- `DASHBOARD_OPERATOR_ID`: the operator's numeric GitHub ID.

The Fro Bot App installation on `fro-bot/.github` must grant contents write. It already does,
because `merge-data.yaml` mints Fro Bot tokens with contents write.

Caddy's catch-all proxies to the dashboard without rewriting the path, so `/wiki/<id>` reaches the
server as sent.

---

## The `/wiki/<id>` contract

The `fro-bot/.github` Edit-link task links pages to the dashboard:

```text
https://dashboard.fro.bot/wiki/<id>
```

A page ID is `<directory>.<name>`:

| Page path                                  | ID                          |
| ------------------------------------------ | --------------------------- |
| `knowledge/wiki/repos/<name>.md`           | `repos.<name>`              |
| `knowledge/wiki/topics/<name>.md`          | `topics.<name>`             |
| `knowledge/wiki/entities/<name>.md`        | `entities.<name>`           |
| `knowledge/wiki/comparisons/<name>.md`     | `comparisons.<name>`        |

Example: `knowledge/wiki/repos/marcusrbrown--infra.md` is `repos.marcusrbrown--infra`.

- The directory is one of the four above. The name is the file name without `.md`.
- The name starts and ends with a letter or digit and holds only letters, digits, `.`, `_` and `-`.
  It never contains `..`. An ID is at most 200 characters.
- Pages only. Nested paths, `README.md`, `index.md`, `log.md` and `corrections.yaml` have no ID.
- The link takes exactly one path segment. A trailing slash, a nested path or an encoded slash is a 404.
- `/wiki` serves the page list. It is the only other wiki path the server serves a shell for.
- An unauthenticated visit signs in first, then returns to the page or the list. The return target is
  kept in a short-lived cookie that holds only `/wiki` or a valid `/wiki/<id>` path.

The server resolves an ID to a path by finding it in the current tree, never from client input.

---

## What a save does

One commit on `data` carries the page, the appended `knowledge/log.md` entry, the rebuilt
`knowledge/index.md`, and `knowledge/corrections.yaml` when the save marks, retires, flags or
reconfirms a correction. The commit message has two trailers: `Fro-Operation-Id` and `Fro-Operator`.
The commit sets no author or committer, so GitHub attributes it to the App.

Conflicts are per page: the page's blob SHA must match what the editor loaded. A moved head is
retried in the request a few times. Every save then dispatches `promote-data`. If the dispatch
fails, the save reports "saved, not promoted" and the editor offers a retry that sends only the
dispatch.

### Marking corrections

Only marked corrections survive the next regeneration of a page. In the editor, select text and
choose **Mark as correction**. The button follows the text area's selection, so it works from the
keyboard and by touch. A page without a `node_id` cannot be marked and says its edits will not
survive regeneration.

- A mark is a UTF-16 start and end plus the exact text with a short prefix and suffix. The text is what
  the server stores. The offsets are hints that the editor keeps current as the draft changes.
- The editor rebases the marks on every input event, using the caret and the inserted length the
  browser reports to place the edit when the text alone is ambiguous: typing a character over a
  selection that begins with the same character, for example. A paste reports no inserted length, so
  it is placed by the text alone. Text typed at the start or the end of a mark does
  not grow it; the typed text is unmarked. A mark grows or shrinks only for an edit inside its span,
  including typing strictly inside it or replacing exactly its text. An edit that crosses the edge of
  a mark clips the mark to what survives of its original span outside the edit and flags it *needs
  review*. An edit that covers the whole mark, such as deleting exactly its text, keeps the mark's
  text and flags it too.
- **The Keep rule**, for an edit and for a merge alike. A flagged mark is *needs review* only when its
  text stands at the offsets the mark records. **Keep** is offered only then, and it clears the flag
  without moving the mark, so a kept mark is the span the operator marked and never another
  occurrence of the same words. Any other flagged mark is *missing*, even where its words stand
  elsewhere: it cannot be kept, and no later edit or merge searches for its text and places it there.
  An edit leaves it where it is if its text stands at its own offsets now, as when an undo brings the
  text back, and otherwise it is *unplaced*. A mark whose text has left the draft is *missing* too.
  Save waits until each *missing* mark is removed and each *needs review* mark is kept or removed.
  When the same words also stand elsewhere with a closer match to the mark's surrounding text, a
  flagged mark can show as *missing* even at its own place. Remove it and mark the text again.
- On Save, a changed draft is compared with the page it started from, line by line and then word by
  word. A draft whose changes all fall inside marked spans saves without a question. A change
  outside every mark asks for confirmation. So does a deletion unless one mark surrounds the gap,
  with marked text on both sides of it: a mark that only touches one edge of the gap does not cover it.
  A save that only carries staged correction actions, with the body unchanged, skips the check.
- The corrections panel lists the page's corrections with their status. **Retire** and **Flag for
  reconfirmation** are offered on an active correction and **Reconfirm** on a flagged one. They are
  staged in the draft, shown as staged, can be undone, and are committed with Save. A save carries at
  most 100 staged actions, and the panel says so when a 101st is refused. A staged action whose
  correction has changed or gone when the page is read again is dropped with a notice.
- When a save is rejected because a marked correction is no longer in the page
  (`correction-eroded`), the finding names the correction and offers **Retire this correction**.
  Staging the retire lets the next save pass.

Drafts are schema version 2. A version 1 draft is read as a version 2 draft with no marks and nothing
staged, and is written as version 2 the next time it is saved to the device.

Detection of the marked spans takes about 50 ms for scattered edits on a 512 KB page. A diff's cost
grows much faster than its input, so each stage is sized first (`web/src/wiki/unmarked.ts`), and a
draft over any budget is not compared:

| Budget | Limit | Catches |
| ------ | ----- | ------- |
| `MAX_LINE_WORK` | 1 billion: matching line pairs times the larger line count | pages dense with blank lines or repeated separators, and pages of tens of thousands of short lines |
| `MAX_DIFF_AREA` | 200 million (base characters times draft characters) for one block | a whole-page rewrite that also adds or removes a line, a single 512 KB line |
| `MAX_TOTAL_DIFF_AREA` | 400 million over all blocks | many changed blocks that each fit |

The editor then says it could not check which changes are marked, and Save asks for the
unmarked-changes confirmation. `web/src/wiki/unmarked.measure.test.ts` asserts which shapes land
there; it does not assert elapsed time.

### Resolving a conflict

A conflict names its kind and keeps the draft.

- **Page changed.** The editor loads the current page and merges three texts line by line: the draft
  (mine), the page text the draft started from (base) and the current page (theirs). Each line keeps
  its terminator, so the merged text is exact. A change only one side made is applied. A change both
  sides made identically is applied once. Where both sides changed the same lines differently, or
  neighbouring lines, the change is a hunk with a heading, both versions as plain text, and **Accept
  mine** and **Accept theirs** buttons. They are native buttons in tab order. One polite status
  region announces each resolution once, and focus does not move. **Use merged text** is enabled
  when every hunk is resolved, or at once when there are none.
- **Use merged text** makes the merged text the draft, sets the page base to the current blob and
  text, and sets the corrections base to the current page's entries. A staged action whose correction
  has changed or gone is dropped with a notice. A recorded unmarked-change confirmation is cleared, so
  the next Save asks again. A draft that is identical to its base takes the current page wholesale.
- **Overwrite with my draft** stays available behind a confirmation. It keeps the draft text and moves
  the base to the current page.
- A merged save that hits another page conflict merges again, from the base the first merge set.
- **Corrections changed.** The view shows the base entries against the current ones. Overwrite moves
  the page and corrections bases together and drops staged actions the new entries no longer allow.
- **Page removed.** The page is no longer in the wiki. Save stays disabled, the draft is kept on the
  device, and **Copy draft** copies it out. The draft stays in the list's "Drafts without a page"
  section, and opens read-only, until the operator discards it.

#### Marks through a merge

`web/src/wiki/remap-marks.ts` places each mark by the merge's stretches, which record whether each
range of the merged text came from mine, base or theirs. Offsets are UTF-16 code units.

- A mark entirely inside one unbroken run of text taken from the draft, whether the draft changed it
  or left it as the base had it, moves with that run. Its text is read back at the new position and its
  prefix and suffix are read again from the merged text.
- Every other mark is left *unplaced*: flagged, with the text it was made on and no position. That is
  a mark that touches text taken from theirs, one whose lines the merge dropped, one in a hunk resolved
  as theirs, one whose text does not verify at the new position, one that was not in the draft's text
  to begin with, and a flagged one that was not at its own offsets in the draft. An unplaced mark is
  stored with its end at the largest safe integer, which no text has, so the draft schema is
  unchanged. It follows the Keep rule above and is never sent. The panel offers only **Remove**, and
  the operator marks the text again.
- A mark that was already flagged and is carried stays flagged, and can be kept.

#### Pages too large to compare

A line diff costs about the number of matching line pairs times the number of lines, and a page with
many identical lines, such as blank ones, has pairs that grow with the square of its length. The
merge sizes its work first (`mergeWork` in `web/src/wiki/merge.ts`): matching pairs times lines,
summed over the three diffs a merge runs. A merge costs roughly 0.4 to 1 ns per unit across shapes, so
`MAX_MERGE_WORK` (1.5 billion) is about 0.6 to 1.5 s on the measuring machine.

A page over the budget shows one whole-page change: nothing is diffed, and the operator takes the
draft or the current page. Taking the current page flags every mark and leaves it unplaced, because no line is carried.
A draft identical to its base takes the current page without a question.

- Paragraph prose with a blank line between paragraphs reaches the budget at about 140 KB.
- At 512 KB, only a page whose lines average about 23 bytes or more stays under it. Short-line and
  blank-line-heavy pages are one change at that size.
- Pages of distinct lines under the budget, with edits on both sides, merge line by line in about
  0.1 s at 512 KB.

`web/src/wiki/merge.measure.test.ts` asserts which shapes land where; it does not assert elapsed time.

### Two tabs on one page

Editing the same page in two tabs at the same time is not supported. The tabs share one local draft
per page, so unsaved text in one tab can be replaced or removed by the other. Commits stay safe:
the server checks the page's blob SHA, so a stale save becomes a conflict instead of overwriting.

### Cold and warm reads

A snapshot lists the whole `data` tree in one request and reads only the blobs the gates need:
everything under `knowledge/` and `metadata/repos.yaml`. A content-addressed blob cache spares
refetching unchanged blobs.

| Read | Requests | Wall time |
| ---- | -------- | --------- |
| Cold | 56       | about 3.5 s |
| Warm, head unchanged | 3 | about 0.7 s |

Measured against the real repository. The cold read dominates the first page open after a deploy.

### A save that is not found yet

A save-status check reads GitHub's path history, which can lag behind a commit that just landed. If a
save that was just made is not found yet, saving again may show a conflict with that save, so check
the page before overwriting.

### Rate limits

Writes and save-status lookups share one per-operator limit, below the per-IP limit. A trip answers
the rate-limited outcome with a retry hint. GitHub rate limits surface the same way.

### Weekly backstop

`merge-data.yaml` also runs on a weekly schedule. A save whose dispatch failed is therefore
promoted by the next scheduled run: a failed dispatch is not data loss.

---

## Promotion status

Status is read from the open `data` → `main` PR and the newest `merge-data.yaml` run, of any event
type. The privacy checks run as steps inside that run, so a blocked promotion is a failed run, not
a PR check. One status read costs at most three GitHub requests, and the server caches a result
for a few seconds.

| Newest run                          | State                   |
| ----------------------------------- | ----------------------- |
| queued or in progress               | pending                 |
| `cancelled`, `action_required`, `stale` | pending             |
| `success`, `neutral`, `skipped`     | settled                 |
| `failure`, `timed_out`, `startup_failure` | blocked           |
| no run yet                          | pending                 |

A cancelled run is pending because a newer dispatch cancels the run in progress. Runs created
before the save's commit time are ignored, so an older failure cannot answer for a newer save.
Blocked belongs to the `data` branch, not to one save: a later successful run clears it.

### Reading "Promotion blocked"

The reason comes from the failed step's name, ignoring a leading symbol. Unknown names read as
`unknown`. The response carries the reason code and a link to the run, never log text.

| Failed step                                       | Reason               |
| ------------------------------------------------- | -------------------- |
| `🔒 Block private wiki pages`                     | `private-page`       |
| `🔒 Block private repo names in promotion diff`   | `private-repo-name`  |
| `🔒 Fetch data ref for promotion diff`            | `promotion-diff`     |
| `⤵ Fetch data branch for privacy check`           | `privacy-check`      |
| `🔁 Merge main into data`                         | `merge`              |
| `🔀 Open data merge PR`                           | `open-pr`            |
| anything else                                     | `unknown`            |

Example: runs 35545734311 and 34790889509 both failed at `🔒 Block private wiki pages`.

To clear a block, read the run, fix the page the step names, and save again.

"Promotion status unavailable" means a transient read error: network, timeout, 5xx or a GitHub
rate limit. A 401, 403 or 404 on the status reads is a configuration fault. It is logged at error
level and returned as `configuration-fault`.

---

## Gate contract

Before opening a page and on every save, the dashboard compares the gate-contract version of its
`@fro.bot/wiki-write-core` dependency with the marker published on `fro-bot/.github` `main`
(`packages/wiki-write-core/dist/gate-contract.json`). The marker is cached
(`GATE_CONTRACT_CACHE_TTL_MS`). If a refresh fails, a cached marker is used up to
`GATE_CONTRACT_STALE_CEILING_MS`.

| Outcome        | Meaning                                              | Retry | Fix |
| -------------- | ---------------------------------------------------- | ----- | --- |
| `ok`           | Versions match.                                      |       |     |
| `mismatch`     | The dashboard's gates differ from the control plane's. Saves answer HTTP 424 and make no GitHub write call. The editor keeps the draft. | No | Update the `@fro.bot/wiki-write-core` dependency to the version the control plane publishes, then deploy. |
| `unreadable`   | The marker could not be fetched or parsed, and no usable cached marker exists. HTTP 424. | Yes | Check that `raw.githubusercontent.com` is reachable and the marker file exists on `main`, then retry. |

A mismatch cannot be fixed by retrying. An unreadable marker clears itself when the fetch works again.

---

## Local development: `dev:fixture`

`bun run dev:fixture` serves the fixture build against an in-memory repository. It needs no GitHub
credential and makes no network request. The script sets what the write path needs:

- `NODE_ENV=development` and `DASHBOARD_HOST=127.0.0.1`: the fixture harness refuses anything else.
- `DASHBOARD_FIXTURE_HARNESS_ENABLED=true` and `DASHBOARD_DEV_AUTOLOGIN=true`.
- `DASHBOARD_OPERATOR_LOGIN=fixture-operator`: autologin mints no session without it.
- `DASHBOARD_COOKIE_KEY`: a throwaway key generated on each start.

The expected origin in fixture mode is the loopback origin the server binds to:
`http://127.0.0.1:<DASHBOARD_PORT>` (port 3000 by default). Open the app at that exact origin.
`http://localhost:<port>` fails the `Origin` check.

Only the Git Data transport is fake. The routes, gates, write operation and promotion reader are
the production code.

Each fault fires on the first save of its page, lets the following saves through, and arms again
after the next save that goes through. Restarting resets everything.

| Page ID                                | First save                                                        |
| -------------------------------------- | ----------------------------------------------------------------- |
| `repos.fixture--plain`                 | Saves. Has a `node_id` and one active correction. Status reads pending, then settled. |
| `comparisons.fixture-a-vs-b`           | Saves.                                                            |
| `topics.fixture-no-node-id`            | Saves. No `node_id`, so no marks.                                 |
| `topics.fixture-conflict`              | Page conflict: another writer changed the page.                   |
| `repos.fixture--page-conflict`         | Page conflict on a page with a `node_id`, so it takes marks. The other writer inserts a line above the paragraphs and changes the middle line: a mark in an untouched paragraph moves with its text, an edit to the middle line overlaps. |
| `repos.fixture--corrections-conflict`  | Corrections conflict, for a save that carries a mark or transition. |
| `topics.fixture-timeout-landed`        | Timeout; the commit landed. Lookup finds it.                      |
| `topics.fixture-timeout-lost`          | Timeout; the commit did not land. Lookup reports missing.         |
| `topics.fixture-dispatch-failure`      | Saved, not promoted. The retry dispatch succeeds with no second commit. |
| `topics.fixture-blocked`               | Saves; the promotion then reads blocked, reason `private-page`.   |
| `topics.fixture-contract-mismatch`     | Contract mismatch on every save.                                  |
| `topics.fixture-contract-unreadable`   | Contract unreadable once.                                         |
| `topics.fixture-rate-limit`            | GitHub rate limit with a retry hint.                              |
| `topics.fixture-failed`                | Retryable write failure; nothing is committed.                    |
| `topics.fixture-rejected`              | Rejected by a real gate: the page holds an inline frame. Remove the line and save. |
| `entities.fixture-vanishes`            | The page is removed first: page-removed conflict. It returns on the next list read. |

The fixture cannot prove GitHub's own status codes or response shapes. The first real save does.

---

## Closing check

After the infra change is live, save one real correction. Confirm the commit lands on `data` with
both trailers and the App's attribution, the promotion run starts, and the promotion PR shows the
change. Merge the PR by hand. This is the only check that proves the real credential, the ruleset
bypass, the dispatch and the privacy-check read together.
