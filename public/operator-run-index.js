/**
 * Operator run index — pure core + thin DOM shell.
 *
 * Security invariants:
 * - Never log run summaries, run IDs, repo names, Gateway bodies, or endpoint paths.
 * - Render only safe fields from a closed safe-view; never spread raw payloads.
 * - All error classes collapse to one neutral unavailable treatment.
 * - credentials:'include', redirect:'error' on all fetch calls.
 */

import {formatRelativeTime, LAUNCH_TIME_SOURCE, MAX_TIMESTAMP_LENGTH} from './operator-time.js'

// Re-exported so existing importers of the run index keep working.
export {formatRelativeTime}

export const RUN_INDEX_CAP = 100

/** Timeout for the /runs fetch — matches server-side Gateway fetch timeout precedent. */
export const FETCH_TIMEOUT_MS = 10_000

const MAX_ID_LENGTH = 512

/** 'blocked' is stream-only — a run summary never carries it. The waiting statuses are gateway overlays on a running run. */
export const VALID_RUN_SUMMARY_STATUSES = new Set([
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_question',
  'succeeded',
  'failed',
  'cancelled',
])

/** Render labels from this map, never the raw wire string. */
const STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  waiting_for_approval: 'Waiting for approval',
  waiting_for_question: 'Waiting for answer',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/**
 * Run-summary status ↔ CSS class token, the single two-way map for the run-list card badge.
 *
 * Tokens are hyphenated (`waiting_for_question` → `status-waiting-for-question`), matching the
 * stream emitter (operator-stream.js) and the rules in web/src/index.css. The card emitter below
 * writes through this map, and web/src/operator/runtime.ts reads a card's class back through its
 * mirror (STATUS_CLASS_TOKENS; a parity test pins the two together). Underscore tokens are not
 * in the map, so they never read back as a status.
 */
export const RUN_STATUS_CLASS_TOKENS = Object.freeze({
  queued: 'status-queued',
  running: 'status-running',
  waiting_for_approval: 'status-waiting-for-approval',
  waiting_for_question: 'status-waiting-for-question',
  succeeded: 'status-succeeded',
  failed: 'status-failed',
  cancelled: 'status-cancelled',
})

const STATUS_BY_CLASS_TOKEN = new Map(Object.entries(RUN_STATUS_CLASS_TOKENS).map(([status, token]) => [token, status]))

/** The summary status a class token stands for, or undefined for any token the map does not own. */
function summaryStatusFromClassToken(token) {
  return typeof token === 'string' ? STATUS_BY_CLASS_TOKEN.get(token) : undefined
}

/**
 * data-role of the hidden checkout-detail region (provenance / preparation). Unit-3 anatomy
 * only: this module creates and shows/hides the region; operator-stream.js renders into it.
 */
const CHECKOUT_DETAIL_ROLE = 'run-checkout-detail'
const WAITING_ROLE = 'run-waiting'

/**
 * data-role of the hidden question region. This module only creates it and shows/hides it with
 * the rest of the substructure; operator-stream.js owns everything rendered inside it.
 */
const QUESTIONS_ROLE = 'run-questions'

/**
 * Output toolbar region (data-role="run-output-tools"): the Rendered/Raw toggle and Copy raw controls,
 * built by operator-stream.js. It sits right after the output region on every card shape.
 */
const OUTPUT_TOOLS_ROLE = 'run-output-tools'

/**
 * The card's hidden substructure regions in DOM order. The checkout-detail region leads the
 * list, so anything inserted "before the first hidden region" lands ahead of it too. The
 * question region sits right after the approvals region on every card shape.
 */
const SUBSTRUCTURE_ROLES = [
  CHECKOUT_DETAIL_ROLE,
  WAITING_ROLE,
  'run-output',
  OUTPUT_TOOLS_ROLE,
  'run-output-coalesced',
  'run-approvals',
  QUESTIONS_ROLE,
  'approval-badge',
  'run-cancel',
]

/**
 * Allowlisted OperatorFailureKind values — out-of-set values
 * normalize to absent, never parsed through.
 * Mirrors src/gateway/operator-contract/run-status.ts OPERATOR_FAILURE_KINDS.
 */
const VALID_FAILURE_KINDS = new Set([
  'inactivity-timeout',
  'max-duration-timeout',
  'stream-ended',
  'workspace-unreachable',
  'session-error',
  'checkout-substituted',
  'workspace-unavailable',
  'unknown',
])

/**
 * Dashboard-owned display labels for known failure reasons — render labels from
 * this map, never the raw failureKind wire string. Must stay identical to the
 * map in public/operator-stream.js (parity is enforced by tests). Every
 * OperatorFailureKind value has an explicit display decision.
 */
export const FAILURE_REASON_LABELS = {
  'inactivity-timeout': 'No recent activity',
  'max-duration-timeout': 'Run timed out',
  'stream-ended': 'Stream ended early',
  'workspace-unreachable': 'Workspace unreachable',
  'session-error': 'Session error',
  'checkout-substituted': 'Checkout mismatch',
  'workspace-unavailable': 'Workspace unavailable',
  unknown: 'Unknown failure',
}

/**
 * Parse a single run summary item from the Gateway response.
 * Error strings are fixed — never echo or interpolate any part of the input.
 */
export function parseRunSummaryItem(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {success: false, error: 'invalid run summary shape'}
  }

  const candidate = input

  if (typeof candidate.runId !== 'string' || candidate.runId.length > MAX_ID_LENGTH) {
    return {success: false, error: 'invalid run summary shape'}
  }

  if (typeof candidate.repo !== 'string' || candidate.repo.length > MAX_ID_LENGTH) {
    return {success: false, error: 'invalid run summary shape'}
  }

  if (typeof candidate.status !== 'string' || !VALID_RUN_SUMMARY_STATUSES.has(candidate.status)) {
    return {success: false, error: 'invalid run summary shape'}
  }

  if (typeof candidate.createdAt !== 'string' || candidate.createdAt.length > MAX_TIMESTAMP_LENGTH) {
    return {success: false, error: 'invalid run summary shape'}
  }

  // updatedAt is optional — if present must be a length-capped string
  if (
    'updatedAt' in candidate &&
    (typeof candidate.updatedAt !== 'string' || candidate.updatedAt.length > MAX_TIMESTAMP_LENGTH)
  ) {
    return {success: false, error: 'invalid run summary shape'}
  }

  // failureKind is optional and allowlist-gated; an unrecognized or absent
  // value normalizes to omitted — it never fails validity of the summary.
  const failureKind = VALID_FAILURE_KINDS.has(candidate.failureKind) ? candidate.failureKind : undefined

  // Closed DTO — copy only declared fields; never spread input.
  const summary = {
    runId: candidate.runId,
    repo: candidate.repo,
    status: candidate.status,
    createdAt: candidate.createdAt,
    ...('updatedAt' in candidate ? {updatedAt: candidate.updatedAt} : {}),
    ...(failureKind === undefined ? {} : {failureKind}),
  }

  return {success: true, data: summary}
}

