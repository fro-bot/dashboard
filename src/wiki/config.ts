/**
 * Wiki write configuration.
 *
 * Reads the Fro Bot App credential pair, the operator's numeric GitHub ID, and
 * the dashboard origin that write requests must come from. Missing values leave
 * writes off with a reason code. A value that is set but invalid throws, so a
 * misconfigured deployment fails at startup instead of running with writes in an
 * unknown state.
 *
 * Environment:
 * - `DASHBOARD_FRO_BOT_APP_ID`: Fro Bot App ID (single line; `_FILE` supported).
 * - `DASHBOARD_FRO_BOT_APP_KEY`: Fro Bot App private key PEM (`_FILE` supported).
 * - `DASHBOARD_OPERATOR_ID`: operator's numeric GitHub ID, a positive integer.
 * - `DASHBOARD_GATEWAY_OPERATOR_ORIGIN`: expected dashboard origin, read through
 *   the existing gateway operator origin reader.
 */

import process from 'node:process'
import {readGatewayOperatorOrigin} from '../gateway/operator-config.ts'
import {readOptionalMultilineSecret, readOptionalSecret} from '../secrets.ts'

export type WikiWriteOffReason = 'app-credentials-absent' | 'app-credentials-incomplete' | 'operator-id-unset'

export type WikiWriteConfig =
  | {
    readonly enabled: true
    readonly appId: string
    readonly privateKey: string
    readonly operatorId: number
    readonly dashboardOrigin: string
  }
  | {readonly enabled: false; readonly reason: WikiWriteOffReason}

const POSITIVE_INTEGER = /^[1-9]\d*$/u

/** Returns the operator ID, or null when unset. Throws when set but invalid. */
function readOperatorId(): number | null {
  const raw = process.env.DASHBOARD_OPERATOR_ID
  if (raw === undefined) return null

  const trimmed = raw.trim()
  const parsed = POSITIVE_INTEGER.test(trimmed) ? Number(trimmed) : Number.NaN
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError('DASHBOARD_OPERATOR_ID must be a positive integer (fail-closed)')
  }
  return parsed
}

/** Returns the App ID, or null when unset. Throws when set but not a positive integer. */
function readAppId(): string | null {
  const raw = readOptionalSecret('DASHBOARD_FRO_BOT_APP_ID')
  if (raw === null) return null
  const value = raw.trim()
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TypeError('DASHBOARD_FRO_BOT_APP_ID must be a positive integer (fail-closed)')
  }
  return value
}

export function readWikiWriteConfig(): WikiWriteConfig {
  const operatorId = readOperatorId()
  const appId = readAppId()
  const privateKey = readOptionalMultilineSecret('DASHBOARD_FRO_BOT_APP_KEY')

  if (appId === null && privateKey === null) return {enabled: false, reason: 'app-credentials-absent'}
  if (appId === null || privateKey === null) return {enabled: false, reason: 'app-credentials-incomplete'}
  if (operatorId === null) return {enabled: false, reason: 'operator-id-unset'}

  const dashboardOrigin = readGatewayOperatorOrigin()
  if (dashboardOrigin === null) {
    throw new Error('DASHBOARD_GATEWAY_OPERATOR_ORIGIN must be an absolute http(s) origin (fail-closed)')
  }

  return {enabled: true, appId, privateKey, operatorId, dashboardOrigin}
}
