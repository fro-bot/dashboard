/**
 * Result<T,E> error-return seam.
 *
 * Re-exported from `@bfra.me/es/result` — the SAME source the gateway's
 * `@fro-bot/runtime` re-exports from. Keeping the dashboard's app-client error
 * shape identical to the runtime's means a future `@fro.bot/runtime` extraction
 * is a file-move, not a signature migration (plan: Interface Contracts seam).
 *
 * Shape: `Ok<T> = {success: true, data: T}`, `Err<E> = {success: false, error: E}`.
 */
export type {Err, Ok, Result} from '@bfra.me/es/result'
export {err, isErr, isOk, ok} from '@bfra.me/es/result'
