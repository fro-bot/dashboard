/**
 * Dev-only fixture harness router.
 *
 * Security invariants:
 * - Only mounted when NODE_ENV is 'development'/'test' AND bind host is loopback.
 * - All identifiers are fixture-prefixed; never resemble production tokens or real data.
 * - Inbound cookies, auth headers, and CSRF values are ignored — never echoed or logged.
 * - Error responses never echo invalid input.
 * - Logs use route templates, status, and coarse error class only.
 * - No-store on every response. State resets with the process.
 * - Idempotency scoped by fixtureSessionId + idempotencyKey.
 * - runId is bound to the launching fixtureSessionId; stream/approvals/decision
 *   require a matching session (query param or x-fixture-session-id header).
 */
import type {RunSummary} from '../gateway/operator-contract/run-summary.ts'
import {createHash} from 'node:crypto'
import {Hono} from 'hono'
import {FIXTURE_OPERATOR_PREFIX} from '../gateway/operator-fixture-routes.ts'
import {FIXTURE_SCENARIO_NAMES, serializeScenarioToSse} from '../gateway/operator-fixture-sse.ts'
import {
  FIXTURE_CSRF,
  FIXTURE_KNOWN_FAILURE_REASON,
  FIXTURE_SESSION,
  FIXTURE_UNKNOWN_FAILURE_REASON,
  FIXTURE_VAPID_KEY_VERSION,
  FIXTURE_VAPID_PUBLIC_KEY,
} from '../gateway/operator-fixtures.ts'
import {logger} from '../logger.ts'

// Fixture-prefixed repo list — never real repos.
const FIXTURE_REPOS = [
  {owner: 'fixture-org', repo: 'fixture-repo'},
  {owner: 'fixture-org', repo: 'fixture-repo-2'},
]

const FIXTURE_APPROVAL = {requestID: 'req-fixture-harness-001', permission: 'tool_use', command: 'bash'}

// Sorted newest-first; updatedAt absent on some entries to exercise the optional field.
const FIXTURE_RUN_SUMMARIES: readonly RunSummary[] = [
  {
    runId: 'run-fixture-index-queued-001',
    repo: 'fixture-org/fixture-repo',
    status: 'queued',
    createdAt: '2026-06-28T10:05:00Z',
  },
  {
    runId: 'run-fixture-index-running-002',
    repo: 'fixture-org/fixture-repo-2',
    status: 'running',
    createdAt: '2026-06-28T10:04:00Z',
    updatedAt: '2026-06-28T10:04:30Z',
  },
  {
    runId: 'run-fixture-index-succeeded-003',
    repo: 'fixture-org/fixture-repo',
    status: 'succeeded',
    createdAt: '2026-06-28T10:03:00Z',
    updatedAt: '2026-06-28T10:03:45Z',
  },
  {
    runId: 'run-fixture-index-failed-004',
    repo: 'fixture-org/fixture-repo-2',
    status: 'failed',
    createdAt: '2026-06-28T10:02:00Z',
    updatedAt: '2026-06-28T10:02:20Z',
  },
  {
    runId: 'run-fixture-index-cancelled-005',
    repo: 'fixture-org/fixture-repo',
    status: 'cancelled',
    createdAt: '2026-06-28T10:01:00Z',
    updatedAt: '2026-06-28T10:01:10Z',
  },
  {
    runId: 'run-fixture-index-failed-reason-006',
    repo: 'fixture-org/fixture-repo',
    status: 'failed',
    createdAt: '2026-06-28T10:00:30Z',
    updatedAt: '2026-06-28T10:00:50Z',
    failureKind: FIXTURE_KNOWN_FAILURE_REASON,
  },
  {
    runId: 'run-fixture-index-failed-unknown-reason-007',
    repo: 'fixture-org/fixture-repo-2',
    status: 'failed',
    createdAt: '2026-06-28T10:00:10Z',
    updatedAt: '2026-06-28T10:00:25Z',
    // Synthetic out-of-union value for unknown-reason normalization.
    failureKind: FIXTURE_UNKNOWN_FAILURE_REASON as unknown as RunSummary['failureKind'],
  },
]

