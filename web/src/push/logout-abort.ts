/**
 * Shared logout-abort signal for in-flight push operations.
 *
 * `AppShell`'s `handleLogout` triggers this abort before issuing the logout
 * POST so an in-flight `subscribeOptIn`/`resubscribeStaleKey` call (started
 * from the Notifications consent surface) discards its result and never
 * issues a dangling Gateway POST after the operator has logged out.
 *
 * Web-local — no import from `src/`.
 */

let controller = new AbortController()

/** Current logout-abort signal. Pass this as `SubscribeDeps.signal`. */
export function getLogoutAbortSignal(): AbortSignal {
  return controller.signal
}

/**
 * Abort any push operation currently watching the shared signal, then swap
 * in a fresh controller so a subsequent session doesn't start pre-aborted.
 */
export function triggerLogoutAbort(): void {
  controller.abort()
  controller = new AbortController()
}
