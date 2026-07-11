/**
 * Tests for the pure core of the operator run stream client.
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
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  bootstrapOperatorStreams,
  buildApprovalClient,
  buildCancelClient,
  CANCEL_RETRY_MAX_ATTEMPTS,
  FIRST_FRAME_TIMEOUT_MS,
  GATEWAY_PENDING_APPROVALS_CAP,
  getOpenApprovals,
  hasOpenApprovals,
  initOperatorStream,
  MAX_APPROVAL_TOMBSTONES,
  MAX_OPEN_APPROVALS,
  MAX_OUTPUT_TEXT_CHARS,
  MAX_SSE_BUFFER_BYTES,
  nextStreamState,
  parseSseFrame,
  PHASE_TO_WEB_STATUS,
  PINNED_CONTRACT_VERSION,
  renderApprovalPrompt,
  renderCancelControl,
  resetBootstrapState,
  RETRY_BASE_MS,
  RETRY_FACTOR,
  RETRY_MAX_COUNT,
  toSafeRunView,
} from '../public/operator-stream.js'
import {OPERATOR_CONTRACT_VERSION, PHASE_TO_WEB_STATUS as VENDORED_PHASE_TO_WEB_STATUS} from '../src/gateway/operator-contract/index.ts'
import {FIXTURE_RUN_ID_FOR_TESTS, FIXTURE_SCENARIO_NAMES, serializeScenarioToSse} from '../src/gateway/operator-fixture-sse.ts'

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

describe('parseSseFrame — pure parser', () => {
  it('parses a ready frame', () => {
    const text = `event: ready\ndata: {"contractVersion":"1.5.0"}\n\n`
    const result = parseSseFrame(text)
    expect(result).not.toBeNull()
    expect(result?.success).toBe(true)
    if (result !== null && result.success) {
      expect(result.frame.type).toBe('ready')
      if (result.frame.type === 'ready') {
        expect(result.frame.data.contractVersion).toBe('1.5.0')
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

  it('parses a failed status frame with each known failureKind', () => {
    const kinds = [
      'inactivity-timeout',
      'max-duration-timeout',
      'stream-ended',
      'workspace-unreachable',
      'session-error',
      'unknown',
    ]
    for (const failureKind of kinds) {
      const payload = {...ACTIVE_STATUS, status: 'failed', phase: 'FAILED', failureKind}
      const text = `event: status\ndata: ${JSON.stringify(payload)}\n\n`
      const result = parseSseFrame(text)
      expect(result?.success).toBe(true)
      if (result?.success && result.frame.type === 'status') {
        expect(result.frame.data.failureKind).toBe(failureKind)
      }
    }
  })

  it('failureKind is absent on a status frame when omitted from input', () => {
    const text = `event: status\ndata: ${JSON.stringify(ACTIVE_STATUS)}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result?.success && result.frame.type === 'status') {
      expect('failureKind' in result.frame.data).toBe(false)
    }
  })

  it('normalizes an unknown failureKind on a status frame to absent — does not reject the frame', () => {
    const payload = {...ACTIVE_STATUS, status: 'failed', phase: 'FAILED', failureKind: 'some-future-fixture-reason'}
    const text = `event: status\ndata: ${JSON.stringify(payload)}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    if (result?.success && result.frame.type === 'status') {
      expect('failureKind' in result.frame.data).toBe(false)
    }
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
    const text = 'data: {"contractVersion":"1.5.0"}\n\n'
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

describe('nextStreamState — output accumulation', () => {
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

describe('nextStreamState — failure reason label', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  it('a failed status with a known failureKind stores a safe reasonLabel for the run', () => {
    const state = nextStreamState(live(), {
      type: 'status',
      data: {...ACTIVE_STATUS, status: 'failed', phase: 'FAILED', failureKind: 'inactivity-timeout'},
    })
    expect(state.runs['run-abc']?.reasonLabel).toBe('No recent activity')
  })

  it('an unknown failureKind on a failed status leaves reasonLabel absent — generic Failed fallback remains available', () => {
    const state = nextStreamState(live(), {
      type: 'status',
      data: {...ACTIVE_STATUS, status: 'failed', phase: 'FAILED'},
    })
    expect(state.runs['run-abc']?.reasonLabel).toBeUndefined()
    expect(state.runs['run-abc']?.status).toBe('failed')
  })

  it('a missing failureKind on a failed status does not throw and leaves reasonLabel absent', () => {
    expect(() =>
      nextStreamState(live(), {
        type: 'status',
        data: {...ACTIVE_STATUS, status: 'failed', phase: 'FAILED'},
      }),
    ).not.toThrow()
  })

  it('a non-failed status with a failureKind ignores the reason — no reasonLabel stored', () => {
    const state = nextStreamState(live(), {
      type: 'status',
      data: {...ACTIVE_STATUS, failureKind: 'inactivity-timeout'},
    })
    expect(state.runs['run-abc']?.reasonLabel).toBeUndefined()
  })

  it('a late non-terminal status after a terminal failure does not clear the stored reasonLabel', () => {
    const withFailure = nextStreamState(live(), {
      type: 'status',
      data: {...ACTIVE_STATUS, status: 'failed', phase: 'FAILED', failureKind: 'session-error'},
    })
    expect(withFailure.runs['run-abc']?.reasonLabel).toBe('Session error')

    // A late, non-terminal frame for the same run arrives after the terminal failure.
    const withLateFrame = nextStreamState(withFailure, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    expect(withLateFrame.runs['run-abc']?.reasonLabel).toBe('Session error')
  })

  it('terminal failed status with a reason preserves already-rendered output text', () => {
    const withOutput = nextStreamState(live(), {
      type: 'output',
      data: {runId: 'run-abc', text: 'partial answer', final: false, seq: 0},
    })
    const withFailure = nextStreamState(withOutput, {
      type: 'status',
      data: {...ACTIVE_STATUS, status: 'failed', phase: 'FAILED', failureKind: 'stream-ended'},
    })
    expect(withFailure.runs['run-abc']?.outputText).toBe('partial answer')
    expect(withFailure.runs['run-abc']?.reasonLabel).toBe('Stream ended early')
  })
})

describe('nextStreamState — cancel race (terminal-wins)', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  it('a cancel action sets cancelInFlight on the target run entry', () => {
    const withActive = nextStreamState(live(), {type: 'status', data: ACTIVE_STATUS})
    const withCancel = nextStreamState(withActive, {type: 'cancel', data: {runId: 'run-abc'}})
    expect(withCancel.runs['run-abc']?.cancelInFlight).toBe(true)
  })

  it('cancel-completion terminal status clears cancelInFlight and sets terminal', () => {
    const withActive = nextStreamState(live(), {type: 'status', data: ACTIVE_STATUS})
    const withCancel = nextStreamState(withActive, {type: 'cancel', data: {runId: 'run-abc'}})
    const withTerminal = nextStreamState(withCancel, {
      type: 'status',
      data: {...TERMINAL_STATUS, status: 'cancelled', phase: 'CANCELLED'},
    })
    expect(withTerminal.runs['run-abc']?.terminal).toBe(true)
    expect(withTerminal.runs['run-abc']?.cancelInFlight).toBeFalsy()
  })

  it('terminal-wins: a succeeded status frame clears cancelInFlight even mid-cancel', () => {
    const withActive = nextStreamState(live(), {type: 'status', data: ACTIVE_STATUS})
    const withCancel = nextStreamState(withActive, {type: 'cancel', data: {runId: 'run-abc'}})
    const withTerminal = nextStreamState(withCancel, {type: 'status', data: TERMINAL_STATUS})
    expect(withTerminal.runs['run-abc']?.terminal).toBe(true)
    expect(withTerminal.runs['run-abc']?.cancelInFlight).toBeFalsy()
  })

  it('terminal-wins: a failed status frame clears cancelInFlight even mid-cancel', () => {
    const withActive = nextStreamState(live(), {type: 'status', data: ACTIVE_STATUS})
    const withCancel = nextStreamState(withActive, {type: 'cancel', data: {runId: 'run-abc'}})
    const withTerminal = nextStreamState(withCancel, {
      type: 'status',
      data: {...ACTIVE_STATUS, status: 'failed', phase: 'FAILED'},
    })
    expect(withTerminal.runs['run-abc']?.terminal).toBe(true)
    expect(withTerminal.runs['run-abc']?.cancelInFlight).toBeFalsy()
  })

  it('a late non-terminal status frame preserves cancelInFlight', () => {
    const withActive = nextStreamState(live(), {type: 'status', data: ACTIVE_STATUS})
    const withCancel = nextStreamState(withActive, {type: 'cancel', data: {runId: 'run-abc'}})
    const withLateFrame = nextStreamState(withCancel, {type: 'status', data: ACTIVE_STATUS})
    expect(withLateFrame.runs['run-abc']?.cancelInFlight).toBe(true)
    expect(withLateFrame.runs['run-abc']?.terminal).toBe(false)
  })

  it('a cancel action on an already-terminal run does not re-open it and does not set cancelInFlight', () => {
    const withTerminal = nextStreamState(live(), {type: 'status', data: TERMINAL_STATUS})
    const withCancel = nextStreamState(withTerminal, {type: 'cancel', data: {runId: 'run-abc'}})
    expect(withCancel.runs['run-abc']?.terminal).toBe(true)
    expect(withCancel.runs['run-abc']?.cancelInFlight).toBeFalsy()
  })

  it('toSafeRunView does not expose cancelInFlight even when the run entry carries it', () => {
    const withActive = nextStreamState(live(), {type: 'status', data: ACTIVE_STATUS})
    const withCancel = nextStreamState(withActive, {type: 'cancel', data: {runId: 'run-abc'}})
    const entry = withCancel.runs['run-abc']
    expect(entry).toBeDefined()
    const view = toSafeRunView(entry as unknown as Parameters<typeof toSafeRunView>[0])
    expect('cancelInFlight' in view).toBe(false)
    const allowedKeys = new Set(['runId', 'status', 'phase', 'startedAt', 'stale', 'reasonLabel'])
    for (const key of Object.keys(view)) {
      expect(allowedKeys.has(key)).toBe(true)
    }
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
    // max-duration + terminal → no reconnect; override connection to test the reset path
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

describe('toSafeRunView — reasonLabel', () => {
  it('includes reasonLabel when the run entry carries one', () => {
    const view = toSafeRunView({...ACTIVE_STATUS, status: 'failed', reasonLabel: 'No recent activity'})
    expect(view.reasonLabel).toBe('No recent activity')
  })

  it('omits reasonLabel when the run entry has none', () => {
    const view = toSafeRunView(ACTIVE_STATUS)
    expect('reasonLabel' in view).toBe(false)
  })

  it('never exposes reason, failureKind, or a raw code — only the allowed key set', () => {
    const dangerousInput = {
      ...ACTIVE_STATUS,
      status: 'failed',
      failureKind: 'workspace-unreachable',
      reason: 'workspace-unreachable',
      reasonLabel: 'Workspace unreachable',
    }
    const view = toSafeRunView(dangerousInput)
    const allowedKeys = new Set(['runId', 'status', 'phase', 'startedAt', 'stale', 'reasonLabel'])
    for (const key of Object.keys(view)) {
      expect(allowedKeys.has(key)).toBe(true)
    }
    expect('failureKind' in view).toBe(false)
    expect('reason' in view).toBe(false)
  })
})

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

    const runEntry = withStatus.runs['run-abc']
    expect(runEntry).toBeDefined()

    if (runEntry) {
      const view = toSafeRunView(runEntry)
      const serialized = JSON.stringify(view)
      expect(serialized).not.toContain('fro-bot/secret-repo')
      expect(serialized).not.toContain('entityRef')
      expect(serialized).not.toContain('surface')
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

  it('PINNED_CONTRACT_VERSION is 1.6.0', () => {
    expect(PINNED_CONTRACT_VERSION).toBe('1.6.0')
  })
})

describe('contract pin lockstep parity', () => {
  it('browser PINNED_CONTRACT_VERSION equals vendored TypeScript OPERATOR_CONTRACT_VERSION', () => {
    expect(PINNED_CONTRACT_VERSION).toBe(OPERATOR_CONTRACT_VERSION)
  })
})

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

describe('MAX_SSE_BUFFER_BYTES constant', () => {
  it('is a positive number', () => {
    expect(typeof MAX_SSE_BUFFER_BYTES).toBe('number')
    expect(MAX_SSE_BUFFER_BYTES).toBeGreaterThan(0)
  })
})

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

describe('nextStreamState — drift is absorbing', () => {
  it('status before any ready is not applied (connection stays connecting)', () => {
    const state = nextStreamState(INITIAL_STATE, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    expect(state.connection).toBe('connecting')
    expect(Object.keys(state.runs)).toHaveLength(0)
  })

  it('once in drift, a matching ready does not escape drift', () => {
    const drifted = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: '0.0.1'},
    })
    expect(drifted.connection).toBe('drift')
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

  it('future unknown version (2.0.0) drifts and subsequent status+output frames are not applied', () => {
    const drifted = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: '2.0.0'},
    })
    expect(drifted.connection).toBe('drift')

    const afterStatus = nextStreamState(drifted, {type: 'status', data: ACTIVE_STATUS})
    expect(afterStatus.connection).toBe('drift')
    expect(Object.keys(afterStatus.runs)).toHaveLength(0)

    const afterOutput = nextStreamState(afterStatus, {
      type: 'output',
      data: {runId: 'run-abc', text: 'leaked output', final: false, seq: 0},
    })
    expect(afterOutput.connection).toBe('drift')
    expect(Object.keys(afterOutput.runs)).toHaveLength(0)
  })
})

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

describe('backoff first-delay', () => {
  it('RETRY_BASE_MS is 1000ms', () => {
    expect(RETRY_BASE_MS).toBe(1000)
  })

  it('RETRY_FACTOR is 2', () => {
    expect(RETRY_FACTOR).toBe(2)
  })

  it('first retry delay (retryCount=1 after increment) uses backoffDelay(1) = 2000ms', () => {
    // backoffDelay(retryCount) = RETRY_BASE_MS * RETRY_FACTOR^retryCount; after first error retryCount=1
    expect(RETRY_BASE_MS * RETRY_FACTOR ** 1).toBe(2000)
  })
})

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
    expect(Object.hasOwn(state.runs, protoRunId)).toBe(true)
    expect(Object.hasOwn({}, protoRunId)).toBe(false)
  })

  it('runs map produced by the reducer has a null prototype', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const state = nextStreamState(liveState, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    expect(Object.getPrototypeOf(state.runs)).toBeNull()
  })
})

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
  querySelector: (sel: string) => FakeSection | {textContent: string; hidden: boolean} | null
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

  const noticeEl = {textContent: '', hidden: false}

  const fakeDocument: FakeDocument = {
    querySelector: (sel: string) => {
      if (sel === '[data-role="run-index-list"]') return sectionPresent ? section : null
      if (sel === '[data-role="stream-status"]') return sectionPresent ? noticeEl : null
      return null
    },
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
  beforeEach(() => resetBootstrapState())
  afterEach(() => resetBootstrapState())

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
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    expect(liveState.connection).toBe('live')
    const afterTimeout = nextStreamState(liveState, {type: 'first-frame-timeout'})
    expect(afterTimeout.connection).toBe('live')
  })

  it('FIRST_FRAME_TIMEOUT_MS is a positive number', () => {
    expect(typeof FIRST_FRAME_TIMEOUT_MS).toBe('number')
    expect(FIRST_FRAME_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

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

  it('terminal status with no prior output frame leaves run with no outputText (no-output case)', () => {
    let state = live()
    state = nextStreamState(state, {type: 'status', data: TERMINAL_STATUS})
    const run = runOf(state, 'run-abc')
    expect(run.outputText === undefined || run.outputText === '').toBe(true)
    expect(run.terminal).toBe(true)
    expect(run.status).toBe('succeeded')
  })

  it('empty final output frame (text:"") is applied as authoritative no-output state', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-abc', text: '', final: true, seq: 0})
    const run = runOf(state, 'run-abc')
    expect(run.outputText).toBe('')
    expect(run.outputFinal).toBe(true)
  })

  it('running status after non-final output preserves accumulated output', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-abc', text: 'partial', final: false, seq: 0})
    state = nextStreamState(state, {type: 'status', data: ACTIVE_STATUS})
    const run = runOf(state, 'run-abc')
    expect(run.outputText).toBe('partial')
    expect(run.outputFinal).toBe(false)
    expect(run.status).toBe('running')
  })

  it('a subscriber receiving only a final:true frame ends with authoritative outputText and outputFinal===true', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-001', text: 'Authoritative final answer', final: true, seq: 7})
    const run = runOf(state, 'run-001')
    expect(run.outputText).toBe('Authoritative final answer')
    expect(run.outputFinal).toBe(true)
  })

  it('a final:true frame with droppedCount > 0 sets outputCoalesced AND replaces text', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-001', text: 'partial ', final: false, seq: 0})
    state = applyOutput(state, {runId: 'run-001', text: 'complete answer', final: true, seq: 3, droppedCount: 2})
    const run = runOf(state, 'run-001')
    expect(run.outputText).toBe('complete answer')
    expect(run.outputFinal).toBe(true)
    expect(run.outputCoalesced).toBe(true)
  })

  it('accumulated output state does not surface runId, droppedCount, or other frame fields as free text', () => {
    let state = live()
    state = applyOutput(state, {runId: 'run-001', text: 'hello', final: false, seq: 0, droppedCount: 1})
    state = applyOutput(state, {runId: 'run-001', text: ' world', final: true, seq: 1})
    const run = runOf(state, 'run-001')
    expect(run.outputText).not.toContain('run-001')
    expect(run.outputText).not.toContain('droppedCount')
    expect(run.outputText).not.toContain('final')
    expect(run.outputText).not.toContain('seq')
    const serialized = JSON.stringify({outputText: run.outputText, outputFinal: run.outputFinal, outputCoalesced: run.outputCoalesced})
    expect(serialized).not.toContain('run-001')
    expect(serialized).not.toContain('droppedCount')
  })
})

describe('nextStreamState — approval reducer state', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  const runOf = (state: StreamState, runId: string): RunEntry => {
    const entry = state.runs[runId]
    if (entry === undefined) throw new Error(`expected run ${runId} in state`)
    return entry
  }

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

  const settleApproval = (state: StreamState, runId: string, requestID: string): StreamState =>
    nextStreamState(state, {
      type: 'approval',
      data: {runId, requestID, settled: true},
    })

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
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo again')
    const runAfterReopen = runOf(state, 'run-001')
    expect(hasOpenApprovals(runAfterReopen)).toBe(false)
  })

  it('pre-live: approval frame before ready (connection !== live) → ignored, no prompt', () => {
    const state = openApproval(INITIAL_STATE, 'run-001', 'req-001', 'shell')
    expect(state.runs['run-001']).toBeUndefined()
  })

  it('race — open-after-settle: settle(req-001) THEN open(req-001) → open is ignored (tombstone wins)', () => {
    let state = live()
    state = settleApproval(state, 'run-001', 'req-001')
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo late')
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(getOpenApprovals(run)).toHaveLength(0)
  })

  it('race — settle-unseen: settle(req-002) with no prior open → no prompt added, req-002 tombstoned', () => {
    let state = live()
    state = settleApproval(state, 'run-001', 'req-002')
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    state = openApproval(state, 'run-001', 'req-002', 'network')
    const runAfter = runOf(state, 'run-001')
    expect(hasOpenApprovals(runAfter)).toBe(false)
  })

  it('race — id-reuse: settle(req-001) then fresh open(req-001) → ignored (tombstone wins)', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo first')
    state = settleApproval(state, 'run-001', 'req-001')
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo reused')
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(getOpenApprovals(run)).toHaveLength(0)
  })

  it('race — terminal absorbing: open(req-001) then terminal status → all prompts cleared', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo hello')
    expect(hasOpenApprovals(runOf(state, 'run-001'))).toBe(true)
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
    state = openApproval(state, 'run-001', 'req-003', 'network')
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(getOpenApprovals(run)).toHaveLength(0)
  })

  it('idempotent: duplicate open(req-001) → single prompt, no corruption', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo hello')
    state = openApproval(state, 'run-001', 'req-001', 'shell', 'echo hello')
    const run = runOf(state, 'run-001')
    const prompts = getOpenApprovals(run)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.requestID).toBe('req-001')
  })

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

  it('immutability: prior state object is not mutated by an approval transition', () => {
    const liveState = live()
    const beforeOpen = openApproval(liveState, 'run-001', 'req-001', 'shell')
    const priorRuns = beforeOpen.runs
    const priorEntry = beforeOpen.runs['run-001']
    const afterSettle = settleApproval(beforeOpen, 'run-001', 'req-001')
    expect(beforeOpen.runs).toBe(priorRuns)
    expect(beforeOpen.runs['run-001']).toBe(priorEntry)
    expect(afterSettle.runs).not.toBe(priorRuns)
    expect(hasOpenApprovals(priorEntry)).toBe(true)
    expect(hasOpenApprovals(afterSettle.runs['run-001'])).toBe(false)
  })

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

    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: `req-${MAX_APPROVAL_TOMBSTONES}`, settled: true},
    })
    const run = state.runs['run-001']
    const tombstones = run?.approvalTombstones ?? {}
    expect(Object.keys(tombstones)).toHaveLength(MAX_APPROVAL_TOMBSTONES)
    expect(Object.hasOwn(tombstones, 'req-0')).toBe(false)
    expect(Object.hasOwn(tombstones, `req-${MAX_APPROVAL_TOMBSTONES}`)).toBe(true)
  })
})

describe('nextStreamState — open-approvals cap (MAX_OPEN_APPROVALS)', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  it('overflow open frame is ignored when open-prompts map is at cap — existing prompts intact', () => {
    let state = live()
    for (let i = 0; i < MAX_OPEN_APPROVALS; i++) {
      state = nextStreamState(state, {
        type: 'approval',
        data: {runId: 'run-001', requestID: `req-${i}`, permission: 'shell', settled: false},
      })
    }
    const runAtCap = state.runs['run-001']
    expect(Object.keys(runAtCap?.approvalOpenPrompts ?? {})).toHaveLength(MAX_OPEN_APPROVALS)

    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: `req-${MAX_OPEN_APPROVALS}`, permission: 'shell', settled: false},
    })
    const run = state.runs['run-001']
    const openPrompts = run?.approvalOpenPrompts ?? {}
    expect(Object.keys(openPrompts)).toHaveLength(MAX_OPEN_APPROVALS)
    expect(Object.hasOwn(openPrompts, `req-${MAX_OPEN_APPROVALS}`)).toBe(false)
    expect(Object.hasOwn(openPrompts, 'req-0')).toBe(true)
    expect(Object.hasOwn(openPrompts, `req-${MAX_OPEN_APPROVALS - 1}`)).toBe(true)
  })
})

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

interface FakeElement {
  tagName: string
  textContent: string
  hidden: boolean
  className: string
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
  dispatchEvent: (event: {type: string; stopPropagation?: () => void}) => void
}

function makeFakeEl(tagName = 'div'): FakeElement {
  // Setting textContent to '' clears children, mirroring real DOM behavior.
  let textContentValue = ''
  const el = {
    tagName,
    get textContent() { return textContentValue },
    set textContent(v: string) {
      textContentValue = v
      if (v === '') {
        el.children = []
      }
    },
    hidden: false,
    className: '',
    children: [] as FakeElement[],
    attributes: {} as Record<string, string>,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    eventListeners: {} as Record<string, ((...args: unknown[]) => void)[]>,
    querySelector(sel: string): FakeElement | null {
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
    remove() {}, // parent would need to remove from children
    setAttribute(name: string, value: string) {
      el.attributes[name] = value
    },
    getAttribute(name: string): string | null {
      return el.attributes[name] ?? null
    },
    classList: {
      add(_cls: string) {},
      remove(_cls: string) {},
      contains(_cls: string) { return false },
    },
    addEventListener(event: string, handler: (...args: unknown[]) => void) {
      if (!el.eventListeners[event]) el.eventListeners[event] = []
      el.eventListeners[event].push(handler)
    },
    dispatchEvent(event: {type: string; stopPropagation?: () => void}) {
      // Real DOM events always carry stopPropagation; default to a no-op so
      // callers that dispatch a bare {type: 'click'} still work.
      const eventWithDefaults = {stopPropagation: () => {}, ...event}
      const handlers = el.eventListeners[event.type] ?? []
      for (const h of handlers) h(eventWithDefaults)
    },
  } satisfies FakeElement
  return el
}

type ListRunApprovalsResult =
  | {success: true; data: {approvals: {requestID: string; permission: string; command?: string; filepath?: string}[]}}
  | {success: false; error: {kind: 'http'; status: number}}
  | {success: false; error: {kind: 'network'}}
  | {success: false; error: {kind: 'protocol'}}

function makeFakeApprovalClient(opts: {
  decideResult?: {success: boolean; data?: {state: string}; error?: {kind: string; status?: number}}
  listResult?: {requestID: string; permission: string; command?: string; filepath?: string}[]
  listFailure?: {kind: 'http'; status: number} | {kind: 'network'} | {kind: 'protocol'}
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
      listRunApprovals: async (runId: string): Promise<ListRunApprovalsResult> => {
        listCalls.push(runId)
        if (opts.listFailure) {
          const failure = opts.listFailure
          if (failure.kind === 'http') return {success: false, error: {kind: 'http', status: failure.status}}
          if (failure.kind === 'network') return {success: false, error: {kind: 'network'}}
          return {success: false, error: {kind: 'protocol'}}
        }
        return {success: true, data: {approvals: opts.listResult ?? []}}
      },
    },
  }
}

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
      approvalClient: client,
    })

    expect(decideCalls).toHaveLength(0)
    expect(listCalls).toHaveLength(0)
  })
})

describe('bootstrapOperatorStreams — discovers approvalsEl and badgeEl', () => {
  beforeEach(() => resetBootstrapState())
  afterEach(() => resetBootstrapState())

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
      querySelectorAll: () => cards,
    }
    const noticeEl = {textContent: '', hidden: false}

    vi.stubGlobal('document', {
      querySelector: (sel: string) => {
        if (sel === '[data-role="run-index-list"]') return section
        if (sel === '[data-role="stream-status"]') return noticeEl
        return null
      },
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

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toBe('/operator/runs/run-001/stream')
  })
})

describe('reconcile-on-reconnect — reducer-level no-resurrect', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  it('reconcile: a synthetic open frame for a tombstoned requestID is ignored (no-resurrect)', () => {
    let state = live()
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', permission: 'shell', settled: false},
    })
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', settled: true},
    })
    expect(hasOpenApprovals(state.runs['run-001'])).toBe(false)
    // Tombstoned: a synthetic open for the same requestID (e.g. from a reconcile GET) must be ignored
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', permission: 'shell', settled: false},
    })
    expect(hasOpenApprovals(state.runs['run-001'])).toBe(false)
    expect(getOpenApprovals(state.runs['run-001'])).toHaveLength(0)
  })

  it('reconcile: a synthetic open frame for a non-tombstoned requestID is added', () => {
    let state = live()
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-002', permission: 'network', settled: false},
    })
    expect(hasOpenApprovals(state.runs['run-001'])).toBe(true)
    expect(getOpenApprovals(state.runs['run-001'])[0]?.requestID).toBe('req-002')
  })

  it('reconcile: after terminal status, synthetic open frames are ignored', () => {
    let state = live()
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
    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-003', permission: 'shell', settled: false},
    })
    expect(hasOpenApprovals(state.runs['run-001'])).toBe(false)
  })
})

describe('safe DOM — inert text rendering', () => {
  it('a command containing HTML/script renders as inert text (no element injection)', () => {
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

    // Reducer stores command as-is; rendering layer must use textContent (never innerHTML)
    const prompts = getOpenApprovals(state.runs['run-001'])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.command).toBe(maliciousCommand)
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
    expect(prompts[0]?.filepath).toBe(maliciousFilepath)
  })
})

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

function renderPromptAsFake(
  prompt: ApprovalFrameDataOpen,
  runId: string,
  client: ReturnType<typeof makeFakeApprovalClient>['client'],
): FakeElement {
  return renderApprovalPrompt(prompt, runId, client, () => {}) as FakeElement
}

function findVisibleButtons(el: FakeElement): FakeElement[] {
  const buttons: FakeElement[] = []
  for (const child of el.children) {
    if (child.hidden) continue
    if (child.tagName === 'button') buttons.push(child)
    buttons.push(...findVisibleButtons(child))
  }
  return buttons
}

function findStatusElement(el: FakeElement): FakeElement | undefined {
  for (const child of el.children) {
    if (child.attributes.role === 'status') return child
    const found = findStatusElement(child)
    if (found !== undefined) return found
  }
  return undefined
}

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

    const actionEl = el.children.find((c: FakeElement) => c.tagName === 'pre')
    expect(actionEl).toBeDefined()
    if (actionEl !== undefined) {
      expect(actionEl.textContent).toBe(maliciousCommand)
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

    const alwaysBtn = findVisibleButtons(el).find(b => b.textContent === 'Always')
    expect(alwaysBtn).toBeDefined()
    alwaysBtn?.dispatchEvent({type: 'click'})

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

    const alwaysBtn = findVisibleButtons(el).find(b => b.textContent === 'Always')
    alwaysBtn?.dispatchEvent({type: 'click'})
    const cancelBtn = findVisibleButtons(el).find(b => b.textContent === 'Cancel')
    expect(cancelBtn).toBeDefined()
    cancelBtn?.dispatchEvent({type: 'click'})

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

    const alwaysBtn = findVisibleButtons(el).find(b => b.textContent === 'Always')
    alwaysBtn?.dispatchEvent({type: 'click'})
    const confirmBtn = findVisibleButtons(el).find(b => b.textContent === 'Confirm always')
    expect(confirmBtn).toBeDefined()
    confirmBtn?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(decideCalls).toHaveLength(1)
    expect(decideCalls[0]?.decision).toBe('always')
    expect(decideCalls[0]?.runId).toBe('run-001')
    expect(decideCalls[0]?.requestId).toBe('req-001')
  })
})

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

    const onceBtn = findVisibleButtons(el).find(b => b.textContent === 'Once')
    onceBtn?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/may not have approval access|check your gateway/i)
    const buttons = findVisibleButtons(el)
    expect(buttons).toHaveLength(0)
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
    const buttons = findVisibleButtons(el)
    expect(buttons.length).toBeGreaterThan(0)
    expect(statusEl?.textContent).not.toMatch(/may not have.*access|approval access/i)
  })

  it('HTTP 400 post-retry → session-failure copy shown, controls cleared', async () => {
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
    const buttons = findVisibleButtons(el)
    expect(buttons).toHaveLength(0)
  })

  it('HTTP 401 from CSRF-refresh-expiry → session-failure copy shown, controls cleared', async () => {
    stubRenderEnv()
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid-1234'})
    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const {client} = makeFakeApprovalClient({
      decideResult: {success: false, error: {kind: 'http', status: 401}},
    })
    const el = renderPromptAsFake(prompt, 'run-001', client)

    const onceBtn = findVisibleButtons(el).find(b => b.textContent === 'Once')
    onceBtn?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/session.*expired|reload.*page/i)
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

  it('scope_mismatch → scope label shown, controls cleared', async () => {
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
    const buttons = findVisibleButtons(el)
    expect(buttons).toHaveLength(0)
  })

  it('failed_to_settle → retryable copy shown, controls still present', async () => {
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
    const buttons = findVisibleButtons(el)
    expect(buttons.length).toBeGreaterThan(0)
  })
})

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
      listRunApprovals: async () => ({success: true as const, data: {approvals: []}}),
    }

    const prompt: ApprovalFrameDataOpen = {
      runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 'echo hi', settled: false,
    }
    const el = renderApprovalPrompt(prompt, 'run-001', client, () => {}) as unknown as FakeElement

    const onceBtn = findVisibleButtons(el).find(b => b.textContent === 'Once')
    onceBtn?.dispatchEvent({type: 'click'})
    onceBtn?.dispatchEvent({type: 'click'}) // second click while in-flight must be ignored
    resolveDecide({success: true, data: {state: 'claimed'}})
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(decideCalls).toHaveLength(1)
  })
})

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
      if (typeof url === 'string' && url.includes('/csrf')) {
        return {ok: true, status: 200, json: async () => ({csrfToken: 'test-csrf-token'})}
      }
      return {ok: true, status: 200, json: async () => ({state: 'claimed'})}
    })
    vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid'})

    const client = buildApprovalClient()
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc')

    expect(result.success).toBe(true)
    expect(fetchCalls).toHaveLength(2)
    const decisionCall = fetchCalls[1]
    expect(decisionCall?.init?.headers).toBeDefined()
    const headers = decisionCall?.init?.headers as Record<string, string>
    expect(headers['x-csrf-token']).toBe('test-csrf-token')
    expect(headers['idempotency-key']).toBe('idem-key-abc')
    expect(decisionCall?.init?.redirect).toBe('error')
  })

  it('retries ONCE on 400 with a refreshed CSRF token and the SAME idempotency key', async () => {
    const fetchCalls: {url: string; init: RequestInit}[] = []
    let decisionCallCount = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetchCalls.push({url, init})
      if (typeof url === 'string' && url.includes('/csrf')) {
        return {ok: true, status: 200, json: async () => ({csrfToken: `csrf-${fetchCalls.length}`})}
      }
      // First decision call → 400, second → success
      decisionCallCount++
      if (decisionCallCount === 1) {
        return {ok: false, status: 400, json: async () => ({})}
      }
      return {ok: true, status: 200, json: async () => ({state: 'claimed'})}
    })

    const client = buildApprovalClient()
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc')

    expect(result.success).toBe(true)
    expect(fetchCalls).toHaveLength(4)
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
        if (csrfCallCount === 1) {
          return {ok: true, status: 200, json: async () => ({csrfToken: 'csrf-1'})}
        }
        throw new Error('network failure on retry')
      }
      return {ok: false, status: 400, json: async () => ({})}
    })

    const client = buildApprovalClient()
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error?.kind).toBe('network')
    }
  })

  it('initial CSRF refresh returning 401 → http error, not network', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (typeof url === 'string' && url.includes('/csrf')) {
        return {ok: false, status: 401, json: async () => ({})}
      }
      return {ok: true, status: 200, json: async () => ({state: 'claimed'})}
    })

    const client = buildApprovalClient()
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc')

    expect(result.success).toBe(false)
    if (!result.success) {
      // Surfaces as http so the prompt shows the reload state, not a retryable network failure
      expect(result.error?.kind).toBe('http')
      if (result.error?.kind === 'http') {
        expect(result.error.status).toBe(401)
      }
    }
  })

  it('initial CSRF refresh returning 403 → http error, not network', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (typeof url === 'string' && url.includes('/csrf')) {
        return {ok: false, status: 403, json: async () => ({})}
      }
      return {ok: true, status: 200, json: async () => ({state: 'claimed'})}
    })

    const client = buildApprovalClient()
    const result = await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-abc')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error?.kind).toBe('http')
      if (result.error?.kind === 'http') {
        expect(result.error.status).toBe(403)
      }
    }
  })
})

describe('buildApprovalClient — listRunApprovals', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns {success:true, data:{approvals:[]}} on 200 with empty approvals array', async () => {
    vi.stubGlobal('fetch', async () => ({ok: true, status: 200, json: async () => ({approvals: []})}))
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual({success: true, data: {approvals: []}})
  })

  it('returns {success:true, data:{approvals:[...]}} on 200 with populated approvals array', async () => {
    const approvals = [{requestID: 'req-001', permission: 'shell', command: 'echo hi'}]
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({approvals}),
    }))
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual({success: true, data: {approvals}})
  })

  it('returns {success:false, error:{kind:"http", status}} on non-2xx response', async () => {
    vi.stubGlobal('fetch', async () => ({ok: false, status: 404, json: async () => ({})}))
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual({success: false, error: {kind: 'http', status: 404}})
  })

  it('returns {success:false, error:{kind:"http", status}} on 500 response', async () => {
    vi.stubGlobal('fetch', async () => ({ok: false, status: 500, json: async () => ({})}))
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual({success: false, error: {kind: 'http', status: 500}})
  })

  it('returns {success:false, error:{kind:"network"}} on fetch throw', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error')
    })
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual({success: false, error: {kind: 'network'}})
  })

  it('returns {success:false, error:{kind:"protocol"}} on 200 with missing approvals field', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({notApprovals: []}),
    }))
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual({success: false, error: {kind: 'protocol'}})
  })

  it('returns {success:false, error:{kind:"protocol"}} on 200 with null body', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => null,
    }))
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual({success: false, error: {kind: 'protocol'}})
  })

  it('returns {success:false, error:{kind:"protocol"}} on 200 with approvals as non-array', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({approvals: 'not-an-array'}),
    }))
    const client = buildApprovalClient()
    const result = await client.listRunApprovals('run-001')
    expect(result).toEqual({success: false, error: {kind: 'protocol'}})
  })
})

describe('buildCancelClient — cancelRun', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('happy path: 200 {ok:true, runId, phase:"CANCELLED"} parses to success', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ok: true, runId: 'run-001', phase: 'CANCELLED'}),
    }))
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ok: true, runId: 'run-001', phase: 'CANCELLED'})
    }
  })

  it('happy path: phase "COMPLETED" (already-terminal) parses to success', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ok: true, runId: 'run-001', phase: 'COMPLETED'}),
    }))
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.phase).toBe('COMPLETED')
    }
  })

  it('happy path: phase "FAILED" (already-terminal) parses to success', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ok: true, runId: 'run-001', phase: 'FAILED'}),
    }))
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.phase).toBe('FAILED')
    }
  })

  it('edge: blank csrf token rejects before fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', '')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('edge: whitespace-only csrf token rejects before fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', '   ')
    expect(result.success).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('edge: blank idempotency key rejects before fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', '', 'csrf-token-abc')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('edge: invalid runId with slash rejects before fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = buildCancelClient()
    const result = await client.cancelRun('run/001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('validation')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('edge: invalid runId with ".." traversal rejects before fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = buildCancelClient()
    const result = await client.cancelRun('..', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('edge: invalid runId with percent-encoded slash rejects before fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = buildCancelClient()
    const result = await client.cancelRun('run%2F001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('edge: invalid runId with a literal NUL/CR/LF rejects before fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = buildCancelClient()
    for (const bad of ['run\u0000001', 'run\r001', 'run\n001']) {
      const result = await client.cancelRun(bad, 'idem-key-abc', 'csrf-token-abc')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.kind).toBe('validation')
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('edge: invalid runId with percent-encoded NUL/CR/LF rejects before fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = buildCancelClient()
    for (const bad of ['run%00001', 'run%0d001', 'run%0D001', 'run%0a001', 'run%0A001']) {
      const result = await client.cancelRun(bad, 'idem-key-abc', 'csrf-token-abc')
      expect(result.success).toBe(false)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reliability: a hung fetch (never resolves) hits the client timeout and maps to network error', async () => {
    vi.stubGlobal('fetch', async (_input: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }))
    const client = buildCancelClient()
    const resultPromise = client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    // Simulate the timeout firing by aborting via a real AbortController the
    // fake fetch listens to — buildCancelClient itself wires AbortSignal.timeout,
    // so here we just confirm the outcome once the underlying signal aborts.
    const result = await resultPromise
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('network')
    }
  }, 15_000)

  it('error: HTTP 400 triggers exactly ONE retry with the SAME idempotency key', async () => {
    const fetchCalls: {url: string; init: RequestInit}[] = []
    let callCount = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetchCalls.push({url, init})
      callCount++
      if (callCount === 1) {
        return {ok: false, status: 400, json: async () => ({})}
      }
      return {ok: true, status: 200, json: async () => ({ok: true, runId: 'run-001', phase: 'CANCELLED'})}
    })
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(true)
    expect(fetchCalls).toHaveLength(2)
    const idemKeys = fetchCalls.map(c => (c.init?.headers as Record<string, string>)['idempotency-key'])
    expect(idemKeys[0]).toBe('idem-key-abc')
    expect(idemKeys[1]).toBe('idem-key-abc')
    const csrfTokens = fetchCalls.map(c => (c.init?.headers as Record<string, string>)['x-csrf-token'])
    expect(csrfTokens[0]).toBe('csrf-token-abc')
    expect(csrfTokens[1]).toBe('csrf-token-abc')
  })

  it('error: persistent 400 (both attempts) returns the http/400 result once', async () => {
    const fetchCalls: {url: string; init: RequestInit}[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetchCalls.push({url, init})
      return {ok: false, status: 400, json: async () => ({})}
    })
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(400)
      }
    }
    expect(fetchCalls).toHaveLength(2)
  })

  it('error: 404 maps to http error class with status 404', async () => {
    vi.stubGlobal('fetch', async () => ({ok: false, status: 404, json: async () => ({})}))
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(404)
      }
    }
  })

  it('error: 503 maps to http error class with status 503', async () => {
    vi.stubGlobal('fetch', async () => ({ok: false, status: 503, json: async () => ({})}))
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('http')
      if (result.error.kind === 'http') {
        expect(result.error.status).toBe(503)
      }
    }
  })

  it('error: network throw maps to network error class', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED')
    })
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('network')
    }
  })

  it('error: malformed 200 body (fails parseOperatorCancelResponse) maps to protocol error class', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ok: true, runId: 'run-001', phase: 'NOT_A_REAL_PHASE'}),
    }))
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('protocol')
    }
  })

  it('error: 200 body that is not valid JSON maps to protocol error class', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid json')
      },
    }))
    const client = buildCancelClient()
    const result = await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.kind).toBe('protocol')
    }
  })

  it('integration: sets redirect:"error" on the fetch init', async () => {
    const fetchCalls: {url: string; init: RequestInit}[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetchCalls.push({url, init})
      return {ok: true, status: 200, json: async () => ({ok: true, runId: 'run-001', phase: 'CANCELLED'})}
    })
    const client = buildCancelClient()
    await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(fetchCalls[0]?.init?.redirect).toBe('error')
  })

  it('integration: sends no request body', async () => {
    const fetchCalls: {url: string; init: RequestInit}[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetchCalls.push({url, init})
      return {ok: true, status: 200, json: async () => ({ok: true, runId: 'run-001', phase: 'CANCELLED'})}
    })
    const client = buildCancelClient()
    await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-abc')
    expect(fetchCalls[0]?.init?.body).toBeUndefined()
  })

  it('integration: POSTs to the expected path with x-csrf-token and idempotency-key headers', async () => {
    const fetchCalls: {url: string; init: RequestInit}[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetchCalls.push({url, init})
      return {ok: true, status: 200, json: async () => ({ok: true, runId: 'run-001', phase: 'CANCELLED'})}
    })
    const client = buildCancelClient()
    await client.cancelRun('run-001', 'idem-key-abc', 'csrf-token-xyz')
    expect(fetchCalls[0]?.url).toBe('/operator/runs/run-001/cancel')
    expect(fetchCalls[0]?.init?.method).toBe('POST')
    const headers = fetchCalls[0]?.init?.headers as Record<string, string>
    expect(headers['x-csrf-token']).toBe('csrf-token-xyz')
    expect(headers['idempotency-key']).toBe('idem-key-abc')
  })

  it('no-leak: injected logger receives only the route template + coarse status, never runId/csrf/idempotency', async () => {
    vi.stubGlobal('fetch', async () => ({ok: false, status: 404, json: async () => ({})}))
    const logCalls: {message: string; meta?: Record<string, unknown>}[] = []
    const logger = {
      error: (message: string, meta?: Record<string, unknown>) => {
        logCalls.push({message, meta})
      },
    }
    const client = buildCancelClient({logger})
    await client.cancelRun('super-secret-run-id', 'super-secret-idem-key', 'super-secret-csrf-token')
    expect(logCalls.length).toBeGreaterThan(0)
    for (const call of logCalls) {
      const serialized = JSON.stringify(call)
      expect(serialized).not.toContain('super-secret-run-id')
      expect(serialized).not.toContain('super-secret-idem-key')
      expect(serialized).not.toContain('super-secret-csrf-token')
      expect(serialized).toContain('/operator/runs/:runId/cancel')
    }
  })

  it('no-leak: logger is called on network error, without leaking sensitive values', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED super-secret-run-id')
    })
    const logCalls: {message: string; meta?: Record<string, unknown>}[] = []
    const logger = {
      error: (message: string, meta?: Record<string, unknown>) => {
        logCalls.push({message, meta})
      },
    }
    const client = buildCancelClient({logger})
    await client.cancelRun('super-secret-run-id', 'super-secret-idem-key', 'super-secret-csrf-token')
    expect(logCalls.length).toBeGreaterThan(0)
    for (const call of logCalls) {
      const serialized = JSON.stringify(call)
      expect(serialized).not.toContain('super-secret-run-id')
      expect(serialized).not.toContain('super-secret-idem-key')
      expect(serialized).not.toContain('super-secret-csrf-token')
    }
  })
})

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

    expect(badgeEl.hidden).toBe(true)
    expect(badgeEl.textContent).toBe('')

    handle.close()
  })

  it('badge shows "2" for two open prompts and hides on settle (reducer-level)', () => {
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

    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-001', settled: true},
    })
    const runAfter = state.runs['run-001']
    expect(getOpenApprovals(runAfter)).toHaveLength(1)

    state = nextStreamState(state, {
      type: 'approval',
      data: {runId: 'run-001', requestID: 'req-002', settled: true},
    })
    const runFinal = state.runs['run-001']
    expect(hasOpenApprovals(runFinal)).toBe(false)
    expect(getOpenApprovals(runFinal)).toHaveLength(0)
  })
})

describe('nextStreamState — approval-reconcile action', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  const runOf = (state: StreamState, runId: string): RunEntry => {
    const entry = state.runs[runId]
    if (entry === undefined) throw new Error(`expected run ${runId} in state`)
    return entry
  }

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

  const settleApproval = (state: StreamState, runId: string, requestID: string): StreamState =>
    nextStreamState(state, {
      type: 'approval',
      data: {runId, requestID, settled: true},
    })

  const reconcile = (
    state: StreamState,
    runId: string,
    pruneIds: string[],
    addPrompts: {requestID: string; permission: string; command?: string; filepath?: string}[],
  ): StreamState =>
    nextStreamState(state, {
      type: 'approval-reconcile',
      runId,
      pruneIds,
      addPrompts,
    })

  it('happy: open(A), open(B) → reconcile pruneIds:[A], addPrompts:[] → A absent, tombstoned; B still open', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-A', 'shell', 'echo A')
    state = openApproval(state, 'run-001', 'req-B', 'shell', 'echo B')
    state = reconcile(state, 'run-001', ['req-A'], [])

    const run = runOf(state, 'run-001')
    const openIds = getOpenApprovals(run).map(p => p.requestID)
    expect(openIds).not.toContain('req-A')
    expect(openIds).toContain('req-B')
    expect(hasOpenApprovals(run)).toBe(true)
    expect(Object.hasOwn(run.approvalTombstones ?? {}, 'req-A')).toBe(true)
  })

  it('edge: reconcile pruneIds:[A,B] → both pruned and tombstoned', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-A', 'shell', 'echo A')
    state = openApproval(state, 'run-001', 'req-B', 'network')
    state = reconcile(state, 'run-001', ['req-A', 'req-B'], [])

    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(getOpenApprovals(run)).toHaveLength(0)
    expect(Object.hasOwn(run.approvalTombstones ?? {}, 'req-A')).toBe(true)
    expect(Object.hasOwn(run.approvalTombstones ?? {}, 'req-B')).toBe(true)
  })

  it('edge (no-resurrect): A pruned → later open frame for A → A stays suppressed (tombstone precedence)', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-A', 'shell', 'echo A')
    state = reconcile(state, 'run-001', ['req-A'], [])
    expect(hasOpenApprovals(runOf(state, 'run-001'))).toBe(false)
    state = openApproval(state, 'run-001', 'req-A', 'shell', 'echo late')
    expect(hasOpenApprovals(runOf(state, 'run-001'))).toBe(false)
    expect(getOpenApprovals(runOf(state, 'run-001'))).toHaveLength(0)
  })

  it('edge (idempotent settle/prune overlap): A already settled then pruneIds:[A] → no-op, no error, A stays tombstoned', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-A', 'shell', 'echo A')
    state = settleApproval(state, 'run-001', 'req-A')
    expect(Object.hasOwn(runOf(state, 'run-001').approvalTombstones ?? {}, 'req-A')).toBe(true)
    state = reconcile(state, 'run-001', ['req-A'], [])
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(Object.hasOwn(run.approvalTombstones ?? {}, 'req-A')).toBe(true)
  })

  it('edge (add path): addPrompts:[{requestID:C}] where C not open and not tombstoned → C added as open', () => {
    let state = live()
    state = reconcile(state, 'run-001', [], [{requestID: 'req-C', permission: 'network'}])

    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(true)
    const prompts = getOpenApprovals(run)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.requestID).toBe('req-C')
    expect(prompts[0]?.permission).toBe('network')
  })

  it('edge (add ignores tombstoned): addPrompts:[{requestID:A}] where A is tombstoned → A NOT added', () => {
    let state = live()
    state = settleApproval(state, 'run-001', 'req-A')
    expect(Object.hasOwn(runOf(state, 'run-001').approvalTombstones ?? {}, 'req-A')).toBe(true)
    state = reconcile(state, 'run-001', [], [{requestID: 'req-A', permission: 'shell'}])
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(getOpenApprovals(run)).toHaveLength(0)
  })

  it('edge: empty pruneIds and empty addPrompts → no-op, no spurious tombstones', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-A', 'shell', 'echo A')
    const before = runOf(state, 'run-001')
    state = reconcile(state, 'run-001', [], [])
    const after = runOf(state, 'run-001')
    expect(getOpenApprovals(after)).toHaveLength(1)
    expect(getOpenApprovals(after)[0]?.requestID).toBe('req-A')
    expect(Object.keys(after.approvalTombstones ?? {})).toHaveLength(
      Object.keys(before.approvalTombstones ?? {}).length,
    )
  })

  it('edge (FIFO cap): pruning when tombstone map is at MAX_APPROVAL_TOMBSTONES evicts oldest', () => {
    let state = live()
    for (let i = 0; i < MAX_APPROVAL_TOMBSTONES; i++) {
      state = nextStreamState(state, {
        type: 'approval',
        data: {runId: 'run-001', requestID: `req-${i}`, settled: true},
      })
    }
    const runAtCap = runOf(state, 'run-001')
    expect(Object.keys(runAtCap.approvalTombstones ?? {})).toHaveLength(MAX_APPROVAL_TOMBSTONES)

    state = openApproval(state, 'run-001', 'req-new', 'shell', 'echo new')
    state = reconcile(state, 'run-001', ['req-new'], [])

    const run = runOf(state, 'run-001')
    const tombstones = run.approvalTombstones ?? {}
    expect(Object.keys(tombstones)).toHaveLength(MAX_APPROVAL_TOMBSTONES)
    expect(Object.hasOwn(tombstones, 'req-0')).toBe(false)
    expect(Object.hasOwn(tombstones, 'req-new')).toBe(true)
  })

  it('edge (add idempotent): addPrompts containing an id already locally open → idempotent, no duplicate', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-A', 'shell', 'echo A')
    state = reconcile(state, 'run-001', [], [{requestID: 'req-A', permission: 'shell'}])
    const run = runOf(state, 'run-001')
    expect(getOpenApprovals(run)).toHaveLength(1)
    expect(getOpenApprovals(run)[0]?.requestID).toBe('req-A')
  })

  it('edge: pruneIds containing an id not in open-prompts → tombstoned but no error', () => {
    let state = live()
    state = reconcile(state, 'run-001', ['req-X'], [])
    const run = runOf(state, 'run-001')
    // settle-unseen behavior: tombstoned even if never opened
    expect(Object.hasOwn(run.approvalTombstones ?? {}, 'req-X')).toBe(true)
    expect(hasOpenApprovals(run)).toBe(false)
  })

  it('immutability: prior state is not mutated by approval-reconcile', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-A', 'shell', 'echo A')
    const priorRuns = state.runs
    const priorEntry = state.runs['run-001']
    const after = reconcile(state, 'run-001', ['req-A'], [])
    expect(state.runs).toBe(priorRuns)
    expect(state.runs['run-001']).toBe(priorEntry)
    expect(after.runs).not.toBe(priorRuns)
    expect(hasOpenApprovals(priorEntry)).toBe(true)
    expect(hasOpenApprovals(after.runs['run-001'])).toBe(false)
  })

  it('terminal absorbing: approval-reconcile on a terminal run is ignored', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-A', 'shell', 'echo A')
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
    expect(runOf(state, 'run-001').terminal).toBe(true)
    state = reconcile(state, 'run-001', ['req-A'], [{requestID: 'req-B', permission: 'network'}])
    const run = runOf(state, 'run-001')
    expect(hasOpenApprovals(run)).toBe(false)
    expect(getOpenApprovals(run).map(p => p.requestID)).not.toContain('req-B')
  })

  it('pre-live: approval-reconcile before ready (connection !== live) → ignored', () => {
    const state = reconcile(INITIAL_STATE, 'run-001', ['req-A'], [{requestID: 'req-B', permission: 'shell'}])
    expect(state.runs['run-001']).toBeUndefined()
  })
})

describe('GATEWAY_PENDING_APPROVALS_CAP constant', () => {
  it('GATEWAY_PENDING_APPROVALS_CAP is exported and equals 50', () => {
    expect(GATEWAY_PENDING_APPROVALS_CAP).toBe(50)
  })

  it('GATEWAY_PENDING_APPROVALS_CAP is a positive number less than MAX_OPEN_APPROVALS', () => {
    expect(typeof GATEWAY_PENDING_APPROVALS_CAP).toBe('number')
    expect(GATEWAY_PENDING_APPROVALS_CAP).toBeGreaterThan(0)
    expect(GATEWAY_PENDING_APPROVALS_CAP).toBeLessThan(MAX_OPEN_APPROVALS)
  })
})

/**
 * Build a fake SSE ReadableStream that emits the given SSE text chunks.
 * Pass `keepOpen: true` to leave the stream open after all chunks are emitted.
 * By default the stream closes after all chunks, triggering the reconnect path.
 */
