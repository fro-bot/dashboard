---
title: Flag-gated meta injection truncated the SPA shell via a stale Content-Length
date: 2026-07-10
category: docs/solutions/runtime-errors
module: src/server.ts
problem_type: runtime_error
component: service_object
symptoms:
  - "Browser console: 'Root element not found' and a blank dashboard"
  - "Failure only reproduced over a real HTTP client (curl/browser), never in unit tests"
  - "Only occurred when the DASHBOARD_OPERATOR_PUSH_ENABLED flag was on"
  - "Served / body was capped at the pre-injection byte length, dropping <div id=\"root\">"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags:
  - content-length
  - serve-static
  - spa-shell
  - meta-injection
  - hono
  - streamed-response
---

# Flag-gated meta injection truncated the SPA shell via a stale Content-Length

## Problem
When the operator Web Push flag was on, `GET /` injected a `<meta>` tag into the SPA shell by rewriting the `serveStatic` streamed response, but kept the original `Content-Length`. The longer injected body was truncated at the stale length, dropping `<div id="root">`, so React had no mount target and the entire dashboard rendered blank.

## Symptoms
- Browser console: `Root element not found`; page is blank.
- Reproduces only over a real HTTP client (curl/browser), never in unit tests.
- Only when `DASHBOARD_OPERATOR_PUSH_ENABLED` is on (the flag that triggers meta injection).
- The served `/` body is capped at the pre-injection byte count (e.g. 649 bytes), missing the tail of `<body>` including the root div.

## What Didn't Work
- **Deleting the header on the rebuilt Response** (`headers.delete('content-length')`) did not win. `serveStatic` returns a *streamed* response; post-processing it left `Content-Length` at the stale value (`649`), so the client still truncated. You cannot reliably re-length a streamed static response by mutating its headers after the fact.

## Solution
When the flag is on, stop rewriting the streamed static response. Serve `/` **inline**: read the built `index.html` from disk, inject the meta tag, and return it via `c.html(...)` so Hono computes `Content-Length` from the actual bytes. Fall through to `serveStatic` when the file is missing or the flag is off.

```ts
import {existsSync, readFileSync} from 'node:fs'
```

```ts
// Sync read + inject + c.html() recomputes Content-Length from the real
// bytes, avoiding the stale length a streamed serveStatic rewrite would leave.
// Fall through to serveStatic if the file is missing.
const indexHtmlPath = join(webDistRoot, 'index.html')
if (pushNotificationsEnabled) {
  app.get('/', async c => {
    if (!existsSync(indexHtmlPath)) return c.notFound()
    const html = readFileSync(indexHtmlPath, 'utf8')
    const injected = html.includes('<meta name="push-enabled"')
      ? html
      : html.replace('</head>', '<meta name="push-enabled" content="true"></head>')
    return c.html(injected)
  })
} else {
  app.get('/', serveStatic({root: webDistRoot, path: 'index.html'}))
}
```

Regression test (authenticated harness) — asserts the served shell is **complete** and self-consistent, not just that the meta is present:

```ts
it('serves a COMPLETE index.html (root mount target present) with the injected meta when push is enabled', async () => {
  const app = await buildTestApp({operatorUiEnabled: true, pushNotificationsEnabled: true})
  const res = await authedGet(app, '/')
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain('<meta name="push-enabled" content="true">')
  expect(body).toContain('<div id="root">')
  expect(body).toContain('</html>')
  const contentLength = res.headers.get('content-length')
  if (contentLength !== null) {
    expect(Number(contentLength)).toBe(Buffer.byteLength(body))
  }
})
```

## Why This Works
`c.html()` re-serializes the full HTML and recomputes `Content-Length` from the real bytes, so the client receives the whole document. Unit tests missed the defect because it lived entirely in the byte-transport layer that Hono's in-process `app.request()` skips — the response was correct in-process but corrupt on the wire.

## Prevention
- When a flag mutates served HTML, assert **shell integrity over the real byte path**: the body contains both the injected marker and `<div id="root">`, and `Content-Length` (when present) equals `Buffer.byteLength(body)`.
- Never rewrite a streamed `Response` while reusing its length headers. Either build a fresh body with a framework helper that recomputes length (`c.html`/`c.body`) or don't touch the stream.
- Verify HTML-serving feature flags with a real HTTP client or browser, not only `app.request()`.

## Related
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — the umbrella "green ≠ done" lesson; this is its HTTP-transport instance.
- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md` — sibling browser-only failure the unit suite couldn't see.
- `docs/solutions/build-errors/web-bundle-server-import-boundary-2026-07-04.md` — another false-green that only a real build/runtime path exposed.
- Shipped in PR #188 (closes #108, operator Web Push).
