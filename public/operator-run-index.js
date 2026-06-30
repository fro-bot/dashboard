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

  // Closed DTO — copy only declared fields; never spread input.
  const summary = {
    runId: candidate.runId,
    repo: candidate.repo,
    status: candidate.status,
    createdAt: candidate.createdAt,
    ...('updatedAt' in candidate ? {updatedAt: candidate.updatedAt} : {}),
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

/** Build a closed safe-view from a parsed run summary. Unknown fields excluded by construction. */
export function buildRunSafeView(summary) {
  const statusLabel = STATUS_LABELS[summary.status] ?? summary.status

  return {
    runId: summary.runId,
    repo: summary.repo,
    status: summary.status,
    statusLabel,
    createdAt: summary.createdAt,
    ...('updatedAt' in summary ? {updatedAt: summary.updatedAt} : {}),
  }
}

/**
 * Fetch the run index from the Gateway.
 * All error classes collapse to {kind: 'unavailable'} — never logs endpoint paths or bodies.
 */
export async function fetchRunIndex(opts) {
  const endpointBase = opts?.endpointBase ?? '/operator'

  try {
    const res = await globalThis.fetch(`${endpointBase}/runs`, {
      credentials: 'include',
      redirect: 'error',
    })

    if (!res.ok) {
      return {kind: 'unavailable'}
    }

    let body
    try {
      body = await res.json()
    } catch {
      return {kind: 'unavailable'}
    }

    const parsed = parseRunSummaryList(body)
    if (!parsed.success) {
      return {kind: 'unavailable'}
    }

    return {kind: 'loaded', summaries: parsed.data}
  } catch {
    return {kind: 'unavailable'}
  }
}

// _runIndexGeneration is a monotonically increasing counter. Each init captures its own
// generation; resetRunIndexState() increments it to invalidate all pending inits.
let _runIndexGeneration = 0
let _runIndexInitialized = false

function isRunIndexInitStale(generation) {
  return generation !== _runIndexGeneration
}

/** Increment generation to invalidate pending inits. Called by the React runtime seam cleanup. */
export function resetRunIndexState() {
  _runIndexGeneration++
  _runIndexInitialized = false
}

export async function initOperatorRunIndex(opts) {
  const myGeneration = ++_runIndexGeneration

  const endpointBase = opts?.endpointBase ?? '/operator'

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

  const result = await fetchRunIndex({endpointBase})

  // Guard: bail if reset/replaced while awaiting fetch.
  if (isRunIndexInitStale(myGeneration)) return

  if (runIndexLoading !== null) runIndexLoading.hidden = true

  if (result.kind === 'unavailable') {
    if (runIndexUnavailable !== null) runIndexUnavailable.hidden = false
    return
  }

  const {summaries} = result

  if (summaries.length === 0) {
    if (runIndexEmpty !== null) runIndexEmpty.hidden = false
    return
  }

  if (runIndexList !== null) {
    runIndexList.hidden = false
    runIndexList.textContent = ''

    for (const summary of summaries) {
      const view = buildRunSafeView(summary)
      const card = renderRunCard(view)
      runIndexList.append(card)
    }
  }

  if (runIndexSection !== null) {
    runIndexSection.dataset.state = 'loaded'
  }
}

/** Safe DOM writes only — no innerHTML for Gateway content. */
function renderRunCard(view) {
  const card = document.createElement('div')
  card.className = 'run-card'
  card.tabIndex = 0
  card.setAttribute('role', 'button')
  card.setAttribute('aria-label', `Run, status: ${view.statusLabel}`)
  card.dataset.testid = 'run-index-card'
  card.dataset.runId = view.runId

  const statusSpan = document.createElement('span')
  statusSpan.className = `run-status status-${view.status}`
  statusSpan.dataset.role = 'run-status'
  statusSpan.textContent = view.statusLabel
  card.append(statusSpan)

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
    timeEl.textContent = view.updatedAt
    card.append(timeEl)
  }

  return card
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
