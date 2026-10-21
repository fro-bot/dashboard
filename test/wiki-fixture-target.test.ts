/**
 * The fixture write target behind the real /api/wiki routes.
 *
 * Every fault page is driven through the real routes, the real write operation,
 * the real gates and the real promotion reader. Only the Git Data transport is
 * in memory.
 */

import type {FixtureWikiTarget} from '../src/wiki/fixture-target.ts'
import type {SaveResult} from '../src/wiki/write-operation.ts'

import {Buffer} from 'node:buffer'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {buildDashboardApp, resetRateLimitForTesting} from '../src/server.ts'
import {SessionManager} from '../src/session.ts'
import {readWikiWriteConfig} from '../src/wiki/config.ts'
import {
  buildFixtureWikiDeps,
  FIXTURE_RUN_DURATION_MS,
  fixtureOriginFor,
  FIXTURE_PAGE_IDS as IDS,
} from '../src/wiki/fixture-target.ts'
import {parsePageId} from '../src/wiki/paths.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8')
const PORT = 4821
const ORIGIN = `http://127.0.0.1:${PORT}`
const LOGIN = 'fixture-operator'
const START_MS = Date.parse('2030-06-01T12:00:00Z')
const PR_URL = 'https://github.com/fro-bot/.github/pull/4100'

let shellRoot = ''

