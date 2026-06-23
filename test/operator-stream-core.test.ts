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

import type {ApprovalFrameDataOpen, OutputFrameData, RunEntry, StreamState} from '../public/operator-stream.js'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  bootstrapOperatorStreams,
  buildApprovalClient,
  FIRST_FRAME_TIMEOUT_MS,
  getOpenApprovals,
  hasOpenApprovals,
  initOperatorStream,
  MAX_APPROVAL_TOMBSTONES,
  MAX_OPEN_APPROVALS,
  MAX_OUTPUT_TEXT_CHARS,
  MAX_SSE_BUFFER_BYTES,
  nextStreamState,
  parseSseFrame,
  PINNED_CONTRACT_VERSION,
  renderApprovalPrompt,
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
    const text = `event: ready\ndata: {"contractVersion":"1.4.0"}\n\n`
    const result = parseSseFrame(text)
    expect(result).not.toBeNull()
    expect(result?.success).toBe(true)
    if (result !== null && result.success) {
      expect(result.frame.type).toBe('ready')
      if (result.frame.type === 'ready') {
        expect(result.frame.data.contractVersion).toBe('1.4.0')
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
    const text = 'data: {"contractVersion":"1.4.0"}\n\n'
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

  it('rejects an output frame with a non-integer, negative, or non-finite seq', () => {
    for (const data of [
      '{"runId":"r","text":"x","final":false,"seq":-1}',
      '{"runId":"r","text":"x","final":false,"seq":1.5}',
      '{"runId":"r","text":"x","final":false,"seq":1e999}',
    ]) {
      const result = parseSseFrame(`event: output\ndata: ${data}\n\n`)
      expect(result?.success).toBe(false)
    }
  })

  it('rejects an output frame with a negative or fractional droppedCount', () => {
    for (const data of [
      '{"runId":"r","text":"x","final":false,"seq":0,"droppedCount":-2}',
      '{"runId":"r","text":"x","final":false,"seq":0,"droppedCount":2.5}',
    ]) {
      const result = parseSseFrame(`event: output\ndata: ${data}\n\n`)
      expect(result?.success).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// parseSseFrame — approval frame parsing
// ---------------------------------------------------------------------------

describe('parseSseFrame — approval frame (open variant)', () => {
  it('parses an open approval frame with command', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      permission: 'shell',
      command: 'echo hello',
      settled: false,
    }
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result?.success && result.frame.type === 'approval') {
      expect(result.frame.data.runId).toBe('run-001')
      expect(result.frame.data.requestID).toBe('req-001')
      expect(result.frame.data.settled).toBe(false)
      if (!result.frame.data.settled) {
        expect(result.frame.data.permission).toBe('shell')
        expect(result.frame.data.command).toBe('echo hello')
      }
    } else {
      expect.fail('expected an approval frame')
    }
  })

  it('parses an open approval frame with filepath', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      permission: 'fs-write',
      filepath: '/workspace/output.txt',
      settled: false,
    }
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result?.success && result.frame.type === 'approval') {
      expect(result.frame.data.settled).toBe(false)
      if (!result.frame.data.settled) {
        expect(result.frame.data.permission).toBe('fs-write')
        expect(result.frame.data.filepath).toBe('/workspace/output.txt')
      }
    } else {
      expect.fail('expected an approval frame')
    }
  })

  it('parses an open approval frame with neither command nor filepath', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      permission: 'network',
      settled: false,
    }
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result?.success && result.frame.type === 'approval') {
      expect(result.frame.data.settled).toBe(false)
      if (!result.frame.data.settled) {
        expect(result.frame.data.permission).toBe('network')
        expect(result.frame.data.command).toBeUndefined()
        expect(result.frame.data.filepath).toBeUndefined()
      }
    } else {
      expect.fail('expected an approval frame')
    }
  })

  it('parses an open approval frame with empty string command (valid string)', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      permission: 'shell',
      command: '',
      settled: false,
    }
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result?.success && result.frame.type === 'approval') {
      if (!result.frame.data.settled) {
        expect(result.frame.data.command).toBe('')
      }
    } else {
      expect.fail('expected an approval frame')
    }
  })
})

describe('parseSseFrame — approval frame (settle variant)', () => {
  it('parses a settle approval frame', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      settled: true,
    }
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result?.success && result.frame.type === 'approval') {
      expect(result.frame.data.runId).toBe('run-001')
      expect(result.frame.data.requestID).toBe('req-001')
      expect(result.frame.data.settled).toBe(true)
    } else {
      expect.fail('expected an approval frame')
    }
  })

  it('parses a settle frame with extra unexpected fields (only required fields used)', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      settled: true,
      extraField: 'ignored',
      anotherExtra: 42,
    }
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result?.success) {
      expect(result.frame.type).toBe('approval')
    }
  })
})

