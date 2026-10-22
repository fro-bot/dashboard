import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  currentWikiPageId,
  currentWikiRoute,
  isPlainClick,
  isWikiPageId,
  leaveWikiPageUrl,
  leaveWikiUrl,
  onWikiPopState,
  parseWikiPagePath,
  pushWikiPage,
  seedWikiHistory,
  showWikiList,
  WIKI_LIST_URL,
  wikiPagePath,
  type WikiRoute,
} from './location.ts'

/** Wait for the next popstate the browser (jsdom) fires after a history traversal. */
function nextPopState(): Promise<void> {
  return new Promise(resolve => {
    window.addEventListener('popstate', () => resolve(), {once: true})
  })
}

async function traverse(delta: -1 | 1): Promise<void> {
  const popped = nextPopState()
  window.history.go(delta)
  await popped
}

beforeEach(() => {
  // Pushing drops any forward entries an earlier test left, so the current entry is the tip and
  // `history.length` comparisons mean what they say.
  window.history.pushState(null, '', '/')
})

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('page ID shape (mirrors the server rule)', () => {
  it.each([
    'repos.acme--alpha',
    'topics.beta-topic',
    'entities.gamma',
    'comparisons.a_b.c-d',
    'repos.a',
    'repos.A1',
  ])('accepts %s', id => {
    expect(isWikiPageId(id)).toBe(true)
  })

  it.each([
    '',
    'repos',
    'repos.',
    'other.page',
    'repos.-lead',
    'repos.trail-',
    'repos.trail.',
    'repos.a/b',
    'repos.a%2Fb',
    'repos.a b',
    'repos.a..b',
    'repos..a',
    'repos.a\u0000',
    'Repos.alpha',
    ` repos.alpha`,
    `repos.${'a'.repeat(200)}`,
  ])('rejects %j', id => {
    expect(isWikiPageId(id)).toBe(false)
  })

  it('accepts an ID of exactly 200 characters and rejects 201', () => {
    const prefix = 'repos.'
    expect(isWikiPageId(prefix + 'a'.repeat(200 - prefix.length))).toBe(true)
    expect(isWikiPageId(prefix + 'a'.repeat(201 - prefix.length))).toBe(false)
  })
})

describe('parseWikiPagePath', () => {
  it('returns the ID for exactly /wiki/<id>', () => {
    expect(parseWikiPagePath('/wiki/repos.acme--alpha')).toBe('repos.acme--alpha')
  })

  it.each([
    '/',
    '/wiki',
    '/wiki/',
    '/wiki/repos.alpha/',
    '/wiki/repos.alpha/extra',
    '/wiki/repos.a%2Fb',
    '/wiki/repos.%61lpha',
    '/wiki/nope',
    '/wiki/../repos.alpha',
    '/operator',
    '/Wiki/repos.alpha',
    'wiki/repos.alpha',
  ])('returns null for %s', pathname => {
    expect(parseWikiPagePath(pathname)).toBeNull()
  })
})

describe('wikiPagePath', () => {
  it('builds the deep-link path for a valid ID', () => {
    expect(wikiPagePath('topics.beta-topic')).toBe('/wiki/topics.beta-topic')
  })

  it('returns null for an invalid ID instead of building a path from it', () => {
    expect(wikiPagePath('../etc')).toBeNull()
    expect(wikiPagePath('repos.a/b')).toBeNull()
  })
})

describe('WIKI_LIST_URL', () => {
  it('is the bare /wiki path, which the server serves the shell for', () => {
    expect(WIKI_LIST_URL).toBe('/wiki')
  })
})

describe('currentWikiPageId', () => {
  it('reads the page ID from the load path', () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
    expect(currentWikiPageId()).toBe('repos.acme--alpha')
  })

  it('is null on the operator path, with or without the run hash, and on the list', () => {
    expect(currentWikiPageId()).toBeNull()
    window.history.replaceState(null, '', '/#run-1')
    expect(currentWikiPageId()).toBeNull()
    window.history.replaceState(null, '', '/wiki')
    expect(currentWikiPageId()).toBeNull()
  })
})