function makeSseStream(chunks: string[], opts: {keepOpen?: boolean} = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      if (!opts.keepOpen) {
        controller.close()
      }
    },
  })
}

function makeSseResponse(chunks: string[], opts: {keepOpen?: boolean} = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: {get: (h: string) => (h === 'content-type' ? 'text/event-stream' : null)},
    body: makeSseStream(chunks, opts),
  } as unknown as Response
}

describe('reconcileApprovals — wired integration (corrective prune)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('integration: ghost prompt A absent from complete recovery set is pruned on reconnect', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', command: 'echo A', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    const conn1Chunks = [readyChunk, openAChunk, resetChunk]
    const conn2Chunks = [readyChunk]

    let connectionCount = 0
    const listCalls: string[] = []

    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async (runId: string) => {
        listCalls.push(runId)
        return {success: true as const, data: {approvals: []}} // req-A settled during gap
      },
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      connectionCount++
      const chunks = connectionCount === 1 ? conn1Chunks : conn2Chunks
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))
    expect(listCalls.length).toBeGreaterThanOrEqual(2)
    expect(approvalsEl.hidden).toBe(true)
  }, 10000)

  it('error path: listRunApprovals failure → open prompts preserved, no prune', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    let listCallCount = 0
    const listCalls: string[] = []

    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async (runId: string) => {
        listCalls.push(runId)
        listCallCount++
        if (listCallCount === 1) {
          return {success: true as const, data: {approvals: []}} // req-A arrives during GET window
        }
        return {success: false as const, error: {kind: 'network' as const}} // must NOT prune req-A
      },
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    let fetchCount = 0
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      const chunks = fetchCount === 1
        ? [readyChunk, openAChunk, resetChunk]
        : [readyChunk]
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))
    expect(listCalls.length).toBeGreaterThanOrEqual(2)
    expect(approvalsEl.hidden).toBe(false) // req-A must NOT have been pruned (reconcile failed)
  }, 10000)

  // Race guard: a prompt C opened AFTER the pre-GET snapshot and absent from the
  // recovered set must NOT be pruned (pruneIds is derived from the pre-GET snapshot).
  //
  // Setup: stream goes live (no pre-existing open prompts), reconcileApprovals
  // starts (GET pending). req-C's open frame arrives via SSE DURING the await.
  // Recovery returns [] (empty). req-C must NOT be pruned.
  // -------------------------------------------------------------------------

  it('race guard: prompt C opened during the GET window is NOT pruned even when absent from recovery', async () => {
    // Use a controllable listRunApprovals that delays resolution so req-C can
    // arrive via SSE before the GET resolves.
    let resolveList!: (v: {success: true; data: {approvals: []}}) => void
    const listPromise = new Promise<{success: true; data: {approvals: []}}>(resolve => {
      resolveList = resolve
    })

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    // req-C arrives AFTER the ready frame (during the GET await window)
    const openCChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-C', permission: 'network', settled: false})}\n\n`

    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async (_runId: string) => listPromise,
    }

    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    // SSE stream: ready (triggers reconcile), then req-C open (during await).
    // Keep the stream open so the connection stays live during the await.
    vi.stubGlobal('fetch', async () => makeSseResponse([readyChunk, openCChunk], {keepOpen: true}))
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    // Let the SSE stream process: ready fires, reconcileApprovals starts (GET pending),
    // req-C open frame arrives during the await window.
    await new Promise(resolve => setTimeout(resolve, 10))

    // Now resolve the list — recovery returns empty (req-C absent from recovery)
    resolveList({success: true, data: {approvals: []}})

    // Wait for the reconcile to complete
    await new Promise(resolve => setTimeout(resolve, 10))

    // req-C was NOT in the pre-GET snapshot (it arrived during the await) →
    // it must NOT be pruned. approvalsEl must be visible (req-C still open).
    expect(approvalsEl.hidden).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Happy path: recovery returns [A,B] while only A was locally open
  // → B added, A retained, nothing pruned.
  //
  // On the first connection, req-A opens during the GET window (not in snapshot).
  // On the second connection, req-A IS in the snapshot. Recovery returns [A,B].
  // req-A retained, req-B added, nothing pruned.
  // -------------------------------------------------------------------------

  it('happy: recovery returns [A,B] while only A locally open → B added, A retained, nothing pruned', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    let fetchCount = 0
    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async () => ({
        success: true as const,
        data: {approvals: [{requestID: 'req-A', permission: 'shell'}, {requestID: 'req-B', permission: 'network'}]},
      }),
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      const chunks = fetchCount === 1
        ? [readyChunk, openAChunk, resetChunk]
        : [readyChunk]
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))

    // Both A and B should be open — approvalsEl visible, badge shows 2
    expect(approvalsEl.hidden).toBe(false)
    expect(badgeEl.hidden).toBe(false)
    expect(badgeEl.textContent).toBe('2')
  }, 10000)

  // -------------------------------------------------------------------------
  // Edge (truncation): recovery size >= GATEWAY_PENDING_APPROVALS_CAP
  // → pruneIds empty, additive only (no prune).
  //
  // On the second connection, req-A is in the pre-GET snapshot. Recovery returns
  // exactly GATEWAY_PENDING_APPROVALS_CAP entries (none is req-A). Truncation
  // guard fires → req-A must NOT be pruned.
  // -------------------------------------------------------------------------

  it('edge (truncation): recovery size >= cap → pruneIds empty, open prompts preserved', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    // Recovery returns exactly GATEWAY_PENDING_APPROVALS_CAP entries (none is req-A)
    const bigRecovery = Array.from({length: GATEWAY_PENDING_APPROVALS_CAP}, (_, i) => ({
      requestID: `req-recovered-${i}`,
      permission: 'shell',
    }))

    let fetchCount = 0
    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async () => ({success: true as const, data: {approvals: bigRecovery}}),
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      const chunks = fetchCount === 1
        ? [readyChunk, openAChunk, resetChunk]
        : [readyChunk]
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))

    expect(approvalsEl.hidden).toBe(false) // truncation guard: req-A must NOT be pruned
  }, 10000)

  it('edge (complete empty): recovery returns empty set while A,B open → both pruned', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const openBChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-B', permission: 'network', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    let fetchCount = 0
    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async () => ({success: true as const, data: {approvals: []}}),
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      const chunks = fetchCount === 1
        ? [readyChunk, openAChunk, openBChunk, resetChunk]
        : [readyChunk]
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))

    expect(approvalsEl.hidden).toBe(true)
  }, 10000)

  it('one-shot: listRunApprovals called exactly once per connect', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const listCalls: string[] = []

    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async (runId: string) => {
        listCalls.push(runId)
        return {success: true as const, data: {approvals: []}}
      },
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => makeSseResponse([readyChunk], {keepOpen: true}))
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]).toBe('run-001')
  })

  it('malformed-entries no-wipe: all-invalid entries with A,B locally open → NO prune', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const openBChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-B', permission: 'network', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    let fetchCount = 0
    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      // All entries fail validation (missing requestID / empty requestID) → malformed-entries guard fires
      listRunApprovals: async () => ({
        success: true as const,
        data: {approvals: [{permission: 'shell'}, {requestID: ''}] as unknown as {requestID: string; permission: string}[]},
      }),
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      const chunks = fetchCount === 1
        ? [readyChunk, openAChunk, openBChunk, resetChunk]
        : [readyChunk]
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))

    expect(approvalsEl.hidden).toBe(false)
  }, 10000)

  it('stale-reconcile discard: first reconcile resolved after second connect → stale result discarded, no wrong prune', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    let resolveFirstList!: (v: {success: true; data: {approvals: []}}) => void
    const firstListPromise = new Promise<{success: true; data: {approvals: []}}>(resolve => {
      resolveFirstList = resolve
    })

    let listCallCount = 0
    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async () => {
        listCallCount++
        if (listCallCount === 1) return firstListPromise // hold open until we resolve it
        return {success: true as const, data: {approvals: [{requestID: 'req-A', permission: 'shell'}]}}
      },
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    let fetchCount = 0
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      const chunks = fetchCount === 1
        ? [readyChunk, openAChunk, resetChunk]
        : [readyChunk]
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))
    // Resolve the stale GET with [] — would prune req-A if epoch guard is absent
    resolveFirstList({success: true, data: {approvals: []}})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(approvalsEl.hidden).toBe(false)
  }, 10000)

  it('error path (http 500): listRunApprovals http-500 failure → open prompts preserved', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    let listCallCount = 0
    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async () => {
        listCallCount++
        if (listCallCount === 1) return {success: true as const, data: {approvals: []}}
        return {success: false as const, error: {kind: 'http' as const, status: 500}}
      },
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    let fetchCount = 0
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      const chunks = fetchCount === 1
        ? [readyChunk, openAChunk, resetChunk]
        : [readyChunk]
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))

    expect(approvalsEl.hidden).toBe(false)
  }, 10000)

  it('error path (protocol): listRunApprovals protocol failure → open prompts preserved', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    let listCallCount = 0
    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async () => {
        listCallCount++
        if (listCallCount === 1) return {success: true as const, data: {approvals: []}}
        return {success: false as const, error: {kind: 'protocol' as const}}
      },
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    let fetchCount = 0
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      const chunks = fetchCount === 1
        ? [readyChunk, openAChunk, resetChunk]
        : [readyChunk]
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))

    expect(approvalsEl.hidden).toBe(false)
  }, 10000)

  it('truncation boundary (allow-prune): valid size === CAP-1 → prune IS performed', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    const nearCapRecovery = Array.from({length: GATEWAY_PENDING_APPROVALS_CAP - 1}, (_, i) => ({
      requestID: `req-recovered-${i}`,
      permission: 'shell',
    }))

    let fetchCount = 0
    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async () => ({success: true as const, data: {approvals: nearCapRecovery}}),
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      const chunks = fetchCount === 1
        ? [readyChunk, openAChunk, resetChunk]
        : [readyChunk]
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))

    // CAP-1 valid entries → truncation guard does NOT fire → req-A IS pruned
    expect(approvalsEl.hidden).toBe(false)
    expect(badgeEl.textContent).toBe(String(GATEWAY_PENDING_APPROVALS_CAP - 1))
  }, 10000)

  it('mixed valid/invalid recovery — a locally-open prompt absent from the valid subset is NOT pruned', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const openBChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-B', permission: 'network', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    let fetchCount = 0
    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      // A is valid; second entry is malformed (missing requestID) → sawMalformed fires → no prune
      listRunApprovals: async () => ({
        success: true as const,
        data: {
          approvals: [
            {requestID: 'req-A', permission: 'shell'},
            {permission: 'bad'},
          ] as unknown as {requestID: string; permission: string}[],
        },
      }),
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      const chunks = fetchCount === 1
        ? [readyChunk, openAChunk, openBChunk, resetChunk]
        : [readyChunk]
      return makeSseResponse(chunks)
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    await new Promise(resolve => setTimeout(resolve, 2500))

    expect(approvalsEl.hidden).toBe(false)
    expect(badgeEl.hidden).toBe(false)
    expect(badgeEl.textContent).toBe('2')
  }, 10000)

  // Three-connection test to guarantee a non-empty pre-GET snapshot for the stale reconcile:
  //   conn1: ready + open(A) + reset → A in state, reconnect
  //   conn2: ready + reset → reconcile-2 (STALE) snapshots preGetLocalOpenIds=[req-A], GET deferred
  //   conn3: ready (keepOpen) → reconcile-3 returns [req-A], preserving A
  // Resolving the stale GET with [] must be discarded (epoch guard: myEpoch !== connectEpoch).
  it('stale reconcile with a non-empty pre-GET snapshot bails on epoch mismatch — the prompt is NOT pruned', async () => {
    const readyChunk = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
    const openAChunk = `event: approval\ndata: ${JSON.stringify({runId: 'run-001', requestID: 'req-A', permission: 'shell', settled: false})}\n\n`
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'no-snapshot'})}\n\n`

    let resolveStaleList!: (v: {success: true; data: {approvals: []}}) => void
    const staleListPromise = new Promise<{success: true; data: {approvals: []}}>(resolve => {
      resolveStaleList = resolve
    })

    let listCallCount = 0
    const client = {
      refreshCsrf: async () => ({success: true as const, data: {csrfToken: 'csrf'}}),
      decideRunApproval: async () => ({success: true as const, data: {state: 'claimed'}}),
      listRunApprovals: async () => {
        listCallCount++
        if (listCallCount === 1) return {success: true as const, data: {approvals: []}} // conn1: no-op
        if (listCallCount === 2) return staleListPromise // conn2: STALE, hold open
        return {success: true as const, data: {approvals: [{requestID: 'req-A', permission: 'shell'}]}} // conn3
      },
    }

    const approvalsEl = makeFakeEl('div')
    approvalsEl.hidden = true
    approvalsEl.attributes['data-role'] = 'run-approvals'
    const badgeEl = makeFakeEl('span')
    badgeEl.hidden = true
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    let fetchCount = 0
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('fetch', async () => {
      fetchCount++
      if (fetchCount === 1) return makeSseResponse([readyChunk, openAChunk, resetChunk])
      if (fetchCount === 2) return makeSseResponse([readyChunk, resetChunk])
      // conn3: keepOpen so the connection stays live when reconcile-2's stale GET resolves
      // (without keepOpen, stream-closed gates the reducer and the test becomes a false positive)
      return makeSseResponse([readyChunk], {keepOpen: true})
    })
    vi.stubGlobal('addEventListener', () => {})

    initOperatorStream({
      runId: 'run-001',
      statusEl,
      noticeEl,
      approvalsEl,
      badgeEl,
      approvalClient: client,
    })

    // Backoff: conn1→conn2 = 2000ms, conn2→conn3 = 4000ms; use 7000ms for margin
    await new Promise(resolve => setTimeout(resolve, 7000))
    expect(fetchCount).toBe(3)
    expect(listCallCount).toBe(3)
    // Resolve the stale GET with [] — epoch guard must discard it
    resolveStaleList({success: true, data: {approvals: []}})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(approvalsEl.hidden).toBe(false)
    expect(badgeEl.hidden).toBe(false)
  }, 20000)
})

describe('nextStreamState — approval-reconcile __proto__ key guard', () => {
  const live = (): StreamState =>
    nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})

  const openApproval = (state: StreamState, runId: string, requestID: string, permission: string): StreamState =>
    nextStreamState(state, {
      type: 'approval',
      data: {runId, requestID, permission, settled: false},
    })

  it('pruneIds:[__proto__] → ignored, open prompts unaffected, Object.prototype not polluted', () => {
    let state = live()
    state = openApproval(state, 'run-001', 'req-A', 'shell')
    state = openApproval(state, 'run-001', 'req-B', 'network')
    state = nextStreamState(state, {
      type: 'approval-reconcile',
      runId: 'run-001',
      pruneIds: ['__proto__'],
      addPrompts: [],
    })

    const run = state.runs['run-001']
    const openIds = getOpenApprovals(run).map(p => p.requestID)
    expect(openIds).toContain('req-A')
    expect(openIds).toContain('req-B')
    expect(Object.hasOwn({}, '__proto__')).toBe(false)
  })

  it('addPrompts:[{requestID:__proto__}] → not added, Object.prototype not polluted', () => {
    let state = live()
    state = nextStreamState(state, {
      type: 'approval-reconcile',
      runId: 'run-001',
      pruneIds: [],
      addPrompts: [{requestID: '__proto__', permission: 'shell'}],
    })

    const run = state.runs['run-001']
    const openIds = getOpenApprovals(run).map(p => p.requestID)
    expect(openIds).not.toContain('__proto__')
    expect(Object.hasOwn({}, '__proto__')).toBe(false)
    if (run?.approvalOpenPrompts !== undefined) {
      expect(Object.hasOwn(run.approvalOpenPrompts, '__proto__')).toBe(false)
    }
  })
})

describe('bootstrapOperatorStreams — idempotency guard', () => {
  beforeEach(() => resetBootstrapState())
  afterEach(() => resetBootstrapState())

  it('resetBootstrapState export exists and is callable', () => {
    expect(typeof resetBootstrapState).toBe('function')
    expect(() => resetBootstrapState()).not.toThrow()
  })

  it('calling resetBootstrapState allows bootstrapOperatorStreams to run again', async () => {
    await withFakeBrowser([], false, bootstrapOperatorStreams)
    // Reset the flag
    resetBootstrapState()
    // Second call: should run again without throwing
    const fetchCalls = await withFakeBrowser([], false, bootstrapOperatorStreams)
    expect(fetchCalls).toHaveLength(0)
  })

  it('bootstrapOperatorStreams is idempotent — calling twice does not start streams twice', async () => {
    const cards = [makeFakeCard('run-idempotent')]
    const fetchCalls1 = await withFakeBrowser(cards, true, bootstrapOperatorStreams)
    expect(fetchCalls1).toHaveLength(1)
    const fetchCalls2 = await withFakeBrowser(cards, true, bootstrapOperatorStreams)
    expect(fetchCalls2).toHaveLength(0)
  })
})

describe('resetBootstrapState — handle cleanup and pagehide listener removal', () => {
  beforeEach(() => resetBootstrapState())
  afterEach(() => resetBootstrapState())

  it('resetBootstrapState closes active stream handles', async () => {
    const cards = [makeFakeCard('run-cleanup-001')]
    const section = {
      querySelectorAll: () => cards,
    }
    const noticeEl = {textContent: '', hidden: false}
    const fakeDocument = {
      querySelector: (sel: string) => {
        if (sel === '[data-role="run-index-list"]') return section
        if (sel === '[data-role="stream-status"]') return noticeEl
        return null
      },
      readyState: 'complete',
      addEventListener() {},
    }

    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('fetch', async () => new Promise<Response>(() => {}))
    vi.stubGlobal('addEventListener', () => {})

    try {
      bootstrapOperatorStreams()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(() => resetBootstrapState()).not.toThrow()
  })

  it('resetBootstrapState removes the pagehide listener (removeEventListener called)', async () => {
    const removedListeners: string[] = []

    const cards = [makeFakeCard('run-pagehide-001')]
    const section = {
      querySelectorAll: () => cards,
    }
    const noticeEl = {textContent: '', hidden: false}
    const fakeDocument = {
      querySelector: (sel: string) => {
        if (sel === '[data-role="run-index-list"]') return section
        if (sel === '[data-role="stream-status"]') return noticeEl
        return null
      },
      readyState: 'complete',
      addEventListener() {},
    }

    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('fetch', async () => new Promise<Response>(() => {}))
    vi.stubGlobal('addEventListener', () => {})
    vi.stubGlobal('removeEventListener', (event: string) => {
      removedListeners.push(event)
    })

    try {
      bootstrapOperatorStreams()
    } finally {
      vi.unstubAllGlobals()
    }

    vi.stubGlobal('removeEventListener', (event: string) => {
      removedListeners.push(event)
    })
    try {
      resetBootstrapState()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(removedListeners).toContain('pagehide')
  })

  it('resetBootstrapState can be called multiple times without throwing', () => {
    expect(() => {
      resetBootstrapState()
      resetBootstrapState()
      resetBootstrapState()
    }).not.toThrow()
  })

  it('pagehide listener is not duplicated after reset + bootstrap cycle', async () => {
    const addedListeners: string[] = []

    const cards = [makeFakeCard('run-cycle-001')]
    const section = {
      querySelectorAll: () => cards,
    }
    const noticeEl = {textContent: '', hidden: false}
    const fakeDocument = {
      querySelector: (sel: string) => {
        if (sel === '[data-role="run-index-list"]') return section
        if (sel === '[data-role="stream-status"]') return noticeEl
        return null
      },
      readyState: 'complete',
      addEventListener() {},
    }

    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('fetch', async () => new Promise<Response>(() => {}))
    vi.stubGlobal('addEventListener', (event: string) => {
      addedListeners.push(event)
    })
    vi.stubGlobal('removeEventListener', () => {})

    try {
      bootstrapOperatorStreams()
      resetBootstrapState()
      bootstrapOperatorStreams()
    } finally {
      vi.unstubAllGlobals()
    }

    const pagehideCount = addedListeners.filter(e => e === 'pagehide').length
    expect(pagehideCount).toBe(2)
  })
})

describe('initOperatorStream — noticeEl gets data-connection-state attribute', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('noticeEl has data-connection-state="live" when stream goes live', async () => {
    const noticeEl = makeFakeEl('div')
    const statusEl = makeFakeEl('span')

    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const encoder = new TextEncoder()
    let resolveController: (c: ReadableStreamDefaultController<Uint8Array>) => void
    const controllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(resolve => {
      resolveController = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      start(c) { resolveController(c) },
    })

    vi.stubGlobal('fetch', async () => ({
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body,
    }))

    const handle = initOperatorStream({runId: 'run-state-test', statusEl, noticeEl})

    const controller = await controllerReady
    controller.enqueue(encoder.encode(readyFrame))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(noticeEl.dataset.connectionState).toBe('live')

    handle.close()
  })

  it('noticeEl has data-connection-state="reconnecting" when stream gets a 500 (network-error path)', async () => {
    const noticeEl = makeFakeEl('div')
    const statusEl = makeFakeEl('span')
    vi.stubGlobal('fetch', async () => ({
      status: 500,
      headers: {get: () => 'text/html'},
      body: null,
    }))

    const handle = initOperatorStream({runId: 'run-fail-test', statusEl, noticeEl})

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(noticeEl.dataset.connectionState).toBe('reconnecting')

    handle.close()
  })

  it('noticeEl has data-connection-state="not-found" on 404', async () => {
    const noticeEl = makeFakeEl('div')
    const statusEl = makeFakeEl('span')

    vi.stubGlobal('fetch', async () => ({
      status: 404,
      headers: {get: () => 'text/html'},
      body: null,
    }))

    const handle = initOperatorStream({runId: 'run-404-test', statusEl, noticeEl})

    await new Promise(resolve => setTimeout(resolve, 10))

    expect(noticeEl.dataset.connectionState).toBe('not-found')

    handle.close()
  })
})

describe('initOperatorStream — terminal status updates statusEl when connection closes atomically', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('statusEl shows "Failed" label and status-failed class after a terminal failed status closes the stream', async () => {
    const statusEl = makeFakeEl('span')
    const addedClasses: string[] = []
    statusEl.classList = {
      add(cls: string) { addedClasses.push(cls) },
      remove(_cls: string) {},
      contains(_cls: string) { return false },
    }

    const noticeEl = makeFakeEl('div')

    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const failedStatusFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-fail',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'FAILED',
      status: 'failed',
      startedAt: '2026-06-27T10:00:00Z',
      stale: false,
    })}\n\n`

    const encoder = new TextEncoder()
    const sseBody = readyFrame + failedStatusFrame
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody))
        controller.close()
      },
    })

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: {get: (h: string) => (h === 'content-type' ? 'text/event-stream' : null)},
      body: stream,
    }))
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('addEventListener', () => {})

    const handle = initOperatorStream({runId: 'run-fail', statusEl, noticeEl})

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(statusEl.textContent).toBe('Failed')
    expect(addedClasses).toContain('status-failed')

    handle.close()
  })

  it('statusEl shows "Succeeded" label after a terminal succeeded status closes the stream', async () => {
    const statusEl = makeFakeEl('span')
    const addedClasses: string[] = []
    statusEl.classList = {
      add(cls: string) { addedClasses.push(cls) },
      remove(_cls: string) { /* no-op */ },
      contains(_cls: string) { return false },
    }

    const noticeEl = makeFakeEl('div')

    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const succeededStatusFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-ok',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'COMPLETED',
      status: 'succeeded',
      startedAt: '2026-06-27T10:00:00Z',
      stale: false,
    })}\n\n`

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(readyFrame + succeededStatusFrame))
        controller.close()
      },
    })

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: {get: (h: string) => (h === 'content-type' ? 'text/event-stream' : null)},
      body: stream,
    }))
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('addEventListener', () => {})

    const handle = initOperatorStream({runId: 'run-ok', statusEl, noticeEl})

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(statusEl.textContent).toBe('Succeeded')
    expect(addedClasses).toContain('status-succeeded')

    handle.close()
  })

  it('statusEl is NOT updated for a pre-ready status (connection stays connecting)', () => {
    const statusEl = makeFakeEl('span')
    const noticeEl = makeFakeEl('div')

    vi.stubGlobal('fetch', async () => new Promise<Response>(() => {})) // never settles
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('addEventListener', () => {})

    const handle = initOperatorStream({runId: 'run-pre-ready', statusEl, noticeEl})

    expect(statusEl.textContent).toBe('')

    handle.close()
  })
})

// ---------------------------------------------------------------------------
// Fixture SSE scenario integration (browser reducer path)
// ---------------------------------------------------------------------------
// These tests verify that the typed fixture scenarios serialize to SSE bytes
// that the browser-side parseSseFrame + nextStreamState reducer can consume.
// ---------------------------------------------------------------------------

describe('fixture SSE scenarios — browser reducer: success scenario', () => {
  it('success scenario frames drive the browser reducer to closed with succeeded run', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.success, FIXTURE_RUN_ID_FOR_TESTS)
    // Split into individual records and parse each
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    // After all frames: connection closed, run terminal with succeeded status
    expect(state.connection).toBe('closed')
    const runEntries = Object.values(state.runs)
    expect(runEntries.length).toBeGreaterThanOrEqual(1)
    const succeededRun = runEntries.find(r => r.terminal && r.status === 'succeeded')
    expect(succeededRun).toBeDefined()
  })

  it('success scenario output accumulation: final output replaces accumulated text', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.success, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    // At least one run must have output
    const runEntries = Object.values(state.runs)
    const runWithOutput = runEntries.find(r => r.outputFinal === true)
    expect(runWithOutput).toBeDefined()
    if (runWithOutput) {
      expect(runWithOutput.outputFinal).toBe(true)
    }
  })

  it('success scenario: terminal status after output preserves output fields', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.success, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    // The terminal run must have both output and terminal status
    const runEntries = Object.values(state.runs)
    const terminalRun = runEntries.find(r => r.terminal)
    expect(terminalRun).toBeDefined()
    if (terminalRun) {
      // Output fields must survive the terminal status update
      expect(terminalRun.outputFinal).toBe(true)
      expect(terminalRun.status).toBe('succeeded')
    }
  })
})

describe('fixture SSE scenarios — browser reducer: terminal_failure scenario', () => {
  it('terminal_failure scenario drives the browser reducer to closed with failed run', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.terminal_failure, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    expect(state.connection).toBe('closed')
    const runEntries = Object.values(state.runs)
    const failedRun = runEntries.find(r => r.terminal && r.status === 'failed')
    expect(failedRun).toBeDefined()
  })

  it('terminal_failure scenario: failed run remains renderable (has status and terminal flag)', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.terminal_failure, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    const runEntries = Object.values(state.runs)
    const failedRun = runEntries.find(r => r.status === 'failed')
    expect(failedRun).toBeDefined()
    if (failedRun) {
      expect(failedRun.terminal).toBe(true)
      expect(failedRun.status).toBe('failed')
      // Output fields must be preserved (visible output before failure)
      expect(failedRun.outputFinal).toBe(true)
    }
  })
})

describe('fixture SSE scenarios — browser reducer: reason-bearing scenarios', () => {
  it('terminal_failure_known_reason scenario: failed run carries a resolved reasonLabel', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.terminal_failure_known_reason, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    const failedRun = Object.values(state.runs).find(r => r.status === 'failed')
    expect(failedRun).toBeDefined()
    if (failedRun) {
      const view = toSafeRunView(failedRun)
      expect(view.reasonLabel).toBeDefined()
      expect(typeof view.reasonLabel).toBe('string')
      expect(view.reasonLabel).not.toBe('')
    }
  })

  it('terminal_failure_unknown_reason scenario: failed run has no reasonLabel (unrecognized reason normalizes to absent)', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.terminal_failure_unknown_reason, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    const failedRun = Object.values(state.runs).find(r => r.status === 'failed')
    expect(failedRun).toBeDefined()
    if (failedRun) {
      const view = toSafeRunView(failedRun)
      expect(view.reasonLabel).toBeUndefined()
    }
  })

  it('non_failed_with_reason scenario: a non-failed terminal status ignores any reason entirely — reasonLabel absent', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.non_failed_with_reason, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    const runEntries = Object.values(state.runs)
    expect(runEntries.length).toBeGreaterThan(0)
    for (const entry of runEntries) {
      expect(entry.status).not.toBe('failed')
      const view = toSafeRunView(entry)
      expect(view.reasonLabel).toBeUndefined()
    }
  })
})

describe('fixture SSE scenarios — browser reducer: contract_drift scenario', () => {
  it('contract_drift scenario drives the browser reducer to drift state', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.contract_drift, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    expect(state.connection).toBe('drift')
    expect(Object.keys(state.runs)).toHaveLength(0)
  })

  it('contract_drift scenario: later frames after drift are absorbed (no runs populated)', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.contract_drift, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    // Drift is absorbing — no runs should be populated even if status frames follow
    expect(Object.keys(state.runs)).toHaveLength(0)
    expect(state.shouldReconnect).toBe(false)
  })
})

describe('fixture SSE scenarios — browser reducer: malformed_unavailable scenario', () => {
  it('malformed_unavailable scenario: at least one parseSseFrame call returns a failure', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.malformed_unavailable, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    let hasFailure = false
    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && !result.success) {
        hasFailure = true
        break
      }
    }

    expect(hasFailure).toBe(true)
  })

  it('malformed_unavailable scenario: parse failure error string does not echo wire content', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.malformed_unavailable, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && !result.success) {
        // Error must be a fixed string, not echoing wire content
        expect(result.error.length).toBeGreaterThan(0)
        expect(result.error).not.toContain('{not valid json}')
      }
    }
  })
})

describe('fixture SSE scenarios — browser reducer: no_output scenario', () => {
  it('no_output scenario: empty terminal output does not crash the reducer and outputFinal is true', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.no_output, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    expect(state.connection).toBe('closed')
    const runEntries = Object.values(state.runs)
    const run = runEntries.find(r => r.runId === FIXTURE_RUN_ID_FOR_TESTS)
    expect(run).toBeDefined()
    if (run) {
      expect(run.outputText).toBe('')
      expect(run.outputFinal).toBe(true)
      expect(run.terminal).toBe(true)
      expect(run.status).toBe('succeeded')
    }
  })
})

describe('fixture SSE scenarios — browser reducer: stream_reset scenario', () => {
  it('stream_reset scenario: terminal reset reason closes the stream without reconnect', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.stream_reset, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
      }
    }

    expect(state.connection).toBe('closed')
    expect(state.shouldReconnect).toBe(false)
  })
})

describe('fixture SSE scenarios — browser reducer: approval_flow scenario', () => {
  it('approval_flow scenario: open frame creates an open approval prompt for the run', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.approval_flow, FIXTURE_RUN_ID_FOR_TESTS)
    const records = sseBytes.split('\n\n').filter(r => r.trim() !== '')

    const INITIAL_STATE: StreamState = {connection: 'connecting', runs: {}, retryCount: 0, shouldReconnect: false}
    let state = INITIAL_STATE

    for (const record of records) {
      const result = parseSseFrame(`${record}\n\n`)
      if (result !== null && result.success) {
        state = nextStreamState(state, result.frame)
        if (result.frame.type === 'approval' && result.frame.data.settled === false) {
          // Immediately after the open frame is applied, the prompt must be open.
          const run = state.runs[FIXTURE_RUN_ID_FOR_TESTS]
          expect(hasOpenApprovals(run)).toBe(true)
          const openApprovals = getOpenApprovals(run)
          expect(openApprovals.some(p => p.requestID === 'req-fixture-approval-001')).toBe(true)
        }
      }
    }

    // After the settle frame (and terminal status), the prompt must be removed.
    const finalRun = state.runs[FIXTURE_RUN_ID_FOR_TESTS]
    expect(hasOpenApprovals(finalRun)).toBe(false)
    expect(finalRun?.terminal).toBe(true)
    expect(finalRun?.status).toBe('succeeded')
  })
})

describe('buildApprovalClient — endpoint base support', () => {
  it('buildApprovalClient accepts an optional endpointBase option', () => {
    // Should not throw when called with an endpointBase
    expect(() => buildApprovalClient({endpointBase: '/__fixture/operator'})).not.toThrow()
  })

  it('buildApprovalClient with no options uses /operator as default', () => {
    // Should not throw when called with no options
    expect(() => buildApprovalClient()).not.toThrow()
    const client = buildApprovalClient()
    expect(typeof client.refreshCsrf).toBe('function')
    expect(typeof client.decideRunApproval).toBe('function')
    expect(typeof client.listRunApprovals).toBe('function')
  })

  it('buildApprovalClient with fixture endpointBase returns a client with the same interface', () => {
    const client = buildApprovalClient({endpointBase: '/__fixture/operator'})
    expect(typeof client.refreshCsrf).toBe('function')
    expect(typeof client.decideRunApproval).toBe('function')
    expect(typeof client.listRunApprovals).toBe('function')
  })
})

describe('initOperatorStream — malformed/closed-before-terminal: stream unavailable notice', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('noticeEl shows a visible generic unavailable notice when stream closes before any terminal status for the run', async () => {
    // Simulate the malformed_unavailable scenario: stream sends a malformed frame
    // (unrecognized event name) then closes. The run card was inserted before the
    // stream started, so runId is known but no status frame was ever received.
    // The UI must surface a path-unaware unavailable notice — not silent Pending.
    const noticeEl = makeFakeEl('div')
    const statusEl = makeFakeEl('span')

    // Malformed SSE frame: unrecognized event name → parser returns failure → silently dropped
    const malformedFrame = `event: fixture-unknown-event\ndata: {"id":"run-fixture-malformed-001","reason":"fixture-malformed"}\n\n`
    const encoder = new TextEncoder()

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(malformedFrame))
        controller.close()
      },
    })

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: {get: (h: string) => (h === 'content-type' ? 'text/event-stream' : null)},
      body: stream,
    }))
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('addEventListener', () => {})

    const handle = initOperatorStream({runId: 'run-fixture-malformed-001', statusEl, noticeEl})

    await new Promise(resolve => setTimeout(resolve, 50))

    // The stream closed before any terminal status — the notice must be visible
    // and contain a generic unavailable message (no raw error, URL, or scenario name).
    expect(noticeEl.hidden).toBe(false)
    expect(noticeEl.textContent.length).toBeGreaterThan(0)
    // Must not echo raw parse error, URL, status code, or scenario name
    expect(noticeEl.textContent).not.toContain('fixture-unknown-event')
    expect(noticeEl.textContent).not.toContain('fixture-malformed')
    expect(noticeEl.textContent).not.toContain('malformed_unavailable')
    expect(noticeEl.textContent).not.toContain('/stream')
    expect(noticeEl.textContent).not.toContain('200')

    handle.close()
  })

  it('noticeEl is hidden (silent) when stream closes after a terminal status for the run', async () => {
    // Contrast: when the stream closes normally after a terminal status, no notice.
    const noticeEl = makeFakeEl('div')
    const statusEl = makeFakeEl('span')
    statusEl.classList = {
      add(_cls: string) {},
      remove(_cls: string) {},
      contains(_cls: string) { return false },
    }

    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const succeededStatusFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-ok-terminal',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'COMPLETED',
      status: 'succeeded',
      startedAt: '2026-06-27T10:00:00Z',
      stale: false,
    })}\n\n`

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(readyFrame + succeededStatusFrame))
        controller.close()
      },
    })

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: {get: (h: string) => (h === 'content-type' ? 'text/event-stream' : null)},
      body: stream,
    }))
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeFakeEl(tag),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('addEventListener', () => {})

    const handle = initOperatorStream({runId: 'run-ok-terminal', statusEl, noticeEl})

    await new Promise(resolve => setTimeout(resolve, 50))

    // Terminal status received before close — notice must be silent
    expect(noticeEl.hidden).toBe(true)
    expect(noticeEl.textContent).toBe('')

    handle.close()
  })
})

