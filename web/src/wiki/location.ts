/**
 * Wiki location: the `/wiki/<id>` deep link, without a router.
 *
 * `App.tsx` holds the current view in state. This module is the one place that reads or
 * writes the URL for the wiki view:
 *
 *   - It parses `/wiki/<id>` at load. The ID shape mirrors the server's check
 *     (`src/wiki/paths.ts`, `parsePageId`); the client cannot import from `src/`.
 *     The server serves the SPA shell only for a shape-valid one-segment ID, and a path
 *     that fails the check here is not a wiki page.
 *   - The page list lives at `/wiki`, which the server serves the shell for, so a reload on
 *     the list opens the list.
 *   - It pushes a history entry when the wiki or a page opens, and when the wiki is left, and
 *     listens for `popstate`.
 *
 * It never reads or writes `location.hash` itself and nothing here listens for `hashchange`:
 * the operator view owns the hash (the expanded run). Leaving the wiki restores the URL the
 * operator view had when the wiki opened, hash included.
 */

/** Where the list lives. A deep link's Back entry and "back to the list" both land here. */
export const WIKI_LIST_URL = '/wiki'

const WIKI_PREFIX = '/wiki/'
const MAX_PAGE_ID_LENGTH = 200
const PAGE_ID = /^(?:repos|topics|entities|comparisons)\.[A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?$/u

/** Marks a history entry this module created or already seeded, so seeding runs once per entry. */
const ENTRY_MARKER = 'fro-bot-wiki-page'

type Host = Pick<Window, 'addEventListener' | 'history' | 'location' | 'removeEventListener'>

function host(): Host {
  return globalThis.window
}

/** The same rule as the server: `<dir>.<name>`, one segment, no dot segment, 200 characters at most. */
export function isWikiPageId(id: string): boolean {
  return id.length <= MAX_PAGE_ID_LENGTH && !id.includes('..') && PAGE_ID.test(id)
}

/** The page ID when `pathname` is exactly `/wiki/<id>` with a shape-valid ID; otherwise null. */
export function parseWikiPagePath(pathname: string): string | null {
  if (!pathname.startsWith(WIKI_PREFIX)) return null
  const id = pathname.slice(WIKI_PREFIX.length)
  return isWikiPageId(id) ? id : null
}

/** The deep-link path for a page, or null when the ID fails the shape check. */
export function wikiPagePath(id: string): string | null {
  return isWikiPageId(id) ? `${WIKI_PREFIX}${id}` : null
}

export function currentWikiPageId(win: Host = host()): string | null {
  return parseWikiPagePath(win.location.pathname)
}

/** Where the URL points: a wiki page, the wiki list, or anything else (the operator view and its hash). */
export type WikiRoute = {readonly kind: 'page'; readonly id: string} | {readonly kind: 'list'} | {readonly kind: 'other'}

export function currentWikiRoute(win: Host = host()): WikiRoute {
  const {pathname} = win.location
  if (pathname === WIKI_LIST_URL) return {kind: 'list'}
  const id = parseWikiPagePath(pathname)
  return id === null ? {kind: 'other'} : {kind: 'page', id}
}

/** The URL the operator view had when the wiki opened. Leaving the wiki returns to it. */
let returnUrl = '/'

function isMarked(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[ENTRY_MARKER] === true
}

/**
 * Loaded straight onto `/wiki/<id>`, the history has no entry for the list. Put the list
 * entry under the page entry so Back returns to the list. Safe to run twice (StrictMode) and
 * on reload: the page entry is marked, and a marked entry is left alone.
 */
export function seedWikiHistory(win: Host = host()): void {
  const path = win.location.pathname
  if (parseWikiPagePath(path) === null || isMarked(win.history.state)) return
  win.history.replaceState(null, '', WIKI_LIST_URL)
  win.history.pushState({[ENTRY_MARKER]: true}, '', path)
}

/** Open a page: write a history entry at its deep link. False, and no write, for an ID that fails the shape check. */
export function pushWikiPage(id: string, win: Host = host()): boolean {
  const path = wikiPagePath(id)
  if (path === null) return false
  win.history.pushState({[ENTRY_MARKER]: true}, '', path)
  return true
}

/**
 * Move from a page path to the list. `push` adds a list entry after the page (Back returns to
 * the page); `replace` swaps the page entry out. Any other URL is left alone.
 */
export function leaveWikiPageUrl(mode: 'push' | 'replace', win: Host = host()): void {
  if (currentWikiPageId(win) === null) return
  if (mode === 'push') win.history.pushState(null, '', WIKI_LIST_URL)
  else win.history.replaceState(null, '', WIKI_LIST_URL)
}

/**
 * Show the list: push `/wiki` from a page or from any non-wiki URL, which is remembered so
 * `leaveWikiUrl` can restore it. Writes nothing when the list is already showing.
 */
export function showWikiList(win: Host = host()): void {
  const route = currentWikiRoute(win)
  if (route.kind === 'list') return
  if (route.kind === 'other') {
    const {pathname, search, hash} = win.location
    returnUrl = `${pathname}${search}${hash}`
  }
  win.history.pushState(null, '', WIKI_LIST_URL)
}

/**
 * Leave the wiki for another view: push the URL the operator view had when the wiki opened
 * (`/` when the wiki was loaded directly), so Back returns to the wiki. Writes nothing when
 * the URL is not a wiki URL.
 */
export function leaveWikiUrl(win: Host = host()): void {
  if (currentWikiRoute(win).kind === 'other') return
  win.history.pushState(null, '', returnUrl)
}

/** A plain left click is handled in the app. Anything else is the browser's: new tab, new window, save. */
export function isPlainClick(event: Pick<MouseEvent, 'altKey' | 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/**
 * Report where Back and Forward landed: a page, the list, or any other entry. The caller
 * decides what `other` means for the view it is showing. Returns the stop function.
 */
export function onWikiPopState(handler: (route: WikiRoute) => void, win: Host = host()): () => void {
  const listener = (): void => {
    handler(currentWikiRoute(win))
  }
  win.addEventListener('popstate', listener)
  return () => {
    win.removeEventListener('popstate', listener)
  }
}
