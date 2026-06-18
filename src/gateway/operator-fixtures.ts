/**
 * Typed fixtures and in-memory mock OperatorClient for the operator UI skeleton.
 *
 * Security invariants:
 * - Fixture data must NOT contain real prompts, tool args, workspace paths,
 *   internal URLs, tokens, session cookies, or CSRF values.
 * - The mock client's injected fetch THROWS if called — proving the UI never
 *   hits network during mock render.
 * - The mock createEventStream replays fixture events synchronously (no real SSE).
 * - Zero /operator/* fetch happens during SSR.
 */
import type {ApprovalDecisionRequest, ApprovalDecisionResponse, CsrfDto, EventStreamHandle, LaunchRunRequest, LaunchRunResponse, OperatorClient, PendingApprovalsResponse, PendingApprovalSummary, RunSnapshotDto, RunStreamEvent, SessionDto} from './operator-client.ts'
import {createOperatorClient} from './operator-client.ts'

// ---------------------------------------------------------------------------
// Session fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_SESSION: SessionDto = {
  operatorId: 1,
  login: 'fixture-operator',
  expiresAt: '2099-01-01T00:00:00Z',
}

export const FIXTURE_CSRF: CsrfDto = {
  // NOTE: This is a fixture placeholder — never a real CSRF token.
  // The token value is intentionally generic and not rendered in the UI.
  token: 'fixture-csrf-placeholder',
  expiresAt: '2099-01-01T00:00:00Z',
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
// Run stream event timeline fixture
// ---------------------------------------------------------------------------

export const FIXTURE_RUN_TIMELINE: readonly RunStreamEvent[] = [
  {
    type: 'heartbeat',
    timestamp: '2026-06-17T10:01:00Z',
  },
  {
    type: 'run.state',
    runId: 'run-fixture-running-002',
    status: 'queued',
    timestamp: '2026-06-17T10:01:01Z',
  },
  {
    type: 'run.state',
    runId: 'run-fixture-running-002',
    status: 'running',
    timestamp: '2026-06-17T10:01:05Z',
  },
  {
    type: 'run.output',
    runId: 'run-fixture-running-002',
    // Safe summary text only — no raw prompts, tool args, or workspace paths
    text: '[Fixture output — safe summary text only]',
    truncated: false,
  },
  {
    type: 'approval.pending',
    requestId: 'req-fixture-pending-001',
    runId: 'run-fixture-approval-003',
    // Safe summary — no raw tool arguments or workspace paths
    safeSummary: 'Fixture approval request — safe summary',
    approvalScope: 'fixture-scope',
    timestamp: '2026-06-17T10:04:00Z',
  },
  {
    type: 'approval.claimed',
    requestId: 'req-fixture-pending-001',
    runId: 'run-fixture-approval-003',
    timestamp: '2026-06-17T10:04:30Z',
  },
  {
    type: 'approval.confirmed',
    requestId: 'req-fixture-pending-001',
    runId: 'run-fixture-approval-003',
    outcome: 'approved',
    timestamp: '2026-06-17T10:05:00Z',
  },
  {
    type: 'approval.expired',
    requestId: 'req-fixture-expired-002',
    runId: 'run-fixture-approval-003',
    timestamp: '2026-06-17T10:06:00Z',
  },
  {
    type: 'approval.failed_to_settle',
    requestId: 'req-fixture-failed-003',
    runId: 'run-fixture-approval-003',
    // Coarse reason only — no internal details
    reason: 'fixture-reason',
    timestamp: '2026-06-17T10:07:00Z',
  },
  {
    type: 'run.error',
    runId: 'run-fixture-failed-005',
    code: 'fixture-error-code',
    description: 'Fixture error — safe description only',
  },
  {
    type: 'stream.reset',
    reason: 'replay_unavailable',
  },
]

// ---------------------------------------------------------------------------
// Pending approval fixtures — one per ApprovalDecisionState
// ---------------------------------------------------------------------------

export const FIXTURE_PENDING_APPROVAL: PendingApprovalSummary = {
  requestId: 'req-fixture-pending-001',
  runId: 'run-fixture-approval-003',
  safeSummary: 'Fixture approval request — safe summary',
  approvalScope: 'fixture-scope',
  createdAt: '2026-06-17T10:04:00Z',
}

export const FIXTURE_PENDING_APPROVALS: PendingApprovalsResponse = {
  approvals: [FIXTURE_PENDING_APPROVAL],
}

// ---------------------------------------------------------------------------
// Approval decision response fixtures — one per ApprovalDecisionState
// ---------------------------------------------------------------------------

export const FIXTURE_DECISION_CLAIMED: ApprovalDecisionResponse = {
  state: 'claimed',
  requestId: 'req-fixture-pending-001',
  timestamp: '2026-06-17T10:04:30Z',
}

export const FIXTURE_DECISION_ALREADY_SETTLED: ApprovalDecisionResponse = {
  state: 'already_settled',
  requestId: 'req-fixture-pending-001',
  timestamp: '2026-06-17T10:05:00Z',
}

export const FIXTURE_DECISION_EXPIRED: ApprovalDecisionResponse = {
  state: 'expired',
  requestId: 'req-fixture-expired-002',
  timestamp: '2026-06-17T10:06:00Z',
}

export const FIXTURE_DECISION_FAILED_TO_SETTLE: ApprovalDecisionResponse = {
  state: 'failed_to_settle',
  requestId: 'req-fixture-failed-003',
  timestamp: '2026-06-17T10:07:00Z',
}

export const FIXTURE_DECISION_UNAVAILABLE: ApprovalDecisionResponse = {
  state: 'unavailable',
  requestId: 'req-fixture-unavailable-004',
  timestamp: '2026-06-17T10:08:00Z',
}

// ---------------------------------------------------------------------------
// Mock OperatorClient factory
// ---------------------------------------------------------------------------

/**
 * Create a mock OperatorClient built via the real createOperatorClient factory
 * with an injected fetch that THROWS if called (proving the UI never hits network
 * in mock render) and an injected createEventStream that replays fixture events
 * synchronously (no real SSE).
 *
 * The skeleton SSR render must NOT call network — it renders from static fixtures
 * directly. This mock client exists to satisfy the contract/type-surface and for
 * any interaction tests.
 */
export function createMockOperatorClient(): OperatorClient {
  // Injected fetch that throws if called — proves no network calls during SSR
  const throwingFetch = async (_input: string, _init?: RequestInit): Promise<Response> => {
    throw new Error(
      'Mock operator client fetch was called — this proves a live network call was attempted. ' +
      'The operator UI skeleton must render from static fixtures only, with zero /operator/* calls.',
    )
  }

  // Injected createEventStream that replays fixture events synchronously
  const fixtureEventStream = (_path: string): EventStreamHandle => {
    return {
      start: (onEvent, _onError, onClose) => {
        // Replay fixture timeline events synchronously
        for (const event of FIXTURE_RUN_TIMELINE) {
          onEvent(event)
        }
        onClose()
      },
      close: () => {
        // No-op for fixture stream
      },
    }
  }

  return createOperatorClient({
    fetch: throwingFetch,
    createEventStream: fixtureEventStream,
  })
}

// ---------------------------------------------------------------------------
// Fixture launch request/response
// ---------------------------------------------------------------------------

export const FIXTURE_LAUNCH_REQUEST: LaunchRunRequest = {
  owner: 'fro-bot',
  repo: 'agent',
  // NOTE: This is a fixture placeholder — never a real prompt.
  // The prompt is intentionally generic and not rendered in the UI.
  prompt: '[Fixture prompt — not rendered in UI]',
  idempotencyKey: 'fixture-idempotency-key-001',
  csrfToken: 'fixture-csrf-placeholder',
}

export const FIXTURE_LAUNCH_RESPONSE: LaunchRunResponse = {
  runId: 'run-fixture-queued-001',
  status: 'queued',
}

export const FIXTURE_APPROVAL_DECISION_REQUEST: ApprovalDecisionRequest = {
  requestId: 'req-fixture-pending-001',
  decision: 'approve',
  approvalScope: 'fixture-scope',
  idempotencyKey: 'fixture-idempotency-key-002',
  csrfToken: 'fixture-csrf-placeholder',
}
