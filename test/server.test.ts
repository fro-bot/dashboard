import {describe, expect, it, vi} from 'vitest'
import {buildDashboardApp, buildSnapshotProvider} from '../src/server.ts'

describe('dashboard server', () => {
  const app = buildDashboardApp()

  it('GET /api/healthz returns 200 with status shape', async () => {
    const res = await app.request('/api/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ok: true, lastFetch: null, rateLimit: null})
  })

  it('fails closed: with no operator configured, an unknown protected route is denied (401), not 404', async () => {
    // Deny-by-default — an unauthenticated caller must not be able to probe
    // which routes exist, and an unconfigured operator login must never serve
    // protected content.
    const res = await app.request('/not-a-real-route')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Wiring: production server uses the REAL aggregator, not the empty default
// ---------------------------------------------------------------------------

describe('buildSnapshotProvider — production wiring', () => {
  it('getSnapshot returns aggregator data, not the hardcoded empty snapshot', async () => {
    // Fake snapshot that the aggregator will return after a refresh cycle.
    // If the production path were using the empty default, getSnapshot() would
    // return {repos:[], staleBanner:false, driftCount:0, refreshedAt:null} and
    // this test would fail.
    const fakeRepo = {
      node_id: 'R_kgDOFake',
      owner: 'fro-bot',
      name: 'fake-repo',
      full_name: 'fro-bot/fake-repo',
      discovery_channel: 'collab',
      status: {
        rollupState: 'green' as const,
        failingChecks: 0,
        openPrCount: 0,
        openIssueCount: 0,
        openAlertCount: null,
        stale: false,
        fetchedAt: Date.now(),
      },
    }

    // Fake enumerate: returns one repo
    const fakeEnumerate = vi.fn().mockResolvedValue({
      success: true,
      data: {
        repos: [
          {
            node_id: 'R_kgDOFake',
            database_id: 999,
            owner: 'fro-bot',
            name: 'fake-repo',
            full_name: 'fro-bot/fake-repo',
          },
        ],
        installations: [{id: 1, account: 'fro-bot'}],
      },
    })

    // Fake metadata reader: returns a minimal valid YAML with the fake repo
    const fakeMetadataReader = vi.fn().mockResolvedValue(`
version: 1
repos:
  - owner: fro-bot
    name: fake-repo
    added: 2026-01-01
    onboarding_status: onboarded
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    next_survey_eligible_at: null
    discovery_channel: collab
    private: false
    node_id: R_kgDOFake
`)

    // Fake graphql: returns a valid repo status response
    const fakeGraphqlQuery = vi.fn().mockResolvedValue({
      repository: {
        defaultBranchRef: {
          target: {
            statusCheckRollup: {state: 'SUCCESS'},
            checkSuites: {nodes: []},
          },
        },
        pullRequests: {totalCount: 0},
        issues: {totalCount: 0},
        vulnerabilityAlerts: {totalCount: 0},
      },
    })

    const provider = buildSnapshotProvider({
      appId: 'fake-app-id',
      privateKey: 'fake-private-key',
      enumerateFn: fakeEnumerate,
      metadataReader: fakeMetadataReader,
      graphqlQueryFn: fakeGraphqlQuery,
    })

    // start() triggers the first refresh cycle synchronously
    await provider.start()
    provider.stop()

    const snapshot = provider.getSnapshot()

    // The snapshot must NOT be the hardcoded empty default.
    // If someone reverts createDashboardServer to the empty provider, this fails.
    expect(snapshot.repos).toHaveLength(1)
    expect(snapshot.repos[0]?.node_id).toBe(fakeRepo.node_id)
    expect(snapshot.repos[0]?.owner).toBe(fakeRepo.owner)
    expect(snapshot.repos[0]?.name).toBe(fakeRepo.name)
    expect(snapshot.refreshedAt).not.toBeNull()
    expect(snapshot.staleBanner).toBe(false)
  })

  it('getSnapshot is the aggregator getSnapshot, not the empty default', async () => {
    // Minimal wiring: enumerate returns empty, metadata returns empty list.
    // The key assertion is that getSnapshot is the aggregator's function —
    // after start(), refreshedAt is set (not null as in the empty default).
    const fakeEnumerate = vi.fn().mockResolvedValue({
      success: true,
      data: {repos: [], installations: []},
    })
    const fakeMetadataReader = vi.fn().mockResolvedValue('version: 1\nrepos: []\n')
    const fakeGraphqlQuery = vi.fn().mockResolvedValue({repository: null})

    const provider = buildSnapshotProvider({
      appId: 'fake-app-id',
      privateKey: 'fake-private-key',
      enumerateFn: fakeEnumerate,
      metadataReader: fakeMetadataReader,
      graphqlQueryFn: fakeGraphqlQuery,
    })

    await provider.start()
    provider.stop()

    const snapshot = provider.getSnapshot()

    // After a successful refresh, refreshedAt is set — the empty default always returns null.
    // This assertion fails if the production path uses the empty default.
    expect(snapshot.refreshedAt).not.toBeNull()
  })
})
