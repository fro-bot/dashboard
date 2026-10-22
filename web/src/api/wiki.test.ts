import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  getWikiPage,
  listWikiPages,
  lookupWikiOperation,
  promotionStatus,
  retryPromotionDispatch,
  SAVE_TIMEOUT_MS,
  saveWikiPage,
} from './wiki.ts'

// ---------------------------------------------------------------------------
// Shared wire samples
// ---------------------------------------------------------------------------

interface Sample {
  readonly status: number
  readonly body: unknown
}

type SampleFile = Record<string, Record<string, Sample>>

const SAMPLES = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../test/fixtures/wiki-wire-samples.json'), 'utf8'),
) as SampleFile

function sample(group: string, key: string): Sample {
  const found = SAMPLES[group]?.[key]
  if (found === undefined) throw new Error(`No sample ${group}.${key}`)
  return found
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}})
}

function sampleResponse(group: string, key: string): Response {
  const {status, body} = sample(group, key)
  return jsonResponse(status, body)
}

function opaqueRedirect(): Response {
  const res = new Response(null)
  Object.defineProperty(res, 'type', {value: 'opaqueredirect'})
  Object.defineProperty(res, 'status', {value: 0})
  return res
}

const OPERATION_ID = '00000000-0000-4000-8000-000000000001'

const SAVE_INPUT = {
  pageId: 'repos.acme--alpha',
  operationId: OPERATION_ID,
  pageBlobSha: 'blob-bc079bf35740',
  correctionsBase: '84af704b511188e099d585af405ec64aa728d795249bc5cccdffcec5602b731f',
  body: '\n# acme/alpha\n\nEdited.\n',
} as const

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function nextResponse(response: Response): void {
  fetchMock.mockResolvedValueOnce(response)
}

function lastCall(): {url: string; init: RequestInit} {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit] | undefined
  if (call === undefined) throw new Error('fetch was not called')
  return {url: call[0], init: call[1]}
}

// ---------------------------------------------------------------------------
// Every sample parses to its typed outcome
// ---------------------------------------------------------------------------

interface SampleCase {
  readonly sample: string
  readonly call: () => Promise<unknown>
  readonly expected: unknown
}

const SAVED_FIELDS = {operationId: OPERATION_ID, commitSha: 'commit-2', committedAt: '2030-01-01T00:00:01.000Z'}
const callList = () => listWikiPages()
const callPage = () => getWikiPage('repos.acme--alpha')
const callSave = () => saveWikiPage(SAVE_INPUT)
const callLookup = () =>
  lookupWikiOperation({operationId: OPERATION_ID, pageId: 'repos.acme--alpha', startedAt: 1_900_000_000_000})
const callDispatch = () => retryPromotionDispatch()
const callStatus = () => promotionStatus()
const fail = (error: Record<string, unknown>) => ({ok: false, error})
const succeed = (value: Record<string, unknown>) => ({ok: true, value})

