import type {ApprovalDecisionState, RunStatus} from '../src/gateway/operator-client.ts'

/**
 * Tests for operator-safe display copy mapping.
 *
 * TDD: written before implementation.
 * Critical invariant: 'failed_to_settle' must NEVER be the primary UI label.
 * All RunStatus and ApprovalDecisionState values must have safe copy.
 */
import {describe, expect, it} from 'vitest'
import {
  APPROVAL_ACCESS_CAVEAT_COPY,
  APPROVAL_ALREADY_SETTLED_COPY,
  APPROVAL_ALWAYS_CONSEQUENCE_COPY,
  APPROVAL_CANT_APPROVE_COPY,
  APPROVAL_EDIT_CLASS_CAVEAT_COPY,
  APPROVAL_TRANSPORT_FAILURE_COPY,
  approvalStateLabel,
  isEditClassPermission,
  permissionLabel,
  runStatusLabel,
  streamEventLabel,
} from '../src/gateway/operator-copy.ts'

describe('runStatusLabel', () => {
  const allStatuses: RunStatus[] = [
    'queued',
    'running',
    'waiting_for_approval',
    'blocked',
    'failed',
    'cancelled',
    'succeeded',
  ]

  it('returns a non-empty string for every RunStatus', () => {
    for (const status of allStatuses) {
      const label = runStatusLabel(status)
      expect(label, `runStatusLabel('${status}') should be non-empty`).toBeTruthy()
      expect(typeof label).toBe('string')
    }
  })

  it('does not use raw backend token as primary label for any status', () => {
    // Raw backend tokens that should not appear verbatim as the primary label
    const rawTokens: RunStatus[] = ['waiting_for_approval', 'blocked', 'failed', 'cancelled', 'succeeded']
    for (const status of rawTokens) {
      const label = runStatusLabel(status)
      // The label should be human-readable, not the raw underscore-separated token
      expect(label).not.toBe(status)
    }
  })

  it('queued → human-readable label', () => {
    expect(runStatusLabel('queued')).toMatch(/queue|waiting|pending/i)
  })

  it('running → human-readable label', () => {
    expect(runStatusLabel('running')).toMatch(/running|in progress|active/i)
  })

  it('waiting_for_approval → human-readable label (not raw token)', () => {
    const label = runStatusLabel('waiting_for_approval')
    expect(label).not.toBe('waiting_for_approval')
    expect(label).toMatch(/approval|waiting|pending/i)
  })

  it('blocked → human-readable label', () => {
    const label = runStatusLabel('blocked')
    expect(label).not.toBe('blocked')
    expect(label).toMatch(/block|unavailable|paused/i)
  })

  it('failed → human-readable label', () => {
    const label = runStatusLabel('failed')
    expect(label).not.toBe('failed')
    expect(label).toMatch(/fail|error|unsuccessful/i)
  })

  it('cancelled → human-readable label', () => {
    const label = runStatusLabel('cancelled')
    expect(label).not.toBe('cancelled')
    expect(label).toMatch(/cancel|stopped|aborted/i)
  })

  it('succeeded → human-readable label', () => {
    const label = runStatusLabel('succeeded')
    expect(label).not.toBe('succeeded')
    expect(label).toMatch(/success|complete|done/i)
  })
})

