import type {GateContractDecision} from '../src/wiki/gate-contract.ts'
import type {runWikiGates as RunWikiGates} from '../src/wiki/gates.ts'
import type {DispatchResult, SaveResult} from '../src/wiki/write-operation.ts'

import {Buffer} from 'node:buffer'
import {GATE_CONTRACT_VERSION, parseCorrections} from '@fro.bot/wiki-write-core'
import {afterEach, describe, expect, it, vi, type Mock} from 'vitest'
import {WriteCredentialError} from '../src/github/fro-bot-app-client.ts'
import {logger} from '../src/logger.ts'
import {createBlobCache, createWikiDataClient, RequestNotSentError} from '../src/wiki/data-client.ts'
import {createGateContractChecker} from '../src/wiki/gate-contract.ts'
import {correctionsDigest, EMPTY_CORRECTIONS_DIGEST} from '../src/wiki/pages.ts'
import {
  createWikiWriteOperation,
  lookupOperation,
  MAX_BODY_BYTES,
  MAX_HEAD_ATTEMPTS,
  OPERATION_TRAILER,
  OPERATOR_TRAILER,
  RECONCILE_SKEW_MS,
} from '../src/wiki/write-operation.ts'
import {FakeRepo, HttpError} from './wiki-fake-repo.ts'
import {
  ALPHA,
  ALPHA_BODY,
  ALPHA_ID,
  BETA,
  BETA_BODY,
  BETA_ID,
  correctionRecord,
  CORRECTIONS,
  correctionsYaml,
  DOC,
  GAMMA,
  GAMMA_ID,
  LOG,
  wikiFiles,
  WORKFLOW,
} from './wiki-write-fixtures.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const OK_CONTRACT: GateContractDecision = {
  proceed: true,
  marker: {version: GATE_CONTRACT_VERSION, sourceTreeHash: 's'},
  readiness: {ready: true, stale: false, mainHeadSha: 'main-1'},
}
const MISMATCH: GateContractDecision = {
  proceed: false,
  reason: 'version_mismatch',
  marker: {version: GATE_CONTRACT_VERSION + 1, sourceTreeHash: 's'},
  readiness: {ready: false, stale: false, mainHeadSha: 'main-1'},
}
const UNREADABLE: GateContractDecision = {
  proceed: false,
  reason: 'unavailable',
  readiness: {ready: false, stale: true, mainHeadSha: null},
}

// Replaces the shared gates for the tests that need a result real content cannot produce.
const gateOverride = vi.hoisted(() => ({current: null as null | ((...args: unknown[]) => unknown)}))

vi.mock('../src/wiki/gates.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/wiki/gates.ts')>()
  return {
    ...actual,
    runWikiGates: ((...args: Parameters<typeof RunWikiGates>) =>
      gateOverride.current === null ? actual.runWikiGates(...args) : gateOverride.current(...args)) as typeof RunWikiGates,
  }
})

const CONTEXT = {operatorLogin: 'octocat'}
const EDITED_BODY = ALPHA_BODY.replace('widgets', 'gadgets')

function opId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

interface Harness {
  readonly repo: FakeRepo
  readonly dispatch: Mock<() => Promise<DispatchResult>>
  readonly checkContract: Mock<() => Promise<GateContractDecision>>
  readonly operation: ReturnType<typeof createWikiWriteOperation>
  readonly client: ReturnType<typeof createWikiDataClient>
  readonly headBefore: string
}

function setup(
  options: {
    files?: Record<string, string>
    decision?: GateContractDecision
    dispatchResult?: {ok: boolean}
  } = {},
): Harness {
  const repo = new FakeRepo({files: options.files ?? wikiFiles()})
  const client = createWikiDataClient(repo.transport(), {blobCache: createBlobCache()})
  const dispatch = vi.fn<() => Promise<DispatchResult>>(async () => (options.dispatchResult?.ok === false ? {ok: false} : {ok: true}))
  const checkContract = vi.fn<() => Promise<GateContractDecision>>(async () => options.decision ?? OK_CONTRACT)
  let minted = 0
  const operation = createWikiWriteOperation({
    client,
    checkContract,
    dispatch: {dispatch},
    now: () => repo.clockMs,
    newId: () => {
      minted += 1
      return `mint-${minted}`
    },
  })
  return {repo, dispatch, checkContract, operation, client, headBefore: repo.head}
}

function request(h: Harness, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: opId(1),
    pageId: ALPHA_ID,
    pageBlobSha: h.repo.blobShaAt(ALPHA),
    correctionsBase: EMPTY_CORRECTIONS_DIGEST,
    body: EDITED_BODY,
    marks: [],
    transitions: [],
    ...overrides,
  }
}

function mark(body: string, text: string): {text: string; start: number; end: number} {
  const start = body.indexOf(text)
  if (start === -1) throw new Error('test mark text not in body')
  return {text, start, end: start + text.length}
}

function pipelineLogAppend(repo: FakeRepo): string {
  return `${repo.files()[LOG]}\n## [2029-12-31 23:00] ingest | repo:acme/beta\n\nSurveyed.\n\nSources: none\n`
}

function expectState<S extends SaveResult['state']>(result: SaveResult, state: S): Extract<SaveResult, {state: S}> {
  expect(result.state).toBe(state)
  return result as Extract<SaveResult, {state: S}>
}

function nothingCommitted(h: Harness): void {
  expect(h.repo.count('createCommit')).toBe(0)
  expect(h.repo.count('updateRef')).toBe(0)
  expect(h.repo.head).toBe(h.headBefore)
}

function savedCorrections(repo: FakeRepo) {
  return parseCorrections(repo.files()[CORRECTIONS] ?? '').corrections
}

