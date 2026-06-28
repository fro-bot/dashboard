---
title: "fix: Repair operator contract 1.5 stream drift"
type: fix
status: active
date: 2026-06-27
origin: docs/brainstorms/2026-06-27-operator-local-development-harness-requirements.md
---

# fix: Repair operator contract 1.5 stream drift

## Overview

The live Gateway now emits operator contract `1.5.0`, while the dashboard still pins `1.4.0` in both its TypeScript stream reader and browser runtime. The mismatch correctly fails closed, but it makes live runs appear blank even when the stream contains status and output frames.

This plan repairs the urgent drift only. The local fixture-backed harness and real local Gateway path remain follow-on work from the origin document.

## Problem Frame

An operator can launch a run and receive a valid stream, but the dashboard rejects the first `ready` frame because its pinned contract is stale. Once drift is detected, the browser runtime clears run state and ignores later status/output frames. That absorbing drift behavior must stay intact for unknown future contracts; the fix is to support the known current contract and enforce lockstep pins so this does not recur.

## Requirements Trace

- R1. Dashboard supports current Gateway operator contract `1.5.0` in both TypeScript and browser stream consumers.
- R2. The repair documents the consumed `1.4.0` to `1.5.0` surface diff and covers consumed events, fields, and semantics with tests.
- R3. Unknown contract versions remain strict fail-closed states; no partial status/output/approval rendering after drift.
- R4. A `1.5.0` stream containing status and output frames renders visible run output.
- R5. Browser and vendored TypeScript contract pins are verified in lockstep.

## Scope Boundaries

- Do not make contract mismatches permissive or retryable.
- Do not add support for the new run-index route or `RunSummary` DTO in this PR.
- Do not implement the fixture-backed local harness in this PR.
- Do not change Gateway OAuth/session behavior or local Gateway topology.
- Do not reintroduce the monitoring UI as a fallback.

### Deferred to Separate Tasks

- Fixture-backed local operator harness: separate plan from the same origin requirements document.
- Real local `fro-bot/agent` Gateway mode: separate research/planning pass gated by auth/session fidelity.
- Run-index de-mock adoption of `GET /operator/runs`: existing run-index plan, not this drift repair.

## Context & Research

### Relevant Code and Patterns

- `src/gateway/operator-contract/version.ts` pins the vendored TypeScript contract at `1.4.0`.
- `public/operator-stream.js` pins the browser runtime contract separately at `1.4.0`.
- `src/gateway/operator-sse-reader.ts` imports the TypeScript pin and fails closed if the first frame is missing, malformed, or mismatched.
- `public/operator-stream.js` treats drift as absorbing: it clears run state, stops reconnecting, and ignores later frames.
- `test/operator-contract-conformance.test.ts`, `test/operator-sse-reader.test.ts`, and `test/operator-stream-core.test.ts` carry hardcoded `1.4.0` ready-frame fixtures and pin assertions.
- Pinned `fro-bot/agent` source under `.slim/clonedeps/repos/fro-bot__agent/` defines `OPERATOR_CONTRACT_VERSION = '1.5.0'` and emits it as the first stream frame.

### Consumed Contract Diff

- On-wire stream JSON consumed by the dashboard is unchanged for ready, status, reset, output, and approval frames.
- Session, CSRF, repo-list, decision, ok, and error DTOs remain compatible for this repair.
- `1.5.0` adds run-summary contract surface and a run-index route, but that is not consumed by this track.
- Output frame type shape is unchanged, but semantics changed: no-output runs now guarantee an empty terminal output frame. The existing reducer already handles empty final frames; local contract comments and the output solution doc are stale.
- Gateway internal type names changed around approval frame data, but the stream wire shape remains compatible because the route still injects `runId` on emitted frames.

### Institutional Learnings

- `docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md` documents the lockstep gotcha: bumping only the vendored contract pin leaves the browser stream client failing closed.
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md` documents that contract drift must stay absorbing and that all consumers must move together.
- `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md` reinforces that the ready-frame gate and buffered dispatch path must both stay fail-closed.
- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md` keeps operator fail states uniform and avoids reviving monitoring as a fallback.

