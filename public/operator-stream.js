/**
 * Operator run stream client — pure core + thin DOM shell.
 *
 * This file is valid plain ES module that runs in a browser as-is (no TS syntax,
 * no imports of Node/TS modules). It is also directly importable by Vitest (Node 24
 * ESM) because it uses only standard JS. DOM-touching code lives exclusively inside
 * initOperatorStream() and is never executed at module top-level.
 *
 * Architecture: pure exports (parseSseFrame, nextStreamState, toSafeRunView,
 * constants) are tested by test/operator-stream-core.test.ts without a browser.
 * The DOM shell (initOperatorStream) is the only part that touches document.*.
 *
 * Security invariants:
 * - Never console.log/console.error/console.warn frame data, run IDs, repo names,
 *   stream URLs, or status payloads.
 * - Render only phase/status/timestamps — never entityRef/surface/output/tool/path.
 * - All 404s collapse to one not-found state; no cause inference from body or timing.
 * - Read-only: GET stream only; no POST/PUT/DELETE, no telemetry endpoint.
 * - Same-origin: credentials:'include', no URL rewriting.
 * - redirect:'error' prevents auth-redirect loops from being parsed as streams.
 * - Content-Type must be text/event-stream on 200; otherwise fail closed.
 * - Buffer is capped at MAX_SSE_BUFFER_BYTES; overflow → abort + failed state.
 * - status/phase/surface are allowlist-gated; out-of-set values → parse failure.
 * - Status labels are rendered from a local map, never from the raw wire string.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Contract version this client expects on the ready frame. */
export const PINNED_CONTRACT_VERSION = '1.2.0'

/** Base delay in milliseconds for exponential backoff. */
export const RETRY_BASE_MS = 1000

/** Exponential backoff multiplier. */
export const RETRY_FACTOR = 2

/** Maximum number of reconnect attempts before transitioning to failed. */
export const RETRY_MAX_COUNT = 5

/** Hard cap on the incremental SSE buffer in bytes. Overflow → abort + failed. */
export const MAX_SSE_BUFFER_BYTES = 1_000_000

/**
 * Bounded timeout in milliseconds for receiving the first SSE frame after opening
 * a stream. If no frame arrives within this window, the connection transitions to
 * 'submitted-unobservable' — the run was accepted but is not yet streaming (e.g.
 * queued behind the concurrency cap or still starting). A manual retry re-opens.
 */
export const FIRST_FRAME_TIMEOUT_MS = 15_000

/** Terminal OperatorWebStatus values — a run in one of these states will not progress. */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

/** Valid ResetReason values from the gateway SSE surface. */
const VALID_RESET_REASONS = new Set([
  'no-snapshot',
  'terminal',
  'shutdown',
  'max-duration',
  'writer-error',
  'overflow',
])

/** Allowlisted status values — out-of-set values are parse failures. */
const VALID_STATUSES = new Set([
  'queued',
  'blocked',
  'running',
  'waiting_for_approval',
  'succeeded',
  'failed',
  'cancelled',
])

/** Allowlisted phase values — out-of-set values are parse failures. */
const VALID_PHASES = new Set([
  'PENDING',
  'ACKNOWLEDGED',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
])

/** Allowlisted surface values — out-of-set values are parse failures. */
const VALID_SURFACES = new Set(['github', 'discord', 'web'])

/**
 * Safe status label map — render labels from this map, never the raw wire string.
 * classList.add throws on whitespace; raw wire values like 'waiting_for_approval'
 * are safe for classList but must still go through this map for display text.
 */
