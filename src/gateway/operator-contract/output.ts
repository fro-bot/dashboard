/**
 * Operator run-stream output frame.
 *
 * Vendored from fro-bot/agent
 * packages/gateway/src/operator-contract/output.ts.
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
 * No-output runs: the gateway ALWAYS emits a terminal
 * output frame (empty `text`, `final:true`) so consumers can distinguish
 * "no output" from "missing output". Consumers must still drive completion off
 * the terminal `status` frame and must not block awaiting an output frame —
 * the terminal status frame remains the authoritative completion signal.
 *
 * Expired replay: when the replay entry is gone (aged out, or lost to a gateway
 * restart) the stream emits `reset` (`no-snapshot`) and then, if the run's
 * persisted state is terminal, only the terminal status frame. Persisted state
 * carries no output text, so NO terminal output frame is sent in that case — its
 * absence means "output no longer available", not "no output". Clients must
 * drive completion off the terminal status frame.
 */
export interface OperatorOutputFrame {
  readonly runId: string
  readonly text: string
  readonly final: boolean
  readonly seq: number
  readonly droppedCount?: number
}