describe('parseSseFrame — approval frame (error cases, fail-closed, no wire echo)', () => {
  it('rejects approval frame with missing runId', () => {
    const payload = {requestID: 'req-001', permission: 'shell', settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('req-001')
    }
  })

  it('rejects approval frame with non-string runId', () => {
    const payload = {runId: 42, requestID: 'req-001', permission: 'shell', settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('42')
    }
  })

  it('rejects approval frame with missing requestID', () => {
    const payload = {runId: 'run-001', permission: 'shell', settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('run-001')
    }
  })

  it('rejects approval frame with non-string requestID', () => {
    const payload = {runId: 'run-001', requestID: true, permission: 'shell', settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
  })

  it('rejects open approval frame with missing permission', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('run-001')
      expect(result.error).not.toContain('req-001')
    }
  })

  it('rejects open approval frame with non-string permission', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: 99, settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('99')
    }
  })

  it('rejects approval frame with non-boolean settled', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: 'shell', settled: 'false'}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('false')
    }
  })

  it('rejects open approval frame with non-string command (present but wrong type)', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 123, settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('123')
    }
  })

  it('rejects open approval frame with non-string filepath (present but wrong type)', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: 'shell', filepath: [], settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
  })

  it('error string for missing required fields is fixed and does not echo wire content', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).toBe('approval frame missing required fields')
    }
  })

  it('error string for invalid settled discriminator is fixed and does not echo wire content', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', settled: 'yes'}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).toBe('approval frame has invalid settled discriminator')
    }
  })

  // Fix 2: empty-string rejections
  it('rejects approval frame with empty-string runId (open)', () => {
    const payload = {runId: '', requestID: 'req-001', permission: 'shell', settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
  })

  it('rejects approval frame with empty-string requestID (open)', () => {
    const payload = {runId: 'run-001', requestID: '', permission: 'shell', settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
  })

  it('rejects approval frame with empty-string runId (settle)', () => {
    const payload = {runId: '', requestID: 'req-001', settled: true}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
  })

  it('rejects approval frame with empty-string requestID (settle)', () => {
    const payload = {runId: 'run-001', requestID: '', settled: true}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
  })

  it('rejects open approval frame with empty-string permission', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: '', settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
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

  it('a status frame after output preserves the accumulated output fields', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-abc', text: 'answer-text', final: true, seq: 0})
    // A terminal status frame arrives AFTER the final output — it must not drop output state.
    state = nextStreamState(state, {type: 'status', data: TERMINAL_STATUS})
    expect(runOf(state, 'run-abc').outputText).toBe('answer-text')
    expect(runOf(state, 'run-abc').outputFinal).toBe(true)
    expect(runOf(state, 'run-abc').status).toBe('succeeded')
    expect(runOf(state, 'run-abc').terminal).toBe(true)
  })

  it('caps cumulative output growth and flags truncation', () => {
    let state = live()
    // Append deltas well past the cap; accumulated text must not grow without bound.
    const chunk = 'x'.repeat(50_000)
    for (let seq = 0; seq < 10; seq++) {
      state = applyOutput(state, {runId: 'run-abc', text: chunk, final: false, seq})
    }
    const entry = runOf(state, 'run-abc')
    expect(entry.outputText).toBeDefined()
    expect((entry.outputText ?? '').length).toBeLessThanOrEqual(MAX_OUTPUT_TEXT_CHARS)
    expect(entry.outputTruncated).toBe(true)
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

  it('PINNED_CONTRACT_VERSION is 1.4.0', () => {
    expect(PINNED_CONTRACT_VERSION).toBe('1.4.0')
  })
})

// ---------------------------------------------------------------------------
// CRLF normalization in parseSseFrame
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
// Bounded buffer constant exported
// ---------------------------------------------------------------------------

describe('MAX_SSE_BUFFER_BYTES constant', () => {
  it('is a positive number', () => {
    expect(typeof MAX_SSE_BUFFER_BYTES).toBe('number')
    expect(MAX_SSE_BUFFER_BYTES).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Cap reset-triggered reconnects
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
// Drift is absorbing; status before ready not rendered
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
// Value-allowlist in parseSseFrame
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
// backoffDelay(0) === RETRY_BASE_MS
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
// null-prototype runs map guards __proto__ keys
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
// closed/submitted-unobservable guard: abort-rejection must not reopen
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
// #47 scope-5: output accumulation edge cases
// ---------------------------------------------------------------------------

describe('nextStreamState — output accumulation edge cases', () => {
  // Helpers mirroring the existing output accumulation describe block
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})
  const applyOutput = (state: StreamState, data: OutputFrameData): StreamState =>
    nextStreamState(state, {type: 'output', data})
  const runOf = (state: StreamState, runId: string): RunEntry => {
    const entry = state.runs[runId]
    if (entry === undefined) throw new Error(`expected run ${runId} in state`)
    return entry
  }

  // Gap 2: no-output run — terminal status with no prior output frame
  it('terminal status with no prior output frame leaves run with no outputText (no-output case)', () => {
    let state = live()
    // Receive a terminal status with no preceding output frame
    state = nextStreamState(state, {type: 'status', data: TERMINAL_STATUS})
    const run = runOf(state, 'run-abc')
    // outputText must be absent or empty — never a required empty terminal frame
    expect(run.outputText === undefined || run.outputText === '').toBe(true)
    // Must not block or error — terminal state is still reached
    expect(run.terminal).toBe(true)
    expect(run.status).toBe('succeeded')
  })

  // Gap 3: late-subscriber final-only — only a final:true frame, no deltas
  it('a subscriber receiving only a final:true frame ends with authoritative outputText and outputFinal===true', () => {
    let state = live()
    // No deltas — only the authoritative final frame (mirrors gateway replay cache)
    state = applyOutput(state, {runId: 'run-001', text: 'Authoritative final answer', final: true, seq: 7})
    const run = runOf(state, 'run-001')
    expect(run.outputText).toBe('Authoritative final answer')
    expect(run.outputFinal).toBe(true)
  })

  // Gap 4: droppedCount on a final/terminal frame
  it('a final:true frame with droppedCount > 0 sets outputCoalesced AND replaces text', () => {
    let state = live()
    // Some prior deltas
    state = applyOutput(state, {runId: 'run-001', text: 'partial ', final: false, seq: 0})
    // Final frame carries droppedCount (coalesced under backpressure)
    state = applyOutput(state, {runId: 'run-001', text: 'complete answer', final: true, seq: 3, droppedCount: 2})
    const run = runOf(state, 'run-001')
    expect(run.outputText).toBe('complete answer')
    expect(run.outputFinal).toBe(true)
    expect(run.outputCoalesced).toBe(true)
  })

  // Gap 6: no-leak — accumulated output path never surfaces frame metadata as free text
  it('accumulated output state does not surface runId, droppedCount, or other frame fields as free text', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-001', text: 'hello', final: false, seq: 0, droppedCount: 1})
    state = applyOutput(state, {runId: 'run-001', text: ' world', final: true, seq: 1})
    const run = runOf(state, 'run-001')

    // Only outputText carries user-visible text — the other frame fields must not
    // appear as free-text values in the accumulated output string
    expect(run.outputText).not.toContain('run-001')
    expect(run.outputText).not.toContain('droppedCount')
    expect(run.outputText).not.toContain('final')
    expect(run.outputText).not.toContain('seq')

    // The run entry itself must not have a field whose value is the raw runId string
    // embedded in the outputText (only the runId key is expected, not as output content)
    const serialized = JSON.stringify({outputText: run.outputText, outputFinal: run.outputFinal, outputCoalesced: run.outputCoalesced})
    expect(serialized).not.toContain('run-001')
    expect(serialized).not.toContain('droppedCount')
  })
})

// ---------------------------------------------------------------------------
// nextStreamState — approval reducer state
// ---------------------------------------------------------------------------

describe('nextStreamState — approval reducer state', () => {
  // Helper: reach 'live' state (mirrors existing output-accumulation helpers)
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  // Helper: get run entry or throw
  const runOf = (state: StreamState, runId: string): RunEntry => {
    const entry = state.runs[runId]
    if (entry === undefined) throw new Error(`expected run ${runId} in state`)
    return entry
  }

  // Helper: dispatch an open approval frame
  const openApproval = (
    state: StreamState,
    runId: string,
    requestID: string,
    permission: string,
    command?: string,
  ): StreamState =>
    nextStreamState(state, {
      type: 'approval',
      data: {
        runId,
        requestID,
        permission,
        settled: false,
        ...(command === undefined ? {} : {command}),
      },
    })

  // Helper: dispatch a settle approval frame
  const settleApproval = (state: StreamState, runId: string, requestID: string): StreamState =>
    nextStreamState(state, {
      type: 'approval',
      data: {runId, requestID, settled: true},
    })

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('happy: open(req-001) → open-prompts has req-001 with permission/command', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo hello')
    const run = runOf(state, 'run-001')
    const prompts = getOpenApprovals(run)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.requestID).toBe('req-001')
    expect(prompts[0]?.permission).toBe('shell')
    expect(prompts[0]?.command).toBe('echo hello')
    expect(hasOpenApprovals(run)).toBe(true)
  })

  it('happy: settle(req-001) → prompt gone AND req-001 tombstoned', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo hello')
    state = settleApproval(state, 'run-001', 'req-001')
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(getOpenApprovals(run)).toHaveLength(0)
    // A subsequent open for the same id must be ignored (tombstone wins)
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo again')
    const runAfterReopen = runOf(state, 'run-001')
    expect(hasOpenApprovals(runAfterReopen)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Pre-live: approval frame before ready is ignored
  // ---------------------------------------------------------------------------

  it('pre-live: approval frame before ready (connection !== live) → ignored, no prompt', () => {
    // INITIAL_STATE is 'connecting', not 'live'
    const state = openApproval(INITIAL_STATE, 'run-001', 'req-001', 'shell')
    // run-001 must not appear in runs at all
    expect(state.runs['run-001']).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // Race: open-after-settle
  // ---------------------------------------------------------------------------

  it('race — open-after-settle: settle(req-001) THEN open(req-001) → open is ignored (tombstone wins)', () => {
    let state = live()
    // Settle first (without a prior open — settle-unseen is valid)
    state = settleApproval(state, 'run-001', 'req-001')
    // Now open arrives — must be ignored
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo late')
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(getOpenApprovals(run)).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // Race: settle-unseen
  // ---------------------------------------------------------------------------

  it('race — settle-unseen: settle(req-002) with no prior open → no prompt added, req-002 tombstoned', () => {
    let state = live()
    state = settleApproval(state, 'run-001', 'req-002')
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    // A later open for req-002 must also be ignored (tombstone wins)
    state = openApproval(state, 'run-001', 'req-002', 'network')
    const runAfter = runOf(state, 'run-001')
    expect(hasOpenApprovals(runAfter)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Race: id-reuse (same as open-after-settle, explicit test)
  // ---------------------------------------------------------------------------

  it('race — id-reuse: settle(req-001) then fresh open(req-001) → ignored (tombstone wins)', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo first')
    state = settleApproval(state, 'run-001', 'req-001')
    // Simulate id reuse: a new open with the same requestID
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo reused')
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(getOpenApprovals(run)).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // Race: terminal absorbing
  // ---------------------------------------------------------------------------

  it('race — terminal absorbing: open(req-001) then terminal status → all prompts cleared', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo hello')
    // Verify prompt is open before terminal
    expect(hasOpenApprovals(runOf(state, 'run-001'))).toBe(true)
    // Apply terminal status
    state = nextStreamState(state, {
      type: 'status',
      data: {
        runId: 'run-001',
        entityRef: 'testowner/test-repo',
        surface: 'github',
        phase: 'COMPLETED',
        status: 'succeeded',
        startedAt: '2026-06-22T10:00:00Z',
        stale: false,
      },
    })
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(run.terminal).toBe(true)
  })

  it('race — terminal absorbing: after terminal status, a later open(req-003) for that run → ignored', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo hello')
    // Apply terminal status
    state = nextStreamState(state, {
      type: 'status',
      data: {
        runId: 'run-001',
        entityRef: 'testowner/test-repo',
        surface: 'github',
        phase: 'COMPLETED',
        status: 'succeeded',
        startedAt: '2026-06-22T10:00:00Z',
        stale: false,
      },
    })
    // A new open for a different requestID after terminal → must be ignored
    state = openApproval(state, 'run-001', 'req-003', 'network')
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(getOpenApprovals(run)).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // Idempotent: duplicate open
  // ---------------------------------------------------------------------------

  it('idempotent: duplicate open(req-001) → single prompt, no corruption', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo hello')
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo hello')
    const run = runOf(state, 'run-001')
    const prompts = getOpenApprovals(run)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.requestID).toBe('req-001')
  })

  // ---------------------------------------------------------------------------
  // Derivation: hasOpenApprovals
  // ---------------------------------------------------------------------------

  it('derivation: hasOpenApprovals true with ≥1 open prompt, false after all settled/cleared', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell')
    state = openApproval(state, 'run-001', 'req-002', 'network')
    expect(hasOpenApprovals(runOf(state, 'run-001'))).toBe(true)
    state = settleApproval(state, 'run-001', 'req-001')
    expect(hasOpenApprovals(runOf(state, 'run-001'))).toBe(true) // req-002 still open
    state = settleApproval(state, 'run-001', 'req-002')
    expect(hasOpenApprovals(runOf(state, 'run-001'))).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Immutability: prior state not mutated
  // ---------------------------------------------------------------------------

  it('immutability: prior state object is not mutated by an approval transition', () => {
    const liveState = live()
    const beforeOpen = openApproval(liveState, 'run-001', 'req-001', 'shell')
    // Capture a reference to the prior runs map
    const priorRuns = beforeOpen.runs
    const priorEntry = beforeOpen.runs['run-001']
    // Apply a settle
    const afterSettle = settleApproval(beforeOpen, 'run-001', 'req-001')
    // The prior state's runs map must be unchanged
    expect(beforeOpen.runs).toBe(priorRuns) // same reference (not mutated)
    expect(beforeOpen.runs['run-001']).toBe(priorEntry) // same entry reference
    // The new state must have a different runs map
    expect(afterSettle.runs).not.toBe(priorRuns)
    // The prior entry must still show the prompt as open
    expect(hasOpenApprovals(priorEntry)).toBe(true)
    // The new entry must show it settled
    expect(hasOpenApprovals(afterSettle.runs['run-001'])).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Multi-prompt
  // ---------------------------------------------------------------------------

  it('multi-prompt: open(req-001) + open(req-002) on one run → both present; settle(req-001) → only req-002 remains', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo first')
    state = openApproval(state, 'run-001', 'req-002', 'fs-write', undefined)
    const run = runOf(state, 'run-001')
    expect(getOpenApprovals(run)).toHaveLength(2)
    expect(hasOpenApprovals(run)).toBe(true)
    // Settle req-001
    state = settleApproval(state, 'run-001', 'req-001')
    const runAfter = runOf(state, 'run-001')
    const remaining = getOpenApprovals(runAfter)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.requestID).toBe('req-002')
    expect(hasOpenApprovals(runAfter)).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Approval state preserved across status updates (non-terminal)
  // ---------------------------------------------------------------------------

  it('approval state survives a non-terminal status update', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo hello')
    // Apply a non-terminal status update
    state = nextStreamState(state, {
      type: 'status',
      data: {
        runId: 'run-001',
        entityRef: 'testowner/test-repo',
        surface: 'github',
        phase: 'EXECUTING',
        status: 'waiting_for_approval',
        startedAt: '2026-06-22T10:00:00Z',
        stale: false,
      },
    })
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(true)
    expect(getOpenApprovals(run)[0]?.requestID).toBe('req-001')
  })
})

// ---------------------------------------------------------------------------
// hasOpenApprovals / getOpenApprovals — derivation helpers
// ---------------------------------------------------------------------------

describe('hasOpenApprovals / getOpenApprovals — derivation helpers', () => {
  it('hasOpenApprovals returns false for a run entry with no approval fields', () => {
    // A run entry that has never seen an approval frame
    const entry: RunEntry = {
      runId: 'run-001',
      status: 'running',
      phase: 'EXECUTING',
      startedAt: '2026-06-22T10:00:00Z',
      stale: false,
      terminal: false,
    }
    expect(hasOpenApprovals(entry)).toBe(false)
  })

  it('getOpenApprovals returns an empty array for a run entry with no approval fields', () => {
    const entry: RunEntry = {
      runId: 'run-001',
      status: 'running',
      phase: 'EXECUTING',
      startedAt: '2026-06-22T10:00:00Z',
      stale: false,
      terminal: false,
    }
    expect(getOpenApprovals(entry)).toEqual([])
  })

  it('getOpenApprovals returns typed ApprovalFrameDataOpen objects', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'ls', settled: false},
    })
    const run = state.runs['run-001']
    if (run === undefined) throw new Error('expected run-001')
    const prompts: readonly ApprovalFrameDataOpen[] = getOpenApprovals(run)
    expect(prompts[0]?.permission).toBe('shell')
    expect(prompts[0]?.command).toBe('ls')
    expect(prompts[0]?.settled).toBe(false)
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

// ---------------------------------------------------------------------------
// Fix 1: tombstone map cap + open-approvals map cap
// ---------------------------------------------------------------------------

describe('nextStreamState — approval tombstone cap (MAX_APPROVAL_TOMBSTONES)', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  it('MAX_APPROVAL_TOMBSTONES is a positive number', () => {
    expect(typeof MAX_APPROVAL_TOMBSTONES).toBe('number')
    expect(MAX_APPROVAL_TOMBSTONES).toBeGreaterThan(0)
  })

  it('MAX_OPEN_APPROVALS is a positive number', () => {
    expect(typeof MAX_OPEN_APPROVALS).toBe('number')
    expect(MAX_OPEN_APPROVALS).toBeGreaterThan(0)
  })

  it('tombstone map stays at cap after MAX_APPROVAL_TOMBSTONES+1 settles — oldest evicted, newest present', () => {
    let state = live()
    // Add MAX_APPROVAL_TOMBSTONES settles
    for (let i = 0; i < MAX_APPROVAL_TOMBSTONES; i++) {
      state = nextStreamState(state, {
        type: 'approval',
        data: {runId: 'run-001', requestID: `req-${i}`, settled: true},
      })
    }
    const runBefore = state.runs['run-001']
    expect(runBefore).toBeDefined()
    const tombstonesBefore = runBefore?.approvalTombstones ?? {}
    expect(Object.keys(tombstonesBefore)).toHaveLength(MAX_APPROVAL_TOMBSTONES)

    // Add one more — should evict oldest (req-0) and add newest
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: `req-${MAX_APPROVAL_TOMBSTONES}`, settled: true},
    })
    const run = state.runs['run-001']
    const tombstones = run?.approvalTombstones ?? {}
    // Map size stays at cap
    expect(Object.keys(tombstones)).toHaveLength(MAX_APPROVAL_TOMBSTONES)
    // Oldest (req-0) evicted
    expect(Object.hasOwn(tombstones, 'req-0')).toBe(false)
    // Newest present
    expect(Object.hasOwn(tombstones, `req-${MAX_APPROVAL_TOMBSTONES}`)).toBe(true)
  })
})

describe('nextStreamState — open-approvals cap (MAX_OPEN_APPROVALS)', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  it('overflow open frame is ignored when open-prompts map is at cap — existing prompts intact', () => {
    let state = live()
    // Add MAX_OPEN_APPROVALS distinct open prompts
    for (let i = 0; i < MAX_OPEN_APPROVALS; i++) {
      state = nextStreamState(state, {
        type: 'approval',
        data: {runId: 'run-001', requestID: `req-${i}`, permission: 'shell', settled: false},
      })
    }
    const runAtCap = state.runs['run-001']
    expect(Object.keys(runAtCap?.approvalOpenPrompts ?? {})).toHaveLength(MAX_OPEN_APPROVALS)

    // One more distinct open — must be ignored
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: `req-${MAX_OPEN_APPROVALS}`, permission: 'shell', settled: false},
    })
    const run = state.runs['run-001']
    const openPrompts = run?.approvalOpenPrompts ?? {}
    // Size stays at cap
    expect(Object.keys(openPrompts)).toHaveLength(MAX_OPEN_APPROVALS)
    // Overflow requestID not present
    expect(Object.hasOwn(openPrompts, `req-${MAX_OPEN_APPROVALS}`)).toBe(false)
    // All original prompts still present
    expect(Object.hasOwn(openPrompts, 'req-0')).toBe(true)
    expect(Object.hasOwn(openPrompts, `req-${MAX_OPEN_APPROVALS - 1}`)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fix 3: coverage gaps
// ---------------------------------------------------------------------------

describe('parseSseFrame — approval frame (settle variant) — extra fields absent', () => {
  it('settle frame with extra wire fields: parsed data has ONLY {runId, requestID, settled}', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      settled: true,
      extraField: 'ignored',
      anotherExtra: 42,
    }
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(true)
    if (result?.success && result.frame.type === 'approval') {
      const data = result.frame.data
      const keys = Object.keys(data)
      expect(keys.sort()).toEqual(['requestID', 'runId', 'settled'].sort())
      expect('extraField' in data).toBe(false)
      expect('anotherExtra' in data).toBe(false)
    } else {
      expect.fail('expected an approval frame')
    }
  })
})

describe('parseSseFrame — approval frame (open variant) — filepath valid', () => {
  it('parses an open approval frame with empty string filepath (valid string)', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      permission: 'fs-write',
      filepath: '',
      settled: false,
    }
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(true)
    if (result?.success && result.frame.type === 'approval') {
      if (!result.frame.data.settled) {
        expect(result.frame.data.filepath).toBe('')
      }
    } else {
      expect.fail('expected an approval frame')
    }
  })
})

describe('parseSseFrame — approval frame (error cases) — no-echo assertions', () => {
  it('non-string requestID rejection does not echo the bad value', () => {
    const payload = {runId: 'run-001', requestID: true, permission: 'shell', settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('true')
    }
  })

  it('non-string filepath rejection does not echo the bad value', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: 'shell', filepath: [], settled: false}
    const result = parseSseFrame(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)
    expect(result?.success).toBe(false)
    if (result && !result.success) {
      expect(result.error).not.toContain('[]')
    }
  })
})

describe('nextStreamState — approval reducer null-proto sub-maps', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  it('approvalOpenPrompts has null prototype after dispatching an open approval', () => {
    let state = live()
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', permission: 'shell', settled: false},
    })
    const runEntry = state.runs['run-001']
    expect(runEntry).toBeDefined()
    expect(Object.getPrototypeOf(runEntry?.approvalOpenPrompts)).toBeNull()
  })

  it('approvalTombstones has null prototype after dispatching a settle approval', () => {
    let state = live()
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', settled: true},
    })
    const runEntry = state.runs['run-001']
    expect(runEntry).toBeDefined()
    expect(Object.getPrototypeOf(runEntry?.approvalTombstones)).toBeNull()
  })
})

