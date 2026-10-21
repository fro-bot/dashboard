import type {DispatchPort} from '../src/wiki/write-operation.ts'

import {afterEach, describe, expect, it, vi} from 'vitest'
import {WriteCredentialError} from '../src/github/fro-bot-app-client.ts'
import {createWikiDataClient} from '../src/wiki/data-client.ts'
import {
  createDispatchPort,
  createPromotionStatusReader,
  PROMOTION_CACHE_MAX_ENTRIES,
  PROMOTION_CACHE_TTL_MS,
  reasonForStep,
} from '../src/wiki/promotion.ts'
import {HttpError} from './wiki-fake-repo.ts'

// ---------------------------------------------------------------------------
// Fake GitHub
// ---------------------------------------------------------------------------

const RUN_URL = 'https://github.com/fro-bot/.github/actions/runs'
const PR_URL = 'https://github.com/fro-bot/.github/pull'

/** Step names as they appear on real `merge-data.yaml` runs. */
const STEPS = {
  setup: 'Set up job',
  token: 'Get Workflow Access Token',
  checkout: '\u2935 Checkout Branch',
  install: '\uD83D\uDCE6 Setup',
  merge: '\uD83D\uDD01 Merge main into data',
  fetchForPrivacy: '\u2935 Fetch data branch for privacy check',
  privatePages: '\uD83D\uDD12 Block private wiki pages',
  fetchForDiff: '\uD83D\uDD12 Fetch data ref for promotion diff',
  privateNames: '\uD83D\uDD12 Block private repo names in promotion diff',
  openPr: '\uD83D\uDD00 Open data merge PR',
} as const

interface RunSpec {
  id?: number
  status?: string
  conclusion?: string | null
  event?: string
  createdAt?: string
}

function run(spec: RunSpec = {}) {
  return {
    id: spec.id ?? 100,
    status: spec.status ?? 'completed',
    conclusion: spec.conclusion === undefined ? 'success' : spec.conclusion,
    event: spec.event ?? 'repository_dispatch',
    created_at: spec.createdAt ?? '2030-01-01T00:10:00Z',
    html_url: 'https://example.invalid/not-used',
    display_title: 'acme/secret-repo LOG-TEXT-MARKER',
  }
}

function failedJob(failedStep: string, extraSteps: {name: string; conclusion: string}[] = []) {
  return {
    name: 'acme/secret-repo job',
    conclusion: 'failure',
    steps: [
      {name: STEPS.setup, conclusion: 'success'},
      {name: STEPS.token, conclusion: 'success'},
      {name: failedStep, conclusion: 'failure'},
      {name: STEPS.openPr, conclusion: 'skipped'},
      ...extraSteps,
    ],
  }
}

interface World {
  pulls: unknown
  runs: unknown
  jobs: unknown
}

function world(overrides: Partial<World> = {}): World {
  return {pulls: [], runs: [], jobs: [], ...overrides}
}

function pull(number = 4035) {
  return {number, html_url: 'https://example.invalid/pr', created_at: '2030-01-01T00:05:00Z'}
}

function build(initial: World, now: () => number = () => 0) {
  const state = {...initial}
  const calls: string[] = []
  const errors: Partial<Record<'listPulls' | 'listWorkflowRuns' | 'listRunJobs' | 'createDispatch', unknown>> = {}
  const gate = (name: keyof typeof errors) => {
    calls.push(name)
    const error = errors[name]
    if (error !== undefined) throw error
  }
  const transport = {
    createDispatch: vi.fn(async (params: Record<string, unknown>) => {
      gate('createDispatch')
      return {data: params}
    }),
    listPulls: vi.fn(async () => {
      gate('listPulls')
      return {data: state.pulls}
    }),
    listWorkflowRuns: vi.fn(async () => {
      gate('listWorkflowRuns')
      return {data: {workflow_runs: state.runs}}
    }),
    listRunJobs: vi.fn(async () => {
      gate('listRunJobs')
      return {data: {jobs: state.jobs}}
    }),
  }
  const client = createWikiDataClient(transport)
  const reader = createPromotionStatusReader({client, now})
  return {state, calls, errors, transport, client, reader, port: createDispatchPort({client})}
}

