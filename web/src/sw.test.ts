/**
 * Service worker tests — build-output assertions (require a prior `pnpm build:web`):
 * - Pins the deny-by-default fetch router structure.
 * - Pins that /api/monitoring NetworkFirst route is ABSENT (monitoring removed).
 * - Pins the /operator navigation redirect handler is present BEFORE generic nav fallback.
 * - Pins the PURGE_RUNTIME message handler targets operator runtime caches only.
 *
 * Build-output tests read the built artifact, not the source sw.ts, because the
 * injectManifest step substitutes self.__WB_MANIFEST and produces the final sw.js.
 * The root `pretest` script runs `pnpm build:web` automatically.
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

// Resolve relative to the web/ root (vitest.config.ts sets root: 'web').
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
    // The precache manifest rewrites index.html → '/' via manifestTransforms so
    // Workbox's install-time fetch hits GET / (200) not GET /index.html (404).
    expect(content).not.toMatch(/"url":"index\.html"/)
    expect(content).toContain('"url":"/"')
  })

  // SECURITY GUARD: deny-by-default auth/api routing.
  // These assertions pin the load-bearing safety boundary. If either guard is
  // dropped, the SW would intercept OAuth callbacks or serve cached API responses
  // to unauthenticated users.

  it('GUARD: /auth/ routes are NetworkOnly (auth must reach the server)', () => {
    const content = readSW()
    expect(content).toContain('/auth/')
  })

  it('GUARD: /api/ routes are NetworkOnly (default-deny API caching)', () => {
    const content = readSW()
    expect(content).toContain('/api/')
  })

  it('GUARD: NavigationRoute denylist contains /auth/ and /api/ regex patterns', () => {
    const content = readSW()
    expect(content).toMatch(/\\\/auth/)
    expect(content).toMatch(/\\\/api/)
  })

  // REGRESSION: /api/monitoring NetworkFirst route MUST be absent.

  it('REGRESSION: /api/monitoring NetworkFirst route is ABSENT from the built SW', () => {
    const content = readSW()
    expect(content).not.toContain('/api/monitoring')
  })

  it('REGRESSION: X-From-Cache stale-snapshot header is ABSENT from the built SW', () => {
    const content = readSW()
    expect(content).not.toContain('X-From-Cache')
  })

  it('REGRESSION: X-Cached-At stale-snapshot header is ABSENT from the built SW', () => {
    const content = readSW()
    expect(content).not.toContain('X-Cached-At')
  })

  // /operator navigation redirect handler must fire BEFORE the generic NavigationRoute.

  it('GUARD: /operator navigation redirect handler is present in the built SW', () => {
    const content = readSW()
    expect(content).toContain('/operator')
  })

  it('GUARD: source registers /operator redirect handler BEFORE the generic NavigationRoute', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const operatorRedirectIdx = src.indexOf('/operator')
    const navHandlerIdx = src.indexOf("createHandlerBoundToURL('/')")
    expect(operatorRedirectIdx).toBeGreaterThan(-1)
    expect(navHandlerIdx).toBeGreaterThan(-1)
    expect(operatorRedirectIdx).toBeLessThan(navHandlerIdx)
  })

  it('GUARD: source registers the precache BEFORE the NavigationRoute (createHandlerBoundToURL resolves against the precache at call time)', () => {
    // When createHandlerBoundToURL runs before precacheAndRoute(), Workbox throws
    // `non-precached-url` and the SW never registers (silent SPA degradation).
    const src = readFileSync(
      resolve(import.meta.dirname, 'sw.ts'),
      'utf8',
    )
    const precacheIdx = src.indexOf('precacheAndRoute(self.__WB_MANIFEST)')
    const navHandlerIdx = src.indexOf("createHandlerBoundToURL('/')")
    expect(precacheIdx).toBeGreaterThan(-1)
    expect(navHandlerIdx).toBeGreaterThan(-1)
    expect(precacheIdx).toBeLessThan(navHandlerIdx)
  })

  it('GUARD: PURGE_RUNTIME message handler is present in the built SW', () => {
    const content = readSW()
    expect(content).toContain('PURGE_RUNTIME')
  })

  it('GUARD: purge handler targets operator-runtime-v1 (positive assertion)', () => {
    const content = readSW()
    expect(content).toContain('operator-runtime-v1')
  })

  it('GUARD: purge handler also deletes legacy monitoring-v1 cache (migration cleanup)', () => {
    const content = readSW()
    expect(content).toContain('monitoring-v1')
  })

  it('GUARD: purge handler does NOT delete the precache (workbox-precache-v2)', () => {
    const content = readSW()
    expect(content).not.toContain('workbox-precache-v2')
  })

  // The SW itself and the manifest must NOT be in the precache list (served with
  // no-cache headers; must not be stale-served from precache).

  it('sw.js is NOT in the precache list', () => {
    const content = readSW()
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
    expect(content).toMatch(/"url":"assets\/index-[A-Za-z0-9_-]+\.js"/)
    expect(content).toMatch(/"url":"assets\/index-[A-Za-z0-9_-]+\.css"/)
  })

  // Security: operator data must never be cached.

  it('SECURITY: /operator/auth/ routes are covered by the NetworkOnly denylist', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    expect(src).toMatch(/operator\/auth/)
  })

  // Push, notificationclick, pushsubscriptionchange handlers.

  it('GUARD: push, notificationclick, and pushsubscriptionchange listeners are registered', () => {
    const content = readSW()
    expect(content).toMatch(/addEventListener\(`push`/)
    expect(content).toMatch(/addEventListener\(`notificationclick`/)
    expect(content).toMatch(/addEventListener\(`pushsubscriptionchange`/)
  })

  it('GUARD: push handler references showNotification and touches no cache API', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const pushHandlerStart = src.indexOf("addEventListener('push'")
    const pushHandlerEnd = src.indexOf("addEventListener('notificationclick'")
    expect(pushHandlerStart).toBeGreaterThan(-1)
    expect(pushHandlerEnd).toBeGreaterThan(pushHandlerStart)
    const pushHandlerSource = src.slice(pushHandlerStart, pushHandlerEnd)
    expect(pushHandlerSource).toContain('showNotification')
    expect(pushHandlerSource).not.toContain('caches.')
    expect(pushHandlerSource).not.toContain('cache.put')
  })

  it('GUARD: notificationclick handler opens the literal / (open-redirect guard)', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const clickHandlerStart = src.indexOf("addEventListener('notificationclick'")
    const clickHandlerEnd = src.indexOf("addEventListener('pushsubscriptionchange'")
    expect(clickHandlerStart).toBeGreaterThan(-1)
    expect(clickHandlerEnd).toBeGreaterThan(clickHandlerStart)
    const clickHandlerSource = src.slice(clickHandlerStart, clickHandlerEnd)
    expect(clickHandlerSource).toContain("openWindow('/')")
    // Never reads notification.data (or any payload field) as a navigation target.
    expect(clickHandlerSource).not.toContain('.data.route')
    expect(clickHandlerSource).not.toContain('notification.data')
  })

  it('GUARD: pushsubscriptionchange handler posts only {type: PUSH_SUBSCRIPTION_CHANGE} — no endpoint/keys/identity', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const changeHandlerStart = src.indexOf("addEventListener('pushsubscriptionchange'")
    expect(changeHandlerStart).toBeGreaterThan(-1)
    const changeHandlerSource = src.slice(changeHandlerStart)
    expect(changeHandlerSource).toContain('PUSH_SUBSCRIPTION_CHANGE')
    expect(changeHandlerSource).not.toContain('endpoint')
    expect(changeHandlerSource).not.toContain('p256dh')
  })

  it('GUARD: pushsubscriptionchange handler performs no resubscribe — no pushManager.subscribe call', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const changeHandlerStart = src.indexOf("addEventListener('pushsubscriptionchange'")
    expect(changeHandlerStart).toBeGreaterThan(-1)
    const changeHandlerSource = src.slice(changeHandlerStart)
    expect(changeHandlerSource).not.toContain('pushManager.subscribe')
    expect(changeHandlerSource).not.toContain('applicationServerKey')
  })

  it('GUARD: the push/notificationclick/pushsubscriptionchange handlers are registered AFTER the message handler', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'sw.ts'), 'utf8')
    const messageHandlerIdx = src.indexOf("addEventListener('message'")
    const pushHandlerIdx = src.indexOf("addEventListener('push'")
    expect(messageHandlerIdx).toBeGreaterThan(-1)
    expect(pushHandlerIdx).toBeGreaterThan(-1)
    expect(messageHandlerIdx).toBeLessThan(pushHandlerIdx)
  })
})
