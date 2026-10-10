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

import type {
  ApprovalFrameDataOpen,
  OutputFrameData,
  QuestionClient,
  QuestionDecision,
  QuestionDecisionOutcome,
  QuestionListResult,
  QuestionReconcileEvent,
  RunEntry,
  StreamHandle,
  StreamState,
} from '../public/operator-stream.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  bootstrapOperatorStreams,
  buildApprovalClient,
  buildCancelClient,
  buildQuestionClient,
  CANCEL_RETRY_MAX_ATTEMPTS,
  CHECKOUT_FAILURE_FLAG_LABELS,
  CHECKOUT_LAYOUT_REASON_LABELS,
  CHECKOUT_OBSTRUCTION_KIND_LABELS,
  CHECKOUT_OPERATION_LABELS,
  CHECKOUT_PREPARATION_HEADLINE_LABELS,
  CHECKOUT_PROVENANCE_LABELS,
  CHECKOUT_REFUSAL_REASON_LABELS,
  CHECKOUT_UPDATE_FAILURE_REASON_LABELS,
  FAILURE_REASON_LABELS,
  fillLabelTemplate,
  FIRST_FRAME_TIMEOUT_MS,
  GATEWAY_PENDING_APPROVALS_CAP,
  GATEWAY_PENDING_QUESTIONS_CAP,
  getEffectiveStatus,
  getOpenApprovals,
  getOpenQuestions,
  getQuestionPageStore,
  hasOpenApprovals,
  hasOpenQuestions,
  initOperatorStream,
  MAX_APPROVAL_TOMBSTONES,
  MAX_OPEN_APPROVALS,
  MAX_OPEN_QUESTIONS,
  MAX_OUTPUT_TEXT_CHARS,
  MAX_SSE_BUFFER_BYTES,
  nextStreamState,
  parseSseFrame,
  PHASE_TO_WEB_STATUS,
  PINNED_CONTRACT_VERSION,
  QUESTION_CLAIM_RECHECK_DELAYS_MS,
  QUESTION_DECISION_STATES,
  QUESTION_INVALID_REASONS,
  renderApprovalPrompt,
  renderCancelControl,
  resetBootstrapState,
  resetQuestionPageStore,
  RETRY_BASE_MS,
  RETRY_FACTOR,
  RETRY_MAX_COUNT,
  sanitizeCheckoutText,
  toSafeRunView,
} from '../public/operator-stream.js'
import {
  CHECKOUT_OPERATIONS,
  CHECKOUT_REFUSAL_REASONS,
  LAYOUT_REFUSAL_REASONS,
  MAX_OPTIONS_PER_QUESTION,
  MAX_QUESTIONS_PER_REQUEST,
  OBSTRUCTION_KINDS,
  OPERATOR_CONTRACT_VERSION,
  QUESTION_HEADER_MAX_LENGTH,
  QUESTION_OPTION_DESCRIPTION_MAX_LENGTH,
  QUESTION_OPTION_LABEL_MAX_LENGTH,
  QUESTION_TEXT_MAX_LENGTH,
  UPDATE_FAILURE_REASONS,
  PHASE_TO_WEB_STATUS as VENDORED_PHASE_TO_WEB_STATUS,
  QUESTION_DECISION_STATES as VENDORED_QUESTION_DECISION_STATES,
  QUESTION_INVALID_REASONS as VENDORED_QUESTION_INVALID_REASONS,
} from '../src/gateway/operator-contract/index.ts'
import {OPERATOR_FAILURE_KINDS} from '../src/gateway/operator-contract/run-status.ts'
import {FIXTURE_RUN_ID_FOR_TESTS, FIXTURE_SCENARIO_NAMES, serializeScenarioToSse} from '../src/gateway/operator-fixture-sse.ts'
import {parseSseChunk} from '../src/gateway/operator-sse-reader.ts'

