/**
 * Operator runtime seam.
 *
 * Connects the React operator shell to existing browser-direct operator runtimes
 * (public/operator-*.js) without duplicating Gateway logic or adding a proxy.
 *
 * Design:
 * - One lifecycle owner: React mounts the runtime once when the operator shell
 *   reaches ready state; cleanup is called on unmount or auth expiry.
 * - Idempotent: mounting twice (React Strict Mode) is safe — cleanup from the
 *   first mount prevents double-registration.
 * - Async runtime loading: if the runtime module is absent, the shell transitions
 *   to unavailable without crashing.
 * - CSRF and idempotency keys are memory-only; never persisted or logged.
 *
 * Security invariants:
 * - Never logs prompt, token, cookie, CSRF value, repo name, run ID, or raw payload.
 * - Repo-list failures use the canonical operator state classifier — never renders
 *   "No repositories available" for auth/rate-limit/network/protocol failures.
 * - All Gateway data flows through safe text paths only.
 * - Reload restore reads location.hash only to (a) check list-container membership
 *   and (b) build a fetch URL via encodeURIComponent; it never reaches textContent,
 *   innerHTML, a logger, or any DOM attribute other than data-run-id (setAttribute).
 *   A hash value over MAX_HASH_ID_LENGTH is rejected before any further processing.
 */

import {RUN_ID_PATTERN} from './run-id.ts'
import {validateDynamicId} from './validate-dynamic-id.ts'
import type * as LaunchModule from '../../../public/operator-launch.js'
import type * as RunIndexModule from '../../../public/operator-run-index.js'
import type * as StreamModule from '../../../public/operator-stream.js'
import type {RunSummaryStatus, StreamHandle} from '../../../public/operator-stream.js'
import type {OperatorState} from './state.ts'
import {clearGatewaySignInRedirectGuard, maybeAutoRedirectToGatewaySignIn} from './sign-in-recovery.ts'

/**
 * Hard cap on a location.hash-sourced runId, matching the run-summary parser's
 * MAX_ID_LENGTH (public/operator-run-index.js). location.hash is reachable via a
 * crafted/shared link, so this cap is enforced BEFORE validateDynamicId or any
 * decode/encode call — a megabyte-long hash must not reach those paths.
 */
export const MAX_HASH_ID_LENGTH = 512

/**
 * The element shape the stream sidecar's InitOptions declares for a render target. DOM lib types
 * `hidden` as `boolean | string`, so a plain HTMLElement does not satisfy the sidecar's boolean.
 */
type StreamTargetEl = HTMLElement & {hidden: boolean}

/**
 * Discover the per-card render targets for a run's stream (output, coalesced
 * output hint, approval prompt, approval badge, reason, cancel, checkout detail, questions). Without these, a stream
 * handle's DOM updates only ever touch statusEl/noticeEl, leaving the card's
 * core content (output + approvals) blank.
 *
 * Exported so both production (`_attachStream`) and tests exercise the exact
 * same discovery logic — a test that re-implements this lookup proves nothing
 * about whether production actually wires the elements.
 */
export function discoverCardStreamTargets(runId: string): {
  outputEl: StreamTargetEl | null
  coalescedEl: StreamTargetEl | null
  approvalsEl: StreamTargetEl | null
  badgeEl: StreamTargetEl | null
  reasonEl: StreamTargetEl | null
  cancelEl: StreamTargetEl | null
  checkoutEl: StreamTargetEl | null
  questionsEl: StreamTargetEl | null
  /** The card's <time>, only while it is launch-seeded: the list takes it over on adoption. */
  timeEl: HTMLElement | null
  waitingEl: StreamTargetEl | null
} {
  const card = typeof document !== 'undefined'
    ? document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`)
    : null
  return {
    outputEl: card?.querySelector<StreamTargetEl>('[data-role="run-output"]') ?? null,
    coalescedEl: card?.querySelector<StreamTargetEl>('[data-role="run-output-coalesced"]') ?? null,
    approvalsEl: card?.querySelector<StreamTargetEl>('[data-role="run-approvals"]') ?? null,
    badgeEl: card?.querySelector<StreamTargetEl>('[data-role="approval-badge"]') ?? null,
    reasonEl: card?.querySelector<StreamTargetEl>('[data-role="run-reason"]') ?? null,
    cancelEl: card?.querySelector<StreamTargetEl>('[data-role="run-cancel"]') ?? null,
    checkoutEl: card?.querySelector<StreamTargetEl>('[data-role="run-checkout-detail"]') ?? null,
    questionsEl: card?.querySelector<StreamTargetEl>('[data-role="run-questions"]') ?? null,
    timeEl: card?.querySelector<HTMLElement>('[data-role="run-updated-at"][data-time-source="launch"]') ?? null,
    waitingEl: card?.querySelector<StreamTargetEl>('[data-role="run-waiting"]') ?? null,
  }
}

/**
 * Run-list summary status → hyphenated class token: a mirror of RUN_STATUS_CLASS_TOKENS in
 * public/operator-run-index.js, which the run index writes onto each card's run-status element.
 * The seven summary statuses are exactly the run index parser's VALID_RUN_SUMMARY_STATUSES; the
 * stream-only blocked status is not a summary.
 *
 * Mirrored, not imported: this file only takes types from public/ — the run index is loaded at
 * runtime from /static (see _runIndexSpecifier) and must not be bundled a second time into the
 * client. runtime.test.ts pins the two maps together (parity), so they cannot drift silently.
 */
export const STATUS_CLASS_TOKENS = {
  queued: 'status-queued',
  running: 'status-running',
  waiting_for_approval: 'status-waiting-for-approval',
  waiting_for_question: 'status-waiting-for-question',
  succeeded: 'status-succeeded',
  failed: 'status-failed',
  cancelled: 'status-cancelled',
} as const satisfies Record<RunSummaryStatus, string>

const STATUS_BY_CLASS_TOKEN: ReadonlyMap<string, RunSummaryStatus> = new Map(
  (Object.entries(STATUS_CLASS_TOKENS) as [RunSummaryStatus, string][]).map(([status, token]) => [token, status]),
)

/**
 * The expanded card's run-list summary status, or undefined when the card has none to offer.
 *
 * Source: the card's run-status element carries the hyphenated class token the run index writes
 * only from its parsed summary (an allowlist-validated value) — no free text is read. The token
 * is mapped back through STATUS_CLASS_TOKENS, so anything else (an underscore token, the
 * optimistic `status-pending`, stream-only statuses, an unknown token) yields undefined. An
 * optimistic launch card carries no run-list summary yet, so it never offers one.
 *
 * Exported so tests exercise the exact production lookup.
 */
export function discoverCardSummaryStatus(runId: string): RunSummaryStatus | undefined {
  const card = typeof document !== 'undefined'
    ? document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`)
    : null
  if (card === null || (card as HTMLElement).dataset.optimistic === 'true') return undefined
  const statusEl = card.querySelector('[data-role="run-status"]')
  if (statusEl === null) return undefined
  for (const token of Array.from(statusEl.classList)) {
    const status = STATUS_BY_CLASS_TOKEN.get(token)
    if (status !== undefined) return status
  }
  return undefined
}

