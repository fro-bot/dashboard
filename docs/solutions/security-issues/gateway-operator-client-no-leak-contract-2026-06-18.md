---
title: Gateway operator client — typed mocked contract with no-leak boundaries
date: 2026-06-18
category: security-issues
module: dashboard
problem_type: security_issue
component: authentication
symptoms:
  - "future Gateway operator calls could accidentally use live /operator/* endpoints before readiness"
  - "operator launch and approval mutations could omit CSRF or idempotency guards"
  - "logs could capture prompts, tool arguments, workspace paths, internal URLs, tokens, cookies, session IDs, CSRF values, or idempotency keys"
  - "absolute, protocol-relative, or traversal paths could bypass same-origin /operator/* assumptions"
root_cause: missing_validation
resolution_type: code_fix
severity: high
related_components:
  - src/gateway/operator-client.ts
  - test/operator-client.test.ts
tags:
  - gateway
  - operator-client
  - csrf
  - idempotency
  - same-origin
  - redaction
  - sse
  - no-log
---

# Gateway operator client — typed mocked contract with no-leak boundaries

## Problem

The dashboard needs a Gateway operator client before Gateway's live operator surface
is ready. A normal browser client would create the wrong default: accidental live
`/operator/*` calls, ambiguous credential ownership, mutation requests without CSRF
or idempotency, and logs that can leak operator prompts or credentials.

The right artifact is a typed mocked contract: DTOs, guards, and injectable
transports now; production Gateway wiring only after Gateway smoke readiness.

## Symptoms

- Gateway route shapes are still contract-churn-prone, but the downstream dashboard
  UI needs stable types for issue #26.
- The dashboard signed `session` cookie and Gateway operator auth are separate
  credential domains; conflating them would make authorization ambiguous.
- Operator requests carry high-risk values: prompts, tool arguments, workspace
  paths, internal URLs, session state, CSRF tokens, and idempotency keys.
- Same-origin `/operator/*` is a security boundary; accepting absolute URLs,
  protocol-relative URLs, or traversal paths undermines that boundary.

## What Didn't Work

- **Waiting for live Gateway endpoints** would block dashboard UI work and push
  security decisions into future wiring code.
- **A normal global `fetch`/`EventSource` client** would be easy to use but hard to
  test safely under Node 24 SSR, and would risk accidental production calls.
- **Render-time or log-time redaction** is too late. The client boundary must avoid
  sending sensitive values to the logger in the first place.
- **Treating dashboard auth as Gateway auth** repeats the credential-domain
  conflation bug class already seen with GitHub App JWTs and installation tokens.

## Solution

Add `src/gateway/operator-client.ts` as a contract-only client factory:

```ts
const client = createOperatorClient({
  fetch: mockedOrSameOriginFetch,
  createEventStream: mockedOrSameOriginStream,
  logger,
})
```

The factory requires injected `fetch` and SSE transport implementations. It does
not capture global `fetch`, does not import `EventSource`, and does not know how
to contact a production Gateway by itself.

### Keep paths relative and same-origin

Every request goes through `validateOperatorPath(path)`. It accepts only
same-origin `/operator/*` paths and rejects:

- leading or trailing whitespace;
- null bytes, CR, or LF;
- protocol-relative paths like `//evil.example/operator/session`;
- scheme-like paths such as `http:`, `file:`, `data:`, `blob:`, `ftp:`, or
  `javascript:`;
- paths outside `/operator/*`;
- decoded `..` path segments.

Dynamic `runId` and `requestId` values are encoded with `encodeURIComponent` at
route construction sites, and blank IDs fail before fetch or stream creation.

### Guard mutating calls before fetch

`launchRun` and `decideApproval` reject before fetch when either value is blank:

```ts
csrfToken.trim() === ''
idempotencyKey.trim() === ''
```

Both mutating methods send CSRF and idempotency as headers, exclude them from the
JSON body, and set `redirect: 'error'` so a redirect cannot forward sensitive
headers or bodies to another origin.

