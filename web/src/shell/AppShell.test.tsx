import {fireEvent, render, screen} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as logoutPurgeModule from '../pwa/logout-purge.ts'
import {AppShell} from './AppShell.tsx'

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

describe('AppShell', () => {
  beforeEach(() => {
    // Reset localStorage and data-theme before each test
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    stubMatchMedia(false) // default: prefers dark
  })

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
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
    const purgeSpy = vi.spyOn(logoutPurgeModule, 'purgeOperatorCache').mockReturnValue(undefined)

    // Stub fetch so logout doesn't make real network calls
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))

    render(<AppShell>content</AppShell>)
    fireEvent.click(screen.getByTestId('logout-button'))

    expect(purgeSpy).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
    purgeSpy.mockRestore()
  })
})