afterEach(() => {
  gateOverride.current = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('save: body edit', () => {
  it('commits one commit with the page, the appended log, and no corrections file', async () => {
    const h = setup()

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'saved')

    expect(result.commitSha).toBe(h.repo.head)
    expect(h.repo.commit(result.commitSha).parents).toEqual([h.headBefore])
    const touched = [...h.repo.commit(result.commitSha).touched]
    expect(touched).toContain(ALPHA)
    expect(touched).toContain(LOG)
    expect(touched).not.toContain(CORRECTIONS)
    expect(h.repo.files()[ALPHA]).toContain('Alpha builds gadgets')
    expect(h.dispatch).toHaveBeenCalledTimes(1)
  })

  it('appends a manual-edit entry to the log and keeps earlier log text', async () => {
    const h = setup()
    const before = h.repo.files()[LOG] ?? ''

    await h.operation.save(request(h), CONTEXT)

    const log = h.repo.files()[LOG] ?? ''
    expect(log.startsWith(before)).toBe(true)
    expect(log).toContain('manual-edit')
    expect(log).toContain(ALPHA)
  })

  it('keeps every untouched file: the tree is built on the head tree with changed entries only', async () => {
    const h = setup()
    const before = h.repo.files()
    const baseTree = h.repo.commit(h.repo.head).treeSha

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'saved')

    const treeCalls = h.repo.calls.filter(call => call.method === 'createTree')
    expect(treeCalls).toHaveLength(1)
    const params = treeCalls[0]?.params as {base_tree: string; tree: {path: string; sha: string | null}[]}
    expect(params.base_tree).toBe(baseTree)
    const entryPaths = params.tree.map(entry => entry.path)
    expect(entryPaths).toContain(ALPHA)
    expect(entryPaths).toContain(LOG)
    expect(params.tree.every(entry => entry.sha !== null)).toBe(true)
    expect(h.repo.count('createBlob')).toBe(params.tree.length)

    const after = h.repo.files()
    for (const path of Object.keys(before)) {
      if (entryPaths.includes(path)) continue
      expect(after[path]).toBe(before[path])
    }
    expect(after[WORKFLOW]).toBe(before[WORKFLOW])
    expect(after[DOC]).toBe(before[DOC])
    expect(after['knowledge/wiki/README.md']).toBe(before['knowledge/wiki/README.md'])
    expect([...h.repo.commit(result.commitSha).touched].sort()).toEqual([...entryPaths].sort())
  })

  it('does not conflict when other pages change between load and save', async () => {
    const h = setup()
    const loaded = request(h)
    h.repo.pipelineCommit({[BETA]: wikiFiles()[BETA]?.replace('gadgets', 'sprockets') ?? '', [LOG]: pipelineLogAppend(h.repo)})

    const result = await h.operation.save(loaded, CONTEXT)

    expectState(result, 'saved')
    expect(h.repo.files()[BETA]).toContain('sprockets')
    expect(h.repo.files()[LOG]).toContain('repo:acme/beta')
    expect(h.repo.files()[LOG]).toContain('manual-edit')
  })

  it('returns the commit time from the created commit', async () => {
    const h = setup()

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'saved')

    expect(result.committedAt).toBe(h.repo.commit(result.commitSha).committedAt)
  })

  it('sets the commit message trailers from the session, not the request', async () => {
    const h = setup()

    const result = expectState(
      await h.operation.save(request(h, {operator: 'mallory', operatorLogin: 'mallory', author: 'mallory'}), CONTEXT),
      'saved',
    )

    const message = h.repo.commit(result.commitSha).message
    expect(message.split('\n')[0]).toBe(`docs(knowledge): manual edit ${ALPHA}`)
    expect(message).toContain(`${OPERATION_TRAILER}: ${opId(1)}`)
    expect(message).toContain(`${OPERATOR_TRAILER}: octocat`)
    expect(message).not.toContain('mallory')
  })

  it('sends no author or committer, so GitHub signs the commit as the App', async () => {
    const h = setup()

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'saved')

    expect(h.repo.commit(result.commitSha).author).toBeUndefined()
    expect(h.repo.commit(result.commitSha).committer).toBeUndefined()
  })

  it('uses a non-forced ref update with the observed head as the commit parent', async () => {
    const h = setup()

    await h.operation.save(request(h), CONTEXT)

    expect(h.repo.calls.find(call => call.method === 'updateRef')?.params).toMatchObject({force: false, ref: 'heads/data'})
    expect(h.repo.calls.find(call => call.method === 'createCommit')?.params).toMatchObject({parents: [h.headBefore]})
  })
})

