import {act, fireEvent, render, screen, waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
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
    const runtimeModule = await import('./operator/runtime.ts')
    vi.spyOn(runtimeModule, 'createOperatorRuntime').mockImplementation(() => ({
      isMounted: true,
      cleanup: vi.fn(),
    }))
    // App polls the listener unread count on mount + interval for the nav badge.
    // Stub it so the operator-runtime assertions don't race an unmocked fetch.
    const listenerApi = await import('./api/listener.ts')
    vi.spyOn(listenerApi, 'fetchListenerMessages').mockResolvedValue({
      ok: true,
      data: {messages: [], unreadCount: 0},
    })
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
      expect(document.querySelector('[data-role="run-index-list"]')).not.toBeNull()
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
    // App polls the listener unread count on mount + interval for the nav badge.
    // Stub it so the operator-runtime assertions don't race an unmocked fetch.
    const listenerApi = await import('./api/listener.ts')
    vi.spyOn(listenerApi, 'fetchListenerMessages').mockResolvedValue({
      ok: true,
      data: {messages: [], unreadCount: 0},
    })
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

// ── Notification click: in-page jump ───────────────────────────────────────
// The service worker posts {type: 'OPEN_RUN', runId} to an open window. App is the only listener; it
// switches to the operator view and hands the run ID to the runtime module's jump slot.

describe('App — OPEN_RUN service-worker message', () => {
  type Listener = (event: unknown) => void

  const controller = {postMessage: vi.fn()}
  let listeners: Set<Listener>
  let addEventListener: ReturnType<typeof vi.fn>
  let removeEventListener: ReturnType<typeof vi.fn>
  let jump: MockInstance<typeof import('./operator/runtime.ts').requestRunJump>
  let originalDescriptor: PropertyDescriptor | undefined

  function installServiceWorker(activeController: unknown = controller) {
    listeners = new Set()
    addEventListener = vi.fn((type: string, listener: Listener) => {
      if (type === 'message') listeners.add(listener)
    })
    removeEventListener = vi.fn((type: string, listener: Listener) => {
      if (type === 'message') listeners.delete(listener)
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: activeController,
        ready: new Promise(() => {}),
        addEventListener,
        removeEventListener,
      },
    })
  }

  /** What the browser hands the page: the posting worker as `source`, the cloned message as `data`. */
  function deliver(data: unknown, source: unknown = controller) {
    act(() => {
      for (const listener of [...listeners]) listener({data, source})
    })
  }

  const operatorWrapper = () => screen.getByTestId('operator-shell').parentElement as HTMLElement

  beforeEach(async () => {
    stubMatchMedia()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
    installServiceWorker()
    const fixtureLoader = await import('./operator/fixture-runtime-loader.ts')
    vi.spyOn(fixtureLoader, 'fetchFixtureSession').mockResolvedValue(null)
    const listenerApi = await import('./api/listener.ts')
    vi.spyOn(listenerApi, 'fetchListenerMessages').mockResolvedValue({ok: true, data: {messages: [], unreadCount: 0}})
    const runtimeModule = await import('./operator/runtime.ts')
    vi.spyOn(runtimeModule, 'createOperatorRuntime').mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))
    jump = vi.spyOn(runtimeModule, 'requestRunJump').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalDescriptor === undefined) Reflect.deleteProperty(navigator, 'serviceWorker')
    else Object.defineProperty(navigator, 'serviceWorker', originalDescriptor)
  })

  async function renderOnListenerView() {
    const view = render(<App />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', {name: 'Inbox'}))
    // Let the inbox's own fetch settle so its state update is not mistaken for a console warning later.
    await act(async () => {})
    expect(operatorWrapper().style.display).toBe('none')
    return view
  }

  it('registers one message listener at mount and removes that same listener on unmount', async () => {
    const {unmount} = render(<App />)
    await act(async () => {})

    expect(addEventListener.mock.calls.filter(([type]) => type === 'message')).toHaveLength(1)
    const registered = addEventListener.mock.calls.find(([type]) => type === 'message')?.[1]

    unmount()

    expect(removeEventListener).toHaveBeenCalledWith('message', registered)
    expect(listeners.size).toBe(0)
  })

  it('does not re-register when the view changes', async () => {
    render(<App />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', {name: 'Inbox'}))
    fireEvent.click(screen.getByRole('button', {name: 'Runs'}))

    expect(addEventListener.mock.calls.filter(([type]) => type === 'message')).toHaveLength(1)
    expect(removeEventListener).not.toHaveBeenCalled()
  })

  it('a valid message from the active worker switches to the operator view, then requests the jump', async () => {
    await renderOnListenerView()
    let displayAtRequest: string | undefined
    jump.mockImplementation(() => {
      displayAtRequest = operatorWrapper().style.display
    })

    deliver({type: 'OPEN_RUN', runId: 'run-from-sw_1'})

    expect(jump).toHaveBeenCalledTimes(1)
    expect(jump).toHaveBeenCalledWith('run-from-sw_1')
    // The view is already visible when the runtime hears about the run, so focus can land.
    expect(displayAtRequest).toBe('block')
    expect(operatorWrapper().style.display).toBe('block')
    expect(screen.queryByTestId('listener-loading')).toBeNull()
  })

  it('a valid message while the operator view is already showing just requests the jump', async () => {
    render(<App />)
    await act(async () => {})

    deliver({type: 'OPEN_RUN', runId: 'run-already-here'})

    expect(operatorWrapper().style.display).toBe('block')
    expect(jump).toHaveBeenCalledWith('run-already-here')
  })

  it('two valid messages in a row each reach the runtime, in order (the runtime keeps the last)', async () => {
    render(<App />)
    await act(async () => {})

    deliver({type: 'OPEN_RUN', runId: 'run-first'})
    deliver({type: 'OPEN_RUN', runId: 'run-second'})

    expect(jump.mock.calls.map(([runId]) => runId)).toEqual(['run-first', 'run-second'])
  })

  const rejected: [string, unknown, unknown?][] = [
    ['a source that is not the active worker', {type: 'OPEN_RUN', runId: 'run-1'}, {postMessage: vi.fn()}],
    ['no source', {type: 'OPEN_RUN', runId: 'run-1'}, null],
    ['the window as source', {type: 'OPEN_RUN', runId: 'run-1'}, window],
    ['a wrong type', {type: 'PUSH_SUBSCRIPTION_CHANGE', runId: 'run-1'}],
    ['an extra key', {type: 'OPEN_RUN', runId: 'run-1', route: '/operator'}],
    ['a missing runId', {type: 'OPEN_RUN'}],
    ['a runId that is not a string', {type: 'OPEN_RUN', runId: 42}],
    ['a runId that fails the run ID pattern', {type: 'OPEN_RUN', runId: '../etc'}],
    ['an over-long runId', {type: 'OPEN_RUN', runId: 'a'.repeat(129)}],
    ['a null body', null],
    ['a string body', 'OPEN_RUN'],
    ['an array body', ['OPEN_RUN', 'run-1']],
  ]
  it.each(rejected)('ignores %s: no view switch, no jump', async (_label, data, source) => {
    await renderOnListenerView()

    deliver(data, source === undefined ? controller : source)

    expect(jump).not.toHaveBeenCalled()
    expect(operatorWrapper().style.display).toBe('none')
  })

  it('ignores a well-formed message when the page has no controlling worker', async () => {
    installServiceWorker(null)
    await renderOnListenerView()

    deliver({type: 'OPEN_RUN', runId: 'run-1'}, null)
    deliver({type: 'OPEN_RUN', runId: 'run-1'}, undefined)

    expect(jump).not.toHaveBeenCalled()
    expect(operatorWrapper().style.display).toBe('none')
  })

  it('judges the source against the controller at delivery time', async () => {
    const replacement = {postMessage: vi.fn()}
    await renderOnListenerView()
    Object.defineProperty(navigator.serviceWorker, 'controller', {configurable: true, value: replacement})

    deliver({type: 'OPEN_RUN', runId: 'run-1'}, controller)
    expect(jump).not.toHaveBeenCalled()

    deliver({type: 'OPEN_RUN', runId: 'run-1'}, replacement)
    expect(jump).toHaveBeenCalledWith('run-1')
  })

  it('mounts without throwing in a browser with no service worker support', async () => {
    Reflect.deleteProperty(navigator, 'serviceWorker')
    expect('serviceWorker' in navigator).toBe(false)

    expect(() => render(<App />)).not.toThrow()
    await act(async () => {})
  })

  it('makes no console calls, accepted or ignored (a run ID must never be logged)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    await renderOnListenerView()

    deliver({type: 'OPEN_RUN', runId: 'run-secret-id'})
    deliver({type: 'OPEN_RUN', runId: 'run-secret-id', extra: 1})
    deliver({type: 'OPEN_RUN', runId: 'run-secret-id'}, {postMessage: vi.fn()})

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('App.tsx has no console call and no hashchange listener', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const src = await fs.readFile(path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'App.tsx'), 'utf8')
    expect(src).not.toMatch(/console\./)
    expect(src).not.toMatch(/hashchange/)
  })
})

