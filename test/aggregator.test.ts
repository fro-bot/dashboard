/**
 * Test suite for src/github/aggregator.ts
 *
 * Security tests are the primary gate:
 * - Denylist-before-query: GraphQL client NEVER called for denylisted node_ids.
 * - Fail-closed: when readMetadata returns err, no fresh union is built.
 * - Leak guard: redacted repo names/node_ids never appear in snapshot output.
 *
 * All tests inject fakes — no network calls, no real timers.
 */

import type {AggregatorDeps, GraphqlQueryFn} from '../src/github/aggregator.ts'
import type {EnumerateReposResult} from '../src/github/installations.ts'
import type {MetadataResult} from '../src/github/metadata.ts'
import type {Result} from '../src/result.ts'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createAggregator} from '../src/github/aggregator.ts'
import {FetchInstallationsError} from '../src/github/installations.ts'
import {MetadataTransportError, MetadataUnavailableError} from '../src/github/metadata.ts'
import {err, ok} from '../src/result.ts'

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

function makeRepo(overrides: {node_id?: string; database_id?: number; owner?: string; name?: string; full_name?: string} = {}) {
  const owner = overrides.owner ?? 'fro-bot'
  const name = overrides.name ?? 'agent'
  return {
    node_id: overrides.node_id ?? 'NODE_AGENT',
    database_id: overrides.database_id ?? 1000,
    owner,
    name,
    full_name: overrides.full_name ?? `${owner}/${name}`,
  }
}

function makePublicRepo(overrides: {
  node_id?: string
  owner?: string
  name?: string
  discovery_channel?: string
} = {}) {
  return {
    node_id: overrides.node_id ?? 'NODE_AGENT',
    owner: overrides.owner ?? 'fro-bot',
    name: overrides.name ?? 'agent',
    discovery_channel: overrides.discovery_channel ?? 'collab',
  }
}

function makeMetadataResult(overrides: {
  publicRepos?: ReturnType<typeof makePublicRepo>[]
  redactedNodeIds?: string[]
  redactedDatabaseIds?: number[]
} = {}): MetadataResult {
  return {
    publicRepos: overrides.publicRepos ?? [],
    redactedNodeIds: new Set(overrides.redactedNodeIds ?? []),
    redactedDatabaseIds: new Set(overrides.redactedDatabaseIds ?? []),
  }
}

function makeEnumerateResult(repos: ReturnType<typeof makeRepo>[]): Result<EnumerateReposResult, FetchInstallationsError> {
  return ok({repos, installations: [{id: 1, account: 'fro-bot'}]})
}

/**
 * Build a minimal GraphQL response for a repo.
 */
function makeGraphqlResponse(overrides: {
  rollupState?: string
  failingChecks?: number
  openPrCount?: number
  openIssueCount?: number
  openAlertCount?: number | null
} = {}) {
  const failingChecks = overrides.failingChecks ?? 0
  return {
    repository: {
      defaultBranchRef: {
        target: {
          statusCheckRollup: overrides.rollupState === undefined ? null : {state: overrides.rollupState},
          checkSuites: {
            nodes: failingChecks > 0 ? [{checkRuns: {totalCount: failingChecks}}] : [],
          },
        },
      },
      pullRequests: {totalCount: overrides.openPrCount ?? 0},
      issues: {totalCount: overrides.openIssueCount ?? 0},
      vulnerabilityAlerts: overrides.openAlertCount !== null && overrides.openAlertCount !== undefined
        ? {totalCount: overrides.openAlertCount}
        : null,
    },
  }
}

/** Fake installations client (unused in most tests — we inject enumerate directly) */
const fakeInstallationsClient = {
  listInstallations: vi.fn(),
  mintInstallationToken: vi.fn(),
  listInstallationRepos: vi.fn(),
}

/** Fake metadata reader (unused — we inject readMetadata directly) */
const fakeMetadataReader = vi.fn()

/**
 * Build aggregator deps with sensible defaults.
 * Override any dep to test specific scenarios.
 */
