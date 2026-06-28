---
title: Consuming an authoritative-final streaming output channel
date: 2026-06-22
category: best-practices
module: src/gateway/operator-sse-reader.ts
component: operator-stream
problem_type: best_practice
severity: medium
applies_when:
  - Interpreting an SSE output channel where final:true is authoritative and seq is monotonic
  - Accumulating deltas while allowing a late-subscriber final frame to replace history
  - The same frame type is parsed in two independent code paths (server reader + browser reader)
  - Managing contract-version drift across multiple consumers
tags: [sse, operator, contract, streaming, no-leak, dual-parser]
related_components:
  - public/operator-stream.js
  - src/gateway/operator-contract/output.ts
issue: fro-bot/dashboard#47
related:
  - docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md
  - docs/solutions/security-issues/gateway-operator-client-no-leak-contract-2026-06-18.md
  - docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md
---

# Consuming an authoritative-final streaming output channel

## Context

The gateway streams run output over SSE as an `output` frame
(`{runId, text, final, seq, droppedCount?}`): `final:false` frames are live
deltas to append, a `final:true` frame is the authoritative complete answer, and
`seq` is monotonic per run. The read-only dashboard consumes this to show live run
output. The non-obvious hazards are not in the transport (covered by the
authenticated-SSE-consumption sibling doc) but in how a consumer *interprets and
accumulates* an authoritative-final channel, and in the fact that the dashboard
parses the same frame in two independent places. Each hazard below was a real
finding caught in review on this change — the transport was safe but the
*interpretation* was wrong.

## Guidance

### Drive completion off the terminal status frame, not output presence

As of contract 1.5.0, **a run that produces no output still emits an empty terminal
output frame** (`text: ''`, `final: true`). This lets consumers distinguish "no
output" from "missing output". However, the terminal *status* frame remains the
authoritative completion signal — consumers must not block awaiting an output frame,
because the status frame is what marks a run done. Drive completion off status;
treat output as a side-channel that may arrive empty:

```js
// render: show output only when non-empty; an empty final clears any stale text
const outputText = runEntry?.outputText
if (typeof outputText === 'string' && outputText !== '') {
  outputEl.textContent = outputText
  outputEl.hidden = false
} else {
  outputEl.textContent = ''   // clear any stale text, e.g. after an empty final
  outputEl.hidden = true
}
```

The empty-final guarantee means the reducer's authoritative-final path (`final:true`
replaces accumulated text) now runs for every run, including silent ones. Ensure the
reducer handles `text: ''` without treating it as a no-op.

### Accumulate with authoritative-final precedence, not seq precedence

`final:true` must replace the accumulated text **regardless of seq**, because the
replay cache delivers only the final answer to a late subscriber (not the delta
history) — so a lone final frame with an older seq is the complete answer. Deltas
apply only in strictly-increasing seq order; stale/duplicate seqs are dropped:

```js
if (final) {
  nextText = text          // authoritative — replaces, ignores seq
  nextSeq = seq
} else if (seq > prevSeq) {
  nextText = prevText + text   // delta — strictly increasing seq only
  nextSeq = seq
} // else: stale/duplicate delta — ignored (but still record a new coalesced flag)
```

Process frames strictly in arrival order — the seq check is a duplicate/stale guard,
not a sorting key. Never reorder by seq or apply a delta after a later final frame.

### A new per-run field must survive status updates

The terminal status frame arrives *after* the final output frame. If the status
reducer replaces the run entry instead of merging, it silently drops the just-
accumulated output. Spread the prior entry:

```js
[runId]: {...prevEntry, runId, status, phase, startedAt, stale, terminal},
```

This is the trap of adding state to a reducer entry that other event handlers also
write: every handler that builds that entry must preserve the new fields.

### Render free-form text via textContent only

The `text` field is free-form agent output and is **not** allowlist-gateable, so it
cannot be sanitized by enumeration like status/phase values. Render it through
`textContent` / a text node — never HTML interpolation, never `innerHTML`. The SSR
element ships empty and hidden; only the client writes it. Never render any other
frame field (`runId`, `seq`, `droppedCount`) as free text — surface a *fixed* label
for the coalesced/truncated hint instead of echoing a count.

### Bound cumulative accumulation

A raw-buffer cap bounds a single frame, not the growing answer. A stream of valid
deltas can grow the accumulated string without limit (browser memory/CPU DoS from a
buggy or hostile producer). Cap the cumulative text and flag truncation:

```js
if (nextText.length > MAX_OUTPUT_TEXT_CHARS) {
  nextText = nextText.slice(0, MAX_OUTPUT_TEXT_CHARS)
  truncated = true
}
```

### Keep dual parsers in lockstep

When the same frame is parsed in two places (here: a server SSE reader and a static
browser SSE reader), they are independent code paths that drift silently. Give both
the **same** fail-closed validation — required-field type checks, `Number.isSafeInteger(seq) && seq >= 0`
(rejects fractional / negative / `1e999` Infinity that `typeof === 'number'` lets
through), optional non-negative-integer `droppedCount` — and the same fixed,
non-echoing error strings. Pin parity with tests in both suites.

### Fail closed on contract-version drift

Pin the contract version on the client; the first `ready` frame's version must match
or the consumer enters an absorbing drift state and renders nothing. When the
provider bumps the contract, bump the pin in *every* consumer — a stale pin fails
closed against the live provider, which looks like "output never renders." The
dashboard maintains two independent pins (TypeScript vendored constant and browser
runtime literal); both must move together.

## Prevention

- Test the no-output path explicitly: terminal status with an empty final output
  frame (`text: ''`, `final: true`) → no hang, no output surface.
- Test authoritative-final-replaces-regardless-of-seq and late-subscriber-final-only.
- Test that a status update preserves accumulated output fields.
- Test the cumulative-growth cap and the empty-final-clears-the-DOM path.
- Test parser parity: every malformed/edge input rejected by one parser is rejected
  by the other.
- When bumping the vendored contract version, update both the TypeScript pin and the
  browser runtime literal together; a parity test should catch any one-sided bump.

## Related

- `authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md` — the
  fetch + ReadableStream SSE transport/lifecycle this consumer sits on (note: that
  doc predates contract 1.3.0).
- `gateway-operator-client-no-leak-contract-2026-06-18.md` — the typed operator
  client + no-leak boundary the output frame flows through.
- `safe-operator-launch-surface-2026-06-20.md` — the launch→observe handoff that
  feeds runIds into this stream consumer.
