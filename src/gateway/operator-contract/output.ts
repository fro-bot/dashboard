/**
 * Operator run-stream output frame (contract 1.3.0).
 *
 * Vendored byte-exact from fro-bot/agent
 * packages/gateway/src/operator-contract/output.ts at tag v0.74.0.
 *
 * Delivered as `event: output` on GET /operator/runs/:runId/stream, emitted
 * BEFORE the terminal `status` frame.
 *
 * Semantics:
 * - final:false → a live delta; append `text` to the accumulated answer.
 * - final:true  → the authoritative complete answer; it replaces the accumulated
 *   live text.
 * - seq → monotonic per run from 0; apply deltas in seq order.
 * - droppedCount → number of deltas coalesced under per-subscriber backpressure,
 *   carried on the next emitted output frame. Absent when nothing was coalesced.
 *
 * No-output runs: the gateway does NOT guarantee a terminal output frame. A run
 * that produced no output reaches terminal `status` with no preceding `output`
 * frame. Consumers must treat "terminal status, no output seen" as the no-output
 * case and never block awaiting an output frame.
 */
export interface OperatorOutputFrame {
  readonly runId: string
  readonly text: string
  readonly final: boolean
  readonly seq: number
  readonly droppedCount?: number
}