const CASES: readonly SampleCase[] = [
  {
    sample: 'list.ok',
    call: callList,
    expected: succeed({
      headSha: 'commit-1',
      canWrite: true,
      canWriteReason: null,
      pages: [
        {id: 'repos.acme--alpha', title: 'acme/alpha', type: 'repos', updated: '2026-02-01', canMark: true},
        {id: 'repos.acme--beta', title: 'acme/beta', type: 'repos', updated: '2026-02-01', canMark: true},
        {id: 'topics.beta-topic', title: 'Beta topic', type: 'topics', updated: '2026-02-01', canMark: false},
        {id: 'entities.gamma', title: 'Gamma', type: 'entities', updated: '2026-02-01', canMark: false},
      ],
    }),
  },
  {sample: 'list.unavailable', call: callList, expected: fail({kind: 'unavailable'})},
  {
    sample: 'page.ok',
    call: callPage,
    expected: succeed({
      id: 'repos.acme--alpha',
      type: 'repos',
      title: 'acme/alpha',
      updated: '2026-02-01',
      body: '\n# acme/alpha\n\nAlpha builds widgets for factories. See [[beta-topic]] and [[acme--beta]].\n',
      pageBlobSha: 'blob-bc079bf35740',
      nodeId: 'R_alpha',
      canMark: true,
      correctionsBase: '84af704b511188e099d585af405ec64aa728d795249bc5cccdffcec5602b731f',
      headSha: 'commit-1',
      contract: {ok: true},
      canWrite: true,
      canWriteReason: null,
      corrections: [
        {
          id: 'c1',
          status: 'active',
          span: {text: 'Alpha builds widgets'},
          attribution: null,
          reason: null,
          supersededBy: null,
          stale: false,
        },
      ],
    }),
  },
  {
    sample: 'page.contractMismatch',
    call: callPage,
    expected: succeed({contract: {ok: false, kind: 'mismatch', retry: false}}),
  },
  {
    sample: 'page.contractUnreadable',
    call: callPage,
    expected: succeed({contract: {ok: false, kind: 'unreadable', retry: true}}),
  },
  {sample: 'page.notFound', call: callPage, expected: fail({kind: 'not-found'})},
  {sample: 'page.unavailable', call: callPage, expected: fail({kind: 'unavailable'})},
  {sample: 'page.correctionsCorrupt', call: callPage, expected: fail({kind: 'corrections-corrupt'})},
  {sample: 'page.pageInvalid', call: callPage, expected: fail({kind: 'page-invalid'})},
  {sample: 'save.saved', call: callSave, expected: succeed({state: 'saved', ...SAVED_FIELDS})},
  {sample: 'save.notPromoted', call: callSave, expected: succeed({state: 'saved-not-promoted', ...SAVED_FIELDS})},
  {
    sample: 'save.rejected',
    call: callSave,
    expected: fail({
      kind: 'rejected',
      reason: 'gate',
      findings: [
        {
          kind: 'unsafe-html',
          path: 'knowledge/wiki/repos/acme--alpha.md',
          message: 'The page contains HTML that is not allowed.',
        },
      ],
    }),
  },
  {
    sample: 'save.rejectedWithTarget',
    call: callSave,
    expected: fail({
      kind: 'rejected',
      reason: 'gate',
      findings: [
        {
          kind: 'broken-markdown-link',
          path: 'knowledge/wiki/repos/acme--alpha.md',
          message: 'A link points to a page that does not exist.',
          target: './secret-page-name.md',
        },
      ],
    }),
  },
  {
    sample: 'save.contractRejected',
    call: callSave,
    expected: fail({kind: 'contract-rejected', reason: 'mismatch', retry: false}),
  },
  {
    sample: 'save.contractUnreadable',
    call: callSave,
    expected: fail({kind: 'contract-rejected', reason: 'unreadable', retry: true}),
  },
  {
    sample: 'save.conflictPage',
    call: callSave,
    expected: fail({kind: 'conflict', conflict: {kind: 'page', currentBlobSha: 'blob-bc079bf35740'}}),
  },
  {
    sample: 'save.conflictPageRemoved',
    call: callSave,
    expected: fail({kind: 'conflict', conflict: {kind: 'page-removed'}}),
  },
  {
    sample: 'save.conflictCorrections',
    call: callSave,
    expected: fail({
      kind: 'conflict',
      conflict: {
        kind: 'corrections',
        correctionsBase: '84af704b511188e099d585af405ec64aa728d795249bc5cccdffcec5602b731f',
        currentCorrections: [
          {
            id: 'c1',
            status: 'active',
            span: {text: 'Alpha builds widgets'},
            attribution: null,
            reason: null,
            supersededBy: null,
            stale: false,
          },
        ],
      },
    }),
  },
  {sample: 'save.failed', call: callSave, expected: fail({kind: 'failed', operationId: OPERATION_ID, retryable: true})},
  {
    sample: 'save.failedRefused',
    call: callSave,
    expected: fail({kind: 'failed', operationId: OPERATION_ID, retryable: false}),
  },
  {sample: 'save.indeterminate', call: callSave, expected: fail({kind: 'status-unknown', cause: 'indeterminate'})},
  {sample: 'save.limited', call: callSave, expected: fail({kind: 'rate-limited', retryAfterSeconds: 17})},
  {sample: 'save.forbidden', call: callSave, expected: fail({kind: 'forbidden'})},
  {sample: 'save.unsupported', call: callSave, expected: fail({kind: 'unsupported-media-type'})},
  {sample: 'save.tooLarge', call: callSave, expected: fail({kind: 'payload-too-large'})},
  {sample: 'save.badRequest', call: callSave, expected: fail({kind: 'bad-request'})},
  {
    sample: 'lookup.found',
    call: callLookup,
    expected: succeed({state: 'found', commitSha: 'commit-2', committedAt: '2030-01-01T00:00:01.000Z'}),
  },
  {sample: 'lookup.missing', call: callLookup, expected: succeed({state: 'missing'})},
  {sample: 'lookup.unknown', call: callLookup, expected: succeed({state: 'unknown'})},
  {sample: 'lookup.invalidRequest', call: callLookup, expected: fail({kind: 'invalid-request'})},
  {sample: 'lookup.forbidden', call: callLookup, expected: fail({kind: 'forbidden'})},
  {sample: 'dispatch.dispatched', call: callDispatch, expected: succeed({state: 'dispatched'})},
  {sample: 'dispatch.failed', call: callDispatch, expected: fail({kind: 'dispatch-failed'})},
  {sample: 'dispatch.limited', call: callDispatch, expected: fail({kind: 'rate-limited', retryAfterSeconds: 33})},
  {sample: 'status.pending', call: callStatus, expected: succeed({state: 'pending', pr: null})},
  {
    sample: 'status.settled',
    call: callStatus,
    expected: succeed({state: 'settled', pr: {number: 7, url: 'https://github.com/fro-bot/.github/pull/7'}}),
  },
  {
    sample: 'status.blocked',
    call: callStatus,
    expected: succeed({
      state: 'blocked',
      reason: 'private-page',
      runUrl: 'https://github.com/fro-bot/.github/actions/runs/3',
      pr: null,
    }),
  },
  {sample: 'status.unavailable', call: callStatus, expected: fail({kind: 'unavailable'})},
  {sample: 'status.configurationFault', call: callStatus, expected: fail({kind: 'configuration-fault'})},
  {sample: 'status.badRequest', call: callStatus, expected: fail({kind: 'bad-request'})},
  {sample: 'status.forbidden', call: callStatus, expected: fail({kind: 'forbidden'})},
]

