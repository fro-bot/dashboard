/**
 * Canonical operator state classifier.
 *
 * Maps concrete response/network/stream signals to fixed operator states.
 * The classifier is PURE and PATH-UNAWARE: identical signals produce the same
 * state regardless of which operator API path triggered them.
 *
 * Security invariants:
 * - No raw response body, URL, prompt, token, cookie, CSRF value, repo name,
 *   run ID, or stack trace crosses into the returned state.
 * - Denied/malformed/unknown signals map to neutral `unavailable` — never
 *   reveal resource existence by treating the same status differently per path.
 * - Auth expiry (401/403) always maps to `auth-required` regardless of source
 *   (bootstrap, fetch, stream, or mutation).
 */

export type OperatorSignal =
  | {readonly kind: 'http-ok'; readonly status: number}
  | {readonly kind: 'http-error'; readonly status: number}
  | {readonly kind: 'redirect'}
  | {readonly kind: 'offline'}
  | {readonly kind: 'network-failure'}
  | {readonly kind: 'malformed-response'}
  | {readonly kind: 'contract-drift'}
  | {readonly kind: 'denied'}
  | {readonly kind: 'stream-drift'}
  | {readonly kind: 'unknown'}
  | {readonly kind: 'loading'}

export type OperatorState =
  | 'ready'
  | 'loading'
  | 'auth-required'
  | 'rate-limited'
  | 'offline'
  | 'unavailable'

/**
 * Classify a concrete signal into a fixed operator state.
 *
 * Path-unaware by design: cannot produce different states for the same signal
 * based on which operator API path triggered it, preventing the classifier from
 * becoming an oracle for protected resource existence.
 */
export function classifySignal(signal: OperatorSignal): OperatorState {
  switch (signal.kind) {
    case 'loading':
      return 'loading'

    case 'http-ok':
      return 'ready'

    case 'redirect':
      return 'auth-required'

    case 'http-error': {
      const {status} = signal
      if (status === 401 || status === 403) return 'auth-required'
      if (status === 429) return 'rate-limited'
      // 404 is neutral — do not reveal resource existence.
      return 'unavailable'
    }

    case 'offline':
    case 'network-failure':
      return 'offline'

    case 'malformed-response':
    case 'contract-drift':
    case 'denied':
    case 'stream-drift':
    case 'unknown':
      return 'unavailable'
  }
}

export function isActionDisabled(state: OperatorState): boolean {
  return state !== 'ready'
}
