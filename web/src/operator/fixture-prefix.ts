/**
 * Web-local copy of the fixture operator route prefix.
 *
 * `web/` must never import from `src/` (the server) — the Docker builder
 * stage only copies `web/` into the image, so a `src/` import fails to
 * resolve at build time. Keep this literal in sync with
 * `src/gateway/operator-fixture-routes.ts`.
 */
export const FIXTURE_OPERATOR_PREFIX = '/__fixture/operator'
