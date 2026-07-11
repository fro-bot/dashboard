---
title: Fixture fault sentinels must key on browser-controlled values
date: 2026-07-11
category: workflow-issues
module: operator-fixture-harness
problem_type: workflow_issue
component: testing_framework
severity: medium
applies_when:
  - "Adding fault-injection paths (5xx, 404, timeouts) to a local fixture harness"
  - "Assembled-page browser verification must exercise error/retry UI states"
tags: [fixture-harness, fault-injection, browser-verification, retry-state, assembled-page]
---

# Fixture fault sentinels must key on browser-controlled values

## Context

The operator run-cancellation UI needed its bounded-retry (503) and unavailable (404) states verified on the assembled page, not just in unit tests. The first fixture implementation added a 503 sentinel keyed on a magic `idempotency-key` header value — but the real browser client mints its own `crypto.randomUUID()` idempotency key per attempt. Nothing driving the assembled UI could ever send the magic header, so the fault states were unreachable from the browser: unit tests covered them, browser verification could not.

## Guidance

Key fixture fault sentinels on values the browser client actually controls and sends organically — typically the resource ID in the URL path — not on headers or bodies the client generates internally.

```ts
// Unreachable from the assembled UI: browser mints its own idempotency key
if (c.req.header('idempotency-key') === 'force-503') { ... }

// Reachable: dedicated fixture runs whose IDs trigger the fault
const CANCEL_RETRY_RUN_ID = 'run-fixture-cancel-retry-008'
const CANCEL_UNAVAILABLE_RUN_ID = 'run-fixture-cancel-unavailable-009'
if (runId === CANCEL_RETRY_RUN_ID) {
  return c.json({error: 'transient'}, 503, {'Retry-After': '2'})
}
```

Expose the fault-triggering resources in the normal listing route (e.g. the fault runs appear in `GET /runs` as `running`), so the UI renders real controls against them and a human or agent can click through every failure state. Place sentinel checks before any idempotency-replay or cache-write logic so the fault fires on every attempt — a cached first response would break retry-loop verification.

## Why This Matters

The whole point of assembled-page verification is exercising the real client → real route path. A fault path only reachable by hand-crafted curl or unit-test fixtures silently exempts the UI's error/retry states from that gate — the states where operator-surface bugs have historically clustered (lifecycle, retry, teardown), while the happy path gets all the scrutiny.

## When to Apply

- Designing any fixture-harness fault path meant to be exercised from a browser
- Reviewing fixture routes: ask "can the shipped client organically trigger this?"
- When retry/backoff/unavailable UI states exist, verify each is reachable end-to-end from the rendered page

## Examples

In `src/routes/operator-fixture-harness.ts`, the cancel route keys 503/404 faults on two dedicated always-running fixture run IDs surfaced in the run index. Browser verification then confirmed the full ladder live: armed → confirm → retrying (bounded, honors `Retry-After`) → unavailable, and the 404 → unavailable path, with no mocks.

## Related

- docs/solutions/best-practices/operator-local-fixture-harness-2026-06-30.md — fixture-mode checklist for new browser clients
- docs/solutions/best-practices/local-fixture-harness-must-mirror-wire-contract-2026-07-03.md — fixtures must mirror wire shapes byte-for-byte
- docs/solutions/workflow-issues/unit-green-is-not-feature-done-2026-06-24.md — the broader assembled-page verification lesson
