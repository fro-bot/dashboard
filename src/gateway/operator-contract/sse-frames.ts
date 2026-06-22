/**
 * SSE run-stream frame types for the /operator/runs/:runId/stream endpoint.
 *
 * These mirror the named SSE events emitted by the gateway's web/sse/ surface
 * (a parallel surface to the operator-contract barrel — not part of the contract
 * barrel itself). Vendored from fro-bot/agent v0.72.0 (PRs #961/#962).
 *
 * Named events on the wire:
 *   event: ready  → data: ReadyFrame
 *   event: status → data: StatusFrameData  (same shape as OperatorRunStatus)
 *   event: reset  → data: ResetFrameData
 *   event: output → data: OperatorOutputFrame (contract 1.3.0)
 *
 * Heartbeat is an SSE comment (": heartbeat") — it is NOT a named event and
 * has no corresponding frame type here.
 *
 * Import rewrites applied:
 *   OperatorRunStatus imported from ./run-status.ts (local vendored copy)
 */

import type {OperatorOutputFrame} from './output.ts'
import type {OperatorRunStatus} from './run-status.ts'

// ---------------------------------------------------------------------------
// ResetReason
// ---------------------------------------------------------------------------

/**
 * Reasons the gateway may reset the run stream.
 *
 * Vendored from fro-bot/agent v0.72.0 web/sse/ surface.
 */
export type ResetReason =
  | 'no-snapshot'
  | 'terminal'
  | 'shutdown'
  | 'max-duration'
  | 'writer-error'
  | 'overflow'

// ---------------------------------------------------------------------------
// Frame data shapes
// ---------------------------------------------------------------------------

/**
 * Data payload for the "ready" SSE event.
 * Carries the contract version the gateway is serving.
 */
export interface ReadyFrame {
  readonly contractVersion: string
}

/**
 * Data payload for the "status" SSE event.
 * Identical in shape to OperatorRunStatus — aliased for clarity at the SSE boundary.
 */
export type StatusFrameData = OperatorRunStatus

/**
 * Data payload for the "reset" SSE event.
 * Signals that the stream has been reset and the client should reconnect.
 */
export interface ResetFrameData {
  readonly runId: string
  readonly reason: ResetReason
}

// ---------------------------------------------------------------------------
// Discriminated union for stream consumers
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all named SSE frames on the run stream.
 *
 * The `type` field mirrors the SSE event name, making it safe to dispatch
 * on in a switch/if-else without additional parsing.
 *
 * Usage in a stream reader:
 *   switch (frame.type) {
 *     case 'ready':  // frame.data is ReadyFrame
 *     case 'status': // frame.data is StatusFrameData (OperatorRunStatus)
 *     case 'reset':  // frame.data is ResetFrameData
 *     case 'output': // frame.data is OperatorOutputFrame
 *   }
 */
export type RunStreamFrame =
  | {readonly type: 'ready'; readonly data: ReadyFrame}
  | {readonly type: 'status'; readonly data: StatusFrameData}
  | {readonly type: 'reset'; readonly data: ResetFrameData}
  | {readonly type: 'output'; readonly data: OperatorOutputFrame}