/**
 * Sanitize a raw location.hash fragment (with or without the leading '#') into a
 * safe runId, or null if it is absent/oversized/malformed.
 *
 * Order matters: the length cap runs first, before validateDynamicId (which itself
 * calls decodeURIComponent). Never call encodeURIComponent/decodeURIComponent on a
 * value that hasn't passed the length cap.
 */
export function sanitizeRunIdFromHash(rawHash: string): string | null {
  const candidate = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash
  if (candidate.length === 0 || candidate.length > MAX_HASH_ID_LENGTH) return null
  if (!validateDynamicId(candidate)) return null
  return candidate
}

export interface RepoListError {
  readonly kind: 'http' | 'network' | 'protocol'
  readonly status?: number
}

export interface OperatorRuntimeOptions {
  readonly container: HTMLElement
  readonly onStateChange: (state: OperatorState) => void
  /**
   * Injectable runtime loader for testing.
   * In production, this dynamically imports the operator runtime modules.
   * May return a cleanup function that is called when the runtime is cleaned up.
   * If absent, the default loader is used.
   *
   * In fixture mode the loader receives {endpointBase, fixtureSessionId, getScenario}
   * so it can configure the public browser modules to use the fixture route prefix
   * and include fixture context in launch requests.
   */
  readonly _runtimeLoader?: (opts?: {
    endpointBase?: string
    fixtureSessionId?: string
    getScenario?: () => string
  }) => Promise<void | (() => void)>
  /**
   * When true, the runtime uses fixture routes instead of production routes.
   * Only active in development builds (import.meta.env.DEV).
   * Production browser bundles must not contain fixture route strings.
   */
  readonly fixtureMode?: boolean
  /**
   * The fixture endpoint base to pass to the runtime loader when fixtureMode is true.
   * Must be provided by the caller (App/fixture loader); no fallback is applied here.
   */
  readonly fixtureEndpointBase?: string
  /**
   * The fixture session ID from the fixture session response.
   * Passed to initOperatorLaunch so launch requests include it in the body.
   * Only used when fixtureMode is true.
   */
  readonly fixtureSessionId?: string
  /**
   * Returns the currently selected fixture scenario at call time.
   * Called at submit time so scenario changes after init are reflected.
   * Only used when fixtureMode is true.
   */
  readonly getScenario?: () => string
}

export interface OperatorRuntimeHandle {
  isMounted: boolean
  cleanup: () => void
}

/**
 * Mint a fresh unique idempotency key for a mutation.
 *
 * Uses crypto.randomUUID() with a fallback for environments that lack it.
 * Keys are memory-only — never persisted, logged, or shared across mutations.
 *
 * Exported for direct testing.
 */
export function mintRuntimeIdempotencyKey(): string {
  if (
    globalThis.crypto !== undefined &&
    typeof (globalThis.crypto as {randomUUID?: () => string}).randomUUID === 'function'
  ) {
    return (globalThis.crypto as {randomUUID: () => string}).randomUUID()
  }
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2)
  return `${ts}-${rand}`
}

/**
 * Classify a repo-list error into a canonical operator state.
 *
 * Never returns "No repositories available" — that string is reserved for the
 * case where the list is genuinely empty after a successful fetch.
 *
 * Auth/rate-limit/network/protocol failures map to their canonical states so
 * the UI can render the correct recovery action.
 *
 * Exported for direct testing.
 */
export function classifyRepoListError(error: RepoListError): OperatorState {
  if (error.kind === 'http') {
    const {status} = error
    if (status === 401 || status === 403) return 'auth-required'
    if (status === 429) return 'rate-limited'
    return 'unavailable'
  }
  return error.kind === 'network' ? 'offline' : 'unavailable'
}

