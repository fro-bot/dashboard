/**
 * Web-local copy of the dynamic ID validator.
 *
 * This is a pure validator with no server dependencies. It is duplicated here
 * (rather than imported from `src/gateway/operator-client.ts`) because `web/`
 * is the browser SPA bundle and must never import from `src/` (the server) —
 * the Docker builder stage only copies `web/` into the image, so a `src/`
 * import fails to resolve at build time. Keep this in sync with the server
 * copy in `src/gateway/operator-client.ts` if the validation rules change.
 */
export function validateDynamicId(id: string): boolean {
  if (id.trim() === '') return false
  if (id.includes('/') || id.includes('\\')) return false
  if (/%(?:2f|5c)/i.test(id)) return false
  // eslint-disable-next-line no-control-regex -- intentional control-char rejection
  if (/[\u0000-\u001F]/.test(id)) return false
  if (/%(?:00|0d|0a)/i.test(id)) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(id)
  } catch {
    return false
  }
  if (decoded === '.' || decoded === '..') return false
  const segments = decoded.split(/[/\\]/)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return false
  }
  return true
}
