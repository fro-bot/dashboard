/**
 * Fro Bot design token constants.
 *
 * These are the CSS custom property names defined in tokens.css.
 * Import these instead of writing raw CSS var strings in components.
 *
 * Usage:
 *   import { tokens } from './styles/theme.ts'
 *   // In inline styles:
 *   style={{ color: `var(${tokens.color.text})` }}
 *   // In Tailwind 4 arbitrary values:
 *   className={`bg-[var(${tokens.color.bg})]`}
 *
 * Source of truth: assets/styleguide.md §5–7
 */

/** Semantic color token CSS var names */
export const colorTokens = {
  // Backgrounds
  bg: '--color-bg',
  surface: '--color-surface',
  surfaceRaised: '--color-surface-raised',
  surfaceOverlay: '--color-surface-overlay',

  // Borders
  border: '--color-border',
  borderMuted: '--color-border-muted',
  borderAccent: '--color-border-accent',

  // Text
  text: '--color-text',
  textMuted: '--color-text-muted',
  textSubtle: '--color-text-subtle',
  textDisabled: '--color-text-disabled',

  // Interactive
  accent: '--color-accent',
  accentHover: '--color-accent-hover',
  accentPressed: '--color-accent-pressed',

  // CTA
  cta: '--color-cta',
  ctaHover: '--color-cta-hover',

  // Semantic
  highlight: '--color-highlight',
  success: '--color-success',
  warning: '--color-warning',
  error: '--color-error',
  info: '--color-info',
} as const

/** Brand primitive CSS var names */
export const brandTokens = {
  void: '--frobot-void',
  purple: '--frobot-purple',
  purpleMid: '--frobot-purple-mid',
  purpleMuted: '--frobot-purple-muted',
  cyan: '--frobot-cyan',
  cyanBright: '--frobot-cyan-bright',
  cyanAa: '--frobot-cyan-aa',
  cyanAaa: '--frobot-cyan-aaa',
  magenta: '--frobot-magenta',
  magentaLight: '--frobot-magenta-light',
  magentaAaa: '--frobot-magenta-aaa',
  amber: '--frobot-amber',
  amberLarge: '--frobot-amber-large',
  white: '--frobot-white',
  cream: '--frobot-cream',
} as const

/** Shadow CSS var names */
export const shadowTokens = {
  sm: '--shadow-sm',
  md: '--shadow-md',
  lg: '--shadow-lg',
  glow: '--shadow-glow',
  glowMagenta: '--shadow-glow-magenta',
} as const

/** Typography CSS var names */
export const typographyTokens = {
  fontDisplay: '--font-display',
  fontBody: '--font-body',
  fontMono: '--font-mono',

  textDisplay: '--text-display',
  textH1: '--text-h1',
  textH2: '--text-h2',
  textH3: '--text-h3',
  textH4: '--text-h4',
  textBodyLg: '--text-body-lg',
  textBody: '--text-body',
  textBodySm: '--text-body-sm',
  textLabel: '--text-label',
  textCode: '--text-code',

  trackingDisplay: '--tracking-display',
  trackingHeading: '--tracking-heading',
  trackingBody: '--tracking-body',
  trackingLabel: '--tracking-label',
  trackingCode: '--tracking-code',
} as const

/** Spacing CSS var names */
export const spacingTokens = {
  space1: '--space-1',
  space2: '--space-2',
  space3: '--space-3',
  space4: '--space-4',
  space5: '--space-5',
  space6: '--space-6',
  space8: '--space-8',
  space10: '--space-10',
  space12: '--space-12',
  space16: '--space-16',
  space24: '--space-24',
} as const

/** Border radius CSS var names */
export const radiusTokens = {
  sm: '--radius-sm',
  md: '--radius-md',
  lg: '--radius-lg',
  xl: '--radius-xl',
  full: '--radius-full',
} as const

/** Motion CSS var names */
export const motionTokens = {
  durationInstant: '--duration-instant',
  durationFast: '--duration-fast',
  durationNormal: '--duration-normal',
  durationSlow: '--duration-slow',
  durationDeliberate: '--duration-deliberate',

  easeStandard: '--ease-standard',
  easeSpring: '--ease-spring',
  easeOutExpo: '--ease-out-expo',
  easeInOut: '--ease-in-out',
} as const

/** All tokens grouped */
export const tokens = {
  color: colorTokens,
  brand: brandTokens,
  shadow: shadowTokens,
  typography: typographyTokens,
  spacing: spacingTokens,
  radius: radiusTokens,
  motion: motionTokens,
} as const

/**
 * Documented dark-theme token values from styleguide §5.
 * Used in tests to assert the CSS matches the spec.
 */
export const darkThemeValues = {
  bg: '#0d0216',
  surface: '#1a0b2e',
  surfaceRaised: '#2d1b4e',
  surfaceOverlay: '#3d2a5f',
  border: '#3d2a5f',
  borderMuted: '#2d1b4e',
  borderAccent: '#00bcd4',
  text: '#ffffff',
  textMuted: '#f5ebeb',
  accent: '#00bcd4',
  accentHover: '#00e5ff',
  accentPressed: '#00acc1',
  cta: '#e91e63',
  ctaHover: '#f06292',
  highlight: '#ffc107',
  success: '#69f0ae',
  warning: '#ffc107',
  error: '#f44336',
  info: '#00bcd4',
} as const

/**
 * Documented light-theme token values from styleguide §6.
 * Used in tests to assert the CSS matches the spec.
 */
export const lightThemeValues = {
  bg: '#ffffff',
  surface: '#f5ebeb',
  surfaceRaised: '#edd8d8',
  surfaceOverlay: '#e8cccc',
  border: '#d4b8b8',
  borderMuted: '#edd8d8',
  borderAccent: '#006064',
  text: '#1a0b2e',
  textMuted: '#5c4569',
  accent: '#006064',
  accentHover: '#00838f',
  accentPressed: '#004d50',
  cta: '#880e4f',
  ctaHover: '#ad1457',
  highlight: '#e65100',
  success: '#2e7d32',
  warning: '#e65100',
  error: '#c62828',
  info: '#006064',
} as const

export type ColorToken = keyof typeof colorTokens
export type BrandToken = keyof typeof brandTokens
