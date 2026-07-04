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

describe('Operator — fixture mode indicator', () => {
  it('renders a fixture-mode indicator when fixtureMode=true', () => {
    render(<Operator state="ready" fixtureMode={true} />)
    const indicator = document.querySelector('[data-testid="fixture-mode-indicator"]')
    expect(indicator).not.toBeNull()
  })

  it('fixture-mode indicator contains text indicating synthetic/local data', () => {
    render(<Operator state="ready" fixtureMode={true} />)
    const indicator = document.querySelector('[data-testid="fixture-mode-indicator"]')
    const text = indicator?.textContent ?? ''
    // Must say something about fixture/synthetic/local mode
    expect(text.toLowerCase()).toMatch(/fixture|synthetic|local/)
  })

  it('does NOT render fixture-mode indicator when fixtureMode is not set', () => {
    render(<Operator state="ready" />)
    const indicator = document.querySelector('[data-testid="fixture-mode-indicator"]')
    expect(indicator).toBeNull()
  })

  it('does NOT render fixture-mode indicator when fixtureMode=false', () => {
    render(<Operator state="ready" fixtureMode={false} />)
    const indicator = document.querySelector('[data-testid="fixture-mode-indicator"]')
    expect(indicator).toBeNull()
  })

  it('fixture-mode indicator is visible in loading state too', () => {
    render(<Operator state="loading" fixtureMode={true} />)
    const indicator = document.querySelector('[data-testid="fixture-mode-indicator"]')
    expect(indicator).not.toBeNull()
  })
})

describe('Operator — fixture scenario selector', () => {
  it('renders a scenario selector when fixtureMode=true and state=ready', () => {
    render(<Operator state="ready" fixtureMode={true} />)
    const selector = document.querySelector('[data-testid="fixture-scenario-select"]')
    expect(selector).not.toBeNull()
  })

  it('scenario selector has options for success, terminal_failure, contract_drift, malformed_unavailable', () => {
    render(<Operator state="ready" fixtureMode={true} />)
    const selector = document.querySelector('[data-testid="fixture-scenario-select"]') as HTMLSelectElement | null
    expect(selector).not.toBeNull()
    const values = Array.from(selector?.options ?? []).map(o => o.value)
    expect(values).toContain('success')
    expect(values).toContain('terminal_failure')
    expect(values).toContain('contract_drift')
    expect(values).toContain('malformed_unavailable')
  })

  it('does NOT render scenario selector when fixtureMode is not set', () => {
    render(<Operator state="ready" />)
    const selector = document.querySelector('[data-testid="fixture-scenario-select"]')
    expect(selector).toBeNull()
  })

  it('does NOT render scenario selector when state is not ready', () => {
    render(<Operator state="loading" fixtureMode={true} />)
    const selector = document.querySelector('[data-testid="fixture-scenario-select"]')
    expect(selector).toBeNull()
  })
})

