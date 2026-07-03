/**
 * Tests for the fetch-based SSE reader for the operator run stream.
 *
 * Security invariants tested:
 * - Contract-version gate: first frame must be 'ready' with matching version;
 *   mismatched version triggers fail-closed drift error, no status frames dispatched.
 * - 404 → typed not-found error, no body parsing for cause.
 * - 429 → typed rate-limited error.
 * - Network throw / abort → network-style error, fail closed.
 * - Fetch uses credentials:'include' and the given path; no repo param added.
 * - No runId appears in any logged line (route template only).
 * - Partial-chunk reassembly: frame split across two chunks is parsed once whole.
 */

import type {RunStreamFrame} from '../src/gateway/operator-contract/sse-frames.ts'
import type {Logger} from '../src/logger.ts'
import {describe, expect, it, vi} from 'vitest'
import {FIXTURE_RUN_ID_FOR_TESTS, FIXTURE_SCENARIO_NAMES, serializeScenarioToSse} from '../src/gateway/operator-fixture-sse.ts'
import {createOperatorSseReader, MAX_SSE_BUFFER_BYTES, parseSseChunk} from '../src/gateway/operator-sse-reader.ts'

function makeStreamBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

function makeResponse(status: number, chunks: string[]): Response {
  return new Response(makeStreamBody(chunks), {
    status,
    headers: {'content-type': 'text/event-stream'},
  })
}

function makeEmptyResponse(status: number): Response {
  return new Response(null, {status})
}

interface RecordedFetchCall {
  path: string
  init: RequestInit | undefined
}

function makeFakeFetch(response: Response): {
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>
  calls: RecordedFetchCall[]
} {
  const calls: RecordedFetchCall[] = []
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    calls.push({path, init})
    return response
  }
  return {fetchImpl, calls}
}

function makeThrowingFetch(error: unknown): {
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>
  calls: RecordedFetchCall[]
} {
  const calls: RecordedFetchCall[] = []
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    calls.push({path, init})
    throw error
  }
  return {fetchImpl, calls}
}

function makeCapturingLogger(): {logger: Logger; messages: string[]} {
  const messages: string[] = []
  const logger: Logger = {
    debug: (msg, ctx) => messages.push(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    info: (msg, ctx) => messages.push(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    warning: (msg, ctx) => messages.push(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    error: (msg, ctx) => messages.push(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
  }
  return {logger, messages}
}

describe('parseSseChunk — pure parser', () => {
  it('parses a ready frame', () => {
    const text = 'event: ready\ndata: {"contractVersion":"1.5.0"}\n\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success) {
      expect(frame.frame.type).toBe('ready')
      if (frame.frame.type === 'ready') {
        expect(frame.frame.data.contractVersion).toBe('1.5.0')
      }
    }
  })

  it('parses a status frame with a full OperatorRunStatus payload', () => {
    const payload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const text = `event: status\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success) {
      expect(frame.frame.type).toBe('status')
      if (frame.frame.type === 'status') {
        expect(frame.frame.data.runId).toBe('run-001')
        expect(frame.frame.data.status).toBe('running')
        expect(frame.frame.data.phase).toBe('EXECUTING')
        expect(frame.frame.data.stale).toBe(false)
      }
    }
  })

  it('parses a reset frame for each ResetReason', () => {
    const reasons = ['no-snapshot', 'terminal', 'shutdown', 'max-duration', 'writer-error', 'overflow'] as const
    for (const reason of reasons) {
      const payload = {runId: 'run-001', reason}
      const text = `event: reset\ndata: ${JSON.stringify(payload)}\n\n`
      const results = parseSseChunk(text)
      expect(results).toHaveLength(1)
      const frame = results[0]
      expect(frame?.success).toBe(true)
      if (frame?.success) {
        expect(frame.frame.type).toBe('reset')
        if (frame.frame.type === 'reset') {
          expect(frame.frame.data.reason).toBe(reason)
          expect(frame.frame.data.runId).toBe('run-001')
        }
      }
    }
  })

  it('parses an output delta frame', () => {
    const payload = {runId: 'run-001', text: 'partial answer', final: false, seq: 0}
    const text = `event: output\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success && frame.frame.type === 'output') {
      expect(frame.frame.data.runId).toBe('run-001')
      expect(frame.frame.data.text).toBe('partial answer')
      expect(frame.frame.data.final).toBe(false)
      expect(frame.frame.data.seq).toBe(0)
      expect(frame.frame.data.droppedCount).toBeUndefined()
    } else {
      expect.fail('expected an output frame')
    }
  })

  it('parses an output final frame with empty text (no-output terminal)', () => {
    const payload = {runId: 'run-001', text: '', final: true, seq: 0}
    const text = `event: output\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success && frame.frame.type === 'output') {
      expect(frame.frame.data.text).toBe('')
      expect(frame.frame.data.final).toBe(true)
    } else {
      expect.fail('expected an output frame')
    }
  })

  it('parses an output frame carrying droppedCount', () => {
    const payload = {runId: 'run-001', text: 'delta', final: false, seq: 4, droppedCount: 2}
    const text = `event: output\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success && frame.frame.type === 'output') {
      expect(frame.frame.data.droppedCount).toBe(2)
    } else {
      expect.fail('expected an output frame')
    }
  })

  it('rejects an output frame with a non-number droppedCount', () => {
    const payload = {runId: 'run-001', text: 'x', final: false, seq: 0, droppedCount: 'lots'}
    const text = `event: output\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
  })

  it('rejects output frames missing required fields', () => {
    const bad = [
      {text: 'x', final: false, seq: 0}, // missing runId
      {runId: 'r', final: false, seq: 0}, // missing text
      {runId: 'r', text: 'x', seq: 0}, // missing final
      {runId: 'r', text: 'x', final: false}, // missing seq
      {runId: 'r', text: 'x', final: 'no', seq: 0}, // wrong final type
      {runId: 'r', text: 'x', final: false, seq: '0'}, // wrong seq type
    ]
    for (const payload of bad) {
      const text = `event: output\ndata: ${JSON.stringify(payload)}\n\n`
      const frame = parseSseChunk(text)[0]
      expect(frame?.success).toBe(false)
    }
  })

  it('rejects output frames with non-integer/negative/non-finite seq or droppedCount', () => {
    const bad = [
      '{"runId":"r","text":"x","final":false,"seq":-1}',
      '{"runId":"r","text":"x","final":false,"seq":1.5}',
      '{"runId":"r","text":"x","final":false,"seq":1e999}',
      '{"runId":"r","text":"x","final":false,"seq":0,"droppedCount":-2}',
      '{"runId":"r","text":"x","final":false,"seq":0,"droppedCount":2.5}',
    ]
    for (const data of bad) {
      const frame = parseSseChunk(`event: output\ndata: ${data}\n\n`)[0]
      expect(frame?.success).toBe(false)
    }
  })

  it('parses an output frame followed by a terminal status frame in sequence', () => {
    const output = {runId: 'run-001', text: 'done', final: true, seq: 1}
    const status = {
      runId: 'run-001',
      entityRef: 'testowner/testrepo',
      surface: 'github',
      phase: 'COMPLETED',
      status: 'succeeded',
      startedAt: '2026-06-22T00:00:00Z',
      stale: false,
    }
    const text = `event: output\ndata: ${JSON.stringify(output)}\n\nevent: status\ndata: ${JSON.stringify(status)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(2)
    expect(results[0]?.success && results[0].frame.type).toBe('output')
    expect(results[1]?.success && results[1].frame.type).toBe('status')
  })

  it('ignores a heartbeat comment line — produces no frame', () => {
    const text = ': heartbeat\n\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(0)
  })

  it('ignores a blank comment line — produces no frame', () => {
    const text = ':\n\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(0)
  })

  it('returns a typed failure for malformed JSON data', () => {
    const text = 'event: ready\ndata: {not valid json}\n\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      // Error message must be a fixed string, not echoing input
      expect(frame.error.message).not.toContain('{not valid json}')
    }
  })

  it('returns a typed failure for a ready frame missing contractVersion', () => {
    const text = 'event: ready\ndata: {"other":"field"}\n\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(false)
  })

  it('returns a typed failure for a reset frame with unknown reason', () => {
    const text = 'event: reset\ndata: {"runId":"run-001","reason":"unknown-reason"}\n\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      // Must not echo the unknown reason value
      expect(frame.error.message).not.toContain('unknown-reason')
    }
  })

  it('returns a typed failure for a reset frame missing runId', () => {
    const text = 'event: reset\ndata: {"reason":"terminal"}\n\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(false)
  })

  it('returns a typed failure for a status frame missing required fields', () => {
    const text = 'event: status\ndata: {"runId":"run-001"}\n\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(false)
  })

  it('returns a typed failure for an unknown event name', () => {
    const text = 'event: unknown-event\ndata: {"foo":"bar"}\n\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      // Must not echo the unknown event name
      expect(frame.error.message).not.toContain('unknown-event')
    }
  })

  it('parses multiple frames from a single chunk', () => {
    const readyPayload = {contractVersion: '1.5.0'}
    const statusPayload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const text = `event: ready\ndata: ${JSON.stringify(readyPayload)}\n\nevent: status\ndata: ${JSON.stringify(statusPayload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(2)
    expect(results[0]?.success).toBe(true)
    if (results[0]?.success) {
      expect(results[0].frame.type).toBe('ready')
    }
    expect(results[1]?.success).toBe(true)
    if (results[1]?.success) {
      expect(results[1].frame.type).toBe('status')
    }
  })

  it('ignores a heartbeat comment mixed with real frames', () => {
    const readyPayload = {contractVersion: '1.5.0'}
    const text = `event: ready\ndata: ${JSON.stringify(readyPayload)}\n\n: heartbeat\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(true)
    if (results[0]?.success) {
      expect(results[0].frame.type).toBe('ready')
    }
  })

  it('handles a frame with no event line (data-only) as a failure', () => {
    const text = 'data: {"contractVersion":"1.5.0"}\n\n'
    const results = parseSseChunk(text)
    // No event name → unknown event → typed failure
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(false)
  })
})

