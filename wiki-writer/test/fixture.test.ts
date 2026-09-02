import {describe, expect, it, vi} from 'vitest'
import {createFixtureWikiWriterApp, signFixtureRequest} from '../src/fixture.ts'

describe('wiki-writer fixture', () => {
  it('accepts synthetic signed requests without reading a key file or constructing a GitHub client', async () => {
    const authorizeOperation = vi.fn().mockResolvedValue({allowed: true})
    const app = createFixtureWikiWriterApp({authorizeOperation, nowSeconds: () => 1_756_000_000})
    const response = await app.fetch(
      signFixtureRequest('POST', '/write', JSON.stringify({operation: 'write', repository: 'fixture-org/fixture-repo', ref: 'fixture', path: 'fixture.md', content: '# Fixture'}), 'fixture-001'),
    )

    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({accepted: true})
    expect(authorizeOperation).toHaveBeenCalledOnce()
  })

  it('returns the same safe no-store readiness shape as the service boundary', async () => {
    const app = createFixtureWikiWriterApp({nowSeconds: () => 1_756_000_000})
    const response = await app.fetch(signFixtureRequest('GET', '/healthz', '', 'fixture-health-001'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ready: true})
  })
})
