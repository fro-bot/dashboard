/**
 * Operator contract conformance tests.
 *
 * Verifies the vendored operator contract v1.5.0 is correctly pinned and
 * that parse helpers behave per spec. Also verifies the SSE frame types
 * vendored from fro-bot/agent (including the run-output and approval channels)
 * are structurally correct.
 *
 * Source: fro-bot/agent | Tag: v0.78.0
 */
import type {ApprovalDecisionState, RunStatus} from '../src/gateway/operator-client.ts'
import type {
  OperatorApprovalFrame,
  OperatorDecisionState,
  OperatorOutputFrame,
  OperatorRunStatus,
  OperatorWebStatus,
  ReadyFrame,
  RepoSummary,
  ResetFrameData,
  ResetReason,
  RunStreamFrame,
  RunSummary as RunSummaryType,
  StatusFrameData,
} from '../src/gateway/operator-contract/index.ts'
import {describe, expect, it} from 'vitest'
import {
  OPERATOR_CONTRACT_VERSION,
  parseOperatorCsrfToken,
  parseOperatorError,
  parseOperatorOk,
  parseOperatorSessionInfo,
  parseRepoSummary,
  parseRepoSummaryList,
  parseRunSummary,
  parseRunSummaryList,
} from '../src/gateway/operator-contract/index.ts'

// ---------------------------------------------------------------------------
// Type-level assignability: dashboard types ↔ canonical contract types
// ---------------------------------------------------------------------------
// These are compile-time checks — if the types diverge, tsc fails.
// Function-based style: declare type-checking functions that are never called.
// Using satisfies to avoid unused-variable lint while keeping the type constraint.

// ApprovalDecisionState ↔ OperatorDecisionState (mutual assignability)
type CheckApprovalToCanonical = (x: ApprovalDecisionState) => OperatorDecisionState
type CheckCanonicalToApproval = (x: OperatorDecisionState) => ApprovalDecisionState
// These type aliases are the compile-time check — if types diverge, tsc fails here.
// The identity function satisfies both directions only when the types are identical.
const checkApprovalBidirectional: CheckApprovalToCanonical & CheckCanonicalToApproval = x => x
// Suppress unused-variable lint without void
export {checkApprovalBidirectional}

// RunStatus ↔ OperatorWebStatus (mutual assignability)
type CheckRunStatusToCanonical = (x: RunStatus) => OperatorWebStatus
type CheckCanonicalToRunStatus = (x: OperatorWebStatus) => RunStatus
const checkRunStatusBidirectional: CheckRunStatusToCanonical & CheckCanonicalToRunStatus = x => x
export {checkRunStatusBidirectional}

// ---------------------------------------------------------------------------
// SSE frame type-assignability checks (compile-time)
// ---------------------------------------------------------------------------
// These are compile-time checks — if the types diverge, tsc fails.
// Function-based style: declare type-checking functions that are never called.
// Using satisfies/export to avoid unused-variable lint while keeping the type constraint.

// ReadyFrame: must accept a literal with contractVersion string
const checkReadyFrameLiteral: ReadyFrame = {contractVersion: '1.5.0'}
export {checkReadyFrameLiteral}

// ResetFrameData: must accept a literal with runId + ResetReason
const checkResetFrameLiteral: ResetFrameData = {runId: 'run-001', reason: 'no-snapshot'}
export {checkResetFrameLiteral}

// StatusFrameData is aliased to OperatorRunStatus — mutual assignability
type CheckStatusToRunStatus = (x: StatusFrameData) => OperatorRunStatus
type CheckRunStatusToStatus = (x: OperatorRunStatus) => StatusFrameData
const checkStatusBidirectional: CheckStatusToRunStatus & CheckRunStatusToStatus = x => x
export {checkStatusBidirectional}

// ResetReason: all 6 values must be assignable to the union
const checkResetReasons: ResetReason[] = ['no-snapshot', 'terminal', 'shutdown', 'max-duration', 'writer-error', 'overflow']
export {checkResetReasons}

// RepoSummary: must accept literals with and without channelName
const checkRepoSummaryMinimal: RepoSummary = {owner: 'fro-bot', repo: 'agent'}
const checkRepoSummaryWithChannel: RepoSummary = {owner: 'fro-bot', repo: 'agent', channelName: 'main'}
export {checkRepoSummaryMinimal, checkRepoSummaryWithChannel}