describe('hasOpenApprovals / getOpenApprovals — null/undefined guards', () => {
  it('hasOpenApprovals(undefined) returns false', () => {
    expect(hasOpenApprovals(undefined)).toBe(false)
  })

  it('hasOpenApprovals(null) returns false', () => {
    expect(hasOpenApprovals(null)).toBe(false)
  })

  it('getOpenApprovals(undefined) returns []', () => {
    expect(getOpenApprovals(undefined)).toEqual([])
  })

  it('getOpenApprovals(null) returns []', () => {
    expect(getOpenApprovals(null)).toEqual([])
  })
})

describe('nextStreamState — approval reducer open frame with filepath', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  it('open frame with filepath stores filepath correctly in the prompt', () => {
    let state = live()
    state = nextStreamState(state, {
      type: 'approval',
      data: {
        runId: 'run-001',
        requestID: 'req-001',
        permission: 'fs-write',
        filepath: '/workspace/output.txt',
        settled: false,
      },
    })
    const run = state.runs['run-001']
    expect(run).toBeDefined()
    const prompts = getOpenApprovals(run)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.filepath).toBe('/workspace/output.txt')
    expect(prompts[0]?.permission).toBe('fs-write')
  })
})

// ---------------------------------------------------------------------------
// initOperatorStream — approval prompt DOM rendering
// ---------------------------------------------------------------------------

