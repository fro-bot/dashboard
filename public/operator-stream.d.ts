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
/** Cap on open questions per run (the gateway's list cap). Excess opens are rejected, never evicting. */
export declare const MAX_OPEN_QUESTIONS: number
/**
 * Mirrors the gateway's pending-question list cap (50). A list at or above it may be
 * truncated, so the question reconcile is additive only for it.
 */
export declare const GATEWAY_PENDING_QUESTIONS_CAP: number
/** Decision states a 200 can carry. Mirrors the vendored `QUESTION_DECISION_STATES`. */
export declare const QUESTION_DECISION_STATES: readonly ['claimed', 'already_claimed', 'already_settled', 'failed_to_settle']
/** Reasons a 400 can carry. Mirrors the vendored `QUESTION_INVALID_REASONS`. */
export declare const QUESTION_INVALID_REASONS: readonly [
  'malformed',
  'arity-mismatch',
  'unknown-option',
  'multiple-not-allowed',
  'empty-value',
  'text-too-long',
]
/** Delays between successive re-lists after an `already_claimed`: about 2, 5, 10 and 20 seconds, then stop. */
export declare const QUESTION_CLAIM_RECHECK_DELAYS_MS: readonly number[]

/** Operator-safe failure-reason code. */
export type FailureKind =
  | 'inactivity-timeout'
  | 'max-duration-timeout'
  | 'stream-ended'
  | 'workspace-unreachable'
  | 'session-error'
  | 'checkout-substituted'
  | 'workspace-unavailable'
  | 'unknown'

/**
 * Dashboard-owned display labels for known failure reasons, keyed by FailureKind.
 * Must stay identical (keys and label values) to the map exported from
 * public/operator-run-index.js — parity is enforced by tests.
 */
export declare const FAILURE_REASON_LABELS: Readonly<Record<FailureKind, string>>

// ---------------------------------------------------------------------------
// Checkout provenance / checkout preparation (closed browser DTOs)
//
// These are NOT the wire shapes: free-form strings are already sanitized and
// capped, lists are bounded, SHAs are validated 40-hex, and the upstream
// timestamps (observedAt, checkedAt) are not carried.
// ---------------------------------------------------------------------------

export type CheckoutOperation = 'none' | 'merge' | 'rebase' | 'am' | 'cherry-pick' | 'revert' | 'bisect'

export type CheckoutLayoutReason =
  | 'core-worktree'
  | 'gitfile'
  | 'symlinked-git-dir'
  | 'symlinked-config'
  | 'alternates'
  | 'replace-refs'
  | 'grafts'
  | 'shallow'
  | 'partial-clone'
  | 'linked-worktree'
  | 'unsupported-index-flag'
  | 'bare-repository'

export type CheckoutObstructionKind = 'exact-conflict' | 'prefix-conflict' | 'identical-content' | 'symlink-ancestor'

export type CheckoutUpdateFailureReason =
  | 'aborted'
  | 'inspection-failed'
  | 'fetch-auth-rejected'
  | 'fetch-not-found'
  | 'fetch-forbidden'
  | 'fetch-rate-limited'
  | 'fetch-unreachable'
  | 'fetch-timeout'
  | 'fetch-failed'
  | 'remote-moved'
  | 'apply-failed'
  | 'termination-unconfirmed'

export type CheckoutRefusalReason =
  | 'needs-recovery'
  | 'checkout-substituted'
  | 'unsupported-layout'
  | 'unsupported-config'
  | 'operation-in-progress'
  | 'dirty'
  | 'submodule-initialized'
  | 'detached'
  | 'non-default-branch'
  | 'diverged'
  | 'ahead'
  | 'obstructed'
  | 'maintenance-hold'

/** At most MAX_CHECKOUT_LIST_ENTRIES sanitized entries plus a count of the rest. */
export interface CheckoutBoundedList<T> {
  readonly items: readonly T[]
  readonly more: number
}

export type CheckoutHead =
  | {readonly kind: 'attached'; readonly branch: string; readonly sha: string}
  | {readonly kind: 'detached'; readonly sha: string}