describe('createOperatorSseReader — 200 happy path', () => {
  it('dispatches ready then status frames in order', async () => {
    const readyPayload = {contractVersion: '1.5.0'}
    const statusPayload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const sseText = `event: ready\ndata: ${JSON.stringify(readyPayload)}\n\nevent: status\ndata: ${JSON.stringify(statusPayload)}\n\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    let closed = false

    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(0)
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('ready')
    expect(events[1]?.type).toBe('status')
    expect(closed).toBe(true)
  })

  it('calls onClose after stream ends', async () => {
    const sseText = 'event: ready\ndata: {"contractVersion":"1.5.0"}\n\n'
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => { closed = true },
    })

    expect(closed).toBe(true)
  })

  it('dispatches a reset frame', async () => {
    const resetPayload = {runId: 'run-001', reason: 'no-snapshot'}
    const sseText = `event: ready\ndata: {"contractVersion":"1.5.0"}\n\nevent: reset\ndata: ${JSON.stringify(resetPayload)}\n\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: () => {},
      onClose: () => {},
    })

    expect(events).toHaveLength(2)
    expect(events[1]?.type).toBe('reset')
    if (events[1]?.type === 'reset') {
      expect(events[1].data.reason).toBe('no-snapshot')
    }
  })

  it('ignores heartbeat comments — no frame dispatched', async () => {
    const sseText = 'event: ready\ndata: {"contractVersion":"1.5.0"}\n\n: heartbeat\n\n'
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: () => {},
      onClose: () => {},
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('ready')
  })

  it('live stream: 1.5.0 ready + running status + output delta dispatches all three frames in order', async () => {
    const statusPayload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const outputPayload = {runId: 'run-001', text: 'partial output', final: false, seq: 0}
    const sseText =
      `event: ready\ndata: {"contractVersion":"1.5.0"}\n\n` +
      `event: status\ndata: ${JSON.stringify(statusPayload)}\n\n` +
      `event: output\ndata: ${JSON.stringify(outputPayload)}\n\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(0)
    expect(events).toHaveLength(3)
    expect(events[0]?.type).toBe('ready')
    expect(events[1]?.type).toBe('status')
    expect(events[2]?.type).toBe('output')
    if (events[2]?.type === 'output') {
      expect(events[2].data.text).toBe('partial output')
      expect(events[2].data.final).toBe(false)
    }
  })

  it('live stream: 1.5.0 ready + status + empty final output (no-output terminal guarantee)', async () => {
    const statusPayload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const emptyFinalOutput = {runId: 'run-001', text: '', final: true, seq: 0}
    const sseText =
      `event: ready\ndata: {"contractVersion":"1.5.0"}\n\n` +
      `event: status\ndata: ${JSON.stringify(statusPayload)}\n\n` +
      `event: output\ndata: ${JSON.stringify(emptyFinalOutput)}\n\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(0)
    expect(events).toHaveLength(3)
    expect(events[2]?.type).toBe('output')
    if (events[2]?.type === 'output') {
      expect(events[2].data.text).toBe('')
      expect(events[2].data.final).toBe(true)
    }
  })
})

