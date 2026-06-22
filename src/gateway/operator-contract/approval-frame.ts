/**
 * Operator run-stream approval frame (contract 1.4.0).
 *
 * Vendored byte-exact from fro-bot/agent
 * packages/gateway/src/operator-contract/approval-frame.ts at tag v0.76.0
 * (gateway PR #986).
 *
 * Delivered as `event: approval` on GET /operator/runs/:runId/stream.
 * The frame is a discriminated union on `settled`:
 *
 * - settled:false (open) — the agent has hit a tool gate and is waiting for
 *   an operator decision. `permission` names the gate class; `command` and
 *   `filepath` are optional gated-action strings (at most one is present for
 *   shell/fs gates; neither is present for other gate classes).
 * - settled:true (settle) — the gate has been resolved (by any cause: operator
 *   decision, deadline, or terminal run status). The consumer must dismiss the
 *   corresponding open prompt and tombstone the `requestID` so that a late-
 *   arriving open frame for the same id is ignored.
 *
 * Consumers MUST validate `runId` and `requestID` as non-empty strings on both
 * variants, and `permission` as a non-empty string on the open variant, before
 * acting on the frame. Malformed frames must be rejected fail-closed.
 */

// ---------------------------------------------------------------------------
// Open variant
// ---------------------------------------------------------------------------

export interface OperatorApprovalFrameOpen {
  readonly runId: string
  readonly requestID: string
  readonly permission: string
  readonly command?: string
  readonly filepath?: string
  readonly settled: false
}

// ---------------------------------------------------------------------------
// Settle variant
// ---------------------------------------------------------------------------

export interface OperatorApprovalFrameSettle {
  readonly runId: string
  readonly requestID: string
  readonly settled: true
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type OperatorApprovalFrame = OperatorApprovalFrameOpen | OperatorApprovalFrameSettle
