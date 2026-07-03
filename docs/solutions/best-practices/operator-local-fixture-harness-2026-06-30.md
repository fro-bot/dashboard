---
title: Operator local fixture harness pattern
date: 2026-06-30
last_updated: 2026-07-03
category: best-practices
module: operator-fixture-harness
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - Developing the operator UI without live Gateway access
  - Adding dev-only routes that must never be reachable in production
  - Exercising browser runtime modules against synthetic HTTP and SSE fixtures
  - Verifying PWA behavior that unit tests cannot prove
  - Reviewing fixture data for credential or private-repo leakage
tags: [operator, fixture-harness, dev-only, run-index, pwa, sse, no-proxy, browser-verification]
related_components:
  - src/routes/operator-fixture-harness.ts
  - src/gateway/operator-fixture-config.ts
  - src/gateway/operator-fixture-routes.ts
  - src/gateway/operator-fixture-sse.ts
  - web/src/operator/fixture-runtime-loader.ts
  - web/src/operator/runtime.ts
  - web/src/views/Operator.tsx
  - public/operator-launch.js
  - public/operator-run-index.js
  - public/operator-stream.js
  - web/vite.config.ts
  - src/server.ts
---

# Operator local fixture harness pattern

## Context

The operator UI depends on Gateway operator routes, but dashboard development should
not wait on a Gateway deploy for every UI iteration. The local fixture harness gives
the dashboard a synthetic same-origin backend that exercises the real browser shell,
runtime modules, launch path, SSE parser, and approval path without real Gateway
credentials or production data.

This is not a unit-test mock. It is a development-time HTTP surface mounted under a
reserved prefix so the assembled PWA can be opened in a browser and driven through
success, failure, contract-drift, and malformed-stream scenarios.

## Guidance

### Use one reserved fixture prefix

Keep the dev route namespace in one shared constant:

```ts
export const FIXTURE_OPERATOR_PREFIX = '/__fixture/operator'
```

Use that constant for route registration, public-path checks, browser endpoint
configuration, and production absence tests. Do not scatter `'/__fixture/operator'`
strings through the app.

The production operator data route invariant still holds: the dashboard must not
proxy real `/operator/*` Gateway routes. Fixture mode is a separate dev-only prefix,
not a production fallback.

### Require three independent production guards

Fixture mode should only activate when all of these are true:

1. `DASHBOARD_FIXTURE_HARNESS_ENABLED=true`
2. `NODE_ENV` is `development` or `test`
3. the dashboard binds to loopback (`127.0.0.1`, `localhost`, or `::1`)

If the fixture flag is set outside those conditions, fail loudly at app construction.
Do not silently skip the routes; silent failure makes operators think they are
testing fixture mode when they are really testing production paths.

Production must also refuse the fixture build output:

```ts
if (webDistRoot.includes('dist-fixture') && process.env.NODE_ENV === 'production') {
  throw new Error('fixture build output cannot be served in production')
}
```

This catches the separate class of bugs where routing is safe but the wrong static
root is served.

### Keep fixture routes synthetic, no-store, and non-echoing

Fixture responses should never carry real credentials, repo names, workspace paths,
or token-shaped values. Use visually synthetic identifiers (`fixture-session-*`,
`run-fixture-*`, `req-fixture-*`) and assert that fixture files do not contain
private-looking URLs, bearer tokens, cookies, CSRF headers, UUID run IDs, or local
workspace paths.

Every fixture response should set `cache-control: no-store`. Validation failures
should return a short class like `{error: 'invalid-fixture-session'}` and must not
echo the invalid value. Logs should name route templates and error classes only,
not request URLs, headers, bodies, session IDs, or prompt text.

### Scope state by fixture session and run

Each `GET /session` call should mint a fresh `fixtureSessionId`. Launch idempotency
is scoped by `(fixtureSessionId, idempotencyKey)`, not by idempotency key alone, so
two tabs with the same key cannot collide.

When a fixture run is created, bind the generated run ID to the fixture session.
Stream, approval-list, and approval-decision routes should require the same
fixture session via query parameter or header. Missing, mismatched, and unprefixed
session values should all collapse to the same non-echoing error so the route does
not become an oracle.

### Configure the real browser modules, do not replace them

The browser harness should pass endpoint context into the existing operator runtime
modules:

```ts
createOperatorRuntime({
  container,
  onStateChange,
  fixtureMode: true,
  fixtureEndpointBase: FIXTURE_OPERATOR_PREFIX,
  fixtureSessionId,
  getScenario,
})
```

`public/operator-launch.js` and `public/operator-stream.js` still default to
`/operator` when no fixture options are supplied. That keeps production behavior
boring while allowing fixture mode to use the same launch, stream, reducer, and DOM
code. Avoid global `fetch` overrides or parallel fixture-only runtime modules; those
test the shim instead of the behavior that ships.

Initial browser snapshots follow the same rule. A Recent Runs module should fetch
the Gateway-owned production path directly:

```ts
await fetch('/operator/runs')
```

Fixture mode supplies the same contract under the reserved prefix:

```ts
await fetch('/__fixture/operator/runs')
```

"Same contract" means the exact wire shape, not an approximation. Derive the fixture
response from the upstream route's actual `c.json(...)` call, never from a sibling
route — adjacent routes disagree (`/operator/runs` returns the envelope
`{runs: [...]}`, `/operator/repos` returns a bare array). A fixture that returns a
plausible-but-wrong shape makes every test and browser check that consumes it green
while production stays broken. Vendor and conformance-pin the response *envelope*, not
just the item DTO, and when correcting a shape make the parser reject the old one so
drift is loud. See
[Local fixture harness must mirror the wire contract exactly](./local-fixture-harness-must-mirror-wire-contract-2026-07-03.md).