// ---------------------------------------------------------------------------
// fixtureSessionId propagation to stream URL and approval client
// ---------------------------------------------------------------------------

describe('initOperatorStream — fixtureSessionId propagated to stream URL', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('stream URL includes fixtureSessionId as query param when provided', async () => {
    let capturedUrl: string | undefined

    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return {
        ok: true,
        status: 200,
        headers: {get: (h: string) => (h === 'content-type' ? 'text/event-stream' : null)},
        body: new ReadableStream({start(c) { c.close() }}),
      }
    })
    vi.stubGlobal('document', {
      createElement: () => ({style: {}, className: '', textContent: '', hidden: false, dataset: {}, setAttribute: () => {}, append: () => {}, remove: () => {}, querySelector: () => null, querySelectorAll: () => [], classList: {add: () => {}, remove: () => {}}, replaceAll: () => ''}),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('addEventListener', () => {})

    const statusEl = {textContent: '', className: '', classList: {add: () => {}}, dataset: {}, hidden: false, style: {}}
    const noticeEl = {textContent: '', hidden: false, dataset: {connectionState: ''}, setAttribute: () => {}}

    initOperatorStream({
      runId: 'run-fixture-001',
      statusEl,
      noticeEl,
      endpointBase: '/__fixture/operator',
      fixtureSessionId: 'fixture-session-0001',
    })

    await new Promise(resolve => setTimeout(resolve, 20))

    expect(capturedUrl).toBeDefined()
    expect(capturedUrl).toContain('fixtureSessionId=fixture-session-0001')
  })

  it('stream URL does NOT include fixtureSessionId when not provided (production path)', async () => {
    let capturedUrl: string | undefined

    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return {
        ok: true,
        status: 200,
        headers: {get: (h: string) => (h === 'content-type' ? 'text/event-stream' : null)},
        body: new ReadableStream({start(c) { c.close() }}),
      }
    })
    vi.stubGlobal('document', {
      createElement: () => ({style: {}, className: '', textContent: '', hidden: false, dataset: {}, setAttribute: () => {}, append: () => {}, remove: () => {}, querySelector: () => null, querySelectorAll: () => [], classList: {add: () => {}, remove: () => {}}, replaceAll: () => ''}),
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    })
    vi.stubGlobal('addEventListener', () => {})

    const statusEl = {textContent: '', className: '', classList: {add: () => {}}, dataset: {}, hidden: false, style: {}}
    const noticeEl = {textContent: '', hidden: false, dataset: {connectionState: ''}, setAttribute: () => {}}

    initOperatorStream({
      runId: 'run-prod-001',
      statusEl,
      noticeEl,
    })

    await new Promise(resolve => setTimeout(resolve, 20))

    expect(capturedUrl).toBeDefined()
    expect(capturedUrl).not.toContain('fixtureSessionId')
  })
})