```ts
{
  method: 'POST',
  redirect: 'error',
  headers: {
    'content-type': 'application/json',
    'x-csrf-token': req.csrfToken,
    'idempotency-key': req.idempotencyKey,
  },
  body,
}
```

### Use a discriminated `Result` error contract

Public methods return `Result<T, GatewayClientError>`. The error union separates
the failure classes that callers need to handle:

- `validation` — reject-before-fetch guards such as missing CSRF, blank IDs, or
  invalid path;
- `http` — non-2xx responses;
- `network` — injected fetch or stream setup throws;
- `protocol` — a 2xx response returns malformed JSON.

The JSON boundary casts through `unknown` before asserting the DTO type:

```ts
const raw: unknown = await response.json()
return ok(raw as T)
```

### Make SSE injectable and resumable

`connectRunStream` accepts an injected `createEventStream` transport and returns
`Result<EventStreamHandle, GatewayClientError>`. It exposes SSE event IDs as
metadata so callers can capture the latest ID and pass it back as `lastEventId`
on reconnect. The transport owns translating that option into `Last-Event-ID`.

The event union covers heartbeat, run state, output, errors, reset/resnapshot,
replay unavailable, terminal states, pending approvals, and approval decision
states. Runtime validation of arbitrary stream payloads is deferred until live
Gateway route contracts land.

### Log only coarse metadata

Logger calls use route templates and coarse status/event metadata only:

```ts
logger?.error('operator-client: http error', {route, status: response.status})
logger?.error('operator-client: stream error', {
  route: '/operator/runs/:runId/stream',
  eventType: 'stream.error',
})
```

Tests assert logs never contain prompts, tool arguments, workspace paths, internal
URLs, tokens, session IDs, cookies, CSRF values, idempotency keys, or dynamic
run/request IDs.

## Why This Works

- The dashboard can build and test against a typed operator boundary without any
  production Gateway dependency.
- Same-origin `/operator/*` stays a hard client invariant instead of a convention
  every caller must remember.
- Dashboard session auth and Gateway operator auth remain separate credential
  domains. The client surfaces Gateway session and CSRF DTOs but does not reuse,
  translate, or inspect dashboard cookies.
- Mutating calls cannot accidentally skip CSRF/idempotency, and redirects cannot
  silently forward those headers.
- Sensitive values never reach logger context, which is stronger than relying on
  downstream redaction.

This extends two earlier dashboard lessons:

- `github-app-credential-domain-conflation-2026-06-15.md` — model credential
  domains explicitly. That lesson covered App JWT vs installation token; this
  one extends it to dashboard session vs Gateway operator session.
- `cross-source-redaction-denylist-before-query-2026-06-15.md` — test absence of
  the leak, not only absence from rendered output. This contract applies that to
  logs and pre-fetch guards.

## Prevention

- Keep `src/gateway/operator-client.ts` marked contract-churn-prone until Gateway
  Phase B live route shapes and smoke tests are ready.
- Any new operator client method must use the same path validator, `Result` error
  contract, coarse logger shape, and injected transport boundary.
- Any new mutating method must reject missing CSRF/idempotency before fetch and
  use `redirect: 'error'`.
- Tests should assert absence directly: no fetch when validation fails, no stream
  creation for blank IDs, and no sensitive value in logger records.
- When Gateway route units land, reconcile DTO unions and add runtime stream event
  validation at the SSE boundary rather than spreading validation into UI code.

## Related Issues

- Dashboard issue #24 — parent plan for same-origin Gateway operator integration.
- Dashboard issue #25 — typed mocked Gateway operator API client contract.
- Dashboard issue #26 — downstream mock operator workflow UI skeleton.
- `docs/plans/2026-06-17-001-feat-gateway-operator-control-surface-plan.md` —
  same-origin, auth-boundary, disabled-mode, and no-production-call requirements.
- `src/gateway/operator-client.ts` and `test/operator-client.test.ts` — contract
  and 114 focused tests.
