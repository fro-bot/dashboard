/**
 * Server-side same-origin operator fetch adapter.
 *
 * Produces a fetch function matching `OperatorClientOptions.fetch` that:
 * - Resolves relative /operator/* paths against the inbound request origin.
 * - Forwards the end user's inbound Cookie header verbatim, so the gateway
 *   validates the END USER's session — never the dashboard's own identity.
 * - Uses NO service-to-service credential — the only auth is the forwarded cookie.
 * - Rejects (throws) when no inbound cookie is present, so the operator client's
 *   fetchJson wrapper maps it to a GatewayNetworkError and the caller fails closed.
 *
 * Security invariants:
 * - Never logs the cookie value — only the resolved path template is safe to log.
 * - No Authorization header or service credential is ever attached.
 * - The forwarded cookie wins over any cookie in caller-supplied init.headers.
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OperatorServerFetchOptions {
  /**
   * The inbound request's origin (e.g. 'https://dashboard.fro.bot').
   * Relative /operator/* paths are resolved against this origin.
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
 * against the inbound request origin and forwards the end user's cookie.
 *
 * The returned function matches `OperatorClientOptions.fetch`:
 *   `(input: string, init?: RequestInit) => Promise<Response>`
 *
 * Throws when the inbound cookie is absent or blank — the operator client's
 * fetchJson wrapper maps a thrown fetch to a GatewayNetworkError, so the caller
 * fails closed.
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

    // Merge caller-supplied headers with the forwarded cookie.
    // The forwarded cookie wins — spread caller headers first, then override cookie.
    const callerHeaders: Record<string, string> =
      init?.headers === undefined ? {} : (init.headers as Record<string, string>)

    const mergedHeaders: Record<string, string> = {
      ...callerHeaders,
      // The forwarded end-user cookie is the principal — it always wins.
      cookie,
    }

    const mergedInit: RequestInit = {
      ...init,
      headers: mergedHeaders,
    }

    return fetchImpl(absoluteUrl, mergedInit)
  }
}
