/**
 * Typed fetch for the BFF aggregation JSON endpoint.
 *
 * Fetches /api/monitoring (same-origin, credentials:'include') and returns
 * the already-redacted AggregatorSnapshot. The BFF guarantees redaction
 * server-side — this client is display-only and must never apply its own
 * redaction logic.
 *
 * Error handling:
 * - Network failure → throws (caller handles)
 * - Non-2xx response → throws with status info
 * - JSON parse failure → throws
 *
 * The SPA is untrusted display-only. Redaction is enforced at the BFF seam.
 */

// ---------------------------------------------------------------------------
// Snapshot shape (mirrors src/github/aggregator.ts — kept in sync manually)
// ---------------------------------------------------------------------------

export type CiRollupState = 'green' | 'red' | 'pending' | 'unknown'

export interface RepoCiStatus {
  readonly rollupState: CiRollupState
  readonly failingChecks: number
  readonly openPrCount: number
  readonly openIssueCount: number
  readonly openAlertCount: number | null
  readonly stale: boolean
  readonly fetchedAt: number
}

export interface DashboardRepo {
  readonly node_id: string
  readonly owner: string
  readonly name: string
  readonly full_name: string
  readonly discovery_channel: string
  readonly status: RepoCiStatus
}

export interface AggregatorSnapshot {
  readonly repos: readonly DashboardRepo[]
  readonly staleBanner: boolean
  readonly driftCount: number
  readonly refreshedAt: number | null
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the aggregation snapshot from the BFF.
 *
 * Uses credentials:'include' so the session cookie is forwarded.
 * The BFF endpoint is behind auth — a 401/403 means the session expired.
 *
 * @throws {Error} on network failure, non-2xx response, or JSON parse failure.
 */
export async function fetchAggregationSnapshot(): Promise<AggregatorSnapshot> {
  const res = await fetch('/api/monitoring', {
    method: 'GET',
    credentials: 'include',
    headers: {Accept: 'application/json'},
  })

  if (!res.ok) {
    throw new Error(`BFF aggregation endpoint returned ${res.status} ${res.statusText}`)
  }

  const data = await res.json() as AggregatorSnapshot
  return data
}
