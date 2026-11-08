import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {expect, it} from 'vitest'

it('gives disabled launch controls a token-based unavailable treatment', () => {
  // jsdom does not load the stylesheet imports or resolve the theme tokens.
  const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8')
  const rule = css.match(/#launch-prompt:disabled,\s*#launch-form \.operator-submit-btn:disabled\s*\{([^}]+)\}/s)?.[1]
  expect(rule).toBeDefined()
  expect(rule).toContain('background: var(--color-surface)')
  expect(rule).toContain('border-color: var(--color-border)')
  expect(rule).toContain('color: var(--color-text-muted)')
  expect(rule).toContain('cursor: not-allowed')
  expect(rule).toContain('box-shadow: none')
})
