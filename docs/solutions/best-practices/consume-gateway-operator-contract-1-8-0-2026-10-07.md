---
title: Consume a gateway operator contract bump as a full dashboard consumer (contract 1.8.0)
date: 2026-10-07
category: best-practices
module: operator-contract-consumption
problem_type: architecture_pattern
component: development_workflow
severity: high
applies_when:
  - A gateway operator contract bump adds optional OperatorRunStatus fields or failure kinds
  - New contract fields carry free-form text such as branch names, paths, or git config keys
  - Upstream is contract-ready but the gateway does not yet project the new fields to SSE consumers
  - The dashboard and gateway contract pins must move in the same marcusrbrown/infra deploy
tags: [operator, gateway-contract, contract-1-8-0, fail-closed, sanitization, checkout-provenance, checkout-preparation, deploy-coordination]
---

# Consume a gateway operator contract bump as a full dashboard consumer (contract 1.8.0)

## Context

Gateway operator contract 1.8.0 added optional `checkoutProvenance` and
`checkoutPreparation` on `OperatorRunStatus`, `checked` remote-freshness variants,
and the failure kinds `checkout-substituted` and `workspace-unavailable`. All of it is additive, but the
dashboard checks `contractVersion` for an exact match on both the server reader and
the browser stream. Any skew between dashboard and gateway drops every operator
stream at the `ready` frame.

Two things made this more than a pin bump:

- The new fields carry free-form repository detail: branch names, changed paths,
  submodule names, git config keys, obstruction paths.
