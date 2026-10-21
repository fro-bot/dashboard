import {readFileSync} from 'node:fs'
import {GATE_CONTRACT_VERSION} from '@fro.bot/wiki-write-core'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  classifyGateContract,
  createGateContractChecker,
  GATE_CONTRACT_CACHE_TTL_MS,
  GATE_CONTRACT_FAILURE_TTL_MS,
  GATE_CONTRACT_FETCH_TIMEOUT_MS,
  GATE_CONTRACT_HEAD_URL,
  GATE_CONTRACT_MARKER_URL,
  GATE_CONTRACT_STALE_CEILING_MS,
  type GateContractCheckerOptions,
} from '../src/wiki/gate-contract.ts'

const HEAD_SHA = 'main-head-001'
const MATCHING_MARKER = JSON.stringify({version: GATE_CONTRACT_VERSION, sourceTreeHash: 'source-a'})

function response(body: string, status = 200): Response {
  return new Response(body, {status, headers: {'content-type': 'application/json'}})
}

function transport(markerBody: string = MATCHING_MARKER, headSha = HEAD_SHA): ReturnType<typeof vi.fn<GateContractCheckerOptions['fetch']>> {
  return vi.fn<GateContractCheckerOptions['fetch']>(async (url: string) => {
    if (url === GATE_CONTRACT_HEAD_URL) return response(JSON.stringify({object: {sha: headSha}}))
    if (url === GATE_CONTRACT_MARKER_URL) return response(markerBody)
    throw new Error(`unexpected URL: ${url}`)
  })
}