const STATUS_LABELS = {
  queued: 'Queued',
  blocked: 'Blocked',
  running: 'Running',
  waiting_for_approval: 'Waiting for approval',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

// ---------------------------------------------------------------------------
// CRLF normalization
// ---------------------------------------------------------------------------

/**
 * Normalize CRLF and lone CR line endings to LF.
 * Must be applied before searching for record boundaries.
 */
function normalizeCrlf(text) {
  // Replace \r\n first (order matters — avoids double-replacing the \r)
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

// ---------------------------------------------------------------------------
// Pure SSE frame parser
// ---------------------------------------------------------------------------

/**
 * Parse a single SSE record (the text between two blank lines) into a typed
 * frame result or null (for comment-only records like heartbeats).
 *
 * Returns:
 *   null                          — comment-only record (heartbeat); no frame
 *   { success: true, frame }      — a valid named frame
 *   { success: false, error }     — parse failure; error is a fixed string (no-oracle)
 *
 * NO-ORACLE: error strings are fixed. They never echo, interpolate, or stringify
 * any part of the input.
 *
 * Input is normalized for CRLF before parsing.
 */
export function parseSseFrame(record) {
  const normalized = normalizeCrlf(record)
  const lines = normalized.split('\n')
  let eventName
  let dataLine

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

  // Comment-only record (heartbeat) — produce no frame
  if (eventName === undefined && dataLine === undefined) {
    return null
  }

  // Record has data but no event name
  if (eventName === undefined) {
    return {success: false, error: 'sse record missing event name'}
  }

  // Parse the data field as JSON
  let parsed
  try {
    parsed = JSON.parse(dataLine ?? 'null')
  } catch {
    return {success: false, error: 'sse record data is not valid JSON'}
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {success: false, error: 'sse record data is not a JSON object'}
  }

  if (eventName === 'ready') {
    if (typeof parsed.contractVersion !== 'string') {
      return {success: false, error: 'ready frame missing contractVersion string'}
    }
    return {
      success: true,
      frame: {type: 'ready', data: {contractVersion: parsed.contractVersion}},
    }
  }

  if (eventName === 'status') {
    if (
      typeof parsed.runId !== 'string' ||
      typeof parsed.entityRef !== 'string' ||
      typeof parsed.surface !== 'string' ||
      typeof parsed.phase !== 'string' ||
      typeof parsed.status !== 'string' ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.stale !== 'boolean'
    ) {
      return {success: false, error: 'status frame missing required fields'}
    }
    // F6: Allowlist-gate enumerated fields — fail closed on out-of-set values
    if (!VALID_STATUSES.has(parsed.status)) {
      return {success: false, error: 'status frame status value not in allowlist'}
    }
    if (!VALID_PHASES.has(parsed.phase)) {
      return {success: false, error: 'status frame phase value not in allowlist'}
    }
    if (!VALID_SURFACES.has(parsed.surface)) {
      return {success: false, error: 'status frame surface value not in allowlist'}
    }
    return {
      success: true,
      frame: {
        type: 'status',
        data: {
          runId: parsed.runId,
          entityRef: parsed.entityRef,
          surface: parsed.surface,
          phase: parsed.phase,
          status: parsed.status,
          startedAt: parsed.startedAt,
          stale: parsed.stale,
        },
      },
    }
  }

  if (eventName === 'reset') {
    if (typeof parsed.runId !== 'string') {
      return {success: false, error: 'reset frame missing runId string'}
    }
    if (typeof parsed.reason !== 'string' || !VALID_RESET_REASONS.has(parsed.reason)) {
      return {success: false, error: 'reset frame has unrecognized reason value'}
    }
    return {
      success: true,
      frame: {type: 'reset', data: {runId: parsed.runId, reason: parsed.reason}},
    }
  }

  // Unknown event name — fixed error string, never echoes the name
  return {success: false, error: 'sse record has unrecognized event name'}
}

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * Pure reducer: given the current stream state and an event, return the next state.
 *
 * State shape:
 *   connection: 'connecting' | 'live' | 'reconnecting' | 'drift' | 'not-found' |
 *               'backpressure' | 'failed' | 'closed'
 *   runs: Object.create(null) — null-prototype map keyed by runId (F13)
 *   retryCount: number
 *   shouldReconnect: boolean
 *
 * Events (discriminated by type):
 *   { type: 'ready', data: { contractVersion } }
 *   { type: 'status', data: OperatorRunStatus }
 *   { type: 'reset', data: { runId, reason } }
 *   { type: 'http-status', code: 404 | 429 }
 *   { type: 'network-error' }
 *   { type: 'stream-closed' }
 *   { type: 'unexpected-close' }
 *
 * Drift is absorbing: once in drift, ready/status do not move back to live.
 * A status before any ready is not rendered (F5b).
 */
export function nextStreamState(current, event) {
  switch (event.type) {
    case 'ready': {
      // F5b: drift is absorbing — a second ready does not escape drift
      if (current.connection === 'drift') {
        return current
      }
      if (event.data.contractVersion !== PINNED_CONTRACT_VERSION) {
        // Contract version mismatch — fail closed, clear all run state
        return {
          connection: 'drift',
          runs: Object.create(null),
          retryCount: current.retryCount,
          shouldReconnect: false,
        }
      }
      return {
        ...current,
        connection: 'live',
        shouldReconnect: false,
      }
    }

    case 'status': {
      // F5b: status before ready (connection !== 'live') is not rendered
      if (current.connection !== 'live') {
        return current
      }
      const {runId, status, phase, startedAt, stale} = event.data
      const isTerminal = TERMINAL_STATUSES.has(status)
      // F13: use null-prototype object to guard against __proto__ pollution
      const updatedRuns = Object.assign(Object.create(null), current.runs, {
        [runId]: {runId, status, phase, startedAt, stale, terminal: isTerminal},
      })
      // If all observed runs are terminal, close the stream
      const allTerminal =
        Object.keys(updatedRuns).length > 0 &&
        Object.values(updatedRuns).every(r => r.terminal)
      return {
        ...current,
        runs: updatedRuns,
        connection: allTerminal ? 'closed' : current.connection,
        shouldReconnect: allTerminal ? false : current.shouldReconnect,
      }
    }

    case 'reset': {
      const {reason} = event.data

      // F3: terminal reset reason → close (no reconnect)
      if (reason === 'terminal') {
        return {
          ...current,
          connection: 'closed',
          shouldReconnect: false,
        }
      }

      // max-duration: reconnect only if the run is still active
      if (reason === 'max-duration') {
        const runEntry = current.runs[event.data.runId]
        const runIsActive = runEntry !== undefined && !runEntry.terminal
        if (!runIsActive) {
          return {
            ...current,
            connection: 'closed',
            shouldReconnect: false,
          }
        }
      }

      // F3: increment retryCount on reset and cap at RETRY_MAX_COUNT
      if (current.retryCount >= RETRY_MAX_COUNT) {
        return {
          ...current,
          connection: 'failed',
          shouldReconnect: false,
        }
      }
      return {
        ...current,
        connection: 'reconnecting',
        retryCount: current.retryCount + 1,
        shouldReconnect: true,
      }
    }

    case 'http-status': {
      if (event.code === 404) {
        return {
          ...current,
          connection: 'not-found',
          shouldReconnect: false,
        }
      }
      if (event.code === 429) {
        return {
          ...current,
          connection: 'backpressure',
          shouldReconnect: false,
        }
      }
      return {
        ...current,
        connection: 'failed',
        shouldReconnect: false,
      }
    }

    case 'network-error': {
      // Guard terminal-ish display states: abort-rejection from close() must not reopen
      if (
        current.connection === 'closed' ||
        current.connection === 'submitted-unobservable'
      ) {
        return current
      }
      if (current.retryCount >= RETRY_MAX_COUNT) {
        return {
          ...current,
          connection: 'failed',
          shouldReconnect: false,
        }
      }
      return {
        ...current,
        connection: 'reconnecting',
        retryCount: current.retryCount + 1,
        shouldReconnect: true,
      }
    }

    case 'stream-closed': {
      return {
        ...current,
        connection: 'closed',
        shouldReconnect: false,
      }
    }

    case 'unexpected-close': {
      // Guard terminal-ish display states: abort-rejection from close() must not reopen
      if (
        current.connection === 'closed' ||
        current.connection === 'submitted-unobservable'
      ) {
        return current
      }
      if (current.retryCount >= RETRY_MAX_COUNT) {
        return {
          ...current,
          connection: 'failed',
          shouldReconnect: false,
        }
      }
      return {
        ...current,
        connection: 'reconnecting',
        retryCount: current.retryCount + 1,
        shouldReconnect: true,
      }
    }

    case 'buffer-overflow': {
      // A stream that exceeds the buffer cap is hostile or broken — fail closed
      // terminally with no reconnect, regardless of retry budget.
      return {
        ...current,
        connection: 'failed',
        shouldReconnect: false,
      }
    }

    case 'first-frame-timeout': {
      // Only applies when no frame has arrived yet (still in the initial connecting
      // or reconnecting phase). Any state that already received a frame (live, drift,
      // not-found, failed, closed, backpressure) is left unchanged — the timeout
      // fires only when the stream opened but stayed silent.
      if (
        current.connection === 'connecting' ||
        current.connection === 'reconnecting'
      ) {
        return {
          ...current,
          connection: 'submitted-unobservable',
          shouldReconnect: false,
        }
      }
      return current
    }

    default: {
      return current
    }
  }
}

// ---------------------------------------------------------------------------
// Safe render model mapper
// ---------------------------------------------------------------------------

/**
 * Map a run status object to the safe render model.
 *
 * Returns ONLY: { runId, status, phase, startedAt, stale }
 *
 * Explicitly excluded: entityRef, surface, output, tool, path, repoName,
 * and any other field not in the safe set. This is a whitelist, not a blacklist.
 */
export function toSafeRunView(runStatus) {
  return {
    runId: runStatus.runId,
    status: runStatus.status,
    phase: runStatus.phase,
    startedAt: runStatus.startedAt,
    stale: runStatus.stale,
  }
}

// ---------------------------------------------------------------------------
// Backoff delay calculator
// ---------------------------------------------------------------------------

/**
 * Calculate the delay in milliseconds for a given retry attempt (0-indexed).
 * Uses exponential backoff: base * factor^attempt.
 * backoffDelay(0) === RETRY_BASE_MS (1000ms on first retry).
 */
function backoffDelay(attempt) {
  return RETRY_BASE_MS * RETRY_FACTOR ** attempt
}

// ---------------------------------------------------------------------------
// DOM shell — only runs in a browser (document must exist)
// ---------------------------------------------------------------------------

/**
 * Initialize the operator run stream for a given run ID.
 *
 * This function touches the DOM and must only be called from a browser context.
 * It is never called at module top-level, so Vitest can import this file safely.
 *
 * Options:
 *   runId    — the run ID to subscribe to (used only in the fetch URL)
 *   statusEl — element with [data-role="run-status"] to update
 *   noticeEl — element to show stream connection state notices
 *
 * Security:
 * - Never logs frame data, run IDs, repo names, or stream URLs.
 * - Renders only phase/status/timestamps via toSafeRunView.
 * - Status labels rendered from STATUS_LABELS map, never raw wire strings.
 * - All 404s → one not-found state, one retry policy.
 * - Read-only: GET only, no POST/PUT/DELETE.
 */
export function initOperatorStream(opts) {
  const {runId, statusEl, noticeEl} = opts

  let state = {
    connection: 'connecting',
    runs: Object.create(null), // F13: null-prototype to guard __proto__ keys
    retryCount: 0,
    shouldReconnect: false,
  }

  let abortController = null
  let reconnectTimer = null // track pending reconnect timer
  let firstFrameTimer = null // track pending first-frame timeout
  let aborted = false // set by close() to prevent late timer from fetching

  function updateDOM() {
    if (noticeEl) {
      const conn = state.connection
      if (conn === 'live') {
        noticeEl.textContent = ''
        noticeEl.hidden = true
      } else if (conn === 'connecting' || conn === 'reconnecting') {
        noticeEl.textContent = 'Connecting to run stream\u2026'
        noticeEl.hidden = false
      } else if (conn === 'drift') {
        noticeEl.textContent = 'Stream version mismatch \u2014 refresh the page.'
        noticeEl.hidden = false
      } else if (conn === 'not-found') {
        noticeEl.textContent = 'Run stream unavailable.'
        noticeEl.hidden = false
      } else if (conn === 'backpressure') {
        noticeEl.textContent = 'Stream temporarily unavailable \u2014 retrying\u2026'
        noticeEl.hidden = false
      } else if (conn === 'failed') {
        noticeEl.textContent = 'Stream connection failed.'
        noticeEl.hidden = false
      } else if (conn === 'submitted-unobservable') {
        noticeEl.textContent =
          'Run submitted \u2014 not yet observable (it may be queued or still starting).'
        noticeEl.hidden = false
      } else if (conn === 'closed') {
        noticeEl.textContent = ''
        noticeEl.hidden = true
      }
    }

    if (statusEl) {
      const runEntry = state.runs[runId]
      if (runEntry && state.connection === 'live') {
        const view = toSafeRunView(runEntry)
        // F6: render label from local map, never the raw wire string into textContent
        const label = STATUS_LABELS[view.status] ?? ''
        statusEl.textContent = label
        // Update status class for styling — use allowlisted status value (no whitespace)
        statusEl.className = statusEl.className.replaceAll(/\bstatus-\S+/g, '')
        statusEl.classList.add(`status-${view.status.replaceAll('_', '-')}`)
      }
    }
  }

  function clearFirstFrameTimer() {
    if (firstFrameTimer !== null) {
      clearTimeout(firstFrameTimer)
      firstFrameTimer = null
    }
  }

  function dispatch(event) {
    state = nextStreamState(state, event)
    updateDOM()
  }

  function connect() {
    // Don't fetch if close() was called
    if (aborted) return

    // Clear any previously-pending first-frame timer before arming a new one.
    // Without this, a reconnect would leak the old timer, which could fire later
    // and wrongly dispatch first-frame-timeout on a recovering stream.
    clearFirstFrameTimer()

    abortController = new AbortController()
    const signal = abortController.signal

    // Arm the first-frame timeout. If no ready/status/reset frame arrives within
    // FIRST_FRAME_TIMEOUT_MS, the run is considered submitted but not yet observable.
    // The timer is cleared as soon as the first frame is dispatched or on close().
    firstFrameTimer = setTimeout(() => {
      firstFrameTimer = null
      dispatch({type: 'first-frame-timeout'})
    }, FIRST_FRAME_TIMEOUT_MS)

    // Build the stream URL — runId is used only here, never logged
    const path = `/operator/runs/${encodeURIComponent(runId)}/stream`

    fetch(path, {
      credentials: 'include',
      redirect: 'error', // prevent auth-redirect loops
      signal,
      headers: {accept: 'text/event-stream'},
    })
      .then(response => {
        if (response.status === 404) {
          clearFirstFrameTimer()
          dispatch({type: 'http-status', code: 404})
          return
        }
        if (response.status === 429) {
          clearFirstFrameTimer()
          dispatch({type: 'http-status', code: 429})
          return
        }
        if (response.status !== 200) {
          clearFirstFrameTimer()
          dispatch({type: 'network-error'})
          scheduleReconnect()
          return
        }
        // Require Content-Type text/event-stream on 200
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.startsWith('text/event-stream')) {
          clearFirstFrameTimer()
          dispatch({type: 'network-error'})
          return
        }
        if (!response.body) {
          clearFirstFrameTimer()
          dispatch({type: 'network-error'})
          scheduleReconnect()
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''
        const reader = response.body.getReader()

        function readChunk() {
          reader
            .read()
            .then(({done, value}) => {
              if (done) {
                // Flush remaining buffer before handling done
                if (buffer.trim() !== '') {
                  const flushResult = parseSseFrame(`${buffer}\n\n`)
                  if (flushResult !== null && flushResult.success) {
                    clearFirstFrameTimer()
                    dispatch(flushResult.frame)
                  }
                  buffer = ''
                }
                // Stream ended — check if we should reconnect
                if (state.shouldReconnect) {
                  scheduleReconnect()
                } else {
                  dispatch({type: 'stream-closed'})
                }
                return
              }

              if (value) {
                // Normalize CRLF on each appended chunk
                buffer += normalizeCrlf(decoder.decode(value, {stream: true}))
              }

              // Hard buffer cap — abort the reader and fail closed terminally
              // (no reconnect) if exceeded without a record boundary.
              if (buffer.length > MAX_SSE_BUFFER_BYTES) {
                clearFirstFrameTimer()
                if (abortController) {
                  abortController.abort()
                }
                dispatch({type: 'buffer-overflow'})
                return
              }

              // Process complete SSE records (terminated by \n\n)
              let boundary = buffer.indexOf('\n\n')
              while (boundary !== -1) {
                const record = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)

                const result = parseSseFrame(`${record}\n\n`)
                if (result !== null && result.success) {
                  // Clear the first-frame timer on the first successfully parsed frame
                  clearFirstFrameTimer()
                  dispatch(result.frame)
                  // Parse failures are silently dropped (fail closed, no logging of frame data)
                }

                boundary = buffer.indexOf('\n\n')
              }

              // Continue reading if still connected
              if (
                state.connection !== 'closed' &&
                state.connection !== 'failed' &&
                state.connection !== 'not-found' &&
                state.connection !== 'drift' && // stop reading on drift
                state.connection !== 'submitted-unobservable' // stop reading after first-frame timeout
              ) {
                readChunk()
              }
            })
            .catch(() => {
              // Stream read error — fail closed, no logging of error details
              clearFirstFrameTimer()
              dispatch({type: 'unexpected-close'})
              if (state.shouldReconnect) {
                scheduleReconnect()
              }
            })
        }

        readChunk()
      })
      .catch(() => {
        // Network error — fail closed, no logging of error details
        clearFirstFrameTimer()
        dispatch({type: 'network-error'})
        if (state.shouldReconnect) {
          scheduleReconnect()
        }
      })
  }

  function scheduleReconnect() {
    if (!state.shouldReconnect) return
    if (aborted) return // don't schedule if close() was called
    // use backoffDelay(retryCount) — retryCount >= 0 → 1000ms on first retry
    const delay = backoffDelay(state.retryCount)
    reconnectTimer = setTimeout(connect, delay)
  }

  // Start the connection
  connect()

  // Return a handle to allow external abort (e.g. page unload)
  return {
    close() {
      aborted = true // prevent late timer from fetching
      // Clear any pending timers
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      clearFirstFrameTimer()
      if (abortController) {
        abortController.abort()
      }
      state = nextStreamState(state, {type: 'stream-closed'})
    },
  }
}

/**
 * Browser bootstrap. Discovers the run cards in the run-status section, starts a
 * stream for each, and closes all handles on page unload. Runs only in a browser
 * (guarded on `document`), so importing this module in Node for tests is a no-op.
 */
export function bootstrapOperatorStreams() {
  const section = document.querySelector('#run-status-section')
  if (section === null) return

  const noticeEl = section.querySelector('[data-role="stream-status"]')
  const cards = section.querySelectorAll('[data-run-id]')
  const handles = []

  for (const card of cards) {
    const runId = card.dataset.runId
    if (runId === null || runId === '') continue
    const statusEl = card.querySelector('[data-role="run-status"]')
    handles.push(initOperatorStream({runId, statusEl, noticeEl}))
  }

  globalThis.addEventListener('pagehide', () => {
    for (const handle of handles) handle.close()
  })
}

// Auto-start in the browser. Guarded so a Node/test import never touches the DOM.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapOperatorStreams)
  } else {
    bootstrapOperatorStreams()
  }
}
