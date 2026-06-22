---
title: Consuming an authenticated SSE stream safely in a read-only dashboard
date: 2026-06-20
last_updated: 2026-06-22
category: best-practices
module: dashboard
component: operator-run-stream
problem_type: best_practice
severity: medium
applies_when:
  - Consuming an authenticated Server-Sent Events stream from a browser-facing dashboard
  - You must distinguish HTTP status (404 vs 429 vs network) on a stream that has no non-stream success response
  - The stream may carry hostile, malformed, or contract-drifted fields and the surface is redaction-strict
  - Introducing the first client-side JS / CSP / static-asset serving into an SSR app with no build step
tags: [sse, eventsource, readable-stream, csp, no-leak, fail-closed, redaction, browser-fetch, contract-version]
related:
  - docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md
  - docs/solutions/security-issues/operator-ui-mock-only-skeleton-pattern-2026-06-18.md
  - docs/solutions/security-issues/gateway-operator-session-cookie-forwarding-trust-boundary-2026-06-20.md
issue: fro-bot/dashboard#63
---

# Consuming an authenticated SSE stream safely in a read-only dashboard

## Context

The dashboard consumes the gateway's authenticated operator run-stream
(`GET /operator/runs/:runId/stream`, contract 1.1.0 at the time of writing; the
channel has since grown an `output` frame — see the Related output-consumption doc)
to render live run status,
replacing a mock. This was the dashboard's first client-side JavaScript, first
Content-Security-Policy, and first static-asset serving — introduced into an
SSR-only Hono app with no build step, on a read-only, redaction-strict surface.
Several non-obvious decisions and hardening steps made the difference between a
demo and a safe consumer.

## Guidance

### 1. Prefer a `fetch` + `ReadableStream` SSE reader over native `EventSource` when you need the HTTP status

Native `EventSource` cannot read the HTTP response status or body on failure — it
fires a generic `error` event. If the contract distinguishes a uniform `404`
denial from `429` backpressure (and the success response IS the stream, with no
non-stream JSON), `EventSource` cannot tell them apart. Use a `fetch` with
`credentials: 'include'` and read `response.body` as a `ReadableStream`:

```js
const res = await fetch(path, {
  credentials: 'include',
  redirect: 'error',                 // cookie must never follow a 3xx
  headers: {accept: 'text/event-stream'},
  signal,
})
if (res.status === 404) return failClosed('not-found')     // uniform, no cause
if (res.status === 429) return failClosed('backpressure')
if (res.status !== 200) return failClosed('network')
const ctype = res.headers.get('content-type') ?? ''
if (!ctype.startsWith('text/event-stream')) return failClosed('network') // not a stream (e.g. an auth-redirect HTML page)
```

Dropping `EventSource` also drops its built-in auto-reconnect, so the client owns
the explicit lifecycle (terminal close, reset, max-duration, bounded retry)
instead of fighting it.

### 2. The stream is an untrusted input — allowlist its "safe" field VALUES, not just their types

Type-checking `status`/`phase` as strings is not enough. A hostile or
misconfigured stream can put arbitrary text — including a private repo name —
into the `status` field, which then renders. Parse, don't validate: reject any
frame whose `status`/`phase`/`surface` is outside the canonical set, and render
labels from a fixed local map rather than the raw wire string:

```js
const VALID_STATUSES = new Set(['queued','blocked','running','waiting_for_approval','succeeded','failed','cancelled'])
const STATUS_LABELS = {running: 'Running', succeeded: 'Succeeded', /* ... */}
// in the parser: if (!VALID_STATUSES.has(candidate.status)) return parseFailure()  // fail closed, not rendered
// in the DOM:   statusEl.textContent = STATUS_LABELS[view.status] ?? ''            // never the raw string
```

Also use a whitelist render mapper (`toSafeRunView`) that returns ONLY the safe
fields (runId/status/phase/startedAt/stale) and drops anything else (e.g.
`entityRef`) even if present on the frame.

### 3. Treat contract-version drift and ordering as a fail-closed security gate