const Q_RUN = 'run-q-001'

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
    // no-snapshot no longer reconnects (#583); a transient reason still does.
    const state = nextStreamState(liveState, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'writer-error'},
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

  it('does not reconnect on no-snapshot reset when the run is terminal (fro-bot/agent#1639)', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const withTerminal = nextStreamState(liveState, {
      type: 'status',
      data: TERMINAL_STATUS,
    })
    // no-snapshot for a finished run is a stable fact, not a transient hiccup — every
    // retry gets a byte-identical response, so reconnecting can never help.
    const liveWithTerminal: StreamState = {...withTerminal, connection: 'live'}
    const state = nextStreamState(liveWithTerminal, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'no-snapshot'},
    })
    expect(state.shouldReconnect).toBe(false)
    expect(state.connection).toBe('closed')
    expect(state.retryCount).toBe(withTerminal.retryCount)
  })

  it('keeps the connection live on no-snapshot reset when the run is still active (#583)', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const withActive = nextStreamState(liveState, {
      type: 'status',
      data: ACTIVE_STATUS,
    })
    // The gateway keeps the subscription open after no-snapshot, so a reconnect would park on a
    // reader that never ends. Stay live, spend no retry, and keep accepting frames.
    const state = nextStreamState(withActive, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'no-snapshot'},
    })
    expect(state.connection).toBe('live')
    expect(state.shouldReconnect).toBe(false)
    expect(state.retryCount).toBe(withActive.retryCount)
  })

  it('keeps the connection live on no-snapshot reset when the run entry is unknown (#583)', () => {
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    // No status frame and no terminal summary: unknown is not evidence of terminal, so the
    // connection stays live instead of reconnecting.
    const state = nextStreamState(liveState, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'no-snapshot'},
    })
    expect(state.connection).toBe('live')
    expect(state.shouldReconnect).toBe(false)
    expect(state.retryCount).toBe(liveState.retryCount)
  })

  it('ends the production ready → reset:no-snapshot sequence for a terminal run in a settled, non-reconnecting state', () => {
    // Mirrors the exact captured wire sequence: ready, then reset with reason
    // no-snapshot, for a run that is already known-terminal client-side.
    const liveState = nextStreamState(INITIAL_STATE, {
      type: 'ready',
      data: {contractVersion: PINNED_CONTRACT_VERSION},
    })
    const withTerminal = nextStreamState(liveState, {
      type: 'status',
      data: TERMINAL_STATUS,
    })
    const state = nextStreamState(withTerminal, {
      type: 'reset',
      data: {runId: 'run-abc', reason: 'no-snapshot'},
    })
    expect(state.connection).not.toBe('reconnecting')
    expect(state.connection).toBe('closed')
    expect(state.shouldReconnect).toBe(false)
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

  it('PINNED_CONTRACT_VERSION is a well-formed version literal (its value is checked only against the server constant)', () => {
    expect(PINNED_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
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
      data: {runId: 'run-abc', reason: 'shutdown'},
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
      data: {runId: 'run-abc', reason: 'shutdown'},
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
        data: {runId: 'run-abc', reason: 'shutdown'},
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
  type: string
  name: string
  value: string
  checked: boolean
  disabled: boolean
  tabIndex: number
  parent?: FakeElement
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
  const el: FakeElement = {
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
    type: '',
    name: '',
    value: '',
    checked: false,
    disabled: false,
    tabIndex: 0,
    children: [],
    attributes: {},
    style: {},
    dataset: {},
    eventListeners: {},
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
        if (sel.split(',').some(selector => selector.trim() === child.tagName)) {
          results.push(child)
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
        node.remove()
        el.children.push(node)
        node.parent = el
      }
    },
    remove() {
      if (el.parent !== undefined) {
        el.parent.children = el.parent.children.filter(child => child !== el)
        el.parent = undefined
      }
    },
    setAttribute(name: string, value: string) {
      el.attributes[name] = value
    },
    getAttribute(name: string): string | null {
      return el.attributes[name] ?? null
    },
    classList: {
      add(cls: string) { if (!el.className.split(/\s+/).includes(cls)) el.className = `${el.className} ${cls}`.trim() },
      remove(cls: string) { el.className = el.className.split(/\s+/).filter(token => token !== cls).join(' ') },
      contains(cls: string) { return el.className.split(/\s+/).includes(cls) },
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
  }
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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const resetChunk = `event: reset\ndata: ${JSON.stringify({runId: 'run-001', reason: 'shutdown'})}\n\n`

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
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
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
    const readyFrame = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`
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
    expect(reasonEl.textContent).toBe('Workspace unreachable')
    // noticeEl must contain the live polite announcement
    expect(noticeEl.textContent).toBe('Run failed: Workspace unreachable')
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

describe('CSS selector ↔ checkout-detail emitter agreement', () => {
  it('has a rule for every checkout-detail class the renderer emits and for the region selector', async () => {
    const fs = await import('node:fs/promises')
    const css = await fs.readFile(new URL('../web/src/index.css', import.meta.url).pathname, 'utf8')
    const source = await fs.readFile(new URL('../public/operator-stream.js', import.meta.url).pathname, 'utf8')

    // Every class token the renderer can emit: the root, and each `checkout-detail__*` element.
    const emitted = [...new Set(source.match(/(?<![\w-])checkout-detail(?:__[a-z]+)?(?![\w-])/g) ?? [])]
    expect(emitted).toEqual(expect.arrayContaining([
      'checkout-detail',
      'checkout-detail__line',
      'checkout-detail__list',
      'checkout-detail__item',
      'checkout-detail__overflow',
      'checkout-detail__preparation',
      'checkout-detail__flags',
    ]))
    for (const token of emitted) {
      expect(css, `no CSS rule for .${token}`).toMatch(new RegExp(String.raw`\.${token}(?![\w-])`))
    }

    // The region the stream renders into is styled by its data-role selector, shown or hidden.
    expect(css).toContain('[data-role="run-checkout-detail"] {')
    expect(css).toContain('[data-role="run-checkout-detail"][hidden]')
  })
})

describe('CSS selector ↔ question-region emitter agreement', () => {
  it('has a CSS rule for every class token emitted by the question renderer', async () => {
    const fs = await import('node:fs/promises')
    const css = await fs.readFile(new URL('../web/src/index.css', import.meta.url).pathname, 'utf8')
    const source = await fs.readFile(new URL('../public/operator-stream.js', import.meta.url).pathname, 'utf8')
    const emitted = [...new Set(source.match(/(?<![\w-])question-region(?:__[a-z-]+)?(?![\w-])/g) ?? [])]

    expect(emitted).toEqual(expect.arrayContaining(['question-region', 'question-region__request', 'question-region__question']))
    for (const token of emitted) {
      expect(css, `no CSS rule for .${token}`).toMatch(new RegExp(String.raw`\.${token}(?![\w-])`))
    }
    expect(css).toContain('[data-role="run-questions"]')
    expect(css).toContain('[data-role="run-questions"][hidden]')
  })
})

// ===========================================================================
// Checkout provenance / checkout preparation — browser trust boundary
// ===========================================================================

const CK_SHA_A = 'a'.repeat(40)
const CK_SHA_B = 'b'.repeat(40)
const CK_SHA_C = 'c'.repeat(40)

function ckStatusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-ck-001',
    entityRef: 'fro-bot/agent',
    surface: 'github',
    phase: 'EXECUTING',
    status: 'running',
    startedAt: '2026-10-06T10:00:00Z',
    stale: false,
    ...overrides,
  }
}

function ckObserved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'observed',
    observation: {
      head: {kind: 'attached', branch: 'fixture-main', sha: CK_SHA_A},
      worktree: {kind: 'clean'},
      operationInProgress: 'none',
      observedAt: '2026-10-06T10:00:00Z',
    },
    remote: {kind: 'not-checked'},
    ...overrides,
  }
}

function ckObservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {...(ckObserved().observation as Record<string, unknown>), ...overrides}
}

function ckBrowserStatus(payload: Record<string, unknown>) {
  const result = parseSseFrame(`event: status\ndata: ${JSON.stringify(payload)}\n\n`)
  if (result === null || !result.success || result.frame.type !== 'status') return undefined
  return result.frame.data
}

function ckServerStatus(payload: Record<string, unknown>) {
  const result = parseSseChunk(`event: status\ndata: ${JSON.stringify(payload)}\n\n`)[0]
  if (result === undefined || !result.success || result.frame.type !== 'status') return undefined
  return result.frame.data
}

function ckLive(): StreamState {
  return nextStreamState(INITIAL_STATE, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})
}

function ckApply(state: StreamState, payload: Record<string, unknown>): StreamState {
  const data = ckBrowserStatus(payload)
  if (data === undefined) throw new Error('fixture frame did not parse')
  return nextStreamState(state, {type: 'status', data})
}

// ---------------------------------------------------------------------------
// Label coverage — every vendored value has a dashboard label
// ---------------------------------------------------------------------------

describe('checkout label maps — coverage against the vendored vocabularies', () => {
  const sorted = (values: Iterable<string>) => [...values].toSorted()

  it('failure-kind labels cover exactly the vendored OperatorFailureKind set', () => {
    expect(sorted(Object.keys(FAILURE_REASON_LABELS))).toEqual(sorted(OPERATOR_FAILURE_KINDS))
  })

  it('refusal-reason labels cover exactly the vendored refusal reasons', () => {
    expect(sorted(Object.keys(CHECKOUT_REFUSAL_REASON_LABELS))).toEqual(sorted(CHECKOUT_REFUSAL_REASONS))
  })

  it('update-failure labels cover exactly the vendored update-failure reasons', () => {
    expect(sorted(Object.keys(CHECKOUT_UPDATE_FAILURE_REASON_LABELS))).toEqual(sorted(UPDATE_FAILURE_REASONS))
  })

  it('layout-reason labels cover exactly the vendored layout reasons', () => {
    expect(sorted(Object.keys(CHECKOUT_LAYOUT_REASON_LABELS))).toEqual(sorted(LAYOUT_REFUSAL_REASONS))
  })

  it('obstruction-kind labels cover exactly the vendored obstruction kinds', () => {
    expect(sorted(Object.keys(CHECKOUT_OBSTRUCTION_KIND_LABELS))).toEqual(sorted(OBSTRUCTION_KINDS))
  })

  it('operation labels cover every vendored operation except `none`, which deliberately renders nothing', () => {
    expect(sorted([...Object.keys(CHECKOUT_OPERATION_LABELS), 'none'])).toEqual(sorted(CHECKOUT_OPERATIONS))
    expect('none' in CHECKOUT_OPERATION_LABELS).toBe(false)
  })

  it('every label is a non-empty string', () => {
    const maps = [
      FAILURE_REASON_LABELS,
      CHECKOUT_REFUSAL_REASON_LABELS,
      CHECKOUT_UPDATE_FAILURE_REASON_LABELS,
      CHECKOUT_LAYOUT_REASON_LABELS,
      CHECKOUT_OBSTRUCTION_KIND_LABELS,
      CHECKOUT_OPERATION_LABELS,
      CHECKOUT_FAILURE_FLAG_LABELS,
      CHECKOUT_PREPARATION_HEADLINE_LABELS,
      CHECKOUT_PROVENANCE_LABELS,
    ] as readonly Readonly<Record<string, string>>[]
    for (const map of maps) {
      for (const value of Object.values(map)) {
        expect(typeof value).toBe('string')
        expect(value.length).toBeGreaterThan(0)
      }
    }
  })

  it('workspace-unreachable, workspace-unavailable and checkout-substituted have three distinct labels', () => {
    const labels = [
      FAILURE_REASON_LABELS['workspace-unreachable'],
      FAILURE_REASON_LABELS['workspace-unavailable'],
      FAILURE_REASON_LABELS['checkout-substituted'],
    ]
    expect(new Set(labels).size).toBe(3)
    expect(labels).toEqual(['Workspace unreachable', 'Workspace unavailable', 'Checkout mismatch'])
  })

  it('all labels within each map are distinct', () => {
    for (const map of [
      FAILURE_REASON_LABELS,
      CHECKOUT_REFUSAL_REASON_LABELS,
      CHECKOUT_UPDATE_FAILURE_REASON_LABELS,
      CHECKOUT_LAYOUT_REASON_LABELS,
      CHECKOUT_OBSTRUCTION_KIND_LABELS,
      CHECKOUT_OPERATION_LABELS,
    ] as readonly Readonly<Record<string, string>>[]) {
      const values = Object.values(map)
      expect(new Set(values).size).toBe(values.length)
    }
  })

  it('label copy matches the reviewed Label Copy verbatim', () => {
    expect(CHECKOUT_PREPARATION_HEADLINE_LABELS).toEqual({
      refused: 'Checkout refused: {reason}',
      failed: 'Checkout update failed: {reason}',
    })
    expect(CHECKOUT_FAILURE_FLAG_LABELS).toEqual({
      permanent: "Retrying won't help.",
      mutationStarted: 'The checkout was partly changed.',
      mutationPossibly: 'The checkout may have been partly changed.',
    })
    expect(CHECKOUT_REFUSAL_REASON_LABELS).toEqual({
      'needs-recovery': 'needs recovery',
      'checkout-substituted': 'checkout mismatch',
      'unsupported-layout': 'unsupported repository layout ({layout})',
      'unsupported-config': 'disallowed git config',
      'operation-in-progress': '{operation} in progress',
      dirty: 'uncommitted changes',
      'submodule-initialized': 'submodules initialized',
      detached: 'detached HEAD',
      'non-default-branch': 'on branch {branch}, not the default',
      diverged: 'diverged from remote',
      ahead: 'local commits not on remote',
      obstructed: 'files in the way',
      'maintenance-hold': 'maintenance hold',
    })
    expect(CHECKOUT_OPERATION_LABELS).toEqual({
      merge: 'Merge',
      rebase: 'Rebase',
      am: 'Patch apply',
      'cherry-pick': 'Cherry-pick',
      revert: 'Revert',
      bisect: 'Bisect',
    })
    expect(CHECKOUT_PROVENANCE_LABELS).toEqual({
      headAttached: 'Started from {branch} at {sha}',
      headDetached: 'Started from detached {sha}',
      worktreeClean: 'Clean worktree',
      worktreeDirty: 'Uncommitted changes:',
      operationInProgress: '{operation} in progress',
      remoteNotChecked: 'Remote not checked',
      remoteUpToDate: 'Up to date with {defaultBranch}',
      remoteFastForwarded: 'Fast-forwarded {fromSha} → {sha} on {defaultBranch}',
      unavailable: 'Checkout state unavailable',
    })
  })

  it('every {placeholder} used by a template is one the renderer is expected to supply', () => {
    const allowed = new Set(['reason', 'layout', 'operation', 'branch', 'sha', 'fromSha', 'defaultBranch'])
    const templates = [
      ...Object.values(CHECKOUT_REFUSAL_REASON_LABELS),
      ...Object.values(CHECKOUT_PREPARATION_HEADLINE_LABELS),
      ...Object.values(CHECKOUT_PROVENANCE_LABELS),
    ]
    for (const template of templates) {
      for (const match of template.matchAll(/\{(\w+)\}/g)) {
        expect(allowed.has(match[1] ?? '')).toBe(true)
      }
    }
  })

  it('fillLabelTemplate substitutes in a single pass and never re-expands substituted text', () => {
    expect(fillLabelTemplate('on {a} at {b}', {a: 'x', b: 'y'})).toBe('on x at y')
    expect(fillLabelTemplate('on {a}', {a: '{b}', b: 'nope'})).toBe('on {b}')
    expect(fillLabelTemplate('on {a}', {a: '$& $1'})).toBe('on $& $1')
    expect(fillLabelTemplate('keep {missing}', {})).toBe('keep {missing}')
  })
})

// ---------------------------------------------------------------------------
// Parser — acceptance (shared inputs drive the server and browser parsers)
// ---------------------------------------------------------------------------

function ckRefusals(): Record<string, unknown>[] {
  return [
    {outcome: 'refused', reason: 'needs-recovery'},
    {outcome: 'refused', reason: 'checkout-substituted'},
    {outcome: 'refused', reason: 'unsupported-layout', layoutReason: 'shallow'},
    {outcome: 'refused', reason: 'unsupported-config', disallowedKeys: ['fixture.key']},
    {outcome: 'refused', reason: 'unsupported-config', disallowedKeys: []},
    {outcome: 'refused', reason: 'operation-in-progress', operation: 'merge'},
    {outcome: 'refused', reason: 'dirty', changedPaths: ['fixture/a', 'fixture/b']},
    {outcome: 'refused', reason: 'dirty', changedPaths: []},
    {outcome: 'refused', reason: 'submodule-initialized', submodules: ['fixture-sub']},
    {outcome: 'refused', reason: 'detached'},
    {outcome: 'refused', reason: 'non-default-branch', branch: 'fixture-feature'},
    {outcome: 'refused', reason: 'diverged'},
    {outcome: 'refused', reason: 'ahead'},
    {outcome: 'refused', reason: 'obstructed', obstructions: [{path: 'fixture/a', kind: 'exact-conflict'}]},
    {outcome: 'refused', reason: 'obstructed', obstructions: []},
    {outcome: 'refused', reason: 'maintenance-hold'},
  ]
}

interface CkParityCase {
  readonly name: string
  readonly field: 'checkoutProvenance' | 'checkoutPreparation'
  readonly value: unknown
  readonly present: boolean
}

function ckParityCases(): CkParityCase[] {
  const cases: CkParityCase[] = []
  const prov = (name: string, value: unknown, present: boolean) =>
    cases.push({name: `provenance: ${name}`, field: 'checkoutProvenance', value, present})
  const prep = (name: string, value: unknown, present: boolean) =>
    cases.push({name: `preparation: ${name}`, field: 'checkoutPreparation', value, present})

  prov('observed, attached, clean, not-checked', ckObserved(), true)
  prov('observed, detached, dirty, rebase', ckObserved({observation: ckObservation({
    head: {kind: 'detached', sha: CK_SHA_A},
    worktree: {kind: 'dirty', staged: 1, unstaged: 2, untracked: 3, conflicted: 4},
    operationInProgress: 'rebase',
  })}), true)
  prov('unavailable', {kind: 'unavailable', remote: {kind: 'not-checked'}}, true)
  prov('checked unchanged', ckObserved({remote: {kind: 'checked', defaultBranch: 'main', sha: CK_SHA_B, checkedAt: 'now', change: 'unchanged'}}), true)
  prov('checked fast-forward', ckObserved({remote: {kind: 'checked', defaultBranch: 'main', sha: CK_SHA_B, checkedAt: 'now', change: 'fast-forward', fromSha: CK_SHA_C}}), true)
  prov('39-character SHA', ckObserved({observation: ckObservation({head: {kind: 'detached', sha: 'a'.repeat(39)}})}), false)
  prov('41-character SHA', ckObserved({observation: ckObservation({head: {kind: 'detached', sha: 'a'.repeat(41)}})}), false)
  prov('uppercase-hex SHA', ckObserved({observation: ckObservation({head: {kind: 'detached', sha: 'A'.repeat(40)}})}), false)
  prov('fast-forward with fromSha === sha', ckObserved({remote: {kind: 'checked', defaultBranch: 'main', sha: CK_SHA_B, checkedAt: 'now', change: 'fast-forward', fromSha: CK_SHA_B}}), false)
  prov('fast-forward without fromSha', ckObserved({remote: {kind: 'checked', defaultBranch: 'main', sha: CK_SHA_B, checkedAt: 'now', change: 'fast-forward'}}), false)
  prov('checked with unknown change', ckObserved({remote: {kind: 'checked', defaultBranch: 'main', sha: CK_SHA_B, checkedAt: 'now', change: 'fixture-unknown'}}), false)
  prov('checked with empty defaultBranch', ckObserved({remote: {kind: 'checked', defaultBranch: '', sha: CK_SHA_B, checkedAt: 'now', change: 'unchanged'}}), false)
  prov('checked with empty checkedAt', ckObserved({remote: {kind: 'checked', defaultBranch: 'main', sha: CK_SHA_B, checkedAt: '', change: 'unchanged'}}), false)
  prov('unknown remote kind', ckObserved({remote: {kind: 'fixture-unknown'}}), false)
  prov('missing remote', ckObserved({remote: undefined}), false)
  prov('empty branch', ckObserved({observation: ckObservation({head: {kind: 'attached', branch: '', sha: CK_SHA_A}})}), false)
  prov('attached head without branch', ckObserved({observation: ckObservation({head: {kind: 'attached', sha: CK_SHA_A}})}), false)
  prov('unknown head kind', ckObserved({observation: ckObservation({head: {kind: 'fixture-unknown', sha: CK_SHA_A}})}), false)
  prov('unknown worktree kind', ckObserved({observation: ckObservation({worktree: {kind: 'fixture-unknown'}})}), false)
  prov('unknown operation', ckObserved({observation: ckObservation({operationInProgress: 'fixture-unknown'})}), false)
  prov('negative count', ckObserved({observation: ckObservation({worktree: {kind: 'dirty', staged: -1, unstaged: 0, untracked: 0, conflicted: 0}})}), false)
  prov('fractional count', ckObserved({observation: ckObservation({worktree: {kind: 'dirty', staged: 1.5, unstaged: 0, untracked: 0, conflicted: 0}})}), false)
  prov('string count', ckObserved({observation: ckObservation({worktree: {kind: 'dirty', staged: '1', unstaged: 0, untracked: 0, conflicted: 0}})}), false)
  prov('null count (Infinity on the wire)', ckObserved({observation: ckObservation({worktree: {kind: 'dirty', staged: null, unstaged: 0, untracked: 0, conflicted: 0}})}), false)
  prov('missing count', ckObserved({observation: ckObservation({worktree: {kind: 'dirty', staged: 1, unstaged: 0, untracked: 0}})}), false)
  prov('empty observedAt', ckObserved({observation: ckObservation({observedAt: ''})}), false)
  prov('unknown provenance kind', {kind: 'fixture-unknown', remote: {kind: 'not-checked'}}, false)
  prov('observed without observation', {kind: 'observed', remote: {kind: 'not-checked'}}, false)
  for (const value of ['fixture-string', 42, true, [], ['fixture-array'], {}]) {
    prov(`non-object ${JSON.stringify(value)}`, value, false)
  }

  for (const refusal of ckRefusals()) {
    prep(`refused ${String(refusal.reason)} #${cases.length}`, refusal, true)
  }
  for (const mutationStarted of [true, false, 'possibly']) {
    for (const permanent of [true, false]) {
      prep(`failed mutationStarted=${String(mutationStarted)} permanent=${String(permanent)}`, {outcome: 'failed', reason: 'fetch-timeout', mutationStarted, permanent}, true)
    }
  }
  prep('unknown refusal reason', {outcome: 'refused', reason: 'fixture-unknown'}, false)
  prep('unknown layout reason', {outcome: 'refused', reason: 'unsupported-layout', layoutReason: 'fixture-unknown'}, false)
  prep('missing layout reason', {outcome: 'refused', reason: 'unsupported-layout'}, false)
  prep('disallowedKeys not an array', {outcome: 'refused', reason: 'unsupported-config', disallowedKeys: 'fixture'}, false)
  prep('changedPaths with a non-string entry', {outcome: 'refused', reason: 'dirty', changedPaths: ['fixture/a', 7]}, false)
  prep('submodules with a null entry', {outcome: 'refused', reason: 'submodule-initialized', submodules: [null]}, false)
  prep('empty non-default branch', {outcome: 'refused', reason: 'non-default-branch', branch: ''}, false)
  prep('non-string non-default branch', {outcome: 'refused', reason: 'non-default-branch', branch: 7}, false)
  prep('unknown operation', {outcome: 'refused', reason: 'operation-in-progress', operation: 'fixture-unknown'}, false)
  prep('unknown obstruction kind', {outcome: 'refused', reason: 'obstructed', obstructions: [{path: 'fixture/a', kind: 'fixture-unknown'}]}, false)
  prep('obstruction path not a string', {outcome: 'refused', reason: 'obstructed', obstructions: [{path: 3, kind: 'exact-conflict'}]}, false)
  prep('obstruction entry not an object', {outcome: 'refused', reason: 'obstructed', obstructions: ['fixture/a']}, false)
  prep('unknown update-failure reason', {outcome: 'failed', reason: 'fixture-unknown', mutationStarted: false, permanent: false}, false)
  prep('mutationStarted not tri-state', {outcome: 'failed', reason: 'fetch-failed', mutationStarted: 'maybe', permanent: false}, false)
  prep('permanent not boolean', {outcome: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: 'yes'}, false)
  prep('unknown outcome', {outcome: 'fixture-unknown'}, false)
  for (const value of ['fixture-string', 42, true, [], ['fixture-array'], {}]) {
    prep(`non-object ${JSON.stringify(value)}`, value, false)
  }
  return cases
}

describe('checkout fields — server and browser parsers agree on presence', () => {
  for (const testCase of ckParityCases()) {
    it(`${testCase.name} → ${testCase.present ? 'present' : 'absent'} in both`, () => {
      const payload = ckStatusPayload({[testCase.field]: testCase.value})
      const server = ckServerStatus(payload)
      const browser = ckBrowserStatus(payload)
      // The frame itself is always accepted by both — soft fields never reject it.
      expect(server).toBeDefined()
      expect(browser).toBeDefined()
      expect(server?.[testCase.field] !== undefined).toBe(testCase.present)
      expect(browser?.[testCase.field] !== undefined).toBe(testCase.present)
      if (!testCase.present) {
        expect(Object.prototype.hasOwnProperty.call(browser, testCase.field)).toBe(false)
      }
    })
  }

  it('every vendored vocabulary value is accepted by the browser parser, and an unlisted one is not', () => {
    for (const layoutReason of LAYOUT_REFUSAL_REASONS) {
      const value = {outcome: 'refused', reason: 'unsupported-layout', layoutReason}
      expect(ckBrowserStatus(ckStatusPayload({checkoutPreparation: value}))?.checkoutPreparation).toBeDefined()
    }
    for (const kind of OBSTRUCTION_KINDS) {
      const value = {outcome: 'refused', reason: 'obstructed', obstructions: [{path: 'fixture/a', kind}]}
      expect(ckBrowserStatus(ckStatusPayload({checkoutPreparation: value}))?.checkoutPreparation).toBeDefined()
    }
    for (const reason of UPDATE_FAILURE_REASONS) {
      const value = {outcome: 'failed', reason, mutationStarted: false, permanent: false}
      expect(ckBrowserStatus(ckStatusPayload({checkoutPreparation: value}))?.checkoutPreparation).toBeDefined()
    }
    for (const operation of CHECKOUT_OPERATIONS) {
      const value = {outcome: 'refused', reason: 'operation-in-progress', operation}
      expect(ckBrowserStatus(ckStatusPayload({checkoutPreparation: value}))?.checkoutPreparation).toBeDefined()
      const observed = ckObserved({observation: ckObservation({operationInProgress: operation})})
      expect(ckBrowserStatus(ckStatusPayload({checkoutProvenance: observed}))?.checkoutProvenance).toBeDefined()
    }
    for (const reason of CHECKOUT_REFUSAL_REASONS) {
      const match = ckRefusals().find(candidate => candidate.reason === reason)
      expect(match, `fixture for ${reason}`).toBeDefined()
      expect(ckBrowserStatus(ckStatusPayload({checkoutPreparation: match}))?.checkoutPreparation).toBeDefined()
    }
  })

  it('the browser is deliberately stricter than the vendored server parser in exactly two ways', () => {
    // 1. A required scalar that is empty after sanitizing invalidates the containing object.
    const bidiOnly = '\u202E\u202D\u0007'
    const emptyBranch = ckObserved({observation: ckObservation({head: {kind: 'attached', branch: bidiOnly, sha: CK_SHA_A}})})
    expect(ckServerStatus(ckStatusPayload({checkoutProvenance: emptyBranch}))?.checkoutProvenance).toBeDefined()
    expect(ckBrowserStatus(ckStatusPayload({checkoutProvenance: emptyBranch}))?.checkoutProvenance).toBeUndefined()
    // 2. Counts must be safe integers (the server accepts any integer-valued number).
    const unsafe = ckObserved({observation: ckObservation({worktree: {kind: 'dirty', staged: 2 ** 60, unstaged: 0, untracked: 0, conflicted: 0}})})
    expect(ckServerStatus(ckStatusPayload({checkoutProvenance: unsafe}))?.checkoutProvenance).toBeDefined()
    expect(ckBrowserStatus(ckStatusPayload({checkoutProvenance: unsafe}))?.checkoutProvenance).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Parser — DTO shape, caps and sanitizing
// ---------------------------------------------------------------------------

describe('checkout provenance DTO', () => {
  it('stores a closed DTO: head, worktree, operation and remote — and no timestamps', () => {
    const wire = ckObserved({
      observation: ckObservation({
        head: {kind: 'attached', branch: 'fixture-main', sha: CK_SHA_A},
        worktree: {kind: 'dirty', staged: 1, unstaged: 2, untracked: 3, conflicted: 0},
        operationInProgress: 'merge',
      }),
      remote: {kind: 'checked', defaultBranch: 'main', sha: CK_SHA_B, checkedAt: 'fixture-checked-at', change: 'fast-forward', fromSha: CK_SHA_C},
    })
    const dto = ckBrowserStatus(ckStatusPayload({checkoutProvenance: wire}))?.checkoutProvenance
    expect(dto).toEqual({
      kind: 'observed',
      head: {kind: 'attached', branch: 'fixture-main', sha: CK_SHA_A},
      worktree: {kind: 'dirty', staged: 1, unstaged: 2, untracked: 3, conflicted: 0},
      operation: 'merge',
      remote: {kind: 'checked', change: 'fast-forward', defaultBranch: 'main', sha: CK_SHA_B, fromSha: CK_SHA_C},
    })
    const serialized = JSON.stringify(dto)
    expect(serialized).not.toContain('observedAt')
    expect(serialized).not.toContain('checkedAt')
    expect(serialized).not.toContain('fixture-checked-at')
    expect(serialized).not.toContain('2026-10-06')
  })

  it('stores the detached, clean, not-checked and unavailable shapes', () => {
    const detached = ckBrowserStatus(
      ckStatusPayload({checkoutProvenance: ckObserved({observation: ckObservation({head: {kind: 'detached', sha: CK_SHA_A}})})}),
    )?.checkoutProvenance
    expect(detached).toEqual({
      kind: 'observed',
      head: {kind: 'detached', sha: CK_SHA_A},
      worktree: {kind: 'clean'},
      operation: 'none',
      remote: {kind: 'not-checked'},
    })
    const unavailable = ckBrowserStatus(
      ckStatusPayload({checkoutProvenance: {kind: 'unavailable', remote: {kind: 'not-checked'}}}),
    )?.checkoutProvenance
    expect(unavailable).toEqual({kind: 'unavailable', remote: {kind: 'not-checked'}})
  })

  it('drops unknown extra keys instead of copying them', () => {
    const wire = {
      ...ckObserved({fixtureExtra: 'fixture-extra-top'}),
      observation: {...ckObservation({fixtureExtra: 'fixture-extra-obs'}), head: {kind: 'attached', branch: 'b', sha: CK_SHA_A, fixtureExtra: 'fixture-extra-head'}},
    }
    const dto = ckBrowserStatus(ckStatusPayload({checkoutProvenance: wire}))?.checkoutProvenance
    expect(dto).toBeDefined()
    expect(JSON.stringify(dto)).not.toContain('fixture-extra')
  })

  it('a branch containing U+202E is stored without it', () => {
    const wire = ckObserved({observation: ckObservation({head: {kind: 'attached', branch: 'fixture\u202Emain', sha: CK_SHA_A}})})
    const dto = ckBrowserStatus(ckStatusPayload({checkoutProvenance: wire}))?.checkoutProvenance
    expect(dto?.kind === 'observed' && dto.head.kind === 'attached' ? dto.head.branch : undefined).toBe('fixturemain')
  })

  it('a head.branch made only of bidi and control characters makes the provenance absent', () => {
    const wire = ckObserved({observation: ckObservation({head: {kind: 'attached', branch: '\u202E\u2066\u061C\u0000\u009F', sha: CK_SHA_A}})})
    expect(ckBrowserStatus(ckStatusPayload({checkoutProvenance: wire}))?.checkoutProvenance).toBeUndefined()
  })

  it('a remote.defaultBranch that is empty after sanitizing makes the provenance absent', () => {
    const wire = ckObserved({remote: {kind: 'checked', defaultBranch: '\u200E\u200F', sha: CK_SHA_B, checkedAt: 'now', change: 'unchanged'}})
    expect(ckBrowserStatus(ckStatusPayload({checkoutProvenance: wire}))?.checkoutProvenance).toBeUndefined()
  })

  it('caps a 300-character branch at 256 characters with a trailing ellipsis', () => {
    const wire = ckObserved({observation: ckObservation({head: {kind: 'attached', branch: 'x'.repeat(300), sha: CK_SHA_A}})})
    const dto = ckBrowserStatus(ckStatusPayload({checkoutProvenance: wire}))?.checkoutProvenance
    const branch = dto?.kind === 'observed' && dto.head.kind === 'attached' ? dto.head.branch : ''
    expect(branch).toHaveLength(256)
    expect(branch.endsWith('…')).toBe(true)
  })

  it('a branch exactly at the cap is kept whole', () => {
    const wire = ckObserved({observation: ckObservation({head: {kind: 'attached', branch: 'y'.repeat(256), sha: CK_SHA_A}})})
    const dto = ckBrowserStatus(ckStatusPayload({checkoutProvenance: wire}))?.checkoutProvenance
    const branch = dto?.kind === 'observed' && dto.head.kind === 'attached' ? dto.head.branch : ''
    expect(branch).toBe('y'.repeat(256))
  })

  it('cap truncation never leaves half a surrogate pair', () => {
    const wire = ckObserved({observation: ckObservation({head: {kind: 'attached', branch: '😀'.repeat(300), sha: CK_SHA_A}})})
    const dto = ckBrowserStatus(ckStatusPayload({checkoutProvenance: wire}))?.checkoutProvenance
    const branch = dto?.kind === 'observed' && dto.head.kind === 'attached' ? dto.head.branch : ''
    expect(branch.length).toBeLessThanOrEqual(256)
    expect(branch.isWellFormed()).toBe(true)
    expect(branch.endsWith('…')).toBe(true)
  })

  it('SHAs are re-validated 40-hex and stored whole (never unvalidated text)', () => {
    const dto = ckBrowserStatus(ckStatusPayload({checkoutProvenance: ckObserved()}))?.checkoutProvenance
    expect(dto?.kind === 'observed' ? dto.head.sha : '').toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('sanitizeCheckoutText', () => {
  it('strips C0, DEL and C1 controls', () => {
    const controls = Array.from({length: 0x20}, (_, i) => String.fromCodePoint(i))
      .join('')
      .concat('\u007F', Array.from({length: 0x20}, (_, i) => String.fromCodePoint(0x80 + i)).join(''))
    expect(sanitizeCheckoutText(`a${controls}b`, 256)).toBe('ab')
  })

  it('strips every bidi control: overrides and embeddings, isolates, and marks', () => {
    const bidi = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F', '\u061C']
    for (const char of bidi) {
      expect(sanitizeCheckoutText(`fixture${char}text`, 256)).toBe('fixturetext')
    }
  })

  it('keeps ordinary text, including non-ASCII letters and emoji', () => {
    expect(sanitizeCheckoutText('fixture/ünïcode/日本語/😀.txt', 256)).toBe('fixture/ünïcode/日本語/😀.txt')
  })

  it('truncates to the cap with a trailing ellipsis, within the cap', () => {
    const out = sanitizeCheckoutText('z'.repeat(1000), 10)
    expect(out).toHaveLength(10)
    expect(out).toBe(`${'z'.repeat(9)}…`)
  })
})

describe('checkout preparation DTO — bounded lists', () => {
  const dirty = (changedPaths: unknown) => ({outcome: 'refused', reason: 'dirty', changedPaths})
  const prepOf = (value: unknown) => ckBrowserStatus(ckStatusPayload({phase: 'FAILED', status: 'failed', checkoutPreparation: value}))?.checkoutPreparation

  it('refused dirty with 3 paths lists all 3, overflow 0', () => {
    expect(prepOf(dirty(['fixture/a', 'fixture/b', 'fixture/c']))).toEqual({
      outcome: 'refused',
      reason: 'dirty',
      changedPaths: {items: ['fixture/a', 'fixture/b', 'fixture/c'], more: 0},
    })
  })

  it('25 changed paths → 10 entries plus an overflow of 15, none over 256 characters', () => {
    const paths = Array.from({length: 25}, (_, i) => `fixture/${i}/${'p'.repeat(400)}`)
    const dto = prepOf(dirty(paths))
    expect(dto?.outcome === 'refused' && dto.reason === 'dirty' ? dto.changedPaths.items : []).toHaveLength(10)
    expect(dto?.outcome === 'refused' && dto.reason === 'dirty' ? dto.changedPaths.more : -1).toBe(15)
    for (const entry of dto?.outcome === 'refused' && dto.reason === 'dirty' ? dto.changedPaths.items : []) {
      expect(entry.length).toBeLessThanOrEqual(256)
    }
  })

  it('exactly 10 entries → no overflow; 11 → overflow of 1', () => {
    const ten = prepOf(dirty(Array.from({length: 10}, (_, i) => `fixture/${i}`)))
    expect(ten?.outcome === 'refused' && ten.reason === 'dirty' ? ten.changedPaths.more : -1).toBe(0)
    const eleven = prepOf(dirty(Array.from({length: 11}, (_, i) => `fixture/${i}`)))
    expect(eleven?.outcome === 'refused' && eleven.reason === 'dirty' ? eleven.changedPaths.more : -1).toBe(1)
  })

  it('a path of only bidi or control characters is dropped, and does not count toward the overflow', () => {
    const dto = prepOf(dirty(['fixture/a', '\u202E\u2066', '\u0000\u009F', 'fixture/b']))
    expect(dto).toEqual({outcome: 'refused', reason: 'dirty', changedPaths: {items: ['fixture/a', 'fixture/b'], more: 0}})
  })

  it('a list that is empty after sanitizing keeps the reason with no entries', () => {
    expect(prepOf(dirty(['\u202E', '\u061C']))).toEqual({outcome: 'refused', reason: 'dirty', changedPaths: {items: [], more: 0}})
    expect(prepOf(dirty([]))).toEqual({outcome: 'refused', reason: 'dirty', changedPaths: {items: [], more: 0}})
  })

  it('applies the same bounds to submodules, disallowedKeys and obstructions', () => {
    const many = Array.from({length: 12}, (_, i) => `fixture-${i}`)
    const subs = prepOf({outcome: 'refused', reason: 'submodule-initialized', submodules: many})
    expect(subs?.outcome === 'refused' && subs.reason === 'submodule-initialized' ? subs.submodules : undefined).toEqual({items: many.slice(0, 10), more: 2})
    const keys = prepOf({outcome: 'refused', reason: 'unsupported-config', disallowedKeys: many})
    expect(keys?.outcome === 'refused' && keys.reason === 'unsupported-config' ? keys.disallowedKeys : undefined).toEqual({items: many.slice(0, 10), more: 2})
    const obstructions = prepOf({
      outcome: 'refused',
      reason: 'obstructed',
      obstructions: [
        ...many.map(path => ({path, kind: 'exact-conflict'})),
        {path: '\u202E', kind: 'prefix-conflict'},
      ],
    })
    expect(obstructions?.outcome === 'refused' && obstructions.reason === 'obstructed' ? obstructions.obstructions : undefined).toEqual({
      items: many.slice(0, 10).map(path => ({path, kind: 'exact-conflict'})),
      more: 2,
    })
  })

  it('an obstruction keeps its kind next to the sanitized path', () => {
    const dto = prepOf({
      outcome: 'refused',
      reason: 'obstructed',
      obstructions: [{path: 'fixture\u202E/a', kind: 'symlink-ancestor', fixtureExtra: 'fixture-extra'}],
    })
    expect(dto).toEqual({
      outcome: 'refused',
      reason: 'obstructed',
      obstructions: {items: [{path: 'fixture/a', kind: 'symlink-ancestor'}], more: 0},
    })
  })

  it('a non-default-branch branch is sanitized, and empty-after-sanitizing makes the preparation absent', () => {
    expect(prepOf({outcome: 'refused', reason: 'non-default-branch', branch: 'fixture\u202E-feature'})).toEqual({
      outcome: 'refused',
      reason: 'non-default-branch',
      branch: 'fixture-feature',
    })
    expect(prepOf({outcome: 'refused', reason: 'non-default-branch', branch: '\u202E\u0000'})).toBeUndefined()
  })

  it('the shape of every other refusal and the failed outcome is closed', () => {
    expect(prepOf({outcome: 'refused', reason: 'unsupported-layout', layoutReason: 'shallow', fixtureExtra: 'fixture-extra'})).toEqual({
      outcome: 'refused',
      reason: 'unsupported-layout',
      layoutReason: 'shallow',
    })
    expect(prepOf({outcome: 'refused', reason: 'operation-in-progress', operation: 'bisect'})).toEqual({
      outcome: 'refused',
      reason: 'operation-in-progress',
      operation: 'bisect',
    })
    expect(prepOf({outcome: 'refused', reason: 'diverged', fixtureExtra: 'fixture-extra'})).toEqual({outcome: 'refused', reason: 'diverged'})
    expect(prepOf({outcome: 'failed', reason: 'remote-moved', mutationStarted: 'possibly', permanent: true, fixtureExtra: 'fixture-extra'})).toEqual({
      outcome: 'failed',
      reason: 'remote-moved',
      mutationStarted: 'possibly',
      permanent: true,
    })
  })
})

describe('checkout fields never reject the status frame; the core stays hard', () => {
  it('malformed provenance and preparation leave the frame accepted with failureKind intact', () => {
    const data = ckBrowserStatus(
      ckStatusPayload({
        phase: 'FAILED',
        status: 'failed',
        failureKind: 'workspace-unavailable',
        checkoutProvenance: {kind: 'fixture-bogus'},
        checkoutPreparation: {outcome: 'fixture-bogus'},
      }),
    )
    expect(data?.status).toBe('failed')
    expect(data?.failureKind).toBe('workspace-unavailable')
    expect(data?.checkoutProvenance).toBeUndefined()
    expect(data?.checkoutPreparation).toBeUndefined()
  })

  it('both new failure kinds parse, and an unknown kind is still absent', () => {
    for (const failureKind of ['checkout-substituted', 'workspace-unavailable']) {
      expect(ckBrowserStatus(ckStatusPayload({phase: 'FAILED', status: 'failed', failureKind}))?.failureKind).toBe(failureKind)
    }
    expect(ckBrowserStatus(ckStatusPayload({phase: 'FAILED', status: 'failed', failureKind: 'fixture-unknown'}))?.failureKind).toBeUndefined()
  })

  it('status, phase and surface still hard-reject even with valid provenance and preparation', () => {
    const valid = {checkoutProvenance: ckObserved(), checkoutPreparation: {outcome: 'refused', reason: 'detached'}}
    for (const override of [{status: 'fixture-unknown'}, {phase: 'FIXTURE_UNKNOWN'}, {surface: 'fixture-unknown'}]) {
      const result = parseSseFrame(`event: status\ndata: ${JSON.stringify(ckStatusPayload({...override, ...valid}))}\n\n`)
      expect(result?.success).toBe(false)
    }
  })

  it('omits both keys entirely when absent', () => {
    const data = ckBrowserStatus(ckStatusPayload())
    expect(Object.prototype.hasOwnProperty.call(data, 'checkoutProvenance')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(data, 'checkoutPreparation')).toBe(false)
  })

  it('an own __proto__ key inside a nested object cannot smuggle fields into the DTO', () => {
    const text = `event: status\ndata: ${JSON.stringify(ckStatusPayload())
      .slice(0, -1)},"checkoutPreparation":{"outcome":"refused","reason":"detached","__proto__":{"polluted":"fixture-polluted"}}}\n\n`
    const result = parseSseFrame(text)
    expect(result?.success).toBe(true)
    expect(JSON.stringify(result)).not.toContain('fixture-polluted')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Reducer — latest valid wins, per field; provenance and preparation exclusive
// ---------------------------------------------------------------------------

describe('nextStreamState — checkout fields', () => {
  const observed = ckObserved()
  const prepared = {outcome: 'refused', reason: 'dirty', changedPaths: ['fixture/a']}

  it('stores the provenance DTO on the run entry', () => {
    const state = ckApply(ckLive(), ckStatusPayload({checkoutProvenance: observed}))
    expect(state.runs['run-ck-001']?.checkoutProvenance).toEqual(ckBrowserStatus(ckStatusPayload({checkoutProvenance: observed}))?.checkoutProvenance)
    expect(state.runs['run-ck-001']?.checkoutPreparation).toBeUndefined()
  })

  it('EXECUTING with provenance, then a frame without it, then a terminal frame without it → provenance survives', () => {
    let state = ckApply(ckLive(), ckStatusPayload({checkoutProvenance: observed}))
    const stored = state.runs['run-ck-001']?.checkoutProvenance
    expect(stored).toBeDefined()
    state = ckApply(state, ckStatusPayload({stale: true}))
    expect(state.runs['run-ck-001']?.checkoutProvenance).toEqual(stored)
    state = ckApply(state, ckStatusPayload({phase: 'COMPLETED', status: 'succeeded'}))
    expect(state.runs['run-ck-001']?.terminal).toBe(true)
    expect(state.runs['run-ck-001']?.checkoutProvenance).toEqual(stored)
  })

  it('a run that never reached EXECUTING ends FAILED carrying preparation → preparation stored, no provenance key', () => {
    let state = ckApply(ckLive(), ckStatusPayload({phase: 'PENDING', status: 'queued'}))
    state = ckApply(state, ckStatusPayload({phase: 'FAILED', status: 'failed', checkoutPreparation: prepared}))
    const entry = state.runs['run-ck-001']
    expect(entry?.checkoutPreparation).toEqual({outcome: 'refused', reason: 'dirty', changedPaths: {items: ['fixture/a'], more: 0}})
    expect(entry !== undefined && 'checkoutProvenance' in entry).toBe(false)
    expect(entry?.terminal).toBe(true)
  })

  it('a valid replacement provenance replaces the stored one', () => {
    let state = ckApply(ckLive(), ckStatusPayload({checkoutProvenance: observed}))
    const next = ckObserved({observation: ckObservation({head: {kind: 'detached', sha: CK_SHA_B}})})
    state = ckApply(state, ckStatusPayload({checkoutProvenance: next}))
    const stored = state.runs['run-ck-001']?.checkoutProvenance
    expect(stored?.kind === 'observed' ? stored.head : undefined).toEqual({kind: 'detached', sha: CK_SHA_B})
  })

  it('an invalid incoming value keeps the stored one (per field), including on the terminal frame', () => {
    let state = ckApply(ckLive(), ckStatusPayload({checkoutProvenance: observed}))
    const stored = state.runs['run-ck-001']?.checkoutProvenance
    state = ckApply(
      state,
      ckStatusPayload({phase: 'FAILED', status: 'failed', failureKind: 'session-error', checkoutProvenance: {kind: 'fixture-bogus'}, checkoutPreparation: {outcome: 'fixture-bogus'}}),
    )
    const entry = state.runs['run-ck-001']
    expect(entry?.status).toBe('failed')
    expect(entry?.terminal).toBe(true)
    expect(entry?.checkoutProvenance).toEqual(stored)
    expect(entry !== undefined && 'checkoutPreparation' in entry).toBe(false)
  })

  it('a malformed preparation on the terminal frame leaves the earlier valid preparation in place', () => {
    // The earlier frame is non-terminal (a terminal frame closes the stream), so the terminal frame is applied.
    let state = ckApply(ckLive(), ckStatusPayload({phase: 'PENDING', status: 'queued', checkoutPreparation: prepared}))
    const stored = state.runs['run-ck-001']?.checkoutPreparation
    expect(stored).toBeDefined()
    state = ckApply(state, ckStatusPayload({phase: 'FAILED', status: 'failed', checkoutPreparation: {outcome: 'fixture-bogus'}}))
    expect(state.runs['run-ck-001']?.terminal).toBe(true)
    expect(state.runs['run-ck-001']?.checkoutPreparation).toEqual(stored)
  })

  it('a valid preparation after stored provenance clears the provenance (contract-impossible, defended)', () => {
    let state = ckApply(ckLive(), ckStatusPayload({checkoutProvenance: observed}))
    state = ckApply(state, ckStatusPayload({phase: 'FAILED', status: 'failed', checkoutPreparation: prepared}))
    const entry = state.runs['run-ck-001']
    expect(entry?.terminal).toBe(true)
    expect(entry?.checkoutPreparation).toBeDefined()
    expect(entry !== undefined && 'checkoutProvenance' in entry).toBe(false)
  })

  it('and the reverse: a valid provenance after stored preparation clears the preparation', () => {
    let state = ckApply(ckLive(), ckStatusPayload({phase: 'PENDING', status: 'queued', checkoutPreparation: prepared}))
    state = ckApply(state, ckStatusPayload({checkoutProvenance: observed}))
    const entry = state.runs['run-ck-001']
    expect(entry?.checkoutProvenance).toBeDefined()
    expect(entry !== undefined && 'checkoutPreparation' in entry).toBe(false)
  })

  it('both valid in a single frame (contract-impossible): preparation wins, exclusivity holds', () => {
    const state = ckApply(ckLive(), ckStatusPayload({phase: 'FAILED', status: 'failed', checkoutProvenance: observed, checkoutPreparation: prepared}))
    const entry = state.runs['run-ck-001']
    expect(entry?.checkoutPreparation).toBeDefined()
    expect(entry !== undefined && 'checkoutProvenance' in entry).toBe(false)
  })

  it('malformed preparation on a failed frame still advances status to failed and keeps the reason label', () => {
    const state = ckApply(
      ckLive(),
      ckStatusPayload({phase: 'FAILED', status: 'failed', failureKind: 'checkout-substituted', checkoutPreparation: {outcome: 'refused', reason: 'dirty', changedPaths: 'fixture'}}),
    )
    const entry = state.runs['run-ck-001']
    expect(entry?.status).toBe('failed')
    expect(entry?.reasonLabel).toBe('Checkout mismatch')
    expect(entry?.checkoutPreparation).toBeUndefined()
  })

  it('failure kinds resolve to their distinct labels in the reducer', () => {
    const labelFor = (failureKind: string) =>
      ckApply(ckLive(), ckStatusPayload({phase: 'FAILED', status: 'failed', failureKind})).runs['run-ck-001']?.reasonLabel
    expect(labelFor('workspace-unreachable')).toBe('Workspace unreachable')
    expect(labelFor('workspace-unavailable')).toBe('Workspace unavailable')
    expect(labelFor('checkout-substituted')).toBe('Checkout mismatch')
  })

  it('status frames before ready are not stored', () => {
    const state = ckApply(INITIAL_STATE, ckStatusPayload({checkoutProvenance: observed}))
    expect(Object.keys(state.runs)).toHaveLength(0)
  })

  it('per-run isolation: one run’s fields never appear on another', () => {
    let state = ckApply(ckLive(), ckStatusPayload({checkoutProvenance: observed}))
    state = ckApply(state, ckStatusPayload({runId: 'run-ck-002'}))
    expect(state.runs['run-ck-001']?.checkoutProvenance).toBeDefined()
    const other = state.runs['run-ck-002']
    expect(other !== undefined && 'checkoutProvenance' in other).toBe(false)
  })

  it('toSafeRunView stays closed: neither key reaches the safe view', () => {
    const state = ckApply(ckLive(), ckStatusPayload({checkoutProvenance: observed}))
    const entry = state.runs['run-ck-001']
    expect(entry).toBeDefined()
    if (entry !== undefined) {
      const view = toSafeRunView(entry)
      expect(Object.keys(view).toSorted()).toEqual(['phase', 'runId', 'stale', 'startedAt', 'status'])
      expect(JSON.stringify(view)).not.toContain('fixture-main')
    }
  })

  it('the run entry carries exactly the two checkout keys beyond its baseline shape — no raw identity', () => {
    const failed = {phase: 'FAILED', status: 'failed'}
    const baselineRunning = ckApply(ckLive(), ckStatusPayload()).runs['run-ck-001']
    const baselineFailed = ckApply(ckLive(), ckStatusPayload(failed)).runs['run-ck-001']
    const withProv = ckApply(ckLive(), ckStatusPayload({checkoutProvenance: observed})).runs['run-ck-001']
    const withPrep = ckApply(ckLive(), ckStatusPayload({...failed, checkoutPreparation: prepared})).runs['run-ck-001']
    const extra = (entry: object | undefined, baseline: object | undefined) =>
      Object.keys(entry ?? {}).filter(key => !Object.keys(baseline ?? {}).includes(key))
    expect(extra(withProv, baselineRunning)).toEqual(['checkoutProvenance'])
    expect(extra(withPrep, baselineFailed)).toEqual(['checkoutPreparation'])
    for (const entry of [baselineRunning, baselineFailed, withProv, withPrep]) {
      expect(Object.keys(entry ?? {})).not.toContain('entityRef')
      expect(Object.keys(entry ?? {})).not.toContain('surface')
    }
  })
})

// ---------------------------------------------------------------------------
// Leak guard — sentinel `fixture-` strings stay inside in-memory state
// ---------------------------------------------------------------------------

function ckSentinelStatus(): Record<string, unknown> {
  return ckStatusPayload({
    phase: 'FAILED',
    status: 'failed',
    checkoutProvenance: ckObserved({
      observation: ckObservation({head: {kind: 'attached', branch: 'fixture-sentinel-branch', sha: CK_SHA_A}}),
      remote: {kind: 'checked', defaultBranch: 'fixture-sentinel-default', sha: CK_SHA_B, checkedAt: 'fixture-sentinel-checked-at', change: 'unchanged'},
    }),
    checkoutPreparation: {
      outcome: 'refused',
      reason: 'obstructed',
      obstructions: [{path: 'fixture-sentinel-path', kind: 'exact-conflict'}],
    },
  })
}

/** A stand-in global that records the name of every property read or written on it. */
function ckAccessRecorder(log: string[]): object {
  return new Proxy({}, {
    get(_target, prop) {
      log.push(String(prop))
      return () => {}
    },
    set(_target, prop) {
      log.push(String(prop))
      return true
    },
  })
}

/** A fake element that records every value written to it — text, attributes, classes, dataset, style. */
function ckRecordingElement(writes: string[]): Record<string, unknown> {
  const dataset = new Proxy({}, {
    set(_target, prop, value) {
      writes.push(`dataset.${String(prop)}=${String(value)}`)
      return true
    },
  })
  const target: Record<string, unknown> = {
    textContent: '',
    className: '',
    hidden: false,
    dataset,
    classList: {add: (...tokens: string[]) => writes.push(...tokens), remove: () => {}},
    style: {setProperty: (name: string, value: string) => writes.push(`${name}=${value}`)},
    setAttribute: (name: string, value: string) => writes.push(`${name}=${value}`),
    children: [] as Record<string, unknown>[],
    append(...nodes: Record<string, unknown>[]) {
      ;(target.children as Record<string, unknown>[]).push(...nodes)
    },
  }
  return new Proxy(target, {
    set(object, prop, value) {
      object[String(prop)] = value
      writes.push(`${String(prop)}=${String(value)}`)
      return true
    },
  })
}

describe('checkout fields — leak guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('production source contains no console, web-storage, IndexedDB, CacheStorage, history or location writes', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-stream.js', 'utf8')
    expect(src).not.toMatch(/console\.(?:log|error|warn|info|debug|trace)\s*\(/)
    expect(src).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/)
    expect(src).not.toMatch(/\bcaches\.(?:open|put|match|delete)/)
    expect(src).not.toMatch(/\bhistory\.(?:pushState|replaceState)/)
    expect(src).not.toMatch(/\blocation(?:\.(?:assign|replace|hash|search|href)\b|\s*=[^=])/)
  })

  it('the checkout code never writes to the DOM: no innerHTML/outerHTML/insertAdjacentHTML/document.write near the new fields', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile('public/operator-stream.js', 'utf8')
    expect(src).not.toMatch(/(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\s*(?:=|\()/)
  })

  it('a full stream carrying sentinels touches no console, storage, cache, history or location, and writes no sentinel to any element', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    const storageCalls: string[] = []
    const storage = ckAccessRecorder(storageCalls)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', storage)
    const idbCalls: string[] = []
    vi.stubGlobal('indexedDB', ckAccessRecorder(idbCalls))
    const cacheCalls: string[] = []
    vi.stubGlobal('caches', ckAccessRecorder(cacheCalls))
    const historyCalls: string[] = []
    vi.stubGlobal('history', ckAccessRecorder(historyCalls))
    const locationWrites: string[] = []
    vi.stubGlobal('location', ckAccessRecorder(locationWrites))

    const writes: string[] = []
    const checkoutWrites: string[] = []
    const checkoutRegion = ckRecordingElement(checkoutWrites)
    vi.stubGlobal('document', {
      createElement: () => ckRecordingElement(checkoutWrites),
      createTextNode: (text: string) => {
        const node = ckRecordingElement(checkoutWrites)
        node.textContent = text
        return node
      },
    })

    const encoder = new TextEncoder()
    const sentinel = ckSentinelStatus()
    const provenanceStatus = {...sentinel, phase: 'EXECUTING', status: 'running', checkoutPreparation: undefined}
    const preparationStatus = {...sentinel, checkoutProvenance: undefined}
    const body = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\nevent: status\ndata: ${JSON.stringify(provenanceStatus)}\n\nevent: status\ndata: ${JSON.stringify(preparationStatus)}\n\n`
    let read = 0
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {getReader: () => ({read: async () => (read++ === 0 ? {done: false, value: encoder.encode(body)} : {done: true})})},
    }))

    const handle = initOperatorStream({
      runId: 'run-ck-001',
      statusEl: ckRecordingElement(writes),
      noticeEl: ckRecordingElement(writes),
      reasonEl: ckRecordingElement(writes),
      checkoutEl: checkoutRegion as never,
      endpointBase: '/operator',
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    handle.close()

    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
    expect(storageCalls).toEqual([])
    expect(idbCalls).toEqual([])
    expect(cacheCalls).toEqual([])
    expect(historyCalls).toEqual([])
    expect(locationWrites).toEqual([])
    expect(writes.join('\n')).not.toContain('fixture-')
    expect(writes.length).toBeGreaterThan(0)
    const checkoutTextWrites = checkoutWrites.filter(write => write.startsWith('textContent='))
    for (const sentinel of ['fixture-sentinel-branch', 'fixture-sentinel-default', 'fixture-sentinel-path']) {
      expect(checkoutTextWrites.some(write => write.includes(sentinel))).toBe(true)
    }
    expect(checkoutWrites.join('\n')).not.toMatch(/(?:className|classList|dataset|style|aria-|data-)[^\n]*fixture-/)
    expect(checkoutWrites.filter(write => !write.startsWith('textContent=') && write.includes('fixture-'))).toEqual([])
  })

  it('sentinels live only in the closed DTOs inside in-memory run state', () => {
    const sentinel = ckSentinelStatus()
    const provenanceOnly = ckApply(ckLive(), {...sentinel, phase: 'EXECUTING', status: 'running', checkoutPreparation: undefined})
    const preparationOnly = ckApply(ckLive(), {...sentinel, checkoutProvenance: undefined})
    for (const [state, key, needle] of [
      [provenanceOnly, 'checkoutProvenance', 'fixture-sentinel-branch'],
      [preparationOnly, 'checkoutPreparation', 'fixture-sentinel-path'],
    ] as const) {
      const entry = state.runs['run-ck-001'] as unknown as Record<string, unknown>
      const {[key]: dto, ...rest} = entry
      expect(JSON.stringify(dto)).toContain(needle)
      expect(JSON.stringify(rest)).not.toContain('fixture-')
    }
  })

  it('a stream carrying question sentinels touches no console, storage, cache, history, location or HTML sink, and writes no sentinel to any element', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    const storageCalls: string[] = []
    const storage = ckAccessRecorder(storageCalls)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', storage)
    const idbCalls: string[] = []
    vi.stubGlobal('indexedDB', ckAccessRecorder(idbCalls))
    const cacheCalls: string[] = []
    vi.stubGlobal('caches', ckAccessRecorder(cacheCalls))
    const historyCalls: string[] = []
    vi.stubGlobal('history', ckAccessRecorder(historyCalls))
    const locationWrites: string[] = []
    vi.stubGlobal('location', ckAccessRecorder(locationWrites))

    const writes: string[] = []
    vi.stubGlobal('document', {
      createElement: () => ckRecordingElement(writes),
      createTextNode: (text: string) => {
        const node = ckRecordingElement(writes)
        node.textContent = text
        return node
      },
    })

    const open = qOpen('req-q-sentinel', [
      qQuestion({
        header: 'fixture-q-header',
        text: 'fixture-q-text <img src=x onerror=alert(1)> [link](https://example.invalid)',
        options: [{label: 'fixture-q-label', description: 'fixture-q-description'}],
      }),
    ])
    // Three rejected frames, each carrying a sentinel: over-bound, extra key, truncated JSON.
    const overBound = qOpen('req-q-bad', [qQuestion({header: `fixture-q-reject-${'x'.repeat(QUESTION_HEADER_MAX_LENGTH)}`})])
    const extraKey = {...qOpen('req-q-extra'), 'fixture-q-extra-key': 'fixture-q-extra-value'}
    const encoder = new TextEncoder()
    const body = [
      `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n`,
      `event: status\ndata: ${JSON.stringify(ckStatusPayload({runId: Q_RUN}))}\n\n`,
      qSse(open),
      qSse(overBound),
      qSse(extraKey),
      'event: question\ndata: {"fixture-q-truncated\n\n',
    ].join('')
    let read = 0
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {getReader: () => ({read: async () => (read++ === 0 ? {done: false, value: encoder.encode(body)} : new Promise(() => {}))})},
    }))

    const handle = initOperatorStream({
      runId: Q_RUN,
      statusEl: ckRecordingElement(writes) as never,
      noticeEl: ckRecordingElement(writes) as never,
      reasonEl: ckRecordingElement(writes) as never,
      endpointBase: '/operator',
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    handle.close()

    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
    expect(storageCalls).toEqual([])
    expect(idbCalls).toEqual([])
    expect(cacheCalls).toEqual([])
    expect(historyCalls).toEqual([])
    expect(locationWrites).toEqual([])
    // The valid question reached the reducer: the derived status label is painted.
    expect(writes.join('\n')).toContain('Waiting for answer')
    // No question text, accepted or rejected, reaches a text node, attribute, class, dataset or style.
    expect(writes.join('\n')).not.toContain('fixture-q-')
    expect(writes.join('\n')).not.toContain('onerror')
    expect(writes.some(write => /^(?:innerHTML|outerHTML)=/.test(write))).toBe(false)
    // The page store holds ids and drafts only; the stream never writes question text into it.
    const store = getQuestionPageStore(Q_RUN)
    expect(JSON.stringify({tombstones: [...store.tombstones], drafts: [...store.drafts]})).not.toContain('fixture-q-')
  })

  it('the browser question parser rejects bad frames with a fixed error and no log call carrying a sentinel', () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    const rejected = [
      qOpen('req-q-bad', [qQuestion({header: `fixture-q-reject-${'x'.repeat(QUESTION_HEADER_MAX_LENGTH)}`})]),
      {...qOpen('req-q-extra'), 'fixture-q-extra-key': 'fixture-q-extra-value'},
      qOpen('req-q-multiple', [qQuestion({text: 'fixture-q-reject', multiple: 'fixture-q-reject'})]),
      'fixture-q-reject-not-json',
    ]
    for (const payload of rejected) {
      const result = parseSseFrame(qSse(payload))
      expect(result).not.toBeNull()
      expect(result?.success).toBe(false)
      expect(JSON.stringify(result)).not.toContain('fixture-q-')
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
  })

  it('question sentinels live only in the open-question entries of in-memory run state', () => {
    resetQuestionPageStore()
    const sentinel = qOpen('req-q-sentinel', [qQuestion({header: 'fixture-q-header', text: 'fixture-q-text'})])
    const state = qFrameApply(qStatus(qLive(), 'running'), sentinel)
    const entry = qEntry(state) as unknown as Record<string, unknown>
    const {questionOpen, ...rest} = entry
    expect(JSON.stringify([...(questionOpen as Map<string, unknown>).values()])).toContain('fixture-q-header')
    expect(JSON.stringify({...rest, questionClaimedExempt: [...(rest.questionClaimedExempt as Set<string>)]})).not.toContain('fixture-q-')
    expect(JSON.stringify(toSafeRunView(qEntry(state)))).not.toContain('fixture-q-')
    expect(Object.keys(toSafeRunView(qEntry(state))).toSorted()).toEqual(['phase', 'runId', 'stale', 'startedAt', 'status'])
  })
})

/**
 * Streams the given status payloads and returns the rendered elements. By default the connection
 * stays live and open; `closeStream` ends the body after the payloads, and `withoutReasonEl`
 * omits the reason element.
 */
async function renderCheckoutStatuses(
  payloads: Record<string, unknown>[],
  options: {closeStream?: boolean; withoutReasonEl?: boolean} = {},
) {
  const region = makeFakeEl('section')
  const reason = makeFakeEl('p')
  const body = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n${payloads
    .map(payload => `event: status\ndata: ${JSON.stringify(payload)}\n\n`)
    .join('')}`
  let read = 0
  vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag), createTextNode: (text: string) => {
    const node = makeFakeEl('#text')
    node.textContent = text
    return node
  }})
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200, headers: {get: () => 'text/event-stream'},
    body: {getReader: () => ({read: async () => read++ === 0
      ? {done: false, value: new TextEncoder().encode(body)}
      : options.closeStream === true ? {done: true} : new Promise(() => {})})},
  }))
  const handle = initOperatorStream({
    runId: 'run-ck-001',
    statusEl: makeFakeEl(),
    noticeEl: makeFakeEl(),
    ...(options.withoutReasonEl === true ? {} : {reasonEl: reason}),
    checkoutEl: region as never,
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  handle.close()
  const textOf = (element: FakeElement): string => element.textContent + element.children.map(textOf).join('')
  return {region, reason, regionText: textOf(region)}
}

describe('checkout rendering — labelled safe detail region', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders observed provenance head, worktree and remote lines', async () => {
    const region = makeFakeEl('section')
    const reason = makeFakeEl('p')
    const status = makeFakeEl('span')
    const notice = makeFakeEl('p')
    const payload = ckStatusPayload({
      phase: 'FAILED', status: 'failed',
      checkoutProvenance: ckObserved({
        observation: ckObservation({
          head: {kind: 'attached', branch: 'fixture-main', sha: CK_SHA_A},
          worktree: {kind: 'clean'}, operationInProgress: 'none',
        }),
        remote: {kind: 'checked', change: 'unchanged', defaultBranch: 'main', sha: CK_SHA_B, checkedAt: 'now'},
      }),
    })
    let read = 0
    vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag), createTextNode: (text: string) => {
      const node = makeFakeEl('#text')
      node.textContent = text
      return node
    }})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: {get: () => 'text/event-stream'},
      body: {getReader: () => ({read: async () => read++ === 0
        ? {done: false, value: new TextEncoder().encode(`event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\nevent: status\ndata: ${JSON.stringify(payload)}\n\n`)}
        : {done: true}})},
    }))
    const handle = initOperatorStream({runId: 'run-ck-001', statusEl: status, noticeEl: notice, reasonEl: reason, checkoutEl: region as never})
    await new Promise(resolve => setTimeout(resolve, 30))
    handle.close()
    const textOf = (element: FakeElement): string => element.textContent + element.children.map(textOf).join('')
    const rendered = region.children
    expect(region.hidden).toBe(false)
    expect(rendered[0] && textOf(rendered[0])).toContain('Started from fixture-main at aaaaaaa')
    expect(rendered.map(textOf).join(' ')).toContain('Up to date with main')
    expect(rendered.map(textOf).join(' ')).toContain('Clean worktree')
  })

  it('renders a refused dirty headline and at most 10 paths with an overflow line', async () => {
    const region = makeFakeEl('section')
    const reason = makeFakeEl('p')
    let read = 0
    const payload = ckStatusPayload({
      phase: 'FAILED', status: 'failed',
      checkoutPreparation: {outcome: 'refused', reason: 'dirty', changedPaths: Array.from({length: 12}, (_, index) => `/tmp/path-${index}`)},
    })
    vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag), createTextNode: (text: string) => {
      const node = makeFakeEl('#text')
      node.textContent = text
      return node
    }})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: {get: () => 'text/event-stream'},
      body: {getReader: () => ({read: async () => read++ === 0
        ? {done: false, value: new TextEncoder().encode(`event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\nevent: status\ndata: ${JSON.stringify(payload)}\n\n`)}
        : {done: true}})},
    }))
    const handle = initOperatorStream({runId: 'run-ck-001', statusEl: makeFakeEl(), noticeEl: makeFakeEl(), reasonEl: reason, checkoutEl: region as never})
    await new Promise(resolve => setTimeout(resolve, 30))
    handle.close()
    const textOf = (element: FakeElement): string => element.textContent + element.children.map(textOf).join('')
    const allElements = (element: FakeElement): FakeElement[] => element.children.flatMap(child => [child, ...allElements(child)])
    expect(reason.textContent).toBe('Checkout refused: uncommitted changes')
    expect(textOf(region)).toContain('/tmp/path-0')
    expect(textOf(region)).toContain('and 2 more')
    expect(allElements(region).filter(element => element.tagName === 'li')).toHaveLength(10)
  })

  it('renders failed-preparation flags as their fixed sentences below the headline', async () => {
    const region = makeFakeEl('section')
    const reason = makeFakeEl('p')
    let read = 0
    const payload = ckStatusPayload({
      phase: 'FAILED', status: 'failed',
      checkoutPreparation: {outcome: 'failed', reason: 'fetch-timeout', permanent: true, mutationStarted: 'possibly'},
    })
    vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag), createTextNode: (text: string) => {
      const node = makeFakeEl('#text')
      node.textContent = text
      return node
    }})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: {get: () => 'text/event-stream'},
      body: {getReader: () => ({read: async () => read++ === 0
        ? {done: false, value: new TextEncoder().encode(`event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\nevent: status\ndata: ${JSON.stringify(payload)}\n\n`)}
        : {done: true}})},
    }))
    const handle = initOperatorStream({runId: 'run-ck-001', statusEl: makeFakeEl(), noticeEl: makeFakeEl(), reasonEl: reason, checkoutEl: region as never})
    await new Promise(resolve => setTimeout(resolve, 30))
    handle.close()
    const textOf = (element: FakeElement): string => element.textContent + element.children.map(textOf).join('')
    expect(reason.textContent).toBe('Checkout update failed: fetch timed out')
    expect(textOf(region)).toContain("Retrying won't help.")
    expect(textOf(region)).toContain('The checkout may have been partly changed.')
  })

  it('hides and clears the region on attach when the status has no checkout DTOs', async () => {
    const region = makeFakeEl('section')
    region.append(makeFakeEl('p'))
    region.hidden = false
    vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag), createTextNode: (text: string) => {
      const node = makeFakeEl('#text')
      node.textContent = text
      return node
    }})
    vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>(() => {})))
    const handle = initOperatorStream({runId: 'run-ck-001', statusEl: makeFakeEl(), noticeEl: makeFakeEl(), checkoutEl: region as never})
    expect(region.hidden).toBe(true)
    expect(region.children).toHaveLength(0)
    handle.close()
  })

  it('does not repeat checkout-substituted preparation under its matching failure headline', async () => {
    const region = makeFakeEl('section')
    const reason = makeFakeEl('p')
    let read = 0
    const payload = ckStatusPayload({
      phase: 'FAILED', status: 'failed', failureKind: 'checkout-substituted',
      checkoutPreparation: {outcome: 'refused', reason: 'checkout-substituted'},
    })
    vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag), createTextNode: (text: string) => {
      const node = makeFakeEl('#text')
      node.textContent = text
      return node
    }})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: {get: () => 'text/event-stream'},
      body: {getReader: () => ({read: async () => read++ === 0
        ? {done: false, value: new TextEncoder().encode(`event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\nevent: status\ndata: ${JSON.stringify(payload)}\n\n`)}
        : {done: true}})},
    }))
    const handle = initOperatorStream({runId: 'run-ck-001', statusEl: makeFakeEl(), noticeEl: makeFakeEl(), reasonEl: reason, checkoutEl: region as never})
    await new Promise(resolve => setTimeout(resolve, 30))
    handle.close()
    const textOf = (element: FakeElement): string => element.textContent + element.children.map(textOf).join('')
    expect(reason.textContent).toBe('Checkout mismatch')
    expect(textOf(region)).not.toContain('checkout mismatch')
  })

  it('clears the reason line when a later status replaces the preparation with provenance', async () => {
    const preparation = ckStatusPayload({phase: 'PENDING', status: 'queued', checkoutPreparation: {outcome: 'refused', reason: 'detached'}})
    const provenance = ckStatusPayload({phase: 'EXECUTING', status: 'running', checkoutProvenance: ckObserved()})

    const before = await renderCheckoutStatuses([preparation])
    expect(before.reason.textContent).toBe('Checkout refused: detached HEAD')
    expect(before.reason.dataset.reasonState).toBe('present')

    const after = await renderCheckoutStatuses([preparation, provenance])
    expect(after.reason.textContent).toBe('')
    expect(after.reason.dataset.reasonState).toBeUndefined()
    expect(after.regionText).not.toContain('Checkout refused')
  })

  it('keeps the preparation reason in the region when the connection is not live and the headline is cleared', async () => {
    const preparation = {outcome: 'refused', reason: 'detached'}
    const closed = await renderCheckoutStatuses(
      [ckStatusPayload({phase: 'PENDING', status: 'queued', checkoutPreparation: preparation})],
      {closeStream: true},
    )
    expect(closed.reason.textContent).toBe('')
    expect(closed.regionText).toBe('detached HEAD')
  })

  it('keeps the preparation reason in the region when no reason element exists', async () => {
    const preparation = {outcome: 'refused', reason: 'detached'}
    const {regionText} = await renderCheckoutStatuses(
      [ckStatusPayload({phase: 'PENDING', status: 'queued', checkoutPreparation: preparation})],
      {withoutReasonEl: true},
    )
    expect(regionText).toBe('detached HEAD')
  })

  it('omits the preparation reason from the region while the live headline already shows it', async () => {
    const preparation = {outcome: 'refused', reason: 'detached'}
    const {reason, regionText} = await renderCheckoutStatuses([
      ckStatusPayload({phase: 'PENDING', status: 'queued', checkoutPreparation: preparation}),
    ])
    expect(reason.textContent).toBe('Checkout refused: detached HEAD')
    expect(regionText).toBe('')
  })

  it('renders an operation-in-progress refusal with operation none as fixed copy, without a blank operation name', async () => {
    const preparation = {outcome: 'refused', reason: 'operation-in-progress', operation: 'none'}
    const headline = await renderCheckoutStatuses([ckStatusPayload({phase: 'FAILED', status: 'failed', checkoutPreparation: preparation})])
    expect(headline.reason.textContent).toBe('Checkout refused: operation in progress')

    // With a failure reason on the headline, the region repeats the preparation reason as its own line.
    const detail = await renderCheckoutStatuses([
      ckStatusPayload({phase: 'FAILED', status: 'failed', failureKind: 'session-error', checkoutPreparation: preparation}),
    ])
    expect(detail.reason.textContent).toBe('Session error')
    expect(detail.regionText).toBe('operation in progress')
  })

  it('renders provenance operationInProgress none as no line', async () => {
    const payload = ckStatusPayload({
      phase: 'FAILED', status: 'failed',
      checkoutProvenance: ckObserved({observation: ckObservation({operationInProgress: 'none'})}),
    })
    const {regionText} = await renderCheckoutStatuses([payload])
    expect(regionText).not.toContain('in progress')
  })
})

