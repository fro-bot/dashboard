Source: fro-bot/agent
Path: packages/gateway/src/operator-contract/ (contract barrel) + packages/gateway/src/web/sse/ (SSE surface)
Contract version: exported as `OPERATOR_CONTRACT_VERSION` in `version.ts`, the single source. No other file, comment,
or test hand-types a version or release tag; tests compare against the constant.
Vendored copy — do not hand-edit behavior. Refresh by re-copying upstream and
re-applying the documented import rewrites (@fro-bot/runtime → ../../result.ts;
inlined boundary types for RunPhase/Surface/RunState).

## Files and their upstream sources

- `run-status.ts`, `approval.ts`, `identity.ts`, `parse.ts`, `redaction.ts`,
  `responses.ts`, `version.ts` — vendored from the operator-contract barrel
  (packages/gateway/src/operator-contract/).
- `provenance.ts` — vendored from the operator-contract barrel, whole: it keeps
  upstream's types and parsers (`parseOperatorCheckoutProvenance`,
  `parseOperatorCheckoutPreparation`) as-is. Beyond the comment rewording below,
  the dashboard applies exactly three edits:
  - `export` is added to the existing vocabulary sets (`CHECKOUT_OPERATIONS`,
    `LAYOUT_REFUSAL_REASONS`, `OBSTRUCTION_KINDS`, `UPDATE_FAILURE_REASONS`), so
    coverage tests can read them at runtime.
  - `CHECKOUT_REFUSAL_REASONS` is added, an exported list of the refusal reasons.
    A compile-time check (`CheckoutRefusalReasonsAreExact`) fails the type check if
    the list and `OperatorCheckoutPreparationRefused['reason']` differ in either
    direction.
  - Both parsers return freshly constructed objects holding only contract fields, never
    the input or its nested parts, so extra input keys cannot reach the reader's frames.
  Comments that name contract versions are reworded so no version literal remains.
  Accept/reject behavior is unchanged. The dashboard server reader calls both parsers on status
  frames. It applies no length caps or sanitizing: the browser is the sanitization
  boundary, so any future server-side consumer must apply the same caps first.
- `output.ts` — carries upstream's note that after `reset` (`no-snapshot`) a terminal run sends
  only the terminal status frame and no output frame, reworded to fit the dashboard's existing
  comment. `run-status.ts` adds `waiting_for_question` to `OperatorWebStatus`, in upstream's
  position and wording (precedence: `waiting_for_approval` wins).
- `question-frame.ts` — vendored from the operator-contract barrel. The upstream file is
  types only, so its types are copied verbatim, apart from one comment reworded so no
  version literal remains and whitespace changes from the repo's lint autofix. Everything after the marker comment near the end of the file is
  dashboard-authored and has no upstream counterpart. The deviations, all additions:
  - `QUESTION_DECISION_STATES` and `QUESTION_INVALID_REASONS` are exported runtime lists of the
    decision states and invalid-answer reasons (a union is erased at runtime, so coverage tests
    and the browser need values to read). Compile-time checks
    (`QuestionDecisionStatesAreExact`, `QuestionInvalidReasonsAreExact`) fail the type check if a
    list and its union differ in either direction.
  - The upstream bounds are exported as constants (`QUESTION_HEADER_MAX_LENGTH`,
    `QUESTION_TEXT_MAX_LENGTH`, `QUESTION_OPTION_LABEL_MAX_LENGTH`,
    `QUESTION_OPTION_DESCRIPTION_MAX_LENGTH`, `MAX_QUESTIONS_PER_REQUEST`,
    `MAX_OPTIONS_PER_QUESTION`). They come from the gateway's `approvals/question-detail.ts`
    build site, not from the contract barrel.
  - `sanitizeQuestionText` applies the shared text rule: tab, newline and carriage return become
    spaces; other C0 and C1 controls, DEL, and every Unicode bidi control (including U+061C and
    the marks U+200E/U+200F) are removed. The upstream build site removes a narrower set (it keeps
    the marks and U+061C), so the dashboard removes strictly more. It is the same bidi set the
    browser's checkout sanitizer uses.
  - `parseQuestionFrame` validates a `question` frame payload. The gateway builds the same frames
    but ships no parser, so this is locally authored. It is closed at every level: a key outside
    the contract (including an own `__proto__`) rejects the frame, and the result is rebuilt field
    by field, so no input object reaches a caller. It enforces the bounds above on the sanitized
    text and rejects, never truncates, an over-bound or malformed frame. A request with zero
    questions and a question with zero options both parse. This differs from the checkout
    parsers, which drop extra keys; a question frame is a closed wire shape.
  - `PendingQuestionDTO`, the decision request types, and the decision response types are
    copied as upstream has them. The dashboard server has no caller for them yet.
