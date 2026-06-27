import {render, screen} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {Operator} from './Operator.tsx'

describe('Operator', () => {
  it('renders without throwing', () => {
    expect(() => render(<Operator />)).not.toThrow()
  })

  it('renders a clear heading for the operator shell', () => {
    render(<Operator />)
    const heading = screen.getByRole('heading')
    expect(heading).toBeInTheDocument()
  })

  it('renders a live region for state changes', () => {
    render(<Operator />)
    const liveRegion = document.querySelector('[aria-live]')
    expect(liveRegion).not.toBeNull()
  })

  // Regression: no monitoring artifacts

  it('does not render monitoring dashboard title', () => {
    render(<Operator />)
    expect(screen.queryByText(/repository status/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/monitoring/i)).not.toBeInTheDocument()
  })

  it('does not render monitoring filter controls', () => {
    render(<Operator />)
    expect(screen.queryByPlaceholderText(/filter repos/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', {name: /filter by state/i})).not.toBeInTheDocument()
  })

  it('does not render monitoring test IDs', () => {
    render(<Operator />)
    expect(document.querySelector('[data-testid="monitoring-view"]')).toBeNull()
    expect(document.querySelector('[data-testid="monitoring-loading"]')).toBeNull()
    expect(document.querySelector('[data-testid="monitoring-offline"]')).toBeNull()
    expect(document.querySelector('[data-testid="monitoring-empty"]')).toBeNull()
    expect(document.querySelector('[data-testid="stale-cache-banner"]')).toBeNull()
  })

  it('does not render stale snapshot notice', () => {
    render(<Operator />)
    expect(screen.queryByText(/showing cached data/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/offline — no cached data available/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/showing data from/i)).not.toBeInTheDocument()
  })

  it('does not render a repository grid', () => {
    render(<Operator />)
    const repoLinks = document.querySelectorAll('a[href*="github.com"]')
    expect(repoLinks).toHaveLength(0)
  })

  it('operator shell has a stable focus order (heading before content)', () => {
    render(<Operator />)
    const heading = screen.getByRole('heading')
    expect(heading).toBeInTheDocument()
    const allElements = Array.from(document.body.querySelectorAll('*'))
    const headingIndex = allElements.indexOf(heading)
    const contentArea = document.querySelector('[data-testid="operator-content"]')
    if (contentArea) {
      const contentIndex = allElements.indexOf(contentArea)
      expect(headingIndex).toBeLessThan(contentIndex)
    }
  })

  it('renders operator shell content without hover-only interactions', () => {
    render(<Operator />)
    const buttons = screen.queryAllByRole('button')
    for (const btn of buttons) {
      const hasText = btn.textContent && btn.textContent.trim().length > 0
      const hasAriaLabel = btn.hasAttribute('aria-label')
      expect(hasText || hasAriaLabel).toBe(true)
    }
  })
})
