/**
 * Token spec tests — Unit 2
 *
 * Strategy: jsdom does not parse @import'd CSS files, so we cannot test
 * computed CSS custom properties at runtime. Instead we:
 *   1. Assert the theme.ts exported values match the styleguide spec verbatim.
 *   2. Read tokens.css as a text file and assert the documented hex values are
 *      present in the correct theme blocks — a real structural check, not a
 *      tautology (the values come from the styleguide, not from the module).
 *   3. Assert dark ≠ light for every semantic token that differs.
 *   4. Assert the documented WCAG pairings' hex values are present.
 *
 * Source of truth: assets/styleguide.md §5–7
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  brandTokens,
  colorTokens,
  darkThemeValues,
  lightThemeValues,
  motionTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  tokens,
  typographyTokens,
} from './theme.ts'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Read tokens.css as a string for structural assertions */
const tokensCSS = readFileSync(resolve(__dirname, 'tokens.css'), 'utf-8')

/** Extract the dark theme block (between :root, [data-theme="dark"] { ... }) */
const darkBlockMatch = tokensCSS.match(
  /:root,\s*\[data-theme="dark"\]\s*\{([^}]+)\}/s,
)
const darkBlock = darkBlockMatch?.[1] ?? ''

/**
 * Extract the light theme block.
 * The CSS structure is: @media (prefers-color-scheme: light) { :root { ... } }
 * We match the @media block and extract the inner :root content.
 */
const lightBlockMatch = tokensCSS.match(
  /@media\s*\(prefers-color-scheme:\s*light\)\s*\{([\s\S]*?)\n\}/,
)
const lightBlock = lightBlockMatch?.[1] ?? ''

