/**
 * Single public import authority for the operator API contract (vendored copy).
 *
 * Vendored from fro-bot/agent packages/gateway/src/operator-contract/index.ts
 * at tag v0.71.0 (PR #952, commit 92b621e1).
 *
 * Omissions vs upstream barrel:
 * - toOperatorDecisionState: omitted — requires DecisionOutcome (upstream-only registry type)
 * - toOperatorRunStatus: omitted — requires RunState (upstream-only coordination type)
 * - DecisionInput: omitted — requires ApprovalActor (upstream-only registry type)
 *
 * The PUBLIC frozen types (unions + response interfaces + parse helpers) are all present.
 *
 * Design constraints:
 * - Effect Schema is never part of the exported surface (plain TS + Result only).
 * - All exported types are transport-stable; internal coordination fields are excluded
 *   by construction.
 * - The contract version is build-time pinned and never negotiated over the wire.
 */

export type {OperatorApprovalFrame} from './approval-frame.ts'
export type {OperatorDecisionState, PermissionReply} from './approval.ts'
export type {OperatorIdentity} from './identity.ts'
export type {OperatorOutputFrame} from './output.ts'
export {parseOperatorCsrfToken, parseOperatorError, parseOperatorOk, parseOperatorSessionInfo} from './parse.ts'
export type {PushHandoffState, PushSubscriptionMetadata, VapidKeyResponse} from './push.ts'
export {parsePushHandoffState, parsePushSubscriptionMetadata, parseVapidKeyResponse} from './push.ts'
export {assertRedactionApplied, AUTHORIZATION_OBLIGATION, REDACTION_OBLIGATION} from './redaction.ts'
export type {RedactionContext} from './redaction.ts'
export type {RepoSummary} from './repo-summary.ts'
export {parseRepoSummary, parseRepoSummaryList} from './repo-summary.ts'
export type {OperatorCsrfToken, OperatorError, OperatorOk, OperatorSessionInfo} from './responses.ts'
export type {OperatorFailureKind, OperatorRunStatus, OperatorWebStatus, RunPhase, Surface} from './run-status.ts'
export type {RunsListResponse, RunSummary, RunSummaryStatus} from './run-summary.ts'
export {parseRunsListResponse, parseRunSummary, parseRunSummaryList, RUN_INDEX_CAP} from './run-summary.ts'
export type {ReadyFrame, ResetFrameData, ResetReason, RunStreamFrame, StatusFrameData} from './sse-frames.ts'
export {OPERATOR_CONTRACT_VERSION} from './version.ts'