// OperatorOutputFrame: must accept literals with and without droppedCount,
// and an empty-text authoritative final frame.
const checkOutputDelta: OperatorOutputFrame = {runId: 'run-001', text: 'partial', final: false, seq: 0}
const checkOutputFinal: OperatorOutputFrame = {runId: 'run-001', text: 'complete', final: true, seq: 3}
const checkOutputCoalesced: OperatorOutputFrame = {runId: 'run-001', text: 'partial', final: false, seq: 1, droppedCount: 2}
const checkOutputEmptyFinal: OperatorOutputFrame = {runId: 'run-001', text: '', final: true, seq: 0}
export {checkOutputCoalesced, checkOutputDelta, checkOutputEmptyFinal, checkOutputFinal}

// OperatorApprovalFrame: both discriminated variants must be assignable
// Open variant — with command
const checkApprovalFrameOpenWithCommand: OperatorApprovalFrame = {
  runId: 'run-001',
  requestID: 'req-001',
  permission: 'shell',
  command: 'ls -la',
  settled: false,
}
export {checkApprovalFrameOpenWithCommand}
// Open variant — with filepath
const checkApprovalFrameOpenWithFilepath: OperatorApprovalFrame = {
  runId: 'run-001',
  requestID: 'req-001',
  permission: 'fs/write',
  filepath: '/tmp/output.txt',
  settled: false,
}
export {checkApprovalFrameOpenWithFilepath}
// Open variant — with neither command nor filepath (both optional)
const checkApprovalFrameOpenMinimal: OperatorApprovalFrame = {
  runId: 'run-001',
  requestID: 'req-001',
  permission: 'network',
  settled: false,
}
export {checkApprovalFrameOpenMinimal}
// Settle variant — exactly 3 fields
const checkApprovalFrameSettle: OperatorApprovalFrame = {
  runId: 'run-001',
  requestID: 'req-001',
  settled: true,
}
export {checkApprovalFrameSettle}

// RunStreamFrame discriminated union: each variant must be constructable
const checkReadyFrame: RunStreamFrame = {type: 'ready', data: {contractVersion: '1.5.0'}}
const checkOutputFrame: RunStreamFrame = {
  type: 'output',
  data: {runId: 'run-001', text: 'partial', final: false, seq: 0},
}
export {checkOutputFrame}
const checkResetFrame: RunStreamFrame = {type: 'reset', data: {runId: 'run-001', reason: 'terminal'}}
const checkStatusFrame: RunStreamFrame = {
  type: 'status',
  data: {
    runId: 'run-001',
    entityRef: 'fro-bot/agent',
    surface: 'github',
    phase: 'EXECUTING',
    status: 'running',
    startedAt: '2026-06-20T00:00:00Z',
    stale: false,
  },
}
// Approval frame as RunStreamFrame union member
const checkApprovalRunStreamFrame: RunStreamFrame = {
  type: 'approval',
  data: {
    runId: 'run-001',
    requestID: 'req-001',
    permission: 'shell',
    command: 'echo hello',
    settled: false,
  },
}
export {checkApprovalRunStreamFrame, checkReadyFrame, checkResetFrame, checkStatusFrame}

// ---------------------------------------------------------------------------
// Version pin
// ---------------------------------------------------------------------------

describe('OPERATOR_CONTRACT_VERSION', () => {
  it('is pinned to 1.5.0', () => {
    expect(OPERATOR_CONTRACT_VERSION).toBe('1.5.0')
  })
})

// ---------------------------------------------------------------------------
// parseOperatorSessionInfo
// ---------------------------------------------------------------------------

