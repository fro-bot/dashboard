import {describe, expect, it} from 'vitest'
import {classifySignal, type OperatorSignal, type OperatorState} from './state.ts'

describe('classifySignal — ready/loading', () => {
  it('maps a usable 200 response to ready', () => {
    const signal: OperatorSignal = {kind: 'http-ok', status: 200}
    const state: OperatorState = classifySignal(signal)
    expect(state).toBe('ready')
  })

  it('maps a loading signal to loading', () => {
    const signal: OperatorSignal = {kind: 'loading'}
    const state: OperatorState = classifySignal(signal)
    expect(state).toBe('loading')
  })
})

// ---------------------------------------------------------------------------
// Auth required — login redirect, 401, 403
// ---------------------------------------------------------------------------

describe('classifySignal — auth-required', () => {
  it('maps a login redirect (302) to auth-required', () => {
    const signal: OperatorSignal = {kind: 'redirect'}
    expect(classifySignal(signal)).toBe('auth-required')
  })

  it('maps HTTP 401 to auth-required', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 401}
    expect(classifySignal(signal)).toBe('auth-required')
  })

  it('maps HTTP 403 to auth-required', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 403}
    expect(classifySignal(signal)).toBe('auth-required')
  })
})

// ---------------------------------------------------------------------------
// Rate limited — 429
// ---------------------------------------------------------------------------

describe('classifySignal — rate-limited', () => {
  it('maps HTTP 429 to rate-limited', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 429}
    expect(classifySignal(signal)).toBe('rate-limited')
  })
})

// ---------------------------------------------------------------------------
// Offline — explicit offline, network failure
// ---------------------------------------------------------------------------

describe('classifySignal — offline', () => {
  it('maps explicit offline signal to offline', () => {
    const signal: OperatorSignal = {kind: 'offline'}
    expect(classifySignal(signal)).toBe('offline')
  })

  it('maps network failure to offline', () => {
    const signal: OperatorSignal = {kind: 'network-failure'}
    expect(classifySignal(signal)).toBe('offline')
  })
})

// ---------------------------------------------------------------------------
// Unavailable — 5xx, malformed JSON, contract drift, denied, unknown, stream drift
// ---------------------------------------------------------------------------

describe('classifySignal — unavailable', () => {
  it('maps HTTP 500 to unavailable', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 500}
    expect(classifySignal(signal)).toBe('unavailable')
  })

  it('maps HTTP 502 to unavailable', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 502}
    expect(classifySignal(signal)).toBe('unavailable')
  })

  it('maps HTTP 503 to unavailable', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 503}
    expect(classifySignal(signal)).toBe('unavailable')
  })

  it('maps HTTP 504 to unavailable', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 504}
    expect(classifySignal(signal)).toBe('unavailable')
  })

  it('maps malformed JSON (protocol error) to unavailable', () => {
    const signal: OperatorSignal = {kind: 'malformed-response'}
    expect(classifySignal(signal)).toBe('unavailable')
  })

  it('maps contract drift to unavailable', () => {
    const signal: OperatorSignal = {kind: 'contract-drift'}
    expect(classifySignal(signal)).toBe('unavailable')
  })

  it('maps denied (404 from gateway) to unavailable', () => {
    const signal: OperatorSignal = {kind: 'denied'}
    expect(classifySignal(signal)).toBe('unavailable')
  })

  it('maps unknown error to unavailable', () => {
    const signal: OperatorSignal = {kind: 'unknown'}
    expect(classifySignal(signal)).toBe('unavailable')
  })

  it('maps stream drift to unavailable', () => {
    const signal: OperatorSignal = {kind: 'stream-drift'}
    expect(classifySignal(signal)).toBe('unavailable')
  })

  it('maps HTTP 400 to unavailable (not auth-required)', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 400}
    expect(classifySignal(signal)).toBe('unavailable')
  })

  it('maps HTTP 404 to unavailable', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 404}
    expect(classifySignal(signal)).toBe('unavailable')
  })
})

// ---------------------------------------------------------------------------
// No-oracle: path-unaware — same signal maps same state regardless of source
// ---------------------------------------------------------------------------

describe('classifySignal — no-oracle path-unaware', () => {
  const paths = [
    '/operator/session',
    '/operator/repos',
    '/operator/runs/some-id',
    '/operator/runs/some-id/approvals',
  ] as const

  it('maps 401 to auth-required regardless of operator API path', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 401}
    for (const _path of paths) {
      // Classifier is path-unaware — same signal, same result
      expect(classifySignal(signal)).toBe('auth-required')
    }
  })

  it('maps 403 to auth-required regardless of operator API path', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 403}
    for (const _path of paths) {
      expect(classifySignal(signal)).toBe('auth-required')
    }
  })

  it('maps 429 to rate-limited regardless of operator API path', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 429}
    for (const _path of paths) {
      expect(classifySignal(signal)).toBe('rate-limited')
    }
  })

  it('maps 500 to unavailable regardless of operator API path', () => {
    const signal: OperatorSignal = {kind: 'http-error', status: 500}
    for (const _path of paths) {
      expect(classifySignal(signal)).toBe('unavailable')
    }
  })

  it('maps network-failure to offline regardless of operator API path', () => {
    const signal: OperatorSignal = {kind: 'network-failure'}
    for (const _path of paths) {
      expect(classifySignal(signal)).toBe('offline')
    }
  })
})

// ---------------------------------------------------------------------------
// Auth expiry: 401/403 from any source clears to auth-required
// ---------------------------------------------------------------------------

describe('classifySignal — auth expiry', () => {
  it('401 from bootstrap maps to auth-required', () => {
    expect(classifySignal({kind: 'http-error', status: 401})).toBe('auth-required')
  })

  it('403 from stream maps to auth-required', () => {
    expect(classifySignal({kind: 'http-error', status: 403})).toBe('auth-required')
  })

  it('401 from mutation maps to auth-required', () => {
    expect(classifySignal({kind: 'http-error', status: 401})).toBe('auth-required')
  })
})

// ---------------------------------------------------------------------------
// Action posture helpers
// ---------------------------------------------------------------------------

describe('isActionDisabled', () => {
  it('is exported and callable', async () => {
    const {isActionDisabled} = await import('./state.ts')
    expect(typeof isActionDisabled).toBe('function')
  })

  it('returns true for auth-required', async () => {
    const {isActionDisabled} = await import('./state.ts')
    expect(isActionDisabled('auth-required')).toBe(true)
  })

  it('returns true for rate-limited', async () => {
    const {isActionDisabled} = await import('./state.ts')
    expect(isActionDisabled('rate-limited')).toBe(true)
  })

  it('returns true for offline', async () => {
    const {isActionDisabled} = await import('./state.ts')
    expect(isActionDisabled('offline')).toBe(true)
  })

  it('returns true for unavailable', async () => {
    const {isActionDisabled} = await import('./state.ts')
    expect(isActionDisabled('unavailable')).toBe(true)
  })

  it('returns false for ready', async () => {
    const {isActionDisabled} = await import('./state.ts')
    expect(isActionDisabled('ready')).toBe(false)
  })

  it('returns true for loading (actions not yet enabled)', async () => {
    const {isActionDisabled} = await import('./state.ts')
    expect(isActionDisabled('loading')).toBe(true)
  })
})
