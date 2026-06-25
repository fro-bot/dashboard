/**
 * Pure header-transform utilities for the service worker stale-signal plugin.
 *
 * Extracted from sw.ts so they can be unit-tested without importing Workbox
 * (which executes SW-environment code at import time and throws in jsdom/Node).
 *
 * These functions have no side effects and no Workbox dependencies — they only
 * operate on standard Web API Response objects.
 */

/**
 * Returns a new Response with X-Cached-At set to the current timestamp (ms).
 * Called on cache write (cacheWillUpdate) to stamp when the response was stored.
 * Body and all existing headers are preserved. The original response is not mutated.
 */
export function addCachedAtHeader(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Cached-At', String(Date.now()))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Returns a new Response with X-From-Cache: true added.
 * Called on cache read (cachedResponseWillBeUsed) to signal the app that
 * this response came from the SW cache (i.e., the network was unavailable).
 * Returns undefined when cachedResponse is undefined (cache miss passthrough).
 * The original response is not mutated.
 */
export function markFromCache(cachedResponse: Response | undefined): Response | undefined {
  if (cachedResponse === undefined) return undefined
  const headers = new Headers(cachedResponse.headers)
  headers.set('X-From-Cache', 'true')
  return new Response(cachedResponse.body, {
    status: cachedResponse.status,
    statusText: cachedResponse.statusText,
    headers,
  })
}
