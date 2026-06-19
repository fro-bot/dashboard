import type {ApprovalDecisionState, RunStatus} from '../src/gateway/operator-client.ts'

/**
 * Tests for operator-safe display copy mapping.
 *
 * TDD: written before implementation.
 * Critical invariant: 'failed_to_settle' must NEVER be the primary UI label.
 * All RunStatus and ApprovalDecisionState values must have safe copy.
 */
import {describe, expect, it} from 'vitest'
import {approvalStateLabel, runStatusLabel} from '../src/gateway/operator-copy.ts'

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
