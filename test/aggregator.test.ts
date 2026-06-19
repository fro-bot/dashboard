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

import type {AggregatorDeps, GraphqlQueryForInstallationFn} from '../src/github/aggregator.ts'
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

function makeRepo(overrides: {node_id?: string; database_id?: number; owner?: string; name?: string; full_name?: string; installation_id?: number} = {}) {
  const owner = overrides.owner ?? 'fro-bot'
  const name = overrides.name ?? 'agent'
  return {
    node_id: overrides.node_id ?? 'NODE_AGENT',
    database_id: overrides.database_id ?? 1000,
    owner,
    name,
    full_name: overrides.full_name ?? `${owner}/${name}`,
    installation_id: overrides.installation_id ?? 1,
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
    graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse()),
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'})),
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'FAILURE'})),
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'PENDING'})),
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'ERROR'})),
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: undefined})),
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({
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

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async (_installId, _query, vars) => {
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
      graphqlQueryForInstallation,
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

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async (_installId, _query, vars) => {
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
      graphqlQueryForInstallation,
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

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async (_installId, _query, vars) => {
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
      graphqlQueryForInstallation,
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
      graphqlQueryForInstallation: vi.fn(),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(0)
    expect(snap.staleBanner).toBe(false)
    expect(snap.driftCount).toBe(0)
    // GraphQL should never be called for empty set
    expect(deps.graphqlQueryForInstallation).not.toHaveBeenCalled()
  })

  it('repo with no PRs/issues/alerts → shown healthy', async () => {
    const repo = makeRepo({node_id: 'NODE_CLEAN', owner: 'org', name: 'clean'})
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_CLEAN', owner: 'org', name: 'clean'})],
      }))),
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse()),
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse()),
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({openAlertCount: null})),
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

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async (_installId, _query, vars) => {
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
      graphqlQueryForInstallation,
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

  it('installation enumeration failure → uses empty install set, still queries metadata publicRepos (with resolver), staleBanner=true', async () => {
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(err(new FetchInstallationsError('network down'))),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_META', owner: 'org', name: 'meta-repo'})],
      }))),
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'})),
      // Provide a resolver so metadata-only repos can be queried even when enumeration fails
      resolveInstallationIdForRepo: vi.fn().mockResolvedValue(1),
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
// Security: private repo names never logged in plaintext (#54)
// ---------------------------------------------------------------------------