## Key Technical Decisions

- **Strict bump, not compatibility negotiation:** Accept exactly `1.5.0`; keep unknown current/future versions fail-closed.
- **Two pins, one invariant:** Keep the plain browser runtime literal, but add a test that compares it to the vendored TypeScript contract pin.
- **Update stale output semantics:** Bring local contract comments and solution guidance forward to the `1.5.0` guarantee so future tests do not encode obsolete no-output behavior.
- **Do not adopt run index here:** `RunSummary` is new in the Gateway contract but unrelated to rendering the already-open stream.

## Open Questions

### Resolved During Planning

- What changed from `1.4.0` to `1.5.0`? On-wire stream shapes consumed by the dashboard are compatible; the material changes for this repair are the version literal and output no-output semantics.
- Should doc cleanup ride with the drift fix? Yes. The stale output guidance contradicts the current contract and would mislead the next output-related change.

### Deferred to Implementation

- Exact parity-test seam: implementer may import the browser module directly or parse the browser literal as text, as long as the test proves both runtime pins are equal without adding a build step.

## Implementation Units

- [x] **Unit 1: Bump contract pins in lockstep**

**Goal:** Update both dashboard stream consumers to accept Gateway contract `1.5.0`.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Modify: `src/gateway/operator-contract/version.ts`
- Modify: `public/operator-stream.js`
- Test: `test/operator-contract-conformance.test.ts`
- Test: `test/operator-stream-core.test.ts`

**Approach:**
- Advance the vendored TypeScript contract pin and the browser runtime pin together.
- Add a parity assertion that fails if the two pins diverge in future bumps.
- Keep drift handling strict; only the known pin changes.

**Execution note:** Start with failing pin/parity tests before changing production constants.

**Patterns to follow:**
- Existing contract conformance tests in `test/operator-contract-conformance.test.ts`.
- Lockstep guidance in `docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md`.

**Test scenarios:**
- Happy path: vendored TypeScript contract pin is `1.5.0`.
- Happy path: browser runtime contract pin is `1.5.0`.
- Regression: browser runtime pin equals the vendored TypeScript contract pin.

**Verification:**
- Both consumers accept the same current contract version and the parity test prevents a one-sided bump.

- [x] **Unit 2: Update stream fixtures and conformance coverage**

**Goal:** Move ready-frame fixtures and version-specific assertions from `1.4.0` to `1.5.0` without weakening mismatch tests.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 1

**Files:**
- Modify: `test/operator-contract-conformance.test.ts`
- Modify: `test/operator-sse-reader.test.ts`
- Modify: `test/operator-stream-core.test.ts`

**Approach:**
- Update success-path ready-frame fixtures to the new current contract.
- Preserve intentional mismatch fixtures that prove fail-closed behavior.
- Add explicit future-version coverage so a newer unknown contract still does not render partial data.

**Execution note:** Use test-first assertions for the new current version and future-version rejection before broad fixture replacement.

**Patterns to follow:**
- Existing drift tests that assert no status frames dispatch after mismatch.
- Existing absorbing-drift reducer tests in the browser runtime suite.

**Test scenarios:**
- Happy path: TypeScript reader dispatches frames after a `1.5.0` ready frame.
- Happy path: browser reducer transitions to live after a `1.5.0` ready frame.
- Error path: future unsupported contract followed by status/output remains drifted and dispatches nothing.
- Error path: first frame not ready still fails closed.

**Verification:**
- Old current-version fixtures no longer require `1.4.0`, while negative drift fixtures still fail closed.

- [x] **Unit 3: Add live status-plus-output regression coverage**

**Goal:** Prove the observed live stream shape renders output after the contract bump.

**Requirements:** R2, R4

**Dependencies:** Units 1 and 2

**Files:**
- Modify: `test/operator-sse-reader.test.ts`
- Modify: `test/operator-stream-core.test.ts`

**Approach:**
- Cover the sequence that failed live: current ready frame, running status, output delta.
- Ensure output text is applied through the same parser/reducer path as production rather than through a shortcut fixture.
- Include empty terminal output behavior to match the `1.5.0` guarantee.

