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
 */

import type {Logger} from '../logger.ts'
import type {ResetReason, RunStreamFrame} from './operator-contract/sse-frames.ts'
import {OPERATOR_CONTRACT_VERSION} from './operator-contract/version.ts'

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
    // Validate required OperatorRunStatus fields
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
 */
export function parseSseChunk(text: string): SseParseResult[] {
  const records = text.split('\n\n')
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
 * 1. Fetches the given path with credentials:'include' and Accept: text/event-stream.
 * 2. Branches on HTTP status: 200 → stream; 404 → not-found; 429 → rate-limited;
 *    other → network-style error. All non-200 paths call onError then onClose.
 * 3. On 200, reads the body as a ReadableStream, feeds an incremental SSE parser,
 *    and dispatches each RunStreamFrame via onEvent.
 * 4. Enforces the contract-version gate: the first frame must be 'ready' with
 *    contractVersion === OPERATOR_CONTRACT_VERSION. A mismatch triggers a
 *    fail-closed drift error (onError) and stops all further frame dispatch.
 * 5. On stream end, calls onClose.
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

    // Fetch the SSE stream
    let response: Response
    try {
      response = await fetchImpl(path, {
        credentials: 'include',
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
          buffer += decoder.decode(value, {stream: true})
        }

        // Extract complete SSE records (terminated by \n\n)
        // We process all complete records in the buffer, leaving any partial
        // record in the buffer for the next chunk.
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const record = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)

          const results = parseSseChunk(`${record}\n\n`)
          for (const result of results) {
            if (!result.success) {
              // Parse failure — log and skip (fail closed for this frame)
              logger?.error('sse-reader: frame parse failure', {route: ROUTE_TEMPLATE})
              continue
            }

            const frame = result.frame

            // Contract-version gate
            if (!contractVerified) {
              if (frame.type !== 'ready') {
                // First frame must be 'ready' — fail closed
                logger?.error('sse-reader: first frame is not ready', {route: ROUTE_TEMPLATE})
                drifted = true
                onError(new Error('contract-drift: first frame was not a ready frame'))
                onClose()
                return
              }
              if (frame.data.contractVersion !== OPERATOR_CONTRACT_VERSION) {
                // Version mismatch — fail closed
                logger?.error('sse-reader: contract version mismatch', {route: ROUTE_TEMPLATE})
                drifted = true
                onError(new Error('contract-drift: server contract version does not match client'))
                onClose()
                return
              }
              contractVerified = true
            }

            if (drifted) continue

            onEvent(frame)
          }

          boundary = buffer.indexOf('\n\n')
        }
      }

      // Flush any remaining buffer content (handles streams that don't end with \n\n)
      if (buffer.trim() !== '') {
        const results = parseSseChunk(`${buffer}\n\n`)
        for (const result of results) {
          if (!result.success) {
            logger?.error('sse-reader: frame parse failure in flush', {route: ROUTE_TEMPLATE})
            continue
          }
          if (!drifted) {
            onEvent(result.frame)
          }
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
