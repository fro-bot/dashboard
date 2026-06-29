/**
 * Fixture harness feature flag reader.
 *
 * Reads DASHBOARD_FIXTURE_HARNESS_ENABLED via readOptionalSecret.
 * Default: OFF (fail-closed).
 * Only the exact string 'true' (case-insensitive, trimmed) enables the feature.
 * Anything else (null, '', 'false', '1', 'yes') → disabled.
 *
 * This flag is INDEPENDENT from devAutoLogin, operatorUiEnabled, and
 * gatewayOperatorSessionEnabled: separate env var, separate reader, no coupling.
 *
 * SECURITY INVARIANTS:
 * - Fixture harness is ONLY valid when NODE_ENV !== 'production' AND the bind
 *   host is a loopback address (127.0.0.1, localhost, ::1).
 * - If the flag is enabled on a non-loopback bind, app construction MUST throw.
 * - Fixture routes are public-before-auth ONLY when the full fixture gate is active.
 */
import {readOptionalSecret} from '../secrets.ts'

export interface FixtureHarnessConfig {
  readonly enabled: boolean
}

/**
 * Read the fixture harness feature flag.
 *
 * Fail-closed: only 'true' (case-insensitive, trimmed) enables the harness.
 * All other values, including null, empty string, 'false', '1', 'yes', disable it.
 */
export function readFixtureHarnessConfig(): FixtureHarnessConfig {
  let raw: string | null
  try {
    raw = readOptionalSecret('DASHBOARD_FIXTURE_HARNESS_ENABLED')
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
