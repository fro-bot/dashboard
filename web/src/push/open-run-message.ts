/**
 * The page side of the notification-click handoff.
 *
 * `notification-click.ts` (service worker) posts `{type: 'OPEN_RUN', runId}` to an open dashboard
 * window. This parser is the only thing the page trusts about that message's body: anything that is
 * not exactly that shape, with a `runId` that passes the strict run ID pattern, is `null`. No
 * `console.*` calls: a run ID must never be logged.
 */

import {RUN_ID_PATTERN} from '../operator/run-id.ts'

export const OPEN_RUN_MESSAGE_TYPE = 'OPEN_RUN'

export interface OpenRunMessage {
  readonly runId: string
}

/** An own data property's value, or `undefined` when absent or an accessor (a getter is never invoked). */
function ownDataValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}

/**
 * Parse a service-worker message body. Accepts a plain object (a structured-clone result) with
 * exactly the own keys `type` and `runId`, `type === 'OPEN_RUN'`, and a `runId` matching
 * `RUN_ID_PATTERN`.
 */
export function parseOpenRunMessage(data: unknown): OpenRunMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const proto = Object.getPrototypeOf(data) as unknown
  if (proto !== Object.prototype && proto !== null) return null

  const keys = Object.keys(data)
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('runId')) return null

  if (ownDataValue(data, 'type') !== OPEN_RUN_MESSAGE_TYPE) return null
  const runId = ownDataValue(data, 'runId')
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return null
  return {runId}
}
