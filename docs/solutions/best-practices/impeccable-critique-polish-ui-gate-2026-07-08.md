---
title: Use Impeccable critique and polish as a final UI gate
date: 2026-07-08
category: best-practices
module: impeccable-ui-review
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - Preparing a UI-bearing feature for push or PR review
  - A feature is functionally green but visual quality has not been inspected in-browser
  - A delegated UI pass may have introduced off-token styling or row-layout drift
  - Choosing a final Impeccable task before the remote-action gate
tags: [impeccable, critique, polish, ui-review, design-gate, browser-verification, css-tokens, accessibility]
related_components:
  - web/src/index.css
  - web/src/views/Operator.tsx
  - .impeccable/critique
---

# Use Impeccable critique and polish as a final UI gate

## Context

The operator failure-reason UI was functionally green before the final design pass. Tests covered the contract, sanitization, fixtures, and browser behavior, but they did not catch visual quality issues: low-contrast diagnostic text, warning panels with inconsistent border grammar, OS emoji that clashed with the product tone, and row layout that became fragile once reason labels wrapped.

Running `/impeccable critique` against `web/src/views/Operator.tsx` produced `.impeccable/critique/2026-07-08T03-34-54Z__web-src-views-operator-tsx.md` and a design health score of `24/40`. The detector was clean, but the design critique surfaced issues worth fixing before the branch was pushed again.

## Guidance

### Ask for the final UI gate explicitly at the push/PR boundary

Before pushing a UI-bearing branch, use the question tool to ask which Impeccable task to run as the final pass. Do not assume the same pass is appropriate every time:

- `critique` when the design needs judgment and prioritized findings
- `polish` when the direction is correct but details need cleanup
- `quieter` when the UI is too loud or visually inconsistent
- `layout` when spacing, grids, hierarchy, or responsive behavior is the risk

Also ask whether `ce:review` is needed for the change. Review depth should match risk; it is not automatic for every branch.

### Treat a clean detector as evidence, not proof

The detector returned `[]` for `web/src/views/Operator.tsx`, but the critique still found real defects. A clean script result only means no deterministic detector rules fired. It does not prove the UI is accessible, aligned, or product-quality.

Use both signals:

```bash
node .agents/skills/impeccable/scripts/detect.mjs --json web/src/views/Operator.tsx
```

Then inspect the assembled surface and read the critique output. If the detector and design assessment disagree, trust the rendered UI.

### Verify the real browser path

UI polish should be verified in the assembled app, not just by reading CSS. For the operator PWA that means:

1. build the fixture bundle
2. run the dev server on loopback without `--watch`
3. clear stale service workers/caches or use a fresh browser profile
4. drive the fixture scenario that renders the target state
5. inspect DOM, computed styles, and layout geometry

`agent-browser` can be unstable on long-lived SSE pages or evaluate in `about:blank`. Raw Chrome DevTools Protocol is an acceptable fallback when it produces clearer evidence. The point is real browser evidence, not a specific automation wrapper.

### Polish with tokens and product tone, not decoration

The critique findings were fixed with small, token-aligned CSS changes:

```css
.run-reason {
  color: var(--color-text-muted);
}

.operator-warning-panel.operator-failure-state-unavailable {
  background: color-mix(in srgb, var(--color-error) 8%, transparent);
  border: 1px solid var(--color-error);
  color: var(--color-error);
}
```

The goal was not to make the UI more decorative. It was to make diagnostic text legible, normalize state grammar, remove cartoonish OS emoji, and keep run rows stable under real content.

## Why This Matters

UI regressions often survive type checks, lint, unit tests, and even deterministic design detectors. Product-quality issues live at the seam between tokens, copy, layout, and rendered state. A final Impeccable pass catches that seam while there is still time to fix it locally.

The operator surface is a technical control UI. It benefits from terse copy and strong signal, but it still needs accessible contrast and consistent visual language. Treating polish as a gate prevents correct-but-sloppy features from becoming the new design baseline.

## When to Apply

- Any PR that changes visible UI, component layout, interaction states, status copy, or CSS tokens
- Any delegated design/fixer pass that may have touched styles without a holistic visual review
- Any branch where the user asks for an Impeccable final pass before push/PR
- Any feature whose important state only appears through fixture/browser interaction

## Examples

### Good: critique found what tests missed

The failure-reason slice had green contract and fixture tests before critique. `/impeccable critique` still caught:

- `.run-reason` using a low-contrast text token for diagnostic content
- warning panels mixing `double`, `dashed`, `dotted`, and thick `solid` borders
- OS emoji indicators that clashed with the cyber-technical product tone
- reason text placed beside a compact badge, risking row rhythm on wrap

### Good: browser evidence after polish

Raw Chrome CDP verified the polished surface:

- reason text rendered as `No recent activity`
- `data-reason-state="present"`
- reason appeared below the repo and outside the status column
- unknown/non-failed reasons stayed blank
- no raw reason codes leaked into text or attributes

### Anti-pattern: detector-only review

A clean detector result is not a design approval. If the target is user-visible, run the selected Impeccable task and inspect the assembled UI.

## Related

- `.impeccable/critique/2026-07-08T03-34-54Z__web-src-views-operator-tsx.md`
- `docs/solutions/workflow-issues/css-selector-emitter-mismatch-2026-07-04.md`
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`
- `docs/solutions/workflow-issues/dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md`