function capture() {
  const lines: string[] = []
  const sink = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(sink),
    vi.spyOn(console, 'warn').mockImplementation(sink),
    vi.spyOn(console, 'error').mockImplementation(sink),
    vi.spyOn(console, 'info').mockImplementation(sink),
    vi.spyOn(console, 'debug').mockImplementation(sink),
  ]
  return {lines, error: spies[2]}
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Dispatch port
// ---------------------------------------------------------------------------

describe('dispatch port', () => {
  it('sends the promote-data repository dispatch with no payload and reports success', async () => {
    const w = build(world())

    await expect(w.port.dispatch()).resolves.toEqual({ok: true})

    expect(w.transport.createDispatch).toHaveBeenCalledTimes(1)
    expect(w.transport.createDispatch).toHaveBeenCalledWith({owner: 'fro-bot', repo: '.github', event_type: 'promote-data'})
    expect(w.transport.createDispatch.mock.calls[0]?.[0]).not.toHaveProperty('client_payload')
  })

  it('satisfies the write operation dispatch port', () => {
    const port: DispatchPort = build(world()).port

    expect(typeof port.dispatch).toBe('function')
  })

  it.each([
    ['a timeout', new HttpError('Request timed out', 500)],
    ['a server error', new HttpError('Bad Gateway', 502)],
    ['a validation failure', new HttpError('Validation Failed', 422)],
    ['a network failure', new TypeError('fetch failed')],
    ['a non-error throw', 'boom'],
  ])('reports failure for %s and never throws', async (_label, error) => {
    const w = build(world())
    w.errors.createDispatch = error

    await expect(w.port.dispatch()).resolves.toEqual({ok: false, rateLimit: null})
    expect(w.transport.createDispatch).toHaveBeenCalledTimes(1)
  })

  it('reports a thrown token source failure as a dispatch failure', async () => {
    const client = createWikiDataClient({
      createDispatch: async () => {
        throw new Error('mint failed')
      },
    })

    await expect(createDispatchPort({client}).dispatch()).resolves.toMatchObject({ok: false})
  })

  it('retries by calling the same port again; it commits nothing and succeeds once GitHub recovers', async () => {
    const w = build(world())
    w.errors.createDispatch = new HttpError('Bad Gateway', 502)

    expect(await w.port.dispatch()).toMatchObject({ok: false})
    delete w.errors.createDispatch
    expect(await w.port.dispatch()).toEqual({ok: true})

    expect(w.transport.createDispatch).toHaveBeenCalledTimes(2)
    expect(w.calls.filter(call => call !== 'createDispatch')).toEqual([])
  })

  it('reports a rate limit with its hint and does not retry on its own', async () => {
    const w = build(world())
    w.errors.createDispatch = new HttpError('API rate limit exceeded', 403, {'retry-after': '21'})

    await expect(w.port.dispatch()).resolves.toEqual({ok: false, rateLimit: {retryAfterSeconds: 21}})
    expect(w.transport.createDispatch).toHaveBeenCalledTimes(1)
  })

  it.each([403, 404, 401])('logs a %s refusal at error level and still reports failure', async status => {
    const logs = capture()
    const w = build(world())
    w.errors.createDispatch = new HttpError('Resource not accessible', status)

    await expect(w.port.dispatch()).resolves.toMatchObject({ok: false})

    expect(logs.error).toHaveBeenCalled()
  })

  it('logs a transient failure below error level', async () => {
    const logs = capture()
    const w = build(world())
    w.errors.createDispatch = new HttpError('Bad Gateway', 502)

    await w.port.dispatch()

    expect(logs.error).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Step names
// ---------------------------------------------------------------------------

describe('reasonForStep', () => {
  it.each([
    [STEPS.privatePages, 'private-page'],
    [STEPS.privateNames, 'private-repo-name'],
    [STEPS.fetchForDiff, 'promotion-diff'],
    [STEPS.fetchForPrivacy, 'privacy-check'],
    [STEPS.merge, 'merge'],
    [STEPS.openPr, 'open-pr'],
  ])('maps the real step %j to %s', (name, reason) => {
    expect(reasonForStep(name)).toBe(reason)
  })

  it.each([
    ['\uD83D\uDD12 Block private wiki pages', 'private-page'],
    ['\uD83D\uDD12\uFE0F  Block private wiki pages', 'private-page'],
    ['  \u2935\uFE0F Block private wiki pages', 'private-page'],
    ['\u200D\uD83D\uDD12Block private wiki pages', 'private-page'],
    ['Block private wiki pages', 'private-page'],
    ['BLOCK PRIVATE WIKI PAGES', 'private-page'],
    ['\uD83D\uDD12 Block   private wiki pages', 'private-page'],
  ])('ignores a leading symbol, spacing, and case in %j', (name, reason) => {
    expect(reasonForStep(name)).toBe(reason)
  })

  it.each([
    ['an unknown name', '\uD83D\uDE80 Deploy the thing'],
    ['an empty name', ''],
    ['a symbol-only name', '\uD83D\uDD12'],
    ['a name that only contains a known one', 'Block private wiki pages again'],
    ['a post step', 'Post \u2935 Fetch data branch for privacy check'],
  ])('falls back to the generic reason for %s', (_label, name) => {
    expect(reasonForStep(name)).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// Status mapping: one test per run state
// ---------------------------------------------------------------------------

describe('promotion status: run states', () => {
  it('is pending for a run in progress, with no PR link when there is no PR yet', async () => {
    const w = build(world({runs: [run({status: 'in_progress', conclusion: null})]}))

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'pending', pr: null})
  })

  it.each(['queued', 'waiting', 'requested', 'pending'])('is pending for a %s run', async status => {
    const w = build(world({runs: [run({status, conclusion: null})]}))

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'pending', pr: null})
  })

  it('is pending, not blocked, when the newest run was cancelled by a newer dispatch', async () => {
    const w = build(world({runs: [run({conclusion: 'cancelled'})]}))

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'pending', pr: null})
    expect(w.transport.listRunJobs).not.toHaveBeenCalled()
  })

  it.each(['action_required', 'stale'])('is pending for a run concluded as %s', async conclusion => {
    const w = build(world({runs: [run({conclusion})]}))

    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'pending'})
  })

  it('is pending when no run exists yet', async () => {
    const w = build(world())

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'pending', pr: null})
  })

  it('is settled for a successful run, with the open PR number and URL', async () => {
    const w = build(world({pulls: [pull(4035)], runs: [run({conclusion: 'success'})]}))

    await expect(w.reader.getStatus()).resolves.toEqual({
      state: 'settled',
      pr: {number: 4035, url: `${PR_URL}/4035`},
    })
  })

  it('is settled with no PR link when no PR is open', async () => {
    const w = build(world({runs: [run({conclusion: 'success'})]}))

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'settled', pr: null})
  })

  it.each(['neutral', 'skipped'])('is settled for a run concluded as %s', async conclusion => {
    const w = build(world({runs: [run({conclusion})]}))

    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'settled'})
  })

  it('is blocked for a failed run, with a link to the run and a coarse reason from the failed step', async () => {
    const w = build(
      world({
        runs: [run({id: 35545734311, conclusion: 'failure', event: 'schedule'})],
        jobs: [failedJob(STEPS.privatePages)],
      }),
    )

    await expect(w.reader.getStatus()).resolves.toEqual({
      state: 'blocked',
      reason: 'private-page',
      runUrl: `${RUN_URL}/35545734311`,
      pr: null,
    })
  })

  it.each([
    [STEPS.privatePages, 'private-page'],
    [STEPS.privateNames, 'private-repo-name'],
    [STEPS.fetchForDiff, 'promotion-diff'],
    [STEPS.fetchForPrivacy, 'privacy-check'],
    [STEPS.merge, 'merge'],
    [STEPS.openPr, 'open-pr'],
  ])('maps a failure at %j to the reason %s', async (step, reason) => {
    const w = build(world({runs: [run({conclusion: 'failure'})], jobs: [failedJob(step)]}))

    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'blocked', reason})
  })

  it('is blocked with the generic reason for an unrecognised failed step', async () => {
    const w = build(world({runs: [run({conclusion: 'failure'})], jobs: [failedJob('\uD83D\uDE80 Deploy the thing')]}))

    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'blocked', reason: 'unknown'})
  })

  it.each(['timed_out', 'startup_failure'])('is blocked for a run concluded as %s', async conclusion => {
    const w = build(world({runs: [run({conclusion})], jobs: [failedJob(STEPS.merge)]}))

    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'blocked', reason: 'merge'})
  })

  it('is blocked with the generic reason when a failed run has no failed step to read', async () => {
    const w = build(world({runs: [run({conclusion: 'failure'})], jobs: []}))

    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'blocked', reason: 'unknown'})
  })

  it('takes the first failed step of the first failed job', async () => {
    const w = build(
      world({
        runs: [run({conclusion: 'failure'})],
        jobs: [
          {name: 'ok', conclusion: 'success', steps: [{name: STEPS.merge, conclusion: 'success'}]},
          failedJob(STEPS.privateNames, [{name: `Post ${STEPS.install}`, conclusion: 'failure'}]),
          failedJob(STEPS.merge),
        ],
      }),
    )

    await expect(w.reader.getStatus()).resolves.toMatchObject({reason: 'private-repo-name'})
  })

  it('carries the open PR on a blocked status too', async () => {
    const w = build(world({pulls: [pull(7)], runs: [run({conclusion: 'failure'})], jobs: [failedJob(STEPS.privatePages)]}))

    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'blocked', pr: {number: 7, url: `${PR_URL}/7`}})
  })

  it('builds its links from IDs, ignoring any URL GitHub returns', async () => {
    const w = build(world({pulls: [pull(9)], runs: [run({id: 55, conclusion: 'success'})]}))

    const status = await w.reader.getStatus()

    expect(JSON.stringify(status)).not.toContain('example.invalid')
    expect(status).toMatchObject({pr: {url: `${PR_URL}/9`}})
  })
})

