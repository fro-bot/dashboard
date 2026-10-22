/**
 * Navigation guard for unsaved wiki edits.
 *
 * The editor registers a guard while it holds work that is not saved to the wiki: edits, a
 * save in flight, or a save whose outcome is unknown. The guard covers:
 *   - `beforeunload` (reload, close, leaving the site), through the browser's own prompt;
 *   - in-app navigation, which `App` runs through `confirmLeaveWiki` (the view switch, opening
 *     a page, and the list link all pass through `showView` and `openWikiPage`);
 *   - the browser's Back and Forward, which have already moved the URL by the time the
 *     `popstate` handler runs, so a refused move is undone with `restoreGuardedPage`.
 *
 * There is one guard at a time. A later registration replaces the earlier one, and the
 * earlier release then does nothing.
 */

import type {WikiRoute} from './location.ts'

import {pushWikiPage} from './location.ts'

interface Guard {
  readonly pageId: string
  readonly message: string
}

let active: Guard | null = null

function onBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault()
  // Older browsers need a return value to show the prompt.
  event.returnValue = ''
}

/** Hold navigation for `pageId` until the returned function is called. */
export function registerNavigationGuard(guard: Guard): () => void {
  const mine: Guard = {...guard}
  if (active === null) window.addEventListener('beforeunload', onBeforeUnload)
  active = mine

  return () => {
    if (active !== mine) return
    active = null
    window.removeEventListener('beforeunload', onBeforeUnload)
  }
}

/** The page the active guard protects, or null. */
export function guardedWikiPageId(): string | null {
  return active?.pageId ?? null
}

/**
 * True when navigation may go ahead: there is no guard, the move stays on the guarded page,
 * or the operator confirms. `destination` is null for an in-app move that is not a route
 * (a view switch).
 */
export function confirmLeaveWiki(destination: WikiRoute | null): boolean {
  if (active === null) return true
  if (destination?.kind === 'page' && destination.id === active.pageId) return true
  return window.confirm(active.message)
}

/** Put the guarded page's URL back after a refused Back or Forward. */
export function restoreGuardedPage(): void {
  if (active !== null) pushWikiPage(active.pageId)
}
