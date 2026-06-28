Source: fro-bot/agent  | Tag: v0.78.0
Path: packages/gateway/src/operator-contract/ (contract barrel) + packages/gateway/src/web/sse/ (SSE surface)
Contract: OPERATOR_CONTRACT_VERSION = 1.5.0
Vendored copy — do not hand-edit behavior. Refresh by re-copying upstream and
re-applying the documented import rewrites (@fro-bot/runtime → ../../result.ts;
inlined boundary types for RunPhase/Surface/RunState).

## Files and their upstream sources

- `run-status.ts`, `approval.ts`, `identity.ts`, `parse.ts`, `redaction.ts`,
  `responses.ts`, `version.ts` — vendored from the operator-contract barrel
  (packages/gateway/src/operator-contract/) at v0.78.0.
- `sse-frames.ts` — vendored from the gateway's web/sse/ surface
  (packages/gateway/src/web/sse/) at v0.78.0. This is a parallel surface to
  the contract barrel; it is NOT part of the upstream operator-contract barrel
  export. The SSE frame types (ReadyFrame, StatusFrameData, ResetFrameData,
  RunStreamFrame, ResetReason) are re-exported from the dashboard's contract
  barrel for convenience.
- `repo-summary.ts` — locally authored (PR #968 adds RepoSummary to the upstream
  contract at v0.73.0, but no upstream parse helper exists). The type definition
  is faithful to the upstream interface; the parse guards follow the same
  hand-rolled type-guard + fixed-reason-string pattern as parse.ts.

## Omissions vs upstream

The following upstream exports are omitted because they depend on upstream-only types:

- `toOperatorDecisionState` — requires `DecisionOutcome` from `../approvals/registry.js`
- `toOperatorRunStatus` — requires `RunState` from `@fro-bot/runtime`
- `DecisionInput` — requires `ApprovalActor` from `../approvals/registry.js`

The PUBLIC frozen types (OperatorDecisionState, OperatorWebStatus, OperatorRunStatus,
OperatorSessionInfo, OperatorCsrfToken, OperatorOk, OperatorError, OperatorIdentity,
RunPhase, Surface, PermissionReply, RedactionContext, ReadyFrame, StatusFrameData,
ResetFrameData, RunStreamFrame, ResetReason) are all present and correct.

## Import rewrites applied

- `parse.ts`: `import type {Result} from '@fro-bot/runtime'` → `import type {Result} from '../../result.ts'`
- `parse.ts`: `import {err, ok} from '@fro-bot/runtime'` → `import {err, ok} from '../../result.ts'`
- `run-status.ts`: `import type {RunPhase, RunState, Surface} from '@fro-bot/runtime'` → inlined as local type definitions
- `approval.ts`: `import type {ApprovalActor, DecisionOutcome} from '../approvals/registry.js'` → removed (dependent helpers omitted)
- `sse-frames.ts`: `import type {OperatorRunStatus} from '@fro-bot/runtime'` → `import type {OperatorRunStatus} from './run-status.ts'`
