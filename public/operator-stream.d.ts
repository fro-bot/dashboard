/**
 * Type declarations for public/operator-stream.js.
 *
 * Provides TypeScript types for the pure exported functions so that
 * test/operator-stream-core.test.ts can import them without `any`.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export declare const PINNED_CONTRACT_VERSION: string
export declare const RETRY_BASE_MS: number
export declare const RETRY_FACTOR: number
export declare const RETRY_MAX_COUNT: number
export declare const MAX_SSE_BUFFER_BYTES: number
export declare const MAX_OUTPUT_TEXT_CHARS: number
export declare const MAX_APPROVAL_TOMBSTONES: number
export declare const MAX_OPEN_APPROVALS: number
export declare const FIRST_FRAME_TIMEOUT_MS: number
/**
 * Mirrors the gateway's PENDING_APPROVALS_MAX_RESULTS cap (50) from
 * fro-bot/agent v0.76.2 packages/gateway/src/web/operator/pending-approvals-route.ts.
 * Used by reconcileApprovals to guard against truncated recovery responses.
 */
export declare const GATEWAY_PENDING_APPROVALS_CAP: number

/** Operator-safe failure-reason code. */
export type FailureKind =
  | 'inactivity-timeout'
  | 'max-duration-timeout'
  | 'stream-ended'
  | 'workspace-unreachable'
  | 'session-error'
  | 'unknown'

/**
 * Dashboard-owned display labels for known failure reasons, keyed by FailureKind.
 * Must stay identical (keys and label values) to the map exported from
 * public/operator-run-index.js — parity is enforced by tests.
 */
export declare const FAILURE_REASON_LABELS: Readonly<Record<FailureKind, string>>

// ---------------------------------------------------------------------------
// Frame types (mirrors src/gateway/operator-contract/sse-frames.ts shapes)
// ---------------------------------------------------------------------------

export interface ReadyFrameData {
  readonly contractVersion: string
}

export interface StatusFrameData {
  readonly runId: string
  readonly entityRef: string
  readonly surface: string
  readonly phase: string
  readonly status: string
  readonly startedAt: string
  readonly stale: boolean
  /** Operator-safe failure-reason code. Optional; failed statuses only. */
  readonly failureKind?: FailureKind
}

export interface ResetFrameData {
  readonly runId: string
  readonly reason: string
}

export interface OutputFrameData {
  readonly runId: string
  readonly text: string
  readonly final: boolean
  readonly seq: number
  readonly droppedCount?: number
}

export interface ApprovalFrameDataOpen {
  readonly runId: string
  readonly requestID: string
  readonly permission: string
  readonly command?: string
  readonly filepath?: string
  readonly settled: false
}

export interface ApprovalFrameDataSettle {
  readonly runId: string
  readonly requestID: string
  readonly settled: true
}

export type ApprovalFrameData = ApprovalFrameDataOpen | ApprovalFrameDataSettle

export type StreamFrame =
  | {readonly type: 'ready'; readonly data: ReadyFrameData}
  | {readonly type: 'status'; readonly data: StatusFrameData}
  | {readonly type: 'reset'; readonly data: ResetFrameData}
  | {readonly type: 'output'; readonly data: OutputFrameData}
  | {readonly type: 'approval'; readonly data: ApprovalFrameData}

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

export type SseParseResult =
  | {readonly success: true; readonly frame: StreamFrame}
  | {readonly success: false; readonly error: string}

// ---------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------

export type ConnectionStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'drift'
  | 'not-found'
  | 'backpressure'
  | 'failed'
  | 'closed'
  | 'submitted-unobservable'

