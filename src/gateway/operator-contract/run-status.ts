/**
 * Operator-safe run-status projection.
 *
 * Mirrors fro-bot/agent's operator-contract/run-status.ts. The projection
 * helper (toOperatorRunStatus) and internal error-kind mapping are
 * intentionally omitted — the dashboard only consumes the closed public
 * types below directly from the gateway API.
 *
 * Security: OperatorRunStatus carries only operator-safe fields. Internal
 * coordination fields (holder_id, thread_id, details) are excluded by
 * construction — they do not appear in this type.
 */

import type {OperatorCheckoutPreparation, OperatorCheckoutProvenance} from './provenance.ts'

// ---------------------------------------------------------------------------
// Inlined boundary types from @fro-bot/runtime (minimal, frozen literals only)
// ---------------------------------------------------------------------------

/** Run lifecycle phases (exact frozen literal values from the upstream contract). */
export type RunPhase = 'PENDING' | 'ACKNOWLEDGED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

/** Terminal run phases (exact frozen literal values from the upstream contract). */
export type TerminalPhase = 'COMPLETED' | 'FAILED' | 'CANCELLED'

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

/**
 * Maps a RunPhase to its operator-facing web status.
 *
 * 'blocked' and 'waiting_for_approval' are NOT in this map — they are
 * endpoint-layer overlays, not derivable from RunPhase alone.
 */
export const PHASE_TO_WEB_STATUS: Readonly<Record<RunPhase, OperatorWebStatus>> = {
  PENDING: 'queued',
  ACKNOWLEDGED: 'running',
  EXECUTING: 'running',
  COMPLETED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

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
  /**
   * What this run started from (the checked-out commit/branch, worktree
   * cleanliness, any in-progress operation). Present ONLY on runs that reached
   * EXECUTING — i.e. inspection ran and the run actually started. A run that
   * fails before EXECUTING (e.g. `checkout-substituted`, `workspace-unavailable`)
   * has no checkout provenance to report; its reason is carried in `failureKind`
   * instead, never persisted here.
   *
   * Absent (`undefined`) both for a run that never reached EXECUTING and for a
   * run recorded before this field existed, or if the stored value is malformed
   * — all collapse to the same "no provenance recorded" state. Never a claim
   * about the CURRENT tree — it describes the starting point only.
   */
  readonly checkoutProvenance?: OperatorCheckoutProvenance
  /**
   * What preparation reported when it refused or failed BEFORE the run reached
   * EXECUTING. Mutually exclusive with `checkoutProvenance` in practice, but the
   * two fields are independent optionals on this type, not a discriminated pair;
   * nothing here enforces that exclusivity structurally. Absent for a run that
   * reached EXECUTING, one that predates this field, or a malformed stored value.
   */
  readonly checkoutPreparation?: OperatorCheckoutPreparation
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
 *
 * This union may gain values over time. Consumers that switch over it must
 * handle unrecognized values gracefully rather than assuming the set is fixed.
 * 'checkout-substituted' (a correctness failure) and 'workspace-unavailable'
 * (non-retriable) are kept apart from the transient 'workspace-unreachable'.
 */
export type OperatorFailureKind =
  | 'inactivity-timeout'
  | 'max-duration-timeout'
  | 'stream-ended'
  | 'workspace-unreachable'
  | 'session-error'
  | 'checkout-substituted'
  | 'workspace-unavailable'
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
  'checkout-substituted',
  'workspace-unavailable',
  'unknown',
])

/** Narrow an unknown value to OperatorFailureKind if it's in the allowlist. */
export function isOperatorFailureKind(value: unknown): value is OperatorFailureKind {
  return typeof value === 'string' && OPERATOR_FAILURE_KINDS.has(value as OperatorFailureKind)
}