describe('Operator — fixture mode passes endpointBase to runtime', () => {
  it('createOperatorRuntime is called with fixtureMode=true and fixtureEndpointBase when fixtureMode prop is set', async () => {
    const {vi} = await import('vitest')
    const runtimeModule = await import('../operator/runtime.ts')

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    render(<Operator state="ready" fixtureMode={true} fixtureEndpointBase="/__fixture/operator" />)

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        fixtureMode: true,
        fixtureEndpointBase: '/__fixture/operator',
      })
    )

    createSpy.mockRestore()
  })

  it('createOperatorRuntime is called without fixtureMode when prop is not set', async () => {
    const {vi} = await import('vitest')
    const runtimeModule = await import('../operator/runtime.ts')

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    render(<Operator state="ready" />)

    const callArgs = createSpy.mock.calls[0]?.[0]
    expect(callArgs?.fixtureMode).toBeFalsy()

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

describe('Operator — fixture scenario and sessionId wired to runtime', () => {
  it('createOperatorRuntime is called with fixtureSessionId when fixtureMode=true', async () => {
    const {vi} = await import('vitest')
    const runtimeModule = await import('../operator/runtime.ts')

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    render(<Operator state="ready" fixtureMode={true} fixtureEndpointBase="/__fixture/operator" fixtureSessionId="fixture-session-0001" />)

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        fixtureSessionId: 'fixture-session-0001',
      })
    )

    createSpy.mockRestore()
  })

  it('createOperatorRuntime is called with a getScenario function when fixtureMode=true', async () => {
    const {vi} = await import('vitest')
    const runtimeModule = await import('../operator/runtime.ts')

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    render(<Operator state="ready" fixtureMode={true} fixtureEndpointBase="/__fixture/operator" fixtureSessionId="fixture-session-0001" />)

    const callArgs = createSpy.mock.calls[0]?.[0]
    expect(typeof callArgs?.getScenario).toBe('function')

    createSpy.mockRestore()
  })

  it('getScenario returns the currently selected scenario value', async () => {
    const {vi} = await import('vitest')
    const runtimeModule = await import('../operator/runtime.ts')

    let capturedGetScenario: (() => string) | undefined
    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation((opts) => {
      capturedGetScenario = opts.getScenario
      return {isMounted: true, cleanup: vi.fn()}
    })

    render(<Operator state="ready" fixtureMode={true} fixtureEndpointBase="/__fixture/operator" fixtureSessionId="fixture-session-0001" />)

    // Default scenario is 'success'
    expect(capturedGetScenario?.()).toBe('success')

    createSpy.mockRestore()
  })

  it('createOperatorRuntime is NOT called with fixtureSessionId or getScenario when fixtureMode is not set', async () => {
    const {vi} = await import('vitest')
    const runtimeModule = await import('../operator/runtime.ts')

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    render(<Operator state="ready" />)

    const callArgs = createSpy.mock.calls[0]?.[0]
    expect(callArgs?.fixtureSessionId).toBeUndefined()
    expect(callArgs?.getScenario).toBeUndefined()

    createSpy.mockRestore()
  })
})

describe('Operator — data-fixture-mode attribute for agent detection', () => {
  it('operator-shell has data-fixture-mode="true" when fixtureMode=true', () => {
    render(<Operator state="ready" fixtureMode={true} />)
    const shell = document.querySelector('[data-testid="operator-shell"]')
    expect(shell?.getAttribute('data-fixture-mode')).toBe('true')
  })

  it('operator-shell does NOT have data-fixture-mode attribute when fixtureMode is not set', () => {
    render(<Operator state="ready" />)
    const shell = document.querySelector('[data-testid="operator-shell"]')
    expect(shell?.hasAttribute('data-fixture-mode')).toBe(false)
  })

  it('operator-shell does NOT have data-fixture-mode attribute when fixtureMode=false', () => {
    render(<Operator state="ready" fixtureMode={false} />)
    const shell = document.querySelector('[data-testid="operator-shell"]')
    expect(shell?.hasAttribute('data-fixture-mode')).toBe(false)
  })

  it('data-fixture-mode is present in loading state too (not just ready)', () => {
    render(<Operator state="loading" fixtureMode={true} />)
    const shell = document.querySelector('[data-testid="operator-shell"]')
    expect(shell?.getAttribute('data-fixture-mode')).toBe('true')
  })
})


// Recent-runs section presence