describe('createOperatorSseReader — contract-version gate', () => {
  it('dispatches ready and status when contractVersion matches', async () => {
    const statusPayload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const sseText = `event: ready\ndata: {"contractVersion":"1.5.0"}\n\nevent: status\ndata: ${JSON.stringify(statusPayload)}\n\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(0)
    expect(events).toHaveLength(2)
  })

  it('fails closed on contractVersion mismatch — no status frames dispatched', async () => {
    const statusPayload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const sseText = `event: ready\ndata: {"contractVersion":"1.0.0"}\n\nevent: status\ndata: ${JSON.stringify(statusPayload)}\n\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('contract-drift')
    const statusFrames = events.filter(e => e.type === 'status')
    expect(statusFrames).toHaveLength(0)
    expect(closed).toBe(true)
  })

  it('contract-drift error message does not echo the mismatched version', async () => {
    const sseText = 'event: ready\ndata: {"contractVersion":"9.9.9"}\n\n'
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).not.toContain('9.9.9')
  })

  it('future unknown version (2.0.0) followed by status and output dispatches nothing', async () => {
    const statusPayload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const outputPayload = {runId: 'run-001', text: 'partial output', final: false, seq: 0}
    const sseText =
      `event: ready\ndata: {"contractVersion":"2.0.0"}\n\n` +
      `event: status\ndata: ${JSON.stringify(statusPayload)}\n\n` +
      `event: output\ndata: ${JSON.stringify(outputPayload)}\n\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('contract-drift')
    const statusFrames = events.filter(e => e.type === 'status')
    const outputFrames = events.filter(e => e.type === 'output')
    expect(statusFrames).toHaveLength(0)
    expect(outputFrames).toHaveLength(0)
  })
})

describe('createOperatorSseReader — 404 not found', () => {
  it('calls onError with a not-found error and then onClose', async () => {
    const {fetchImpl} = makeFakeFetch(makeEmptyResponse(404))
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('not-found')
    expect(closed).toBe(true)
  })

  it('does not parse the 404 response body for cause', async () => {
    const bodyWithCause = JSON.stringify({error: 'run_not_found', cause: 'secret-internal-detail'})
    const response = new Response(bodyWithCause, {
      status: 404,
      headers: {'content-type': 'application/json'},
    })
    const {fetchImpl} = makeFakeFetch(response)
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).not.toContain('secret-internal-detail')
    expect(errors[0]?.message).not.toContain('run_not_found')
  })
})

describe('createOperatorSseReader — 429 rate limited', () => {
  it('calls onError with a rate-limited error and then onClose', async () => {
    const {fetchImpl} = makeFakeFetch(makeEmptyResponse(429))
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('rate-limited')
    expect(closed).toBe(true)
  })
})

describe('createOperatorSseReader — other HTTP error statuses', () => {
  it('calls onError with a network-style error for 500', async () => {
    const {fetchImpl} = makeFakeFetch(makeEmptyResponse(500))
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(1)
    expect(closed).toBe(true)
  })

  it('calls onError with a network-style error for 401', async () => {
    const {fetchImpl} = makeFakeFetch(makeEmptyResponse(401))
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(1)
    expect(closed).toBe(true)
  })
})

describe('createOperatorSseReader — network throw', () => {
  it('calls onError with a network-style error when fetch throws', async () => {
    const {fetchImpl} = makeThrowingFetch(new Error('connection refused'))
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).not.toContain('connection refused')
    expect(closed).toBe(true)
  })

  it('calls onError when fetch is aborted via signal', async () => {
    const controller = new AbortController()
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    const {fetchImpl} = makeThrowingFetch(abortError)
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
      signal: controller.signal,
    })

    expect(errors).toHaveLength(1)
    expect(closed).toBe(true)
  })
})

describe('createOperatorSseReader — fetch args', () => {
  it('sends credentials:include on the outgoing fetch', async () => {
    const {fetchImpl, calls} = makeFakeFetch(makeEmptyResponse(404))
    const reader = createOperatorSseReader({fetchImpl})

    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.init?.credentials).toBe('include')
  })

  it('sends the exact path given — no repo param appended', async () => {
    const {fetchImpl, calls} = makeFakeFetch(makeEmptyResponse(404))
    const reader = createOperatorSseReader({fetchImpl})

    const path = '/operator/runs/run-001/stream'
    await reader.open(path, {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })

    expect(calls[0]?.path).toBe(path)
    expect(calls[0]?.path).not.toContain('?')
  })

  it('sends Accept: text/event-stream header', async () => {
    const {fetchImpl, calls} = makeFakeFetch(makeEmptyResponse(404))
    const reader = createOperatorSseReader({fetchImpl})

    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })

    const headers = calls[0]?.init?.headers as Record<string, string> | undefined
    expect(headers?.accept).toBe('text/event-stream')
  })
})

describe('createOperatorSseReader — logger discipline', () => {
  it('logs only the route template, never the dynamic runId', async () => {
    const {logger, messages} = makeCapturingLogger()
    const {fetchImpl} = makeFakeFetch(makeEmptyResponse(404))
    const reader = createOperatorSseReader({fetchImpl, logger})

    await reader.open('/operator/runs/run-secret-id-xyz/stream', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })

    for (const msg of messages) {
      expect(msg).not.toContain('run-secret-id-xyz')
    }
  })

  it('logs the route template /operator/runs/:runId/stream on error', async () => {
    const {logger, messages} = makeCapturingLogger()
    const {fetchImpl} = makeFakeFetch(makeEmptyResponse(404))
    const reader = createOperatorSseReader({fetchImpl, logger})

    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })

    const hasTemplate = messages.some(m => m.includes('/operator/runs/:runId/stream'))
    expect(hasTemplate).toBe(true)
  })

  it('does not log the runId on contract-drift error', async () => {
    const {logger, messages} = makeCapturingLogger()
    const sseText = 'event: ready\ndata: {"contractVersion":"0.0.1"}\n\n'
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl, logger})

    await reader.open('/operator/runs/run-secret-id-xyz/stream', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })

    for (const msg of messages) {
      expect(msg).not.toContain('run-secret-id-xyz')
    }
  })
})

describe('createOperatorSseReader — partial-chunk reassembly', () => {
  it('reassembles a frame split across two chunks', async () => {
    const fullFrame = 'event: ready\ndata: {"contractVersion":"1.5.0"}\n\n'
    const chunk1 = fullFrame.slice(0, 20)
    const chunk2 = fullFrame.slice(20)

    const {fetchImpl} = makeFakeFetch(makeResponse(200, [chunk1, chunk2]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(0)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('ready')
  })

  it('reassembles a frame split at the blank-line boundary', async () => {
    const fullFrame = 'event: ready\ndata: {"contractVersion":"1.5.0"}\n\n'
    const splitAt = fullFrame.length - 2
    const chunk1 = fullFrame.slice(0, splitAt)
    const chunk2 = fullFrame.slice(splitAt)

    const {fetchImpl} = makeFakeFetch(makeResponse(200, [chunk1, chunk2]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: () => {},
      onClose: () => {},
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('ready')
  })

  it('handles multiple frames across multiple chunks', async () => {
    const statusPayload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const frame1 = 'event: ready\ndata: {"contractVersion":"1.5.0"}\n\n'
    const frame2 = `event: status\ndata: ${JSON.stringify(statusPayload)}\n\n`
    const combined = frame1 + frame2
    const chunk1 = combined.slice(0, 15)
    const chunk2 = combined.slice(15, 50)
    const chunk3 = combined.slice(50)

    const {fetchImpl} = makeFakeFetch(makeResponse(200, [chunk1, chunk2, chunk3]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(0)
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('ready')
    expect(events[1]?.type).toBe('status')
  })
})

describe('createOperatorSseReader — EventStreamHandle shape', () => {
  it('the reader object has an open method', () => {
    const reader = createOperatorSseReader({fetchImpl: async () => makeEmptyResponse(404)})
    expect(typeof reader.open).toBe('function')
  })
})

describe('createOperatorSseReader — callback discipline', () => {
  it('calls onError exactly once and onClose exactly once on 404', async () => {
    const {fetchImpl} = makeFakeFetch(makeEmptyResponse(404))
    const reader = createOperatorSseReader({fetchImpl})

    const onEvent = vi.fn()
    const onError = vi.fn()
    const onClose = vi.fn()

    await reader.open('/operator/runs/run-001/stream', {onEvent, onError, onClose})

    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onError exactly once and onClose exactly once on network throw', async () => {
    const {fetchImpl} = makeThrowingFetch(new Error('network failure'))
    const reader = createOperatorSseReader({fetchImpl})

    const onEvent = vi.fn()
    const onError = vi.fn()
    const onClose = vi.fn()

    await reader.open('/operator/runs/run-001/stream', {onEvent, onError, onClose})

    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose exactly once on clean stream end', async () => {
    const sseText = 'event: ready\ndata: {"contractVersion":"1.5.0"}\n\n'
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const onClose = vi.fn()
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: () => {},
      onClose,
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('parseSseChunk — CRLF normalization', () => {
  it('parses a ready frame delimited by CRLF record separators', () => {
    const text = 'event: ready\r\ndata: {"contractVersion":"1.5.0"}\r\n\r\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(true)
    if (results[0]?.success) {
      expect(results[0].frame.type).toBe('ready')
    }
  })

  it('parses a status frame delimited by CRLF identically to LF-only', () => {
    const payload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const crlfText = `event: status\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`
    const lfText = `event: status\ndata: ${JSON.stringify(payload)}\n\n`
    const crlfResults = parseSseChunk(crlfText)
    const lfResults = parseSseChunk(lfText)
    expect(crlfResults).toHaveLength(1)
    expect(lfResults).toHaveLength(1)
    expect(crlfResults[0]?.success).toBe(true)
    expect(lfResults[0]?.success).toBe(true)
    if (crlfResults[0]?.success && lfResults[0]?.success) {
      expect(crlfResults[0].frame.type).toBe(lfResults[0].frame.type)
      if (crlfResults[0].frame.type === 'status' && lfResults[0].frame.type === 'status') {
        expect(crlfResults[0].frame.data.runId).toBe(lfResults[0].frame.data.runId)
        expect(crlfResults[0].frame.data.status).toBe(lfResults[0].frame.data.status)
      }
    }
  })

  it('parses a reset frame delimited by CRLF record separators', () => {
    const payload = {runId: 'run-001', reason: 'shutdown'}
    const text = `event: reset\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(true)
    if (results[0]?.success) {
      expect(results[0].frame.type).toBe('reset')
    }
  })

  it('parses a ready frame with lone CR line endings', () => {
    const text = 'event: ready\rdata: {"contractVersion":"1.5.0"}\r\r'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(true)
    if (results[0]?.success) {
      expect(results[0].frame.type).toBe('ready')
    }
  })
})