describe('approvalStateLabel', () => {
  // Canonical OperatorDecisionState values per contract v1.0.0
  const allStates: ApprovalDecisionState[] = [
    'pending',
    'claimed',
    'already_claimed',
    'scope_mismatch',
    'failed_to_settle',
    'unavailable',
  ]

  it('returns a non-empty string for every ApprovalDecisionState', () => {
    for (const state of allStates) {
      const label = approvalStateLabel(state)
      expect(label, `approvalStateLabel('${state}') should be non-empty`).toBeTruthy()
      expect(typeof label).toBe('string')
    }
  })

  it('CRITICAL: failed_to_settle is NOT the primary label (must use safe copy)', () => {
    const label = approvalStateLabel('failed_to_settle')
    // Must NOT use the raw backend token as the primary label
    expect(label).not.toBe('failed_to_settle')
    // Must NOT contain the raw underscore token
    expect(label).not.toContain('failed_to_settle')
    // Must be a safe, human-readable description
    expect(label.length).toBeGreaterThan(0)
  })

  it('failed_to_settle → safe copy like "Couldn\'t finalize the decision"', () => {
    const label = approvalStateLabel('failed_to_settle')
    // Should convey the meaning without exposing the raw backend token
    expect(label).toMatch(/couldn.t|could not|finalize|decision|settle|complete/i)
  })

  it('claimed → human-readable label (not raw token)', () => {
    const label = approvalStateLabel('claimed')
    expect(label).not.toBe('claimed')
    expect(label).toMatch(/claim|process|review|in progress/i)
  })

  it('already_claimed → human-readable label (not raw token, not "already decided")', () => {
    const label = approvalStateLabel('already_claimed')
    // Must NOT use the raw backend token
    expect(label).not.toBe('already_claimed')
    expect(label).not.toContain('already_claimed')
    // already_claimed means a second decision arrived while first POST was in-flight
    // NOT "already done" — must convey in-flight/duplicate/progress semantics
    expect(label).toMatch(/in progress|no duplicate|duplicate action/i)
    // Must NOT reuse "already decided" wording (that was the old already_settled copy)
    expect(label).not.toMatch(/already decided/i)
    // Must NOT imply the decision is terminal/settled — it is still in-flight
    expect(label).not.toMatch(/\bdone\b|completed|settled|finished/i)
  })

  it('pending → human-readable label', () => {
    const label = approvalStateLabel('pending')
    expect(label).not.toBe('pending')
    expect(label).toMatch(/await|pending|decision|your/i)
  })

  it('scope_mismatch → human-readable label (not raw token)', () => {
    const label = approvalStateLabel('scope_mismatch')
    expect(label).not.toBe('scope_mismatch')
    expect(label).not.toContain('scope_mismatch')
    expect(label).toMatch(/scope|match|apply|decision/i)
  })

  it('unavailable → human-readable label', () => {
    const label = approvalStateLabel('unavailable')
    expect(label).toMatch(/unavailable|not available|inaccessible/i)
  })
})

// ---------------------------------------------------------------------------
// streamEventLabel — #47 scope-5 gap 5
// ---------------------------------------------------------------------------

describe('streamEventLabel', () => {
  it("'output' returns its safe fixed label and never echoes wire content", () => {
    const label = streamEventLabel('output')
    // Must be a non-empty string
    expect(typeof label).toBe('string')
    expect(label.length).toBeGreaterThan(0)
    // Must be the fixed safe label — not a raw wire token
    expect(label).toBe('Run output received')
    // Must not contain any wire-level field names that could leak frame content
    expect(label).not.toContain('runId')
    expect(label).not.toContain('droppedCount')
    expect(label).not.toContain('seq')
    expect(label).not.toContain('final')
  })

  it("'ready' returns its safe fixed label", () => {
    expect(streamEventLabel('ready')).toBe('Stream connected')
  })

  it("'status' returns its safe fixed label", () => {
    expect(streamEventLabel('status')).toBe('Run status updated')
  })

  it("'reset' returns its safe fixed label", () => {
    expect(streamEventLabel('reset')).toBe('Stream reconnected')
  })
})

// ---------------------------------------------------------------------------
// permissionLabel — Unit 5 approval prompt copy
// ---------------------------------------------------------------------------

describe('permissionLabel', () => {
  it('returns a non-empty string for known permission values', () => {
    const known = ['shell', 'edit', 'external_directory', 'network', 'read', 'write']
    for (const p of known) {
      const label = permissionLabel(p)
      expect(label, `permissionLabel('${p}') should be non-empty`).toBeTruthy()
      expect(typeof label).toBe('string')
    }
  })

  it('never returns the raw permission token as the label', () => {
    const known = ['shell', 'edit', 'external_directory', 'network', 'read', 'write']
    for (const p of known) {
      const label = permissionLabel(p)
      expect(label).not.toBe(p)
    }
  })

  it('returns a safe generic label for unknown permission values', () => {
    const label = permissionLabel('unknown_permission_xyz')
    expect(label).toBeTruthy()
    expect(label).not.toContain('unknown_permission_xyz')
  })

  it('shell → human-readable label', () => {
    expect(permissionLabel('shell')).toMatch(/shell|command/i)
  })

  it('edit → human-readable label', () => {
    expect(permissionLabel('edit')).toMatch(/file|edit/i)
  })

  it('external_directory → human-readable label (not raw token)', () => {
    const label = permissionLabel('external_directory')
    expect(label).not.toBe('external_directory')
    expect(label).not.toContain('external_directory')
    expect(label).toMatch(/directory|access|external/i)
  })
})

// ---------------------------------------------------------------------------
// isEditClassPermission — Unit 5
// ---------------------------------------------------------------------------