describe('gate contract drift checker', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('allows writes when the fetched marker version matches the pinned package', async () => {
    const check = createGateContractChecker({fetch: transport()}).check()

    await expect(check).resolves.toMatchObject({
      proceed: true,
      readiness: {stale: false, mainHeadSha: HEAD_SHA},
    })
  })

  it('refuses writes when the fetched marker version differs', async () => {
    const fetch = transport(JSON.stringify({version: GATE_CONTRACT_VERSION + 1, sourceTreeHash: 'source-a'}))

    await expect(createGateContractChecker({fetch}).check()).resolves.toMatchObject({
      proceed: false,
      reason: 'version_mismatch',
      readiness: {stale: false, mainHeadSha: HEAD_SHA},
    })
  })

  it('uses a warm cache inside the staleness ceiling when fetching fails and reports stale readiness', async () => {
    let now = 0
    const fetch = transport()
    const warnings: {message: string; context?: Record<string, unknown>}[] = []
    const checker = createGateContractChecker({
      fetch,
      now: () => now,
      logger: {warning: (message, context) => warnings.push({message, context})},
    })

    await expect(checker.check()).resolves.toMatchObject({proceed: true, readiness: {stale: false}})
    now = 5 * 60 * 1000 + 1
    fetch.mockRejectedValue(new Error('network unavailable'))

    await expect(checker.check()).resolves.toMatchObject({
      proceed: true,
      readiness: {stale: true, mainHeadSha: HEAD_SHA},
    })
    expect(warnings).toHaveLength(1)
  })

  it('refuses writes when fetching fails without a cache', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network unavailable'))

    await expect(createGateContractChecker({fetch}).check()).resolves.toMatchObject({
      proceed: false,
      reason: 'unavailable',
      readiness: {stale: true},
    })
  })

  it('refuses writes when fetching fails past the one-hour staleness ceiling', async () => {
    let now = 0
    const fetch = transport()
    const checker = createGateContractChecker({fetch, now: () => now})
    await checker.check()

    now = 60 * 60 * 1000 + 1
    fetch.mockRejectedValue(new Error('network unavailable'))

    await expect(checker.check()).resolves.toMatchObject({
      proceed: false,
      reason: 'unavailable',
      readiness: {stale: true},
    })
  })

  describe('concurrent checks share one fetch', () => {
    it('makes exactly one marker fetch for simultaneous checks during an outage', async () => {
      const fetch = vi.fn().mockRejectedValue(new Error('network unavailable'))
      const checker = createGateContractChecker({fetch})

      const decisions = await Promise.all(Array.from({length: 8}, async () => checker.check()))

      expect(fetch).toHaveBeenCalledTimes(1)
      for (const decision of decisions) expect(decision).toMatchObject({proceed: false, reason: 'unavailable'})
    })

    it('shares one fetch pair for simultaneous checks on a healthy cold start', async () => {
      const fetch = transport()
      const checker = createGateContractChecker({fetch})

      const decisions = await Promise.all(Array.from({length: 5}, async () => checker.check()))

      expect(fetch).toHaveBeenCalledTimes(2)
      for (const decision of decisions) expect(decision).toMatchObject({proceed: true})
    })

    it('shares a fetch that is still pending, and starts a new one after it settles', async () => {
      const gate: {release: (() => void) | undefined} = {release: undefined}
      const fetch = vi.fn<GateContractCheckerOptions['fetch']>(async (url: string) => {
        if (url === GATE_CONTRACT_HEAD_URL) return response(JSON.stringify({object: {sha: HEAD_SHA}}))
        await new Promise<void>(resolve => {
          gate.release = resolve
        })
        return response(MATCHING_MARKER)
      })
      const releaseNow = (): void => gate.release?.()
      let now = 0
      const checker = createGateContractChecker({fetch, now: () => now})

      const first = checker.check()
      const second = checker.check()
      await vi.waitFor(() => {
        expect(gate.release).toBeDefined()
      })
      releaseNow()
      await Promise.all([first, second])
      expect(fetch).toHaveBeenCalledTimes(2)

      now = GATE_CONTRACT_CACHE_TTL_MS
      gate.release = undefined
      const third = checker.check()
      await vi.waitFor(() => {
        expect(gate.release).toBeDefined()
      })
      releaseNow()
      await third
      expect(fetch).toHaveBeenCalledTimes(4)
    })

    it('does not cache a rejection from the shared flight', async () => {
      const fetch = transport()
      fetch.mockRejectedValueOnce(new Error('network unavailable'))
      let now = 0
      const checker = createGateContractChecker({fetch, now: () => now})

      await checker.check()
      now += GATE_CONTRACT_FAILURE_TTL_MS

      await expect(checker.check()).resolves.toMatchObject({proceed: true})
    })
  })

  describe('a failed marker fetch is remembered briefly', () => {
    it('does not refetch inside the failure window, and answers unavailable each time', async () => {
      let now = 0
      const fetch = vi.fn().mockRejectedValue(new Error('network unavailable'))
      const checker = createGateContractChecker({fetch, now: () => now})

      const first = await checker.check()
      now += GATE_CONTRACT_FAILURE_TTL_MS - 1
      const second = await checker.check()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(first).toMatchObject({proceed: false, reason: 'unavailable'})
      expect(second).toEqual(first)
    })

    it('refetches once the failure window ends', async () => {
      let now = 0
      const fetch = vi.fn().mockRejectedValue(new Error('network unavailable'))
      const checker = createGateContractChecker({fetch, now: () => now})

      await checker.check()
      now += GATE_CONTRACT_FAILURE_TTL_MS
      await checker.check()

      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('recovers on the first successful refetch after the window and stops answering from the failure', async () => {
      let now = 0
      const fetch = transport()
      fetch.mockRejectedValueOnce(new Error('network unavailable'))
      const checker = createGateContractChecker({fetch, now: () => now})

      await expect(checker.check()).resolves.toMatchObject({proceed: false, reason: 'unavailable'})
      now += GATE_CONTRACT_FAILURE_TTL_MS

      await expect(checker.check()).resolves.toMatchObject({proceed: true, readiness: {stale: false}})
      await expect(checker.check()).resolves.toMatchObject({proceed: true})
    })

    it('answers from the stale cache inside the failure window without refetching', async () => {
      let now = 0
      const fetch = transport()
      const checker = createGateContractChecker({fetch, now: () => now})
      await checker.check()
      now = GATE_CONTRACT_CACHE_TTL_MS + 1
      fetch.mockClear()
      fetch.mockRejectedValue(new Error('network unavailable'))

      const first = await checker.check()
      now += 1000
      const second = await checker.check()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(first).toMatchObject({proceed: true, readiness: {stale: true, mainHeadSha: HEAD_SHA}})
      expect(second).toMatchObject({proceed: true, readiness: {stale: true, mainHeadSha: HEAD_SHA}})
    })

    it('still enforces the staleness ceiling against the current time inside the failure window', async () => {
      let now = 0
      const fetch = transport()
      const checker = createGateContractChecker({fetch, now: () => now})
      await checker.check()
      now = GATE_CONTRACT_STALE_CEILING_MS - 1000
      fetch.mockRejectedValue(new Error('network unavailable'))

      await expect(checker.check()).resolves.toMatchObject({proceed: true, readiness: {stale: true}})
      now = GATE_CONTRACT_STALE_CEILING_MS + 1

      await expect(checker.check()).resolves.toMatchObject({proceed: false, reason: 'unavailable'})
      expect(fetch).toHaveBeenCalledTimes(3)
    })

    it('does not remember an invalid marker, which is an answer and not an outage', async () => {
      let now = 0
      const fetch = transport('{')
      const checker = createGateContractChecker({fetch, now: () => now})

      await checker.check()
      now += 1000
      await checker.check()

      // One marker fetch per check; an invalid marker stops before the head fetch.
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('keeps the failure window much shorter than the success cache', () => {
      expect(GATE_CONTRACT_FAILURE_TTL_MS).toBeGreaterThan(0)
      expect(GATE_CONTRACT_FAILURE_TTL_MS).toBeLessThan(GATE_CONTRACT_CACHE_TTL_MS)
    })
  })

  it('ignores source tree hash drift when the marker version still matches', async () => {
    const fetch = transport(JSON.stringify({version: GATE_CONTRACT_VERSION, sourceTreeHash: 'source-b'}))

    await expect(createGateContractChecker({fetch}).check()).resolves.toMatchObject({proceed: true})
  })

  it.each([
    ['malformed JSON', '{'],
    ['a non-object marker', JSON.stringify(['not-a-marker'])],
    ['a marker without a numeric version', JSON.stringify({sourceTreeHash: 'source-a'})],
  ])('refuses writes for %s', async (_description, markerBody) => {
    const fetch = transport(markerBody)

    await expect(createGateContractChecker({fetch}).check()).resolves.toMatchObject({
      proceed: false,
      reason: 'invalid_marker',
    })
  })

  it('refetches after the five-minute cache TTL expires', async () => {
    let now = 0
    const fetch = transport()
    const checker = createGateContractChecker({fetch, now: () => now})

    await checker.check()
    expect(fetch).toHaveBeenCalledTimes(2)

    now = 5 * 60 * 1000
    await checker.check()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('passes the bounded timeout signal to both public fetches', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const signals: (AbortSignal | null)[] = []
    const fetch = vi.fn<GateContractCheckerOptions['fetch']>(async (url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? null)
      if (url === GATE_CONTRACT_HEAD_URL) return response(JSON.stringify({object: {sha: HEAD_SHA}}))
      if (url === GATE_CONTRACT_MARKER_URL) return response(MATCHING_MARKER)
      throw new Error(`unexpected URL: ${url}`)
    })

    await createGateContractChecker({fetch}).check()

    expect(timeout).toHaveBeenCalledTimes(2)
    expect(timeout).toHaveBeenNthCalledWith(1, GATE_CONTRACT_FETCH_TIMEOUT_MS)
    expect(timeout).toHaveBeenNthCalledWith(2, GATE_CONTRACT_FETCH_TIMEOUT_MS)
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal instanceof AbortSignal)).toBe(true)
  })

  it('uses the warm cache when a refetch never settles inside the staleness ceiling', async () => {
    let now = 0
    const fetch = transport()
    const checker = createGateContractChecker({fetch, now: () => now})
    await checker.check()

    now = 5 * 60 * 1000 + 1
    fetch.mockImplementation(async () => new Promise<Response>(() => {}))
    vi.useFakeTimers()
    try {
      const bounded = checker.check()
      await vi.advanceTimersByTimeAsync(GATE_CONTRACT_FETCH_TIMEOUT_MS)
      await expect(bounded).resolves.toMatchObject({
        proceed: true,
        readiness: {stale: true, mainHeadSha: HEAD_SHA},
      })
    } finally {
      vi.useRealTimers()
    }
  }, 2_000)

  it('refuses when a fetch never settles and there is no cache', async () => {
    const fetch = vi.fn<GateContractCheckerOptions['fetch']>(async () => new Promise<Response>(() => {}))
    vi.useFakeTimers()
    try {
      const bounded = createGateContractChecker({fetch}).check()
      await vi.advanceTimersByTimeAsync(GATE_CONTRACT_FETCH_TIMEOUT_MS)
      await expect(bounded).resolves.toMatchObject({
        proceed: false,
        reason: 'unavailable',
      })
    } finally {
      vi.useRealTimers()
    }
  }, 2_000)

  it('proceeds on a marker when the head SHA fetch fails and reports the SHA as unavailable', async () => {
    const fetch = vi.fn<GateContractCheckerOptions['fetch']>(async (url: string) => {
      if (url === GATE_CONTRACT_MARKER_URL) return response(MATCHING_MARKER)
      throw new Error('head unavailable')
    })

    await expect(createGateContractChecker({fetch}).check()).resolves.toMatchObject({
      proceed: true,
      readiness: {stale: false, mainHeadSha: null},
    })
  })

  it('keeps only the latest marker after checks observe many distinct head SHAs', async () => {
    let now = 0
    let headSha = 'main-head-000'
    let sourceTreeHash = 'source-000'
    const fetch = vi.fn<GateContractCheckerOptions['fetch']>(async (url: string) => {
      if (url === GATE_CONTRACT_HEAD_URL) return response(JSON.stringify({object: {sha: headSha}}))
      if (url === GATE_CONTRACT_MARKER_URL) return response(JSON.stringify({version: GATE_CONTRACT_VERSION, sourceTreeHash}))
      throw new Error(`unexpected URL: ${url}`)
    })
    const checker = createGateContractChecker({fetch, now: () => now})

    for (let index = 0; index < 25; index += 1) {
      headSha = `main-head-${String(index).padStart(3, '0')}`
      sourceTreeHash = `source-${String(index).padStart(3, '0')}`
      await checker.check()
      now += 5 * 60 * 1000
    }

    fetch.mockRejectedValue(new Error('network unavailable'))
    const result = await checker.check()
    expect(result).toMatchObject({
      proceed: true,
      marker: {sourceTreeHash: 'source-024'},
      readiness: {stale: true, mainHeadSha: 'main-head-024'},
    })
  })
})

