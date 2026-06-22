---
title: 'feat: consume operator run-output channel (contract 1.3.0) — #47'
type: feat
status: completed
date: 2026-06-22
issue: fro-bot/dashboard#47
contract: fro-bot/agent operator-contract 1.3.0 (v0.74.0, verified live)
---

# feat: consume operator run-output channel (contract 1.3.0) — #47

## Overview

The gateway ships operator-contract `1.3.0` with a run-stream `output` frame
(`event: output`) carrying live answer deltas and an authoritative final answer.
The dashboard pins `1.2.0` and its SSE frame union has no `output` type, so it
literally cannot parse the output the gateway already sends. Align the dashboard to
`1.3.0`: vendor the canonical frame, add it to both SSE parsers and the browser
reducer, accumulate deltas → final, and render the answer in the run view behind the
existing operator-UI flag. (see issue #47)

## Verified Ground Truth (live agent v0.74.0)

- `OperatorOutputFrame { readonly runId: string; readonly text: string; readonly final: boolean; readonly seq: number; readonly droppedCount?: number }` — confirmed byte-exact.
- `OPERATOR_CONTRACT_VERSION = '1.3.0'`; barrel does `export type {OperatorOutputFrame}`.
- Wire: `event: output`, emitted BEFORE the terminal `status` frame. First frame is `ready` with `contractVersion: '1.3.0'`.
- `final:false` = delta to append; `final:true` = authoritative complete answer (replaces accumulated text). `seq` monotonic per run from 0. `droppedCount` = deltas coalesced under backpressure, rides on the next output frame.
- **Correction to the handoff (4c):** a no-output run does NOT reliably emit an empty terminal `output` frame — the gateway only emits it if the producer explicitly called `observeOutput('', {final:true})`. **The consumer MUST treat "terminal status reached, no output frame seen" as the no-output case and never block on a guaranteed terminal output frame.**
- Replay cache holds only the FINAL output (not intermediate deltas); a late subscriber within TTL gets the authoritative answer, not the delta history.

## Architecture Map (two parsers + one reducer)

- `src/gateway/operator-contract/version.ts` — pins the version (1.2.0 → 1.3.0).
- `src/gateway/operator-contract/sse-frames.ts` — the `RunStreamFrame` union (server-side types); add `output`.
- `src/gateway/operator-contract/output.ts` — NEW vendored frame.
- `src/gateway/operator-sse-reader.ts` `parseSseRecord` — server-side SSE parser; fail-closed on unknown events. Add the `output` case.
- `public/operator-stream.js` — browser SSE parser (mirror) + the `switch(event.type)` reducer where delta accumulation lives. Add the `output` parse case + accumulation. NOTE its current banner says "never render output" — that ban is lifted ONLY for the frozen `text` field, rendered via safe DOM (textContent), never HTML interpolation.
- `src/routes/operator.ts` — SSR run view (flag-gated); add the run-output surface element the browser client writes into.
- `test/operator-contract-conformance.test.ts` + `test/operator-sse-reader.test.ts` + `test/operator-stream-core.test.ts` — extend.

## Requirements Trace

- R1 — Vendor `OperatorOutputFrame` 1.3.0 + bump version to 1.3.0. (#47 scope 1)
- R2 — Add `output` to the `RunStreamFrame` union + server parser, type+value validated, fail-closed. (#47 scope 2)
- R3 — Add `output` to the browser parser + reducer: accumulate `final:false` deltas in `seq` order, replace with `final:true`, surface `droppedCount` as a coalesced hint. (#47 scope 3)
- R4 — Render the accumulated/final answer in the run view via safe DOM, flag-gated, no HTML interpolation, no leak of other fields. (#47 scope 4)
- R5 — "No output" = terminal status with no output frame seen (do NOT require an empty terminal output frame). (verified correction)
- R6 — Conformance + consumer tests: type-assignability, delta accumulation, final replacement, seq ordering, droppedCount, empty-vs-missing terminal, late-subscriber final-only. (#47 scope 5)

## Scope Boundaries

- Output channel only. Behind `DASHBOARD_OPERATOR_UI_ENABLED` (do not flip the flag's default — that's a deploy decision).
- Synthetic fixtures only (`testowner/...`); no canonical private-repo identifiers.

### Deferred / OUT of scope (leave mock-only)

- The approval-decision surface (`decideApproval` → `/operator/approvals/:id/decision`): the gateway endpoint does not exist (auto-deny, Discord-owned; agent Unit 6 unstarted). Leave approval DTOs mock-only, fail-closed. That is dashboard #48.
- Do not bump past 1.3.0 or invent unfrozen frames.

## Key Technical Decisions

- **KTD1 — Vendor + dual-parser parity.** The output frame type is vendored once; BOTH the server parser (`operator-sse-reader.ts`) and the browser parser (`operator-stream.js`) get a matching `output` case with the same fail-closed discipline. They are independent code paths and must not drift.
- **KTD2 — Accumulation lives in the browser reducer, not the client transport.** `connectRunStream` stays transport-only (forwards typed frames). Delta→final accumulation is reducer state in `operator-stream.js`, keyed by the absorbing-drift model already there.
- **KTD3 — `text` renders via safe DOM only.** `text` is free-form agent output — not allowlist-gateable. Render with `textContent`/`createTextNode`, NEVER template/HTML interpolation (the runId-injection lesson). `droppedCount` renders as a fixed-label hint, not echoed text.
- **KTD4 — No-output is the absence of an output frame.** Terminal status with no prior output → render the "no output" state; never block awaiting a terminal output frame (verified gateway behavior).
- **KTD5 — seq ordering + idempotency.** Apply deltas in `seq` order; a `final:true` frame replaces accumulated text regardless of seq gaps; out-of-order/duplicate seqs do not corrupt the accumulated answer.

## Open Questions

### Resolved During Planning

- Canonical shape / version / wire semantics → verified live (above).
- No-output guarantee → does NOT exist; treat as absence (KTD4/R5).
- Where accumulation lives → browser reducer (KTD2).

### Deferred to Implementation

- Whether to render `droppedCount` at all in v1 (a subtle "some deltas coalesced" hint) or just accumulate silently — decide when wiring the view; default to a minimal fixed-label hint, no count echo if it adds leak surface.
- Exact SSR element id/hook the browser client writes into (mirror the existing `data-role`/`data-run-id` handoff pattern from the SSE run-status work).

## Implementation Units

- [ ] **Unit 1: Vendor the 1.3.0 output frame + bump version**

**Goal:** `output.ts` exists mirroring the canonical frame; version is 1.3.0; barrel exports the type.

**Requirements:** R1, KTD1

**Dependencies:** None

**Files:**
- Create: `src/gateway/operator-contract/output.ts`
- Modify: `src/gateway/operator-contract/version.ts` (1.2.0 → 1.3.0), `src/gateway/operator-contract/index.ts` (export the type)
- Test: `test/operator-contract-conformance.test.ts`

**Approach:** Mirror `OperatorOutputFrame` byte-exact with the vendored-provenance comment style used by the other contract files. Bump the version constant. Add `export type {OperatorOutputFrame}` to the barrel.

**Execution note:** Test-first — flip the conformance `OPERATOR_CONTRACT_VERSION` assertion to `1.3.0` and add a type-assignability check for `OperatorOutputFrame` before/with the vendor.

**Patterns to follow:** `sse-frames.ts` / `run-status.ts` vendored-comment + export style; the existing conformance type-assignability checks.

**Test scenarios:**
- Type assignability: a full `OperatorOutputFrame` literal (with and without `droppedCount`) is assignable.
- Version: `OPERATOR_CONTRACT_VERSION === '1.3.0'`.
- Edge: `droppedCount` omitted is valid; `final:true` empty-`text` literal is valid.

**Verification:** Conformance test asserts 1.3.0 + frame assignability; CT green.

- [ ] **Unit 2: Add `output` to the SSE union + server parser**

**Goal:** `RunStreamFrame` includes `output`; `parseSseRecord` parses `event: output` fail-closed.

**Requirements:** R2, R5, KTD1

**Dependencies:** Unit 1

**Files:**
- Modify: `src/gateway/operator-contract/sse-frames.ts` (add `output` to the union + a frame-data type), `src/gateway/operator-sse-reader.ts` (`parseSseRecord` output case)
- Test: `test/operator-sse-reader.test.ts`

**Approach:** Add `{type:'output'; data: OperatorOutputFrame}` to the union. In `parseSseRecord`, before the unknown-event fallthrough, add an `output` branch: require `runId:string`, `text:string`, `final:boolean`, `seq:number`; `droppedCount` optional number-or-absent; reject otherwise with a fixed error string (never echo wire content). The ready-frame version gate already accepts whatever string arrives — confirm 1.3.0 ready passes (it should; gate compares to the pinned version).

**Execution note:** Test-first — RED a parse test for a valid output frame and for each malformed variant.

**Patterns to follow:** the `reset`/`ready` branches' type-check-then-construct shape and fixed-error-string discipline.

**Test scenarios:**
- Happy: valid output frame (delta and final) → typed frame.
- Edge: `droppedCount` absent → valid; `droppedCount` present non-number → reject; `text:''` `final:true` → valid.
- Error: missing/wrong-typed `runId`/`text`/`final`/`seq` → fixed parse error, no wire echo.
- Integration: an output frame followed by a terminal status frame both parse in sequence.

**Verification:** Server parser yields a typed `output` frame; malformed variants fail closed; CT green.

- [ ] **Unit 3: Browser parser + accumulation reducer**

**Goal:** `operator-stream.js` parses `output` and accumulates deltas → final in seq order.

**Requirements:** R3, R5, KTD2, KTD5

**Dependencies:** Unit 2 (mirror parity)

**Files:**
- Modify: `public/operator-stream.js` (+ its `.d.ts` if present)
- Test: `test/operator-stream-core.test.ts`

**Approach:** Add the `output` parse case mirroring Unit 2's validation. In the `switch(event.type)` reducer, maintain accumulated answer state: `final:false` appends `text` in `seq` order; `final:true` replaces the accumulated text with the authoritative answer; track a coalesced flag if any `droppedCount>0` seen. Absorbing-drift rules unchanged. Terminal status with no output → no-output state (KTD4).

**Execution note:** Test-first — RED accumulation/replacement/seq/droppedCount cases.

**Patterns to follow:** the existing reducer's absorbing-drift handling and the parser's fail-closed cases.

**Test scenarios:**
- Happy: deltas seq 0,1,2 accumulate in order → concatenated text.
- Replacement: deltas then `final:true` → accumulated text becomes the final text.
- Edge: out-of-order seq / duplicate seq does not corrupt the answer; `droppedCount>0` sets the coalesced hint.
- Error: malformed output frame → parse failure, reducer unaffected.
- No-output: terminal status, no output frame → no-output state, no block.

**Verification:** `operator-stream-core` accumulation tests green.

- [ ] **Unit 4: Render the run output in the SSR view (flag-gated, safe DOM)**

**Goal:** The run view exposes an output surface the browser client writes the answer into, via safe DOM, behind the flag.

**Requirements:** R4, KTD3

**Dependencies:** Unit 3

**Files:**
- Modify: `src/routes/operator.ts` (SSR run-detail output element + hook), `public/operator-stream.js` (write accumulated text via `textContent`/`createTextNode`)
- Test: `test/operator-ui.test.ts`, `test/operator-stream-core.test.ts`

**Approach:** Add a run-output element (mirror the `data-role`/`data-run-id` handoff hooks) to the SSR run view, only when the operator UI flag is on. The browser client writes the accumulated answer via `textContent` — never HTML interpolation. Render a minimal fixed-label "some output was coalesced" hint when the coalesced flag is set; never echo `droppedCount` into free text. Render the "no output" state for KTD4. No other output-frame field is rendered.

**Execution note:** Test-first — RED the SSR element presence (flag on) / absence (flag off) and the no-leak/no-HTML-interpolation render assertion.

**Patterns to follow:** the #63 SSE run-status SSR wiring (`data-role="run-status"`, `data-run-id`, the static module script) and the label-map/value-allowlist no-leak rendering.

**Test scenarios:**
- Flag on → the output element is present with the run hook; flag off → absent.
- Safe DOM: an output `text` containing HTML/script-looking content renders as inert text (no element injection).
- No leak: no `entityRef`/`surface`/runId leaked into the output surface; `droppedCount` not echoed as raw text.
- No-output: terminal status with no output → the no-output state renders.

**Verification:** SSR exposes the flag-gated output surface; render is injection-safe and leak-free; tests green.

- [ ] **Unit 5: Conformance + consumer test sweep**

**Goal:** Tests cover the full output channel per #47 scope 5.

**Requirements:** R6

**Dependencies:** Units 1–4

**Files:**
- Modify: `test/operator-contract-conformance.test.ts` (+ any gaps in the unit tests above)

**Approach:** Ensure the conformance suite asserts the vendored frame matches the canonical shape (type-assignability over every field incl. optional `droppedCount`), and that the consumer behaviors (accumulation, final replacement, seq, droppedCount, empty-vs-missing terminal, late-subscriber final-only) are pinned across the relevant suites. Fill any category gap (happy/edge/error/integration) left by Units 1–4.

**Test scenarios:** Test expectation: the matrix in #47 scope 5 is fully covered with synthetic fixtures.

**Verification:** Full suite green; no canonical private-repo identifiers in fixtures.

- [ ] **Unit 6: Learning doc (optional)**

**Goal:** Capture the durable learning if warranted (dual-parser parity + accumulation + no-output-is-absence).

**Dependencies:** Units 1–5

**Files:** Create `docs/solutions/best-practices/<slug>-2026-06-22.md` only if non-obvious post-merge (compound can do this after merge instead).

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** Documented if warranted, else deferred to ce:compound.

## System-Wide Impact

- Two independent SSE parsers (server + browser) must stay in lockstep — KTD1 guards drift with mirrored cases and tests.
- The browser reducer gains accumulation state; the absorbing-drift/contract-version gates are unchanged.
- The run view gains a flag-gated output surface; the operator UI flag default is unchanged (deploy decision).
- Read-only posture, no-leak rendering, fail-closed contract-version gate, and the no-dashboard-proxy topology are all unchanged.
- Approval surface stays mock-only (#48); no new live endpoint is wired.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Blocking on a terminal output frame that never comes (no-output run) | KTD4/R5 — treat absence as no-output; test it |
| HTML injection via free-form `text` | KTD3 — `textContent` only, injection-safe render test |
| Server/browser parser drift | KTD1 — mirrored cases + tests in both suites |
| seq gaps / duplicates corrupting the answer | KTD5 — seq-order apply, final replaces, idempotent; tests |
| Accidentally wiring approvals live | Scope boundary — approvals stay mock-only (#48) |
| Leaking other output-frame fields | Render only `text` (safe) + fixed coalesced hint; no-leak test |

## Sources & References

- Issue: fro-bot/dashboard#47
- Canonical contract (verified live): fro-bot/agent v0.74.0 `packages/gateway/src/operator-contract/output.ts`, `version.ts`, `index.ts`; `web/sse/run-stream-route.ts`, `web/sse/manager.ts`
- Code: `src/gateway/operator-contract/{version,sse-frames,index}.ts`, `src/gateway/operator-sse-reader.ts`, `src/gateway/operator-client.ts`, `public/operator-stream.js`, `src/routes/operator.ts`
- Learnings: `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md`, `safe-operator-launch-surface-2026-06-20.md`