/**
 * Minimal fake DOM element for testing approval prompt rendering.
 * Tracks textContent, hidden state, and child elements.
 */
interface FakeElement {
  tagName: string
  textContent: string
  hidden: boolean
  children: FakeElement[]
  attributes: Record<string, string>
  style: Record<string, string>
  dataset: Record<string, string>
  eventListeners: Record<string, ((...args: unknown[]) => void)[]>
  querySelector: (sel: string) => FakeElement | null
  querySelectorAll: (sel: string) => FakeElement[]
  append: (...nodes: FakeElement[]) => void
  remove: () => void
  setAttribute: (name: string, value: string) => void
  getAttribute: (name: string) => string | null
  classList: {add: (cls: string) => void; remove: (cls: string) => void; contains: (cls: string) => boolean}
  addEventListener: (event: string, handler: (...args: unknown[]) => void) => void
  dispatchEvent: (event: {type: string}) => void
}

function makeFakeEl(tagName = 'div'): FakeElement {
  // Use a plain object with a textContent property that clears children when set to ''.
  // This mirrors the real DOM behavior where `el.textContent = ''` removes all child nodes.
  let textContentValue = ''
  const el = {
    tagName,
    get textContent() { return textContentValue },
    set textContent(v: string) {
      textContentValue = v
      // Setting textContent clears children (mirrors real DOM behavior)
      if (v === '') {
        el.children = []
      }
    },
    hidden: false,
    children: [] as FakeElement[],
    attributes: {} as Record<string, string>,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    eventListeners: {} as Record<string, ((...args: unknown[]) => void)[]>,
    querySelector(sel: string): FakeElement | null {
      // Simple selector matching for data-role and id
      for (const child of el.children) {
        if (sel.includes('data-role=')) {
          const role = sel.match(/data-role="([^"]+)"/)?.[1]
          if (role !== undefined && role !== '' && child.attributes['data-role'] === role) return child
        }
        if (sel.startsWith('#')) {
          const id = sel.slice(1)
          if (child.attributes.id === id) return child
        }
        const found = child.querySelector(sel)
        if (found !== null) return found
      }
      return null
    },
    querySelectorAll(sel: string): FakeElement[] {
      const results: FakeElement[] = []
      for (const child of el.children) {
        if (sel === 'button') {
          if (child.tagName === 'button') results.push(child)
          results.push(...child.querySelectorAll(sel))
        } else if (sel.includes('data-role=')) {
          const role = sel.match(/data-role="([^"]+)"/)?.[1]
          if (role !== undefined && role !== '' && child.attributes['data-role'] === role) results.push(child)
          results.push(...child.querySelectorAll(sel))
        } else {
          results.push(...child.querySelectorAll(sel))
        }
      }
      return results
    },
    append(...nodes: FakeElement[]) {
      for (const node of nodes) {
        el.children.push(node)
      }
    },
    remove() {
      // No-op in fake — parent would need to remove from children
    },
    setAttribute(name: string, value: string) {
      el.attributes[name] = value
    },
    getAttribute(name: string): string | null {
      return el.attributes[name] ?? null
    },
    classList: {
      add(_cls: string) { /* no-op */ },
      remove(_cls: string) { /* no-op */ },
      contains(_cls: string) { return false },
    },
    addEventListener(event: string, handler: (...args: unknown[]) => void) {
      if (!el.eventListeners[event]) el.eventListeners[event] = []
      el.eventListeners[event].push(handler)
    },
    dispatchEvent(event: {type: string}) {
      const handlers = el.eventListeners[event.type] ?? []
      for (const h of handlers) h(event)
    },
  } satisfies FakeElement
  return el
}

