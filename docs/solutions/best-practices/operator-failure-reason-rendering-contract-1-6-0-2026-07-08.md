---
title: Render sanitized operator failure reasons from contract 1.6.0
date: 2026-07-08
category: best-practices
module: operator-failure-reason-ui
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - Vendoring a Gateway operator contract version that adds a client-rendered field
  - Rendering an optional allowlisted wire value in the operator run index or stream UI
  - Extending fixture scenarios for a browser-direct operator PWA surface
  - Verifying operator contract changes without exposing raw Gateway values
tags: [operator, failure-reason, contract-1-6-0, fail-closed, sanitization, fixture-harness, run-index, sse]
related_components:
  - public/operator-stream.js
  - public/operator-run-index.js
  - src/gateway/operator-contract
  - src/routes/operator-fixture-harness.ts
---

# Render sanitized operator failure reasons from contract 1.6.0

## Context

Gateway operator contract `1.6.0` added `failureKind`, an operator-safe reason code for failed runs. The dashboard needed to consume it in both the recent-run index and live stream path, then show useful labels without leaking raw wire codes.

The shipped slice was PR [fro-bot/dashboard#174](https://github.com/fro-bot/dashboard/pull/174), released as [`2026.07.11`](https://github.com/fro-bot/dashboard/releases/tag/2026.07.11), and deployed through [marcusrbrown/infra run 28917088926](https://github.com/marcusrbrown/infra/actions/runs/28917088926). Production verification confirmed `/static/operator-stream.js` serves contract `1.6.0` with `failureKind` support, `/static/operator-run-index.js` renders sanitized reason labels, and unauthenticated `/operator/session` plus `/operator/runs` still return `401`.

## Guidance

### Keep server and browser contract pins in lockstep

When vendoring a Gateway operator contract bump, update every consumer that enforces the contract version:

- `src/gateway/operator-contract/version.ts` — `OPERATOR_CONTRACT_VERSION = '1.6.0'`
- `public/operator-stream.js` — `PINNED_CONTRACT_VERSION = '1.6.0'`
- fixture SSE ready frames — `contractVersion: '1.6.0'`
- conformance/parity tests proving server and browser pins cannot drift

Do not loosen drift handling to accept multiple versions unless that compatibility behavior is explicitly planned. Operator streams should fail closed on contract mismatch.

### Normalize unknown reasons to absent

`failureKind` is a display supplement. An unrecognized value should not reject the whole run summary or status frame; it should normalize to `undefined` and render the generic failed state.

```ts
const failureKind = isOperatorFailureKind(input.failureKind)
  ? input.failureKind
  : undefined

return {
  runId: input.runId,
  repo: input.repo,
  status: input.status,
  createdAt: input.createdAt,
  ...(failureKind === undefined ? {} : {failureKind}),
}
```

This preserves the run while preventing future or hostile values from leaking into DOM text, attributes, logs, screenshots, or accessible labels.

### Render labels from dashboard-owned maps

Never render the raw wire code. Browser surfaces should derive labels from explicit allowlist maps and expose only the resolved label in the safe view.

```js
export const FAILURE_REASON_LABELS = {
  'inactivity-timeout': 'No recent activity',
  'max-duration-timeout': 'Run timed out',
  'stream-ended': 'Stream ended early',
  'workspace-unreachable': 'Workspace unavailable',
  'session-error': 'Session error',
  unknown: 'Unknown failure',
}
```

The render-time invariant is:

- failed run + known reason → display the reason label
- failed run + absent or unknown reason → display generic `Failed`
- non-failed run + reason field → ignore the reason entirely

Tests should assert the serialized safe view contains `reasonLabel` only when allowed and never contains `failureKind` or fixture-only unknown codes.

### Mirror policy branches in the fixture harness

The local fixture harness needs explicit scenarios for each policy branch, not just one generic failure:

- failed run with a known reason
- failed run with an unrecognized fixture-prefixed reason
- non-failed run carrying a reason field that must be ignored
- failed run with no reason
- selection restoration, including A → B → A transitions where the reason label must restore correctly

Use synthetic identifiers and fixture-prefixed unknowns. Keep `Cache-Control: no-store` on fixture responses. The harness should prove browser behavior without forwarding live Gateway credentials or real operator data.

### Verify deploy shape without probing live operator data

Production verification should prove the deployed asset state and auth boundary without enumerating operator data. Static asset probes and unauthenticated boundary checks are enough for this contract slice:

- `/static/operator-stream.js` contains `1.6.0`, `failureKind`, and the expected labels
- `/static/operator-run-index.js` contains the label rendering path
- `/operator/session` and `/operator/runs` return unauthenticated `401` JSON

Authenticated run-data verification needs an intentional session-backed pass. Do not replace that with broad production scans.

## Why This Matters

The security boundary is the allowlist, not TypeScript. TypeScript describes the intended shape, but the browser receives JSON from a remote Gateway. Unknown or future `failureKind` values must be treated as untrusted input.

The UX boundary is also real. Showing only `Failed` made inactivity timeouts indistinguishable from other terminal failures. Showing raw codes would be noisy and brittle. Dashboard-owned labels provide useful operator context without coupling the UI to internal Gateway error names.

## When to Apply

- Vendoring any operator contract bump with a new client-rendered field
- Adding a status, reason, phase, surface, or approval field from Gateway JSON
- Rendering any optional field where unknown values must degrade safely
- Extending the fixture harness for a new browser-visible state

## Examples

### Good: closed safe view

```js
const reasonLabel = summary.status === 'failed' && summary.failureKind !== undefined
  ? FAILURE_REASON_LABELS[summary.failureKind]
  : undefined

return {
  runId: summary.runId,
  repo: summary.repo,
  status: summary.status,
  statusLabel: STATUS_LABELS[summary.status] ?? summary.status,
  ...(reasonLabel === undefined ? {} : {reasonLabel}),
}
```

The safe view exposes only the already-sanitized label. It does not carry the raw `failureKind` field forward.

### Good: fixture-only unknown reason

```ts
export const FIXTURE_KNOWN_FAILURE_REASON = 'inactivity-timeout'
export const FIXTURE_UNKNOWN_FAILURE_REASON = 'fixture-unrecognized-reason'
```

Fixture-prefixed unknowns make leak checks easy: committed fixture files can use known enum values or `fixture-*` values, and tests can assert the synthetic unknown never reaches the DOM.

### Anti-pattern: rejecting the whole run for an unknown reason

Do not turn an unknown display supplement into a missing run. Normalize the reason away and keep the run visible.

### Anti-pattern: passing raw codes through DOM attributes

Do not render `data-failure-kind`, CSS classes derived from raw codes, or accessible labels built from wire values. Resolve to dashboard-owned copy first.

## Related

- [fro-bot/dashboard#174](https://github.com/fro-bot/dashboard/pull/174)
- [fro-bot/.github#3512](https://github.com/fro-bot/.github/issues/3512)
- [fro-bot/agent#1099](https://github.com/fro-bot/agent/issues/1099)
- [fro-bot/agent#1055](https://github.com/fro-bot/agent/issues/1055)
- [fro-bot/agent#1069](https://github.com/fro-bot/agent/issues/1069)
- [marcusrbrown/infra#729](https://github.com/marcusrbrown/infra/issues/729)
- `docs/solutions/best-practices/operator-local-fixture-harness-2026-06-30.md`
- `docs/solutions/best-practices/local-fixture-harness-must-mirror-wire-contract-2026-07-03.md`
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`
