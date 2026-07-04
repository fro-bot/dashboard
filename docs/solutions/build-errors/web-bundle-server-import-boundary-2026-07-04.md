---
title: Web bundle must not import from the server src tree
date: 2026-07-04
category: build-errors
module: dashboard
problem_type: build_error
component: tooling
symptoms:
  - "Docker release image build fails with rolldown [UNRESOLVED_IMPORT] Could not resolve '../../../src/...' in web/src/operator/runtime.ts"
  - "Docker build exits 1; the merged commit's release pipeline breaks"
  - "Local check-types, lint, test, and build:web all pass (false green)"
root_cause: scope_issue
resolution_type: code_fix
severity: high
tags:
  - web-bundle
  - docker-build
  - unresolved-import
  - boundary-violation
  - release-build
  - false-green
---

# Web bundle must not import from the server src tree

## Problem

A browser-only file under `web/` imported a helper from the server `src/` tree. The app worked
locally and every gate passed, but the Docker release image build failed — so `main`'s release
pipeline broke immediately after the PR merged.

## Symptoms

```
rolldown [UNRESOLVED_IMPORT] Could not resolve '../../../src/gateway/operator-client.ts'
  in web/src/operator/runtime.ts
```

Docker build exits `1`. **Every local gate passed first**: `pnpm check-types`, `pnpm lint`,
`pnpm test`, and `pnpm build:web` were all green, because the full repo (including `src/`) is on
disk during a local build. A second latent violation existed in
`web/src/operator/fixture-runtime-loader.ts` importing from `src/gateway/operator-fixture-routes.ts`.

## What Didn't Work

- **Trusting local `pnpm build:web` as proof.** It cannot reproduce the failure — the Docker
  web-builder stage is isolated and only has `web/`, but a local build sees the whole repo.
- **Widening the Dockerfile `COPY` to include `src/`.** This would make the build pass, but it
  is the wrong fix: it smuggles server code into the browser bundle and dissolves the boundary
  the error was correctly enforcing. Rejected.

## Solution

Sever the cross-boundary imports and give the web bundle its own copies of the tiny pure
helpers, then add a guard test so it can't regress.

Before:

```ts
// web/src/operator/runtime.ts
import {validateDynamicId} from '../../../src/gateway/operator-client.ts'
```

After:

```ts
import {validateDynamicId} from './validate-dynamic-id.ts'
```

- `validateDynamicId` → duplicated into `web/src/operator/validate-dynamic-id.ts` (with a parity
  test pinning identical accept/reject behavior to the server copy).
- The fixture prefix constant → duplicated into `web/src/operator/fixture-prefix.ts`.

Guard test (`web/src/operator/no-server-imports.test.ts`), in essence:

```ts
// Walk every web/src/**/*.{ts,tsx}; fail if any relative import resolves into src/.
for (const specifier of importSpecifiers(file)) {
  if (specifier.startsWith('.') && resolvesInto(specifier, 'src/')) {
    throw new Error(`${file} imports from the server src/ tree: ${specifier}`)
  }
}
```

## Why This Works

The boundary is load-bearing. The Docker builder stage copies only `web/` before running
`pnpm build:web`; `src/` is server runtime code copied into a later stage. So any `web/ → src/`
import that resolves locally fails in the image. A tiny pure value (a validator, a constant
string) is correct to **duplicate** across the client/server boundary; **importing** across it
is the bug.

## Prevention

- **Keep the guard test.** It turns a re-introduced `web/ → src/` import into a loud unit-test
  failure instead of a silent release break.
- **Verify bundle-boundary correctness with the real constraint, not local `build:web`.** Either
  run an actual `docker build`, or reproduce the builder isolation locally by moving `src/`
  aside and re-running `pnpm build:web` — if it still succeeds, no `web/ → src/` import survives.
- **Never trust local `build:web` alone** as proof that the release image will build; it sees the
  whole repo and false-greens on this class of error.

## Related Issues

- PR #159 — the shipped fix.
- [Release paths filter must cover runtime image contents](../workflow-issues/release-paths-filter-must-cover-runtime-image-contents-2026-06-25.md) — sibling "image contents vs local green" release-build failure.
- [Unit-green is not feature-done](../workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md) — the umbrella "local green ≠ shipped truth" lesson.
- [CSS selectors must match the classes vanilla JS actually emits](../workflow-issues/css-selector-emitter-mismatch-2026-07-04.md) — sibling false-green failure mode (styling).
- [PWA service worker registration is invisible to unit tests](../workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md) — sibling false-green failure mode (runtime SW).
