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
  const allStates: ApprovalDecisionState[] = [
    'claimed',
    'already_settled',
    'expired',
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

  it('already_settled → human-readable label (not raw token)', () => {
    const label = approvalStateLabel('already_settled')
    expect(label).not.toBe('already_settled')
    expect(label).not.toContain('already_settled')
    expect(label).toMatch(/already|settled|decided|complete/i)
  })

  it('expired → human-readable label', () => {
    const label = approvalStateLabel('expired')
    expect(label).toMatch(/expir|timeout|lapsed/i)
  })

  it('unavailable → human-readable label', () => {
    const label = approvalStateLabel('unavailable')
    expect(label).toMatch(/unavailable|not available|inaccessible/i)
  })
})
