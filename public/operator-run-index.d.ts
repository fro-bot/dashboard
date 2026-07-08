/**
 * Type declarations for public/operator-run-index.js.
 * Loaded only by web/src/operator/runtime.ts via dynamic import with ?manual=1.
 */

/** Index-only status set. Stream-only statuses (blocked, waiting_for_approval) are excluded. */
export type RunSummaryStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** Operator-safe failure-reason code (contract 1.6.0). */
export type FailureKind =
  | 'inactivity-timeout'
  | 'max-duration-timeout'
  | 'stream-ended'
  | 'workspace-unreachable'
  | 'session-error'
  | 'unknown'

/** Parsed run summary — closed DTO with only declared fields. */
export interface ParsedRunSummary {
  readonly runId: string
  readonly repo: string
  readonly status: RunSummaryStatus
  readonly createdAt: string
  readonly updatedAt?: string
  readonly failureKind?: FailureKind
}

/** Closed safe-view for rendering — adds statusLabel, excludes unknown fields. */
export interface RunSafeView {
  readonly runId: string
  readonly repo: string
  readonly status: RunSummaryStatus
  readonly statusLabel: string
  readonly createdAt: string
  readonly updatedAt?: string
  /** Pre-resolved dashboard display label for a known failure reason. Never the raw failureKind. */
  readonly reasonLabel?: string
}

export type RunIndexResult =
  | {readonly kind: 'loaded'; readonly summaries: ParsedRunSummary[]}
  | {readonly kind: 'unavailable'; readonly authFailure?: boolean}

export declare const RUN_INDEX_CAP: 100
export declare const VALID_RUN_SUMMARY_STATUSES: ReadonlySet<string>

/**
 * Dashboard-owned display labels for known failure reasons, keyed by FailureKind.
 * Must stay identical (keys and label values) to the map exported from
 * public/operator-stream.js — parity is enforced by tests.
 */
export declare const FAILURE_REASON_LABELS: Readonly<Record<FailureKind, string>>

export declare function parseRunSummaryItem(
  input: unknown,
): {success: true; data: ParsedRunSummary} | {success: false; error: string}

export declare function parseRunSummaryList(
  input: unknown,
): {success: true; data: ParsedRunSummary[]} | {success: false; error: string}

export declare function buildRunSafeView(summary: ParsedRunSummary): RunSafeView

export declare const FETCH_TIMEOUT_MS: number

export declare function fetchRunIndex(opts?: {endpointBase?: string; fixtureSessionId?: string}): Promise<RunIndexResult>

/** Increment generation to invalidate pending inits. Called by the React runtime seam cleanup. */
export declare function resetRunIndexState(): void

/**
 * Mark a runId as stream-attached. Called by the runtime seam after attaching a stream.
 * The marker describes the currently active stream, not historical attachment — it
 * drives the `data-stream-attached` attribute used for styling/testing, not click
 * suppression. Card activation (click/Enter/Space) always calls onSelectRun; the
 * runtime seam's onSelectRun callback decides attach vs collapse.
 */
export declare function markRunStreamAttached(runId: string): void

export declare function initOperatorRunIndex(opts?: {
  endpointBase?: string
  fixtureSessionId?: string
  /**
   * Called when a run card is activated (click/Enter/Space). The DOM shell toggles
   * the card's `data-expanded` and per-card substructure visibility (single-open:
   * expanding one card collapses whichever other card was expanded) before calling
   * this. The runtime seam owns the actual stream attach/close decision — a repeat
   * call for the currently-attached runId means "collapse and close the stream."
   */
  onSelectRun?: (runId: string) => void
  /**
   * A pre-sanitized runId (length-capped + validateDynamicId-checked by the caller)
   * to restore on this mount, e.g. from location.hash after a hard refresh. This is
   * a cold-boot restore, not a click toggle — it is handled by a distinct
   * expand-only path, never by re-invoking onSelectRun's toggle semantics.
   */
  restoreRunId?: string
  /**
   * Called once the restore target is confirmed present in the fetched list and has
   * been expanded. Receives the card element and its safe-view status so the caller
   * can decide reconnect (non-terminal) vs read-only (terminal) without querying the
   * DOM for status again.
   */
  onRestoreRun?: (runId: string, card: Element, status: RunSummaryStatus) => void
  /**
   * Called when restoreRunId is set but absent from the resolved fetch (aged out of
   * the cap or otherwise gone). The caller is responsible for clearing the hash and
   * showing a fixed, path-unaware notice — never echoing the runId.
   */
  onRestoreMiss?: () => void
  /**
   * Called when the /operator/runs fetch itself signals expired/absent auth
   * (401/403). The caller must reclassify to auth-required and skip any restore.
   */
  onAuthRequired?: () => void
}): Promise<void>
