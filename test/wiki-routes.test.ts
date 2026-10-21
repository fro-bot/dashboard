/**
 * /api/wiki routes through the real app: authorization chain, outcome mapping,
 * body bounds, rate limits, deep-link shell, and wire conformance.
 */

import type {OperatorClient, SessionDto} from '../src/gateway/operator-client.ts'
import type {WikiAppDeps} from '../src/routes/wiki.ts'
import type {GateContractDecision} from '../src/wiki/gate-contract.ts'
import type {PromotionDispatchResult} from '../src/wiki/promotion.ts'
import type {SaveResult} from '../src/wiki/write-operation.ts'

import {Buffer} from 'node:buffer'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {env} from 'node:process'
import {GATE_CONTRACT_VERSION} from '@fro.bot/wiki-write-core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {WriteCredentialError} from '../src/github/fro-bot-app-client.ts'
import {ok} from '../src/result.ts'
import {MAX_REQUEST_BODY_BYTES} from '../src/routes/wiki.ts'
import {
  buildDashboardApp,
  checkRateLimit,
  consumeRateLimit,
  resetRateLimitForTesting,
  WIKI_WRITE_RATE_LIMIT_MAX,
} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'
import {createBlobCache, createWikiDataClient} from '../src/wiki/data-client.ts'
import {createWikiPages, EMPTY_CORRECTIONS_DIGEST} from '../src/wiki/pages.ts'
import {createDispatchPort, createPromotionStatusReader} from '../src/wiki/promotion.ts'
import {createWikiWriteOperation} from '../src/wiki/write-operation.ts'
import {FakeRepo, HttpError} from './wiki-fake-repo.ts'
import {ALPHA, ALPHA_BODY, ALPHA_ID, BETA_ID, correctionRecord, CORRECTIONS, correctionsYaml, wikiFiles} from './wiki-write-fixtures.ts'

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8')
const ORIGIN = 'https://dashboard.fro.bot'
const OPERATOR_ID = 12345
const LOGIN = 'octocat'
const SESSION: SessionDto = {operatorId: OPERATOR_ID, login: LOGIN, expiresAt: Date.now() + 60 * 60 * 1000}
const GATEWAY_COOKIE = '__Host-session=abc'
let SHELL_ROOT = ''
const SAMPLES_PATH = new URL('./fixtures/wiki-wire-samples.json', import.meta.url)

function opId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

const OK_CONTRACT = {
  proceed: true,
  marker: {version: GATE_CONTRACT_VERSION, sourceTreeHash: 's'},
  readiness: {ready: true, stale: false, mainHeadSha: 'main-1'},
} as const

function fakeOperatorClient(session: () => SessionDto): OperatorClient {
  return new Proxy({}, {
    get: (_target, property) =>
      property === 'getCurrentSession'
        ? async () => ok(session())
        : () => {
            throw new Error(`${String(property)} must not be called`)
          },
  }) as unknown as OperatorClient
}

interface World {
  readonly repo: FakeRepo
  readonly deps: WikiAppDeps
  readonly dispatch: ReturnType<typeof vi.fn<() => Promise<PromotionDispatchResult>>>
  readonly runs: {value: unknown[]}
  readonly pulls: {value: unknown[]}
  readonly jobs: {value: unknown[]}
}

function makeWorld(overrides: {
  files?: Record<string, string>
  operatorId?: number | null
  capabilityOff?: boolean
  decision?: GateContractDecision
} = {}): World {
  const repo = new FakeRepo({files: overrides.files ?? wikiFiles()})
  const runs = {value: [] as unknown[]}
  const pulls = {value: [] as unknown[]}
  const jobs = {value: [] as unknown[]}
  const transport = {
    ...repo.transport(),
    listWorkflowRuns: async (params: Record<string, unknown>) => {
      repo.hooks.onCall?.('listWorkflowRuns', params)
      return {data: {workflow_runs: runs.value}}
    },
    listPulls: async (params: Record<string, unknown>) => {
      repo.hooks.onCall?.('listPulls', params)
      return {data: pulls.value}
    },
    listRunJobs: async (params: Record<string, unknown>) => {
      repo.hooks.onCall?.('listRunJobs', params)
      return {data: {jobs: jobs.value}}
    },
  }
  const client = createWikiDataClient(transport, {blobCache: createBlobCache()})
  const checkContract = async (): Promise<GateContractDecision> => overrides.decision ?? OK_CONTRACT
  const port = createDispatchPort({client})
  const dispatch = vi.fn(async () => port.dispatch())
  let minted = 0
  const deps: WikiAppDeps = {
    pages: createWikiPages({client, checkContract}),
    write: overrides.capabilityOff
      ? null
      : {
          operation: createWikiWriteOperation({
            client,
            checkContract,
            dispatch: {dispatch},
            now: () => repo.clockMs,
            newId: () => `mint-${++minted}`,
          }),
          dispatch: {dispatch},
          status: createPromotionStatusReader({client, now: () => repo.clockMs}),
        },
    policy: {
      capability: overrides.capabilityOff
        ? {enabled: false, reason: 'app-credentials-absent'}
        : {enabled: true, operatorId: overrides.operatorId === undefined ? OPERATOR_ID : overrides.operatorId, dashboardOrigin: ORIGIN},
      fixtureOperatorLogin: null,
    },
  }
  return {repo, deps, dispatch, runs, pulls, jobs}
}

async function gatewayApp(deps: WikiAppDeps, session: () => SessionDto = () => SESSION, extra: Record<string, unknown> = {}) {
  return buildDashboardApp({
    cookieKey: TEST_KEY,
    gatewayOperatorSessionEnabled: true,
    gatewayOperatorOrigin: ORIGIN,
    operatorClient: fakeOperatorClient(session),
    wiki: deps,
    webDistRoot: SHELL_ROOT,
    ...extra,
  })
}

const WRITE_HEADERS = {cookie: GATEWAY_COOKIE, origin: ORIGIN, 'content-type': 'application/json'}

function saveBody(world: World, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: opId(1),
    pageBlobSha: world.repo.blobShaAt(ALPHA),
    correctionsBase: EMPTY_CORRECTIONS_DIGEST,
    body: ALPHA_BODY.replace('widgets', 'gadgets'),
    marks: [],
    transitions: [],
    ...overrides,
  }
}

