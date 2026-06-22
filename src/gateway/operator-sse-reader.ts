/**
 * Fetch-based SSE reader for the operator run stream.
 *
 * Unlike native EventSource, this reader sees the HTTP status and body,
 * parses named SSE frames, enforces the contract-version gate, and fails
 * closed on every error path.
 *
 * Security invariants:
 * - Contract-version gate: the first frame must be 'ready' with a matching
 *   contractVersion. A mismatch triggers a fail-closed drift error and stops
 *   all further frame dispatch.
 * - No runId or dynamic path segment is ever logged — only the route template.
 * - No response body text is included in errors (no-oracle).
 * - 404 → typed not-found error; body is never parsed for cause.
 * - 429 → typed rate-limited error.
 * - Network throw / abort → network-style error, fail closed.
 * - Fetch uses credentials:'include' and Accept: text/event-stream.
 * - redirect:'error' prevents auth-redirect loops from being parsed as streams.
 * - Content-Type must be text/event-stream on 200; otherwise fail closed.
 * - Path must be a relative /operator/runs/ path; absolute URLs rejected.
 * - Buffer is capped at MAX_SSE_BUFFER_BYTES; overflow → fail closed.
 */

import type {Logger} from '../logger.ts'
import type {OperatorApprovalFrame} from './operator-contract/approval-frame.ts'
import type {ResetReason, RunStreamFrame} from './operator-contract/sse-frames.ts'
import {OPERATOR_CONTRACT_VERSION} from './operator-contract/version.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on the incremental SSE buffer. Overflow → fail closed. */
export const MAX_SSE_BUFFER_BYTES = 1_000_000

// ---------------------------------------------------------------------------
// Allowlists for value-gated fields
// ---------------------------------------------------------------------------

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'blocked',
  'running',
  'waiting_for_approval',
  'succeeded',
  'failed',
  'cancelled',
])

const VALID_PHASES: ReadonlySet<string> = new Set([
  'PENDING',
  'ACKNOWLEDGED',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
])

const VALID_SURFACES: ReadonlySet<string> = new Set(['github', 'discord', 'web'])

// ---------------------------------------------------------------------------
// Parse result types
// ---------------------------------------------------------------------------

export type SseParseResult =
  | {readonly success: true; readonly frame: RunStreamFrame}
  | {readonly success: false; readonly error: Error}

// ---------------------------------------------------------------------------
// Pure SSE frame parser
// ---------------------------------------------------------------------------

/**
 * The set of valid ResetReason values, used for membership checks.
 * Defined as a plain object (not an enum) per project conventions.
 */
const VALID_RESET_REASONS: ReadonlySet<string> = new Set<ResetReason>([
  'no-snapshot',
  'terminal',
  'shutdown',
  'max-duration',
  'writer-error',
  'overflow',
])

function isValidResetReason(value: unknown): value is ResetReason {
  return typeof value === 'string' && VALID_RESET_REASONS.has(value)
}

/**
 * Normalize CRLF and lone CR line endings to LF in an SSE buffer chunk.
 * Must be applied before searching for record boundaries.
 */