describe('save: marks and staged transitions', () => {
  it('creates the corrections file for two marks, with server IDs and session attribution', async () => {
    const h = setup()
    const marks = [mark(EDITED_BODY, 'Alpha builds gadgets'), mark(EDITED_BODY, 'for factories')]

    const result = await h.operation.save(request(h, {marks}), CONTEXT)

    expectState(result, 'saved')
    const corrections = savedCorrections(h.repo)
    expect(corrections.map(record => [record.id, record.page_node_id, record.state])).toEqual([
      ['mint-1', 'R_alpha', 'active'],
      ['mint-2', 'R_alpha', 'active'],
    ])
    expect(corrections[0]?.attribution?.actor).toBe('octocat')
    expect(corrections[0]?.attribution?.recorded_at).toBe(new Date(h.repo.clockMs - 1000).toISOString())
    expect(corrections[0]?.span).toEqual(marks[0])
  })

  it('applies staged retire, flag, and reconfirm in the same commit as the body', async () => {
    const files = wikiFiles({
      [CORRECTIONS]: correctionsYaml(
        correctionRecord('c-retire', 'R_alpha', 'Alpha builds'),
        correctionRecord('c-flag', 'R_alpha', 'for factories'),
        correctionRecord('c-reconfirm', 'R_alpha', 'See', {state: 'needs-reconfirmation', reason: 'drift'}),
      ),
    })
    const h = setup({files})
    const base = correctionsDigest(parseCorrections(files[CORRECTIONS] ?? '').corrections)

    const result = expectState(
      await h.operation.save(
        request(h, {
          correctionsBase: base,
          transitions: [
            {id: 'c-retire', action: 'retire'},
            {id: 'c-flag', action: 'flag'},
            {id: 'c-reconfirm', action: 'reconfirm'},
          ],
        }),
        CONTEXT,
      ),
      'saved',
    )

    expect(savedCorrections(h.repo).map(record => [record.id, record.state])).toEqual([
      ['c-retire', 'retired'],
      ['c-flag', 'needs-reconfirmation'],
      ['c-reconfirm', 'active'],
    ])
    expect(h.repo.files()[ALPHA]).toContain('gadgets')
    expect(h.repo.commit(result.commitSha).touched.has(CORRECTIONS)).toBe(true)
    expect(h.repo.commit(result.commitSha).touched.has(ALPHA)).toBe(true)
  })

  it('commits a corrections-only save with an unchanged body', async () => {
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets'))})
    const h = setup({files})
    const base = correctionsDigest(parseCorrections(files[CORRECTIONS] ?? '').corrections)

    const result = expectState(
      await h.operation.save(
        request(h, {body: ALPHA_BODY, correctionsBase: base, transitions: [{id: 'c1', action: 'retire'}]}),
        CONTEXT,
      ),
      'saved',
    )

    expect(savedCorrections(h.repo)[0]?.state).toBe('retired')
    expect(h.repo.commit(result.commitSha).touched.has(ALPHA)).toBe(false)
    expect(h.repo.commit(result.commitSha).touched.has(CORRECTIONS)).toBe(true)
  })

  it('lets a marked save on page B succeed after a marked save on page A from a stale editor', async () => {
    const h = setup()
    const bBlob = h.repo.blobShaAt(BETA)
    const aBody = EDITED_BODY
    const bBody = BETA_BODY.replace('gadgets', 'sprockets')

    expectState(
      await h.operation.save(request(h, {marks: [mark(aBody, 'Alpha builds gadgets')]}), CONTEXT),
      'saved',
    )
    const second = await h.operation.save(
      request(h, {
        operationId: opId(2),
        pageId: BETA_ID,
        pageBlobSha: bBlob,
        body: bBody,
        marks: [mark(bBody, 'Beta ships sprockets')],
      }),
      CONTEXT,
    )

    expectState(second, 'saved')
    expect(savedCorrections(h.repo).map(record => [record.id, record.page_node_id])).toEqual([
      ['mint-1', 'R_alpha'],
      ['mint-2', 'R_beta'],
    ])
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('save: edge cases', () => {
  const ERODING = ALPHA_BODY.replace('Alpha builds widgets', 'Alpha makes things')

  it('rejects a body that erodes an active correction, with the eroded-correction finding', async () => {
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets'))})
    const h = setup({files})
    const base = correctionsDigest(parseCorrections(files[CORRECTIONS] ?? '').corrections)

    const result = expectState(await h.operation.save(request(h, {body: ERODING, correctionsBase: base}), CONTEXT), 'rejected')

    expect(result.reason).toBe('gate')
    expect(result.findings?.map(finding => finding.kind)).toEqual(['correction-eroded'])
    expect(h.repo.count('createCommit')).toBe(0)
  })

  it('passes the same body when the correction is retired in the same save', async () => {
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets'))})
    const h = setup({files})
    const base = correctionsDigest(parseCorrections(files[CORRECTIONS] ?? '').corrections)

    const result = await h.operation.save(
      request(h, {body: ERODING, correctionsBase: base, transitions: [{id: 'c1', action: 'retire'}]}),
      CONTEXT,
    )

    expectState(result, 'saved')
    expect(savedCorrections(h.repo)[0]?.state).toBe('retired')
  })

  it('runs the corrections guard on a save with no marks and no transitions, and leaves the file alone when the base matches', async () => {
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'for factories'))})
    const h = setup({files})
    const base = correctionsDigest(parseCorrections(files[CORRECTIONS] ?? '').corrections)

    const stale = await h.operation.save(request(h, {correctionsBase: EMPTY_CORRECTIONS_DIGEST}), CONTEXT)
    const current = await h.operation.save(request(h, {correctionsBase: base, operationId: opId(2)}), CONTEXT)

    expect(stale).toMatchObject({state: 'conflict', kind: 'corrections'})
    expectState(current, 'saved')
    expect(h.repo.commit(h.repo.head).touched.has(CORRECTIONS)).toBe(false)
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', '\n \n'],
    ['unparseable', 'version: 1\ncorrections: [\n'],
  ])('rejects with a corrupt-corrections finding when the corrections file is %s', async (_label, content) => {
    const h = setup({files: wikiFiles({[CORRECTIONS]: content})})

    for (const overrides of [{marks: [mark(EDITED_BODY, 'for factories')]}, {}]) {
      const result = expectState(await h.operation.save(request(h, overrides), CONTEXT), 'rejected')
      expect(result.reason).toBe('gate')
      expect(result.findings).toEqual([expect.objectContaining({kind: 'corrupt-corrections', path: CORRECTIONS})])
    }
    expect(h.repo.count('createCommit')).toBe(0)
  })

  it('commits a body of exactly the size cap and rejects one byte more before any network call', async () => {
    const fill = (bytes: number) => `\n# acme/alpha\n\nSee [[beta-topic]] and [[acme--beta]].\n\n${'x'.repeat(bytes)}\n`
    const overhead = Buffer.byteLength(fill(0), 'utf8')
    const atCap = fill(MAX_BODY_BYTES - overhead)
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(MAX_BODY_BYTES)

    const exact = setup()
    expectState(await exact.operation.save(request(exact, {body: atCap}), CONTEXT), 'saved')

    const over = setup()
    const result = expectState(await over.operation.save(request(over, {body: `${atCap}y`}), CONTEXT), 'rejected')
    expect(result.reason).toBe('content-too-large')
    expect(over.repo.calls).toHaveLength(0)
    expect(over.checkContract).not.toHaveBeenCalled()
  })

  it('counts the size cap in bytes, not characters', async () => {
    const h = setup()
    const body = `\n# acme/alpha\n\n${'\u00E9'.repeat(MAX_BODY_BYTES / 2)}\n`

    const result = expectState(await h.operation.save(request(h, {body}), CONTEXT), 'rejected')

    expect(result.reason).toBe('content-too-large')
    expect(h.repo.calls).toHaveLength(0)
  })

  it('rejects a mark on a page without node_id', async () => {
    const h = setup()
    const body = '\n# Gamma\n\nGamma is a tool used by [[acme--alpha]]. Edited.\n'

    const result = expectState(
      await h.operation.save(
        request(h, {pageId: GAMMA_ID, pageBlobSha: h.repo.blobShaAt(GAMMA), body, marks: [mark(body, 'Gamma is a tool')]}),
        CONTEXT,
      ),
      'rejected',
    )

    expect(result.reason).toBe('mark-unavailable')
    expect(h.repo.count('createCommit')).toBe(0)
  })

  it('lets a page without node_id be edited with no marks', async () => {
    const h = setup()
    const body = '\n# Gamma\n\nGamma is a tool used by [[acme--alpha]]. Edited.\n'

    const result = await h.operation.save(
      request(h, {pageId: GAMMA_ID, pageBlobSha: h.repo.blobShaAt(GAMMA), body}),
      CONTEXT,
    )

    expectState(result, 'saved')
  })

  it('rejects a save that changes nothing', async () => {
    const h = setup()

    const result = expectState(await h.operation.save(request(h, {body: ALPHA_BODY}), CONTEXT), 'rejected')

    expect(result.reason).toBe('no-change')
    expect(h.repo.count('createCommit')).toBe(0)
  })

  it.each([
    ['a transition on an unknown ID', [{id: 'missing', action: 'retire'}]],
    ['a transition on a page without entries', [{id: 'c-other', action: 'retire'}]],
  ])('rejects %s', async (_label, transitions) => {
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c-other', 'R_beta', 'Beta ships gadgets'))})
    const h = setup({files})

    const result = expectState(await h.operation.save(request(h, {transitions}), CONTEXT), 'rejected')

    expect(result.reason).toBe('invalid-transition')
    expect(h.repo.count('createCommit')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Retry on a moved head
// ---------------------------------------------------------------------------

describe('save: moved head', () => {
  it('re-reads, re-runs the gates, and commits when the head moves once', async () => {
    const h = setup()
    let pipelineSha = ''
    h.repo.hooks.beforeUpdateRef = attempt => {
      if (attempt === 1) pipelineSha = h.repo.pipelineCommit({[LOG]: pipelineLogAppend(h.repo)})
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'saved')

    expect(h.repo.count('updateRef')).toBe(2)
    expect(h.repo.count('getTree')).toBe(2)
    expect(h.repo.commit(result.commitSha).parents).toEqual([pipelineSha])
    expect(h.repo.files()[LOG]).toContain('repo:acme/beta')
    expect(h.repo.files()[LOG]).toContain('manual-edit')
  })

  it('fails, safe to retry, with nothing committed, when the head keeps moving past the bound', async () => {
    const h = setup()
    h.repo.hooks.beforeUpdateRef = () => {
      h.repo.pipelineCommit({[LOG]: pipelineLogAppend(h.repo)})
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'failed')

    expect(result.retryable).toBe(true)
    expect(h.repo.count('updateRef')).toBe(MAX_HEAD_ATTEMPTS)
    expect(h.repo.history().some(commit => commit.message.includes(opId(1)))).toBe(false)
    expect(h.repo.files()[ALPHA]).toContain('widgets')
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it.each([
    ['an unauthorized response', new HttpError('Bad credentials', 401), false],
    ['a ruleset refusal', new HttpError('Repository rule violations found', 403), false],
    ['a not-found response', new HttpError('Not Found', 404), false],
    ['a validation failure', new HttpError('Validation Failed', 422), true],
  ])('fails without a retry or conflict when the head is unchanged after %s', async (_label, error, retryable) => {
    const h = setup()
    h.repo.hooks.beforeUpdateRef = () => {
      throw error
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'failed')

    expect(result.retryable).toBe(retryable)
    expect(h.repo.count('updateRef')).toBe(1) // exactly one attempt: no retry
    expect(h.repo.count('getRef')).toBeGreaterThanOrEqual(2)
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('does not loop on an unchanged head: one snapshot, one ref update attempt', async () => {
    const h = setup()
    let attempts = 0
    h.repo.hooks.onCall = method => {
      if (method === 'updateRef') {
        attempts += 1
        throw new HttpError('Repository rule violations found', 403)
      }
    }

    expectState(await h.operation.save(request(h), CONTEXT), 'failed')

    expect(attempts).toBe(1)
    expect(h.repo.count('createCommit')).toBe(1)
  })

  it('reports a page conflict when the page changed during a head move', async () => {
    const h = setup()
    h.repo.hooks.beforeUpdateRef = attempt => {
      if (attempt === 1) h.repo.pipelineCommit({[ALPHA]: wikiFiles()[ALPHA]?.replace('factories', 'plants') ?? ''})
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'conflict')

    expect(result).toMatchObject({kind: 'page', currentBlobSha: h.repo.blobShaAt(ALPHA)})
    expect(h.repo.files()[ALPHA]).toContain('plants')
  })

  it('reports a corrections conflict when this page entries changed during a head move', async () => {
    const h = setup()
    h.repo.hooks.beforeUpdateRef = attempt => {
      if (attempt === 1) {
        h.repo.pipelineCommit({[CORRECTIONS]: correctionsYaml(correctionRecord('late', 'R_alpha', 'Alpha builds'))})
      }
    }

    const result = expectState(
      await h.operation.save(request(h, {marks: [mark(EDITED_BODY, 'for factories')]}), CONTEXT),
      'conflict',
    )

    expect(result).toMatchObject({kind: 'corrections'})
  })

  it('reports a removed page when the page vanished during a head move', async () => {
    const h = setup()
    h.repo.hooks.beforeUpdateRef = attempt => {
      if (attempt === 1) h.repo.removeFile(ALPHA)
    }

    const result = await h.operation.save(request(h), CONTEXT)

    expect(result.state).toBe('conflict')
    expect(result).toMatchObject({kind: 'page-removed'})
  })
})

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('save: guards', () => {
  it('reports a page conflict with the current blob SHA when the page changed after load', async () => {
    const h = setup()
    const loaded = request(h)
    h.repo.pipelineCommit({[ALPHA]: wikiFiles()[ALPHA]?.replace('factories', 'plants') ?? ''})

    const result = expectState(await h.operation.save(loaded, CONTEXT), 'conflict')

    expect(result).toMatchObject({kind: 'page', currentBlobSha: h.repo.blobShaAt(ALPHA)})
    expect(h.repo.count('createBlob')).toBe(0)
    expect(h.repo.count('createCommit')).toBe(0)
  })

  it('reports a page-removed conflict when the page is gone', async () => {
    const h = setup()
    const loaded = request(h)
    h.repo.removeFile(ALPHA)

    const result = await h.operation.save(loaded, CONTEXT)

    expect(result).toMatchObject({state: 'conflict', kind: 'page-removed'})
    expect(h.repo.count('createCommit')).toBe(0)
  })

  it('reports a corrections conflict with the current entries when this page entries changed and the save writes corrections', async () => {
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets'))})
    const h = setup({files})

    const result = expectState(
      await h.operation.save(request(h, {marks: [mark(EDITED_BODY, 'for factories')]}), CONTEXT),
      'conflict',
    )

    expect(result.kind).toBe('corrections')
    if (result.kind !== 'corrections') return
    expect(result.currentCorrections.map(entry => entry.id)).toEqual(['c1'])
    expect(result.correctionsBase).toBe(correctionsDigest(parseCorrections(files[CORRECTIONS] ?? '').corrections))
    expect(h.repo.count('createCommit')).toBe(0)
  })

  it('conflicts a body-only save when this page entries were removed upstream, and commits nothing', async () => {
    const record = correctionRecord('c1', 'R_alpha', 'Alpha builds widgets')
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(record)})
    const h = setup({files})
    const loadedDigest = correctionsDigest(parseCorrections(files[CORRECTIONS] ?? '').corrections)
    const loaded = request(h, {correctionsBase: loadedDigest, body: EDITED_BODY.replace('Alpha builds widgets', 'Alpha builds things')})
    h.repo.pipelineCommit({[CORRECTIONS]: correctionsYaml()}, 'chore(pipeline): drop corrections')

    const result = expectState(await h.operation.save(loaded, CONTEXT), 'conflict')

    expect(result.kind).toBe('corrections')
    if (result.kind !== 'corrections') return
    expect(result.currentCorrections).toEqual([])
    expect(result.correctionsBase).toBe(EMPTY_CORRECTIONS_DIGEST)
    expect(h.repo.count('createCommit')).toBe(0)
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('conflicts a body-only save when this page gained an entry upstream', async () => {
    const h = setup()
    const loaded = request(h)
    h.repo.pipelineCommit(
      {[CORRECTIONS]: correctionsYaml(correctionRecord('c9', 'R_alpha', 'Alpha builds widgets'))},
      'chore(pipeline): add correction',
    )

    const result = await h.operation.save(loaded, CONTEXT)

    expect(result).toMatchObject({state: 'conflict', kind: 'corrections'})
    expect(h.repo.count('createCommit')).toBe(0)
  })

  it('saves a body-only edit when this page entries are unchanged since it was loaded', async () => {
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'for factories'))})
    const h = setup({files})
    const base = correctionsDigest(parseCorrections(files[CORRECTIONS] ?? '').corrections)

    const result = await h.operation.save(request(h, {correctionsBase: base}), CONTEXT)

    expectState(result, 'saved')
  })

  it('checks a page without a node id against the empty set', async () => {
    const files = wikiFiles()
    files[ALPHA] = files[ALPHA]?.replace(/^node_id:.*\n/mu, '') ?? ''
    const h = setup({files})

    expectState(await h.operation.save(request(h, {pageBlobSha: h.repo.blobShaAt(ALPHA)}), CONTEXT), 'saved')
  })

  it('does not conflict on drift in another page entries', async () => {
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('b1', 'R_beta', 'Beta ships gadgets'))})
    const h = setup({files})

    const result = await h.operation.save(request(h, {marks: [mark(EDITED_BODY, 'for factories')]}), CONTEXT)

    expectState(result, 'saved')
    expect(savedCorrections(h.repo).map(record => record.id)).toEqual(['b1', 'mint-1'])
  })

  it('treats a staged transition as a save that writes corrections', async () => {
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'for factories'))})
    const h = setup({files})

    const result = await h.operation.save(
      request(h, {correctionsBase: EMPTY_CORRECTIONS_DIGEST, transitions: [{id: 'c1', action: 'retire'}]}),
      CONTEXT,
    )

    expect(result).toMatchObject({state: 'conflict', kind: 'corrections'})
  })
})