describe('buildApprovalClient — fixtureSessionId propagated to approval requests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('decideRunApproval URL includes fixtureSessionId as query param when provided', async () => {
    let capturedUrl: string | undefined

    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return {ok: true, status: 200, json: async () => ({state: 'claimed'})}
    })

    const client = buildApprovalClient({
      endpointBase: '/__fixture/operator',
      fixtureSessionId: 'fixture-session-0001',
    })

    await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-001')

    expect(capturedUrl).toBeDefined()
    expect(capturedUrl).toContain('fixtureSessionId=fixture-session-0001')
  })

  it('decideRunApproval URL does NOT include fixtureSessionId in production mode', async () => {
    let capturedUrl: string | undefined

    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return {ok: true, status: 200, json: async () => ({state: 'claimed'})}
    })

    const client = buildApprovalClient({endpointBase: '/operator'})

    await client.decideRunApproval('run-001', 'req-001', 'once', 'idem-key-001')

    expect(capturedUrl).toBeDefined()
    expect(capturedUrl).not.toContain('fixtureSessionId')
  })

  it('listRunApprovals URL includes fixtureSessionId as query param when provided', async () => {
    let capturedUrl: string | undefined

    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return {ok: true, status: 200, json: async () => ({approvals: []})}
    })

    const client = buildApprovalClient({
      endpointBase: '/__fixture/operator',
      fixtureSessionId: 'fixture-session-0002',
    })

    await client.listRunApprovals('run-002')

    expect(capturedUrl).toBeDefined()
    expect(capturedUrl).toContain('fixtureSessionId=fixture-session-0002')
  })

  it('listRunApprovals URL does NOT include fixtureSessionId in production mode', async () => {
    let capturedUrl: string | undefined

    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return {ok: true, status: 200, json: async () => ({approvals: []})}
    })

    const client = buildApprovalClient({endpointBase: '/operator'})

    await client.listRunApprovals('run-002')

    expect(capturedUrl).toBeDefined()
    expect(capturedUrl).not.toContain('fixtureSessionId')
  })

  it('refreshCsrf URL includes fixtureSessionId as query param when provided', async () => {
    let capturedUrl: string | undefined

    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return {ok: true, status: 200, json: async () => ({csrfToken: 'tok'})}
    })

    const client = buildApprovalClient({
      endpointBase: '/__fixture/operator',
      fixtureSessionId: 'fixture-session-0003',
    })

    await client.refreshCsrf()

    expect(capturedUrl).toBeDefined()
    expect(capturedUrl).toContain('fixtureSessionId=fixture-session-0003')
  })

  it('refreshCsrf URL does NOT include fixtureSessionId in production mode', async () => {
    let capturedUrl: string | undefined

    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url
      return {ok: true, status: 200, json: async () => ({csrfToken: 'tok'})}
    })

    const client = buildApprovalClient({endpointBase: '/operator'})

    await client.refreshCsrf()

    expect(capturedUrl).toBeDefined()
    expect(capturedUrl).not.toContain('fixtureSessionId')
  })
})

