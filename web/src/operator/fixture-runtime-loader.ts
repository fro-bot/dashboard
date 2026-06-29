/**
 * Fixture-aware runtime loader for the operator PWA.
 *
 * This module is ONLY imported in development builds (import.meta.env.DEV).
 * Production browser bundles must not contain fixture route strings, fixture
 * flags, or fallback paths. Vite's tree-shaking removes this module from
 * production output when it is only imported behind an import.meta.env.DEV guard.
 *
 * Design:
 * - Reads the fixture session from the fixture session endpoint.
 * - Passes the fixture endpoint base and session ID to the runtime loader.
 * - On failure, maps to the existing 'unavailable' state without path-specific copy.
 * - CSRF is NOT fetched here; public modules fetch it via ${endpointBase}/session/csrf.
 *
 * Security invariants:
 * - Never logs fixture session IDs or fixture endpoint paths.
 * - Failure maps to the canonical 'unavailable' state — no path-specific oracle copy.
 * - Only active when import.meta.env.DEV is true.
 */

import {FIXTURE_OPERATOR_PREFIX} from '../../../src/gateway/operator-fixture-routes.ts'

export {FIXTURE_OPERATOR_PREFIX}

export interface FixtureSession {
  readonly fixtureMode: true
  readonly fixtureSessionId: string
}

export interface FixtureRuntimeConfig {
  readonly endpointBase: string
  readonly fixtureSessionId: string
  readonly scenario: string
}

/**
 * Fetch a fixture session from the fixture session endpoint.
 *
 * Returns the fixture session on success, or null on failure.
 * Failure is silent — the caller maps it to 'unavailable'.
 *
 * The session response contains {fixtureMode: true, fixtureSessionId, ...normalSessionFields}.
 * CSRF is NOT included here; public modules fetch it separately via /session/csrf.
 */
export async function fetchFixtureSession(): Promise<FixtureSession | null> {
  try {
    const res = await globalThis.fetch(`${FIXTURE_OPERATOR_PREFIX}/session`, {
      credentials: 'include',
      redirect: 'error',
      headers: {'content-type': 'application/json'},
    })
    if (!res.ok) return null
    const data = await res.json() as unknown
    if (
      data === null ||
      typeof data !== 'object' ||
      !('fixtureMode' in data) ||
      (data as {fixtureMode: unknown}).fixtureMode !== true ||
      !('fixtureSessionId' in data) ||
      typeof (data as {fixtureSessionId: unknown}).fixtureSessionId !== 'string'
    ) {
      return null
    }
    return {
      fixtureMode: true,
      fixtureSessionId: (data as {fixtureSessionId: string}).fixtureSessionId,
    }
  } catch {
    return null
  }
}

/**
 * Build the fixture runtime config from a fixture session and selected scenario.
 */
export function buildFixtureRuntimeConfig(
  session: FixtureSession,
  scenario: string,
): FixtureRuntimeConfig {
  return {
    endpointBase: FIXTURE_OPERATOR_PREFIX,
    fixtureSessionId: session.fixtureSessionId,
    scenario,
  }
}
