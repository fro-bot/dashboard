import {describe, expect, it} from 'vitest'
import {buildDashboardApp} from '../src/server.ts'

describe('dashboard server', () => {
  const app = buildDashboardApp()

  it('GET /api/healthz returns 200 with status shape', async () => {
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, lastFetch: null, rateLimit: null})
  })

  it('fails closed: with no operator configured, an unknown protected route is denied (401), not 404', async () => {
    // Deny-by-default — an unauthenticated caller must not be able to probe
    // which routes exist, and an unconfigured operator login must never serve
    // protected content.
    const res = await app.request('/not-a-real-route')
    expect(res.status).toBe(401)
  })
})