function normalizeCrlf(text: string): string {
  // Replace \r\n first (order matters — avoids double-replacing the \r)
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

/**
 * Parse a single SSE record (the text between two blank lines) into a
 * typed RunStreamFrame or a typed parse failure.
 *
 * NO-ORACLE: error messages are fixed strings. They never echo, interpolate,
 * or stringify any part of the input.
 */
function parseSseRecord(record: string): SseParseResult | null {
  const lines = record.split('\n')
  let eventName: string | undefined
  let dataLine: string | undefined

  for (const line of lines) {
    if (line.startsWith(':')) {
      // SSE comment (e.g. ": heartbeat") — skip
      continue
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLine = line.slice('data:'.length).trim()
    }
  }

  // A record with only comment lines produces no frame
  if (eventName === undefined && dataLine === undefined) {
    return null
  }

  // A record with no event name is an unknown event
  if (eventName === undefined) {
    return {success: false, error: new Error('sse record missing event name')}
  }

  // Parse the data field as JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(dataLine ?? 'null')
  } catch {
    return {success: false, error: new Error('sse record data is not valid JSON')}
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {success: false, error: new Error('sse record data is not a JSON object')}
  }

  const candidate = parsed as Record<string, unknown>

  if (eventName === 'ready') {
    if (typeof candidate.contractVersion !== 'string') {
      return {success: false, error: new Error('ready frame missing contractVersion string')}
    }
    return {
      success: true,
      frame: {type: 'ready', data: {contractVersion: candidate.contractVersion}},
    }
  }

  if (eventName === 'status') {
    // Validate required OperatorRunStatus fields — type check first
    if (
      typeof candidate.runId !== 'string' ||
      typeof candidate.entityRef !== 'string' ||
      typeof candidate.surface !== 'string' ||
      typeof candidate.phase !== 'string' ||
      typeof candidate.status !== 'string' ||
      typeof candidate.startedAt !== 'string' ||
      typeof candidate.stale !== 'boolean'
    ) {
      return {success: false, error: new Error('status frame missing required fields')}
    }
    // Allowlist-gate the enumerated fields — fail closed on out-of-set values
    if (!VALID_STATUSES.has(candidate.status)) {
      return {success: false, error: new Error('status frame status value not in allowlist')}
    }
    if (!VALID_PHASES.has(candidate.phase)) {
      return {success: false, error: new Error('status frame phase value not in allowlist')}
    }
    if (!VALID_SURFACES.has(candidate.surface)) {
      return {success: false, error: new Error('status frame surface value not in allowlist')}
    }
    return {
      success: true,
      frame: {
        type: 'status',
        data: {
          runId: candidate.runId,
          entityRef: candidate.entityRef,
          surface: candidate.surface as 'github' | 'discord' | 'web',
          phase: candidate.phase as 'PENDING' | 'ACKNOWLEDGED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED',
          status: candidate.status as 'queued' | 'blocked' | 'running' | 'waiting_for_approval' | 'succeeded' | 'failed' | 'cancelled',
          startedAt: candidate.startedAt,
          stale: candidate.stale,
        },
      },
    }
  }

  if (eventName === 'reset') {
    if (typeof candidate.runId !== 'string') {
      return {success: false, error: new Error('reset frame missing runId string')}
    }
    if (!isValidResetReason(candidate.reason)) {
      return {success: false, error: new Error('reset frame has unrecognized reason value')}
    }
    return {
      success: true,
      frame: {
        type: 'reset',
        data: {runId: candidate.runId, reason: candidate.reason},
      },
    }
  }

  if (eventName === 'output') {
    // Type-check the required fields; reject otherwise. droppedCount is optional
    // and must be a number when present. Never echo wire content in the error.
    if (
      typeof candidate.runId !== 'string' ||
      typeof candidate.text !== 'string' ||
      typeof candidate.final !== 'boolean' ||
      typeof candidate.seq !== 'number' ||
      !Number.isSafeInteger(candidate.seq) ||
      candidate.seq < 0
    ) {
      return {success: false, error: new Error('output frame missing required fields')}
    }
    if (
      candidate.droppedCount !== undefined &&
      (typeof candidate.droppedCount !== 'number' ||
        !Number.isSafeInteger(candidate.droppedCount) ||
        candidate.droppedCount < 0)
    ) {
      return {success: false, error: new Error('output frame droppedCount is not a non-negative integer')}
    }
    const data =
      candidate.droppedCount === undefined
        ? {runId: candidate.runId, text: candidate.text, final: candidate.final, seq: candidate.seq}
        : {
            runId: candidate.runId,
            text: candidate.text,
            final: candidate.final,
            seq: candidate.seq,
            droppedCount: candidate.droppedCount,
          }
    return {success: true, frame: {type: 'output', data}}
  }

  if (eventName === 'approval') {
    // Validate runId and requestID — required on both variants
    if (typeof candidate.runId !== 'string' || typeof candidate.requestID !== 'string') {
      return {success: false, error: new Error('approval frame missing required fields')}
    }
    // settled must be a boolean — reject anything else (string, number, null, etc.)
    if (typeof candidate.settled !== 'boolean') {
      return {success: false, error: new Error('approval frame has invalid settled discriminator')}
    }
    if (candidate.settled === false) {
      // Open variant: permission is required; command and filepath are optional strings
      if (typeof candidate.permission !== 'string') {
        return {success: false, error: new Error('approval frame missing required fields')}
      }
      if (candidate.command !== undefined && typeof candidate.command !== 'string') {
        return {success: false, error: new Error('approval frame missing required fields')}
      }
      if (candidate.filepath !== undefined && typeof candidate.filepath !== 'string') {
        return {success: false, error: new Error('approval frame missing required fields')}
      }
      const data: OperatorApprovalFrame = {
        runId: candidate.runId,
        requestID: candidate.requestID,
        permission: candidate.permission,
        settled: false,
        ...(candidate.command === undefined ? {} : {command: candidate.command}),
        ...(candidate.filepath === undefined ? {} : {filepath: candidate.filepath}),
      }
      return {success: true, frame: {type: 'approval', data}}
    } else {
      // Settle variant: only runId/requestID/settled required
      const data: OperatorApprovalFrame = {
        runId: candidate.runId,
        requestID: candidate.requestID,
        settled: true,
      }
      return {success: true, frame: {type: 'approval', data}}
    }
  }

  // Unknown event name — fixed error string, never echoes the name
  return {success: false, error: new Error('sse record has unrecognized event name')}
}

