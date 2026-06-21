---
title: Adding a safe mutating launch route to a read-only dashboard
date: 2026-06-20
category: best-practices
module: dashboard
component: operator-launch
problem_type: best_practice
severity: medium
applies_when:
  - Adding the first (or any) mutating browser-facing route to a read-only-by-construction app
  - A browser must call same-origin operator endpoints directly (not through an app proxy)
  - Idempotency, CSRF, and no-oracle behavior matter on a submit path
  - A launch must hand off to an existing SSE observe stream without re-bootstrapping
tags: [operator-launch, mutating-route, idempotency-key, csrf, no-oracle, browser-client, sse, security-hardening, reverse-proxy]
related:
  - docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md
  - docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md
issue: fro-bot/dashboard#47
---

# Adding a safe mutating launch route to a read-only dashboard

## Context

The dashboard is read-only by construction, but the operator surface needed a
single write action: launch a run (`POST /operator/runs`) plus a repo picker
(`GET /operator/repos`), against the released gateway operator contract 1.2.0.
This was the dashboard's first mutating-route consumer and first client-side
operator client. Introducing write capability into a read-only app — safely — is
the load-bearing problem, and several decisions are non-obvious.

## Guidance

### 1. Bound the read-only relaxation to ONE audited route; keep it browser-direct, not a proxy

Relax read-only-by-construction for exactly one audited route and say so explicitly
in the plan and the code. The browser may invoke ONLY that route, with a
server-resolved target (the client names a repo; the gateway resolves and
authorizes it — the client cannot expand the trust boundary). Critically, the
browser calls the same-origin `/operator/*` paths **directly**; the public reverse
proxy routes them to the gateway. The dashboard app must NOT mount or proxy them —
serving them would make a read-only app a credential-forwarding component and
enlarge its blast radius.

Encode that deliberate gap as a test so it isn't mistaken for a bug:

```ts
// The dashboard app does NOT serve the operator data/launch endpoints — the
// reverse proxy routes those same-origin paths to the gateway.
const repos = await app.request('/operator/repos', {headers: {cookie: '...'}})
expect(repos.status).toBe(404)                         // not mounted here, by design
const launch = await app.request('/operator/runs', {method: 'POST', ...})
expect(launch.status).toBe(404)
```

### 2. Defend against double-launch: mandatory idempotency key + an in-flight mutex

A `POST` that starts work needs two independent guards:

- **A mandatory fresh idempotency key per submit, REUSED on any retry.** A retry of
  a request whose response was lost must dedupe to the same run, not start a second
  one. The single CSRF-400 retry must pass the *same* key:

```js
const key = mintIdempotencyKey()                 // once per submit; use crypto.randomUUID()
let res = await client.launchRun({repo, prompt, csrfToken, idempotencyKey: key})
if (res.error?.status === 400) {                 // possibly stale CSRF
  const csrf = await client.refreshCsrf()
  res = await client.launchRun({repo, prompt, csrfToken: csrf, idempotencyKey: key}) // SAME key
}
```

- **An in-flight mutex on the submit handler.** Disabling the submit button is not
  enough — any page-context re-entry (a re-dispatched `submit` event, a direct
  handler call, a pre-click before the first `launching = true`) fires the handler
  again and mints a *different* key, double-launching. Guard re-entry directly:

```js
if (launching) return
launching = true
try { /* mint key → submit → handoff */ }
finally { launching = false; submitBtn.disabled = false }   // also un-stick the form on throw
```

### 3. No oracle on a mutating path

A mutating route's error responses are an information surface. Collapse them:
- ALL post-submit `400`s → one generic failure. Do NOT special-case the gateway's
  post-authz `400 "prompt is required"` — surfacing it reveals the repo was found
  and authorized. The only prompt-required signal is a LOCAL pre-fetch validation.
- `404` → one uniform unavailable state (no cause).
- The repo picker renders from a single normalized success shape — no
  count/ordering/timing/per-item-denial inference (denied repos are simply absent).

### 4. The browser operator-client pattern