**Execution note:** Add regression tests before adjusting any reducer expectations.

**Patterns to follow:**
- Output accumulation and authoritative-final tests in `test/operator-stream-core.test.ts`.
- Stream parser chunk tests in `test/operator-sse-reader.test.ts`.

**Test scenarios:**
- Integration: ready `1.5.0` plus status plus output dispatches status and output frames in order.
- Happy path: browser reducer appends non-final output for an observed run.
- Happy path: browser reducer applies an empty final output frame as authoritative no-output state.
- Regression: status updates preserve accumulated output.

**Verification:**
- The concrete live failure mode has a test that fails before the bump and passes after the repair.

- [x] **Unit 4: Refresh vendored contract notes and institutional guidance**

**Goal:** Remove stale local guidance that still describes pre-`1.5.0` output semantics.

**Requirements:** R2

**Dependencies:** Unit 3

**Files:**
- Modify: `src/gateway/operator-contract/output.ts`
- Modify: `src/gateway/operator-contract/sse-frames.ts`
- Modify: `src/gateway/operator-contract/README.md`
- Modify: `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`

**Approach:**
- Update contract comments to reflect the pinned `fro-bot/agent` source and current output semantics.
- Replace obsolete “no terminal output frame for no-output runs” guidance with the current empty-terminal-frame guarantee.
- Preserve the existing guidance that terminal status, not output presence, remains the completion signal.

**Patterns to follow:**
- Existing `docs/solutions/` frontmatter and concise problem/solution structure.
- Current Gateway `output.ts` contract wording in the pinned cloned source.

**Test scenarios:**
- Test expectation: none — documentation/comment-only unit. Existing output tests from Unit 3 cover the behavior being documented.

**Verification:**
- Contract docs, solution guidance, and tests describe the same output semantics.

## System-Wide Impact

- **Interaction graph:** The stream reader, browser runtime reducer, and operator PWA shell all depend on the ready-frame contract gate.
- **Error propagation:** Drift remains terminal for a stream lifetime; future unknown versions still produce fail-closed state with no partial rendering.
- **State lifecycle risks:** Status frames must continue preserving accumulated output, including empty final output.
- **API surface parity:** No production dashboard operator proxy routes are added; same-origin Gateway routing remains external to the dashboard app.
- **Integration coverage:** Browser verification should prove the assembled PWA loads the updated `public/operator-stream.js`, not just the TypeScript tests.
- **Unchanged invariants:** Read-only dashboard posture, no monitoring fallback, no credential forwarding, and no softened contract mismatch branch.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Only one contract pin is bumped | Add parity coverage comparing the browser runtime pin to the vendored TypeScript pin. |
| Fixture replacement weakens drift tests | Keep explicit mismatch and future-version negative cases. |
| Stale no-output docs cause future regressions | Update vendored comments and solution guidance in the same repair. |
| Browser bundle still serves old runtime code | Run browser verification against a rebuilt no-watch server after tests pass. |
| Run-index contract changes leak into this repair | Keep `RunSummary` and `GET /operator/runs` out of scope. |

## Documentation / Operational Notes

- PR notes should mention that this is the dashboard half of the Gateway `1.5.0` operator contract bump.
- Release verification should exercise an actual operator stream with status and output after deploy.
- The follow-on local harness plan should reuse the new `1.5.0` status-plus-output regression as its first fixture scenario.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-06-27-operator-local-development-harness-requirements.md`
- `src/gateway/operator-contract/version.ts`
- `public/operator-stream.js`
- `src/gateway/operator-sse-reader.ts`
- `.slim/clonedeps/repos/fro-bot__agent/packages/gateway/src/operator-contract/version.ts`
- `.slim/clonedeps/repos/fro-bot__agent/packages/gateway/src/operator-contract/output.ts`
- `.slim/clonedeps/repos/fro-bot__agent/packages/gateway/src/web/sse/run-stream-route.ts`
- `docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md`
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md`
- `docs/solutions/best-practices/authenticated-sse-consumption-fetch-stream-no-leak-2026-06-20.md`
- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md`