describe('wire samples', () => {
  it('has a case for every sample in the shared file', () => {
    const inFile = Object.entries(SAMPLES).flatMap(([group, entries]) =>
      Object.keys(entries).map(key => `${group}.${key}`),
    )
    expect(CASES.map(c => c.sample).sort()).toEqual(inFile.sort())
  })

  it.each(CASES.map(c => [c.sample, c] as const))('%s parses to its typed outcome', async (_name, testCase) => {
    const [group, key] = testCase.sample.split('.') as [string, string]
    nextResponse(sampleResponse(group, key))

    expect(await testCase.call()).toMatchObject(testCase.expected as object)
  })

  it('treats a rejection without findings as an empty findings list', async () => {
    nextResponse(jsonResponse(422, {state: 'rejected', reason: 'no-change'}))

    expect(await callSave()).toEqual({ok: false, error: {kind: 'rejected', reason: 'no-change', findings: []}})
  })

  it('reads the Retry-After header when a rate-limited body has no usable seconds', async () => {
    nextResponse(jsonResponse(429, {state: 'rate-limited', retryAfterSeconds: null}, {'retry-after': '9'}))

    expect(await callSave()).toEqual({ok: false, error: {kind: 'rate-limited', retryAfterSeconds: 9}})
  })
})

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('request shape', () => {
  it('sends every request with redirect manual and same-origin credentials', async () => {
    nextResponse(sampleResponse('list', 'ok'))
    await callList()
    nextResponse(sampleResponse('page', 'ok'))
    await callPage()
    nextResponse(sampleResponse('save', 'saved'))
    await callSave()
    nextResponse(sampleResponse('lookup', 'found'))
    await callLookup()
    nextResponse(sampleResponse('dispatch', 'dispatched'))
    await callDispatch()
    nextResponse(sampleResponse('status', 'pending'))
    await callStatus()

    expect(fetchMock).toHaveBeenCalledTimes(6)
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(init.redirect).toBe('manual')
      expect(init.credentials).toBe('same-origin')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('does not set an Origin header; the browser supplies it', async () => {
    nextResponse(sampleResponse('save', 'saved'))
    await callSave()

    const headers = new Headers(lastCall().init.headers)
    expect([...headers.keys()].map(name => name.toLowerCase())).not.toContain('origin')
  })

  it('reads with GET and no body', async () => {
    nextResponse(sampleResponse('list', 'ok'))
    await callList()

    expect(lastCall().url).toBe('/api/wiki/pages')
    expect(lastCall().init.method).toBe('GET')
    expect(lastCall().init.body).toBeUndefined()
  })

  it('encodes the page ID in the read path', async () => {
    nextResponse(sampleResponse('page', 'ok'))
    await getWikiPage('repos.a b/c')

    expect(lastCall().url).toBe('/api/wiki/pages/repos.a%20b%2Fc')
  })

  it('posts a save as JSON with the operation ID and the base values the caller supplied', async () => {
    nextResponse(sampleResponse('save', 'saved'))
    await saveWikiPage({
      ...SAVE_INPUT,
      marks: [{text: 'Edited', start: 14, end: 20}],
      transitions: [{id: 'c1', action: 'retire'}],
    })

    const {url, init} = lastCall()
    expect(url).toBe('/api/wiki/pages/repos.acme--alpha/save')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({
      operationId: OPERATION_ID,
      pageBlobSha: SAVE_INPUT.pageBlobSha,
      correctionsBase: SAVE_INPUT.correctionsBase,
      body: SAVE_INPUT.body,
      marks: [{text: 'Edited', start: 14, end: 20}],
      transitions: [{id: 'c1', action: 'retire'}],
    })
  })

  it('defaults marks and transitions to empty lists, which the server requires', async () => {
    nextResponse(sampleResponse('save', 'saved'))
    await callSave()

    const sent = JSON.parse(lastCall().init.body as string) as Record<string, unknown>
    expect(sent.marks).toEqual([])
    expect(sent.transitions).toEqual([])
  })

  it('uses the operation ID the caller supplied and mints none itself', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
    nextResponse(sampleResponse('save', 'saved'))
    await callSave()

    expect(randomUUID).not.toHaveBeenCalled()
    expect((JSON.parse(lastCall().init.body as string) as {operationId: string}).operationId).toBe(OPERATION_ID)
  })

  it('posts the retry dispatch as JSON with an empty object', async () => {
    nextResponse(sampleResponse('dispatch', 'dispatched'))
    await callDispatch()

    const {url, init} = lastCall()
    expect(url).toBe('/api/wiki/promotion/dispatch')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(init.body).toBe('{}')
  })

  it('puts the lookup arguments in the query string', async () => {
    nextResponse(sampleResponse('lookup', 'found'))
    await callLookup()

    const url = new URL(lastCall().url, 'https://dashboard.test')
    expect(url.pathname).toBe(`/api/wiki/operations/${OPERATION_ID}`)
    expect(url.searchParams.get('pageId')).toBe('repos.acme--alpha')
    expect(url.searchParams.get('startedAt')).toBe('1900000000000')
    expect(lastCall().init.method).toBe('GET')
  })

  it('passes the since value to promotion status, and omits it when absent', async () => {
    nextResponse(sampleResponse('status', 'pending'))
    await promotionStatus('2030-01-01T00:00:01.000Z')
    expect(lastCall().url).toBe('/api/wiki/promotion/status?since=2030-01-01T00%3A00%3A01.000Z')

    nextResponse(sampleResponse('status', 'pending'))
    await promotionStatus()
    expect(lastCall().url).toBe('/api/wiki/promotion/status')
  })

  it('lookup makes one request per call and never polls', async () => {
    vi.useFakeTimers()
    try {
      nextResponse(sampleResponse('lookup', 'unknown'))
      await callLookup()
      await vi.advanceTimersByTimeAsync(120_000)

      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a save a longer timeout than the server GitHub budget of 30 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    nextResponse(sampleResponse('save', 'saved'))
    await callSave()

    expect(SAVE_TIMEOUT_MS).toBeGreaterThan(30_000)
    expect(timeout).toHaveBeenCalledWith(SAVE_TIMEOUT_MS)
  })
})

// ---------------------------------------------------------------------------
// Session loss, network, timeout
// ---------------------------------------------------------------------------

describe('session loss', () => {
  const readers: readonly (readonly [string, () => Promise<unknown>])[] = [
    ['list', callList],
    ['page', callPage],
    ['lookup', callLookup],
    ['dispatch', callDispatch],
    ['status', callStatus],
  ]

  it.each(readers)('maps an opaque redirect on %s to session lost', async (_name, call) => {
    nextResponse(opaqueRedirect())

    expect(await call()).toEqual({ok: false, error: {kind: 'session-lost'}})
  })

  it.each(readers)('maps a 302 on %s to session lost', async (_name, call) => {
    nextResponse(new Response(null, {status: 302, headers: {location: '/auth/login'}}))

    expect(await call()).toEqual({ok: false, error: {kind: 'session-lost'}})
  })

  it('maps a 401 on a read to session lost', async () => {
    nextResponse(jsonResponse(401, {error: 'nope'}))

    expect(await callPage()).toEqual({ok: false, error: {kind: 'session-lost'}})
  })

  it('maps an opaque redirect during save to save status unknown', async () => {
    nextResponse(opaqueRedirect())

    expect(await callSave()).toEqual({ok: false, error: {kind: 'status-unknown', cause: 'session-lost'}})
  })

  it('maps a 401 during save to save status unknown', async () => {
    nextResponse(jsonResponse(401, {error: 'nope'}))

    expect(await callSave()).toEqual({ok: false, error: {kind: 'status-unknown', cause: 'session-lost'}})
  })
})

describe('network failure and timeout', () => {
  const readers: readonly (readonly [string, () => Promise<unknown>])[] = [
    ['list', callList],
    ['page', callPage],
    ['lookup', callLookup],
    ['dispatch', callDispatch],
    ['status', callStatus],
  ]

  it.each(readers)('maps a network error on %s to a network failure', async (_name, call) => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    expect(await call()).toEqual({ok: false, error: {kind: 'network'}})
  })

  it.each(readers)('maps a timeout on %s to a timeout', async (_name, call) => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))

    expect(await call()).toEqual({ok: false, error: {kind: 'timeout'}})
  })

  it('maps a network error during save to save status unknown', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    expect(await callSave()).toEqual({ok: false, error: {kind: 'status-unknown', cause: 'network'}})
  })

  it('maps a timeout during save to save status unknown', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))

    expect(await callSave()).toEqual({ok: false, error: {kind: 'status-unknown', cause: 'timeout'}})
  })

  it('maps a body that cannot be read during save to save status unknown', async () => {
    const broken = new Response('{', {status: 200})
    vi.spyOn(broken, 'text').mockRejectedValue(new TypeError('terminated'))
    nextResponse(broken)

    expect(await callSave()).toEqual({ok: false, error: {kind: 'status-unknown', cause: 'network'}})
  })

  it('never retries a save', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await callSave()
    nextResponse(sampleResponse('save', 'indeterminate'))
    await callSave()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a read either', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await callList()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

describe('rate limit', () => {
  it('maps a plain-text 429 from the per-IP limiter to rate-limited, not contract drift', async () => {
    nextResponse(new Response('Too Many Requests', {status: 429, headers: {'retry-after': '12'}}))

    expect(await callPage()).toEqual({ok: false, error: {kind: 'rate-limited', retryAfterSeconds: 12}})
  })

  it('maps a plain-text 429 with no Retry-After to rate-limited with unknown seconds', async () => {
    nextResponse(new Response('Too Many Requests', {status: 429}))

    expect(await callList()).toEqual({ok: false, error: {kind: 'rate-limited', retryAfterSeconds: null}})
  })

  it('maps a plain-text 429 on a save to rate-limited, since nothing was committed', async () => {
    nextResponse(new Response('Too Many Requests', {status: 429}))

    expect(await callSave()).toEqual({ok: false, error: {kind: 'rate-limited', retryAfterSeconds: null}})
  })

  it('maps a lookup 429 to rate-limited', async () => {
    nextResponse(jsonResponse(429, {state: 'rate-limited', retryAfterSeconds: 4}))

    expect(await callLookup()).toEqual({ok: false, error: {kind: 'rate-limited', retryAfterSeconds: 4}})
  })
})

// ---------------------------------------------------------------------------
// Contract drift
// ---------------------------------------------------------------------------

function mutate(group: string, key: string, change: (body: Record<string, unknown>) => void): Response {
  const {status, body} = sample(group, key)
  const copy = structuredClone(body) as Record<string, unknown>
  change(copy)
  return jsonResponse(status, copy)
}

describe('contract drift', () => {
  const drift = {ok: false, error: {kind: 'contract-drift'}}
  // A save that drifts may have landed, so it is status-unknown, never a definite failure.
  const saveDrift = {ok: false, error: {kind: 'status-unknown', cause: 'contract-drift'}}

  it('treats an unknown save state as drift, not a crash', async () => {
    nextResponse(jsonResponse(200, {state: 'teleported', operationId: OPERATION_ID}))

    expect(await callSave()).toEqual(saveDrift)
  })

  it('treats a known save state on the wrong status as drift', async () => {
    nextResponse(jsonResponse(200, {state: 'conflict', kind: 'page-removed'}))

    expect(await callSave()).toEqual(saveDrift)
  })

  it('treats an unknown conflict kind as drift', async () => {
    nextResponse(mutate('save', 'conflictPage', body => (body.kind = 'branch')))

    expect(await callSave()).toEqual(saveDrift)
  })

  it('treats a saved response without a commit SHA as drift', async () => {
    nextResponse(mutate('save', 'saved', body => delete body.commitSha))

    expect(await callSave()).toEqual(saveDrift)
  })

  it('treats a conflict without the current blob SHA as drift', async () => {
    nextResponse(mutate('save', 'conflictPage', body => delete body.currentBlobSha))

    expect(await callSave()).toEqual(saveDrift)
  })

  it('treats a rejection with an unknown reason as drift', async () => {
    nextResponse(mutate('save', 'rejected', body => (body.reason = 'vibes')))

    expect(await callSave()).toEqual(saveDrift)
  })

  it('treats a malformed finding as drift', async () => {
    nextResponse(
      mutate('save', 'rejected', body => {
        body.findings = [{kind: 'unsafe-html', path: 'x'}]
      }),
    )

    expect(await callSave()).toEqual(saveDrift)
  })

  it('treats a contract rejection whose retry flag contradicts its kind as drift', async () => {
    nextResponse(mutate('save', 'contractRejected', body => (body.retry = true)))

    expect(await callSave()).toEqual(saveDrift)
  })

  it('treats a failed response without a retryable flag as drift', async () => {
    nextResponse(mutate('save', 'failed', body => delete body.retryable))

    expect(await callSave()).toEqual(saveDrift)
  })

  it('treats a non-JSON success as drift', async () => {
    nextResponse(new Response('<html>login</html>', {status: 200, headers: {'content-type': 'text/html'}}))

    expect(await callPage()).toEqual(drift)
  })

  it('treats a non-JSON 502 as drift', async () => {
    nextResponse(new Response('Bad Gateway', {status: 502}))

    expect(await callList()).toEqual(drift)
  })

  it('treats a JSON array as drift', async () => {
    nextResponse(jsonResponse(200, []))

    expect(await callList()).toEqual(drift)
  })

  it('treats a list page with an unknown page type as drift', async () => {
    nextResponse(
      mutate('list', 'ok', body => {
        ;((body.pages as Record<string, unknown>[])[0] as Record<string, unknown>).type = 'diaries'
      }),
    )

    expect(await callList()).toEqual(drift)
  })

  it('treats a list without a head SHA as drift', async () => {
    nextResponse(mutate('list', 'ok', body => delete body.headSha))

    expect(await callList()).toEqual(drift)
  })

  it('treats a page without a blob SHA as drift', async () => {
    nextResponse(mutate('page', 'ok', body => delete body.pageBlobSha))

    expect(await callPage()).toEqual(drift)
  })

  it('treats a page with a non-array corrections field as drift', async () => {
    nextResponse(mutate('page', 'ok', body => (body.corrections = {})))

    expect(await callPage()).toEqual(drift)
  })

  it('treats a correction with an unknown lifecycle as drift', async () => {
    nextResponse(
      mutate('page', 'ok', body => {
        ;((body.corrections as Record<string, unknown>[])[0] as Record<string, unknown>).status = 'haunted'
      }),
    )

    expect(await callPage()).toEqual(drift)
  })

  it('treats an unknown contract verdict as drift', async () => {
    nextResponse(mutate('page', 'contractMismatch', body => ((body.contract as Record<string, unknown>).kind = 'shrug')))

    expect(await callPage()).toEqual(drift)
  })

  it('treats a page without the corrections base as drift', async () => {
    nextResponse(mutate('page', 'ok', body => delete body.correctionsBase))

    expect(await callPage()).toEqual(drift)
  })

  it('treats an unknown lookup state as drift', async () => {
    nextResponse(jsonResponse(200, {state: 'maybe'}))

    expect(await callLookup()).toEqual(drift)
  })

  it('treats a found lookup without a commit SHA as drift', async () => {
    nextResponse(mutate('lookup', 'found', body => delete body.commitSha))

    expect(await callLookup()).toEqual(drift)
  })

  it('accepts a found lookup with a null commit time', async () => {
    nextResponse(mutate('lookup', 'found', body => (body.committedAt = null)))

    expect(await callLookup()).toMatchObject({ok: true, value: {state: 'found', committedAt: null}})
  })

  it('treats an unknown promotion state as drift', async () => {
    nextResponse(jsonResponse(200, {state: 'eventually'}))

    expect(await callStatus()).toEqual(drift)
  })

  it('treats a blocked status with an unknown reason as drift', async () => {
    nextResponse(mutate('status', 'blocked', body => (body.reason = 'moon-phase')))

    expect(await callStatus()).toEqual(drift)
  })

  it('treats a blocked status without a run URL as drift', async () => {
    nextResponse(mutate('status', 'blocked', body => delete body.runUrl))

    expect(await callStatus()).toEqual(drift)
  })

  it('treats a promotion PR link that is not https as drift', async () => {
    nextResponse(
      mutate('status', 'settled', body => {
        ;(body.pr as Record<string, unknown>).url = 'javascript:alert(1)'
      }),
    )

    expect(await callStatus()).toEqual(drift)
  })

  it('treats an unknown dispatch state as drift', async () => {
    nextResponse(jsonResponse(200, {state: 'sent-ish'}))

    expect(await callDispatch()).toEqual(drift)
  })
})
