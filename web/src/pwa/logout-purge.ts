/**
 * Logout cache purge — page-side SW cache cleanup.
 *
 * Two-pronged approach:
 *   1. caches.delete(cacheName) — direct Cache Storage API call. Works
 *      even if the SW is mid-update or the tab is closing.
 *   2. postMessage({type:'PURGE_RUNTIME'}) — tells the SW to also delete the
 *      cache, guarding against race conditions.
 *
 * Only runtime caches are purged — NOT the precache. The app shell must
 * survive logout so the next user gets an instant load.
 *
 * Both calls are guarded for environments without caches/serviceWorker (e.g.
 * non-HTTPS, old browsers, test environments).
 */

import {OPERATOR_RUNTIME_CACHE} from './cache-names.ts'

/**
 * Legacy cache name from the monitoring-era SW. Clients that installed the old
 * SW may still have this cache on disk. Purge it alongside the current runtime
 * cache so stale monitoring data does not linger after migration.
 */
const LEGACY_MONITORING_CACHE = 'monitoring-v1'

/**
 * Purge operator runtime caches on logout, auth change, or app-version change.
 * Clears OPERATOR_RUNTIME_CACHE and the legacy MONITORING_CACHE without touching
 * the precache (shell continuity).
 * Safe to call without awaiting — errors are swallowed (best-effort).
 */
export function purgeOperatorCache(): void {
  // Direct Cache Storage delete — robust even if SW is mid-update.
  if (typeof caches !== 'undefined') {
    caches.delete(OPERATOR_RUNTIME_CACHE).catch(() => {
      // Best-effort — ignore errors (quota, permissions, etc.)
    })
    // Legacy purge: remove orphaned monitoring-v1 cache from pre-migration clients.
    caches.delete(LEGACY_MONITORING_CACHE).catch(() => {
      // Best-effort — ignore errors (quota, permissions, etc.)
    })
  }

  // Tell the SW to also purge — backup for race conditions.
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({type: 'PURGE_RUNTIME'})
  }
}
