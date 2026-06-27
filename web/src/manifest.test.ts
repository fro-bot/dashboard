/**
 * Tests for PWA manifest operator-first identity.
 *
 * Covers:
 * - Manifest name/short_name reflects operator app identity (not monitoring dashboard)
 * - Manifest description reflects operator app identity
 * - Manifest start_url is / (canonical operator launch route)
 * - Manifest scope is / (covers the whole origin, not /operator)
 * - Manifest does not contain monitoring-era copy
 */
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

// Read the source manifest from web/public/ (the authoritative source).
// web/dist/manifest.webmanifest is a build artifact; testing the source avoids
// requiring a build step.
const manifestPath = resolve(import.meta.dirname, '../public/manifest.webmanifest')
const manifestRaw = readFileSync(manifestPath, 'utf8')
const m = JSON.parse(manifestRaw) as {
  name: string
  short_name: string
  description: string
  start_url: string
  scope?: string
  display: string
  theme_color: string
  background_color: string
  icons: Array<{src: string; sizes: string; type: string; purpose: string}>
}

describe('PWA manifest — operator-first identity', () => {
  it('manifest name reflects operator app identity (not monitoring dashboard)', () => {
    expect(m.name).not.toContain('Dashboard')
    expect(m.name.toLowerCase()).not.toContain('monitoring')
    expect(m.name.toLowerCase()).toMatch(/operator|fro.?bot/i)
  })

  it('manifest short_name reflects operator app identity', () => {
    expect(m.short_name.toLowerCase()).not.toContain('dashboard')
    expect(m.short_name.toLowerCase()).not.toContain('monitoring')
  })

  it('manifest description reflects operator app identity (not monitoring)', () => {
    expect(m.description.toLowerCase()).not.toContain('monitoring')
    expect(m.description.toLowerCase()).toMatch(/operator|fro.?bot/i)
  })

  it('manifest start_url is / (canonical operator launch route)', () => {
    expect(m.start_url).toBe('/')
  })

  it('manifest scope is / or undefined (covers whole origin, not /operator)', () => {
    if (m.scope !== undefined) {
      expect(m.scope).toBe('/')
      expect(m.scope).not.toBe('/operator')
    }
  })

  it('manifest does not contain monitoring-era copy in any string field', () => {
    const allText = JSON.stringify(m).toLowerCase()
    expect(allText).not.toContain('monitoring dashboard')
    expect(allText).not.toContain('cross-repo footprint')
  })

  it('manifest preserves / as start_url (not /operator)', () => {
    expect(m.start_url).not.toBe('/operator')
    expect(m.start_url).toBe('/')
  })

  it('manifest icons are present and use SVG type', () => {
    expect(m.icons.length).toBeGreaterThan(0)
    for (const icon of m.icons) {
      expect(icon.type).toBe('image/svg+xml')
    }
  })
})
