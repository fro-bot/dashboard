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
import {createOperatorSseReader, parseSseChunk} from '../src/gateway/operator-sse-reader.ts'

// ---------------------------------------------------------------------------
// Helpers: build a fake ReadableStream from text chunks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Recording fake fetch
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Capture logger
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pure parser: parseSseChunk
// ---------------------------------------------------------------------------

describe('parseSseChunk — pure parser', () => {
  it('parses a ready frame', () => {
    const text = 'event: ready\ndata: {"contractVersion":"1.1.0"}\n\n'
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    const frame = results[0]
    expect(frame?.success).toBe(true)
    if (frame?.success) {
      expect(frame.frame.type).toBe('ready')
      if (frame.frame.type === 'ready') {
        expect(frame.frame.data.contractVersion).toBe('1.1.0')
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
    const readyPayload = {contractVersion: '1.1.0'}
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
    const readyPayload = {contractVersion: '1.1.0'}
    const text = `event: ready\ndata: ${JSON.stringify(readyPayload)}\n\n: heartbeat\n\n`
    const results = parseSseChunk(text)
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(true)
    if (results[0]?.success) {
      expect(results[0].frame.type).toBe('ready')
    }
  })

  it('handles a frame with no event line (data-only) as a failure', () => {
    const text = 'data: {"contractVersion":"1.1.0"}\n\n'
    const results = parseSseChunk(text)
    // No event name → unknown event → typed failure
    expect(results).toHaveLength(1)
    expect(results[0]?.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// open() — 200 happy path
// ---------------------------------------------------------------------------

describe('createOperatorSseReader — 200 happy path', () => {
  it('dispatches ready then status frames in order', async () => {
    const readyPayload = {contractVersion: '1.1.0'}
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
    const sseText = 'event: ready\ndata: {"contractVersion":"1.1.0"}\n\n'
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
    const sseText = `event: ready\ndata: {"contractVersion":"1.1.0"}\n\nevent: reset\ndata: ${JSON.stringify(resetPayload)}\n\n`
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
    const sseText = 'event: ready\ndata: {"contractVersion":"1.1.0"}\n\n: heartbeat\n\n'
    const {fetchImpl} = makeFakeFetch(makeResponse(200, [sseText]))
    const reader = createOperatorSseReader({fetchImpl})

    const events: RunStreamFrame[] = []
    await reader.open('/operator/runs/run-001/stream', {
      onEvent: frame => events.push(frame),
      onError: () => {},
      onClose: () => {},
    })

    // Only the ready frame; heartbeat produces no event
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('ready')
  })
})

// ---------------------------------------------------------------------------
// Contract-version gate
// ---------------------------------------------------------------------------

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
    const sseText = `event: ready\ndata: {"contractVersion":"1.1.0"}\n\nevent: status\ndata: ${JSON.stringify(statusPayload)}\n\n`
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
    // Version 1.0.0 does not match pinned 1.1.0
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

    // Must signal drift error
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('contract-drift')
    // Must NOT dispatch any status frames after drift
    const statusFrames = events.filter(e => e.type === 'status')
    expect(statusFrames).toHaveLength(0)
    // Must call onClose
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
    // Must not echo the version value from the wire
    expect(errors[0]?.message).not.toContain('9.9.9')
  })
})

// ---------------------------------------------------------------------------
// HTTP error status codes
// ---------------------------------------------------------------------------

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
    // Body contains a cause string — must NOT appear in the error
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

// ---------------------------------------------------------------------------
// Network throw / abort
// ---------------------------------------------------------------------------

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
    // Must not echo the raw error message (no-oracle)
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

// ---------------------------------------------------------------------------
// Fetch args: credentials:'include', correct path, no repo param
// ---------------------------------------------------------------------------

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
    // Must not append any query params
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

// ---------------------------------------------------------------------------
// Logger: route template only, no runId in logs
// ---------------------------------------------------------------------------

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

    // No log message should contain the actual runId
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

    // At least one log message should reference the route template
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

// ---------------------------------------------------------------------------
// Partial-chunk reassembly
// ---------------------------------------------------------------------------

describe('createOperatorSseReader — partial-chunk reassembly', () => {
  it('reassembles a frame split across two chunks', async () => {
    const fullFrame = 'event: ready\ndata: {"contractVersion":"1.1.0"}\n\n'
    // Split in the middle of the data line
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
    const fullFrame = 'event: ready\ndata: {"contractVersion":"1.1.0"}\n\n'
    // Split just before the final \n\n
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
    const frame1 = 'event: ready\ndata: {"contractVersion":"1.1.0"}\n\n'
    const frame2 = `event: status\ndata: ${JSON.stringify(statusPayload)}\n\n`
    // Deliver as 3 chunks with arbitrary split points
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

// ---------------------------------------------------------------------------
// EventStreamHandle compatibility
// ---------------------------------------------------------------------------

describe('createOperatorSseReader — EventStreamHandle shape', () => {
  it('the reader object has an open method', () => {
    const reader = createOperatorSseReader({fetchImpl: async () => makeEmptyResponse(404)})
    expect(typeof reader.open).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// vi.fn() spy: no extra calls
// ---------------------------------------------------------------------------

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
    const sseText = 'event: ready\ndata: {"contractVersion":"1.1.0"}\n\n'
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
