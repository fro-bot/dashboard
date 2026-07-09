import {render, screen, fireEvent, act} from '@testing-library/react'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {getNotificationPermission, getPushSupport} from '../push/capability.ts'
import {
  resubscribeStaleKey,
  runReconcileSweep,
  subscribeOptIn,
  unsubscribeOptOut,
} from '../push/subscribe.ts'
import {Notifications} from './Notifications.tsx'

vi.mock('../push/capability.ts', () => ({
  getNotificationPermission: vi.fn(),
  getPushSupport: vi.fn(),
}))

vi.mock('../push/subscribe.ts', () => ({
  INITIAL_RECONCILE_SWEEP_CACHE: {},
  buildPushClient: vi.fn().mockReturnValue({}),
  runReconcileSweep: vi.fn(),
  subscribeOptIn: vi.fn(),
  resubscribeStaleKey: vi.fn(),
  unsubscribeOptOut: vi.fn(),
}))

describe('Notifications Component', () => {
  let metaTag: HTMLMetaElement | null = null

  const addMetaTag = () => {
    metaTag = document.createElement('meta')
    metaTag.setAttribute('name', 'push-enabled')
    metaTag.setAttribute('content', 'true')
    document.head.appendChild(metaTag)
  }

  const removeMetaTag = () => {
    if (metaTag && metaTag.parentNode) {
      metaTag.parentNode.removeChild(metaTag)
    }
    metaTag = null
  }

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    removeMetaTag()

    // Default mock behavior
    vi.mocked(getPushSupport).mockReturnValue({supported: true, needsInstall: false})
    vi.mocked(getNotificationPermission).mockReturnValue('default')
    vi.mocked(runReconcileSweep).mockResolvedValue({
      skipped: false,
      action: undefined,
      uiState: 'not-requested',
      nextCache: {} as any,
    })
  })

  it('renders nothing when push-enabled meta is absent', () => {
    render(<Notifications />)
    expect(screen.queryByTestId('notifications-settings')).toBeNull()
  })

  it('renders the component when push-enabled meta is present', async () => {
    addMetaTag()
    await act(async () => {
      render(<Notifications />)
    })
    expect(screen.getByTestId('notifications-settings')).toBeInTheDocument()
  })

  it('handles state: ios-not-installed', async () => {
    addMetaTag()
    vi.mocked(getPushSupport).mockReturnValue({supported: false, needsInstall: true})

    await act(async () => {
      render(<Notifications />)
    })

    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Installation Required')
    expect(screen.getByTestId('notifications-cta')).toHaveTextContent('Install App')
  })

  it('handles state: unsupported', async () => {
    addMetaTag()
    vi.mocked(getPushSupport).mockReturnValue({supported: false, needsInstall: false})

    await act(async () => {
      render(<Notifications />)
    })

    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Alerts Unsupported')
    expect(screen.queryByTestId('notifications-cta')).toBeNull()
  })

  it('handles state: denied', async () => {
    addMetaTag()
    vi.mocked(runReconcileSweep).mockResolvedValue({
      skipped: false,
      action: undefined,
      uiState: 'denied',
      nextCache: {} as any,
    })

    await act(async () => {
      render(<Notifications />)
    })

    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Alerts Blocked')
    expect(screen.queryByTestId('notifications-cta')).toBeNull()
  })

  it('cleanup action honors reconcile uiState (denied → Blocked, not Unsupported)', async () => {
    addMetaTag()
    // The `cleanup` action fires for push_disabled, denied-without-subscription,
    // AND granted-but-drifted — each with a different correct uiState. The
    // handler must honor result.uiState, not hardcode 'unsupported'. Regression:
    // a blocked browser rendered "Alerts Unsupported" instead of "Alerts Blocked".
    const originalSw = Object.getOwnPropertyDescriptor(globalThis.navigator, 'serviceWorker')
    const swStub = {
      ready: Promise.resolve({pushManager: {getSubscription: async () => null}}),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: swStub,
      configurable: true,
    })
    vi.mocked(runReconcileSweep).mockResolvedValue({
      skipped: false,
      action: 'cleanup',
      uiState: 'denied',
      nextCache: {} as any,
    })

    try {
      await act(async () => {
        render(<Notifications />)
      })
      expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Alerts Blocked')
    } finally {
      if (originalSw) {
        Object.defineProperty(globalThis.navigator, 'serviceWorker', originalSw)
      } else {
        // Remove the stub we added so it can't leak into sibling tests.
        Reflect.deleteProperty(globalThis.navigator, 'serviceWorker')
      }
    }
  })

  it('handles state: subscribed', async () => {
    addMetaTag()
    vi.mocked(runReconcileSweep).mockResolvedValue({
      skipped: false,
      action: undefined,
      uiState: 'subscribed',
      nextCache: {} as any,
    })

    await act(async () => {
      render(<Notifications />)
    })

    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Alerts Active')
    expect(screen.getByTestId('notifications-cta')).toHaveTextContent('Disable notifications')
  })

  it('handles state: not-requested', async () => {
    addMetaTag()
    await act(async () => {
      render(<Notifications />)
    })

    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Push Alerts')
    expect(screen.getByTestId('notifications-cta')).toHaveTextContent('Enable notifications')
  })

  it('handles transitioning from not-requested to dismissed on user dismiss', async () => {
    addMetaTag()
    vi.mocked(subscribeOptIn).mockResolvedValue({kind: 'dismissed'})

    await act(async () => {
      render(<Notifications />)
    })

    const cta = screen.getByTestId('notifications-cta')
    await act(async () => {
      fireEvent.click(cta)
    })

    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Prompt Closed')
    expect(screen.getByTestId('notifications-cta')).toHaveTextContent('Try again')
  })

  it('handles transitioning to subscribe-failed on registration failure', async () => {
    addMetaTag()
    vi.mocked(subscribeOptIn).mockResolvedValue({kind: 'subscribe-failed'})

    await act(async () => {
      render(<Notifications />)
    })

    const cta = screen.getByTestId('notifications-cta')
    await act(async () => {
      fireEvent.click(cta)
    })

    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Setup Failed')
    expect(screen.getByTestId('notifications-cta')).toHaveTextContent('Retry Registration')
  })

  it('handles transitioning to sw-not-ready when service worker ready times out', async () => {
    addMetaTag()
    vi.mocked(subscribeOptIn).mockResolvedValue({kind: 'sw-not-ready'})

    await act(async () => {
      render(<Notifications />)
    })

    const cta = screen.getByTestId('notifications-cta')
    await act(async () => {
      fireEvent.click(cta)
    })

    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Initializing background sync')
    expect(screen.getByTestId('notifications-cta')).toHaveTextContent('Retry')
  })

  it('dismisses card and persists to localStorage', async () => {
    addMetaTag()
    await act(async () => {
      render(<Notifications />)
    })

    const dismissBtn = screen.getByTestId('notifications-card-dismiss')
    await act(async () => {
      fireEvent.click(dismissBtn)
    })

    expect(screen.queryByTestId('notifications-settings')).toBeNull()
    expect(localStorage.getItem('fro-bot-notifications-dismissed')).toBe('1')
  })

  it('does not render card if already dismissed in localStorage', async () => {
    addMetaTag()
    localStorage.setItem('fro-bot-notifications-dismissed', '1')

    await act(async () => {
      render(<Notifications />)
    })

    expect(screen.queryByTestId('notifications-settings')).toBeNull()
  })

  it('runs reconcile actions: register', async () => {
    addMetaTag()
    vi.mocked(runReconcileSweep).mockResolvedValue({
      skipped: false,
      action: 'register',
      uiState: 'not-requested',
      nextCache: {} as any,
    })
    vi.mocked(subscribeOptIn).mockResolvedValue({kind: 'subscribed'})

    await act(async () => {
      render(<Notifications />)
    })

    expect(subscribeOptIn).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Alerts Active')
  })

  it('runs reconcile actions: resubscribe', async () => {
    addMetaTag()
    vi.mocked(runReconcileSweep).mockResolvedValue({
      skipped: false,
      action: 'resubscribe',
      uiState: 'subscribed',
      nextCache: {} as any,
    })
    vi.mocked(resubscribeStaleKey).mockResolvedValue({kind: 'subscribed'})

    await act(async () => {
      render(<Notifications />)
    })

    expect(resubscribeStaleKey).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Alerts Active')
  })

  it('runs reconcile actions: cleanup-and-unsubscribe', async () => {
    addMetaTag()
    vi.mocked(runReconcileSweep).mockResolvedValue({
      skipped: false,
      action: 'cleanup-and-unsubscribe',
      uiState: 'not-requested',
      nextCache: {} as any,
    })
    vi.mocked(getNotificationPermission).mockReturnValue('default')

    await act(async () => {
      render(<Notifications />)
    })

    expect(unsubscribeOptOut).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Push Alerts')
  })

  it('handles focus placement and aria-live announcements during state transitions', async () => {
    addMetaTag()
    render(<Notifications />)

    // Initial state (not-requested) cta should gain focus
    const cta = screen.getByTestId('notifications-cta')
    expect(document.activeElement).toBe(cta)

    // Simulate transition
    vi.mocked(subscribeOptIn).mockResolvedValue({kind: 'dismissed'})
    await act(async () => {
      fireEvent.click(cta)
    })

    // Now the "Try again" CTA should gain focus
    const newCta = screen.getByTestId('notifications-cta')
    expect(document.activeElement).toBe(newCta)
    expect(newCta).toHaveTextContent('Try again')

    // Confirm presence of screen reader announcer
    const announcer = screen.getByTestId('notifications-status-announcer')
    expect(announcer).toBeInTheDocument()
  })

  it('listens for appinstalled event to transition out of ios-not-installed', async () => {
    addMetaTag()
    vi.mocked(getPushSupport).mockReturnValue({supported: false, needsInstall: true})

    await act(async () => {
      render(<Notifications />)
    })

    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Installation Required')

    // Change push support and fire event
    vi.mocked(getPushSupport).mockReturnValue({supported: true, needsInstall: false})
    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'))
    })

    expect(screen.getByTestId('notifications-headline')).toHaveTextContent('Push Alerts')
  })

  it('triggers postMessage to SW controller on synthetic push click', async () => {
    addMetaTag()
    const postMessage = vi.fn()
    const mockController = {postMessage}

    Object.defineProperty(navigator, 'serviceWorker', {
      writable: true,
      value: {
        controller: mockController,
        ready: Promise.resolve({}),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    })

    await act(async () => {
      render(<Notifications />)
    })

    const syncBtn = screen.getByTestId('synthetic-push-btn')
    expect(syncBtn).toBeInTheDocument()

    fireEvent.click(syncBtn)
    expect(postMessage).toHaveBeenCalledWith({
      type: 'MOCK_SYNTHETIC_PUSH',
      payload: {type: 'approval'},
    })
  })
})