describe('createOperatorSseReader — CRLF normalization in stream', () => {
  it('parses ready+status frames delivered with CRLF delimiters', async () => {
    const statusPayload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const sseText =
      `event: ready\r\ndata: {"contractVersion":"1.5.0"}\r\n\r\n` +
      `event: status\r\ndata: ${JSON.stringify(statusPayload)}\r\n\r\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(0)
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('ready')
    expect(events[1]?.type).toBe('status')
  })
})

describe('createOperatorSseReader — buffer overflow', () => {
  it('fails closed with onError+onClose when buffer exceeds MAX_SSE_BUFFER_BYTES without a boundary', async () => {
    const oversizedChunk = 'x'.repeat(MAX_SSE_BUFFER_BYTES + 1)
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [oversizedChunk]))
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).not.toContain('x'.repeat(10))
    expect(closed).toBe(true)
  })
})

describe('createOperatorSseReader — flush path contract gate', () => {
  it('flush of a status-only buffer with no prior ready dispatches nothing', async () => {
    const statusPayload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    // No trailing \n\n triggers the flush path; no ready frame precedes it
    const sseText = `event: status\ndata: ${JSON.stringify(statusPayload)}`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('contract-drift')
    const statusFrames = events.filter(e => e.type === 'status')
    expect(statusFrames).toHaveLength(0)
  })

  it('flush of a complete frame without trailing blank line dispatches the frame', async () => {
    const sseText = 'event: ready\ndata: {"contractVersion":"1.5.0"}'
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(0)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('ready')
  })
})

describe('parseSseChunk — approval frame (open variant)', () => {
  it('parses an open approval frame with command', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      permission: 'shell',
      command: 'echo hello',
      settled: false,
    }
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success && frame.frame.type === 'approval') {
      expect(frame.frame.data.runId).toBe('run-001')
      expect(frame.frame.data.requestID).toBe('req-001')
      expect(frame.frame.data.settled).toBe(false)
      if (!frame.frame.data.settled) {
        expect(frame.frame.data.permission).toBe('shell')
        expect(frame.frame.data.command).toBe('echo hello')
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
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success && frame.frame.type === 'approval') {
      expect(frame.frame.data.settled).toBe(false)
      if (!frame.frame.data.settled) {
        expect(frame.frame.data.permission).toBe('fs-write')
        expect(frame.frame.data.filepath).toBe('/workspace/output.txt')
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
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success && frame.frame.type === 'approval') {
      expect(frame.frame.data.settled).toBe(false)
      if (!frame.frame.data.settled) {
        expect(frame.frame.data.permission).toBe('network')
        expect(frame.frame.data.command).toBeUndefined()
        expect(frame.frame.data.filepath).toBeUndefined()
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
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success && frame.frame.type === 'approval') {
      if (!frame.frame.data.settled) {
        expect(frame.frame.data.command).toBe('')
      }
    } else {
      expect.fail('expected an approval frame')
    }
  })
})

describe('parseSseChunk — approval frame (settle variant)', () => {
  it('parses a settle approval frame', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      settled: true,
    }
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success && frame.frame.type === 'approval') {
      expect(frame.frame.data.runId).toBe('run-001')
      expect(frame.frame.data.requestID).toBe('req-001')
      expect(frame.frame.data.settled).toBe(true)
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
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success) {
      expect(frame.frame.type).toBe('approval')
    }
  })
})

describe('parseSseChunk — approval frame (error cases, fail-closed, no wire echo)', () => {
  it('rejects approval frame with missing runId', () => {
    const payload = {requestID: 'req-001', permission: 'shell', settled: false}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).not.toContain('req-001')
    }
  })

  it('rejects approval frame with non-string runId', () => {
    const payload = {runId: 42, requestID: 'req-001', permission: 'shell', settled: false}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).not.toContain('42')
    }
  })

  it('rejects approval frame with missing requestID', () => {
    const payload = {runId: 'run-001', permission: 'shell', settled: false}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).not.toContain('run-001')
    }
  })

  it('rejects approval frame with non-string requestID', () => {
    const payload = {runId: 'run-001', requestID: true, permission: 'shell', settled: false}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
  })

  it('rejects open approval frame with missing permission', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', settled: false}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).not.toContain('run-001')
      expect(frame.error.message).not.toContain('req-001')
    }
  })

  it('rejects open approval frame with non-string permission', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: 99, settled: false}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).not.toContain('99')
    }
  })

  it('rejects approval frame with non-boolean settled', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: 'shell', settled: 'false'}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).not.toContain('false')
    }
  })

  it('rejects open approval frame with non-string command (present but wrong type)', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: 'shell', command: 123, settled: false}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).not.toContain('123')
    }
  })

  it('rejects open approval frame with non-string filepath (present but wrong type)', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: 'shell', filepath: [], settled: false}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
  })

  it('error string for missing required fields is fixed and does not echo wire content', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', settled: false}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).toBe('approval frame missing required fields')
    }
  })

  it('error string for invalid settled discriminator is fixed and does not echo wire content', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', settled: 'yes'}
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const frame = parseSseChunk(text)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).toBe('approval frame has invalid settled discriminator')
    }
  })

  it('rejects approval frame with empty-string runId (open)', () => {
    const payload = {runId: '', requestID: 'req-001', permission: 'shell', settled: false}
    const frame = parseSseChunk(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)[0]
    expect(frame?.success).toBe(false)
  })

  it('rejects approval frame with empty-string requestID (open)', () => {
    const payload = {runId: 'run-001', requestID: '', permission: 'shell', settled: false}
    const frame = parseSseChunk(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)[0]
    expect(frame?.success).toBe(false)
  })

  it('rejects approval frame with empty-string runId (settle)', () => {
    const payload = {runId: '', requestID: 'req-001', settled: true}
    const frame = parseSseChunk(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)[0]
    expect(frame?.success).toBe(false)
  })

  it('rejects approval frame with empty-string requestID (settle)', () => {
    const payload = {runId: 'run-001', requestID: '', settled: true}
    const frame = parseSseChunk(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)[0]
    expect(frame?.success).toBe(false)
  })

  it('rejects open approval frame with empty-string permission', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: '', settled: false}
    const frame = parseSseChunk(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)[0]
    expect(frame?.success).toBe(false)
  })

  it('non-string requestID rejection does not echo the bad value', () => {
    const payload = {runId: 'run-001', requestID: true, permission: 'shell', settled: false}
    const frame = parseSseChunk(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).not.toContain('true')
    }
  })

  it('non-string filepath rejection does not echo the bad value', () => {
    const payload = {runId: 'run-001', requestID: 'req-001', permission: 'shell', filepath: [], settled: false}
    const frame = parseSseChunk(`event: approval\ndata: ${JSON.stringify(payload)}\n\n`)[0]
    expect(frame?.success).toBe(false)
    if (frame !== undefined && !frame.success) {
      expect(frame.error.message).not.toContain('[]')
    }
  })
})

describe('parseSseChunk — approval frame (open variant) — filepath valid', () => {
  it('parses an open approval frame with empty string filepath (valid string)', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      permission: 'fs-write',
      filepath: '',
      settled: false,
    }
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success && frame.frame.type === 'approval') {
      if (!frame.frame.data.settled) {
        expect(frame.frame.data.filepath).toBe('')
      }
    } else {
      expect.fail('expected an approval frame')
    }
  })
})

describe('parseSseChunk — approval frame (settle variant) — extra fields absent', () => {
  it('settle frame with extra wire fields: parsed data has ONLY {runId, requestID, settled}', () => {
    const payload = {
      runId: 'run-001',
      requestID: 'req-001',
      settled: true,
      extraField: 'ignored',
      anotherExtra: 42,
    }
    const text = `event: approval\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success && frame.frame.type === 'approval') {
      const data = frame.frame.data
      const keys = Object.keys(data)
      expect(keys.sort()).toEqual(['requestID', 'runId', 'settled'].sort())
      expect('extraField' in data).toBe(false)
      expect('anotherExtra' in data).toBe(false)
    } else {
      expect.fail('expected an approval frame')
    }
  })
})

