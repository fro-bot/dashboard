import {GATE_CONTRACT_VERSION} from '@fro-bot/wiki-write-core'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  createGateContractChecker,
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
})