export interface RunEntry {
  readonly runId: string
  readonly status: string
  readonly phase: string
  readonly startedAt: string
  readonly stale: boolean
  readonly terminal: boolean
  /** Accumulated run-output answer text (deltas appended; final replaces). */
  readonly outputText?: string
  /** Highest applied output seq; -1 / absent before any output. */
  readonly outputSeq?: number
  /** True once an authoritative final output frame has been applied. */
  readonly outputFinal?: boolean
  /** True if any output frame reported coalesced (dropped) deltas. */
  readonly outputCoalesced?: boolean
  /** True if accumulated output exceeded the cap and was truncated. */
  readonly outputTruncated?: boolean
  /**
   * Pre-resolved dashboard display label for a known failure reason. Set only when
   * a failed status frame carried a known failureKind; sticky across later frames
   * for the same run (never cleared by a subsequent non-terminal frame). Never the
   * raw failureKind wire value.
   */
  readonly reasonLabel?: string
  /**
   * Null-prototype map of open (non-tombstoned) approval prompts, keyed by requestID.
   * Absent until the first approval frame is received for this run.
   * Use `getOpenApprovals(runEntry)` to read; never access directly.
   */
  readonly approvalOpenPrompts?: Readonly<Record<string, ApprovalFrameDataOpen>>
  /**
   * Null-prototype map of tombstoned requestIDs (requestID → true).
   * A tombstoned id means the prompt was settled; any later open for the same id is ignored.
   * Absent until the first settle frame is received for this run.
   */
  readonly approvalTombstones?: Readonly<Record<string, true>>
  /**
   * True while a browser-dispatched cancel POST is outstanding for this run.
   * Internal-only — set by the `cancel` action, cleared by a terminal status
   * frame from any source (terminal-wins). Never exposed via toSafeRunView.
   */
  readonly cancelInFlight?: boolean
}

/**
 * Dispatched when the browser sends the cancel POST for a run. Marks the run
 * as having a cancel in flight; a terminal status frame from any source clears
 * it (terminal-wins) and a cancel action on an already-terminal run is a no-op.
 */
export interface CancelActionEvent {
  readonly type: 'cancel'
  readonly data: {readonly runId: string}
}

export interface StreamState {
  readonly connection: ConnectionStatus
  readonly runs: Readonly<Record<string, RunEntry>>
  readonly retryCount: number
  readonly shouldReconnect: boolean
}

// ---------------------------------------------------------------------------
// Corrective reconnect-reconcile action
// ---------------------------------------------------------------------------

/**
 * Corrective reconcile action dispatched by reconcileApprovals on reconnect.
 *
 * The caller computes the explicit diff from a pre-GET snapshot so the
 * reducer does NOT re-derive it — this is what makes the reconcile-window race
 * impossible.
 *
 * - pruneIds: requestIDs to remove from open-prompts and tombstone (FIFO-capped).
 *   Pruning an absent id is a no-op; re-tombstoning is idempotent.
 * - addPrompts: recovered open prompts to add if not already open and not tombstoned.
 *   Respects MAX_OPEN_APPROVALS overflow guard.
 */