export type CheckoutWorktree =
  | {readonly kind: 'clean'}
  | {
    readonly kind: 'dirty'
    readonly staged: number
    readonly unstaged: number
    readonly untracked: number
    readonly conflicted: number
  }

export type CheckoutRemote =
  | {readonly kind: 'not-checked'}
  | {
    readonly kind: 'checked'
    readonly change: 'unchanged'
    readonly defaultBranch: string
    readonly sha: string
  }
  | {
    readonly kind: 'checked'
    readonly change: 'fast-forward'
    readonly defaultBranch: string
    readonly sha: string
    readonly fromSha: string
  }

export type CheckoutProvenance =
  | {
    readonly kind: 'observed'
    readonly head: CheckoutHead
    readonly worktree: CheckoutWorktree
    readonly operation: CheckoutOperation
    readonly remote: CheckoutRemote
  }
  | {readonly kind: 'unavailable'; readonly remote: CheckoutRemote}

export type CheckoutPreparationRefused =
  | {readonly outcome: 'refused'; readonly reason: 'needs-recovery'}
  | {readonly outcome: 'refused'; readonly reason: 'checkout-substituted'}
  | {readonly outcome: 'refused'; readonly reason: 'unsupported-layout'; readonly layoutReason: CheckoutLayoutReason}
  | {
    readonly outcome: 'refused'
    readonly reason: 'unsupported-config'
    readonly disallowedKeys: CheckoutBoundedList<string>
  }
  | {readonly outcome: 'refused'; readonly reason: 'operation-in-progress'; readonly operation: CheckoutOperation}
  | {readonly outcome: 'refused'; readonly reason: 'dirty'; readonly changedPaths: CheckoutBoundedList<string>}
  | {
    readonly outcome: 'refused'
    readonly reason: 'submodule-initialized'
    readonly submodules: CheckoutBoundedList<string>
  }
  | {readonly outcome: 'refused'; readonly reason: 'detached'}
  | {readonly outcome: 'refused'; readonly reason: 'non-default-branch'; readonly branch: string}
  | {readonly outcome: 'refused'; readonly reason: 'diverged'}
  | {readonly outcome: 'refused'; readonly reason: 'ahead'}
  | {
    readonly outcome: 'refused'
    readonly reason: 'obstructed'
    readonly obstructions: CheckoutBoundedList<{readonly path: string; readonly kind: CheckoutObstructionKind}>
  }
  | {readonly outcome: 'refused'; readonly reason: 'maintenance-hold'}

export interface CheckoutPreparationFailed {
  readonly outcome: 'failed'
  readonly reason: CheckoutUpdateFailureReason
  readonly mutationStarted: boolean | 'possibly'
  readonly permanent: boolean
}

export type CheckoutPreparation = CheckoutPreparationRefused | CheckoutPreparationFailed

/** Per-string cap for every free-form checkout string. */
export declare const MAX_CHECKOUT_STRING_CHARS: number
/** Entries kept per free-form checkout list. */
export declare const MAX_CHECKOUT_LIST_ENTRIES: number

/** Dashboard-owned labels. Each map's keys equal the vendored vocabulary; tests enforce it. */
export declare const CHECKOUT_REFUSAL_REASON_LABELS: Readonly<Record<CheckoutRefusalReason, string>>
export declare const CHECKOUT_UPDATE_FAILURE_REASON_LABELS: Readonly<Record<CheckoutUpdateFailureReason, string>>
export declare const CHECKOUT_LAYOUT_REASON_LABELS: Readonly<Record<CheckoutLayoutReason, string>>
export declare const CHECKOUT_OBSTRUCTION_KIND_LABELS: Readonly<Record<CheckoutObstructionKind, string>>
/** Every operation except `none`, which deliberately renders nothing. */
export declare const CHECKOUT_OPERATION_LABELS: Readonly<Record<Exclude<CheckoutOperation, 'none'>, string>>
export declare const CHECKOUT_PREPARATION_HEADLINE_LABELS: Readonly<Record<'refused' | 'failed', string>>
export declare const CHECKOUT_FAILURE_FLAG_LABELS: Readonly<
  Record<'permanent' | 'mutationStarted' | 'mutationPossibly', string>