// ---------------------------------------------------------------------------
// Late-frame guard — closed stream must not mutate shared noticeEl
// ---------------------------------------------------------------------------

describe('initOperatorStream — late-frame guard: closed stream does not mutate shared noticeEl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('after close(), updateDOM does not write to noticeEl (shared notice guard)', async () => {
    // Use fake DOM objects (no real document needed — test environment has no jsdom)
    const noticeEl = {
      textContent: 'Card B stream active',
      hidden: false,
      dataset: {connectionState: ''},
    }

    let resolveStream: ((value: {done: boolean; value?: Uint8Array}) => void) | undefined
    const streamPromise = new Promise<{done: boolean; value?: Uint8Array}>(resolve => {
      resolveStream = resolve
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => streamPromise,
        }),
      },
    }))

    const statusEl = {textContent: 'Pending', className: '', classList: {add: () => {}}, dataset: {}, hidden: false}

    const handle = initOperatorStream({
      runId: 'run-card-a',
      statusEl,
      noticeEl,
      endpointBase: '/operator',
    })

    // Close the stream (simulating card switch to card B)
    handle.close()

    // Resolve the stream reader with done=true (simulating stream end after close)
    resolveStream?.({done: true})

    // Give microtasks time to settle
    await new Promise(resolve => setTimeout(resolve, 20))

    // noticeEl should not have been mutated by the closed stream
    // (it should still say 'Card B stream active' — not a stream state message)
    const streamStateMessages = [
      'Connecting to run stream',
      'Stream version mismatch',
      'Run stream unavailable',
      'Stream temporarily unavailable',
      'Stream connection failed',
      'Run submitted',
      'Run stream ended',
    ]
    const currentText = noticeEl.textContent ?? ''
    for (const msg of streamStateMessages) {
      expect(currentText, `noticeEl should not contain "${msg}" after close`).not.toContain(msg)
    }
  })

  it('after close(), statusEl is not updated by late frames', async () => {
    const noticeEl = {textContent: '', hidden: false, dataset: {connectionState: ''}}

    let resolveStream: ((value: {done: boolean; value?: Uint8Array}) => void) | undefined
    const streamPromise = new Promise<{done: boolean; value?: Uint8Array}>(resolve => {
      resolveStream = resolve
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => streamPromise,
        }),
      },
    }))

    const statusEl = {textContent: 'Pending', className: '', classList: {add: () => {}}, dataset: {}, hidden: false}

    const handle = initOperatorStream({
      runId: 'run-card-a-status',
      statusEl,
      noticeEl,
      endpointBase: '/operator',
    })

    // Close the stream
    handle.close()

    const statusBefore = statusEl.textContent

    // Resolve with done
    resolveStream?.({done: true})
    await new Promise(resolve => setTimeout(resolve, 20))

    // statusEl should not have been updated to a stream-derived label after close
    expect(statusEl.textContent).toBe(statusBefore)
  })

  it('after close(), a late buffered frame writes to no DOM target at all (output/coalesced/approvals/badge/notice/status)', async () => {
    // A single early `aborted` guard at the top of updateDOM must cover every
    // write block, not just noticeEl/statusEl — this pins that regression.
    const noticeEl = {textContent: '', hidden: false, dataset: {connectionState: ''}}
    const statusEl = {textContent: 'Pending', className: '', classList: {add: () => {}}, dataset: {}, hidden: false}
    const outputEl = {textContent: '', hidden: true}
    const coalescedEl = {hidden: true}
    const approvalsEl = {hidden: true, append: () => {}}
    const badgeEl = {textContent: '', hidden: true}

    const encoder = new TextEncoder()
    const readyFrame = 'event: ready\ndata: {"contractVersion":"1.6.0"}\n\n'
    const outputFrame = `event: output\ndata: ${JSON.stringify({runId: 'run-late-frame', text: 'late output', final: false, seq: 0})}\n\n`
    const approvalFrame = `event: approval\ndata: ${JSON.stringify({runId: 'run-late-frame', requestID: 'req-late', permission: 'shell', settled: false})}\n\n`

    let readCount = 0
    // Only the ready frame is delivered before close(); output+approval frames
    // arrive in a SECOND chunk that resolves only after close() has run.
    let resolveSecondChunk: ((value: {done: boolean; value?: Uint8Array}) => void) | undefined
    const secondChunkPromise = new Promise<{done: boolean; value?: Uint8Array}>(resolve => {
      resolveSecondChunk = resolve
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount === 0) {
              readCount++
              return {done: false, value: encoder.encode(readyFrame)}
            }
            if (readCount === 1) {
              readCount++
              return secondChunkPromise
            }
            return {done: true}
          },
        }),
      },
    }))

    const handle = initOperatorStream({
      runId: 'run-late-frame',
      statusEl,
      noticeEl,
      outputEl,
      coalescedEl,
      approvalsEl,
      badgeEl,
      endpointBase: '/operator',
    })

    // Let the ready frame process.
    await new Promise(resolve => setTimeout(resolve, 20))

    // Snapshot all targets right after ready (before close, before the late frame).
    const snapshot = {
      noticeText: noticeEl.textContent,
      statusText: statusEl.textContent,
      outputText: outputEl.textContent,
      outputHidden: outputEl.hidden,
      coalescedHidden: coalescedEl.hidden,
      approvalsHidden: approvalsEl.hidden,
      badgeText: badgeEl.textContent,
      badgeHidden: badgeEl.hidden,
    }

    handle.close()

    // Now deliver the buffered output+approval frame — after close(), this must
    // not reach any DOM target.
    resolveSecondChunk?.({done: false, value: encoder.encode(outputFrame + approvalFrame)})
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(noticeEl.textContent).toBe(snapshot.noticeText)
    expect(statusEl.textContent).toBe(snapshot.statusText)
    expect(outputEl.textContent).toBe(snapshot.outputText)
    expect(outputEl.hidden).toBe(snapshot.outputHidden)
    expect(coalescedEl.hidden).toBe(snapshot.coalescedHidden)
    expect(approvalsEl.hidden).toBe(snapshot.approvalsHidden)
    expect(badgeEl.textContent).toBe(snapshot.badgeText)
    expect(badgeEl.hidden).toBe(snapshot.badgeHidden)
  })
})

