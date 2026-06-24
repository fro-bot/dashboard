import {render, screen} from '@testing-library/react'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import * as aggregationModule from './api/aggregation.ts'
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
    // Mock the BFF fetch so Monitoring doesn't make real network calls
    vi.spyOn(aggregationModule, 'fetchAggregationSnapshot').mockReturnValue(
      new Promise(() => undefined), // never resolves — keeps loading state
    )
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

  it('renders Monitoring view inside AppShell', () => {
    render(<App />)
    // Monitoring starts in loading state while fetch is in flight
    expect(screen.getByTestId('monitoring-loading')).toBeInTheDocument()
  })
})