describe('gate contract classification', () => {
  it('lets a matching marker proceed', async () => {
    const decision = await createGateContractChecker({fetch: transport()}).check()

    expect(classifyGateContract(decision)).toEqual({ok: true})
  })

  it('lets a bounded stale cache proceed', async () => {
    let now = 0
    const fetch = transport()
    const checker = createGateContractChecker({fetch, now: () => now})
    await checker.check()
    now = 5 * 60 * 1000 + 1
    fetch.mockRejectedValue(new Error('network unavailable'))

    expect(classifyGateContract(await checker.check())).toEqual({ok: true})
  })

  it('maps a version mismatch to a no-retry rejection', async () => {
    const fetch = transport(JSON.stringify({version: GATE_CONTRACT_VERSION + 1, sourceTreeHash: 'source-a'}))

    const verdict = classifyGateContract(await createGateContractChecker({fetch}).check())

    expect(verdict).toEqual({ok: false, kind: 'mismatch', retry: false})
  })

  it.each([
    ['an invalid marker', async () => transport('{')],
    ['a failed fetch with no cache', async () => vi.fn().mockRejectedValue(new Error('network unavailable'))],
  ])('maps %s to a retryable unreadable rejection', async (_label, makeFetch) => {
    const verdict = classifyGateContract(await createGateContractChecker({fetch: await makeFetch()}).check())

    expect(verdict).toEqual({ok: false, kind: 'unreadable', retry: true})
  })

  it('maps a cache stale beyond the ceiling to a retryable unreadable rejection', async () => {
    let now = 0
    const fetch = transport()
    const checker = createGateContractChecker({fetch, now: () => now})
    await checker.check()
    now = 60 * 60 * 1000 + 1
    fetch.mockRejectedValue(new Error('network unavailable'))

    expect(classifyGateContract(await checker.check())).toEqual({ok: false, kind: 'unreadable', retry: true})
  })
})

describe('gate contract version source', () => {
  it('compares the marker against the core package export, not a literal', () => {
    const source = readFileSync(new URL('../src/wiki/gate-contract.ts', import.meta.url), 'utf8')

    expect(source).toMatch(/import \{GATE_CONTRACT_VERSION\} from '@fro\.bot\/wiki-write-core'/u)
    expect(source).toMatch(/\.version\s*!==\s*GATE_CONTRACT_VERSION/u)
    expect(source).not.toMatch(/version\s*[!=]==?\s*\d/u)
  })

  it('follows the exported version when it is compared', async () => {
    const matching = transport(JSON.stringify({version: GATE_CONTRACT_VERSION, sourceTreeHash: 's'}))
    const bumped = transport(JSON.stringify({version: GATE_CONTRACT_VERSION + 1, sourceTreeHash: 's'}))

    await expect(createGateContractChecker({fetch: matching}).check()).resolves.toMatchObject({proceed: true})
    await expect(createGateContractChecker({fetch: bumped}).check()).resolves.toMatchObject({reason: 'version_mismatch'})
  })
})