// ===========================================================================
// Agent questions — browser parser, run-entry state, page store, effective status
// ===========================================================================

function qQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    header: 'Pick one',
    text: 'Which option?',
    options: [{label: 'alpha', description: 'The first option'}],
    multiple: false,
    custom: true,
    ...overrides,
  }
}

function qOpen(requestID = 'req-q-1', questions: unknown[] = [qQuestion()], runId = Q_RUN): Record<string, unknown> {
  return {runId, requestID, settled: false, questions}
}

function qSettle(requestID = 'req-q-1', runId = Q_RUN): Record<string, unknown> {
  return {runId, requestID, settled: true}
}

/** A `question` SSE record. A string payload is used as the raw data line. */
function qSse(payload: unknown): string {
  return `event: question\ndata: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
}

function qFakeText(element: FakeElement): string {
  return element.textContent + element.children.map(qFakeText).join('')
}

function qFakeFindAll(element: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement[] {
  return [
    ...(predicate(element) ? [element] : []),
    ...element.children.flatMap(child => qFakeFindAll(child, predicate)),
  ]
}

function qRequired<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a rendered question control')
  return value
}

async function renderQuestionFrames(
  requests: Record<string, unknown>[],
  decision: (requestId: string, value: QuestionDecision) => Promise<QuestionDecisionOutcome> = async () => ({kind: 'decided', state: 'failed_to_settle'}),
  list: () => Promise<QuestionListResult> = async () => new Promise<never>(() => {}),
) {
  const region = makeFakeEl('section')
  region.hidden = true
  const calls: {requestId: string; decision: QuestionDecision}[] = []
  vi.stubGlobal('document', {
    createElement: (tagName: string) => makeFakeEl(tagName),
    createTextNode: (text: string) => {
      const node = makeFakeEl('#text')
      node.textContent = text
      return node
    },
  })
  const body = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n${requests.map(qSse).join('')}`
  let read = 0
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status: 200,
    headers: {get: () => 'text/event-stream'},
    body: {getReader: () => ({read: async () => read++ === 0
      ? {done: false, value: new TextEncoder().encode(body)}
      : new Promise(() => {})})},
  }))
  const handle = initOperatorStream({
    runId: Q_RUN,
    statusEl: makeFakeEl('span'),
    noticeEl: makeFakeEl('p'),
    questionsEl: region as never,
    questionClient: {
      listRunQuestions: list,
      decideRunQuestion: async (_runId, requestId, value) => {
        calls.push({requestId, decision: value})
        return decision(requestId, value)
      },
    },
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  return {region, calls, handle}
}

describe('question region — answer controls and decision bodies', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetQuestionPageStore()
  })

  it('renders request cards and question groups in arrival order with radio and checkbox controls', async () => {
    const {region, handle} = await renderQuestionFrames([
      qOpen('req-first', [qQuestion({header: 'First question'})]),
      qOpen('req-second', [qQuestion({header: 'Second question', multiple: true})]),
    ])
    const cards = region.children.filter(child => child.className.includes('question-region__request'))
    const legends = qFakeFindAll(region, node => node.tagName === 'legend').map(node => node.textContent)
    const inputs = qFakeFindAll(region, node => node.tagName === 'input')

    expect(region.hidden).toBe(false)
    expect(cards).toHaveLength(2)
    expect(region.children.at(-1)?.className).toBe('question-region__announcer')
    expect(legends).toEqual(['First question', 'Second question'])
    expect(inputs.map(input => input.type)).toEqual(['radio', 'checkbox'])
    expect(inputs.every(input => !input.checked)).toBe(true)
    handle.close()
  })

  it('keeps the question region hidden when no open requests or notes exist', async () => {
    const {region, handle} = await renderQuestionFrames([])
    expect(region.hidden).toBe(true)
    handle.close()
  })

  it('submits selected option indices and trimmed custom text in question order', async () => {
    const {region, calls, handle} = await renderQuestionFrames([
      qOpen('req-answer', [
        qQuestion({options: [{label: 'A', description: ''}, {label: 'B', description: ''}], custom: false}),
        qQuestion({multiple: true, options: [{label: 'C', description: ''}, {label: 'D', description: ''}]}),
      ]),
    ])
    const inputs = qFakeFindAll(region, node => node.tagName === 'input')
    qRequired(inputs[1]).checked = true
    qRequired(inputs[1]).dispatchEvent({type: 'change'})
    qRequired(inputs[2]).checked = true
    qRequired(inputs[2]).dispatchEvent({type: 'change'})
    qRequired(inputs[3]).checked = true
    qRequired(inputs[3]).dispatchEvent({type: 'change'})
    const textarea = qRequired(qFakeFindAll(region, node => node.tagName === 'textarea')[0])
    textarea.value = '  write a note  '
    textarea.dispatchEvent({type: 'input'})
    qRequired(qFakeFindAll(region, node => node.className === 'question-region__submit')[0]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    expect(calls[0]).toEqual({
      requestId: 'req-answer',
      decision: {decision: 'answer', answers: [{options: [1]}, {options: [0, 1], text: 'write a note'}]},
    })
    handle.close()
  })

  it('blocks a single-choice answer with both values while retaining both values', async () => {
    const {region, handle} = await renderQuestionFrames([qOpen('req-both', [qQuestion()])])
    const radio = qRequired(qFakeFindAll(region, node => node.tagName === 'input')[0])
    const textarea = qRequired(qFakeFindAll(region, node => node.tagName === 'textarea')[0])
    radio.checked = true
    radio.dispatchEvent({type: 'change'})
    textarea.value = 'custom value'
    textarea.dispatchEvent({type: 'input'})

    expect(qFakeFindAll(region, node => node.className === 'question-region__submit')[0]?.disabled).toBe(true)
    expect(qFakeText(region)).toContain('Choose an option or type an answer, not both.')
    expect(radio.checked).toBe(true)
    expect(textarea.value).toBe('custom value')
    handle.close()
  })

  it('sends an empty answer object for unanswerable questions and an empty answers array for zero questions', async () => {
    const {region, calls, handle} = await renderQuestionFrames([
      qOpen('req-unanswerable', [qQuestion({options: [], custom: false})]),
      qOpen('req-empty', []),
    ])
    const submits = qFakeFindAll(region, node => node.className === 'question-region__submit')
    expect(submits.map(button => button.disabled)).toEqual([false, false])
    qRequired(submits[0]).dispatchEvent({type: 'click'})
    qRequired(submits[1]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(calls).toHaveLength(2))

    expect(calls.map(call => call.decision)).toEqual([
      {decision: 'answer', answers: [{}]},
      {decision: 'answer', answers: []},
    ])
    handle.close()
  })

  it('treats whitespace as unanswered, enforces the UTF-16 limit, and trims on submit', async () => {
    const {region, calls, handle} = await renderQuestionFrames([qOpen('req-text-limit', [qQuestion({options: [], custom: true})])])
    const textarea = qRequired(qFakeFindAll(region, node => node.tagName === 'textarea')[0])
    const submit = qRequired(qFakeFindAll(region, node => node.className === 'question-region__submit')[0])
    textarea.value = '   \t  '
    textarea.dispatchEvent({type: 'input'})
    expect(submit.disabled).toBe(true)
    textarea.value = 'x'.repeat(4001)
    textarea.dispatchEvent({type: 'input'})
    expect(submit.disabled).toBe(true)
    expect(qFakeText(region)).toContain('Shorten this answer to 4,000 characters or fewer.')
    textarea.value = 'x'.repeat(4000)
    textarea.dispatchEvent({type: 'input'})
    expect(submit.disabled).toBe(false)
    textarea.value = '  answer text  '
    textarea.dispatchEvent({type: 'input'})
    submit.dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.decision).toEqual({decision: 'answer', answers: [{text: 'answer text'}]})
    handle.close()
  })

  it('skip sends immediately and discards only that request draft', async () => {
    const {region, calls, handle} = await renderQuestionFrames([
      qOpen('req-skip', [qQuestion()]),
      qOpen('req-keep', [qQuestion()]),
    ])
    const fields = qFakeFindAll(region, node => node.tagName === 'textarea')
    qRequired(fields[0]).value = 'discard this'
    qRequired(fields[0]).dispatchEvent({type: 'input'})
    qRequired(fields[1]).value = 'keep this'
    qRequired(fields[1]).dispatchEvent({type: 'input'})
    const skip = qRequired(qFakeFindAll(region, node => node.className === 'question-region__skip')[0])
    skip.dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    expect(calls[0]?.decision).toEqual({decision: 'skip'})
    expect(getQuestionPageStore(Q_RUN).drafts.has('req-skip')).toBe(false)
    expect(getQuestionPageStore(Q_RUN).drafts.get('req-keep')).toEqual([{options: [], text: 'keep this'}])
    expect(fields[1]?.value).toBe('keep this')
    handle.close()
  })

  it('keeps another request editable while the first request is in flight', async () => {
    const pending = new Promise<QuestionDecisionOutcome>(() => {})
    const {region, calls, handle} = await renderQuestionFrames([
      qOpen('req-flight', [qQuestion()]),
      qOpen('req-independent', [qQuestion()]),
    ], async () => pending)
    const fields = qFakeFindAll(region, node => node.tagName === 'textarea')
    qRequired(fields[0]).value = 'first'
    qRequired(fields[0]).dispatchEvent({type: 'input'})
    qRequired(fields[1]).value = 'second'
    qRequired(fields[1]).dispatchEvent({type: 'input'})
    const submits = qFakeFindAll(region, node => node.className === 'question-region__submit')
    qRequired(submits[0]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    expect(submits[0]?.disabled).toBe(true)
    expect(submits[1]?.disabled).toBe(false)
    expect(fields[1]?.disabled).toBe(false)
    expect(fields[1]?.value).toBe('second')
    expect(qFakeText(region)).toContain('Sending answers…')
    handle.close()
  })

  it('preserves inputs and shows the retryable failed-to-settle copy', async () => {
    const {region, handle} = await renderQuestionFrames([qOpen('req-failed', [qQuestion()])])
    const field = qRequired(qFakeFindAll(region, node => node.tagName === 'textarea')[0])
    field.value = 'draft answer'
    field.dispatchEvent({type: 'input'})
    qRequired(qFakeFindAll(region, node => node.className === 'question-region__submit')[0]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(qFakeText(region)).toContain("Your answer wasn't recorded. Try again."))
    expect(field.value).toBe('draft answer')
    expect(qFakeFindAll(region, node => node.className === 'question-region__submit')[0]?.disabled).toBe(false)
    handle.close()
  })

  it('keeps question text and draft visible but removes controls after a masked denial', async () => {
    const {region, handle} = await renderQuestionFrames([qOpen('req-denied', [qQuestion()])], async () => ({kind: 'cant-answer'}))
    const field = qRequired(qFakeFindAll(region, node => node.tagName === 'textarea')[0])
    field.value = 'private draft'
    field.dispatchEvent({type: 'input'})
    qRequired(qFakeFindAll(region, node => node.className === 'question-region__submit')[0]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(qFakeText(region)).toContain("You can't answer questions for this run."))

    expect(field.value).toBe('private draft')
    expect(qFakeFindAll(region, node => node.tagName === 'fieldset')[0]?.hidden).toBe(false)
    expect(qFakeFindAll(region, node => node.className === 'question-region__controls')[0]?.hidden).toBe(true)
    handle.close()
  })

  it('keeps the draft and shows the session-expired copy', async () => {
    const {region, handle} = await renderQuestionFrames([qOpen('req-session', [qQuestion()])], async () => ({kind: 'session-expired'}))
    const field = qRequired(qFakeFindAll(region, node => node.tagName === 'textarea')[0])
    field.value = 'retry after sign-in'
    field.dispatchEvent({type: 'input'})
    qRequired(qFakeFindAll(region, node => node.className === 'question-region__submit')[0]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(qFakeText(region)).toContain('Your session expired. Sign in again in another tab, then try again.'))
    expect(field.value).toBe('retry after sign-in')
    handle.close()
  })

  it('shows claimed-elsewhere, offers Check again, and announces checking', async () => {
    const {region, handle} = await renderQuestionFrames([qOpen('req-claimed', [qQuestion()])], async () => ({kind: 'decided', state: 'already_claimed'}))
    const field = qRequired(qFakeFindAll(region, node => node.tagName === 'textarea')[0])
    field.value = 'kept draft'
    field.dispatchEvent({type: 'input'})
    qRequired(qFakeFindAll(region, node => node.className === 'question-region__submit')[0]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(qFakeText(region)).toContain('This question is being answered elsewhere.'))
    const check = qRequired(qFakeFindAll(region, node => node.className === 'question-region__check')[0])
    expect(check.hidden).toBe(false)
    check.dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(qFakeText(region)).toContain('Checking whether your answer was recorded…'))
    expect(field.value).toBe('kept draft')
    handle.close()
  })

  it('shows the check-failed copy when Check again cannot list questions', async () => {
    const {region, handle} = await renderQuestionFrames(
      [qOpen('req-check-failed', [qQuestion()])],
      async () => ({kind: 'decided', state: 'already_claimed'}),
      async () => ({success: false, error: {kind: 'network'}}),
    )
    const field = qRequired(qFakeFindAll(region, node => node.tagName === 'textarea')[0])
    field.value = 'answer'
    field.dispatchEvent({type: 'input'})
    qRequired(qFakeFindAll(region, node => node.className === 'question-region__submit')[0]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(qFakeText(region)).toContain('This question is being answered elsewhere.'))
    qRequired(qFakeFindAll(region, node => node.className === 'question-region__check')[0]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(qFakeText(region)).toContain("Couldn't check for questions. Try again."))
    handle.close()
  })

  it('keeps settled and unknown-outcome notes visible until the request disappears from the card', async () => {
    const {region, handle} = await renderQuestionFrames(
      [qOpen('req-note', [qQuestion()])],
      async () => ({kind: 'decided', state: 'already_settled'}),
    )
    const field = qRequired(qFakeFindAll(region, node => node.tagName === 'textarea')[0])
    field.value = 'answer'
    field.dispatchEvent({type: 'input'})
    qRequired(qFakeFindAll(region, node => node.className === 'question-region__submit')[0]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(qFakeText(region)).toContain('This question is no longer open.'))
    expect(region.hidden).toBe(false)
    expect(qFakeFindAll(region, node => node.className === 'question-region__controls')[0]?.getAttribute('aria-disabled')).toBe('true')
    handle.close()
  })

  it('shows the may-have-been-recorded note after an unknown outcome is absent from the list', async () => {
    const {region, handle} = await renderQuestionFrames(
      [qOpen('req-gone', [qQuestion()])],
      async () => ({kind: 'unknown'}),
      async () => ({success: true, data: {requests: [], invalidBody: false, partial: false}}),
    )
    const field = qRequired(qFakeFindAll(region, node => node.tagName === 'textarea')[0])
    field.value = 'maybe sent'
    field.dispatchEvent({type: 'input'})
    qRequired(qFakeFindAll(region, node => node.className === 'question-region__submit')[0]).dispatchEvent({type: 'click'})
    await vi.waitFor(() => expect(qFakeText(region)).toContain('This question is no longer open. Your answer may have been recorded.'))
    expect(region.hidden).toBe(false)
    handle.close()
  })
})

