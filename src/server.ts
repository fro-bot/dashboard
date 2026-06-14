import type {ServerType} from '@hono/node-server'
import process from 'node:process'
import {serve} from '@hono/node-server'
import {Hono} from 'hono'
import {api} from './routes/api.ts'

/**
 * Constructs the Hono app with all routes mounted.
 * Separated from port binding so tests can call app.request() without a live server.
 * Mirrors the gateway's buildAnnounceApp/createAnnounceServer split for future
 * @fro.bot/runtime extraction.
 */
function buildDashboardApp(): Hono {
  const app = new Hono()

  app.route('/api', api)

  return app
}

/**
 * Binds the app to 127.0.0.1:3000 via @hono/node-server.
 */
function createDashboardServer(): ServerType {
  const app = buildDashboardApp()

  const server = serve(
    {
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: 3000,
    },
    info => {
      console.warn(`Dashboard listening on http://${info.address}:${info.port}`)
    },
  )

  return server
}

// Only start the server when this module is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  createDashboardServer()
}

export {buildDashboardApp, createDashboardServer}