function makeDeps(overrides: Partial<AggregatorDeps> = {}): AggregatorDeps {
  let t = 0
  return {
    enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([])),
    readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult())),
    graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse()),
    now: () => {
      t += 1
      return t
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Happy path: CI state mapping
// ---------------------------------------------------------------------------

describe('aggregator — happy path: CI state mapping', () => {
  it('maps SUCCESS rollup to green', async () => {
    const repo = makeRepo({node_id: 'NODE_A', owner: 'org', name: 'repo-a'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_A', owner: 'org', name: 'repo-a'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'})),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(1)
    expect(snap.repos[0]?.status.rollupState).toBe('green')
    expect(snap.staleBanner).toBe(false)
  })

  it('maps FAILURE rollup to red', async () => {
    const repo = makeRepo({node_id: 'NODE_B', owner: 'org', name: 'repo-b'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_B', owner: 'org', name: 'repo-b'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'FAILURE'})),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos[0]?.status.rollupState).toBe('red')
  })

  it('maps PENDING rollup to pending', async () => {
    const repo = makeRepo({node_id: 'NODE_C', owner: 'org', name: 'repo-c'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_C', owner: 'org', name: 'repo-c'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'PENDING'})),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos[0]?.status.rollupState).toBe('pending')
  })

  it('maps ERROR rollup to red', async () => {
    const repo = makeRepo({node_id: 'NODE_D', owner: 'org', name: 'repo-d'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_D', owner: 'org', name: 'repo-d'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'ERROR'})),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos[0]?.status.rollupState).toBe('red')
  })

  it('maps null/missing rollup to unknown', async () => {
    const repo = makeRepo({node_id: 'NODE_E', owner: 'org', name: 'repo-e'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_E', owner: 'org', name: 'repo-e'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: undefined})),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos[0]?.status.rollupState).toBe('unknown')
  })

  it('correctly maps openPrCount, openIssueCount, openAlertCount', async () => {
    const repo = makeRepo({node_id: 'NODE_F', owner: 'org', name: 'repo-f'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_F', owner: 'org', name: 'repo-f'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({
        rollupState: 'SUCCESS',
        openPrCount: 3,
        openIssueCount: 7,
        openAlertCount: 2,
      })),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos[0]?.status.openPrCount).toBe(3)
    expect(snap.repos[0]?.status.openIssueCount).toBe(7)
    expect(snap.repos[0]?.status.openAlertCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Happy path: attention-first sorting
// ---------------------------------------------------------------------------

describe('aggregator — happy path: attention-first sorting', () => {
  it('repos with failing checks sort before healthy repos', async () => {
    const repoHealthy = makeRepo({node_id: 'NODE_HEALTHY', owner: 'org', name: 'healthy'})
    const repoFailing = makeRepo({node_id: 'NODE_FAILING', owner: 'org', name: 'failing'})

    const graphqlQuery: GraphqlQueryFn = vi.fn().mockImplementation(async (_query, vars) => {
      if ((vars as {name: string}).name === 'failing') {
        return makeGraphqlResponse({rollupState: 'FAILURE', failingChecks: 3})
      }
      return makeGraphqlResponse({rollupState: 'SUCCESS'})
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repoHealthy, repoFailing])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [
          makePublicRepo({node_id: 'NODE_HEALTHY', owner: 'org', name: 'healthy'}),
          makePublicRepo({node_id: 'NODE_FAILING', owner: 'org', name: 'failing'}),
        ],
      }))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(2)
    expect(snap.repos[0]?.node_id).toBe('NODE_FAILING')
    expect(snap.repos[1]?.node_id).toBe('NODE_HEALTHY')
  })

  it('repos with open alerts sort before healthy repos', async () => {
    const repoHealthy = makeRepo({node_id: 'NODE_H2', owner: 'org', name: 'healthy2'})
    const repoAlerts = makeRepo({node_id: 'NODE_ALERTS', owner: 'org', name: 'alerts'})

    const graphqlQuery: GraphqlQueryFn = vi.fn().mockImplementation(async (_query, vars) => {
      if ((vars as {name: string}).name === 'alerts') {
        return makeGraphqlResponse({rollupState: 'SUCCESS', openAlertCount: 5})
      }
      return makeGraphqlResponse({rollupState: 'SUCCESS', openAlertCount: 0})
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repoHealthy, repoAlerts])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [
          makePublicRepo({node_id: 'NODE_H2', owner: 'org', name: 'healthy2'}),
          makePublicRepo({node_id: 'NODE_ALERTS', owner: 'org', name: 'alerts'}),
        ],
      }))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos[0]?.node_id).toBe('NODE_ALERTS')
    expect(snap.repos[1]?.node_id).toBe('NODE_H2')
  })

  it('repos with open PRs sort before repos with no PRs', async () => {
    const repoNoPr = makeRepo({node_id: 'NODE_NOPR', owner: 'org', name: 'no-pr'})
    const repoPr = makeRepo({node_id: 'NODE_PR', owner: 'org', name: 'has-pr'})

    const graphqlQuery: GraphqlQueryFn = vi.fn().mockImplementation(async (_query, vars) => {
      if ((vars as {name: string}).name === 'has-pr') {
        return makeGraphqlResponse({rollupState: 'SUCCESS', openPrCount: 2})
      }
      return makeGraphqlResponse({rollupState: 'SUCCESS', openPrCount: 0})
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repoNoPr, repoPr])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [
          makePublicRepo({node_id: 'NODE_NOPR', owner: 'org', name: 'no-pr'}),
          makePublicRepo({node_id: 'NODE_PR', owner: 'org', name: 'has-pr'}),
        ],
      }))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos[0]?.node_id).toBe('NODE_PR')
    expect(snap.repos[1]?.node_id).toBe('NODE_NOPR')
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('aggregator — edge cases', () => {
  it('empty union → empty dashboard, no crash', async () => {
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult())),
      graphqlQuery: vi.fn(),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(0)
    expect(snap.staleBanner).toBe(false)
    expect(snap.driftCount).toBe(0)
    // GraphQL should never be called for empty set
    expect(deps.graphqlQuery).not.toHaveBeenCalled()
  })

  it('repo with no PRs/issues/alerts → shown healthy', async () => {
    const repo = makeRepo({node_id: 'NODE_CLEAN', owner: 'org', name: 'clean'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_CLEAN', owner: 'org', name: 'clean'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({
        rollupState: 'SUCCESS',
        openPrCount: 0,
        openIssueCount: 0,
        openAlertCount: 0,
      })),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(1)
    const status = snap.repos[0]?.status
    expect(status?.rollupState).toBe('green')
    expect(status?.openPrCount).toBe(0)
    expect(status?.openIssueCount).toBe(0)
    expect(status?.stale).toBe(false)
  })

  it('getSnapshot before any refresh returns empty state', () => {
    const deps = makeDeps()
    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(0)
    expect(snap.staleBanner).toBe(false)
    expect(snap.refreshedAt).toBeNull()
  })

  it('installation-only repos (not in publicRepos) get discovery_channel = discovered', async () => {
    const installOnlyRepo = makeRepo({node_id: 'NODE_INSTALL_ONLY', owner: 'org', name: 'install-only'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([installOnlyRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [], // not in metadata
        redactedNodeIds: [],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse()),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(1)
    expect(snap.repos[0]?.discovery_channel).toBe('discovered')
    expect(snap.driftCount).toBe(1)
  })

  it('metadata publicRepos carry their discovery_channel label', async () => {
    const repo = makeRepo({node_id: 'NODE_COLLAB', owner: 'org', name: 'collab-repo'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_COLLAB', owner: 'org', name: 'collab-repo', discovery_channel: 'collab'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse()),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos[0]?.discovery_channel).toBe('collab')
  })

  it('security alerts null when vulnerabilityAlerts is absent from response', async () => {
    const repo = makeRepo({node_id: 'NODE_NOALERT', owner: 'org', name: 'no-alert'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_NOALERT', owner: 'org', name: 'no-alert'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({openAlertCount: null})),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos[0]?.status.openAlertCount).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('aggregator — error paths', () => {
  it('per-repo GraphQL failure → that repo marked stale, others unaffected', async () => {
    const repoA = makeRepo({node_id: 'NODE_OK', owner: 'org', name: 'ok-repo'})
    const repoB = makeRepo({node_id: 'NODE_FAIL', owner: 'org', name: 'fail-repo'})

    const graphqlQuery: GraphqlQueryFn = vi.fn().mockImplementation(async (_query, vars) => {
      if ((vars as {name: string}).name === 'fail-repo') {
        throw new Error('GraphQL timeout')
      }
      return makeGraphqlResponse({rollupState: 'SUCCESS'})
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repoA, repoB])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [
          makePublicRepo({node_id: 'NODE_OK', owner: 'org', name: 'ok-repo'}),
          makePublicRepo({node_id: 'NODE_FAIL', owner: 'org', name: 'fail-repo'}),
        ],
      }))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(2)

    const okRepo = snap.repos.find(r => r.node_id === 'NODE_OK')
    const failRepo = snap.repos.find(r => r.node_id === 'NODE_FAIL')

    expect(okRepo?.status.stale).toBe(false)
    expect(okRepo?.status.rollupState).toBe('green')
    expect(failRepo?.status.stale).toBe(true)
    // staleBanner is false — only one repo failed, not the whole refresh
    expect(snap.staleBanner).toBe(false)
  })

  it('installation enumeration failure → uses empty install set, still queries metadata publicRepos, staleBanner=true', async () => {
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(err(new FetchInstallationsError('network down'))),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_META', owner: 'org', name: 'meta-repo'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'})),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    // metadata publicRepos still show up (public data is safe to serve)
    expect(snap.repos).toHaveLength(1)
    expect(snap.repos[0]?.node_id).toBe('NODE_META')
    // staleBanner=true — data is incomplete (installation channel failed)
    expect(snap.staleBanner).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cache refresh with fake timers
// ---------------------------------------------------------------------------

describe('aggregator — cache refresh with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cache refresh replaces stale payload after interval', async () => {
    let callCount = 0
    const graphqlQuery: GraphqlQueryFn = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return makeGraphqlResponse({rollupState: 'SUCCESS'})
      }
      return makeGraphqlResponse({rollupState: 'FAILURE'})
    })

    const repo = makeRepo({node_id: 'NODE_TIMER', owner: 'org', name: 'timer-repo'})
    let nowMs = 0

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_TIMER', owner: 'org', name: 'timer-repo'})],
      }))),
      graphqlQuery,
      now: () => {
        nowMs += 70_000 // advance past 60s TTL on each call
        return nowMs
      },
      setIntervalFn: (fn, ms) => setInterval(fn, ms),
      clearIntervalFn: id => clearInterval(id),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.start()

    const snap1 = agg.getSnapshot()
    expect(snap1.repos[0]?.status.rollupState).toBe('green')

    // Advance timer to trigger the interval refresh
    await vi.advanceTimersByTimeAsync(60_000)

    const snap2 = agg.getSnapshot()
    expect(snap2.repos[0]?.status.rollupState).toBe('red')

    agg.stop()
  })
})

