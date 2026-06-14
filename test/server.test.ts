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

  it('unknown route returns 404', async () => {
    const res = await app.request('/not-a-real-route')
    expect(res.status).toBe(404)
  })
})
