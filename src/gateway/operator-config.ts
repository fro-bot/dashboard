/**
 * Operator UI feature flag reader.
 *
 * Reads DASHBOARD_OPERATOR_UI_ENABLED via readOptionalSecret.
 * Default: OFF (fail-closed).
 * Only the exact string 'true' (case-insensitive, trimmed) enables the UI.
 * Anything else (null, '', 'false', '1', 'yes') → disabled.
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
