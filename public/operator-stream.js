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
export const PINNED_CONTRACT_VERSION = '1.4.0'

/** Base delay in milliseconds for exponential backoff. */
export const RETRY_BASE_MS = 1000

/** Exponential backoff multiplier. */
export const RETRY_FACTOR = 2

/** Maximum number of reconnect attempts before transitioning to failed. */
export const RETRY_MAX_COUNT = 5

/** Hard cap on the incremental SSE buffer in bytes. Overflow → abort + failed. */
export const MAX_SSE_BUFFER_BYTES = 1_000_000

/**
 * Hard cap on cumulative accumulated run-output characters. The raw SSE buffer cap
 * bounds a single frame; this bounds the reducer's growing answer string so a stream
 * of many valid deltas cannot exhaust browser memory. On overflow the text is
 * truncated and a fixed truncation hint is shown — never an echoed count.
 */
export const MAX_OUTPUT_TEXT_CHARS = 256_000

/**
 * Hard cap on the per-run approval tombstone map. A hostile stream could send many
 * distinct settle frames; this bounds the map size. When the cap is reached, the
 * oldest entry (FIFO) is evicted before adding the new one.
 */
export const MAX_APPROVAL_TOMBSTONES = 1000

/**
 * Hard cap on the per-run open-approvals map. A hostile stream could send many
 * distinct open frames; this bounds the map size. When the cap is reached, new open
 * frames for unseen requestIDs are ignored (existing prompts are never evicted).
 */
export const MAX_OPEN_APPROVALS = 100

/**
 * Mirrors the gateway's PENDING_APPROVALS_MAX_RESULTS cap (50) from
 * fro-bot/agent v0.76.2 packages/gateway/src/web/operator/pending-approvals-route.ts.
 *
 * The reconnect-reconcile caller uses this to guard against truncated recovery
 * responses: if the recovered set size is >= this cap, the response may be
 * truncated and corrective pruning is skipped (additive-only fallback).
 *
 * NOTE: This is an external contract value with no in-repo source of truth.
 * If the gateway cap is bumped, update this mirror and the guard in reconcileApprovals.
 * A stale mirror silently tightens the guard (ghosts persist) but never causes
 * catastrophic wipe — the safe failure direction.
 */