// ---------------------------------------------------------------------------
// Status mapping: sequences
// ---------------------------------------------------------------------------

describe('promotion status: sequences', () => {
  it('keeps the PR open across two saves: the first run is cancelled, the second succeeds', async () => {
    let now = 0
    const w = build(world({pulls: [pull(4035)], runs: [run({id: 1, conclusion: 'cancelled'})]}), () => now)

    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'pending', pr: {number: 4035}})

    now += PROMOTION_CACHE_TTL_MS + 1
    w.state.runs = [run({id: 2, conclusion: 'success'})]
    await expect(w.reader.getStatus()).resolves.toEqual({state: 'settled', pr: {number: 4035, url: `${PR_URL}/4035`}})
  })

  it('clears blocked when a later run succeeds', async () => {
    let now = 0
    const w = build(world({runs: [run({id: 1, conclusion: 'failure'})], jobs: [failedJob(STEPS.privatePages)]}), () => now)
    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'blocked'})

    now += PROMOTION_CACHE_TTL_MS + 1
    w.state.runs = [run({id: 2, conclusion: 'success', createdAt: '2030-01-02T00:00:00Z'})]
    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'settled'})
  })

  it('reads a scheduled run that failed at the private-page step as blocked, with no save involved', async () => {
    const w = build(
      world({
        runs: [run({id: 35545734311, conclusion: 'failure', event: 'schedule', createdAt: '2026-09-20T23:48:40Z'})],
        jobs: [failedJob(STEPS.privatePages)],
      }),
    )

    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'blocked', reason: 'private-page'})
  })

  it('does not tie the run to an event type', async () => {
    for (const event of ['repository_dispatch', 'schedule', 'workflow_dispatch']) {
      const w = build(world({runs: [run({conclusion: 'success', event})]}))
      await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'settled'})
    }
  })

  it('ignores a run created before since, so an older failure cannot answer for a newer save', async () => {
    const w = build(
      world({
        runs: [run({conclusion: 'failure', createdAt: '2030-01-01T00:00:00Z'})],
        jobs: [failedJob(STEPS.privatePages)],
      }),
    )

    await expect(w.reader.getStatus('2030-01-01T00:05:00Z')).resolves.toEqual({state: 'pending', pr: null})
    expect(w.transport.listRunJobs).not.toHaveBeenCalled()
  })

  it('stays pending until a run at or after since appears, then maps it', async () => {
    let now = 0
    const w = build(world({runs: [run({conclusion: 'success', createdAt: '2030-01-01T00:00:00Z'})]}), () => now)
    const since = '2030-01-01T00:05:00Z'
    await expect(w.reader.getStatus(since)).resolves.toMatchObject({state: 'pending'})

    now += PROMOTION_CACHE_TTL_MS + 1
    w.state.runs = [run({conclusion: 'success', createdAt: since})]
    await expect(w.reader.getStatus(since)).resolves.toMatchObject({state: 'settled'})
  })

  it('keeps the PR link on a pending status that ignored an old run', async () => {
    const w = build(world({pulls: [pull(3)], runs: [run({conclusion: 'success', createdAt: '2030-01-01T00:00:00Z'})]}))

    await expect(w.reader.getStatus('2030-02-01T00:00:00Z')).resolves.toEqual({
      state: 'pending',
      pr: {number: 3, url: `${PR_URL}/3`},
    })
  })

  it('ignores a since that is not a time', async () => {
    const w = build(world({runs: [run({conclusion: 'success'})]}))

    await expect(w.reader.getStatus('not-a-time')).resolves.toMatchObject({state: 'settled'})
  })

  it('asks GitHub for the open PRs from data into main and the newest merge-data run', async () => {
    const w = build(world())

    await w.reader.getStatus()

    expect(w.transport.listPulls).toHaveBeenCalledWith(
      expect.objectContaining({state: 'open', head: 'fro-bot:data', base: 'main'}),
    )
    expect(w.transport.listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({workflow_id: 'merge-data.yaml', per_page: 1}),
    )
  })
})

