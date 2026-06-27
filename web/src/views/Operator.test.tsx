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

describe('Operator — agent-native state hooks', () => {
  it('operator-shell has data-state matching the state prop', () => {
    render(<Operator state="loading" />)
    const shell = document.querySelector('[data-testid="operator-shell"]')
    expect(shell).not.toBeNull()
    expect(shell?.getAttribute('data-state')).toBe('loading')
  })

  it('operator-shell data-state updates when state prop changes', () => {
    const {rerender} = render(<Operator state="loading" />)
    const shell = document.querySelector('[data-testid="operator-shell"]')
    expect(shell?.getAttribute('data-state')).toBe('loading')
    rerender(<Operator state="ready" />)
    expect(shell?.getAttribute('data-state')).toBe('ready')
  })

  it('operator-shell data-state is "auth-required" for auth-required state', () => {
    render(<Operator state="auth-required" />)
    const shell = document.querySelector('[data-testid="operator-shell"]')
    expect(shell?.getAttribute('data-state')).toBe('auth-required')
  })

  it('operator-shell data-state defaults to "loading" when no state prop given', () => {
    render(<Operator />)
    const shell = document.querySelector('[data-testid="operator-shell"]')
    expect(shell?.getAttribute('data-state')).toBe('loading')
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

// ---------------------------------------------------------------------------
// TDD: New lifecycle tests (RED phase)
// ---------------------------------------------------------------------------

describe('Operator — callback identity stability (ref guard)', () => {
  it('re-render with new inline callback while ready does not cleanup/recreate runtime', async () => {
    const {vi} = await import('vitest')
    const {act} = await import('react')
    const runtimeModule = await import('../operator/runtime.ts')

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    const cleanupMock = vi.fn()
    createSpy.mockImplementation(() => ({
      isMounted: true,
      cleanup: cleanupMock,
    }))

    const {rerender} = render(<Operator state="ready" onRuntimeStateChange={() => {}} />)

    // First render: runtime should be created once
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(cleanupMock).not.toHaveBeenCalled()

    // Re-render with a new inline callback (different identity each render)
    await act(async () => {
      rerender(<Operator state="ready" onRuntimeStateChange={() => {}} />)
    })

    // Runtime must NOT have been cleaned up or recreated due to callback identity change
    expect(cleanupMock).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledTimes(1)

    createSpy.mockRestore()
  })
})

describe('Operator — runtime state wiring', () => {
  it('runtime reporting unavailable triggers onRuntimeStateChange', async () => {
    const {vi} = await import('vitest')
    const runtimeModule = await import('../operator/runtime.ts')

    let capturedOnStateChange: ((state: import('../operator/state.ts').OperatorState) => void) | undefined

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation((opts) => {
      capturedOnStateChange = opts.onStateChange
      return {isMounted: true, cleanup: vi.fn()}
    })

    const onRuntimeStateChange = vi.fn()
    render(<Operator state="ready" onRuntimeStateChange={onRuntimeStateChange} />)

    // Simulate runtime reporting unavailable
    capturedOnStateChange?.('unavailable')

    expect(onRuntimeStateChange).toHaveBeenCalledWith('unavailable')

    createSpy.mockRestore()
  })
})
