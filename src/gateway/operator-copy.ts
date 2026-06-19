/**
 * Operator-safe display copy mapping.
 *
 * Maps backend terms → human-readable operator-safe display copy.
 *
 * CRITICAL invariants:
 * - 'failed_to_settle' MUST NEVER be the primary UI label.
 * - No raw backend enum tokens as primary copy.
 * - Machine values are available only as non-primary detail (e.g. small monospace
 *   secondary text), never as the headline.
 * - Copy must NOT imply dashboard auth authorizes Gateway actions.
 */
import type {ApprovalDecisionState, RunStatus, RunStreamEvent} from './operator-client.ts'

/**
 * Human-readable label for a run status.
 * Never returns the raw backend token as the primary label.
 */
export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued — waiting to start'
    case 'running':
      return 'Running'
    case 'waiting_for_approval':
      return 'Waiting for approval'
    case 'blocked':
      return 'Blocked — cannot proceed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'succeeded':
      return 'Completed successfully'
  }
}

/**
 * Human-readable label for an approval decision state.
 * CRITICAL: 'failed_to_settle' must NEVER be the primary label.
 * Maps it to safe copy: "Couldn't finalize the decision".
 *
 * Canonical OperatorDecisionState values per contract v1.0.0:
 * pending | claimed | already_claimed | scope_mismatch | failed_to_settle | unavailable
 */
export function approvalStateLabel(state: ApprovalDecisionState): string {
  switch (state) {
    case 'pending':
      return 'Awaiting your decision'
    case 'claimed':
      return 'Decision in progress — claimed for review'
    case 'already_claimed':
      // already_claimed: a second decision arrived while the first POST was still in-flight.
      // The entry has NOT settled yet — this is NOT "already done".
      return 'Decision already in progress — no duplicate action sent'
    case 'scope_mismatch':
      return "Approval scope didn't match — decision not applied"
    case 'failed_to_settle':
      return "Couldn't finalize the decision — please try again"
    case 'unavailable':
      return 'Approval unavailable at this time'
  }
}

/**
 * Human-readable label for a stream event type.
 * Used for displaying event timeline entries.
 */
export function streamEventLabel(type: RunStreamEvent['type']): string {
  switch (type) {
    case 'heartbeat':
      return 'Connection active'
    case 'run.state':
      return 'Run status updated'
    case 'run.output':
      return 'Output received'
    case 'run.error':
      return 'Run error'
    case 'approval.pending':
      return 'Approval requested'
    case 'approval.claimed':
      return 'Approval claimed for review'
    case 'approval.confirmed':
      return 'Approval decision recorded'
    case 'approval.expired':
      return 'Approval window expired'
    case 'approval.failed_to_settle':
      return "Couldn't finalize the approval decision"
    case 'stream.reset':
      return 'Stream reconnected'
    default:
      return 'Event received'
  }
}
