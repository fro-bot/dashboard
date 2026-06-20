/**
 * Operator UI feature flag reader, gateway operator session feature flag reader,
 * and gateway operator origin reader.
 *
 * Reads DASHBOARD_OPERATOR_UI_ENABLED and DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED
 * via readOptionalSecret.
 * Default: OFF (fail-closed).
 * Only the exact string 'true' (case-insensitive, trimmed) enables the feature.
 * Anything else (null, '', 'false', '1', 'yes') → disabled.
 *
 * The two flags are INDEPENDENT: separate env vars, separate readers, no coupling.
 *
 * DASHBOARD_GATEWAY_OPERATOR_ORIGIN: the trusted, configured origin for the gateway
 * operator session endpoint. This is a SECURITY-CRITICAL value — it must never be
 * derived from the inbound request Host header (which is attacker-influenceable).
 * Defaults to 'https://dashboard.fro.bot' when unset. On parse failure → null
 * (caller must fail closed).
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

// ---------------------------------------------------------------------------
// Gateway operator origin
// ---------------------------------------------------------------------------

/**
 * The pinned public origin for the gateway operator surface.
 * Used as the default when DASHBOARD_GATEWAY_OPERATOR_ORIGIN is unset.
 */
const DEFAULT_GATEWAY_OPERATOR_ORIGIN = 'https://dashboard.fro.bot'

/**
 * Read the trusted gateway operator origin from DASHBOARD_GATEWAY_OPERATOR_ORIGIN.
 *
 * Security invariant: the origin used to build the /operator/session URL must be
 * a CONFIGURED, TRUSTED value — never derived from the inbound request Host header,
 * which is attacker-influenceable and could redirect the forwarded cookie to an
 * attacker-controlled server.
 *
 * Returns the configured origin string when valid, or null when the configured
 * value is present but unparseable as an absolute http(s) origin. Callers must
 * fail closed (deny the request) when null is returned.
 *
 * When unset, defaults to 'https://dashboard.fro.bot' (the pinned public origin).
 */
export function readGatewayOperatorOrigin(): string | null {
  let raw: string | null
  try {
    raw = readOptionalSecret('DASHBOARD_GATEWAY_OPERATOR_ORIGIN')
  } catch {
    // readOptionalSecret throws on embedded newlines — treat as invalid (fail-closed)
    return null
  }

  const candidate = raw ?? DEFAULT_GATEWAY_OPERATOR_ORIGIN

  // Validate: must be an absolute http(s) origin with no path/query/fragment.
  // new URL() throws on invalid input; we also reject non-http(s) schemes.
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }

  // An origin has no path (or only '/'), no search, no hash.
  // Reconstruct the canonical origin string from the parsed URL.
  return parsed.origin
}

/**
 * Read the gateway operator session feature flag.
 *
 * Selects gateway-session vs Arctic auth mode (default: OFF, fail-closed).
 * Only 'true' (case-insensitive, trimmed) enables the gateway-session path.
 * All other values, including null, empty string, 'false', '1', 'yes', disable it.
 *
 * Independent of DASHBOARD_OPERATOR_UI_ENABLED: separate env var, separate reader.
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
