import {fireEvent, render, screen} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {getLogoutAbortSignal} from '../push/logout-abort.ts'
import * as logoutPurgeModule from '../pwa/logout-purge.ts'
import {AppShell} from './AppShell.tsx'

// jsdom throws "Not implemented: navigation to another Document" on real
// `window.location.href =` assignment and never reflects the new value.
// Stub `location` with a plain object so redirect assertions observe the
// value the app actually set instead of jsdom's fixed default.
function stubLocation(): {href: string} {
  const stub = {href: window.location.href}
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: stub,
  })
  return stub
}

// jsdom doesn't implement matchMedia — stub it
function stubMatchMedia(prefersLight: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: prefersLight && query.includes('light'),
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

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString()
}

function findFetchCall(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.find(([input]) => requestUrl(input).includes(path))
}

function countFetchCalls(fetchMock: ReturnType<typeof vi.fn>, path: string): number {
  return fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes(path)).length
}

function csrfOkResponse(token = 'test-csrf-token') {
  return new Response(JSON.stringify({csrfToken: token}), {
    status: 200,
    headers: {'content-type': 'application/json'},
  })
}

function logoutOkResponse() {
  return new Response(JSON.stringify({ok: true}), {
    status: 200,
    headers: {'content-type': 'application/json'},
  })
}

function nonOkResponse(status = 500) {
  return new Response(null, {status})
}