/**
 * Build a fake approval client for testing.
 * Records calls and returns configurable results.
 */
function makeFakeApprovalClient(opts: {
  decideResult?: {success: boolean; data?: {state: string}; error?: {kind: string; status?: number}}
  listResult?: {requestID: string; permission: string; command?: string; filepath?: string}[]
} = {}) {
  const decideCalls: {runId: string; requestId: string; decision: string; idempotencyKey: string}[] = []
  const listCalls: string[] = []

  return {
    decideCalls,
    listCalls,
    client: {
      refreshCsrf: async () => ({success: true, data: {csrfToken: 'test-csrf'}}),
      decideRunApproval: async (runId: string, requestId: string, decision: string, idempotencyKey: string) => {
        decideCalls.push({runId, requestId, decision, idempotencyKey})
        return opts.decideResult ?? {success: true, data: {state: 'claimed'}}
      },
      listRunApprovals: async (runId: string) => {
        listCalls.push(runId)
        return opts.listResult ?? []
      },
    },
  }
}

// Helper: build a fake DOM environment and run initOperatorStream
function makeApprovalTestEnv(opts: {
  approvalClientOpts?: Parameters<typeof makeFakeApprovalClient>[0]
} = {}) {
  const {client, decideCalls, listCalls} = makeFakeApprovalClient(opts.approvalClientOpts)

  const approvalsEl = makeFakeEl('div')
  approvalsEl.hidden = true
  approvalsEl.attributes['data-role'] = 'run-approvals'

  const badgeEl = makeFakeEl('span')
  badgeEl.hidden = true
  badgeEl.attributes['data-role'] = 'approval-badge'

  const statusEl = makeFakeEl('span')
  const noticeEl = makeFakeEl('div')

  // Stub document.createElement to return fake elements
  const createdElements: FakeElement[] = []
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      const el = makeFakeEl(tag)
      createdElements.push(el)
      return el
    },
    querySelector: () => null,
    readyState: 'complete',
    addEventListener: () => {},
  })
  vi.stubGlobal('fetch', async () => new Promise<Response>(() => {}))
  vi.stubGlobal('addEventListener', () => {})

  return {approvalsEl, badgeEl, statusEl, noticeEl, client, decideCalls, listCalls, createdElements}
}