describe('currentWikiRoute', () => {
  it('is the list on /wiki', () => {
    window.history.replaceState(null, '', '/wiki')
    expect(currentWikiRoute()).toEqual({kind: 'list'})
  })

  it('is the list on /wiki with a hash or a query, because the path is what the server serves', () => {
    window.history.replaceState(null, '', '/wiki#top')
    expect(currentWikiRoute()).toEqual({kind: 'list'})
    window.history.replaceState(null, '', '/wiki?x=1')
    expect(currentWikiRoute()).toEqual({kind: 'list'})
  })

  it('is the page on /wiki/<id>', () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
    expect(currentWikiRoute()).toEqual({kind: 'page', id: 'repos.acme--alpha'})
  })

  it.each(['/', '/#run-1', '/wiki/', '/wikis', '/wiki/not-a-page', '/wiki/repos.a/b', '/operator'])(
    'is other on %s',
    url => {
      window.history.replaceState(null, '', url)
      expect(currentWikiRoute()).toEqual({kind: 'other'})
    },
  )
})

describe('seedWikiHistory', () => {
  it('puts the list URL under the page entry so Back returns to the list', async () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
    const lengthBefore = window.history.length

    seedWikiHistory()

    expect(window.location.pathname).toBe('/wiki/repos.acme--alpha')
    expect(window.history.length).toBe(lengthBefore + 1)

    await traverse(-1)
    expect(window.location.pathname).toBe('/wiki')
    expect(currentWikiRoute()).toEqual({kind: 'list'})

    await traverse(1)
    expect(currentWikiPageId()).toBe('repos.acme--alpha')
  })

  it('does not grow the stack when it runs again for the same entry (StrictMode, reload)', () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')

    seedWikiHistory()
    const lengthAfterFirst = window.history.length
    seedWikiHistory()
    seedWikiHistory()

    expect(window.history.length).toBe(lengthAfterFirst)
    expect(currentWikiPageId()).toBe('repos.acme--alpha')
  })

  it('does nothing away from a wiki page path, the list included', () => {
    const lengthBefore = window.history.length
    seedWikiHistory()
    window.history.replaceState(null, '', '/wiki')
    seedWikiHistory()
    expect(window.history.length).toBe(lengthBefore)
    expect(window.location.pathname).toBe('/wiki')
  })
})

describe('pushWikiPage', () => {
  it('writes a history entry at /wiki/<id>', () => {
    const lengthBefore = window.history.length
    expect(pushWikiPage('repos.acme--alpha')).toBe(true)
    expect(window.location.pathname).toBe('/wiki/repos.acme--alpha')
    expect(window.history.length).toBe(lengthBefore + 1)
  })

  it('refuses an ID that fails the shape check and writes nothing', () => {
    const lengthBefore = window.history.length
    expect(pushWikiPage('../../etc/passwd')).toBe(false)
    expect(window.history.length).toBe(lengthBefore)
    expect(window.location.pathname).toBe('/')
  })

  it('Back after a push returns to the entry the push left', async () => {
    window.history.replaceState(null, '', '/wiki')
    pushWikiPage('repos.acme--alpha')
    await traverse(-1)
    expect(window.location.pathname).toBe('/wiki')
  })
})

describe('leaveWikiPageUrl', () => {
  it('replace swaps the page entry for the list URL without adding one', () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
    const lengthBefore = window.history.length

    leaveWikiPageUrl('replace')

    expect(window.location.pathname).toBe('/wiki')
    expect(window.history.length).toBe(lengthBefore)
  })

  it('push adds a list entry after the page entry', async () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')
    const lengthBefore = window.history.length

    leaveWikiPageUrl('push')

    expect(window.location.pathname).toBe('/wiki')
    expect(window.history.length).toBe(lengthBefore + 1)
    await traverse(-1)
    expect(currentWikiPageId()).toBe('repos.acme--alpha')
  })

  it('leaves the URL alone when it is not a wiki page path (the operator hash survives)', () => {
    window.history.replaceState(null, '', '/#run-keep')
    const lengthBefore = window.history.length

    leaveWikiPageUrl('replace')
    leaveWikiPageUrl('push')

    expect(window.location.hash).toBe('#run-keep')
    expect(window.history.length).toBe(lengthBefore)
  })
})

