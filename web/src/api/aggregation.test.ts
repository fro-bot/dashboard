import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {fetchAggregationSnapshot} from './aggregation.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(
  body: object,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json', ...headers},
  })
}

const baseSnapshot = {
  repos: [],
  staleBanner: false,
  driftCount: 0,
  refreshedAt: null,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchAggregationSnapshot', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('happy path — fresh response (no cache headers)', () => {
    it('returns servedFromCache=false and cachedAt=null when headers are absent', async () => {
      fetchMock.mockResolvedValue(makeJsonResponse(baseSnapshot))

      const result = await fetchAggregationSnapshot()

      expect(result.servedFromCache).toBe(false)
      expect(result.cachedAt).toBeNull()
      expect(result.data).toEqual(baseSnapshot)
    })

    it('returns servedFromCache=false when X-From-Cache is not "true"', async () => {
      fetchMock.mockResolvedValue(
        makeJsonResponse(baseSnapshot, {'X-From-Cache': 'false'}),
      )

      const result = await fetchAggregationSnapshot()

      expect(result.servedFromCache).toBe(false)
    })
  })

  describe('happy path — stale-from-cache response', () => {
    it('returns servedFromCache=true and parsed cachedAt when both headers present', async () => {
      const ts = 1_750_000_000_000
      fetchMock.mockResolvedValue(
        makeJsonResponse(baseSnapshot, {
          'X-From-Cache': 'true',
          'X-Cached-At': String(ts),
        }),
      )

      const result = await fetchAggregationSnapshot()

      expect(result.servedFromCache).toBe(true)
      expect(result.cachedAt).toBe(ts)
      expect(result.data).toEqual(baseSnapshot)
    })

    it('returns servedFromCache=true and cachedAt=null when X-Cached-At is absent', async () => {
      fetchMock.mockResolvedValue(
        makeJsonResponse(baseSnapshot, {'X-From-Cache': 'true'}),
      )

      const result = await fetchAggregationSnapshot()

      expect(result.servedFromCache).toBe(true)
      expect(result.cachedAt).toBeNull()
    })
  })

  describe('edge cases — malformed X-Cached-At', () => {
    it('returns cachedAt=null when X-Cached-At is not a number', async () => {
      fetchMock.mockResolvedValue(
        makeJsonResponse(baseSnapshot, {
          'X-From-Cache': 'true',
          'X-Cached-At': 'not-a-number',
        }),
      )

      const result = await fetchAggregationSnapshot()

      expect(result.servedFromCache).toBe(true)
      expect(result.cachedAt).toBeNull()
    })

    it('returns cachedAt=null when X-Cached-At is empty string', async () => {
      fetchMock.mockResolvedValue(
        makeJsonResponse(baseSnapshot, {
          'X-From-Cache': 'true',
          'X-Cached-At': '',
        }),
      )

      const result = await fetchAggregationSnapshot()

      expect(result.cachedAt).toBeNull()
    })
  })

  describe('error handling', () => {
    it('throws on non-2xx response', async () => {
      fetchMock.mockResolvedValue(
        new Response('Unauthorized', {status: 401, statusText: 'Unauthorized'}),
      )

      await expect(fetchAggregationSnapshot()).rejects.toThrow('401')
    })

    it('throws on network failure', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

      await expect(fetchAggregationSnapshot()).rejects.toThrow('Failed to fetch')
    })
  })
})
