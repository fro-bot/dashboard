/**
 * Typed fetch for the BFF aggregation JSON endpoint.
 *
 * Fetches /api/monitoring (same-origin, credentials:'include') and returns
 * the minimized client DTO. The BFF guarantees redaction server-side and
 * emits ONLY the fields the monitoring UI needs — this client is display-only
 * and must never apply its own redaction logic.
 *
 * Error handling:
 * - Network failure → throws (caller handles)
 * - Non-2xx response → throws with status info
 * - JSON parse failure → throws
 *
 * The SPA is untrusted display-only. Redaction is enforced at the BFF seam.
 * Internal fields (node_id, owner, name, fetchedAt, installation_id) are
 * NEVER present in the DTO — the BFF mapper strips them before emission.
 */

// ---------------------------------------------------------------------------
// Client DTO shape (mirrors MonitoringDto in src/routes/api.ts — kept in sync manually)
//
// IMPORTANT: This DTO intentionally omits internal fields present in the
// server-side AggregatorSnapshot/DashboardRepo:
//   - node_id      (internal identifier — not needed for display)
//   - owner        (derivable from full_name if needed)
//   - name         (derivable from full_name if needed)
//   - fetchedAt    (internal cache timestamp — not rendered)
//   - installation_id (internal auth context — never client-visible)
// ---------------------------------------------------------------------------

export type CiRollupState = 'green' | 'red' | 'pending' | 'unknown'

export interface RepoCiStatus {
  readonly rollupState: CiRollupState
  readonly failingChecks: number
  readonly openPrCount: number
  readonly openIssueCount: number
  readonly openAlertCount: number | null
  readonly stale: boolean
}

export interface DashboardRepo {
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
