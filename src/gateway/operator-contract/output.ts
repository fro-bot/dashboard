/**
 * Operator run-stream output frame (contract 1.5.0).
 *
 * Vendored from fro-bot/agent
 * packages/gateway/src/operator-contract/output.ts at v0.78.0.
 *
 * Delivered as `event: output` on GET /operator/runs/:runId/stream, emitted
 * BEFORE the terminal `status` frame.
 *
 * Semantics:
 * - final:false → a live delta; append `text` to the accumulated answer.
 * - final:true  → the authoritative complete answer; it replaces the accumulated
 *   live text. Guaranteed to arrive before the terminal status frame.
 * - seq → monotonic per run from 0; apply deltas in seq order.
 * - droppedCount → number of deltas coalesced under per-subscriber backpressure,
 *   carried on the next emitted output frame. Absent when nothing was coalesced.
 *
 * No-output runs: as of contract 1.5.0 the gateway ALWAYS emits a terminal
 * output frame (empty `text`, `final:true`) so consumers can distinguish
 * "no output" from "missing output". Consumers must still drive completion off
 * the terminal `status` frame and must not block awaiting an output frame —
 * the terminal status frame remains the authoritative completion signal.
 */
export interface OperatorOutputFrame {
  readonly runId: string
  readonly text: string
  readonly final: boolean
  readonly seq: number
  readonly droppedCount?: number
}