// ── Wiki view ──────────────────────────────────────────────────────────────
// There is no router: App holds the view in state and web/src/wiki/location.ts owns the URL.
// The operator view stays mounted (hidden) while the wiki view shows, exactly as it does for the inbox.

describe('App — wiki view', () => {
  const operatorWrapper = () => screen.getByTestId('operator-shell').parentElement as HTMLElement

  async function renderApp() {
    const view = render(<App />)
    await act(async () => {})
    return view
  }

  async function traverse(delta: -1 | 1) {
    const popped = new Promise<void>(resolve => {
      window.addEventListener('popstate', () => resolve(), {once: true})
    })
    await act(async () => {
      window.history.go(delta)
      await popped
    })
  }

  beforeEach(async () => {
    stubMatchMedia()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    window.history.pushState(null, '', '/')
    const fixtureLoader = await import('./operator/fixture-runtime-loader.ts')
    vi.spyOn(fixtureLoader, 'fetchFixtureSession').mockResolvedValue(null)
    const runtimeModule = await import('./operator/runtime.ts')
    vi.spyOn(runtimeModule, 'createOperatorRuntime').mockImplementation(() => ({isMounted: true, cleanup: vi.fn()}))
    const listenerApi = await import('./api/listener.ts')
    vi.spyOn(listenerApi, 'fetchListenerMessages').mockResolvedValue({ok: true, data: {messages: [], unreadCount: 0}})
    const wikiApi = await import('./api/wiki.ts')
    vi.spyOn(wikiApi, 'listWikiPages').mockReturnValue(new Promise(() => {}))
    vi.spyOn(wikiApi, 'getWikiPage').mockReturnValue(new Promise(() => {}))
    vi.spyOn(wikiApi, 'promotionStatus').mockReturnValue(new Promise(() => {}))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.pushState(null, '', '/')
  })

  it('opens at the operator view when the path is not a wiki page', async () => {
    await renderApp()
    expect(operatorWrapper().style.display).toBe('block')
    expect(screen.queryByTestId('wiki-list')).toBeNull()
    expect(screen.queryByTestId('wiki-page')).toBeNull()
  })

  it('the Wiki nav opens the list and hides the operator view without unmounting it', async () => {
    await renderApp()
    const operatorNode = screen.getByTestId('operator-shell')

    fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))

    expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
    expect(screen.getByTestId('operator-shell')).toBe(operatorNode)
    expect(operatorWrapper().style.display).toBe('none')
    expect(screen.getByRole('button', {name: 'Wiki'})).toHaveAttribute('aria-current', 'page')
    expect(window.location.pathname).toBe('/wiki')
  })

  it('loading at /wiki opens the list directly, with the operator view hidden', async () => {
    window.history.replaceState(null, '', '/wiki')

    await renderApp()

    expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-page')).toBeNull()
    expect(operatorWrapper().style.display).toBe('none')
    expect(screen.getByRole('button', {name: 'Wiki'})).toHaveAttribute('aria-current', 'page')
  })

  it('does not stack history entries when the app loads on /wiki', async () => {
    window.history.replaceState(null, '', '/wiki')
    const length = window.history.length

    await renderApp()

    expect(window.history.length).toBe(length)
  })

  it('Back from the list returns to the Runs view, and Forward returns to the list', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))

    await traverse(-1)
    expect(window.location.pathname).toBe('/')
    expect(operatorWrapper().style.display).toBe('block')
    expect(screen.queryByTestId('wiki-list')).toBeNull()

    await traverse(1)
    expect(window.location.pathname).toBe('/wiki')
    expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
  })

  it('Runs after Wiki shows the same operator node again and drops the list', async () => {
    await renderApp()
    const operatorNode = screen.getByTestId('operator-shell')
    fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))

    fireEvent.click(screen.getByRole('button', {name: 'Runs'}))

    expect(screen.getByTestId('operator-shell')).toBe(operatorNode)
    expect(operatorWrapper().style.display).toBe('block')
    expect(screen.queryByTestId('wiki-list')).toBeNull()
  })

  it('creates the operator runtime once, however the views change', async () => {
    const runtimeModule = await import('./operator/runtime.ts')
    await renderApp()
    fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))
    fireEvent.click(screen.getByRole('button', {name: 'Inbox'}))
    fireEvent.click(screen.getByRole('button', {name: 'Runs'}))
    await act(async () => {})
    expect(vi.mocked(runtimeModule.createOperatorRuntime)).toHaveBeenCalledTimes(1)
  })

  it('loading at /wiki/<id> opens that page directly, with the operator view hidden', async () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')

    await renderApp()

    expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-page-id', 'repos.acme--alpha')
    expect(operatorWrapper().style.display).toBe('none')
    expect(screen.getByRole('button', {name: 'Wiki'})).toHaveAttribute('aria-current', 'page')
  })

  it('Back from a deep-linked page returns to the list, and Forward returns to the page', async () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
    await renderApp()

    await traverse(-1)
    expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-page')).toBeNull()
    expect(window.location.pathname).toBe('/wiki')

    await traverse(1)
    expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-page-id', 'repos.acme--alpha')
  })

  it('does not stack history entries when the app mounts twice on the same deep link', async () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
    const first = await renderApp()
    const length = window.history.length
    first.unmount()

    await renderApp()

    expect(window.history.length).toBe(length)
  })

  it('a path that fails the page-ID check opens the operator view', async () => {
    window.history.replaceState(null, '', '/wiki/not-a-page')
    await renderApp()
    expect(screen.queryByTestId('wiki-page')).toBeNull()
    expect(operatorWrapper().style.display).toBe('block')
  })

  it('leaving a page for Runs takes /wiki/<id> off the URL', async () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
    await renderApp()

    fireEvent.click(screen.getByRole('button', {name: 'Runs'}))

    expect(window.location.pathname).toBe('/')
    expect(operatorWrapper().style.display).toBe('block')
    expect(screen.queryByTestId('wiki-page')).toBeNull()
  })

  it('the Wiki nav from a page returns to the list', async () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
    await renderApp()

    fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))

    expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/wiki')
  })

  it('leaves the operator #runId hash alone through every view change', async () => {
    window.history.replaceState(null, '', '/#run-keep-me')
    await renderApp()

    fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))
    fireEvent.click(screen.getByRole('button', {name: 'Inbox'}))
    fireEvent.click(screen.getByRole('button', {name: 'Runs'}))

    expect(window.location.hash).toBe('#run-keep-me')
    expect(window.location.pathname).toBe('/')
  })

  it('a popstate that lands on the same wiki list does not pull the user off it', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
  })

  it('a popstate on the operator view (the run hash writes one) leaves every non-wiki view where it is', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', {name: 'Inbox'}))
    await act(async () => {})

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    expect(operatorWrapper().style.display).toBe('none')
    expect(screen.getByRole('button', {name: 'Inbox'})).toHaveAttribute('aria-current', 'page')
  })

  describe('list to page and back', () => {
    const SUMMARY = {id: 'repos.acme--alpha', title: 'acme/alpha', type: 'repos', updated: '2026-02-01', canMark: true} as const
    const PAGE = {
      ...SUMMARY,
      body: 'Alpha builds widgets.\n',
      pageBlobSha: 'blob-1',
      nodeId: null,
      corrections: [],
      correctionsBase: 'digest-1',
      headSha: 'commit-1',
      contract: {ok: true},
      canWrite: true,
      canWriteReason: null,
    } as const

    beforeEach(async () => {
      const wikiApi = await import('./api/wiki.ts')
      vi.mocked(wikiApi.listWikiPages).mockResolvedValue({
        ok: true,
        value: {headSha: 'commit-1', pages: [SUMMARY], canWrite: true, canWriteReason: null},
      })
      vi.mocked(wikiApi.promotionStatus).mockResolvedValue({ok: true, value: {state: 'settled', pr: null}})
      vi.mocked(wikiApi.getWikiPage).mockResolvedValue({ok: true, value: PAGE as never})
    })

    it('a page row opens the page at its deep link, and Back returns to the list', async () => {
      await renderApp()
      fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))
      await act(async () => {})

      fireEvent.click(screen.getByRole('link', {name: 'acme/alpha'}))
      await act(async () => {})

      expect(window.location.pathname).toBe('/wiki/repos.acme--alpha')
      expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-state', 'ready')
      expect(screen.getByTestId('wiki-page-body')).toHaveTextContent('Alpha builds widgets.')
      expect(screen.queryByTestId('wiki-list')).toBeNull()

      await traverse(-1)
      await act(async () => {})

      expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
      expect(screen.queryByTestId('wiki-page')).toBeNull()
      expect(window.location.pathname).toBe('/wiki')
    })

    it('the in-page back link returns to the list', async () => {
      window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
      await renderApp()

      fireEvent.click(screen.getByRole('link', {name: 'Back to the wiki list'}))
      await act(async () => {})

      expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
      expect(window.location.pathname).toBe('/wiki')
    })

    describe('with unsaved edits', () => {
      let confirmSpy: MockInstance<typeof window.confirm>

      async function editing() {
        window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
        await renderApp()
        fireEvent.click(screen.getByRole('button', {name: 'Edit'}))
        await act(async () => {})
        fireEvent.change(screen.getByRole('textbox', {name: 'Page text (raw Markdown)'}), {target: {value: 'changed'}})
      }

      beforeEach(() => {
        confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      })

      it('a view switch asks first, and a refusal keeps the editor and the URL', async () => {
        await editing()

        fireEvent.click(screen.getByRole('button', {name: 'Runs'}))

        expect(confirmSpy).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('textbox', {name: 'Page text (raw Markdown)'})).toHaveValue('changed')
        expect(window.location.pathname).toBe('/wiki/repos.acme--alpha')
        expect(operatorWrapper().style.display).toBe('none')
      })

      it('a view switch goes ahead when confirmed', async () => {
        await editing()
        confirmSpy.mockReturnValue(true)

        fireEvent.click(screen.getByRole('button', {name: 'Runs'}))

        expect(operatorWrapper().style.display).toBe('block')
        expect(screen.queryByTestId('wiki-page')).toBeNull()
        expect(window.location.pathname).toBe('/')
      })

      it('the list link asks first, and a refusal keeps the editor', async () => {
        await editing()

        fireEvent.click(screen.getByRole('link', {name: 'Back to the wiki list'}))

        expect(confirmSpy).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('textbox', {name: 'Page text (raw Markdown)'})).toBeInTheDocument()
        expect(window.location.pathname).toBe('/wiki/repos.acme--alpha')
      })

      it('the Wiki nav from the page asks first', async () => {
        await editing()
        fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))
        expect(confirmSpy).toHaveBeenCalledTimes(1)
        expect(screen.queryByTestId('wiki-list')).toBeNull()
      })

      it('the browser Back button asks first, and a refusal puts the page URL back', async () => {
        await editing()

        await traverse(-1)

        expect(confirmSpy).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('textbox', {name: 'Page text (raw Markdown)'})).toHaveValue('changed')
        expect(window.location.pathname).toBe('/wiki/repos.acme--alpha')
        expect(screen.queryByTestId('wiki-list')).toBeNull()
      })

      it('the browser Back button goes ahead when confirmed', async () => {
        await editing()
        confirmSpy.mockReturnValue(true)

        await traverse(-1)
        await act(async () => {})

        expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
        expect(window.location.pathname).toBe('/wiki')
      })

      it('a popstate that stays on the page (a hash change) does not ask', async () => {
        await editing()

        act(() => {
          window.dispatchEvent(new PopStateEvent('popstate'))
        })

        expect(confirmSpy).not.toHaveBeenCalled()
        expect(screen.getByRole('textbox', {name: 'Page text (raw Markdown)'})).toBeInTheDocument()
      })

      it('asks nothing when there is nothing to lose', async () => {
        window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
        await renderApp()
        fireEvent.click(screen.getByRole('button', {name: 'Edit'}))
        await act(async () => {})

        fireEvent.click(screen.getByRole('link', {name: 'Back to the wiki list'}))

        expect(confirmSpy).not.toHaveBeenCalled()
        expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
      })

      it('opening a page asks first when a guard is held for another page', async () => {
        const guard = await import('./wiki/navigation-guard.ts')
        await renderApp()
        fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))
        await act(async () => {})
        const release = guard.registerNavigationGuard({pageId: 'topics.elsewhere', message: 'Leave?'})

        fireEvent.click(screen.getByRole('link', {name: 'acme/alpha'}))

        expect(confirmSpy).toHaveBeenCalledWith('Leave?')
        expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
        expect(window.location.pathname).toBe('/wiki')
        release()
      })
    })

    it('an unknown ID in the URL shows not-found with a path back to the list', async () => {
      const wikiApi = await import('./api/wiki.ts')
      vi.mocked(wikiApi.getWikiPage).mockResolvedValue({ok: false, error: {kind: 'not-found'}})
      window.history.replaceState(null, '', '/wiki/repos.nope')
      await renderApp()

      expect(screen.getByTestId('wiki-page-not-found')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('link', {name: 'Back to the wiki list'}))
      await act(async () => {})
      expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
    })
  })

  describe('OPEN_RUN from the wiki view', () => {
    type Listener = (event: unknown) => void
    const controller = {postMessage: vi.fn()}
    let listeners: Set<Listener>
    let originalDescriptor: PropertyDescriptor | undefined

    beforeEach(async () => {
      listeners = new Set()
      originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          controller,
          ready: new Promise(() => {}),
          addEventListener: (type: string, listener: Listener) => {
            if (type === 'message') listeners.add(listener)
          },
          removeEventListener: (type: string, listener: Listener) => {
            if (type === 'message') listeners.delete(listener)
          },
        },
      })
      const runtimeModule = await import('./operator/runtime.ts')
      vi.spyOn(runtimeModule, 'requestRunJump').mockImplementation(() => {})
    })

    afterEach(() => {
      if (originalDescriptor === undefined) Reflect.deleteProperty(navigator, 'serviceWorker')
      else Object.defineProperty(navigator, 'serviceWorker', originalDescriptor)
    })

    function deliver(data: unknown) {
      act(() => {
        for (const listener of [...listeners]) listener({data, source: controller})
      })
    }

    it('switches back to Runs from the list and requests the jump', async () => {
      const runtimeModule = await import('./operator/runtime.ts')
      await renderApp()
      fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))
      expect(operatorWrapper().style.display).toBe('none')

      deliver({type: 'OPEN_RUN', runId: 'run-from-wiki'})

      expect(operatorWrapper().style.display).toBe('block')
      expect(screen.queryByTestId('wiki-list')).toBeNull()
      expect(runtimeModule.requestRunJump).toHaveBeenCalledWith('run-from-wiki')
    })

    it('a refused leave keeps the wiki view and does not request the jump', async () => {
      const guard = await import('./wiki/navigation-guard.ts')
      const runtimeModule = await import('./operator/runtime.ts')
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      await renderApp()
      fireEvent.click(screen.getByRole('button', {name: 'Wiki'}))
      const release = guard.registerNavigationGuard({pageId: 'repos.acme--alpha', message: 'Leave?'})

      deliver({type: 'OPEN_RUN', runId: 'run-held'})

      expect(operatorWrapper().style.display).toBe('none')
      expect(screen.getByTestId('wiki-list')).toBeInTheDocument()
      expect(runtimeModule.requestRunJump).not.toHaveBeenCalled()
      release()
    })

    it('switches back to Runs from a wiki page and takes the page off the URL', async () => {
      window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
      await renderApp()
      expect(operatorWrapper().style.display).toBe('none')

      deliver({type: 'OPEN_RUN', runId: 'run-from-page'})

      expect(operatorWrapper().style.display).toBe('block')
      expect(screen.queryByTestId('wiki-page')).toBeNull()
      expect(window.location.pathname).toBe('/')
    })
  })
})