describe('parseOperatorSessionInfo', () => {
  it('accepts valid shape with numeric expiresAt', () => {
    const input = {operatorId: 42, login: 'octocat', expiresAt: 4070908800000}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.operatorId).toBe(42)
      expect(result.data.login).toBe('octocat')
      expect(result.data.expiresAt).toBe(4070908800000)
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {operatorId: 1, login: 'x', expiresAt: 1000, extra: 'ignored'}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(true)
  })

  it('rejects string expiresAt (canonical type is number)', () => {
    const input = {operatorId: 42, login: 'octocat', expiresAt: '2099-01-01T00:00:00Z'}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      // Error message must be a fixed string — never echoes input
      expect(result.error.message).toBe('invalid operator session info shape')
    }
  })

  it('rejects missing operatorId', () => {
    const input = {login: 'octocat', expiresAt: 1000}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(false)
  })

  it('rejects null', () => {
    const result = parseOperatorSessionInfo(null)
    expect(result.success).toBe(false)
  })

  it('rejects array', () => {
    const result = parseOperatorSessionInfo([])
    expect(result.success).toBe(false)
  })

  it('rejects non-integer operatorId', () => {
    const input = {operatorId: 1.5, login: 'x', expiresAt: 1000}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(false)
  })

  it('rejects non-finite expiresAt (Infinity)', () => {
    const input = {operatorId: 1, login: 'x', expiresAt: Infinity}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseOperatorCsrfToken
// ---------------------------------------------------------------------------

describe('parseOperatorCsrfToken', () => {
  it('accepts {csrfToken} shape', () => {
    const input = {csrfToken: 'tok-abc123'}
    const result = parseOperatorCsrfToken(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.csrfToken).toBe('tok-abc123')
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {csrfToken: 'tok', extra: 'ignored', expiresAt: '2099-01-01'}
    const result = parseOperatorCsrfToken(input)
    expect(result.success).toBe(true)
  })

  it('rejects {token, expiresAt} shape (old DTO — canonical field is csrfToken)', () => {
    const input = {token: 'tok-abc123', expiresAt: '2099-01-01T00:00:00Z'}
    const result = parseOperatorCsrfToken(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid operator csrf token shape')
    }
  })

  it('rejects missing csrfToken', () => {
    const result = parseOperatorCsrfToken({})
    expect(result.success).toBe(false)
  })

  it('rejects null', () => {
    const result = parseOperatorCsrfToken(null)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseOperatorError
// ---------------------------------------------------------------------------

describe('parseOperatorError', () => {
  it('accepts {error} shape', () => {
    const input = {error: 'unauthorized'}
    const result = parseOperatorError(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.error).toBe('unauthorized')
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {error: 'bad_request', message: 'extra field ignored', code: 400}
    const result = parseOperatorError(input)
    expect(result.success).toBe(true)
  })

  it('rejects missing error field', () => {
    const result = parseOperatorError({message: 'something went wrong'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid operator error shape')
    }
  })

  it('rejects null', () => {
    const result = parseOperatorError(null)
    expect(result.success).toBe(false)
  })

  it('rejects non-string error field', () => {
    const result = parseOperatorError({error: 42})
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseOperatorOk
// ---------------------------------------------------------------------------

describe('parseOperatorOk', () => {
  it('accepts {ok: true} shape', () => {
    const input = {ok: true}
    const result = parseOperatorOk(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.ok).toBe(true)
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {ok: true, message: 'extra field ignored', code: 200}
    const result = parseOperatorOk(input)
    expect(result.success).toBe(true)
  })

  it('rejects {ok: false} (discriminant must be literal true)', () => {
    const result = parseOperatorOk({ok: false})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid operator ok shape')
    }
  })

  it('rejects {} (missing ok field)', () => {
    const result = parseOperatorOk({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid operator ok shape')
    }
  })

  it('rejects a non-object (string)', () => {
    const result = parseOperatorOk('ok')
    expect(result.success).toBe(false)
  })

  it('rejects null', () => {
    const result = parseOperatorOk(null)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseRepoSummary
// ---------------------------------------------------------------------------

describe('parseRepoSummary', () => {
  it('accepts {owner, repo} without channelName', () => {
    const input = {owner: 'fro-bot', repo: 'agent'}
    const result = parseRepoSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.owner).toBe('fro-bot')
      expect(result.data.repo).toBe('agent')
      expect(result.data.channelName).toBeUndefined()
    }
  })

  it('accepts {owner, repo, channelName} with channelName present', () => {
    const input = {owner: 'fro-bot', repo: 'agent', channelName: 'main'}
    const result = parseRepoSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.owner).toBe('fro-bot')
      expect(result.data.repo).toBe('agent')
      expect(result.data.channelName).toBe('main')
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {owner: 'fro-bot', repo: 'agent', extra: 'ignored', count: 42}
    const result = parseRepoSummary(input)
    expect(result.success).toBe(true)
  })

  it('rejects missing owner', () => {
    const result = parseRepoSummary({repo: 'agent'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects non-string owner', () => {
    const result = parseRepoSummary({owner: 42, repo: 'agent'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects missing repo', () => {
    const result = parseRepoSummary({owner: 'fro-bot'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects non-string repo', () => {
    const result = parseRepoSummary({owner: 'fro-bot', repo: true})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects non-string channelName when present', () => {
    const result = parseRepoSummary({owner: 'fro-bot', repo: 'agent', channelName: 99})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects null', () => {
    const result = parseRepoSummary(null)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects a non-object (string)', () => {
    const result = parseRepoSummary('fro-bot/agent')
    expect(result.success).toBe(false)
  })

  it('rejects an array', () => {
    const result = parseRepoSummary([{owner: 'fro-bot', repo: 'agent'}])
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RunSummary type-level checks (compile-time)
// ---------------------------------------------------------------------------

// RunSummary: must accept literals with and without updatedAt
const checkRunSummaryMinimal: RunSummaryType = {
  runId: 'run-abc-123',
  repo: 'fro-bot/agent',
  status: 'running',
  createdAt: '2026-06-01T00:00:00.000Z',
}
const checkRunSummaryWithUpdatedAt: RunSummaryType = {
  runId: 'run-abc-123',
  repo: 'fro-bot/agent',
  status: 'succeeded',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T01:00:00.000Z',
}
export {checkRunSummaryMinimal, checkRunSummaryWithUpdatedAt}

// ---------------------------------------------------------------------------
// parseRepoSummaryList
// ---------------------------------------------------------------------------

describe('parseRepoSummaryList', () => {
  it('accepts an empty array', () => {
    const result = parseRepoSummaryList([])
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual([])
    }
  })

  it('accepts an array of valid items without channelName', () => {
    const input = [
      {owner: 'fro-bot', repo: 'agent'},
      {owner: 'fro-bot', repo: 'dashboard'},
    ]
    const result = parseRepoSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(2)
      expect(result.data[0]?.owner).toBe('fro-bot')
      expect(result.data[1]?.repo).toBe('dashboard')
    }
  })

  it('accepts an array of valid items with channelName', () => {
    const input = [
      {owner: 'fro-bot', repo: 'agent', channelName: 'main'},
      {owner: 'fro-bot', repo: 'dashboard'},
    ]
    const result = parseRepoSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data[0]?.channelName).toBe('main')
      expect(result.data[1]?.channelName).toBeUndefined()
    }
  })

  it('rejects a non-array input (object)', () => {
    const result = parseRepoSummaryList({owner: 'fro-bot', repo: 'agent'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary list: expected array')
    }
  })

  it('rejects a non-array input (null)', () => {
    const result = parseRepoSummaryList(null)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary list: expected array')
    }
  })

  it('rejects a non-array input (string)', () => {
    const result = parseRepoSummaryList('fro-bot/agent')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary list: expected array')
    }
  })

  it('fails the whole list if any item is invalid (fail closed)', () => {
    const input = [
      {owner: 'fro-bot', repo: 'agent'},
      {owner: 'fro-bot'}, // missing repo — invalid
    ]
    const result = parseRepoSummaryList(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary list: item failed validation')
    }
  })

  it('fails the whole list if the first item is invalid', () => {
    const input = [
      {repo: 'agent'}, // missing owner — invalid
      {owner: 'fro-bot', repo: 'dashboard'},
    ]
    const result = parseRepoSummaryList(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid repo summary list: item failed validation')
    }
  })

  it('fails the whole list if any item has a non-string channelName', () => {
    const input = [
      {owner: 'fro-bot', repo: 'agent', channelName: 0},
    ]
    const result = parseRepoSummaryList(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid repo summary list: item failed validation')
    }
  })
})

// ---------------------------------------------------------------------------
// parseRunSummary
// ---------------------------------------------------------------------------

describe('parseRunSummary', () => {
  it('accepts a minimal valid run summary (no updatedAt)', () => {
    const input = {
      runId: 'run-abc-123',
      repo: 'fro-bot/agent',
      status: 'running',
      createdAt: '2026-06-01T00:00:00.000Z',
    }
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runId).toBe('run-abc-123')
      expect(result.data.repo).toBe('fro-bot/agent')
      expect(result.data.status).toBe('running')
      expect(result.data.createdAt).toBe('2026-06-01T00:00:00.000Z')
      expect(result.data.updatedAt).toBeUndefined()
    }
  })

  it('accepts a run summary with updatedAt present', () => {
    const input = {
      runId: 'run-abc-123',
      repo: 'fro-bot/agent',
      status: 'succeeded',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T01:00:00.000Z',
    }
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.updatedAt).toBe('2026-06-01T01:00:00.000Z')
    }
  })

  it('updatedAt is absent (key not present) when omitted from input', () => {
    const input = {
      runId: 'run-abc-123',
      repo: 'fro-bot/agent',
      status: 'queued',
      createdAt: '2026-06-01T00:00:00.000Z',
    }
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Object.prototype.hasOwnProperty.call(result.data, 'updatedAt')).toBe(false)
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {
      runId: 'run-abc-123',
      repo: 'fro-bot/agent',
      status: 'failed',
      createdAt: '2026-06-01T00:00:00.000Z',
      extra: 'ignored',
      internalField: 42,
    }
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      // Extra fields must not be accessible through the typed result
      expect(Object.keys(result.data)).not.toContain('extra')
      expect(Object.keys(result.data)).not.toContain('internalField')
    }
  })

  it('accepts all five valid index statuses', () => {
    const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
    for (const status of statuses) {
      const input = {runId: 'run-1', repo: 'fro-bot/agent', status, createdAt: '2026-06-01T00:00:00.000Z'}
      const result = parseRunSummary(input)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.status).toBe(status)
      }
    }
  })

  it('rejects unknown status (fails closed)', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'unknown_status', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects stream-only status: waiting_for_approval', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'waiting_for_approval', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects stream-only status: blocked', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'blocked', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects missing runId', () => {
    const input = {repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects non-string runId', () => {
    const input = {runId: 42, repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects missing repo', () => {
    const input = {runId: 'run-1', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
  })

  it('rejects non-string repo', () => {
    const input = {runId: 'run-1', repo: 99, status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
  })

  it('rejects missing createdAt', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'running'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
  })

  it('rejects non-string createdAt', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: 1234567890}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
  })

  it('rejects non-string updatedAt when present', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: 9999}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects oversized runId without logging raw value', () => {
    const input = {runId: 'r'.repeat(513), repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      // Error message must be fixed — never echoes the oversized value
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects oversized repo without logging raw value', () => {
    const input = {runId: 'run-1', repo: 'x'.repeat(513), status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects oversized createdAt without logging raw value', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2'.repeat(129)}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects oversized updatedAt without logging raw value', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2'.repeat(129)}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects null', () => {
    const result = parseRunSummary(null)
    expect(result.success).toBe(false)
  })

  it('rejects an array', () => {
    const result = parseRunSummary([])
    expect(result.success).toBe(false)
  })

  it('rejects a non-object (string)', () => {
    const result = parseRunSummary('run-abc-123')
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseRunSummaryList
// ---------------------------------------------------------------------------

describe('parseRunSummaryList', () => {
  it('accepts an empty array', () => {
    const result = parseRunSummaryList([])
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual([])
    }
  })

  it('accepts an array of valid summaries', () => {
    const input = [
      {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'},
      {runId: 'run-2', repo: 'fro-bot/dashboard', status: 'succeeded', createdAt: '2026-06-02T00:00:00.000Z'},
    ]
    const result = parseRunSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(2)
      expect(result.data[0]?.runId).toBe('run-1')
      expect(result.data[1]?.status).toBe('succeeded')
    }
  })

  it('deduplicates by runId: keeps first valid entry, suppresses later duplicates', () => {
    const input = [
      {runId: 'run-dup', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'},
      {runId: 'run-dup', repo: 'fro-bot/agent', status: 'succeeded', createdAt: '2026-06-01T01:00:00.000Z'},
      {runId: 'run-other', repo: 'fro-bot/agent', status: 'queued', createdAt: '2026-06-01T02:00:00.000Z'},
    ]
    const result = parseRunSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(2)
      // First entry for run-dup is kept (status: running)
      expect(result.data[0]?.runId).toBe('run-dup')
      expect(result.data[0]?.status).toBe('running')
      expect(result.data[1]?.runId).toBe('run-other')
    }
  })

  it('skips invalid items (per-item validation, not whole-list fail)', () => {
    const input = [
      {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'},
      {runId: 'run-2', repo: 'fro-bot/agent', status: 'blocked', createdAt: '2026-06-01T00:00:00.000Z'}, // invalid status
      {runId: 'run-3', repo: 'fro-bot/agent', status: 'succeeded', createdAt: '2026-06-01T00:00:00.000Z'},
    ]
    const result = parseRunSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      // Invalid item is skipped, valid ones are kept
      expect(result.data).toHaveLength(2)
      expect(result.data[0]?.runId).toBe('run-1')
      expect(result.data[1]?.runId).toBe('run-3')
    }
  })

  it('rejects a non-array input (object)', () => {
    const result = parseRunSummaryList({runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid run summary list: expected array')
    }
  })

  it('rejects a non-array input (null)', () => {
    const result = parseRunSummaryList(null)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary list: expected array')
    }
  })

  it('rejects a non-array input (string)', () => {
    const result = parseRunSummaryList('run-1')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary list: expected array')
    }
  })

  it('returns empty array when all items are invalid', () => {
    const input = [
      {runId: 'run-1', repo: 'fro-bot/agent', status: 'blocked', createdAt: '2026-06-01T00:00:00.000Z'},
      {runId: 'run-2', repo: 'fro-bot/agent', status: 'waiting_for_approval', createdAt: '2026-06-01T00:00:00.000Z'},
    ]
    const result = parseRunSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(0)
    }
  })
})