/** Check a CSS var declaration is present in a block */
function hasVar(block: string, varName: string, value: string): boolean {
  // Normalize whitespace and check for `--var-name: value;`
  const pattern = new RegExp(
    `${varName.replace('--', '--')}\\s*:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  )
  return pattern.test(block)
}

// ─── 1. Token module structure ─────────────────────────────────────────────

describe('token module exports', () => {
  it('exports all semantic color token names', () => {
    const required: Array<keyof typeof colorTokens> = [
      'bg',
      'surface',
      'surfaceRaised',
      'surfaceOverlay',
      'border',
      'borderMuted',
      'borderAccent',
      'text',
      'textMuted',
      'textSubtle',
      'textDisabled',
      'accent',
      'accentHover',
      'accentPressed',
      'cta',
      'ctaHover',
      'highlight',
      'success',
      'warning',
      'error',
      'info',
    ]
    for (const key of required) {
      expect(colorTokens).toHaveProperty(key)
      expect(colorTokens[key]).toMatch(/^--color-/)
    }
  })

  it('exports all brand primitive token names', () => {
    const required: Array<keyof typeof brandTokens> = [
      'void',
      'purple',
      'purpleMid',
      'purpleMuted',
      'cyan',
      'cyanBright',
      'cyanAa',
      'cyanAaa',
      'magenta',
      'magentaLight',
      'magentaAaa',
      'amber',
      'amberLarge',
      'white',
      'cream',
    ]
    for (const key of required) {
      expect(brandTokens).toHaveProperty(key)
      expect(brandTokens[key]).toMatch(/^--frobot-/)
    }
  })

  it('exports shadow, typography, spacing, radius, motion tokens', () => {
    expect(Object.keys(shadowTokens).length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(typographyTokens).length).toBeGreaterThanOrEqual(10)
    expect(Object.keys(spacingTokens).length).toBeGreaterThanOrEqual(8)
    expect(Object.keys(radiusTokens).length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(motionTokens).length).toBeGreaterThanOrEqual(8)
  })

  it('tokens object groups all sub-objects', () => {
    expect(tokens.color).toBe(colorTokens)
    expect(tokens.brand).toBe(brandTokens)
    expect(tokens.shadow).toBe(shadowTokens)
    expect(tokens.typography).toBe(typographyTokens)
    expect(tokens.spacing).toBe(spacingTokens)
    expect(tokens.radius).toBe(radiusTokens)
    expect(tokens.motion).toBe(motionTokens)
  })
})

// ─── 2. Dark theme values match styleguide §5 ──────────────────────────────

describe('dark theme values (styleguide §5)', () => {
  it('darkThemeValues.bg is #0d0216 (Void)', () => {
    expect(darkThemeValues.bg).toBe('#0d0216')
  })

  it('darkThemeValues.surface is #1a0b2e (Deep Purple)', () => {
    expect(darkThemeValues.surface).toBe('#1a0b2e')
  })

  it('darkThemeValues.text is #ffffff (Pure White)', () => {
    expect(darkThemeValues.text).toBe('#ffffff')
  })

  it('darkThemeValues.accent is #00bcd4 (Cyber Cyan)', () => {
    expect(darkThemeValues.accent).toBe('#00bcd4')
  })

  it('darkThemeValues.cta is #e91e63 (Neon Magenta)', () => {
    expect(darkThemeValues.cta).toBe('#e91e63')
  })

  it('darkThemeValues.highlight is #ffc107 (Solar Amber)', () => {
    expect(darkThemeValues.highlight).toBe('#ffc107')
  })

  it('darkThemeValues.success is #69f0ae', () => {
    expect(darkThemeValues.success).toBe('#69f0ae')
  })

  it('darkThemeValues.error is #f44336', () => {
    expect(darkThemeValues.error).toBe('#f44336')
  })
})

// ─── 3. Light theme values match styleguide §6 ─────────────────────────────

describe('light theme values (styleguide §6)', () => {
  it('lightThemeValues.bg is #ffffff', () => {
    expect(lightThemeValues.bg).toBe('#ffffff')
  })

  it('lightThemeValues.surface is #f5ebeb (Warm Cream)', () => {
    expect(lightThemeValues.surface).toBe('#f5ebeb')
  })

  it('lightThemeValues.text is #1a0b2e (Deep Purple — AAA on white)', () => {
    expect(lightThemeValues.text).toBe('#1a0b2e')
  })

  it('lightThemeValues.accent is #006064 (Dark Teal — AAA)', () => {
    expect(lightThemeValues.accent).toBe('#006064')
  })

  it('lightThemeValues.cta is #880e4f (Deep Rose — AAA on white)', () => {
    expect(lightThemeValues.cta).toBe('#880e4f')
  })

  it('lightThemeValues.highlight is #e65100 (Burnt Amber — AA Large)', () => {
    expect(lightThemeValues.highlight).toBe('#e65100')
  })
})

// ─── 4. Dark ≠ Light for all semantic tokens ──────────────────────────────

describe('dark and light themes resolve to DISTINCT values', () => {
  const distinctTokens = [
    'bg',
    'surface',
    'surfaceRaised',
    'surfaceOverlay',
    'border',
    'borderMuted',
    'borderAccent',
    'text',
    'textMuted',
    'accent',
    'accentHover',
    'accentPressed',
    'cta',
    'ctaHover',
    'highlight',
    'success',
    'warning',
    'error',
    'info',
  ] as const

  for (const key of distinctTokens) {
    it(`--color-${key.replace(/([A-Z])/g, '-$1').toLowerCase()} differs between dark and light`, () => {
      expect(darkThemeValues[key]).not.toBe(lightThemeValues[key])
    })
  }
})

// ─── 5. CSS file structural checks ────────────────────────────────────────

describe('tokens.css structural integrity', () => {
  it('CSS file exists and is non-empty', () => {
    expect(tokensCSS.length).toBeGreaterThan(500)
  })

  it('contains @theme directive (Tailwind 4 CSS-first)', () => {
    expect(tokensCSS).toContain('@theme')
  })

  it('contains :root block with brand primitives', () => {
    expect(tokensCSS).toContain('--frobot-void: #0d0216')
    expect(tokensCSS).toContain('--frobot-purple: #1a0b2e')
    expect(tokensCSS).toContain('--frobot-cyan: #00bcd4')
    expect(tokensCSS).toContain('--frobot-magenta: #e91e63')
    expect(tokensCSS).toContain('--frobot-amber: #ffc107')
  })

  it('dark theme block contains correct bg and surface values', () => {
    expect(darkBlock).toBeTruthy()
    expect(hasVar(darkBlock, '--color-bg', '#0d0216')).toBe(true)
    expect(hasVar(darkBlock, '--color-surface', '#1a0b2e')).toBe(true)
    expect(hasVar(darkBlock, '--color-text', '#ffffff')).toBe(true)
    expect(hasVar(darkBlock, '--color-accent', '#00bcd4')).toBe(true)
    expect(hasVar(darkBlock, '--color-cta', '#e91e63')).toBe(true)
    expect(hasVar(darkBlock, '--color-highlight', '#ffc107')).toBe(true)
  })

  it('light theme block contains correct bg and surface values', () => {
    expect(lightBlock).toBeTruthy()
    expect(hasVar(lightBlock, '--color-bg', '#ffffff')).toBe(true)
    expect(hasVar(lightBlock, '--color-surface', '#f5ebeb')).toBe(true)
    expect(hasVar(lightBlock, '--color-text', '#1a0b2e')).toBe(true)
    expect(hasVar(lightBlock, '--color-accent', '#006064')).toBe(true)
    expect(hasVar(lightBlock, '--color-cta', '#880e4f')).toBe(true)
  })

  it('contains [data-theme="dark"] selector', () => {
    expect(tokensCSS).toContain('[data-theme="dark"]')
  })

  it('contains [data-theme="light"] selector', () => {
    expect(tokensCSS).toContain('[data-theme="light"]')
  })

  it('contains prefers-color-scheme: light media query', () => {
    expect(tokensCSS).toContain('prefers-color-scheme: light')
  })

  it('contains prefers-reduced-motion override', () => {
    expect(tokensCSS).toContain('prefers-reduced-motion: reduce')
  })
})

// ─── 6. WCAG pairing assertions (styleguide §2.2 and §2.3) ────────────────

describe('WCAG documented pairings — hex values present in token spec', () => {
  /**
   * We assert the token VALUES match the styleguide's documented hex values
   * for the key WCAG pairings. This is a real assertion: the values come from
   * the styleguide spec, not from the module under test.
   *
   * Styleguide §2.2 Dark Mode — key pairings:
   *   White #ffffff on Deep Purple #1a0b2e → 18.56:1 AAA (body text)
   *   White #ffffff on Void #0d0216 → 20.24:1 AAA (body text)
   *   Cyber Cyan #00bcd4 on Deep Purple #1a0b2e → 8.08:1 AAA (links)
   *
   * Styleguide §2.3 Light Mode — key pairings:
   *   Deep Purple #1a0b2e on White #ffffff → 18.56:1 AAA (body text)
   *   Dark Teal #006064 on White #ffffff → 7.35:1 AAA (links)
   *   Deep Rose #880e4f on White #ffffff → 9.45:1 AAA (CTA)
   */

  it('dark: --color-text is #ffffff (White — 18.56:1 AAA on Deep Purple)', () => {
    // Styleguide §2.2: White on Deep Purple = 18.56:1 AAA
    expect(darkThemeValues.text).toBe('#ffffff')
    expect(darkThemeValues.surface).toBe('#1a0b2e')
  })

  it('dark: --color-bg is #0d0216 (Void — 20.24:1 AAA for white text)', () => {
    // Styleguide §2.2: White on Void = 20.24:1 AAA
    expect(darkThemeValues.bg).toBe('#0d0216')
    expect(darkThemeValues.text).toBe('#ffffff')
  })

  it('dark: --color-accent is #00bcd4 (Cyber Cyan — 8.08:1 AAA on Deep Purple)', () => {
    // Styleguide §2.2: Cyber Cyan on Deep Purple = 8.08:1 AAA
    expect(darkThemeValues.accent).toBe('#00bcd4')
    expect(darkThemeValues.surface).toBe('#1a0b2e')
  })

  it('light: --color-text is #1a0b2e (Deep Purple — 18.56:1 AAA on white)', () => {
    // Styleguide §2.3: Deep Purple on White = 18.56:1 AAA
    expect(lightThemeValues.text).toBe('#1a0b2e')
    expect(lightThemeValues.bg).toBe('#ffffff')
  })

  it('light: --color-accent is #006064 (Dark Teal — 7.35:1 AAA on white)', () => {
    // Styleguide §2.3: Dark Teal on White = 7.35:1 AAA
    expect(lightThemeValues.accent).toBe('#006064')
    expect(lightThemeValues.bg).toBe('#ffffff')
  })

  it('light: --color-cta is #880e4f (Deep Rose — 9.45:1 AAA on white)', () => {
    // Styleguide §2.3: Deep Rose on White = 9.45:1 AAA
    expect(lightThemeValues.cta).toBe('#880e4f')
    expect(lightThemeValues.bg).toBe('#ffffff')
  })

  it('dark text-on-surface pairing uses documented values (#ffffff on #1a0b2e)', () => {
    // Explicit WCAG pairing check from the task spec
    expect(darkThemeValues.text).toBe('#ffffff')
    expect(darkThemeValues.surface).toBe('#1a0b2e')
  })
})
