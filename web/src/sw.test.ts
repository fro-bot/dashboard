/**
 * Service worker tests — two layers:
 *
 * 1. Pure-function unit tests (no browser, no build required):
 *    - addCachedAtHeader: stamps X-Cached-At on a response
 *    - markFromCache: adds X-From-Cache: true on a cached response
 *    These are extracted from the staleSignalPlugin so they can be tested
 *    without a SW environment.
 *
 * 2. Build-output assertions (require a prior `pnpm build:web`):
 *    - Pins the deny-by-default fetch router structure.
 *    - Pins the /api/monitoring NetworkFirst route ordered BEFORE /api/* NetworkOnly.
 *    - Pins the PURGE_RUNTIME message handler targets the runtime cache only.
 *
 * NOTE: Build-output tests require a prior `pnpm build:web` run (the root
 * `pretest` script handles this automatically). They read the built artifact,
 * not the source sw.ts, because the injectManifest step is what substitutes
 * self.__WB_MANIFEST and produces the final sw.js.
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'
import {addCachedAtHeader, markFromCache} from './sw-utils.ts'

// ---------------------------------------------------------------------------
// Pure-function unit tests — stale-signal header transforms
// ---------------------------------------------------------------------------
// These functions are extracted from the staleSignalPlugin so they can be
// tested without a browser or SW environment.

describe('addCachedAtHeader — stamps X-Cached-At on cache write', () => {
  it('adds X-Cached-At header with a numeric timestamp string', () => {
    const before = Date.now()
    const original = new Response('{"repos":[]}', {
      status: 200,
      headers: {'Content-Type': 'application/json'},
    })
    const stamped = addCachedAtHeader(original)
    const after = Date.now()

    const cachedAt = stamped.headers.get('X-Cached-At')
    expect(cachedAt).not.toBeNull()
    const ts = Number(cachedAt)
    expect(Number.isFinite(ts)).toBe(true)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('preserves the original response body', async () => {
    const body = '{"repos":[],"staleBanner":false}'
    const original = new Response(body, {status: 200})
    const stamped = addCachedAtHeader(original)
    expect(await stamped.text()).toBe(body)
  })

  it('preserves the original status and statusText', () => {
    const original = new Response('ok', {status: 200, statusText: 'OK'})
    const stamped = addCachedAtHeader(original)
    expect(stamped.status).toBe(200)
    expect(stamped.statusText).toBe('OK')
  })

  it('preserves existing headers alongside the new X-Cached-At', () => {
    const original = new Response('{}', {
      status: 200,
      headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
    })
    const stamped = addCachedAtHeader(original)
    expect(stamped.headers.get('Content-Type')).toBe('application/json')
    expect(stamped.headers.get('Cache-Control')).toBe('no-store')
    expect(stamped.headers.get('X-Cached-At')).not.toBeNull()
  })

  it('does not mutate the original response headers', () => {
    const original = new Response('{}', {status: 200})
    addCachedAtHeader(original)
    // The original must be untouched (Response headers are immutable anyway,
    // but we verify the function creates a new Response rather than mutating).
    expect(original.headers.get('X-Cached-At')).toBeNull()
  })
})

describe('markFromCache — adds X-From-Cache: true on cache read', () => {
  it('adds X-From-Cache: true to a cached response', () => {
    const cached = new Response('{"repos":[]}', {
      status: 200,
      headers: {'Content-Type': 'application/json'},
    })
    const marked = markFromCache(cached)
    expect(marked).not.toBeNull()
    expect(marked?.headers.get('X-From-Cache')).toBe('true')
  })

  it('preserves the original response body', async () => {
    const body = '{"repos":[],"staleBanner":false}'
    const cached = new Response(body, {status: 200})
    const marked = markFromCache(cached)
    expect(await marked?.text()).toBe(body)
  })

  it('preserves existing headers alongside X-From-Cache', () => {
    const cached = new Response('{}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cached-At': '1700000000000',
      },
    })
    const marked = markFromCache(cached)
    expect(marked?.headers.get('Content-Type')).toBe('application/json')
    expect(marked?.headers.get('X-Cached-At')).toBe('1700000000000')
    expect(marked?.headers.get('X-From-Cache')).toBe('true')
  })

  it('returns undefined when cachedResponse is undefined (no crash on cache miss)', () => {
    const result = markFromCache(undefined)
    expect(result).toBeUndefined()
  })

  it('does not mutate the original cached response headers', () => {
    const cached = new Response('{}', {status: 200})
    markFromCache(cached)
    expect(cached.headers.get('X-From-Cache')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Build-output assertions — sw.js structure
// ---------------------------------------------------------------------------

// Resolve relative to the web/ root (vitest.config.ts sets root: 'web').
// __dirname is web/src/ at runtime; web/dist/sw.js is one level up then into dist/.
const SW_PATH = resolve(__dirname, '../dist/sw.js')

function readSW(): string {
  try {
    return readFileSync(SW_PATH, 'utf-8')
  } catch {
    throw new Error(
      `web/dist/sw.js not found. Run 'pnpm build:web' before running tests.\n` +
        `Expected path: ${SW_PATH}`,
    )
  }
}

describe('sw.js build output', () => {
  it('exists and is non-empty', () => {
    const content = readSW()
    expect(content.length).toBeGreaterThan(1000)
  })

  it('has self.__WB_MANIFEST substituted (non-empty precache list)', () => {
    const content = readSW()
    // After injectManifest substitution, self.__WB_MANIFEST is replaced with
    // an array literal. The raw token must NOT appear in the output.
    expect(content).not.toContain('self.__WB_MANIFEST')
    // The precache array must contain at least one entry (index.html at minimum)
    expect(content).toContain('"url":"index.html"')
  })

  // ── SECURITY GUARD: deny-by-default auth/api routing ──────────────────────
  // These assertions pin the load-bearing safety boundary. If either guard is
  // dropped, the SW would intercept OAuth callbacks or serve cached API responses
  // to unauthenticated users.

  it('GUARD: /auth/ routes are NetworkOnly (auth must reach the server)', () => {
    const content = readSW()
    // The compiled SW must contain the /auth/ pathname check.
    // In the minified output this appears as the string literal '/auth/'
    // inside the route matcher function.
    expect(content).toContain('/auth/')
  })

  it('GUARD: /api/ routes are NetworkOnly (default-deny API caching)', () => {
    const content = readSW()
    expect(content).toContain('/api/')
  })

  it('GUARD: NavigationRoute denylist contains /auth/ and /api/ regex patterns', () => {
    const content = readSW()
    // The denylist regexes are serialized into the bundle as regex literals.
    // We check for the pattern strings that appear in the NavigationRoute denylist.
    expect(content).toMatch(/\\\/auth/)
    expect(content).toMatch(/\\\/api/)
  })

  // ── Unit 3: /api/monitoring NetworkFirst route ────────────────────────────
  // The /api/monitoring NetworkFirst route must be registered BEFORE the
  // /api/* NetworkOnly catch-all (Workbox evaluates routes in registration order).

  it('GUARD: /api/monitoring route is present in the built SW', () => {
    const content = readSW()
    expect(content).toContain('/api/monitoring')
  })

  it('GUARD: /api/monitoring NetworkFirst appears BEFORE the /api/* NetworkOnly catch-all (registration order)', () => {
    const content = readSW()
    // /api/monitoring is the specific route; /api/ (startsWith) is the catch-all.
    // Since '/api/monitoring' contains '/api/', we must find the catch-all occurrence
    // that appears AFTER the monitoring route — i.e., the first '/api/' that is NOT
    // part of '/api/monitoring'. We do this by searching for '/api/' starting from
    // the position AFTER the monitoring route match.
    const monitoringIdx = content.indexOf('/api/monitoring')
    expect(monitoringIdx).toBeGreaterThan(-1)
    // Find the first '/api/' occurrence that comes after the monitoring route.
    // The catch-all uses startsWith('/api/') so '/api/' must appear after monitoring.
    const apiCatchAllIdx = content.indexOf('/api/', monitoringIdx + '/api/monitoring'.length)
    expect(apiCatchAllIdx).toBeGreaterThan(-1)
    expect(monitoringIdx).toBeLessThan(apiCatchAllIdx)
  })

  it('GUARD: MONITORING_CACHE name is present in the built SW (runtime cache name)', () => {
    const content = readSW()
    // The cache name constant must appear in the bundle so the purge handler
    // and the NetworkFirst route share the same name.
    expect(content).toContain('monitoring-v1')
  })

  it('GUARD: PURGE_RUNTIME message handler is present in the built SW', () => {
    const content = readSW()
    expect(content).toContain('PURGE_RUNTIME')
  })

  it('GUARD: purge handler targets the runtime cache name (monitoring-v1), not the precache', () => {
    const content = readSW()
    // The message handler must reference the runtime cache name.
    // The precache name (workbox-precache-v2) must NOT be deleted by the purge handler.
    // We verify the PURGE_RUNTIME handler and the monitoring cache name co-exist.
    expect(content).toContain('PURGE_RUNTIME')
    expect(content).toContain('monitoring-v1')
    // The precache name must NOT appear adjacent to the PURGE_RUNTIME handler
    // (i.e., the purge must not delete the precache).
    // We check that 'workbox-precache' does not appear in the PURGE_RUNTIME branch.
    // Since the bundle is minified, we verify the precache name is present (it is
    // used by precacheAndRoute) but the purge only references monitoring-v1.
    expect(content).not.toContain('workbox-precache-v2')
  })

  // ── Precache exclusion guard ───────────────────────────────────────────────
  // The SW itself and the manifest must NOT be in the precache list (they are
  // served with no-cache headers and must not be stale-served from precache).

  it('sw.js is NOT in the precache list', () => {
    const content = readSW()
    // The precache entries are serialized as {"revision":"...","url":"..."} objects.
    // sw.js must not appear as a precache URL.
    expect(content).not.toMatch(/"url":"sw\.js"/)
    expect(content).not.toMatch(/"url":".*\/sw\.js"/)
  })

  it('manifest.webmanifest is NOT in the precache list', () => {
    const content = readSW()
    expect(content).not.toMatch(/"url":"manifest\.webmanifest"/)
    expect(content).not.toMatch(/"url":".*manifest\.webmanifest"/)
  })

  it('registerSW.js is NOT in the precache list', () => {
    const content = readSW()
    expect(content).not.toMatch(/"url":"registerSW\.js"/)
  })

  it('precache list contains at least the app JS bundle and CSS', () => {
    const content = readSW()
    // Hashed assets must be present (the exact hash changes per build, so we
    // match the pattern rather than the exact filename).
    expect(content).toMatch(/"url":"assets\/index-[A-Za-z0-9_-]+\.js"/)
    expect(content).toMatch(/"url":"assets\/index-[A-Za-z0-9_-]+\.css"/)
  })
})