describe('initOperatorStream — terminal run: immediate close preserves terminal state', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('terminal status frame before close preserves terminal state in statusEl', async () => {
    const noticeEl = {textContent: '', hidden: false, dataset: {connectionState: ''}}

    const encoder = new TextEncoder()
    const readyFrame = 'event: ready\ndata: {"contractVersion":"1.6.0"}\n\n'
    const terminalFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-terminal-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'COMPLETED',
      status: 'succeeded',
      startedAt: '2026-06-26T10:00:00Z',
      stale: false,
    })}\n\n`

    let readCount = 0
    const chunks = [encoder.encode(readyFrame + terminalFrame)]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount < chunks.length) {
              return {done: false, value: chunks[readCount++]}
            }
            return {done: true}
          },
        }),
      },
    }))

    const statusEl = {textContent: 'Pending', className: '', classList: {add: () => {}}, dataset: {}, hidden: false}

    initOperatorStream({
      runId: 'run-terminal-001',
      statusEl,
      noticeEl,
      endpointBase: '/operator',
    })

    // Wait for stream to process
    await new Promise(resolve => setTimeout(resolve, 50))

    // Terminal status should be reflected in statusEl
    expect(statusEl.textContent).toBe('Succeeded')
    // noticeEl should be hidden (terminal run, stream closed cleanly)
    expect(noticeEl.hidden).toBe(true)
  })
})

function makeUnavailableTestStatusEl(initial = 'Pending') {
  return {textContent: initial, className: 'status-queued', classList: {add(_cls: string) {}, remove() {}}, dataset: {}, hidden: false}
}

function makeUnavailableTestNoticeEl() {
  return {textContent: '', hidden: false, dataset: {connectionState: ''}}
}

describe('initOperatorStream — statusEl unavailable on stream failure', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('drift connection → statusEl shows "Unavailable" and gets status-unavailable class', async () => {
    const noticeEl = makeUnavailableTestNoticeEl()
    const statusEl = makeUnavailableTestStatusEl('Pending')

    const encoder = new TextEncoder()
    // Send a ready frame with a mismatched contract version → drift
    const driftReadyFrame = 'event: ready\ndata: {"contractVersion":"0.0.1"}\n\n'

    let readCount = 0
    const chunks = [encoder.encode(driftReadyFrame)]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount < chunks.length) {
              return {done: false, value: chunks[readCount++]}
            }
            return new Promise<{done: boolean}>(() => {}) // hang after chunks
          },
        }),
      },
    }))

    initOperatorStream({
      runId: 'run-drift-001',
      statusEl,
      noticeEl,
      endpointBase: '/operator',
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(statusEl.textContent).toBe('Unavailable')
    expect(statusEl.className).toContain('status-unavailable')
  })

  it('closed connection (non-terminal run) → statusEl shows "Unavailable" and gets status-unavailable class', async () => {
    const noticeEl = makeUnavailableTestNoticeEl()
    const statusEl = makeUnavailableTestStatusEl('Pending')

    const encoder = new TextEncoder()
    // Send a ready frame then close the stream without a terminal status
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`

    let readCount = 0
    const chunks = [encoder.encode(readyFrame)]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount < chunks.length) {
              return {done: false, value: chunks[readCount++]}
            }
            return {done: true} // stream closes without terminal status
          },
        }),
      },
    }))

    initOperatorStream({
      runId: 'run-closed-001',
      statusEl,
      noticeEl,
      endpointBase: '/operator',
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(statusEl.textContent).toBe('Unavailable')
    expect(statusEl.className).toContain('status-unavailable')
  })

  it('terminal succeeded label wins — not overwritten by closed state', async () => {
    const noticeEl = makeUnavailableTestNoticeEl()
    const statusEl = makeUnavailableTestStatusEl('Pending')

    const encoder = new TextEncoder()
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const terminalFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-terminal-win-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'COMPLETED',
      status: 'succeeded',
      startedAt: '2026-06-29T10:00:00Z',
      stale: false,
    })}\n\n`

    let readCount = 0
    const chunks = [encoder.encode(readyFrame + terminalFrame)]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount < chunks.length) {
              return {done: false, value: chunks[readCount++]}
            }
            return {done: true} // stream closes after terminal status
          },
        }),
      },
    }))

    initOperatorStream({
      runId: 'run-terminal-win-001',
      statusEl,
      noticeEl,
      endpointBase: '/operator',
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    // Terminal succeeded must win — not overwritten by "Unavailable"
    expect(statusEl.textContent).toBe('Succeeded')
    expect(statusEl.className).not.toContain('status-unavailable')
  })

  it('terminal failed label wins — not overwritten by closed state', async () => {
    const noticeEl = makeUnavailableTestNoticeEl()
    const statusEl = makeUnavailableTestStatusEl('Pending')

    const encoder = new TextEncoder()
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const terminalFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-terminal-failed-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'FAILED',
      status: 'failed',
      startedAt: '2026-06-29T10:00:00Z',
      stale: false,
    })}\n\n`

    let readCount = 0
    const chunks = [encoder.encode(readyFrame + terminalFrame)]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount < chunks.length) {
              return {done: false, value: chunks[readCount++]}
            }
            return {done: true}
          },
        }),
      },
    }))

    initOperatorStream({
      runId: 'run-terminal-failed-001',
      statusEl,
      noticeEl,
      endpointBase: '/operator',
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(statusEl.textContent).toBe('Failed')
    expect(statusEl.className).not.toContain('status-unavailable')
  })

  it('after close(), statusEl is not updated to Unavailable by late stream-closed event', async () => {
    const noticeEl = makeUnavailableTestNoticeEl()
    const statusEl = makeUnavailableTestStatusEl('Pending')

    let resolveStream: ((value: {done: boolean; value?: Uint8Array}) => void) | undefined
    const streamPromise = new Promise<{done: boolean; value?: Uint8Array}>(resolve => {
      resolveStream = resolve
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => streamPromise,
        }),
      },
    }))

    const handle = initOperatorStream({
      runId: 'run-late-frame-001',
      statusEl,
      noticeEl,
      endpointBase: '/operator',
    })

    // Close the stream (simulating card switch)
    handle.close()

    const statusBefore = statusEl.textContent

    // Resolve with done — triggers stream-closed dispatch
    resolveStream?.({done: true})
    await new Promise(resolve => setTimeout(resolve, 20))

    // statusEl must not have been updated to "Unavailable" after close
    expect(statusEl.textContent).toBe(statusBefore)
    expect(statusEl.textContent).not.toBe('Unavailable')
  })
})

