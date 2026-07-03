---
title: Local fixture harness must mirror the wire contract exactly
date: 2026-07-03
category: best-practices
module: operator-fixture-harness
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - Building or updating a local/dev fixture that stands in for a real upstream response
  - Vendoring a contract for a gateway route the browser consumes
  - Authoring a fixture by copying a sibling route's shape
  - Consuming a new gateway route from a browser runtime module
tags: [operator, fixture-harness, contract-shape, response-envelope, browser-verification, fail-closed]
related:
  - docs/solutions/best-practices/operator-local-fixture-harness-2026-06-30.md
  - docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md
---

# Local fixture harness must mirror the wire contract exactly

## Context

A dev fixture harness is only as good as its fidelity to the real wire shape. When
`GET /operator/runs` was democked, the operator Recent Runs list never rendered in
production — yet every gate was green. The fixture harness returned a **bare array**
for `/runs`, but the real gateway returns an **envelope** `{runs: RunSummary[]}`. The
browser parser required a bare array, so every real response failed parsing and
collapsed into the neutral `unavailable` state (indistinguishable from a network
error by design).

The fixture shape was wrong because it was authored by copying the neighbor route:
`/operator/repos` genuinely returns a bare array upstream, `/operator/runs` does not.
Contract vendoring covered the item DTO (`RunSummary`) but not the response envelope,
so nothing in CI ever parsed a real gateway response — the fixture, the unit tests,
and the fixture-mode browser check all exercised the same wrong shape.

## Guidance

1. **Mirror the wire contract byte-for-byte.** Derive a fixture from the upstream
   route's actual `c.json(...)` call (or a captured real response), never from a
   sibling route. Adjacent routes in the same service can disagree on envelope vs
   bare value.
2. **Vendor and conformance-pin the response envelope, not just the item DTO.** A
   pinned `RunSummary` proves nothing about how the list is wrapped. Pin the
   `{runs: [...]}` container too, so fixture/contract skew of this class fails CI.
3. **Fail closed on the old shape.** When you fix a shape mismatch, make the parser
   *reject* the previous shape rather than accept both — drift then surfaces loudly
   instead of silently degrading.

## Why This Matters

A drifted fixture is worse than no fixture: because the unit tests, the browser check,
and the fixture harness all consume the *same wrong* shape, they agree with each other
and turn green while production stays broken. False confidence scales across the whole
verification stack instead of failing at one gate.

## When to Apply

- Adding any fixture/mocked endpoint that stands in for a real upstream route.
- Vendoring a contract into `src/gateway/operator-contract/`.
- Consuming a new gateway route from a browser runtime module.
- Copying an existing route's shape into dev/test harness code.

## Examples

Upstream contrast — the two routes disagree, so copy-the-neighbor is unsafe:

```ts
return c.json({runs}, 200)    // GET /operator/runs  — envelope
return c.json(summaries, 200) // GET /operator/repos — bare array
```

Fixture harness — mirror the real envelope:

```js
// before: copied the /repos bare-array shape
c.json(FIXTURE_RUN_SUMMARIES)
// after: mirrors the /runs envelope
c.json({runs: FIXTURE_RUN_SUMMARIES})
```

Browser parser — fail closed on the old shape:

```js
const body = await res.json()
if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.runs)) {
  return {kind: 'unavailable'} // bare array no longer accepted — drift is loud
}
```

Vendored envelope + conformance pin:

```ts
export interface RunsListResponse {
  readonly runs: readonly RunSummary[]
}
// parseRunsListResponse rejects non-envelope shapes; conformance test pins it
```

## Related

- `docs/solutions/best-practices/operator-local-fixture-harness-2026-06-30.md` — the
  harness pattern this lesson strengthens: it framed contract drift as a *scenario*;
  this makes byte-for-byte wire fidelity and envelope conformance-pinning an invariant.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`
  — the sibling verification lesson (green tests, broken live surface).
- fro-bot/dashboard#148 (fix), fro-bot/agent#1099 (sanitized failure reason),
  fro-bot/agent#1101 (inactivity-timeout observability).
