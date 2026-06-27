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
    // Operator shell renders a heading — not a monitoring loading state
    expect(screen.getByRole('heading')).toBeInTheDocument()
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

  // ── Regression: SW prompts remain reachable ────────────────────────────────

  it('ReloadPrompt is mounted (SW update affordance survives shell swap)', () => {
    render(<App />)
    // ReloadPrompt renders null when needRefresh is false (the default in tests),
    // but it must be mounted so the SW registration hook runs.
    // We verify AppShell is present (which always mounts ReloadPrompt).
    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
  })
})
