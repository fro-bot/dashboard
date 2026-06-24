import type {AggregatorSnapshot} from '../github/aggregator.ts'
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

  api.get('/status', c => {
    const snapshot = getSnapshot === undefined ? EMPTY_SNAPSHOT : getSnapshot()
    return c.json(snapshot)
  })

  /**
   * BFF aggregation endpoint for the SPA monitoring view.
   *
   * Returns the ALREADY-REDACTED aggregation snapshot as JSON.
   * Reuses the same aggregator output as /api/status — the denylist-before-query
   * invariant is enforced in the aggregator, not here.
   *
   * Security invariants:
   * - Cache-Control: no-store — snapshot must never be cached by intermediaries.
   * - Behind auth — the auth middleware in server.ts denies unauthenticated requests.
   * - The SPA is untrusted display-only. Redaction is guaranteed at the aggregator seam.
   * - Denylisted/private repo identifiers are NEVER present in the snapshot output.
   */
  api.get('/monitoring', c => {
    const snapshot = getSnapshot === undefined ? EMPTY_SNAPSHOT : getSnapshot()
    c.header('Cache-Control', 'no-store')
    return c.json(snapshot)
  })

  return api
}