// Run IDs bound to a specific reason-bearing stream scenario, distinct from the
// generic terminal_failure default. Extends the failed→scenario binding below.
const RUN_ID_TO_REASON_SCENARIO: ReadonlyMap<string, string> = new Map([
  ['run-fixture-index-failed-reason-006', FIXTURE_SCENARIO_NAMES.terminal_failure_known_reason],
  ['run-fixture-index-failed-unknown-reason-007', FIXTURE_SCENARIO_NAMES.terminal_failure_unknown_reason],
])

// In-memory state — scoped by (fixtureSessionId, idempotencyKey). Resets on restart.
const idempotencyMap = new Map<string, string>() // `${sessionId}:${idemKey}` → runId
const runScenarioMap = new Map<string, string>() // runId → scenarioName
const runSessionMap = new Map<string, string>() // runId → owning fixtureSessionId (launched runs only)
const validFixtureSessionIds = new Set<string>() // all session IDs minted by GET /session

// Push subscription fixture record. `endpoint` is kept internally ONLY to match
// unsubscribe requests and compute the synthetic hash — it is never returned
// in any response.
interface FixturePushRecord {
  endpoint: string
  keyVersion: string
  active: boolean
  createdAt: string
  updatedAt: string
  inactiveReason?: string
}

// Idempotency scoping mirrors POST /runs: `${sessionId}:${idemKey}` → record.
const pushIdempotencyMap = new Map<string, FixturePushRecord>()
// Current record per fixtureSessionId — the "active subscription" for that
// session's browser. Overwritten on subscribe, marked inactive on unsubscribe.
const pushSessionRecordMap = new Map<string, FixturePushRecord>()

// Synthetic, never a real sha256 — deterministic per-endpoint fixture hash.
function fixtureEndpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex')
}

function isValidPushSubscriptionBody(
  body: unknown,
): body is {endpoint: string; keys: {p256dh: string; auth: string}} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
  const candidate = body as Record<string, unknown>
  if (typeof candidate.endpoint !== 'string' || candidate.endpoint.trim() === '') return false
  if (candidate.keys === null || typeof candidate.keys !== 'object' || Array.isArray(candidate.keys)) return false
  const keys = candidate.keys as Record<string, unknown>
  if (typeof keys.p256dh !== 'string' || keys.p256dh.trim() === '') return false
  if (typeof keys.auth !== 'string' || keys.auth.trim() === '') return false
  return true
}

let sessionIdCounter = 0
let runIdCounter = 0

function generateFixtureSessionId(): string {
  sessionIdCounter++
  return `fixture-session-${String(sessionIdCounter).padStart(4, '0')}`
}

function isIndexedRunId(runId: string): boolean {
  return FIXTURE_RUN_SUMMARIES.some(s => s.runId === runId)
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

// Rejects non-fixture session IDs without echoing the invalid input.
const FIXTURE_SESSION_ID_PREFIX = 'fixture-session-'

function isValidFixtureSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(FIXTURE_SESSION_ID_PREFIX)
}

function setNoStore(headers: Headers): void {
  headers.set('cache-control', 'no-store')
}

// Extract fixtureSessionId from query param or header. Never echoes raw value.
function extractRequestSessionId(c: {req: {query: (k: string) => string | undefined; header: (k: string) => string | undefined}}): string | undefined {
  const fromQuery = c.req.query('fixtureSessionId')
  const fromHeader = c.req.header('x-fixture-session-id')
  const raw = fromQuery ?? fromHeader
  if (raw === undefined) return undefined
  return isValidFixtureSessionId(raw) ? raw : undefined
}

// Indexed runs are shared synthetic fixtures; launched runs stay session-bound.
function verifyRunOwnership(runId: string, requestSessionId: string | undefined): boolean {
  if (requestSessionId === undefined) return false
  if (isIndexedRunId(runId)) {
    return runScenarioMap.has(runId) && validFixtureSessionIds.has(requestSessionId)
  }
  const ownerSessionId = runSessionMap.get(runId)
  if (ownerSessionId === undefined) return false
  return ownerSessionId === requestSessionId
}

