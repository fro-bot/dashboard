/**
 * Operator contract conformance tests.
 *
 * Verifies the vendored operator contract v1.0.0 is correctly pinned and
 * that parse helpers behave per spec.
 *
 * Source: fro-bot/agent | Tag: v0.71.0 | PR: #952 | Commit: 92b621e1
 */
import type {ApprovalDecisionState, RunStatus} from '../src/gateway/operator-client.ts'
import type {OperatorDecisionState, OperatorWebStatus} from '../src/gateway/operator-contract/index.ts'
import {describe, expect, it} from 'vitest'
import {
  OPERATOR_CONTRACT_VERSION,
  parseOperatorCsrfToken,
  parseOperatorError,
  parseOperatorOk,
  parseOperatorSessionInfo,
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
// Version pin
// ---------------------------------------------------------------------------

describe('OPERATOR_CONTRACT_VERSION', () => {
  it('is pinned to 1.0.0', () => {
    expect(OPERATOR_CONTRACT_VERSION).toBe('1.0.0')
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