function qBrowser(payload: unknown) {
  const result = parseSseFrame(qSse(payload))
  if (result === null || !result.success || result.frame.type !== 'question') return undefined
  return result.frame.data
}

function qServer(payload: unknown) {
  const result = parseSseChunk(qSse(payload))[0]
  if (result === undefined || !result.success || result.frame.type !== 'question') return undefined
  return result.frame.data
}

function qLive(): StreamState {
  return ckLive()
}

function qFrameApply(state: StreamState, payload: unknown): StreamState {
  const data = qBrowser(payload)
  if (data === undefined) throw new Error('fixture question frame did not parse')
  return nextStreamState(state, {type: 'question', data})
}

function qStatus(state: StreamState, status: string, runId = Q_RUN): StreamState {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status)
  return ckApply(state, ckStatusPayload({runId, status, phase: terminal ? 'COMPLETED' : 'EXECUTING'}))
}

function qEntry(state: StreamState, runId = Q_RUN): RunEntry {
  const entry = state.runs[runId]
  if (entry === undefined) throw new Error(`expected run ${runId} in state`)
  return entry
}

function qIds(state: StreamState, runId = Q_RUN): string[] {
  return getOpenQuestions(state.runs[runId]).map(request => request.requestID)
}

function qWithExempt(state: StreamState, ids: string[]): StreamState {
  return {...state, runs: {...state.runs, [Q_RUN]: {...qEntry(state), questionClaimedExempt: new Set(ids)}}}
}

