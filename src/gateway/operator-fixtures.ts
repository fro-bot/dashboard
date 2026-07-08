/**
 * Typed fixtures for the operator UI skeleton.
 *
 * Security invariants:
 * - Fixture data must NOT contain real prompts, tool args, workspace paths,
 *   internal URLs, tokens, session cookies, or CSRF values.
 */
import type {CsrfDto, LaunchRunRequest, LaunchRunResponse, RunApprovalDecisionResponse, RunApprovalsResponse, RunApprovalSummary, RunSnapshotDto, RunStreamEvent, SessionDto} from './operator-client.ts'

// ---------------------------------------------------------------------------
// Session fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_SESSION: SessionDto = {
  operatorId: 1,
  login: 'fixture-operator',
  // expiresAt is ms-since-epoch (number) per canonical OperatorSessionInfo
  expiresAt: Date.parse('2099-01-01T00:00:00Z'),
}

export const FIXTURE_CSRF: CsrfDto = {
  // NOTE: This is a fixture placeholder — never a real CSRF token.
  // The token value is intentionally generic and not rendered in the UI.
  // Field is csrfToken per canonical OperatorCsrfToken (not token).
  csrfToken: 'fixture-csrf-placeholder',
}

// ---------------------------------------------------------------------------
// Run snapshot fixtures — one per RunStatus
// ---------------------------------------------------------------------------

export const FIXTURE_RUN_QUEUED: RunSnapshotDto = {
  runId: 'run-fixture-queued-001',
  status: 'queued',
  owner: 'fro-bot',
  repo: 'agent',
  createdAt: '2026-06-17T10:00:00Z',
}

export const FIXTURE_RUN_RUNNING: RunSnapshotDto = {
  runId: 'run-fixture-running-002',
  status: 'running',
  owner: 'fro-bot',
  repo: 'agent',
  createdAt: '2026-06-17T10:01:00Z',
  updatedAt: '2026-06-17T10:02:00Z',
}

export const FIXTURE_RUN_WAITING_FOR_APPROVAL: RunSnapshotDto = {
  runId: 'run-fixture-approval-003',
  status: 'waiting_for_approval',
  owner: 'fro-bot',
  repo: 'agent',
  createdAt: '2026-06-17T10:03:00Z',
  updatedAt: '2026-06-17T10:04:00Z',
}

export const FIXTURE_RUN_BLOCKED: RunSnapshotDto = {
  runId: 'run-fixture-blocked-004',
  status: 'blocked',
  owner: 'fro-bot',
  repo: 'agent',
  createdAt: '2026-06-17T10:05:00Z',
  updatedAt: '2026-06-17T10:06:00Z',
}

export const FIXTURE_RUN_FAILED: RunSnapshotDto = {
  runId: 'run-fixture-failed-005',
  status: 'failed',
  owner: 'fro-bot',
  repo: 'agent',
  createdAt: '2026-06-17T10:07:00Z',
  updatedAt: '2026-06-17T10:08:00Z',
}

export const FIXTURE_RUN_CANCELLED: RunSnapshotDto = {
  runId: 'run-fixture-cancelled-006',
  status: 'cancelled',
  owner: 'fro-bot',
  repo: 'agent',
  createdAt: '2026-06-17T10:09:00Z',
  updatedAt: '2026-06-17T10:10:00Z',
}

export const FIXTURE_RUN_SUCCEEDED: RunSnapshotDto = {
  runId: 'run-fixture-succeeded-007',
  status: 'succeeded',
  owner: 'fro-bot',
  repo: 'agent',
  createdAt: '2026-06-17T10:11:00Z',
  updatedAt: '2026-06-17T10:12:00Z',
}

export const ALL_FIXTURE_RUNS: readonly RunSnapshotDto[] = [
  FIXTURE_RUN_QUEUED,
  FIXTURE_RUN_RUNNING,
  FIXTURE_RUN_WAITING_FOR_APPROVAL,
  FIXTURE_RUN_BLOCKED,
  FIXTURE_RUN_FAILED,
  FIXTURE_RUN_CANCELLED,
  FIXTURE_RUN_SUCCEEDED,
]