describe('Operator — recent-runs section', () => {
  it('ready state renders a recent-runs section', () => {
    render(<Operator state="ready" />)
    const section = document.querySelector('[data-testid="recent-runs-section"]')
    expect(section).not.toBeNull()
  })

  it('recent-runs section appears before the launch form in DOM order', () => {
    render(<Operator state="ready" />)
    const allElements = Array.from(document.body.querySelectorAll('*'))
    const runsSection = document.querySelector('[data-testid="recent-runs-section"]')
    const launchForm = document.querySelector('#launch-form')
    expect(runsSection).not.toBeNull()
    expect(launchForm).not.toBeNull()
    const runsIdx = allElements.indexOf(runsSection as Element)
    const launchIdx = allElements.indexOf(launchForm as Element)
    expect(runsIdx).toBeLessThan(launchIdx)
  })

  it('recent-runs section has a loading region with aria-live', () => {
    render(<Operator state="ready" />)
    const section = document.querySelector('[data-testid="recent-runs-section"]')
    expect(section).not.toBeNull()
    const liveRegion = section?.querySelector('[aria-live]')
    expect(liveRegion).not.toBeNull()
  })

  it('recent-runs loading region does not imply whether runs exist', () => {
    render(<Operator state="ready" />)
    const section = document.querySelector('[data-testid="recent-runs-section"]')
    const liveRegion = section?.querySelector('[aria-live]')
    const text = liveRegion?.textContent ?? ''
    // Must not assert presence or absence of runs — neutral loading copy only
    expect(text).not.toMatch(/no runs/i)
    expect(text).not.toMatch(/\d+ run/i)
  })

  it('recent-runs section has data-role="run-index" for the DOM shell hook', () => {
    render(<Operator state="ready" />)
    const section = document.querySelector('[data-role="run-index"]')
    expect(section).not.toBeNull()
  })

  it('recent-runs section has a stable hook for the run list', () => {
    render(<Operator state="ready" />)
    const listHook = document.querySelector('[data-role="run-index-list"]')
    expect(listHook).not.toBeNull()
  })

  it('recent-runs section has a stable hook for loading state', () => {
    render(<Operator state="ready" />)
    const loadingHook = document.querySelector('[data-role="run-index-loading"]')
    expect(loadingHook).not.toBeNull()
  })

  it('recent-runs loading state renders branded loading skeletons', () => {
    render(<Operator state="ready" />)
    const loadingHook = document.querySelector('[data-role="run-index-loading"]')
    expect(loadingHook).toHaveClass('run-index-skeleton-container')

    const skeletons = document.querySelectorAll('[data-testid="run-card-skeleton"]')
    expect(skeletons).toHaveLength(3)

    for (const skeleton of Array.from(skeletons)) {
      expect(skeleton.querySelector('.skeleton-pill')).not.toBeNull()
      expect(skeleton.querySelector('.skeleton-repo')).not.toBeNull()
      expect(skeleton.querySelector('.skeleton-time')).not.toBeNull()
    }
  })

  it('recent-runs section has a stable hook for empty state', () => {
    render(<Operator state="ready" />)
    const emptyHook = document.querySelector('[data-role="run-index-empty"]')
    expect(emptyHook).not.toBeNull()
  })

  it('recent-runs section has a stable hook for unavailable state', () => {
    render(<Operator state="ready" />)
    const unavailableHook = document.querySelector('[data-role="run-index-unavailable"]')
    expect(unavailableHook).not.toBeNull()
  })

  it('renders a persistent launch trigger button in ready state', () => {
    render(<Operator state="ready" />)
    const triggerBtn = screen.getByTestId('launch-trigger-btn')
    expect(triggerBtn).toBeInTheDocument()
  })

  it('opening the persistent affordance reveals the launch controls', async () => {
    const {act} = await import('react')
    render(<Operator state="ready" />)
    const drawer = screen.getByTestId('launch-drawer')
    expect(drawer).toHaveStyle({display: 'none'})

    const triggerBtn = screen.getByTestId('launch-trigger-btn')
    await act(async () => {
      triggerBtn.click()
    })

    expect(drawer).toHaveStyle({display: 'block'})
    const launchForm = document.querySelector('#launch-form')
    expect(launchForm).toBeInTheDocument()
  })

  it('submit path is still reachable when drawer is open', async () => {
    const {act} = await import('react')
    render(<Operator state="ready" />)
    const triggerBtn = screen.getByTestId('launch-trigger-btn')
    await act(async () => {
      triggerBtn.click()
    })

    const launchForm = document.querySelector('#launch-form')
    expect(launchForm).not.toBeNull()
    const submitBtn = launchForm?.querySelector('[type="submit"]')
    expect(submitBtn).not.toBeNull()
  })

  it('the standalone stacked launch section is gone and no duplicate launch form exists', () => {
    render(<Operator state="ready" />)
    // Check there is exactly one launch-form
    const forms = document.querySelectorAll('#launch-form')
    expect(forms).toHaveLength(1)

    // The form is inside the drawer, not in a direct sibling section of the body
    const drawer = screen.getByTestId('launch-drawer')
    const formInsideDrawer = drawer.querySelector('#launch-form')
    expect(formInsideDrawer).not.toBeNull()

    // No stacked section panel named "Launch" in the page content
    const sections = document.querySelectorAll('section')
    for (const section of Array.from(sections)) {
      const heading = section.querySelector('h2')
      if (heading) {
        expect(heading.textContent).not.toBe('Launch')
      }
    }
  })

  it('the unified run list is the single content region — no separate run-status section', () => {
    render(<Operator state="ready" />)
    expect(document.querySelector('#run-status-section')).toBeNull()
  })

  it('the shared stream-status notice lives with the unified list', () => {
    render(<Operator state="ready" />)
    const section = document.querySelector('[data-testid="recent-runs-section"]')
    const notice = section?.querySelector('[data-role="stream-status"]')
    expect(notice).not.toBeNull()
  })

  it('recent-runs section is NOT rendered in non-ready states', () => {
    render(<Operator state="loading" />)
    const section = document.querySelector('[data-testid="recent-runs-section"]')
    expect(section).toBeNull()
  })
})


