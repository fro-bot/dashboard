/**
 * InstallPrompt tests — synthetic beforeinstallprompt + appinstalled events.
 *
 * Tests the install affordance lifecycle:
 *   - beforeinstallprompt fired → Install control appears
 *   - clicking Install calls the event's prompt()
 *   - appinstalled → control hidden
 *   - dismiss → control hidden + localStorage persisted
 */

import {render, screen, fireEvent, act} from '@testing-library/react'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {InstallPrompt} from './InstallPrompt.tsx'

const DISMISS_KEY = 'fro-bot-install-dismissed'

/** Create a synthetic BeforeInstallPromptEvent with a mock prompt(). */
function makeInstallPromptEvent(): {event: Event; prompt: ReturnType<typeof vi.fn>} {
  const prompt = vi.fn().mockResolvedValue(undefined)
  const event = new Event('beforeinstallprompt') as Event & {prompt: typeof prompt}
  event.prompt = prompt
  return {event, prompt}
}

describe('InstallPrompt', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('renders nothing before beforeinstallprompt fires', () => {
    render(<InstallPrompt />)
    expect(screen.queryByTestId('install-prompt')).toBeNull()
  })

  it('shows the Install control after beforeinstallprompt fires', () => {
    render(<InstallPrompt />)
    const {event} = makeInstallPromptEvent()
    act(() => {
      window.dispatchEvent(event)
    })
    expect(screen.getByTestId('install-prompt')).toBeInTheDocument()
    expect(screen.getByTestId('install-prompt-button')).toBeInTheDocument()
  })

  it('calls the event prompt() when Install is clicked', async () => {
    render(<InstallPrompt />)
    const {event, prompt} = makeInstallPromptEvent()
    act(() => {
      window.dispatchEvent(event)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('install-prompt-button'))
    })
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('hides the control after Install is clicked (no re-prompt)', async () => {
    render(<InstallPrompt />)
    const {event} = makeInstallPromptEvent()
    act(() => {
      window.dispatchEvent(event)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('install-prompt-button'))
    })
    expect(screen.queryByTestId('install-prompt')).toBeNull()
  })

  it('hides the control when appinstalled fires', () => {
    render(<InstallPrompt />)
    const {event} = makeInstallPromptEvent()
    act(() => {
      window.dispatchEvent(event)
    })
    expect(screen.getByTestId('install-prompt')).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new Event('appinstalled'))
    })
    expect(screen.queryByTestId('install-prompt')).toBeNull()
  })

  it('hides the control when dismiss is clicked', () => {
    render(<InstallPrompt />)
    const {event} = makeInstallPromptEvent()
    act(() => {
      window.dispatchEvent(event)
    })
    fireEvent.click(screen.getByTestId('install-prompt-dismiss'))
    expect(screen.queryByTestId('install-prompt')).toBeNull()
  })

  it('persists dismiss to localStorage', () => {
    render(<InstallPrompt />)
    const {event} = makeInstallPromptEvent()
    act(() => {
      window.dispatchEvent(event)
    })
    fireEvent.click(screen.getByTestId('install-prompt-dismiss'))
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1')
  })

  it('does not show the control when already dismissed (localStorage)', () => {
    localStorage.setItem(DISMISS_KEY, '1')
    render(<InstallPrompt />)
    const {event} = makeInstallPromptEvent()
    act(() => {
      window.dispatchEvent(event)
    })
    // Even though the event fired, the dismissed state suppresses the control.
    expect(screen.queryByTestId('install-prompt')).toBeNull()
  })
})
