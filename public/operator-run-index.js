/**
 * Operator run index — pure core + thin DOM shell.
 *
 * Security invariants:
 * - Never log run summaries, run IDs, repo names, Gateway bodies, or endpoint paths.
 * - Render only safe fields from a closed safe-view; never spread raw payloads.
 * - All error classes collapse to one neutral unavailable treatment.
 * - credentials:'include', redirect:'error' on all fetch calls.
 */

export const RUN_INDEX_CAP = 100

/** Timeout for the /runs fetch — matches server-side Gateway fetch timeout precedent. */
export const FETCH_TIMEOUT_MS = 10_000

const MAX_ID_LENGTH = 512
const MAX_DATE_LENGTH = 128

/** 'blocked' and 'waiting_for_approval' are stream-only — never produced by the run-summary projector. */
export const VALID_RUN_SUMMARY_STATUSES = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

/** Render labels from this map, never the raw wire string. */
const STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

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
  'workspace-unreachable': 'Workspace unavailable',
  'session-error': 'Session error',
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

  if (typeof candidate.createdAt !== 'string' || candidate.createdAt.length > MAX_DATE_LENGTH) {
    return {success: false, error: 'invalid run summary shape'}
  }

  // updatedAt is optional — if present must be a length-capped string
  if (
    'updatedAt' in candidate &&
    (typeof candidate.updatedAt !== 'string' || candidate.updatedAt.length > MAX_DATE_LENGTH)
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
 * Format an ISO timestamp as a coarse relative time string.
 * Returns 'just now', 'N minute(s) ago', 'N hour(s) ago', or 'N day(s) ago'.
 */
export function formatRelativeTime(isoString, nowMs = Date.now()) {
  if (!isoString) return ''
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''

  const diff = Math.max(0, nowMs - date.getTime())
  if (diff < 60_000) return 'just now'

  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`

  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
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

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let res
  try {
    res = await globalThis.fetch(url, {
      credentials: 'include',
      redirect: 'error',
      signal: controller.signal,
    })
  } catch {
    return {kind: 'unavailable'}
  } finally {
    clearTimeout(timeoutId)
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
}

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

  if (isRunIndexInitStale(myGeneration)) return
  if (typeof document === 'undefined') return

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
  if (isRunIndexInitStale(myGeneration)) return

  if (runIndexLoading !== null) runIndexLoading.hidden = true

  if (result.kind === 'unavailable') {
    // The /operator/runs fetch itself is the auth re-classification point: a stale
    // or expired session must not resurrect a restored ready view. Report it and
    // skip any restore attempt entirely.
    if (result.authFailure === true && typeof onAuthRequired === 'function') {
      onAuthRequired()
      return
    }
    if (runIndexUnavailable !== null) runIndexUnavailable.hidden = false
    if (runIndexSection !== null) runIndexSection.dataset.state = 'unavailable'
    return
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
  }

  if (remaining === 0) {
    if (runIndexList !== null) runIndexList.hidden = true
    if (runIndexEmpty !== null) runIndexEmpty.hidden = false
    if (runIndexSection !== null) runIndexSection.dataset.state = 'empty'
    if (restoreRunId !== undefined && restoreRunId !== null && typeof onRestoreMiss === 'function') {
      onRestoreMiss()
    }
    return
  }

  if (runIndexList !== null) {
    runIndexList.hidden = false
  }

  if (runIndexSection !== null) {
    runIndexSection.dataset.state = 'loaded'
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
 * Re-sort lock: the currently expanded card (_expandedRunId) is never repositioned by
 * this diff, even if its status flips to terminal mid-stream. Its position is frozen
 * until it collapses.
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
 * (run-status label, run-repo text, run-updated-at text). No data-repo/data-status or
 * other run-metadata attribute is ever created.
 */
function diffRunIndexList(list, views, opts) {
  const onSelectRun = opts?.onSelectRun
  const activeStreamRunId = opts?.activeStreamRunId ?? null

  // Snapshot existing DOM order and cards by runId before mutating anything.
  const existingOrder = []
  const existingCards = new Map()
  for (const child of Array.from(list.children ?? [])) {
    const runId = child.dataset?.runId
    if (typeof runId === 'string') {
      existingCards.set(runId, child)
      existingOrder.push(runId)
    }
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

  // Re-sort lock: the currently expanded card (if it still exists) must not move
  // relative to its siblings, even though the fetched order may rank it elsewhere
  // (e.g. it flipped to terminal and would otherwise sort below active runs).
  // Compute a target order that respects the fetch order for every OTHER card,
  // but reinserts the frozen runId back at its current relative DOM index.
  const frozenRunId = _expandedRunId
  const frozenCardStillPresent = frozenRunId !== null && existingCards.has(frozenRunId)

  let targetOrder = views.map(v => v.runId)
  if (frozenCardStillPresent) {
    // Position among the cards that survived removal, in their original relative order.
    const survivingOriginalOrder = existingOrder.filter(id => existingCards.has(id))
    const frozenIndexAmongSurvivors = survivingOriginalOrder.indexOf(frozenRunId)

    const withoutFrozen = targetOrder.filter(id => id !== frozenRunId)
    // Clamp so a frozen card at/after the end of the surviving list still lands validly.
    const insertAt = Math.min(frozenIndexAmongSurvivors, withoutFrozen.length)
    withoutFrozen.splice(insertAt < 0 ? withoutFrozen.length : insertAt, 0, frozenRunId)
    targetOrder = withoutFrozen
  }

  const viewsByRunId = new Map(views.map(v => [v.runId, v]))

  // Update/create/reposition pass, walking the computed target order.
  let cursor = list.firstChild
  for (const runId of targetOrder) {
    const view = viewsByRunId.get(runId)
    let card = existingCards.get(runId)

    if (card === undefined) {
      // New card — view is guaranteed to exist here (targetOrder only contains
      // fetched runIds plus, at most, the still-present frozen runId).
      card = renderRunCard(view, onSelectRun)
      if (cursor === null || cursor === undefined) {
        list.append(card)
      } else {
        cursor.before(card)
      }
      continue
    }

    const isActive = runId === activeStreamRunId && card.dataset.streamAttached === 'true'
    const isFrozen = runId === frozenRunId

    if (!isActive && view !== undefined) {
      // Non-active card with a fetched view: normal in-place attribute update is
      // safe (no concurrent writer). A frozen-but-fetched card is still updated
      // in place (status/label/time) — only its DOM position is locked.
      updateCardInPlace(card, view)
      if (card.dataset.optimistic === 'true') delete card.dataset.optimistic
    }
    // Active card, or a frozen card absent from the fetch: write-protected —
    // updateDOM (or the prior state) remains the substructure's sole writer.

    if (isFrozen) {
      // Never reposition the frozen card itself, but do advance the cursor past
      // it so subsequent cards in this pass are inserted after its fixed slot.
      cursor = card.nextSibling
      continue
    }

    if (card === cursor) {
      cursor = cursor.nextSibling
    } else if (cursor === null || cursor === undefined) {
      list.append(card)
    } else {
      cursor.before(card)
    }
  }
}

/** True iff a card's own run-status element already shows a terminal status class. */
function cardShowsTerminalStatus(card) {
  if (typeof card.querySelector !== 'function') return false
  const statusEl = card.querySelector('[data-role="run-status"]')
  if (statusEl === null || statusEl === undefined) return false
  const className = typeof statusEl.className === 'string' ? statusEl.className : ''
  for (const status of TERMINAL_RUN_STATUSES) {
    if (className.includes(`status-${status}`)) return true
  }
  return false
}

/**
 * Update a card's safe-view-derived fields in place. Closed attribute-mutation set:
 * className (status-* only), textContent (safe-view text children), datetime (on <time>).
 * Never touches data-run-id, data-expanded, or creates any new attribute.
 */
function updateCardInPlace(card, view) {
  card.setAttribute(
    'aria-label',
    `Run, status: ${view.statusLabel}${view.reasonLabel === undefined ? '' : `, reason: ${view.reasonLabel}`}`,
  )

  if (typeof card.querySelector === 'function') {
    const statusEl = card.querySelector('[data-role="run-status"]')
    if (statusEl !== null && statusEl !== undefined) {
      statusEl.className = `run-status status-${view.status}`
      statusEl.textContent = view.statusLabel
    }

    const repoEl = card.querySelector('[data-role="run-repo"]')
    if (repoEl !== null && repoEl !== undefined) {
      repoEl.textContent = view.repo
    }

    const timeEl = card.querySelector('[data-role="run-updated-at"]')
    if ('updatedAt' in view && view.updatedAt !== undefined && timeEl !== null && timeEl !== undefined) {
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
  statusSpan.className = `run-status status-${view.status}`
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
  // Revealed on expansion. Safe-DOM only: createElement + textContent/
  // hidden/dataset, never innerHTML. No run field beyond the closed safe-view
  // reaches these elements at creation time.
  const outputEl = document.createElement('div')
  outputEl.dataset.role = 'run-output'
  outputEl.hidden = true
  card.append(outputEl)

  const coalescedEl = document.createElement('div')
  coalescedEl.dataset.role = 'run-output-coalesced'
  coalescedEl.hidden = true
  card.append(coalescedEl)

  const approvalsEl = document.createElement('div')
  approvalsEl.dataset.role = 'run-approvals'
  approvalsEl.hidden = true
  card.append(approvalsEl)

  const badgeEl = document.createElement('span')
  badgeEl.dataset.role = 'approval-badge'
  badgeEl.hidden = true
  card.append(badgeEl)

  // Wire click and keyboard activation to the expand/collapse toggle.
  if (typeof onSelectRun === 'function') {
    const runId = view.runId
    const activate = () => {
      toggleCardExpansion(card, runId, onSelectRun)
    }
    card.addEventListener('click', activate)
    card.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      if (e.key === ' ') e.preventDefault()
      activate()
    })
  }

  return card
}

/**
 * Toggle a card's expanded state and reveal/hide its per-card substructure.
 *
 * Single-open accordion: expanding a card first collapses whichever other card
 * is currently expanded (hides its substructure, clears its data-expanded)
 * before expanding the clicked one. Selecting an already-expanded card
 * collapses it instead. In both cases onSelectRun(runId) is called — the
 * runtime seam owns the actual stream attach/close; this DOM shell only owns
 * data-expanded and per-card substructure visibility.
 *
 * Safe-DOM only: toggles `hidden` and `dataset.expanded`, never innerHTML.
 */
function toggleCardExpansion(card, runId, onSelectRun) {
  const isExpanded = card.dataset.expanded === 'true'

  if (!isExpanded && _expandedRunId !== null && _expandedRunId !== runId && typeof document !== 'undefined') {
    const prevCard = document.querySelector(`[data-run-id="${CSS.escape(_expandedRunId)}"]`)
    if (prevCard !== null && prevCard !== undefined) {
      prevCard.dataset.expanded = 'false'
      setSubstructureHidden(prevCard, true)
    }
  }

  card.dataset.expanded = isExpanded ? 'false' : 'true'
  setSubstructureHidden(card, isExpanded)
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
 * and the card's revealed substructure consistent with the runtime seam's active
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
  if (card.dataset.expanded === 'true') return // already expanded — nothing to do

  if (_expandedRunId !== null && _expandedRunId !== runId) {
    const prevCard = document.querySelector(`[data-run-id="${CSS.escape(_expandedRunId)}"]`)
    if (prevCard !== null && prevCard !== undefined) {
      prevCard.dataset.expanded = 'false'
      setSubstructureHidden(prevCard, true)
    }
  }

  card.dataset.expanded = 'true'
  setSubstructureHidden(card, false)
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
      setSubstructureHidden(prevCard, true)
    }
  }

  card.dataset.expanded = 'true'
  setSubstructureHidden(card, false)
  _expandedRunId = runId

  onExpand(runId, card)
}

/** Show/hide a card's four per-card substructure regions in one place. */
function setSubstructureHidden(card, hidden) {
  if (typeof card.querySelector !== 'function') return
  for (const role of ['run-output', 'run-output-coalesced', 'run-approvals', 'approval-badge']) {
    const el = card.querySelector(`[data-role="${role}"]`)
    if (el !== null && el !== undefined) el.hidden = hidden
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
