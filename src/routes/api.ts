import type {AggregatorSnapshot, DashboardRepo, RepoCiStatus} from '../github/aggregator.ts'
import {Hono} from 'hono'

/** Injectable snapshot provider — returns the current aggregator snapshot. */
export type SnapshotProvider = () => AggregatorSnapshot

/** Empty snapshot returned when no provider is configured. */
const EMPTY_SNAPSHOT: AggregatorSnapshot = {
  repos: [],
  staleBanner: false,
  driftCount: 0,
  refreshedAt: null,
}

// ---------------------------------------------------------------------------
// Client DTO — /api/monitoring
//
// The SPA is an untrusted display-only client. This DTO exposes ONLY what the
// monitoring UI needs. Internal fields (node_id, owner, name, fetchedAt,
// installation_id, redactedNodeIds, redactedDatabaseIds) are NEVER emitted.
// ---------------------------------------------------------------------------

interface MonitoringRepoStatusDto {
  readonly rollupState: RepoCiStatus['rollupState']
  readonly failingChecks: number
  readonly openPrCount: number
  readonly openIssueCount: number
  readonly openAlertCount: number | null
  readonly stale: boolean
}

interface MonitoringRepoDto {
  readonly full_name: string
  readonly discovery_channel: string
  readonly status: MonitoringRepoStatusDto
}

interface MonitoringDto {
  readonly repos: readonly MonitoringRepoDto[]
  readonly staleBanner: boolean
  readonly driftCount: number
  readonly refreshedAt: number | null
}

function toMonitoringRepoDto(repo: DashboardRepo): MonitoringRepoDto {
  return {
    full_name: repo.full_name,
    discovery_channel: repo.discovery_channel,
    status: {
      rollupState: repo.status.rollupState,
      failingChecks: repo.status.failingChecks,
      openPrCount: repo.status.openPrCount,
      openIssueCount: repo.status.openIssueCount,
      openAlertCount: repo.status.openAlertCount,
      stale: repo.status.stale,
    },
  }
}

function toMonitoringDto(snapshot: AggregatorSnapshot): MonitoringDto {
  return {
    repos: snapshot.repos.map(toMonitoringRepoDto),
    staleBanner: snapshot.staleBanner,
    driftCount: snapshot.driftCount,
    refreshedAt: snapshot.refreshedAt,
  }
}

/**
 * Builds the API router.
 *
 * @param getSnapshot - Optional snapshot provider. When absent, returns an empty snapshot.
 *   In production, the real aggregator's `getSnapshot` is injected via server.ts.
 *   Tests inject a fake.
 */
export function buildApiRouter(getSnapshot?: SnapshotProvider): Hono {
  const api = new Hono()

  api.get('/healthz', c => {
    return c.json({ok: true, lastFetch: null, rateLimit: null})
  })

  /**
   * Authenticated internal status API — returns the full AggregatorSnapshot.
   * This endpoint is for internal/operator use only. It is NOT the client DTO.
   * If you need to add a consumer, prefer /api/monitoring (the minimized DTO).
   */
  api.get('/status', c => {
    const snapshot = getSnapshot === undefined ? EMPTY_SNAPSHOT : getSnapshot()
    return c.json(snapshot)
  })

  /**
   * BFF aggregation endpoint for the SPA monitoring view.
   *
   * Returns a MINIMIZED client DTO — only the fields the monitoring UI needs.
   * Internal fields (node_id, owner, name, fetchedAt, installation_id,
   * redactedNodeIds, redactedDatabaseIds) are NEVER emitted to the SPA client.
   *
   * Security invariants:
   * - Cache-Control: no-store — snapshot must never be cached by intermediaries.
   * - Behind auth — the auth middleware in server.ts denies unauthenticated requests.
   * - The SPA is untrusted display-only. Redaction is guaranteed at the aggregator seam.
   * - Denylisted/private repo identifiers are NEVER present in the snapshot output.
   * - The DTO mapper is the final whitelist: only explicitly mapped fields are emitted.
   */
  api.get('/monitoring', c => {
    const snapshot = getSnapshot === undefined ? EMPTY_SNAPSHOT : getSnapshot()
    c.header('Cache-Control', 'no-store')
    return c.json(toMonitoringDto(snapshot))
  })

  return api
}
