---
title: Clicking a control inside a run card toggled the card
date: 2026-10-10
category: ui-bugs
module: operator-first-pwa
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Choosing an answer option in a question card collapsed the run card it sat in"
  - "Any click inside the question region reached the card's click-to-toggle handler"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [event-bubbling, stoppropagation, run-card, operator, question-region, vanilla-js]
---

# Clicking a control inside a run card toggled the card

## Problem

Run cards in the operator UI expand and collapse on click. The question region renders inside an expanded card, so choosing an option in it bubbled a click to the card's toggle handler and collapsed the card under the operator's hands.

## Symptoms

- Selecting a radio option or checkbox in a question collapsed the run card.
- Any other click inside the question region (text field, Submit, Skip) did the same.

## Solution

Stop click propagation at the question request container, in `public/operator-stream.js` (the `question-region__request` section built per open request):

```js
el.className = 'question-region__request'
el.addEventListener('click', event => {
  event.stopPropagation()
})
```

The regression test is `web/src/operator/question-region.test.ts` ("does not collapse an expandable run card when an option is selected"): it mounts the region inside a parent click counter and asserts the counter stays at zero.

Keyboard activation needs no change: `bindCardActivation` (`public/operator-run-index.js`) ignores keydown unless `e.target === card`.

## Why This Works

The card's toggle listens on the card element, so every descendant click bubbles to it. The container listener stops that for the question region only.

## Prevention

- Any interactive region nested inside a toggle card stops click propagation at its container. (The note card reuses the container class without controls, so it needs none.)
- Test it with a parent click counter: mount the region inside a parent with a click listener, click a nested control, and assert the listener never fired.
- Keep the card's `keydown` guard (`e.target === card`) so nested controls own their own keys.

## Related Issues

- [CSS selectors must match the classes vanilla JS actually emits](../workflow-issues/css-selector-emitter-mismatch-2026-07-04.md) — another vanilla-DOM card bug class.
- [Question channel](../best-practices/operator-approval-channel-consumption-2026-06-22.md#question-channel) — the question card's state handling.
