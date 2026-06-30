/**
 * Operator UI — compatibility SSR route.
 *
 * Mounted at /operator when operatorUiEnabled is true. The unconditional redirects
 * at app.get('/operator') and app.get('/operator/') in server.ts fire first for
 * those paths; this router handles any remaining sub-paths (e.g. /operator/foo)
 * that fall through — all of which 404 because no routes are registered for them.
 *
 * NOTE: router.get('/') below is intentionally dead code. Due to a Hono routing
 * quirk, app.route('/operator', router) does NOT strip the trailing slash from
 * /operator/ — the sub-router sees the full path '/operator/' and router.get('/')
 * never matches it. The /operator/ case is handled unconditionally in server.ts
 * via app.get('/operator/', c => c.redirect('/', 302)).
 *
 * The active operator surface is the React PWA shell at /. This route is inert:
 * no SSR Gateway calls, no fixture data, no script tags.
 *
 * Protected by auth middleware in server.ts. NOT a public path.
 */
import {Hono} from 'hono'
import {html} from 'hono/html'

function compatibilityPage(): ReturnType<typeof html> {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Fro Bot — Operator</title>
</head>
<body>
  <p><a href="/">Go to operator dashboard</a></p>
</body>
</html>`
}

/** Builds the operator UI compatibility SSR router. Mounted at /operator in server.ts. */
export function buildOperatorRouter(_gatewaySessionEnabled: boolean): Hono {
  const router = new Hono()

  router.get('/', async c => {
    return c.html(compatibilityPage())
  })

  return router
}
