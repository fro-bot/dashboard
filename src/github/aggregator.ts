/**
 * Dashboard aggregator — Phase-1 signal set with cross-source leak guard.
 *
 * Security invariants (enforced here, tested in test/aggregator.test.ts):
 *
 * 1. DENYLIST-BEFORE-QUERY: The working set is filtered against redactedNodeIds
 *    BEFORE any per-repo GraphQL query is issued. A query against a redacted
 *    private repo is itself an observable signal/leak — it must never happen.
 *    See: buildWorkingSet() → the filter is applied before the query loop.
 *
 * 2. FAIL-CLOSED on denylist unavailability: If readMetadata returns err(...),
 *    we MUST NOT build a fresh union of installation-discovered repos (the
 *    denylist would be incomplete). Instead: serve last-good cache + staleBanner,
 *    or empty state on cold start. The GraphQL client is never called for
 *    installation-only repos when the denylist is unavailable.
 *
 * 3. SOURCE-CHANNEL LABELS: Repos in metadata publicRepos carry their
 *    discovery_channel. Repos discovered ONLY via installations (not in
 *    publicRepos, not denylisted) get the generic label 'discovered'. The
 *    metadata-vs-installation cardinality gap is reported as a count only
 *    (driftCount), never by repo identity.
 */

import type {Result} from '../result.ts'
import type {EnumerateReposResult, InstallationsClient} from './installations.ts'
import type {MetadataError, MetadataReader, MetadataResult} from './metadata.ts'

import {logger} from '../logger.ts'
import {isErr, isOk} from '../result.ts'

// ---------------------------------------------------------------------------
// Injectable GraphQL transport
// ---------------------------------------------------------------------------

/**
 * A single GraphQL query function. Accepts a query string and variables,
 * returns the raw response data. Injectable so tests never hit the network.
 */
export type GraphqlQueryFn = (query: string, variables: Record<string, unknown>) => Promise<unknown>

// ---------------------------------------------------------------------------
// Phase-1 signal types
// ---------------------------------------------------------------------------

export type CiRollupState = 'green' | 'red' | 'pending' | 'unknown'

export interface RepoCiStatus {
  /** Mapped from statusCheckRollup.state: SUCCESS→green, FAILURE/ERROR→red, PENDING→pending */
  readonly rollupState: CiRollupState
  /** Number of failing check runs on the default branch */
  readonly failingChecks: number
  /** Number of open pull requests */
  readonly openPrCount: number
  /** Number of open issues */
  readonly openIssueCount: number
  /** Number of open security alerts (null if permission unavailable) */
  readonly openAlertCount: number | null
  /** Whether this repo's data is stale (per-repo fetch failed) */
  readonly stale: boolean
  /** When this data was fetched (ms since epoch) */
  readonly fetchedAt: number
}

/**
 * A repo entry in the dashboard snapshot.
 * Repos needing attention sort before healthy ones.
 */
export interface DashboardRepo {
  readonly node_id: string
  readonly owner: string
  readonly name: string
  readonly full_name: string
  /**
   * 'collab' | 'discovered' | any metadata discovery_channel value.
   * Repos only seen via installations (not in publicRepos) get 'discovered'.
   */
  readonly discovery_channel: string
  readonly status: RepoCiStatus
}

/**
 * The aggregator's public snapshot shape.
 */
export interface AggregatorSnapshot {
  /** Repos sorted attention-first */
  readonly repos: readonly DashboardRepo[]
  /**
   * True when the denylist was unavailable during the last refresh attempt
   * and we are serving stale/empty data.
   */
  readonly staleBanner: boolean
  /**
   * Count of repos the Agent App can see that are NOT in public metadata.
   * Never includes names or node_ids — count only.
   */
  readonly driftCount: number
  /** When the snapshot was last successfully refreshed (ms since epoch) */
  readonly refreshedAt: number | null
}

// ---------------------------------------------------------------------------
// Internal cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly fetchedAt: number
  readonly payload: RepoCiStatus
}

// ---------------------------------------------------------------------------
// GraphQL query + response types
// ---------------------------------------------------------------------------

