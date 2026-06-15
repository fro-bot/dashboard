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

  return api
}
