---
title: Check a local dependency clone's ref before citing it as canonical
date: '2026-11-24'
category: best-practices
module: dashboard
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - A plan or brainstorm names a local clone of a dependency (for example `.slim/clonedeps/repos/fro-bot__agent/`) as the source of a contract
  - Vendoring or bumping the operator contract from `fro-bot/agent`
  - Writing a "Sources & References" or "Upstream Source" section that points at a path inside a clone
tags: [clonedeps, fro-bot-agent, operator-contract, stale-clone, plans, source-authority]
---

# Check a local dependency clone's ref before citing it as canonical

## Context

The dashboard vendors the gateway operator contract from `fro-bot/agent` (`src/gateway/operator-contract/`). Plans point at the upstream files so a reader can compare the vendored copy against the source. Some of those pointers name a local clone, `.slim/clonedeps/repos/fro-bot__agent/`, rather than a release.

A clone is a working tree at whatever ref its machine last checked out. The dashboard repo carries no `.slim/clonedeps.json` and a fresh checkout has no `.slim/` directory, so a clone path in a plan names a directory that exists only where someone created it, at a ref nothing in the repo records. It speaks for exactly one thing: what that ref ships.

The ref matters. In `fro-bot/agent`:

| Tag | `OPERATOR_CONTRACT_VERSION` | `OperatorCancelResponse` in `operator-contract/responses.ts` |
| --- | --- | --- |
| `v0.82.0` | `1.5.0` | absent |
| `v0.83.0` | `1.6.0` | present |
| `v0.83.1` | `1.6.0` | present |

A clone at `v0.82.0` or earlier looks like a healthy source and answers the cancellation-contract question with "that type does not exist".

## Guidance

Before citing a clone path as canonical, or reading a contract out of one:

1. Read the ref the clone is on: `git -C <clone> describe --tags --exact-match HEAD` (or `git -C <clone> rev-parse HEAD`).
2. Compare it with the release the dashboard targets. For the operator contract, that is the `fro-bot/agent` release the contract-bump plan names (for example `v0.83.1` for contract 1.6.0).
3. If they differ, do not read from the clone. Read the target ref directly: `git -C <clone> show <tag>:<path>`. This needs the tag fetched (`git -C <clone> fetch --tags`) and does not move the working tree.
4. In the plan, cite the release tag and the path, and name the check, so the reference stays correct on a machine whose clone is somewhere else.

The same rule holds for any dependency clone, not only `fro-bot/agent`: the ref is part of the citation.

## Examples

A reference that carries the check:

```text
- Canonical contract, read at `fro-bot/agent` `v0.83.1` (`git -C <clone> show v0.83.1:<path>`; use the clone's working tree only if `git describe --tags --exact-match HEAD` reports that tag): `packages/gateway/src/operator-contract/responses.ts` (`OperatorCancelResponse`)
```

A reference that does not:

```text
- Canonical contract: `.slim/clonedeps/repos/fro-bot__agent/packages/gateway/src/operator-contract/responses.ts`
```

[`docs/plans/2026-07-07-001-feat-operator-failure-reason-ui-plan.md`](../../plans/2026-07-07-001-feat-operator-failure-reason-ui-plan.md) states the failure case directly: the clone is stale relative to `v0.83.1` and must not be used for that bump. [`docs/plans/2026-07-10-002-feat-operator-run-cancellation-ui-plan.md`](../../plans/2026-07-10-002-feat-operator-run-cancellation-ui-plan.md) cites the same clone for the cancellation contract with the ref check attached.

## Related

- [`consume-gateway-operator-contract-1-8-0-2026-10-07.md`](consume-gateway-operator-contract-1-8-0-2026-10-07.md) — the contract-bump workflow this check belongs to; contract skew between dashboard and gateway drops every operator stream at the `ready` frame.
