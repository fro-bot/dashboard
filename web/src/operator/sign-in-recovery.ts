import type {OperatorState} from './state.ts'

export const GATEWAY_SIGN_IN_URL = '/operator/auth/github/start?return_to=/operator'
const SIGN_IN_REDIRECT_GUARD_KEY = 'fro-bot.operator-sign-in-redirect'
const SIGN_IN_REDIRECT_GUARD_MS = 60_000

export function navigateToGatewaySignIn(assign: (url: string) => void = url => globalThis.location.assign(url)): void {
  assign(GATEWAY_SIGN_IN_URL)
}

export function maybeAutoRedirectToGatewaySignIn(
  state: OperatorState,
  navigate: () => void = navigateToGatewaySignIn,
): void {
  if (state !== 'auth-required') return

  try {
    const now = Date.now()
    const previousRedirect = Number(sessionStorage.getItem(SIGN_IN_REDIRECT_GUARD_KEY))
    if (Number.isFinite(previousRedirect) && previousRedirect > 0 && now - previousRedirect < SIGN_IN_REDIRECT_GUARD_MS) return

    sessionStorage.setItem(SIGN_IN_REDIRECT_GUARD_KEY, String(now))
    navigate()
  } catch {
    // Without a reliable tab-scoped loop guard, leave the manual sign-in action available.
  }
}

export function clearGatewaySignInRedirectGuard(): void {
  try {
    sessionStorage.removeItem(SIGN_IN_REDIRECT_GUARD_KEY)
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
