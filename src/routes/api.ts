import {Hono} from 'hono'

const api = new Hono()

api.get('/healthz', c => {
  return c.json({ok: true, lastFetch: null, rateLimit: null})
})

export {api}
