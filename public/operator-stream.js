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
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Contract version this client expects on the ready frame. */
export const PINNED_CONTRACT_VERSION = '1.1.0'

/** Base delay in milliseconds for exponential backoff. */
export const RETRY_BASE_MS = 1000

/** Exponential backoff multiplier. */
export const RETRY_FACTOR = 2

/** Maximum number of reconnect attempts before transitioning to failed. */
export const RETRY_MAX_COUNT = 5

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
 */
export function parseSseFrame(record) {
  const lines = record.split('\n')
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
 *   runs: { [runId]: { runId, status, phase, startedAt, stale, terminal } }
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
 */
export function nextStreamState(current, event) {
  switch (event.type) {
    case 'ready': {
      if (event.data.contractVersion !== PINNED_CONTRACT_VERSION) {
        // Contract version mismatch — fail closed, clear all run state
        return {
          connection: 'drift',
          runs: {},
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
      const {runId, status, phase, startedAt, stale} = event.data
      const isTerminal = TERMINAL_STATUSES.has(status)
      const updatedRuns = {
        ...current.runs,
        [runId]: {runId, status, phase, startedAt, stale, terminal: isTerminal},
      }
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
      return {
        ...current,
        connection: 'reconnecting',
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
 * - All 404s → one not-found state, one retry policy.
 * - Read-only: GET only, no POST/PUT/DELETE.
 */
export function initOperatorStream(opts) {
  const {runId, statusEl, noticeEl} = opts

  let state = {
    connection: 'connecting',
    runs: {},
    retryCount: 0,
    shouldReconnect: false,
  }

  let abortController = null

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
      } else if (conn === 'closed') {
        noticeEl.textContent = ''
        noticeEl.hidden = true
      }
    }

    if (statusEl) {
      const runEntry = state.runs[runId]
      if (runEntry && state.connection !== 'drift') {
        const view = toSafeRunView(runEntry)
        statusEl.textContent = view.status
        // Update status class for styling
        statusEl.className = statusEl.className.replaceAll(/\bstatus-\S+/g, '')
        statusEl.classList.add(`status-${view.status.replaceAll('_', '-')}`)
      }
    }
  }

  function dispatch(event) {
    state = nextStreamState(state, event)
    updateDOM()
  }

  function connect() {
    abortController = new AbortController()
    const signal = abortController.signal

    // Build the stream URL — runId is used only here, never logged
    const path = `/operator/runs/${encodeURIComponent(runId)}/stream`

    fetch(path, {
      credentials: 'include',
      signal,
      headers: {accept: 'text/event-stream'},
    })
      .then(response => {
        if (response.status === 404) {
          dispatch({type: 'http-status', code: 404})
          return
        }
        if (response.status === 429) {
          dispatch({type: 'http-status', code: 429})
          return
        }
        if (response.status !== 200) {
          dispatch({type: 'network-error'})
          scheduleReconnect()
          return
        }
        if (!response.body) {
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
                // Stream ended — check if we should reconnect
                if (state.shouldReconnect) {
                  scheduleReconnect()
                } else {
                  dispatch({type: 'stream-closed'})
                }
                return
              }

              if (value) {
                buffer += decoder.decode(value, {stream: true})
              }

              // Process complete SSE records (terminated by \n\n)
              let boundary = buffer.indexOf('\n\n')
              while (boundary !== -1) {
                const record = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)

                const result = parseSseFrame(`${record}\n\n`)
                if (result !== null && result.success) {
                  dispatch(result.frame)
                  // Parse failures are silently dropped (fail closed, no logging of frame data)
                }

                boundary = buffer.indexOf('\n\n')
              }

              // Continue reading if still connected
              if (state.connection !== 'closed' && state.connection !== 'failed' && state.connection !== 'not-found') {
                readChunk()
              }
            })
            .catch(() => {
              // Stream read error — fail closed, no logging of error details
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
        dispatch({type: 'network-error'})
        if (state.shouldReconnect) {
          scheduleReconnect()
        }
      })
  }

  function scheduleReconnect() {
    if (!state.shouldReconnect) return
    const delay = backoffDelay(state.retryCount - 1)
    setTimeout(connect, delay)
  }

  // Start the connection
  connect()

  // Return a handle to allow external abort (e.g. page unload)
  return {
    close() {
      if (abortController) {
        abortController.abort()
      }
      state = nextStreamState(state, {type: 'stream-closed'})
    },
  }
}