const REPO_STATUS_QUERY = `
  query RepoStatus($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            statusCheckRollup {
              state
            }
            checkSuites(first: 10) {
              nodes {
                checkRuns(first: 50, filterBy: { status: COMPLETED, conclusions: [FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE] }) {
                  totalCount
                }
              }
            }
          }
        }
      }
      pullRequests(states: OPEN) {
        totalCount
      }
      issues(states: OPEN) {
        totalCount
      }
      vulnerabilityAlerts(states: OPEN) {
        totalCount
      }
    }
  }
`

interface GraphqlRepoResponse {
  repository: {
    defaultBranchRef: {
      target: {
        statusCheckRollup: {state: string} | null
        checkSuites: {
          nodes: {checkRuns: {totalCount: number}}[]
        }
      }
    } | null
    pullRequests: {totalCount: number}
    issues: {totalCount: number}
    vulnerabilityAlerts: {totalCount: number} | null
  } | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRollupState(raw: string | undefined | null): CiRollupState {
  if (raw === 'SUCCESS') return 'green'
  if (raw === 'FAILURE' || raw === 'ERROR') return 'red'
  if (raw === 'PENDING' || raw === 'EXPECTED') return 'pending'
  return 'unknown'
}

function needsAttention(status: RepoCiStatus): boolean {
  if (status.stale) return true
  if (status.rollupState === 'red') return true
  if (status.failingChecks > 0) return true
  if (status.openAlertCount !== null && status.openAlertCount > 0) return true
  if (status.openPrCount > 0) return true
  return false
}

function sortAttentionFirst(repos: DashboardRepo[]): DashboardRepo[] {
  return repos.sort((a, b) => {
    const aNeeds = needsAttention(a.status) ? 0 : 1
    const bNeeds = needsAttention(b.status) ? 0 : 1
    return aNeeds - bNeeds
  })
}

// ---------------------------------------------------------------------------
// Aggregator deps interface
// ---------------------------------------------------------------------------

export interface AggregatorDeps {
  /** Enumerate repos from all installations */
  readonly enumerate: (client: InstallationsClient) => Promise<Result<EnumerateReposResult, unknown>>
  /** Read repo metadata + denylist */
  readonly readMetadata: (reader: MetadataReader) => Promise<Result<MetadataResult, MetadataError>>
  /** Injectable GraphQL query function — tests inject a fake */
  readonly graphqlQuery: GraphqlQueryFn
  /** Injectable clock (defaults to Date.now) */
  readonly now?: () => number
  /** Injectable setInterval (defaults to global setInterval) */
  readonly setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Injectable clearInterval (defaults to global clearInterval) */
  readonly clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void
}

// ---------------------------------------------------------------------------
// Working set entry (pre-query)
// ---------------------------------------------------------------------------

interface WorkingSetEntry {
  readonly node_id: string
  readonly owner: string
  readonly name: string
  readonly full_name: string
  readonly discovery_channel: string
}

/**
 * Build the working set from the union of installation repos and metadata publicRepos,
 * then REMOVE every repo whose node_id is in redactedNodeIds.
 *
 * This is the DENYLIST-BEFORE-QUERY enforcement point. The returned set contains
 * ONLY repos that are safe to query. Denylisted node_ids never reach the query loop.
 *
 * @param installRepos - Repos from the installations channel
 * @param metadata - Parsed metadata result (publicRepos + redactedNodeIds)
 * @returns { workingSet, driftCount } where driftCount is the number of
 *   installation-only repos (not in publicRepos, not denylisted) — count only.
 */
function buildWorkingSet(
  installRepos: readonly {node_id: string; owner: string; name: string; full_name: string}[],
  metadata: MetadataResult,
): {workingSet: WorkingSetEntry[]; driftCount: number} {
  const {publicRepos, redactedNodeIds} = metadata

  // Index publicRepos by node_id for O(1) lookup
  const publicByNodeId = new Map<string, (typeof publicRepos)[number]>()
  for (const pub of publicRepos) {
    publicByNodeId.set(pub.node_id, pub)
  }

  // Union: start with publicRepos (they have authoritative channel labels)
  const unionByNodeId = new Map<string, WorkingSetEntry>()
  for (const pub of publicRepos) {
    // *** DENYLIST CHECK — publicRepos should never contain redacted entries,
    // but we double-check here for defense-in-depth ***
    if (!redactedNodeIds.has(pub.node_id)) {
      unionByNodeId.set(pub.node_id, {
        node_id: pub.node_id,
        owner: pub.owner,
        name: pub.name,
        full_name: `${pub.owner}/${pub.name}`,
        discovery_channel: pub.discovery_channel,
      })
    }
  }

  // Add installation repos not already in the union
  let driftCount = 0
  for (const repo of installRepos) {
    // *** PRIMARY DENYLIST-BEFORE-QUERY ENFORCEMENT ***
    // If this repo's node_id is in the denylist, SKIP IT — never add to working set,
    // never query it. This is the exact line where denylisted ids are removed.
    if (redactedNodeIds.has(repo.node_id)) {
      continue
    }

    if (!unionByNodeId.has(repo.node_id)) {
      // Installation-only repo: use generic 'discovered' label
      unionByNodeId.set(repo.node_id, {
        node_id: repo.node_id,
        owner: repo.owner,
        name: repo.name,
        full_name: repo.full_name,
        discovery_channel: 'discovered',
      })
      driftCount++
    }
  }

  return {workingSet: [...unionByNodeId.values()], driftCount}
}

// ---------------------------------------------------------------------------
// Per-repo GraphQL fetch
// ---------------------------------------------------------------------------

async function fetchRepoStatus(
  entry: WorkingSetEntry,
  graphqlQuery: GraphqlQueryFn,
  now: () => number,
): Promise<RepoCiStatus> {
  const fetchedAt = now()
  try {
    const raw = await graphqlQuery(REPO_STATUS_QUERY, {owner: entry.owner, name: entry.name})
    const data = raw as GraphqlRepoResponse

    const repo = data.repository
    if (repo === null || repo === undefined) {
      return {rollupState: 'unknown', failingChecks: 0, openPrCount: 0, openIssueCount: 0, openAlertCount: null, stale: false, fetchedAt}
    }

    const target = repo.defaultBranchRef?.target
    const rollupRaw = target?.statusCheckRollup?.state
    const rollupState = mapRollupState(rollupRaw)

    // Sum failing check runs across all check suites
    let failingChecks = 0
    if (target?.checkSuites?.nodes) {
      for (const suite of target.checkSuites.nodes) {
        failingChecks += suite.checkRuns.totalCount
      }
    }

    const openPrCount = repo.pullRequests.totalCount
    const openIssueCount = repo.issues.totalCount

    // Security alerts: may be null if permission unavailable — handle gracefully
    const openAlertCount = repo.vulnerabilityAlerts?.totalCount ?? null

    return {rollupState, failingChecks, openPrCount, openIssueCount, openAlertCount, stale: false, fetchedAt}
  } catch (error) {
    logger.warning('Per-repo GraphQL fetch failed; marking stale', {
      owner: entry.owner,
      name: entry.name,
      error: error instanceof Error ? error.message : String(error),
    })
    return {rollupState: 'unknown', failingChecks: 0, openPrCount: 0, openIssueCount: 0, openAlertCount: null, stale: true, fetchedAt}
  }
}

// ---------------------------------------------------------------------------
// Aggregator factory
// ---------------------------------------------------------------------------

/**
 * Create a dashboard aggregator.
 *
 * The aggregator is a factory — it does NOT auto-start an interval at import
 * time. Call `start()` to begin background refresh, `stop()` to cancel it.
 *
 * Deps are fully injectable for testing (fake timers, fake GraphQL, fake
 * enumerate/readMetadata).
 */
export function createAggregator(
  installationsClient: InstallationsClient,
  metadataReader: MetadataReader,
  deps: AggregatorDeps,
) {
  const {graphqlQuery} = deps
  const now = deps.now ?? (() => Date.now())
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = deps.clearIntervalFn ?? (id => clearInterval(id))

  // Per-repo cache: node_id → CacheEntry
  const cache = new Map<string, CacheEntry>()

  // Last-good snapshot (serves stale data when refresh fails)
  let lastGoodSnapshot: AggregatorSnapshot | null = null

  // Interval handle
  let intervalHandle: ReturnType<typeof setInterval> | null = null

  /**
   * Perform a full refresh cycle.
   *
   * Security: if readMetadata fails (denylist unavailable), we MUST NOT build
   * a fresh union. We serve last-good cache + staleBanner, or empty on cold start.
   */
  async function refresh(): Promise<void> {
    // 1. Read metadata + denylist FIRST
    const metadataResult = await deps.readMetadata(metadataReader)

    if (isErr(metadataResult)) {
      // FAIL-CLOSED: denylist unavailable — do NOT build a fresh union
      logger.warning('Metadata read failed; failing closed — serving stale/empty snapshot', {
        error: metadataResult.error.message,
      })

      if (lastGoodSnapshot === null) {
        // Cold start with no cache — serve empty with banner
        lastGoodSnapshot = {repos: [], staleBanner: true, driftCount: 0, refreshedAt: null}
      } else {
        // Serve last-good with staleBanner
        lastGoodSnapshot = {...lastGoodSnapshot, staleBanner: true}
      }
      return
    }

    const metadata = metadataResult.data

    // 2. Enumerate installation repos
    const enumerateResult = await deps.enumerate(installationsClient)

    let installRepos: readonly {node_id: string; owner: string; name: string; full_name: string}[] = []
    if (isOk(enumerateResult)) {
      installRepos = enumerateResult.data.repos
    } else {
      logger.warning('Installation enumeration failed; using empty install set', {
        error: String((enumerateResult as {error: unknown}).error),
      })
    }

    // 3. Build working set — DENYLIST-BEFORE-QUERY applied here
    const {workingSet, driftCount} = buildWorkingSet(installRepos, metadata)

    if (workingSet.length === 0) {
      lastGoodSnapshot = {repos: [], staleBanner: false, driftCount, refreshedAt: now()}
      return
    }

    // 4. Fetch per-repo status — only for repos that survived the denylist filter
    const dashboardRepos: DashboardRepo[] = []
    for (const entry of workingSet) {
      // Check cache first (60s TTL)
      const cached = cache.get(entry.node_id)
      const CACHE_TTL_MS = 60_000
      if (cached !== undefined && now() - cached.fetchedAt < CACHE_TTL_MS) {
        dashboardRepos.push({
          node_id: entry.node_id,
          owner: entry.owner,
          name: entry.name,
          full_name: entry.full_name,
          discovery_channel: entry.discovery_channel,
          status: cached.payload,
        })
        continue
      }

      const status = await fetchRepoStatus(entry, graphqlQuery, now)
      cache.set(entry.node_id, {fetchedAt: status.fetchedAt, payload: status})
      dashboardRepos.push({
        node_id: entry.node_id,
        owner: entry.owner,
        name: entry.name,
        full_name: entry.full_name,
        discovery_channel: entry.discovery_channel,
        status,
      })
    }

    // 5. Sort attention-first and store snapshot
    const sorted = sortAttentionFirst(dashboardRepos)
    lastGoodSnapshot = {repos: sorted, staleBanner: false, driftCount, refreshedAt: now()}

    logger.info('Aggregator refresh complete', {
      repoCount: sorted.length,
      driftCount,
    })
  }

  /**
   * Get the current snapshot. Returns empty state if no refresh has run yet.
   */
  function getSnapshot(): AggregatorSnapshot {
    if (lastGoodSnapshot === null) {
      return {repos: [], staleBanner: false, driftCount: 0, refreshedAt: null}
    }
    return lastGoodSnapshot
  }

  /**
   * Start the background refresh interval (60s). Also triggers an immediate refresh.
   */
  async function start(): Promise<void> {
    await refresh()
    intervalHandle = setIntervalFn(() => {
      refresh().catch(error => {
        logger.error('Aggregator background refresh threw unexpectedly', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, 60_000)
  }

  /**
   * Stop the background refresh interval.
   */
  function stop(): void {
    if (intervalHandle !== null) {
      clearIntervalFn(intervalHandle)
      intervalHandle = null
    }
  }

  return {refresh, getSnapshot, start, stop}
}

export type Aggregator = ReturnType<typeof createAggregator>
