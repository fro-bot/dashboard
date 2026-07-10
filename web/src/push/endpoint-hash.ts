/**
 * Client-side join key correlating a local `PushSubscription.endpoint` to
 * the Gateway's `endpointHash` subscription metadata. The Gateway keys
 * records as `sha256(endpoint)`; this computes the same canonical
 * lowercase-hex SHA-256 digest of the exact endpoint string.
 *
 * The endpoint is a bearer-capability URL and is treated as secret: this
 * function must NEVER log or render the endpoint or the resulting hash.
 */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}
