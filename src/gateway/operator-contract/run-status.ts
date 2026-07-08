/**
 * Operator-safe run-status projection.
 *
 * Mirrors fro-bot/agent's operator-contract/run-status.ts (v0.83.1). The
 * projection helper (toOperatorRunStatus) and internal error-kind mapping
 * are intentionally omitted — the dashboard only consumes the closed public
 * types below directly from the gateway API.
 *
 * Security: OperatorRunStatus carries only operator-safe fields. Internal
 * coordination fields (holder_id, thread_id, details) are excluded by
 * construction — they do not appear in this type.
 */

// ---------------------------------------------------------------------------
// Inlined boundary types from @fro-bot/runtime (minimal, frozen literals only)
// ---------------------------------------------------------------------------

/** Run lifecycle phases (exact frozen literal values from the upstream contract). */
export type RunPhase = 'PENDING' | 'ACKNOWLEDGED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

/** Surface discriminant — the integration surface that initiated the run. */
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
  readonly failureKind?: OperatorFailureKind
}

// ---------------------------------------------------------------------------
// OperatorFailureKind
// ---------------------------------------------------------------------------

/**
 * The operator-facing failure-reason enum.
 *
 * A closed allowlist vendored verbatim from upstream (derived from
 * RunCoreErrorKind, the internal error-kind vocabulary). 'unknown' is the
 * fallback for any internal kind with no mapping entry (defense-in-depth:
 * unmapped/future/unrecognized kinds never leak past this gate).
 */
export type OperatorFailureKind =
  | 'inactivity-timeout'
  | 'max-duration-timeout'
  | 'stream-ended'
  | 'workspace-unreachable'
  | 'session-error'
  | 'unknown'

/**
 * Allowlist of OperatorFailureKind values, for gating untrusted input.
 * 'unknown' is the fallback for any internal kind with no mapping — unmapped
 * or unrecognized kinds never leak past this gate.
 */
export const OPERATOR_FAILURE_KINDS: ReadonlySet<OperatorFailureKind> = new Set([
  'inactivity-timeout',
  'max-duration-timeout',
  'stream-ended',
  'workspace-unreachable',
  'session-error',
  'unknown',
])

/** Narrow an unknown value to OperatorFailureKind if it's in the allowlist. */
export function isOperatorFailureKind(value: unknown): value is OperatorFailureKind {
  return typeof value === 'string' && OPERATOR_FAILURE_KINDS.has(value as OperatorFailureKind)
}
