import {GATE_CONTRACT_VERSION} from '@fro-bot/wiki-write-core'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  createGateContractChecker,
  GATE_CONTRACT_FETCH_TIMEOUT_MS,
  GATE_CONTRACT_HEAD_URL,
  GATE_CONTRACT_MARKER_URL,
  type GateContractCheckerOptions,
} from '../src/gate-contract.ts'

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