// ---------------------------------------------------------------------------
// Failure-reason (Gateway 1.6.0) fixture constants — shared across the fixture
// harness route and SSE scenario builders so known/unknown reason values stay
// in lockstep. See src/gateway/operator-contract/run-status.ts for the
// canonical OPERATOR_FAILURE_KINDS allowlist.
// ---------------------------------------------------------------------------

/**
 * A known Gateway 1.6.0 operator failure-reason code, used by both the
 * fixture-harness recent-run entries and the live-stream reason scenarios so
 * a single known-reason case exercises both surfaces with the same value.
 */
export const FIXTURE_KNOWN_FAILURE_REASON = 'inactivity-timeout'

/**
 * A visibly synthetic, fixture-prefixed reason value that is deliberately NOT
 * in the OPERATOR_FAILURE_KINDS allowlist. Proves unrecognized reason codes
 * normalize to absent and never reach renderers, logs, or sanitizer output.
 */
export const FIXTURE_UNKNOWN_FAILURE_REASON = 'fixture-unrecognized-reason'

// ---------------------------------------------------------------------------
// Run stream event timeline fixture
// ---------------------------------------------------------------------------

export const FIXTURE_RUN_TIMELINE: readonly RunStreamEvent[] = [
  {
    type: 'ready',
    data: {contractVersion: '1.1.0'},
  },
  {
    type: 'status',
    data: {
      runId: 'run-fixture-running-002',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'PENDING',
      status: 'queued',
      startedAt: '2026-06-17T10:01:01Z',
      stale: false,
    },
  },
  {
    type: 'status',
    data: {
      runId: 'run-fixture-running-002',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-17T10:01:05Z',
      stale: false,
    },
  },
  {
    type: 'reset',
    data: {
      runId: 'run-fixture-running-002',
      reason: 'terminal',
    },
  },
]

// ---------------------------------------------------------------------------
// Run approval fixtures — 1.4.0 per-run routes
// ---------------------------------------------------------------------------

export const FIXTURE_RUN_APPROVAL: RunApprovalSummary = {
  requestID: 'req-fixture-pending-001',
  permission: 'tool_use',
  command: 'bash',
}

export const FIXTURE_RUN_APPROVALS: RunApprovalsResponse = {
  approvals: [FIXTURE_RUN_APPROVAL],
}

// ---------------------------------------------------------------------------
// Approval decision response fixtures — one per OperatorDecisionState
// ---------------------------------------------------------------------------

export const FIXTURE_DECISION_PENDING: RunApprovalDecisionResponse = {
  state: 'pending',
}

export const FIXTURE_DECISION_CLAIMED: RunApprovalDecisionResponse = {
  state: 'claimed',
}

export const FIXTURE_DECISION_ALREADY_CLAIMED: RunApprovalDecisionResponse = {
  // already_claimed: a second decision arrived while the first POST was still in-flight.
  // The entry has NOT settled yet — this is NOT 'already_settled'.
  state: 'already_claimed',
}

export const FIXTURE_DECISION_SCOPE_MISMATCH: RunApprovalDecisionResponse = {
  state: 'scope_mismatch',
}

export const FIXTURE_DECISION_FAILED_TO_SETTLE: RunApprovalDecisionResponse = {
  state: 'failed_to_settle',
}

export const FIXTURE_DECISION_UNAVAILABLE: RunApprovalDecisionResponse = {
  state: 'unavailable',
}

// ---------------------------------------------------------------------------
// Fixture launch request/response
// ---------------------------------------------------------------------------

export const FIXTURE_LAUNCH_REQUEST: LaunchRunRequest = {
  repo: 'fro-bot/agent',
  // NOTE: This is a fixture placeholder — never a real prompt.
  // The prompt is intentionally generic and not rendered in the UI.
  prompt: '[Fixture prompt — not rendered in UI]',
  idempotencyKey: 'fixture-idempotency-key-001',
  csrfToken: 'fixture-csrf-placeholder',
}

export const FIXTURE_LAUNCH_RESPONSE: LaunchRunResponse = {
  runId: 'run-fixture-queued-001',
}