export function buildFixtureHarnessRouter(): Hono {
  const router = new Hono()

  // GET / — fixture harness manifest.
  router.get('/', c => {
    logger.debug('fixture-harness: GET /', {status: 200})
    const res = c.json({
      fixtureMode: true,
      prefix: FIXTURE_OPERATOR_PREFIX,
      scenarios: Object.values(FIXTURE_SCENARIO_NAMES),
    })
    setNoStore(res.headers)
    return res
  })

  // GET /session — synthetic session; each call mints a fresh fixtureSessionId.
  router.get('/session', c => {
    logger.debug('fixture-harness: GET /session', {status: 200})
    const fixtureSessionId = generateFixtureSessionId()
    validFixtureSessionIds.add(fixtureSessionId)
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

  router.get('/runs', c => {
    const requestSessionId = extractRequestSessionId(c)

    if (requestSessionId !== undefined) {
      for (const summary of FIXTURE_RUN_SUMMARIES) {
        if (!runScenarioMap.has(summary.runId)) {
          const reasonScenario = RUN_ID_TO_REASON_SCENARIO.get(summary.runId)
          const scenario =
            reasonScenario ??
            (summary.status === 'failed' || summary.status === 'cancelled'
              ? FIXTURE_SCENARIO_NAMES.terminal_failure
              : FIXTURE_SCENARIO_NAMES.success)
          runScenarioMap.set(summary.runId, scenario)
        }
      }
    }

    logger.debug('fixture-harness: GET /runs', {status: 200})
    const res = c.json({runs: FIXTURE_RUN_SUMMARIES})
    setNoStore(res.headers)
    return res
  })

  // POST /runs — synthetic launch. Binds runId to fixtureSessionId for ownership checks.
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

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
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

    if (!isValidFixtureSessionId(req.fixtureSessionId)) {
      logger.debug('fixture-harness: POST /runs', {status: 400, errorClass: 'invalid-fixture-session'})
      const res = c.json({error: 'invalid-fixture-session'}, 400)
      setNoStore(res.headers)
      return res
    }

    const fixtureSessionId = req.fixtureSessionId
    const scenario = req.scenario
    const scopedKey = `${fixtureSessionId}:${idempotencyKey}`

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
    runSessionMap.set(runId, fixtureSessionId)

    logger.debug('fixture-harness: POST /runs', {status: 200})
    const res = c.json({runId})
    setNoStore(res.headers)
    return res
  })

  // GET /runs/:runId/stream — SSE bytes for the scenario. Requires matching fixtureSessionId.
  router.get('/runs/:runId/stream', c => {
    const runId = c.req.param('runId')
    const scenario = runScenarioMap.get(runId)
    if (scenario === undefined) {
      logger.debug('fixture-harness: GET /runs/:runId/stream', {status: 404, errorClass: 'unknown-run'})
      const res = c.json({error: 'not-found'}, 404)
      setNoStore(res.headers)
      return res
    }

    const requestSessionId = extractRequestSessionId(c)
    if (!verifyRunOwnership(runId, requestSessionId)) {
      logger.debug('fixture-harness: GET /runs/:runId/stream', {status: 400, errorClass: 'session-mismatch'})
      const res = c.json({error: 'invalid-fixture-session'}, 400)
      setNoStore(res.headers)
      return res
    }

    let sseBytes: string
    try {
      sseBytes = serializeScenarioToSse(scenario, runId)
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

  // GET /runs/:runId/approvals — synthetic approval list. Requires matching fixtureSessionId.
  router.get('/runs/:runId/approvals', c => {
    const runId = c.req.param('runId')
    if (!runScenarioMap.has(runId)) {
      logger.debug('fixture-harness: GET /runs/:runId/approvals', {status: 404, errorClass: 'unknown-run'})
      const res = c.json({error: 'not-found'}, 404)
      setNoStore(res.headers)
      return res
    }

    const requestSessionId = extractRequestSessionId(c)
    if (!verifyRunOwnership(runId, requestSessionId)) {
      logger.debug('fixture-harness: GET /runs/:runId/approvals', {status: 400, errorClass: 'session-mismatch'})
      const res = c.json({error: 'invalid-fixture-session'}, 400)
      setNoStore(res.headers)
      return res
    }

    logger.debug('fixture-harness: GET /runs/:runId/approvals', {status: 200})
    const res = c.json({approvals: [FIXTURE_APPROVAL]})
    setNoStore(res.headers)
    return res
  })

  // POST /runs/:runId/approvals/:reqId/decision — synthetic decision. Requires matching fixtureSessionId.
  router.post('/runs/:runId/approvals/:reqId/decision', async c => {
    const runId = c.req.param('runId')
    if (!runScenarioMap.has(runId)) {
      logger.debug('fixture-harness: POST /runs/:runId/approvals/:reqId/decision', {status: 404, errorClass: 'unknown-run'})
      const res = c.json({error: 'not-found'}, 404)
      setNoStore(res.headers)
      return res
    }

    const requestSessionId = extractRequestSessionId(c)
    if (!verifyRunOwnership(runId, requestSessionId)) {
      logger.debug('fixture-harness: POST /runs/:runId/approvals/:reqId/decision', {status: 400, errorClass: 'session-mismatch'})
      const res = c.json({error: 'invalid-fixture-session'}, 400)
      setNoStore(res.headers)
      return res
    }

    logger.debug('fixture-harness: POST /runs/:runId/approvals/:reqId/decision', {status: 200})
    const res = c.json({state: 'claimed'})
    setNoStore(res.headers)
    return res
  })

  // GET /push/vapid-key — synthetic VAPID public key. EXACTLY {publicKey, keyVersion}.
  router.get('/push/vapid-key', c => {
    logger.debug('fixture-harness: GET /push/vapid-key', {status: 200})
    const res = c.json({publicKey: FIXTURE_VAPID_PUBLIC_KEY, keyVersion: FIXTURE_VAPID_KEY_VERSION})
    setNoStore(res.headers)
    return res
  })

  // POST /push/subscriptions — synthetic subscribe. Requires fixture session +
  // CSRF header + idempotency key. Idempotent per `${fixtureSessionId}:${idemKey}`.
  router.post('/push/subscriptions', async c => {
    const requestSessionId = extractRequestSessionId(c)
    if (requestSessionId === undefined) {
      logger.debug('fixture-harness: POST /push/subscriptions', {status: 400, errorClass: 'invalid-fixture-session'})
      const res = c.json({error: 'invalid-fixture-session'}, 400)
      setNoStore(res.headers)
      return res
    }

    const csrfToken = c.req.header('x-csrf-token')
    if (typeof csrfToken !== 'string' || csrfToken.trim() === '') {
      logger.debug('fixture-harness: POST /push/subscriptions', {status: 400, errorClass: 'missing-csrf'})
      const res = c.json({error: 'missing-csrf'}, 400)
      setNoStore(res.headers)
      return res
    }

    const idempotencyKey = c.req.header('idempotency-key')
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      logger.debug('fixture-harness: POST /push/subscriptions', {status: 400, errorClass: 'missing-idempotency-key'})
      const res = c.json({error: 'missing-idempotency-key'}, 400)
      setNoStore(res.headers)
      return res
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      logger.debug('fixture-harness: POST /push/subscriptions', {status: 400, errorClass: 'parse'})
      const res = c.json({error: 'invalid-request'}, 400)
      setNoStore(res.headers)
      return res
    }

    if (!isValidPushSubscriptionBody(body)) {
      logger.debug('fixture-harness: POST /push/subscriptions', {status: 400, errorClass: 'validation'})
      const res = c.json({error: 'invalid-request'}, 400)
      setNoStore(res.headers)
      return res
    }

    const scopedKey = `${requestSessionId}:${idempotencyKey}`
    const existing = pushIdempotencyMap.get(scopedKey)
    if (existing !== undefined) {
      logger.debug('fixture-harness: POST /push/subscriptions idempotent', {status: 200})
      const res = c.json({ok: true})
      setNoStore(res.headers)
      return res
    }

    const now = new Date().toISOString()
    const record: FixturePushRecord = {
      endpoint: body.endpoint,
      keyVersion: FIXTURE_VAPID_KEY_VERSION,
      active: true,
      createdAt: now,
      updatedAt: now,
    }
    pushIdempotencyMap.set(scopedKey, record)
    pushSessionRecordMap.set(requestSessionId, record)

    logger.debug('fixture-harness: POST /push/subscriptions', {status: 200})
    const res = c.json({ok: true})
    setNoStore(res.headers)
    return res
  })

  // POST /push/subscriptions/unsubscribe — synthetic unsubscribe. Requires
  // fixture session + CSRF header. Marks the session's record inactive.
  router.post('/push/subscriptions/unsubscribe', async c => {
    const requestSessionId = extractRequestSessionId(c)
    if (requestSessionId === undefined) {
      logger.debug('fixture-harness: POST /push/subscriptions/unsubscribe', {status: 400, errorClass: 'invalid-fixture-session'})
      const res = c.json({error: 'invalid-fixture-session'}, 400)
      setNoStore(res.headers)
      return res
    }

    const csrfToken = c.req.header('x-csrf-token')
    if (typeof csrfToken !== 'string' || csrfToken.trim() === '') {
      logger.debug('fixture-harness: POST /push/subscriptions/unsubscribe', {status: 400, errorClass: 'missing-csrf'})
      const res = c.json({error: 'missing-csrf'}, 400)
      setNoStore(res.headers)
      return res
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      logger.debug('fixture-harness: POST /push/subscriptions/unsubscribe', {status: 400, errorClass: 'parse'})
      const res = c.json({error: 'invalid-request'}, 400)
      setNoStore(res.headers)
      return res
    }

    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).endpoint !== 'string'
    ) {
      logger.debug('fixture-harness: POST /push/subscriptions/unsubscribe', {status: 400, errorClass: 'validation'})
      const res = c.json({error: 'invalid-request'}, 400)
      setNoStore(res.headers)
      return res
    }

    const record = pushSessionRecordMap.get(requestSessionId)
    if (record !== undefined) {
      record.active = false
      record.updatedAt = new Date().toISOString()
      record.inactiveReason = 'unsubscribed'
    }

    logger.debug('fixture-harness: POST /push/subscriptions/unsubscribe', {status: 200})
    const res = c.json({ok: true})
    setNoStore(res.headers)
    return res
  })

  // GET /push/subscriptions — safe metadata only for the current fixture
  // session's active record. Never the raw endpoint/keys.
  router.get('/push/subscriptions', c => {
    const requestSessionId = extractRequestSessionId(c)
    if (requestSessionId === undefined) {
      logger.debug('fixture-harness: GET /push/subscriptions', {status: 400, errorClass: 'invalid-fixture-session'})
      const res = c.json({error: 'invalid-fixture-session'}, 400)
      setNoStore(res.headers)
      return res
    }

    const record = pushSessionRecordMap.get(requestSessionId)
    if (record === undefined) {
      logger.debug('fixture-harness: GET /push/subscriptions', {status: 200, errorClass: 'not-subscribed'})
      const res = c.json({})
      setNoStore(res.headers)
      return res
    }

    logger.debug('fixture-harness: GET /push/subscriptions', {status: 200})
    const res = c.json({
      endpointHash: fixtureEndpointHash(record.endpoint),
      keyVersion: record.keyVersion,
      active: record.active,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.inactiveReason === undefined ? {} : {inactiveReason: record.inactiveReason}),
    })
    setNoStore(res.headers)
    return res
  })

  return router
}

/** Reset in-memory state. Tests only. */
export function resetFixtureHarnessForTesting(): void {
  idempotencyMap.clear()
  runScenarioMap.clear()
  runSessionMap.clear()
  validFixtureSessionIds.clear()
  pushIdempotencyMap.clear()
  pushSessionRecordMap.clear()
  sessionIdCounter = 0
  runIdCounter = 0
}