// ---------------------------------------------------------------------------
// Request budget and cache
// ---------------------------------------------------------------------------

describe('promotion status: request budget and cache', () => {
  const FAILED = {runs: [run({conclusion: 'failure'})], jobs: [failedJob(STEPS.privatePages)]}

  it.each([
    ['pending', world({runs: [run({status: 'queued', conclusion: null})]}), 2],
    ['settled', world({pulls: [pull()], runs: [run()]}), 2],
    ['cancelled', world({runs: [run({conclusion: 'cancelled'})]}), 2],
    ['no run', world(), 2],
    ['blocked', world(FAILED), 3],
  ])('makes at most the budgeted requests for a %s read', async (_label, initial, expected) => {
    const w = build(initial)

    await w.reader.getStatus()

    expect(w.calls).toHaveLength(expected)
    expect(w.calls.length).toBeLessThanOrEqual(3)
  })

  it('serves two reads inside the polling interval from one set of requests', async () => {
    let now = 1000
    const w = build(world(FAILED), () => now)

    const first = await w.reader.getStatus()
    now += PROMOTION_CACHE_TTL_MS - 1
    const second = await w.reader.getStatus()

    expect(second).toEqual(first)
    expect(w.calls).toHaveLength(3)
  })

  it('reads again once the cache lifetime has passed', async () => {
    let now = 1000
    const w = build(world(FAILED), () => now)

    await w.reader.getStatus()
    now += PROMOTION_CACHE_TTL_MS
    await w.reader.getStatus()

    expect(w.calls).toHaveLength(6)
  })

  it('keeps the cache lifetime under the 15 second client poll', () => {
    expect(PROMOTION_CACHE_TTL_MS).toBeGreaterThan(0)
    expect(PROMOTION_CACHE_TTL_MS).toBeLessThan(15_000)
  })

  it('keys the cache by since', async () => {
    const w = build(world({runs: [run()]}))

    await w.reader.getStatus()
    await w.reader.getStatus('2030-01-01T00:00:00Z')
    await w.reader.getStatus('2030-01-01T00:00:00Z')
    await w.reader.getStatus()

    expect(w.calls).toHaveLength(4)
  })

  it('shares one set of requests between concurrent reads of the same key', async () => {
    const w = build(world(FAILED))

    const results = await Promise.all([w.reader.getStatus(), w.reader.getStatus(), w.reader.getStatus()])

    expect(w.calls).toHaveLength(3)
    expect(results[1]).toEqual(results[0])
  })

  it('bounds the cache, so many distinct since values do not grow it without limit', async () => {
    const w = build(world({runs: [run()]}))
    const total = PROMOTION_CACHE_MAX_ENTRIES + 5

    for (let index = 0; index < total; index += 1) {
      await w.reader.getStatus(new Date(Date.parse('2030-01-01T00:00:00Z') + index * 1000).toISOString())
    }
    const before = w.calls.length
    await w.reader.getStatus(new Date(Date.parse('2030-01-01T00:00:00Z') + (total - 1) * 1000).toISOString())
    expect(w.calls.length).toBe(before)
    await w.reader.getStatus(new Date(Date.parse('2030-01-01T00:00:00Z')).toISOString())
    expect(w.calls.length).toBeGreaterThan(before)
    expect(w.reader.cacheSize()).toBeLessThanOrEqual(PROMOTION_CACHE_MAX_ENTRIES)
  })

  it('does not cache across readers', async () => {
    const one = build(world({runs: [run()]}))
    const two = build(world({runs: [run()]}))

    await one.reader.getStatus()
    await two.reader.getStatus()

    expect(one.calls).toHaveLength(2)
    expect(two.calls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('promotion status: errors', () => {
  it.each([
    ['a timeout', new HttpError('Request timed out', 500)],
    ['a server error', new HttpError('Bad Gateway', 502)],
    ['a network failure', new TypeError('fetch failed')],
    ['a primary rate limit', new HttpError('API rate limit exceeded', 403, {'x-ratelimit-remaining': '0'})],
    ['a secondary rate limit', new HttpError('You have exceeded a secondary rate limit', 403, {'retry-after': '30'})],
    ['a 429', new HttpError('Too Many Requests', 429)],
  ])('returns unavailable for %s', async (_label, error) => {
    const logs = capture()
    const w = build(world({runs: [run()]}))
    w.errors.listWorkflowRuns = error

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'unavailable'})
    expect(logs.error).not.toHaveBeenCalled()
  })

  it.each([
    ['a 403', 403],
    ['a 404', 404],
    ['a 401', 401],
  ])('returns a configuration fault for %s and logs it at error level', async (_label, status) => {
    const logs = capture()
    const w = build(world({runs: [run()]}))
    w.errors.listWorkflowRuns = new HttpError('Resource not accessible by integration', status)

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'configuration-fault'})
    expect(logs.error).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 404])('reports a configuration fault when the write credential is refused with %d', async status => {
    const logs = capture()
    const w = build(world({runs: [run()]}))
    w.errors.listWorkflowRuns = new WriteCredentialError('Failed to mint a write token: refused', status)

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'configuration-fault'})
    expect(logs.error).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a server error', new WriteCredentialError('Failed to mint a write token: down', 502)],
    ['no status', new WriteCredentialError('Failed to mint a write token: timeout')],
  ])('reports unavailable when the credential failure carries %s', async (_label, error) => {
    const w = build(world({runs: [run()]}))
    w.errors.listWorkflowRuns = error

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'unavailable'})
  })

  it.each(['listPulls', 'listWorkflowRuns'] as const)('treats a refused %s read as a configuration fault', async name => {
    const w = build(world({runs: [run()]}))
    w.errors[name] = new HttpError('Not Found', 404)

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'configuration-fault'})
  })

  it('lets a configuration fault win over a transient failure in the same read', async () => {
    const w = build(world({runs: [run()]}))
    w.errors.listPulls = new HttpError('Bad Gateway', 502)
    w.errors.listWorkflowRuns = new HttpError('Not Found', 404)

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'configuration-fault'})
  })

  it('still reports blocked, with the generic reason, when only the jobs read fails transiently', async () => {
    const w = build(world({runs: [run({id: 77, conclusion: 'failure'})], jobs: [failedJob(STEPS.privatePages)]}))
    w.errors.listRunJobs = new HttpError('Bad Gateway', 502)

    await expect(w.reader.getStatus()).resolves.toEqual({
      state: 'blocked',
      reason: 'unknown',
      runUrl: `${RUN_URL}/77`,
      pr: null,
    })
  })

  it('reports a configuration fault when the jobs read is refused', async () => {
    const w = build(world({runs: [run({conclusion: 'failure'})], jobs: [failedJob(STEPS.privatePages)]}))
    w.errors.listRunJobs = new HttpError('Resource not accessible by integration', 403)

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'configuration-fault'})
  })

  it.each([
    ['pulls that are not a list', {pulls: {}}],
    ['a run list that is not an object', {runs: 'nope'}],
  ])('returns unavailable for %s', async (_label, overrides) => {
    const w = build(world(overrides))

    await expect(w.reader.getStatus()).resolves.toEqual({state: 'unavailable'})
  })

  it('serves a failed read from the cache inside the lifetime, so a failing GitHub is not hammered', async () => {
    let now = 0
    const w = build(world({runs: [run()]}), () => now)
    w.errors.listWorkflowRuns = new HttpError('Bad Gateway', 502)

    await w.reader.getStatus()
    now += 1000
    await w.reader.getStatus()
    expect(w.calls.filter(call => call === 'listWorkflowRuns')).toHaveLength(1)

    now += PROMOTION_CACHE_TTL_MS
    delete w.errors.listWorkflowRuns
    await expect(w.reader.getStatus()).resolves.toMatchObject({state: 'settled'})
  })

  it('never rejects', async () => {
    const w = build(world())
    w.errors.listPulls = 'boom'
    w.errors.listWorkflowRuns = null

    await expect(w.reader.getStatus()).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Response content
// ---------------------------------------------------------------------------

describe('promotion status: response and log content', () => {
  const MARKERS = ['LOG-TEXT-MARKER', 'acme', 'secret-repo']

  it.each([
    ['settled', world({pulls: [pull()], runs: [run()]})],
    ['pending', world({runs: [run({status: 'in_progress', conclusion: null})]})],
    ['blocked', world({runs: [run({conclusion: 'failure'})], jobs: [failedJob(STEPS.privatePages)]})],
    ['blocked, unknown step', world({runs: [run({conclusion: 'failure'})], jobs: [failedJob('acme/secret-repo step')]})],
  ])('carries only states, reasons, and fixed URLs when %s', async (_label, initial) => {
    const w = build(initial)

    const status = await w.reader.getStatus()

    const text = JSON.stringify(status)
    for (const marker of MARKERS) expect(text).not.toContain(marker)
    const urls = text.match(/https?:\/\/[^"]+/gu) ?? []
    for (const url of urls) expect(url.startsWith('https://github.com/fro-bot/.github/')).toBe(true)
    const allowed = new Set(['state', 'pr', 'reason', 'runUrl', 'number', 'url'])
    const keys = (value: unknown): string[] =>
      typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]) : []
    for (const key of keys(status)) expect(allowed.has(key)).toBe(true)
  })

  it('never logs run titles, job or step names, log text, or repository names', async () => {
    const logs = capture()
    const failing = build(world({runs: [run({conclusion: 'failure'})], jobs: [failedJob(STEPS.privatePages)]}))
    await failing.reader.getStatus()

    const refused = build(world({runs: [run()]}))
    refused.errors.listWorkflowRuns = new HttpError('acme/secret-repo LOG-TEXT-MARKER not found', 404)
    await refused.reader.getStatus()

    const flaky = build(world({runs: [run()]}))
    flaky.errors.listPulls = new HttpError('acme/secret-repo LOG-TEXT-MARKER unavailable', 502)
    await flaky.reader.getStatus()

    const dispatch = build(world())
    dispatch.errors.createDispatch = new HttpError('acme/secret-repo LOG-TEXT-MARKER refused', 403)
    await dispatch.port.dispatch()

    const output = logs.lines.join('\n')
    expect(logs.lines.length).toBeGreaterThan(0)
    for (const marker of MARKERS) expect(output).not.toContain(marker)
    expect(output).not.toContain('fro-bot/.github')
  })
})
