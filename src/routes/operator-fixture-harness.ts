/**
 * Dev-only fixture harness router.
 *
 * SECURITY INVARIANTS:
 * - ONLY mounted when NODE_ENV !== 'production' AND bind host is loopback.
 * - All identifiers are visually fixture-prefixed; must not resemble production
 *   tokens, cookies, UUIDs, or real operator data.
 * - Inbound cookies, authorization headers, and real CSRF values are IGNORED.
 *   They are never accepted as evidence, reflected in responses, or logged.
 * - Non-echoing validation errors: error responses never echo invalid input.
 * - Logs use route templates, status, and coarse error class only — no request
 *   URLs with identifiers, headers, body text, synthetic values, or detail.
 * - No-store headers on every fixture response.
 * - Fixture responses inherit normal app CSP (set by secureHeaders middleware).
 * - Idempotency is scoped by fixtureSessionId + idempotencyKey. Two fixture
 *   sessions with the same idempotency key receive different run IDs.
 * - State resets with the dev server process.
 */
import {Hono} from 'hono'
import {FIXTURE_SCENARIO_NAMES, serializeScenarioToSse} from '../gateway/operator-fixture-sse.ts'
import {FIXTURE_CSRF, FIXTURE_SESSION} from '../gateway/operator-fixtures.ts'
import {logger} from '../logger.ts'

// Synthetic fixture repo list — fixture-prefixed, never real repos.
// Shape matches validateRepoItem: {owner, repo} required; channelName optional.
const FIXTURE_REPOS = [
  {owner: 'fixture-org', repo: 'fixture-repo'},
  {owner: 'fixture-org', repo: 'fixture-repo-2'},
]

const FIXTURE_APPROVAL = {requestID: 'req-fixture-harness-001', permission: 'tool_use', command: 'bash'}

// In-memory state — scoped by (fixtureSessionId, idempotencyKey). Resets on restart.
const idempotencyMap = new Map<string, string>() // `${sessionId}:${idemKey}` → runId
const runScenarioMap = new Map<string, string>() // runId → scenarioName

let sessionIdCounter = 0
let runIdCounter = 0

function generateFixtureSessionId(): string {
  sessionIdCounter++
  return `fixture-session-${String(sessionIdCounter).padStart(4, '0')}`
}

function generateFixtureRunId(): string {
  runIdCounter++
  return `run-fixture-harness-${String(runIdCounter).padStart(4, '0')}`
}

function isValidScenario(scenario: unknown): scenario is string {
  if (typeof scenario !== 'string') return false
  return Object.values(FIXTURE_SCENARIO_NAMES).includes(
    scenario as (typeof FIXTURE_SCENARIO_NAMES)[keyof typeof FIXTURE_SCENARIO_NAMES],
  )
}

// fixtureSessionId must start with the canonical prefix to be accepted.
// This rejects real session IDs, UUIDs, and other non-fixture values without
// echoing the invalid input in the error response.
const FIXTURE_SESSION_ID_PREFIX = 'fixture-session-'

function isValidFixtureSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(FIXTURE_SESSION_ID_PREFIX)
}

function setNoStore(headers: Headers): void {
  headers.set('cache-control', 'no-store')
}

