import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  clearWikiSignInGuard,
  navigateToWikiSignIn,
  WIKI_SIGN_IN_PATH,
  wikiSignInUrl,
} from './session-recovery.ts'

const GUARD_KEY = 'fro-bot.wiki-sign-in-redirect'

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('wikiSignInUrl', () => {
  it('encodes the deep-link target in next', () => {
    expect(wikiSignInUrl('repos.acme--alpha')).toBe(`${WIKI_SIGN_IN_PATH}?next=%2Fwiki%2Frepos.acme--alpha`)
  })

  it('sends next=/wiki for the list, which the server accepts as a return target', () => {
    expect(wikiSignInUrl(null)).toBe(`${WIKI_SIGN_IN_PATH}?next=%2Fwiki`)
    expect(WIKI_SIGN_IN_PATH).toBe('/auth/login')
  })

  it('falls back to the list target for an ID that fails the shape check rather than encoding it', () => {
    expect(wikiSignInUrl('../../etc/passwd')).toBe(`${WIKI_SIGN_IN_PATH}?next=%2Fwiki`)
    expect(wikiSignInUrl('repos.a/b')).toBe(`${WIKI_SIGN_IN_PATH}?next=%2Fwiki`)
  })
})

describe('navigateToWikiSignIn', () => {
  it('navigates once to login with the target encoded', () => {
    const assign = vi.fn()

    expect(navigateToWikiSignIn('topics.beta-topic', assign)).toBe(true)

    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/auth/login?next=%2Fwiki%2Ftopics.beta-topic')
  })

  it('a second lost-session signal does not navigate again', () => {
    const assign = vi.fn()

    expect(navigateToWikiSignIn('topics.beta-topic', assign)).toBe(true)
    expect(navigateToWikiSignIn('topics.beta-topic', assign)).toBe(false)
    expect(navigateToWikiSignIn(null, assign)).toBe(false)

    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('sets the guard before navigating', () => {
    const assign = vi.fn(() => {
      expect(sessionStorage.getItem(GUARD_KEY)).not.toBeNull()
    })
    navigateToWikiSignIn(null, assign)
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('navigates again after a successful call cleared the guard', () => {
    const assign = vi.fn()
    navigateToWikiSignIn(null, assign)

    clearWikiSignInGuard()
    expect(navigateToWikiSignIn(null, assign)).toBe(true)

    expect(assign).toHaveBeenCalledTimes(2)
  })

  it('does not navigate when tab storage is unusable, because a loop could not be stopped', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const assign = vi.fn()

    expect(navigateToWikiSignIn(null, assign)).toBe(false)
    expect(assign).not.toHaveBeenCalled()
  })

  it('clearWikiSignInGuard survives unusable storage', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(() => clearWikiSignInGuard()).not.toThrow()
  })
})