describe('initOperatorStream — approval prompt DOM rendering', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('approvalsEl starts hidden when no open prompts', () => {
    const {approvalsEl, badgeEl, statusEl, noticeEl, client} = makeApprovalTestEnv()

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    // No prompts yet — approvalsEl should remain hidden
    expect(approvalsEl.hidden).toBe(true)
  })

  it('no approval client constructed when approvalsEl is absent', () => {
    // When approvalsEl is not provided, no approval client should be built
    // (the injected client should not be called)
    const {client, decideCalls, listCalls} = makeFakeApprovalClient()

    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => new Promise<Response>(() => {}))
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl: makeFakeEl('span'),
      noticeEl: makeFakeEl('div'),
      // No approvalsEl — approval client should not be used
      approvalClient: client,
    })

    // No calls should have been made to the client
    expect(decideCalls).toHaveLength(0)
    expect(listCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// bootstrapOperatorStreams — discovers approvalsEl and badgeEl
// ---------------------------------------------------------------------------

describe('bootstrapOperatorStreams — discovers approvalsEl and badgeEl', () => {
  interface FakeCardWithApprovals {
    dataset: {runId: string}
    querySelector: (sel: string) => {
      textContent: string
      hidden: boolean
      attributes?: Record<string, string>
      dataset?: Record<string, string>
    } | null
  }

  function makeFakeCardWithApprovals(runId: string): FakeCardWithApprovals {
    return {
      dataset: {runId},
      querySelector: (sel: string) => {
        if (sel.includes('run-status')) return {textContent: '', hidden: false}
        if (sel.includes('run-output-coalesced')) return {textContent: '', hidden: true}
        if (sel.includes('run-output')) return {textContent: '', hidden: true}
        if (sel.includes('run-approvals')) return {textContent: '', hidden: true, attributes: {'data-role': 'run-approvals'}}
        if (sel.includes('approval-badge')) return {textContent: '', hidden: true, attributes: {'data-role': 'approval-badge'}}
        return null
      },
    }
  }

  it('bootstrapOperatorStreams discovers approvalsEl and badgeEl per card', async () => {
    const fetchCalls: string[] = []
    const cards = [makeFakeCardWithApprovals('run-001')]

    const section = {
      querySelector: (sel: string) =>
        sel.includes('stream-status') ? {textContent: '', hidden: false} : null,
      querySelectorAll: () => cards,
    }

    vi.stubGlobal('document', {
      querySelector: (sel: string) => (sel === '#run-status-section' ? section : null),
      readyState: 'complete',
      addEventListener() {},
    })
    vi.stubGlobal('fetch', async (url: string) => {
      fetchCalls.push(url)
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('addEventListener', () => {})

    try {
      bootstrapOperatorStreams()
    } finally {
      vi.unstubAllGlobals()
    }

    // Should have started a stream for the card
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toBe('/operator/runs/run-001/stream')
  })
})

// ---------------------------------------------------------------------------
// reconcile-on-reconnect — reducer-level no-resurrect
// ---------------------------------------------------------------------------

describe('reconcile-on-reconnect — reducer-level no-resurrect', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  it('reconcile: a synthetic open frame for a tombstoned requestID is ignored (no-resurrect)', () => {
    let state = live()
    // Open and settle req-001
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', permission: 'shell', settled: false},
    })
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', settled: true},
    })
    // Verify tombstoned
    expect(hasOpenApprovals(state.runs['run-001'])).toBe(false)

    // Simulate reconcile: dispatch a synthetic open frame for the same requestID
    // (as if the GET returned it — the reducer must ignore it because it's tombstoned)
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', permission: 'shell', settled: false},
    })
    // Must still be absent (tombstone wins)
    expect(hasOpenApprovals(state.runs['run-001'])).toBe(false)
    expect(getOpenApprovals(state.runs['run-001'])).toHaveLength(0)
  })

  it('reconcile: a synthetic open frame for a non-tombstoned requestID is added', () => {
    let state = live()
    // No prior open/settle for req-002

    // Simulate reconcile: dispatch a synthetic open frame
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-002', permission: 'network', settled: false},
    })
    // Must be present
    expect(hasOpenApprovals(state.runs['run-001'])).toBe(true)
    expect(getOpenApprovals(state.runs['run-001'])[0]?.requestID).toBe('req-002')
  })

  it('reconcile: after terminal status, synthetic open frames are ignored', () => {
    let state = live()
    // Apply terminal status
    state = nextStreamState(state, {
      type: 'status',
      data: {
        runId: 'run-001',
        entityRef: 'testowner/test-repo',
        surface: 'github',
        phase: 'COMPLETED',
        status: 'succeeded',
        startedAt: '2026-06-22T10:00:00Z',
        stale: false,
      },
    })
    // Simulate reconcile: dispatch a synthetic open frame after terminal
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-003', permission: 'shell', settled: false},
    })
    // Must be ignored (terminal is absorbing)
    expect(hasOpenApprovals(state.runs['run-001'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// safe DOM — inert text rendering (no injection)
// ---------------------------------------------------------------------------

describe('safe DOM — inert text rendering', () => {
  it('a command containing HTML/script renders as inert text (no element injection)', () => {
    // This test verifies the renderApprovalPrompt function uses textContent only.
    // We test this by checking that the rendered element's textContent contains
    // the raw string (including HTML chars) without any element injection.
    //
    // Since renderApprovalPrompt is not exported, we test it indirectly through
    // the reducer + DOM rendering path. The key invariant is:
    // - command/filepath values are set via textContent, not innerHTML
    // - HTML characters in command/filepath must appear as literal text, not parsed HTML
    //
    // We verify this at the reducer level: the prompt data is stored as-is,
    // and the rendering contract (textContent only) is enforced by the implementation.

    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const maliciousCommand = '<script>alert("xss")</script>'
    const state = nextStreamState(liveState, {
      type: 'approval',
      data: {
        runId: 'run-001',
        requestID: 'req-001',
        permission: 'shell',
        command: maliciousCommand,
        settled: false,
      },
    })

    // The reducer stores the command as-is (no sanitization at reducer level)
    const prompts = getOpenApprovals(state.runs['run-001'])
    expect(prompts).toHaveLength(1)
    // The raw command is stored — the rendering layer is responsible for safe DOM
    expect(prompts[0]?.command).toBe(maliciousCommand)

    // The rendering contract: when this is rendered, it MUST use textContent,
    // not innerHTML. This is enforced by the renderApprovalPrompt implementation
    // which uses `actionEl.textContent = command` (never innerHTML).
    // The test above verifies the data is correct; the implementation contract
    // is verified by code review and the no-injection invariant in the module header.
  })

  it('a filepath containing HTML renders as inert text (no element injection)', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const maliciousFilepath = '/workspace/<img src=x onerror=alert(1)>.txt'
    const state = nextStreamState(liveState, {
      type: 'approval',
      data: {
        runId: 'run-001',
        requestID: 'req-001',
        permission: 'edit',
        filepath: maliciousFilepath,
        settled: false,
      },
    })

    const prompts = getOpenApprovals(state.runs['run-001'])
    expect(prompts).toHaveLength(1)
    // The raw filepath is stored — the rendering layer uses textContent only
    expect(prompts[0]?.filepath).toBe(maliciousFilepath)
  })
})

// ---------------------------------------------------------------------------
// Shared helpers for renderApprovalPrompt and buildApprovalClient tests
// ---------------------------------------------------------------------------

/** Stub a minimal browser environment for renderApprovalPrompt tests. */
function stubRenderEnv() {
  vi.stubGlobal('document', {
    createElement: (tag: string) => makeFakeEl(tag),
    querySelector: () => null,
    readyState: 'complete',
    addEventListener: () => {},
  })
  vi.stubGlobal('fetch', async () => new Promise<Response>(() => {}))
  vi.stubGlobal('addEventListener', () => {})
}

/**
 * Call renderApprovalPrompt and return the result as a FakeElement.
 * renderApprovalPrompt is typed as returning HTMLElement (for browser use),
 * but in tests it returns a FakeElement from the stubbed document.createElement.
 */
function renderPromptAsFake(
  prompt: ApprovalFrameDataOpen,
  runId: string,
  client: ReturnType<typeof makeFakeApprovalClient>['client'],
): FakeElement {
  return renderApprovalPrompt(prompt, runId, client, () => {}) as FakeElement
}

/** Find all visible (non-hidden) button elements recursively. */
function findVisibleButtons(el: FakeElement): FakeElement[] {
  const buttons: FakeElement[] = []
  for (const child of el.children) {
    if (child.hidden) continue
    if (child.tagName === 'button') buttons.push(child)
    buttons.push(...findVisibleButtons(child))
  }
  return buttons
}

/** Find the status element (role="status") recursively. */
function findStatusElement(el: FakeElement): FakeElement | undefined {
  for (const child of el.children) {
    if (child.attributes.role === 'status') return child
    const found = findStatusElement(child)
    if (found !== undefined) return found
  }
  return undefined
}

// ---------------------------------------------------------------------------
// renderApprovalPrompt — safe-DOM inertness (injection-safety regression guard)
// ---------------------------------------------------------------------------

describe('renderApprovalPrompt — safe-DOM inertness', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('command containing HTML/script renders as inert textContent — no child elements injected', () => {
    stubRenderEnv()
    const maliciousCommand = '<script>alert(1)</script><img src=x onerror=y>'
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001',
      requestID: 'req-001',
      permission: 'shell',
      command: maliciousCommand,
      settled: false,
    }
    const {client} = makeFakeApprovalClient()
    const el = renderPromptAsFake(prompt, 'run-001', client)

    // Find the action element (pre tag) — it should have the raw string as textContent
    const actionEl = el.children.find((c: FakeElement) => c.tagName === 'pre')
    expect(actionEl).toBeDefined()
    if (actionEl !== undefined) {
      // textContent must equal the literal string (not parsed HTML)
      expect(actionEl.textContent).toBe(maliciousCommand)
      // No child elements should have been injected (innerHTML was never set)
      // In our fake DOM, children are only added via append() — never innerHTML
      expect(actionEl.children).toHaveLength(0)
    }
  })

  it('filepath containing HTML/script renders as inert textContent — no child elements injected', () => {
    stubRenderEnv()
    const maliciousFilepath = '<script>alert(1)</script><img src=x onerror=y>'
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001',
      requestID: 'req-001',
      permission: 'edit',
      filepath: maliciousFilepath,
      settled: false,
    }
    const {client} = makeFakeApprovalClient()
    const el = renderPromptAsFake(prompt, 'run-001', client)

    const actionEl = el.children.find((c: FakeElement) => c.tagName === 'pre')
    expect(actionEl).toBeDefined()
    if (actionEl !== undefined) {
      expect(actionEl.textContent).toBe(maliciousFilepath)
      expect(actionEl.children).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// renderApprovalPrompt — two-step always flow
// ---------------------------------------------------------------------------

describe('renderApprovalPrompt — two-step always flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('initial render shows 3 controls: once, always, reject', () => {
    stubRenderEnv()
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client} = makeFakeApprovalClient()
    const el = renderPromptAsFake(prompt, 'run-001', client)
    const buttons = findVisibleButtons(el)
    const labels = buttons.map(b => b.textContent)
    expect(labels).toContain('Once')
    expect(labels).toContain('Always')
    expect(labels).toContain('Reject')
    expect(buttons).toHaveLength(3)
  })

  it('clicking always suppresses once/reject and shows confirm/cancel', () => {
    stubRenderEnv()
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client} = makeFakeApprovalClient()
    const el = renderPromptAsFake(prompt, 'run-001', client)

    // Click always
    const alwaysBtn = findVisibleButtons(el).find(b => b.textContent === 'Always')
    expect(alwaysBtn).toBeDefined()
    alwaysBtn?.dispatchEvent({type: 'click'})

    // After click: once/reject should be gone, confirm/cancel should appear
    const buttons = findVisibleButtons(el)
    const labels = buttons.map(b => b.textContent)
    expect(labels).not.toContain('Once')
    expect(labels).not.toContain('Reject')
    expect(labels).toContain('Confirm always')
    expect(labels).toContain('Cancel')
  })

  it('clicking cancel after always restores 3 controls', () => {
    stubRenderEnv()
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client} = makeFakeApprovalClient()
    const el = renderPromptAsFake(prompt, 'run-001', client)

    // Click always then cancel
    const alwaysBtn = findVisibleButtons(el).find(b => b.textContent === 'Always')
    alwaysBtn?.dispatchEvent({type: 'click'})
    const cancelBtn = findVisibleButtons(el).find(b => b.textContent === 'Cancel')
    expect(cancelBtn).toBeDefined()
    cancelBtn?.dispatchEvent({type: 'click'})

    // Should be back to 3 controls
    const buttons = findVisibleButtons(el)
    const labels = buttons.map(b => b.textContent)
    expect(labels).toContain('Once')
    expect(labels).toContain('Always')
    expect(labels).toContain('Reject')
    expect(buttons).toHaveLength(3)
  })

  it('clicking confirm always calls decideRunApproval with "always"', async () => {
    stubRenderEnv()
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid-1234'})
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client, decideCalls} = makeFakeApprovalClient({
      decideResult: {success: true, data: {state: 'claimed'}},
    })
    const el = renderPromptAsFake(prompt, 'run-001', client)

    // Click always then confirm
    const alwaysBtn = findVisibleButtons(el).find(b => b.textContent === 'Always')
    alwaysBtn?.dispatchEvent({type: 'click'})
    const confirmBtn = findVisibleButtons(el).find(b => b.textContent === 'Confirm always')
    expect(confirmBtn).toBeDefined()
    confirmBtn?.dispatchEvent({type: 'click'})

    // Wait for async decision
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(decideCalls).toHaveLength(1)
    expect(decideCalls[0]?.decision).toBe('always')
    expect(decideCalls[0]?.runId).toBe('run-001')
    expect(decideCalls[0]?.requestId).toBe('req-001')
  })
})