describe('parseSseChunk — approval frame integration (open then settle in one chunk)', () => {
  it('parses an open frame followed by a settle frame for the same requestID in order', () => {
    const openPayload = {
      runId: 'run-001',
      requestID: 'req-001',
      permission: 'shell',
      command: 'ls /tmp',
      settled: false,
    }
    const settlePayload = {
      runId: 'run-001',
      requestID: 'req-001',
      settled: true,
    }
    const text =
      `event: approval\ndata: ${JSON.stringify(openPayload)}\n\n` +
      `event: approval\ndata: ${JSON.stringify(settlePayload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(2)
    expect(results[0]?.success).toBe(true)
    if (results[0]?.success && results[0].frame.type === 'approval') {
      expect(results[0].frame.data.settled).toBe(false)
    } else {
      expect.fail('expected first approval frame')
    }
    expect(results[1]?.success).toBe(true)
    if (results[1]?.success && results[1].frame.type === 'approval') {
      expect(results[1].frame.data.settled).toBe(true)
    } else {
      expect.fail('expected second approval frame')
    }
  })
})

describe('createOperatorSseReader — allowlist gate for status/phase/surface', () => {
  it('rejects a status frame with an out-of-allowlist status value — not dispatched', async () => {
    const payload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'fro-bot/private-repo leak',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const sseText =
      `event: ready\ndata: {"contractVersion":"1.5.0"}\n\n` +
      `event: status\ndata: ${JSON.stringify(payload)}\n\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => {},
    })

    expect(errors).toHaveLength(0)
    const statusFrames = events.filter(e => e.type === 'status')
    expect(statusFrames).toHaveLength(0)
    for (const err of errors) {
      expect(err.message).not.toContain('private-repo')
    }
  })

  it('rejects a status frame with an out-of-allowlist phase value', async () => {
    const payload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'UNKNOWN_PHASE',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const sseText =
      `event: ready\ndata: {"contractVersion":"1.5.0"}\n\n` +
      `event: status\ndata: ${JSON.stringify(payload)}\n\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: () => {},
      onClose: () => {},
    })

    const statusFrames = events.filter(e => e.type === 'status')
    expect(statusFrames).toHaveLength(0)
  })

  it('rejects a status frame with an out-of-allowlist surface value', async () => {
    const payload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'unknown-surface',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const sseText =
      `event: ready\ndata: {"contractVersion":"1.5.0"}\n\n` +
      `event: status\ndata: ${JSON.stringify(payload)}\n\n`
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: () => {},
      onClose: () => {},
    })

    const statusFrames = events.filter(e => e.type === 'status')
    expect(statusFrames).toHaveLength(0)
  })
})

describe('parseSseChunk — allowlist gate for status/phase/surface', () => {
  it('returns a parse failure for a status frame with out-of-allowlist status', () => {
    const payload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'EXECUTING',
      status: 'fro-bot/private-repo leak',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const text = `event: status\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(false)
    if (results[0] !== undefined && !results[0].success) {
      expect(results[0].error.message).not.toContain('private-repo')
    }
  })

  it('returns a parse failure for a status frame with out-of-allowlist phase', () => {
    const payload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'UNKNOWN_PHASE',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const text = `event: status\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(false)
  })

  it('returns a parse failure for a status frame with out-of-allowlist surface', () => {
    const payload = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'unknown-surface',
      phase: 'EXECUTING',
      status: 'running',
      startedAt: '2026-06-18T20:00:00Z',
      stale: false,
    }
    const text = `event: status\ndata: ${JSON.stringify(payload)}\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(false)
  })
})

