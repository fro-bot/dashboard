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

export type StreamFrame =
  | {readonly type: 'ready'; readonly data: ReadyFrameData}
  | {readonly type: 'status'; readonly data: StatusFrameData}
  | {readonly type: 'reset'; readonly data: ResetFrameData}

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

export interface RunEntry {
  readonly runId: string
  readonly status: string
  readonly phase: string
  readonly startedAt: string
  readonly stale: boolean
  readonly terminal: boolean
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
}

export declare function initOperatorStream(opts: InitOptions): StreamHandle
