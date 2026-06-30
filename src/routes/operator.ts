/**
 * Operator UI — compatibility SSR route.
 *
 * Mounted at /operator when operatorUiEnabled is true. The unconditional redirect
 * at app.get('/operator') fires first for the exact path; this router only handles
 * sub-path variants (e.g. /operator/) that the redirect does not cover.
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