// CSP-safe dynamic import helper.
//
// Vite's import-analysis plugin statically resolves string literals in import()
// calls, even when annotated with @vite-ignore, during Vitest's transform pass.
// Using a computed specifier (string concatenation) prevents static resolution
// while remaining CSP-safe — no eval or Function constructor is used.
//
// The ?manual=1 query param signals the public modules to skip auto-bootstrap
// on evaluation, giving the runtime seam deterministic lifecycle control.
const _streamSpecifier = '/static/operator-stream.js' + '?manual=1'
const _launchSpecifier = '/static/operator-launch.js' + '?manual=1'
const _runIndexSpecifier = '/static/operator-run-index.js' + '?manual=1'

// Active-stream state owned by the runtime seam.
// Only one stream is active at a time; switching cards closes the prior handle first.
let _activeStreamHandle: Pick<StreamHandle, 'close' | 'getConnectionStatus'> | null = null

// The runId whose stream is currently attached (mirrors _activeStreamHandle's target).
// Used by onSelectRun to distinguish "expand a new run" (attach) from "select the
// already-expanded run again" (collapse) — the single-open accordion's decision point.
let _activeStreamRunId: string | null = null

/** How often the visible window refreshes the run list. Well inside the gateway's 20/min limit on GET /operator/runs. */
export const RUN_LIST_REFRESH_INTERVAL_MS = 30_000

/**
 * The longest an expand waits for the run-list refresh. Past it the stream attaches with the status
 * already on the card, so a slow gateway can't leave an opened card empty; the refresh itself keeps
 * going in the background and updates the list as usual.
 */
export const EXPAND_REFRESH_CAP_MS = 2000

// The expand that is waiting on the run-list refresh, if any. An expand only attaches its stream
// once the refresh has landed (or the cap has passed), so the stream starts from the current summary;
// until then this is what tells onSelectRun that a second activation of the same card is a collapse,
// not another expand. The object identity is the token: anything that supersedes the expand (a
// collapse, another expand, a launch, cleanup) goes through _cancelPendingExpand, which clears it and
// releases the wait (and its cap timer); the waiting continuation checks the token still holds.
interface PendingExpand {
  readonly runId: string
  readonly release: () => void
}
let _pendingExpand: PendingExpand | null = null

function _cancelPendingExpand(): void {
  const pending = _pendingExpand
  _pendingExpand = null
  pending?.release()
}

// ---------------------------------------------------------------------------
// Jump to a run: a question notification tapped while the dashboard is open.
//
// The App's service-worker message listener cannot reach the loader's closure (the jump needs the
// loader's refresh, attach and hash writers), so intent crosses through this module-level slot,
// one discriminated value:
//   - 'queue':  no loaded runtime yet (before the runtime mounts, or while its run index is loading).
//               requestRunJump parks the ID in `pending`; one slot, last wins.
//   - 'apply':  a loaded runtime is mounted; requestRunJump calls `apply` at once.
//   - 'refuse': the current runtime's run index ended unavailable, stale or auth-required. A tap is
//               an immediate intent, so it is dropped rather than held for some later mount. A
//               runtime whose list was only unavailable moves back to 'apply' once a refresh lands.
// Every write goes through _setJumpSlot with the writer's loader epoch, so a loader that a newer
// one has replaced can no longer touch the slot.
// The ID lives only here and in the jump's locals: never logged, rendered or put in an attribute.
// ---------------------------------------------------------------------------

type RunJumpSlot =
  | {readonly mode: 'queue'; readonly pending: string | null}
  | {readonly mode: 'apply'; readonly apply: (runId: string) => void}
  | {readonly mode: 'refuse'}

let _jumpSlot: RunJumpSlot = {mode: 'queue', pending: null}

/** Identifies the newest defaultRuntimeLoader call; an older loader leaves the slot alone. */
let _loaderEpoch = 0

/** Identifies the newest jump; an older one stops after its refresh, so the last request wins. */
let _jumpSeq = 0

/** The one writer of the jump slot. Returns false (and writes nothing) once a newer loader owns it. */
function _setJumpSlot(epoch: number, next: RunJumpSlot): boolean {
  if (epoch !== _loaderEpoch) return false
  _jumpSlot = next
  return true
}

function _pendingRunJump(): string | null {
  return _jumpSlot.mode === 'queue' ? _jumpSlot.pending : null
}

/** Forget an ID parked for a runtime that is gone. A no-op once a newer loader owns the slot. */
function _dropPendingRunJump(epoch: number): void {
  if (_jumpSlot.mode === 'queue') _setJumpSlot(epoch, {mode: 'queue', pending: null})
}

/**
 * Ask the mounted operator runtime to open a run: expand its card, attach its stream, update the
 * hash, and bring the card into view. Safe to call at any time:
 *   - an ID that fails the strict run ID pattern is ignored (the jump is stricter than the hash
 *     restore, whose validator stays permissive);
 *   - with no loaded runtime yet the ID waits in a single slot (last wins) and is applied once the
 *     run index has loaded; it is dropped if the run index ends unavailable, stale or auth-required,
 *     on runtime cleanup, and when it equals the mount-time hash-restore target (the restore opens
 *     that run, so it attaches once).
 */
export function requestRunJump(runId: string): void {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return
  const slot = _jumpSlot
  if (slot.mode === 'apply') slot.apply(runId)
  else if (slot.mode === 'queue') _setJumpSlot(_loaderEpoch, {mode: 'queue', pending: runId})
}