Do not add a dashboard pass-through proxy for `/operator/runs`. The dashboard owns
the PWA shell and static modules; Gateway owns operator data routes.

The fixture runtime loader belongs behind an `import.meta.env.DEV` guard so Vite
tree-shakes it out of production builds. Production build tests should assert that
`web/dist/**`, `sw.js`, and the public operator modules contain no `/__fixture`,
`dist-fixture`, or `fixture-runtime-loader` strings.

### Make fixture mode visible

The operator shell should expose a visible fixture-mode indicator and a machine
readable state, for example `data-fixture-mode="true"`. Synthetic data should not
look like a live Gateway run. If an operator or browser test cannot tell fixture
mode from production at a glance, the harness is too subtle.

### Treat active streams as a singleton

Snapshot surfaces and live streams must share one active run lifecycle. When
the user selects a recent run, the runtime should close any previously attached
stream before opening the new stream. Launching a run and selecting an indexed run
should share the same active-stream path.

The DOM marker should describe the currently active stream, not historical runs
that once had a stream:

```js
let activeRunId = null

function markRunStreamAttached(runId) {
  if (activeRunId !== null && activeRunId !== runId) unmarkRun(activeRunId)
  activeRunId = runId
  markRun(runId)
}
```

Avoid a set like `attachedRunIds.add(runId)` for this state. After selecting A then
B, A must be selectable again. The fixture browser check should cover A → B → A.

### Keep production idempotency in headers

Fixture harnesses may need synthetic body fields for local routing, but production
launch requests must keep the idempotency key in the `idempotency-key` header, not
the JSON body:

```js
await fetch('/operator/runs', {
  method: 'POST',
  headers: {'content-type': 'application/json', 'idempotency-key': idempotencyKey},
  body: JSON.stringify({repo, prompt}),
})
```

Tests should assert the production body contains only production contract fields
while the header still carries the key. Do not make production payloads leakier to
support fixture routing.

### Verify the assembled browser surface

Unit tests are not enough for this pattern. The fixture harness must be verified in
a real browser with the no-watch dev-server recipe:

```sh
pnpm dev:fixture
```

The browser pass should cover:

- root shell loads in fixture mode
- Recent Runs renders synthetic run summaries
- selecting indexed run A, then B, then A again reattaches the stream to A
- success scenario renders output and a terminal succeeded state
- terminal-failure scenario renders a failed state
- contract-drift scenario fails closed without guessing later frame data
- malformed scenario surfaces unavailable/failure instead of leaving a pending card
- `/operator` canonicalization still lands on the root operator shell
- fixture responses are not cached by the service worker

After merge, production probes should confirm that `/__fixture/operator/*` is not a
public route and production static modules contain no fixture route strings.

## Why This Matters

The harness shortens the operator UI feedback loop without weakening production
boundaries. The dashboard can iterate on layout, failure states, launch UX, SSE
rendering, and approvals locally, while the Gateway remains the owner of real auth,
real CSRF, and real operator execution.

The dangerous version of this pattern is a dev backend that leaks into production:
a public fixture route, a fixture static bundle served from production, a token-like
fixture value committed to the repo, or a global browser shim that bypasses the
real runtime. The three production guards, synthetic identifier discipline, static
absence tests, and assembled browser verification are what keep the harness useful
instead of becoming another footgun.

## When to Apply

- Use this pattern when a frontend needs fast local iteration against a backend
  owned by another repo, deploy pipeline, or credential domain.
- Use it when the real behavior includes browser-only concerns such as service
  workers, dynamic imports, SSE streams, or DOM lifecycle ownership.
- Do not use it for a tiny form where a component-level test is enough.
- Do not use it if fixture values cannot be made obviously synthetic.
- Do not add request-time environment branches as the only safety boundary; fixture
  activation should be decided at app construction.

## Examples

### Dev command shape

```json
{
  "scripts": {
    "build:web:fixture": "VITE_FIXTURE_MODE=true vite build web",
    "dev:fixture": "pnpm build:web:fixture && NODE_ENV=development DASHBOARD_HOST=127.0.0.1 DASHBOARD_WEB_DIST=./web/dist-fixture DASHBOARD_FIXTURE_HARNESS_ENABLED=true DASHBOARD_DEV_AUTOLOGIN=true node --env-file-if-exists=.env src/server.ts"
  }
}
```

The fixture script serves `web/dist-fixture`, not `web/dist`, and uses the real
server env names. Tests should pin both details.

### Session-scoped idempotency

```ts
const scopedKey = `${fixtureSessionId}:${idempotencyKey}`
const existingRunId = idempotencyMap.get(scopedKey)
if (existingRunId !== undefined) return existingRunId

const runId = generateFixtureRunId()
idempotencyMap.set(scopedKey, runId)
runSessionMap.set(runId, fixtureSessionId)
return runId
```

This prevents cross-tab and cross-test collisions while preserving production
idempotency semantics.

### Production absence test

```ts
expect(bundleText).not.toContain('/__fixture')
expect(bundleText).not.toContain('fixture-runtime-loader')
expect(bundleText).not.toContain('dist-fixture')
```

Run this against production build artifacts, not just source files. Source can
contain fixture code behind dev-only imports; production output must not.

### Active stream regression

```ts
selectRun('A') // opens A
selectRun('B') // closes A, opens B
selectRun('A') // closes B, opens A again
```

The final selection should not be suppressed by a stale "already attached" marker.
The active marker should move with the current stream.

## Related

- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md`
- `docs/solutions/security-issues/operator-ui-mock-only-skeleton-pattern-2026-06-18.md`
- `docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md`
- `docs/solutions/workflow-issues/dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md`
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`
- `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md`
- PR #132 / release `2026.06.55`
- PR #137