/**
 * Parse an array of run summary items from the Gateway response.
 * Invalid items are skipped. Duplicate runIds: keeps first valid entry. Caps at RUN_INDEX_CAP.
 */
export function parseRunSummaryList(input) {
  if (!Array.isArray(input)) {
    return {success: false, error: 'invalid run summary list: expected array'}
  }

  const seen = new Set()
  const valid = []

  for (const item of input) {
    if (valid.length >= RUN_INDEX_CAP) break

    const parsed = parseRunSummaryItem(item)
    if (!parsed.success) continue

    const {runId} = parsed.data
    if (seen.has(runId)) continue

    seen.add(runId)
    valid.push(parsed.data)
  }

  return {success: true, data: valid}
}

/**
 * Build a closed safe-view from a parsed run summary. Unknown fields excluded by
 * construction. reasonLabel is a pre-resolved dashboard display label — never the
 * raw failureKind — and is present only for a failed summary carrying a known
 * failureKind. Non-failed statuses ignore any failureKind.
 */
export function buildRunSafeView(summary) {
  const statusLabel = STATUS_LABELS[summary.status] ?? summary.status
  const reasonLabel =
    summary.status === 'failed' && summary.failureKind !== undefined
      ? FAILURE_REASON_LABELS[summary.failureKind]
      : undefined

  return {
    runId: summary.runId,
    repo: summary.repo,
    status: summary.status,
    statusLabel,
    createdAt: summary.createdAt,
    ...('updatedAt' in summary ? {updatedAt: summary.updatedAt} : {}),
    ...(reasonLabel === undefined ? {} : {reasonLabel}),
  }
}

/**
 * Fetch the run index from the Gateway.
 * All error classes collapse to {kind: 'unavailable'} — never logs endpoint paths or bodies.
 */
export async function fetchRunIndex(opts) {
  const endpointBase = opts?.endpointBase ?? '/operator'
  const fixtureSessionId = opts?.fixtureSessionId

  const url = fixtureSessionId === undefined
    ? `${endpointBase}/runs`
    : `${endpointBase}/runs?fixtureSessionId=${encodeURIComponent(fixtureSessionId)}`

  // One timer bounds the whole request: the headers AND the body read. It aborts the fetch and also
  // wins a race against the request, so a body that never settles (stalled, or ignoring the abort)
  // still resolves as unavailable and cannot wedge the single-flight refresh.
  const controller = new AbortController()
  let timeoutId
  const timedOut = new Promise(resolve => {
    timeoutId = setTimeout(() => {
      controller.abort()
      resolve({kind: 'unavailable'})
    }, FETCH_TIMEOUT_MS)
  })

  try {
    return await Promise.race([requestRunIndex(url, controller.signal), timedOut])
  } finally {
    clearTimeout(timeoutId)
  }
}

/** The request half of fetchRunIndex: fetch, status check, body read, parse. Never rejects. */
async function requestRunIndex(url, signal) {
  let res
  try {
    res = await globalThis.fetch(url, {
      credentials: 'include',
      redirect: 'error',
      signal,
    })
  } catch {
    return {kind: 'unavailable'}
  }

  if (!res.ok) {
    // Auth signal: 401/403 means the session has expired or is absent. Surfaced
    // separately (never as a distinct render path) so a caller can reclassify the
    // shell state to auth-required instead of resurrecting a stale ready view.
    const authFailure = res.status === 401 || res.status === 403
    return {kind: 'unavailable', authFailure}
  }

  let body
  try {
    body = await res.json()
  } catch {
    return {kind: 'unavailable'}
  }

  // The Gateway wraps run listings in an envelope: {runs: RunSummary[]}.
  // A bare array is no longer accepted — fail closed on contract drift.
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.runs)) {
    return {kind: 'unavailable'}
  }

  const parsed = parseRunSummaryList(body.runs)
  if (!parsed.success) {
    return {kind: 'unavailable'}
  }

  return {kind: 'loaded', summaries: parsed.data}
}

// _runIndexGeneration is a monotonically increasing counter. Each init captures its own
// generation; resetRunIndexState() increments it to invalidate all pending inits.
let _runIndexGeneration = 0
let _runIndexInitialized = false

// Tracks the single runId that currently has an active stream attached.
// Only this run's card is inert; switching to a new run clears the previous card's state.
let _activeStreamRunId = null

// Tracks the single runId whose card is currently expanded (single-open accordion).
// Owned by this DOM shell only — the runtime seam separately owns the stream handle.
let _expandedRunId = null

// The selection handler from the most recent init, retained so a card created
// outside this module (the launch handoff) can be wired for expansion by
// markCardExpandedForLaunch. operator-launch.js is a separate module instance and
// deliberately does not import this one, so it cannot reach toggleCardExpansion.
let _onSelectRun

// Single-flight refresh state (see refreshOperatorRunIndex). The context is what the last init
// that finished its fetch was configured with; it is the only thing a refresh needs from init, and
// its presence is what "init has loaded" means. A reset or an auth failure clears it.
let _refreshContext = null
// The refresh cycle currently fetching/applying, and the one deferred cycle waiting behind it.
let _refreshInFlight = null
let _refreshTrailing = null

function isRunIndexInitStale(generation) {
  return generation !== _runIndexGeneration
}

/**
 * Mark a runId as stream-attached. Called by the runtime seam after attaching a stream.
 * Once marked, card clicks for this runId will not re-trigger onSelectRun.
 * Exported so the runtime seam can call it after initOperatorStream succeeds.
 */