// ---------------------------------------------------------------------------
// Security: denylist-before-query (leak-of-intent prevention)
// ---------------------------------------------------------------------------

describe('security — denylist-before-query', () => {
  it('GraphQL client is NEVER called with a denylisted node_id', async () => {
    const REDACTED_NODE_ID = 'NODE_PRIVATE_SECRET'
    const REDACTED_FULL_NAME = 'private-org/secret-repo'

    // Installation channel returns the private repo (as if the App can see it)
    const privateRepo = makeRepo({
      node_id: REDACTED_NODE_ID,
      owner: 'private-org',
      name: 'secret-repo',
      full_name: REDACTED_FULL_NAME,
    })
    const publicRepo = makeRepo({node_id: 'NODE_PUBLIC', owner: 'org', name: 'public'})

    const graphqlQuery: GraphqlQueryFn = vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'}))

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([privateRepo, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_PUBLIC', owner: 'org', name: 'public'})],
        redactedNodeIds: [REDACTED_NODE_ID], // private repo is denylisted
      }))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // Assert: GraphQL was called (for the public repo)
    expect(graphqlQuery).toHaveBeenCalled()

    // Assert: GraphQL was NEVER called with the denylisted node_id as owner/name
    // (We check call args — the query uses owner+name, not node_id directly,
    // but the denylisted repo's owner/name must never appear in any call)
    const calls = (graphqlQuery as ReturnType<typeof vi.fn>).mock.calls
    for (const call of calls) {
      const vars = call[1] as {owner: string; name: string}
      // The private repo's owner and name must never appear in any GraphQL call
      expect(vars.owner).not.toBe('private-org')
      expect(vars.name).not.toBe('secret-repo')
    }
  })

  it('denylisted repos are absent from snapshot output (deep serialization check)', async () => {
    const REDACTED_NODE_ID = 'NODE_REDACTED_DEEP'
    const REDACTED_NAME = 'ultra-secret-repo'
    const REDACTED_OWNER = 'secret-org'

    const privateRepo = makeRepo({
      node_id: REDACTED_NODE_ID,
      owner: REDACTED_OWNER,
      name: REDACTED_NAME,
      full_name: `${REDACTED_OWNER}/${REDACTED_NAME}`,
    })
    const publicRepo = makeRepo({node_id: 'NODE_PUB2', owner: 'org', name: 'pub2'})

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([privateRepo, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_PUB2', owner: 'org', name: 'pub2'})],
        redactedNodeIds: [REDACTED_NODE_ID],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'})),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    // Serialize the entire snapshot and assert no trace of the redacted repo
    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain(REDACTED_NODE_ID)
    expect(serialized).not.toContain(REDACTED_NAME)
    expect(serialized).not.toContain(REDACTED_OWNER)
  })

  it('database_id match excludes repo when node_id formats differ (cross-format gap closure)', async () => {
    // Scenario: metadata stores the redacted repo under legacy base64 node_id format,
    // but the installation channel returns the SAME repo under the new R_kgDO... format.
    // The exact-string node_id match would MISS this — but the database_id match catches it.
    const METADATA_NODE_ID = 'MDEwOlJlcG9zaXRvcnkxODY5MTU0' // legacy base64 format
    const INSTALL_NODE_ID = 'R_kgDOxxxx' // new format — different string, same repo
    const SHARED_DATABASE_ID = 186915400 // stable numeric id — same across both formats

    const privateRepo = makeRepo({
      node_id: INSTALL_NODE_ID,
      database_id: SHARED_DATABASE_ID,
      owner: 'private-org',
      name: 'format-mismatch-repo',
    })
    const publicRepo = makeRepo({node_id: 'NODE_PUBLIC_FM', database_id: 9999, owner: 'org', name: 'public-fm'})

    const graphqlQuery: GraphqlQueryFn = vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'}))

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([privateRepo, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_PUBLIC_FM', owner: 'org', name: 'public-fm'})],
        // Metadata has the LEGACY node_id — won't match INSTALL_NODE_ID
        redactedNodeIds: [METADATA_NODE_ID],
        // But metadata also has the database_id — this IS the format-independent match
        redactedDatabaseIds: [SHARED_DATABASE_ID],
      }))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // GraphQL was called (for the public repo)
    expect(graphqlQuery).toHaveBeenCalled()

    // GraphQL was NEVER called for the private repo — database_id match caught it
    const calls = (graphqlQuery as ReturnType<typeof vi.fn>).mock.calls
    for (const call of calls) {
      const vars = call[1] as {owner: string; name: string}
      expect(vars.owner).not.toBe('private-org')
      expect(vars.name).not.toBe('format-mismatch-repo')
    }

    // The private repo must not appear in the snapshot
    const snap = agg.getSnapshot()
    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain(INSTALL_NODE_ID)
    expect(serialized).not.toContain('format-mismatch-repo')
    expect(serialized).not.toContain('private-org')
  })

  it('same-node_id exclusion still works (regression guard)', async () => {
    // Existing behavior: node_id exact match still excludes the repo
    const REDACTED_NODE_ID = 'NODE_SAME_FORMAT_PRIVATE'

    const privateRepo = makeRepo({
      node_id: REDACTED_NODE_ID,
      database_id: 77777,
      owner: 'private-org',
      name: 'same-format-secret',
    })
    const publicRepo = makeRepo({node_id: 'NODE_SAFE_SF', database_id: 88888, owner: 'org', name: 'safe-sf'})

    const graphqlQuery: GraphqlQueryFn = vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'}))

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([privateRepo, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_SAFE_SF', owner: 'org', name: 'safe-sf'})],
        redactedNodeIds: [REDACTED_NODE_ID], // same format — primary match
        redactedDatabaseIds: [], // no database_id in metadata
      }))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // Only 1 call — for the safe public repo
    expect(graphqlQuery).toHaveBeenCalledTimes(1)
    const call = (graphqlQuery as ReturnType<typeof vi.fn>).mock.calls[0]
    const vars = call?.[1] as {owner: string; name: string}
    expect(vars.name).toBe('safe-sf')
  })

  it('multiple denylisted repos are all excluded from GraphQL calls', async () => {
    const REDACTED_IDS = ['NODE_PRIV_1', 'NODE_PRIV_2', 'NODE_PRIV_3']
    const privateRepos = REDACTED_IDS.map((id, i) =>
      makeRepo({node_id: id, owner: 'priv-org', name: `priv-repo-${i}`}),
    )
    const publicRepo = makeRepo({node_id: 'NODE_SAFE', owner: 'org', name: 'safe'})

    const graphqlQuery: GraphqlQueryFn = vi.fn().mockResolvedValue(makeGraphqlResponse())

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([...privateRepos, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_SAFE', owner: 'org', name: 'safe'})],
        redactedNodeIds: REDACTED_IDS,
      }))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // Only 1 call — for the safe public repo
    expect(graphqlQuery).toHaveBeenCalledTimes(1)
    const call = (graphqlQuery as ReturnType<typeof vi.fn>).mock.calls[0]
    const vars = call?.[1] as {owner: string; name: string}
    expect(vars.owner).toBe('org')
    expect(vars.name).toBe('safe')
  })
})

