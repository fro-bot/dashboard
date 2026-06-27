/**
 * Logout cache purge — page-side SW cache cleanup.
 *
 * Two-pronged approach:
 *   1. caches.delete(cacheName) — direct Cache Storage API call. Works
 *      even if the SW is mid-update or the tab is closing.
 *   2. postMessage({type:'PURGE_RUNTIME'}) — tells the SW to also delete the
 *      cache from its side, guarding against race conditions.
 *
 * Only runtime caches are purged — NOT the precache. The app shell must
 * survive logout so the next user gets an instant load.
 *
 * Both calls are guarded for environments without caches/serviceWorker (e.g.
 * non-HTTPS, old browsers, test environments).
 */

import {MONITORING_CACHE} from './cache-names.ts'

/**
 * Purge operator runtime caches on logout, auth change, or app-version change.
 * Safe to call without awaiting — errors are swallowed (best-effort).
 */
export function purgeOperatorCache(): void {
  // 1. Direct Cache Storage delete — robust even if SW is mid-update.
  if (typeof caches !== 'undefined') {
    caches.delete(MONITORING_CACHE).catch(() => {
      // Best-effort — ignore errors (quota, permissions, etc.)
    })
  }

  // 2. Tell the SW to also purge — backup for race conditions.
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({type: 'PURGE_RUNTIME'})
  }
}

/**
 * Purge the /api/monitoring runtime cache on logout.
 * @deprecated Use purgeOperatorCache instead.
 * Safe to call without awaiting — errors are swallowed (best-effort).
 */
export function purgeMonitoringCache(): void {
  // 1. Direct Cache Storage delete — robust even if SW is mid-update.
  if (typeof caches !== 'undefined') {
    caches.delete(MONITORING_CACHE).catch(() => {
      // Best-effort — ignore errors (quota, permissions, etc.)
    })
  }

  // 2. Tell the SW to also purge — backup for race conditions.
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({type: 'PURGE_RUNTIME'})
  }
}