// Fixture-absence assertions for root PWA shell
describe('Operator — fixture-absence: no fixture run IDs in root shell', () => {
  const fixtureRunIds = [
    'run-fixture-queued-001',
    'run-fixture-running-002',
    'run-fixture-approval-003',
    'run-fixture-blocked-004',
    'run-fixture-failed-005',
    'run-fixture-cancelled-006',
    'run-fixture-succeeded-007',
  ]

  for (const runId of fixtureRunIds) {
    it(`root shell does not contain fixture run ID: ${runId}`, () => {
      render(<Operator state="ready" />)
      const text = document.body.textContent ?? ''
      const html = document.body.innerHTML
      expect(text).not.toContain(runId)
      expect(html).not.toContain(runId)
    })
  }
})

describe('Operator — fixture-absence: no fixture timeline/stream tokens in root shell', () => {
  it('root shell does not contain entityRef token', () => {
    render(<Operator state="ready" />)
    const html = document.body.innerHTML
    expect(html).not.toContain('entityRef')
  })

  it('root shell does not contain contractVersion token', () => {
    render(<Operator state="ready" />)
    const html = document.body.innerHTML
    expect(html).not.toContain('contractVersion')
  })

  it('root shell does not contain mock badge copy', () => {
    render(<Operator state="ready" />)
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('Mock skeleton')
    expect(text).not.toContain('fixture data')
    expect(text).not.toContain('fixture events')
  })

  it('root shell does not contain badge-mock class', () => {
    render(<Operator state="ready" />)
    const html = document.body.innerHTML
    expect(html).not.toContain('badge-mock')
  })
})

describe('Operator — fixture-absence: no sensitive fixture values in root shell', () => {
  it('root shell does not contain fixture prompt', () => {
    render(<Operator state="ready" />)
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('[Fixture prompt — not rendered in UI]')
  })

  it('root shell does not contain fixture CSRF token', () => {
    render(<Operator state="ready" />)
    const html = document.body.innerHTML
    expect(html).not.toContain('fixture-csrf-placeholder')
  })

  it('root shell does not contain fixture idempotency keys', () => {
    render(<Operator state="ready" />)
    const html = document.body.innerHTML
    expect(html).not.toContain('fixture-idempotency-key-001')
    expect(html).not.toContain('fixture-idempotency-key-002')
  })

  it('root shell does not contain fixture request ID', () => {
    render(<Operator state="ready" />)
    const html = document.body.innerHTML
    expect(html).not.toContain('req-fixture-001')
    expect(html).not.toContain('req-fixture-pending-001')
  })

  it('root shell does not contain fixture repo name in run card context', () => {
    render(<Operator state="ready" />)
    // The shell itself must not render fixture repo names in run cards
    // (fixture-mode indicator may mention "synthetic" but not repo names)
    const html = document.body.innerHTML
    expect(html).not.toContain('run-fixture')
  })
})