export const GATEWAY_PENDING_APPROVALS_CAP = 50

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
    // Allowlist-gate enumerated fields — fail closed on out-of-set values
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

  if (eventName === 'output') {
    if (
      typeof parsed.runId !== 'string' ||
      typeof parsed.text !== 'string' ||
      typeof parsed.final !== 'boolean' ||
      typeof parsed.seq !== 'number' ||
      !Number.isSafeInteger(parsed.seq) ||
      parsed.seq < 0
    ) {
      return {success: false, error: 'output frame missing required fields'}
    }
    if (
      parsed.droppedCount !== undefined &&
      (typeof parsed.droppedCount !== 'number' ||
        !Number.isSafeInteger(parsed.droppedCount) ||
        parsed.droppedCount < 0)
    ) {
      return {success: false, error: 'output frame droppedCount is not a non-negative integer'}
    }
    const data =
      parsed.droppedCount === undefined
        ? {runId: parsed.runId, text: parsed.text, final: parsed.final, seq: parsed.seq}
        : {runId: parsed.runId, text: parsed.text, final: parsed.final, seq: parsed.seq, droppedCount: parsed.droppedCount}
    return {success: true, frame: {type: 'output', data}}
  }

  if (eventName === 'approval') {
    // Validate runId and requestID — required on both variants; must be non-empty strings
    if (
      typeof parsed.runId !== 'string' ||
      parsed.runId.length === 0 ||
      typeof parsed.requestID !== 'string' ||
      parsed.requestID.length === 0
    ) {
      return {success: false, error: 'approval frame missing required fields'}
    }
    // settled must be a boolean — reject anything else (string, number, null, etc.)
    if (typeof parsed.settled !== 'boolean') {
      return {success: false, error: 'approval frame has invalid settled discriminator'}
    }
    if (parsed.settled === false) {
      // Open variant: permission is required and must be non-empty; command and filepath are optional strings
      if (typeof parsed.permission !== 'string' || parsed.permission.length === 0) {
        return {success: false, error: 'approval frame missing required fields'}
      }
      if (parsed.command !== undefined && typeof parsed.command !== 'string') {
        return {success: false, error: 'approval frame missing required fields'}
      }
      if (parsed.filepath !== undefined && typeof parsed.filepath !== 'string') {
        return {success: false, error: 'approval frame missing required fields'}
      }
      const data = {
        runId: parsed.runId,
        requestID: parsed.requestID,
        permission: parsed.permission,
        settled: false,
        ...(parsed.command === undefined ? {} : {command: parsed.command}),
        ...(parsed.filepath === undefined ? {} : {filepath: parsed.filepath}),
      }
      return {success: true, frame: {type: 'approval', data}}
    } else {
      // Settle variant: only runId/requestID/settled required
      const data = {
        runId: parsed.runId,
        requestID: parsed.requestID,
        settled: true,
      }
      return {success: true, frame: {type: 'approval', data}}
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
 *   runs: Object.create(null) — null-prototype map keyed by runId
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
 * A status before any ready is not rendered.
 */
export function nextStreamState(current, event) {
  switch (event.type) {
    case 'ready': {
      // Drift is absorbing — a second ready does not escape drift
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
      // Status before ready (connection !== 'live') is not rendered
      if (current.connection !== 'live') {
        return current
      }
      const {runId, status, phase, startedAt, stale} = event.data
      const isTerminal = TERMINAL_STATUSES.has(status)
      // Use a null-prototype object to guard against __proto__ key pollution.
      // Spread the prior entry so accumulated output fields (outputText/outputSeq/
      // outputFinal/outputCoalesced) survive a status update — a terminal status frame
      // arrives AFTER the final output frame, so a bare replacement would drop it.
      const prevStatusEntry = current.runs[runId]
      // On terminal status, clear all open approval prompts for this run.
      // Terminal is absorbing for approvals: once terminal, no open prompt can reappear.
      // Tombstones are preserved so that any late open frames are still ignored.
      const approvalFields = isTerminal
        ? {
            approvalOpenPrompts: Object.create(null),
            approvalTombstones: prevStatusEntry?.approvalTombstones ?? Object.create(null),
          }
        : {
            approvalOpenPrompts: prevStatusEntry?.approvalOpenPrompts,
            approvalTombstones: prevStatusEntry?.approvalTombstones,
          }
      const updatedRuns = Object.assign(Object.create(null), current.runs, {
        [runId]: {
          ...prevStatusEntry,
          ...approvalFields,
          runId,
          status,
          phase,
          startedAt,
          stale,
          terminal: isTerminal,
        },
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

    case 'approval': {
      // Approval frames before ready (connection !== 'live') are ignored — mirrors output/status gating.
      if (current.connection !== 'live') {
        return current
      }
      const {runId, requestID, settled} = event.data
      const prevEntry = current.runs[runId]

      // If the run is already terminal, all approval frames are ignored (terminal is absorbing).
      if (prevEntry !== undefined && prevEntry.terminal) {
        return current
      }

      // Build the base entry (may be a new run entry if we've never seen a status for this run).
      const base = prevEntry ?? {
        runId,
        status: '',
        phase: '',
        startedAt: '',
        stale: false,
        terminal: false,
      }

      // Null-proto maps for open prompts and tombstones — guard against __proto__ key pollution.
      const prevOpenPrompts = base.approvalOpenPrompts ?? Object.create(null)
      const prevTombstones = base.approvalTombstones ?? Object.create(null)

      if (settled) {
        // Settle frame: remove from open-prompts map AND add to tombstone set.
        // A settle for a requestID never seen open → still tombstone it (no spurious UI).
        const nextOpenPrompts = Object.assign(Object.create(null), prevOpenPrompts)
        delete nextOpenPrompts[requestID]
        // Cap the tombstone map: if at cap and requestID is new, evict the oldest entry (FIFO).
        let tombstoneBase = prevTombstones
        if (!(requestID in prevTombstones) && Object.keys(prevTombstones).length >= MAX_APPROVAL_TOMBSTONES) {
          const oldestKey = Object.keys(prevTombstones)[0]
          tombstoneBase = Object.assign(Object.create(null), prevTombstones)
          delete tombstoneBase[oldestKey]
        }
        const nextTombstones = Object.assign(Object.create(null), tombstoneBase, {[requestID]: true})
        const updatedEntry = {
          ...base,
          approvalOpenPrompts: nextOpenPrompts,
          approvalTombstones: nextTombstones,
        }
        const updatedRuns = Object.assign(Object.create(null), current.runs, {[runId]: updatedEntry})
        return {...current, runs: updatedRuns}
      } else {
        // Open frame: if requestID is already tombstoned → IGNORE (open-after-settle / id-reuse guard).
        if (prevTombstones[requestID] === true) {
          return current
        }
        // Cap the open-prompts map: if at cap and requestID is new, ignore the overflow open.
        // (Never evict an existing open prompt — losing a real pending prompt is worse than dropping overflow.)
        if (!(requestID in prevOpenPrompts) && Object.keys(prevOpenPrompts).length >= MAX_OPEN_APPROVALS) {
          return current
        }
        // Add/replace in the open-prompts map (duplicate open for same id is idempotent).
        const promptData = {
          runId: event.data.runId,
          requestID: event.data.requestID,
          permission: event.data.permission,
          settled: false,
          ...(event.data.command === undefined ? {} : {command: event.data.command}),
          ...(event.data.filepath === undefined ? {} : {filepath: event.data.filepath}),
        }
        const nextOpenPrompts = Object.assign(Object.create(null), prevOpenPrompts, {[requestID]: promptData})
        const updatedEntry = {
          ...base,
          approvalOpenPrompts: nextOpenPrompts,
          approvalTombstones: prevTombstones,
        }
        const updatedRuns = Object.assign(Object.create(null), current.runs, {[runId]: updatedEntry})
        return {...current, runs: updatedRuns}
      }
    }

    case 'output': {
      // Output before ready (connection !== 'live') is not applied.
      if (current.connection !== 'live') {
        return current
      }
      const {runId, text, final, seq, droppedCount} = event.data
      const prev = current.runs[runId]
      const prevText = prev?.outputText ?? ''
      const prevSeq = prev?.outputSeq ?? -1
      const prevCoalesced = prev?.outputCoalesced ?? false
      const coalesced = prevCoalesced || (typeof droppedCount === 'number' && droppedCount > 0)

      let nextText = prevText
      let nextSeq = prevSeq
      if (final) {
        // Authoritative complete answer replaces the accumulated text regardless of seq.
        nextText = text
        nextSeq = seq
      } else if (seq > prevSeq) {
        // Apply deltas only in strictly increasing seq order; drop stale/duplicate seqs.
        nextText = prevText + text
        nextSeq = seq
      } else if (coalesced === prevCoalesced) {
        // Out-of-order / duplicate delta with no new coalesced signal — ignore entirely.
        return current
      }
      // else: stale-seq delta but a new coalesced signal — fall through to record it.

      // Bound cumulative growth: a stream of valid deltas must not grow the answer
      // without limit. Truncate and flag — never echo a count.
      const prevTruncated = prev?.outputTruncated ?? false
      let truncated = prevTruncated
      if (nextText.length > MAX_OUTPUT_TEXT_CHARS) {
        nextText = nextText.slice(0, MAX_OUTPUT_TEXT_CHARS)
        truncated = true
      }

      const base = prev ?? {runId, status: '', phase: '', startedAt: '', stale: false, terminal: false}
      const updatedRuns = Object.assign(Object.create(null), current.runs, {
        [runId]: {
          ...base,
          runId,
          outputText: nextText,
          outputSeq: nextSeq,
          outputFinal: final ? true : (prev?.outputFinal ?? false),
          outputCoalesced: coalesced,
          outputTruncated: truncated,
        },
      })
      return {...current, runs: updatedRuns}
    }

    case 'reset': {
      const {reason} = event.data

      // Terminal reset reason → close (no reconnect)
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

      // Increment retryCount on reset and cap at RETRY_MAX_COUNT
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

    case 'approval-reconcile': {
      // Corrective reconcile action dispatched by reconcileApprovals on reconnect.
      // The reconnect-reconcile caller computes the explicit pruneIds and addPrompts lists from
      // a pre-GET snapshot diff — the reducer does NOT re-derive the diff, which is
      // what makes the reconcile-window race impossible.
      //
      // Before ready (connection !== 'live') → ignore (mirrors approval/output gating).
      if (current.connection !== 'live') {
        return current
      }
      const {runId, pruneIds, addPrompts} = event
      const prevEntry = current.runs[runId]

      // If the run is already terminal, all approval frames are ignored (terminal is absorbing).
      if (prevEntry !== undefined && prevEntry.terminal) {
        return current
      }

      // Build the base entry (may be a new run entry if we've never seen a status for this run).
      const base = prevEntry ?? {
        runId,
        status: '',
        phase: '',
        startedAt: '',
        stale: false,
        terminal: false,
      }

      // Null-proto maps for open prompts and tombstones — guard against __proto__ key pollution.
      let nextOpenPrompts = Object.assign(Object.create(null), base.approvalOpenPrompts ?? Object.create(null))
      let nextTombstones = base.approvalTombstones ?? Object.create(null)

      // --- Prune path ---
      // For each id in pruneIds: remove from open-prompts and add to tombstones.
      // Removing an id that's already absent is a no-op.
      // Re-tombstoning an already-tombstoned id is idempotent.
      // Reuses the FIFO-cap logic from the settle branch (~L460-472).
      for (const requestID of pruneIds) {
        // Guard against __proto__ key injection
        if (requestID === '__proto__') continue
        // Remove from open-prompts (no-op if absent)
        if (requestID in nextOpenPrompts) {
          const updated = Object.assign(Object.create(null), nextOpenPrompts)
          delete updated[requestID]
          nextOpenPrompts = updated
        }
        // Add to tombstones with FIFO cap (mirrors settle branch)
        if (!(requestID in nextTombstones) && Object.keys(nextTombstones).length >= MAX_APPROVAL_TOMBSTONES) {
          const oldestKey = Object.keys(nextTombstones)[0]
          const trimmed = Object.assign(Object.create(null), nextTombstones)
          delete trimmed[oldestKey]
          nextTombstones = trimmed
        }
        nextTombstones = Object.assign(Object.create(null), nextTombstones, {[requestID]: true})
      }

      // --- Add path ---
      // For each prompt in addPrompts whose requestID is NOT already in open-prompts
      // AND NOT tombstoned: add it. Respects the existing MAX_OPEN_APPROVALS overflow guard.
      // Mirrors the open branch (~L480-505).
      for (const prompt of addPrompts) {
        const {requestID} = prompt
        // Guard against __proto__ key injection
        if (requestID === '__proto__') continue
        // Ignore if tombstoned (tombstone precedence)
        if (nextTombstones[requestID] === true) continue
        // Ignore if already open (idempotent)
        if (requestID in nextOpenPrompts) continue
        // Overflow guard: if at cap, ignore the new prompt
        if (Object.keys(nextOpenPrompts).length >= MAX_OPEN_APPROVALS) continue
        const promptData = {
          runId,
          requestID,
          permission: prompt.permission,
          settled: false,
          ...(prompt.command === undefined ? {} : {command: prompt.command}),
          ...(prompt.filepath === undefined ? {} : {filepath: prompt.filepath}),
        }
        nextOpenPrompts = Object.assign(Object.create(null), nextOpenPrompts, {[requestID]: promptData})
      }

      const updatedEntry = {
        ...base,
        approvalOpenPrompts: nextOpenPrompts,
        approvalTombstones: nextTombstones,
      }
      const updatedRuns = Object.assign(Object.create(null), current.runs, {[runId]: updatedEntry})
      return {...current, runs: updatedRuns}
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
// Approval derivation helpers
// ---------------------------------------------------------------------------

/**
 * Returns true iff the run entry has at least one open (non-tombstoned) approval prompt.
 *
 * This is the canonical visibility signal for the `waiting_for_approval` overlay and
 * the in-page open-prompt indicator. Both must derive from this one state so
 * they cannot desync.
 *
 * @param {object} runEntry - A RunEntry from the stream state's runs map.
 * @returns {boolean} True iff the run has at least one open approval prompt.
 */
export function hasOpenApprovals(runEntry) {
  if (runEntry === undefined || runEntry === null) return false
  const openPrompts = runEntry.approvalOpenPrompts
  if (openPrompts === undefined || openPrompts === null) return false
  return Object.keys(openPrompts).length > 0
}

/**
 * Returns the list of open (non-tombstoned) approval prompts for a run entry,
 * in insertion order. Each element is an open ApprovalFrameData object with
 * `{runId, requestID, permission, settled:false, command?, filepath?}`.
 *
 * Returns an empty array when there are no open prompts.
 *
 * @param {object} runEntry - A RunEntry from the stream state's runs map.
 * @returns {Array} The list of open approval prompt objects, or an empty array.
 */
export function getOpenApprovals(runEntry) {
  if (runEntry === undefined || runEntry === null) return []
  const openPrompts = runEntry.approvalOpenPrompts
  if (openPrompts === undefined || openPrompts === null) return []
  return Object.values(openPrompts)
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

// ---------------------------------------------------------------------------
// Browser-direct approval client (same-origin relative /operator/* paths)
// ---------------------------------------------------------------------------

/**
 * Build a browser-direct approval client for the inline approval prompt UI.
 *
 * Uses same-origin relative /operator/* paths (owned by the public reverse proxy,
 * not the dashboard app). credentials:'include' and redirect:'error' are set on
 * all fetch calls so the cookie, Origin, and Sec-Fetch metadata ride automatically.
 *
 * Security:
 * - Never logs runId, requestId, decision, csrf, or idempotency key.
 * - All 404s collapse to one denial-class signal (no cause inference).
 * - Transport errors are distinct from denial (approval decision failure handling).
 * - CSRF-400 retried once with the same idempotency key (mirrors launch pattern).
 *
 * @returns {object} An object with refreshCsrf() and decideRunApproval() methods.
 */
export function buildApprovalClient() {
  const browserFetch = (input, init) =>
    globalThis.fetch(input, {
      ...init,
      credentials: 'include',
      redirect: 'error',
    })

  async function refreshCsrf() {
    try {
      const res = await browserFetch('/operator/session/csrf', {
        headers: {'content-type': 'application/json'},
      })
      if (!res.ok) return {success: false, error: {kind: 'http', status: res.status}}
      const data = await res.json()
      if (data === null || typeof data !== 'object' || typeof data.csrfToken !== 'string') {
        return {success: false, error: {kind: 'protocol'}}
      }
      return {success: true, data: {csrfToken: data.csrfToken}}
    } catch {
      return {success: false, error: {kind: 'network'}}
    }
  }

  /**
   * POST a decision for a pending approval.
   *
   * Returns:
   *   {success: true, data: {state}}  — decision accepted; state is the gateway's response
   *   {success: false, error: {kind: 'http', status: 404}}  — denial-class (uniform not-found)
   *   {success: false, error: {kind: 'network'}}  — transport failure (retryable)
   *   {success: false, error: {kind: 'http', status: N}}  — other HTTP error
   *
   * One CSRF-400 retry reusing the same idempotency key (mirrors launch pattern).
   */
  async function decideRunApproval(runId, requestId, decision, idempotencyKey) {
    // Get initial CSRF token. Propagate an HTTP failure (e.g. an expired session
    // returning 401/403) so the caller can show the reload state instead of an
    // endless retry; only a true transport failure collapses to 'network'.
    const csrfResult = await refreshCsrf()
    if (!csrfResult.success) {
      return csrfResult.error.kind === 'http'
        ? {success: false, error: {kind: 'http', status: csrfResult.error.status}}
        : {success: false, error: {kind: 'network'}}
    }
    const csrfToken = csrfResult.data.csrfToken

    const path = `/operator/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(requestId)}/decision`
    const body = JSON.stringify({decision})
    const makeInit = csrf => ({
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': idempotencyKey,
      },
      body,
    })

    let res
    try {
      res = await browserFetch(path, makeInit(csrfToken))
    } catch {
      return {success: false, error: {kind: 'network'}}
    }

    // CSRF-400 retry: refresh CSRF once and retry with the same idempotency key
    if (res.status === 400) {
      const retrycsrfResult = await refreshCsrf()
      if (!retrycsrfResult.success) {
        return retrycsrfResult.error.kind === 'http'
          ? {success: false, error: {kind: 'http', status: retrycsrfResult.error.status}}
          : {success: false, error: {kind: 'network'}}
      }
      try {
        res = await browserFetch(path, makeInit(retrycsrfResult.data.csrfToken))
      } catch {
        return {success: false, error: {kind: 'network'}}
      }
    }

    if (res.ok) {
      let data
      try {
        data = await res.json()
      } catch {
        return {success: false, error: {kind: 'network'}}
      }
      return {success: true, data: {state: data.state}}
    }

    return {success: false, error: {kind: 'http', status: res.status}}
  }

  /**
   * GET open approvals for a run (reconcile on reconnect).
   *
   * Returns a discriminated result:
   *   {success: true, data: {approvals: [...]}}  — 2xx with a valid approvals array
   *   {success: false, error: {kind: 'http', status}}  — non-2xx response
   *   {success: false, error: {kind: 'network'}}  — fetch threw (transport failure)
   *   {success: false, error: {kind: 'protocol'}}  — 200 but missing/non-array approvals
   *
   * A malformed body is NOT treated as success-empty: under corrective pruning,
   * a failed reconcile must never wipe open prompts. The caller dispatches the
   * corrective action only on success:true.
   */
  async function listRunApprovals(runId) {
    try {
      const res = await browserFetch(
        `/operator/runs/${encodeURIComponent(runId)}/approvals`,
        {headers: {'content-type': 'application/json'}},
      )
      if (!res.ok) return {success: false, error: {kind: 'http', status: res.status}}
      const data = await res.json()
      if (!data || !Array.isArray(data.approvals)) return {success: false, error: {kind: 'protocol'}}
      return {success: true, data: {approvals: data.approvals}}
    } catch {
      return {success: false, error: {kind: 'network'}}
    }
  }

  return {refreshCsrf, decideRunApproval, listRunApprovals}
}

// ---------------------------------------------------------------------------
// Approval prompt interaction state machine (per-prompt, browser-side)
// ---------------------------------------------------------------------------

/**
 * Prompt interaction states (per-prompt, browser-side):
 *   'open'              — controls active: once, always, reject
 *   'always-confirm'    — always first-click: show confirm + cancel; once/reject suppressed
 *   'in-flight'         — POST pending: all controls disabled
 *   'cant-approve'      — denial-class 404: generic no-access copy, controls gone
 *   'transport-failure' — transport error: "try again" state, controls re-enabled
 *   'already-settled'   — already_claimed/unavailable: inline settled copy
 */

/**
 * Render a single open approval prompt into a container element.
 * Uses safe DOM (textContent only — never innerHTML or HTML interpolation).
 * Wires once/reject/always/confirm/cancel handlers.
 *
 * @param {object} prompt - An open ApprovalFrameDataOpen object from getOpenApprovals.
 * @param {string} runId - The run ID (for the decision POST).
 * @param {object} approvalClient - The browser-direct approval client.
 * @param {function} _onSettle - Called when the prompt is settled (to trigger DOM cleanup).
 * @returns {HTMLElement} The rendered prompt element.
 */
export function renderApprovalPrompt(prompt, runId, approvalClient, _onSettle) {
  const {requestID, permission, command, filepath} = prompt

  // Determine if this is an edit-class prompt (filepath-based, contents not previewed)
  const isEditClass = permission === 'edit' || permission === 'external_directory'

  // Safe permission label — never the raw token
  const permLabel = (() => {
    switch (permission) {
      case 'shell': return 'Shell command'
      case 'edit': return 'File edit'
      case 'external_directory': return 'External directory access'
      case 'network': return 'Network access'
      case 'read': return 'File read'
      case 'write': return 'File write'
      default: return 'Tool action'
    }
  })()

  // Build the prompt container
  const el = document.createElement('div')
  el.className = 'approval-prompt'
  el.setAttribute('role', 'region')
  el.setAttribute('aria-label', 'Approval prompt')
  el.style.cssText = 'border:1px solid #f59e0b;border-radius:4px;padding:10px;margin-bottom:8px;background:#fffbeb;'

  // Permission label
  const permEl = document.createElement('div')
  permEl.style.cssText = 'font-size:0.8rem;font-weight:600;color:#92400e;margin-bottom:4px;'
  permEl.textContent = permLabel
  el.append(permEl)

  // Gated action — strictly inert textContent, never innerHTML
  if (command !== undefined || filepath !== undefined) {
    const actionEl = document.createElement('pre')
    actionEl.style.cssText = 'font-size:0.8rem;background:#fef3c7;border:1px solid #fcd34d;border-radius:3px;padding:6px 8px;margin:4px 0;white-space:pre-wrap;word-break:break-all;overflow:hidden;'
    actionEl.setAttribute('aria-label', 'Requested action (read-only)')
    // textContent only — never innerHTML. This is the injection-safety guarantee.
    actionEl.textContent = command === undefined ? (filepath ?? '') : command
    el.append(actionEl)
  }

  // Edit-class caveat
  if (isEditClass) {
    const caveEl = document.createElement('p')
    caveEl.style.cssText = 'font-size:0.75rem;color:#92400e;margin:2px 0 6px;'
    caveEl.textContent = 'File-level only \u2014 contents not previewed.'
    el.append(caveEl)
  }

  // Access caveat
  const accessCaveEl = document.createElement('p')
  accessCaveEl.style.cssText = 'font-size:0.75rem;color:#6b7280;margin:2px 0 6px;'
  accessCaveEl.textContent = 'Approval requires write access to this run. Unavailable decisions fail safely.'
  el.append(accessCaveEl)

  // Status/feedback area (for in-flight, failure, settled states)
  const statusEl = document.createElement('div')
  statusEl.setAttribute('role', 'status')
  statusEl.setAttribute('aria-live', 'polite')
  statusEl.style.cssText = 'font-size:0.8rem;margin:4px 0;'
  el.append(statusEl)

  // Controls area
  const controlsEl = document.createElement('div')
  controlsEl.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;'
  el.append(controlsEl)

  // Always-confirm area (hidden until always first-click)
  const alwaysConfirmEl = document.createElement('div')
  alwaysConfirmEl.hidden = true
  alwaysConfirmEl.style.cssText = 'margin-top:6px;padding:8px;background:#fef3c7;border:1px solid #f59e0b;border-radius:4px;'
  el.append(alwaysConfirmEl)

  const alwaysConsequenceEl = document.createElement('p')
  alwaysConsequenceEl.style.cssText = 'font-size:0.8rem;color:#92400e;margin:0 0 8px;'
  alwaysConsequenceEl.textContent = 'This installs a standing approval that auto-approves matching requests for the rest of this run, as defined by the gateway\u2019s grant rule.'
  alwaysConfirmEl.append(alwaysConsequenceEl)

  const alwaysConfirmBtnsEl = document.createElement('div')
  alwaysConfirmBtnsEl.style.cssText = 'display:flex;gap:8px;'
  alwaysConfirmEl.append(alwaysConfirmBtnsEl)

  // Interaction state machine
  let promptState = 'open' // 'open' | 'always-confirm' | 'in-flight' | 'cant-approve' | 'transport-failure' | 'already-settled'

  function setInFlight() {
    promptState = 'in-flight'
    statusEl.textContent = 'Sending decision\u2026'
    // Disable all buttons
    for (const btn of el.querySelectorAll('button')) {
      btn.disabled = true
    }
  }

  function setTransportFailure() {
    promptState = 'transport-failure'
    // Re-enable controls first (renderControls clears statusEl.textContent),
    // then set the status message so it survives and is visible alongside the controls.
    renderControls()
    statusEl.textContent = 'Decision didn\u2019t go through \u2014 try again.'
  }

  function setCantApprove() {
    promptState = 'cant-approve'
    statusEl.textContent = 'You may not have approval access for this run. If you believe this is an error, check your gateway operator session.'
    // Remove controls
    controlsEl.textContent = ''
    alwaysConfirmEl.hidden = true
  }

  function setAlreadySettled() {
    promptState = 'already-settled'
    statusEl.textContent = 'This approval request has already been settled.'
    controlsEl.textContent = ''
    alwaysConfirmEl.hidden = true
  }

  async function handleDecision(decision) {
    if (promptState === 'in-flight') return
    setInFlight()

    const idempotencyKey = (
      globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    )

    const result = await approvalClient.decideRunApproval(runId, requestID, decision, idempotencyKey)

    if (result.success) {
      const {state} = result.data
      if (state === 'already_claimed' || state === 'unavailable') {
        setAlreadySettled()
      } else if (state === 'scope_mismatch') {
        // Terminal non-retryable: the decision was not applied due to a scope mismatch.
        // Show the label and clear controls (mirrors already-settled behavior).
        promptState = 'already-settled'
        statusEl.textContent = 'Approval scope didn\u2019t match \u2014 decision not applied.'
        controlsEl.textContent = ''
        alwaysConfirmEl.hidden = true
      } else if (state === 'failed_to_settle') {
        // Retryable: the gateway couldn't finalize the decision. Re-enable controls.
        // Uses transport-failure path so the operator can retry.
        setTransportFailure()
        statusEl.textContent = 'Couldn\u2019t finalize the decision \u2014 please try again.'
      } else if (state === 'pending') {
        // Defensive: pending shouldn't come back from a decision POST, but if it does
        // re-enable controls so the operator is not left in a disabled limbo.
        renderControls()
      } else {
        // claimed / other → treat as in-progress success.
        // The settle frame will arrive over the stream and remove the prompt via the reducer.
        statusEl.textContent = ''
      }
    } else {
      const {error} = result
      if (error.kind === 'http' && error.status === 404) {
        setCantApprove()
      } else if (error.kind === 'http' && (error.status === 400 || error.status === 401 || error.status === 403)) {
        // Persistent auth/session failure after CSRF retry — non-retryable loop guard.
        // Clear controls so the operator cannot loop; instruct them to reload.
        promptState = 'cant-approve'
        statusEl.textContent = 'Your session may have expired \u2014 reload the page to approve.'
        controlsEl.textContent = ''
        alwaysConfirmEl.hidden = true
      } else {
        setTransportFailure()
      }
    }
  }

  function renderControls() {
    controlsEl.textContent = ''
    alwaysConfirmEl.hidden = true
    statusEl.textContent = ''

    const onceBtn = document.createElement('button')
    onceBtn.type = 'button'
    onceBtn.textContent = 'Once'
    onceBtn.style.cssText = 'padding:4px 12px;background:#2563eb;color:#fff;border:none;border-radius:4px;font-size:0.8rem;font-weight:600;cursor:pointer;'
    onceBtn.addEventListener('click', () => {
      handleDecision('once')
    })
    controlsEl.append(onceBtn)

    const alwaysBtn = document.createElement('button')
    alwaysBtn.type = 'button'
    alwaysBtn.textContent = 'Always'
    alwaysBtn.style.cssText = 'padding:4px 12px;background:#d97706;color:#fff;border:none;border-radius:4px;font-size:0.8rem;font-weight:600;cursor:pointer;'
    alwaysBtn.addEventListener('click', () => {
      if (promptState !== 'open' && promptState !== 'transport-failure') return
      promptState = 'always-confirm'
      // Suppress once/reject during always-confirm pending
      controlsEl.textContent = ''
      alwaysConfirmEl.hidden = false

      // Confirm button
      const confirmBtn = document.createElement('button')
      confirmBtn.type = 'button'
      confirmBtn.textContent = 'Confirm always'
      confirmBtn.style.cssText = 'padding:4px 12px;background:#d97706;color:#fff;border:none;border-radius:4px;font-size:0.8rem;font-weight:600;cursor:pointer;'
      confirmBtn.addEventListener('click', () => {
        handleDecision('always')
      })

      // Cancel button
      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.style.cssText = 'padding:4px 12px;background:#6b7280;color:#fff;border:none;border-radius:4px;font-size:0.8rem;cursor:pointer;'
      cancelBtn.addEventListener('click', () => {
        promptState = 'open'
        renderControls()
      })

      alwaysConfirmBtnsEl.textContent = ''
      alwaysConfirmBtnsEl.append(confirmBtn, cancelBtn)
    })
    controlsEl.append(alwaysBtn)

    const rejectBtn = document.createElement('button')
    rejectBtn.type = 'button'
    rejectBtn.textContent = 'Reject'
    rejectBtn.style.cssText = 'padding:4px 12px;background:#dc2626;color:#fff;border:none;border-radius:4px;font-size:0.8rem;font-weight:600;cursor:pointer;'
    rejectBtn.addEventListener('click', () => {
      handleDecision('reject')
    })
    controlsEl.append(rejectBtn)
  }

  renderControls()

  return el
}

/**
 * Initialize the operator run stream for a given run ID.
 *
 * This function touches the DOM and must only be called from a browser context.
 * It is never called at module top-level, so Vitest can import this file safely.
 *
 * Options:
 *   runId       — the run ID to subscribe to (used only in the fetch URL)
 *   statusEl    — element with [data-role="run-status"] to update
 *   noticeEl    — element to show stream connection state notices
 *   approvalsEl — element with [data-role="run-approvals"] to render approval prompts
 *   badgeEl     — element with [data-role="approval-badge"] for the approval count badge
 *   approvalClient — optional pre-built approval client (for testing); if absent,
 *                    buildApprovalClient() is called when the flag is on
 *
 * Security:
 * - Never logs frame data, run IDs, repo names, or stream URLs.
 * - Renders only phase/status/timestamps via toSafeRunView.
 * - Status labels rendered from STATUS_LABELS map, never raw wire strings.
 * - Approval prompt content rendered via textContent only — never innerHTML.
 * - All 404s → one not-found state, one retry policy.
 * - Read-only: GET only for stream; approval decisions are operator-forwarded writes.
 */
export function initOperatorStream(opts) {
  const {runId, statusEl, noticeEl, outputEl, coalescedEl, approvalsEl, badgeEl, approvalClient: injectedApprovalClient} = opts

  // Build the approval client lazily (only if approvalsEl is present)
  const approvalClient = approvalsEl !== undefined && approvalsEl !== null
    ? (injectedApprovalClient ?? buildApprovalClient())
    : null

  // Track rendered prompt elements by requestID so we can remove them on settle
  // without re-rendering the entire list. Map: requestID → DOM element.
  const renderedPrompts = new Map()

  let state = {
    connection: 'connecting',
    runs: Object.create(null), // null-prototype to guard against __proto__ key pollution
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
        // Render label from local map, never the raw wire string into textContent
        const label = STATUS_LABELS[view.status] ?? ''
        statusEl.textContent = label
        // Update status class for styling — use allowlisted status value (no whitespace)
        statusEl.className = statusEl.className.replaceAll(/\bstatus-\S+/g, '')
        statusEl.classList.add(`status-${view.status.replaceAll('_', '-')}`)
      }
    }

    // Run output: render the accumulated answer via textContent only — `text` is
    // free-form agent output and must NEVER be interpolated as HTML. droppedCount is
    // never echoed; a fixed-label hint is toggled instead. Other output-frame fields
    // are not rendered.
    if (outputEl) {
      const runEntry = state.runs[runId]
      const outputText = runEntry?.outputText
      if (typeof outputText === 'string' && outputText !== '') {
        outputEl.textContent = outputText
        outputEl.hidden = false
      } else {
        // No output (or an authoritative empty final): clear any stale text and re-hide.
        outputEl.textContent = ''
        outputEl.hidden = true
      }
      if (coalescedEl) {
        // Show the fixed hint when output was coalesced or truncated — never an echoed count.
        const flagged = runEntry?.outputCoalesced === true || runEntry?.outputTruncated === true
        coalescedEl.hidden = !flagged
      }
    }

    // Approval prompts: render open prompts from getOpenApprovals(runEntry).
    // Uses safe DOM (textContent only — never innerHTML). Prompts are added/removed
    // as the reducer state changes; settled prompts are removed silently.
    if (approvalsEl !== undefined && approvalsEl !== null && approvalClient !== null) {
      const runEntry = state.runs[runId]
      const openPrompts = getOpenApprovals(runEntry)
      const openIds = new Set(openPrompts.map(p => p.requestID))

      // Remove prompts that are no longer open (settled/dismissed)
      for (const [reqId, promptEl] of renderedPrompts) {
        if (!openIds.has(reqId)) {
          promptEl.remove()
          renderedPrompts.delete(reqId)
        }
      }

      // Add new prompts that aren't yet rendered
      for (const prompt of openPrompts) {
        if (!renderedPrompts.has(prompt.requestID)) {
          const promptEl = renderApprovalPrompt(prompt, runId, approvalClient, () => {
            // onSettle: called when the prompt decides to remove itself
            // (the reducer will handle the actual removal on the next settle frame)
          })
          renderedPrompts.set(prompt.requestID, promptEl)
          approvalsEl.append(promptEl)
        }
      }

      // Show/hide the approvals container
      approvalsEl.hidden = openPrompts.length === 0

      // Update the badge indicator (hasOpenApprovals)
      if (badgeEl !== undefined && badgeEl !== null) {
        const hasOpen = hasOpenApprovals(runEntry)
        if (hasOpen) {
          badgeEl.textContent = String(openPrompts.length)
          badgeEl.hidden = false
        } else {
          badgeEl.textContent = ''
          badgeEl.hidden = true
        }
      }
    }
  }

  function clearFirstFrameTimer() {
    if (firstFrameTimer !== null) {
      clearTimeout(firstFrameTimer)
      firstFrameTimer = null
    }
  }

  // Track whether we've done the reconcile GET for the current connection attempt.
  // Reset on each connect() call so reconnects trigger a fresh reconcile.
  let reconcileDone = false

  function dispatch(event) {
    const prevConnection = state.connection
    state = nextStreamState(state, event)
    updateDOM()
    // Trigger reconcile when the stream first goes live (or re-goes live after reconnect).
    // This is the one-shot GET on (re)connect.
    if (prevConnection !== 'live' && state.connection === 'live') {
      reconcileApprovals()
    }
  }

  /**
   * Reconcile open approvals on (re)connect: one-shot corrective GET on stream open.
   *
   * Snapshots the locally-open approval ids BEFORE the GET so that any prompt
   * opening via SSE during the await window is never eligible for pruning (race-proof).
   * On a successful response, dispatches a single approval-reconcile action that
   * both prunes ghost prompts and adds any recovered-but-not-local prompts.
   * On any failure, dispatches nothing — open prompts are preserved (fail-closed).
   *
   * Truncation guard: if the recovered set is at or above the gateway cap it may be
   * incomplete, so pruneIds is left empty (additive-only) to avoid false pruning.
   *
   * Never called on a timer — only once per connect() invocation.
   */
  async function reconcileApprovals() {
    if (approvalClient === null) return
    if (reconcileDone) return
    reconcileDone = true

    // Snapshot the locally-open ids BEFORE the await. Only prompts open at this
    // moment are eligible for pruning — prompts that arrive via SSE during the
    // GET window are never in this set and therefore never pruned.
    const runEntry = state.runs[runId]
    const preGetLocalOpenIds = getOpenApprovals(runEntry).map(p => p.requestID)

    const listResult = await approvalClient.listRunApprovals(runId)

    // Staleness check: if connect() reset reconcileDone during the await, a newer
    // reconnect cycle is already in progress — discard this stale result entirely.
    if (!reconcileDone) return

    // On any failure, abort — never prune on an unsafe signal.
    if (!listResult.success) return

    const recovered = listResult.data.approvals

    // Validate each recovered summary and build the recovered open-id set and
    // the list of prompts to add (those not already locally open).
    const recoveredOpenIds = new Set()
    const addPrompts = []
    for (const approval of recovered) {
      if (
        typeof approval.requestID !== 'string' ||
        approval.requestID.length === 0 ||
        typeof approval.permission !== 'string' ||
        approval.permission.length === 0
      ) {
        continue
      }
      recoveredOpenIds.add(approval.requestID)
      addPrompts.push({
        requestID: approval.requestID,
        permission: approval.permission,
        ...(typeof approval.command === 'string' ? {command: approval.command} : {}),
        ...(typeof approval.filepath === 'string' ? {filepath: approval.filepath} : {}),
      })
    }

    // Malformed-entries guard: if the gateway returned entries but none passed
    // validation, the response is not authoritative — abort rather than wiping
    // all locally-open prompts. A genuinely empty response (recovered.length === 0)
    // is authoritative and still prunes normally.
    if (recoveredOpenIds.size === 0 && preGetLocalOpenIds.length > 0 && recovered.length > 0) return

    // Truncation guard: if the recovered VALID set is at or above the gateway cap
    // it may be incomplete — fall back to additive-only to avoid pruning real open
    // prompts. Uses recoveredOpenIds.size (valid entries only) to match the metric
    // used by the prune diff below.
    const pruneIds = recoveredOpenIds.size >= GATEWAY_PENDING_APPROVALS_CAP
      ? []
      : preGetLocalOpenIds.filter(id => !recoveredOpenIds.has(id))

    dispatch({type: 'approval-reconcile', runId, pruneIds, addPrompts})
  }

  function connect() {
    // Don't fetch if close() was called
    if (aborted) return

    // Reset reconcile flag for this connection attempt — each connect/reconnect
    // triggers a fresh one-shot reconcile GET when the stream goes live.
    reconcileDone = false

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
    const outputEl = card.querySelector('[data-role="run-output"]')
    const coalescedEl = card.querySelector('[data-role="run-output-coalesced"]')
    // Discover the approval region and badge elements
    const approvalsEl = card.querySelector('[data-role="run-approvals"]')
    const badgeEl = card.querySelector('[data-role="approval-badge"]')
    handles.push(initOperatorStream({runId, statusEl, noticeEl, outputEl, coalescedEl, approvalsEl, badgeEl}))
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