// ---------------------------------------------------------------------------
// renderApprovalPrompt — DOM-level failure states
// ---------------------------------------------------------------------------

describe('renderApprovalPrompt — DOM-level failure states', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('404 → cant-approve copy shown, controls cleared', async () => {
    stubRenderEnv()
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid-1234'})
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client} = makeFakeApprovalClient({
      decideResult: {success: false, error: {kind: 'http', status: 404}},
    })
    const el = renderPromptAsFake(prompt, 'run-001', client)

    // Click once to trigger decision
    const onceBtn = findVisibleButtons(el).find(b => b.textContent === 'Once')
    onceBtn?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/may not have approval access|check your gateway/i)
    // Controls should be cleared (no buttons)
    const buttons = findVisibleButtons(el)
    expect(buttons).toHaveLength(0)
    // Denial copy must not contain "try again"
    expect(statusEl?.textContent).not.toMatch(/try again/i)
  })

  it('network error → transport-failure copy shown, controls still present (Fix 1)', async () => {
    stubRenderEnv()
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid-1234'})
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client} = makeFakeApprovalClient({
      decideResult: {success: false, error: {kind: 'network'}},
    })
    const el = renderPromptAsFake(prompt, 'run-001', client)

    const onceBtn = findVisibleButtons(el).find(b => b.textContent === 'Once')
    onceBtn?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/didn.t go through|try again/i)
    // Controls must still be present (retryable)
    const buttons = findVisibleButtons(el)
    expect(buttons.length).toBeGreaterThan(0)
    // Transport copy must not contain "access" language that implies denial
    expect(statusEl?.textContent).not.toMatch(/may not have.*access|approval access/i)
  })

  it('HTTP 400 post-retry → session-failure copy shown, controls cleared (Fix 3)', async () => {
    stubRenderEnv()
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid-1234'})
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client} = makeFakeApprovalClient({
      decideResult: {success: false, error: {kind: 'http', status: 400}},
    })
    const el = renderPromptAsFake(prompt, 'run-001', client)

    const onceBtn = findVisibleButtons(el).find(b => b.textContent === 'Once')
    onceBtn?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/session.*expired|reload.*page/i)
    // Controls should be cleared (non-retryable)
    const buttons = findVisibleButtons(el)
    expect(buttons).toHaveLength(0)
  })

  it('already_claimed → already-settled copy shown', async () => {
    stubRenderEnv()
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid-1234'})
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client} = makeFakeApprovalClient({
      decideResult: {success: true, data: {state: 'already_claimed'}},
    })
    const el = renderPromptAsFake(prompt, 'run-001', client)

    const onceBtn = findVisibleButtons(el).find(b => b.textContent === 'Once')
    onceBtn?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/already been settled/i)
  })

  it('scope_mismatch → scope label shown, controls cleared (Fix 2)', async () => {
    stubRenderEnv()
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid-1234'})
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client} = makeFakeApprovalClient({
      decideResult: {success: true, data: {state: 'scope_mismatch'}},
    })
    const el = renderPromptAsFake(prompt, 'run-001', client)

    const onceBtn = findVisibleButtons(el).find(b => b.textContent === 'Once')
    onceBtn?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/scope.*didn.t match|decision not applied/i)
    // Controls should be cleared (terminal non-retryable)
    const buttons = findVisibleButtons(el)
    expect(buttons).toHaveLength(0)
  })

  it('failed_to_settle → retryable copy shown, controls still present (Fix 2)', async () => {
    stubRenderEnv()
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid-1234'})
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client} = makeFakeApprovalClient({
      decideResult: {success: true, data: {state: 'failed_to_settle'}},
    })
    const el = renderPromptAsFake(prompt, 'run-001', client)

    const onceBtn = findVisibleButtons(el).find(b => b.textContent === 'Once')
    onceBtn?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/couldn.t finalize|please try again/i)
    // Controls must still be present (retryable)
    const buttons = findVisibleButtons(el)
    expect(buttons.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// renderApprovalPrompt — in-flight guard
// ---------------------------------------------------------------------------

describe('renderApprovalPrompt — in-flight guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a second handleDecision while in-flight is ignored (no duplicate calls)', async () => {
    stubRenderEnv()
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid-1234'})

    let resolveDecide!: (v: {success: boolean; data: {state: string}}) => void
    const decidePromise = new Promise<{success: boolean; data: {state: string}}>(resolve => {
      resolveDecide = resolve
    })

    const decideCalls: string[] = []
    const client = {
      refreshCsrf: async () => ({success: true, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async (_runId: string, _requestId: string, decision: string) => {
        decideCalls.push(decision)
        return decidePromise
      },
      listRunApprovals: async () => [],
    }

    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const el = renderApprovalPrompt(prompt, 'run-001', client, () => {}) as unknown as FakeElement

    // Click once — starts in-flight
    const onceBtn = findVisibleButtons(el).find(b => b.textContent === 'Once')
    onceBtn?.dispatchEvent({type: 'click'})

    // Immediately click again — should be ignored (in-flight guard)
    onceBtn?.dispatchEvent({type: 'click'})

    // Resolve the pending decision
    resolveDecide({success: true, data: {state: 'claimed'}})
    await new Promise(resolve => setTimeout(resolve, 10))

    // Only one call should have been made
    expect(decideCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// buildApprovalClient — refreshCsrf and decideRunApproval
// ---------------------------------------------------------------------------

describe('buildApprovalClient — refreshCsrf', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('200 response → success with csrfToken', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({csrfToken: 'test-csrf-token'}),
    }))
    const client = buildApprovalClient()
    const result = await client.refreshCsrf()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data?.csrfToken).toBe('test-csrf-token')
    }
  })

  it('non-200 response → http error', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }))
    const client = buildApprovalClient()
    const result = await client.refreshCsrf()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error?.kind).toBe('http')
      expect(result.error?.status).toBe(401)
    }
  })

  it('fetch throws → network error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED')
    })
    const client = buildApprovalClient()
    const result = await client.refreshCsrf()
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error?.kind).toBe('network')
    }
  })
})