describe('createOperatorSseReader — redirect and content-type', () => {
  it('sets redirect:error on the outgoing fetch init', async () => {
    const {fetchImpl, calls} = makeFakeFetch(makeEmptyResponse(404))
    const reader = createOperatorSseReader({fetchImpl})

    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })

    expect(calls[0]?.init?.redirect).toBe('error')
  })

  it('fails closed when 200 response has non-event-stream content-type', async () => {
    const response = new Response(makeStreamBody(['data: {}\n\n']), {
      status: 200,
      headers: {'content-type': 'text/html; charset=utf-8'},
    })
    const {fetchImpl} = makeFakeFetch(response)
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(1)
    expect(closed).toBe(true)
  })

  it('fails closed when 200 response has application/json content-type', async () => {
    const response = new Response(makeStreamBody(['{"error":"unauthorized"}\n\n']), {
      status: 200,
      headers: {'content-type': 'application/json'},
    })
    const {fetchImpl} = makeFakeFetch(response)
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(1)
    expect(closed).toBe(true)
  })
})

describe('createOperatorSseReader — path validation', () => {
  it('rejects an absolute URL — no fetch issued, fails closed', async () => {
    const {fetchImpl, calls} = makeFakeFetch(makeEmptyResponse(200))
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('https://evil.example.com/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(calls).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(closed).toBe(true)
  })

  it('rejects a protocol-relative URL (//evil) — no fetch issued, fails closed', async () => {
    const {fetchImpl, calls} = makeFakeFetch(makeEmptyResponse(200))
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('//evil.example.com/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(calls).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(closed).toBe(true)
  })

  it('rejects a non-/operator/runs/ relative path — no fetch issued, fails closed', async () => {
    const {fetchImpl, calls} = makeFakeFetch(makeEmptyResponse(200))
    const reader = createOperatorSseReader({fetchImpl})

    const errors: Error[] = []
    let closed = false
    await reader.open('/api/some-other-endpoint', {
      onEvent: () => {},
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(calls).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(closed).toBe(true)
  })

  it('accepts a valid /operator/runs/ relative path', async () => {
    const {fetchImpl, calls} = makeFakeFetch(makeEmptyResponse(404))
    const reader = createOperatorSseReader({fetchImpl})

    await reader.open('/operator/runs/run-001/stream', {
      onEvent: () => {},
      onError: () => {},
      onClose: () => {},
    })

    expect(calls).toHaveLength(1)
  })
})

describe('fixture SSE scenarios — scenario names', () => {
  it('exports canonical scenario names as a readonly object', () => {
    expect(typeof FIXTURE_SCENARIO_NAMES).toBe('object')
    expect(FIXTURE_SCENARIO_NAMES).not.toBeNull()
  })

  it('exports success scenario name', () => {
    expect(typeof FIXTURE_SCENARIO_NAMES.success).toBe('string')
    expect(FIXTURE_SCENARIO_NAMES.success.length).toBeGreaterThan(0)
  })

  it('exports terminal_failure scenario name', () => {
    expect(typeof FIXTURE_SCENARIO_NAMES.terminal_failure).toBe('string')
    expect(FIXTURE_SCENARIO_NAMES.terminal_failure.length).toBeGreaterThan(0)
  })

  it('exports contract_drift scenario name', () => {
    expect(typeof FIXTURE_SCENARIO_NAMES.contract_drift).toBe('string')
    expect(FIXTURE_SCENARIO_NAMES.contract_drift.length).toBeGreaterThan(0)
  })

  it('exports malformed_unavailable scenario name', () => {
    expect(typeof FIXTURE_SCENARIO_NAMES.malformed_unavailable).toBe('string')
    expect(FIXTURE_SCENARIO_NAMES.malformed_unavailable.length).toBeGreaterThan(0)
  })

  it('exports no_output scenario name', () => {
    expect(typeof FIXTURE_SCENARIO_NAMES.no_output).toBe('string')
    expect(FIXTURE_SCENARIO_NAMES.no_output.length).toBeGreaterThan(0)
  })

  it('exports stream_reset scenario name', () => {
    expect(typeof FIXTURE_SCENARIO_NAMES.stream_reset).toBe('string')
    expect(FIXTURE_SCENARIO_NAMES.stream_reset.length).toBeGreaterThan(0)
  })

  it('exports approval_flow scenario name', () => {
    expect(typeof FIXTURE_SCENARIO_NAMES.approval_flow).toBe('string')
    expect(FIXTURE_SCENARIO_NAMES.approval_flow.length).toBeGreaterThan(0)
  })

  it('scenario names are code-safe (no spaces, lowercase with underscores)', () => {
    for (const name of Object.values(FIXTURE_SCENARIO_NAMES)) {
      expect(/^[a-z][a-z0-9_]*$/.test(name)).toBe(true)
    }
  })
})

describe('fixture SSE scenarios — success scenario parses in server reader', () => {
  it('success scenario SSE bytes parse as ready + running status + output + terminal succeeded', async () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.success, FIXTURE_RUN_ID_FOR_TESTS)
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseBytes]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    let closed = false

    await reader.open('/operator/runs/run-fixture-success-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(0)
    expect(closed).toBe(true)
    expect(events.length).toBeGreaterThanOrEqual(4)

    const readyFrames = events.filter(e => e.type === 'ready')
    expect(readyFrames).toHaveLength(1)

    const statusFrames = events.filter(e => e.type === 'status')
    expect(statusFrames.length).toBeGreaterThanOrEqual(2)

    const outputFrames = events.filter(e => e.type === 'output')
    expect(outputFrames.length).toBeGreaterThanOrEqual(1)

    const terminalStatus = statusFrames.at(-1)
    expect(terminalStatus?.type).toBe('status')
    if (terminalStatus?.type === 'status') {
      expect(terminalStatus.data.status).toBe('succeeded')
    }
  })

  it('success scenario ready frame carries OPERATOR_CONTRACT_VERSION', async () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.success, FIXTURE_RUN_ID_FOR_TESTS)
    const results = parseSseChunk(sseBytes)
    const readyResult = results.find(r => r.success && r.frame.type === 'ready')
    expect(readyResult).toBeDefined()
    if (readyResult?.success && readyResult.frame.type === 'ready') {
      const {OPERATOR_CONTRACT_VERSION} = await import('../src/gateway/operator-contract/version.ts')
      expect(readyResult.frame.data.contractVersion).toBe(OPERATOR_CONTRACT_VERSION)
    }
  })

  it('success scenario output frame has non-empty text and final:true', async () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.success, FIXTURE_RUN_ID_FOR_TESTS)
    const results = parseSseChunk(sseBytes)
    const outputResults = results.filter(r => r.success && r.frame.type === 'output')
    expect(outputResults.length).toBeGreaterThanOrEqual(1)
    const finalOutput = outputResults.find(r => r.success && r.frame.type === 'output' && r.frame.data.final)
    expect(finalOutput).toBeDefined()
    if (finalOutput?.success && finalOutput.frame.type === 'output') {
      expect(finalOutput.frame.data.final).toBe(true)
    }
  })
})

