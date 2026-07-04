---
title: CSS selectors must match the classes vanilla JS actually emits
date: 2026-07-04
category: workflow-issues
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - React renders only static hooks and vanilla JS emits the dynamic DOM into them
  - CSS in web/src/index.css is authored against class names or data-roles emitted by public/operator-*.js
  - A visual change passes check-types, lint, build, and unit tests but styling silently does not apply
  - A CSS grid contains children appended directly by JS
tags:
  - css
  - selectors
  - vanilla-js
  - react-shell
  - operator
  - browser-verification
  - false-green
---

# CSS selectors must match the classes vanilla JS actually emits

## Context

The operator UI is split into two layers. `web/src/views/Operator.tsx` (React) renders only
static container hooks — empty elements carrying `data-role`, `data-testid`, and `id`
attributes. The real content is rendered by vanilla modules
(`public/operator-run-index.js`, `public/operator-stream.js`, `public/operator-launch.js`)
which build DOM with `document.createElement`, set `textContent`, and attach specific class
strings and `data-role`s via safe-DOM. Styling lives in `web/src/index.css`, bundled into the
SPA by Vite.

That split creates a silent-failure class: CSS can be perfectly valid and every automated gate
can pass while a selector matches nothing the JS emits, so the element renders unstyled or
mis-placed. This mismatch surfaced three times in a single session while building the
run-centric operator redesign (PRs #158 / #160), each authored by a delegated
designer/fixer subagent and each caught only by manual cross-checking — never by CI.

## Guidance

Treat every class name and `data-role` a JS renderer emits as a styling contract.

1. **Mirror the emitted strings exactly.** If the JS sets
   `` className = `run-status status-${view.status}` `` then the CSS must target the exact
   status tokens the status values produce (`status-succeeded`, not `status-success`). Do not
   invent a parallel class layer (`.approval-btn`) unless the JS also emits it.

2. **Cross-check CSS against emitters after any UI change** — especially delegated ones. Grep
   the literal `className =`, `dataset.role =`, and `setAttribute(...)` strings in
   `public/operator-*.js`, and verify every new selector in `web/src/index.css` matches an
   actually-emitted string. This is a mandatory review step, not an optional one: subagents
   routinely author plausible-but-wrong class names.

3. **Give JS-inserted grid children explicit placement.** Any element appended directly into a
   CSS-grid container by JS needs `grid-column` (e.g. `1 / -1`) or it auto-places into whatever
   cell is free and silently breaks the row layout.

4. **Encode the contract as a test for stringly-typed CSS.** A vitest that reads
   `web/src/index.css` as text and asserts a rule exists for every canonical value (e.g. every
   status in `VALID_RUN_SUMMARY_STATUSES`) turns a silent rename into a loud failure.

5. **Browser-verify the real state, not just the default fixture.** If a rendered state is gated
   behind a fixture scenario the UI doesn't expose by default (the approval surface, error
   microstates), exercise that path explicitly. One of the three mismatches was invisible even
   to browser verification because the fixture Launch drawer never surfaced the approval
   scenario, so the approval badge never rendered during visual checks.

## Why This Matters

Every gate is blind to it: a selector that matches nothing is valid CSS, TypeScript and ESLint
treat CSS as opaque, `build:web` produces a well-formed bundle, and no unit test asserts
selector↔emitter agreement. Even browser verification misses states that never render in the
default fixture scenario. So the contract must be verified deliberately — grep cross-check, an
encoded test, or browser-exercising every state — or the UI looks finished while whole state
branches render unstyled. This is the concrete CSS-drift sub-class of the broader
"unit-green is not feature-done" lesson.

## When to Apply

Adding or editing CSS for anything a `public/operator-*.js` renderer produces, styling a CSS
grid that holds JS-inserted children, or reviewing a delegated designer/fixer UI change before
committing.

## Examples

**1. Status class mismatch (3 of 6 status colors silently missing)**

The JS emits status tokens from the run status value:

```js
statusEl.className = `run-status status-${view.status}`
// view.status ∈ VALID_RUN_SUMMARY_STATUSES: succeeded | failed | running | queued | cancelled
// (operator-launch.js separately hardcodes `run-status status-pending` for optimistic cards)
```

Correct CSS mirrors the real tokens:

```css
.status-succeeded { /* … */ }
.status-failed { /* … */ }
.status-running { /* … */ }
```

The drift that silently failed:

```css
.status-success { /* never matches */ }
.status-failure { /* never matches */ }
.status-in_progress { /* never matches */ }
```

**2. Approval button class mismatch (buttons rendered unstyled)**

The JS emits:

```js
// public/operator-stream.js, renderApprovalPrompt
btn.className = 'approval-prompt-btn-once'   // -always | -confirm | -cancel | -reject
```

Correct CSS:

```css
.approval-prompt-btn-once,
.approval-prompt-btn-always,
.approval-prompt-btn-confirm,
.approval-prompt-btn-cancel,
.approval-prompt-btn-reject { /* … */ }
```

The drift: `.approval-btn`, `.approval-btn-primary`, `.approval-btn-danger` — none emitted.

**3. Grid child with no placement (badge broke the card row)**

The badge is appended directly into the `.run-card` grid:

```js
badgeEl.dataset.role = 'approval-badge'
card.append(badgeEl)
```

Without explicit placement it auto-places into the narrow status column. The fix spans it onto
its own row (and `justify-self: start` keeps it a compact pill rather than a full-width bar):

```css
[data-role="approval-badge"] {
  grid-column: 1 / -1;
  justify-self: start;
}
```

**4. Guard test that makes a rename fail loudly**

```js
const css = readFileSync('web/src/index.css', 'utf8')
for (const status of [...VALID_RUN_SUMMARY_STATUSES, 'pending']) {
  expect(css).toContain(`.status-${status}`)
}
```

## Related

- [Unit-green is not feature-done: verify the assembled surface](./unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md) — the parent meta-lesson; this doc is the CSS-selector-drift sub-class.
- [PWA service worker registration is invisible to unit tests](./pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md) — sibling false-green failure mode (Workbox install semantics).
- [Operator local fixture harness](../best-practices/operator-local-fixture-harness-2026-06-30.md) — the browser-verification harness whose default scenarios can hide un-rendered states.
- [Local fixture harness must mirror the wire contract](../best-practices/local-fixture-harness-must-mirror-wire-contract-2026-07-03.md) — adjacent "wrong contract everywhere, gates green" mechanism.
- PRs: #158 (run-centric redesign), #160 (skeletons + mobile polish, where the three mismatches were caught and fixed).