The first frame must be `ready { contractVersion }`. If the version mismatches
the pinned value, render NO `status` — a misparsed frame could surface wrong or
private data. Make the drift state ABSORBING (once drifted, later `ready`/`status`
frames don't move back to live) and enforce "first frame must be ready" on BOTH
the streaming path AND the end-of-stream flush path (a status-only buffer with no
preceding `ready` must dispatch nothing).

### 4. Never log or render the dynamic identifier; keep denials uniform

The `runId` rides only the request URL. Log the route TEMPLATE
(`/operator/runs/:runId/stream`), never the dynamic value (the logger's
field-name redaction won't catch `runId`). Collapse all `404`s to one UI state
with one retry policy — no cause-specific copy, timing, or retry behavior — so the
client doesn't reintroduce the oracle the server deliberately removed.

### 5. SSE stream-reading robustness (the parts that silently break in production)

- **Normalize CRLF.** SSE records are blank-line separated, but the spec allows
  `\r\n\r\n`. A gateway sending CRLF makes an `indexOf('\n\n')` split match
  nothing — zero frames parse, silently. Normalize `\r\n`→`\n` on every appended
  chunk.
- **Bound the incremental buffer.** A stream that never emits a record boundary
  grows the buffer without limit (OOM). Cap it; on overflow, abort the reader and
  drive a TERMINAL failed state (no reconnect) — not a generic retryable error
  that can leave a dangling open reader.
- **Flush on stream end.** A trailing frame without a final blank line is dropped
  unless you flush the remaining buffer when the stream closes.
- **Cap every reconnect path.** A `reset`-driven reconnect that doesn't increment
  the retry count loops forever against a pathological gateway. Increment and cap
  on `reset` exactly like network errors; `terminal` reset reason → close.

### 6. Introducing client JS + CSP into a no-build SSR app

- Ship the client as a served static `.js` (framework-free plain ESM, no build
  step), referenced as a same-origin `<script src type="module">`. Keep DOM access
  inside an init function so the module is also importable by the test runner in
  Node (a top-level `if (typeof document !== 'undefined')` auto-start guard makes
  the import a no-op in tests).
- Factor the parser + lifecycle state machine + safe-render mapper as PURE
  exported functions; unit-test them directly. Keep the DOM shell thin.
- Use the framework's built-in CSP (`secureHeaders`) and static serving
  (`serveStatic`) — no new dependency. Keep `script-src 'self'` strict (no inline
  script — the meaningful XSS vector), but be pragmatic about `style-src`: an SSR
  app with pervasive inline `style="..."` attributes needs `'unsafe-inline'` for
  styles. Keep `script-src 'self'` strict but allow `style-src 'unsafe-inline'` —
  inline styles are low risk; inline scripts are the XSS vector.

Most of these failure modes only surface under a hostile or quirky gateway — the
happy path hides them, so a review has to construct the adversarial stream.

## Prevention

- Keep the status/phase/surface allowlists in sync when the contract adds a value
  — a new valid status that's missing from the set silently fails its frames closed.
- Never soften a fail-closed branch (overflow, drift, denial) into a retryable one;
  each must terminate or stay absorbing.
- Never drop the CRLF normalization if the transport is swapped — it's invisible on
  an LF gateway and total-loss on a CRLF one.
- Test the adversarial paths explicitly: parse failure, contract drift, 404/429,
  buffer overflow, CRLF, partial-chunk reassembly — not just the happy stream.

## Examples

The vendored contract bump was version-only: `OPERATOR_CONTRACT_VERSION` moved
`1.0.0` → `1.1.0` and new SSE frame types were added, but the `OperatorRunStatus`
DTO was byte-identical upstream. The SSE frames live in the gateway's `web/sse/`
surface, NOT the operator-contract barrel, so they were vendored locally as
`src/gateway/operator-contract/sse-frames.ts` (a parallel local file), not as a
barrel mirror. Verify what actually changed between contract versions from the
upstream source before vendoring — the "bump" may be smaller (or differently
located) than the version number implies.

## Related

- `docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md`
  — the nearest sibling: the typed mocked operator client with injectable
  transport, path validation, and no-log discipline that this consumer plugs into.
- `docs/solutions/security-issues/operator-ui-mock-only-skeleton-pattern-2026-06-18.md`
  — the mock-only/flag-gated posture this work was built behind.
- `docs/solutions/security-issues/gateway-operator-session-cookie-forwarding-trust-boundary-2026-06-20.md`
  — the auth cutover this stream's live connection is gated on.
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`
  — extends this transport to the contract 1.3.0 `output` frame: delta/authoritative-final
  accumulation, no-output-as-absence semantics, and dual-parser parity.
- Issues: closes #63; part of #47; gated by #53/#59.