// ---------------------------------------------------------------------------
// Gates and request checks
// ---------------------------------------------------------------------------

describe('save: gates and request checks', () => {
  it('rejects a rendering-policy violation with findings and commits nothing', async () => {
    const h = setup()

    const result = expectState(
      await h.operation.save(request(h, {body: `${EDITED_BODY}\n<script>alert(1)</script>\n`}), CONTEXT),
      'rejected',
    )

    expect(result.reason).toBe('gate')
    expect(result.findings?.map(finding => finding.kind)).toContain('unsafe-html')
    nothingCommitted(h)
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a frontmatter reconstruction failure generically', async () => {
    const files = wikiFiles()
    files[ALPHA] = 'no frontmatter at all\n'
    const h = setup({files})

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'rejected')

    expect(result.reason).toBe('gate')
    expect(result.findings ?? []).toEqual([])
    nothingCommitted(h)
  })

  it('does not echo the gate message or page text in finding messages', async () => {
    const h = setup()

    const result = expectState(
      await h.operation.save(request(h, {body: `${EDITED_BODY}\nSee [x](./secret-page-name.md).\n`}), CONTEXT),
      'rejected',
    )

    const text = JSON.stringify(result)
    expect(text).toContain('broken-markdown-link')
    expect(text).toContain('./secret-page-name.md')
    expect(result.findings?.every(finding => !finding.message.includes('secret-page-name'))).toBe(true)
  })

  it('rejects when the gates would write outside the page, log, index, and corrections', async () => {
    gateOverride.current = () => ({ok: true, files: {[ALPHA]: 'x', [WORKFLOW]: 'name: evil\n'}})
    const h = setup()

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'rejected')

    expect(result.reason).toBe('gate')
    expect(h.repo.count('createBlob')).toBe(0)
    expect(h.repo.count('createCommit')).toBe(0)
  })

  it.each([
    ['the knowledge schema', 'knowledge/schema.md'],
    ['another page', BETA],
    ['a nested page', 'knowledge/wiki/repos/nested/x.md'],
    ['the metadata file', 'metadata/repos.yaml'],
  ])('rejects a gate result that writes %s', async (_label, path) => {
    gateOverride.current = () => ({ok: true, files: {[ALPHA]: 'x', [path]: 'y'}})
    const h = setup()

    expectState(await h.operation.save(request(h), CONTEXT), 'rejected')

    expect(h.repo.count('createCommit')).toBe(0)
  })

  it.each([
    ['a null request', null],
    ['an array', []],
    ['a string', 'save'],
    ['a missing operation ID', request(setup(), {operationId: undefined})],
    ['an operation ID that is not a UUID', request(setup(), {operationId: 'op-1'})],
    ['an operation ID that is not version 4', request(setup(), {operationId: '00000000-0000-1000-8000-000000000001'})],
    ['a page ID with traversal', request(setup(), {pageId: '../../etc/passwd'})],
    ['a page ID with an encoded slash', request(setup(), {pageId: 'repos.a%2Fb'})],
    ['an unknown page type', request(setup(), {pageId: 'secrets.alpha'})],
    ['an empty blob SHA', request(setup(), {pageBlobSha: ''})],
    ['a short corrections digest', request(setup(), {correctionsBase: 'abc'})],
    ['a non-string body', request(setup(), {body: 5})],
    ['marks that are not an array', request(setup(), {marks: 'x'})],
    ['a mark without text', request(setup(), {marks: [{start: 0, end: 1}]})],
    ['a mark with an empty text', request(setup(), {marks: [{text: '', start: 0, end: 0}]})],
    ['a mark with a negative start', request(setup(), {marks: [{text: 'a', start: -1, end: 1}]})],
    ['a mark with a fractional end', request(setup(), {marks: [{text: 'a', start: 0, end: 1.5}]})],
    ['a mark that ends before it starts', request(setup(), {marks: [{text: 'a', start: 5, end: 2}]})],
    ['a mark beyond the body', request(setup(), {marks: [{text: 'a', start: 0, end: 999_999}]})],
    ['too many marks', request(setup(), {marks: Array.from({length: 101}, () => ({text: 'a', start: 0, end: 1}))})],
    ['a transition with an unknown action', request(setup(), {transitions: [{id: 'c1', action: 'delete'}]})],
    ['a transition without an ID', request(setup(), {transitions: [{action: 'retire'}]})],
    ['too many transitions', request(setup(), {transitions: Array.from({length: 101}, () => ({id: 'c', action: 'retire'}))})],
  ])('rejects %s before any network call', async (_label, input) => {
    const h = setup()

    const result = expectState(await h.operation.save(input, CONTEXT), 'rejected')

    expect(result.reason).toBe('invalid-request')
    expect(h.repo.calls).toHaveLength(0)
    expect(h.checkContract).not.toHaveBeenCalled()
  })

  it.each([['line break', 'octo\ncat'], ['empty', ''], ['spaces', 'octo cat'], ['trailer injection', 'a\nFro-Operation-Id: x']])(
    'rejects an operator login with %s before any network call',
    async (_label, operatorLogin) => {
      const h = setup()

      const result = expectState(await h.operation.save(request(h), {operatorLogin}), 'rejected')

      expect(result.reason).toBe('invalid-session')
      expect(h.repo.calls).toHaveLength(0)
    },
  )
})