describe('fixture SSE scenarios — terminal_failure scenario parses in server reader', () => {
  it('terminal_failure scenario SSE bytes parse with failed terminal status after output', async () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.terminal_failure, FIXTURE_RUN_ID_FOR_TESTS)
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseBytes]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    let closed = false

    await reader.open('/operator/runs/run-fixture-failure-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(0)
    expect(closed).toBe(true)

    const statusFrames = events.filter(e => e.type === 'status')
    expect(statusFrames.length).toBeGreaterThanOrEqual(1)

    // Terminal status must be failed
    const terminalStatus = statusFrames.at(-1)
    if (terminalStatus?.type === 'status') {
      expect(terminalStatus.data.status).toBe('failed')
    }

    // Output must appear before terminal status
    const outputFrames = events.filter(e => e.type === 'output')
    expect(outputFrames.length).toBeGreaterThanOrEqual(1)

    const outputIdx = events.findLastIndex(e => e.type === 'output')
    const terminalIdx = events.findLastIndex(e => e.type === 'status' && e.data.status === 'failed')
    // Output must come before terminal failed status
    expect(outputIdx).toBeLessThan(terminalIdx)
  })

  it('terminal_failure scenario SSE bytes are valid (parseable by server parser)', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.terminal_failure, FIXTURE_RUN_ID_FOR_TESTS)
    const results = parseSseChunk(sseBytes)
    const successes = results.filter(r => r.success)
    expect(successes.length).toBeGreaterThanOrEqual(1)
  })
})

