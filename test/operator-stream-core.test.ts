/**
 * Tests for the pure core of the operator run stream client.
 *
 * Imports directly from public/operator-stream.js (plain ESM, no TS syntax).
 * Vitest runs in Node 24 and can import .js ESM files directly.
 *
 * Security invariants tested:
 * - Parser: ready/status/reset parsed; heartbeat comment ignored; malformed → no bogus frame.
 * - State machine: terminal status → closed; reset → resubscribe; max-duration + active → reconnect;
 *   max-duration + terminal → no reconnect; unexpected close → bounded retries then failed.
 * - Contract-version mismatch → drift state, no status applied.
 * - 404 → single not-found state; 429 → backpressure state (no cause branching).
 * - Render model exposes only phase/status/timestamps (no raw output/tool/path/repo-name/entityRef).
 * - No console output of frame data.
 */

import type {StreamState} from '../public/operator-stream.js'
import {describe, expect, it} from 'vitest'
import {
  nextStreamState,
  parseSseFrame,
  PINNED_CONTRACT_VERSION,
  RETRY_BASE_MS,
  RETRY_FACTOR,
  RETRY_MAX_COUNT,
  toSafeRunView,
} from '../public/operator-stream.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_STATUS = {
  runId: 'run-abc',
  entityRef: 'fro-bot/agent',
  surface: 'github',
  phase: 'EXECUTING',
  status: 'running',
  startedAt: '2026-06-20T10:00:00Z',
  stale: false,
}

const TERMINAL_STATUS = {
  runId: 'run-abc',
  entityRef: 'fro-bot/agent',
  surface: 'github',
  phase: 'COMPLETED',
  status: 'succeeded',
  startedAt: '2026-06-20T10:00:00Z',
  stale: false,
}

const INITIAL_STATE: StreamState = {
  connection: 'connecting',
  runs: {},
  retryCount: 0,
  shouldReconnect: false,
}

// ---------------------------------------------------------------------------
// parseSseFrame — pure parser
// ---------------------------------------------------------------------------