// ---------------------------------------------------------------------------
// Security: fail-closed on denylist unavailability
// ---------------------------------------------------------------------------

describe('security — fail-closed on denylist unavailability', () => {
  it('when readMetadata returns err, GraphQL is NOT called for installation repos', async () => {
    const installRepo = makeRepo({node_id: 'NODE_INSTALL', owner: 'org', name: 'install-repo'})
    const graphqlQuery: GraphqlQueryFn = vi.fn()

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([installRepo])),
      readMetadata: vi.fn().mockResolvedValue(err(new MetadataUnavailableError('data branch missing'))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // GraphQL must NEVER be called — no fresh union was built
    expect(graphqlQuery).not.toHaveBeenCalled()
  })

  it('when readMetadata returns err on cold start, snapshot is empty with staleBanner=true', async () => {
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([
        makeRepo({node_id: 'NODE_WOULD_LEAK', owner: 'org', name: 'would-leak'}),
      ])),
      readMetadata: vi.fn().mockResolvedValue(err(new MetadataUnavailableError('data branch missing'))),
      graphqlQuery: vi.fn(),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(0)
    expect(snap.staleBanner).toBe(true)
    expect(snap.refreshedAt).toBeNull()
  })

  it('when readMetadata returns err after a good snapshot, serves last-good with staleBanner=true', async () => {
    const repo = makeRepo({node_id: 'NODE_GOOD', owner: 'org', name: 'good-repo'})
    const readMetadata = vi.fn()
      // First call: success
      .mockResolvedValueOnce(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_GOOD', owner: 'org', name: 'good-repo'})],
      })))
      // Second call: failure
      .mockResolvedValueOnce(err(new MetadataTransportError('transport error')))

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata,
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'})),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)

    // First refresh: success
    await agg.refresh()
    const snap1 = agg.getSnapshot()
    expect(snap1.repos).toHaveLength(1)
    expect(snap1.staleBanner).toBe(false)

    // Second refresh: metadata fails → serve last-good with banner
    await agg.refresh()
    const snap2 = agg.getSnapshot()
    expect(snap2.repos).toHaveLength(1) // last-good preserved
    expect(snap2.staleBanner).toBe(true)
    expect(snap2.repos[0]?.node_id).toBe('NODE_GOOD')
  })

  it('fail-closed works for MetadataTransportError variant', async () => {
    const graphqlQuery: GraphqlQueryFn = vi.fn()
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([
        makeRepo({node_id: 'NODE_TRANSPORT', owner: 'org', name: 'transport-repo'}),
      ])),
      readMetadata: vi.fn().mockResolvedValue(err(new MetadataTransportError('network error'))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    expect(graphqlQuery).not.toHaveBeenCalled()
    expect(agg.getSnapshot().staleBanner).toBe(true)
  })

  it('snapshot output never contains installation-only repos when denylist is unavailable', async () => {
    const WOULD_LEAK_NAME = 'would-be-leaked-repo'
    const WOULD_LEAK_NODE = 'NODE_WOULD_LEAK_2'

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([
        makeRepo({node_id: WOULD_LEAK_NODE, owner: 'org', name: WOULD_LEAK_NAME}),
      ])),
      readMetadata: vi.fn().mockResolvedValue(err(new MetadataUnavailableError('unavailable'))),
      graphqlQuery: vi.fn(),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain(WOULD_LEAK_NAME)
    expect(serialized).not.toContain(WOULD_LEAK_NODE)
  })
})

