import {Hono} from 'hono'
import {describe, expect, it} from 'vitest'
import {
  consumeReturnCookie,
  parseReturnTarget,
  RETURN_COOKIE,
  RETURN_COOKIE_MAX_AGE_SECONDS,
  returnTargetForPath,
  setReturnCookie,
} from '../src/wiki/return-target.ts'

describe('parseReturnTarget', () => {
  it.each([
    '/wiki/repos.marcusrbrown--infra',
    '/wiki/topics.docker-containers',
    '/wiki/entities.node.js',
    '/wiki/comparisons.a-vs-b',
  ])('accepts %s', target => {
    expect(parseReturnTarget(target)).toBe(target)
  })

  it.each([
    ['an absolute URL', 'https://evil.example/wiki/repos.a'],
    ['a protocol-relative URL', '//evil.example/wiki/repos.a'],
    ['the root', '/'],
    ['the operator path', '/operator'],
    ['the wiki index', '/wiki/'],
    ['the bare wiki path', '/wiki'],
    ['a nested path', '/wiki/repos.a/b'],
    ['a trailing slash', '/wiki/repos.a/'],
    ['a query string', '/wiki/repos.a?x=1'],
    ['a fragment', '/wiki/repos.a#top'],
    ['an encoded slash', '/wiki/repos.a%2Fb'],
    ['an encoded dot', '/wiki/repos.%2e%2e'],
    ['traversal', '/wiki/repos..'],
    ['traversal in the path', '/wiki/../auth/login'],
    ['a backslash', String.raw`/wiki/repos.a\b`],
    ['an unknown page type', '/wiki/secrets.alpha'],
    ['an empty name', '/wiki/repos.'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a control character', '/wiki/repos.a\n'],
    ['whitespace', '/wiki/repos.a '],
    ['a leading space', ' /wiki/repos.a'],
    ['an overlong ID', `/wiki/repos.${'a'.repeat(300)}`],
    ['a relative path', 'wiki/repos.a'],
    ['an auth path', '/auth/login'],
    ['an api path', '/api/wiki/pages'],
  ])('drops %s', (_label, value) => {
    expect(parseReturnTarget(value)).toBeNull()
  })

  it.each([undefined, null, 5, {}, [], true])('drops a non-string value %j', value => {
    expect(parseReturnTarget(value)).toBeNull()
  })
})

describe('returnTargetForPath', () => {
  it('returns the path when it is a wiki page path', () => {
    expect(returnTargetForPath('/wiki/repos.acme--alpha')).toBe('/wiki/repos.acme--alpha')
  })

  it.each(['/', '/wiki', '/wiki/', '/wiki/a/b', '/api/wiki/pages', '/operator'])('returns null for %s', path => {
    expect(returnTargetForPath(path)).toBeNull()
  })
})

function appFor(secure: boolean) {
  const app = new Hono()
  app.get('/set', c => {
    setReturnCookie(c, '/wiki/repos.acme--alpha', secure)
    return c.text('ok')
  })
  app.get('/consume', c => c.json({target: consumeReturnCookie(c)}))
  return app
}

describe('return cookie', () => {
  it('sets an HttpOnly, SameSite=Lax, short-lived cookie holding only the target', async () => {
    const res = await appFor(true).request('/set')
    const cookie = res.headers.get('set-cookie') ?? ''

    expect(cookie).toContain(`${RETURN_COOKIE}=`)
    expect(cookie).toContain(encodeURIComponent('/wiki/repos.acme--alpha'))
    expect(cookie).toMatch(/HttpOnly/iu)
    expect(cookie).toMatch(/SameSite=Lax/iu)
    expect(cookie).toMatch(/Path=\//iu)
    expect(cookie).toContain(`Max-Age=${RETURN_COOKIE_MAX_AGE_SECONDS}`)
    expect(RETURN_COOKIE_MAX_AGE_SECONDS).toBeLessThanOrEqual(15 * 60)
    expect(RETURN_COOKIE_MAX_AGE_SECONDS).toBeGreaterThan(0)
  })

  it('is Secure by default and not Secure in loopback development', async () => {
    const secure = (await appFor(true).request('/set')).headers.get('set-cookie') ?? ''
    const dev = (await appFor(false).request('/set')).headers.get('set-cookie') ?? ''

    expect(secure).toMatch(/Secure/iu)
    expect(dev).not.toMatch(/Secure/iu)
  })

  it('consumes a valid cookie once: returns the target and clears the cookie', async () => {
    const res = await appFor(true).request('/consume', {
      headers: {cookie: `${RETURN_COOKIE}=${encodeURIComponent('/wiki/repos.acme--alpha')}`},
    })

    expect(await res.json()).toEqual({target: '/wiki/repos.acme--alpha'})
    const cleared = res.headers.get('set-cookie') ?? ''
    expect(cleared).toContain(`${RETURN_COOKIE}=`)
    expect(cleared).toMatch(/Max-Age=0/iu)
  })

  it('returns null and sends no cookie header when there is no cookie', async () => {
    const res = await appFor(true).request('/consume')

    expect(await res.json()).toEqual({target: null})
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it.each([
    ['an absolute URL', 'https://evil.example/'],
    ['the root', '/'],
    ['a nested path', '/wiki/repos.a/b'],
    ['garbage', '%E0%A4%A'],
  ])('clears a tampered cookie holding %s and returns null', async (_label, value) => {
    const res = await appFor(true).request('/consume', {headers: {cookie: `${RETURN_COOKIE}=${encodeURIComponent(value)}`}})

    expect(await res.json()).toEqual({target: null})
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/iu)
  })

  it('refuses to set a cookie for an invalid target', async () => {
    const app = new Hono()
    app.get('/set', c => {
      setReturnCookie(c, 'https://evil.example/', true)
      return c.text('ok')
    })

    const res = await app.request('/set')

    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