describe('isEditClassPermission', () => {
  it('returns true for edit', () => {
    expect(isEditClassPermission('edit')).toBe(true)
  })

  it('returns true for external_directory', () => {
    expect(isEditClassPermission('external_directory')).toBe(true)
  })

  it('returns false for shell', () => {
    expect(isEditClassPermission('shell')).toBe(false)
  })

  it('returns false for network', () => {
    expect(isEditClassPermission('network')).toBe(false)
  })

  it('returns false for unknown values', () => {
    expect(isEditClassPermission('unknown')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// R10 failure-class copy constants — Unit 5
// ---------------------------------------------------------------------------

describe('R10 failure-class copy constants', () => {
  it('APPROVAL_CANT_APPROVE_COPY is a non-empty string', () => {
    expect(typeof APPROVAL_CANT_APPROVE_COPY).toBe('string')
    expect(APPROVAL_CANT_APPROVE_COPY.length).toBeGreaterThan(0)
  })

  it('APPROVAL_TRANSPORT_FAILURE_COPY is a non-empty string', () => {
    expect(typeof APPROVAL_TRANSPORT_FAILURE_COPY).toBe('string')
    expect(APPROVAL_TRANSPORT_FAILURE_COPY.length).toBeGreaterThan(0)
  })

  it('APPROVAL_ALREADY_SETTLED_COPY is a non-empty string', () => {
    expect(typeof APPROVAL_ALREADY_SETTLED_COPY).toBe('string')
    expect(APPROVAL_ALREADY_SETTLED_COPY.length).toBeGreaterThan(0)
  })

  it('APPROVAL_ALWAYS_CONSEQUENCE_COPY is a non-empty string', () => {
    expect(typeof APPROVAL_ALWAYS_CONSEQUENCE_COPY).toBe('string')
    expect(APPROVAL_ALWAYS_CONSEQUENCE_COPY.length).toBeGreaterThan(0)
  })

  it('APPROVAL_ACCESS_CAVEAT_COPY is a non-empty string', () => {
    expect(typeof APPROVAL_ACCESS_CAVEAT_COPY).toBe('string')
    expect(APPROVAL_ACCESS_CAVEAT_COPY.length).toBeGreaterThan(0)
  })

  it('APPROVAL_EDIT_CLASS_CAVEAT_COPY is a non-empty string', () => {
    expect(typeof APPROVAL_EDIT_CLASS_CAVEAT_COPY).toBe('string')
    expect(APPROVAL_EDIT_CLASS_CAVEAT_COPY.length).toBeGreaterThan(0)
  })

  it('CRITICAL: denial copy and transport-failure copy are distinct (R10 — must not conflate)', () => {
    expect(APPROVAL_CANT_APPROVE_COPY).not.toBe(APPROVAL_TRANSPORT_FAILURE_COPY)
    // The transport copy must not contain "access" language that implies denial
    expect(APPROVAL_TRANSPORT_FAILURE_COPY).not.toMatch(/may not have.*access|approval access/i)
    // The denial copy must not contain "try again" language that implies retryability
    expect(APPROVAL_CANT_APPROVE_COPY).not.toMatch(/try again/i)
  })

  it('CRITICAL: no raw backend token leakage in any copy constant', () => {
    const allCopy = [
      APPROVAL_CANT_APPROVE_COPY,
      APPROVAL_TRANSPORT_FAILURE_COPY,
      APPROVAL_ALREADY_SETTLED_COPY,
      APPROVAL_ALWAYS_CONSEQUENCE_COPY,
      APPROVAL_ACCESS_CAVEAT_COPY,
      APPROVAL_EDIT_CLASS_CAVEAT_COPY,
    ]
    for (const copy of allCopy) {
      expect(copy).not.toContain('failed_to_settle')
      expect(copy).not.toContain('already_claimed')
      expect(copy).not.toContain('scope_mismatch')
      expect(copy).not.toContain('waiting_for_approval')
    }
  })

  it('APPROVAL_ALWAYS_CONSEQUENCE_COPY uses conservative wording (does not assert specific match key)', () => {
    // Must not claim a specific match dimension (e.g. "same command", "same tool")
    // until the exact grant scope is confirmed against the gateway
    expect(APPROVAL_ALWAYS_CONSEQUENCE_COPY).toMatch(/standing approval|auto-approves|grant rule/i)
    // Must not assert a specific match key
    expect(APPROVAL_ALWAYS_CONSEQUENCE_COPY).not.toMatch(/same command|same tool|same file/i)
  })
})
