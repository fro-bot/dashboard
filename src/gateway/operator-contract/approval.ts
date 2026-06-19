/**
 * Approval-decision contract for the operator API surface.
 *
 * Vendored from fro-bot/agent packages/gateway/src/operator-contract/approval.ts
 * Import rewrite: ApprovalActor and DecisionOutcome (from ../approvals/registry.js)
 * are upstream-only types. The toOperatorDecisionState helper and DecisionInput
 * interface (which requires ApprovalActor) are omitted in this vendored copy.
 * The PUBLIC frozen type OperatorDecisionState is present and correct.
 *
 * ### v1.1 promotion candidates (kept in coordinator.ts for v1 to bound fan-out)
 * - `PermissionRequest`    (11-file fan-out)
 * - `PermissionReplyEvent` (2-file fan-out)
 * - `SettlementReason`     (5-file fan-out)
 */

// ---------------------------------------------------------------------------
// PermissionReply — sole definer (coordinator.ts re-exports from here)
// ---------------------------------------------------------------------------

/** Reply verbs accepted by the OpenCode permission reply endpoint. */
export type PermissionReply = 'once' | 'always' | 'reject'

// ---------------------------------------------------------------------------
// OperatorDecisionState — operator-facing decision-state set
// ---------------------------------------------------------------------------

/**
 * Operator-facing decision states for an approval entry.
 *
 * - `pending`         — implied pre-decision state: entry is open, no `DecisionOutcome` yet.
 *                       NOT produced by `toOperatorDecisionState` (which maps `DecisionOutcome`
 *                       values only); it is the state before any outcome exists.
 * - `claimed`         — decision was accepted and the reply was POSTed successfully (`ok`).
 * - `already_claimed` — a second decision arrived while the first POST was still in-flight;
 *                       the entry has NOT settled yet (NOT `already_settled`).
 * - `scope_mismatch`  — the `approvalScopeId` in the decision did not match the registered entry.
 * - `failed_to_settle`— the reply POST failed (threw or returned `ok:false`).
 * - `unavailable`     — no entry found for the given `requestID`.
 *
 * Note: `expired` is NOT in this set. It is a deadline/settlement-path state
 * (`SettlementReason 'deadline'`), not a `DecisionOutcome`; if exposed at all
 * it is derived separately from the deadline path, not from this mapping.
 */
export type OperatorDecisionState =
  | 'pending'
  | 'claimed'
  | 'already_claimed'
  | 'scope_mismatch'
  | 'failed_to_settle'
  | 'unavailable'
