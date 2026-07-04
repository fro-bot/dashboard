/**
 * Type declarations for public/operator-run-index.js.
 * Loaded only by web/src/operator/runtime.ts via dynamic import with ?manual=1.
 */

/** Index-only status set. Stream-only statuses (blocked, waiting_for_approval) are excluded. */
export type RunSummaryStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** Parsed run summary — closed DTO with only declared fields. */
export interface ParsedRunSummary {
  readonly runId: string
  readonly repo: string
  readonly status: RunSummaryStatus
  readonly createdAt: string
  readonly updatedAt?: string
}

/** Closed safe-view for rendering — adds statusLabel, excludes unknown fields. */
export interface RunSafeView {
  readonly runId: string
  readonly repo: string
  readonly status: RunSummaryStatus
  readonly statusLabel: string
  readonly createdAt: string
  readonly updatedAt?: string
}

export type RunIndexResult =
  | {readonly kind: 'loaded'; readonly summaries: ParsedRunSummary[]}
  | {readonly kind: 'unavailable'}

export declare const RUN_INDEX_CAP: 100
export declare const VALID_RUN_SUMMARY_STATUSES: ReadonlySet<string>

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
}): Promise<void>