export function markRunStreamAttached(runId) {
  // Unmark the previously active run's card before marking the new one.
  if (_activeStreamRunId !== null && _activeStreamRunId !== runId && typeof document !== 'undefined') {
    const prev = document.querySelector(`[data-run-id="${CSS.escape(_activeStreamRunId)}"]`)
    if (prev !== null) delete prev.dataset.streamAttached
  }
  _activeStreamRunId = runId
  if (typeof document !== 'undefined') {
    const card = document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`)
    if (card !== null) card.dataset.streamAttached = 'true'
  }
}

/** Increment generation to invalidate pending inits. Called by the React runtime seam cleanup. */
export function resetRunIndexState() {
  _runIndexGeneration++
  _runIndexInitialized = false
  if (typeof document !== 'undefined' && _activeStreamRunId !== null) {
    const card = document.querySelector(`[data-run-id="${CSS.escape(_activeStreamRunId)}"]`)
    if (card !== null) delete card.dataset.streamAttached
  }
  _activeStreamRunId = null
  _expandedRunId = null
  _onSelectRun = undefined
  // Settle any request waiting behind an in-flight refresh; the in-flight cycle itself notices the
  // reset when its fetch returns and discards the response.
  _refreshContext = null
  _refreshInFlight = null
  if (_refreshTrailing !== null) {
    _refreshTrailing.resolve(false)
    _refreshTrailing = null
  }
}

/**
 * Load the run list and render it. Resolves with how the load ended, so the caller never has to read
 * it back from the DOM: 'loaded' (cards shown), 'empty' (no runs), 'unavailable' (a non-auth failure,
 * or no document), 'auth-required' (401/403, after onAuthRequired), 'stale' (a reset or a newer init
 * replaced this one while it fetched; it rendered no result and left the loading state to the newer owner).
 */
export async function initOperatorRunIndex(opts) {
  const myGeneration = ++_runIndexGeneration

  const endpointBase = opts?.endpointBase ?? '/operator'
  const fixtureSessionId = opts?.fixtureSessionId
  const onSelectRun = opts?.onSelectRun
  // Reload restore (cold-boot, not a click toggle) — see expandCardForRestore.
  // restoreRunId is pre-sanitized by the runtime seam (length cap + validateDynamicId)
  // before it ever reaches here.
  const restoreRunId = opts?.restoreRunId
  const onRestoreRun = opts?.onRestoreRun
  const onRestoreMiss = opts?.onRestoreMiss
  const onAuthRequired = opts?.onAuthRequired
  const onListApplied = opts?.onListApplied

  if (isRunIndexInitStale(myGeneration)) return 'stale'
  if (typeof document === 'undefined') return 'unavailable'

  if (typeof onSelectRun === 'function') _onSelectRun = onSelectRun

  const runIndexSection = document.querySelector('[data-role="run-index"]')
  const runIndexList = document.querySelector('[data-role="run-index-list"]')
  const runIndexLoading = document.querySelector('[data-role="run-index-loading"]')
  const runIndexEmpty = document.querySelector('[data-role="run-index-empty"]')
  const runIndexUnavailable = document.querySelector('[data-role="run-index-unavailable"]')

  if (runIndexLoading !== null) runIndexLoading.hidden = false
  if (runIndexList !== null) runIndexList.hidden = true
  if (runIndexEmpty !== null) runIndexEmpty.hidden = true
  if (runIndexUnavailable !== null) runIndexUnavailable.hidden = true
  if (runIndexSection !== null) runIndexSection.dataset.state = 'loading'

  const result = await fetchRunIndex({endpointBase, fixtureSessionId})

  // Guard: bail if reset/replaced while awaiting fetch.
  if (isRunIndexInitStale(myGeneration)) return 'stale'

  if (runIndexLoading !== null) runIndexLoading.hidden = true

  // Init has loaded (or failed non-auth): from here a refresh may run, configured as this init was.
  // An auth failure below clears it again — there is no session to refresh against.
  _refreshContext = {endpointBase, fixtureSessionId, onSelectRun, onAuthRequired, onListApplied}

  if (result.kind === 'unavailable') {
    // The /operator/runs fetch itself is the auth re-classification point: a stale
    // or expired session must not resurrect a restored ready view. Report it and
    // skip any restore attempt entirely.
    if (result.authFailure === true && typeof onAuthRequired === 'function') {
      _refreshContext = null
      onAuthRequired()
      return 'auth-required'
    }
    showRunIndexUnavailable({runIndexSection, runIndexUnavailable})
    return 'unavailable'
  }

  const {summaries} = result

  // Always diff — even with zero fetched summaries — so a protected card (active-stream
  // or still-pending optimistic launch card) is correctly retained or resolved rather
  // than skipped by an early empty-state return.
  let remaining = 0
  let views = []
  if (runIndexList !== null) {
    views = summaries.map(buildRunSafeView)
    diffRunIndexList(runIndexList, views, {onSelectRun, activeStreamRunId: _activeStreamRunId})
    remaining = runIndexList.children?.length ?? 0
    reportListApplied(onListApplied, views)
  }

  showRunIndexResult({runIndexSection, runIndexList, runIndexEmpty, runIndexUnavailable}, remaining)

  if (remaining === 0) {
    if (restoreRunId !== undefined && restoreRunId !== null && typeof onRestoreMiss === 'function') {
      onRestoreMiss()
    }
    return 'empty'
  }

  // Reload restore: only after the list has resolved and been diffed. Presence in
  // the fetched view list is required — a runId that aged out of the cap or no
  // longer exists is treated as a miss, never a perpetual attempt.
  //
  // Race guard: the operator can click a card (attaching a stream via the runtime
  // seam, which sets _activeStreamRunId) while this fetch is still in flight. A
  // restore that fires after such a click must never stomp that user selection —
  // check for a card already marked data-stream-attached="true" for a DIFFERENT
  // runId than the one being restored, and skip the restore entirely if found.
  if (restoreRunId !== undefined && restoreRunId !== null) {
    const userSelectedDuringFetch =
      _activeStreamRunId !== null &&
      _activeStreamRunId !== restoreRunId &&
      typeof document !== 'undefined' &&
      document.querySelector(`[data-run-id="${CSS.escape(_activeStreamRunId)}"]`)?.dataset.streamAttached === 'true'

    if (!userSelectedDuringFetch) {
      const matchedView = views.find(v => v.runId === restoreRunId)
      if (matchedView !== undefined) {
        expandCardForRestore(restoreRunId, (runId, card) => {
          if (typeof onRestoreRun === 'function') onRestoreRun(runId, card, matchedView.status)
        })
      } else if (typeof onRestoreMiss === 'function') {
        onRestoreMiss()
      }
    }
  }

  return 'loaded'
}

/**
 * Tell the caller which run IDs the list just applied: the fetched ones, not the cards left in the
 * DOM (a protected card can outlive the list that dropped it). A callback that throws must not break
 * the apply.
 */
function reportListApplied(onListApplied, views) {
  if (typeof onListApplied !== 'function') return
  try {
    onListApplied(views.map(view => view.runId))
  } catch {
    // Nothing here is logged: errors can carry run data.
  }
}

/** The unavailable treatment: the unavailable notice up, section state to match. */
function showRunIndexUnavailable({runIndexSection, runIndexUnavailable}) {
  if (runIndexUnavailable !== null) runIndexUnavailable.hidden = false
  if (runIndexSection !== null) runIndexSection.dataset.state = 'unavailable'
}

/**
 * Show a diffed list's outcome: the empty state when no card remains, the list otherwise, and the
 * unavailable notice down either way. Shared by init and refresh so the two cannot disagree about
 * what a populated or empty list looks like.
 */
function showRunIndexResult({runIndexSection, runIndexList, runIndexEmpty, runIndexUnavailable}, remaining) {
  const isEmpty = remaining === 0
  if (runIndexList !== null) runIndexList.hidden = isEmpty
  if (runIndexEmpty !== null) runIndexEmpty.hidden = !isEmpty
  if (runIndexUnavailable !== null) runIndexUnavailable.hidden = true
  if (runIndexSection !== null) runIndexSection.dataset.state = isEmpty ? 'empty' : 'loaded'
}

/**
 * One refresh cycle: fetch, then diff the list in place. Never rejects; resolves true only when
 * fetched data was applied.
 *
 * Differences from init, on purpose: no loading toggle (the visible list stays put), no restore
 * handling, and a non-auth failure — 429, network, bad body, any other status — keeps the current
 * list untouched instead of showing the unavailable state. The stream-attached card is never written:
 * diffRunIndexList protects it. A DOM move blurs a focused node, so the focused card is refocused
 * afterwards with preventScroll.
 *
 * It does not touch _runIndexGeneration, so it cannot invalidate an in-flight init; it captures the
 * generation and context instead, and drops its response if either changed (a reset or a new init)
 * while it was fetching.
 */
async function applyRefresh() {
  const context = _refreshContext
  if (context === null || typeof document === 'undefined') return false
  const generation = _runIndexGeneration

  try {
    const result = await fetchRunIndex({endpointBase: context.endpointBase, fixtureSessionId: context.fixtureSessionId})
    if (isRunIndexInitStale(generation) || _refreshContext !== context) return false

    if (result.kind === 'unavailable') {
      if (result.authFailure === true) {
        // No session: stop refreshing and let the shell reclassify, exactly as init does.
        _refreshContext = null
        if (typeof context.onAuthRequired === 'function') context.onAuthRequired()
      }
      return false
    }

    const runIndexSection = document.querySelector('[data-role="run-index"]')
    const runIndexList = document.querySelector('[data-role="run-index-list"]')
    const runIndexEmpty = document.querySelector('[data-role="run-index-empty"]')
    const runIndexUnavailable = document.querySelector('[data-role="run-index-unavailable"]')

    const focused = runIndexList !== null && runIndexList !== undefined ? focusedElementWithin(runIndexList) : null

    let remaining = 0
    if (runIndexList !== null) {
      const views = result.summaries.map(buildRunSafeView)
      diffRunIndexList(runIndexList, views, {onSelectRun: context.onSelectRun, activeStreamRunId: _activeStreamRunId})
      remaining = runIndexList.children?.length ?? 0
      reportListApplied(context.onListApplied, views)
    }

    showRunIndexResult({runIndexSection, runIndexList, runIndexEmpty, runIndexUnavailable}, remaining)
    if (focused !== null) restoreFocus(runIndexList, focused)
    return true
  } catch {
    // Keep the current list. Nothing here is logged: errors can carry run data.
    return false
  }
}

/** The document's focused element when it lives inside the list, else null. */
function focusedElementWithin(list) {
  const active = document.activeElement
  if (active === null || active === undefined) return null
  return typeof list.contains === 'function' && list.contains(active) ? active : null
}

/** Put focus back on an element a DOM move blurred, without scrolling. A removed element stays unfocused. */
function restoreFocus(list, element) {
  if (document.activeElement === element) return
  if (typeof list.contains !== 'function' || !list.contains(element)) return
  if (typeof element.focus === 'function') element.focus({preventScroll: true})
}

/**
 * Refresh the run list in place. Single-flight: at most one fetch runs at a time, and a request
 * that arrives meanwhile joins ONE deferred refresh that starts when the running one finishes — so
 * responses can never be applied out of order, and a request is never answered with data fetched
 * before it was made. Every request during the same flight shares the deferred refresh's promise.
 *
 * The promise settles once its data has been applied (or dropped): true when fresh data was
 * applied, false on a failure, a stale generation, or when init has not loaded yet (a no-op that
 * does not fetch). It never rejects.
 *
 * Callers (runtime.ts): the 30-second interval, becoming visible, expand, and a notification jump.
 */
export function refreshOperatorRunIndex() {
  if (_refreshContext === null) return Promise.resolve(false)
  if (_refreshInFlight === null) return startRefreshCycle()

  if (_refreshTrailing === null) {
    let resolve
    const promise = new Promise(res => {
      resolve = res
    })
    _refreshTrailing = {promise, resolve}
  }
  return _refreshTrailing.promise
}

function startRefreshCycle() {
  const cycle = applyRefresh()
  _refreshInFlight = cycle
  cycle.then(() => {
    // A reset replaced the state while this cycle ran; it has already settled the trailing waiter.
    if (_refreshInFlight !== cycle) return
    const trailing = _refreshTrailing
    _refreshTrailing = null
    if (trailing === null) {
      _refreshInFlight = null
      return
    }
    _refreshInFlight = null
    trailing.resolve(_refreshContext === null ? false : startRefreshCycle())
  })
  return cycle
}

/** Terminal run-summary statuses — a card in one of these will not progress further. */
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Reconcile the run-index list in place, keyed by runId.
 *
 * Never clears the container wholesale. Existing cards are updated or adopted;
 * missing runIds are removed unless protected (see below); new runIds get a
 * freshly rendered card inserted at the fetched position.
 *
 * Active-card ownership boundary: the card whose runId matches opts.activeStreamRunId
 * (corroborated by data-stream-attached="true") is treated as a write-protected black
 * box — no attribute or text write of any kind, and it is never replaced, only possibly
 * repositioned via a Node move that preserves element identity. updateDOM (operator-stream.js)
 * is the sole writer to that card's substructure.
 *
 * Order: the list follows the fetched order for every card. The gateway sorts by createdAt,
 * which never changes, so existing cards keep their relative order; a new run lands on top.
 * A protected card the fetch no longer lists stays behind the fetched cards, at the end — except an
 * unlisted optimistic launch card at the head of the list, which stays there (it is the newest run,
 * not yet indexed) until a fetch lists it.
 *
 * Protected-card identification (optimistic launch): a DOM card absent from the fetched
 * view list is preserved when it is the active-stream card, OR when it carries
 * data-optimistic="true" and its own run-status element does not yet show a terminal
 * status class (i.e. the stream has not resolved it to terminal). Once a launch-created
 * card's stream resolves to terminal while still absent from the fetch, it is no longer
 * protected and is removed on the next diff — it is never left as a perpetual ghost.
 *
 * Allowed attribute mutations for a non-active, non-protected-absent card are a closed
 * set: data-run-id (immutable, set once at create), datetime (on <time>, from the
 * length-capped updatedAt already validated by parseRunSummaryItem), className
 * (allowlist-gated `.status-*` only), and textContent on the safe-view text children
 * (run-status label, run-repo text, run-updated-at text). Adoption of a launch-seeded <time>
 * also removes that <time>, or its data-time-source marker, as the list's updatedAt takes over.
 * No data-repo/data-status or other run-metadata attribute is ever created.
 */
function diffRunIndexList(list, views, opts) {
  const onSelectRun = opts?.onSelectRun
  const activeStreamRunId = opts?.activeStreamRunId ?? null

  // Snapshot existing cards by runId before mutating anything.
  const existingCards = new Map()
  for (const child of Array.from(list.children ?? [])) {
    const runId = child.dataset?.runId
    if (typeof runId === 'string') existingCards.set(runId, child)
  }

  const fetchedIds = new Set(views.map(v => v.runId))

  // Removal pass: drop cards absent from the fetch unless protected.
  for (const [runId, card] of existingCards) {
    if (fetchedIds.has(runId)) continue

    const isActive = runId === activeStreamRunId && card.dataset.streamAttached === 'true'
    if (isActive) continue // active-stream card is always protected, even if absent

    const isOptimistic = card.dataset.optimistic === 'true'
    if (isOptimistic && !cardShowsTerminalStatus(card)) continue // stream still active — keep

    // Neither active-stream nor a still-pending optimistic card: safe to remove.
    card.remove()
    existingCards.delete(runId)
  }

  // The list follows fetch order for every card. The gateway sorts by createdAt, which never
  // changes for a run, so existing cards never reorder: the only changes are new runs at the top
  // and old runs dropping off the end. A protected card the fetch no longer lists is not in this
  // order, so the walk below leaves it behind the fetched cards, at the end of the list.
  const targetOrder = views.map(v => v.runId)
  const viewsByRunId = new Map(views.map(v => [v.runId, v]))

  // An unlisted optimistic launch card is the newest run, so it stays at the head of the list until
  // the gateway indexes it (the list is newest-first). Start the walk after any such leading cards.
  let cursor = list.firstChild
  while (cursor !== null && cursor !== undefined && isUnlistedOptimisticCard(cursor, fetchedIds)) {
    cursor = cursor.nextSibling
  }

  // Update/create/reposition pass, walking the target order.
  for (const runId of targetOrder) {
    const view = viewsByRunId.get(runId)
    let card = existingCards.get(runId)

    if (card === undefined) {
      // New card — view is guaranteed to exist here (targetOrder only contains fetched runIds).
      card = renderRunCard(view, onSelectRun)
      if (cursor === null || cursor === undefined) {
        list.append(card)
      } else {
        cursor.before(card)
      }
      continue
    }

    const isActive = runId === activeStreamRunId && card.dataset.streamAttached === 'true'

    if (!isActive && view !== undefined) {
      // Non-active card with a fetched view: normal in-place attribute update is
      // safe (no concurrent writer).
      if (card.dataset.optimistic === 'true') {
        // First non-active adoption of a launch-created card: it was built with
        // only the status anatomy, so add what a fetched card has (repo, time,
        // cancel region, role, expansion listeners) before filling it from the view.
        ensureRunCardAnatomy(card, view, onSelectRun)
      }
      updateCardInPlace(card, view)
      if (card.dataset.optimistic === 'true') delete card.dataset.optimistic
    }
    // Active card: write-protected — updateDOM remains the substructure's sole writer.
    // It is still moved to its fetch slot (a Node move keeps its identity).

    if (card === cursor) {
      cursor = cursor.nextSibling
    } else if (cursor === null || cursor === undefined) {
      list.append(card)
    } else {
      cursor.before(card)
    }
  }
}

/** True iff a card is an optimistic launch card the fetch does not list. */
function isUnlistedOptimisticCard(card, fetchedIds) {
  return card.dataset?.optimistic === 'true' && !fetchedIds.has(card.dataset.runId)
}

/** True iff a card's own run-status element already shows a terminal status class. */
function cardShowsTerminalStatus(card) {
  if (typeof card.querySelector !== 'function') return false
  const statusEl = card.querySelector('[data-role="run-status"]')
  if (statusEl === null || statusEl === undefined) return false
  const className = typeof statusEl.className === 'string' ? statusEl.className : ''
  for (const token of className.split(/\s+/)) {
    const status = summaryStatusFromClassToken(token)
    if (status !== undefined && TERMINAL_RUN_STATUSES.has(status)) return true
  }
  return false
}

/**
 * Hand a launch-seeded <time> (data-time-source="launch") to the list: write the view's updatedAt
 * and drop the marker, or remove the <time> when the view has none (renderRunCard omits it too).
 */
function adoptLaunchSeededTime(card, view) {
  if (typeof card.querySelector !== 'function') return
  const timeEl = card.querySelector('[data-role="run-updated-at"]')
  if (timeEl === null || timeEl === undefined || timeEl.dataset?.timeSource !== LAUNCH_TIME_SOURCE) return

  if ('updatedAt' in view && view.updatedAt !== undefined) {
    timeEl.setAttribute('datetime', view.updatedAt)
    timeEl.textContent = formatRelativeTime(view.updatedAt)
    delete timeEl.dataset.timeSource
  } else {
    timeEl.remove()
  }
}

/**
 * Update a card's safe-view-derived fields in place. Closed attribute-mutation set:
 * className (status-* only), textContent (safe-view text children), datetime (on <time>),
 * plus removing a launch-seeded <time> and its data-time-source marker on adoption.
 * Never touches data-run-id or data-expanded on the card itself. The one structural
 * addition is a missing <time> (see below), built with the same safe-DOM shape as renderRunCard.
 * Never called for the active-stream card (the diff write-protects it).
 *
 * Terminal is sticky: a card already showing succeeded/failed/cancelled never takes a
 * non-terminal view. A run ID never returns to a non-terminal status once terminal (a launch
 * mints a fresh ID), so such a view is stale — a list fetched before the run finished, or one
 * racing the stream's own terminal write. The whole update is skipped: the label, aria-label and
 * reason all describe the terminal status and must stay together. Terminal → terminal and
 * non-terminal → anything still update.
 */
function updateCardInPlace(card, view) {
  // Before the sticky return: a stale view must not leave the card on its launch-seeded time.
  adoptLaunchSeededTime(card, view)
  if (!TERMINAL_RUN_STATUSES.has(view.status) && cardShowsTerminalStatus(card)) return

  card.setAttribute(
    'aria-label',
    `Run, status: ${view.statusLabel}${view.reasonLabel === undefined ? '' : `, reason: ${view.reasonLabel}`}`,
  )

  if (typeof card.querySelector === 'function') {
    const statusEl = card.querySelector('[data-role="run-status"]')
    if (statusEl !== null && statusEl !== undefined) {
      statusEl.className = statusClassName(view.status)
      statusEl.textContent = view.statusLabel
    }

    const repoEl = card.querySelector('[data-role="run-repo"]')
    if (repoEl !== null && repoEl !== undefined) {
      repoEl.textContent = view.repo
    }

    if ('updatedAt' in view && view.updatedAt !== undefined) {
      let timeEl = card.querySelector('[data-role="run-updated-at"]')
      if (timeEl === null || timeEl === undefined) {
        // A card first rendered/adopted without updatedAt gains its <time> the first
        // time a view carries one — same class/role/slot as renderRunCard gives it.
        timeEl = document.createElement('time')
        timeEl.className = 'run-updated-at'
        timeEl.dataset.role = 'run-updated-at'
        insertBeforeFirstRole(card, timeEl, SUBSTRUCTURE_ROLES)
      }
      timeEl.setAttribute('datetime', view.updatedAt)
      timeEl.textContent = formatRelativeTime(view.updatedAt)
    }

    const reasonEl = card.querySelector('[data-role="run-reason"]')
    if (reasonEl !== null && reasonEl !== undefined) {
      reasonEl.textContent = view.reasonLabel ?? ''
      if (view.reasonLabel === undefined) {
        if (reasonEl.dataset) delete reasonEl.dataset.reasonState
      } else if (reasonEl.dataset) {
        reasonEl.dataset.reasonState = 'present'
      }
    }
  }
}

/** The card badge's class list: the base class plus the status token from the map. */
function statusClassName(status) {
  return Object.hasOwn(RUN_STATUS_CLASS_TOKENS, status) ? `run-status ${RUN_STATUS_CLASS_TOKENS[status]}` : 'run-status'
}

/** Safe DOM writes only — no innerHTML for Gateway content. */
function renderRunCard(view, onSelectRun) {
  const card = document.createElement('div')
  card.className = 'run-card'
  card.tabIndex = 0
  card.setAttribute('role', 'button')
  card.setAttribute(
    'aria-label',
    `Run, status: ${view.statusLabel}${view.reasonLabel === undefined ? '' : `, reason: ${view.reasonLabel}`}`,
  )
  card.dataset.testid = 'run-card'
  card.dataset.runId = view.runId

  const statusGroup = document.createElement('span')
  statusGroup.className = 'run-status-group'
  statusGroup.dataset.role = 'run-status-group'

  const statusSpan = document.createElement('span')
  statusSpan.className = statusClassName(view.status)
  statusSpan.dataset.role = 'run-status'
  statusSpan.textContent = view.statusLabel
  statusGroup.append(statusSpan)

  const reasonSpan = document.createElement('span')
  reasonSpan.className = 'run-reason'
  reasonSpan.dataset.role = 'run-reason'
  reasonSpan.textContent = view.reasonLabel ?? ''
  if (view.reasonLabel !== undefined) reasonSpan.dataset.reasonState = 'present'
  statusGroup.append(reasonSpan)

  card.append(statusGroup)

  const repoSpan = document.createElement('span')
  repoSpan.className = 'run-repo'
  repoSpan.dataset.role = 'run-repo'
  repoSpan.textContent = view.repo
  card.append(repoSpan)

  // Timestamp — only render updatedAt when present
  if ('updatedAt' in view && view.updatedAt !== undefined) {
    const timeEl = document.createElement('time')
    timeEl.className = 'run-updated-at'
    timeEl.dataset.role = 'run-updated-at'
    timeEl.setAttribute('datetime', view.updatedAt)
    timeEl.textContent = formatRelativeTime(view.updatedAt)
    card.append(timeEl)
  }

  // Hidden per-card substructure — targets for operator-stream.js's updateDOM().
  // Shown only by the stream's paint, never by expand. Safe-DOM only: createElement + textContent/
  // hidden/dataset, never innerHTML. No run field beyond the closed safe-view
  // reaches these elements at creation time.

  // Checkout-detail region — the stream renders what a run started from (provenance) or
  // why checkout preparation refused/failed, here. SLOT: the first hidden region, directly
  // after the header row (status group, repo, time) and before run-output, so on expansion
  // the checkout facts sit right under the status/reason line. Every card shape (this
  // renderer, the optimistic launch card, and ensureRunCardAnatomy) places it in this slot.
  const checkoutEl = document.createElement('div')
  checkoutEl.dataset.role = CHECKOUT_DETAIL_ROLE
  checkoutEl.hidden = true
  card.append(checkoutEl)

  // Waiting line — the stream shows it while nothing else is showing. SLOT: right below checkout.
  const waitingEl = document.createElement('div')
  waitingEl.dataset.role = WAITING_ROLE
  waitingEl.hidden = true
  card.append(waitingEl)

  const outputEl = document.createElement('div')
  outputEl.dataset.role = 'run-output'
  outputEl.hidden = true
  card.append(outputEl)

  // Output toolbar — directly after run-output. Populated and shown by the stream.
  const outputToolsEl = document.createElement('div')
  outputToolsEl.dataset.role = OUTPUT_TOOLS_ROLE
  outputToolsEl.hidden = true
  card.append(outputToolsEl)

  const coalescedEl = document.createElement('div')
  coalescedEl.dataset.role = 'run-output-coalesced'
  coalescedEl.hidden = true
  card.append(coalescedEl)

  const approvalsEl = document.createElement('div')
  approvalsEl.dataset.role = 'run-approvals'
  approvalsEl.hidden = true
  card.append(approvalsEl)

  // Question region — directly after run-approvals. Rendered into by the stream; the runtime
  // seam passes it to initOperatorStream as questionsEl.
  const questionsEl = document.createElement('div')
  questionsEl.dataset.role = QUESTIONS_ROLE
  questionsEl.hidden = true
  card.append(questionsEl)

  const badgeEl = document.createElement('span')
  badgeEl.dataset.role = 'approval-badge'
  badgeEl.hidden = true
  card.append(badgeEl)

  // Cancel control region — a sibling to run-approvals. Populated by
  // initOperatorStream (operator-stream.js) via the runtime seam once a stream
  // attaches; gated on non-terminal status there. Safe-DOM only at creation.
  const cancelEl = document.createElement('div')
  cancelEl.dataset.role = 'run-cancel'
  cancelEl.hidden = true
  card.append(cancelEl)

  // Wire click and keyboard activation to the expand/collapse toggle.
  bindCardActivation(card, view.runId, onSelectRun)

  return card
}

/**
 * Cards that already carry the click/keydown expansion listeners. Listener
 * registration is idempotent per card: a launch-created card is wired once by
 * markCardExpandedForLaunch and must not be re-bound when a later diff adopts it.
 * A WeakSet (not a data-* attribute) keeps the closed attribute set intact.
 */
const _activatableCards = new WeakSet()

/**
 * Wire click and Enter/Space activation to the expand/collapse toggle, at most
 * once per card. No-op when onSelectRun is not a function (card stays inert, as
 * with a fetched card rendered without a selection handler).
 */
function bindCardActivation(card, runId, onSelectRun) {
  if (typeof onSelectRun !== 'function') return
  if (_activatableCards.has(card)) return
  _activatableCards.add(card)

  const activate = () => {
    toggleCardExpansion(card, runId, onSelectRun)
  }
  card.addEventListener('click', event => {
    if (clickBelongsToContent(card, event)) return
    activate()
  })
  card.addEventListener('keydown', e => {
    // Keys bubbling up from nested controls (e.g. the run-cancel buttons) belong to
    // those controls: only a keydown on the card itself toggles expansion.
    if (e.target !== card) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (e.key === ' ') e.preventDefault()
    activate()
  })
}

/**
 * Whether a click belongs to the card's content, not the card itself: it landed on a link or
 * a button inside the card, or the reader is selecting text there. Such a click never toggles the card.
 * This guard is the only mechanism: nothing inside the card stops propagation for it.
 */
function clickBelongsToContent(card, event) {
  const target = event?.target
  if (target !== card && typeof target?.closest === 'function') {
    const control = target.closest('a[href], button')
    if (control !== null && control !== undefined && (typeof card.contains !== 'function' || card.contains(control))) return true
  }
  return selectionInside(card)
}

/** True when a non-collapsed text selection starts or ends inside `card`. */
function selectionInside(card) {
  if (typeof card.contains !== 'function') return false
  const doc = card.ownerDocument ?? globalThis.document
  const selection = typeof doc?.getSelection === 'function' ? doc.getSelection() : null
  if (selection === null || selection === undefined || selection.isCollapsed || selection.rangeCount === 0) return false
  return card.contains(selection.anchorNode) || card.contains(selection.focusNode)
}

/**
 * Insert `el` before the first of the card's direct children matching one of
 * `roles` (so late-added anatomy lands in the same slot renderRunCard gives it),
 * or append when none exist. Safe-DOM only.
 */
function insertBeforeFirstRole(card, el, roles) {
  for (const role of roles) {
    const ref = card.querySelector(`[data-role="${role}"]`)
    if (ref !== null && ref !== undefined && typeof ref.before === 'function') {
      ref.before(el)
      return
    }
  }
  card.append(el)
}

/**
 * Upgrade a launch-created (optimistic) card to full fetched-card anatomy IN PLACE.
 *
 * In place, not replace-with-renderRunCard, on purpose: the runtime seam and
 * operator-stream.js hold references into the optimistic card's substructure
 * (run-status element, etc.), and node identity also preserves DOM position, the
 * expanded state, and focus. Replacing the node would orphan those references.
 *
 * Idempotent: only creates what is missing and binds listeners at most once, so
 * repeated calls never duplicate elements or handlers. Never called on the
 * active-stream card (the caller guards) — that card is write-protected.
 * Text/datetime values (and the <time> element, which any card may gain late) are
 * handled by updateCardInPlace; this only adds the remaining anatomy.
 * Safe-DOM only: createElement + dataset.role/className, never innerHTML.
 */
function ensureRunCardAnatomy(card, view, onSelectRun) {
  card.setAttribute('role', 'button')
  card.tabIndex = 0

  if (card.querySelector('[data-role="run-repo"]') === null) {
    const repoSpan = document.createElement('span')
    repoSpan.className = 'run-repo'
    repoSpan.dataset.role = 'run-repo'
    insertBeforeFirstRole(card, repoSpan, ['run-updated-at', ...SUBSTRUCTURE_ROLES])
  }

  // Checkout-detail region: same slot renderRunCard gives it (ahead of every other
  // hidden region). Only created when missing — exactly one per card, however often
  // the diff re-adopts it.
  if (card.querySelector(`[data-role="${CHECKOUT_DETAIL_ROLE}"]`) === null) {
    const checkoutEl = document.createElement('div')
    checkoutEl.dataset.role = CHECKOUT_DETAIL_ROLE
    checkoutEl.hidden = true
    insertBeforeFirstRole(card, checkoutEl, SUBSTRUCTURE_ROLES)
  }

  // Waiting line: same slot renderRunCard gives it (below checkout, ahead of the output regions).
  // The role list leaves out checkout so the line always lands after it.
  if (card.querySelector(`[data-role="${WAITING_ROLE}"]`) === null) {
    const waitingEl = document.createElement('div')
    waitingEl.dataset.role = WAITING_ROLE
    waitingEl.hidden = true
    insertBeforeFirstRole(card, waitingEl, SUBSTRUCTURE_ROLES.filter(role => role !== CHECKOUT_DETAIL_ROLE && role !== WAITING_ROLE))
  }

  // Output toolbar: same slot renderRunCard gives it (right after run-output, ahead of every later
  // region). Only created when missing — exactly one per card.
  if (card.querySelector(`[data-role="${OUTPUT_TOOLS_ROLE}"]`) === null) {
    const outputToolsEl = document.createElement('div')
    outputToolsEl.dataset.role = OUTPUT_TOOLS_ROLE
    outputToolsEl.hidden = true
    insertBeforeFirstRole(card, outputToolsEl, SUBSTRUCTURE_ROLES.slice(SUBSTRUCTURE_ROLES.indexOf(OUTPUT_TOOLS_ROLE) + 1))
  }

  // Question region: same slot renderRunCard gives it (after run-approvals, ahead of the badge
  // and cancel regions). Only created when missing — exactly one per card.
  if (card.querySelector(`[data-role="${QUESTIONS_ROLE}"]`) === null) {
    const questionsEl = document.createElement('div')
    questionsEl.dataset.role = QUESTIONS_ROLE
    questionsEl.hidden = true
    insertBeforeFirstRole(card, questionsEl, ['approval-badge', 'run-cancel'])
  }

  if (card.querySelector('[data-role="run-cancel"]') === null) {
    const cancelEl = document.createElement('div')
    cancelEl.dataset.role = 'run-cancel'
    cancelEl.hidden = true
    card.append(cancelEl)
  }

  bindCardActivation(card, view.runId, onSelectRun)
}

/**
 * Toggle a card's expanded state, hiding its per-card substructure on collapse.
 *
 * Single-open accordion: expanding a card first collapses whichever other card
 * is currently expanded (hides its substructure, clears its data-expanded)
 * before expanding the clicked one. Selecting an already-expanded card
 * collapses it instead. In both cases onSelectRun(runId) is called — the
 * runtime seam owns the actual stream attach/close; this DOM shell only owns
 * data-expanded and collapsing the substructure; the stream reveals regions.
 *
 * Safe-DOM only: toggles `hidden` and `dataset.expanded`, never innerHTML.
 */
function toggleCardExpansion(card, runId, onSelectRun) {
  const isExpanded = card.dataset.expanded === 'true'

  if (!isExpanded && _expandedRunId !== null && _expandedRunId !== runId && typeof document !== 'undefined') {
    const prevCard = document.querySelector(`[data-run-id="${CSS.escape(_expandedRunId)}"]`)
    if (prevCard !== null && prevCard !== undefined) {
      prevCard.dataset.expanded = 'false'
      hideSubstructure(prevCard)
    }
  }

  card.dataset.expanded = isExpanded ? 'false' : 'true'
  // Collapse hides; expand shows nothing, since the stream's paint is the only thing that reveals a region.
  if (isExpanded) hideSubstructure(card)
  _expandedRunId = isExpanded ? null : runId

  onSelectRun(runId)
}

/**
 * Mark a card as expanded because a launch (or restore) just attached its stream —
 * NOT a click toggle.
 *
 * A freshly-launched run's card is inserted collapsed by operator-launch.js, then
 * its stream is attached immediately via the runtime seam's onRunLaunched handoff.
 * Without this entry point, the card would look collapsed while its stream is
 * already live, and the operator's first click on it would be misread by
 * onSelectRun as "collapse the active stream" instead of "expand." Calling this
 * right after the stream attaches keeps the DOM shell's _expandedRunId bookkeeping
 * and the card's expansion state consistent with the runtime seam's active
 * stream state, so the first real click correctly collapses instead of the stream
 * silently closing on attach.
 *
 * Idempotent and non-toggling: it only ever expands the target card (mirrors
 * expandCardForRestore's single-open bookkeeping) and does nothing if the card is
 * already expanded.
 *
 * Safe-DOM only: toggles `hidden` and `dataset.expanded`, never innerHTML.
 */
export function markCardExpandedForLaunch(runId) {
  if (typeof document === 'undefined') return
  const card = document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`)
  if (card === null || card === undefined) return

  // Make the launch-created card operable before any fetch adopts it: bind the
  // same click/Enter/Space expansion wiring a fetched card has. Idempotent, and
  // touches only listeners — never the stream-owned substructure.
  bindCardActivation(card, runId, _onSelectRun)

  if (card.dataset.expanded === 'true') return // already expanded — nothing to do

  if (_expandedRunId !== null && _expandedRunId !== runId) {
    const prevCard = document.querySelector(`[data-run-id="${CSS.escape(_expandedRunId)}"]`)
    if (prevCard !== null && prevCard !== undefined) {
      prevCard.dataset.expanded = 'false'
      hideSubstructure(prevCard)
    }
  }

  card.dataset.expanded = 'true'
  _expandedRunId = runId
}

