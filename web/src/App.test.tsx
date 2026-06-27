import {render, screen} from '@testing-library/react'
import {beforeEach, describe, expect, it} from 'vitest'
import App from './App.tsx'

// jsdom doesn't implement matchMedia — stub it (same pattern as AppShell.test.tsx)
function stubMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

describe('App', () => {
  beforeEach(() => {
    stubMatchMedia()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('renders the brand name', () => {
    render(<App />)
    // AppShell renders "Fro Bot" as the brand mark text
    expect(screen.getByText('Fro Bot')).toBeInTheDocument()
  })

  it('mounts without throwing', () => {
    expect(() => render(<App />)).not.toThrow()
  })

  it('renders AppShell nav', () => {
    render(<App />)
    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
    expect(screen.getByTestId('app-nav')).toBeInTheDocument()
  })

  it('renders Operator view inside AppShell', () => {
    render(<App />)
    // Operator shell renders an h1 heading — not a monitoring loading state.
    // Use level:1 because ready state also renders h2 section headings.
    expect(screen.getByRole('heading', {level: 1})).toBeInTheDocument()
  })

  // ── Regression: no monitoring artifacts ────────────────────────────────────

  it('does not render monitoring loading state', () => {
    render(<App />)
    expect(document.querySelector('[data-testid="monitoring-loading"]')).toBeNull()
  })

  it('does not render monitoring view', () => {
    render(<App />)
    expect(document.querySelector('[data-testid="monitoring-view"]')).toBeNull()
  })

  it('does not render monitoring dashboard title', () => {
    render(<App />)
    expect(screen.queryByText(/repository status/i)).not.toBeInTheDocument()
  })

  // ── Regression: operator runtime shell mounts by default ──────────────────

  it('renders operator runtime shell by default (not indefinite connecting state)', () => {
    render(<App />)
    // The assembled app must enter ready state so the runtime DOM skeleton is present.
    // A browser-direct operator has no Gateway session-check wiring, so it should
    // start ready and let the runtime classify failures itself.
    expect(document.querySelector('#launch-form')).not.toBeNull()
    expect(document.querySelector('#repo-picker-container')).not.toBeNull()
    expect(document.querySelector('#run-status-section')).not.toBeNull()
  })

  it('does not render indefinite connecting state as primary UI', () => {
    render(<App />)
    // "Connecting…" / "Establishing operator session." must not be the only visible state.
    // If the runtime shell is present, the connecting copy is superseded.
    const launchForm = document.querySelector('#launch-form')
    expect(launchForm).not.toBeNull()
    // Connecting text may still exist in the DOM (aria-live region) but the
    // runtime shell must also be present — not stuck behind a loading gate.
    expect(document.querySelector('[data-testid="operator-content"]')).not.toBeNull()
  })

  // ── Regression: SW prompts remain reachable ────────────────────────────────

  it('ReloadPrompt is mounted (SW update affordance survives shell swap)', () => {
    render(<App />)
    // ReloadPrompt renders null when needRefresh is false (the default in tests),
    // but it must be mounted so the SW registration hook runs.
    // We verify AppShell is present (which always mounts ReloadPrompt).
    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// TDD: App/Operator wiring — runtime state propagation (RED phase)
// ---------------------------------------------------------------------------

describe('App — runtime state wiring', () => {
  beforeEach(() => {
    stubMatchMedia()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('runtime reporting unavailable transitions shell to unavailable state', async () => {
    const {vi} = await import('vitest')
    const {act} = await import('react')
    const runtimeModule = await import('./operator/runtime.ts')

    let capturedOnStateChange: ((state: import('./operator/state.ts').OperatorState) => void) | undefined

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation((opts) => {
      capturedOnStateChange = opts.onStateChange
      return {isMounted: true, cleanup: vi.fn()}
    })

    render(<App />)

    // Simulate runtime reporting unavailable
    await act(async () => {
      capturedOnStateChange?.('unavailable')
    })

    // Shell should now show unavailable state (service unavailable headline)
    expect(screen.getByText(/service unavailable/i)).toBeInTheDocument()

    createSpy.mockRestore()
  })

  it('App passes onRuntimeStateChange to Operator', async () => {
    const {vi} = await import('vitest')
    const runtimeModule = await import('./operator/runtime.ts')

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    render(<App />)

    // createOperatorRuntime should have been called (Operator is in ready state and wired)
    expect(createSpy).toHaveBeenCalled()
    const callOpts = createSpy.mock.calls[0]?.[0]
    expect(typeof callOpts?.onStateChange).toBe('function')

    createSpy.mockRestore()
  })
})