// ---------------------------------------------------------------------------
// Security: cross-format gap closure via derived databaseId
// ---------------------------------------------------------------------------

describe('security — cross-format gap closure via derived databaseId from legacy node_id', () => {
  it('redacted entry with legacy node_id MDEw... (dbid 1869154) + install repo with new-format node_id but same database_id → GraphQL NEVER called', async () => {
    // Scenario: metadata stores the redacted repo under the legacy base64 node_id format.
    // deriveDatabaseId('MDEwOlJlcG9zaXRvcnkxODY5MTU0') → 1869154.
    // The installation channel returns the SAME repo under a new-format node_id (R_kgDO...),
    // but with the same numeric database_id (1869154).
    // The exact node_id string match MISSES this — but the derived databaseId match catches it.
    const LEGACY_NODE_ID = 'MDEwOlJlcG9zaXRvcnkxODY5MTU0' // legacy format → dbid 1869154
    const NEW_FORMAT_NODE_ID = 'R_kgDONewFormat' // new format — different string, same repo
    const SHARED_DATABASE_ID = 1869154 // derived from legacy node_id

    const privateRepo = makeRepo({
      node_id: NEW_FORMAT_NODE_ID,
      database_id: SHARED_DATABASE_ID,
      owner: 'marcusrbrown',
      name: 'dotfiles',
    })
    const publicRepo = makeRepo({node_id: 'NODE_PUBLIC_LEGACY', database_id: 9999, owner: 'org', name: 'public-legacy'})

    const graphqlQuery: GraphqlQueryFn = vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'}))

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([privateRepo, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_PUBLIC_LEGACY', owner: 'org', name: 'public-legacy'})],
        // Metadata has the LEGACY node_id — won't match NEW_FORMAT_NODE_ID by string
        redactedNodeIds: [LEGACY_NODE_ID],
        // But metadata also has the derived databaseId — this IS the format-independent match.
        // In production, this is populated by deriveDatabaseId() in readRepoMetadata.
        // Here we inject it directly to test the aggregator's secondary guard.
        redactedDatabaseIds: [SHARED_DATABASE_ID],
      }))),
      graphqlQuery,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // GraphQL was called (for the public repo)
    expect(graphqlQuery).toHaveBeenCalled()

    // GraphQL was NEVER called for the private repo — derived databaseId match caught it
    const calls = (graphqlQuery as ReturnType<typeof vi.fn>).mock.calls
    for (const call of calls) {
      const vars = call[1] as {owner: string; name: string}
      expect(vars.owner).not.toBe('marcusrbrown')
      expect(vars.name).not.toBe('dotfiles')
    }

    // The private repo must not appear in the snapshot
    const snap = agg.getSnapshot()
    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain(NEW_FORMAT_NODE_ID)
    expect(serialized).not.toContain('dotfiles')
    expect(serialized).not.toContain('marcusrbrown')
  })
})

