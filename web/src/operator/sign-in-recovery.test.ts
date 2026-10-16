import {afterEach, describe, expect, it, vi} from 'vitest'
import {createOperatorRuntime} from './runtime.ts'
import {
  clearGatewaySignInRedirectGuard,
  GATEWAY_SIGN_IN_URL,
  maybeAutoRedirectToGatewaySignIn,
  navigateToGatewaySignIn,
} from './sign-in-recovery.ts'

const SIGN_IN_GUARD_KEY = 'fro-bot.operator-sign-in-redirect'

describe('operator sign-in redirect recovery', () => {
  afterEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    vi.doUnmock('/static/operator-stream.js?manual=1')
    vi.doUnmock('/static/operator-run-index.js?manual=1')
    vi.doUnmock('/static/operator-launch.js?manual=1')
    vi.restoreAllMocks()
  })

  it('navigates the current tab to the gateway sign-in start URL', () => {
    const assign = vi.fn()

    navigateToGatewaySignIn(assign)

    expect(assign).toHaveBeenCalledWith(GATEWAY_SIGN_IN_URL)
    expect(GATEWAY_SIGN_IN_URL).toBe('/operator/auth/github/start?return_to=/operator')
  })

  it('automatically redirects once when the tab first reaches auth-required', () => {
    const navigate = vi.fn()

    maybeAutoRedirectToGatewaySignIn('auth-required', navigate)
    maybeAutoRedirectToGatewaySignIn('auth-required', navigate)

    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('sets the tab redirect flag before navigating on the first signed-out load', () => {
    let flagAtNavigation: string | null = null
    const navigate = vi.fn(() => {
      flagAtNavigation = sessionStorage.getItem(SIGN_IN_GUARD_KEY)
    })

    maybeAutoRedirectToGatewaySignIn('auth-required', navigate)

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(flagAtNavigation).not.toBeNull()
    expect(sessionStorage.getItem(SIGN_IN_GUARD_KEY)).not.toBeNull()
  })

  it('does not auto-redirect while the tab redirect flag is set', () => {
    const navigate = vi.fn()
    sessionStorage.setItem(SIGN_IN_GUARD_KEY, '1')

    maybeAutoRedirectToGatewaySignIn('auth-required', navigate)

    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not auto-redirect when the flag was set more than 60 seconds ago (no time window)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-15T13:30:00Z'))
      sessionStorage.setItem(SIGN_IN_GUARD_KEY, String(Date.now()))
      vi.setSystemTime(new Date('2026-10-15T13:31:07Z'))
      const navigate = vi.fn()

      maybeAutoRedirectToGatewaySignIn('auth-required', navigate)

      expect(navigate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays one-shot across repeated signed-out loads far beyond 60 seconds', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-15T12:10:00Z'))
      const navigate = vi.fn()

      maybeAutoRedirectToGatewaySignIn('auth-required', navigate)
      for (let minute = 1; minute <= 120; minute++) {
        vi.advanceTimersByTime(60_000)
        maybeAutoRedirectToGatewaySignIn('auth-required', navigate)
      }

      expect(navigate).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not auto-redirect when sessionStorage throws', () => {
    const navigate = vi.fn()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })

    maybeAutoRedirectToGatewaySignIn('auth-required', navigate)

    expect(navigate).not.toHaveBeenCalled()
  })

  it('redirects again on a later signed-out load after the flag is cleared', async () => {
    const navigate = vi.fn()
    maybeAutoRedirectToGatewaySignIn('auth-required', navigate)
    expect(navigate).toHaveBeenCalledTimes(1)

    clearGatewaySignInRedirectGuard()

    expect(sessionStorage.getItem(SIGN_IN_GUARD_KEY)).toBeNull()
    maybeAutoRedirectToGatewaySignIn('auth-required', navigate)
    expect(navigate).toHaveBeenCalledTimes(2)
  })

  it.each(['ready', 'loading', 'rate-limited', 'offline', 'unavailable'] as const)(
    'does not auto-redirect in the %s state', state => {
      const navigate = vi.fn()

      maybeAutoRedirectToGatewaySignIn(state, navigate)

      expect(navigate).not.toHaveBeenCalled()
    },
  )

  it.each(['loaded', 'empty'] as const)('clears the tab redirect guard after a successful %s run-list load', async outcome => {
    sessionStorage.setItem(SIGN_IN_GUARD_KEY, '1')
    vi.doMock('/static/operator-stream.js?manual=1', () => ({
      initOperatorStream: vi.fn(),
      takeUsableFinishedRun: vi.fn(() => undefined),
      pruneFinishedRuns: vi.fn(),
      clearFinishedRuns: vi.fn(),
    }))
    vi.doMock('/static/operator-run-index.js?manual=1', () => ({
      initOperatorRunIndex: vi.fn(async () => outcome),
      refreshOperatorRunIndex: vi.fn(async () => true),
      resetRunIndexState: vi.fn(),
      markRunStreamAttached: vi.fn(),
      markCardExpandedForLaunch: vi.fn(),
    }))
    vi.doMock('/static/operator-launch.js?manual=1', () => ({
      initOperatorLaunch: vi.fn(async () => {}),
      resetLaunchState: vi.fn(),
    }))

    const runtime = createOperatorRuntime({
      container: document.createElement('div'),
      onStateChange: vi.fn(),
    })

    await vi.waitFor(() => expect(sessionStorage.getItem(SIGN_IN_GUARD_KEY)).toBeNull())
    runtime.cleanup()
  })

  it.each(['auth-required', 'unavailable'] as const)('preserves the tab redirect guard after an %s run-list outcome', async outcome => {
    const guardValue = '1'
    sessionStorage.setItem(SIGN_IN_GUARD_KEY, guardValue)
    vi.doMock('/static/operator-stream.js?manual=1', () => ({
      initOperatorStream: vi.fn(),
      takeUsableFinishedRun: vi.fn(() => undefined),
      pruneFinishedRuns: vi.fn(),
      clearFinishedRuns: vi.fn(),
    }))
    vi.doMock('/static/operator-run-index.js?manual=1', () => ({
      initOperatorRunIndex: vi.fn(async () => outcome),
      refreshOperatorRunIndex: vi.fn(async () => false),
      resetRunIndexState: vi.fn(),
      markRunStreamAttached: vi.fn(),
      markCardExpandedForLaunch: vi.fn(),
    }))
    vi.doMock('/static/operator-launch.js?manual=1', () => ({
      initOperatorLaunch: vi.fn(async () => {}),
      resetLaunchState: vi.fn(),
    }))

    const runtime = createOperatorRuntime({container: document.createElement('div'), onStateChange: vi.fn()})

    await vi.waitFor(() => expect(sessionStorage.getItem(SIGN_IN_GUARD_KEY)).toBe(guardValue))
    runtime.cleanup()
  })
})
