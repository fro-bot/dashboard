import {render, screen} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {Operator} from './Operator.tsx'
import type {OperatorState} from '../operator/state.ts'

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

describe('Operator — state prop rendering', () => {
  it('renders loading state with connecting headline', () => {
    render(<Operator state="loading" />)
    expect(screen.getByRole('heading')).toBeInTheDocument()
    const liveRegion = document.querySelector('[aria-live]')
    expect(liveRegion).not.toBeNull()
  })

  it('renders auth-required state with sign-in headline', () => {
    render(<Operator state="auth-required" />)
    expect(screen.getByText(/sign in required/i)).toBeInTheDocument()
  })

  it('renders rate-limited state with rate-limit headline', () => {
    render(<Operator state="rate-limited" />)
    expect(screen.getByText(/too many requests/i)).toBeInTheDocument()
  })

  it('renders offline state with no-connection headline', () => {
    render(<Operator state="offline" />)
    expect(screen.getByText(/no connection/i)).toBeInTheDocument()
  })

  it('renders unavailable state with service-unavailable headline', () => {
    render(<Operator state="unavailable" />)
    expect(screen.getByText(/service unavailable/i)).toBeInTheDocument()
  })

  it('renders ready state with operator headline', () => {
    render(<Operator state="ready" />)
    expect(screen.getByRole('heading', {level: 1})).toBeInTheDocument()
  })
})

describe('Operator — disabled action reasons', () => {
  const disabledStates: OperatorState[] = ['auth-required', 'rate-limited', 'offline', 'unavailable', 'loading']

  for (const state of disabledStates) {
    it(`renders a visible action-disabled reason for ${state}`, () => {
      render(<Operator state={state} />)
      const reasonEl = document.querySelector('[data-testid="operator-action-reason"]')
      expect(reasonEl).not.toBeNull()
      expect(reasonEl?.textContent?.trim().length).toBeGreaterThan(0)
    })
  }

  it('does not render action-disabled reason for ready state', () => {
    render(<Operator state="ready" />)
    const reasonEl = document.querySelector('[data-testid="operator-action-reason"]')
    expect(reasonEl).toBeNull()
  })
})

describe('Operator — aria-live region', () => {
  it('has aria-live="polite" region', () => {
    render(<Operator />)
    const liveRegion = document.querySelector('[aria-live="polite"]')
    expect(liveRegion).not.toBeNull()
  })

  it('aria-live region contains state detail text for auth-required', () => {
    render(<Operator state="auth-required" />)
    const liveRegion = document.querySelector('[aria-live="polite"]')
    expect(liveRegion?.textContent).toMatch(/session/i)
  })

  it('aria-live region contains state detail text for offline', () => {
    render(<Operator state="offline" />)
    const liveRegion = document.querySelector('[aria-live="polite"]')
    expect(liveRegion?.textContent).toMatch(/offline|connection/i)
  })

  it('aria-live region contains state detail text for unavailable', () => {
    render(<Operator state="unavailable" />)
    const liveRegion = document.querySelector('[aria-live="polite"]')
    expect(liveRegion?.textContent).toMatch(/error|unexpected/i)
  })
})

describe('Operator — auth expiry clears active state', () => {
  it('auth-required state renders no run output placeholders', () => {
    render(<Operator state="auth-required" />)
    expect(document.querySelector('[data-testid="run-output"]')).toBeNull()
    expect(document.querySelector('[data-testid="run-card"]')).toBeNull()
    expect(document.querySelector('[data-testid="run-list"]')).toBeNull()
  })

  it('auth-required state renders no approval action buttons', () => {
    render(<Operator state="auth-required" />)
    const approvalButtons = document.querySelectorAll('[data-testid="approval-button"]')
    expect(approvalButtons).toHaveLength(0)
  })
})

describe('Operator — copy security', () => {
  const errorStates: OperatorState[] = ['auth-required', 'rate-limited', 'offline', 'unavailable']

  for (const state of errorStates) {
    it(`${state} rendered text does not include raw HTTP status codes`, () => {
      render(<Operator state={state} />)
      const text = document.body.textContent ?? ''
      expect(text).not.toMatch(/\b4\d\d\b/)
      expect(text).not.toMatch(/\b5\d\d\b/)
    })

    it(`${state} rendered text does not include raw API paths`, () => {
      render(<Operator state={state} />)
      const text = document.body.textContent ?? ''
      expect(text).not.toMatch(/\/operator\//)
    })
  }
})
