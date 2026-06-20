/**
 * Operator UI feature flag reader and gateway operator session feature flag reader.
 *
 * Reads DASHBOARD_OPERATOR_UI_ENABLED and DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED
 * via readOptionalSecret.
 * Default: OFF (fail-closed).
 * Only the exact string 'true' (case-insensitive, trimmed) enables the feature.
 * Anything else (null, '', 'false', '1', 'yes') → disabled.
 *
 * The two flags are INDEPENDENT: separate env vars, separate readers, no coupling.
 */
import {readOptionalSecret} from '../secrets.ts'

export interface OperatorUiConfig {
  readonly enabled: boolean
}

/**
 * Read the operator UI feature flag.
 *
 * Fail-closed: only 'true' (case-insensitive, trimmed) enables the UI.
 * All other values, including null, empty string, 'false', '1', 'yes', disable it.
 */
export function readOperatorUiConfig(): OperatorUiConfig {
  let raw: string | null
  try {
    raw = readOptionalSecret('DASHBOARD_OPERATOR_UI_ENABLED')
  } catch {
    // readOptionalSecret throws on embedded newlines — treat as disabled (fail-closed)
    return {enabled: false}
  }

  if (raw === null) {
    return {enabled: false}
  }

  const trimmed = raw.trim().toLowerCase()
  return {enabled: trimmed === 'true'}
}

export interface GatewayOperatorSessionConfig {
  readonly enabled: boolean
}

/**
 * Read the gateway operator session feature flag.
 *
 * Selects gateway-session vs Arctic auth mode (default: OFF, fail-closed).
 * Only 'true' (case-insensitive, trimmed) enables the gateway-session path.
 * All other values, including null, empty string, 'false', '1', 'yes', disable it.
 *
 * Independent of DASHBOARD_OPERATOR_UI_ENABLED (KTD5): separate env var, separate reader.
 */
export function readGatewayOperatorSessionConfig(): GatewayOperatorSessionConfig {
  let raw: string | null
  try {
    raw = readOptionalSecret('DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED')
  } catch {
    // readOptionalSecret throws on embedded newlines — treat as disabled (fail-closed)
    return {enabled: false}
  }

  if (raw === null) {
    return {enabled: false}
  }

  const trimmed = raw.trim().toLowerCase()
  return {enabled: trimmed === 'true'}
}