// Routes fetch to CSRF/logout handlers by URL; anything else throws so an
// unexpected call fails the test loudly instead of hanging.
function mockLogoutFetch(routes: {
  csrf?: () => Response | Promise<Response>
  logout?: () => Response | Promise<Response>
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    if (url.includes('/operator/session/csrf') && routes.csrf) return routes.csrf()
    if (url.includes('/operator/auth/logout') && routes.logout) return routes.logout()
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function spyOnPurgeOperatorCache() {
  return vi.spyOn(logoutPurgeModule, 'purgeOperatorCache').mockReturnValue(undefined)
}

function stubServiceWorker(getSubscription: () => Promise<unknown>) {
  Object.defineProperty(navigator, 'serviceWorker', {
    writable: true,
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: {getSubscription},
      }),
      controller: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
}

function fakePushSubscription(endpoint = 'https://push.example/abc') {
  return {
    endpoint,
    toJSON: () => ({endpoint}),
    unsubscribe: vi.fn().mockResolvedValue(true),
  }
}

describe('AppShell', () => {
  beforeEach(() => {
    // Reset localStorage and data-theme before each test
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    stubMatchMedia(false) // default: prefers dark
  })

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders a nav/header', () => {
    render(<AppShell>content</AppShell>)
    expect(screen.getByTestId('app-nav')).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
  })

  it('renders children through the content slot', () => {
    render(
      <AppShell>
        <p data-testid="child-content">hello world</p>
      </AppShell>,
    )
    expect(screen.getByTestId('child-content')).toHaveTextContent('hello world')
    expect(screen.getByTestId('app-content')).toContainElement(
      screen.getByTestId('child-content'),
    )
  })

  it('renders the brand link with accessible label', () => {
    render(<AppShell>content</AppShell>)
    expect(screen.getByRole('link', {name: /fro bot dashboard home/i})).toBeInTheDocument()
  })

  it('renders primary navigation landmark', () => {
    render(<AppShell>content</AppShell>)
    expect(screen.getByRole('navigation', {name: /primary navigation/i})).toBeInTheDocument()
  })

  it('header has sticky positioning style', () => {
    render(<AppShell>content</AppShell>)
    const header = screen.getByTestId('app-nav')
    expect(header).toHaveStyle({position: 'sticky'})
  })

  it('content slot has responsive padding classes', () => {
    render(<AppShell>content</AppShell>)
    const main = screen.getByTestId('app-content')
    expect(main.className).toMatch(/sm:px-6/)
    expect(main.className).toMatch(/md:px-8/)
    expect(main.className).toMatch(/lg:px-10/)
  })

  it('nav inner container has responsive padding classes', () => {
    render(<AppShell>content</AppShell>)
    const nav = screen.getByTestId('app-nav')
    const inner = nav.querySelector('[class*="sm:px-6"]')
    expect(inner).not.toBeNull()
  })

  it('renders a theme toggle button', () => {
    render(<AppShell>content</AppShell>)
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument()
  })

  it('defaults to dark theme and sets data-theme on <html>', () => {
    render(<AppShell>content</AppShell>)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('toggles data-theme from dark to light on click', () => {
    render(<AppShell>content</AppShell>)

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    fireEvent.click(screen.getByTestId('theme-toggle'))

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('toggles data-theme back to dark on second click', () => {
    render(<AppShell>content</AppShell>)

    fireEvent.click(screen.getByTestId('theme-toggle'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    fireEvent.click(screen.getByTestId('theme-toggle'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('persists theme choice to localStorage', () => {
    render(<AppShell>content</AppShell>)

    fireEvent.click(screen.getByTestId('theme-toggle'))

    expect(window.localStorage.getItem('fro-bot-theme')).toBe('light')
  })

  it('reads initial theme from localStorage', () => {
    window.localStorage.setItem('fro-bot-theme', 'light')
    render(<AppShell>content</AppShell>)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('theme toggle button has accessible aria-label', () => {
    render(<AppShell>content</AppShell>)
    const btn = screen.getByTestId('theme-toggle')
    expect(btn).toHaveAttribute('aria-label', 'Switch to light theme')
  })

  it('aria-label updates after toggle', () => {
    render(<AppShell>content</AppShell>)

    fireEvent.click(screen.getByTestId('theme-toggle'))

    expect(screen.getByTestId('theme-toggle')).toHaveAttribute(
      'aria-label',
      'Switch to dark theme',
    )
  })

  it('logout calls purgeOperatorCache, not purgeMonitoringCache', () => {
    // AppShell must call the generalized operator purge on logout,
    // not the monitoring-named cache purge.
    const purgeSpy = spyOnPurgeOperatorCache()

    // Stub fetch so logout doesn't make real network calls
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))

    render(<AppShell>content</AppShell>)
    fireEvent.click(screen.getByTestId('logout-button'))

    expect(purgeSpy).toHaveBeenCalledTimes(1)
  })

  it('logout fetches CSRF and POSTs logout with the token, then redirects to /auth/login', async () => {
    const purgeSpy = spyOnPurgeOperatorCache()
    const location = stubLocation()
    const fetchMock = mockLogoutFetch({csrf: csrfOkResponse, logout: logoutOkResponse})

    render(<AppShell>content</AppShell>)
    fireEvent.click(screen.getByTestId('logout-button'))

    await vi.waitFor(() => {
      const logoutCall = findFetchCall(fetchMock, '/operator/auth/logout')
      expect(logoutCall).toBeDefined()
      const [, init] = logoutCall ?? []
      expect(init?.method).toBe('POST')
      expect(init?.credentials).toBe('same-origin')
      expect(new Headers(init?.headers).get('x-csrf-token')).toBe('test-csrf-token')
    })

    await vi.waitFor(() => {
      expect(location.href).toBe('/auth/login')
    })

    expect(purgeSpy).toHaveBeenCalledTimes(1)
  })

  it('disables the button and issues only one CSRF/logout call pair on rapid double-click', async () => {
    spyOnPurgeOperatorCache()

    let resolveCsrf: ((res: Response) => void) | undefined
    const fetchMock = mockLogoutFetch({
      // Hold the CSRF fetch open so we can assert disabled state
      // and fire the second click while it's still pending.
      csrf: () => new Promise<Response>((resolve) => (resolveCsrf = resolve)),
      logout: logoutOkResponse,
    })

    render(<AppShell>content</AppShell>)
    const button = screen.getByTestId('logout-button')

    fireEvent.click(button)
    fireEvent.click(button)

    expect(button).toBeDisabled()
    expect(countFetchCalls(fetchMock, '/operator/session/csrf')).toBe(1)

    resolveCsrf?.(csrfOkResponse())

    await vi.waitFor(() => {
      expect(countFetchCalls(fetchMock, '/operator/auth/logout')).toBe(1)
    })
  })

  it('redirects to /auth/login and skips the logout POST when the CSRF endpoint is non-ok', async () => {
    spyOnPurgeOperatorCache()
    const location = stubLocation()
    const fetchMock = mockLogoutFetch({csrf: () => nonOkResponse()})

    render(<AppShell>content</AppShell>)
    fireEvent.click(screen.getByTestId('logout-button'))

    await vi.waitFor(() => {
      expect(location.href).toBe('/auth/login')
    })

    expect(findFetchCall(fetchMock, '/operator/auth/logout')).toBeUndefined()
  })

  it('redirects to /auth/login when the logout POST is non-ok', async () => {
    spyOnPurgeOperatorCache()
    const location = stubLocation()
    mockLogoutFetch({csrf: csrfOkResponse, logout: () => nonOkResponse()})

    render(<AppShell>content</AppShell>)
    fireEvent.click(screen.getByTestId('logout-button'))

    await vi.waitFor(() => {
      expect(location.href).toBe('/auth/login')
    })
  })

  it('redirects to /auth/login when the fetch rejects (network error)', async () => {
    spyOnPurgeOperatorCache()
    const location = stubLocation()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))

    render(<AppShell>content</AppShell>)
    fireEvent.click(screen.getByTestId('logout-button'))

    await vi.waitFor(() => {
      expect(location.href).toBe('/auth/login')
    })
  })

  it('fails closed without sending a logout POST when the CSRF response body is malformed', async () => {
    spyOnPurgeOperatorCache()
    const location = stubLocation()
    // Missing csrfToken field entirely.
    const fetchMock = mockLogoutFetch({
      csrf: () =>
        new Response(JSON.stringify({unexpected: 'shape'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    })

    render(<AppShell>content</AppShell>)
    fireEvent.click(screen.getByTestId('logout-button'))

    await vi.waitFor(() => {
      expect(location.href).toBe('/auth/login')
    })

    expect(findFetchCall(fetchMock, '/operator/auth/logout')).toBeUndefined()
  })

  describe('push teardown on logout', () => {
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'serviceWorker')
    })

    it('logout calls local unsubscribe() + Gateway unsubscribe, then navigates', async () => {
      spyOnPurgeOperatorCache()
      const location = stubLocation()
      const subscription = fakePushSubscription()
      stubServiceWorker(() => Promise.resolve(subscription))
      const fetchMock = mockLogoutFetch({csrf: csrfOkResponse, logout: logoutOkResponse})

      render(<AppShell>content</AppShell>)
      fireEvent.click(screen.getByTestId('logout-button'))

      await vi.waitFor(() => {
        expect(subscription.unsubscribe).toHaveBeenCalledTimes(1)
      })

      await vi.waitFor(() => {
        // unsubscribeOptOut refetches CSRF for the Gateway unsubscribe POST,
        // so there are two CSRF calls: one from handleLogout, one from
        // unsubscribeOptOut's own refreshCsrf().
        expect(countFetchCalls(fetchMock, '/operator/push/subscriptions/unsubscribe')).toBe(1)
      })

      await vi.waitFor(() => {
        expect(location.href).toBe('/auth/login')
      })
    })

    it('push teardown failure/timeout still completes logout and navigates', async () => {
      spyOnPurgeOperatorCache()
      const location = stubLocation()
      stubServiceWorker(() => Promise.reject(new Error('sw teardown boom')))
      mockLogoutFetch({csrf: csrfOkResponse, logout: logoutOkResponse})

      render(<AppShell>content</AppShell>)
      fireEvent.click(screen.getByTestId('logout-button'))

      await vi.waitFor(() => {
        expect(location.href).toBe('/auth/login')
      })
    })

    it('endpointless case: no local subscription -> no Gateway unsubscribe call, still navigates', async () => {
      spyOnPurgeOperatorCache()
      const location = stubLocation()
      stubServiceWorker(() => Promise.resolve(null))
      const fetchMock = mockLogoutFetch({csrf: csrfOkResponse, logout: logoutOkResponse})

      render(<AppShell>content</AppShell>)
      fireEvent.click(screen.getByTestId('logout-button'))

      await vi.waitFor(() => {
        expect(location.href).toBe('/auth/login')
      })

      expect(findFetchCall(fetchMock, '/operator/push/subscriptions/unsubscribe')).toBeUndefined()
    })

    it('logout triggers the shared logout-abort signal so an in-flight subscribe discards its result', () => {
      spyOnPurgeOperatorCache()
      stubServiceWorker(() => Promise.resolve(null))
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))

      render(<AppShell>content</AppShell>)
      const signalBefore = getLogoutAbortSignal()
      expect(signalBefore.aborted).toBe(false)

      fireEvent.click(screen.getByTestId('logout-button'))

      expect(signalBefore.aborted).toBe(true)
    })
  })
})
