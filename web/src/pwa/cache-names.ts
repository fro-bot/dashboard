/**
 * Shared cache name constants — imported by both the service worker and the
 * page-side logout purge. This module is intentionally Workbox-free so it can
 * be bundled into the page without pulling in Workbox.
 */

/**
 * Runtime cache name for operator-sensitive data.
 * Purged on logout, auth change, and app-version change.
 * Only shell/static assets survive purge (managed by Workbox precache).
 */
export const OPERATOR_RUNTIME_CACHE = 'operator-runtime-v1'