describe('Operator — drawer close is unified across close button, backdrop, and Escape', () => {
  it('close button closes the drawer and returns focus to the trigger', async () => {
    const {act} = await import('react')
    render(<Operator state="ready" />)
    const triggerBtn = screen.getByTestId('launch-trigger-btn')
    await act(async () => { triggerBtn.click() })

    const drawer = screen.getByTestId('launch-drawer')
    expect(drawer).toHaveStyle({display: 'block'})

    const closeBtn = screen.getByTestId('close-drawer-btn')
    await act(async () => { closeBtn.click() })

    expect(drawer).toHaveStyle({display: 'none'})
    expect(document.activeElement).toBe(triggerBtn)
  })

  it('clicking the backdrop closes the drawer and returns focus to the trigger', async () => {
    const {act} = await import('react')
    render(<Operator state="ready" />)
    const triggerBtn = screen.getByTestId('launch-trigger-btn')
    await act(async () => { triggerBtn.click() })

    const drawer = screen.getByTestId('launch-drawer')
    const backdrop = drawer.querySelector('.operator-drawer-backdrop') as HTMLElement
    expect(backdrop).not.toBeNull()

    await act(async () => { backdrop.click() })

    expect(drawer).toHaveStyle({display: 'none'})
    expect(document.activeElement).toBe(triggerBtn)
  })

  it('pressing Escape closes the drawer and returns focus to the trigger', async () => {
    const {act} = await import('react')
    render(<Operator state="ready" />)
    const triggerBtn = screen.getByTestId('launch-trigger-btn')
    await act(async () => { triggerBtn.click() })

    const drawer = screen.getByTestId('launch-drawer')
    expect(drawer).toHaveStyle({display: 'block'})

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))
    })

    expect(drawer).toHaveStyle({display: 'none'})
    expect(document.activeElement).toBe(triggerBtn)
  })
})

describe('Operator — post-launch focus-steal guard', () => {
  it('moves focus to the new run card when focus was still on the submit button at launch success', async () => {
    const {act} = await import('react')
    render(<Operator state="ready" />)
    const triggerBtn = screen.getByTestId('launch-trigger-btn')
    await act(async () => { triggerBtn.click() })

    const runIndexList = document.querySelector('[data-role="run-index-list"]') as HTMLElement
    const card = document.createElement('div')
    card.dataset.testid = 'run-card'
    card.tabIndex = 0
    runIndexList.append(card)

    const form = document.querySelector('#launch-form') as HTMLFormElement
    const submitBtn = form.querySelector('[type="submit"]') as HTMLButtonElement
    submitBtn.focus()
    expect(document.activeElement).toBe(submitBtn)

    await act(async () => {
      form.dispatchEvent(new CustomEvent('launch-success', {bubbles: true, detail: {runId: 'run-1'}}))
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })

    expect(document.activeElement).toBe(card)
  })

  it('does NOT steal focus from an element the operator already moved to before launch-success fires', async () => {
    const {act} = await import('react')
    render(<Operator state="ready" />)
    const triggerBtn = screen.getByTestId('launch-trigger-btn')
    await act(async () => { triggerBtn.click() })

    const runIndexList = document.querySelector('[data-role="run-index-list"]') as HTMLElement
    const card = document.createElement('div')
    card.dataset.testid = 'run-card'
    card.tabIndex = 0
    runIndexList.append(card)

    const form = document.querySelector('#launch-form') as HTMLFormElement

    // Operator has already moved focus elsewhere (e.g. clicked some unrelated
    // element) by the time the launch-success event fires.
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    expect(document.activeElement).toBe(elsewhere)

    await act(async () => {
      form.dispatchEvent(new CustomEvent('launch-success', {bubbles: true, detail: {runId: 'run-1'}}))
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })

    // Focus must remain on the element the operator moved to — not stolen by the card.
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })
})

describe('Operator — failure state distinct treatments', () => {
  const failureStates: ('auth-required' | 'rate-limited' | 'offline' | 'unavailable')[] = [
    'auth-required',
    'rate-limited',
    'offline',
    'unavailable',
  ]

  for (const state of failureStates) {
    it(`renders its distinct failure state treatment for ${state} with disabled actions`, () => {
      render(<Operator state={state} />)
      const shell = screen.getByTestId('operator-shell')
      expect(shell).toHaveAttribute('data-state', state)

      const reasonEl = screen.getByTestId('operator-action-reason')
      expect(reasonEl).toHaveClass(`operator-failure-state-${state}`)
      expect(reasonEl).toHaveClass('operator-warning-panel')
      expect(reasonEl.textContent?.trim().length).toBeGreaterThan(0)
    })
  }
})
