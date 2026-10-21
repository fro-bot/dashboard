/**
 * Wiki routes, mounted at `/api/wiki` behind the session middleware.
 *
 * Read routes need the session. Write routes (save, retry dispatch) also run the
 * authorization chain: write capability, operator identity, exact `Origin`, JSON
 * content type, per-operator rate limit, then a bounded body read. A refusal of
 * capability, identity, or origin always answers the same 403 body, so it does not
 * say which check failed. No route sends CORS headers.
 *
 * Every body is a discriminated union on `state`, except successful reads. Logs
 * carry the route template, status class, and operation ID; never bodies or IDs
 * from the path.
 */

import type {Context} from 'hono'
import type {ContentfulStatusCode} from 'hono/utils/http-status'
import type {SessionDto} from '../gateway/operator-client.ts'
import type {IdentityPolicy, WikiSession} from '../wiki/authorize.ts'
import type {PageCorrection, WikiPageReadModel, WikiPages, WikiPagesError, WriteAccess} from '../wiki/pages.ts'
import type {PromotionDispatchResult, PromotionStatusReader} from '../wiki/promotion.ts'
import type {SaveResult, WikiWriteOperation} from '../wiki/write-operation.ts'

import {Buffer} from 'node:buffer'
import {Hono} from 'hono'
import {logger} from '../logger.ts'
import {isJsonContentType, operatorRateLimitKey, originMatches, resolveWriteAccess} from '../wiki/authorize.ts'
import {parsePageId} from '../wiki/paths.ts'
import {MAX_DATE_MS} from '../wiki/write-operation.ts'

/** Largest request body read. A save body is at most 512 KiB of text before JSON escaping. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024
const MAX_SINCE_LENGTH = 64
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export interface WikiWriteRoutes {
  readonly operation: Pick<WikiWriteOperation, 'lookup' | 'save'>
  readonly dispatch: {readonly dispatch: () => Promise<PromotionDispatchResult>}
  readonly status: Pick<PromotionStatusReader, 'getStatus'>
}

/** What the app supplies. Null parts mean the capability is not configured. */
export interface WikiAppDeps {
  readonly pages: WikiPages | null
  readonly write: WikiWriteRoutes | null
  readonly policy: IdentityPolicy
}

export interface WikiRouterDeps extends WikiAppDeps {
  readonly rateLimit: (key: string) => {readonly allowed: boolean; readonly retryAfterSeconds: number}
}

interface WikiVariables {
  gatewaySession?: SessionDto
  sessionLogin?: string
  wikiRoute?: string
  wikiOperationId?: string
}

type WikiContext = Context<{Variables: WikiVariables}>

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** One distinct status per save outcome. The client switches on the body `state`. */
const SAVE_STATUS: Readonly<Record<SaveResult['state'], ContentfulStatusCode>> = {
  saved: 200,
  'saved-not-promoted': 202,
  rejected: 422,
  conflict: 409,
  failed: 502,
  'contract-rejected': 424,
  indeterminate: 504,
  'rate-limited': 429,
}

function respond(c: WikiContext, status: ContentfulStatusCode, body: unknown): Response {
  return c.json(body, status)
}

function forbidden(c: WikiContext): Response {
  return respond(c, 403, {state: 'forbidden'})
}

function rateLimited(c: WikiContext, retryAfterSeconds: number | null): Response {
  if (retryAfterSeconds !== null) c.header('Retry-After', String(retryAfterSeconds))
  return respond(c, 429, {state: 'rate-limited', retryAfterSeconds})
}

/** The correction as the client sees it: the stored record stays on the server. */
function toWireCorrection(correction: PageCorrection): Omit<PageCorrection, 'record'> {
  return {
    id: correction.id,
    status: correction.status,
    span: correction.span,
    attribution: correction.attribution,
    reason: correction.reason,
    supersededBy: correction.supersededBy,
    stale: correction.stale,
  }
}

function toWirePage(model: WikiPageReadModel): Omit<WikiPageReadModel, 'corrections'> & {
  readonly corrections: readonly Omit<PageCorrection, 'record'>[]
} {
  return {...model, corrections: model.corrections.map(toWireCorrection)}
}

function toWireSave(result: SaveResult): unknown {
  if (result.state === 'conflict' && result.kind === 'corrections') {
    return {...result, currentCorrections: result.currentCorrections.map(toWireCorrection)}
  }
  return result
}

