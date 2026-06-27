/**
 * Canonical operator state copy mapping.
 *
 * Maps fixed operator states to human-readable, operator-safe display copy.
 *
 * Security invariants:
 * - Copy is FIXED and COARSE — no raw response body, URL, prompt, token,
 *   cookie, CSRF value, repo name, run ID, or stack trace in rendered text.
 * - No dynamic interpolation of sensitive values.
 * - Recovery hints are useful without revealing protected resource existence.
 * - Copy must NOT imply dashboard auth authorizes Gateway actions.
 */

import type {OperatorState} from './state.ts'

export interface OperatorStateCopy {
  readonly headline: string
  readonly detail: string
  readonly actionReason: string | null
  readonly recoveryHint: string
}

const COPY: Record<OperatorState, OperatorStateCopy> = {
  ready: {
    headline: 'Operator',
    detail: 'Connected to operator runtime.',
    actionReason: null,
    recoveryHint: '',
  },
  loading: {
    headline: 'Connecting…',
    detail: 'Establishing operator session.',
    actionReason: 'Actions are not available while connecting.',
    recoveryHint: 'Please wait while the session is established.',
  },
  'auth-required': {
    headline: 'Sign in required',
    detail: 'Your session has expired or is not established.',
    actionReason: 'Launch and approval actions are disabled until you sign in.',
    recoveryHint: 'Sign in to continue.',
  },
  'rate-limited': {
    headline: 'Too many requests',
    detail: 'The operator service is temporarily limiting requests.',
    actionReason: 'Actions are disabled while rate limited. Try again shortly.',
    recoveryHint: 'Wait a moment, then try again.',
  },
  offline: {
    headline: 'No connection',
    detail: 'Your device appears to be offline or the service is unreachable.',
    actionReason: 'Launch and approval actions are disabled while offline.',
    recoveryHint: 'Check your connection and try again when online.',
  },
  unavailable: {
    headline: 'Service unavailable',
    detail: 'The operator service encountered an error or returned an unexpected response.',
    actionReason: 'Actions are disabled while the service is unavailable.',
    recoveryHint: 'Try reconnecting. If the problem persists, reload the page.',
  },
}

export function getStateHeadline(state: OperatorState): string {
  return COPY[state].headline
}

export function getStateDetail(state: OperatorState): string {
  return COPY[state].detail
}

export function getStateActionReason(state: OperatorState): string | null {
  return COPY[state].actionReason
}

export function getStateRecoveryHint(state: OperatorState): string {
  return COPY[state].recoveryHint
}

export function getStateCopy(state: OperatorState): OperatorStateCopy {
  return COPY[state]
}