>
export declare const CHECKOUT_PROVENANCE_LABELS: Readonly<
  Record<
    | 'headAttached'
    | 'headDetached'
    | 'worktreeClean'
    | 'worktreeDirty'
    | 'operationInProgress'
    | 'remoteNotChecked'
    | 'remoteUpToDate'
    | 'remoteFastForwarded'
    | 'unavailable',
    string
  >
>

/** Fill `{name}` tokens in a label template in a single pass; values are never re-scanned. */
export declare function fillLabelTemplate(template: string, values: Readonly<Record<string, string | number>>): string

/** Strip control and bidi characters, then cap with a trailing ellipsis (within the cap). */
export declare function sanitizeCheckoutText(value: string, cap?: number): string

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
  /** Closed, sanitized DTO. Omitted when absent or invalid. */
  readonly checkoutProvenance?: CheckoutProvenance
  /** Closed, sanitized DTO. Omitted when absent or invalid. */
  readonly checkoutPreparation?: CheckoutPreparation
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

/** One selectable option. Both strings are sanitized, bounded, untrusted plain text. */
export interface QuestionOption {
  readonly label: string
  readonly description: string
}

/** One question of a request. All strings are sanitized, bounded, untrusted plain text. */
export interface QuestionPrompt {
  readonly header: string
  readonly text: string
  readonly options: readonly QuestionOption[]
  readonly multiple: boolean
  readonly custom: boolean
}

/** A pending question request: the request ID and its parsed prompts, in question order. */
export interface QuestionRequest {
  readonly requestID: string
  readonly questions: readonly QuestionPrompt[]
}

export interface QuestionFrameDataOpen extends QuestionRequest {
  readonly runId: string
  readonly settled: false
}

export interface QuestionFrameDataSettle {
  readonly runId: string
  readonly requestID: string
  readonly settled: true
}

export type QuestionFrameData = QuestionFrameDataOpen | QuestionFrameDataSettle

export type StreamFrame =
  | {readonly type: 'ready'; readonly data: ReadyFrameData}
  | {readonly type: 'status'; readonly data: StatusFrameData}
  | {readonly type: 'reset'; readonly data: ResetFrameData}
  | {readonly type: 'output'; readonly data: OutputFrameData}
  | {readonly type: 'approval'; readonly data: ApprovalFrameData}
  | {readonly type: 'question'; readonly data: QuestionFrameData}

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
   * What the run started from. Latest valid value wins; an absent or invalid frame value
   * keeps this one. Exclusive with `checkoutPreparation`. In-memory only; never part of
   * toSafeRunView.
   */
  readonly checkoutProvenance?: CheckoutProvenance
  /**
   * Why checkout preparation refused or failed. Latest valid value wins; exclusive with
   * `checkoutProvenance`. In-memory only; never part of toSafeRunView.
   */
  readonly checkoutPreparation?: CheckoutPreparation
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
   * Open question requests keyed by requestID, in arrival order (capped at MAX_OPEN_QUESTIONS).
   * Absent until the first question frame or reconcile for this run. Use
   * `getOpenQuestions(runEntry)` to read. Tombstones and drafts are NOT here: they live in the
   * page store so they outlast this run entry.
   */
  readonly questionOpen?: ReadonlyMap<string, QuestionRequest>
  /**
   * Request IDs this page got `already_claimed` for. The gateway omits claimed requests from the
   * pending list, so the question reconcile never removes these for being absent. Empty until the
   * question client populates it.
   */
  readonly questionClaimedExempt?: ReadonlySet<string>
  /** True once a question reconcile result has been applied for this run. Gates the `running` fallback. */
  readonly questionReconcileDone?: boolean
  /**
   * True when the run's output is gone because its gateway snapshot expired: set by a
   * `reset` (`no-snapshot`) for a run known terminal, or by a terminal status frame after such a
   * reset with no output since. Cleared by an output frame. Rendered as fixed in-card copy.
   */
  readonly outputUnavailable?: boolean
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