export interface ApprovalReconcileEvent {
  readonly type: 'approval-reconcile'
  readonly runId: string
  readonly pruneIds: readonly string[]
  readonly addPrompts: readonly {
    readonly requestID: string
    readonly permission: string
    readonly command?: string
    readonly filepath?: string
  }[]
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export type StreamEvent =
  | StreamFrame
  | {readonly type: 'http-status'; readonly code: number}
  | {readonly type: 'network-error'}
  | {readonly type: 'stream-closed'}
  | {readonly type: 'unexpected-close'}
  | {readonly type: 'buffer-overflow'}
  | {readonly type: 'first-frame-timeout'}
  | ApprovalReconcileEvent
  | CancelActionEvent

// ---------------------------------------------------------------------------
// Safe render model
// ---------------------------------------------------------------------------

export interface SafeRunView {
  readonly runId: string
  readonly status: string
  readonly phase: string
  readonly startedAt: string
  readonly stale: boolean
  /** Pre-resolved dashboard display label for a known failure reason. Never the raw failureKind. */
  readonly reasonLabel?: string
}

// ---------------------------------------------------------------------------
// Pure exported functions
// ---------------------------------------------------------------------------

/**
 * Parse a single SSE record (text between two blank lines) into a typed frame
 * result or null (for comment-only records like heartbeats).
 */
export declare function parseSseFrame(record: string): SseParseResult | null

/**
 * Pure reducer: given the current stream state and an event, return the next state.
 */
export declare function nextStreamState(current: StreamState, event: StreamEvent): StreamState

/**
 * Map a run status object to the safe render model.
 * Returns ONLY: { runId, status, phase, startedAt, stale, reasonLabel? }
 */
export declare function toSafeRunView(runStatus: {
  readonly runId: string
  readonly status: string
  readonly phase: string
  readonly startedAt: string
  readonly stale: boolean
  readonly reasonLabel?: string
}): SafeRunView

/**
 * Returns true iff the run entry has at least one open (non-tombstoned) approval prompt.
 *
 * This is the canonical visibility signal for the `waiting_for_approval` overlay and
 * the in-page open-prompt indicator. Both must derive from this one state so
 * they cannot desync.
 */
export declare function hasOpenApprovals(runEntry: RunEntry | undefined | null): boolean

/**
 * Returns the list of open (non-tombstoned) approval prompts for a run entry,
 * in insertion order. Each element is an open ApprovalFrameDataOpen object.
 *
 * Returns an empty array when there are no open prompts.
 */
export declare function getOpenApprovals(runEntry: RunEntry | undefined | null): readonly ApprovalFrameDataOpen[]

// ---------------------------------------------------------------------------
// DOM shell (browser-only — never called at module top-level)
// ---------------------------------------------------------------------------

export interface StreamHandle {
  close: () => void
}

/** Browser-direct approval client interface (for testing injection). */
export interface ApprovalClient {
  readonly refreshCsrf: () => Promise<{success: boolean; data?: {csrfToken: string}; error?: {kind: string; status?: number}}>
  readonly decideRunApproval: (
    runId: string,
    requestId: string,
    decision: string,
    idempotencyKey: string,
  ) => Promise<{success: boolean; data?: {state: string}; error?: {kind: string; status?: number}}>
  readonly listRunApprovals: (runId: string) => Promise<
    | {success: true; data: {approvals: readonly {requestID: string; permission: string; command?: string; filepath?: string}[]}}
    | {success: false; error: {kind: 'http'; status: number}}
    | {success: false; error: {kind: 'network'}}
    | {success: false; error: {kind: 'protocol'}}
  >
}

export interface InitOptions {
  readonly runId: string
  readonly statusEl: Element | null
  readonly noticeEl: Element | null
  readonly outputEl?: (HTMLElement & {hidden: boolean}) | null
  readonly coalescedEl?: (HTMLElement & {hidden: boolean}) | null
  /** Approval prompts container element (data-role="run-approvals"). */
  readonly approvalsEl?: (HTMLElement & {hidden: boolean}) | null
  /** Approval count badge element (data-role="approval-badge"). */
  readonly badgeEl?: (HTMLElement & {hidden: boolean}) | null
  /** Injectable approval client for testing. If absent, buildApprovalClient() is used. */
  readonly approvalClient?: ApprovalClient | null
  /** Optional endpoint base for fixture mode (default: '/operator'). */
  readonly endpointBase?: string
  /** Fixture session ID (fixture mode only). Appended as query param to stream URL and approval requests. */
  readonly fixtureSessionId?: string
  /** Secondary status metadata element (data-role="run-reason"). */
  readonly reasonEl?: Element | null
  /** Cancel control container element (data-role="run-cancel"). */
  readonly cancelEl?: (HTMLElement & {hidden: boolean}) | null
  /** Injectable cancel client for testing. If absent, buildCancelClient() is used. */
  readonly cancelClient?: CancelControlClient | null
}

export declare function initOperatorStream(opts: InitOptions): StreamHandle

export declare function bootstrapOperatorStreams(opts?: {readonly endpointBase?: string; readonly fixtureSessionId?: string}): void

/**
 * Reset the bootstrap-called flag.
 * Called by the React runtime seam cleanup to allow remount after auth expiry.
 * Internal to the runtime seam contract — not part of the public operator API.
 */
export declare function resetBootstrapState(): void

// ---------------------------------------------------------------------------
// Exported for direct testing (approval client + prompt renderer)
// ---------------------------------------------------------------------------

/** Browser-direct approval client factory. Returns refreshCsrf/decideRunApproval/listRunApprovals. */
export declare function buildApprovalClient(opts?: {readonly endpointBase?: string; readonly fixtureSessionId?: string}): ApprovalClient

// ---------------------------------------------------------------------------
// Browser-direct cancel client
// ---------------------------------------------------------------------------

/** Terminal phase carried by a successful cancel response (UPPERCASE wire values). */
export type CancelTerminalPhase = 'COMPLETED' | 'FAILED' | 'CANCELLED'

/**
 * Run lifecycle phases. Mirrors src/gateway/operator-contract/run-status.ts RunPhase.
 */
export type RunPhase = 'PENDING' | 'ACKNOWLEDGED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

/**
 * The 7-value operator-facing web status set. Mirrors
 * src/gateway/operator-contract/run-status.ts OperatorWebStatus.
 */
export type OperatorWebStatus =
  | 'queued'
  | 'blocked'
  | 'running'
  | 'waiting_for_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

/**
 * Local mirror of src/gateway/operator-contract/run-status.ts PHASE_TO_WEB_STATUS.
 * Maps a RunPhase to its lowercase web status. Drift with the vendored TypeScript
 * source is caught by a conformance test.
 */
export declare const PHASE_TO_WEB_STATUS: Readonly<Record<RunPhase, OperatorWebStatus>>

/** Parsed success payload for a cancel response. */
export interface CancelRunResult {
  readonly ok: true
  readonly runId: string
  readonly phase: CancelTerminalPhase
}

/** Discriminated failure classes for cancelRun. */
export type CancelRunError =
  | {readonly kind: 'validation'; readonly code: string}
  | {readonly kind: 'http'; readonly status: number}
  | {readonly kind: 'network'}
  | {readonly kind: 'protocol'}

export type CancelRunOutcome =
  | {readonly success: true; readonly data: CancelRunResult}
  | {readonly success: false; readonly error: CancelRunError}

/** Browser-direct cancel client interface (for testing injection). */
export interface CancelClient {
  readonly cancelRun: (runId: string, idempotencyKey: string, csrfToken: string) => Promise<CancelRunOutcome>
}

/**
 * Cancel client shape used by the cancel control (renderCancelControl) and
 * InitOptions.cancelClient — includes refreshCsrf, which buildCancelClient's
 * cancelRun-only CancelClient does not carry on its own.
 */
export interface CancelControlClient extends CancelClient {
  readonly refreshCsrf: () => Promise<{success: boolean; data?: {csrfToken: string}; error?: {kind: string; status?: number}}>
}

/** Optional coarse logger — receives only route template + status, never sensitive values. */
export interface CancelClientLogger {
  readonly error: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * Browser-direct cancel client factory. Returns cancelRun().
 *
 * Mirrors buildApprovalClient's CSRF + idempotency + one-retry-on-400 + no-leak
 * posture. The optional logger receives only the static route template
 * ('/operator/runs/:runId/cancel') and a coarse HTTP status — never runId,
 * csrfToken, idempotencyKey, or response body.
 */
export declare function buildCancelClient(opts?: {
  readonly endpointBase?: string
  readonly fixtureSessionId?: string
  readonly logger?: CancelClientLogger
}): CancelControlClient

/**
 * Bounded retry count for a transient (HTTP 503) cancel response. This handler
 * owns the retry bound — the reducer intentionally does not track attempt counts.
 */
export declare const CANCEL_RETRY_MAX_ATTEMPTS: number

/** Fixed allowlisted cancel-control interaction states (never a raw wire value). */
export type CancelControlState =
  | 'idle'
  | 'armed'
  | 'pending'
  | 'retrying'
  | 'cancelled'
  | 'unavailable'
  | 'session-expired'
  | 'transport-failure'

export interface CancelControlHandle {
  readonly el: HTMLElement
  /** Called when a terminal status frame arrives for this run from any source. */
  readonly notifyTerminal: () => void
  /**
   * Tear down the control: marks it disposed (fencing any in-flight cancel
   * attempt and its retry timer from ever mutating the UI again) and clears
   * any pending retry timer. Call on stream close/teardown.
   */
  readonly dispose: () => void
}

/**
 * Render a Cancel control with an inline two-step confirm for a single run.
 * Exported for direct unit testing.
 */
export declare function renderCancelControl(
  runId: string,
  cancelClient: CancelControlClient,
  onCancelDispatch: (runId: string) => void,
): CancelControlHandle

/**
 * Render a single open approval prompt into a container element.
 * Uses safe DOM (textContent only — never innerHTML or HTML interpolation).
 * Exported for direct unit testing of the safe-DOM inertness guarantee.
 *
 * @param prompt - An open ApprovalFrameDataOpen object from getOpenApprovals.
 * @param runId - The run ID (for the decision POST).
 * @param approvalClient - The browser-direct approval client.
 * @param onSettle - Called when the prompt is settled (to trigger DOM cleanup).
 * @returns The rendered prompt element.
 */
export declare function renderApprovalPrompt(
  prompt: ApprovalFrameDataOpen,
  runId: string,
  approvalClient: ApprovalClient,
  onSettle: () => void,
): HTMLElement