// ---------------------------------------------------------------------------
// FIX P1: enumeration failure → staleBanner:true
// ---------------------------------------------------------------------------

describe('aggregator — enumeration failure sets staleBanner=true', () => {
  it('enumeration err → snapshot has staleBanner=true (data is incomplete)', async () => {
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(err(new FetchInstallationsError('network down'))),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [],
      }))),
      graphqlQuery: vi.fn(),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    // staleBanner must be true — installation channel failed, data is incomplete
    expect(snap.staleBanner).toBe(true)
  })

  it('enumeration err with metadata publicRepos → repos shown but staleBanner=true', async () => {
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(err(new FetchInstallationsError('timeout'))),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_PUB_ENUM_FAIL', owner: 'org', name: 'pub-enum-fail'})],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'})),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    // Public repos still shown (safe to serve)
    expect(snap.repos).toHaveLength(1)
    expect(snap.repos[0]?.node_id).toBe('NODE_PUB_ENUM_FAIL')
    // But staleBanner=true — operator must know install channel failed
    expect(snap.staleBanner).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Security: source-channel labels (cardinality non-disclosure)
// ---------------------------------------------------------------------------

describe('security — source-channel labels', () => {
  it('driftCount is a count only — no names or node_ids in snapshot', async () => {
    const installOnlyRepos = [
      makeRepo({node_id: 'NODE_DRIFT_1', owner: 'org', name: 'drift-1'}),
      makeRepo({node_id: 'NODE_DRIFT_2', owner: 'org', name: 'drift-2'}),
    ]

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult(installOnlyRepos)),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [], // none in metadata
        redactedNodeIds: [],
      }))),
      graphqlQuery: vi.fn().mockResolvedValue(makeGraphqlResponse()),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    // driftCount is just a number
    expect(snap.driftCount).toBe(2)
    expect(typeof snap.driftCount).toBe('number')
  })
})