- `sse-frames.ts` — vendored from the gateway's web/sse/ surface
  (packages/gateway/src/web/sse/). This is a parallel surface to
  the contract barrel; it is NOT part of the upstream operator-contract barrel
  export. The SSE frame types (ReadyFrame, StatusFrameData, ResetFrameData,
  RunStreamFrame, ResetReason) are re-exported from the dashboard's contract
  barrel for convenience. `RunStreamFrame` carries a `question` variant whose data is
  `QuestionFrameData`.
- `repo-summary.ts` — locally authored (PR #968 adds RepoSummary to the upstream
  contract, but no upstream parse helper exists). The type definition
  is faithful to the upstream interface; the parse guards follow the same
  hand-rolled type-guard + fixed-reason-string pattern as parse.ts.
- `push.ts` — locally authored for the dashboard's operator Web Push companion
  feature (`docs/plans/2026-07-08-001-feat-operator-push-notifications-dashboard-plan.md`).
  `VapidKeyResponse` mirrors the Gateway's `GET /operator/push/vapid-key`
  response and deliberately omits any version field beyond `keyVersion` — the
  Gateway returns only `{publicKey, keyVersion}`, no `contractVersion`.
  `PushSubscriptionMetadata` mirrors the Gateway's safe-metadata response from
  `GET /operator/push/subscriptions` (opaque `endpointHash` only — never the
  raw endpoint, `p256dh`, or `auth` keys). `PushHandoffState` is client-derived,
  not a wire field: the Gateway exposes no handoff-state route, so the
  dashboard computes it from subscription metadata plus local browser state.
  It is defined here so the vendored contract and the web-side duplicate
  (`web/src/push/push-types.ts`) share one canonical string set.

## Omissions vs upstream

The following upstream exports are omitted because they depend on upstream-only types:

- `toOperatorDecisionState` — requires `DecisionOutcome` from `../approvals/registry.js`
- `toOperatorRunStatus` — requires `RunState` from `@fro-bot/runtime`
- `toOperatorFailureKind` and the internal error-kind mapping — require
  `RunCoreErrorKind` from gateway-only execute code. `run-status.ts` keeps a local
  `OPERATOR_FAILURE_KINDS` set and `isOperatorFailureKind` instead.
- `DecisionInput` — requires `ApprovalActor` from `../approvals/registry.js`

The PUBLIC frozen types (OperatorDecisionState, OperatorWebStatus, OperatorRunStatus,
OperatorSessionInfo, OperatorCsrfToken, OperatorOk, OperatorError, OperatorIdentity,
RunPhase, Surface, PermissionReply, RedactionContext, ReadyFrame, StatusFrameData,
ResetFrameData, RunStreamFrame, ResetReason, and the checkout provenance and preparation
types) are all present and correct.

## Import rewrites applied

- `parse.ts`: `import type {Result} from '@fro-bot/runtime'` → `import type {Result} from '../../result.ts'`
- `parse.ts`: `import {err, ok} from '@fro-bot/runtime'` → `import {err, ok} from '../../result.ts'`
- `run-status.ts`: `import type {RunPhase, RunState, Surface} from '@fro-bot/runtime'` → inlined as local type definitions
- `run-status.ts`: `import type {RunCoreErrorKind} from '../execute/run-core.js'` → removed (projection helpers omitted)
- `run-status.ts`: the relative import of `./provenance.js` → `./provenance.ts`
- `approval.ts`: `import type {ApprovalActor, DecisionOutcome} from '../approvals/registry.js'` → removed (dependent helpers omitted)
- `sse-frames.ts`: `import type {OperatorRunStatus} from '@fro-bot/runtime'` → `import type {OperatorRunStatus} from './run-status.ts'`
