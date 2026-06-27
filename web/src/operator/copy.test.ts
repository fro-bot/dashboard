/**
 * Tests for the canonical operator state copy mapping.
 *
 * TDD: these tests are written BEFORE the implementation.
 * Run with: npx vitest run --config web/vitest.config.ts web/src/operator/copy.test.ts
 *
 * Security invariants:
 * - Copy must never include raw signal values, status codes, payload snippets,
 *   URLs, tokens, cookies, CSRF values, repo names, run IDs, or stack traces.
 * - Copy must be fixed/coarse — no dynamic interpolation of sensitive values.
 */

import {describe, expect, it} from 'vitest'
import {
  getStateHeadline,
  getStateDetail,
  getStateActionReason,
  getStateRecoveryHint,
  type OperatorStateCopy,
} from './copy.ts'
import type {OperatorState} from './state.ts'

// ---------------------------------------------------------------------------
// Completeness: every state has copy
// ---------------------------------------------------------------------------

const ALL_STATES: OperatorState[] = ['ready', 'loading', 'auth-required', 'rate-limited', 'offline', 'unavailable']

describe('getStateHeadline', () => {
  for (const state of ALL_STATES) {
    it(`returns a non-empty headline for ${state}`, () => {
      const headline = getStateHeadline(state)
      expect(typeof headline).toBe('string')
      expect(headline.length).toBeGreaterThan(0)
    })
  }
})

describe('getStateDetail', () => {
  for (const state of ALL_STATES) {
    it(`returns a non-empty detail for ${state}`, () => {
      const detail = getStateDetail(state)
      expect(typeof detail).toBe('string')
      expect(detail.length).toBeGreaterThan(0)
    })
  }
})

describe('getStateActionReason', () => {
  it('returns a non-empty reason for auth-required', () => {
    const reason = getStateActionReason('auth-required')
    expect(reason).not.toBeNull()
    expect((reason as string).length).toBeGreaterThan(0)
  })

  it('returns a non-empty reason for rate-limited', () => {
    const reason = getStateActionReason('rate-limited')
    expect(reason).not.toBeNull()
    expect((reason as string).length).toBeGreaterThan(0)
  })

  it('returns a non-empty reason for offline', () => {
    const reason = getStateActionReason('offline')
    expect(reason).not.toBeNull()
    expect((reason as string).length).toBeGreaterThan(0)
  })

  it('returns a non-empty reason for unavailable', () => {
    const reason = getStateActionReason('unavailable')
    expect(reason).not.toBeNull()
    expect((reason as string).length).toBeGreaterThan(0)
  })

  it('returns null for ready (actions enabled)', () => {
    expect(getStateActionReason('ready')).toBeNull()
  })

  it('returns a non-empty reason for loading (actions not yet enabled)', () => {
    const reason = getStateActionReason('loading')
    expect(reason).not.toBeNull()
    expect((reason as string).length).toBeGreaterThan(0)
  })
})

describe('getStateRecoveryHint', () => {
  for (const state of ALL_STATES) {
    it(`returns a string recovery hint for ${state}`, () => {
      const hint = getStateRecoveryHint(state)
      expect(typeof hint).toBe('string')
    })
  }

  it('returns a non-empty recovery hint for auth-required', () => {
    expect(getStateRecoveryHint('auth-required').length).toBeGreaterThan(0)
  })

  it('returns a non-empty recovery hint for offline', () => {
    expect(getStateRecoveryHint('offline').length).toBeGreaterThan(0)
  })

  it('returns a non-empty recovery hint for unavailable', () => {
    expect(getStateRecoveryHint('unavailable').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Security: copy must not include raw signal values or payload snippets
// ---------------------------------------------------------------------------

describe('copy security — no raw signal values', () => {
  const sensitivePatterns = [
    /\b4\d\d\b/,        // raw HTTP status codes (4xx)
    /\b5\d\d\b/,        // raw HTTP status codes (5xx)
    /\bstatus\s*[:=]\s*\d/i, // "status: 401" style
    /\bhttp\b/i,        // raw "HTTP" protocol mention
    /\/operator\//,     // raw API paths
    /\bcsrf\b/i,        // CSRF token mention
    /\btoken\b/i,       // token mention
    /\bcookie\b/i,      // cookie mention
    /\bstack\b/i,       // stack trace mention
    /\bpayload\b/i,     // payload mention
  ]

  for (const state of ALL_STATES) {
    for (const pattern of sensitivePatterns) {
      it(`${state} headline does not match ${pattern}`, () => {
        expect(getStateHeadline(state)).not.toMatch(pattern)
      })

      it(`${state} detail does not match ${pattern}`, () => {
        expect(getStateDetail(state)).not.toMatch(pattern)
      })
    }
  }

  it('auth-required action reason does not include raw status codes', () => {
    const reason = getStateActionReason('auth-required') ?? ''
    expect(reason).not.toMatch(/\b4\d\d\b/)
    expect(reason).not.toMatch(/\b5\d\d\b/)
  })

  it('rate-limited action reason does not include raw status codes', () => {
    const reason = getStateActionReason('rate-limited') ?? ''
    expect(reason).not.toMatch(/\b4\d\d\b/)
    expect(reason).not.toMatch(/\b5\d\d\b/)
  })
})

// ---------------------------------------------------------------------------
// OperatorStateCopy bundle type
// ---------------------------------------------------------------------------

describe('OperatorStateCopy type', () => {
  it('is importable as a type', () => {
    // Type-only check — if this compiles, the type is exported correctly.
    const _check: OperatorStateCopy = {
      headline: 'test',
      detail: 'test',
      actionReason: null,
      recoveryHint: 'test',
    }
    expect(_check.headline).toBe('test')
  })
})

// ---------------------------------------------------------------------------
// Copy distinctness: each error state has distinct headline
// ---------------------------------------------------------------------------

describe('copy distinctness', () => {
  it('auth-required and offline have distinct headlines', () => {
    expect(getStateHeadline('auth-required')).not.toBe(getStateHeadline('offline'))
  })

  it('auth-required and unavailable have distinct headlines', () => {
    expect(getStateHeadline('auth-required')).not.toBe(getStateHeadline('unavailable'))
  })

  it('rate-limited and unavailable have distinct headlines', () => {
    expect(getStateHeadline('rate-limited')).not.toBe(getStateHeadline('unavailable'))
  })

  it('offline and unavailable have distinct headlines', () => {
    expect(getStateHeadline('offline')).not.toBe(getStateHeadline('unavailable'))
  })
})
