/**
 * Deep-link return target.
 *
 * After a login redirect the browser should land back on the wiki page it asked
 * for. The target travels in a short-lived HttpOnly cookie. It is either the bare
 * `/wiki` list path or a `/wiki/<id>` path with a shape-valid page ID, and nothing
 * else, and it is re-validated on use. There is no `return` parameter and no other
 * accepted form.
 */

import type {Context} from 'hono'

import {deleteCookie, getCookie, setCookie} from 'hono/cookie'
import {parsePageId} from './paths.ts'

export const RETURN_COOKIE = 'wiki_return'
export const RETURN_COOKIE_MAX_AGE_SECONDS = 10 * 60

const WIKI_LIST = '/wiki'
const WIKI_PREFIX = '/wiki/'

/** The target when `value` is exactly `/wiki` or `/wiki/<id>` with a shape-valid ID; otherwise null. */
export function parseReturnTarget(value: unknown): string | null {
  if (value === WIKI_LIST) return value
  if (typeof value !== 'string' || !value.startsWith(WIKI_PREFIX)) return null
  return parsePageId(value.slice(WIKI_PREFIX.length)) === null ? null : value
}

/** The request path as a return target, or null when it is neither the wiki list nor a wiki page path. */
export function returnTargetForPath(pathname: string): string | null {
  return parseReturnTarget(pathname)
}

/** Remember a validated target. An invalid target sets nothing. */
export function setReturnCookie(c: Context, target: string, secure: boolean): void {
  if (parseReturnTarget(target) === null) return
  setCookie(c, RETURN_COOKIE, target, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    maxAge: RETURN_COOKIE_MAX_AGE_SECONDS,
    path: '/',
  })
}

/**
 * Read and clear the return cookie. Returns the validated target, or null when
 * there is no cookie or it holds anything else. A present cookie is always cleared.
 */
export function consumeReturnCookie(c: Context): string | null {
  const value = getCookie(c, RETURN_COOKIE)
  if (value === undefined) return null
  deleteCookie(c, RETURN_COOKIE, {path: '/'})
  return parseReturnTarget(value)
}
