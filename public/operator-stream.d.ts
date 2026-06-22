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
export declare const FIRST_FRAME_TIMEOUT_MS: number

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

export type StreamFrame =
  | {readonly type: 'ready'; readonly data: ReadyFrameData}
  | {readonly type: 'status'; readonly data: StatusFrameData}
  | {readonly type: 'reset'; readonly data: ResetFrameData}
  | {readonly type: 'output'; readonly data: OutputFrameData}

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
}

export interface StreamState {
  readonly connection: ConnectionStatus
  readonly runs: Readonly<Record<string, RunEntry>>
  readonly retryCount: number
  readonly shouldReconnect: boolean
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

// ---------------------------------------------------------------------------
// Safe render model
// ---------------------------------------------------------------------------

export interface SafeRunView {
  readonly runId: string
  readonly status: string
  readonly phase: string
  readonly startedAt: string
  readonly stale: boolean
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
 * Returns ONLY: { runId, status, phase, startedAt, stale }
 */
export declare function toSafeRunView(runStatus: {
  readonly runId: string
  readonly status: string
  readonly phase: string
  readonly startedAt: string
  readonly stale: boolean
}): SafeRunView

// ---------------------------------------------------------------------------
// DOM shell (browser-only — never called at module top-level)
// ---------------------------------------------------------------------------

export interface StreamHandle {
  close: () => void
}

export interface InitOptions {
  readonly runId: string
  readonly statusEl: Element | null
  readonly noticeEl: Element | null
  readonly outputEl?: (HTMLElement & {hidden: boolean}) | null
  readonly coalescedEl?: (HTMLElement & {hidden: boolean}) | null
}

export declare function initOperatorStream(opts: InitOptions): StreamHandle

export declare function bootstrapOperatorStreams(): void