describe('showWikiList', () => {
  it('pushes /wiki from a non-wiki URL', async () => {
    const lengthBefore = window.history.length

    showWikiList()

    expect(window.location.pathname).toBe('/wiki')
    expect(window.history.length).toBe(lengthBefore + 1)
    await traverse(-1)
    expect(window.location.pathname).toBe('/')
  })

  it('pushes /wiki from a page, so Back returns to the page', async () => {
    window.history.replaceState(null, '', '/wiki/repos.acme--alpha')

    showWikiList()

    expect(window.location.pathname).toBe('/wiki')
    await traverse(-1)
    expect(currentWikiPageId()).toBe('repos.acme--alpha')
  })

  it('writes nothing when the list is already showing', () => {
    window.history.replaceState(null, '', '/wiki')
    const lengthBefore = window.history.length
    showWikiList()
    expect(window.history.length).toBe(lengthBefore)
  })
})

describe('leaveWikiUrl', () => {
  it('goes back to the URL the operator view had, run hash included', () => {
    window.history.replaceState(null, '', '/#run-keep-me')
    showWikiList()

    leaveWikiUrl()

    expect(window.location.pathname).toBe('/')
    expect(window.location.hash).toBe('#run-keep-me')
  })

  it('also leaves from a page', () => {
    window.history.replaceState(null, '', '/#run-keep-me')
    showWikiList()
    pushWikiPage('repos.acme--alpha')

    leaveWikiUrl()

    expect(window.location.pathname).toBe('/')
    expect(window.location.hash).toBe('#run-keep-me')
  })

  it('adds an entry, so Back returns to the wiki', async () => {
    showWikiList()
    leaveWikiUrl()
    await traverse(-1)
    expect(currentWikiRoute()).toEqual({kind: 'list'})
  })

  it('writes nothing when the URL is not a wiki URL', () => {
    window.history.replaceState(null, '', '/#run-keep')
    const lengthBefore = window.history.length
    leaveWikiUrl()
    expect(window.history.length).toBe(lengthBefore)
    expect(window.location.hash).toBe('#run-keep')
  })

  it('falls back to / when the wiki was loaded directly and there is no URL to return to', async () => {
    vi.resetModules()
    const fresh = await import('./location.ts')
    window.history.replaceState(null, '', '/wiki')

    fresh.leaveWikiUrl()

    expect(window.location.pathname).toBe('/')
    expect(window.location.hash).toBe('')
  })
})

describe('onWikiPopState', () => {
  it('reports the page, the list and other entries as routes', async () => {
    window.history.replaceState(null, '', '/wiki')
    const seen: WikiRoute[] = []
    const stop = onWikiPopState(route => seen.push(route))

    pushWikiPage('repos.acme--alpha')
    await traverse(-1)
    await traverse(1)
    window.history.pushState(null, '', '/')
    await traverse(-1)

    stop()
    expect(seen).toEqual([{kind: 'list'}, {kind: 'page', id: 'repos.acme--alpha'}, {kind: 'page', id: 'repos.acme--alpha'}])
  })

  it('stops listening once the returned function runs', async () => {
    const seen: WikiRoute[] = []
    const stop = onWikiPopState(route => seen.push(route))
    stop()

    window.history.replaceState(null, '', '/wiki')
    pushWikiPage('repos.acme--alpha')
    await traverse(-1)

    expect(seen).toEqual([])
  })

  it('registers exactly one popstate listener and no hashchange listener', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const stop = onWikiPopState(() => {})
    stop()
    expect(add.mock.calls.map(([type]) => type)).toEqual(['popstate'])
  })
})

describe('isPlainClick', () => {
  const click = (init: MouseEventInit) => new MouseEvent('click', {button: 0, ...init})

  it('is true for an unmodified left click', () => {
    expect(isPlainClick(click({}))).toBe(true)
  })

  it.each([{ctrlKey: true}, {metaKey: true}, {shiftKey: true}, {altKey: true}, {button: 1}, {button: 2}])(
    'is false for %j, which the browser handles',
    init => {
      expect(isPlainClick(click(init))).toBe(false)
    },
  )
})