beforeEach(() => {
  resetRateLimitForTesting()
  shellRoot = mkdtempSync(join(tmpdir(), 'wiki-fixture-shell-'))
  mkdirSync(shellRoot, {recursive: true})
  writeFileSync(join(shellRoot, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(shellRoot, {recursive: true, force: true})
})

function opId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

interface PageBody {
  id: string
  body: string
  pageBlobSha: string
  correctionsBase: string
  nodeId: string | null
  canMark: boolean
  canWrite: boolean
  canWriteReason: string | null
  contract: {ok: boolean; kind?: string; retry?: boolean}
  corrections: {id: string; status: string; stale: boolean}[]
}

interface World {
  readonly target: FixtureWikiTarget
  readonly clock: {ms: number}
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
}

/** A fixture target mounted on the real app through the injected wiki seam, so tests can inspect the repo. */
async function makeWorld(): Promise<World> {
  const clock = {ms: START_MS}
  const target = buildFixtureWikiDeps({dashboardOrigin: ORIGIN, operatorLogin: LOGIN, now: () => clock.ms})
  const app = await buildDashboardApp({
    operatorLogin: LOGIN,
    cookieKey: TEST_KEY,
    devAutoLogin: true,
    wiki: target.deps,
    webDistRoot: shellRoot,
  })
  return {target, clock, request: async (path, init) => app.request(path, init)}
}

const WRITE_HEADERS = {origin: ORIGIN, 'content-type': 'application/json'}

async function readPage(world: World, id: string): Promise<PageBody> {
  const res = await world.request(`/api/wiki/pages/${id}`)
  expect(res.status, `GET ${id}`).toBe(200)
  return (await res.json()) as PageBody
}

function saveBodyFor(model: PageBody, n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: opId(n),
    pageBlobSha: model.pageBlobSha,
    correctionsBase: model.correctionsBase,
    body: `${model.body}\nEdited in the fixture.\n`,
    marks: [],
    transitions: [],
    ...overrides,
  }
}

async function postSave(world: World, id: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return world.request(`/api/wiki/pages/${id}/save`, {
    method: 'POST',
    headers: {...WRITE_HEADERS, ...headers},
    body: JSON.stringify(body),
  })
}

/** Open the page, as the editor does, then save an edit. */
async function openAndSave(
  world: World,
  id: string,
  n: number,
  overrides: Record<string, unknown> | ((model: PageBody) => Record<string, unknown>) = {},
): Promise<{model: PageBody; res: Response; json: Record<string, unknown>}> {
  const model = await readPage(world, id)
  const res = await postSave(world, id, saveBodyFor(model, n, typeof overrides === 'function' ? overrides(model) : overrides))
  return {model, res, json: (await res.json()) as Record<string, unknown>}
}

async function promotionStatus(world: World, since?: string): Promise<Record<string, unknown>> {
  const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`
  const res = await world.request(`/api/wiki/promotion/status${query}`)
  expect([200, 503, 502]).toContain(res.status)
  return (await res.json()) as Record<string, unknown>
}

async function lookup(world: World, n: number, id: string, startedAt: number): Promise<Record<string, unknown>> {
  const res = await world.request(`/api/wiki/operations/${opId(n)}?pageId=${id}&startedAt=${startedAt}`)
  return (await res.json()) as Record<string, unknown>
}

function trailerCommits(world: World, n: number) {
  return world.target.repo.commitsWithTrailer(opId(n))
}

function advancePastRun(world: World): void {
  world.clock.ms += FIXTURE_RUN_DURATION_MS + 1000
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe('fixture list', () => {
  it('lists every fault page, across all four page types, with canWrite true', async () => {
    const world = await makeWorld()

    const res = await world.request('/api/wiki/pages')
    const body = (await res.json()) as {pages: {id: string; type: string; canMark: boolean}[]; canWrite: boolean}

    expect(res.status).toBe(200)
    expect(body.canWrite).toBe(true)
    const listed = body.pages.map(page => page.id)
    for (const id of Object.values(IDS)) expect(listed, id).toContain(id)
    expect(new Set(body.pages.map(page => page.type))).toEqual(new Set(['repos', 'topics', 'entities', 'comparisons']))
  })

  it('names every fault page with a readable, valid <dir>.<name> ID', () => {
    const ids = Object.values(IDS)

    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(parsePageId(id), id).not.toBeNull()
      expect(id).toMatch(/^(?:repos|topics|entities|comparisons)\.fixture-/u)
    }
  })

  it('opens every fault page as a valid page model', async () => {
    const world = await makeWorld()

    for (const id of Object.values(IDS)) {
      const model = await readPage(world, id)
      expect(model.id).toBe(id)
      expect(model.pageBlobSha).toMatch(/^blob-/u)
      expect(model.body).not.toContain('node_id')
      expect(model.canWrite).toBe(true)
    }
  })

  it('gives the repo pages a node_id and the page without one no marks', async () => {
    const world = await makeWorld()

    const plain = await readPage(world, IDS.plain)
    const none = await readPage(world, IDS.noNodeId)

    expect(plain.canMark).toBe(true)
    expect(plain.nodeId).toMatch(/^R_/u)
    expect(plain.corrections).toHaveLength(1)
    expect(plain.corrections[0]).toMatchObject({status: 'active', stale: false})
    expect(none.canMark).toBe(false)
    expect(none.nodeId).toBeNull()
    expect(none.corrections).toEqual([])
  })

  it('reports contract state only on the contract pages', async () => {
    const world = await makeWorld()

    expect((await readPage(world, IDS.contractMismatch)).contract).toEqual({ok: false, kind: 'mismatch', retry: false})
    expect((await readPage(world, IDS.contractUnreadable)).contract).toEqual({ok: false, kind: 'unreadable', retry: true})
    for (const id of [IDS.plain, IDS.conflict, IDS.blocked, IDS.rejected]) {
      expect((await readPage(world, id)).contract, id).toEqual({ok: true})
    }
  })
})

// ---------------------------------------------------------------------------
// Fault pages: table-driven
// ---------------------------------------------------------------------------

interface FaultRow {
  readonly name: string
  readonly id: string
  readonly status: number
  readonly body: Record<string, unknown>
  readonly overrides?: (model: PageBody) => Record<string, unknown>
}

// Exhaustive over the save outcomes: a new state fails type-check until it is listed here and given a row.
const OUTCOME_COVERAGE = {
  saved: ['saved'],
  'saved-not-promoted': ['saved-not-promoted'],
  rejected: ['rejected'],
  conflict: ['conflict:page', 'conflict:page-removed', 'conflict:corrections'],
  failed: ['failed'],
  'contract-rejected': ['contract-rejected:mismatch', 'contract-rejected:unreadable'],
  indeterminate: ['indeterminate'],
  'rate-limited': ['rate-limited'],
} as const satisfies Record<SaveResult['state'], readonly string[]>

const FAULT_ROWS: readonly FaultRow[] = [
  {name: 'plain page saves', id: IDS.plain, status: 200, body: {state: 'saved'}},
  {name: 'page without node_id saves', id: IDS.noNodeId, status: 200, body: {state: 'saved'}},
  {name: 'comparison page saves', id: IDS.comparison, status: 200, body: {state: 'saved'}},
  {name: 'blocked page saves', id: IDS.blocked, status: 200, body: {state: 'saved'}},
  {name: 'blob mismatch on first save', id: IDS.conflict, status: 409, body: {state: 'conflict', kind: 'page'}},
  {
    name: 'corrections conflict',
    id: IDS.correctionsConflict,
    status: 409,
    body: {state: 'conflict', kind: 'corrections'},
    overrides: model => ({transitions: [{id: model.corrections[0]?.id, action: 'flag'}]}),
  },
  {name: 'ref-update timeout, commit landed', id: IDS.timeoutLanded, status: 504, body: {state: 'indeterminate'}},
  {name: 'ref-update timeout, commit lost', id: IDS.timeoutLost, status: 504, body: {state: 'indeterminate'}},
  {name: 'dispatch failure', id: IDS.dispatchFailure, status: 202, body: {state: 'saved-not-promoted'}},
  {
    name: 'gate-contract mismatch',
    id: IDS.contractMismatch,
    status: 424,
    body: {state: 'contract-rejected', kind: 'mismatch', retry: false},
  },
  {
    name: 'gate-contract unreadable',
    id: IDS.contractUnreadable,
    status: 424,
    body: {state: 'contract-rejected', kind: 'unreadable', retry: true},
  },
  {name: 'GitHub rate limit', id: IDS.rateLimit, status: 429, body: {state: 'rate-limited', retryAfterSeconds: 20}},
  {name: 'GitHub write failure', id: IDS.failed, status: 502, body: {state: 'failed', retryable: true}},
  {name: 'page vanishes after it is opened', id: IDS.vanishes, status: 409, body: {state: 'conflict', kind: 'page-removed'}},
  {name: 'real gate finding', id: IDS.rejected, status: 422, body: {state: 'rejected', reason: 'gate'}},
]

describe('fault pages through the real routes', () => {
  it.each(FAULT_ROWS)('$name: $id answers $status', async row => {
    const world = await makeWorld()

    const {res, json} = await openAndSave(world, row.id, 1, row.overrides)

    expect(res.status).toBe(row.status)
    expect(json).toMatchObject(row.body)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('covers every outcome in the contract', () => {
    const rowKeys = new Set(FAULT_ROWS.map(row => [row.body.state, row.body.kind].filter(part => part !== undefined).join(':')))

    for (const [state, keys] of Object.entries(OUTCOME_COVERAGE)) {
      for (const key of keys) expect(rowKeys, `${state}: ${key}`).toContain(key)
    }
    expect(Object.keys(OUTCOME_COVERAGE).sort()).toEqual([...new Set(FAULT_ROWS.map(row => String(row.body.state)))].sort())
  })

  it('runs the real gates: a saved page also gets its log entry and index', async () => {
    const world = await makeWorld()

    const {json} = await openAndSave(world, IDS.plain, 1)

    const head = world.target.repo.commit(world.target.repo.head)
    expect(json.commitSha).toBe(head.sha)
    expect(head.touched.has('knowledge/wiki/repos/fixture--plain.md')).toBe(true)
    expect(head.touched.has('knowledge/log.md')).toBe(true)
    expect(head.message).toContain(`Fro-Operation-Id: ${opId(1)}`)
    expect(head.message).toContain(`Fro-Operator: ${LOGIN}`)
    expect(world.target.repo.files()['knowledge/log.md']).toContain('knowledge/wiki/repos/fixture--plain.md')
  })

  it('rejects typed HTML on any page, through the real rendering gate', async () => {
    const world = await makeWorld()

    const {res, json} = await openAndSave(world, IDS.plain, 1, model => ({body: `${model.body}\n<script>alert(1)</script>\n`}))

    expect(res.status).toBe(422)
    expect(json).toMatchObject({state: 'rejected', reason: 'gate'})
    expect((json.findings as {kind: string}[]).map(finding => finding.kind)).toContain('unsafe-html')
    expect(world.target.repo.count('createCommit')).toBe(0)
  })
})

describe('page with a rejecting gate finding', () => {
  it('rejects every save until the offending line is removed, then saves', async () => {
    const world = await makeWorld()
    const model = await readPage(world, IDS.rejected)
    expect(model.body).toContain('<iframe')

    const first = await postSave(world, IDS.rejected, saveBodyFor(model, 1))
    const firstJson = (await first.json()) as {findings: {kind: string; path: string; message: string}[]}
    expect(first.status).toBe(422)
    expect(firstJson.findings[0]).toMatchObject({kind: 'unsafe-html', path: 'knowledge/wiki/topics/fixture-rejected.md'})
    expect(firstJson.findings[0]?.message).not.toContain('iframe')

    const fixed = model.body.split('\n').filter(line => !line.includes('<iframe')).join('\n')
    const second = await postSave(world, IDS.rejected, saveBodyFor(model, 2, {body: fixed}))
    expect(second.status).toBe(200)
  })

  it('does not block other pages: a rejection on one page leaves another page saving', async () => {
    const world = await makeWorld()

    const rejected = await openAndSave(world, IDS.rejected, 1)
    const {res} = await openAndSave(world, IDS.plain, 2)

    expect(rejected.res.status).toBe(422)
    expect(res.status).toBe(200)
  })
})

describe('blob mismatch page', () => {
  it('reports the newer blob on the first save and saves once the editor reloads', async () => {
    const world = await makeWorld()
    const model = await readPage(world, IDS.conflict)

    const first = await postSave(world, IDS.conflict, saveBodyFor(model, 1))
    const conflict = (await first.json()) as {currentBlobSha: string}

    expect(first.status).toBe(409)
    expect(conflict.currentBlobSha).not.toBe(model.pageBlobSha)
    expect(world.target.repo.count('createCommit')).toBe(0)

    const reloaded = await readPage(world, IDS.conflict)
    expect(reloaded.pageBlobSha).toBe(conflict.currentBlobSha)
    expect(reloaded.body).toContain('Updated upstream')
    const second = await postSave(world, IDS.conflict, saveBodyFor(reloaded, 2))
    expect(second.status).toBe(200)
  })

  it('conflicts again on the first save after the next successful one', async () => {
    const world = await makeWorld()
    await openAndSave(world, IDS.conflict, 1)
    const reloaded = await readPage(world, IDS.conflict)
    expect((await postSave(world, IDS.conflict, saveBodyFor(reloaded, 2))).status).toBe(200)

    const third = await openAndSave(world, IDS.conflict, 3)

    expect(third.res.status).toBe(409)
  })

  it('does not conflict a save that overwrites with the newer blob, even after the page is opened again', async () => {
    const world = await makeWorld()
    const first = await openAndSave(world, IDS.conflict, 1)
    const newer = (first.json as {currentBlobSha: string}).currentBlobSha

    await readPage(world, IDS.conflict)
    const overwrite = await postSave(world, IDS.conflict, saveBodyFor(first.model, 2, {pageBlobSha: newer}))

    expect(overwrite.status).toBe(200)
  })
})

describe('corrections conflict page', () => {
  it('conflicts a save that carries a correction change, then saves on the new base', async () => {
    const world = await makeWorld()
    const model = await readPage(world, IDS.correctionsConflict)
    const seeded = model.corrections[0]?.id as string

    const first = await postSave(
      world,
      IDS.correctionsConflict,
      saveBodyFor(model, 1, {transitions: [{id: seeded, action: 'retire'}]}),
    )
    const conflict = (await first.json()) as {
      kind: string
      correctionsBase: string
      currentCorrections: {id: string}[]
    }

    expect(first.status).toBe(409)
    expect(conflict.kind).toBe('corrections')
    expect(conflict.correctionsBase).not.toBe(model.correctionsBase)
    expect(conflict.currentCorrections.length).toBeGreaterThan(model.corrections.length)
    expect(conflict.currentCorrections.map(c => c.id)).toContain(seeded)
    expect(world.target.repo.count('createCommit')).toBe(0)

    const second = await postSave(
      world,
      IDS.correctionsConflict,
      saveBodyFor(model, 2, {transitions: [{id: seeded, action: 'retire'}], correctionsBase: conflict.correctionsBase}),
    )
    expect(second.status).toBe(200)
    const after = await readPage(world, IDS.correctionsConflict)
    expect(after.corrections.find(c => c.id === seeded)?.status).toBe('retired')
  })

  it('saves a body-only edit without touching the corrections guard, and keeps the fault armed', async () => {
    const world = await makeWorld()

    const plainSave = await openAndSave(world, IDS.correctionsConflict, 1)
    expect(plainSave.res.status).toBe(200)

    const model = await readPage(world, IDS.correctionsConflict)
    const marked = await postSave(
      world,
      IDS.correctionsConflict,
      saveBodyFor(model, 2, {transitions: [{id: model.corrections[0]?.id, action: 'flag'}]}),
    )
    expect(marked.status).toBe(409)
  })
})

describe('ref-update timeouts', () => {
  it('resolves as done on lookup when the commit landed, without a second commit', async () => {
    const world = await makeWorld()
    const startedAt = world.clock.ms

    const {res, json} = await openAndSave(world, IDS.timeoutLanded, 1)

    expect(res.status).toBe(504)
    expect(json).toEqual({state: 'indeterminate', operationId: opId(1)})
    const found = await lookup(world, 1, IDS.timeoutLanded, startedAt)
    expect(found).toMatchObject({state: 'found', commitSha: world.target.repo.head})
    expect(trailerCommits(world, 1)).toHaveLength(1)
    expect(world.target.repo.history().some(commit => commit.message.includes(opId(1)))).toBe(true)
  })

  it('resolves as missing on lookup when the commit did not land', async () => {
    const world = await makeWorld()
    const startedAt = world.clock.ms
    const headBefore = world.target.repo.head

    const {res, json} = await openAndSave(world, IDS.timeoutLost, 1)

    expect(res.status).toBe(504)
    expect(json).toEqual({state: 'indeterminate', operationId: opId(1)})
    expect(await lookup(world, 1, IDS.timeoutLost, startedAt)).toEqual({state: 'missing'})
    expect(world.target.repo.head).toBe(headBefore)
    expect(world.target.repo.history().some(commit => commit.message.includes(opId(1)))).toBe(false)
  })

  it('lets the next save through after a lost commit, and times out again on the one after', async () => {
    const world = await makeWorld()
    await openAndSave(world, IDS.timeoutLost, 1)

    const again = await openAndSave(world, IDS.timeoutLost, 2)
    expect(again.res.status).toBe(200)

    const third = await openAndSave(world, IDS.timeoutLost, 3)
    expect(third.res.status).toBe(504)
  })

  it('times out again on the save after a landed commit once a save has gone through', async () => {
    const world = await makeWorld()
    await openAndSave(world, IDS.timeoutLanded, 1)
    expect((await openAndSave(world, IDS.timeoutLanded, 2)).res.status).toBe(200)

    const third = await openAndSave(world, IDS.timeoutLanded, 3)

    expect(third.res.status).toBe(504)
    expect(await lookup(world, 3, IDS.timeoutLanded, START_MS)).toMatchObject({state: 'found'})
  })

  it('does not dispatch for an indeterminate save', async () => {
    const world = await makeWorld()
    await openAndSave(world, IDS.timeoutLanded, 1)
    await openAndSave(world, IDS.timeoutLost, 2)

    expect(world.target.repo.count('createDispatch')).toBe(0)
  })
})

describe('dispatch failure page', () => {
  it('saves, fails to dispatch, and succeeds on retry without a second commit', async () => {
    const world = await makeWorld()

    const {res, json} = await openAndSave(world, IDS.dispatchFailure, 1)
    expect(res.status).toBe(202)
    expect(json).toMatchObject({state: 'saved-not-promoted', operationId: opId(1)})
    expect(trailerCommits(world, 1)).toHaveLength(1)
    const commits = world.target.repo.count('createCommit')
    const head = world.target.repo.head

    const retry = await world.request('/api/wiki/promotion/dispatch', {method: 'POST', headers: WRITE_HEADERS, body: '{}'})

    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({state: 'dispatched'})
    expect(world.target.repo.count('createCommit')).toBe(commits)
    expect(world.target.repo.head).toBe(head)
    expect((await promotionStatus(world, json.committedAt as string)).state).toBe('pending')
  })

  it('dispatches normally on the next save and fails the dispatch again on the one after', async () => {
    const world = await makeWorld()
    await openAndSave(world, IDS.dispatchFailure, 1)

    const second = await openAndSave(world, IDS.dispatchFailure, 2)
    const third = await openAndSave(world, IDS.dispatchFailure, 3)

    expect(second.res.status).toBe(200)
    expect(third.res.status).toBe(202)
  })
})

describe('rate limit and write failure pages', () => {
  it('answers the rate-limited outcome with a retry hint, writes nothing, and then lets the save through', async () => {
    const world = await makeWorld()
    const model = await readPage(world, IDS.rateLimit)

    const first = await postSave(world, IDS.rateLimit, saveBodyFor(model, 1))

    expect(first.status).toBe(429)
    expect(first.headers.get('retry-after')).toBe('20')
    expect(world.target.repo.count('createBlob')).toBe(0)
    const second = await postSave(world, IDS.rateLimit, saveBodyFor(model, 2))
    expect(second.status).toBe(200)
    const third = await openAndSave(world, IDS.rateLimit, 3)
    expect(third.res.status).toBe(429)
  })

  it('answers a retryable failure with no commit, and then lets the save through', async () => {
    const world = await makeWorld()
    const model = await readPage(world, IDS.failed)

    const first = await postSave(world, IDS.failed, saveBodyFor(model, 1))

    expect(first.status).toBe(502)
    expect(world.target.repo.count('createCommit')).toBe(0)
    expect((await postSave(world, IDS.failed, saveBodyFor(model, 2))).status).toBe(200)
  })
})

describe('contract pages', () => {
  it('rejects a mismatch save without any write call, every time', async () => {
    const world = await makeWorld()

    for (const n of [1, 2]) {
      const {res} = await openAndSave(world, IDS.contractMismatch, n)
      expect(res.status).toBe(424)
    }
    expect(world.target.repo.count('createBlob')).toBe(0)
    expect(world.target.repo.count('getRef')).toBe(2)
  })

  it('rejects an unreadable-marker save once, then lets the retry through', async () => {
    const world = await makeWorld()
    const model = await readPage(world, IDS.contractUnreadable)

    const first = await postSave(world, IDS.contractUnreadable, saveBodyFor(model, 1))
    const second = await postSave(world, IDS.contractUnreadable, saveBodyFor(model, 2))

    expect(first.status).toBe(424)
    expect(second.status).toBe(200)
  })
})

describe('vanishing page', () => {
  it('reports page-removed, is gone on read, and is back on the next list', async () => {
    const world = await makeWorld()

    const {res, json} = await openAndSave(world, IDS.vanishes, 1)
    expect(res.status).toBe(409)
    expect(json).toEqual({state: 'conflict', kind: 'page-removed'})

    expect((await world.request(`/api/wiki/pages/${IDS.vanishes}`)).status).toBe(404)
    expect(world.target.repo.files()['knowledge/index.md']).not.toContain('fixture-vanishes')
    const list = (await (await world.request('/api/wiki/pages')).json()) as {pages: {id: string}[]}
    expect(list.pages.map(page => page.id)).toContain(IDS.vanishes)
    expect((await world.request(`/api/wiki/pages/${IDS.vanishes}`)).status).toBe(200)
    expect(world.target.repo.files()['knowledge/index.md']).toContain('fixture-vanishes')
  })

  it('leaves the wiki consistent while the page is gone: another page still saves', async () => {
    const world = await makeWorld()
    await openAndSave(world, IDS.vanishes, 1)

    const {res} = await openAndSave(world, IDS.plain, 2)

    expect(res.status).toBe(200)
  })

  it('saves on the next try, and vanishes again on the save after that', async () => {
    const world = await makeWorld()
    await openAndSave(world, IDS.vanishes, 1)
    await world.request('/api/wiki/pages')

    const second = await openAndSave(world, IDS.vanishes, 2)
    const third = await openAndSave(world, IDS.vanishes, 3)

    expect(second.res.status).toBe(200)
    expect(third.json).toEqual({state: 'conflict', kind: 'page-removed'})
  })
})

// ---------------------------------------------------------------------------
// Promotion status from the fake's PR and runs
// ---------------------------------------------------------------------------

describe('promotion status', () => {
  it('starts settled with the open pull request', async () => {
    const world = await makeWorld()

    expect(await promotionStatus(world)).toEqual({state: 'settled', pr: {number: 4100, url: PR_URL}})
  })

  it('reports pending with the PR link after a plain save, then settled once the run ends', async () => {
    const world = await makeWorld()
    const {json} = await openAndSave(world, IDS.plain, 1)
    const since = json.committedAt as string

    expect(await promotionStatus(world, since)).toEqual({state: 'pending', pr: {number: 4100, url: PR_URL}})

    advancePastRun(world)
    expect(await promotionStatus(world, since)).toEqual({state: 'settled', pr: {number: 4100, url: PR_URL}})
  })

  it('makes at most three GitHub reads per status read', async () => {
    const world = await makeWorld()
    await openAndSave(world, IDS.blocked, 1)
    advancePastRun(world)
    const before = world.target.repo.calls.length

    await promotionStatus(world)

    expect(world.target.repo.calls.length - before).toBeLessThanOrEqual(3)
  })

  it('reports the blocked branch through the status route after a list read and after a page read, then clears on a later success', async () => {
    const world = await makeWorld()
    const {json} = await openAndSave(world, IDS.blocked, 1)
    const since = json.committedAt as string

    expect((await promotionStatus(world, since)).state).toBe('pending')
    advancePastRun(world)

    // The list read.
    expect((await world.request('/api/wiki/pages')).status).toBe(200)
    const onList = await promotionStatus(world, since)
    expect(onList).toMatchObject({state: 'blocked', reason: 'private-page'})
    expect(onList.runUrl).toMatch(/^https:\/\/github\.com\/fro-bot\/\.github\/actions\/runs\/\d+$/u)
    expect(onList.pr).toEqual({number: 4100, url: PR_URL})

    // The page read.
    expect((await world.request(`/api/wiki/pages/${IDS.blocked}`)).status).toBe(200)
    world.clock.ms += 20_000
    expect(await promotionStatus(world, since)).toMatchObject({state: 'blocked', reason: 'private-page'})

    // A later save promotes cleanly and clears it.
    const later = await openAndSave(world, IDS.plain, 2)
    advancePastRun(world)
    expect((await promotionStatus(world, later.json.committedAt as string)).state).toBe('settled')
  })

  it('does not block on a save that does not touch the blocked page', async () => {
    const world = await makeWorld()
    const {json} = await openAndSave(world, IDS.noNodeId, 1)
    advancePastRun(world)

    expect((await promotionStatus(world, json.committedAt as string)).state).toBe('settled')
  })

  it('cancels a run in progress when a newer dispatch arrives, which stays pending', async () => {
    const world = await makeWorld()
    await openAndSave(world, IDS.blocked, 1)
    const second = await openAndSave(world, IDS.plain, 2)
    world.clock.ms += 1000

    const status = await promotionStatus(world, second.json.committedAt as string)

    expect(status.state).toBe('pending')
    const runs = (await world.target.repo.transport().listWorkflowRuns({per_page: 5})).data as {
      workflow_runs: {id: number; status: string; conclusion: string | null}[]
    }
    const byId = new Map(runs.workflow_runs.map(run => [run.id, run]))
    expect(byId.get(5000)).toMatchObject({status: 'completed', conclusion: 'cancelled'})
    expect(byId.get(5001)).toMatchObject({status: 'in_progress', conclusion: null})
  })

  it('fails the blocked page run at the privacy step, which the status reader maps to private-page', async () => {
    const world = await makeWorld()
    const {json} = await openAndSave(world, IDS.blocked, 1)
    advancePastRun(world)
    expect(await promotionStatus(world, json.committedAt as string)).toMatchObject({state: 'blocked', reason: 'private-page'})

    const jobs = await world.target.repo.transport().listRunJobs({run_id: 5000})
    const steps = ((jobs.data as {jobs: {steps: {name: string; conclusion: string}[]}[]}).jobs[0]?.steps ?? []).filter(
      step => step.conclusion === 'failure',
    )

    expect(steps.map(step => step.name)).toEqual(['\uD83D\uDD12 Block private wiki pages'])
  })
})

// ---------------------------------------------------------------------------
// Through the app in fixture mode
// ---------------------------------------------------------------------------

describe('fixture harness wiring', () => {
  async function harnessApp(extra: Record<string, unknown> = {}) {
    return buildDashboardApp({
      operatorLogin: LOGIN,
      cookieKey: TEST_KEY,
      devAutoLogin: true,
      fixtureHarnessEnabled: true,
      fixtureBindHost: '127.0.0.1',
      fixtureBindPort: PORT,
      webDistRoot: shellRoot,
      ...extra,
    })
  }

  async function plainSave(app: Awaited<ReturnType<typeof harnessApp>>, headers: Record<string, string>) {
    const model = (await (await app.request(`/api/wiki/pages/${IDS.plain}`)).json()) as PageBody
    return app.request(`/api/wiki/pages/${IDS.plain}/save`, {
      method: 'POST',
      headers,
      body: JSON.stringify(saveBodyFor(model, 1)),
    })
  }

  it('lists the fault pages without any special request', async () => {
    const app = await harnessApp()

    const res = await app.request('/api/wiki/pages')
    const body = (await res.json()) as {pages: {id: string}[]; canWrite: boolean; canWriteReason: string | null}

    expect(res.status).toBe(200)
    expect(body.canWrite).toBe(true)
    for (const id of Object.values(IDS)) expect(body.pages.map(page => page.id)).toContain(id)
  })

  it('saves a plain page from the loopback origin the server binds to', async () => {
    const app = await harnessApp()

    const res = await plainSave(app, WRITE_HEADERS)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({state: 'saved'})
  })

  it.each([
    ['localhost on the same port', `http://localhost:${PORT}`],
    ['the same host on another port', 'http://127.0.0.1:9999'],
    ['https on the same port', `https://127.0.0.1:${PORT}`],
    ['the production dashboard origin', 'https://dashboard.fro.bot'],
  ])('refuses a save from %s', async (_label, origin) => {
    const app = await harnessApp()

    const res = await plainSave(app, {...WRITE_HEADERS, origin})

    expect(res.status).toBe(403)
  })

  it('takes the expected port from DASHBOARD_PORT when none is injected', async () => {
    vi.stubEnv('DASHBOARD_PORT', '4900')
    const app = await harnessApp({fixtureBindPort: undefined})

    expect((await plainSave(app, {...WRITE_HEADERS, origin: 'http://127.0.0.1:4900'})).status).toBe(200)
    expect((await plainSave(app, {...WRITE_HEADERS, origin: ORIGIN})).status).toBe(403)
  })

  it('derives the loopback origin from the bind host and port', () => {
    expect(fixtureOriginFor('127.0.0.1', 3000)).toBe('http://127.0.0.1:3000')
    expect(fixtureOriginFor('localhost', 4821)).toBe('http://localhost:4821')
    expect(fixtureOriginFor('::1', 3000)).toBe('http://[::1]:3000')
  })

  it('differs from the origin the production write config expects', () => {
    vi.stubEnv('DASHBOARD_FRO_BOT_APP_ID', '1')
    vi.stubEnv('DASHBOARD_FRO_BOT_APP_KEY', '-----BEGIN KEY-----\nabc\n-----END KEY-----')
    vi.stubEnv('DASHBOARD_OPERATOR_ID', '42')

    const config = readWikiWriteConfig()

    expect(config.enabled && config.dashboardOrigin).toBe('https://dashboard.fro.bot')
    expect(config.enabled && config.dashboardOrigin).not.toBe(fixtureOriginFor('127.0.0.1', 3000))
  })

  it('gives a session that is not the autologin canWrite false', async () => {
    const app = await harnessApp({devAutoLogin: false})
    const cookie = `session=${new SessionManager(TEST_KEY).sign(LOGIN)}`

    const list = await app.request('/api/wiki/pages', {headers: {cookie}})
    const write = await app.request(`/api/wiki/pages/${IDS.plain}/save`, {
      method: 'POST',
      headers: {...WRITE_HEADERS, cookie},
      body: '{}',
    })

    expect(await list.json()).toMatchObject({canWrite: false, canWriteReason: 'session-not-supported'})
    expect(write.status).toBe(403)
  })

  it('replaces an injected wiki: the fixture is what serves while the harness is active', async () => {
    const world = await makeWorld()
    const app = await harnessApp({wiki: {...world.target.deps, pages: null, write: null}})

    const res = await app.request('/api/wiki/pages')

    expect(res.status).toBe(200)
    expect(((await res.json()) as {pages: unknown[]}).pages.length).toBeGreaterThan(5)
  })

  it('makes no network request while serving, saving, and checking status', async () => {
    const network = vi.fn(async () => {
      throw new Error('network is not allowed in fixture mode')
    })
    vi.stubGlobal('fetch', network)
    const app = await harnessApp()

    await app.request('/api/wiki/pages')
    await app.request(`/api/wiki/pages/${IDS.contractMismatch}`)
    expect((await plainSave(app, WRITE_HEADERS)).status).toBe(200)
    expect((await app.request('/api/wiki/promotion/status')).status).toBe(200)
    expect((await app.request('/api/wiki/promotion/dispatch', {method: 'POST', headers: WRITE_HEADERS, body: '{}'})).status).toBe(
      200,
    )

    expect(network).not.toHaveBeenCalled()
  })
})

describe('buildFixtureWikiDeps', () => {
  it('carries the origin and operator login into the policy and no operator ID', () => {
    const target = buildFixtureWikiDeps({dashboardOrigin: ORIGIN, operatorLogin: LOGIN})

    expect(target.deps.policy).toEqual({
      capability: {enabled: true, operatorId: null, dashboardOrigin: ORIGIN},
      fixtureOperatorLogin: LOGIN,
    })
    expect(target.deps.pages).not.toBeNull()
    expect(target.deps.write).not.toBeNull()
  })

  it('leaves the fixture login unset when no operator login is given', () => {
    expect(buildFixtureWikiDeps({dashboardOrigin: ORIGIN, operatorLogin: null}).deps.policy.fixtureOperatorLogin).toBeNull()
  })

  it('builds an independent world each time', async () => {
    const one = buildFixtureWikiDeps({dashboardOrigin: ORIGIN, operatorLogin: LOGIN})
    const two = buildFixtureWikiDeps({dashboardOrigin: ORIGIN, operatorLogin: LOGIN})

    expect(one.repo).not.toBe(two.repo)
    expect(one.repo.head).toBe(two.repo.head)
  })
})