describe('live failure reason updates and announcements', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('initOperatorStream with a failed status and known failureKind updates reasonEl', async () => {
    const noticeEl = {textContent: '', hidden: false, dataset: {connectionState: ''}}
    const statusEl = {textContent: 'Pending', className: '', classList: {add: () => {}, remove: () => {}}, dataset: {}, hidden: false}
    const reasonEl = {textContent: ''}

    const encoder = new TextEncoder()
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const terminalFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-reason-test-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'FAILED',
      status: 'failed',
      startedAt: '2026-06-29T10:00:00Z',
      stale: false,
      failureKind: 'inactivity-timeout',
    })}\n\n`

    let readCount = 0
    const chunks = [encoder.encode(readyFrame + terminalFrame)]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount < chunks.length) {
              return {done: false, value: chunks[readCount++]}
            }
            return {done: true}
          },
        }),
      },
    }))

    const handle = initOperatorStream({
      runId: 'run-reason-test-001',
      statusEl,
      noticeEl,
      reasonEl,
      endpointBase: '/operator',
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(statusEl.textContent).toBe('Failed')
    expect(reasonEl.textContent).toBe('No recent activity')
    handle.close()
  })

  it('live terminal failure transitions update the polite noticeEl exactly once', async () => {
    const noticeEl = {textContent: '', hidden: true, dataset: {connectionState: ''}}
    const statusEl = {textContent: 'Pending', className: '', classList: {add: () => {}, remove: () => {}}, dataset: {}, hidden: false}
    const reasonEl = {textContent: ''}

    const encoder = new TextEncoder()
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const runningFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-live-fail-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-29T10:00:00Z',
      stale: false,
    })}\n\n`
    const failedFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-live-fail-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'FAILED',
      status: 'failed',
      startedAt: '2026-06-29T10:02:00Z',
      stale: false,
      failureKind: 'workspace-unreachable',
    })}\n\n`

    let readCount = 0
    let resolveSecondFrame: ((value: {done: boolean; value?: Uint8Array}) => void) | undefined
    const secondFramePromise = new Promise<{done: boolean; value?: Uint8Array}>(resolve => {
      resolveSecondFrame = resolve
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount === 0) {
              readCount++
              return {done: false, value: encoder.encode(readyFrame + runningFrame)}
            }
            if (readCount === 1) {
              readCount++
              return secondFramePromise
            }
            return {done: true}
          },
        }),
      },
    }))

    const handle = initOperatorStream({
      runId: 'run-live-fail-001',
      statusEl,
      noticeEl,
      reasonEl,
      endpointBase: '/operator',
    })

    // Process ready + running
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(statusEl.textContent).toBe('Running')
    expect(noticeEl.textContent).toBe('') // Hidden while running

    // Transition to failed
    resolveSecondFrame?.({done: false, value: encoder.encode(failedFrame)})
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(statusEl.textContent).toBe('Failed')
    expect(reasonEl.textContent).toBe('Workspace unavailable')
    // noticeEl must contain the live polite announcement
    expect(noticeEl.textContent).toBe('Run failed: Workspace unavailable')
    expect(noticeEl.hidden).toBe(false)

    handle.close()
  })

  it('a stream whose very first status frame is already failed with a known reason still announces once', async () => {
    const noticeEl = {textContent: '', hidden: true, dataset: {connectionState: ''}}
    const statusEl = {textContent: 'Pending', className: '', classList: {add: () => {}, remove: () => {}}, dataset: {}, hidden: false}
    const reasonEl = {textContent: ''}

    const encoder = new TextEncoder()
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    // The run terminalized before the stream attached — the first (and only)
    // status frame this stream ever sees is already 'failed'.
    const failedFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-first-frame-failed-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'FAILED',
      status: 'failed',
      startedAt: '2026-06-29T10:02:00Z',
      stale: false,
      failureKind: 'session-error',
    })}\n\n`

    let readCount = 0
    const chunks = [encoder.encode(readyFrame + failedFrame)]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount < chunks.length) {
              return {done: false, value: chunks[readCount++]}
            }
            return {done: true}
          },
        }),
      },
    }))

    const handle = initOperatorStream({
      runId: 'run-first-frame-failed-001',
      statusEl,
      noticeEl,
      reasonEl,
      endpointBase: '/operator',
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(statusEl.textContent).toBe('Failed')
    expect(noticeEl.textContent).toBe('Run failed: Session error')
    expect(noticeEl.hidden).toBe(false)

    handle.close()
  })

  it('duplicate failed status frames for the same run do not re-announce', async () => {
    const noticeEl = {textContent: '', hidden: true, dataset: {connectionState: ''}}
    const statusEl = {textContent: 'Pending', className: '', classList: {add: () => {}, remove: () => {}}, dataset: {}, hidden: false}
    const reasonEl = {textContent: ''}

    const encoder = new TextEncoder()
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const failedFrameData = {
      runId: 'run-dup-failed-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'FAILED',
      status: 'failed',
      startedAt: '2026-06-29T10:02:00Z',
      stale: false,
      failureKind: 'stream-ended',
    }
    const failedFrame = `event: status\ndata: ${JSON.stringify(failedFrameData)}\n\n`
    // A duplicate/replayed failed frame for the same run — must not re-trigger the announcement.
    const duplicateFailedFrame = `event: status\ndata: ${JSON.stringify(failedFrameData)}\n\n`

    let readCount = 0
    const chunks = [encoder.encode(readyFrame + failedFrame + duplicateFailedFrame)]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount < chunks.length) {
              return {done: false, value: chunks[readCount++]}
            }
            return {done: true}
          },
        }),
      },
    }))

    const handle = initOperatorStream({
      runId: 'run-dup-failed-001',
      statusEl,
      noticeEl,
      reasonEl,
      endpointBase: '/operator',
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(noticeEl.textContent).toBe('Run failed: Stream ended early')
    // A single announcement — no accumulation/duplication from the repeated frame.
    expect(noticeEl.textContent).not.toContain('Run failed: Stream ended early Run failed')

    handle.close()
  })

  it('a page-load reason already painted on reasonEl survives a running/replay frame that carries no reasonLabel of its own', async () => {
    const noticeEl = {textContent: '', hidden: true, dataset: {connectionState: ''}}
    const statusEl = {textContent: 'Failed', className: 'run-status status-failed', classList: {add: () => {}, remove: () => {}}, dataset: {}, hidden: false}
    const reasonEl = {textContent: 'No recent activity', dataset: {reasonState: 'present'}}

    const encoder = new TextEncoder()
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const runningFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-reason-persist-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-29T10:00:00Z',
      stale: false,
    })}\n\n`

    let readCount = 0
    const chunks = [encoder.encode(readyFrame + runningFrame)]
    // Keep the stream open (never resolve `done: true`) after the initial chunk —
    // this exercises the "still live, mid-stream, no reason on this frame" case,
    // not a stream that has since closed (closed + non-terminal is its own,
    // separately-tested clearing case).
    const pendingRead = new Promise(() => {})

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount < chunks.length) {
              return {done: false, value: chunks[readCount++]}
            }
            return pendingRead
          },
        }),
      },
    }))

    const handle = initOperatorStream({
      runId: 'run-reason-persist-001',
      statusEl,
      noticeEl,
      reasonEl,
      endpointBase: '/operator',
    })

    await new Promise(resolve => setTimeout(resolve, 30))

    // The pre-existing page-load reason must survive — the running frame carries no
    // reasonLabel of its own, so it must not clear a previously painted safe label.
    expect(reasonEl.textContent).toBe('No recent activity')
    expect(reasonEl.dataset.reasonState).toBe('present')

    handle.close()
  })

  it('reasonEl clears when the stream enters an unavailable/non-terminal state (e.g. not-found)', async () => {
    const noticeEl = {textContent: '', hidden: true, dataset: {connectionState: ''}}
    const statusEl = {textContent: '', className: '', classList: {add: () => {}, remove: () => {}}, dataset: {}, hidden: false}
    const reasonEl = {textContent: 'No recent activity', dataset: {reasonState: 'present'}}

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: {get: () => null},
    }))

    const handle = initOperatorStream({
      runId: 'run-reason-clear-001',
      statusEl,
      noticeEl,
      reasonEl,
      endpointBase: '/operator',
    })

    await new Promise(resolve => setTimeout(resolve, 30))

    expect(noticeEl.dataset.connectionState).toBe('not-found')
    // A stale reason must not linger once the stream can no longer vouch for the run's outcome.
    expect(reasonEl.textContent).toBe('')
    expect(reasonEl.dataset.reasonState).toBeUndefined()

    handle.close()
  })

  it('reasonEl and the notice element both expose data-reason-state / data-connection-state as safe machine-readable tokens, never the raw label or failureKind', async () => {
    const noticeEl = {textContent: '', hidden: true, dataset: {connectionState: ''}}
    const statusEl = {textContent: 'Pending', className: '', classList: {add: () => {}, remove: () => {}}, dataset: {}, hidden: false}
    const reasonEl: {textContent: string; dataset: Record<string, string>} = {textContent: '', dataset: {}}

    const encoder = new TextEncoder()
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
    const failedFrame = `event: status\ndata: ${JSON.stringify({
      runId: 'run-reason-state-attr-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'FAILED',
      status: 'failed',
      startedAt: '2026-06-29T10:02:00Z',
      stale: false,
      failureKind: 'max-duration-timeout',
    })}\n\n`

    let readCount = 0
    const chunks = [encoder.encode(readyFrame + failedFrame)]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            if (readCount < chunks.length) {
              return {done: false, value: chunks[readCount++]}
            }
            return {done: true}
          },
        }),
      },
    }))

    const handle = initOperatorStream({
      runId: 'run-reason-state-attr-001',
      statusEl,
      noticeEl,
      reasonEl,
      endpointBase: '/operator',
    })

    await new Promise(resolve => setTimeout(resolve, 30))

    expect(reasonEl.dataset.reasonState).toBe('present')
    // Never the raw failureKind wire value or the resolved label text in the attribute.
    expect(reasonEl.dataset.reasonState).not.toBe('max-duration-timeout')
    expect(reasonEl.dataset.reasonState).not.toBe('Run timed out')

    handle.close()
  })
})

describe('PHASE_TO_WEB_STATUS local mirror — drift parity', () => {
  it('matches the vendored src/gateway/operator-contract/run-status.ts mapping exactly', () => {
    expect(PHASE_TO_WEB_STATUS).toEqual(VENDORED_PHASE_TO_WEB_STATUS)
  })

  it('maps every TerminalPhase to the safe cancelled/succeeded/failed statuses', () => {
    expect(PHASE_TO_WEB_STATUS.CANCELLED).toBe('cancelled')
    expect(PHASE_TO_WEB_STATUS.COMPLETED).toBe('succeeded')
    expect(PHASE_TO_WEB_STATUS.FAILED).toBe('failed')
  })
})

interface FakeCancelOutcome {
  success: boolean
  data?: {ok: true; runId: string; phase: string}
  error?: {kind: string; status?: number}
}

/** Build a fake cancel client for renderCancelControl tests. */
function makeFakeCancelClient(opts: {
  cancelResult?: FakeCancelOutcome
  cancelResults?: FakeCancelOutcome[]
  refreshCsrfResult?: {success: boolean; data?: {csrfToken: string}; error?: {kind: string; status?: number}}
} = {}) {
  const cancelCalls: {runId: string; idempotencyKey: string; csrfToken: string}[] = []
  let callIndex = 0
  return {
    cancelCalls,
    client: {
      refreshCsrf: async () => opts.refreshCsrfResult ?? {success: true, data: {csrfToken: 'test-csrf'}},
      cancelRun: async (runId: string, idempotencyKey: string, csrfToken: string): Promise<FakeCancelOutcome> => {
        cancelCalls.push({runId, idempotencyKey, csrfToken})
        if (opts.cancelResults !== undefined) {
          const result = opts.cancelResults[Math.min(callIndex, opts.cancelResults.length - 1)]
          callIndex++
          return result ?? {success: true, data: {ok: true, runId, phase: 'CANCELLED'}}
        }
        return opts.cancelResult ?? {success: true, data: {ok: true, runId, phase: 'CANCELLED'}}
      },
    } as unknown as Parameters<typeof renderCancelControl>[1],
  }
}

function stubCancelRenderEnv() {
  vi.stubGlobal('document', {
    createElement: (tag: string) => makeFakeEl(tag),
    querySelector: () => null,
    readyState: 'complete',
    addEventListener: () => {},
  })
  vi.stubGlobal('fetch', async () => new Promise<Response>(() => {}))
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('crypto', {randomUUID: () => 'test-uuid-cancel'})
}

describe('renderCancelControl — two-step confirm interaction', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('happy path: idle renders one Cancel button; click arms Confirm/Dismiss', () => {
    stubCancelRenderEnv()
    const {client} = makeFakeCancelClient()
    const {el} = renderCancelControl('run-001', client, () => {}) as unknown as {el: FakeElement}

    expect(el.dataset.state).toBe('idle')
    let buttons = findVisibleButtons(el)
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toBe('Cancel run')

    buttons[0]?.dispatchEvent({type: 'click'})
    expect(el.dataset.state).toBe('armed')
    buttons = findVisibleButtons(el)
    expect(buttons.map(b => b.textContent).sort()).toEqual(['Confirm cancel', 'Dismiss'])
  })

  it('happy path: confirm issues cancelRun and dispatches onCancelDispatch, then renders cancelled', async () => {
    stubCancelRenderEnv()
    const {client, cancelCalls} = makeFakeCancelClient()
    const dispatchCalls: string[] = []
    const {el} = renderCancelControl('run-001', client, runId => {
      dispatchCalls.push(runId)
    }) as unknown as {el: FakeElement}

    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(dispatchCalls).toEqual(['run-001'])
    expect(cancelCalls).toHaveLength(1)
    expect(el.dataset.state).toBe('cancelled')
    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/stopped/i)
  })

  it('happy path: already-terminal phase (COMPLETED) is rendered as the benign cancelled state', async () => {
    stubCancelRenderEnv()
    const {client} = makeFakeCancelClient({
      cancelResult: {success: true, data: {ok: true, runId: 'run-001', phase: 'COMPLETED'}},
    })
    const {el} = renderCancelControl('run-001', client, () => {}) as unknown as {el: FakeElement}

    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(el.dataset.state).toBe('cancelled')
    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).not.toMatch(/error|unavailable|fail/i)
  })

  it('edge: dismiss from armed returns to idle with a single Cancel button, no cancelRun call', () => {
    stubCancelRenderEnv()
    const {client, cancelCalls} = makeFakeCancelClient()
    const {el} = renderCancelControl('run-001', client, () => {}) as unknown as {el: FakeElement}

    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Dismiss')?.dispatchEvent({type: 'click'})

    expect(el.dataset.state).toBe('idle')
    const buttons = findVisibleButtons(el)
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toBe('Cancel run')
    expect(cancelCalls).toHaveLength(0)
  })

  it('edge: a11y status node has role=status and aria-live=polite', () => {
    stubCancelRenderEnv()
    const {client} = makeFakeCancelClient()
    const {el} = renderCancelControl('run-001', client, () => {}) as unknown as {el: FakeElement}
    const statusEl = findStatusElement(el)
    expect(statusEl?.attributes.role).toBe('status')
    expect(statusEl?.attributes['aria-live']).toBe('polite')
  })

  it('edge: in-flight mutex blocks a second concurrent cancel', async () => {
    stubCancelRenderEnv()
    let resolveCancel!: (v: {success: boolean; data: {ok: true; runId: string; phase: string}}) => void
    const cancelPromise = new Promise<{success: boolean; data: {ok: true; runId: string; phase: string}}>(resolve => {
      resolveCancel = resolve
    })
    const cancelCalls: string[] = []
    const client = {
      refreshCsrf: async () => ({success: true, data: {csrfToken: 'csrf'}}),
      cancelRun: async (runId: string) => {
        cancelCalls.push(runId)
        return cancelPromise
      },
    }
    const {el} = renderCancelControl('run-001', client as unknown as Parameters<typeof renderCancelControl>[1], () => {}) as unknown as {el: FakeElement}

    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    const confirmBtn = findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')
    confirmBtn?.dispatchEvent({type: 'click'})
    confirmBtn?.dispatchEvent({type: 'click'}) // second confirm while pending must be a no-op (disabled + mutex)
    resolveCancel({success: true, data: {ok: true, runId: 'run-001', phase: 'CANCELLED'}})
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(cancelCalls).toHaveLength(1)
  })

  it('error: 404 renders the unavailable state', async () => {
    stubCancelRenderEnv()
    const {client} = makeFakeCancelClient({
      cancelResult: {success: false, error: {kind: 'http', status: 404}},
    })
    const {el} = renderCancelControl('run-001', client, () => {}) as unknown as {el: FakeElement}
    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(el.dataset.state).toBe('unavailable')
    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/unavailable/i)
  })

  it('error: 503 retries up to CANCEL_RETRY_MAX_ATTEMPTS then falls to unavailable', async () => {
    vi.useFakeTimers()
    stubCancelRenderEnv()
    const results = Array.from({length: CANCEL_RETRY_MAX_ATTEMPTS + 1}, () => ({
      success: false as const,
      error: {kind: 'http', status: 503},
    }))
    const {client, cancelCalls} = makeFakeCancelClient({cancelResults: results})
    const {el} = renderCancelControl('run-001', client, () => {}) as unknown as {el: FakeElement}

    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await vi.advanceTimersByTimeAsync(0)
    expect(el.dataset.state).toBe('retrying')

    for (let i = 0; i < CANCEL_RETRY_MAX_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(el.dataset.state).toBe('unavailable')
    expect(cancelCalls.length).toBe(CANCEL_RETRY_MAX_ATTEMPTS + 1)
    vi.useRealTimers()
  })

  it('error: persistent 400/401/403 renders session-expired, not a retry loop', async () => {
    stubCancelRenderEnv()
    const {client, cancelCalls} = makeFakeCancelClient({
      cancelResult: {success: false, error: {kind: 'http', status: 401}},
    })
    const {el} = renderCancelControl('run-001', client, () => {}) as unknown as {el: FakeElement}
    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(el.dataset.state).toBe('session-expired')
    expect(cancelCalls).toHaveLength(1) // no loop
    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).toMatch(/session.*expired|reload/i)
  })

  it('error: network failure renders retryable transport-failure', async () => {
    stubCancelRenderEnv()
    const {client} = makeFakeCancelClient({
      cancelResult: {success: false, error: {kind: 'network'}},
    })
    const {el} = renderCancelControl('run-001', client, () => {}) as unknown as {el: FakeElement}
    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(el.dataset.state).toBe('transport-failure')
    const buttons = findVisibleButtons(el)
    expect(buttons.some(b => b.textContent === 'Try again')).toBe(true)
  })

  it('error: protocol failure falls to the generic unavailable state', async () => {
    stubCancelRenderEnv()
    const {client} = makeFakeCancelClient({
      cancelResult: {success: false, error: {kind: 'protocol'}},
    })
    const {el} = renderCancelControl('run-001', client, () => {}) as unknown as {el: FakeElement}
    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(el.dataset.state).toBe('unavailable')
  })

  it('integration: no raw runId, phase, or status code reaches rendered text', async () => {
    stubCancelRenderEnv()
    const {client} = makeFakeCancelClient({
      cancelResult: {success: false, error: {kind: 'http', status: 503}},
    })
    const {el} = renderCancelControl('run-sensitive-001', client, () => {}) as unknown as {el: FakeElement}
    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))
    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent).not.toContain('run-sensitive-001')
    expect(statusEl?.textContent).not.toContain('503')
    expect(statusEl?.textContent).not.toMatch(/CANCELLED|COMPLETED|FAILED/)
  })

  it('integration: notifyTerminal stops a pending retry and renders cancelled (terminal-wins)', async () => {
    vi.useFakeTimers()
    stubCancelRenderEnv()
    const {client} = makeFakeCancelClient({
      cancelResult: {success: false, error: {kind: 'http', status: 503}},
    })
    const {el, notifyTerminal} = renderCancelControl('run-001', client, () => {}) as unknown as {
      el: FakeElement
      notifyTerminal: () => void
    }
    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await vi.advanceTimersByTimeAsync(0)
    expect(el.dataset.state).toBe('retrying')

    notifyTerminal()
    expect(el.dataset.state).toBe('cancelled')

    // Advancing timers past the retry delay must not re-arm anything.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(el.dataset.state).toBe('cancelled')
    vi.useRealTimers()
  })

  it('terminal-during-pending: notifyTerminal fires while issueCancel is still pending; the pending call later resolving 503 must not re-arm a retry or issue another cancelRun', async () => {
    stubCancelRenderEnv()
    let resolveCancel!: (v: {success: boolean; error: {kind: string; status: number}}) => void
    const pendingResult = new Promise<{success: boolean; error: {kind: string; status: number}}>(resolve => {
      resolveCancel = resolve
    })
    const cancelCalls: string[] = []
    const client = {
      refreshCsrf: async () => ({success: true, data: {csrfToken: 'csrf'}}),
      cancelRun: async (runId: string) => {
        cancelCalls.push(runId)
        return pendingResult
      },
    }
    const {el, notifyTerminal} = renderCancelControl(
      'run-001',
      client as unknown as Parameters<typeof renderCancelControl>[1],
      () => {},
    ) as unknown as {el: FakeElement; notifyTerminal: () => void}

    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    // Allow the refreshCsrf microtask to resolve so cancelRun is actually invoked.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cancelCalls).toHaveLength(1)

    // Terminal wins from the live stream while the cancel POST is still in flight.
    notifyTerminal()
    expect(el.dataset.state).toBe('cancelled')

    // Now the stale cancel resolves with a transient 503 — must be discarded.
    resolveCancel({success: false, error: {kind: 'http', status: 503}})
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(el.dataset.state).toBe('cancelled')
    expect(cancelCalls).toHaveLength(1) // no re-issued cancelRun
  })

  it('terminal-during-pending: notifyTerminal fires while refreshCsrf is still pending — the resolved CSRF must not trigger a cancelRun POST', async () => {
    stubCancelRenderEnv()
    let resolveCsrf!: (v: {success: boolean; data: {csrfToken: string}}) => void
    const pendingCsrf = new Promise<{success: boolean; data: {csrfToken: string}}>(resolve => {
      resolveCsrf = resolve
    })
    const cancelCalls: string[] = []
    const client = {
      refreshCsrf: async () => pendingCsrf,
      cancelRun: async (runId: string) => {
        cancelCalls.push(runId)
        return {success: true, data: {ok: true, runId, phase: 'CANCELLED'}}
      },
    }
    const {el, notifyTerminal} = renderCancelControl(
      'run-001',
      client as unknown as Parameters<typeof renderCancelControl>[1],
      () => {},
    ) as unknown as {el: FakeElement; notifyTerminal: () => void}

    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})

    notifyTerminal()
    expect(el.dataset.state).toBe('cancelled')

    resolveCsrf({success: true, data: {csrfToken: 'csrf-late'}})
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(cancelCalls).toHaveLength(0) // cancelRun must never be sent after terminal won
    expect(el.dataset.state).toBe('cancelled')
  })

  it('dispose: after entering the retrying state, dispose() prevents any further refreshCsrf/cancelRun calls when timers advance', async () => {
    vi.useFakeTimers()
    stubCancelRenderEnv()
    const {client, cancelCalls} = makeFakeCancelClient({
      cancelResult: {success: false, error: {kind: 'http', status: 503}},
    })
    const {el, dispose} = renderCancelControl('run-001', client, () => {}) as unknown as {
      el: FakeElement
      dispose: () => void
    }
    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await vi.advanceTimersByTimeAsync(0)
    expect(el.dataset.state).toBe('retrying')
    expect(cancelCalls).toHaveLength(1)

    dispose()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(cancelCalls).toHaveLength(1) // no further cancelRun calls
    vi.useRealTimers()
  })

  it('no-false-stopped: a run that goes terminal without any operator cancel does not show "Run stopped."', () => {
    stubCancelRenderEnv()
    const {client} = makeFakeCancelClient()
    const {el, notifyTerminal} = renderCancelControl('run-001', client, () => {}) as unknown as {
      el: FakeElement
      notifyTerminal: () => void
    }

    // No cancel button was ever clicked — the run simply completes on its own.
    notifyTerminal()

    const statusEl = findStatusElement(el)
    expect(statusEl?.textContent ?? '').not.toMatch(/stopped/i)
  })

  it('thrown client: an injected cancelClient whose cancelRun throws resets the mutex and shows transport-failure', async () => {
    stubCancelRenderEnv()
    const client: {refreshCsrf: () => Promise<unknown>; cancelRun: () => Promise<unknown>} = {
      refreshCsrf: async () => ({success: true, data: {csrfToken: 'csrf'}}),
      cancelRun: async () => {
        throw new Error('boom')
      },
    }
    const {el} = renderCancelControl(
      'run-001',
      client as Parameters<typeof renderCancelControl>[1],
      () => {},
    ) as unknown as {el: FakeElement}

    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(el.dataset.state).toBe('transport-failure')

    // The mutex was reset — a subsequent Try again click issues another attempt.
    const client2Calls: string[] = []
    client.cancelRun = async () => {
      client2Calls.push('called')
      return {success: true, data: {ok: true, runId: 'run-001', phase: 'CANCELLED'}}
    }
    findVisibleButtons(el).find(b => b.textContent === 'Try again')?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(client2Calls).toHaveLength(1)
    expect(el.dataset.state).toBe('cancelled')
  })

  it('thrown client: an injected cancelClient whose refreshCsrf throws resets the mutex and shows transport-failure', async () => {
    stubCancelRenderEnv()
    const client = {
      refreshCsrf: async () => {
        throw new Error('boom')
      },
      cancelRun: async (runId: string) => ({success: true, data: {ok: true, runId, phase: 'CANCELLED'}}),
    }
    const {el} = renderCancelControl(
      'run-001',
      client as unknown as Parameters<typeof renderCancelControl>[1],
      () => {},
    ) as unknown as {el: FakeElement}

    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click'})
    findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')?.dispatchEvent({type: 'click'})
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(el.dataset.state).toBe('transport-failure')
  })

  it('card-bubbling: clicking Cancel/Confirm/Dismiss stops propagation so a parent click listener is never invoked', () => {
    stubCancelRenderEnv()
    const {client} = makeFakeCancelClient()
    const {el} = renderCancelControl('run-001', client, () => {}) as unknown as {el: FakeElement}

    // Simulate a parent card whose click listener would run unless stopPropagation halts bubbling.
    const cancelBtn = findVisibleButtons(el).find(b => b.textContent === 'Cancel run')
    let propagationStopped = false
    const clickEvent = {
      type: 'click',
      stopPropagation: () => {
        propagationStopped = true
      },
    }
    cancelBtn?.dispatchEvent(clickEvent)
    expect(propagationStopped).toBe(true)

    const confirmBtn = findVisibleButtons(el).find(b => b.textContent === 'Confirm cancel')
    propagationStopped = false
    confirmBtn?.dispatchEvent(clickEvent)
    expect(propagationStopped).toBe(true)

    // Re-arm to test Dismiss too.
    findVisibleButtons(el).find(b => b.textContent === 'Cancel run')?.dispatchEvent({type: 'click', stopPropagation: () => {}})
    const dismissBtn = findVisibleButtons(el).find(b => b.textContent === 'Dismiss')
    propagationStopped = false
    dismissBtn?.dispatchEvent(clickEvent)
    expect(propagationStopped).toBe(true)
  })
})

describe('CSS selector ↔ cancel-control state emitter agreement', () => {
  it('has a rule for every emitted cancel-control class/dataset state token', async () => {
    const fs = await import('node:fs/promises')
    const cssPath = new URL('../web/src/index.css', import.meta.url).pathname
    const cssContent = await fs.readFile(cssPath, 'utf8')

    const requiredClassTokens = [
      '.run-cancel-control',
      '.run-cancel-status',
      '.run-cancel-controls',
      '.run-cancel-btn-cancel',
      '.run-cancel-btn-confirm',
      '.run-cancel-btn-dismiss',
      '.run-cancel-btn-retry',
    ]
    for (const token of requiredClassTokens) {
      expect(cssContent).toContain(token)
    }

    const requiredStateTokens = ['idle', 'armed', 'pending', 'retrying', 'cancelled', 'unavailable', 'session-expired', 'transport-failure']
    for (const state of requiredStateTokens) {
      expect(cssContent).toContain(`[data-state="${state}"]`)
    }
  })
})