function qReconcile(
  state: StreamState,
  listed: string[],
  options: {snapshot?: string[]; invalidBody?: boolean; partial?: boolean} = {},
): StreamState {
  const event: QuestionReconcileEvent = {
    type: 'question-reconcile',
    runId: Q_RUN,
    snapshotIds: options.snapshot ?? qIds(state),
    requests: listed.map(requestID => ({requestID, questions: [qQuestion()] as never})),
    invalidBody: options.invalidBody ?? false,
    partial: options.partial ?? false,
  }
  return nextStreamState(state, event)
}

describe('question frames — browser parser agrees with the server parser', () => {
  const longText = (length: number) => 'x'.repeat(length)
  const parityCases: [string, unknown, boolean][] = [
    ['open frame with two questions', qOpen('req-q-1', [qQuestion(), qQuestion({header: 'Second', multiple: true, custom: false})]), true],
    ['settle frame', qSettle(), true],
    ['request with zero questions', qOpen('req-q-1', []), true],
    ['zero options, custom false, multiple true', qOpen('req-q-1', [qQuestion({options: [], custom: false, multiple: true})]), true],
    ['tab, newline and carriage return in text', qOpen('req-q-1', [qQuestion({text: 'a\tb\nc\rd'})]), true],
    ['a bidi override in text', qOpen('req-q-1', [qQuestion({text: 'a\u202Eb'})]), true],
    ['header at its bound', qOpen('req-q-1', [qQuestion({header: longText(QUESTION_HEADER_MAX_LENGTH)})]), true],
    ['header over its bound', qOpen('req-q-1', [qQuestion({header: longText(QUESTION_HEADER_MAX_LENGTH + 1)})]), false],
    ['text at its bound', qOpen('req-q-1', [qQuestion({text: longText(QUESTION_TEXT_MAX_LENGTH)})]), true],
    ['text over its bound', qOpen('req-q-1', [qQuestion({text: longText(QUESTION_TEXT_MAX_LENGTH + 1)})]), false],
    ['text over its bound only before control removal', qOpen('req-q-1', [qQuestion({text: `${longText(QUESTION_TEXT_MAX_LENGTH)}\u0007\u202E`})]), true],
    ['text over its bound after tab becomes one space', qOpen('req-q-1', [qQuestion({text: `${longText(QUESTION_TEXT_MAX_LENGTH)}\t`})]), false],
    ['label at its bound', qOpen('req-q-1', [qQuestion({options: [{label: longText(QUESTION_OPTION_LABEL_MAX_LENGTH), description: ''}]})]), true],
    ['label over its bound', qOpen('req-q-1', [qQuestion({options: [{label: longText(QUESTION_OPTION_LABEL_MAX_LENGTH + 1), description: ''}]})]), false],
    ['description at its bound', qOpen('req-q-1', [qQuestion({options: [{label: 'a', description: longText(QUESTION_OPTION_DESCRIPTION_MAX_LENGTH)}]})]), true],
    ['description over its bound', qOpen('req-q-1', [qQuestion({options: [{label: 'a', description: longText(QUESTION_OPTION_DESCRIPTION_MAX_LENGTH + 1)}]})]), false],
    ['questions at the cap', qOpen('req-q-1', Array.from({length: MAX_QUESTIONS_PER_REQUEST}, () => qQuestion())), true],
    ['questions over the cap', qOpen('req-q-1', Array.from({length: MAX_QUESTIONS_PER_REQUEST + 1}, () => qQuestion())), false],
    ['options at the cap', qOpen('req-q-1', [qQuestion({options: Array.from({length: MAX_OPTIONS_PER_QUESTION}, (_, index) => ({label: `o${index}`, description: ''}))})]), true],
    ['options over the cap', qOpen('req-q-1', [qQuestion({options: Array.from({length: MAX_OPTIONS_PER_QUESTION + 1}, (_, index) => ({label: `o${index}`, description: ''}))})]), false],
    ['non-boolean multiple', qOpen('req-q-1', [qQuestion({multiple: 'yes'})]), false],
    ['non-boolean custom', qOpen('req-q-1', [qQuestion({custom: 1})]), false],
    ['missing custom', qOpen('req-q-1', [(({custom: _custom, ...rest}) => rest)(qQuestion() as {custom: unknown})]), false],
    ['extra key on the frame', {...qOpen(), extra: 1}, false],
    ['extra key on a question', qOpen('req-q-1', [qQuestion({extra: 1})]), false],
    ['extra key on an option', qOpen('req-q-1', [qQuestion({options: [{label: 'a', description: 'b', extra: 1}]})]), false],
    ['extra key on a settle frame', {...qSettle(), questions: []}, false],
    ['open frame without questions', {runId: Q_RUN, requestID: 'req-q-1', settled: false}, false],
    ['non-array questions', qOpen('req-q-1', 'nope' as never), false],
    ['non-array options', qOpen('req-q-1', [qQuestion({options: 'nope'})]), false],
    ['non-string header', qOpen('req-q-1', [qQuestion({header: 7})]), false],
    ['non-string label', qOpen('req-q-1', [qQuestion({options: [{label: 7, description: ''}]})]), false],
    ['non-object question', qOpen('req-q-1', ['nope']), false],
    ['array as a question', qOpen('req-q-1', [[]]), false],
    ['settled as a string', {...qSettle(), settled: 'true'}, false],
    ['missing runId', {requestID: 'req-q-1', settled: true}, false],
    ['empty requestID', qSettle(''), false],
    ['non-string requestID', {...qSettle(), requestID: 5}, false],
    ['an own __proto__ key on the frame', '{"runId":"run-q-001","requestID":"req-q-1","settled":true,"__proto__":{"x":1}}', false],
    ['an own __proto__ key on a question', `{"runId":"run-q-001","requestID":"req-q-1","settled":false,"questions":[{"header":"h","text":"t","options":[],"multiple":false,"custom":true,"__proto__":{"x":1}}]}`, false],
  ]

  for (const [name, payload, accepted] of parityCases) {
    it(`${name} → ${accepted ? 'accepted' : 'rejected'} by both, and equal when accepted`, () => {
      const server = qServer(payload)
      const browser = qBrowser(payload)
      expect(server !== undefined).toBe(accepted)
      expect(browser !== undefined).toBe(accepted)
      if (accepted) expect(browser).toEqual(server)
    })
  }

  it('applies the same text rule to every control, bidi and whitespace code unit', () => {
    const removed = new Set<number>([
      ...Array.from({length: 0x20}, (_, code) => code),
      ...Array.from({length: 0x21}, (_, offset) => 0x7F + offset),
      0x061C, 0x200E, 0x200F,
      ...Array.from({length: 5}, (_, offset) => 0x202A + offset),
      ...Array.from({length: 4}, (_, offset) => 0x2066 + offset),
    ])
    for (const code of [...removed, 0x20, 0x41, 0xA0, 0x2028, 0x200B]) {
      const char = String.fromCharCode(code)
      const payload = qOpen('req-q-1', [qQuestion({text: `a${char}b`, header: `a${char}b`})])
      const expected = [9, 10, 13].includes(code) ? 'a b' : removed.has(code) ? 'ab' : `a${char}b`
      const browser = qBrowser(payload)
      const server = qServer(payload)
      expect(browser, `code unit ${code}`).toBeDefined()
      expect(browser, `code unit ${code}`).toEqual(server)
      expect(browser !== undefined && !browser.settled ? browser.questions[0]?.text : undefined, `code unit ${code}`).toBe(expected)
    }
  })

  it('rebuilds a closed object: the parsed result shares nothing with the input', () => {
    const input = qOpen('req-q-1', [qQuestion()])
    const browser = qBrowser(input)
    expect(browser).toEqual({runId: Q_RUN, requestID: 'req-q-1', settled: false, questions: [qQuestion()]})
    expect(Object.getPrototypeOf(browser)).toBe(Object.prototype)
  })

  it('rejects with a fixed error that never echoes the input', () => {
    const result = parseSseFrame(qSse(qOpen('req-q-1', [qQuestion({header: `fixture-q-echo-${longText(QUESTION_HEADER_MAX_LENGTH)}`})])))
    expect(result?.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain('fixture-q-echo')
    const again = parseSseFrame(qSse(qOpen('req-q-1', [qQuestion({multiple: 'x'})])))
    expect(again).toEqual(result)
  })
})

describe('nextStreamState — question frames', () => {
  beforeEach(() => resetQuestionPageStore())
  afterEach(() => resetQuestionPageStore())

  it('open then settle: the question is present, then removed and tombstoned for the page', () => {
    let state = qFrameApply(qLive(), qOpen('req-q-1'))
    expect(qIds(state)).toEqual(['req-q-1'])
    expect(hasOpenQuestions(qEntry(state))).toBe(true)
    expect(getOpenQuestions(qEntry(state))[0]?.questions).toEqual([qQuestion()])
    state = qFrameApply(state, qSettle('req-q-1'))
    expect(qIds(state)).toEqual([])
    expect(hasOpenQuestions(qEntry(state))).toBe(false)
    expect(getQuestionPageStore(Q_RUN).tombstones.has('req-q-1')).toBe(true)
  })

  it('settle before open tombstones the request, so a later open is ignored', () => {
    let state = qFrameApply(qLive(), qSettle('req-q-1'))
    expect(getQuestionPageStore(Q_RUN).tombstones.has('req-q-1')).toBe(true)
    state = qFrameApply(state, qOpen('req-q-1'))
    expect(qIds(state)).toEqual([])
  })

  it('a settle frame removes the request draft and the claimed exemption', () => {
    let state = qWithExempt(qFrameApply(qLive(), qOpen('req-q-1')), ['req-q-1'])
    getQuestionPageStore(Q_RUN).drafts.set('req-q-1', {fixture: 'draft'})
    state = qFrameApply(state, qSettle('req-q-1'))
    expect(getQuestionPageStore(Q_RUN).drafts.has('req-q-1')).toBe(false)
    expect(qEntry(state).questionClaimedExempt?.has('req-q-1')).toBe(false)
  })

  it('a duplicate open keeps one entry and the existing draft', () => {
    let state = qFrameApply(qLive(), qOpen('req-q-1'))
    const draft = {fixture: 'draft'}
    getQuestionPageStore(Q_RUN).drafts.set('req-q-1', draft)
    state = qFrameApply(state, qOpen('req-q-1', [qQuestion({text: 'replayed'})]))
    expect(qIds(state)).toEqual(['req-q-1'])
    expect(getQuestionPageStore(Q_RUN).drafts.get('req-q-1')).toBe(draft)
  })

  it('keeps requests in arrival order, including integer-like request ids', () => {
    let state = qLive()
    for (const id of ['10', '2', 'req-b', '1']) state = qFrameApply(state, qOpen(id))
    expect(qIds(state)).toEqual(['10', '2', 'req-b', '1'])
  })

  it('rejects the 51st open on a run and keeps the first 50', () => {
    expect(MAX_OPEN_QUESTIONS).toBe(50)
    let state = qLive()
    for (let index = 0; index < MAX_OPEN_QUESTIONS; index++) state = qFrameApply(state, qOpen(`req-q-${index}`))
    const full = state
    state = qFrameApply(state, qOpen('req-q-overflow'))
    expect(state).toBe(full)
    expect(qIds(state)).toHaveLength(MAX_OPEN_QUESTIONS)
    expect(qIds(state)).not.toContain('req-q-overflow')
    expect(qIds(state)[0]).toBe('req-q-0')
    // A duplicate of an existing request at the cap is still a no-op, and a settle still frees a slot.
    expect(qFrameApply(state, qOpen('req-q-0'))).toBe(state)
    state = qFrameApply(qFrameApply(state, qSettle('req-q-0')), qOpen('req-q-overflow'))
    expect(qIds(state)).toHaveLength(MAX_OPEN_QUESTIONS)
    expect(qIds(state)).toContain('req-q-overflow')
  })

  it('ignores question frames before ready', () => {
    expect(qFrameApply(INITIAL_STATE, qOpen('req-q-1')).runs[Q_RUN]).toBeUndefined()
    expect(getQuestionPageStore(Q_RUN).tombstones.size).toBe(0)
    qFrameApply(INITIAL_STATE, qSettle('req-q-1'))
    expect(getQuestionPageStore(Q_RUN).tombstones.size).toBe(0)
  })

  it('ignores question frames after a terminal status, including settles', () => {
    let state = qStatus(qLive(), 'running')
    state = qStatus(state, 'succeeded')
    const terminal = state
    expect(qFrameApply(state, qOpen('req-q-1'))).toBe(terminal)
    expect(qFrameApply(state, qSettle('req-q-2'))).toBe(terminal)
    expect(getQuestionPageStore(Q_RUN).tombstones.size).toBe(0)
  })

  it('a terminal status clears open questions and their drafts without tombstoning them', () => {
    let state = qStatus(qLive(), 'running')
    state = qFrameApply(qFrameApply(state, qOpen('req-q-1')), qOpen('req-q-2'))
    state = qWithExempt(state, ['req-q-2'])
    const store = getQuestionPageStore(Q_RUN)
    store.drafts.set('req-q-1', {fixture: 'draft-1'})
    store.drafts.set('req-q-2', {fixture: 'draft-2'})
    store.tombstones.add('req-q-old')
    state = qStatus(state, 'failed')
    expect(qIds(state)).toEqual([])
    expect(qEntry(state).questionClaimedExempt?.size).toBe(0)
    expect(store.drafts.size).toBe(0)
    expect([...store.tombstones]).toEqual(['req-q-old'])
    expect(getEffectiveStatus(qEntry(state))).toBe('failed')
  })

  it('a non-terminal status keeps open questions and drafts', () => {
    let state = qFrameApply(qStatus(qLive(), 'running'), qOpen('req-q-1'))
    getQuestionPageStore(Q_RUN).drafts.set('req-q-1', {fixture: 'draft'})
    state = qStatus(state, 'running')
    expect(qIds(state)).toEqual(['req-q-1'])
    expect(getQuestionPageStore(Q_RUN).drafts.has('req-q-1')).toBe(true)
  })

  it('keeps questions per run', () => {
    let state = qFrameApply(qLive(), qOpen('req-q-1'))
    state = qFrameApply(state, qOpen('req-q-2', [qQuestion()], 'run-q-002'))
    expect(qIds(state, Q_RUN)).toEqual(['req-q-1'])
    expect(qIds(state, 'run-q-002')).toEqual(['req-q-2'])
    expect(getQuestionPageStore('run-q-002').tombstones.size).toBe(0)
  })

  it('a new handle for the same run sees the earlier tombstone and draft', () => {
    // First handle: a question settles, another is drafted.
    let first = qFrameApply(qLive(), qOpen('req-q-1'))
    first = qFrameApply(qFrameApply(first, qOpen('req-q-2')), qSettle('req-q-1'))
    const draft = {fixture: 'draft'}
    getQuestionPageStore(Q_RUN).drafts.set('req-q-2', draft)
    expect(qIds(first)).toEqual(['req-q-2'])
    // Collapse and re-expand: a fresh state, a fresh run entry, the same page.
    let second = qLive()
    expect(qIds(second)).toEqual([])
    second = qFrameApply(second, qOpen('req-q-1'))
    expect(qIds(second)).toEqual([])
    second = qFrameApply(second, qOpen('req-q-2'))
    expect(qIds(second)).toEqual(['req-q-2'])
    expect(getQuestionPageStore(Q_RUN).drafts.get('req-q-2')).toBe(draft)
  })

  it('page store accessors return one record per run and reset clears every run', () => {
    const store = getQuestionPageStore(Q_RUN)
    expect(getQuestionPageStore(Q_RUN)).toBe(store)
    store.tombstones.add('req-q-1')
    expect(getQuestionPageStore('run-q-002')).not.toBe(store)
    resetQuestionPageStore()
    expect(getQuestionPageStore(Q_RUN).tombstones.size).toBe(0)
  })
})

describe('getEffectiveStatus — derived from the wire status and open questions', () => {
  beforeEach(() => resetQuestionPageStore())
  afterEach(() => resetQuestionPageStore())

  const withQuestion = (status: string) => qFrameApply(qStatus(qLive(), status), qOpen('req-q-1'))

  it('running with an open question is waiting_for_question', () => {
    expect(getEffectiveStatus(qEntry(withQuestion('running')))).toBe('waiting_for_question')
  })

  it('never stores the derived value: the wire status stays and the next frame cannot overwrite it', () => {
    let state = withQuestion('running')
    expect(qEntry(state).status).toBe('running')
    state = qStatus(state, 'running')
    expect(getEffectiveStatus(qEntry(state))).toBe('waiting_for_question')
    expect(qEntry(state).status).toBe('running')
  })

  it('wire waiting_for_approval wins over an open question', () => {
    expect(getEffectiveStatus(qEntry(withQuestion('waiting_for_approval')))).toBe('waiting_for_approval')
  })

  it('queued with an open question stays queued', () => {
    expect(getEffectiveStatus(qEntry(withQuestion('queued')))).toBe('queued')
  })

  it('blocked with an open question stays blocked', () => {
    expect(getEffectiveStatus(qEntry(withQuestion('blocked')))).toBe('blocked')
  })

  it('terminal wins over a stale question, and the terminal frame clears the question and its draft', () => {
    let state = withQuestion('running')
    getQuestionPageStore(Q_RUN).drafts.set('req-q-1', {fixture: 'draft'})
    state = qStatus(state, 'succeeded')
    expect(getEffectiveStatus(qEntry(state))).toBe('succeeded')
    expect(qIds(state)).toEqual([])
    expect(getQuestionPageStore(Q_RUN).drafts.size).toBe(0)
    // Even an entry that still carries a question (hand-built) reports its terminal status.
    const stale: RunEntry = {
      ...qEntry(state),
      status: 'succeeded',
      terminal: true,
      questionOpen: new Map([['req-q-1', {requestID: 'req-q-1', questions: []}]]),
    }
    expect(getEffectiveStatus(stale)).toBe('succeeded')
  })

  it('wire waiting_for_question with an open question stays waiting_for_question', () => {
    expect(getEffectiveStatus(qEntry(withQuestion('waiting_for_question')))).toBe('waiting_for_question')
  })

  it('wire waiting_for_question with no open question is kept until a reconcile completes, then shows running', () => {
    let state = qStatus(qLive(), 'waiting_for_question')
    expect(getEffectiveStatus(qEntry(state))).toBe('waiting_for_question')
    state = qReconcile(state, [])
    expect(qEntry(state).questionReconcileDone).toBe(true)
    expect(getEffectiveStatus(qEntry(state))).toBe('running')
    expect(qEntry(state).status).toBe('waiting_for_question')
  })

  it('wire waiting_for_question settled by a frame shows running only after a reconcile', () => {
    let state = qFrameApply(qStatus(qLive(), 'waiting_for_question'), qOpen('req-q-1'))
    state = qFrameApply(state, qSettle('req-q-1'))
    expect(getEffectiveStatus(qEntry(state))).toBe('waiting_for_question')
    state = qReconcile(state, [])
    expect(getEffectiveStatus(qEntry(state))).toBe('running')
  })

  it('running with no question is running; other statuses pass through', () => {
    for (const status of ['queued', 'blocked', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled']) {
      expect(getEffectiveStatus(qEntry(qStatus(qLive(), status)))).toBe(status)
    }
  })

  it('is total: an absent entry or one without question fields reports its own status', () => {
    expect(getEffectiveStatus(undefined)).toBe('')
    expect(getEffectiveStatus(null)).toBe('')
    expect(getEffectiveStatus({runId: 'r', status: 'running', phase: 'EXECUTING', startedAt: '', stale: false, terminal: false})).toBe('running')
  })
})

describe('nextStreamState — question-reconcile', () => {
  beforeEach(() => resetQuestionPageStore())
  afterEach(() => resetQuestionPageStore())

  const withOpen = (...ids: string[]): StreamState => {
    let state = qStatus(qLive(), 'running')
    for (const id of ids) state = qFrameApply(state, qOpen(id))
    return state
  }

  it('snapshot {A,B}, list {B,C}: A is removed without a tombstone, B stays, C is added', () => {
    const state = qReconcile(withOpen('A', 'B'), ['B', 'C'])
    expect(qIds(state)).toEqual(['B', 'C'])
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(false)
    expect(qEntry(state).questionReconcileDone).toBe(true)
    // Removed by absence, so it can return on a later frame.
    expect(qIds(qFrameApply(state, qOpen('A')))).toEqual(['B', 'C', 'A'])
  })

  it('keeps the draft of a request removed by absence, so a return restores it', () => {
    getQuestionPageStore(Q_RUN).drafts.set('A', {fixture: 'draft'})
    const state = qReconcile(withOpen('A', 'B'), ['B'])
    expect(qIds(state)).toEqual(['B'])
    expect(getQuestionPageStore(Q_RUN).drafts.get('A')).toEqual({fixture: 'draft'})
  })

  it('a claimed-exempt request survives a list that omits it', () => {
    const state = qReconcile(qWithExempt(withOpen('A', 'B'), ['A']), ['B', 'C'])
    expect(qIds(state)).toEqual(['A', 'B', 'C'])
    expect(qEntry(state).questionClaimedExempt?.has('A')).toBe(true)
  })

  it('a list that shows a claimed-exempt request open again ends the exemption', () => {
    const state = qReconcile(qWithExempt(withOpen('A'), ['A']), ['A'])
    expect(qIds(state)).toEqual(['A'])
    expect(qEntry(state).questionClaimedExempt?.has('A')).toBe(false)
  })

  it('a list at the cap of 50 is additive only', () => {
    expect(GATEWAY_PENDING_QUESTIONS_CAP).toBe(50)
    const listed = Array.from({length: GATEWAY_PENDING_QUESTIONS_CAP}, (_, index) => `L${index}`)
    const state = qReconcile(withOpen('A', 'B'), listed)
    expect(qIds(state)).toContain('A')
    expect(qIds(state)).toContain('B')
    expect(qIds(state)).toHaveLength(MAX_OPEN_QUESTIONS)
    expect(qIds(state).slice(0, 2)).toEqual(['A', 'B'])
    expect(qIds(state)).toContain('L0')
    expect(qIds(state)).not.toContain('L48')
  })

  it('a list just under the cap still prunes', () => {
    const listed = Array.from({length: GATEWAY_PENDING_QUESTIONS_CAP - 1}, (_, index) => `L${index}`)
    const state = qReconcile(withOpen('A'), listed)
    expect(qIds(state)).not.toContain('A')
    expect(qIds(state)).toHaveLength(GATEWAY_PENDING_QUESTIONS_CAP - 1)
  })

  it('an invalid body changes nothing, not even the completed flag', () => {
    const before = withOpen('A', 'B')
    const after = qReconcile(before, ['C'], {invalidBody: true})
    expect(after).toBe(before)
    expect(qEntry(after).questionReconcileDone).toBeUndefined()
  })

  it('a list with dropped invalid entries is additive only', () => {
    const state = qReconcile(withOpen('A', 'B'), ['B', 'C'], {partial: true})
    expect(qIds(state)).toEqual(['A', 'B', 'C'])
    expect(qEntry(state).questionReconcileDone).toBe(true)
  })

  it('a tombstoned request in the list stays out', () => {
    let state = withOpen('B')
    state = qFrameApply(state, qSettle('T'))
    state = qReconcile(state, ['B', 'T'])
    expect(qIds(state)).toEqual(['B'])
  })

  it('a request that opened after the pre-GET snapshot is never pruned', () => {
    const snapshot = ['A']
    let state = withOpen('A')
    state = qFrameApply(state, qOpen('N'))
    state = qReconcile(state, [], {snapshot})
    expect(qIds(state)).toEqual(['N'])
  })

  it('an authoritative empty list prunes every snapshot request that is not claimed-exempt', () => {
    const state = qReconcile(qWithExempt(withOpen('A', 'B'), ['B']), [])
    expect(qIds(state)).toEqual(['B'])
  })

  it('does not exceed the open-question cap when adding', () => {
    const listed = Array.from({length: 49}, (_, index) => `L${index}`)
    let state = withOpen(...Array.from({length: 49}, (_, index) => `K${index}`))
    state = qReconcile(state, [...listed, 'extra-1', 'extra-2'].slice(0, 49), {partial: true})
    expect(qIds(state).length).toBeLessThanOrEqual(MAX_OPEN_QUESTIONS)
  })

  it('is ignored before ready and after a terminal status', () => {
    const before = qReconcile(INITIAL_STATE, ['A'])
    expect(before.runs[Q_RUN]).toBeUndefined()
    const terminal = qStatus(qStatus(qLive(), 'running'), 'succeeded')
    expect(qReconcile(terminal, ['A'])).toBe(terminal)
  })

  it('creates a run entry for a run it has not seen a status for, as approvals do', () => {
    const state = qReconcile(qLive(), ['A'], {snapshot: []})
    expect(qIds(state)).toEqual(['A'])
  })

  it('ignores an own __proto__ id without polluting', () => {
    const state = qReconcile(withOpen('A'), ['__proto__', 'B'])
    expect(qIds(state)).toContain('B')
    expect(({} as Record<string, unknown>).requestID).toBeUndefined()
  })
})

async function paintedStatus(records: string[]) {
  const status = makeFakeEl('span')
  status.classList.add = (cls: string) => {
    status.className = `${status.className} ${cls}`.trim()
  }
  const body = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n${records.join('')}`
  let read = 0
  vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag), createTextNode: (text: string) => {
    const node = makeFakeEl('#text')
    node.textContent = text
    return node
  }})
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200, headers: {get: () => 'text/event-stream'},
    body: {getReader: () => ({read: async () => read++ === 0
      ? {done: false, value: new TextEncoder().encode(body)}
      : new Promise(() => {})})},
  }))
  const handle = initOperatorStream({runId: Q_RUN, statusEl: status as never, noticeEl: makeFakeEl() as never})
  await new Promise(resolve => setTimeout(resolve, 30))
  handle.close()
  return status
}

describe('question status — label, wire acceptance and styling', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('accepts waiting_for_question on a status frame', () => {
    const result = parseSseFrame(`event: status\ndata: ${JSON.stringify(ckStatusPayload({status: 'waiting_for_question'}))}\n\n`)
    expect(result?.success).toBe(true)
    expect(result?.success && result.frame.type === 'status' ? result.frame.data.status : '').toBe('waiting_for_question')
  })

  const statusRecord = (status: string) => `event: status\ndata: ${JSON.stringify(ckStatusPayload({runId: Q_RUN, status}))}\n\n`

  it('paints "Waiting for answer" for a wire waiting_for_question status', async () => {
    resetQuestionPageStore()
    const status = await paintedStatus([statusRecord('waiting_for_question')])
    expect(status.textContent).toBe('Waiting for answer')
    expect(status.className).toContain('status-waiting-for-question')
  })

  it('paints "Waiting for answer" for a running run with an open question, and "Running" once it settles', async () => {
    resetQuestionPageStore()
    const waiting = await paintedStatus([statusRecord('running'), qSse(qOpen('req-q-1'))])
    expect(waiting.textContent).toBe('Waiting for answer')
    expect(waiting.className).toContain('status-waiting-for-question')
    resetQuestionPageStore()
    const settled = await paintedStatus([statusRecord('running'), qSse(qOpen('req-q-1')), qSse(qSettle('req-q-1'))])
    expect(settled.textContent).toBe('Running')
    expect(settled.className).toContain('status-running')
  })

  it('keeps "Waiting for approval" over an open question', async () => {
    resetQuestionPageStore()
    const status = await paintedStatus([statusRecord('waiting_for_approval'), qSse(qOpen('req-q-1'))])
    expect(status.textContent).toBe('Waiting for approval')
  })

  it('keeps "Queued" with an open question and shows the terminal label after a terminal status', async () => {
    resetQuestionPageStore()
    expect((await paintedStatus([statusRecord('queued'), qSse(qOpen('req-q-1'))])).textContent).toBe('Queued')
    resetQuestionPageStore()
    expect((await paintedStatus([statusRecord('running'), qSse(qOpen('req-q-1')), statusRecord('succeeded')])).textContent).toBe('Succeeded')
  })

  it('has a CSS rule matching the class the status emitter produces, in both themes', async () => {
    const fs = await import('node:fs/promises')
    const css = await fs.readFile(new URL('../web/src/index.css', import.meta.url).pathname, 'utf8')
    expect(css).toMatch(/\.run-status\.status-waiting-for-question\b/)
    expect(css).toMatch(/\[data-theme="light"\] \.run-status\.status-waiting-for-question\b/)
  })
})

// ---------------------------------------------------------------------------
// #583 — expired snapshot handling
// ---------------------------------------------------------------------------

function nsLive(summaryStatus?: string): StreamState {
  const initial = {...INITIAL_STATE, ...(summaryStatus === undefined ? {} : {summaryStatus})} as StreamState
  return nextStreamState(initial, {type: 'ready', data: {contractVersion: PINNED_CONTRACT_VERSION}})
}

describe('nextStreamState — expired snapshot (#583)', () => {
  const NS_RUN = 'run-abc'

  const noSnapshot = (state: StreamState): StreamState =>
    nextStreamState(state, {type: 'reset', data: {runId: NS_RUN, reason: 'no-snapshot'}})
  const statusFrame = (state: StreamState, data: typeof ACTIVE_STATUS): StreamState =>
    nextStreamState(state, {type: 'status', data} as never)
  const outputFrame = (state: StreamState, seq: number, text: string): StreamState =>
    nextStreamState(state, {type: 'output', data: {runId: NS_RUN, text, final: false, seq}})
  const unavailable = (state: StreamState): boolean => state.runs[NS_RUN]?.outputUnavailable === true

  it('summary succeeded: no-snapshot with no later frame shows the terminal status, the unavailable state, and closes', () => {
    const before = nsLive('succeeded')
    const state = noSnapshot(before)
    expect(state.connection).toBe('closed')
    expect(state.shouldReconnect).toBe(false)
    expect(state.retryCount).toBe(before.retryCount)
    expect(state.runs[NS_RUN]?.status).toBe('succeeded')
    expect(state.runs[NS_RUN]?.terminal).toBe(true)
    expect(unavailable(state)).toBe(true)
  })

  it.each(['failed', 'cancelled'])('summary %s is terminal too', summary => {
    const state = noSnapshot(nsLive(summary))
    expect(state.connection).toBe('closed')
    expect(state.runs[NS_RUN]?.status).toBe(summary)
    expect(unavailable(state)).toBe(true)
  })

  it('no summary: no-snapshot then a terminal status frame shows the status and the unavailable state, never reconnecting', () => {
    const afterReset = noSnapshot(nsLive())
    expect(afterReset.connection).toBe('live')
    expect(afterReset.shouldReconnect).toBe(false)
    expect(afterReset.retryCount).toBe(0)
    expect(unavailable(afterReset)).toBe(false)
    const state = statusFrame(afterReset, TERMINAL_STATUS)
    expect(state.connection).not.toBe('reconnecting')
    expect(state.connection).toBe('closed')
    expect(state.retryCount).toBe(0)
    expect(state.runs[NS_RUN]?.status).toBe('succeeded')
    expect(unavailable(state)).toBe(true)
  })

  it('summary running: no-snapshot, a running status, then output renders output with no unavailable state', () => {
    let state = noSnapshot(nsLive('running'))
    expect(state.connection).toBe('live')
    expect(state.retryCount).toBe(0)
    state = statusFrame(state, ACTIVE_STATUS)
    expect(state.runs[NS_RUN]?.status).toBe('running')
    expect(unavailable(state)).toBe(false)
    state = outputFrame(state, 0, 'hello')
    expect(state.connection).toBe('live')
    expect(state.runs[NS_RUN]?.outputText).toBe('hello')
    expect(unavailable(state)).toBe(false)
  })

  it('a non-terminal summary (queued) does not count as terminal', () => {
    const state = noSnapshot(nsLive('queued'))
    expect(state.connection).toBe('live')
    expect(state.shouldReconnect).toBe(false)
    expect(unavailable(state)).toBe(false)
  })

  it('a run already terminal in the stream closes on no-snapshot, as before', () => {
    const terminal = statusFrame(nsLive(), TERMINAL_STATUS)
    const live: StreamState = {...terminal, connection: 'live'}
    const state = noSnapshot(live)
    expect(state.connection).toBe('closed')
    expect(state.shouldReconnect).toBe(false)
    expect(state.retryCount).toBe(live.retryCount)
    expect(state.runs[NS_RUN]?.status).toBe('succeeded')
  })

  it('a known-terminal run that already has output is not marked unavailable', () => {
    const withOutput = outputFrame(nsLive(), 0, 'final answer')
    const terminal = statusFrame(withOutput, TERMINAL_STATUS)
    const state = noSnapshot({...terminal, connection: 'live'})
    expect(state.connection).toBe('closed')
    expect(state.runs[NS_RUN]?.outputText).toBe('final answer')
    expect(unavailable(state)).toBe(false)
  })

  it('snapshot-missing, then output, then terminal: no unavailable state', () => {
    let state = noSnapshot(nsLive())
    state = outputFrame(state, 0, 'partial')
    state = statusFrame(state, TERMINAL_STATUS)
    expect(state.connection).toBe('closed')
    expect(state.runs[NS_RUN]?.outputText).toBe('partial')
    expect(unavailable(state)).toBe(false)
  })

  it('a terminal status with no preceding no-snapshot never shows the unavailable state', () => {
    const state = statusFrame(nsLive(), TERMINAL_STATUS)
    expect(unavailable(state)).toBe(false)
  })

  it('snapshot-missing marks only the run that was reset', () => {
    const state = statusFrame(noSnapshot(nsLive()), {...TERMINAL_STATUS, runId: 'run-other'})
    expect(state.runs['run-other']?.outputUnavailable).not.toBe(true)
  })

  it.each(['shutdown', 'overflow', 'writer-error'])('other reset reason %s still reconnects and spends a retry', reason => {
    const before = nsLive('succeeded')
    const state = nextStreamState(before, {type: 'reset', data: {runId: NS_RUN, reason}} as never)
    expect(state.connection).toBe('reconnecting')
    expect(state.shouldReconnect).toBe(true)
    expect(state.retryCount).toBe(before.retryCount + 1)
    expect(unavailable(state)).toBe(false)
  })

  it('reason terminal still closes, and a summary status does not turn max-duration into a close', () => {
    expect(nextStreamState(nsLive('succeeded'), {type: 'reset', data: {runId: NS_RUN, reason: 'terminal'}}).connection).toBe('closed')
    const active = statusFrame(nsLive('succeeded'), ACTIVE_STATUS)
    const state = nextStreamState(active, {type: 'reset', data: {runId: NS_RUN, reason: 'max-duration'}})
    expect(state.connection).toBe('reconnecting')
  })
})

describe('initOperatorStream — expired snapshot DOM (#583)', () => {
  afterEach(() => vi.unstubAllGlobals())

  const RUN = 'run-abc'
  const record = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const readyRecord = record('ready', {contractVersion: PINNED_CONTRACT_VERSION})
  const resetRecord = record('reset', {runId: RUN, reason: 'no-snapshot'})

  // The gateway keeps the subscription open after `reset`: one chunk, then a reader that never ends.
  async function paint(records: string[], summaryStatus?: string) {
    const statusEl = makeFakeEl('span')
    statusEl.classList.add = (cls: string) => {
      statusEl.className = `${statusEl.className} ${cls}`.trim()
    }
    const outputEl = makeFakeEl('pre')
    outputEl.hidden = true
    const noticeEl = makeFakeEl('div')
    let read = 0
    vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag)})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: {get: () => 'text/event-stream'},
      body: {getReader: () => ({read: async () => read++ === 0
        ? {done: false, value: new TextEncoder().encode(records.join(''))}
        : new Promise(() => {})})},
    }))
    const handle = initOperatorStream({
      runId: RUN,
      statusEl: statusEl as never,
      noticeEl: noticeEl as never,
      outputEl: outputEl as never,
      ...(summaryStatus === undefined ? {} : {summaryStatus: summaryStatus as never}),
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    handle.close()
    return {statusEl, outputEl, noticeEl}
  }

  it('summary succeeded + reset no-snapshot: status Succeeded, unavailable text in the output region, empty notice', async () => {
    const {statusEl, outputEl, noticeEl} = await paint([readyRecord, resetRecord], 'succeeded')
    expect(statusEl.textContent).toBe('Succeeded')
    expect(outputEl.textContent).toBe('Output no longer available.')
    expect(outputEl.hidden).toBe(false)
    expect(noticeEl.textContent).toBe('')
    expect(noticeEl.hidden).toBe(true)
    expect(noticeEl.dataset.connectionState).toBe('closed')
  })

  it('no summary + reset no-snapshot + terminal status frame: status shown, unavailable text, empty notice', async () => {
    const {statusEl, outputEl, noticeEl} = await paint([readyRecord, resetRecord, record('status', TERMINAL_STATUS)])
    expect(statusEl.textContent).toBe('Succeeded')
    expect(outputEl.textContent).toBe('Output no longer available.')
    expect(noticeEl.textContent).toBe('')
    expect(noticeEl.hidden).toBe(true)
    expect(noticeEl.dataset.connectionState).not.toBe('reconnecting')
  })

  it('no summary + reset no-snapshot and nothing else: stays live with an empty notice, not "Connecting"', async () => {
    const {outputEl, noticeEl} = await paint([readyRecord, resetRecord])
    expect(noticeEl.dataset.connectionState).toBe('live')
    expect(noticeEl.textContent).toBe('')
    expect(noticeEl.hidden).toBe(true)
    expect(outputEl.hidden).toBe(true)
    expect(outputEl.textContent).toBe('')
  })

  it('summary running + reset + running status + output: output renders, no unavailable state', async () => {
    const {statusEl, outputEl, noticeEl} = await paint([
      readyRecord,
      resetRecord,
      record('status', ACTIVE_STATUS),
      record('output', {runId: RUN, text: 'working on it', final: false, seq: 0}),
    ], 'running')
    expect(statusEl.textContent).toBe('Running')
    expect(outputEl.textContent).toBe('working on it')
    expect(outputEl.hidden).toBe(false)
    expect(noticeEl.textContent).toBe('')
    expect(noticeEl.dataset.connectionState).toBe('live')
  })
})

describe('initOperatorStream — releases the socket on client-side terminal close (#583)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const RUN = 'run-abc'
  const record = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const readyRecord = record('ready', {contractVersion: PINNED_CONTRACT_VERSION})
  const resetRecord = record('reset', {runId: RUN, reason: 'no-snapshot'})

  // One chunk, then either a reader that never ends or a server-side `done`. A read pending
  // when the request is aborted rejects, like a real fetch body.
  async function run(records: string[], opts: {summaryStatus?: string; serverEnds?: boolean} = {}) {
    vi.useFakeTimers()
    const statusEl = makeFakeEl('span')
    const outputEl = makeFakeEl('pre')
    const noticeEl = makeFakeEl('div')
    let signal: AbortSignal | undefined
    let reads = 0
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: {signal: AbortSignal}) => {
      signal = init.signal
      return {
        ok: true, status: 200, headers: {get: () => 'text/event-stream'},
        body: {getReader: () => ({read: async () => {
          if (reads++ === 0) return {done: false, value: new TextEncoder().encode(records.join(''))}
          if (opts.serverEnds === true) return {done: true, value: undefined}
          return new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          })
        }})},
      }
    })
    vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag)})
    vi.stubGlobal('fetch', fetchMock)
    const handle = initOperatorStream({
      runId: RUN,
      statusEl: statusEl as never,
      noticeEl: noticeEl as never,
      outputEl: outputEl as never,
      ...(opts.summaryStatus === undefined ? {} : {summaryStatus: opts.summaryStatus as never}),
    })
    // Past any reconnect backoff, so a scheduled reconnect would have fired.
    await vi.advanceTimersByTimeAsync(10_000)
    // Observed BEFORE handle.close(), which aborts on its own.
    const aborted = signal?.aborted ?? false
    const connectionState = noticeEl.dataset.connectionState
    handle.close()
    return {aborted, connectionState, fetchCalls: fetchMock.mock.calls.length, statusEl, outputEl, noticeEl}
  }

  it('summary succeeded + ready + reset no-snapshot with a never-ending reader aborts the request and stays closed', async () => {
    const result = await run([readyRecord, resetRecord], {summaryStatus: 'succeeded'})
    expect(result.aborted).toBe(true)
    expect(result.connectionState).toBe('closed')
    expect(result.fetchCalls).toBe(1)
    expect(result.statusEl.textContent).toBe('Succeeded')
    expect(result.outputEl.textContent).toBe('Output no longer available.')
    expect(result.noticeEl.textContent).toBe('')
  })

  it('a terminal status frame followed by the server ending the stream stays closed with no abort-induced state change', async () => {
    const result = await run([readyRecord, record('status', TERMINAL_STATUS)], {serverEnds: true})
    expect(result.connectionState).toBe('closed')
    expect(result.fetchCalls).toBe(1)
    expect(result.statusEl.textContent).toBe('Succeeded')
    expect(result.noticeEl.textContent).toBe('')
    expect(result.noticeEl.hidden).toBe(true)
  })

  it('a contract-version drift close aborts the request and neither reopens nor reconnects', async () => {
    const result = await run([record('ready', {contractVersion: '9.9.9'})])
    expect(result.aborted).toBe(true)
    expect(result.connectionState).toBe('drift')
    expect(result.fetchCalls).toBe(1)
  })
})

describe('expired snapshot — selector/emitter parity (#583)', () => {
  it('styles the class the unavailable state emits', async () => {
    const fs = await import('node:fs/promises')
    const [js, css] = await Promise.all([
      fs.readFile('public/operator-stream.js', 'utf8'),
      fs.readFile('web/src/index.css', 'utf8'),
    ])
    expect(js).toContain("'run-output-unavailable'")
    expect(css).toMatch(/\.run-output-unavailable(?![\w-])/)
  })
})

// ===========================================================================
// Agent questions — question client, decision outcomes and the re-list triggers (Unit 4)
// ===========================================================================

type U4State = Extract<QuestionDecisionOutcome, {kind: 'decided'}>['state']

const U4_READY = `event: ready\ndata: ${JSON.stringify({contractVersion: PINNED_CONTRACT_VERSION})}\n\n`
const U4_RESET_SHUTDOWN = `event: reset\ndata: ${JSON.stringify({runId: Q_RUN, reason: 'shutdown'})}\n\n`

function u4Status(status: string): string {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status)
  const payload = ckStatusPayload({runId: Q_RUN, status, phase: terminal ? 'COMPLETED' : 'EXECUTING'})
  return `event: status\ndata: ${JSON.stringify(payload)}\n\n`
}

/** Chunks for a connection that goes live, runs, and has the given requests open. */
function u4Chunks(...openIds: string[]): string[] {
  return [U4_READY, u4Status('running'), ...openIds.map(id => qSse(qOpen(id)))]
}

function u4Listed(...ids: string[]): QuestionListResult {
  return {
    success: true,
    data: {requests: ids.map(requestID => ({requestID, questions: [qQuestion()] as never})), invalidBody: false, partial: false},
  }
}

const u4Decided = (state: U4State): QuestionDecisionOutcome => ({kind: 'decided', state})
const SKIP: QuestionDecision = {decision: 'skip'}

/** A one-chunk SSE body that stays open. */
function u4SseBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
    },
  })
}

function u4Deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return {promise, resolve}
}

interface U4Options {
  /** Chunks per connection; a connection past the end serves just `ready` + a running status. */
  initial?: string[][]
  list?: (call: number) => QuestionListResult | Promise<QuestionListResult>
  decide?: (call: number, requestId: string, decision: QuestionDecision) => QuestionDecisionOutcome | Promise<QuestionDecisionOutcome>
}

const u4Handles: StreamHandle[] = []

/** Start a stream with fake timers and an injected question client. Connections stay open until `end`. */
function u4Start(opts: U4Options = {}) {
  vi.useFakeTimers()
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  const encoder = new TextEncoder()
  const listCalls: string[] = []
  const decideCalls: {requestId: string; decision: QuestionDecision}[] = []

  const client: QuestionClient = {
    listRunQuestions: async runId => {
      listCalls.push(runId)
      return opts.list === undefined ? u4Listed() : opts.list(listCalls.length)
    },
    decideRunQuestion: async (_runId, requestId, decision) => {
      decideCalls.push({requestId, decision})
      return opts.decide === undefined ? u4Decided('claimed') : opts.decide(decideCalls.length, requestId, decision)
    },
  }

  vi.stubGlobal('document', {
    createElement: (tag: string) => makeFakeEl(tag),
    createTextNode: (text: string) => {
      const node = makeFakeEl('#text')
      node.textContent = text
      return node
    },
  })
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('fetch', async () => {
    const chunks = opts.initial?.[controllers.length] ?? [U4_READY, u4Status('running')]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller)
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      },
    })
    return {ok: true, status: 200, headers: {get: () => 'text/event-stream'}, body}
  })

  const handle = initOperatorStream({
    runId: Q_RUN,
    statusEl: makeFakeEl('span') as never,
    noticeEl: makeFakeEl('div') as never,
    questionClient: client,
  })
  u4Handles.push(handle)

  return {
    handle,
    listCalls,
    decideCalls,
    flush: async (ms = 0) => vi.advanceTimersByTimeAsync(ms),
    push: (connection: number, chunk: string) => controllers[connection]?.enqueue(encoder.encode(chunk)),
    end: (connection: number) => controllers[connection]?.close(),
    ids: () => handle.getQuestions().map(request => request.requestID),
    /** Drop connection 0 and let the stream reconnect and go live again. */
    reconnect: async () => {
      controllers[0]?.enqueue(encoder.encode(U4_RESET_SHUTDOWN))
      controllers[0]?.close()
      await vi.advanceTimersByTimeAsync(5000)
    },
  }
}

function u4Cleanup() {
  for (const handle of u4Handles.splice(0)) handle.close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetQuestionPageStore()
}

describe('question decisions — outcomes by response state', () => {
  afterEach(u4Cleanup)

  it('live transition: lists once on going live and adds a listed request', async () => {
    const h = u4Start({initial: [[U4_READY, u4Status('running')]], list: () => u4Listed('L1')})
    await h.flush()
    expect(h.listCalls).toEqual([Q_RUN])
    expect(h.ids()).toEqual(['L1'])
    expect(h.handle.getQuestionStatus('L1')).toEqual({kind: 'open'})
  })

  it('claimed: the request is tombstoned and removed, and a later list cannot bring it back', async () => {
    const h = u4Start({initial: [u4Chunks('A')], list: n => (n === 1 ? u4Listed() : u4Listed('A'))})
    await h.flush()
    expect(h.ids()).toEqual(['A'])
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'claimed'})
    expect(h.ids()).toEqual([])
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(true)
    expect(h.handle.getQuestionNotes()).toEqual([{requestID: 'A', status: {kind: 'claimed'}}])
    await h.handle.checkQuestions()
    expect(h.listCalls).toHaveLength(2)
    expect(h.ids()).toEqual([])
  })

  it('already_settled: tombstoned and removed, as its own note distinct from gone', async () => {
    const h = u4Start({initial: [u4Chunks('A')], decide: () => u4Decided('already_settled')})
    await h.flush()
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'already-settled'})
    expect(h.ids()).toEqual([])
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(true)
  })

  it('claimed resolves even while the stream is reconnecting (the reducer event is not gated on live)', async () => {
    const d = u4Deferred<QuestionDecisionOutcome>()
    const h = u4Start({initial: [u4Chunks('A')], decide: async () => d.promise})
    await h.flush()
    const pending = h.handle.decideQuestion('A', SKIP)
    h.push(0, U4_RESET_SHUTDOWN)
    h.end(0)
    await h.flush(0)
    d.resolve(u4Decided('claimed'))
    await pending
    expect(h.ids()).toEqual([])
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(true)
  })

  it('already_claimed: kept, claimed-exempt, and re-listed on the 2/5/10/20 second schedule, then it stops', async () => {
    expect([...QUESTION_CLAIM_RECHECK_DELAYS_MS]).toEqual([2000, 5000, 10_000, 20_000])
    const h = u4Start({initial: [u4Chunks('A')], decide: () => u4Decided('already_claimed')})
    await h.flush()
    expect(h.listCalls).toHaveLength(1)
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'claimed-elsewhere'})
    expect(h.ids()).toEqual(['A'])

    let lists = 1
    for (const delay of QUESTION_CLAIM_RECHECK_DELAYS_MS) {
      await h.flush(delay - 1)
      expect(h.listCalls).toHaveLength(lists)
      await h.flush(1)
      await h.flush(0)
      lists += 1
      expect(h.listCalls).toHaveLength(lists)
      // The gateway omits claimed requests from the list, yet the request stays.
      expect(h.ids()).toEqual(['A'])
      expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'claimed-elsewhere'})
    }
    await h.flush(300_000)
    expect(h.listCalls).toHaveLength(5)
    expect(h.ids()).toEqual(['A'])
  })

  it('failed_to_settle: retryable with the request kept, and a resubmit is allowed', async () => {
    const h = u4Start({initial: [u4Chunks('A')], decide: n => (n === 1 ? u4Decided('failed_to_settle') : u4Decided('claimed'))})
    await h.flush()
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'failed-to-settle'})
    expect(h.ids()).toEqual(['A'])
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'claimed'})
    expect(h.decideCalls).toHaveLength(2)
  })

  it('a decision is refused while the request is in flight', async () => {
    const d = u4Deferred<QuestionDecisionOutcome>()
    const h = u4Start({initial: [u4Chunks('A')], decide: async () => d.promise})
    await h.flush()
    const first = h.handle.decideQuestion('A', SKIP)
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'in-flight'})
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'in-flight'})
    expect(h.decideCalls).toHaveLength(1)
    d.resolve(u4Decided('claimed'))
    await first
  })

  it('a request that is not open is not submitted', async () => {
    const h = u4Start({initial: [u4Chunks('A')]})
    await h.flush()
    expect(await h.handle.decideQuestion('nope', SKIP)).toBeNull()
    expect(h.decideCalls).toHaveLength(0)
  })

  it('invalid answer on question 2 (zero-based index 1): marked, input kept, resubmit allowed, nothing retried', async () => {
    const invalid: QuestionDecisionOutcome = {kind: 'invalid', reason: 'arity-mismatch', questionIndex: 1}
    const h = u4Start({initial: [u4Chunks('A')], decide: n => (n === 1 ? invalid : u4Decided('claimed'))})
    await h.flush()
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'invalid', reason: 'arity-mismatch', questionIndex: 1})
    expect(h.ids()).toEqual(['A'])
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'claimed'})
  })

  it('request-level invalid and request-level failure surface without a question index', async () => {
    const h = u4Start({
      initial: [u4Chunks('A')],
      decide: n => (n === 1 ? {kind: 'invalid', reason: null, questionIndex: null} : {kind: 'failed'}),
    })
    await h.flush()
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'invalid', reason: null, questionIndex: null})
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'failed-to-settle'})
  })

  it('masked 404: can\'t answer, for this request and every request the run opens later; nothing more is sent', async () => {
    const h = u4Start({initial: [u4Chunks('A')], decide: () => ({kind: 'cant-answer'})})
    await h.flush()
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'cant-answer'})
    expect(h.ids()).toEqual(['A'])
    h.push(0, qSse(qOpen('B')))
    await h.flush()
    expect(h.handle.getQuestionStatus('B')).toEqual({kind: 'cant-answer'})
    expect(await h.handle.decideQuestion('B', SKIP)).toEqual({kind: 'cant-answer'})
    expect(h.decideCalls).toHaveLength(1)
  })

  it('401/403: session expired, and the operator can try again', async () => {
    const h = u4Start({initial: [u4Chunks('A')], decide: n => (n === 1 ? {kind: 'session-expired'} : u4Decided('claimed'))})
    await h.flush()
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'session-expired'})
    expect(h.ids()).toEqual(['A'])
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'claimed'})
  })
})

describe('question re-list triggers — unknown outcome, claim lifecycle, failures, races', () => {
  afterEach(u4Cleanup)

  it('network failure: no resubmit, a fresh list is issued, and a request the list omits is "gone" (may have been recorded)', async () => {
    const h = u4Start({initial: [u4Chunks('A')], decide: () => ({kind: 'unknown'}), list: () => u4Listed()})
    await h.flush()
    expect(h.listCalls).toHaveLength(1)
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'gone'})
    expect(h.decideCalls).toHaveLength(1)
    expect(h.listCalls).toHaveLength(2)
    expect(h.ids()).toEqual([])
    expect(h.handle.getQuestionNotes()).toEqual([{requestID: 'A', status: {kind: 'gone'}}])
    // Removed by absence, not settled: it is not tombstoned, and "gone" differs from "already settled".
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(false)
    expect(h.handle.getQuestionStatus('A')).not.toEqual({kind: 'already-settled'})
  })

  it('network failure: shows "checking" while the list is out, and a request the list still shows goes back to open', async () => {
    const d = u4Deferred<QuestionListResult>()
    const h = u4Start({initial: [u4Chunks('A')], decide: () => ({kind: 'unknown'}), list: async n => (n === 1 ? u4Listed() : d.promise)})
    await h.flush()
    const pending = h.handle.decideQuestion('A', SKIP)
    await h.flush()
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'checking'})
    d.resolve(u4Listed('A'))
    expect(await pending).toEqual({kind: 'open'})
    expect(h.ids()).toEqual(['A'])
  })

  it('network failure: the check itself failing surfaces "check failed", and still never resubmits', async () => {
    const h = u4Start({
      initial: [u4Chunks('A')],
      decide: () => ({kind: 'unknown'}),
      list: n => (n === 1 ? u4Listed() : {success: false, error: {kind: 'network'}}),
    })
    await h.flush()
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'check-failed'})
    expect(h.ids()).toEqual(['A'])
    expect(h.decideCalls).toHaveLength(1)
  })

  it('settle frame before the POST resolves: the late response is ignored', async () => {
    for (const late of [u4Decided('failed_to_settle'), u4Decided('already_claimed'), u4Decided('claimed'), {kind: 'invalid', reason: 'malformed', questionIndex: null} as const]) {
      const d = u4Deferred<QuestionDecisionOutcome>()
      const h = u4Start({initial: [u4Chunks('A')], decide: async () => d.promise})
      await h.flush()
      const pending = h.handle.decideQuestion('A', SKIP)
      h.push(0, qSse(qSettle('A')))
      await h.flush()
      expect(h.ids()).toEqual([])
      d.resolve(late)
      expect(await pending).toBeNull()
      expect(h.handle.getQuestionStatus('A')).toBeNull()
      expect(h.handle.getQuestionNotes()).toEqual([])
      expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(true)
      u4Cleanup()
    }
  })

  it('list removal before the POST resolves: a late claimed still tombstones, so a later list cannot resurrect the request', async () => {
    const d = u4Deferred<QuestionDecisionOutcome>()
    const h = u4Start({initial: [u4Chunks('A')], decide: async () => d.promise, list: n => (n === 3 ? u4Listed('A') : u4Listed())})
    await h.flush()
    const pending = h.handle.decideQuestion('A', SKIP)
    await h.handle.checkQuestions() // list #2 omits A: removed by absence, not tombstoned
    expect(h.ids()).toEqual([])
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(false)
    d.resolve(u4Decided('claimed'))
    expect(await pending).toBeNull()
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(true)
    await h.handle.checkQuestions() // list #3 shows A again, but it is settled for the page
    expect(h.listCalls).toHaveLength(3)
    expect(h.ids()).toEqual([])
  })

  it('terminal status before the POST resolves: the late response is ignored and nothing is tombstoned', async () => {
    const d = u4Deferred<QuestionDecisionOutcome>()
    const h = u4Start({initial: [u4Chunks('A')], decide: async () => d.promise})
    await h.flush()
    const pending = h.handle.decideQuestion('A', SKIP)
    h.push(0, u4Status('succeeded'))
    await h.flush()
    expect(h.ids()).toEqual([])
    d.resolve(u4Decided('claimed'))
    expect(await pending).toBeNull()
    expect(h.handle.getQuestionNotes()).toEqual([])
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(false)
  })

  it('claim reopen: omitted by a list it stays, shown open by a later list it is back to open and the schedule stops', async () => {
    const h = u4Start({
      initial: [u4Chunks('A')],
      decide: () => u4Decided('already_claimed'),
      list: n => (n === 3 ? u4Listed('A') : u4Listed()),
    })
    await h.flush()
    await h.handle.decideQuestion('A', SKIP)
    await h.flush(2000)
    expect(h.listCalls).toHaveLength(2)
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'claimed-elsewhere'})
    await h.flush(5000)
    expect(h.listCalls).toHaveLength(3)
    expect(h.ids()).toEqual(['A'])
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'open'})
    await h.flush(300_000)
    expect(h.listCalls).toHaveLength(3)
    // Open again, so it can be answered again.
    expect(await h.handle.decideQuestion('A', SKIP)).toEqual({kind: 'claimed-elsewhere'})
  })

  it('a settle frame ends a claim: the request is removed and the schedule stops', async () => {
    const h = u4Start({initial: [u4Chunks('A')], decide: () => u4Decided('already_claimed')})
    await h.flush()
    await h.handle.decideQuestion('A', SKIP)
    h.push(0, qSse(qSettle('A')))
    await h.flush()
    expect(h.ids()).toEqual([])
    expect(h.handle.getQuestionStatus('A')).toBeNull()
    await h.flush(300_000)
    expect(h.listCalls).toHaveLength(1)
  })

  it('a terminal status ends a claim: statuses clear and the schedule stops', async () => {
    const h = u4Start({initial: [u4Chunks('A')], decide: () => u4Decided('already_claimed')})
    await h.flush()
    await h.handle.decideQuestion('A', SKIP)
    h.push(0, u4Status('succeeded'))
    await h.flush(300_000)
    expect(h.ids()).toEqual([])
    expect(h.handle.getQuestionStatus('A')).toBeNull()
    expect(h.listCalls).toHaveLength(1)
  })

  it('claim exemption ends at the next live transition when the list still omits the request', async () => {
    const h = u4Start({initial: [u4Chunks('A')], decide: () => u4Decided('already_claimed')})
    await h.flush()
    await h.handle.decideQuestion('A', SKIP)
    expect(h.ids()).toEqual(['A'])
    await h.reconnect()
    expect(h.listCalls).toHaveLength(2)
    expect(h.ids()).toEqual([])
    expect(h.handle.getQuestionStatus('A')).toBeNull()
    // Removed by absence, not settled.
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(false)
  })

  it('claim exemption survives the next live transition when the list shows the request open (it is simply open)', async () => {
    const h = u4Start({initial: [u4Chunks('A')], decide: () => u4Decided('already_claimed'), list: n => (n === 1 ? u4Listed() : u4Listed('A'))})
    await h.flush()
    await h.handle.decideQuestion('A', SKIP)
    await h.reconnect()
    expect(h.ids()).toEqual(['A'])
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'open'})
  })

  it.each([
    ['429', {success: false, error: {kind: 'http', status: 429}}],
    ['500', {success: false, error: {kind: 'http', status: 500}}],
    ['network', {success: false, error: {kind: 'network'}}],
    ['invalid body', {success: true, data: {requests: [], invalidBody: true, partial: false}}],
  ] as [string, QuestionListResult][])('list %s on a live transition: nothing is pruned, nothing surfaces, and it is never retried', async (_name, failure) => {
    const h = u4Start({initial: [u4Chunks('A')], list: n => (n === 1 ? u4Listed() : failure)})
    await h.flush()
    expect(h.ids()).toEqual(['A'])
    await h.reconnect()
    expect(h.listCalls).toHaveLength(2)
    expect(h.ids()).toEqual(['A'])
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'open'})
    await h.flush(600_000)
    expect(h.listCalls).toHaveLength(2)
  })

  it('a failed re-list during the claim schedule leaves the claim as is and stops the schedule', async () => {
    const h = u4Start({
      initial: [u4Chunks('A')],
      decide: () => u4Decided('already_claimed'),
      list: n => (n === 1 ? u4Listed() : {success: false, error: {kind: 'http', status: 429}}),
    })
    await h.flush()
    await h.handle.decideQuestion('A', SKIP)
    await h.flush(2000)
    expect(h.listCalls).toHaveLength(2)
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'claimed-elsewhere'})
    await h.flush(300_000)
    expect(h.listCalls).toHaveLength(2)
  })

  it('"Check again" that fails surfaces "check failed"; one that works restores the claim, and a later one shows it open', async () => {
    const h = u4Start({
      initial: [u4Chunks('A')],
      decide: () => u4Decided('already_claimed'),
      list: n => (n === 2 ? {success: false, error: {kind: 'http', status: 500}} : n === 4 ? u4Listed('A') : u4Listed()),
    })
    await h.flush()
    await h.handle.decideQuestion('A', SKIP)
    await h.handle.checkQuestions('A')
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'check-failed'})
    // The schedule does not retry a failed check on its own.
    await h.flush(300_000)
    expect(h.listCalls).toHaveLength(2)
    await h.handle.checkQuestions('A')
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'claimed-elsewhere'})
    await h.handle.checkQuestions('A')
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'open'})
    expect(h.listCalls).toHaveLength(4)
  })

  it('"Check again" shows "checking" while the list is out; without a request ID it targets every claimed request', async () => {
    const d = u4Deferred<QuestionListResult>()
    const h = u4Start({initial: [u4Chunks('A', 'B')], decide: () => u4Decided('already_claimed'), list: async n => (n === 2 ? d.promise : u4Listed())})
    await h.flush()
    await h.handle.decideQuestion('A', SKIP)
    await h.handle.decideQuestion('B', SKIP)
    const pending = h.handle.checkQuestions()
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'checking'})
    expect(h.handle.getQuestionStatus('B')).toEqual({kind: 'checking'})
    d.resolve(u4Listed())
    await pending
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'claimed-elsewhere'})
    expect(h.handle.getQuestionStatus('B')).toEqual({kind: 'claimed-elsewhere'})
  })

  it('a manual check waits out a list already in flight and then issues its own fresh one', async () => {
    const d = u4Deferred<QuestionListResult>()
    const h = u4Start({initial: [u4Chunks('A')], decide: () => u4Decided('already_claimed'), list: async n => (n === 2 ? d.promise : u4Listed())})
    await h.flush()
    await h.handle.decideQuestion('A', SKIP)
    await h.flush(2000) // the schedule's list (#2) is now out
    expect(h.listCalls).toHaveLength(2)
    const pending = h.handle.checkQuestions('A')
    await h.flush()
    expect(h.listCalls).toHaveLength(2)
    d.resolve(u4Listed())
    await pending
    expect(h.listCalls).toHaveLength(3)
    expect(h.handle.getQuestionStatus('A')).toEqual({kind: 'claimed-elsewhere'})
  })

  it('epoch guard: a list that resolves after a reconnect is ignored', async () => {
    const stale = u4Deferred<QuestionListResult>()
    const h = u4Start({list: async n => (n === 1 ? stale.promise : u4Listed('B'))})
    await h.flush()
    expect(h.listCalls).toHaveLength(1)
    await h.reconnect()
    expect(h.listCalls).toHaveLength(2)
    expect(h.ids()).toEqual(['B'])
    stale.resolve(u4Listed('A'))
    await h.flush()
    expect(h.ids()).toEqual(['B'])
  })

  it('close() ends the claim schedule and refuses further decisions', async () => {
    const h = u4Start({initial: [u4Chunks('A')], decide: () => u4Decided('already_claimed')})
    await h.flush()
    await h.handle.decideQuestion('A', SKIP)
    h.handle.close()
    await h.flush(300_000)
    expect(h.listCalls).toHaveLength(1)
    expect(await h.handle.decideQuestion('A', SKIP)).toBeNull()
  })

  it('a handle without a question client or region never calls the questions routes', async () => {
    vi.useFakeTimers()
    const urls: string[] = []
    vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag)})
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return {ok: true, status: 200, headers: {get: () => 'text/event-stream'}, body: u4SseBody(u4Chunks('A').join(''))}
    })
    const handle = initOperatorStream({runId: Q_RUN, statusEl: makeFakeEl('span') as never, noticeEl: makeFakeEl('div') as never})
    u4Handles.push(handle)
    await vi.advanceTimersByTimeAsync(10)
    expect(urls.every(url => url.endsWith('/stream'))).toBe(true)
    expect(handle.getQuestions().map(request => request.requestID)).toEqual(['A'])
    expect(await handle.decideQuestion('A', SKIP)).toBeNull()
    await handle.checkQuestions()
    expect(urls).toHaveLength(1)
  })

  it('a question region wires the real client: the live transition GETs the run\'s pending list', async () => {
    vi.useFakeTimers()
    const urls: string[] = []
    vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag)})
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      if (url.includes('/questions')) {
        return {ok: true, status: 200, json: async () => ({requests: [{requestID: 'W', questions: [qQuestion()]}]})}
      }
      return {ok: true, status: 200, headers: {get: () => 'text/event-stream'}, body: u4SseBody([U4_READY, u4Status('running')].join(''))}
    })
    const handle = initOperatorStream({
      runId: Q_RUN,
      statusEl: makeFakeEl('span') as never,
      noticeEl: makeFakeEl('div') as never,
      questionsEl: makeFakeEl('div') as never,
    })
    u4Handles.push(handle)
    await vi.advanceTimersByTimeAsync(10)
    expect(urls).toContain(`/operator/runs/${Q_RUN}/questions`)
    expect(handle.getQuestions().map(request => request.requestID)).toEqual(['W'])
  })
})

interface U4Response {
  status: number
  body?: unknown
}

/** Stub fetch: CSRF requests succeed (or fail as told); every other request takes the next scripted response. */
function u4Http(responses: (U4Response | 'throw')[], opts: {csrfStatus?: number | 'throw'} = {}) {
  const calls: {url: string; init: RequestInit}[] = []
  let next = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({url, init})
    if (url.includes('/session/csrf')) {
      if (opts.csrfStatus === 'throw') throw new Error('csrf network')
      const status = opts.csrfStatus ?? 200
      return {ok: status === 200, status, json: async () => ({csrfToken: `csrf-${calls.length}`})}
    }
    const scripted = responses[Math.min(next++, responses.length - 1)]
    if (scripted === undefined || scripted === 'throw') throw new Error('network')
    return {
      ok: scripted.status >= 200 && scripted.status < 300,
      status: scripted.status,
      json: async () => {
        if (scripted.body === undefined) throw new Error('no body')
        return scripted.body
      },
    }
  })
  return calls
}

const u4Posts = <T extends {url: string}>(calls: T[]): T[] => calls.filter(call => call.url.includes('/decision'))
const U4_ANSWER: QuestionDecision = {decision: 'answer', answers: [{options: [0]}, {text: 'hello'}]}

describe('buildQuestionClient — decideRunQuestion', () => {
  afterEach(u4Cleanup)

  it('POSTs the answer body with x-csrf-token, redirect:error, credentials, and no idempotency key', async () => {
    const calls = u4Http([{status: 200, body: {state: 'claimed'}}])
    const result = await buildQuestionClient().decideRunQuestion('run-1', 'req-1', U4_ANSWER)
    expect(result).toEqual({kind: 'decided', state: 'claimed'})
    const [post] = u4Posts(calls)
    expect(post?.url).toBe('/operator/runs/run-1/questions/req-1/decision')
    expect(post?.init.method).toBe('POST')
    expect(post?.init.redirect).toBe('error')
    expect(post?.init.credentials).toBe('include')
    const headers = post?.init.headers as Record<string, string>
    expect(headers['x-csrf-token']).toMatch(/^csrf-/)
    expect(Object.keys(headers).map(key => key.toLowerCase())).not.toContain('idempotency-key')
    expect(JSON.parse(String(post?.init.body))).toEqual({decision: 'answer', answers: [{options: [0]}, {text: 'hello'}]})
  })

  it('sends skip as {decision:"skip"} and rebuilds a closed answer body (stray fields are not sent)', async () => {
    const calls = u4Http([{status: 200, body: {state: 'claimed'}}])
    const client = buildQuestionClient()
    await client.decideRunQuestion('run-1', 'req-1', SKIP)
    await client.decideRunQuestion('run-1', 'req-1', {decision: 'answer', answers: [{options: [1], text: 'x', extra: 'no'}]} as never)
    const [skip, answer] = u4Posts(calls)
    expect(JSON.parse(String(skip?.init.body))).toEqual({decision: 'skip'})
    expect(JSON.parse(String(answer?.init.body))).toEqual({decision: 'answer', answers: [{options: [1], text: 'x'}]})
  })

  it('an empty answer list is sent as-is (a request with zero questions)', async () => {
    const calls = u4Http([{status: 200, body: {state: 'claimed'}}])
    await buildQuestionClient().decideRunQuestion('run-1', 'req-1', {decision: 'answer', answers: []})
    expect(JSON.parse(String(u4Posts(calls)[0]?.init.body))).toEqual({decision: 'answer', answers: []})
  })

  it.each(QUESTION_DECISION_STATES)('200 %s is a decided outcome', async state => {
    u4Http([{status: 200, body: {state}}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', SKIP)).toEqual({kind: 'decided', state})
  })

  it('200 with an unknown state is a request-level retryable failure', async () => {
    u4Http([{status: 200, body: {state: 'mystery'}}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', SKIP)).toEqual({kind: 'failed'})
  })

  it('400 without a reason refreshes CSRF and retries once with the new token', async () => {
    const calls = u4Http([{status: 400, body: {error: 'bad request'}}, {status: 200, body: {state: 'claimed'}}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', U4_ANSWER)).toEqual({kind: 'decided', state: 'claimed'})
    const posts = u4Posts(calls)
    expect(posts).toHaveLength(2)
    expect(calls.filter(call => call.url.includes('/session/csrf'))).toHaveLength(2)
    const tokens = posts.map(post => (post.init.headers as Record<string, string>)['x-csrf-token'])
    expect(tokens[0]).not.toBe(tokens[1])
  })

  it('400 without a reason and with an unreadable body is also a CSRF-style 400', async () => {
    const calls = u4Http([{status: 400}, {status: 200, body: {state: 'claimed'}}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', SKIP)).toEqual({kind: 'decided', state: 'claimed'})
    expect(u4Posts(calls)).toHaveLength(2)
  })

  it('a second 400 without a reason is a request-level invalid outcome, not a third attempt', async () => {
    const calls = u4Http([{status: 400, body: {error: 'bad request'}}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', SKIP)).toEqual({kind: 'invalid', reason: null, questionIndex: null})
    expect(u4Posts(calls)).toHaveLength(2)
  })

  it('400 arity-mismatch with questionIndex 1 is invalid on question 2, and is never retried', async () => {
    const calls = u4Http([{status: 400, body: {error: 'bad request', reason: 'arity-mismatch', questionIndex: 1}}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', U4_ANSWER)).toEqual({
      kind: 'invalid',
      reason: 'arity-mismatch',
      questionIndex: 1,
    })
    expect(u4Posts(calls)).toHaveLength(1)
  })

  it.each(QUESTION_INVALID_REASONS)('400 %s with a null index is a request-level answer problem with the reason kept', async reason => {
    const calls = u4Http([{status: 400, body: {error: 'bad request', reason, questionIndex: null}}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', U4_ANSWER)).toEqual({kind: 'invalid', reason, questionIndex: null})
    expect(u4Posts(calls)).toHaveLength(1)
  })

  it('400 with an unknown reason is request-level invalid, never retried', async () => {
    const calls = u4Http([{status: 400, body: {error: 'bad request', reason: 'brand-new-reason', questionIndex: 0}}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', U4_ANSWER)).toEqual({kind: 'invalid', reason: null, questionIndex: null})
    expect(u4Posts(calls)).toHaveLength(1)
  })

  it.each([2, -1, 1.5, '1', undefined])('400 with an out-of-range or unusable index (%s) is request-level, never retried', async questionIndex => {
    const calls = u4Http([{status: 400, body: {error: 'bad request', reason: 'unknown-option', questionIndex}}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', U4_ANSWER)).toEqual({
      kind: 'invalid',
      reason: 'unknown-option',
      questionIndex: null,
    })
    expect(u4Posts(calls)).toHaveLength(1)
  })

  it('404 is can\'t-answer, 401 and 403 are session expired, and none is retried', async () => {
    for (const [status, expected] of [[404, 'cant-answer'], [401, 'session-expired'], [403, 'session-expired']] as const) {
      const calls = u4Http([{status, body: {}}])
      expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', SKIP)).toEqual({kind: expected})
      expect(u4Posts(calls)).toHaveLength(1)
    }
  })

  it('a 401 or 403 from the CSRF fetch is session expired and sends nothing; other CSRF failures are retryable and send nothing', async () => {
    for (const [csrfStatus, expected] of [[401, 'session-expired'], [403, 'session-expired'], [500, 'failed'], ['throw', 'failed']] as const) {
      const calls = u4Http([{status: 200, body: {state: 'claimed'}}], {csrfStatus})
      expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', SKIP)).toEqual({kind: expected})
      expect(u4Posts(calls)).toHaveLength(0)
    }
  })

  it('a network failure of the POST is an unknown outcome and is not resubmitted', async () => {
    const calls = u4Http(['throw'])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', SKIP)).toEqual({kind: 'unknown'})
    expect(u4Posts(calls)).toHaveLength(1)
  })

  it.each([429, 500, 502, 503])('%i is an unknown outcome (it may have been recorded) and is not resubmitted', async status => {
    const calls = u4Http([{status, body: {}}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', SKIP)).toEqual({kind: 'unknown'})
    expect(u4Posts(calls)).toHaveLength(1)
  })

  it('a network failure of the retry POST is an unknown outcome', async () => {
    u4Http([{status: 400, body: {error: 'bad request'}}, 'throw'])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', SKIP)).toEqual({kind: 'unknown'})
  })

  it('a 200 with an unreadable body is an unknown outcome', async () => {
    u4Http([{status: 200}])
    expect(await buildQuestionClient().decideRunQuestion('run-1', 'req-1', SKIP)).toEqual({kind: 'unknown'})
  })

  it('an unsendable ID or decision is a request-level failure and sends nothing', async () => {
    const calls = u4Http([{status: 200, body: {state: 'claimed'}}])
    const client = buildQuestionClient()
    expect(await client.decideRunQuestion('run/1', 'req-1', SKIP)).toEqual({kind: 'failed'})
    expect(await client.decideRunQuestion('run-1', '../x', SKIP)).toEqual({kind: 'failed'})
    expect(await client.decideRunQuestion('run-1', 'req-1', {decision: 'nope'} as never)).toEqual({kind: 'failed'})
    expect(await client.decideRunQuestion('run-1', 'req-1', {decision: 'answer', answers: [{options: [-1]}]})).toEqual({kind: 'failed'})
    expect(await client.decideRunQuestion('run-1', 'req-1', {decision: 'answer', answers: [{text: 5}]} as never)).toEqual({kind: 'failed'})
    expect(calls).toHaveLength(0)
  })

  it('fixture mode appends the fixture session id to the decision and list paths; the base is configurable', async () => {
    const calls = u4Http([{status: 200, body: {state: 'claimed'}}, {status: 200, body: {requests: []}}])
    const client = buildQuestionClient({endpointBase: '/dev/operator', fixtureSessionId: 'fx 1'})
    await client.decideRunQuestion('run-1', 'req-1', SKIP)
    await client.listRunQuestions('run-1')
    expect(u4Posts(calls)[0]?.url).toBe('/dev/operator/runs/run-1/questions/req-1/decision?fixtureSessionId=fx%201')
    expect(calls.at(-1)?.url).toBe('/dev/operator/runs/run-1/questions?fixtureSessionId=fx%201')
  })
})

describe('buildQuestionClient — listRunQuestions validation', () => {
  afterEach(u4Cleanup)

  const entry = (requestID: string, extra: Record<string, unknown> = {}) => ({requestID, questions: [qQuestion()], ...extra})

  it('GETs the run\'s list with redirect:error and credentials, and returns the parsed requests', async () => {
    const calls = u4Http([{status: 200, body: {requests: [entry('A'), entry('B')]}}])
    const result = await buildQuestionClient().listRunQuestions('run-1')
    expect(calls[0]?.url).toBe('/operator/runs/run-1/questions')
    expect(calls[0]?.init.redirect).toBe('error')
    expect(calls[0]?.init.credentials).toBe('include')
    expect(calls[0]?.init.method).toBeUndefined()
    expect(result).toEqual({
      success: true,
      data: {requests: [entry('A'), entry('B')], invalidBody: false, partial: false},
    })
  })

  it('an empty list is valid and authoritative', async () => {
    u4Http([{status: 200, body: {requests: []}}])
    expect(await buildQuestionClient().listRunQuestions('run-1')).toEqual({
      success: true,
      data: {requests: [], invalidBody: false, partial: false},
    })
  })

  it('applies the question text rule to listed prompts (same parser as the frames)', async () => {
    u4Http([{status: 200, body: {requests: [{requestID: 'A', questions: [qQuestion({text: 'a\tb\u202Ec'})]}]}}])
    const result = await buildQuestionClient().listRunQuestions('run-1')
    expect(result.success && result.data.requests[0]?.questions[0]?.text).toBe('a bc')
  })

  it.each([
    ['null body', null],
    ['an array', []],
    ['no requests key', {items: []}],
    ['requests not an array', {requests: 'nope'}],
    ['an extra key on the body', {requests: [], extra: 1}],
    ['more entries than the gateway cap', {requests: Array.from({length: GATEWAY_PENDING_QUESTIONS_CAP + 1}, (_, index) => entry(`R${index}`))}],
  ])('an invalid body (%s) is flagged invalidBody with nothing listed', async (_name, body) => {
    u4Http([{status: 200, body}])
    expect(await buildQuestionClient().listRunQuestions('run-1')).toEqual({
      success: true,
      data: {requests: [], invalidBody: true, partial: false},
    })
  })

  it('an unreadable 200 body is invalidBody too', async () => {
    u4Http([{status: 200}])
    const result = await buildQuestionClient().listRunQuestions('run-1')
    expect(result.success && result.data.invalidBody).toBe(true)
  })

  it.each([
    ['a per-item runId (the entry is closed)', entry('B', {runId: 'run-1'})],
    ['an extra key', entry('B', {extra: 1})],
    ['an empty requestID', entry('')],
    ['a non-string requestID', {requestID: 7, questions: []}],
    ['a question over its bound', {requestID: 'B', questions: [qQuestion({header: 'h'.repeat(QUESTION_HEADER_MAX_LENGTH + 1)})]}],
    ['more questions than the cap', {requestID: 'B', questions: Array.from({length: MAX_QUESTIONS_PER_REQUEST + 1}, () => qQuestion())}],
    ['a non-object', 'nope'],
    ['a duplicate of an earlier entry', entry('A')],
  ])('drops an entry with %s, keeps the rest, and marks the list partial', async (_name, bad) => {
    u4Http([{status: 200, body: {requests: [entry('A'), bad, entry('C')]}}])
    const result = await buildQuestionClient().listRunQuestions('run-1')
    expect(result.success && result.data.requests.map(request => request.requestID)).toEqual(['A', 'C'])
    expect(result.success && result.data.partial).toBe(true)
    expect(result.success && result.data.invalidBody).toBe(false)
  })

  it('a request with zero questions is valid', async () => {
    u4Http([{status: 200, body: {requests: [{requestID: 'A', questions: []}]}}])
    const result = await buildQuestionClient().listRunQuestions('run-1')
    expect(result.success && result.data.requests).toEqual([{requestID: 'A', questions: []}])
  })

  it('an own __proto__ key on an entry drops it', async () => {
    u4Http([{status: 200, body: JSON.parse('{"requests":[{"requestID":"A","questions":[],"__proto__":{"x":1}}]}')}])
    const result = await buildQuestionClient().listRunQuestions('run-1')
    expect(result.success && result.data.requests).toEqual([])
    expect(result.success && result.data.partial).toBe(true)
  })

  it.each([404, 429, 500])('non-OK %i is an http failure, not an empty list', async status => {
    u4Http([{status, body: {requests: []}}])
    expect(await buildQuestionClient().listRunQuestions('run-1')).toEqual({success: false, error: {kind: 'http', status}})
  })

  it('a fetch that throws is a network failure', async () => {
    u4Http(['throw'])
    expect(await buildQuestionClient().listRunQuestions('run-1')).toEqual({success: false, error: {kind: 'network'}})
  })

  it('an unsafe run ID is refused before any request', async () => {
    const calls = u4Http([{status: 200, body: {requests: []}}])
    expect(await buildQuestionClient().listRunQuestions('../x')).toEqual({success: false, error: {kind: 'invalid-id'}})
    expect(calls).toHaveLength(0)
  })
})

describe('question list through the handle — validation reaches the reducer rules', () => {
  afterEach(u4Cleanup)

  it('a list with dropped entries is additive only: a local request the list omits survives', async () => {
    const partial: QuestionListResult = {success: true, data: {requests: [], invalidBody: false, partial: true}}
    const h = u4Start({initial: [u4Chunks('A')], list: n => (n === 1 ? u4Listed() : partial)})
    await h.flush()
    await h.reconnect()
    expect(h.ids()).toEqual(['A'])
  })

  it('an authoritative list prunes a local request it omits, without a tombstone', async () => {
    const h = u4Start({initial: [u4Chunks('A')], list: () => u4Listed()})
    await h.flush()
    await h.reconnect()
    expect(h.ids()).toEqual([])
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(false)
  })
})

describe('question client — vocabulary parity and privacy', () => {
  afterEach(u4Cleanup)

  it('the browser vocabularies equal the vendored ones', () => {
    expect([...QUESTION_DECISION_STATES]).toEqual([...VENDORED_QUESTION_DECISION_STATES])
    expect([...QUESTION_INVALID_REASONS]).toEqual([...VENDORED_QUESTION_INVALID_REASONS])
  })

  it('request bodies and response text never reach the console or storage, through the client and the handle', async () => {
    const SECRET_ANSWER = 'u4-secret-answer-text'
    const SECRET_RESPONSE = 'u4-secret-response-text'
    const SECRET_QUESTION = 'u4-secret-question-text'
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', {setItem, getItem: () => null})
    vi.stubGlobal('sessionStorage', {setItem, getItem: () => null})

    // Client: every outcome class, with secrets in the request and in the response bodies.
    const decision: QuestionDecision = {decision: 'answer', answers: [{text: SECRET_ANSWER}]}
    for (const response of [
      {status: 200, body: {state: 'claimed', detail: SECRET_RESPONSE}},
      {status: 400, body: {error: SECRET_RESPONSE, reason: 'malformed', detail: SECRET_RESPONSE}},
      {status: 400, body: {error: SECRET_RESPONSE}},
      {status: 404, body: {error: SECRET_RESPONSE}},
      {status: 500, body: {error: SECRET_RESPONSE}},
      {status: 200, body: {state: SECRET_RESPONSE}},
    ]) {
      u4Http([response])
      await buildQuestionClient().decideRunQuestion('run-1', 'req-1', decision)
    }
    u4Http(['throw'])
    await buildQuestionClient().decideRunQuestion('run-1', 'req-1', decision)
    u4Http([{status: 200, body: {requests: [{requestID: 'A', questions: [qQuestion({text: SECRET_QUESTION, extra: SECRET_RESPONSE})]}]}}])
    await buildQuestionClient().listRunQuestions('run-1')
    vi.unstubAllGlobals()
    vi.stubGlobal('localStorage', {setItem, getItem: () => null})
    vi.stubGlobal('sessionStorage', {setItem, getItem: () => null})

    // Handle: open a request with secret text, answer with secret text, fail every way.
    const outcomes: QuestionDecisionOutcome[] = [
      {kind: 'unknown'},
      {kind: 'invalid', reason: 'malformed', questionIndex: 0},
      {kind: 'session-expired'},
      u4Decided('already_claimed'),
    ]
    const frame = qSse(qOpen('A', [qQuestion({text: SECRET_QUESTION})]))
    const h = u4Start({
      initial: [[U4_READY, u4Status('running'), frame]],
      decide: n => outcomes[n - 1] ?? u4Decided('claimed'),
      list: () => ({success: false, error: {kind: 'http', status: 500}}),
    })
    await h.flush()
    for (const outcome of outcomes) {
      expect(outcome.kind).toBeDefined()
      await h.handle.decideQuestion('A', {decision: 'answer', answers: [{text: SECRET_ANSWER}]})
    }
    await h.handle.checkQuestions()
    await h.flush(60_000)
    const observable = JSON.stringify([h.handle.getQuestionNotes(), h.handle.getQuestions().map(request => request.status)])
    expect(observable).not.toContain(SECRET_ANSWER)
    expect(observable).not.toContain(SECRET_RESPONSE)

    for (const spy of consoleSpies) {
      for (const args of spy.mock.calls) {
        const text = JSON.stringify(args)
        for (const secret of [SECRET_ANSWER, SECRET_RESPONSE, SECRET_QUESTION]) expect(text).not.toContain(secret)
      }
      expect(spy).not.toHaveBeenCalled()
    }
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe('nextStreamState — question-claimed, question-resolved and endClaimedExemptions', () => {
  beforeEach(() => resetQuestionPageStore())
  afterEach(() => resetQuestionPageStore())

  const open = (...ids: string[]): StreamState => {
    let state = qStatus(qLive(), 'running')
    for (const id of ids) state = qFrameApply(state, qOpen(id))
    return state
  }

  it('question-claimed exempts an open request from removal by absence', () => {
    const claimed = nextStreamState(open('A', 'B'), {type: 'question-claimed', runId: Q_RUN, requestID: 'A'})
    expect(qEntry(claimed).questionClaimedExempt?.has('A')).toBe(true)
    expect(qIds(qReconcile(claimed, ['B']))).toEqual(['A', 'B'])
  })

  it('question-claimed is a no-op for a request that is not open, is tombstoned, or whose run is terminal', () => {
    const state = open('A')
    expect(nextStreamState(state, {type: 'question-claimed', runId: Q_RUN, requestID: 'Z'})).toBe(state)
    expect(nextStreamState(INITIAL_STATE, {type: 'question-claimed', runId: Q_RUN, requestID: 'A'})).toBe(INITIAL_STATE)
    const terminal = qStatus(state, 'succeeded')
    expect(nextStreamState(terminal, {type: 'question-claimed', runId: Q_RUN, requestID: 'A'})).toBe(terminal)
  })

  it('question-resolved tombstones, removes, drops the draft and the exemption, even before the connection is live', () => {
    const claimed = nextStreamState(open('A'), {type: 'question-claimed', runId: Q_RUN, requestID: 'A'})
    getQuestionPageStore(Q_RUN).drafts.set('A', {fixture: 'draft'})
    const reconnecting = {...claimed, connection: 'reconnecting'} as StreamState
    const resolved = nextStreamState(reconnecting, {type: 'question-resolved', runId: Q_RUN, requestID: 'A'})
    expect(qIds(resolved)).toEqual([])
    expect(qEntry(resolved).questionClaimedExempt?.has('A')).toBe(false)
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(true)
    expect(getQuestionPageStore(Q_RUN).drafts.has('A')).toBe(false)
    expect(qIds(qFrameApply(resolved, qOpen('A')))).toEqual([])
  })

  it('question-resolved is ignored once the run is terminal', () => {
    const terminal = qStatus(open('A'), 'succeeded')
    expect(nextStreamState(terminal, {type: 'question-resolved', runId: Q_RUN, requestID: 'A'})).toBe(terminal)
    expect(getQuestionPageStore(Q_RUN).tombstones.has('A')).toBe(false)
  })

  it('a reconcile with endClaimedExemptions removes a claimed request the list omits, and one without keeps it', () => {
    const claimed = nextStreamState(open('A', 'B'), {type: 'question-claimed', runId: Q_RUN, requestID: 'A'})
    const base: QuestionReconcileEvent = {
      type: 'question-reconcile',
      runId: Q_RUN,
      snapshotIds: ['A', 'B'],
      requests: [{requestID: 'B', questions: [qQuestion()] as never}],
      invalidBody: false,
      partial: false,
    }
    expect(qIds(nextStreamState(claimed, base))).toEqual(['A', 'B'])
    const ended = nextStreamState(claimed, {...base, endClaimedExemptions: true})
    expect(qIds(ended)).toEqual(['B'])
    expect(qEntry(ended).questionClaimedExempt?.size).toBe(0)
  })

  it('an invalid-body reconcile does not end exemptions even when asked to', () => {
    const claimed = nextStreamState(open('A'), {type: 'question-claimed', runId: Q_RUN, requestID: 'A'})
    const result = nextStreamState(claimed, {
      type: 'question-reconcile',
      runId: Q_RUN,
      snapshotIds: ['A'],
      requests: [],
      invalidBody: true,
      partial: false,
      endClaimedExemptions: true,
    })
    expect(result).toBe(claimed)
  })
})

describe('approval client — unchanged by the question client', () => {
  afterEach(u4Cleanup)

  it('still retries once on ANY 400, including one carrying a reason, with the same idempotency key', async () => {
    const calls = u4Http([
      {status: 400, body: {error: 'bad request', reason: 'malformed'}},
      {status: 200, body: {state: 'claimed'}},
    ])
    const result = await buildApprovalClient().decideRunApproval('run-1', 'req-1', 'once', 'idem-1')
    expect(result.success).toBe(true)
    const posts = u4Posts(calls)
    expect(posts).toHaveLength(2)
    expect(posts.map(post => (post.init.headers as Record<string, string>)['idempotency-key'])).toEqual(['idem-1', 'idem-1'])
  })

  it('still sends the idempotency key, and the approval routes are untouched by the question routes', async () => {
    const calls = u4Http([{status: 200, body: {state: 'claimed'}}, {status: 200, body: {approvals: []}}])
    const client = buildApprovalClient()
    await client.decideRunApproval('run-1', 'req-1', 'once', 'idem-2')
    await client.listRunApprovals('run-1')
    const urls = calls.map(call => call.url)
    expect(urls).toContain('/operator/runs/run-1/approvals/req-1/decision')
    expect(urls).toContain('/operator/runs/run-1/approvals')
    expect(urls.some(url => url.includes('/questions'))).toBe(false)
    expect(calls.find(call => call.url.endsWith('/decision'))?.init.headers).toMatchObject({'idempotency-key': 'idem-2'})
  })

  it('the approval reconcile still runs on a live transition with no question client wired', async () => {
    vi.useFakeTimers()
    const listed: string[] = []
    vi.stubGlobal('document', {createElement: (tag: string) => makeFakeEl(tag)})
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode([U4_READY, u4Status('running')].join(''))) }}),
    }))
    const approvalsEl = makeFakeEl('div')
    const handle = initOperatorStream({
      runId: Q_RUN,
      statusEl: makeFakeEl('span') as never,
      noticeEl: makeFakeEl('div') as never,
      approvalsEl: approvalsEl as never,
      approvalClient: {
        refreshCsrf: async () => ({success: true, data: {csrfToken: 'c'}}),
        decideRunApproval: async () => ({success: true, data: {state: 'claimed'}}),
        listRunApprovals: async (runId: string) => {
          listed.push(runId)
          return {success: true as const, data: {approvals: []}}
        },
      },
    })
    u4Handles.push(handle)
    await vi.advanceTimersByTimeAsync(10)
    expect(listed).toEqual([Q_RUN])
  })
})