- The gateway SSE projection (`packages/gateway/src/web/sse/projection.ts`) does not
  forward the new fields yet (fro-bot/agent#1737), so live streams never carry them.

Do not cut scope to "types only" because the gateway projection lags. The
cross-repo tracker (fro-bot/.github#3512), fro-bot/agent#1675 and the upstream plan
all say the operator surface owns these fields. Read them before deciding scope,
then implement exactly what the pinned contract exposes, with fixtures standing in
until live SSE carries the fields.

## Guidance

### 1. Move every pin together and test parity

The server pin (`OPERATOR_CONTRACT_VERSION` in
`src/gateway/operator-contract/version.ts`) is the source of truth. The browser
module cannot import server TypeScript, so `public/operator-stream.js` keeps its own
`PINNED_CONTRACT_VERSION` literal, and the fixture `ready` frames carry the version
too. A parity test pins the browser literal to the server constant:

```ts
it('browser PINNED_CONTRACT_VERSION equals vendored TypeScript OPERATOR_CONTRACT_VERSION', () => {
  expect(PINNED_CONTRACT_VERSION).toBe(OPERATOR_CONTRACT_VERSION)
})
```

A conformance test fails if a version literal appears in any vendored contract
comment or in `README.md`, and a separate assertion allows exactly one non-comment
version literal, in `version.ts`.

### 2. Vendor a consumption-only copy and document every deviation

Upstream `run-status.ts` imports gateway-only execute code, so the dashboard keeps a
trimmed copy: public types and the failure-kind allowlist, no projection helpers.
`provenance.ts` is copied whole with three edits, each recorded in
`src/gateway/operator-contract/README.md`:

- the vocabulary sets are exported so coverage tests can read them at runtime;
- the refusal-reason list has a compile-time exactness check against the union type;
- the parsers rebuild closed objects field by field instead of returning the input.

The last one matters. A parser that validates and then returns the wire object lets
extra keys through, including a JSON-parsed own `__proto__`:

```ts
function copyHead(head: OperatorCheckoutHead): OperatorCheckoutHead {
  return head.kind === 'attached'
    ? {kind: 'attached', branch: head.branch, sha: head.sha}
    : {kind: 'detached', sha: head.sha}
}
// parseOperatorCheckoutProvenance returns
// {kind: 'observed', observation: copyObservation(v.observation), remote: copyRemote(v.remote)}
```

### 3. Treat new optional fields as soft; keep core fields hard

An invalid `checkoutProvenance` or `checkoutPreparation` becomes absent. The status
frame still applies, exactly like an unknown `failureKind`. Invalid `status`,
`phase` or `surface` still reject the frame. In browser state, the latest valid value
wins, an absent or invalid value keeps the stored one, and provenance and preparation
are mutually exclusive:

```js
if (checkoutProvenance !== undefined) {
  nextEntry.checkoutProvenance = checkoutProvenance
  delete nextEntry.checkoutPreparation
}
if (checkoutPreparation !== undefined) {
  nextEntry.checkoutPreparation = checkoutPreparation
  delete nextEntry.checkoutProvenance
}
```

### 4. Make the browser the sanitization boundary

Free-form text is sanitized before it enters browser state, not at render time:
strip C0/C1 controls and every bidi control (including U+061C), cap each string at
256 characters, and cap lists at 10 entries plus "and N more". A required scalar
that is empty after stripping invalidates its containing object. Rendering uses
text nodes only. Static tests cover the browser sinks: no HTML sinks, and no raw
checkout values in class names, `dataset` or CSS variables.

The server reader validates shape but does not cap or sanitize, because nothing on
the server renders or logs these fields. `src/gateway/operator-contract/README.md`
requires any future server-side consumer to add that boundary first. The browser is
therefore deliberately stricter than the server.

### 5. Label maps are allowlists, with coverage tests

The browser label maps double as allowlists: a value with no dashboard-owned label
does not parse into a rendered object. The one exception is the checkout operation
`none`, which is accepted without a label: provenance shows no operation line, and
an operation-in-progress refusal uses fixed copy. Coverage tests compare the label
maps with the exported vendored vocabularies and pin that exception, so a newly
vendored value with no label fails CI.
Keep similar codes distinct: `workspace-unreachable`, `workspace-unavailable` and
`checkout-substituted` each get their own copy in both the stream and run-list maps.

### 6. Render into one region per card, and pass what was actually painted

Every card shape (fetched, optimistic launch, adopted) carries exactly one hidden
`[data-role="run-checkout-detail"]` region, discovered by the runtime seam and
handed to `initOperatorStream`. When `failureKind` is absent, the preparation reason
becomes the card's reason line, and the region leaves out its own copy.

Track what is on screen; don't infer it. Inferring caused two bugs: a stale
preparation headline after provenance replaced preparation, and a region that
dropped its reason line while the headline wasn't painted (connection not live, or
no `reasonEl`). `updateDOM` now passes what it actually painted:

```js
renderCheckoutDetail(checkoutEl, state.runs[runId], paintedPreparationHeadline || failureLabelStatesPreparation)
```

### 7. Build ahead of the upstream gap with fixtures

Until the gateway projects the new fields (fro-bot/agent#1737), the region stays
hidden on live runs and the fixture harness is the only full exercise of the
consumer. Its checkout scenarios cover every refusal reason, remote-freshness
variant, both new failure kinds, bidi and long-path input, and malformed
preparation, and a coverage test proves the set hits every vocabulary value.

### 8. Ship through one infra deploy

marcusrbrown/infra deploys both the dashboard and the gateway. The gateway pin is
`apps/gateway/upstream.json` (an agent release tag such as `v0.118.2`), which is a
different number from the contract version (`1.8.0`). The dashboard release and the
gateway pin move must be approved in the same window. The infra health probes check
only for HTTP 200, so after the deploy confirm `/operator/health` reports the new
`contractVersion` and that an authenticated run stream reaches `ready`.

## Why This Matters

Exact-match contracts fail closed. A pin moved on one side, or a dashboard deployed
before its gateway, blacks out every live run while every health probe stays green.

The contract also moved the security boundary. Earlier bumps only added enum codes
that could be checked against an allowlist. This one carries attacker-influenced
text. Validating the shape is not enough; the browser has to sanitize before state
and render only text.

Cutting scope to types because upstream projection lagged would have meant a second
contract migration later. Building the consumer against the contract, with fixtures
standing in for the missing projection, leaves the dashboard ready the moment the
gateway catches up.

## When to Apply

- A contract bump changes `OperatorRunStatus`, status SSE frames or failure
  vocabularies.
- New fields include paths, branch names, keys or other free-form text.
- Upstream defines fields that its runtime does not yet emit.
- Dashboard and gateway pins have to move in the same infra deploy.

Do not apply the rendering parts to collapsed run-list summaries unless the summary
contract carries the new fields. Here the run summaries stayed lean, and a static
test pins that `public/operator-run-index.js` never reads checkout fields.

## Examples

Soft fields keep the frame:

```ts
const data = ckBrowserStatus(ckStatusPayload({
  phase: 'FAILED', status: 'failed', failureKind: 'workspace-unavailable',
  checkoutProvenance: {kind: 'fixture-bogus'},
  checkoutPreparation: {outcome: 'fixture-bogus'},
}))
expect(data?.failureKind).toBe('workspace-unavailable')
expect(data?.checkoutProvenance).toBeUndefined()
expect(data?.checkoutPreparation).toBeUndefined()
```

The browser is stricter than the server:

```ts
const bidiOnly = '\u202E\u202D\u0007'
const emptyBranch = ckObserved({
  observation: ckObservation({head: {kind: 'attached', branch: bidiOnly, sha: CK_SHA_A}}),
})
expect(ckServerStatus(ckStatusPayload({checkoutProvenance: emptyBranch}))?.checkoutProvenance).toBeDefined()
expect(ckBrowserStatus(ckStatusPayload({checkoutProvenance: emptyBranch}))?.checkoutProvenance).toBeUndefined()
```

Every emitted class has a stylesheet rule:

```ts
const emitted = [...js.matchAll(/\bcheckout-detail(?:__[a-z-]+)?\b/g)].map(match => match[0])
for (const className of emitted) {
  expect(css, `missing CSS rule for .${className}`).toMatch(new RegExp(String.raw`\.${className}(?![\w-])`))
}
```

## Related

- `docs/solutions/best-practices/operator-failure-reason-rendering-contract-1-6-0-2026-07-08.md`: the
  previous contract bump. This doc generalizes it and adds free-form text, the upstream gap and the
  infra deploy.
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`: the dual-parser and
  fail-closed version rule.
- `docs/solutions/best-practices/local-fixture-harness-must-mirror-wire-contract-2026-07-03.md`:
  fixtures must mirror the wire shape.
- `docs/solutions/workflow-issues/css-selector-emitter-mismatch-2026-07-04.md`: selector and emitter
  parity.
- `docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md`: the
  no-leak boundary this builds on.
- `docs/plans/2026-10-06-001-feat-operator-contract-1-8-0-plan.md` and fro-bot/dashboard#573: the
  plan and the PR that shipped it.
- fro-bot/.github#3512 (rollout tracker), fro-bot/agent#1675 (deploy together), fro-bot/agent#1737
  (projection gap).
