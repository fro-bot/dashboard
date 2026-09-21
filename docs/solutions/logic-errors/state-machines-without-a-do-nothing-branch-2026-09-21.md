---
title: Three state machines had no way to do nothing, so unknown state became action
date: 2026-09-21
category: logic-errors
module: dashboard
problem_type: logic_error
component: frontend_stimulus
severity: high
symptoms:
  - "One click of Enable Notifications produced three push subscriptions — push.subscribed=3, push.unsubscribed=0, three live endpoint hashes — one per tab focus cycle"
  - "A hard reload with no button press minted another subscription, taking the endpoint count from three to five"
  - "Clicking a completed run showed 'Connecting to run stream…' forever and never rendered output"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - web/src/push/reconcile.ts
  - web/src/views/Notifications.tsx
  - public/operator-stream.js
tags:
  - state-machine
  - no-op
  - drift-detection
  - push-subscriptions
  - sse
  - reconnect-loop
  - consent
---

# Three state machines had no way to do nothing, so unknown state became action

## Problem

Three production bugs in one night, in two unrelated subsystems, with one shape: **a state that warranted no action was mapped onto a confident action.** Each state machine could decide to create, destroy, or retry — but had no way to say "nothing to do here."

## Symptoms

**Push subscriptions multiplied on their own.** One press of Enable Notifications, then looking away from the tab and back, produced three distinct endpoint records:

```
push.subscribed     3
push.unsubscribed   0
```

Three live subscriptions for one operator means three notifications per dispatch, growing by one per focus cycle, with the abandoned Gateway records never cleaned up.

**A completed run's stream never resolved.** The UI sat on `"Connecting to run stream…"` indefinitely. The entire wire response, captured from the Network tab with no console errors:

```
event: ready
data: {"contractVersion":"1.6.0"}

event: reset
data: {"runId":"7fa0d9ea-…","reason":"no-snapshot"}

```

Two frames, then silence.

## What Didn't Work

**Fixing one half of a symmetric defect.** The first fix (#508) guarded the destructive direction and shipped the creative one. Its guard read as "don't act on inconclusive input" but only covered the branch where a subscription already existed:

```ts
if (handoffState === 'not_subscribed' && localSubscriptionPresent && options?.notSubscribedConfirmed !== true) {
  return {uiState: undefined, action: 'none'}
}
```

With no local subscription, control fell through to `action: 'register'` and minted an endpoint with no user action. That reached production and was caught minutes after deploy — a hard reload with no button press emitted `push.subscribed`. Fixed in #511.

The guard looked complete. It was complete for the case being fixed, and silently partial for its mirror.

**Copying the adjacent branch verbatim.** In the stream fix (#512), the neighbouring `max-duration` branch looked directly reusable — it already asked "is this run still active?" But the two branches ask different questions. `max-duration` treats an unknown run entry as not-active and closes; `no-snapshot` on a *live* run is legitimate, because the stream can attach before the first snapshot exists. Copying the condition broke five existing tests, which is the only reason the distinction surfaced.

**Reasoning about live behavior instead of capturing it.** The stream bug produced three plausible wrong diagnoses from source reading — including a service-worker hypothesis that matched every symptom and was disproved only by clearing site data and watching it fail identically. What settled it was the operator pasting the actual Network response.

## Solution

Each fix added the missing non-action.

**Unknown is not a confirmed negative** (`web/src/push/reconcile.ts:162`). `derivePushHandoffState` collapsed "metadata unreadable", "local hash unavailable", and "genuine mismatch" into one `not_subscribed` verdict. Only the third is evidence. Destruction now requires confirmation; anything less returns `action: 'none'`.

**Permission is not consent** (`web/src/push/reconcile.ts:172`). Granted permission with no local subscription is a resting state — the operator simply is not subscribed. A browser permission grant survives an explicit unsubscribe, so auto-registering on it makes staying unsubscribed impossible. Registration is now reachable only through the explicit opt-in button.

**A stable fact is not a transient one** (`public/operator-stream.js`, the `no-snapshot` branch of `case 'reset'`). For a run the client knows is terminal, `no-snapshot` is permanent: the Gateway's terminal replay cache is in-memory and does not survive a restart. Every reconnect returned a byte-identical response, so the client looped until the retry cap while rendering `"Connecting to run stream…"` — because `reconnecting` is exactly what renders that string. Known-terminal runs now close instead of retrying; unknown and active runs retry exactly as before.

## Why This Works

The common defect was not a wrong branch. It was a **missing** branch.

Each state machine enumerated its actions — cleanup, register, reconnect — and routed every state to one of them. States meaning "the inputs did not tell me anything", "there is genuinely nothing to do", and "this will never change" had nowhere to go, so they fell through to whichever action sat at the end of the chain. The fall-through was always an action, never a no-op.

Adding the non-action is not defensive coding. It is completing the enumeration.

The mirror-image case is worth separating out. A guard that prevents an unwanted *destruction* does nothing about an unwanted *creation*, and the two often share a predicate. When the same condition can authorize opposite actions, guarding one direction leaves the other exposed — and the fix reads as complete while it ships the remaining half.

## Prevention

- **Give every state machine an explicit do-nothing outcome**, and make it the fall-through rather than an action. If a state cannot be classified, the correct behavior is to decline.
- **Unknown and confirmed-negative must be distinct states.** A failed read and a definitive "no" are different facts. Collapsing them means a network blip is indistinguishable from evidence.
- **When guarding one direction of a symmetric decision, check the other in the same change.** Ask directly: this condition now blocks a destructive action — does it also authorize a creative one? #511 existed because that question was not asked, and it reached production.
- **Adjacent-branch conditions are not automatically reusable.** Two branches next to each other in the same `switch` can ask different questions. Write the test that proves the new branch means something different before copying the condition.
- **Distinguish transient from permanent before retrying.** A retry is only correct if the underlying condition can change. Retrying a stable fact burns the retry budget and reports a misleading "connecting" state to the user the entire time.
- **Capture the wire before diagnosing.** Two SSE frames settled a question that three rounds of source reading got wrong. For anything crossing a network boundary, get the actual bytes first.

## Related

- `fro-bot/agent#1639` — the Gateway half of the stream bug: terminal replay is in-memory only, so any restart makes every completed run unreplayable, and the manager has no durable terminal lookup.
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md` — the nearest sibling, covering the same `operator-stream.js` surface. It establishes that `final: true` is authoritative; this doc covers a different failure in the same state machine.
- `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md` — already carries the "cap reconnect paths" principle. Consistent with this finding, not superseded by it.
