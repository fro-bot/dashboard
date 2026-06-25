/**
 * Shared cache name constants — imported by both the service worker and the
 * page-side logout purge. This module is intentionally Workbox-free so it can
 * be bundled into the page without pulling in Workbox.
 *
 * The service worker imports this and re-exports MONITORING_CACHE so existing
 * imports from sw.ts continue to work.
 */

/** Runtime cache name for the /api/monitoring NetworkFirst route. */
export const MONITORING_CACHE = 'monitoring-v1'
