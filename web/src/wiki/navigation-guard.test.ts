import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  confirmLeaveWiki,
  guardedWikiPageId,
  registerNavigationGuard,
  restoreGuardedPage,
} from './navigation-guard.ts'

const PAGE = 'repos.acme--alpha'

let stops: (() => void)[] = []

function guard(message = 'Leave?') {
  const stop = registerNavigationGuard({pageId: PAGE, message})
  stops.push(stop)
  return stop
}

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('registerNavigationGuard', () => {
  it('with no guard, leaving needs no confirmation', () => {
    const confirm = vi.spyOn(window, 'confirm')
    expect(confirmLeaveWiki(null)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(guardedWikiPageId()).toBeNull()
  })

  it('asks before leaving, with the guard message, and obeys the answer', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    guard('You have unsaved changes.')

    expect(confirmLeaveWiki(null)).toBe(false)
    expect(confirm).toHaveBeenCalledWith('You have unsaved changes.')
    expect(confirmLeaveWiki(null)).toBe(true)
  })

  it('asks before beforeunload tears the page down (reload, close)', () => {
    guard()
    const event = new Event('beforeunload', {cancelable: true})
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not hold beforeunload once released', () => {
    const stop = guard()
    stop()
    const event = new Event('beforeunload', {cancelable: true})
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(guardedWikiPageId()).toBeNull()
  })

  it('releasing twice is harmless', () => {
    const stop = guard()
    stop()
    expect(() => {
      stop()
    }).not.toThrow()
  })

  it('a later guard replaces the earlier one, and the earlier release does not drop it', () => {
    const first = guard('first')
    const second = registerNavigationGuard({pageId: 'topics.beta', message: 'second'})
    stops.push(second)

    first()
    expect(guardedWikiPageId()).toBe('topics.beta')

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    confirmLeaveWiki(null)
    expect(confirm).toHaveBeenCalledWith('second')
  })

  it('a move to the guarded page itself does not ask (a hash change, a same-page popstate)', () => {
    const confirm = vi.spyOn(window, 'confirm')
    guard()
    expect(confirmLeaveWiki({kind: 'page', id: PAGE})).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it.each([
    ['another page', {kind: 'page', id: 'topics.beta'}],
    ['the list', {kind: 'list'}],
    ['a non-wiki entry', {kind: 'other'}],
  ] as const)('a move to %s asks', (_label, route) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    guard()
    expect(confirmLeaveWiki(route)).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})

describe('restoreGuardedPage', () => {
  it('puts the guarded page URL back after a refused popstate', () => {
    guard()
    window.history.replaceState(null, '', '/wiki')

    restoreGuardedPage()

    expect(window.location.pathname).toBe(`/wiki/${PAGE}`)
  })

  it('does nothing without a guard', () => {
    window.history.replaceState(null, '', '/wiki')
    restoreGuardedPage()
    expect(window.location.pathname).toBe('/wiki')
  })
})