/** Whether the active stream still serves `runId`'s card: 'active' and 'terminal' do, 'inactive' does not. */
function _activeStreamServes(runId: string): boolean {
  const handle = _activeStreamHandle
  if (_activeStreamRunId !== runId || handle === null) return false
  return handle.getConnectionStatus() !== 'inactive'
}

/** Fixed copy: the run ID is never echoed. */
const JUMP_MISS_COPY = "That run isn't in your recent runs."

/** Fixed copy for a jump whose run list could not be refreshed: the run may exist, so this is not a miss. */
const JUMP_RETRY_COPY = "Couldn't load your runs. Try again in a moment."

/**
 * Wait for `refresh` or for EXPAND_REFRESH_CAP_MS, whichever comes first. `release` ends the wait
 * early (cancellation). Whichever way the wait ends, the cap timer is cleared, so none leaks. `refresh`
 * must never reject.
 */
function _waitForRefreshOrCap(refresh: Promise<boolean>): {settled: Promise<void>; release: () => void} {
  let release = () => {}
  const settled = new Promise<void>(resolve => {
    const timer = setTimeout(() => release(), EXPAND_REFRESH_CAP_MS)
    release = () => {
      clearTimeout(timer)
      resolve()
    }
    void refresh.then(() => release())
  })
  return {settled, release}
}

/**
 * Write the expanded runId to location.hash. runId is used ONLY for setting the
 * hash fragment here — never interpolated into HTML, textContent, or a logger.
 */
function _writeRunHash(runId: string): void {
  if (typeof location === 'undefined') return
  try {
    location.hash = runId
  } catch {
    // ignore — hash write failures are non-fatal (e.g. unsupported environment)
  }
}

/** Clear location.hash on collapse or restore-miss. */
function _clearRunHash(): void {
  if (typeof location === 'undefined') return
  try {
    if (location.hash !== '') {
      history.replaceState(null, '', location.pathname + location.search)
    }
  } catch {
    // ignore
  }
}

function _closeActiveStream(): void {
  if (_activeStreamHandle !== null) {
    try {
      _activeStreamHandle.close()
    } catch {
      // ignore close errors
    }
    _activeStreamHandle = null
  }
  // Clear the stale-eviction-protection marker on the previously-active card so a
  // collapsed card doesn't keep looking stream-attached until some future
  // markRunStreamAttached call happens to overwrite it (or never does).
  if (_activeStreamRunId !== null && typeof document !== 'undefined') {
    const card = document.querySelector(`[data-run-id="${CSS.escape(_activeStreamRunId)}"]`)
    if (card !== null) delete (card as HTMLElement).dataset.streamAttached
  }
  _activeStreamRunId = null
}