/**
 * Parse accumulated SSE text into an array of parse results.
 *
 * Splits on blank lines (\n\n), parses each record, and returns one result
 * per non-comment record. Comment-only records (heartbeats) produce no entry.
 *
 * Exported as a pure function so tests can drive it directly with raw bytes.
 * Input is normalized for CRLF before splitting.
 */
export function parseSseChunk(text: string): SseParseResult[] {
  const normalized = normalizeCrlf(text)
  const records = normalized.split('\n\n')
  const results: SseParseResult[] = []

  for (const record of records) {
    const trimmed = record.trim()
    if (trimmed === '') continue

    const result = parseSseRecord(trimmed)
    if (result !== null) {
      results.push(result)
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Reader options and interface
// ---------------------------------------------------------------------------

export interface SseReaderOpenOptions {
  readonly onEvent: (frame: RunStreamFrame) => void
  readonly onError: (error: Error) => void
  readonly onClose: () => void
  readonly signal?: AbortSignal
}

export interface OperatorSseReader {
  readonly open: (path: string, opts: SseReaderOpenOptions) => Promise<void>
}

export interface OperatorSseReaderOptions {
  /**
   * Injectable fetch implementation. Defaults to the global fetch.
   * Inject a fake in tests to avoid network calls.
   */
  readonly fetchImpl?: (path: string, init?: RequestInit) => Promise<Response>
  /**
   * Optional logger. Receives only coarse metadata — never sensitive values.
   * The route template '/operator/runs/:runId/stream' is logged; the dynamic
   * runId is never logged.
   */
  readonly logger?: Logger
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fetch-based SSE reader for the operator run stream.
 *
 * The returned reader's open() method:
 * 1. Validates the path is a relative /operator/runs/ path (no absolute URLs).
 * 2. Fetches the given path with credentials:'include', redirect:'error', and
 *    Accept: text/event-stream.
 * 3. Branches on HTTP status: 200 → stream; 404 → not-found; 429 → rate-limited;
 *    other → network-style error. All non-200 paths call onError then onClose.
 * 4. On 200, verifies Content-Type is text/event-stream; otherwise fail closed.
 * 5. Reads the body as a ReadableStream, feeds an incremental SSE parser with
 *    CRLF normalization and a hard buffer cap (MAX_SSE_BUFFER_BYTES).
 * 6. Enforces the contract-version gate via handleFrame(): the first frame must
 *    be 'ready' with contractVersion === OPERATOR_CONTRACT_VERSION. A mismatch
 *    triggers a fail-closed drift error and stops all further frame dispatch.
 *    Both the streaming path and the EOF flush path go through handleFrame().
 * 7. On stream end, calls onClose.
 *
 * Security: never logs the dynamic runId or path — only the route template.
 * Never includes response body text in errors (no-oracle).
 */
export function createOperatorSseReader(options: OperatorSseReaderOptions = {}): OperatorSseReader {
  const {fetchImpl = fetch, logger} = options

  // Route template used for logging — never the dynamic path
  const ROUTE_TEMPLATE = '/operator/runs/:runId/stream'

  async function open(path: string, opts: SseReaderOpenOptions): Promise<void> {
    const {onEvent, onError, onClose, signal} = opts

    // Validate path is a relative /operator/runs/ path — no absolute URLs, no //
    if (
      !path.startsWith('/operator/runs/') ||
      path.startsWith('//') ||
      /^[a-z][a-z\d+\-.]*:/i.test(path)
    ) {
      logger?.error('sse-reader: rejected invalid path', {route: ROUTE_TEMPLATE})
      onError(new Error('network error: invalid stream path'))
      onClose()
      return
    }

    // Fetch the SSE stream
    let response: Response
    try {
      response = await fetchImpl(path, {
        credentials: 'include',
        redirect: 'error', // prevent auth-redirect loops
        signal,
        headers: {accept: 'text/event-stream'},
      })
    } catch {
      // Network error or abort — fail closed, no-oracle (never echo raw error)
      logger?.error('sse-reader: fetch failed', {route: ROUTE_TEMPLATE})
      onError(new Error('network error opening stream'))
      onClose()
      return
    }

    // Branch on HTTP status
    if (response.status === 404) {
      logger?.error('sse-reader: stream not found', {route: ROUTE_TEMPLATE, status: 404})
      onError(new Error('not-found: stream endpoint returned 404'))
      onClose()
      return
    }

    if (response.status === 429) {
      logger?.error('sse-reader: rate limited', {route: ROUTE_TEMPLATE, status: 429})
      onError(new Error('rate-limited: stream endpoint returned 429'))
      onClose()
      return
    }

    if (response.status !== 200) {
      logger?.error('sse-reader: unexpected status', {route: ROUTE_TEMPLATE, status: response.status})
      onError(new Error('network error: unexpected stream status'))
      onClose()
      return
    }

    // Require Content-Type text/event-stream on 200
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.startsWith('text/event-stream')) {
      logger?.error('sse-reader: unexpected content-type', {route: ROUTE_TEMPLATE})
      onError(new Error('network error: unexpected content-type'))
      onClose()
      return
    }

    // 200 — read the body as a ReadableStream
    if (response.body === null) {
      logger?.error('sse-reader: response body is null', {route: ROUTE_TEMPLATE})
      onError(new Error('network error: stream response has no body'))
      onClose()
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let contractVerified = false
    let drifted = false

    /**
     * Unified frame handler — enforces the contract-version gate for BOTH the
     * streaming path and the EOF flush path. Returns false if the reader should
     * stop (drift detected).
     */
    function handleFrame(result: SseParseResult): boolean {
      if (!result.success) {
        logger?.error('sse-reader: frame parse failure', {route: ROUTE_TEMPLATE})
        return true // continue reading
      }

      const frame = result.frame

      // Contract-version gate
      if (!contractVerified) {
        if (frame.type !== 'ready') {
          logger?.error('sse-reader: first frame is not ready', {route: ROUTE_TEMPLATE})
          drifted = true
          onError(new Error('contract-drift: first frame was not a ready frame'))
          onClose()
          return false // stop
        }
        if (frame.data.contractVersion !== OPERATOR_CONTRACT_VERSION) {
          logger?.error('sse-reader: contract version mismatch', {route: ROUTE_TEMPLATE})
          drifted = true
          onError(new Error('contract-drift: server contract version does not match client'))
          onClose()
          return false // stop
        }
        contractVerified = true
      }

      if (drifted) return true // absorb

      onEvent(frame)
      return true // continue
    }

    try {
      const reader = response.body.getReader()

      while (true) {
        let done: boolean
        let value: Uint8Array<ArrayBuffer> | undefined
        try {
          const result = await reader.read()
          done = result.done
          value = result.value as Uint8Array<ArrayBuffer> | undefined
        } catch {
          // Stream read error — fail closed
          logger?.error('sse-reader: stream read error', {route: ROUTE_TEMPLATE})
          onError(new Error('network error reading stream'))
          onClose()
          return
        }

        if (done) break

        if (value !== undefined) {
          // Normalize CRLF on each appended chunk before boundary search
          buffer += normalizeCrlf(decoder.decode(value, {stream: true}))
        }

        // Hard buffer cap — fail closed if exceeded without a boundary
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          logger?.error('sse-reader: buffer overflow', {route: ROUTE_TEMPLATE})
          onError(new Error('network error: stream buffer overflow'))
          onClose()
          return
        }

        // Extract complete SSE records (terminated by \n\n)
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const record = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)

          const results = parseSseChunk(`${record}\n\n`)
          for (const result of results) {
            const shouldContinue = handleFrame(result)
            if (!shouldContinue) return
          }

          boundary = buffer.indexOf('\n\n')
        }
      }

      // Flush any remaining buffer content through the unified handleFrame path
      // (handles streams that don't end with \n\n)
      if (buffer.trim() !== '') {
        const results = parseSseChunk(`${buffer}\n\n`)
        for (const result of results) {
          const shouldContinue = handleFrame(result)
          if (!shouldContinue) return
        }
      }
    } catch {
      logger?.error('sse-reader: unexpected stream error', {route: ROUTE_TEMPLATE})
      onError(new Error('network error: unexpected stream failure'))
      onClose()
      return
    }

    onClose()
  }

  return {open}
}
