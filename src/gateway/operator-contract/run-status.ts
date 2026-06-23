/**
 * Operator-safe run-status projection.
 *
 * Vendored from fro-bot/agent packages/gateway/src/operator-contract/run-status.ts
 * Import rewrite: @fro-bot/runtime types (RunPhase, Surface, RunState) are INLINED
 * as minimal local boundary type definitions that preserve the exact frozen literal
 * unions. The toOperatorRunStatus helper is omitted because it depends on RunState
 * (an upstream-only coordination type with internal fields). The PUBLIC frozen types
 * (OperatorWebStatus, OperatorRunStatus, RunPhase, Surface) are present and correct.
 *
 * Security: OperatorRunStatus carries only operator-safe fields. The internal
 * coordination fields holder_id, thread_id, and details are excluded by construction.
 *
 * Note: toOperatorRunStatus is omitted in this vendored copy — it requires RunState
 * (an upstream-only coordination type). The dashboard does not need the projection
 * helper; it consumes OperatorRunStatus values directly from the gateway API.
 */

// ---------------------------------------------------------------------------
// Inlined boundary types from @fro-bot/runtime (minimal, frozen literals only)
// ---------------------------------------------------------------------------

/**
 * Run lifecycle phases (inlined from @fro-bot/runtime).
 * These are the exact frozen literal values from the upstream contract.
 */
export type RunPhase = 'PENDING' | 'ACKNOWLEDGED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

/**
 * Surface discriminant (inlined from @fro-bot/runtime).
 * Identifies the integration surface that initiated the run.
 */
export type Surface = 'github' | 'discord' | 'web'

// ---------------------------------------------------------------------------
// OperatorWebStatus
// ---------------------------------------------------------------------------

/**
 * The 7-value operator-facing web status set (snake_case).
 *
 * 'blocked' and 'waiting_for_approval' are endpoint-layer overlays derived from
 * queue/registry state — they are NOT produced by toOperatorRunStatus (which maps
 * RunPhase only). The snapshot endpoint layers them on top after projection.
 */
export type OperatorWebStatus =
  | 'queued'
  | 'blocked'
  | 'running'
  | 'waiting_for_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

// ---------------------------------------------------------------------------
// OperatorRunStatus
// ---------------------------------------------------------------------------

/**
 * Operator-safe projection of a run's status.
 *
 * Carries only the fields safe to expose to an operator web client.
 * Internal coordination fields (holder_id, thread_id, details) are excluded
 * by construction — they do not appear in this type.
 */
export interface OperatorRunStatus {
  readonly runId: string
  readonly entityRef: string
  readonly surface: Surface
  readonly phase: RunPhase
  readonly status: OperatorWebStatus
  readonly startedAt: string
  readonly stale: boolean
}