export function buildFixtureHarnessRouter(): Hono {
  const router = new Hono()

  // GET /session — synthetic operator session with fixture-mode fields.
  // Each call mints a fresh fixtureSessionId so two tabs get independent sessions.
  router.get('/session', c => {
    logger.debug('fixture-harness: GET /session', {status: 200})
    const fixtureSessionId = generateFixtureSessionId()
    const res = c.json({...FIXTURE_SESSION, fixtureMode: true, fixtureSessionId})
    setNoStore(res.headers)
    return res
  })

  // GET /session/csrf — synthetic CSRF token.
  router.get('/session/csrf', c => {
    logger.debug('fixture-harness: GET /session/csrf', {status: 200})
    const res = c.json(FIXTURE_CSRF)
    setNoStore(res.headers)
    return res
  })

  // GET /repos — synthetic repo list.
  router.get('/repos', c => {
    logger.debug('fixture-harness: GET /repos', {status: 200})
    const res = c.json(FIXTURE_REPOS)
    setNoStore(res.headers)
    return res
  })

  // POST /runs — synthetic launch.
  // Requires: scenario (validated), idempotencyKey, fixtureSessionId (fixture-prefixed).
  // Idempotency key is scoped by fixtureSessionId so two sessions with the same
  // idempotency key receive different run IDs.
  router.post('/runs', async c => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      logger.debug('fixture-harness: POST /runs', {status: 400, errorClass: 'parse'})
      const res = c.json({error: 'invalid-request'}, 400)
      setNoStore(res.headers)
      return res
    }

    if (body === null || typeof body !== 'object') {
      logger.debug('fixture-harness: POST /runs', {status: 400, errorClass: 'validation'})
      const res = c.json({error: 'invalid-request'}, 400)
      setNoStore(res.headers)
      return res
    }

    const req = body as Record<string, unknown>

    if (!isValidScenario(req.scenario)) {
      logger.debug('fixture-harness: POST /runs', {status: 400, errorClass: 'invalid-scenario'})
      const res = c.json({error: 'invalid-scenario'}, 400)
      setNoStore(res.headers)
      return res
    }

    const idempotencyKey = req.idempotencyKey
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      logger.debug('fixture-harness: POST /runs', {status: 400, errorClass: 'missing-idempotency-key'})
      const res = c.json({error: 'missing-idempotency-key'}, 400)
      setNoStore(res.headers)
      return res
    }

    // Require a fixture-prefixed session ID. Rejects real session IDs without echoing them.
    if (!isValidFixtureSessionId(req.fixtureSessionId)) {
      logger.debug('fixture-harness: POST /runs', {status: 400, errorClass: 'invalid-fixture-session'})
      const res = c.json({error: 'invalid-fixture-session'}, 400)
      setNoStore(res.headers)
      return res
    }

    const scenario = req.scenario
    const scopedKey = `${req.fixtureSessionId}:${idempotencyKey}`

    const existing = idempotencyMap.get(scopedKey)
    if (existing !== undefined) {
      logger.debug('fixture-harness: POST /runs idempotent', {status: 200})
      const res = c.json({runId: existing})
      setNoStore(res.headers)
      return res
    }

    const runId = generateFixtureRunId()
    idempotencyMap.set(scopedKey, runId)
    runScenarioMap.set(runId, scenario)

    logger.debug('fixture-harness: POST /runs', {status: 200})
    const res = c.json({runId})
    setNoStore(res.headers)
    return res
  })

  // GET /runs/:runId/stream — SSE bytes for the scenario bound to the run ID.
  router.get('/runs/:runId/stream', c => {
    const runId = c.req.param('runId')
    const scenario = runScenarioMap.get(runId)
    if (scenario === undefined) {
      logger.debug('fixture-harness: GET /runs/:runId/stream', {status: 404, errorClass: 'unknown-run'})
      const res = c.json({error: 'not-found'}, 404)
      setNoStore(res.headers)
      return res
    }

    let sseBytes: string
    try {
      sseBytes = serializeScenarioToSse(scenario)
    } catch {
      logger.debug('fixture-harness: GET /runs/:runId/stream', {status: 500, errorClass: 'serialize'})
      const res = c.json({error: 'internal-error'}, 500)
      setNoStore(res.headers)
      return res
    }

    logger.debug('fixture-harness: GET /runs/:runId/stream', {status: 200})
    return new Response(sseBytes, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    })
  })

  // GET /runs/:runId/approvals — synthetic approval list for a known run.
  router.get('/runs/:runId/approvals', c => {
    const runId = c.req.param('runId')
    if (!runScenarioMap.has(runId)) {
      logger.debug('fixture-harness: GET /runs/:runId/approvals', {status: 404, errorClass: 'unknown-run'})
      const res = c.json({error: 'not-found'}, 404)
      setNoStore(res.headers)
      return res
    }

    logger.debug('fixture-harness: GET /runs/:runId/approvals', {status: 200})
    const res = c.json({approvals: [FIXTURE_APPROVAL]})
    setNoStore(res.headers)
    return res
  })

  // POST /runs/:runId/approvals/:reqId/decision — synthetic decision response.
  router.post('/runs/:runId/approvals/:reqId/decision', async c => {
    const runId = c.req.param('runId')
    if (!runScenarioMap.has(runId)) {
      logger.debug('fixture-harness: POST /runs/:runId/approvals/:reqId/decision', {status: 404, errorClass: 'unknown-run'})
      const res = c.json({error: 'not-found'}, 404)
      setNoStore(res.headers)
      return res
    }

    logger.debug('fixture-harness: POST /runs/:runId/approvals/:reqId/decision', {status: 200})
    const res = c.json({state: 'claimed'})
    setNoStore(res.headers)
    return res
  })

  return router
}

/**
 * Reset fixture harness in-memory state. Tests only.
 * @internal
 */
export function resetFixtureHarnessForTesting(): void {
  idempotencyMap.clear()
  runScenarioMap.clear()
  sessionIdCounter = 0
  runIdCounter = 0
}