/** Statuses a run-list summary can carry. */
export type RunSummaryStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface StreamState {
  readonly connection: ConnectionStatus
  readonly runs: Readonly<Record<string, RunEntry>>
  readonly retryCount: number
  readonly shouldReconnect: boolean
  /**
   * The run-list summary status for the stream's run, when the caller has one. A terminal value lets
   * a `reset` (`no-snapshot`) close the card with that status and the unavailable state, without
   * waiting for a status frame the gateway may never send.
   */
  readonly summaryStatus?: RunSummaryStatus
  /**
   * Null-prototype map of runId → true after a `reset` (`no-snapshot`) left the run live. A terminal
   * status frame with no output since shows the unavailable state; an output frame clears the mark.
   */
  readonly snapshotMissing?: Readonly<Record<string, true>>
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

/**
 * Result of a pending-question list check, applied as a diff against a pre-GET snapshot.
 *
 * - snapshotIds: request IDs open locally BEFORE the GET. Only these may be removed, so a request
 *   that opened over SSE during the await is never pruned.
 * - requests: the valid listed requests. Listed and not tombstoned → added. A request in
 *   `snapshotIds` and absent from here is removed WITHOUT a tombstone, unless it is claimed-exempt.
 * - invalidBody: the response body failed validation → no change at all.
 * - partial: the caller dropped invalid entries → additive only.
 *
 * A list of GATEWAY_PENDING_QUESTIONS_CAP or more requests is also additive only. Sets
 * `questionReconcileDone`. Failures (network, 429, 5xx) are never dispatched.
 */
export interface QuestionReconcileEvent {
  readonly type: 'question-reconcile'
  readonly runId: string
  readonly snapshotIds: readonly string[]
  readonly requests: readonly QuestionRequest[]
  readonly invalidBody: boolean
  readonly partial: boolean
  /**
   * Set by the live-transition check: end every claimed exemption before the removal diff, so a
   * claimed request still absent after a reconnect is removed (its settle frame was likely missed).
   */
  readonly endClaimedExemptions?: boolean
}

/**
 * This page's own decision got `claimed` or `already_settled`: tombstone the request for the page and
 * remove it, with its draft and exemption, exactly as a settle frame would. Not gated on the connection.
 */
export interface QuestionResolvedEvent {
  readonly type: 'question-resolved'
  readonly runId: string
  readonly requestID: string
}

/** This page got `already_claimed` for an open request: exempt it from removal by list absence. */
export interface QuestionClaimedEvent {
  readonly type: 'question-claimed'
  readonly runId: string
  readonly requestID: string
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
  | QuestionReconcileEvent
  | QuestionResolvedEvent
  | QuestionClaimedEvent
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

/** The run's open question requests in arrival order; empty when there are none. */
export declare function getOpenQuestions(runEntry: RunEntry | undefined | null): readonly QuestionRequest[]

/** True iff the run has at least one open question request. */
export declare function hasOpenQuestions(runEntry: RunEntry | undefined | null): boolean

/**
 * The status to render: terminal wins; else wire `waiting_for_approval`; else a `running` run with
 * an open question → `waiting_for_question`; else a wire `waiting_for_question` with no open question
 * after a completed reconcile → `running`; else the wire value. Derived at render, never stored.
 * Returns '' for an absent entry.
 */
export declare function getEffectiveStatus(runEntry: RunEntry | undefined | null): string

/**
 * Page-level question record for a run. Tombstones (settled requests, never evicted) and drafts
 * outlive stream handles so a collapsed and re-expanded card sees them. In memory only; the record
 * is live and callers mutate it directly. Created on first use.
 */
export interface QuestionPageRecord {
  readonly tombstones: Set<string>
  readonly drafts: Map<string, unknown>
}

export declare function getQuestionPageStore(runId: string): QuestionPageRecord

/** Drop every run's tombstones and drafts (tests; page teardown). */
export declare function resetQuestionPageStore(): void

// ---------------------------------------------------------------------------
// DOM shell (browser-only — never called at module top-level)
// ---------------------------------------------------------------------------

/** A decision for one question request: skip it, or answer with one entry per question, in order. */
export type QuestionDecision =
  | {readonly decision: 'skip'}
  | {
    readonly decision: 'answer'
    readonly answers: readonly {readonly options?: readonly number[]; readonly text?: string}[]
  }

export type QuestionDecisionState = (typeof QUESTION_DECISION_STATES)[number]
export type QuestionInvalidReason = (typeof QUESTION_INVALID_REASONS)[number]

/**
 * Outcome of `decideRunQuestion`, classified by response.
 * - `decided`: 200 with a known state.
 * - `invalid`: 400 with a `reason`. `reason` and `questionIndex` are both null when the invalid answer
 *   is request-level (unknown reason, or no usable index); `questionIndex` is zero-based and in range.
 *   Also what a second 400 without a `reason` becomes.
 * - `cant-answer`: 404, the masked denial.
 * - `session-expired`: 401/403, from the CSRF fetch or the POST.
 * - `unknown`: the POST was sent and its outcome is unknown (network failure, 429, 5xx, unreadable 200).
 *   Never resubmit; re-list instead.
 * - `failed`: request-level and retryable (never sent, or a 200 with an unknown state).
 */
export type QuestionDecisionOutcome =
  | {readonly kind: 'decided'; readonly state: QuestionDecisionState}
  | {readonly kind: 'invalid'; readonly reason: QuestionInvalidReason | null; readonly questionIndex: number | null}
  | {readonly kind: 'cant-answer'}
  | {readonly kind: 'session-expired'}
  | {readonly kind: 'unknown'}
  | {readonly kind: 'failed'}

export type QuestionListResult =
  | {
    readonly success: true
    readonly data: {
      readonly requests: readonly QuestionRequest[]
      /** The body failed validation (requests is then empty): change nothing. */
      readonly invalidBody: boolean
      /** Entries were dropped (invalid or duplicate): the list is not a complete picture. */
      readonly partial: boolean
    }
  }
  | {readonly success: false; readonly error: {readonly kind: 'http'; readonly status: number}}
  | {readonly success: false; readonly error: {readonly kind: 'network'}}
  | {readonly success: false; readonly error: {readonly kind: 'invalid-id'}}

/** Browser-direct question client (also the injection shape for tests). */
export interface QuestionClient {
  readonly listRunQuestions: (runId: string) => Promise<QuestionListResult>
  readonly decideRunQuestion: (
    runId: string,
    requestId: string,
    decision: QuestionDecision,
  ) => Promise<QuestionDecisionOutcome>
}

/**
 * The UI-facing status of one question request. Stream state, never page-store state. A request with
 * no recorded status is `open`.
 *
 * - `open`: answerable.
 * - `in-flight`: a decision POST is outstanding (disable controls, "Sending answers…").
 * - `claimed-elsewhere`: `already_claimed`; kept, exempt from removal by absence, re-listing on a
 *   bounded backoff and then on "Check again" (`checkQuestions`).
 * - `checking`: a list check is pending (after an unknown outcome, or a manual check).
 * - `gone`: unknown outcome, then the list omitted the request. "This question is no longer open. Your
 *   answer may have been recorded." A note, shown for a request that is no longer in `getQuestions()`.
 * - `invalid`: 400 with a reason; `questionIndex` is the zero-based question, null for the whole request.
 * - `failed-to-settle`: `failed_to_settle`, or any other retryable request-level error. Input kept.
 * - `cant-answer`: masked 404; applies to every open request of the run for this stream.
 * - `session-expired`: 401/403.
 * - `check-failed`: a check the operator is waiting on failed (manual, or after an unknown outcome).
 * - `claimed`: this page's answer was accepted. A note for a request that already left.
 * - `already-settled`: `already_settled`. A note, distinct from `gone` so the copy can differ.
 */
export type QuestionRequestStatus =
  | {readonly kind: 'open'}
  | {readonly kind: 'in-flight'}
  | {readonly kind: 'claimed-elsewhere'}
  | {readonly kind: 'checking'}
  | {readonly kind: 'gone'}
  | {readonly kind: 'invalid'; readonly reason: QuestionInvalidReason | null; readonly questionIndex: number | null}
  | {readonly kind: 'failed-to-settle'}
  | {readonly kind: 'cant-answer'}
  | {readonly kind: 'session-expired'}
  | {readonly kind: 'check-failed'}
  | {readonly kind: 'claimed'}
  | {readonly kind: 'already-settled'}

/** An open request with its parsed prompts and UI-facing status. */
export interface QuestionRequestView extends QuestionRequest {
  readonly status: QuestionRequestStatus
}

/** A request that is no longer open but whose outcome stays on the card: `claimed`, `already-settled` or `gone`. */
export interface QuestionNote {
  readonly requestID: string
  readonly status: QuestionRequestStatus
}

export interface StreamHandle {
  close: () => void
  /**
   * Submit a decision for one open request. Sends nothing (returns the current status) while the request
   * is in flight, being checked or claimed elsewhere, or once the run's questions are known unanswerable.
   * Resolves to the request's status afterwards (after the follow-up check, for an unknown outcome), or
   * null when the request is not open or no question client is wired. Never resubmits on its own.
   */
  decideQuestion: (requestID: string, decision: QuestionDecision) => Promise<QuestionRequestStatus | null>
  /**
   * "Check again": re-list on demand. With a request ID, targets that request; without, every request
   * that is claimed elsewhere or whose last check failed. Those go `checking`; a failed check leaves
   * `check-failed`. Resolves when the check has finished.
   */
  checkQuestions: (requestID?: string) => Promise<void>
  /** Open requests in arrival order with their statuses. */
  getQuestions: () => readonly QuestionRequestView[]
  /** Notes for requests that are no longer open. */
  getQuestionNotes: () => readonly QuestionNote[]
  /** The status of one request, or null when the stream knows nothing about it. */
  getQuestionStatus: (requestID: string) => QuestionRequestStatus | null
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
  /**
   * Checkout-detail region (data-role="run-checkout-detail"): where checkout provenance /
   * preparation is rendered from the sanitized closed DTOs carried by the run entry.
   */
  readonly checkoutEl?: (HTMLElement & {hidden: boolean}) | null
  /** Injectable cancel client for testing. If absent, buildCancelClient() is used. */
  readonly cancelClient?: CancelControlClient | null
  /**
   * Question region element (data-role="run-questions"). Its presence wires the browser question client
   * and renders open requests, state messages, outcomes, and accessible answer controls into this element.
   * Without it (and without `questionClient`) the stream never calls the questions routes.
   */
  readonly questionsEl?: (HTMLElement & {hidden: boolean}) | null
  /** Injectable question client for testing. If absent and `questionsEl` is present, buildQuestionClient() is used. */
  readonly questionClient?: QuestionClient | null
  /**
   * The run-list summary status for this run, when the caller has one. A terminal value lets an
   * expired run (`reset` with `no-snapshot`) show its status plus "Output no longer available."
   * without a status frame. Unknown values are ignored.
   */
  readonly summaryStatus?: RunSummaryStatus
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

/**
 * Browser-direct question client factory. Shares the approval client's CSRF fetch, but classifies a 400
 * by its `reason`: without one it refreshes CSRF and retries once, with one it is an invalid answer and
 * is never retried. No idempotency key. Never logs or stores bodies, answer text or response text.
 */
export declare function buildQuestionClient(opts?: {
  readonly endpointBase?: string
  readonly fixtureSessionId?: string
}): QuestionClient

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
 * The operator-facing web status set. Mirrors
 * src/gateway/operator-contract/run-status.ts OperatorWebStatus.
 */
export type OperatorWebStatus =
  | 'queued'
  | 'blocked'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_question'
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