function readFailure(c: WikiContext, error: WikiPagesError): Response {
  switch (error.kind) {
    case 'invalid-id':
    case 'not-found':
      return respond(c, 404, {state: 'not-found'})
    case 'page-invalid':
      return respond(c, 502, {state: 'page-invalid'})
    case 'corrections-corrupt':
      return respond(c, 502, {state: 'corrections-corrupt'})
    case 'unavailable':
      return respond(c, 503, {state: 'unavailable'})
  }
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function sessionOf(c: WikiContext): WikiSession | null {
  const gateway = c.get('gatewaySession')
  if (gateway !== undefined) return {kind: 'gateway', operatorId: gateway.operatorId, login: gateway.login}
  const login = c.get('sessionLogin')
  return login === undefined ? null : {kind: 'arctic', login}
}

function accessOf(deps: WikiRouterDeps, session: WikiSession | null): WriteAccess {
  return resolveWriteAccess(deps.policy, session)
}

type WriteGuard =
  | {readonly ok: true; readonly session: WikiSession; readonly write: WikiWriteRoutes}
  | {readonly ok: false; readonly response: Response}

/** Capability, identity, origin, content type, then the per-operator rate limit. */
function guardWrite(c: WikiContext, deps: WikiRouterDeps): WriteGuard {
  const refuse = (response: Response): WriteGuard => ({ok: false, response})
  const {capability} = deps.policy
  const session = sessionOf(c)

  if (deps.write === null || !capability.enabled || session === null) return refuse(forbidden(c))
  if (!accessOf(deps, session).canWrite) return refuse(forbidden(c))
  if (!originMatches(c.req.header('origin'), capability.dashboardOrigin)) return refuse(forbidden(c))
  if (!isJsonContentType(c.req.header('content-type'))) return refuse(respond(c, 415, {state: 'unsupported-media-type'}))

  const limit = deps.rateLimit(operatorRateLimitKey(session))
  if (!limit.allowed) return refuse(rateLimited(c, limit.retryAfterSeconds))
  return {ok: true, session, write: deps.write}
}

// The platform reader resolves to `any` under the project's lint types, so the read loop is
// typed by this shape instead.
interface StreamReader {
  read: () => Promise<{done: boolean; value?: Uint8Array}>
  cancel: () => Promise<void>
}

type BoundedBody = {readonly ok: true; readonly text: string} | {readonly ok: false}

/** Read at most `maxBytes`. A larger declared length is refused before reading; a longer stream is cancelled. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return {ok: false}
  if (request.body === null) return {ok: true, text: ''}

  const reader = request.body.getReader() as unknown as StreamReader
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done || value === undefined) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return {ok: false}
    }
    chunks.push(value)
  }
  return {ok: true, text: Buffer.concat(chunks).toString('utf8')}
}

type JsonBody = {readonly ok: true; readonly value: Record<string, unknown>} | {readonly ok: false; readonly response: Response}

/** Bounded read, then parse. Oversized is 413 without parsing; unparseable is 400. */
async function readJsonObject(c: WikiContext, options: {readonly allowEmpty: boolean}): Promise<JsonBody> {
  const body = await readBoundedBody(c.req.raw, MAX_REQUEST_BODY_BYTES)
  if (!body.ok) return {ok: false, response: respond(c, 413, {state: 'payload-too-large'})}
  if (options.allowEmpty && body.text.trim() === '') return {ok: true, value: {}}

  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    return {ok: false, response: respond(c, 400, {state: 'bad-request'})}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {ok: false, response: respond(c, 400, {state: 'bad-request'})}
  }
  return {ok: true, value: parsed as Record<string, unknown>}
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function buildWikiRouter(deps: WikiRouterDeps): Hono<{Variables: WikiVariables}> {
  const router = new Hono<{Variables: WikiVariables}>()

  router.use('*', async (c, next) => {
    await next()
    const operationId = c.get('wikiOperationId')
    logger.info('Wiki route', {
      route: c.get('wikiRoute') ?? '/api/wiki/*',
      status: `${Math.floor(c.res.status / 100)}xx`,
      ...(operationId === undefined ? {} : {operationId}),
    })
  })

  router.get('/pages', async c => {
    c.set('wikiRoute', '/api/wiki/pages')
    if (deps.pages === null) return respond(c, 503, {state: 'unavailable'})
    const result = await deps.pages.listPages()
    if (!result.success) return readFailure(c, result.error)

    const access = accessOf(deps, sessionOf(c))
    return respond(c, 200, {
      headSha: result.data.headSha,
      pages: result.data.pages,
      canWrite: access.canWrite,
      canWriteReason: access.canWrite ? null : access.reason,
    })
  })

  router.get('/pages/:id', async c => {
    c.set('wikiRoute', '/api/wiki/pages/:id')
    if (deps.pages === null) return respond(c, 503, {state: 'unavailable'})
    const id = c.req.param('id')
    if (parsePageId(id) === null) return respond(c, 404, {state: 'not-found'})

    const result = await deps.pages.readPage(id, accessOf(deps, sessionOf(c)))
    return result.success ? respond(c, 200, toWirePage(result.data)) : readFailure(c, result.error)
  })

  router.post('/pages/:id/save', async c => {
    c.set('wikiRoute', '/api/wiki/pages/:id/save')
    const guard = guardWrite(c, deps)
    if (!guard.ok) return guard.response

    const id = c.req.param('id')
    if (parsePageId(id) === null) return respond(c, 404, {state: 'not-found'})

    const body = await readJsonObject(c, {allowEmpty: false})
    if (!body.ok) return body.response
    const {operationId} = body.value
    if (typeof operationId === 'string' && OPERATION_ID.test(operationId)) c.set('wikiOperationId', operationId)

    const result = await guard.write.operation.save({...body.value, pageId: id}, {operatorLogin: guard.session.login})
    if (result.state === 'rate-limited' && result.retryAfterSeconds !== null) {
      c.header('Retry-After', String(result.retryAfterSeconds))
    }
    return respond(c, SAVE_STATUS[result.state], toWireSave(result))
  })

  router.post('/promotion/dispatch', async c => {
    c.set('wikiRoute', '/api/wiki/promotion/dispatch')
    const guard = guardWrite(c, deps)
    if (!guard.ok) return guard.response

    const body = await readJsonObject(c, {allowEmpty: true})
    if (!body.ok) return body.response

    const result = await guard.write.dispatch.dispatch()
    if (result.ok) return respond(c, 200, {state: 'dispatched'})
    if (result.rateLimit !== null) return rateLimited(c, result.rateLimit.retryAfterSeconds)
    return respond(c, 502, {state: 'dispatch-failed'})
  })

  router.get('/operations/:operationId', async c => {
    c.set('wikiRoute', '/api/wiki/operations/:operationId')
    if (deps.write === null) return forbidden(c)

    // A lookup reads GitHub history, so it spends the operator's write budget. A session with
    // no identity match is left to the per-IP limit that already covers every /api route.
    const session = sessionOf(c)
    if (session !== null && accessOf(deps, session).canWrite) {
      const limit = deps.rateLimit(operatorRateLimitKey(session))
      if (!limit.allowed) return rateLimited(c, limit.retryAfterSeconds)
    }

    const operationId = c.req.param('operationId')
    const pageId = c.req.query('pageId')
    const startedAt = c.req.query('startedAt')
    const startedAtMs = startedAt !== undefined && /^\d{1,16}$/u.test(startedAt) ? Number(startedAt) : Number.NaN
    if (
      !OPERATION_ID.test(operationId) ||
      pageId === undefined ||
      !Number.isSafeInteger(startedAtMs) ||
      startedAtMs > MAX_DATE_MS
    ) {
      return respond(c, 400, {state: 'invalid-request'})
    }
    c.set('wikiOperationId', operationId)

    const result = await deps.write.operation.lookup({operationId, pageId, startedAt: startedAtMs})
    return result.state === 'invalid-request' ? respond(c, 400, result) : respond(c, 200, result)
  })

  router.get('/promotion/status', async c => {
    c.set('wikiRoute', '/api/wiki/promotion/status')
    if (deps.write === null) return forbidden(c)

    const since = c.req.query('since')
    if (since !== undefined && (since.length > MAX_SINCE_LENGTH || Number.isNaN(Date.parse(since)))) {
      return respond(c, 400, {state: 'bad-request'})
    }

    const status = await deps.write.status.getStatus(since)
    if (status.state === 'unavailable') return respond(c, 503, status)
    if (status.state === 'configuration-fault') return respond(c, 502, status)
    return respond(c, 200, status)
  })

  return router
}