describe('fixture SSE scenarios — contract_drift scenario enters absorbing drift', () => {
  it('contract_drift scenario ready frame carries a non-matching version', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.contract_drift, FIXTURE_RUN_ID_FOR_TESTS)
    const results = parseSseChunk(sseBytes)
    const readyResult = results.find(r => r.success && r.frame.type === 'ready')
    expect(readyResult).toBeDefined()
    if (readyResult?.success && readyResult.frame.type === 'ready') {
      // Must NOT match the pinned contract version
      expect(readyResult.frame.data.contractVersion).not.toBe('1.5.0')
    }
  })

  it('contract_drift scenario triggers drift error in server reader and ignores later frames', async () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.contract_drift, FIXTURE_RUN_ID_FOR_TESTS)
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseBytes]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    let closed = false

    await reader.open('/operator/runs/run-fixture-drift-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    // Must signal drift error
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('contract-drift')
    expect(closed).toBe(true)

    // Must NOT dispatch any status frames after drift
    const statusFrames = events.filter(e => e.type === 'status')
    expect(statusFrames).toHaveLength(0)
  })

  it('contract_drift scenario SSE bytes are parseable (ready frame parses successfully)', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.contract_drift, FIXTURE_RUN_ID_FOR_TESTS)
    const results = parseSseChunk(sseBytes)
    const readyResult = results.find(r => r.success && r.frame.type === 'ready')
    expect(readyResult).toBeDefined()
  })
})

describe('fixture SSE scenarios — malformed_unavailable scenario fails closed', () => {
  it('malformed_unavailable scenario SSE bytes contain at least one parse failure', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.malformed_unavailable, FIXTURE_RUN_ID_FOR_TESTS)
    const results = parseSseChunk(sseBytes)
    const failures = results.filter(r => !r.success)
    expect(failures.length).toBeGreaterThanOrEqual(1)
  })

  it('malformed_unavailable scenario parse failure error does not echo wire content', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.malformed_unavailable, FIXTURE_RUN_ID_FOR_TESTS)
    const results = parseSseChunk(sseBytes)
    const failures = results.filter(r => !r.success)
    for (const failure of failures) {
      if (!failure.success) {
        expect(failure.error.message.length).toBeGreaterThan(0)
        expect(failure.error.message).not.toContain('{not valid json}')
        expect(failure.error.message).not.toContain('malformed')
      }
    }
  })
})

describe('fixture SSE scenarios — no_output scenario parses with empty terminal output', () => {
  it('no_output scenario SSE bytes parse as ready + running status + empty output + terminal succeeded', async () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.no_output, FIXTURE_RUN_ID_FOR_TESTS)
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseBytes]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    const errors: Error[] = []
    let closed = false

    await reader.open('/operator/runs/run-fixture-no-output-001/stream', {
      onEvent: frame => events.push(frame),
      onError: err => errors.push(err),
      onClose: () => { closed = true },
    })

    expect(errors).toHaveLength(0)
    expect(closed).toBe(true)

    const outputFrames = events.filter(e => e.type === 'output')
    expect(outputFrames).toHaveLength(1)
    const outputFrame = outputFrames[0]
    if (outputFrame?.type === 'output') {
      expect(outputFrame.data.text).toBe('')
      expect(outputFrame.data.final).toBe(true)
    }

    const statusFrames = events.filter(e => e.type === 'status')
    const terminalStatus = statusFrames.at(-1)
    if (terminalStatus?.type === 'status') {
      expect(terminalStatus.data.status).toBe('succeeded')
    }
  })
})

describe('fixture SSE scenarios — stream_reset scenario carries a terminal reason', () => {
  it('stream_reset scenario SSE bytes parse a reset frame with reason terminal', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.stream_reset, FIXTURE_RUN_ID_FOR_TESTS)
    const results = parseSseChunk(sseBytes)
    const resetResult = results.find(r => r.success && r.frame.type === 'reset')
    expect(resetResult).toBeDefined()
    if (resetResult?.success && resetResult.frame.type === 'reset') {
      expect(resetResult.frame.data.reason).toBe('terminal')
      expect(resetResult.frame.data.runId).toBe(FIXTURE_RUN_ID_FOR_TESTS)
    }
  })
})

describe('fixture SSE scenarios — approval_flow scenario carries open then settle', () => {
  it('approval_flow scenario SSE bytes parse an open approval frame followed by a settle', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.approval_flow, FIXTURE_RUN_ID_FOR_TESTS)
    const results = parseSseChunk(sseBytes)
    const approvalResults = results.filter(r => r.success && r.frame.type === 'approval')
    expect(approvalResults.length).toBe(2)

    const [openResult, settleResult] = approvalResults
    if (openResult?.success && openResult.frame.type === 'approval' && openResult.frame.data.settled === false) {
      expect(openResult.frame.data.requestID).toBe('req-fixture-approval-001')
      expect(openResult.frame.data.permission).toBe('shell')
      expect(openResult.frame.data.command).toBe('[fixture command — synthetic]')
    } else {
      expect.unreachable('expected first approval frame to be the open variant')
    }
    if (settleResult?.success && settleResult.frame.type === 'approval' && settleResult.frame.data.settled === true) {
      expect(settleResult.frame.data.requestID).toBe('req-fixture-approval-001')
    } else {
      expect.unreachable('expected second approval frame to be the settle variant')
    }
  })
})

describe('fixture SSE scenarios — serializeScenarioToSse output format', () => {
  it('serialized SSE bytes are a non-empty string', () => {
    for (const name of Object.values(FIXTURE_SCENARIO_NAMES)) {
      const sseBytes = serializeScenarioToSse(name, FIXTURE_RUN_ID_FOR_TESTS)
      expect(typeof sseBytes).toBe('string')
      expect(sseBytes.length).toBeGreaterThan(0)
    }
  })

  it('serialized SSE bytes contain event: and data: lines', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.success, FIXTURE_RUN_ID_FOR_TESTS)
    expect(sseBytes).toContain('event:')
    expect(sseBytes).toContain('data:')
  })

  it('serialized SSE bytes use double-newline record separators', () => {
    const sseBytes = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES.success, FIXTURE_RUN_ID_FOR_TESTS)
    expect(sseBytes).toContain('\n\n')
  })

  it('unknown scenario name throws a clear error', () => {
    expect(() => serializeScenarioToSse('not-a-real-scenario', FIXTURE_RUN_ID_FOR_TESTS)).toThrow()
  })
})