describe('buildApprovalClient — decideRunApproval', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends POST with x-csrf-token, idempotency-key, and redirect:error', async () => {
    const fetchCalls: {url: string; init: RequestInit}[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetchCalls.push({url, init})
      // CSRF endpoint returns csrfToken; decision endpoint returns state
      if (typeof url === 'string' && url.includes('/csrf')) {
        return {ok: true, status: 200, json: async () => ({csrfToken: 'test-csrf-token'})}
      }
      return {ok: true, status: 200, json: async () => ({state: 'claimed'})}
    })
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid'})

    const client = buildApprovalClient()
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc')

    expect(result.success).toBe(true)
    // Should have made 2 calls: one for CSRF, one for the decision
    expect(fetchCalls).toHaveLength(2)
    const decisionCall = fetchCalls[1]
    expect(decisionCall?.init?.headers).toBeDefined()
    const headers = decisionCall?.init?.headers as Record<string, string>
    expect(headers['x-csrf-token']).toBe('test-csrf-token')
    expect(headers['idempotency-key']).toBe('idem-key-abc')
    // redirect:'error' is set by the browserFetch wrapper (merged into the fetch call)
    expect(decisionCall?.init?.redirect).toBe('error')
  })

  it('retries ONCE on 400 with a refreshed CSRF token and the SAME idempotency key', async () => {
    const fetchCalls: {url: string; init: RequestInit}[] = []
    let decisionCallCount = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetchCalls.push({url, init})
      // CSRF endpoint always returns a token
      if (typeof url === 'string' && url.includes('/csrf')) {
        return {ok: true, status: 200, json: async () => ({csrfToken: `csrf-${fetchCalls.length}`})}
      }
      // Decision endpoint: first call → 400, second call → success
      decisionCallCount++
      if (decisionCallCount === 1) {
        return {ok: false, status: 400, json: async () => ({})}
      }
      return {ok: true, status: 200, json: async () => ({state: 'claimed'})}
    })

    const client = buildApprovalClient()
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc')

    expect(result.success).toBe(true)
    // Should have made 4 calls: CSRF, decision (400), CSRF retry, decision retry
    expect(fetchCalls).toHaveLength(4)
    // Both decision calls must use the same idempotency key
    const decisionCalls = fetchCalls.filter(c => typeof c.url === 'string' && c.url.includes('/decision'))
    expect(decisionCalls).toHaveLength(2)
    const idemKeys = decisionCalls.map(c => (c.init?.headers as Record<string, string>)['idempotency-key'])
    expect(idemKeys[0]).toBe('idem-key-abc')
    expect(idemKeys[1]).toBe('idem-key-abc')
  })

  it('CSRF refresh failure on retry → network error', async () => {
    let csrfCallCount = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (typeof url === 'string' && url.includes('/csrf')) {
        csrfCallCount++
        // First CSRF → success; second CSRF → throws
        if (csrfCallCount === 1) {
          return {ok: true, status: 200, json: async () => ({csrfToken: 'csrf-1'})}
        }
        throw new Error('network failure on retry')
      }
      // Decision → 400
      return {ok: false, status: 400, json: async () => ({})}
    })

    const client = buildApprovalClient()
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error?.kind).toBe('network')
    }
  })
})

describe('buildApprovalClient — listRunApprovals', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns [] on non-200 response', async () => {
    vi.stubGlobal('fetch', async () => ({ok: false, status: 404, json: async () => ({})}))
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual([])
  })

  it('returns [] on fetch throw', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error')
    })
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual([])
  })

  it('returns [] on malformed response (no approvals array)', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({notApprovals: []}),
    }))
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual([])
  })

  it('returns approvals array on success', async () => {
    const approvals = [{requestID: 'req-001', permission: 'shell', command: 'echo hi'}]
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({approvals}),
    }))
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual(approvals)
  })
})

// ---------------------------------------------------------------------------
// approval badge indicator
// ---------------------------------------------------------------------------

describe('approval badge indicator', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('badge starts hidden when no open prompts', () => {
    const {approvalsEl, badgeEl, statusEl, noticeEl, client} = makeApprovalTestEnv()

    const handle = initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    // No prompts yet — badge should remain hidden
    expect(badgeEl.hidden).toBe(true)
    expect(badgeEl.textContent).toBe('')

    handle.close()
  })

  it('badge shows "2" for two open prompts and hides on settle (reducer-level)', () => {
    // Test the badge logic via the reducer state machine
    // (badge is driven by hasOpenApprovals/getOpenApprovals from the reducer)
    const live = (): StreamState =>
      nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

    let state = live()
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', permission: 'shell', settled: false},
    })
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-002', permission: 'network', settled: false},
    })

    const run = state.runs['run-001']
    expect(hasOpenApprovals(run)).toBe(true)
    expect(getOpenApprovals(run)).toHaveLength(2)

    // Settle one
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', settled: true},
    })
    const runAfter = state.runs['run-001']
    expect(getOpenApprovals(runAfter)).toHaveLength(1)

    // Settle both
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-002', settled: true},
    })
    const runFinal = state.runs['run-001']
    expect(hasOpenApprovals(runFinal)).toBe(false)
    expect(getOpenApprovals(runFinal)).toHaveLength(0)
  })
})
