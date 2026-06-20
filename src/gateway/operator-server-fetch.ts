/**
 * Server-side same-origin operator fetch adapter.
 *
 * Produces a fetch function matching `OperatorClientOptions.fetch` that:
 * - Resolves relative /operator/* paths against the configured trusted origin.
 * - Forwards the end user's inbound Cookie header verbatim, so the gateway
 *   validates the END USER's session — never the dashboard's own identity.
 * - Uses NO service-to-service credential — the only auth is the forwarded cookie.
 * - Rejects (throws) when no inbound cookie is present, so the operator client's
 *   fetchJson wrapper maps it to a GatewayNetworkError and the caller fails closed.
 * - Sets redirect:'error' so the forwarded cookie is never sent across a 3xx redirect.
 * - Applies a 10-second AbortSignal timeout so a hanging gateway maps to a network
 *   error → deny (fail-closed), never an indefinite hang.
 *
 * Security invariants:
 * - Never logs the cookie value — only the resolved path template is safe to log.
 * - No Authorization header or service credential is ever attached.
 * - Any caller-supplied Authorization header is stripped (confused-deputy defense).
 * - The forwarded cookie wins over any cookie in caller-supplied init.headers.
 * - redirect:'error' is always set and cannot be overridden by caller init.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Timeout for the gateway session fetch in milliseconds.
 * A hanging gateway maps to an AbortError → GatewayNetworkError → deny (fail-closed).
 */
export const GATEWAY_FETCH_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OperatorServerFetchOptions {
  /**
   * The configured trusted origin (e.g. 'https://dashboard.fro.bot').
   * Relative /operator/* paths are resolved against this origin.
   * SECURITY: must be a configured value, never derived from the inbound request Host.
   */
  readonly origin: string
  /**
   * The inbound Cookie header value from the end user's request.
   * If undefined or empty, the returned fetch throws on every call — there is
   * no end-user principal to forward.
   */
  readonly cookie: string | undefined
  /**
   * Injectable fetch implementation. Defaults to the global `fetch`.
   * Inject a fake in tests to avoid network calls.
   */
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a server-side fetch adapter that resolves relative /operator/* paths
 * against the configured trusted origin and forwards the end user's cookie.
 *
 * The returned function matches `OperatorClientOptions.fetch`:
 *   `(input: string, init?: RequestInit) => Promise<Response>`
 *
 * Throws when the inbound cookie is absent or blank — the operator client's
 * fetchJson wrapper maps a thrown fetch to a GatewayNetworkError, so the caller
 * fails closed.
 *
 * Always sets redirect:'error' (cookie must never be forwarded across a redirect)
 * and applies a 10-second AbortSignal timeout (hanging gateway → deny).
 */
export function createOperatorServerFetch(
  options: OperatorServerFetchOptions,
): (input: string, init?: RequestInit) => Promise<Response> {
  const {origin, cookie, fetchImpl = fetch} = options

  return async (input: string, init?: RequestInit): Promise<Response> => {
    // Reject immediately if there is no end-user cookie to forward.
    // Whitespace-only is treated as absent — no meaningful cookie value.
    if (cookie === undefined || cookie.trim() === '') {
      throw new Error('No inbound cookie to forward: an end-user session is required.')
    }

    // Resolve the relative path to an absolute same-origin URL.
    const absoluteUrl = new URL(input, origin).toString()

    // Normalize caller-supplied headers via new Headers() so that a real Headers
    // object is handled correctly (not silently dropped by a plain object cast).
    // Then strip any caller-supplied cookie or authorization header — the forwarded
    // end-user cookie is the only credential, and we must not forward a confused-deputy
    // Authorization header from the caller.
    const normalized = new Headers(init?.headers)
    normalized.delete('cookie')
    normalized.delete('authorization')
    // Set the forwarded end-user cookie — it always wins.
    normalized.set('cookie', cookie)

    // Convert to a plain Record for the outgoing init (avoids Headers object
    // incompatibility with some fetch implementations in tests).
    const mergedHeaders: Record<string, string> = {}
    normalized.forEach((value, key) => {
      mergedHeaders[key] = value
    })

    const mergedInit: RequestInit = {
      ...init,
      headers: mergedHeaders,
      // The forwarded cookie must never be sent across a 3xx redirect.
      // 'error' causes fetch to throw on any redirect response, which the
      // operator client maps to a GatewayNetworkError → deny (fail-closed).
      redirect: 'error',
      // Abort after GATEWAY_FETCH_TIMEOUT_MS to prevent indefinite hangs.
      // A hanging gateway maps to an AbortError → GatewayNetworkError → deny.
      signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
    }

    return fetchImpl(absoluteUrl, mergedInit)
  }
}
