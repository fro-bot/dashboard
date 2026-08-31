---
title: Fro Bot bootstrap timeout is absorbing — purge every opencode cache to recover
date: 2026-08-31
category: workflow-issues
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - The Fro Bot required check fails during the server-bootstrap phase
  - "A CI job dies in ~34s with: Timeout waiting for server to start after 5000ms"
  - Re-running the failed job keeps failing identically on a warm cache
  - A PR shows mergeStateStatus BLOCKED with no review verdict posted
symptoms:
  - '{"level":"warning","message":"Failed to bootstrap OpenCode server","phase":"server-bootstrap","error":"Timeout waiting for server to start after 5000ms"}'
  - "OpenCode server bootstrap failed: Server bootstrap failed: Timeout waiting for server to start after 5000ms"
  - "gh run rerun --failed succeeds at nothing; every attempt fails the same way"
root_cause: async_timing
resolution_type: environment_setup
tags:
  - github-actions
  - fro-bot
  - opencode
  - cache
  - ci-failure
  - required-check
  - upstream-bug
---

# Fro Bot bootstrap timeout is absorbing — purge every opencode cache to recover

## Context

The `Fro Bot` check is a required status check. When it fails during server
bootstrap the job dies in roughly 34 seconds without ever reaching the review
stage, so **no verdict is produced**. The PR goes `BLOCKED`, but nothing is
wrong with the diff — this is infrastructure, not review feedback.

The failure does not clear itself. Re-running is useless: four consecutive
`gh run rerun --failed` attempts all failed identically. Recovery requires
manual intervention.

## Guidance

### 1. Recognise it before triaging anything else

Three signals together are conclusive enough to skip investigation:

- job duration around 34s
- `Cache | hit` in the run summary
- exactly 5.000s between `Scrubbed agent env for spawn` and the timeout warning

If those hold, do not read the diff, do not re-run, and do not treat it as a
review rejection.

### 2. Purge every `opencode-*` cache

Deleting only the PR's cache does **not** work. Restore-keys fall back to the
`opencode-storage-github-<owner>-<repo>-` prefix, so the run re-inherits the
`main` branch entry. Both `opencode-storage-*` and `opencode-tools-*` must go.

```sh
# enumerate
gh cache list --limit 100 --json id,key,sizeInBytes \
  -q '.[] | select(.key|startswith("opencode-")) | "\(.id)\t\(.sizeInBytes)\t\(.key)"'

# delete each id returned
gh cache delete <id>

# then re-run
gh run rerun <run-id> --failed
```

The recovering run reports `Cache | miss` and takes ~2-3 minutes instead of 34
seconds. The following run restores the freshly saved cache and stays green.

### 3. Do not bother with these

- **Raising a timeout.** There is no workflow-level knob. See below.
- **`skip-cache: true`.** It is honored by both restore (`restore.ts:144`) and
  save (`save.ts:76`), so it suppresses the symptom for one run without ever
  shrinking the stored entry. Remove the flag and the same cache is still there.
- **`WORKSPACE_OPENCODE_READY_TIMEOUT_MS`.** It belongs to the separate
  `apps/workspace-agent` service (`apps/workspace-agent/src/config.ts:129-174`),
  a different code path with real HTTP polling and respawn. Setting it in this
  workflow does nothing.
- **Blaming the env scrubber.** `packages/runtime/src/agent/filter-env.ts`
  explicitly retains `PATH`, `HOME`, `TMPDIR`, `XDG_*`, and `NODE_*`. Its log
  line is simply the last one before the SDK call, which is why the failure
  always lands exactly 5s later. `removedCount` varying 116 vs 117 is incidental.
- **Suspecting a bad release.** The same pinned version succeeded an hour
  earlier, and a scheduled run failed independently minutes after the PR run.

## Why This Matters

Two upstream properties combine into a trap, verified in `fro-bot/agent` at the
pinned commit `d8c47fdac44f39f6ef8fb4bab65609c6e645c58d` (v0.106.1):

**The budget is fixed and unreachable.** The 5000ms is the `@opencode-ai/sdk`
default for `createOpencode()`. `packages/runtime/src/agent/server.ts:59` calls
`createOpencode({signal, hostname, port})` without a `timeout` option, so no
consumer can raise it.

**Failure is absorbing.** Bootstrap runs inside the cache-restore phase. On
failure, `src/harness/phases/cache-restore.ts:59-61` calls `core.setFailed(...)`
and returns null; `run.ts:129-131` then returns 1, so `runCleanup` never
executes. But the Actions `post:` step still runs, and
`src/harness/post.ts:79-100` saves the cache unconditionally — with no prune
call anywhere in that path. Pruning is gated on a live server client
(`cleanup.ts:91`), which is exactly what is missing on a failed run. So the run
that failed re-persists the cache for the next one.

That asymmetry is what converts a single unlucky run into a permanently broken
required check.

## When to Apply

- The `Fro Bot` check fails with the bootstrap timeout signature above
- A rerun has already failed once — do not spend more reruns
- Any repository consuming `fro-bot/agent` that gates merges on this check

## Examples

### The measurement, and what it does not tell us

Upstream `fro-bot/agent#1407` attributes this to oversized session caches;
`bfra-me/.github` hit it at 189 MB and 292 MB. The numbers here do not fit that
explanation:

| Time (UTC) | Restored cache | Bootstrap |
| --- | ---: | --- |
| 03:44 | 21,620,154 B | ready in 3.121s |
| 04:53 | 21,638,164 B | timeout |
| 04:58 | 21,638,179 B | timeout |
| 05:30 | 21,720,735 B | timeout |

The run that succeeded restored a *smaller* cache than the two that failed an
hour later — 18 KB smaller, a 0.08% difference — and it was not marginal:
3.121s against the 5000ms budget, 1.88s of headroom, against the 16 ms upstream
measured on a 292 MB cache. At ~21 MB, an order of magnitude below where
upstream saw it, cache size does not explain the flip.

**Be honest about the gap this leaves.** Purging the cache recovered the build,
reliably and immediately. But the size data argues against a simple
size-causes-timeout mechanism, so *why* the purge works is not established. A
fresh cache may reduce startup work in some way not captured by total bytes, or
the recovery may partly reflect regression to the mean after four failures. The
procedure is verified; the mechanism is not. Do not repeat the size explanation
as if it were settled.

What the data does support: a 5s budget with no configurability is too tight to
absorb ordinary runner variance, and the save/prune asymmetry means any single
loss is permanent until someone intervenes.

### Recognising it versus a real review failure

```text
# infrastructure failure — 34s, no verdict
Fro Bot   fail   34s

# genuine run — reaches review, posts a verdict
Fro Bot   pass   2m38s
```

## When to revisit

- `fro-bot/agent#1407` closes or a release parameterises the bootstrap timeout,
  or prunes without requiring a live server. Then re-check whether this recipe
  is still needed and bump the pin in `.github/workflows/fro-bot.yaml`.
- The cache regrows and the failure returns. There is no local mitigation; the
  purge is the only known recovery.

## Related

- Upstream issue: <https://github.com/fro-bot/agent/issues/1407> — "Oversized
  session cache traps bootstrap: prune is gated on server start, cache save is
  not"
- Our evidence contradicting the size hypothesis:
  <https://github.com/fro-bot/agent/issues/1407#issuecomment-5472241560>
- `docs/solutions/workflow-issues/dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md`
  — sibling operational-recovery recipe for a process that appears hung
- `docs/solutions/workflow-issues/opencode-plugin-hooks-need-live-verification-2026-07-10.md`
  — another OpenCode runtime-contract failure invisible to unit tests