Build the browser client the same way as the first client script: a static `.js`
(no build step) with a PURE core (the submit state machine, idempotency minting,
per-item validation, the pending-card builder) exported for unit tests, and a thin
DOM shell guarded to browser-only. The client is `createOperatorClient` over a
browser fetch adapter:

```js
const browserFetch = (input, init) =>
  globalThis.fetch(input, {...init, credentials: 'include', redirect: 'error'})
```

Same-origin + `credentials:'include'` + `redirect:'error'`; the gateway enforces
Origin/Fetch-Metadata/CSRF. Validate each `listRepos` item in the browser too (the
TS parse guard can't be imported into plain JS) — a null/malformed item must fail
the list closed, not crash the picker render. Validate the `202` body actually
carries a string `runId` before using it in a stream URL.

### 5. Hand off launch → observe by calling the stream client directly

Reuse the existing SSE consumer: on `202`, insert an optimistic pending card with
the exact hooks the stream client needs (`data-run-id`, a `[data-role="run-status"]`
child, the shared `[data-role="stream-status"]` notice) and call the exported
`initOperatorStream({runId, statusEl, noticeEl})` DIRECTLY. Do NOT re-run the
page's bootstrap — it would open duplicate streams for existing cards.

Validating that the `202` `runId` is a string is not enough to render it safely:
set it on the client-built card via `setAttribute('data-run-id', runId)` (or
`textContent`), never by interpolating it into an HTML string — a "looks-opaque"
identifier is still an HTML-injection vector if raw-interpolated. (Server-rendered
cards get this for free from the templating engine's auto-escape; the client-built
card does not.)

### 6. Degrade when a launched run never streams

A launched run can queue behind a concurrency cap or fail before admission and
never emit a stream frame. A bounded first-frame timeout transitions to a distinct
"submitted — not yet observable" state (not an indefinite spinner, and not an
error). Make it a real reducer state that does not overwrite `not-found`/`failed`/
`closed`, and clear the timer on the first frame and on close.

## Prevention

- The test asserting the dashboard 404s `/operator/repos` and `POST /operator/runs`
  is what keeps the deliberate "reverse proxy owns these" gap from being silently
  closed by a future change that "fixes" the 404.
- The CSRF-400 retry MUST reuse the same idempotency key — a fresh key in the retry
  path is a silent double-launch defect; pin that in a test.
- Keep the SSE client's `PINNED_CONTRACT_VERSION` equal to the vendored contract
  version with a test, so a bump can't drift one without the other.
- Any new error-state distinction on the launch/repos path (per-repo 400 copy, a
  timing or count difference in the picker) reintroduces an oracle — review it as a
  security change, not a UX tweak.

## Examples

**The contract-version-pin lockstep gotcha (a real bug caught during the build).**
Bumping the vendored `OPERATOR_CONTRACT_VERSION` to `1.2.0` is not enough — the SSE
run-stream client pins its own `PINNED_CONTRACT_VERSION` and gates the `ready`
frame against it. If the client pin lags the vendored contract, the run-stream
fails CLOSED on a version-skew false positive against the live gateway (which now
advertises the new version), silently breaking observation. Advance both in
lockstep, and pin the equality in a test so they can't drift.

**Where the bugs actually were.** The security model held on the first review pass;
every real bug was in timer/abort/error lifecycle — a first-frame timer not cleared
before re-arming on reconnect (stranded a recovering stream), `close()`'s abort
dispatching a microtask that regressed `closed`→`reconnecting` (the network/
unexpected-close reducer cases didn't guard terminal states), and an unguarded
`throw` in the submit handler leaving the form stuck. On this kind of work, look
hardest at the lifecycle, not the obvious auth surface.

## Related

- `docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md`
  — the typed operator-client contract (CSRF/idempotency reject-before-fetch,
  no-log discipline, same-origin) this launch consumer builds on; that doc was the
  mock-only contract, this is the live mutating-route consumption.
- `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md`
  — the SSE consumer reused for the launch→observe handoff.
- Issues: advances #47; auth cutover #59 (closed); approval slice #48 and engine
  refactors agent#965/#966 deferred.