async function save(
  app: Awaited<ReturnType<typeof gatewayApp>>,
  body: unknown,
  headers: Record<string, string | undefined> = {},
  id = ALPHA_ID,
): Promise<Response> {
  const merged = {...WRITE_HEADERS, ...headers}
  const clean = Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return app.request(`/api/wiki/pages/${id}/save`, {
    method: 'POST',
    headers: clean,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function get(app: Awaited<ReturnType<typeof gatewayApp>>, path: string): Promise<Response> {
  return app.request(path, {headers: {cookie: GATEWAY_COOKIE}})
}

function expectNothingWritten(world: World): void {
  expect(world.repo.count('createBlob')).toBe(0)
  expect(world.repo.count('createCommit')).toBe(0)
  expect(world.repo.count('updateRef')).toBe(0)
  expect(world.dispatch).not.toHaveBeenCalled()
}

beforeEach(() => {
  resetRateLimitForTesting()
  SHELL_ROOT = mkdtempSync(join(tmpdir(), 'wiki-shell-'))
  mkdirSync(SHELL_ROOT, {recursive: true})
  writeFileSync(join(SHELL_ROOT, 'index.html'), '<!doctype html><html><head><title>shell</title></head><body><div id="root"></div></body></html>')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(SHELL_ROOT, {recursive: true, force: true})
})

// ---------------------------------------------------------------------------
// Read routes
// ---------------------------------------------------------------------------

describe('GET /api/wiki/pages', () => {
  it('lists the pages with canWrite true, as no-store', async () => {
    const world = makeWorld()
    const res = await get(await gatewayApp(world.deps), '/api/wiki/pages')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as {pages: {id: string}[]; canWrite: boolean; canWriteReason: string | null; headSha: string}
    expect(body.canWrite).toBe(true)
    expect(body.canWriteReason).toBeNull()
    expect(body.pages.map(page => page.id)).toContain(ALPHA_ID)
    expect(body.headSha).toBe(world.repo.head)
  })

  it('works with write capability off: canWrite false with the reason code', async () => {
    const world = makeWorld({capabilityOff: true})
    const res = await get(await gatewayApp(world.deps), '/api/wiki/pages')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({canWrite: false, canWriteReason: 'app-credentials-absent'})
  })

  it('reports operator-id-unset when the configured ID is missing', async () => {
    const world = makeWorld()
    const deps: WikiAppDeps = {...world.deps, write: null, policy: {capability: {enabled: false, reason: 'operator-id-unset'}, fixtureOperatorLogin: null}}
    const res = await get(await gatewayApp(deps), '/api/wiki/pages')

    expect(await res.json()).toMatchObject({canWrite: false, canWriteReason: 'operator-id-unset'})
  })

  it('reports canWrite false for a valid gateway session of another operator', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps, () => ({...SESSION, operatorId: 99999}))
    const res = await get(app, '/api/wiki/pages')

    expect(await res.json()).toMatchObject({canWrite: false, canWriteReason: 'not-operator'})
  })

  it('answers 503 unavailable when the read side is not configured', async () => {
    const world = makeWorld()
    const res = await get(await gatewayApp({...world.deps, pages: null}), '/api/wiki/pages')

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({state: 'unavailable'})
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('answers 503 unavailable, never a partial list, when GitHub cannot be read', async () => {
    const world = makeWorld()
    world.repo.hooks.onCall = method => {
      if (method === 'getTree') throw new HttpError('Bad Gateway', 502)
    }
    const res = await get(await gatewayApp(world.deps), '/api/wiki/pages')

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({state: 'unavailable'})
  })

  it('redirects an unauthenticated request and never reaches the handler', async () => {
    const world = makeWorld()
    const listPages = vi.spyOn(world.deps.pages as NonNullable<WikiAppDeps['pages']>, 'listPages')
    const app = await gatewayApp(world.deps)

    const res = await app.request('/api/wiki/pages')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
    expect(listPages).not.toHaveBeenCalled()
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('GET /api/wiki/pages/:id', () => {
  it('returns the read model without frontmatter, with canWrite and no-store', async () => {
    const world = makeWorld()
    const res = await get(await gatewayApp(world.deps), `/api/wiki/pages/${ALPHA_ID}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({id: ALPHA_ID, nodeId: 'R_alpha', canMark: true, canWrite: true, canWriteReason: null})
    expect(body.pageBlobSha).toBe(world.repo.blobShaAt(ALPHA))
    expect(body.body).toBe(ALPHA_BODY)
    expect(String(body.body)).not.toContain('node_id')
  })

  it('does not put the raw corrections record on the wire', async () => {
    const world = makeWorld({files: wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets'))})})
    const res = await get(await gatewayApp(world.deps), `/api/wiki/pages/${ALPHA_ID}`)

    const body = (await res.json()) as {corrections: Record<string, unknown>[]}
    expect(body.corrections).toHaveLength(1)
    expect(body.corrections[0]).not.toHaveProperty('record')
    expect(body.corrections[0]).toMatchObject({id: 'c1', status: 'active', stale: false})
  })

  it.each([
    ['a malformed ID', 'repos..'],
    ['traversal', '..%2F..%2Fetc'],
    ['an unknown type', 'secrets.alpha'],
    ['an unknown page', 'repos.no-such-page'],
    ['an encoded slash', 'repos.a%2Fb'],
  ])('answers 404 for %s, before any gate runs', async (_label, id) => {
    const world = makeWorld()
    const res = await get(await gatewayApp(world.deps), `/api/wiki/pages/${id}`)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({state: 'not-found'})
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('answers 502 for a corrupt corrections file, never an empty list', async () => {
    const world = makeWorld({files: wikiFiles({[CORRECTIONS]: ''})})
    const res = await get(await gatewayApp(world.deps), `/api/wiki/pages/${ALPHA_ID}`)

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({state: 'corrections-corrupt'})
  })
})

// ---------------------------------------------------------------------------
// Authorization chain
// ---------------------------------------------------------------------------

describe('save: authorization chain', () => {
  it('saves for a gateway session whose operator ID matches, with a matching Origin and a JSON body', async () => {
    const world = makeWorld()
    const res = await save(await gatewayApp(world.deps), saveBody(world))

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as {state: string; commitSha: string; committedAt: string}
    expect(body.state).toBe('saved')
    expect(body.commitSha).toBe(world.repo.head)
    expect(body.committedAt).toBe(world.repo.commit(world.repo.head).committedAt)
    expect(world.repo.commit(world.repo.head).message).toContain(`Fro-Operator: ${LOGIN}`)
    expect(world.dispatch).toHaveBeenCalledTimes(1)
  })

  it('takes the operator trailer from the session, not the body', async () => {
    const world = makeWorld()
    await save(await gatewayApp(world.deps), {...saveBody(world), operatorLogin: 'mallory', pageId: BETA_ID})

    expect(world.repo.commit(world.repo.head).message).not.toContain('mallory')
    expect(world.repo.commit(world.repo.head).touched.has(ALPHA)).toBe(true)
  })

  it('refuses every write when write capability is off', async () => {
    const world = makeWorld({capabilityOff: true})
    const res = await save(await gatewayApp(world.deps), saveBody(world))

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({state: 'forbidden'})
    expectNothingWritten(world)
  })

  it('refuses every write when the operator ID is unset, while reads still work', async () => {
    const world = makeWorld({operatorId: null})
    const app = await gatewayApp(world.deps)

    const res = await save(app, saveBody(world))
    const read = await get(app, '/api/wiki/pages')

    expect(res.status).toBe(403)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({canWrite: false, canWriteReason: 'not-operator'})
    expectNothingWritten(world)
  })

  it('refuses a valid gateway session for another operator ID and commits and dispatches nothing', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps, () => ({...SESSION, operatorId: 99999}))

    const res = await save(app, saveBody(world))

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({state: 'forbidden'})
    expectNothingWritten(world)
  })

  it('gives a plain Arctic OAuth session canWrite false and refuses its writes', async () => {
    const world = makeWorld()
    const sm = new SessionManager(TEST_KEY)
    const app = await buildDashboardApp({
      operatorLogin: LOGIN,
      cookieKey: TEST_KEY,
      wiki: world.deps,
      webDistRoot: SHELL_ROOT,
    })
    const headers = {cookie: `session=${sm.sign(LOGIN)}`, origin: ORIGIN, 'content-type': 'application/json'}

    const read = await app.request('/api/wiki/pages', {headers})
    const write = await app.request(`/api/wiki/pages/${ALPHA_ID}/save`, {method: 'POST', headers, body: JSON.stringify(saveBody(world))})

    expect(await read.json()).toMatchObject({canWrite: false, canWriteReason: 'session-not-supported'})
    expect(write.status).toBe(403)
    expectNothingWritten(world)
  })

  it('gives an Arctic session canWrite true only through the fixture identity branch, when the login matches', async () => {
    const world = makeWorld()
    const deps: WikiAppDeps = {
      ...world.deps,
      policy: {capability: {enabled: true, operatorId: null, dashboardOrigin: ORIGIN}, fixtureOperatorLogin: LOGIN},
    }
    const sm = new SessionManager(TEST_KEY)
    const app = await buildDashboardApp({operatorLogin: LOGIN, cookieKey: TEST_KEY, wiki: deps, webDistRoot: SHELL_ROOT})
    const headers = {cookie: `session=${sm.sign(LOGIN)}`, origin: ORIGIN, 'content-type': 'application/json'}

    const res = await app.request(`/api/wiki/pages/${ALPHA_ID}/save`, {method: 'POST', headers, body: JSON.stringify(saveBody(world))})

    expect(res.status).toBe(200)
  })

  it('never lets autologin alone confer write access: injected wiring keeps its own fixture identity', async () => {
    const world = makeWorld()
    const deps: WikiAppDeps = {...world.deps, policy: {...world.deps.policy, capability: {enabled: true, operatorId: null, dashboardOrigin: ORIGIN}}}
    const app = await buildDashboardApp({
      operatorLogin: LOGIN,
      cookieKey: TEST_KEY,
      devAutoLogin: true,
      fixtureHarnessEnabled: false,
      wiki: deps,
      webDistRoot: SHELL_ROOT,
    })

    const res = await app.request(`/api/wiki/pages/${ALPHA_ID}/save`, {
      method: 'POST',
      headers: {origin: ORIGIN, 'content-type': 'application/json'},
      body: JSON.stringify(saveBody(world)),
    })

    expect(res.status).toBe(403)
    expectNothingWritten(world)
  })

  it('derives the fixture identity from autologin only while the fixture harness is active', async () => {
    const build = async (devAutoLogin: boolean) =>
      buildDashboardApp({
        operatorLogin: LOGIN,
        cookieKey: TEST_KEY,
        devAutoLogin,
        fixtureHarnessEnabled: true,
        fixtureBindHost: '127.0.0.1',
        fixtureBindPort: 3000,
        webDistRoot: SHELL_ROOT,
      })
    const sm = new SessionManager(TEST_KEY)
    const read = async (app: Awaited<ReturnType<typeof build>>) =>
      (await app.request('/api/wiki/pages', {headers: {cookie: `session=${sm.sign(LOGIN)}`}})).json()

    expect(await read(await build(true))).toMatchObject({canWrite: true, canWriteReason: null})
    expect(await read(await build(false))).toMatchObject({canWrite: false, canWriteReason: 'session-not-supported'})
  })

  it('answers every refused chain step before the body check with the same 403 body', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)
    const otherOperator = await gatewayApp(world.deps, () => ({...SESSION, operatorId: 2}))
    const off = await gatewayApp(makeWorld({capabilityOff: true}).deps)

    const responses = await Promise.all([
      save(otherOperator, saveBody(world)),
      save(app, saveBody(world), {origin: 'https://evil.example'}),
      save(app, saveBody(world), {origin: undefined}),
      save(off, saveBody(world)),
    ])

    for (const res of responses) {
      expect(res.status).toBe(403)
      expect(await res.text()).toBe(JSON.stringify({state: 'forbidden'}))
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('checks identity before origin, content type, and body', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps, () => ({...SESSION, operatorId: 2}))

    const res = await save(app, 'not json', {origin: undefined, 'content-type': 'text/plain'})

    expect(res.status).toBe(403)
  })
})

describe('save: origin and content type', () => {
  it.each([
    ['a missing Origin', undefined],
    ['a different origin', 'https://evil.example'],
    ['the right scheme and host on a different port', 'https://dashboard.fro.bot:8443'],
    ['a null origin', 'null'],
    ['http instead of https', 'http://dashboard.fro.bot'],
    ['a trailing slash', 'https://dashboard.fro.bot/'],
  ])('refuses %s and writes nothing', async (_label, origin) => {
    const world = makeWorld()

    const res = await save(await gatewayApp(world.deps), saveBody(world), {origin})

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({state: 'forbidden'})
    expectNothingWritten(world)
  })

  it('uses the Origin header and never the Host header', async () => {
    const world = makeWorld()

    const res = await save(await gatewayApp(world.deps), saveBody(world), {origin: 'https://evil.example', host: 'dashboard.fro.bot'})

    expect(res.status).toBe(403)
  })

  it.each([
    ['text/plain', 'text/plain'],
    ['form encoding', 'application/x-www-form-urlencoded'],
    ['no content type', undefined],
    ['a JSON look-alike', 'application/jsonp'],
  ])('refuses %s with 415 and writes nothing', async (_label, contentType) => {
    const world = makeWorld()

    const res = await save(await gatewayApp(world.deps), saveBody(world), {'content-type': contentType})

    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({state: 'unsupported-media-type'})
    expectNothingWritten(world)
  })

  it('accepts a JSON content type with a charset', async () => {
    const world = makeWorld()

    const res = await save(await gatewayApp(world.deps), saveBody(world), {'content-type': 'application/json; charset=utf-8'})

    expect(res.status).toBe(200)
  })

  it('sends no CORS headers on a preflight or on any response', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)

    const preflight = await app.request(`/api/wiki/pages/${ALPHA_ID}/save`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
        cookie: GATEWAY_COOKIE,
      },
    })
    const saved = await save(app, saveBody(world), {origin: ORIGIN})
    const refused = await save(app, saveBody(world), {origin: 'https://evil.example'})

    for (const res of [preflight, saved, refused]) {
      const names = [...res.headers.keys()].filter(name => name.startsWith('access-control-'))
      expect(names).toEqual([])
    }
    expect(preflight.status).not.toBe(200)
  })
})

describe('save: body bounds', () => {
  it('answers 413 for a body just over the cap, without parsing it', async () => {
    const world = makeWorld()
    const parse = vi.spyOn(JSON, 'parse')

    const res = await save(await gatewayApp(world.deps), 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1))

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({state: 'payload-too-large'})
    expect(parse.mock.calls.some(call => typeof call[0] === 'string' && call[0].startsWith('xxxx'))).toBe(false)
    expectNothingWritten(world)
  })

  it('answers 413 from the declared length alone, without reading the body', async () => {
    const world = makeWorld()

    const res = await save(await gatewayApp(world.deps), '{}', {'content-length': String(MAX_REQUEST_BODY_BYTES + 1)})

    expect(res.status).toBe(413)
  })

  it('stops reading when the stream outgrows a smaller declared length', async () => {
    const world = makeWorld()

    const res = await save(await gatewayApp(world.deps), 'y'.repeat(MAX_REQUEST_BODY_BYTES + 10), {'content-length': '10'})

    expect(res.status).toBe(413)
  })

  it('counts bytes, not characters', async () => {
    const world = makeWorld()

    const res = await save(await gatewayApp(world.deps), '\u00E9'.repeat(MAX_REQUEST_BODY_BYTES / 2 + 1))

    expect(res.status).toBe(413)
  })

  it('reads a body of exactly the cap and answers on its content', async () => {
    const world = makeWorld()

    const res = await save(await gatewayApp(world.deps), `${' '.repeat(MAX_REQUEST_BODY_BYTES - 2)}{}`)

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({state: 'rejected', reason: 'invalid-request'})
  })

  it.each([
    ['malformed JSON', '{"operationId":'],
    ['an empty body', ''],
    ['a JSON array', '[]'],
    ['a JSON string', '"save"'],
    ['JSON null', 'null'],
  ])('answers 400 for %s', async (_label, raw) => {
    const world = makeWorld()

    const res = await save(await gatewayApp(world.deps), raw)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({state: 'bad-request'})
    expectNothingWritten(world)
  })

  it.each(['repos..', 'secrets.alpha', 'repos.', 'repos.%2e%2e'])('answers 404 for a malformed page ID %j before reading the body', async id => {
    const world = makeWorld()

    const res = await save(await gatewayApp(world.deps), 'not json at all', {}, id)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({state: 'not-found'})
    expectNothingWritten(world)
  })

  it('answers a well-formed page that was removed with the page-removed conflict, not 404', async () => {
    const world = makeWorld()
    const body = saveBody(world)
    world.repo.removeFile(ALPHA)

    const res = await save(await gatewayApp(world.deps), body)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({state: 'conflict', kind: 'page-removed'})
  })
})

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe('write rate limit', () => {
  it('uses a separate, lower ceiling than the per-IP limit', () => {
    expect(WIKI_WRITE_RATE_LIMIT_MAX).toBeLessThan(60)
    expect(WIKI_WRITE_RATE_LIMIT_MAX).toBeGreaterThan(0)
  })

  it('returns the rate-limited outcome with a retry hint once the operator is over the ceiling', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)

    for (let index = 0; index < WIKI_WRITE_RATE_LIMIT_MAX; index += 1) {
      const res = await save(app, 'not json')
      expect(res.status).toBe(400)
    }
    const limited = await save(app, saveBody(world))

    expect(limited.status).toBe(429)
    const body = (await limited.json()) as {state: string; retryAfterSeconds: number}
    expect(body.state).toBe('rate-limited')
    expect(body.retryAfterSeconds).toBeGreaterThan(0)
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(60)
    expect(limited.headers.get('retry-after')).toBe(String(body.retryAfterSeconds))
    expectNothingWritten(world)
  })

  it('does not rate-limit a refused request against the operator key', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps, () => ({...SESSION, operatorId: 2}))

    for (let index = 0; index < WIKI_WRITE_RATE_LIMIT_MAX + 3; index += 1) {
      expect((await save(app, saveBody(world))).status).toBe(403)
    }
  })

  it('leaves the per-IP ceiling unchanged and independent of the operator key', () => {
    const now = 1_000_000
    for (let index = 0; index < 200; index += 1) consumeRateLimit('operator:1', WIKI_WRITE_RATE_LIMIT_MAX, now)

    expect(consumeRateLimit('operator:1', WIKI_WRITE_RATE_LIMIT_MAX, now).allowed).toBe(false)
    expect(consumeRateLimit('operator:2', WIKI_WRITE_RATE_LIMIT_MAX, now).allowed).toBe(true)
    for (let index = 0; index < 60; index += 1) expect(checkRateLimit('203.0.113.9', now)).toBe(true)
    expect(checkRateLimit('203.0.113.9', now)).toBe(false)
  })

  it('reports the seconds left in the window as the retry hint', () => {
    const start = 5_000_000
    for (let index = 0; index < 3; index += 1) consumeRateLimit('operator:7', 3, start)

    const blocked = consumeRateLimit('operator:7', 3, start + 20_000)

    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBe(40)
    expect(consumeRateLimit('operator:7', 3, start + 60_001).allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Outcome to response mapping
// ---------------------------------------------------------------------------

describe('save: outcome to response mapping', () => {
  const COMMIT = {commitSha: 'c0ffee', committedAt: '2030-01-01T00:00:00.000Z', operationId: opId(1)}
  const OUTCOMES: [string, SaveResult, number][] = [
    ['saved', {state: 'saved', ...COMMIT}, 200],
    ['saved-not-promoted', {state: 'saved-not-promoted', ...COMMIT}, 202],
    ['rejected', {state: 'rejected', reason: 'gate', findings: [{kind: 'unsafe-html', path: ALPHA, message: 'm'}]}, 422],
    ['conflict (page)', {state: 'conflict', kind: 'page', currentBlobSha: 'blob-x'}, 409],
    ['conflict (page-removed)', {state: 'conflict', kind: 'page-removed'}, 409],
    ['conflict (corrections)', {state: 'conflict', kind: 'corrections', currentCorrections: [], correctionsBase: 'a'.repeat(64)}, 409],
    ['failed', {state: 'failed', operationId: opId(1), retryable: true}, 502],
    ['contract-rejected (mismatch)', {state: 'contract-rejected', kind: 'mismatch', retry: false}, 424],
    ['contract-rejected (unreadable)', {state: 'contract-rejected', kind: 'unreadable', retry: true}, 424],
    ['indeterminate', {state: 'indeterminate', operationId: opId(1)}, 504],
    ['rate-limited', {state: 'rate-limited', retryAfterSeconds: 12}, 429],
  ]

  // Exhaustive over the save outcomes: a new state fails type-check until it has a status family.
  const STATUS_FAMILY = {
    saved: 200,
    'saved-not-promoted': 202,
    rejected: 422,
    conflict: 409,
    failed: 502,
    'contract-rejected': 424,
    indeterminate: 504,
    'rate-limited': 429,
  } as const satisfies Record<SaveResult['state'], number>

  it('gives every outcome its own status family', () => {
    expect(new Set(Object.values(STATUS_FAMILY)).size).toBe(Object.keys(STATUS_FAMILY).length)
    for (const [, outcome, status] of OUTCOMES) expect(status, outcome.state).toBe(STATUS_FAMILY[outcome.state])
    expect(new Set(OUTCOMES.map(([, outcome]) => outcome.state))).toEqual(new Set(Object.keys(STATUS_FAMILY)))
  })

  it.each(OUTCOMES)('maps %s to %d with the outcome as the body', async (_label, outcome, status) => {
    const world = makeWorld()
    const saveStub = vi.fn(async (_input: unknown, _context: {operatorLogin: string}) => outcome)
    const deps: WikiAppDeps = {
      ...world.deps,
      write: {
        operation: {save: saveStub, lookup: vi.fn()},
        dispatch: {dispatch: vi.fn()},
        status: {getStatus: vi.fn()},
      },
    }

    const res = await save(await gatewayApp(deps), saveBody(world))

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual(outcome)
    if (outcome.state === 'rate-limited') expect(res.headers.get('retry-after')).toBe('12')
    else expect(res.headers.get('retry-after')).toBeNull()
    expect(saveStub).toHaveBeenCalledTimes(1)
    expect(saveStub.mock.calls[0]?.[1]).toEqual({operatorLogin: LOGIN})
  })

  it('passes the page ID from the route and ignores one in the body', async () => {
    const world = makeWorld()
    const saveStub = vi.fn(async (_input: unknown, _context: {operatorLogin: string}): Promise<SaveResult> => ({state: 'rejected', reason: 'no-change'}))
    const deps: WikiAppDeps = {
      ...world.deps,
      write: {operation: {save: saveStub, lookup: vi.fn()}, dispatch: {dispatch: vi.fn()}, status: {getStatus: vi.fn()}},
    }

    await save(await gatewayApp(deps), {...saveBody(world), pageId: BETA_ID})

    expect(saveStub.mock.calls[0]?.[0]).toMatchObject({pageId: ALPHA_ID})
  })

  it('carries the body discriminant in every real outcome', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)

    const rejected = await save(app, saveBody(world, {body: `${ALPHA_BODY}\n<script>x</script>\n`, operationId: opId(2)}))
    const conflict = await save(app, saveBody(world, {pageBlobSha: 'stale', operationId: opId(3)}))
    const saved = await save(app, saveBody(world, {operationId: opId(4)}))

    for (const res of [rejected, conflict, saved]) expect(await res.json()).toHaveProperty('state')
    expect(rejected.status).toBe(422)
    expect(conflict.status).toBe(409)
    expect(saved.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Retry dispatch, lookup, status
// ---------------------------------------------------------------------------

describe('POST /api/wiki/promotion/dispatch', () => {
  const dispatchRequest = async (app: Awaited<ReturnType<typeof gatewayApp>>, headers: Record<string, string | undefined> = {}, body = '{}') => {
    const merged = {...WRITE_HEADERS, ...headers}
    const clean = Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined))
    return app.request('/api/wiki/promotion/dispatch', {method: 'POST', headers: clean, body})
  }

  it('sends the dispatch through the port and commits nothing', async () => {
    const world = makeWorld()

    const res = await dispatchRequest(await gatewayApp(world.deps))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({state: 'dispatched'})
    expect(world.repo.count('createDispatch')).toBe(1)
    expect(world.repo.count('createCommit')).toBe(0)
    expect(world.repo.count('updateRef')).toBe(0)
  })

  it('reports a failed dispatch as 502 dispatch-failed', async () => {
    const world = makeWorld()
    world.repo.hooks.onCall = method => {
      if (method === 'createDispatch') throw new HttpError('Bad Gateway', 502)
    }

    const res = await dispatchRequest(await gatewayApp(world.deps))

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({state: 'dispatch-failed'})
  })

  it('reports a rate-limited dispatch with its hint', async () => {
    const world = makeWorld()
    world.repo.hooks.onCall = method => {
      if (method === 'createDispatch') throw new HttpError('API rate limit exceeded', 403, {'retry-after': '33'})
    }

    const res = await dispatchRequest(await gatewayApp(world.deps))

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({state: 'rate-limited', retryAfterSeconds: 33})
    expect(res.headers.get('retry-after')).toBe('33')
  })

  it.each([
    ['another operator', 2, undefined],
    ['a wrong origin', OPERATOR_ID, {origin: 'https://evil.example'}],
    ['a missing origin', OPERATOR_ID, {origin: undefined}],
  ] as const)('refuses %s with 403 and dispatches nothing', async (_label, operatorId, headers) => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps, () => ({...SESSION, operatorId}))

    const res = await dispatchRequest(app, headers)

    expect(res.status).toBe(403)
    expect(world.repo.count('createDispatch')).toBe(0)
  })

  it('refuses a non-JSON content type with 415', async () => {
    const world = makeWorld()

    const res = await dispatchRequest(await gatewayApp(world.deps), {'content-type': 'text/plain'})

    expect(res.status).toBe(415)
    expect(world.repo.count('createDispatch')).toBe(0)
  })

  it('refuses when write capability is off', async () => {
    const world = makeWorld({capabilityOff: true})

    expect((await dispatchRequest(await gatewayApp(world.deps))).status).toBe(403)
  })

  it('accepts an empty body and refuses malformed JSON', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)

    expect((await dispatchRequest(app, {}, '')).status).toBe(200)
    expect((await dispatchRequest(app, {}, '{')).status).toBe(400)
  })
})

describe('GET /api/wiki/operations/:operationId', () => {
  const lookup = async (app: Awaited<ReturnType<typeof gatewayApp>>, query: string, id = opId(1)) =>
    get(app, `/api/wiki/operations/${id}?${query}`)

  it('finds a save by operation ID', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)
    const startedAt = world.repo.clockMs
    const saved = (await (await save(app, saveBody(world))).json()) as {commitSha: string}

    const res = await lookup(app, `pageId=${ALPHA_ID}&startedAt=${startedAt}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      state: 'found',
      commitSha: saved.commitSha,
      committedAt: world.repo.commit(saved.commitSha).committedAt,
    })
  })

  it('says missing, and unknown when history cannot be listed', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)

    expect(await (await lookup(app, `pageId=${ALPHA_ID}&startedAt=${world.repo.clockMs}`)).json()).toEqual({state: 'missing'})

    world.repo.hooks.onCall = method => {
      if (method === 'listCommitsByPath') throw new HttpError('Bad Gateway', 502)
    }
    expect(await (await lookup(app, `pageId=${ALPHA_ID}&startedAt=${world.repo.clockMs}`)).json()).toEqual({state: 'unknown'})
  })

  it.each([
    ['a missing page ID', 'startedAt=1'],
    ['a bad page ID', 'pageId=..&startedAt=1'],
    ['a missing start time', `pageId=${ALPHA_ID}`],
    ['a fractional start time', `pageId=${ALPHA_ID}&startedAt=1.5`],
    ['a non-numeric start time', `pageId=${ALPHA_ID}&startedAt=soon`],
    ['a start time above the Date range', `pageId=${ALPHA_ID}&startedAt=9999999999999999`],
    ['a start time just above the Date range', `pageId=${ALPHA_ID}&startedAt=8640000000000001`],
    ['an unsafe integer start time', `pageId=${ALPHA_ID}&startedAt=9007199254740993`],
  ])('answers 400 for %s', async (_label, query) => {
    const world = makeWorld()

    const res = await lookup(await gatewayApp(world.deps), query)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({state: 'invalid-request'})
    expect(world.repo.calls).toHaveLength(0)
  })

  describe('per-operator rate limit', () => {
    const query = () => `pageId=${ALPHA_ID}&startedAt=1`

    it('answers 429 with a Retry-After header on the 11th lookup in a minute', async () => {
      const world = makeWorld()
      const app = await gatewayApp(world.deps)

      for (let index = 0; index < WIKI_WRITE_RATE_LIMIT_MAX; index += 1) {
        expect((await lookup(app, query())).status).toBe(200)
      }
      const limited = await lookup(app, query())

      expect(limited.status).toBe(429)
      const body = (await limited.json()) as {state: string; retryAfterSeconds: number}
      expect(body.state).toBe('rate-limited')
      expect(body.retryAfterSeconds).toBeGreaterThan(0)
      expect(limited.headers.get('retry-after')).toBe(String(body.retryAfterSeconds))
      expect(limited.headers.get('cache-control')).toBe('no-store')
    })

    it('does not read GitHub for a limited lookup', async () => {
      const world = makeWorld()
      const app = await gatewayApp(world.deps)
      for (let index = 0; index < WIKI_WRITE_RATE_LIMIT_MAX; index += 1) await lookup(app, query())
      const before = world.repo.calls.length

      await lookup(app, query())

      expect(world.repo.calls.length).toBe(before)
    })

    it('shares the operator key with saves, so lookups cannot starve another operator', async () => {
      const world = makeWorld()
      const app = await gatewayApp(world.deps)
      const other = await gatewayApp(world.deps, () => ({...SESSION, operatorId: 99999}))
      for (let index = 0; index < WIKI_WRITE_RATE_LIMIT_MAX; index += 1) await lookup(app, query())

      expect((await save(app, saveBody(world))).status).toBe(429)
      expect(world.repo.count('createCommit')).toBe(0)
      expect((await lookup(other, query())).status).toBe(200)
    })

    it('does not apply the operator limit to a session with no identity match', async () => {
      const world = makeWorld()
      const other = await gatewayApp(world.deps, () => ({...SESSION, operatorId: 99999}))

      for (let index = 0; index < WIKI_WRITE_RATE_LIMIT_MAX + 5; index += 1) {
        expect((await lookup(other, query())).status).toBe(200)
      }
    })

    it('keeps the access rule: write capability configured, no identity match needed', async () => {
      const off = makeWorld({capabilityOff: true})
      const unmatched = makeWorld()

      expect((await lookup(await gatewayApp(off.deps), query())).status).toBe(403)
      expect((await lookup(await gatewayApp(unmatched.deps, () => ({...SESSION, operatorId: 99999})), query())).status).toBe(200)
    })

    it('counts a malformed lookup against the operator key', async () => {
      const world = makeWorld()
      const app = await gatewayApp(world.deps)

      for (let index = 0; index < WIKI_WRITE_RATE_LIMIT_MAX; index += 1) {
        expect((await lookup(app, 'pageId=..&startedAt=1')).status).toBe(400)
      }

      expect((await lookup(app, query())).status).toBe(429)
    })

    it('leaves the per-IP ceiling to the existing middleware for an unmatched session', async () => {
      const world = makeWorld()
      const other = await gatewayApp(world.deps, () => ({...SESSION, operatorId: 99999}))

      for (let index = 0; index < 60; index += 1) await lookup(other, query())
      const over = await lookup(other, query())

      expect(over.status).toBe(429)
      expect(await over.text()).toBe('Too Many Requests')
    })
  })

  it('accepts the largest start time the Date range holds', async () => {
    const world = makeWorld()

    const res = await lookup(await gatewayApp(world.deps), `pageId=${ALPHA_ID}&startedAt=8640000000000000`)

    expect(res.status).toBe(200)
  })

  it('answers 400 for a malformed operation ID', async () => {
    const world = makeWorld()

    expect((await lookup(await gatewayApp(world.deps), `pageId=${ALPHA_ID}&startedAt=1`, 'nope')).status).toBe(400)
  })

  it('answers 403 when write capability is not configured', async () => {
    const world = makeWorld({capabilityOff: true})

    expect((await lookup(await gatewayApp(world.deps), `pageId=${ALPHA_ID}&startedAt=1`)).status).toBe(403)
  })
})

describe('GET /api/wiki/promotion/status', () => {
  it('reports pending, settled, and blocked from the real reader', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)

    world.runs.value = [{id: 1, status: 'in_progress', conclusion: null, event: 'repository_dispatch', created_at: '2030-01-01T00:00:00Z', html_url: 'x'}]
    const pending = await get(app, '/api/wiki/promotion/status')
    expect(pending.status).toBe(200)
    expect(pending.headers.get('cache-control')).toBe('no-store')
    expect(await pending.json()).toEqual({state: 'pending', pr: null})

    world.repo.advance(60_000)
    world.pulls.value = [{number: 7, html_url: 'x', created_at: '2030-01-01T00:00:00Z'}]
    world.runs.value = [{id: 2, status: 'completed', conclusion: 'success', event: 'repository_dispatch', created_at: '2030-01-01T00:01:00Z', html_url: 'x'}]
    expect(await (await get(app, '/api/wiki/promotion/status')).json()).toEqual({
      state: 'settled',
      pr: {number: 7, url: 'https://github.com/fro-bot/.github/pull/7'},
    })
  })

  it('passes since to the reader', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)
    world.runs.value = [{id: 1, status: 'completed', conclusion: 'success', event: 'schedule', created_at: '2030-01-01T00:00:00Z', html_url: 'x'}]

    const res = await get(app, `/api/wiki/promotion/status?since=${encodeURIComponent('2030-01-02T00:00:00Z')}`)

    expect(await res.json()).toEqual({state: 'pending', pr: null})
  })

  it('maps unavailable to 503 and a configuration fault to 502', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)
    world.repo.hooks.onCall = method => {
      if (method === 'listWorkflowRuns') throw new HttpError('Bad Gateway', 502)
    }
    const unavailable = await get(app, '/api/wiki/promotion/status')
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({state: 'unavailable'})

    world.repo.advance(60_000)
    world.repo.hooks.onCall = method => {
      if (method === 'listWorkflowRuns') throw new HttpError('Not Found', 404)
    }
    const fault = await get(app, '/api/wiki/promotion/status')
    expect(fault.status).toBe(502)
    expect(await fault.json()).toEqual({state: 'configuration-fault'})
  })

  it.each([
    ['text', 'yesterday'],
    ['a malformed date', '2030-13-45T99:99:99Z'],
    ['an empty value', ''],
    ['an out-of-range date', '+275760-09-13T00:00:01.000Z'],
  ])('rejects a since of %s with 400 and does not read GitHub', async (_label, since) => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)
    const before = world.repo.calls.length

    const res = await get(app, `/api/wiki/promotion/status?since=${encodeURIComponent(since)}`)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({state: 'bad-request'})
    expect(world.repo.calls.length).toBe(before)
  })

  it('accepts a valid ISO since', async () => {
    const world = makeWorld()

    const res = await get(await gatewayApp(world.deps), `/api/wiki/promotion/status?since=${encodeURIComponent('2030-01-02T00:00:00.000Z')}`)

    expect(res.status).toBe(200)
  })

  it('rejects an overlong since with 400', async () => {
    const world = makeWorld()

    const res = await get(await gatewayApp(world.deps), `/api/wiki/promotion/status?since=${'1'.repeat(200)}`)

    expect(res.status).toBe(400)
  })

  it('answers 403 when write capability is not configured', async () => {
    const world = makeWorld({capabilityOff: true})

    expect((await get(await gatewayApp(world.deps), '/api/wiki/promotion/status')).status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Shell route and public paths
// ---------------------------------------------------------------------------

describe('GET /wiki/:id shell', () => {
  it('serves the SPA shell for a one-segment page path behind the session', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)

    const res = await get(app, `/wiki/${ALPHA_ID}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<div id="root"></div>')
  })

  it('injects the push meta tag when push is enabled and sends a matching content length', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps, () => SESSION, {pushNotificationsEnabled: true})

    for (const path of ['/', `/wiki/${ALPHA_ID}`]) {
      const res = await get(app, path)
      const text = await res.text()
      expect(text).toContain('<meta name="push-enabled" content="true">')
      expect(text).toContain('<div id="root"></div>')
      const declared = res.headers.get('content-length')
      if (declared !== null) expect(Number(declared)).toBe(Buffer.byteLength(text, 'utf8'))
    }
  })

  it('serves the same shell as / when push is off', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)

    const root = await (await get(app, '/')).text()
    const wiki = await (await get(app, `/wiki/${ALPHA_ID}`)).text()

    expect(wiki).toBe(root)
    expect(wiki).not.toContain('push-enabled')
  })

  it.each([
    ['a nested path', '/wiki/repos.a/b'],
    ['a malformed ID', '/wiki/repos..'],
    ['an unknown type', '/wiki/secrets.alpha'],
    ['an encoded slash', '/wiki/repos.a%2Fb'],
    ['a trailing slash', `/wiki/${ALPHA_ID}/`],
    ['the bare index', '/wiki/'],
    ['the bare wiki path', '/wiki'],
  ])('does not serve the shell for %s', async (_label, path) => {
    const world = makeWorld()

    const res = await get(await gatewayApp(world.deps), path)

    expect(res.status).toBe(404)
  })

  it('redirects an unauthenticated request to login and sets the return cookie', async () => {
    const world = makeWorld()
    const res = await (await gatewayApp(world.deps)).request(`/wiki/${ALPHA_ID}`)

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/auth/github/start?return_to=/operator')
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('wiki_return=')
    expect(cookie).toContain(encodeURIComponent(`/wiki/${ALPHA_ID}`))
    expect(cookie).toMatch(/HttpOnly/iu)
    expect(cookie).toMatch(/SameSite=Lax/iu)
    expect(cookie).toMatch(/Secure/iu)
  })

  it('sets no return cookie when the unauthenticated request is not for a page', async () => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)

    for (const path of ['/', '/wiki/repos.a/b', '/wiki/repos..', '/api/wiki/pages']) {
      const res = await app.request(path)
      expect(res.status).toBe(302)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
  })

  it('sets the return cookie in Arctic mode too, and leaves it non-Secure under loopback autologin only', async () => {
    const world = makeWorld()
    const arctic = await buildDashboardApp({operatorLogin: LOGIN, cookieKey: TEST_KEY, wiki: world.deps, webDistRoot: SHELL_ROOT})

    const res = await arctic.request(`/wiki/${ALPHA_ID}`)

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Secure/iu)
  })
})

describe('public paths', () => {
  const PINNED_PUBLIC_LITERALS = [
    '/api/healthz',
    '/auth/login',
    '/auth/callback',
    '/auth/logout',
    '/assets/',
    '/manifest.webmanifest',
    '/icon-',
    '/sw.js',
    '/registerSW.js',
    '/privacy',
    '/privacy/',
    '/api/listener/ingest',
    '/static/operator-stream.js',
    '/static/operator-launch.js',
    '/static/operator-run-index.js',
    '/static/operator-time.js',
    '/static/',
  ]

  it('keeps the auth middleware public path list exactly as pinned', () => {
    const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
    const start = source.indexOf('const isPublicPath')
    const end = source.indexOf("app.use('*', async (c: Context, next) => {", start)
    const literals = [...source.slice(start, end).matchAll(/'(\/[^']*)'/gu)].map(match => match[1])

    expect(literals).toEqual(PINNED_PUBLIC_LITERALS)
  })

  it.each([
    `/wiki/${ALPHA_ID}`,
    '/wiki/repos.x',
    '/api/wiki/pages',
    `/api/wiki/pages/${ALPHA_ID}`,
    '/api/wiki/promotion/status',
    '/api/wiki/operations/x',
  ])('does not make %s public', async path => {
    const world = makeWorld()
    const app = await gatewayApp(world.deps)

    expect((await app.request(path)).status).toBe(302)
    expect((await app.request(path, {method: 'POST'})).status).toBe(302)
  })

  it('does not make wiki paths public in Arctic mode either', async () => {
    const world = makeWorld()
    const app = await buildDashboardApp({operatorLogin: LOGIN, cookieKey: TEST_KEY, wiki: world.deps, webDistRoot: SHELL_ROOT})

    for (const path of [`/wiki/${ALPHA_ID}`, '/api/wiki/pages']) expect((await app.request(path)).status).toBe(302)
  })

  it('denies the wiki paths with 401 when no operator login is configured', async () => {
    const world = makeWorld()
    const app = await buildDashboardApp({wiki: world.deps, webDistRoot: SHELL_ROOT})

    for (const path of [`/wiki/${ALPHA_ID}`, '/api/wiki/pages']) expect((await app.request(path)).status).toBe(401)
  })
})

describe('a server with no wiki configuration', () => {
  it('still boots, answers wiki reads as unavailable, and refuses writes', async () => {
    const app = await buildDashboardApp({
      cookieKey: TEST_KEY,
      gatewayOperatorSessionEnabled: true,
      gatewayOperatorOrigin: ORIGIN,
      operatorClient: fakeOperatorClient(() => SESSION),
      webDistRoot: SHELL_ROOT,
    })

    expect((await get(app, '/api/wiki/pages')).status).toBe(503)
    expect((await save(app, {})).status).toBe(403)
    expect((await get(app, '/')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('logging', () => {
  it('logs the route template, status class, and operation ID, and never bodies, IDs, origins, or cookies', async () => {
    const lines: string[] = []
    const sink = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(sink)

    const world = makeWorld()
    const app = await gatewayApp(world.deps)
    await get(app, `/api/wiki/pages/${ALPHA_ID}`)
    await save(app, saveBody(world, {body: `${ALPHA_BODY.replace('widgets', 'gadgets')}\nSECRET-BODY-TEXT\n`, operationId: opId(9)}))
    await save(app, saveBody(world, {operationId: opId(8)}), {origin: 'https://evil.example'})
    await (await gatewayApp(world.deps)).request(`/wiki/${ALPHA_ID}`)
    await get(app, '/api/wiki/pages/repos.no-such-page')

    const output = lines.join('\n')
    expect(output).toContain('/api/wiki/pages/:id/save')
    expect(output).toContain('"status":"2xx"')
    expect(output).toContain('"status":"4xx"')
    expect(output).toContain(opId(9))
    for (const secret of ['SECRET-BODY-TEXT', 'acme', 'octocat', 'evil.example', 'abc', ALPHA_ID, 'no-such-page', 'gadgets']) {
      expect(output).not.toContain(secret)
    }
  })
})

// ---------------------------------------------------------------------------
// Wire conformance
// ---------------------------------------------------------------------------

/** Regenerating the sample file moves the contract the client parser reads. It is a local act, never a CI one. */
function assertSamplesMayBeRewritten(environment: Record<string, string | undefined>): void {
  if (environment.CI !== undefined && environment.CI !== '') {
    throw new Error('WIKI_WIRE_SAMPLES_UPDATE must not be set in CI')
  }
}

describe('wire conformance', () => {
  interface Sample {
    readonly status: number
    readonly body: unknown
  }

  async function produce(): Promise<Record<string, Record<string, Sample>>> {
    // Each variant runs on its own world with a clean write limit, so a sample never
    // depends on what another variant did.
    const run = async (
      overrides: Parameters<typeof makeWorld>[0],
      act: (app: Awaited<ReturnType<typeof gatewayApp>>, world: World) => Promise<Response>,
      prepare: (world: World) => void = () => {},
    ): Promise<Sample> => {
      resetRateLimitForTesting()
      const world = makeWorld(overrides)
      prepare(world)
      const res = await act(await gatewayApp(world.deps), world)
      return {status: res.status, body: (await res.json())}
    }
    const failOn = (method: string, error: unknown) => (world: World) => {
      world.repo.hooks.onCall = called => {
        if (called === method) throw error
      }
    }
    const withCorrection = {files: wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets'))})}
    const mismatchDecision: GateContractDecision = {
      proceed: false,
      reason: 'version_mismatch',
      marker: {version: GATE_CONTRACT_VERSION + 1, sourceTreeHash: 's'},
      readiness: {ready: false, stale: false, mainHeadSha: null},
    }
    const unreadableDecision: GateContractDecision = {
      proceed: false,
      reason: 'unavailable',
      readiness: {ready: false, stale: true, mainHeadSha: null},
    }
    const treeFails = failOn('getTree', new HttpError('Bad Gateway', 502))
    const lookupPath = (_world: World, id: number, startedAt: number) =>
      `/api/wiki/operations/${opId(id)}?pageId=${ALPHA_ID}&startedAt=${startedAt}`
    const dispatchRequest = async (app: Awaited<ReturnType<typeof gatewayApp>>) =>
      app.request('/api/wiki/promotion/dispatch', {method: 'POST', headers: WRITE_HEADERS, body: '{}'})
    const status = async (app: Awaited<ReturnType<typeof gatewayApp>>) => get(app, '/api/wiki/promotion/status')
    const run1 = (id: number, runStatus: string, conclusion: string | null, event: string, createdAt: string) => ({
      id,
      status: runStatus,
      conclusion,
      event,
      created_at: createdAt,
      html_url: 'x',
    })

    const savedLookup = await (async () => {
      resetRateLimitForTesting()
      const world = makeWorld()
      const app = await gatewayApp(world.deps)
      const startedAt = world.repo.clockMs
      const saved = await save(app, saveBody(world))
      const found = await get(app, lookupPath(world, 1, startedAt))
      return {
        saved: {status: saved.status, body: (await saved.json())},
        found: {status: found.status, body: (await found.json())},
      }
    })()

    return {
      list: {
        ok: await run(withCorrection, async app => get(app, '/api/wiki/pages')),
        unavailable: await run({}, async app => get(app, '/api/wiki/pages'), treeFails),
      },
      page: {
        ok: await run(withCorrection, async app => get(app, `/api/wiki/pages/${ALPHA_ID}`)),
        contractMismatch: await run({decision: mismatchDecision}, async app => get(app, `/api/wiki/pages/${ALPHA_ID}`)),
        contractUnreadable: await run({decision: unreadableDecision}, async app => get(app, `/api/wiki/pages/${ALPHA_ID}`)),
        notFound: await run({}, async app => get(app, '/api/wiki/pages/repos.no-such-page')),
        unavailable: await run({}, async app => get(app, `/api/wiki/pages/${ALPHA_ID}`), treeFails),
        correctionsCorrupt: await run({files: wikiFiles({[CORRECTIONS]: ''})}, async app => get(app, `/api/wiki/pages/${ALPHA_ID}`)),
        pageInvalid: await run(
          {files: wikiFiles({[ALPHA]: 'no frontmatter at all\n'})},
          async app => get(app, `/api/wiki/pages/${ALPHA_ID}`),
        ),
      },
      save: {
        saved: savedLookup.saved,
        notPromoted: await run({}, async (app, w) => save(app, saveBody(w)), failOn('createDispatch', new HttpError('Bad Gateway', 502))),
        rejected: await run({}, async (app, w) => save(app, saveBody(w, {body: `${ALPHA_BODY}\n<script>x</script>\n`}))),
        rejectedWithTarget: await run({}, async (app, w) =>
          save(app, saveBody(w, {body: `${ALPHA_BODY}\nSee [x](./secret-page-name.md).\n`})),
        ),
        contractRejected: await run({decision: mismatchDecision}, async (app, w) => save(app, saveBody(w))),
        contractUnreadable: await run({decision: unreadableDecision}, async (app, w) => save(app, saveBody(w))),
        conflictPage: await run({}, async (app, w) => save(app, saveBody(w, {pageBlobSha: 'stale-blob'}))),
        conflictPageRemoved: await run({}, async (app, w) => {
          const body = saveBody(w)
          w.repo.removeFile(ALPHA)
          return save(app, body)
        }),
        conflictCorrections: await run(
          withCorrection,
          async (app, w) => save(app, saveBody(w, {transitions: [{id: 'c1', action: 'retire'}], correctionsBase: 'f'.repeat(64)})),
        ),
        failed: await run({}, async (app, w) => save(app, saveBody(w)), failOn('createBlob', new HttpError('Bad Gateway', 502))),
        failedRefused: await run(
          {},
          async (app, w) => save(app, saveBody(w)),
          failOn('getRef', new WriteCredentialError('Failed to mint a write token: refused', 403)),
        ),
        indeterminate: await run({}, async (app, w) => save(app, saveBody(w)), w => {
          w.repo.hooks.beforeUpdateRef = () => {
            throw new HttpError('Request timed out', 500)
          }
        }),
        limited: await run(
          {},
          async (app, w) => save(app, saveBody(w)),
          failOn('getRef', new HttpError('API rate limit exceeded', 403, {'retry-after': '17'})),
        ),
        forbidden: await run({}, async (app, w) => save(app, saveBody(w), {origin: 'https://evil.example'})),
        unsupported: await run({}, async (app, w) => save(app, saveBody(w), {'content-type': 'text/plain'})),
        tooLarge: await run({}, async app => save(app, 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1))),
        badRequest: await run({}, async app => save(app, '{')),
      },
      lookup: {
        found: savedLookup.found,
        missing: await run({}, async (app, w) => get(app, lookupPath(w, 7, w.repo.clockMs))),
        unknown: await run({}, async (app, w) => get(app, lookupPath(w, 5, w.repo.clockMs)), failOn('listCommitsByPath', new HttpError('Bad Gateway', 502))),
        invalidRequest: await run({}, async app => get(app, `/api/wiki/operations/${opId(5)}?pageId=${ALPHA_ID}`)),
        forbidden: await run({capabilityOff: true}, async (app, w) => get(app, lookupPath(w, 5, w.repo.clockMs))),
      },
      dispatch: {
        dispatched: await run({}, async app => dispatchRequest(app)),
        failed: await run({}, async app => dispatchRequest(app), failOn('createDispatch', new HttpError('Bad Gateway', 502))),
        limited: await run(
          {},
          async app => dispatchRequest(app),
          failOn('createDispatch', new HttpError('API rate limit exceeded', 403, {'retry-after': '33'})),
        ),
      },
      status: {
        pending: await run({}, async app => status(app), w => {
          w.runs.value = [run1(1, 'in_progress', null, 'repository_dispatch', '2030-01-01T00:00:00Z')]
        }),
        settled: await run({}, async app => status(app), w => {
          w.pulls.value = [{number: 7, html_url: 'x', created_at: '2030-01-01T00:00:00Z'}]
          w.runs.value = [run1(2, 'completed', 'success', 'repository_dispatch', '2030-01-01T00:01:00Z')]
        }),
        blocked: await run({}, async app => status(app), w => {
          w.runs.value = [run1(3, 'completed', 'failure', 'schedule', '2030-01-01T00:02:00Z')]
          w.jobs.value = [{name: 'j', conclusion: 'failure', steps: [{name: '\uD83D\uDD12 Block private wiki pages', conclusion: 'failure'}]}]
        }),
        unavailable: await run({}, async app => status(app), failOn('listWorkflowRuns', new HttpError('Bad Gateway', 502))),
        configurationFault: await run({}, async app => status(app), failOn('listWorkflowRuns', new HttpError('Not Found', 404))),
        badRequest: await run({}, async app => get(app, '/api/wiki/promotion/status?since=yesterday')),
        forbidden: await run({capabilityOff: true}, async app => status(app)),
      },
    }
  }

  it('matches every response shape to the shared sample file, byte for byte', async () => {
    const produced = await produce()

    if (env.WIKI_WIRE_SAMPLES_UPDATE === '1') {
      assertSamplesMayBeRewritten(env)
      writeFileSync(SAMPLES_PATH, `${JSON.stringify(produced, null, 2)}\n`)
    }
    const samples = JSON.parse(readFileSync(SAMPLES_PATH, 'utf8')) as unknown

    expect(produced).toEqual(samples)
  })

  it('refuses to rewrite the samples when CI is set', () => {
    expect(() => assertSamplesMayBeRewritten({CI: 'true'})).toThrow(/CI/u)
    expect(() => assertSamplesMayBeRewritten({CI: '1'})).toThrow(/CI/u)
    expect(() => assertSamplesMayBeRewritten({})).not.toThrow()
    expect(() => assertSamplesMayBeRewritten({CI: ''})).not.toThrow()
  })

  it('keeps the sample file free of repository secrets and raw records', () => {
    const text = readFileSync(SAMPLES_PATH, 'utf8')

    expect(text).not.toContain('"record"')
    expect(text).not.toContain('LOG-TEXT')
    expect(text).toContain('"state"')
  })
})