async function defaultRuntimeLoader(opts?: {
  endpointBase?: string
  fixtureSessionId?: string
  getScenario?: () => string
  onSelectRun?: (runId: string) => void
  onRunLaunched?: (runId: string, card: HTMLElement) => void
  onStateChange?: (state: OperatorState) => void
  /** False once the owning runtime handle was cleaned up, even if this loader has not finished yet. */
  isMounted?: () => boolean
}): Promise<() => void> {
  // This loader owns the jump slot until a newer one starts. Starting resets the mode: the new run
  // index has not loaded yet, so a request waits (the pending ID itself is kept).
  const epoch = ++_loaderEpoch
  _setJumpSlot(epoch, {mode: 'queue', pending: _pendingRunJump()})

  // The casts name the sidecar types, so renaming or retyping a member the runtime uses fails
  // check-types instead of surfacing as a silently skipped call. Only the members listed are read.
  const streamMod = await import(/* @vite-ignore */ _streamSpecifier) as Pick<
    typeof StreamModule,
    'initOperatorStream'
  >
  // Streams attach on expand, launch, restore and jump only; the stream module's own bootstrap is not run here.

  const runIndexMod = await import(/* @vite-ignore */ _runIndexSpecifier) as Pick<
    typeof RunIndexModule,
    'initOperatorRunIndex' | 'refreshOperatorRunIndex' | 'resetRunIndexState' | 'markRunStreamAttached' | 'markCardExpandedForLaunch'
  >

  const launchMod = await import(/* @vite-ignore */ _launchSpecifier) as Pick<
    typeof LaunchModule,
    'initOperatorLaunch' | 'resetLaunchState'
  >

  function _attachStream(runId: string, statusEl: Element | null, noticeEl: Element | null): void {
    // Any attach supersedes an expand still waiting on the refresh.
    _cancelPendingExpand()
    _closeActiveStream()

    // Discover the per-card render targets so live output, coalescing hints,
    // approval prompts, and the approval badge all render — not just status.
    const {outputEl, coalescedEl, approvalsEl, badgeEl, reasonEl, cancelEl, checkoutEl, questionsEl, timeEl, waitingEl} = discoverCardStreamTargets(runId)
    const summaryStatus = discoverCardSummaryStatus(runId)

    // A re-expanded card must never keep question DOM from a previous attach: the stream and
    // page store rebuild this region from scratch.
    if (questionsEl !== null) questionsEl.textContent = ''

    try {
      const handle = streamMod.initOperatorStream({
        runId,
        statusEl,
        noticeEl,
        outputEl,
        coalescedEl,
        approvalsEl,
        badgeEl,
        reasonEl,
        timeEl,
        waitingEl,
        cancelEl,
        checkoutEl,
        questionsEl,
        ...(summaryStatus === undefined ? {} : {summaryStatus}),
        endpointBase: opts?.endpointBase,
        fixtureSessionId: opts?.fixtureSessionId,
      })
      _activeStreamHandle = handle
      _activeStreamRunId = runId
      runIndexMod.markRunStreamAttached(runId)
    } catch {
      if (statusEl !== null) {
        statusEl.textContent = 'Unavailable'
        statusEl.className = 'status-unavailable'
      }
    }
  }

  // Re-open a refused jump slot after the list recovers; assigned once jumpToRun exists (below).
  let recoverJumps = () => {}

  // Refresh the run list in place (single-flight inside the run index). Triggers: the visible-window
  // interval, becoming visible, expand, and a jump. Resolves true when fresh data was applied. Never
  // rejects: a failed refresh just keeps the list.
  const refreshRunList = (): Promise<boolean> => {
    return runIndexMod.refreshOperatorRunIndex().catch(() => false).then(applied => {
      // A refresh that brings in the run a jump could not find clears that jump's notice, and any
      // refresh that applies makes a "could not load" notice stale.
      if (jumpNotice?.kind === 'miss' && findCard(jumpNotice.runId) !== null) clearJumpNotice()
      else if (jumpNotice?.kind === 'retry' && applied) clearJumpNotice()
      if (applied) recoverJumps()
      return applied
    })
  }

  const findCard = (runId: string): HTMLElement | null =>
    typeof document === 'undefined' ? null : document.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(runId)}"]`)

  let cancelPendingCardReveal = () => {}

  const scrollRunCardIntoView = (card: HTMLElement): void => {
    cancelPendingCardReveal()

    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth'
    const scrollToStart = () => {
      if (typeof card.scrollIntoView === 'function') card.scrollIntoView({block: 'start', behavior})
    }
    scrollToStart()

    let cancelled = false
    let firstFrame: number | undefined
    let secondFrame: number | undefined
    let revealTimeout: number | undefined
    const observer = new MutationObserver(checkForRevealedContent)

    const cleanup = () => {
      cancelled = true
      observer.disconnect()
      if (firstFrame !== undefined) window.cancelAnimationFrame?.(firstFrame)
      if (secondFrame !== undefined) window.cancelAnimationFrame?.(secondFrame)
      if (revealTimeout !== undefined) window.clearTimeout(revealTimeout)
      window.removeEventListener('wheel', onUserScroll)
      window.removeEventListener('touchmove', onUserScroll)
      window.removeEventListener('pointerdown', onUserScroll)
      window.removeEventListener('keydown', onScrollKey)
      if (cancelPendingCardReveal === cleanup) cancelPendingCardReveal = () => {}
    }
    const onUserScroll = () => cleanup()
    const onScrollKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element
        && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null) return
      if (['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '].includes(event.key)) cleanup()
    }

    const hasRevealedContent = () =>
      Array.from(card.querySelectorAll<HTMLElement>('[data-role="run-questions"], [data-role="run-approvals"]'))
        .some(region => !region.hidden && region.childNodes.length > 0)

    function checkForRevealedContent() {
      if (cancelled || card.dataset.expanded !== 'true' || !hasRevealedContent()) return
      observer.disconnect()
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = undefined
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = undefined
          if (cancelled || card.dataset.expanded !== 'true') return cleanup()
          scrollToStart()
          cleanup()
        })
      })
    }

    cancelPendingCardReveal = cleanup
    window.addEventListener('wheel', onUserScroll, {passive: true})
    window.addEventListener('touchmove', onUserScroll, {passive: true})
    window.addEventListener('pointerdown', onUserScroll)
    window.addEventListener('keydown', onScrollKey)
    revealTimeout = window.setTimeout(cleanup, 10_000)
    observer.observe(card, {attributes: true, childList: true, subtree: true, attributeFilter: ['hidden', 'data-expanded']})
    checkForRevealedContent()
  }

  // What the jump notice currently says, held in memory only so a refresh can tell when it is stale.
  // A miss keeps the run it could not find; it is never rendered, logged or written to an attribute,
  // and both notices are fixed copy.
  let jumpNotice: {readonly kind: 'miss'; readonly runId: string} | {readonly kind: 'retry'} | null = null

  const jumpNoticeEl = (): HTMLElement | null => {
    const el = typeof document === 'undefined' ? null : document.querySelector('[data-role="run-jump-miss"]')
    return el instanceof HTMLElement ? el : null
  }

  const jumpNoticeContainerEl = (): HTMLElement | null => {
    const el = typeof document === 'undefined' ? null : document.querySelector('[data-role="run-jump-notice"]')
    return el instanceof HTMLElement ? el : null
  }

  const clearJumpNotice = () => {
    jumpNotice = null
    const el = jumpNoticeEl()
    if (el !== null) {
      el.textContent = ''
      el.hidden = true
    }
    const container = jumpNoticeContainerEl()
    if (container !== null) container.hidden = true
  }

  const showJumpNotice = (notice: NonNullable<typeof jumpNotice>, copy: string) => {
    jumpNotice = notice
    const el = jumpNoticeEl()
    if (el === null) return
    el.textContent = copy
    el.hidden = false
    const container = jumpNoticeContainerEl()
    if (container !== null) container.hidden = false
  }

  const dismissJumpNoticeButton = typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLButtonElement>('[data-role="run-jump-dismiss"]')
  const onDismissJumpNotice = () => clearJumpNotice()
  dismissJumpNoticeButton?.addEventListener('click', onDismissJumpNotice)

  // Build the active-stream coordination callbacks. These are passed to run-index and
  // launch modules so the runtime seam owns the single active stream handle.
  //
  // Single-open accordion: the run-index DOM shell calls this on every card
  // click/keydown activation, whether the card is being expanded or collapsed
  // (it decides that via data-expanded before calling here). This callback is
  // the single decision point for "attach" vs "collapse":
  // - If runId is already the active stream, the card was just collapsed —
  //   close the stream and attach nothing new.
  // - Otherwise the card was just expanded — close whichever stream is active
  //   (if any) and attach the new one. _attachStream already closes the prior
  //   handle first, so this covers both "nothing was open" and "switching cards."
  //
  // Expanding first refreshes the run list, so the stream starts from the current summary (a run
  // that finished while its card was collapsed seeds its terminal status). The attach reads the
  // card's summary status only after the refresh has landed. If the refresh fails the card keeps the
  // status it already shows, and the expand proceeds. The whole wait is cancelable: a collapse
  // never waits, and supersedes an expand that is still waiting.
  const onSelectRun = (runId: string): Promise<void> | void => {
    cancelPendingCardReveal()
    if (_activeStreamRunId === runId) {
      _cancelPendingExpand()
      _closeActiveStream()
      _clearRunHash()
      return
    }
    if (_pendingExpand?.runId === runId) {
      // The card was activated again while its expand waited on the refresh: that is a collapse.
      _cancelPendingExpand()
      _clearRunHash()
      return
    }

    // From here the card is being expanded: a jump's notice is stale.
    clearJumpNotice()

    const attachExpanded = () => {
      // Find the card element for this runId to get its statusEl and noticeEl.
      const card = typeof document !== 'undefined'
        ? document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`)
        : null
      const statusEl = card?.querySelector('[data-role="run-status"]') ?? null
      const noticeEl = typeof document !== 'undefined'
        ? document.querySelector('[data-role="stream-status"]')
        : null
      _attachStream(runId, statusEl, noticeEl)
    }

    // Expanding another card ends the open stream now; only the new attach waits, for the refresh
    // or the cap. Cancelling first releases a previous waiting expand and its cap timer.
    _cancelPendingExpand()
    _closeActiveStream()
    _writeRunHash(runId)
    const wait = _waitForRefreshOrCap(refreshRunList())
    const pending = {runId, release: wait.release}
    _pendingExpand = pending
    return wait.settled.then(() => {
      if (disposed || _pendingExpand !== pending) return
      _pendingExpand = null
      // The refresh may have dropped the run from the list; there is nothing left to stream into.
      const stillListed = typeof document !== 'undefined'
        && document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`) !== null
      if (!stillListed) {
        _clearRunHash()
        return
      }
      attachExpanded()
    })
  }

  // Reload restore: a hash-restored run is expanded via a distinct, non-toggle DOM
  // entry point (expandCardForRestore in operator-run-index.js), never onSelectRun —
  // onSelectRun's toggle semantics assume a prior click (re-select = collapse), which
  // a cold-boot restore is not.
  //
  // Terminal vs. non-terminal restores attach the stream the same way on purpose:
  // the "no reconnect for a terminal run" guarantee already lives in
  // initOperatorStream's own state machine (nextStreamState transitions to
  // connection: 'closed' with shouldReconnect: false once a terminal status frame
  // arrives, and the reader loop stops re-invoking itself once closed) — not in this
  // seam. A restored terminal run still opens one connection to receive the
  // replay/final frame, then closes without ever scheduling a reconnect. There is
  // nothing terminal-specific for this callback to special-case, so TERMINAL_RUN_STATUSES
  // is retained only for tests/documentation of that contract, not a branch here.
  const onRestoreRun = (runId: string, card: Element, _status: string) => {
    const statusEl = card.querySelector('[data-role="run-status"]') ?? null
    const noticeEl = typeof document !== 'undefined'
      ? document.querySelector('[data-role="stream-status"]')
      : null
    if (card instanceof HTMLElement) scrollRunCardIntoView(card)
    _attachStream(runId, statusEl, noticeEl)
  }

  const onRestoreMiss = () => {
    _clearRunHash()
    const noticeEl = typeof document !== 'undefined'
      ? document.querySelector('[data-role="stream-status"]')
      : null
    if (noticeEl instanceof HTMLElement) {
      // Fixed copy — no runId echoed.
      noticeEl.textContent = 'The selected run is no longer in recent history.'
      noticeEl.hidden = false
    }
  }

  // Run-list refresh timer: ticks every RUN_LIST_REFRESH_INTERVAL_MS while the window is visible.
  // Cleared while hidden, on auth-required, and on cleanup.
  let disposed = false
  let authRequired = false
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  const stopRefreshTimer = () => {
    if (refreshTimer === undefined) return
    clearInterval(refreshTimer)
    refreshTimer = undefined
  }

  // Restarts rather than stacks, so a visibility event never leaves two intervals running.
  const startRefreshTimer = () => {
    stopRefreshTimer()
    refreshTimer = setInterval(() => {
      void refreshRunList()
    }, RUN_LIST_REFRESH_INTERVAL_MS)
  }

  const onAuthRequired = () => {
    authRequired = true
    stopRefreshTimer()
    // No session: a pending or arriving jump has nothing to open.
    _setJumpSlot(epoch, {mode: 'refuse'})
    opts?.onStateChange?.('auth-required')
  }

  const onVisibilityChange = () => {
    if (disposed || authRequired) return
    if (document.visibilityState === 'visible') {
      // Returning to the window: catch up now instead of waiting out the period, and restart it.
      void refreshRunList()
      startRefreshTimer()
    } else {
      stopRefreshTimer()
    }
  }

  const onRunLaunched = (runId: string, card: HTMLElement) => {
    const statusEl = card.querySelector('[data-role="run-status"]') ?? null
    const noticeEl = typeof document !== 'undefined'
      ? document.querySelector('[data-role="stream-status"]')
      : null
    _attachStream(runId, statusEl, noticeEl)
    _writeRunHash(runId)
    // A launched run's card must present as already-expanded/observed the moment
    // its stream attaches — otherwise the operator's first click on it is
    // misread by onSelectRun as "collapse the active stream" instead of "expand."
    runIndexMod.markCardExpandedForLaunch(runId)
  }

  // Open a run on request (a notification tap). Like onRunLaunched it lives here because it needs
  // the loader's attach, hash and refresh. Never routed through onSelectRun, whose toggle would
  // collapse an expanded card.
  //
  //   1. any jump supersedes a pending expand, and an earlier jump still waiting on its refresh;
  //   2. refresh the run list, so the card status is current and a new run can appear;
  //   3. card collapsed: expand it (non-toggling), attach, write the hash, then reveal it and
  //      announce it; card expanded with a stream that still serves it (live or terminal): reveal
  //      only; card expanded but its stream is closed, failed or unavailable: re-attach (which
  //      closes the old handle) and reveal; card missing: show a fixed notice and touch nothing
  //      else (hash, expansion and stream stay as they are). The notice says "not in your recent
  //      runs" when the refresh applied, and "could not load" when it did not.
  // The hash write is a plain location.hash assignment and nothing listens for it, so it cannot
  // start another jump.
  const jumpToRun = async (runId: string): Promise<void> => {
    const seq = ++_jumpSeq
    clearJumpNotice()
    _cancelPendingExpand()
    const listFresh = await refreshRunList()
    if (disposed || authRequired || _jumpSeq !== seq) return
    // A click can start an expand while the refresh ran; the jump is the newer intent.
    _cancelPendingExpand()

    // A card that is on the page opens whether or not the refresh applied. A missing card is only a
    // miss when the refresh confirmed the list; otherwise the run may simply not have loaded yet.
    const card = findCard(runId)
    if (card === null) {
      if (listFresh) showJumpNotice({kind: 'miss', runId}, JUMP_MISS_COPY)
      else showJumpNotice({kind: 'retry'}, JUMP_RETRY_COPY)
      return
    }

    const statusEl = card.querySelector('[data-role="run-status"]') ?? null
    const noticeEl = document.querySelector('[data-role="stream-status"]')
    const wasExpanded = card.dataset.expanded === 'true'
    scrollRunCardIntoView(card)

    if (!wasExpanded) {
      // The shared non-toggling expand, used for launches and jumps alike.
      runIndexMod.markCardExpandedForLaunch(runId)
      _attachStream(runId, statusEl, noticeEl)
      _writeRunHash(runId)
    } else if (!_activeStreamServes(runId)) {
      _attachStream(runId, statusEl, noticeEl)
    }

    if (typeof card.focus === 'function') card.focus({preventScroll: true})

    // Every successful jump announces, whether it expanded the card, only revealed an open one, or
    // re-attached its stream. The label comes from the run index's own status element (an
    // allowlisted label), never the ID.
    const label = statusEl?.textContent?.trim() ?? ''
    const announcer = document.querySelector('[data-role="run-jump-announcer"]')
    if (announcer !== null) announcer.textContent = label === '' ? 'Opened run' : `Opened run, ${label}`
  }

  // Open the jump slot for this loader and run the ID that was waiting for it, unless `skipRunId`
  // names it (the hash restore already opened that run).
  const armJumps = (skipRunId?: string) => {
    const pending = _pendingRunJump()
    if (!_setJumpSlot(epoch, {mode: 'apply', apply: runId => void jumpToRun(runId)})) return
    if (pending !== null && pending !== skipRunId) void jumpToRun(pending)
  }

  // Set once, when the first load ended unavailable (not auth, not stale): the one reason a refused
  // slot may open again, as soon as a refresh applies data.
  let jumpsRecoverable = false
  recoverJumps = () => {
    if (!jumpsRecoverable || disposed || authRequired || opts?.isMounted?.() === false) return
    if (_jumpSlot.mode !== 'refuse') return
    jumpsRecoverable = false
    armJumps()
  }

  runIndexMod.resetRunIndexState()
  // The mount-time restore target: sanitized once, handed to the run index below, and compared with
  // a jump that was waiting for this mount (the restore opens that run, so it attaches once).
  const restoreRunId = typeof location !== 'undefined'
    ? sanitizeRunIdFromHash(location.hash) ?? undefined
    : undefined
  // The hash is actually read HERE, synchronously, before initOperatorRunIndex is
  // called — it is only consulted (as restoreRunId) after that function's internal
  // /operator/runs fetch resolves. So a user click that attaches a stream during
  // the await window can race this pre-captured value; the run-index module
  // guards against that by checking for an already-attached stream for a
  // different run before honoring the restore (see initOperatorRunIndex). The
  // raw hash is sanitized above — length cap before validateDynamicId — before it
  // crosses into the run-index module at all.
  const runIndexOpts = opts?.endpointBase !== undefined
    ? {endpointBase: opts.endpointBase, fixtureSessionId: opts.fixtureSessionId, onSelectRun, restoreRunId, onRestoreRun, onRestoreMiss, onAuthRequired}
    : {onSelectRun, restoreRunId, onRestoreRun, onRestoreMiss, onAuthRequired}
  // How the load ended comes back as the init's own outcome. 'loaded'/'empty' mean the list is there;
  // 'unavailable' is a non-auth failure; 'auth-required' and 'stale' (a reset or a newer init
  // replaced this one) have nowhere to open a run.
  const initOutcome = await runIndexMod.initOperatorRunIndex(runIndexOpts)
  const runIndexLoaded = initOutcome === 'loaded' || initOutcome === 'empty'
  // The fixture harness has no gateway sign-in route, so it never redirects.
  if (initOutcome === 'auth-required' && opts?.endpointBase === undefined) maybeAutoRedirectToGatewaySignIn('auth-required')
  if (runIndexLoaded) clearGatewaySignInRedirectGuard()

  launchMod.resetLaunchState()
  const launchOpts = opts?.endpointBase !== undefined
    ? {endpointBase: opts.endpointBase, getScenario: opts.getScenario, fixtureSessionId: opts.fixtureSessionId, onRunLaunched}
    : {onRunLaunched}
  await launchMod.initOperatorLaunch(launchOpts)

  // Start refreshing once init has loaded the list. Init just fetched it, so no refresh is due yet.
  if (typeof document !== 'undefined' && !authRequired) {
    document.addEventListener('visibilitychange', onVisibilityChange)
    if (document.visibilityState === 'visible') startRefreshTimer()
  }

  // Hand the jump slot over. Only the newest loader touches it: an older one (superseded while it
  // set up) leaves the pending ID for its successor.
  if (_loaderEpoch === epoch) {
    if (runIndexLoaded && !authRequired && opts?.isMounted?.() !== false) {
      // The restore already opened the hash's run during init; opening it again would attach twice.
      armJumps(restoreRunId)
    } else {
      // Unavailable, stale, auth-required or already cleaned up: nothing to open it in.
      _setJumpSlot(epoch, {mode: 'refuse'})
      jumpsRecoverable = initOutcome === 'unavailable' && !authRequired && opts?.isMounted?.() !== false
    }
  }

  return () => {
    disposed = true
    cancelPendingCardReveal()
    jumpsRecoverable = false
    _setJumpSlot(epoch, {mode: 'queue', pending: null})
    stopRefreshTimer()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
    dismissJumpNoticeButton?.removeEventListener('click', onDismissJumpNotice)
    _cancelPendingExpand()
    // Close the active stream handle on cleanup.
    _closeActiveStream()
    launchMod.resetLaunchState()
    runIndexMod.resetRunIndexState()
  }
}

