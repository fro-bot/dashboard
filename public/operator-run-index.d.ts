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

export declare function fetchRunIndex(opts: {endpointBase?: string}): Promise<RunIndexResult>

/** Increment generation to invalidate pending inits. Called by the React runtime seam cleanup. */
export declare function resetRunIndexState(): void

export declare function initOperatorRunIndex(opts?: {
  endpointBase?: string
  fixtureSessionId?: string
}): Promise<void>
