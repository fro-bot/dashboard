/**
 * ReloadPrompt tests — mocked useRegisterSW.
 *
 * The virtual:pwa-register/react module is aliased to a stub in vitest.config.ts.
 * We override the stub's return value per test using vi.mocked().mockReturnValue().
 */

import {render, screen, fireEvent} from '@testing-library/react'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import * as pwaRegister from 'virtual:pwa-register/react'
import {ReloadPrompt} from './ReloadPrompt.tsx'

describe('ReloadPrompt', () => {
  const mockUpdateServiceWorker = vi.fn()
  const mockSetNeedRefresh = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no refresh needed
    vi.mocked(pwaRegister.useRegisterSW).mockReturnValue({
      needRefresh: [false, mockSetNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: mockUpdateServiceWorker,
    })
  })

  it('renders nothing when needRefresh is false', () => {
    render(<ReloadPrompt />)
    expect(screen.queryByTestId('reload-prompt')).toBeNull()
  })

  it('renders the update banner when needRefresh is true', () => {
    vi.mocked(pwaRegister.useRegisterSW).mockReturnValue({
      needRefresh: [true, mockSetNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: mockUpdateServiceWorker,
    })
    render(<ReloadPrompt />)
    expect(screen.getByTestId('reload-prompt')).toBeInTheDocument()
    expect(screen.getByText('New version available')).toBeInTheDocument()
  })

  it('calls updateServiceWorker with no args when Refresh is clicked', () => {
    vi.mocked(pwaRegister.useRegisterSW).mockReturnValue({
      needRefresh: [true, mockSetNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: mockUpdateServiceWorker,
    })
    render(<ReloadPrompt />)
    fireEvent.click(screen.getByTestId('reload-prompt-refresh'))
    expect(mockUpdateServiceWorker).toHaveBeenCalledTimes(1)
    // No args — the bool arg is a deprecated no-op in vite-plugin-pwa v1.
    expect(mockUpdateServiceWorker).toHaveBeenCalledWith()
  })

  it('calls setNeedRefresh(false) when dismiss is clicked', () => {
    vi.mocked(pwaRegister.useRegisterSW).mockReturnValue({
      needRefresh: [true, mockSetNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: mockUpdateServiceWorker,
    })
    render(<ReloadPrompt />)
    fireEvent.click(screen.getByTestId('reload-prompt-dismiss'))
    expect(mockSetNeedRefresh).toHaveBeenCalledWith(false)
  })

  it('does not call updateServiceWorker when dismiss is clicked', () => {
    vi.mocked(pwaRegister.useRegisterSW).mockReturnValue({
      needRefresh: [true, mockSetNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: mockUpdateServiceWorker,
    })
    render(<ReloadPrompt />)
    fireEvent.click(screen.getByTestId('reload-prompt-dismiss'))
    expect(mockUpdateServiceWorker).not.toHaveBeenCalled()
  })

  it('uses role=status (polite) for the non-urgent update notice', () => {
    vi.mocked(pwaRegister.useRegisterSW).mockReturnValue({
      needRefresh: [true, mockSetNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: mockUpdateServiceWorker,
    })
    render(<ReloadPrompt />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('hourly interval calls registration.update() — NOT updateServiceWorker (no silent skip-waiting/reload)', () => {
    vi.useFakeTimers()
    const mockRegistrationUpdate = vi.fn().mockResolvedValue(undefined)
    // Make the hook invoke onRegisteredSW with a fake registration whose update()
    // we can observe, mirroring vite-plugin-pwa's real callback.
    vi.mocked(pwaRegister.useRegisterSW).mockImplementation(
      (options?: {onRegisteredSW?: (url: string, reg: ServiceWorkerRegistration) => void}) => {
        options?.onRegisteredSW?.('/sw.js', {
          update: mockRegistrationUpdate,
        } as unknown as ServiceWorkerRegistration)
        return {
          needRefresh: [false, mockSetNeedRefresh],
          offlineReady: [false, vi.fn()],
          updateServiceWorker: mockUpdateServiceWorker,
        }
      },
    )

    render(<ReloadPrompt />)
    // Advance one hour to fire the interval.
    vi.advanceTimersByTime(60 * 60 * 1000)

    expect(mockRegistrationUpdate).toHaveBeenCalledTimes(1)
    // The interval must NOT activate the waiting SW (that bypasses the prompt).
    expect(mockUpdateServiceWorker).not.toHaveBeenCalled()

    vi.useRealTimers()
  })
})