/**
 * Create an operator runtime handle.
 *
 * Loads or initializes existing public/operator-*.js modules after the React
 * operator shell reaches ready state. Returns a handle with a cleanup function
 * that closes streams, removes listeners, clears timers, and wipes generated DOM.
 *
 * One lifecycle owner: React calls this once when the shell is ready and calls
 * cleanup() on unmount or auth expiry. React Strict Mode double-effects are safe
 * because cleanup() is idempotent.
 *
 * @param opts - Runtime options including container, state change callback, and
 *               optional injectable runtime loader for testing.
 * @returns A handle with isMounted and cleanup().
 */
export function createOperatorRuntime(opts: OperatorRuntimeOptions): OperatorRuntimeHandle {
  const {container: _container, onStateChange, _runtimeLoader, fixtureMode, fixtureEndpointBase, fixtureSessionId, getScenario} = opts

  let mounted = true
  let cleanupFns: Array<() => void> = []

  const handle: OperatorRuntimeHandle = {
    get isMounted() {
      return mounted
    },
    cleanup() {
      if (!mounted) return
      mounted = false
      for (const fn of cleanupFns) {
        try {
          fn()
        } catch {
          // Cleanup errors are swallowed — never log sensitive context
        }
      }
      cleanupFns = []
      // A jump still waiting for a runtime that is now gone is stale. (Also covers a runtime cleaned
      // up before its loader finished, whose own cleanup has not been registered yet.) Guarded by
      // the loader's epoch: an ID queued for a newer loader is not this runtime's to drop.
      _dropPendingRunJump(loaderEpoch)
    },
  }

  // onStateChange is bound onto the default loader only (via a thin wrapper), never
  // added to loaderOpts — existing tests assert loaderOpts is `undefined` when
  // fixtureMode is off, and an injectable test _runtimeLoader shouldn't gain an
  // unrequested field. The default loader needs it independent of fixture mode so
  // a stale-auth reload (auth re-classification on the /operator/runs restore fetch)
  // can report auth-required back to the shell.
  const loader = _runtimeLoader ?? ((loaderOpts?: Parameters<typeof defaultRuntimeLoader>[0]) => defaultRuntimeLoader({...loaderOpts, onStateChange, isMounted: () => mounted}))

  // Build loader options: only pass fixture context in fixture mode (dev builds only).
  // Production bundles must not contain fixture route strings.
  const loaderOpts =
    fixtureMode === true
      ? {
          endpointBase: fixtureEndpointBase,
          fixtureSessionId,
          getScenario,
        }
      : undefined

  const loading = loader(loaderOpts)
  // The default loader takes its epoch synchronously, so this is the epoch it owns.
  const loaderEpoch = _loaderEpoch
  loading.then(maybeCleanup => {
    if (typeof maybeCleanup !== 'function') return
    if (mounted) {
      cleanupFns.push(maybeCleanup)
    } else {
      maybeCleanup()
    }
  }).catch(() => {
    if (mounted) {
      onStateChange('unavailable')
    }
  })

  return handle
}
