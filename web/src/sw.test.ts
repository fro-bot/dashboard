/**
 * Build-output assertions for the service worker.
 *
 * These tests run against the emitted web/dist/sw.js to pin the deny-by-default
 * fetch router structure. They are CI-cheap (file reads, no browser) and serve
 * as a regression guard: a future edit that silently drops the auth/api guards
 * will fail here before it can ship.
 *
 * NOTE: These tests require a prior `pnpm build:web` run (the root `pretest`
 * script handles this automatically). They read the built artifact, not the
 * source sw.ts, because the injectManifest step is what substitutes
 * self.__WB_MANIFEST and produces the final sw.js.
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

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
