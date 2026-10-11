---
title: Keep ce:review persona returns valid by re-requesting them, not editing them
date: 2026-10-10
category: workflow-issues
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: medium
tags: [ce-review, review-pipeline, persona-agents, validation, json-output, agent-workflow]
---

# Keep ce:review persona returns valid by re-requesting them, not editing them

## Context

`ce:review` runs persona reviewers in parallel, screens each return with the structural validator (`validate-review.mjs screen`), merges the findings, and sends each finding to a validator agent. In one run on the question-channel PR, three separate frictions showed up. Observed on fro-bot/dashboard#599.

## Guidance

### Re-request the same payload as raw JSON; never hand-edit a return

The validator rejected 4 of 9 persona returns because the JSON was wrapped in a markdown code fence. It rejected a fifth because a finding lacked the required `pre_existing` field. The `screen` stderr message was "Rejected persona adversarial return: field findings.0.pre_existing failed schema validation."

Re-request the identical payload once from the same reviewer session, as raw JSON or with the missing field added, and re-screen. A second rejection records the persona as malformed (`screen` exit 1) rather than retrying indefinitely. Hand-editing a reviewer's return substitutes the orchestrator's output for the reviewer's, which is the hand-synthesis the pipeline forbids.

Prevent it in the prompt template; see the first example below.

### Give each validator one finding, inlined

Validators pointed at the shared `merge-output.json` plus a finding ID sometimes judged a different finding. Write one brief per finding, as in the second example below.

### Review the fix commits, not just the original diff

A focused re-review of only the fix commit caught a regression the fix introduced; see [Claimed elsewhere](../best-practices/operator-approval-channel-consumption-2026-06-22.md#claimed-elsewhere).

## Why This Matters

A fenced or incomplete return that gets patched by hand turns an independent reviewer's verdict into the orchestrator's guess.

## When to Apply

- Every `ce:review` run, when writing persona and validator prompts.
- Whenever a screening step rejects a return: re-request it from the same session.
- Whenever a review finding is fixed: review the fix delta before calling the finding closed.

## Examples

Prompt template line for persona returns:

```text
Return raw JSON only: the first character of your reply is `{` and the last is `}`.
No markdown fences, no prose. Every finding includes `pre_existing`.
```

Validator brief shape (one file per finding):

```text
Finding D12 (fields inlined: file, line, claim, evidence, severity).
Validate only this finding. Do not open merge-output.json.
```

## Related

- [Question channel](../best-practices/operator-approval-channel-consumption-2026-06-22.md#question-channel) — the fix whose first version the focused re-review caught.