// ---------------------------------------------------------------------------
// Gate contract
// ---------------------------------------------------------------------------

describe('save: gate contract', () => {
  it('rejects a version mismatch with no retry, and reads no snapshot', async () => {
    const h = setup({decision: MISMATCH})

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'contract-rejected')

    expect(result).toMatchObject({kind: 'mismatch', retry: false})
    expect(h.repo.calls).toHaveLength(0)
  })

  it('rejects an unreadable marker as retryable', async () => {
    const h = setup({decision: UNREADABLE})

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'contract-rejected')

    expect(result).toMatchObject({kind: 'unreadable', retry: true})
    expect(h.repo.calls).toHaveLength(0)
  })

  it('treats a throwing contract check as unreadable', async () => {
    const h = setup()
    h.checkContract.mockRejectedValue(new Error('checker blew up'))

    const result = await h.operation.save(request(h), CONTEXT)

    expect(result).toMatchObject({state: 'contract-rejected', kind: 'unreadable', retry: true})
  })
})

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

describe('save: reconcile', () => {
  const timeout = () => new HttpError('Request timed out', 500)

  it('finds the trailer after a ref update timeout that landed, and reports saved', async () => {
    const h = setup()
    h.repo.hooks.afterUpdateRef = () => {
      throw timeout()
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'saved')

    expect(result.commitSha).toBe(h.repo.head)
    expect(result.committedAt).toBe(h.repo.commit(h.repo.head).committedAt)
    expect(h.repo.count('updateRef')).toBe(1)
    expect(h.dispatch).toHaveBeenCalledTimes(1)
  })

  it('treats a server error and a network failure like a timeout', async () => {
    for (const error of [new HttpError('Bad Gateway', 502), new TypeError('fetch failed')]) {
      const h = setup()
      h.repo.hooks.afterUpdateRef = () => {
        throw error
      }

      expectState(await h.operation.save(request(h), CONTEXT), 'saved')
    }
  })

  it('reports indeterminate, retries nothing, when the update never landed; the lookup later says missing', async () => {
    const h = setup()
    h.repo.hooks.beforeUpdateRef = () => {
      throw timeout()
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'indeterminate')

    expect(result.operationId).toBe(opId(1))
    expect(h.repo.count('updateRef')).toBe(1) // exactly one attempt: no retry
    expect(h.repo.count('createCommit')).toBe(1)
    expect(h.dispatch).not.toHaveBeenCalled()
    await expect(
      lookupOperation(h.client, {operationId: opId(1), pageId: ALPHA_ID, startedAt: h.repo.clockMs - 5000}),
    ).resolves.toEqual({state: 'missing'})
  })

  describe('a request that was never sent', () => {
    it.each([
      ['a token timeout', new RequestNotSentError('GitHub request timed out', null)],
      ['a malformed mint response', new RequestNotSentError('Token mint returned an unexpected response', null)],
    ])('fails, safe to retry, with no reconcile after %s on the ref update', async (_label, error) => {
      const h = setup()
      h.repo.hooks.beforeUpdateRef = () => {
        throw error
      }

      const result = expectState(await h.operation.save(request(h), CONTEXT), 'failed')

      expect(result.retryable).toBe(true)
      expect(h.repo.count('listCommitsByPath')).toBe(0)
      expect(h.dispatch).not.toHaveBeenCalled()
    })

    it('fails without retry when the request was never sent because the credential was refused', async () => {
      const h = setup()
      h.repo.hooks.beforeUpdateRef = () => {
        throw new RequestNotSentError('Failed to mint a write token: refused', 403)
      }

      const result = expectState(await h.operation.save(request(h), CONTEXT), 'failed')

      expect(result.retryable).toBe(false)
      expect(h.repo.count('listCommitsByPath')).toBe(0)
    })

    it('stays indeterminate for a timeout after the request was sent', async () => {
      const h = setup()
      h.repo.hooks.beforeUpdateRef = () => {
        throw new Error('The operation was aborted due to timeout')
      }

      const result = expectState(await h.operation.save(request(h), CONTEXT), 'indeterminate')

      expect(result.operationId).toBe(opId(1))
      expect(h.repo.count('listCommitsByPath')).toBeGreaterThan(0)
    })
  })

  it('rejects saves as unreadable and retryable inside the failure window, with one marker fetch', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network unavailable'))
    let now = 0
    const checker = createGateContractChecker({fetch, now: () => now})
    const repo = new FakeRepo({files: wikiFiles()})
    const dispatch = vi.fn<() => Promise<DispatchResult>>(async () => ({ok: true}))
    const operation = createWikiWriteOperation({
      client: createWikiDataClient(repo.transport(), {blobCache: createBlobCache()}),
      checkContract: async () => checker.check(),
      dispatch: {dispatch},
      now: () => repo.clockMs,
    })
    const input = (n: number) => ({
      operationId: opId(n),
      pageId: ALPHA_ID,
      pageBlobSha: repo.blobShaAt(ALPHA),
      correctionsBase: EMPTY_CORRECTIONS_DIGEST,
      body: EDITED_BODY,
      marks: [],
      transitions: [],
    })

    const first = await operation.save(input(1), CONTEXT)
    now += 5000
    const second = await operation.save(input(2), CONTEXT)

    for (const result of [first, second]) expect(result).toEqual({state: 'contract-rejected', kind: 'unreadable', retry: true})
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(repo.count('createBlob')).toBe(0)
    expect(repo.count('createCommit')).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reports indeterminate when the path history listing fails', async () => {
    const h = setup()
    h.repo.hooks.afterUpdateRef = () => {
      throw timeout()
    }
    h.repo.hooks.onCall = method => {
      if (method === 'listCommitsByPath') throw new HttpError('Bad Gateway', 502)
    }

    const result = await h.operation.save(request(h), CONTEXT)

    expect(result.state).toBe('indeterminate')
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('finds the trailer through the path-scoped listing when data is busy', async () => {
    const h = setup()
    h.repo.hooks.afterUpdateRef = () => {
      for (let index = 0; index < 150; index += 1) {
        h.repo.pipelineCommit({[`knowledge/wiki/topics/busy-${index}.md`]: `busy ${index}\n`})
      }
      throw timeout()
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'saved')

    expect(h.repo.commit(result.commitSha).message).toContain(opId(1))
    const listings = h.repo.calls.filter(call => call.method === 'listCommitsByPath')
    expect(listings.map(call => call.params.path)).toEqual(expect.arrayContaining([ALPHA, CORRECTIONS]))
    expect(listings).toHaveLength(2)
    expect(listings.every(call => call.params.per_page === 100)).toBe(true)
  })

  it('lists history since the operation started, less a clock skew margin', async () => {
    const h = setup()
    const started = h.repo.clockMs
    h.repo.hooks.afterUpdateRef = () => {
      throw timeout()
    }

    await h.operation.save(request(h), CONTEXT)

    const since = h.repo.calls.find(call => call.method === 'listCommitsByPath')?.params.since
    expect(since).toBe(new Date(started - RECONCILE_SKEW_MS).toISOString())
  })
})

describe('lookupOperation', () => {
  it('finds a saved operation by ID, page, and start time', async () => {
    const h = setup()
    const startedAt = h.repo.clockMs
    const saved = expectState(await h.operation.save(request(h), CONTEXT), 'saved')

    const found = await lookupOperation(h.client, {operationId: opId(1), pageId: ALPHA_ID, startedAt})

    expect(found).toEqual({state: 'found', commitSha: saved.commitSha, committedAt: h.repo.commit(saved.commitSha).committedAt})
  })

  it('finds a corrections-only save, which does not touch the page', async () => {
    const files = wikiFiles({[CORRECTIONS]: correctionsYaml(correctionRecord('c1', 'R_alpha', 'Alpha builds widgets'))})
    const h = setup({files})
    const startedAt = h.repo.clockMs
    const base = correctionsDigest(parseCorrections(files[CORRECTIONS] ?? '').corrections)
    const saved = expectState(
      await h.operation.save(
        request(h, {body: ALPHA_BODY, correctionsBase: base, transitions: [{id: 'c1', action: 'retire'}]}),
        CONTEXT,
      ),
      'saved',
    )

    const found = await lookupOperation(h.client, {operationId: opId(1), pageId: ALPHA_ID, startedAt})

    expect(found).toMatchObject({state: 'found', commitSha: saved.commitSha})
  })

  it('says missing when no commit carries the operation ID', async () => {
    const h = setup()
    await h.operation.save(request(h), CONTEXT)

    await expect(
      lookupOperation(h.client, {operationId: opId(2), pageId: ALPHA_ID, startedAt: h.repo.clockMs - 60_000}),
    ).resolves.toEqual({state: 'missing'})
  })

  it('does not look at commits older than the start time', async () => {
    const h = setup()
    await h.operation.save(request(h), CONTEXT)
    h.repo.advance(10 * 60_000)

    await expect(
      lookupOperation(h.client, {operationId: opId(1), pageId: ALPHA_ID, startedAt: h.repo.clockMs}),
    ).resolves.toEqual({state: 'missing'})
  })

  it('answers for a page that has since been removed', async () => {
    const h = setup()
    const startedAt = h.repo.clockMs
    const saved = expectState(await h.operation.save(request(h), CONTEXT), 'saved')
    h.repo.removeFile(ALPHA)

    await expect(lookupOperation(h.client, {operationId: opId(1), pageId: ALPHA_ID, startedAt})).resolves.toMatchObject({
      state: 'found',
      commitSha: saved.commitSha,
    })
  })

  it('says unknown when history cannot be listed', async () => {
    const h = setup()
    h.repo.hooks.onCall = () => {
      throw new HttpError('Bad Gateway', 502)
    }

    await expect(
      lookupOperation(h.client, {operationId: opId(1), pageId: ALPHA_ID, startedAt: 0}),
    ).resolves.toEqual({state: 'unknown'})
  })

  it.each([
    ['a bad page ID', {operationId: opId(1), pageId: '../x', startedAt: 0}],
    ['a bad operation ID', {operationId: 'nope', pageId: ALPHA_ID, startedAt: 0}],
    ['a bad start time', {operationId: opId(1), pageId: ALPHA_ID, startedAt: Number.NaN}],
  ])('rejects %s before any network call', async (_label, input) => {
    const h = setup()

    await expect(lookupOperation(h.client, input)).resolves.toEqual({state: 'invalid-request'})
    expect(h.repo.calls).toHaveLength(0)
  })

  it('matches the trailer on a whole line, not a prefix or a mention', async () => {
    const h = setup()
    const startedAt = h.repo.clockMs
    h.repo.pipelineCommit({[ALPHA]: 'x'}, `look-alike\n\n${OPERATION_TRAILER}: ${opId(1)}0`)
    h.repo.pipelineCommit({[ALPHA]: 'y'}, `mention\n\nnote ${OPERATION_TRAILER}: ${opId(1)}`)

    await expect(lookupOperation(h.client, {operationId: opId(1), pageId: ALPHA_ID, startedAt})).resolves.toEqual({
      state: 'missing',
    })
  })

  it('is reachable from the operation object too', async () => {
    const h = setup()
    const startedAt = h.repo.clockMs
    await h.operation.save(request(h), CONTEXT)

    await expect(h.operation.lookup({operationId: opId(1), pageId: ALPHA_ID, startedAt})).resolves.toMatchObject({
      state: 'found',
    })
  })
})

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('save: dispatch', () => {
  it('reports saved-not-promoted with the commit SHA when the port reports failure; the commit is untouched', async () => {
    const h = setup({dispatchResult: {ok: false}})

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'saved-not-promoted')

    expect(result.commitSha).toBe(h.repo.head)
    expect(result.committedAt).toBe(h.repo.commit(h.repo.head).committedAt)
    expect(h.repo.files()[ALPHA]).toContain('gadgets')
    expect(h.dispatch).toHaveBeenCalledTimes(1)
  })

  it('reports saved-not-promoted when the port throws, and never throws to the caller', async () => {
    const h = setup()
    h.dispatch.mockRejectedValue(new Error('dispatch exploded'))

    const result = await h.operation.save(request(h), CONTEXT)

    expect(result).toMatchObject({state: 'saved-not-promoted', commitSha: h.repo.head})
  })

  it('calls the port only after the commit landed', async () => {
    const h = setup()
    let headWhenCalled: string | undefined
    h.dispatch.mockImplementation(async () => {
      headWhenCalled = h.repo.head
      return Promise.resolve({ok: true})
    })

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'saved')

    expect(headWhenCalled).toBe(result.commitSha)
  })

  it('does not dispatch for any save that commits nothing', async () => {
    const h = setup({decision: MISMATCH})

    await h.operation.save(request(h), CONTEXT)

    expect(h.dispatch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Failure and rate limits
// ---------------------------------------------------------------------------

describe('save: GitHub failures', () => {
  it('fails, safe to retry, when the snapshot cannot be read', async () => {
    const h = setup()
    h.repo.hooks.onCall = method => {
      if (method === 'getTree') throw new HttpError('Bad Gateway', 502)
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'failed')

    expect(result.retryable).toBe(true)
    nothingCommitted(h)
  })

  describe('a refused credential', () => {
    const refused = (status: number) => new WriteCredentialError('Failed to mint a write token: refused', status)

    it.each([401, 403, 404])('fails without retry when the write credential is refused with %d', async status => {
      const h = setup()
      h.repo.hooks.onCall = method => {
        if (method === 'getRef') throw refused(status)
      }

      const result = expectState(await h.operation.save(request(h), CONTEXT), 'failed')

      expect(result.retryable).toBe(false)
      expect(result.operationId).toBe(opId(1))
      nothingCommitted(h)
    })

    it.each([401, 403, 404])('fails without retry when a GitHub %d refuses the snapshot read', async status => {
      const h = setup()
      h.repo.hooks.onCall = method => {
        if (method === 'getTree') throw new HttpError('Refused', status)
      }

      const result = expectState(await h.operation.save(request(h), CONTEXT), 'failed')

      expect(result.retryable).toBe(false)
      nothingCommitted(h)
    })

    it.each([
      ['a server error', refused(502)],
      ['a credential failure with no status', new WriteCredentialError('Failed to mint a write token: timeout')],
      ['a rate limit on the mint', Object.assign(new WriteCredentialError('rate limit', 403), {})],
    ])('keeps %s retryable or rate-limited, never non-retryable', async (label, error) => {
      const h = setup()
      h.repo.hooks.onCall = method => {
        if (method === 'getRef') throw error
      }

      const result = await h.operation.save(request(h), CONTEXT)

      if (label === 'a rate limit on the mint') {
        // A 403 whose message names a rate limit is a rate limit, not a refusal.
        expect(result).toMatchObject({state: 'rate-limited'})
      } else {
        expect(expectState(result, 'failed').retryable).toBe(true)
      }
      nothingCommitted(h)
    })

    it.each([401, 403, 404])('fails without retry when the ref update is refused with %d by the write credential', async status => {
      const h = setup()
      h.repo.hooks.beforeUpdateRef = () => {
        throw refused(status)
      }

      const result = expectState(await h.operation.save(request(h), CONTEXT), 'failed')

      expect(result.retryable).toBe(false)
      expect(h.repo.count('updateRef')).toBe(1)
      expect(h.dispatch).not.toHaveBeenCalled()
    })

    it('keeps a refusal during the writes non-retryable and commits nothing', async () => {
      const h = setup()
      h.repo.hooks.onCall = method => {
        if (method === 'createBlob') throw refused(403)
      }

      const result = expectState(await h.operation.save(request(h), CONTEXT), 'failed')

      expect(result.retryable).toBe(false)
      expect(h.repo.count('createCommit')).toBe(0)
      expect(h.dispatch).not.toHaveBeenCalled()
    })
  })

  it.each(['createBlob', 'createTree', 'createCommit'])('fails with nothing committed when %s fails', async method => {
    const h = setup()
    h.repo.hooks.onCall = called => {
      if (called === method) throw new HttpError('Bad Gateway', 502)
    }

    const result = await h.operation.save(request(h), CONTEXT)

    expect(result.state).toBe('failed')
    expect(h.repo.count('updateRef')).toBe(0)
    expect(h.repo.head).toBe(h.headBefore)
  })

  it('does not reconcile when a step before the ref update fails', async () => {
    const h = setup()
    h.repo.hooks.onCall = method => {
      if (method === 'createCommit') throw new HttpError('Bad Gateway', 502)
    }

    await h.operation.save(request(h), CONTEXT)

    expect(h.repo.count('listCommitsByPath')).toBe(0)
  })

  it('fails, safe to retry, when the tree is truncated', async () => {
    const h = setup()
    const transport = h.repo.transport()
    const client = createWikiDataClient({...transport, getTree: async () => ({data: {tree: [], truncated: true}})})
    const operation = createWikiWriteOperation({client, checkContract: h.checkContract, dispatch: {dispatch: h.dispatch}})

    const result = await operation.save(request(h), CONTEXT)

    expect(result.state).toBe('failed')
  })

  it.each([
    ['a primary rate limit with a retry-after header', new HttpError('API rate limit exceeded', 403, {'retry-after': '17'}), 17],
    ['a secondary rate limit', new HttpError('You have exceeded a secondary rate limit', 403, {'retry-after': '60'}), 60],
    ['a 429', new HttpError('Too Many Requests', 429, {'retry-after': '5'}), 5],
    ['a rate limit with no hint', new HttpError('API rate limit exceeded', 403, {'x-ratelimit-remaining': '0'}), null],
  ])('returns rate-limited with a retry hint for %s, on the snapshot', async (_label, error, hint) => {
    const h = setup()
    h.repo.hooks.onCall = method => {
      if (method === 'getRef') throw error
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'rate-limited')

    expect(result.retryAfterSeconds).toBe(hint)
    nothingCommitted(h)
  })

  it('derives the hint from the reset time when there is no retry-after header', async () => {
    const h = setup()
    const reset = Math.ceil(Date.now() / 1000) + 30
    h.repo.hooks.onCall = method => {
      if (method === 'getRef') {
        throw new HttpError('API rate limit exceeded', 403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset)})
      }
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'rate-limited')

    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(29)
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(31)
  })

  it.each(['createBlob', 'createTree', 'createCommit', 'updateRef'])('returns rate-limited when %s is limited', async method => {
    const h = setup()
    h.repo.hooks.onCall = called => {
      if (called === method) throw new HttpError('API rate limit exceeded', 403, {'retry-after': '9'})
    }

    const result = expectState(await h.operation.save(request(h), CONTEXT), 'rate-limited')

    expect(result.retryAfterSeconds).toBe(9)
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.repo.count('listCommitsByPath')).toBe(0)
  })

  it('does not take an ordinary 403 for a rate limit', async () => {
    const h = setup()
    h.repo.hooks.onCall = method => {
      if (method === 'createBlob') throw new HttpError('Resource not accessible by integration', 403)
    }

    expectState(await h.operation.save(request(h), CONTEXT), 'failed')
  })

  it('never throws on an unexpected error', async () => {
    gateOverride.current = () => {
      throw new Error('unexpected')
    }
    const h = setup()

    const result = await h.operation.save(request(h), CONTEXT)

    expect(result.state).toBe('rejected')
  })
})

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function capture() {
  const lines: string[] = []
  const sink = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  vi.spyOn(console, 'log').mockImplementation(sink)
  vi.spyOn(console, 'warn').mockImplementation(sink)
  vi.spyOn(console, 'error').mockImplementation(sink)
  vi.spyOn(console, 'info').mockImplementation(sink)
  vi.spyOn(console, 'debug').mockImplementation(sink)
  return lines
}
const SENSITIVE = ['Alpha builds', 'gadgets', 'factories', 'acme', 'XSS-MARKER', 'secret-page-name', 'octocat', 'Beta ships']

async function runScenarios(): Promise<string[]> {
  const lines = capture()
  const body = `${EDITED_BODY}\nXSS-MARKER\n`

  const saved = setup()
  await saved.operation.save(request(saved, {marks: [mark(EDITED_BODY, 'Alpha builds gadgets')]}), CONTEXT)

  const rejected = setup()
  await rejected.operation.save(
    request(rejected, {operationId: opId(2), body: `${body}<script>XSS-MARKER</script>\nSee [[secret-page-name]].\n`}),
    CONTEXT,
  )

  const conflict = setup()
  const loaded = request(conflict, {operationId: opId(3)})
  conflict.repo.pipelineCommit({[ALPHA]: wikiFiles()[ALPHA]?.replace('factories', 'plants') ?? ''})
  await conflict.operation.save(loaded, CONTEXT)

  const failed = setup()
  failed.repo.hooks.onCall = method => {
    if (method === 'createBlob') throw new HttpError('boom Alpha builds gadgets acme/alpha', 502)
  }
  await failed.operation.save(request(failed, {operationId: opId(4)}), CONTEXT)

  const unknown = setup()
  unknown.repo.hooks.beforeUpdateRef = () => {
    throw new HttpError('timeout acme/alpha', 500)
  }
  await unknown.operation.save(request(unknown, {operationId: opId(5)}), CONTEXT)

  const notPromoted = setup({dispatchResult: {ok: false}})
  await notPromoted.operation.save(request(notPromoted, {operationId: opId(6)}), CONTEXT)

  const limited = setup()
  limited.repo.hooks.onCall = method => {
    if (method === 'getRef') throw new HttpError('API rate limit exceeded acme', 403, {'retry-after': '3'})
  }
  await limited.operation.save(request(limited, {operationId: opId(7)}), CONTEXT)

  return lines
}

describe('save: logging', () => {
  it('never logs page text, finding text, repository names, or the operator login', async () => {
    const lines = await runScenarios()
    const output = lines.join('\n')

    expect(lines.length).toBeGreaterThan(0)
    for (const text of SENSITIVE) expect(output).not.toContain(text)
  })

  it('logs the operation ID, the outcome class, and the attempt count', async () => {
    const lines = await runScenarios()
    const output = lines.join('\n')

    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(output).toContain(opId(n))
    for (const outcome of ['saved', 'rejected', 'conflict', 'failed', 'indeterminate', 'saved-not-promoted', 'rate-limited']) {
      expect(output).toContain(`"outcome":"${outcome}"`)
    }
    expect(output).toContain('"attempts":1')
  })

  it('routes through the shared logger', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const h = setup()

    await h.operation.save(request(h), CONTEXT)

    expect(info).toHaveBeenCalled()
  })
})
