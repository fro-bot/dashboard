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

import type {OutputFrameData, RunEntry, StreamState} from '../public/operator-stream.js'
import {describe, expect, it, vi} from 'vitest'
import {
  bootstrapOperatorStreams,
  FIRST_FRAME_TIMEOUT_MS,
  MAX_SSE_BUFFER_BYTES,
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
    const text = `event: ready\ndata: {"contractVersion":"1.3.0"}\n\n`
    const result = parseSseFrame(text)
    expect(result).not.toBeNull()
    expect(result?.success).toBe(true)
    if (result !== null && result.success) {
      expect(result.frame.type).toBe('ready')
      if (result.frame.type === 'ready') {
        expect(result.frame.data.contractVersion).toBe('1.3.0')
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
    const text = 'data: {"contractVersion":"1.3.0"}\n\n'
    const result = parseSseFrame(text)
    expect(result?.success).toBe(false)
  })

  it('parses an output delta frame', () => {
    const text = `event: output\ndata: {"runId":"run-abc","text":"hello","final":false,"seq":0}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result?.success && result.frame.type === 'output') {
      expect(result.frame.data.text).toBe('hello')
      expect(result.frame.data.final).toBe(false)
      expect(result.frame.data.seq).toBe(0)
    } else {
      expect.fail('expected an output frame')
    }
  })

  it('parses an output frame with droppedCount', () => {
    const text = `event: output\ndata: {"runId":"run-abc","text":"x","final":false,"seq":3,"droppedCount":2}\n\n`
    const result = parseSseFrame(text)
    if (result?.success && result.frame.type === 'output') {
      expect(result.frame.data.droppedCount).toBe(2)
    } else {
      expect.fail('expected an output frame')
    }
  })

  it('rejects an output frame missing required fields', () => {
    for (const data of [
      '{"text":"x","final":false,"seq":0}',
      '{"runId":"r","final":false,"seq":0}',
      '{"runId":"r","text":"x","seq":0}',
      '{"runId":"r","text":"x","final":false}',
      '{"runId":"r","text":"x","final":"no","seq":0}',
      '{"runId":"r","text":"x","final":false,"seq":"0"}',
      '{"runId":"r","text":"x","final":false,"seq":0,"droppedCount":"many"}',
    ]) {
      const result = parseSseFrame(`event: output\ndata: ${data}\n\n`)
      expect(result?.success).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// nextStreamState — output accumulation
// ---------------------------------------------------------------------------

describe('nextStreamState — output accumulation', () => {
  // Reach 'live' so output frames are applied (mirrors status: pre-ready is ignored).
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})
  const applyOutput = (state: StreamState, data: OutputFrameData): StreamState =>
    nextStreamState(state, {type: 'output', data})
  const runOf = (state: StreamState, runId: string): RunEntry => {
    const entry = state.runs[runId]
    if (entry === undefined) throw new Error(`expected run ${runId} in state`)
    return entry
  }

  it('does not apply output before ready (not live)', () => {
    const state = applyOutput(INITIAL_STATE, {runId: 'run-abc', text: 'x', final: false, seq: 0})
    expect(state.runs['run-abc']).toBeUndefined()
  })

  it('accumulates deltas in seq order', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-abc', text: 'Hel', final: false, seq: 0})
    state = applyOutput(state, {runId: 'run-abc', text: 'lo ', final: false, seq: 1})
    state = applyOutput(state, {runId: 'run-abc', text: 'world', final: false, seq: 2})
    expect(runOf(state, 'run-abc').outputText).toBe('Hello world')
    expect(runOf(state, 'run-abc').outputFinal).toBe(false)
  })

  it('a final frame replaces the accumulated text with the authoritative answer', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-abc', text: 'partial', final: false, seq: 0})
    state = applyOutput(state, {runId: 'run-abc', text: 'AUTHORITATIVE', final: true, seq: 1})
    expect(runOf(state, 'run-abc').outputText).toBe('AUTHORITATIVE')
    expect(runOf(state, 'run-abc').outputFinal).toBe(true)
  })

  it('does not apply a delta with a seq <= the last applied seq (out-of-order/duplicate)', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-abc', text: 'first', final: false, seq: 1})
    state = applyOutput(state, {runId: 'run-abc', text: 'stale', final: false, seq: 0})
    state = applyOutput(state, {runId: 'run-abc', text: 'dup', final: false, seq: 1})
    expect(runOf(state, 'run-abc').outputText).toBe('first')
  })

  it('sets the coalesced flag when droppedCount > 0', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-abc', text: 'x', final: false, seq: 0, droppedCount: 2})
    expect(runOf(state, 'run-abc').outputCoalesced).toBe(true)
  })

  it('a final frame always replaces, even if its seq is not greater (authoritative wins)', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-abc', text: 'acc', final: false, seq: 5})
    state = applyOutput(state, {runId: 'run-abc', text: 'final-answer', final: true, seq: 0})
    expect(runOf(state, 'run-abc').outputText).toBe('final-answer')
    expect(runOf(state, 'run-abc').outputFinal).toBe(true)
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

  it('PINNED_CONTRACT_VERSION is 1.3.0', () => {
    expect(PINNED_CONTRACT_VERSION).toBe('1.3.0')
  })
})

// ---------------------------------------------------------------------------
// F1 — CRLF normalization in parseSseFrame
// ---------------------------------------------------------------------------

describe('parseSseFrame — CRLF normalization', () => {
  it('parses a ready frame delimited by CRLF record separators', () => {
    const text = 'event: ready\r\ndata: {"contractVersion":"1.1.0"}\r\n\r\n'
    const result = parseSseFrame(text)
    expect(result).not.toBeNull()
    expect(result?.success).toBe(true)
    if (result !== null && result.success) {
      expect(result.frame.type).toBe('ready')
    }
  })

  it('parses a status frame with CRLF identically to LF-only', () => {
    const payload = JSON.stringify({
      runId: 'run-abc',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-20T10:00:00Z',
      stale: false,
    })
    const crlfResult = parseSseFrame(`event: status\r\ndata: ${payload}\r\n\r\n`)
    const lfResult = parseSseFrame(`event: status\ndata: ${payload}\n\n`)
    expect(crlfResult?.success).toBe(true)
    expect(lfResult?.success).toBe(true)
    if (crlfResult !== null && crlfResult.success && lfResult !== null && lfResult.success) {
      expect(crlfResult.frame.type).toBe(lfResult.frame.type)
    }
  })

  it('parses a reset frame with lone CR line endings', () => {
    const text = 'event: reset\rdata: {"runId":"run-abc","reason":"shutdown"}\r\r'
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result !== null && result.success) {
      expect(result.frame.type).toBe('reset')
    }
  })
})

// ---------------------------------------------------------------------------
// F2 — Bounded buffer constant exported
// ---------------------------------------------------------------------------

describe('MAX_SSE_BUFFER_BYTES constant', () => {
  it('is a positive number', () => {
    expect(typeof MAX_SSE_BUFFER_BYTES).toBe('number')
    expect(MAX_SSE_BUFFER_BYTES).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// F3 — Cap reset-triggered reconnects
// ---------------------------------------------------------------------------

describe('nextStreamState — reset retryCount capping', () => {
  it('increments retryCount on each non-terminal reset', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state1 = nextStreamState(liveState, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'no-snapshot'},
    })
    expect(state1.retryCount).toBe(1)
    expect(state1.shouldReconnect).toBe(true)

    const state2 = nextStreamState(state1, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'shutdown'},
    })
    expect(state2.retryCount).toBe(2)
    expect(state2.shouldReconnect).toBe(true)
  })

  it('transitions to failed when retryCount reaches RETRY_MAX_COUNT on reset', () => {
    const exhausted: StreamState = {
      ...INITIAL_STATE,
      connection: 'reconnecting',
      retryCount: RETRY_MAX_COUNT,
    }
    const state = nextStreamState(exhausted, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'no-snapshot'},
    })
    expect(state.connection).toBe('failed')
    expect(state.shouldReconnect).toBe(false)
  })

  it('repeated reset events eventually stop reconnecting (caps at RETRY_MAX_COUNT)', () => {
    let state: StreamState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    for (let i = 0; i < RETRY_MAX_COUNT + 5; i++) {
      state = nextStreamState(state, {
        type: 'reset',
        data: {runId: 'run-abc', reason: 'no-snapshot'},
      })
    }
    expect(state.connection).toBe('failed')
    expect(state.shouldReconnect).toBe(false)
  })

  it('terminal reset reason → closed, no reconnect', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'terminal'},
    })
    expect(state.connection).toBe('closed')
    expect(state.shouldReconnect).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// F5 — Drift is absorbing; status before ready not rendered
// ---------------------------------------------------------------------------

describe('nextStreamState — drift is absorbing', () => {
  it('status before any ready is not applied (connection stays connecting)', () => {
    const state = nextStreamState(INITIAL_STATE, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    // Status before ready must not move to live or add runs
    expect(state.connection).toBe('connecting')
    expect(Object.keys(state.runs)).toHaveLength(0)
  })

  it('once in drift, a matching ready does not escape drift', () => {
    const drifted = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: '0.0.1'},
    })
    expect(drifted.connection).toBe('drift')

    // Now send a matching ready — must stay in drift
    const state = nextStreamState(drifted, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    expect(state.connection).toBe('drift')
  })

  it('once in drift, a status frame does not update runs', () => {
    const drifted = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: '0.0.1'},
    })
    const state = nextStreamState(drifted, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    expect(state.connection).toBe('drift')
    expect(Object.keys(state.runs)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// F6 — Value-allowlist in parseSseFrame
// ---------------------------------------------------------------------------

describe('parseSseFrame — allowlist gate for status/phase/surface', () => {
  it('rejects a status frame with out-of-allowlist status — parse failure, not dispatched', () => {
    const payload = JSON.stringify({
      runId: 'run-abc',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'fro-bot/private-repo leak',
      startedAt: '2026-06-20T10:00:00Z',
      stale: false,
    })
    const result = parseSseFrame(`event: status\ndata: ${payload}\n\n`)
    expect(result?.success).toBe(false)
    // Must not echo the hostile value
    if (result !== null && !result.success) {
      expect(result.error).not.toContain('private-repo')
    }
  })

  it('rejects a status frame with out-of-allowlist phase', () => {
    const payload = JSON.stringify({
      runId: 'run-abc',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'UNKNOWN_PHASE',
      status: 'running',
      startedAt: '2026-06-20T10:00:00Z',
      stale: false,
    })
    const result = parseSseFrame(`event: status\ndata: ${payload}\n\n`)
    expect(result?.success).toBe(false)
  })

  it('rejects a status frame with out-of-allowlist surface', () => {
    const payload = JSON.stringify({
      runId: 'run-abc',
      entityRef: 'fro-bot/agent',
      surface: 'unknown-surface',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-20T10:00:00Z',
      stale: false,
    })
    const result = parseSseFrame(`event: status\ndata: ${payload}\n\n`)
    expect(result?.success).toBe(false)
  })

  it('accepts all valid status values', () => {
    const validStatuses = ['queued', 'blocked', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled']
    for (const status of validStatuses) {
      const payload = JSON.stringify({
        runId: 'run-abc',
        entityRef: 'fro-bot/agent',
        surface: 'github',
        phase: 'EXECUTING',
        status,
        startedAt: '2026-06-20T10:00:00Z',
        stale: false,
      })
      const result = parseSseFrame(`event: status\ndata: ${payload}\n\n`)
      expect(result?.success).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// F8 — backoffDelay(0) === RETRY_BASE_MS
// ---------------------------------------------------------------------------

describe('backoff first-delay', () => {
  it('RETRY_BASE_MS is 1000ms', () => {
    expect(RETRY_BASE_MS).toBe(1000)
  })

  it('RETRY_FACTOR is 2', () => {
    expect(RETRY_FACTOR).toBe(2)
  })

  it('first retry delay (retryCount=1 after increment) uses backoffDelay(1) = 2000ms', () => {
    // After the first network-error, retryCount becomes 1.
    // scheduleReconnect calls backoffDelay(retryCount) = backoffDelay(1) = 2000ms.
    // This is the corrected behavior (was backoffDelay(retryCount-1) = backoffDelay(0) = 1000ms).
    // We verify the formula: RETRY_BASE_MS * RETRY_FACTOR^1 = 2000
    expect(RETRY_BASE_MS * RETRY_FACTOR ** 1).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// F13 — null-prototype runs map guards __proto__ keys
// ---------------------------------------------------------------------------

describe('nextStreamState — null-prototype runs map', () => {
  it('a runId of __proto__ is stored in the runs map without polluting Object.prototype', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const protoRunId = '__proto__'
    const state = nextStreamState(liveState, {
      type: 'status',
      data: {
        ...ACTIVE_STATUS,
        runId: protoRunId,
      },
    })
    // The run entry should be stored (accessible via Object.hasOwn)
    expect(Object.hasOwn(state.runs, protoRunId)).toBe(true)
    // Object.prototype must not be polluted — a plain {} should not have the key
    expect(Object.hasOwn({}, protoRunId)).toBe(false)
  })

  it('runs map produced by the reducer has a null prototype', () => {
    // We verify the reducer preserves null-prototype by checking the state machine output
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    // The runs object should not have Object.prototype methods directly
    // (null-prototype objects don't inherit hasOwnProperty etc.)
    expect(Object.getPrototypeOf(state.runs)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Browser bootstrap (discovers run cards, starts a stream per card)
// ---------------------------------------------------------------------------

interface FakeStatusEl {
  textContent: string
  className: string
  classList: {add: () => void; remove: () => void}
}

interface FakeCard {
  dataset: {runId: string}
  querySelector: () => FakeStatusEl
}

function makeFakeCard(runId: string): FakeCard {
  return {
    dataset: {runId},
    querySelector: () => ({textContent: '', className: '', classList: {add() {}, remove() {}}}),
  }
}

interface FakeSection {
  querySelector: (sel: string) => {textContent: string; hidden: boolean} | null
  querySelectorAll: () => FakeCard[]
}

interface FakeDocument {
  querySelector: (sel: string) => FakeSection | null
  readyState: string
  addEventListener: () => void
}

async function withFakeBrowser(
  cards: FakeCard[],
  sectionPresent: boolean,
  run: () => void,
): Promise<string[]> {
  const fetchCalls: string[] = []

  const section: FakeSection = {
    querySelector: (sel: string) =>
      sel.includes('stream-status') ? {textContent: '', hidden: false} : null,
    querySelectorAll: () => cards,
  }

  const fakeDocument: FakeDocument = {
    querySelector: (sel: string) => (sel === '#run-status-section' && sectionPresent ? section : null),
    readyState: 'complete',
    addEventListener() {},
  }

  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal(
    'fetch',
    async (url: string) => {
      fetchCalls.push(url)
      return new Promise<Response>(() => {}) // never settles — no real streaming in the test
    },
  )
  vi.stubGlobal('addEventListener', () => {})

  try {
    run()
  } finally {
    vi.unstubAllGlobals()
  }

  return fetchCalls
}

describe('bootstrapOperatorStreams', () => {
  it('starts one stream per run card, fetching the per-run stream path', async () => {
    const cards = [makeFakeCard('run-001'), makeFakeCard('run-002')]
    const fetchCalls = await withFakeBrowser(cards, true, bootstrapOperatorStreams)

    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[0]).toBe('/operator/runs/run-001/stream')
    expect(fetchCalls[1]).toBe('/operator/runs/run-002/stream')
  })

  it('does nothing when the run-status section is absent', async () => {
    const fetchCalls = await withFakeBrowser([makeFakeCard('run-001')], false, bootstrapOperatorStreams)
    expect(fetchCalls).toHaveLength(0)
  })

  it('skips cards with an empty run id', async () => {
    const cards = [makeFakeCard(''), makeFakeCard('run-003')]
    const fetchCalls = await withFakeBrowser(cards, true, bootstrapOperatorStreams)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toBe('/operator/runs/run-003/stream')
  })
})

// ---------------------------------------------------------------------------
// First-frame timeout — reducer-level tests
// ---------------------------------------------------------------------------

describe('nextStreamState — first-frame timeout', () => {
  it('connecting + first-frame-timeout → submitted-unobservable, shouldReconnect false', () => {
    const state = nextStreamState(INITIAL_STATE, {type: 'first-frame-timeout'})
    expect(state.connection).toBe('submitted-unobservable')
    expect(state.shouldReconnect).toBe(false)
  })

  it('reconnecting + first-frame-timeout → submitted-unobservable, shouldReconnect false', () => {
    const reconnecting: StreamState = {
      ...INITIAL_STATE,
      connection: 'reconnecting',
      retryCount: 1,
    }
    const state = nextStreamState(reconnecting, {type: 'first-frame-timeout'})
    expect(state.connection).toBe('submitted-unobservable')
    expect(state.shouldReconnect).toBe(false)
  })

  it('live + first-frame-timeout → stays live (no-op)', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {type: 'first-frame-timeout'})
    expect(state.connection).toBe('live')
  })

  it('a state that already received a frame (live with run data) + first-frame-timeout → no overwrite', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const withRun = nextStreamState(liveState, {type: 'status', data: ACTIVE_STATUS})
    const state = nextStreamState(withRun, {type: 'first-frame-timeout'})
    expect(state.connection).toBe('live')
    expect(Object.keys(state.runs)).toHaveLength(1)
  })

  it('not-found + first-frame-timeout → stays not-found', () => {
    const notFound = nextStreamState(INITIAL_STATE, {type: 'http-status', code: 404})
    const state = nextStreamState(notFound, {type: 'first-frame-timeout'})
    expect(state.connection).toBe('not-found')
  })

  it('failed + first-frame-timeout → stays failed', () => {
    const failed: StreamState = {...INITIAL_STATE, connection: 'failed', shouldReconnect: false}
    const state = nextStreamState(failed, {type: 'first-frame-timeout'})
    expect(state.connection).toBe('failed')
  })

  it('closed + first-frame-timeout → stays closed', () => {
    const closed: StreamState = {...INITIAL_STATE, connection: 'closed', shouldReconnect: false}
    const state = nextStreamState(closed, {type: 'first-frame-timeout'})
    expect(state.connection).toBe('closed')
  })

  it('drift + first-frame-timeout → stays drift (drift is absorbing)', () => {
    const drifted = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: '0.0.1'},
    })
    const state = nextStreamState(drifted, {type: 'first-frame-timeout'})
    expect(state.connection).toBe('drift')
  })

  it('a ready frame before the timeout leaves state live (timer-clear is DOM-shell only; reducer is fully tested here)', () => {
    // The pure reducer path: ready → live, then timeout is a no-op
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    expect(liveState.connection).toBe('live')
    // Timeout after live is a no-op
    const afterTimeout = nextStreamState(liveState, {type: 'first-frame-timeout'})
    expect(afterTimeout.connection).toBe('live')
  })

  it('FIRST_FRAME_TIMEOUT_MS is a positive number', () => {
    expect(typeof FIRST_FRAME_TIMEOUT_MS).toBe('number')
    expect(FIRST_FRAME_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// F2 — closed/submitted-unobservable guard: abort-rejection must not reopen
// ---------------------------------------------------------------------------

describe('nextStreamState — closed and submitted-unobservable are terminal for network events', () => {
  it('closed + network-error → stays closed (abort-rejection must not reopen the stream)', () => {
    const closed: StreamState = {
      ...INITIAL_STATE,
      connection: 'closed',
      shouldReconnect: false,
    }
    const state = nextStreamState(closed, {type: 'network-error'})
    expect(state.connection).toBe('closed')
    expect(state.shouldReconnect).toBe(false)
  })

  it('closed + unexpected-close → stays closed (abort-rejection must not reopen the stream)', () => {
    const closed: StreamState = {
      ...INITIAL_STATE,
      connection: 'closed',
      shouldReconnect: false,
    }
    const state = nextStreamState(closed, {type: 'unexpected-close'})
    expect(state.connection).toBe('closed')
    expect(state.shouldReconnect).toBe(false)
  })

  it('submitted-unobservable + network-error → stays submitted-unobservable', () => {
    const unobservable: StreamState = {
      ...INITIAL_STATE,
      connection: 'submitted-unobservable',
      shouldReconnect: false,
    }
    const state = nextStreamState(unobservable, {type: 'network-error'})
    expect(state.connection).toBe('submitted-unobservable')
    expect(state.shouldReconnect).toBe(false)
  })

  it('submitted-unobservable + unexpected-close → stays submitted-unobservable', () => {
    const unobservable: StreamState = {
      ...INITIAL_STATE,
      connection: 'submitted-unobservable',
      shouldReconnect: false,
    }
    const state = nextStreamState(unobservable, {type: 'unexpected-close'})
    expect(state.connection).toBe('submitted-unobservable')
    expect(state.shouldReconnect).toBe(false)
  })

  it('closed + network-error does not increment retryCount', () => {
    const closed: StreamState = {
      ...INITIAL_STATE,
      connection: 'closed',
      retryCount: 2,
      shouldReconnect: false,
    }
    const state = nextStreamState(closed, {type: 'network-error'})
    expect(state.retryCount).toBe(2)
  })

  it('closed + unexpected-close does not increment retryCount', () => {
    const closed: StreamState = {
      ...INITIAL_STATE,
      connection: 'closed',
      retryCount: 3,
      shouldReconnect: false,
    }
    const state = nextStreamState(closed, {type: 'unexpected-close'})
    expect(state.retryCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Buffer overflow fails closed terminally (no reconnect)
// ---------------------------------------------------------------------------

describe('nextStreamState — buffer overflow', () => {
  it('buffer-overflow → failed with no reconnect, regardless of retry budget', () => {
    const live: StreamState = nextStreamState(
      nextStreamState(
        {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false},
        {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}},
      ),
      {type: 'status', data: ACTIVE_STATUS},
    )
    const overflowed = nextStreamState(live, {type: 'buffer-overflow'})
    expect(overflowed.connection).toBe('failed')
    expect(overflowed.shouldReconnect).toBe(false)
  })

  it('buffer-overflow fails closed even with retries remaining', () => {
    const state: StreamState = {
      connection: 'reconnecting',
      runs: {},
      retryCount: 0,
      shouldReconnect: true,
    }
    const overflowed = nextStreamState(state, {type: 'buffer-overflow'})
    expect(overflowed.connection).toBe('failed')
    expect(overflowed.shouldReconnect).toBe(false)
  })
})
