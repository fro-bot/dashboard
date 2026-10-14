/**
 * Serving for the un-hashed `/static/*` files: `serveStatic` plus revalidation.
 *
 * Every successful response is `Cache-Control: no-cache`, and carries a strong ETag (a hash of the
 * file's content) so a matching `If-None-Match` is answered with a bodyless 304. `serveStatic`
 * resolves the file; this module only reads the path it resolved, so nothing new can be reached.
 */
import type {MiddlewareHandler} from 'hono'

import {createHash} from 'node:crypto'
import {readFile, stat} from 'node:fs/promises'
import {serveStatic} from '@hono/node-server/serve-static'

interface CachedEtag {
  readonly mtimeMs: number
  readonly size: number
  readonly etag: string
}

/** True when an `If-None-Match` header matches `etag` (weak comparison, a list, or `*`). */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false
  return header.split(',').some(candidate => {
    const value = candidate.trim()
    return value === '*' || value.replace(/^W\//, '') === etag
  })
}

export function createPublicStatic(root: string): {serve: MiddlewareHandler; revalidate: MiddlewareHandler} {
  // The file serveStatic resolved for a request, keyed by the request object.
  const resolved = new WeakMap<Request, string>()
  // Per path; rehashed only when mtime or size changes, so a changed file always gets a new ETag.
  const etags = new Map<string, CachedEtag>()

  async function etagFor(path: string): Promise<string> {
    const stats = await stat(path)
    const cached = etags.get(path)
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.etag
    const etag = `"${createHash('sha256').update(await readFile(path)).digest('base64url')}"`
    etags.set(path, {mtimeMs: stats.mtimeMs, size: stats.size, etag})
    return etag
  }

  const serve = serveStatic({
    root,
    rewriteRequestPath: path => path.replace(/^\/static/, ''),
    onFound: (path, c) => {
      resolved.set(c.req.raw, path)
    },
  })

  const revalidate: MiddlewareHandler = async (c, next) => {
    await next()
    // 404s and auth responses pass through exactly as they were.
    if (!c.res.ok) return
    c.res.headers.set('cache-control', 'no-cache')

    const path = resolved.get(c.req.raw)
    if (path === undefined || c.res.status !== 200) return
    let etag: string
    try {
      etag = await etagFor(path)
    } catch {
      return
    }
    c.res.headers.set('etag', etag)
    if (!ifNoneMatchHits(c.req.header('if-none-match'), etag)) return

    // Drop the file stream serveStatic opened, then answer with the validators and no body.
    await c.res.body?.cancel().catch(() => {})
    c.res = new Response(null, {status: 304})
    c.res.headers.delete('content-length')
  }

  return {serve, revalidate}
}
