/**
 * Lost-session recovery for the wiki views.
 *
 * When any wiki call reports a lost session, the client navigates once to `/auth/login`.
 * The target travels as `next=/wiki/<id>` for a page and `next=/wiki` for the list; the
 * server accepts exactly those two forms (`src/wiki/return-target.ts`, `parseReturnTarget`)
 * and nothing else.
 *
 * The loop guard follows `operator/sign-in-recovery.ts`: a tab-scoped presence flag, set
 * before the navigation. A second signal in the same tab does not navigate again. Only a
 * successful wiki call clears the flag, so a tab that comes back signed in can recover again
 * later, and a tab that keeps coming back signed out shows the manual sign-in link instead of
 * bouncing.
 */

import {WIKI_LIST_URL, wikiPagePath} from './location.ts'

export const WIKI_SIGN_IN_PATH = '/auth/login'
const GUARD_KEY = 'fro-bot.wiki-sign-in-redirect'

/**
 * The login URL for a lost session on `pageId`, or on the list when `pageId` is null. An ID
 * that fails the shape check is never encoded into `next`; the list is the target then.
 */
export function wikiSignInUrl(pageId: string | null): string {
  const target = (pageId === null ? null : wikiPagePath(pageId)) ?? WIKI_LIST_URL
  return `${WIKI_SIGN_IN_PATH}?next=${encodeURIComponent(target)}`
}

/**
 * Navigate to login once per tab. Returns true when it navigated, false when the guard (or
 * unusable storage) held it back; the caller then offers `wikiSignInUrl` as a link.
 */
export function navigateToWikiSignIn(
  pageId: string | null,
  assign: (url: string) => void = url => {
    globalThis.location.assign(url)
  },
): boolean {
  try {
    if (sessionStorage.getItem(GUARD_KEY) !== null) return false
    sessionStorage.setItem(GUARD_KEY, '1')
  } catch {
    // Without a reliable tab-scoped loop guard, leave the manual sign-in link.
    return false
  }
  assign(wikiSignInUrl(pageId))
  return true
}

/** Call after a wiki request succeeds: the session works again. */
export function clearWikiSignInGuard(): void {
  try {
    sessionStorage.removeItem(GUARD_KEY)
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
