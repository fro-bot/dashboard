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

// ---------------------------------------------------------------------------
// Approval prompt copy — inline prompt UI (Unit 5)
// ---------------------------------------------------------------------------

/**
 * Human-readable label for a permission category.
 * Used to label the gated action in the inline approval prompt.
 * Returns a safe fixed label — never echoes the raw permission string.
 */
export function permissionLabel(permission: string): string {
  switch (permission) {
    case 'shell':
      return 'Shell command'
    case 'edit':
      return 'File edit'
    case 'external_directory':
      return 'External directory access'
    case 'network':
      return 'Network access'
    case 'read':
      return 'File read'
    case 'write':
      return 'File write'
    default:
      // Unknown permission — return a safe generic label, never the raw token
      return 'Tool action'
  }
}

/**
 * Returns true if the permission category is an edit-class permission
 * (filepath-based, contents not previewed in v1).
 */
export function isEditClassPermission(permission: string): boolean {
  return permission === 'edit' || permission === 'external_directory'
}

/**
 * Copy for the R10 denial-class failure (uniform 404 from the gateway).
 * Must NOT imply a specific reason — the gateway returns uniform not-found.
 */
export const APPROVAL_CANT_APPROVE_COPY =
  'You may not have approval access for this run. If you believe this is an error, check your gateway operator session.'

/**
 * Copy for the R10 transport-failure class (network/protocol error).
 * Must be clearly distinct from the denial copy — a transport failure is retryable.
 */
export const APPROVAL_TRANSPORT_FAILURE_COPY =
  'Decision didn\u2019t go through \u2014 try again.'

/**
 * Copy for the R10 already-settled class (already_claimed / unavailable state).
 * Shown inline when the decision response indicates the prompt is already settled.
 */
export const APPROVAL_ALREADY_SETTLED_COPY =
  'This approval request has already been settled.'

/**
 * Conservative consequence copy for the `always` two-step confirm (PD2).
 * Must NOT assert a specific match key — use conservative wording until the
 * exact grant scope is confirmed against the gateway.
 */
export const APPROVAL_ALWAYS_CONSEQUENCE_COPY =
  'This installs a standing approval that auto-approves matching requests for the rest of this run, as defined by the gateway\u2019s grant rule.'

/**
 * Pre-click copy for the approval prompt (PD1).
 * Sets the expectation that approval requires write access.
 */
export const APPROVAL_ACCESS_CAVEAT_COPY =
  'Approval requires write access to this run. Unavailable decisions fail safely.'

/**
 * Caveat shown for edit-class prompts (PD3).
 * The operator sees the filepath only — diff preview is gateway-deferred.
 */
export const APPROVAL_EDIT_CLASS_CAVEAT_COPY =
  'File-level only \u2014 contents not previewed.'

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
    case 'ready':
      return 'Stream connected'
    case 'status':
      return 'Run status updated'
    case 'reset':
      return 'Stream reconnected'
    case 'output':
      return 'Run output received'
    case 'approval':
      return 'Approval requested'
  }
}
