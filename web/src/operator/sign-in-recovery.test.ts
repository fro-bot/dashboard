import {afterEach, describe, expect, it, vi} from 'vitest'
import {createOperatorRuntime} from './runtime.ts'
import {GATEWAY_SIGN_IN_URL, maybeAutoRedirectToGatewaySignIn, navigateToGatewaySignIn} from './sign-in-recovery.ts'

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

  it('does not auto-redirect again during the 60-second tab guard window', () => {
    const navigate = vi.fn()
    sessionStorage.setItem(SIGN_IN_GUARD_KEY, String(Date.now()))

    maybeAutoRedirectToGatewaySignIn('auth-required', navigate)

    expect(navigate).not.toHaveBeenCalled()
  })

  it.each(['ready', 'loading', 'rate-limited', 'offline', 'unavailable'] as const)(
    'does not auto-redirect in the %s state', state => {
      const navigate = vi.fn()

      maybeAutoRedirectToGatewaySignIn(state, navigate)

      expect(navigate).not.toHaveBeenCalled()
    },
  )

  it.each(['loaded', 'empty'] as const)('clears the tab redirect guard after a successful %s run-list load', async outcome => {
    sessionStorage.setItem(SIGN_IN_GUARD_KEY, String(Date.now()))
    vi.doMock('/static/operator-stream.js?manual=1', () => ({initOperatorStream: vi.fn()}))
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
    const guardValue = String(Date.now())
    sessionStorage.setItem(SIGN_IN_GUARD_KEY, guardValue)
    vi.doMock('/static/operator-stream.js?manual=1', () => ({initOperatorStream: vi.fn()}))
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
