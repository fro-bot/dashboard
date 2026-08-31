---
title: An action's default output mode silently discarded every agent fix for two weeks
date: 2026-08-31
category: workflow-issues
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Wiring an agent action that can edit files into a scheduled workflow
  - An automation reports fixes as applied but nothing ever lands
  - An action exposes a delivery, output, or result mode input
  - Auditing whether a bot's reported work actually reached the repository
symptoms:
  - "Daily runs report changes 'applied to the working tree, pending PR from caller' and no PR ever appears"
  - "The identical one-line fix is re-applied and re-reported on consecutive days"
  - "The bot has authored zero pull requests and pushed zero branches, despite weeks of successful runs"
  - "Every job is green; no failed step, no missing artifact, no alert"
root_cause: config_error
resolution_type: config_change
tags:
  - github-actions
  - fro-bot
  - workflow
  - output-mode
  - silent-failure
  - automation
---

# An action's default output mode silently discarded every agent fix for two weeks

## Context

`.github/workflows/fro-bot.yaml` invoked `fro-bot/agent` without setting its
`output-mode` input. Omitting it selects `auto`, which for `schedule` and
`workflow_dispatch` resolves to `working-dir`.

`working-dir` carries a caller-side contract: the agent edits the checked-out
tree, and the *calling workflow* is responsible for detecting the diff,
committing, pushing, and opening a PR. This workflow had no such step — the file
ended at the agent invocation.

Every auto-heal fix was discarded at runner teardown. For at least two weeks.

The reason it survived that long is that **nothing looked wrong**. The job
succeeded. The daily report issue was filed and stated the fixes had been
applied. There was no failed step, no missing artifact, no alert. The agent's
zero exit status proved only that execution finished, not that its edits escaped
the runner.

The cost was not hypothetical. The same one-line CodeQL fix to
`web/src/styles/tokens.test.ts` was applied and lost on three consecutive days,
each reported as a success. A set of dependency overrides prepared by an earlier
run evaporated the same way and had to be redone by hand.

## Guidance

### Check for delivery evidence, not run status

One query settles it:

```sh
gh pr list --state all --json author \
  --jq '[.[] | select(.author.login == "fro-bot")] | length'
git ls-remote --heads origin
```

Zero authored PRs and zero pushed branches, after weeks of green runs, is
conclusive. Not a hint — proof that the delivery path does not exist.

Run this whenever an automation claims work it cannot show you.

### Read the action's input contract before trusting the prompt

The prompt does not control delivery. From `output-mode.ts` in the agent at the
pinned revision:

```ts
case 'auto':
  // `auto` remains a public compatibility value, but prompts are never
  // authoritative for the output mode.
  return 'working-dir'
```

The schedule prompt here explicitly instructed the agent to open PRs. It had no
effect, and could not have.

**General rule:** when an action exposes a delivery, output, or result mode, the
default is the conservative one. A prompt describes the work; the input decides
where the result goes. Assume they are unrelated until you have read the action's
`action.yaml`.

### Scope the mode to the triggers that need it

```yaml
output-mode: >-
  ${{
  (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')
  && 'branch-pr' || 'auto'
  }}
```

`resolveOutputMode` already returns `null` for `pull_request`, `issue_comment`,
`issues`, and `pull_request_review_comment`, so the input is inert on those
triggers and the conditional is a no-op today. Scope it anyway: it keeps the
guarantee in this workflow instead of depending on an upstream event-type switch
that can change, and it states the intent for the next reader.

This workflow now carries **two** conditionals keyed on the same event
classification — `output-mode` here and `persist-credentials` on the checkout
step (see the secondary finding below). They are coupled, and not obviously so:
`branch-pr` delivery pushes with the credential that `persist-credentials`
controls. Setting `persist-credentials: false` unconditionally looks like a
straightforward hardening win and silently breaks delivery, reintroducing exactly
the failure this document exists to describe. Change one, re-read the other.

## Why This Matters

At the pinned commit, `packages/runtime/src/agent/output-mode.ts:6-14` returns
`null` for every non-scheduled event:

```ts
case 'discussion_comment':
case 'issue_comment':
case 'issues':
case 'pull_request':
case 'pull_request_review_comment':
case 'unsupported':
  return null
```

For `schedule` and `workflow_dispatch`, `auto` falls through to `working-dir`
(`:16-26`). The action's own `action.yaml:20-26` says it plainly: *use
`branch-pr` explicitly when branch/PR delivery is required.*

Under `branch-pr`, `packages/runtime/src/agent/prompt.ts:152-159` injects a
delivery preamble granting branch creation, commit, push, and PR open/update.
That preamble is gated at `prompt.ts:171-173` on both the event type and a
non-null resolved mode.

The trap generalizes past this action. Any tool that separates *doing the work*
from *delivering the work* can succeed at the first while silently skipping the
second, and every status signal will agree that it worked.

## When to Apply

- Adding an agent or bot action that edits files to a scheduled workflow
- An automation's reports and the repository's actual history disagree
- Reviewing why a recurring automated fix never seems to land

## Examples

### Before

The `Run Fro Bot` step ended at the agent invocation, with no `output-mode` and
no caller-side delivery:

```yaml
        with:
          github-token: ${{ secrets.FRO_BOT_PAT }}
          auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}
          model: ${{ vars.FRO_BOT_MODEL }}
          opencode-config: ${{ secrets.OPENCODE_CONFIG }}
          prompt: ${{ env.TASK_PROMPT }}
```

### After

`.github/workflows/fro-bot.yaml:316-324`:

```yaml
        with:
          github-token: ${{ secrets.FRO_BOT_PAT }}
          # Scheduled runs need branch-pr; this workflow has no caller-side PR step.
          # Scope it to those triggers so other events stay on auto.
          output-mode: >-
            ${{
            (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')
            && 'branch-pr' || 'auto'
            }}
          auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}
```

Watch the folded scalar. It must collapse to a single-line `${{ ... }}`
expression; an embedded newline breaks the syntax silently. Verify it:

```sh
python3 -c "import yaml;d=yaml.safe_load(open('.github/workflows/fro-bot.yaml'));\
s=[x for x in d['jobs']['fro-bot']['steps'] if x.get('id')=='fro-bot-agent'][0];\
print(repr(s['with']['output-mode']))"
```

### Verification

Do not wait for the next scheduled run to find out. `workflow_dispatch` resolves
to `branch-pr` under the same conditional, so it exercises the identical path:

```sh
gh workflow run fro-bot.yaml --ref main -f prompt="<narrow, single-file task>"
```

A narrow prompt targeting a known-good change makes success unambiguous. Here,
run `33422350695` produced PR #414 — the first `fro-bot`-authored PR in this
repository's history — carrying exactly the one-line fix that had been lost three
days running. It merged as `8f49fe5`.

Fixed in `d3f8778`, merged to `main` as `de3447c` (#413).

## Secondary finding: the review path is gated, and the gate leaked

Recorded here because it surfaced during this work, not because this change
caused it.

The first version of this section claimed the review-path write boundary was
purely instruction-only. That was wrong, and the correction is worth keeping
rather than quietly overwriting — the mistake was reasoning from one file instead
of following the credential end to end.

**What is actually gated.** `resolveCredential` classifies `pull_request`,
`issue_comment`, and `issues` as `withhold`, and the runs prove it:

```text
GitHub CLI credential withheld from child (affected trigger)
Delivered file-convention response
```

The agent genuinely does not receive a `gh` credential on review triggers, and
returns its review through a file convention rather than calling the API. There
is a real technical gate, and it works.

**What leaked past it.** `actions/checkout` ran with `persist-credentials`
defaulting to `true`, leaving a usable git credential in the workspace. `gh` was
withheld; `git push` would still have authenticated.

Upstream has a preflight built to catch exactly that and fail the run closed. It
reads with `git config --local --get-regexp`, and `actions/checkout` v6 no longer
writes `http.<url>.extraheader` into the local config — it writes a file under
`RUNNER_TEMP` and links it with `includeIf.gitdir`. `--local` does not expand
includes; git does that at resolution time:

```sh
git config --local --get-regexp '^http\..*\.extraheader$'   # exit 1, no output
git config --get-regexp '^http\..*\.extraheader$'           # prints the credential
```

The assertion reads clean while the credential still resolves. Fail-closed by
design, fail-open in practice.

**The fix.** Scope `persist-credentials` on the checkout step to match the
agent's own credential classification —
`.github/workflows/fro-bot.yaml`, merged as `db99162` (#416):

```yaml
          # Review-path triggers withhold credentials from the agent; don't leave one in the workspace.
          # Schedule/dispatch keep it because branch-pr delivery pushes with it.
          persist-credentials: >-
            ${{
            !contains(fromJSON('["pull_request", "issue_comment", "issues"]'), github.event_name)
            }}
```

Verified against live runs on both branches, timing taken from the `Checkout
repository` step:

| Trigger | `persist-credentials` | Credential during agent run |
| --- | --- | --- |
| `pull_request` | `false` | written, removed 1.8s later — gone 33s before the agent starts |
| `workflow_dispatch` | `true` | present throughout; `git push --dry-run` authenticates |

The dispatch half matters as much as the review half. On the run that produced
#414 the model pushed with plain `git push -u origin <branch>` and no
`gh auth setup-git` anywhere in the log — the persisted checkout credential is
what `branch-pr` delivery authenticates with. **Blanket
`persist-credentials: false` breaks delivery**, leaving `gh pr create` with no
branch to open against.

**What remains true from the original claim.** No tool allowlist or permission
gate is keyed on the resolved *output mode* — references to `resolvedOutputMode`
in `src/harness/phases/execute.ts` and elsewhere are result propagation and
reporting. `branch-pr` grants no capability; it only injects prompt text. The
capability boundary is the credential, which is why the credential is where the
fix belongs.

Filed upstream as `fro-bot/agent#1517`, since fixing the preflight covers every
consumer. The caller-side conditional works but requires each workflow to
hand-maintain a copy of the trigger classification, and drift there fails
silently in the unsafe direction.

## Related

- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`
  — the umbrella lesson: green signals do not prove the intended outcome exists.
  This is the same failure one layer out, where the gap is between *agent
  execution completed* and *agent output delivered*.
- `docs/solutions/workflow-issues/release-paths-filter-must-cover-runtime-image-contents-2026-06-25.md`
  — the release-layer sibling: a change can merge cleanly and still never reach
  its target. Different mechanism, same shape.
- `docs/solutions/workflow-issues/opencode-plugin-hooks-need-live-verification-2026-07-10.md`
  — another runtime-contract trap where an apparently successful agent operation
  was a no-op.
- `docs/solutions/workflow-issues/opencode-bootstrap-timeout-cache-purge-2026-08-31.md`
  — an adjacent Fro Bot operational failure mode. Unrelated root cause; listed
  because both make the daily run untrustworthy in different ways.
- Issue #410 — the daily report whose "Needs Human Attention #1" identified the
  missing PR handoff, closed once delivery was verified.
- Upstream `fro-bot/agent#1517` — the credential preflight fails open against
  `actions/checkout` v6's `includeIf` layout. Tracked by a smart note; revisit
  the local `persist-credentials` conditional if upstream closes it.