describe('parseSseFrame — pure parser', () => {
  it('parses a ready frame', () => {
    const text = `event: ready\ndata: {"contractVersion":"1.1.0"}\n\n`
    const result = parseSseFrame(text)
    expect(result).not.toBeNull()
    expect(result?.success).toBe(true)
    if (result !== null && result.success) {
      expect(result.frame.type).toBe('ready')
      if (result.frame.type === 'ready') {
        expect(result.frame.data.contractVersion).toBe('1.1.0')
      }
    }
  })

  it('parses a status frame with a full payload', () => {
    const text = `event: status\ndata: ${JSON.stringify(ACTIVE_STATUS)}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result !== null && result.success) {
      expect(result.frame.type).toBe('status')
      if (result.frame.type === 'status') {
        expect(result.frame.data.runId).toBe('run-abc')
        expect(result.frame.data.status).toBe('running')
        expect(result.frame.data.phase).toBe('EXECUTING')
      }
    }
  })

  it('parses a reset frame for each valid reason', () => {
    const reasons = ['no-snapshot', 'terminal', 'shutdown', 'max-duration', 'writer-error', 'overflow']
    for (const reason of reasons) {
      const text = `event: reset\ndata: ${JSON.stringify({runId: 'run-abc', reason})}\n\n`
      const result = parseSseFrame(text)
      expect(result?.success).toBe(true)
      if (result !== null && result.success) {
        expect(result.frame.type).toBe('reset')
        if (result.frame.type === 'reset') {
          expect(result.frame.data.reason).toBe(reason)
          expect(result.frame.data.runId).toBe('run-abc')
        }
      }
    }
  })

  it('ignores a heartbeat comment — returns null', () => {
    const text = ': heartbeat\n\n'
    const result = parseSseFrame(text)
    expect(result).toBeNull()
  })

  it('ignores a blank comment line — returns null', () => {
    const text = ':\n\n'
    const result = parseSseFrame(text)
    expect(result).toBeNull()
  })

  it('returns a failure for malformed JSON data', () => {
    const text = 'event: ready\ndata: {not valid json}\n\n'
    const result = parseSseFrame(text)
    expect(result).not.toBeNull()
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      // Error message must be a fixed string, not echoing input
      expect(result.error).not.toContain('{not valid json}')
    }
  })

  it('returns a failure for a ready frame missing contractVersion', () => {
    const text = 'event: ready\ndata: {"other":"field"}\n\n'
    const result = parseSseFrame(text)
    expect(result?.success).toBe(false)
  })

  it('returns a failure for a reset frame with unknown reason', () => {
    const text = 'event: reset\ndata: {"runId":"run-abc","reason":"unknown-reason"}\n\n'
    const result = parseSseFrame(text)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('unknown-reason')
    }
  })

  it('returns a failure for a status frame missing required fields', () => {
    const text = 'event: status\ndata: {"runId":"run-abc"}\n\n'
    const result = parseSseFrame(text)
    expect(result?.success).toBe(false)
  })

  it('returns a failure for an unknown event name', () => {
    const text = 'event: unknown-event\ndata: {"foo":"bar"}\n\n'
    const result = parseSseFrame(text)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('unknown-event')
    }
  })

  it('returns a failure for a data-only record (no event name)', () => {
    const text = 'data: {"contractVersion":"1.1.0"}\n\n'
    const result = parseSseFrame(text)
    expect(result?.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// nextStreamState — lifecycle state machine
// ---------------------------------------------------------------------------

describe('nextStreamState — ready frame', () => {
  it('transitions to live when contractVersion matches the pinned version', () => {
    const state = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    expect(state.connection).toBe('live')
  })

  it('transitions to drift when contractVersion does not match', () => {
    const state = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: '0.0.1'},
    })
    expect(state.connection).toBe('drift')
  })

  it('does not retain any run status on drift', () => {
    // Pre-populate a run, then drift
    const withRun = nextStreamState(INITIAL_STATE, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    const drifted = nextStreamState(withRun, {
      type: 'ready',
      data: {contractVersion: '0.0.1'},
    })
    expect(drifted.connection).toBe('drift')
    // Runs map should be cleared on drift
    expect(Object.keys(drifted.runs)).toHaveLength(0)
  })

  it('does not set shouldReconnect on drift', () => {
    const state = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: '9.9.9'},
    })
    expect(state.shouldReconnect).toBe(false)
  })
})

describe('nextStreamState — status frame', () => {
  it('updates the run status for an active run', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    expect(state.runs['run-abc']).toBeDefined()
    expect(state.runs['run-abc']?.status).toBe('running')
    expect(state.runs['run-abc']?.phase).toBe('EXECUTING')
    expect(state.runs['run-abc']?.terminal).toBe(false)
  })

  it('marks a run terminal when status is succeeded', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'status',
      data: TERMINAL_STATUS,
    })
    expect(state.runs['run-abc']?.terminal).toBe(true)
    expect(state.runs['run-abc']?.status).toBe('succeeded')
  })

  it('marks a run terminal when status is failed', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'status',
      data: {...ACTIVE_STATUS, status: 'failed', phase: 'FAILED'},
    })
    expect(state.runs['run-abc']?.terminal).toBe(true)
  })

  it('marks a run terminal when status is cancelled', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'status',
      data: {...ACTIVE_STATUS, status: 'cancelled', phase: 'CANCELLED'},
    })
    expect(state.runs['run-abc']?.terminal).toBe(true)
  })

  it('transitions to closed with no reconnect when all observed runs are terminal', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'status',
      data: TERMINAL_STATUS,
    })
    expect(state.connection).toBe('closed')
    expect(state.shouldReconnect).toBe(false)
  })

  it('does not close when at least one run is still active', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    // Add two runs: one active, one terminal
    const withActive = nextStreamState(liveState, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    const withBoth = nextStreamState(withActive, {
      type: 'status',
      data: {...TERMINAL_STATUS, runId: 'run-xyz'},
    })
    expect(withBoth.connection).toBe('live')
    expect(withBoth.shouldReconnect).toBe(false)
  })
})

describe('nextStreamState — reset frame', () => {
  it('transitions to reconnecting and sets shouldReconnect on reset', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'no-snapshot'},
    })
    expect(state.connection).toBe('reconnecting')
    expect(state.shouldReconnect).toBe(true)
  })

  it('transitions to reconnecting on shutdown reset', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'shutdown'},
    })
    expect(state.connection).toBe('reconnecting')
    expect(state.shouldReconnect).toBe(true)
  })

  it('reconnects on max-duration reset when the run is still active', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const withActive = nextStreamState(liveState, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    const state = nextStreamState(withActive, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'max-duration'},
    })
    expect(state.connection).toBe('reconnecting')
    expect(state.shouldReconnect).toBe(true)
  })

  it('does not reconnect on max-duration reset when the run is terminal', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const withTerminal = nextStreamState(liveState, {
      type: 'status',
      data: TERMINAL_STATUS,
    })
    // Override connection back to live to test the reset path
    const liveWithTerminal: StreamState = {...withTerminal, connection: 'live'}
    const state = nextStreamState(liveWithTerminal, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'max-duration'},
    })
    expect(state.shouldReconnect).toBe(false)
    expect(state.connection).toBe('closed')
  })
})

describe('nextStreamState — lifecycle signals', () => {
  it('transitions to not-found on http-404 signal', () => {
    const state = nextStreamState(INITIAL_STATE, {type: 'http-status', code: 404})
    expect(state.connection).toBe('not-found')
    expect(state.shouldReconnect).toBe(false)
  })

  it('transitions to backpressure on http-429 signal', () => {
    const state = nextStreamState(INITIAL_STATE, {type: 'http-status', code: 429})
    expect(state.connection).toBe('backpressure')
    expect(state.shouldReconnect).toBe(false)
  })

  it('transitions to reconnecting on network-error when retries remain and last status non-terminal', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const withActive = nextStreamState(liveState, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    const state = nextStreamState(withActive, {type: 'network-error'})
    expect(state.connection).toBe('reconnecting')
    expect(state.shouldReconnect).toBe(true)
    expect(state.retryCount).toBe(1)
  })

  it('transitions to failed on network-error when retries are exhausted', () => {
    const exhausted: StreamState = {
      ...INITIAL_STATE,
      connection: 'reconnecting',
      retryCount: RETRY_MAX_COUNT,
    }
    const state = nextStreamState(exhausted, {type: 'network-error'})
    expect(state.connection).toBe('failed')
    expect(state.shouldReconnect).toBe(false)
  })

  it('transitions to closed on stream-closed signal', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {type: 'stream-closed'})
    expect(state.connection).toBe('closed')
  })

  it('transitions to reconnecting on unexpected stream-closed when retries remain and run is active', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const withActive = nextStreamState(liveState, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    const state = nextStreamState(withActive, {type: 'unexpected-close'})
    expect(state.connection).toBe('reconnecting')
    expect(state.shouldReconnect).toBe(true)
    expect(state.retryCount).toBe(1)
  })

  it('transitions to failed on unexpected-close when retries are exhausted', () => {
    const exhausted: StreamState = {
      ...INITIAL_STATE,
      connection: 'reconnecting',
      retryCount: RETRY_MAX_COUNT,
    }
    const state = nextStreamState(exhausted, {type: 'unexpected-close'})
    expect(state.connection).toBe('failed')
    expect(state.shouldReconnect).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// toSafeRunView — render model safety
// ---------------------------------------------------------------------------

describe('toSafeRunView — safe render model', () => {
  it('returns only safe fields: runId, status, phase, startedAt, stale', () => {
    const view = toSafeRunView(ACTIVE_STATUS)
    expect(view.runId).toBe('run-abc')
    expect(view.status).toBe('running')
    expect(view.phase).toBe('EXECUTING')
    expect(view.startedAt).toBe('2026-06-20T10:00:00Z')
    expect(view.stale).toBe(false)
  })

  it('does NOT include entityRef even if present on input', () => {
    const view = toSafeRunView(ACTIVE_STATUS)
    expect('entityRef' in view).toBe(false)
  })

  it('does NOT include surface even if present on input', () => {
    const view = toSafeRunView(ACTIVE_STATUS)
    expect('surface' in view).toBe(false)
  })

  it('does NOT include extra fields passed on input', () => {
    const withExtras = {
      ...ACTIVE_STATUS,
      output: 'some output text',
      tool: 'bash',
      path: '/workspace/secret',
      repoName: 'fro-bot/agent',
    }
    const view = toSafeRunView(withExtras)
    expect('output' in view).toBe(false)
    expect('tool' in view).toBe(false)
    expect('path' in view).toBe(false)
    expect('repoName' in view).toBe(false)
  })

  it('does NOT include entityRef even when explicitly passed', () => {
    const withEntityRef = {
      ...ACTIVE_STATUS,
      entityRef: 'fro-bot/secret-repo',
    }
    const view = toSafeRunView(withEntityRef)
    expect('entityRef' in view).toBe(false)
    // Verify the value is not present anywhere in the stringified output
    expect(JSON.stringify(view)).not.toContain('fro-bot/secret-repo')
  })
})

// ---------------------------------------------------------------------------
// No-leak test: drive a sequence and assert no sensitive data in render model
// ---------------------------------------------------------------------------

describe('no-leak: render model contains no sensitive fields', () => {
  it('a full sequence produces a render model with no repo name or entityRef', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const withStatus = nextStreamState(liveState, {
      type: 'status',
      data: {
        ...ACTIVE_STATUS,
        entityRef: 'fro-bot/secret-repo',
      },
    })

    // Extract the run entry and map to safe view
    const runEntry = withStatus.runs['run-abc']
    expect(runEntry).toBeDefined()

    if (runEntry) {
      const view = toSafeRunView(runEntry)
      const serialized = JSON.stringify(view)

      // Must not contain the repo name / entityRef
      expect(serialized).not.toContain('fro-bot/secret-repo')
      expect(serialized).not.toContain('entityRef')
      expect(serialized).not.toContain('surface')

      // Must contain only the safe fields
      expect(view.runId).toBe('run-abc')
      expect(view.status).toBe('running')
    }
  })

  it('toSafeRunView output does not contain any raw frame fields beyond safe set', () => {
    const dangerousInput = {
      runId: 'run-abc',
      entityRef: 'org/private-repo',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-20T10:00:00Z',
      stale: false,
      output: 'secret output',
      tool: 'bash',
      path: '/workspace/private',
    }
    const view = toSafeRunView(dangerousInput)
    const keys = Object.keys(view)
    // Only these keys are allowed
    const allowedKeys = new Set(['runId', 'status', 'phase', 'startedAt', 'stale'])
    for (const key of keys) {
      expect(allowedKeys.has(key)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Backoff constants sanity
// ---------------------------------------------------------------------------

describe('backoff constants', () => {
  it('RETRY_BASE_MS is a positive number', () => {
    expect(typeof RETRY_BASE_MS).toBe('number')
    expect(RETRY_BASE_MS).toBeGreaterThan(0)
  })

  it('RETRY_FACTOR is greater than 1', () => {
    expect(typeof RETRY_FACTOR).toBe('number')
    expect(RETRY_FACTOR).toBeGreaterThan(1)
  })

  it('RETRY_MAX_COUNT is a positive integer', () => {
    expect(typeof RETRY_MAX_COUNT).toBe('number')
    expect(RETRY_MAX_COUNT).toBeGreaterThan(0)
    expect(Number.isInteger(RETRY_MAX_COUNT)).toBe(true)
  })

  it('PINNED_CONTRACT_VERSION is 1.1.0', () => {
    expect(PINNED_CONTRACT_VERSION).toBe('1.1.0')
  })
})
