---
title: Operator UI skeleton — mock-only, flag-gated, render-time redaction
date: 2026-06-18
category: security-issues
module: dashboard
problem_type: security_issue
component: authorization
symptoms:
  - "a UI skeleton built ahead of its backend can accidentally call live endpoints before they are ready"
  - "a control surface can imply that one credential domain authorizes actions in another"
  - "backend state tokens can surface raw in operator-facing copy"
  - "fixture or request values (CSRF tokens, idempotency keys, prompts) can leak into rendered HTML through a later refactor"
  - "a feature flag that is not fail-closed can mount an unfinished surface by default"
root_cause: missing_validation
resolution_type: code_fix
severity: medium
related_components:
  - src/routes/operator.ts
  - src/gateway/operator-config.ts
  - src/gateway/operator-copy.ts
  - src/gateway/operator-fixtures.ts
  - test/operator-ui.test.ts
tags:
  - operator-ui
  - feature-flag
  - redaction
  - credential-domains
  - mock-only
  - same-origin
  - no-log
  - ssr
---

## Problem

The dashboard needed an operator workflow UI before the Gateway operator API was ready to call. Building UI ahead of its backend invites four security mistakes: calling live endpoints prematurely, conflating the dashboard's own session with Gateway authorization, surfacing raw backend state tokens as operator copy, and leaking fixture or request values into rendered HTML. The surface also had to default to off so an unfinished control plane could never appear in production by accident.

## Symptoms

- A skeleton wired to a typed client could call `/operator/*` before the Gateway listener exists.
- Operator copy could read as if "signed in to the dashboard" meant "authorized for Gateway actions."
- A terminal state like `failed_to_settle` could render verbatim as the primary label.
- Fixture CSRF tokens, idempotency keys, or prompts could reach the DOM if a later refactor bound request fields to the form.
- A truthy-but-not-`true` flag value could mount the surface unintentionally.

## What Didn't Work

Mounting the route unconditionally and rendering a disabled placeholder still constructs the route and its fixture module at import time, and leaves a live surface one refactor away from calling the client. Relying on tests that assert against placeholder strings that do not exist in the fixtures proves nothing — the assertions can pass while a real value leaks.

## Solution

Treat the skeleton as a mock-only consumer of the already-frozen client contract, gated by a fail-closed flag, with redaction applied at render time.

### Gate fail-closed and lazy-load

The flag reader only enables on an exact, trimmed, case-insensitive `true`; every other value (null, empty, `false`, `1`, `yes`) resolves to disabled. When disabled, the route is not mounted and its module is never imported, so the route and its fixture constants are never evaluated. The mount uses a dynamic `import()` inside the enabled branch rather than a top-level import.

### Keep credential domains distinct in copy and mechanism

The dashboard session authenticates the monitoring view only. The operator panel states this explicitly and never implies dashboard sign-in authorizes Gateway actions. No dashboard session value is forwarded, translated, or used to infer Gateway authority.

### Map backend tokens to operator-safe copy at render time

A pure copy module maps every run status and approval state to human text. Raw union tokens never appear as primary labels; `failed_to_settle` renders as a recovery message, never the raw token. The mapping functions take the contract's union types so the compiler enforces exhaustiveness when the contract grows.

### Render only from static fixtures, and prove no network

The skeleton renders from static fixture data. The mock client is built with an injected fetch that throws if called, so any accidental network attempt fails loudly. Tests assert that rendering succeeds without invoking the client and that the client converts an attempted call into a network-error result.

### Assert absence of real values, not placeholders

No-leak tests pin the actual fixture literals (the real prompt text, CSRF placeholder, and idempotency keys) and assert they never appear in the rendered HTML. Flag-off tests assert unconditionally that no operator content is served.

## Why This Works

Each invariant is enforced where it can be verified rather than asserted by convention. Fail-closed gating plus lazy import means the disabled state constructs nothing. Render-time redaction keeps the mapping the only path to display. A throwing fetch turns "no network" from a claim into a test. Pinning real fixture values turns the no-leak test into one that can actually fail on a regression.

## Prevention

- Build UI ahead of a backend as a mock-only consumer of the frozen contract, never a live caller.
- Gate unfinished surfaces behind a fail-closed flag and lazy-load them so disabled means "nothing constructed."
- Redact at render time through a single mapping; never render raw backend tokens.
- Write no-leak tests against real sensitive values, not placeholders.
- Keep credential domains separate in both copy and mechanism.

## Related Issues

- `docs/solutions/security-issues/github-app-credential-domain-conflation-2026-06-15.md` — model credential domains before writing code.
- `docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md` — enforce the guard before the upstream call; a request can itself be the leak.
- `docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md` — the typed client contract this skeleton consumes.
