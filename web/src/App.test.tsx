import {render, screen, waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
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
  beforeEach(async () => {
    stubMatchMedia()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    // In dev builds, fixture detection must settle before the runtime mounts.
    // Stub fetchFixtureSession to resolve null immediately so tests that check
    // ready-state DOM don't have to wait for a real async fetch.
    const fixtureLoader = await import('./operator/fixture-runtime-loader.ts')
    vi.spyOn(fixtureLoader, 'fetchFixtureSession').mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  it('renders operator runtime shell by default (not indefinite connecting state)', async () => {
    const {act} = await import('react')
    await act(async () => { render(<App />) })
    // The assembled app must enter ready state so the runtime DOM skeleton is present.
    // Detection settles (null session) then operatorState='ready' takes effect.
    // All three elements are inside operator-content which only renders in ready state.
    await waitFor(() => {
      expect(document.querySelector('#launch-form')).not.toBeNull()
      expect(document.querySelector('#repo-picker-container')).not.toBeNull()
      expect(document.querySelector('#run-status-section')).not.toBeNull()
    })
  })

  it('does not render indefinite connecting state as primary UI', async () => {
    const {act} = await import('react')
    await act(async () => { render(<App />) })
    // "Connecting…" / "Establishing operator session." must not be the only visible state.
    // If the runtime shell is present, the connecting copy is superseded.
    // Wait for both operator-content and launch-form to appear after detection settles.
    await waitFor(() => {
      expect(document.querySelector('[data-testid="operator-content"]')).not.toBeNull()
      expect(document.querySelector('#launch-form')).not.toBeNull()
    })
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

describe('App — runtime state wiring', () => {
  beforeEach(async () => {
    stubMatchMedia()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    // Settle fixture detection immediately so runtime mounts in ready state.
    const fixtureLoader = await import('./operator/fixture-runtime-loader.ts')
    vi.spyOn(fixtureLoader, 'fetchFixtureSession').mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runtime reporting unavailable transitions shell to unavailable state', async () => {
    const {act, waitFor: wf} = await import('@testing-library/react')
    const runtimeModule = await import('./operator/runtime.ts')

    let capturedOnStateChange: ((state: import('./operator/state.ts').OperatorState) => void) | undefined

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation((opts) => {
      capturedOnStateChange = opts.onStateChange
      return {isMounted: true, cleanup: vi.fn()}
    })

    await act(async () => { render(<App />) })

    // Wait for detection to settle and runtime to mount
    await wf(() => { expect(createSpy).toHaveBeenCalled() })

    // Simulate runtime reporting unavailable
    await act(async () => {
      capturedOnStateChange?.('unavailable')
    })

    // Shell should now show unavailable state (service unavailable headline)
    expect(screen.getByText(/service unavailable/i)).toBeInTheDocument()

    createSpy.mockRestore()
  })

  it('App passes onRuntimeStateChange to Operator', async () => {
    const {act, waitFor: wf} = await import('@testing-library/react')
    const runtimeModule = await import('./operator/runtime.ts')

    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    await act(async () => { render(<App />) })

    // Wait for detection to settle and runtime to mount
    await wf(() => {
      // createOperatorRuntime should have been called (Operator is in ready state and wired)
      expect(createSpy).toHaveBeenCalled()
    })
    const callOpts = createSpy.mock.calls[0]?.[0]
    expect(typeof callOpts?.onStateChange).toBe('function')

    createSpy.mockRestore()
  })
})

describe('App — fixture mode detection', () => {
  beforeEach(() => {
    stubMatchMedia()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('does NOT render fixture-mode indicator in non-fixture mode (default)', () => {
    render(<App />)
    expect(document.querySelector('[data-testid="fixture-mode-indicator"]')).toBeNull()
  })

  it('Operator renders fixture-mode indicator when fixtureMode prop is true', async () => {
    const {Operator} = await import('./views/Operator.tsx')
    render(<Operator state="ready" fixtureMode={true} fixtureEndpointBase="/__fixture/operator" fixtureSessionId="fixture-session-0001" />)
    expect(document.querySelector('[data-testid="fixture-mode-indicator"]')).not.toBeNull()
  })

  it('Operator does NOT render fixture-mode indicator when fixtureMode is not set', async () => {
    const {Operator} = await import('./views/Operator.tsx')
    render(<Operator state="ready" />)
    expect(document.querySelector('[data-testid="fixture-mode-indicator"]')).toBeNull()
  })

  it('App renders fixture-mode indicator when fixture session fetch succeeds in dev env', async () => {
    const {act, waitFor} = await import('@testing-library/react')

    // Mock createOperatorRuntime to prevent real dynamic imports
    const runtimeModule = await import('./operator/runtime.ts')
    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    // Mock fetchFixtureSession to return a valid session
    const fixtureLoader = await import('./operator/fixture-runtime-loader.ts')
    const fetchSpy = vi.spyOn(fixtureLoader, 'fetchFixtureSession').mockResolvedValue({
      fixtureMode: true,
      fixtureSessionId: 'fixture-session-0001',
    })

    await act(async () => {
      render(<App />)
    })

    // Wait for the async fixture detection to complete and re-render
    await waitFor(() => {
      expect(document.querySelector('[data-testid="fixture-mode-indicator"]')).not.toBeNull()
    })

    fetchSpy.mockRestore()
    createSpy.mockRestore()
  })
})

// ── Fixture detection race fix ─────────────────────────────────────────────
// These tests verify that in dev builds, createOperatorRuntime is NOT called
// before fixture detection settles, preventing the race where the non-fixture
// runtime starts with /operator endpoints before /__fixture/operator is known.

describe('App — fixture detection race: runtime must not mount before detection settles', () => {
  beforeEach(() => {
    stubMatchMedia()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('createOperatorRuntime is NOT called before fixture detection resolves (dev build)', async () => {
    const {act} = await import('react')

    const runtimeModule = await import('./operator/runtime.ts')
    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    // fetchFixtureSession that never resolves during this test
    const fixtureLoader = await import('./operator/fixture-runtime-loader.ts')
    let resolveFixture!: (v: null) => void
    const pendingFixture = new Promise<null>(resolve => { resolveFixture = resolve })
    const fetchSpy = vi.spyOn(fixtureLoader, 'fetchFixtureSession').mockReturnValue(pendingFixture)

    await act(async () => {
      render(<App />)
    })

    // Detection is still pending — runtime must NOT have been called yet
    expect(createSpy).not.toHaveBeenCalled()

    // Resolve detection so cleanup is clean (wrapped in act to avoid act() warning)
    const {act: actWrap} = await import('@testing-library/react')
    await actWrap(async () => { resolveFixture(null) })

    fetchSpy.mockRestore()
    createSpy.mockRestore()
  })

  it('createOperatorRuntime receives fixture endpoint base when fixture session resolves', async () => {
    const {act, waitFor} = await import('@testing-library/react')

    const runtimeModule = await import('./operator/runtime.ts')
    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    const fixtureLoader = await import('./operator/fixture-runtime-loader.ts')
    const fetchSpy = vi.spyOn(fixtureLoader, 'fetchFixtureSession').mockResolvedValue({
      fixtureMode: true,
      fixtureSessionId: 'fixture-session-0001',
    })

    await act(async () => {
      render(<App />)
    })

    // Wait for detection to settle and runtime to mount
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalled()
    })

    // Runtime must have been called with the fixture endpoint base
    const callOpts = createSpy.mock.calls[0]?.[0]
    expect(callOpts?.fixtureMode).toBe(true)
    expect(callOpts?.fixtureEndpointBase).toBe('/__fixture/operator')

    // Page must show fixture indicator
    expect(document.querySelector('[data-testid="fixture-mode-indicator"]')).not.toBeNull()

    fetchSpy.mockRestore()
    createSpy.mockRestore()
  })

  it('createOperatorRuntime mounts normally (no fixture props) when fixture session returns null', async () => {
    const {act, waitFor} = await import('@testing-library/react')

    const runtimeModule = await import('./operator/runtime.ts')
    const createSpy = vi.spyOn(runtimeModule, 'createOperatorRuntime')
    createSpy.mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))

    const fixtureLoader = await import('./operator/fixture-runtime-loader.ts')
    const fetchSpy = vi.spyOn(fixtureLoader, 'fetchFixtureSession').mockResolvedValue(null)

    await act(async () => {
      render(<App />)
    })

    // Wait for detection to settle and runtime to mount
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalled()
    })

    // Runtime must have been called without fixture props
    const callOpts = createSpy.mock.calls[0]?.[0]
    expect(callOpts?.fixtureMode).toBeFalsy()
    expect(callOpts?.fixtureEndpointBase).toBeUndefined()

    // No fixture indicator
    expect(document.querySelector('[data-testid="fixture-mode-indicator"]')).toBeNull()

    fetchSpy.mockRestore()
    createSpy.mockRestore()
  })
})
