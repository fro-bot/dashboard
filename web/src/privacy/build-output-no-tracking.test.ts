/**
 * Build-output analytics guard — requires a prior `pnpm build:web` (root
 * `pretest` runs it automatically). Reads `web/dist`, not source: a tracking
 * script only matters once it ships, and injectManifest/Rollup can introduce
 * things source-only checks would never see.
 */

import {readdirSync, readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

// Resolve relative to the web/ root (vitest.config.ts sets root: 'web').
const DIST_DIR = resolve(__dirname, '../../dist')

function readDist(relPath: string): string {
  try {
    return readFileSync(resolve(DIST_DIR, relPath), 'utf-8')
  } catch {
    throw new Error(
      `web/dist/${relPath} not found. Run 'pnpm build:web' before running tests.\n` +
        `Expected path: ${resolve(DIST_DIR, relPath)}`,
    )
  }
}

function assetFileNames(): readonly string[] {
  return readdirSync(resolve(DIST_DIR, 'assets')).filter(name => name.endsWith('.js') || name.endsWith('.css'))
}

/** privacy.html + index.html + every JS/CSS asset actually shipped, keyed by name. */
function shippedFiles(): readonly (readonly [string, string])[] {
  const files: (readonly [string, string])[] = [
    ['privacy.html', readDist('privacy.html')],
    ['index.html', readDist('index.html')],
  ]
  for (const name of assetFileNames()) files.push([`assets/${name}`, readDist(`assets/${name}`)])
  return files
}

/** Only the JS assets — the executable "bundle" a tracking call would live in. */
function jsBundleText(): string {
  return assetFileNames()
    .filter(name => name.endsWith('.js'))
    .map(name => readDist(`assets/${name}`))
    .join('\n')
}

// GUARD: pins privacy.html's "...no analytics or advertising of any kind."
// A future tracker import would ship silently unless something reads the
// built output — source-only checks would miss a script the bundler pulls in.

describe('built client output — no analytics or advertising', () => {
  const TRACKER_TOKENS = [
    'umami',
    'plausible',
    'posthog',
    'gtag',
    'googletagmanager',
    'segment',
    'mixpanel',
    'sentry',
    'sendBeacon',
    'metrics.fro.bot',
  ] as const

  // Assert on the list of offending filenames, never on the file text itself:
  // a `not.toContain` against a minified bundle prints the whole bundle on
  // failure, which buries the one fact you need.
  it.each(TRACKER_TOKENS)('GUARD: no reference to tracker token "%s" in the shipped output', token => {
    const needle = token.toLowerCase()
    const offenders = shippedFiles()
      .filter(([, text]) => text.toLowerCase().includes(needle))
      .map(([name]) => name)

    expect(offenders, `tracker token "${token}" found in: ${offenders.join(', ')}`).toEqual([])
  })

  // Scoped to the JS bundle, not privacy.html itself: privacy.html's one
  // external link (github.com/fro-bot/dashboard/issues) is a page citation,
  // already pinned exactly by content.test.ts, and isn't a network call the
  // browser makes on load — a new fetch/beacon target in the bundle is what
  // this exists to catch.
  it('GUARD: the JS bundle contains no third-party origin beyond the known two', () => {
    const ALLOWED = new Set(['http://www.w3.org', 'https://react.dev'])
    const origins = new Set(jsBundleText().match(/https?:\/\/[a-zA-Z0-9.-]+/g) ?? [])
    const unexpected = [...origins].filter(origin => !ALLOWED.has(origin)).sort()

    // Report every offender at once rather than failing on the first.
    expect(unexpected, `unexpected third-party origins in the JS bundle: ${unexpected.join(', ')}`).toEqual([])
  })
})
