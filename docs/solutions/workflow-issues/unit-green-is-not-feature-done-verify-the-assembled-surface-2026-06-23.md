---
title: Unit-green is not feature-done — verify the assembled surface, not just units
date: 2026-06-23
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Shipping a user-facing feature across multiple PRs, each unit-tested in isolation
  - A page or screen is assembled from an older skeleton plus newly-added client/runtime pieces
  - "Done" is being judged from passing CI rather than the rendered/live result
tags: [workflow, verification, definition-of-done, ssr, operator-ui, integration]
---

# Unit-green is not feature-done — verify the assembled surface, not just units

## Context

The operator workflow UI was built across a long series of PRs — vendored contract,
SSE parsers, browser launch/stream/approval clients — each shipped with passing unit
tests and an approving review. Every PR was green. Yet the live `/operator` page that a
logged-in operator actually saw was still the original mock skeleton from the first issue
(#26): hardcoded fixture runs, a fixture timeline, "Mock skeleton" badges, and stale "v1"
copy, with the real client JS bolted on top of it but attached to fake fixture run IDs.
The faucet (capabilities) was real; the plumbing to the page (assembled surface) was never
connected — and nobody noticed until the live site was opened and screenshotted.

## Guidance

**Add a surface-level "done" gate to any multi-PR user-facing feature.** Unit tests prove
each piece works in isolation; they do not prove the assembled page is functional, because
the page's SSR shell can keep rendering stale fixtures/copy that no unit test asserts
against. Before calling an operator-facing feature done:

1. **Render the actual page and look at it** — locally or on a deploy preview — not just
   the unit suite. The screenshot is the test the unit suite can't be.
2. **Grep the page's SSR source for fixture/mock leftovers** when adding live behavior:
   fixture constants (`ALL_FIXTURE_RUNS`), "mock"/"skeleton"/"v1" copy, and placeholder
   data sources that a later PR was supposed to replace. A new client module that
   *attaches to* existing DOM does not remove the fixtures that DOM was built from.
3. **Trace the data origin end to end**, not just the transport. "The stream client works"
   is not "the page shows my runs" if there is no live source feeding the run list.
4. **Separate capability-shipped from surface-shipped in status reports.** "Approval
   decisions: shipped" (the client) is true and misleading if the page never renders a
   real approval. Say which layer shipped.

## Why This Matters

A feature that is unit-green but surface-broken reads externally as *vapor* — "I built all
this and nothing is live." That is a trust cost, not just a bug. It also hides genuine
upstream gates: the operator page being a mock masked that the gateway's repo-list and
run-snapshot endpoints (`GET /operator/repos`, `/operator/runs`) return 404/empty because
those units are unshipped — a fact that only surfaced when someone tried to use the page.
Surface verification finds both the local stale-shell bug and the upstream-missing-data
gate in one look.

## When to Apply

Any multi-PR feature with a user-visible surface, especially one assembled from an earlier
mock/skeleton. The cost of the check is one rendered page; the cost of skipping it is
shipping a mock to production with green checks.

## Examples

What passed vs. what was true on the operator page:

- **Passed:** `operator-stream.test.ts`, `operator-launch.test.ts`, contract conformance,
  approval reducer race tests — all green across #47/#63/#81.
- **True on the live page:** seven `run-fixture-*` cards, "Mock skeleton — fixture data",
  "No repositories available", "Run stream unavailable" — because `src/routes/operator.ts`
  still rendered `ALL_FIXTURE_RUNS`/`FIXTURE_RUN_TIMELINE` and the live client had no real
  runs to attach to.

The prevention is one line in the definition of done: **open the page.**

## Related

- [CSS selectors must match the classes vanilla JS actually emits](./css-selector-emitter-mismatch-2026-07-04.md) — a concrete sub-class where the assembled page renders but styling silently no-ops because a CSS selector drifted from the JS-emitted class name.
