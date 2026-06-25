/**
 * Logout cache purge — page-side SW cache cleanup.
 *
 * On logout, the NetworkFirst strategy would serve cached /api/monitoring data
 * to a logged-out user when the live fetch 401s. This purge prevents that.
 *
 * Two-pronged approach (belt + suspenders):
 *   1. caches.delete(MONITORING_CACHE) — direct Cache Storage API call. Works
 *      even if the SW is mid-update or the tab is closing.
 *   2. postMessage({type:'PURGE_RUNTIME'}) — tells the SW to also delete the
 *      cache from its side. Belt-and-suspenders for the case where the page-side
 *      delete races with a SW cache write.
 *
 * Only the runtime cache is purged — NOT the precache. The app shell must
 * survive logout so the next user gets an instant load.
 *
 * Both calls are guarded for environments without caches/serviceWorker (e.g.
 * non-HTTPS, old browsers, test environments).
 */

import {MONITORING_CACHE} from './cache-names.ts'

/**
 * Purge the /api/monitoring runtime cache on logout.
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
