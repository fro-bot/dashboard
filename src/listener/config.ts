/**
 * Config readers for the operator listener channel.
 *
 * See docs/contracts/operator-listener-channel.md — the authoritative wire contract.
 */
import process from 'node:process'
import {readOptionalSecret} from '../secrets.ts'

/**
 * Shared HMAC key for ingest authentication. Supports the `_FILE` convention
 * via `readOptionalSecret`. Returns null when unset — the caller must NOT
 * mount the ingest route in that case (fail-closed: 404, not an open route).
 */
export function readListenerIngestKey(): string | null {
  return readOptionalSecret('DASHBOARD_LISTENER_INGEST_KEY')
}

/** SQLite file path for the listener message store. */
export function readListenerDbPath(): string {
  return process.env.DASHBOARD_LISTENER_DB ?? '/data/listener/messages.db'
}