describe('security — repo-name redaction in operational logs (#54)', () => {
  const captured: string[] = []
  let originalWarn: typeof console.warn

  beforeEach(() => {
    captured.length = 0
    originalWarn = console.warn
    console.warn = (...args: unknown[]): void => {
      captured.push(args.map((a: unknown) => String(a)).join(' '))
    }
  })

  afterEach(() => {
    console.warn = originalWarn
  })

  function loggedOutput(): string {
    return captured.join('\n')
  }

  it('installation-only repo (not known public) GraphQL failure does NOT log owner/name', async () => {
    // An installation-only repo gets discovery_channel 'discovered' — it is NOT
    // known to be public, so its real owner/name must never reach the log.
    const secret = makeRepo({node_id: 'NODE_SECRET', database_id: 4242, owner: 'private-org', name: 'secret-repo', installation_id: 7})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async () => {
      throw new Error('timeout while querying GitHub')
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([secret])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult())), // empty public set → 'discovered'
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    const out = loggedOutput()
    // The failure WAS logged (marking stale) ...
    expect(out).toMatch(/marking stale/i)
    // ... but the private owner/name must be absent.
    expect(out).not.toContain('private-org')
    expect(out).not.toContain('secret-repo')
    expect(out).not.toContain('private-org/secret-repo')
    // A safe, non-revealing identity IS present for diagnosability.
    expect(out).toContain('NODE_SECRET')
  })

  it('private repo name echoed in the GraphQL error message is scrubbed before logging', async () => {
    // GitHub's GraphQL API echoes the queried owner/name back in error text.
    // The error field is a SECOND leak vector — it must be scrubbed for
    // not-known-public repos, not just the structured owner/name fields.
    const secret = makeRepo({node_id: 'NODE_SECRET2', database_id: 4243, owner: 'private-org', name: 'secret-repo', installation_id: 9})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async () => {
      throw new Error("Could not resolve to a Repository with the name 'private-org/secret-repo'.")
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([secret])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult())),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    const out = loggedOutput()
    expect(out).toMatch(/marking stale/i)
    // The name echoed inside the error string must NOT survive.
    expect(out).not.toContain('private-org')
    expect(out).not.toContain('secret-repo')
    expect(out).toContain('NODE_SECRET2')
  })

  it('private owner appearing ALONE in the error text (not as owner/name) is scrubbed', async () => {
    // An error may reference just the owner, outside the full owner/name form.
    // The bare owner must be scrubbed too, not only the owner/name pair.
    const secret = makeRepo({node_id: 'NODE_SECRET4', database_id: 4245, owner: 'private-org', name: 'secret-repo', installation_id: 13})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async () => {
      throw new Error('Resource not accessible by integration for organization private-org')
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([secret])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult())),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    const out = loggedOutput()
    expect(out).toMatch(/marking stale/i)
    expect(out).not.toContain('private-org')
    expect(out).toContain('NODE_SECRET4')
  })

  it('scrubs fully when owner and name overlap (name is a substring of owner)', async () => {
    // Overlapping tokens: name 'secret' is a substring of owner 'secret-corp'.
    // Longest-first replacement must scrub both without leaving a partial owner.
    const secret = makeRepo({node_id: 'NODE_SECRET5', database_id: 4246, owner: 'secret-corp', name: 'secret', installation_id: 17})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async () => {
      throw new Error("Could not resolve 'secret-corp/secret'; org 'secret-corp' is restricted")
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([secret])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult())),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    const out = loggedOutput()
    expect(out).toMatch(/marking stale/i)
    expect(out).not.toContain('secret-corp')
    expect(out).not.toContain('secret')
    expect(out).toContain('NODE_SECRET5')
  })

  it('no-alerts retry failure path also scrubs the private repo name from the error', async () => {
    // Force the vuln-alerts permission retry, then make the retry ALSO fail with
    // an error that echoes the repo name (site C — the no-alerts retry path).
    const secret = makeRepo({node_id: 'NODE_SECRET3', database_id: 4244, owner: 'private-org', name: 'hidden-svc', installation_id: 11})

    let call = 0
    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async () => {
      call += 1
      if (call === 1) {
        throw new Error('Must have push access to view vulnerability alerts.')
      }
      throw new Error("Could not resolve to a Repository with the name 'private-org/hidden-svc'.")
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([secret])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult())),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    const out = loggedOutput()
    expect(out).not.toContain('private-org')
    expect(out).not.toContain('hidden-svc')
  })

  it('known-public metadata repo MAY log owner/name (public data is safe)', async () => {
    const pub = makeRepo({node_id: 'NODE_PUB', owner: 'fro-bot', name: 'agent', installation_id: 1})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async () => {
      throw new Error('timeout while querying GitHub')
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([pub])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_PUB', owner: 'fro-bot', name: 'agent', discovery_channel: 'collab'})],
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    const out = loggedOutput()
    expect(out).toMatch(/marking stale/i)
    // Public repo: name is safe to log.
    expect(out).toContain('agent')
  })

  it('installation-only repo with null installation_id does NOT log owner/name', async () => {
    // Force a null installation_id path: metadata-only repo whose resolver fails.
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(err(new FetchInstallationsError('enum down'))),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_META_SECRET', owner: 'private-org', name: 'hidden-repo', discovery_channel: 'discovered'})],
      }))),
      resolveInstallationIdForRepo: vi.fn().mockRejectedValue(new Error('cannot resolve')),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    const out = loggedOutput()
    expect(out).not.toContain('private-org')
    expect(out).not.toContain('hidden-repo')
    // Guard against a vacuous pass: the safe identity must actually be logged.
    expect(out).toContain('NODE_META_SECRET')
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
    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async () => {
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
      graphqlQueryForInstallation,
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

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'}))

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([privateRepo, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_PUBLIC', owner: 'org', name: 'public'})],
        redactedNodeIds: [REDACTED_NODE_ID], // private repo is denylisted
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // Assert: GraphQL was called (for the public repo)
    expect(graphqlQueryForInstallation).toHaveBeenCalled()

    // Assert: GraphQL was NEVER called with the denylisted node_id as owner/name
    // (We check call args — the query uses owner+name, not node_id directly,
    // but the denylisted repo's owner/name must never appear in any call)
    // Note: args are (installationId, query, vars) — vars is at index 2
    const calls = (graphqlQueryForInstallation as ReturnType<typeof vi.fn>).mock.calls
    for (const call of calls) {
      const vars = call[2] as {owner: string; name: string}
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'})),
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

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'}))

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([privateRepo, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_PUBLIC_FM', owner: 'org', name: 'public-fm'})],
        // Metadata has the LEGACY node_id — won't match INSTALL_NODE_ID
        redactedNodeIds: [METADATA_NODE_ID],
        // But metadata also has the database_id — this IS the format-independent match
        redactedDatabaseIds: [SHARED_DATABASE_ID],
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // GraphQL was called (for the public repo)
    expect(graphqlQueryForInstallation).toHaveBeenCalled()

    // GraphQL was NEVER called for the private repo — database_id match caught it
    // Note: args are (installationId, query, vars) — vars is at index 2
    const calls = (graphqlQueryForInstallation as ReturnType<typeof vi.fn>).mock.calls
    for (const call of calls) {
      const vars = call[2] as {owner: string; name: string}
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

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'}))

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([privateRepo, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_SAFE_SF', owner: 'org', name: 'safe-sf'})],
        redactedNodeIds: [REDACTED_NODE_ID], // same format — primary match
        redactedDatabaseIds: [], // no database_id in metadata
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // Only 1 call — for the safe public repo
    // Note: args are (installationId, query, vars) — vars is at index 2
    expect(graphqlQueryForInstallation).toHaveBeenCalledTimes(1)
    const call = (graphqlQueryForInstallation as ReturnType<typeof vi.fn>).mock.calls[0]
    const vars = call?.[2] as {owner: string; name: string}
    expect(vars.name).toBe('safe-sf')
  })

  it('multiple denylisted repos are all excluded from GraphQL calls', async () => {
    const REDACTED_IDS = ['NODE_PRIV_1', 'NODE_PRIV_2', 'NODE_PRIV_3']
    const privateRepos = REDACTED_IDS.map((id, i) =>
      makeRepo({node_id: id, owner: 'priv-org', name: `priv-repo-${i}`}),
    )
    const publicRepo = makeRepo({node_id: 'NODE_SAFE', owner: 'org', name: 'safe'})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockResolvedValue(makeGraphqlResponse())

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([...privateRepos, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_SAFE', owner: 'org', name: 'safe'})],
        redactedNodeIds: REDACTED_IDS,
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // Only 1 call — for the safe public repo
    // Note: args are (installationId, query, vars) — vars is at index 2
    expect(graphqlQueryForInstallation).toHaveBeenCalledTimes(1)
    const call = (graphqlQueryForInstallation as ReturnType<typeof vi.fn>).mock.calls[0]
    const vars = call?.[2] as {owner: string; name: string}
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
    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn()

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([installRepo])),
      readMetadata: vi.fn().mockResolvedValue(err(new MetadataUnavailableError('data branch missing'))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // GraphQL must NEVER be called — no fresh union was built
    expect(graphqlQueryForInstallation).not.toHaveBeenCalled()
  })

  it('when readMetadata returns err on cold start, snapshot is empty with staleBanner=true', async () => {
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([
        makeRepo({node_id: 'NODE_WOULD_LEAK', owner: 'org', name: 'would-leak'}),
      ])),
      readMetadata: vi.fn().mockResolvedValue(err(new MetadataUnavailableError('data branch missing'))),
      graphqlQueryForInstallation: vi.fn(),
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'})),
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
    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn()
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([
        makeRepo({node_id: 'NODE_TRANSPORT', owner: 'org', name: 'transport-repo'}),
      ])),
      readMetadata: vi.fn().mockResolvedValue(err(new MetadataTransportError('network error'))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    expect(graphqlQueryForInstallation).not.toHaveBeenCalled()
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
      graphqlQueryForInstallation: vi.fn(),
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

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'}))

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
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // GraphQL was called (for the public repo)
    expect(graphqlQueryForInstallation).toHaveBeenCalled()

    // GraphQL was NEVER called for the private repo — derived databaseId match caught it
    // Note: args are (installationId, query, vars) — vars is at index 2
    const calls = (graphqlQueryForInstallation as ReturnType<typeof vi.fn>).mock.calls
    for (const call of calls) {
      const vars = call[2] as {owner: string; name: string}
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

describe('security — production condition: new-format R_ node_id with no database_id (secondary guard inert)', () => {
  // Pins the CURRENT production shape: the redacted entries in metadata/repos.yaml
  // use new-format R_ node_ids and carry no database_id field, so readRepoMetadata's
  // deriveDatabaseId() returns null and redactedDatabaseIds is empty. The PRIMARY
  // node_id string guard is therefore the sole protection. This is safe today
  // because both channels run against the same GitHub API version (same node_id
  // format), so the primary guard matches. These tests lock in that behavior and
  // document the residual defense-in-depth gap (tracked: fro-bot/.github#3525).

  it('redacted R_ node_id, empty redactedDatabaseIds, same node_id from install channel → excluded by PRIMARY guard, GraphQL never called', async () => {
    const REDACTED_NEW_NODE_ID = 'R_kgDORedactedPrivate'

    // The install channel returns the redacted repo under the SAME node_id the
    // metadata denylist holds — the primary guard must catch it.
    const privateRepo = makeRepo({
      node_id: REDACTED_NEW_NODE_ID,
      database_id: 555_001,
      owner: 'marcusrbrown',
      name: 'private-thing',
    })
    const publicRepo = makeRepo({node_id: 'NODE_PUBLIC', database_id: 9001, owner: 'fro-bot', name: 'agent'})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi
      .fn()
      .mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'}))

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([privateRepo, publicRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_PUBLIC', owner: 'fro-bot', name: 'agent'})],
        redactedNodeIds: [REDACTED_NEW_NODE_ID],
        // Production reality: no database_id field on the redacted entry and an
        // R_ node_id that deriveDatabaseId() can't decode → this set is EMPTY.
        redactedDatabaseIds: [],
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // GraphQL ran for the public repo, NEVER for the redacted one (primary guard).
    expect(graphqlQueryForInstallation).toHaveBeenCalled()
    const calls = (graphqlQueryForInstallation as ReturnType<typeof vi.fn>).mock.calls
    for (const call of calls) {
      const vars = call[2] as {owner: string; name: string}
      expect(vars.owner).not.toBe('marcusrbrown')
      expect(vars.name).not.toBe('private-thing')
    }

    const serialized = JSON.stringify(agg.getSnapshot())
    expect(serialized).not.toContain(REDACTED_NEW_NODE_ID)
    expect(serialized).not.toContain('private-thing')
    expect(serialized).not.toContain('marcusrbrown')
  })

  it('documents the residual: R_ node_id with no database_id leaves redactedDatabaseIds empty, so a format-skewed node_id from the install channel is NOT caught by the secondary guard', async () => {
    // This test makes the defense-in-depth gap explicit and observable. It is the
    // ONLY scenario where a redacted repo could leak: the metadata denylist holds
    // node_id A (R_ format, no database_id → empty redactedDatabaseIds), but the
    // installation channel returns the SAME repo under a DIFFERENT node_id B
    // (a hypothetical future format migration). With no database_id fallback,
    // neither guard matches. Fixing this requires adding database_id to the
    // redacted repos.yaml entries (fro-bot/.github#3525). Until then, this test
    // documents that the leak is possible ONLY under node_id-format skew.
    const DENYLIST_NODE_ID = 'R_kgDOFormatA'
    const SKEWED_NODE_ID = 'R_kgDOFormatB' // same repo, different format — hypothetical

    const skewedPrivateRepo = makeRepo({
      node_id: SKEWED_NODE_ID,
      database_id: 777_002, // no database_id in metadata → can't match on this either
      owner: 'marcusrbrown',
      name: 'skewed-private',
    })

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi
      .fn()
      .mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'}))

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([skewedPrivateRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [],
        redactedNodeIds: [DENYLIST_NODE_ID], // holds format A only
        redactedDatabaseIds: [], // empty — the gap
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()

    // Characterize the gap honestly: under format skew with an empty secondary
    // guard, the repo IS queried and DOES surface. This is the documented residual,
    // not desired behavior — it is what #3525 (add database_id) closes. If a future
    // fix makes deriveDatabaseId/database_id close this gap, THIS assertion will flip
    // and should be updated to assert exclusion.
    const calls = (graphqlQueryForInstallation as ReturnType<typeof vi.fn>).mock.calls
    const queriedNames = calls.map(c => (c[2] as {name: string}).name)
    expect(queriedNames).toContain('skewed-private')
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
      graphqlQueryForInstallation: vi.fn(),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    // staleBanner must be true — installation channel failed, data is incomplete
    expect(snap.staleBanner).toBe(true)
  })

  it('enumeration err with metadata publicRepos → repos shown (with resolver) but staleBanner=true', async () => {
    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(err(new FetchInstallationsError('timeout'))),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_PUB_ENUM_FAIL', owner: 'org', name: 'pub-enum-fail'})],
      }))),
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse({rollupState: 'SUCCESS'})),
      // Provide a resolver so metadata-only repos can be queried even when enumeration fails
      resolveInstallationIdForRepo: vi.fn().mockResolvedValue(1),
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
// Security: error log sanitization (FIX 2 — no raw tokens in logs)
// ---------------------------------------------------------------------------

describe('security — error log sanitization', () => {
  it('per-repo GraphQL failure with token in error message → token NOT logged', async () => {
    const FAKE_TOKEN = 'ghs_FAKEFAKEFAKEFAKEFAKE123456'
    const repo = makeRepo({node_id: 'NODE_SANITIZE_GQL', owner: 'org', name: 'sanitize-gql'})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async () => {
      throw new Error(`GraphQL auth failed: ${FAKE_TOKEN}`)
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_SANITIZE_GQL', owner: 'org', name: 'sanitize-gql'})],
      }))),
      graphqlQueryForInstallation,
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
      await agg.refresh()

      // Collect all logged output
      const allOutput = [
        ...warnSpy.mock.calls.map(args => JSON.stringify(args)),
        ...errorSpy.mock.calls.map(args => JSON.stringify(args)),
      ].join('\n')

      // Token must NOT appear in any log output
      expect(allOutput).not.toContain(FAKE_TOKEN)
      expect(allOutput).not.toContain('ghs_FAKE')
      // [REDACTED] must appear instead
      expect(allOutput).toContain('[REDACTED]')
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('per-repo GraphQL failure with PEM fragment in error → PEM NOT logged', async () => {
    const FAKE_PEM_FRAGMENT = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJ\n-----END RSA PRIVATE KEY-----'
    const repo = makeRepo({node_id: 'NODE_SANITIZE_PEM', owner: 'org', name: 'sanitize-pem'})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async () => {
      throw new Error(`Auth error: ${FAKE_PEM_FRAGMENT}`)
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_SANITIZE_PEM', owner: 'org', name: 'sanitize-pem'})],
      }))),
      graphqlQueryForInstallation,
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
      await agg.refresh()

      const allOutput = [
        ...warnSpy.mock.calls.map(args => JSON.stringify(args)),
        ...errorSpy.mock.calls.map(args => JSON.stringify(args)),
      ].join('\n')

      expect(allOutput).not.toContain('BEGIN RSA PRIVATE KEY')
      expect(allOutput).not.toContain('MIIEowIBAAKCAQEA')
      expect(allOutput).toContain('[REDACTED]')
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('metadata read failure with token in error → token NOT logged', async () => {
    const FAKE_TOKEN = 'ghs_FAKEFAKEFAKEFAKEFAKE123456'

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([])),
      readMetadata: vi.fn().mockResolvedValue(
        err({message: `Metadata fetch failed: ${FAKE_TOKEN}`, name: 'MetadataTransportError'}),
      ),
      graphqlQueryForInstallation: vi.fn(),
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
      await agg.refresh()

      const allOutput = [
        ...warnSpy.mock.calls.map(args => JSON.stringify(args)),
        ...errorSpy.mock.calls.map(args => JSON.stringify(args)),
      ].join('\n')

      expect(allOutput).not.toContain(FAKE_TOKEN)
      expect(allOutput).not.toContain('ghs_FAKE')
      expect(allOutput).toContain('[REDACTED]')
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('enumeration failure with token in error → token NOT logged', async () => {
    const FAKE_TOKEN = 'ghs_FAKEFAKEFAKEFAKEFAKE123456'

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(
        err(new FetchInstallationsError(`Network error: ${FAKE_TOKEN}`)),
      ),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult())),
      graphqlQueryForInstallation: vi.fn(),
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
      await agg.refresh()

      const allOutput = [
        ...warnSpy.mock.calls.map(args => JSON.stringify(args)),
        ...errorSpy.mock.calls.map(args => JSON.stringify(args)),
      ].join('\n')

      expect(allOutput).not.toContain(FAKE_TOKEN)
      expect(allOutput).not.toContain('ghs_FAKE')
      expect(allOutput).toContain('[REDACTED]')
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
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
      graphqlQueryForInstallation: vi.fn().mockResolvedValue(makeGraphqlResponse()),
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    // driftCount is just a number
    expect(snap.driftCount).toBe(2)
    expect(typeof snap.driftCount).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// P1 Regression tests: two-install GraphQL uses correct installation per repo
// ---------------------------------------------------------------------------

describe('P1 regression — two-install GraphQL uses correct installation_id per repo', () => {
  it('install 1 → marcusrbrown/ha-config, install 2 → fro-bot/agent: each uses its own installation', async () => {
    // Two repos from two different installations.
    // The fake graphqlQueryForInstallation only accepts the correct installationId for each repo.
    const repoA = makeRepo({node_id: 'NODE_HA', owner: 'marcusrbrown', name: 'ha-config', installation_id: 1})
    const repoB = makeRepo({node_id: 'NODE_AGENT', owner: 'fro-bot', name: 'agent', installation_id: 2})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(
      async (installId: number, _query: string, vars: Record<string, unknown>) => {
        const owner = vars.owner as string
        // install 1 only accepts marcusrbrown repos
        if (installId === 1 && owner !== 'marcusrbrown') {
          throw new Error(`install 1 cannot access ${owner}`)
        }
        // install 2 only accepts fro-bot repos
        if (installId === 2 && owner !== 'fro-bot') {
          throw new Error(`install 2 cannot access ${owner}`)
        }
        return makeGraphqlResponse({rollupState: 'SUCCESS'})
      },
    )

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repoA, repoB])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [
          makePublicRepo({node_id: 'NODE_HA', owner: 'marcusrbrown', name: 'ha-config'}),
          makePublicRepo({node_id: 'NODE_AGENT', owner: 'fro-bot', name: 'agent'}),
        ],
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    // Both repos fetched non-stale — each used the correct installation
    expect(snap.repos).toHaveLength(2)
    const haRepo = snap.repos.find(r => r.node_id === 'NODE_HA')
    const agentRepo = snap.repos.find(r => r.node_id === 'NODE_AGENT')
    expect(haRepo?.status.stale).toBe(false)
    expect(agentRepo?.status.stale).toBe(false)

    // Verify calls used the correct installationId for each repo
    const calls = (graphqlQueryForInstallation as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    const haCall = calls.find(c => (c[2] as {owner: string}).owner === 'marcusrbrown')
    const agentCall = calls.find(c => (c[2] as {owner: string}).owner === 'fro-bot')
    expect(haCall?.[0]).toBe(1) // install 1 for marcusrbrown
    expect(agentCall?.[0]).toBe(2) // install 2 for fro-bot
  })
})

// ---------------------------------------------------------------------------
// P1 Regression tests: overlay provenance (metadata + install → uses install_id)
// ---------------------------------------------------------------------------

describe('P1 regression — overlay provenance: metadata publicRepo + install repo → uses install installation_id', () => {
  it('publicRepo in metadata + same node_id in installRepos with installation_id:2 → query uses installation_id:2', async () => {
    // fro-bot/agent is in both metadata (publicRepos) and installRepos (installation_id:2).
    // The working set must use installation_id:2 (from the install channel) while keeping
    // the metadata discovery_channel label.
    const installRepo = makeRepo({node_id: 'NODE_AGENT', owner: 'fro-bot', name: 'agent', installation_id: 2})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockResolvedValue(
      makeGraphqlResponse({rollupState: 'SUCCESS'}),
    )

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([installRepo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_AGENT', owner: 'fro-bot', name: 'agent', discovery_channel: 'collab'})],
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(1)
    const repo = snap.repos[0]
    // Metadata discovery_channel preserved
    expect(repo?.discovery_channel).toBe('collab')
    // Not stale — query succeeded
    expect(repo?.status.stale).toBe(false)

    // Query used installation_id:2 (from install channel, not a default)
    const calls = (graphqlQueryForInstallation as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe(2) // installationId arg
  })
})

// ---------------------------------------------------------------------------
// P1 Regression tests: vulnerabilityAlerts graceful degradation
// ---------------------------------------------------------------------------

describe('P1 regression — vulnerabilityAlerts graceful: permission error → openAlertCount:null, not stale', () => {
  it('repo whose query errors on vulnerabilityAlerts → openAlertCount:null, repo NOT stale, other fields present', async () => {
    const repo = makeRepo({node_id: 'NODE_NOALERT_PERM', owner: 'org', name: 'no-alert-perm', installation_id: 1})

    let callCount = 0
    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(
      async (_installId: number, _query: string, _vars: Record<string, unknown>) => {
        callCount++
        if (callCount === 1) {
          // First call (with vulnerabilityAlerts): throw a permission error
          throw new Error('Must have push access to view vulnerability alerts.')
        }
        // Second call (no-alerts variant): succeed
        // Return a response without vulnerabilityAlerts field
        return {
          repository: {
            defaultBranchRef: {
              target: {
                statusCheckRollup: {state: 'SUCCESS'},
                checkSuites: {nodes: []},
              },
            },
            pullRequests: {totalCount: 1},
            issues: {totalCount: 2},
            // No vulnerabilityAlerts field — the no-alerts query variant
          },
        }
      },
    )

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_NOALERT_PERM', owner: 'org', name: 'no-alert-perm'})],
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(1)
    const repoStatus = snap.repos[0]?.status

    // openAlertCount is null (permission unavailable), NOT stale
    expect(repoStatus?.openAlertCount).toBeNull()
    expect(repoStatus?.stale).toBe(false)

    // Other fields are present and correct
    expect(repoStatus?.rollupState).toBe('green')
    expect(repoStatus?.openPrCount).toBe(1)
    expect(repoStatus?.openIssueCount).toBe(2)

    // Two calls were made: first with alerts (failed), second without (succeeded)
    expect(callCount).toBe(2)
  })

  it('repo with non-permission GraphQL error → stale (not graceful retry)', async () => {
    const repo = makeRepo({node_id: 'NODE_REAL_FAIL', owner: 'org', name: 'real-fail', installation_id: 1})

    const graphqlQueryForInstallation: GraphqlQueryForInstallationFn = vi.fn().mockImplementation(async () => {
      throw new Error('GraphQL network timeout')
    })

    const deps = makeDeps({
      enumerate: vi.fn().mockResolvedValue(makeEnumerateResult([repo])),
      readMetadata: vi.fn().mockResolvedValue(ok(makeMetadataResult({
        publicRepos: [makePublicRepo({node_id: 'NODE_REAL_FAIL', owner: 'org', name: 'real-fail'})],
      }))),
      graphqlQueryForInstallation,
    })

    const agg = createAggregator(fakeInstallationsClient, fakeMetadataReader, deps)
    await agg.refresh()
    const snap = agg.getSnapshot()

    expect(snap.repos).toHaveLength(1)
    // Non-permission error → stale
    expect(snap.repos[0]?.status.stale).toBe(true)
    // Only one call (no retry for non-permission errors)
    expect((graphqlQueryForInstallation as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// P1 Regression tests: per-install token cache (no cross-install reuse)
// ---------------------------------------------------------------------------

describe('P1 regression — per-install token cache: no cross-install reuse', () => {
  it('mintReadOnlyToken(1)=>token-1, (2)=>token-2: no cross-install reuse; repeated same install reuses cache', async () => {
    const {mintReadOnlyToken} = await import('../src/github/installations.ts')

    // Use unique IDs to avoid cache hits from other tests
    const INSTALL_ID_1 = 8001
    const INSTALL_ID_2 = 8002

    const mintFn = vi.fn()
      .mockResolvedValueOnce('token-for-8001')
      .mockResolvedValueOnce('token-for-8002')
      .mockResolvedValue('should-not-be-called-again')

    // First call for each installation
    const token1a = await mintReadOnlyToken(INSTALL_ID_1, mintFn)
    const token2a = await mintReadOnlyToken(INSTALL_ID_2, mintFn)

    // Tokens are different (no cross-install reuse)
    expect(token1a).toBe('token-for-8001')
    expect(token2a).toBe('token-for-8002')
    expect(token1a).not.toBe(token2a)

    // Second call for each installation — should hit cache (no new mint)
    const token1b = await mintReadOnlyToken(INSTALL_ID_1, mintFn)
    const token2b = await mintReadOnlyToken(INSTALL_ID_2, mintFn)

    // Cache hit: same tokens returned
    expect(token1b).toBe('token-for-8001')
    expect(token2b).toBe('token-for-8002')

    // mintFn called exactly twice (once per installation, cache hit on repeat)
    expect(mintFn).toHaveBeenCalledTimes(2)
  })
})