/**
 * Expand a card as a cold-boot reload restore — NOT a toggle.
 *
 * toggleCardExpansion assumes a prior DOM click: re-selecting the already-expanded
 * card collapses it. A hash-restore on mount has no such prior state to toggle
 * against, so this is a distinct, idempotent "set expanded" entry point: it always
 * expands (never collapses) the target card, and does so at most once per mount
 * (initOperatorRunIndex only calls it after a resolved fetch confirms the runId is
 * present). Mirrors toggleCardExpansion's single-open bookkeeping (collapsing any
 * other expanded card first) without reusing its click-toggle branch.
 *
 * Safe-DOM only: toggles `hidden` and `dataset.expanded`, never innerHTML. Never
 * writes to the notice/status DOM directly — that stays initOperatorStream's
 * responsibility via the onExpand callback's stream-attach decision.
 */
function expandCardForRestore(runId, onExpand) {
  if (typeof document === 'undefined') return
  const card = document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`)
  if (card === null || card === undefined) return
  if (card.dataset.expanded === 'true') return // already expanded — nothing to do

  if (_expandedRunId !== null && _expandedRunId !== runId) {
    const prevCard = document.querySelector(`[data-run-id="${CSS.escape(_expandedRunId)}"]`)
    if (prevCard !== null && prevCard !== undefined) {
      prevCard.dataset.expanded = 'false'
      hideSubstructure(prevCard)
    }
  }

  card.dataset.expanded = 'true'
  _expandedRunId = runId

  onExpand(runId, card)
}

/** Hide a card's per-card substructure regions. Only the stream shows one. */
function hideSubstructure(card) {
  if (typeof card.querySelector !== 'function') return
  for (const role of SUBSTRUCTURE_ROLES) {
    const el = card.querySelector(`[data-role="${role}"]`)
    if (el !== null && el !== undefined) el.hidden = true
  }
}

const _initOperatorRunIndexOnce = async opts => {
  if (_runIndexInitialized) return
  _runIndexInitialized = true
  await initOperatorRunIndex(opts)
}

// Auto-start in the browser. When imported with ?manual=1 (by the React runtime seam),
// auto-start is skipped so the seam has deterministic lifecycle control.
if (typeof document !== 'undefined') {
  const isManual = (() => {
    try {
      return new URL(import.meta.url).searchParams.has('manual')
    } catch {
      return false
    }
  })()
  if (!isManual) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        _initOperatorRunIndexOnce()
      })
    } else {
      _initOperatorRunIndexOnce()
    }
  }
}
