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

import {logger, sanitizeErrorMessage, type LogContext} from '../logger.ts'
import {isErr, isOk} from '../result.ts'

// ---------------------------------------------------------------------------
// Injectable GraphQL transport
// ---------------------------------------------------------------------------

/**
 * A single GraphQL query function. Accepts a query string and variables,
 * returns the raw response data. Injectable so tests never hit the network.
 *
 * @deprecated Use GraphqlQueryForInstallationFn instead — this type is kept
 * for backward compatibility with existing tests that inject graphqlQuery.
 */
export type GraphqlQueryFn = (query: string, variables: Record<string, unknown>) => Promise<unknown>

/**
 * Per-installation GraphQL query function. Accepts an installationId so the
 * implementation can mint the correct credential for each repo.
 * Injectable so tests never hit the network.
 */
export type GraphqlQueryForInstallationFn = (
  installationId: number,
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>

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

/**
 * Fallback query variant without vulnerabilityAlerts — used when the token
 * lacks the security_events/vulnerability_alerts scope. openAlertCount is set
 * to null (not stale) when this variant is used.
 */
const REPO_STATUS_QUERY_NO_ALERTS = `
  query RepoStatusNoAlerts($owner: String!, $name: String!) {
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
    vulnerabilityAlerts?: {totalCount: number} | null
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
  /**
   * Per-installation GraphQL query function — tests inject a fake.
   * The installationId is used to mint the correct credential for each repo.
   */
  readonly graphqlQueryForInstallation: GraphqlQueryForInstallationFn
  /** Injectable clock (defaults to Date.now) */
  readonly now?: () => number
  /** Injectable setInterval (defaults to global setInterval) */
  readonly setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Injectable clearInterval (defaults to global clearInterval) */
  readonly clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void
  /**
   * Optional: resolve the installation ID for a repo by owner/name.
   * Used for metadata-only public repos that have no installation_id from the
   * enumeration channel. If absent, such repos are skipped (not queried).
   */
  readonly resolveInstallationIdForRepo?: (owner: string, name: string) => Promise<number>
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
  /**
   * The installation ID that can authenticate GraphQL queries for this repo.
   * INTERNAL ONLY — never exposed in DashboardRepo or AggregatorSnapshot.
   * null means no installation was found; the repo will be skipped or marked stale.
   */
  readonly installation_id: number | null
}

/**
 * The generic discovery channel assigned to installation-only repos (repos seen
 * via the installation channel but NOT present in the metadata public set). This
 * is the redaction discriminator: any other channel value means the repo came
 * from the public metadata set and is safe to identify in logs. Defined once and
 * referenced at both the production site (buildWorkingSet) and the consumption
 * sites (safeRepoLogIdentity / safeRepoErrorContext) so the two can never drift.
 */
const DISCOVERED_CHANNEL = 'discovered'

/** A repo is known-public only if it came from the metadata public set. */
function isKnownPublic(discoveryChannel: string): boolean {
  return discoveryChannel !== DISCOVERED_CHANNEL
}

type RepoLogIdentity = Pick<WorkingSetEntry, 'node_id' | 'owner' | 'name' | 'discovery_channel' | 'installation_id'>

/**
 * Build the working set from the union of installation repos and metadata publicRepos,
 * then REMOVE every repo whose node_id is in redactedNodeIds OR whose database_id is
 * in redactedDatabaseIds.
 *
 * This is the DENYLIST-BEFORE-QUERY enforcement point. The returned set contains
 * ONLY repos that are safe to query. Denylisted repos never reach the query loop.
 *
 * Cross-format safety: GitHub has two node_id formats (legacy base64 and new R_kgDO...).
 * The node_id check is the primary guard (both channels use the same format per API
 * version). The database_id check is the secondary, format-independent guard — it closes
 * the gap if API-version skew ever produces different node_id formats for the same repo
 * across channels.
 *
 * redactedDatabaseIds is now populated from TWO sources:
 *   1. Explicit `database_id`/`id` fields in repos.yaml entries (if present).
 *   2. Derived from the node_id string via `deriveDatabaseId()` in metadata.ts:
 *      legacy base64 node_ids (e.g. `MDEwOlJlcG9zaXRvcnkxODY5MTU0`) encode the
 *      databaseId in their decoded ASCII form and can be reliably extracted.
 *      New-format node_ids (`R_kgDO...`) cannot be reliably decoded without a
 *      known test vector — `deriveDatabaseId` returns null for them, so those
 *      entries contribute only to redactedNodeIds (primary guard only).
 *
 * Residual limitation: if a redacted entry has a new-format node_id AND the
 * installation channel returns the same repo under a DIFFERENT new-format node_id
 * (cross-format skew within the new format), neither guard catches it. This is
 * an extremely unlikely edge case (new-format node_ids are stable per repo), and
 * the primary node_id guard still works for same-format matches. The databaseId
 * secondary guard closes the gap for all legacy-format entries and any entry with
 * an explicit database_id field. A warning is logged when any redacted entry
 * could not contribute a derived databaseId (denylistComplete=false).
 *
 * @param installRepos - Repos from the installations channel (must carry database_id)
 * @param metadata - Parsed metadata result (publicRepos + redactedNodeIds + redactedDatabaseIds)
 * @returns { workingSet, driftCount, denylistComplete } where driftCount is the number of
 *   installation-only repos (not in publicRepos, not denylisted) — count only, and
 *   denylistComplete indicates whether ALL redacted entries contributed a databaseId.
 */
function buildWorkingSet(
  installRepos: readonly {node_id: string; database_id: number; owner: string; name: string; full_name: string; installation_id: number}[],
  metadata: MetadataResult,
): {workingSet: WorkingSetEntry[]; driftCount: number; denylistComplete: boolean} {
  const {publicRepos, redactedNodeIds, redactedDatabaseIds} = metadata

  // denylistComplete: true if every redacted node_id also has a derived databaseId in
  // redactedDatabaseIds. False means at least one redacted entry (likely a new-format
  // R_kgDO... node_id) could not contribute a databaseId — the cross-format secondary
  // guard is partial for that entry. The primary node_id guard still applies.
  // Tradeoff: we do NOT fail fully closed here — the primary guard covers same-format
  // matches, and full fail-closed-to-empty would be too aggressive for a single
  // undecodable new-format node_id. We log a warning instead.
  let denylistComplete = true
  for (const nodeId of redactedNodeIds) {
    // Check if this node_id has a corresponding databaseId in the denylist.
    // We can't reverse-lookup by node_id here, so we check if redactedDatabaseIds
    // is non-empty as a proxy — if it's empty and redactedNodeIds is non-empty,
    // at least one entry has no derived databaseId.
    // More precise: new-format node_ids (R_kgDO...) can't be decoded, so if any
    // redacted node_id starts with R_, denylistComplete is false.
    if (nodeId.startsWith('R_')) {
      denylistComplete = false
      break
    }
  }

  // Index install repos by node_id AND database_id for O(1) lookup.
  // This is the auth-context index: when a metadata publicRepo matches an install
  // repo, we use the install repo's installation_id (the only valid auth context).
  const installByNodeId = new Map<string, (typeof installRepos)[number]>()
  const installByDatabaseId = new Map<number, (typeof installRepos)[number]>()
  for (const repo of installRepos) {
    installByNodeId.set(repo.node_id, repo)
    installByDatabaseId.set(repo.database_id, repo)
  }

  // Union: start with publicRepos (they have authoritative channel labels).
  // For each publicRepo, look up the matching install repo to get installation_id.
  // If no match, installation_id is null (will be resolved later or skipped).
  const unionByNodeId = new Map<string, WorkingSetEntry>()
  for (const pub of publicRepos) {
    // *** DENYLIST CHECK — publicRepos should never contain redacted entries,
    // but we double-check here for defense-in-depth ***
    if (redactedNodeIds.has(pub.node_id)) {
      continue
    }

    // Look up the install repo to get the installation_id (auth context).
    const installRepo = installByNodeId.get(pub.node_id)
    const installationId = installRepo?.installation_id ?? null

    unionByNodeId.set(pub.node_id, {
      node_id: pub.node_id,
      owner: pub.owner,
      name: pub.name,
      full_name: `${pub.owner}/${pub.name}`,
      discovery_channel: pub.discovery_channel,
      installation_id: installationId,
    })
  }

  // Add installation repos not already in the union
  let driftCount = 0
  for (const repo of installRepos) {
    // *** PRIMARY + SECONDARY DENYLIST-BEFORE-QUERY ENFORCEMENT ***
    // Exclude if EITHER:
    //   (a) node_id matches redactedNodeIds (primary — same format per API version), OR
    //   (b) database_id matches redactedDatabaseIds (secondary — format-independent,
    //       closes the node_id format-mismatch gap; populated from derived databaseIds
    //       extracted from legacy base64 node_ids AND explicit database_id fields).
    // A match on either key is sufficient to exclude the repo.
    if (redactedNodeIds.has(repo.node_id) || redactedDatabaseIds.has(repo.database_id)) {
      continue
    }

    if (!unionByNodeId.has(repo.node_id)) {
      // Installation-only repo: use generic 'discovered' label
      unionByNodeId.set(repo.node_id, {
        node_id: repo.node_id,
        owner: repo.owner,
        name: repo.name,
        full_name: repo.full_name,
        discovery_channel: DISCOVERED_CHANNEL,
        installation_id: repo.installation_id,
      })
      driftCount++
    }
  }

  return {workingSet: [...unionByNodeId.values()], driftCount, denylistComplete}
}

// ---------------------------------------------------------------------------
// Per-repo GraphQL fetch
// ---------------------------------------------------------------------------

/**
 * Build a log-safe identity for a repo (#54).
 *
 * Private repo names must never reach operational logs. A repo's real
 * `owner`/`name` are only safe to log when the repo is KNOWN PUBLIC — i.e. it
 * came from the `metadata/repos.yaml` public set. Installation-only repos are
 * NOT known public and may be private, so they are logged with only
 * non-revealing identifiers (`node_id`/`installation_id`) instead of
 * `owner`/`name`.
 */
function safeRepoLogIdentity(entry: RepoLogIdentity): LogContext {
  if (!isKnownPublic(entry.discovery_channel)) {
    // Not known public — redact owner/name, keep diagnosable opaque identity.
    return {repoNodeId: entry.node_id, installationId: entry.installation_id}
  }
  // Known public (from metadata public set) — name is safe to log.
  return {owner: entry.owner, name: entry.name, repoNodeId: entry.node_id}
}

/**
 * Build a log-safe identity + error context (#54).
 *
 * The error string is a SECOND leak vector: GitHub's GraphQL API echoes the
 * queried `owner/name` back in error messages (e.g. "Could not resolve to a
 * Repository with the name 'private-org/secret-repo'"). `sanitizeErrorMessage`
 * strips credentials but NOT repo names, so for a not-known-public repo the
 * repo's own `owner`, `name`, and `full_name` are stripped from the error text
 * before logging.
 */
function safeRepoErrorContext(entry: RepoLogIdentity, error: unknown): LogContext {
  const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
  const identity = safeRepoLogIdentity(entry)
  if (isKnownPublic(entry.discovery_channel)) {
    return {...identity, error: message}
  }
  // Not known public — also scrub this repo's identity from the error text.
  const scrubbed = redactRepoIdentityFromText(message, entry)
  return {...identity, error: scrubbed}
}

/** Strip a repo's own owner, name, and full_name occurrences from a text string. */
function redactRepoIdentityFromText(text: string, entry: RepoLogIdentity): string {
  // Replace identity tokens LONGEST-FIRST so the most specific match always wins
  // and no partial fragment survives when tokens overlap (e.g. the name is a
  // substring of the owner). An error string may carry the full `owner/name`,
  // or the owner or name in isolation.
  const tokens = [`${entry.owner}/${entry.name}`, entry.owner, entry.name]
    .filter(token => token.length > 1)
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const token of tokens) {
    out = out.split(token).join('[REDACTED_REPO]')
  }
  return out
}

/**
 * Detect whether a GraphQL error is specifically about the vulnerabilityAlerts
 * field being inaccessible (permission/scope error).
 */
function isVulnerabilityAlertsPermissionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  // GitHub GraphQL returns errors like:
  //   "Must have push access to view vulnerability alerts."
  //   "Resource not accessible by integration"
  //   "Field 'vulnerabilityAlerts' doesn't exist on type 'Repository'"
  return (
    msg.includes('vulnerabilityalerts') ||
    msg.includes('vulnerability_alerts') ||
    msg.includes('vulnerability alerts') ||
    (msg.includes('push access') && msg.includes('vulnerability'))
  )
}

/**
 * Parse a GraphQL response into a RepoCiStatus, with openAlertCount from the response
 * (or null if the field is absent/null).
 */
function parseRepoResponse(raw: unknown, fetchedAt: number, openAlertCount: number | null): RepoCiStatus {
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

  // Use the provided openAlertCount (may be from the response or null if no-alerts variant)
  const alertCount = openAlertCount ?? (repo.vulnerabilityAlerts?.totalCount ?? null)

  return {rollupState, failingChecks, openPrCount, openIssueCount, openAlertCount: alertCount, stale: false, fetchedAt}
}

async function fetchRepoStatus(
  entry: WorkingSetEntry,
  graphqlQueryForInstallation: GraphqlQueryForInstallationFn,
  now: () => number,
): Promise<RepoCiStatus> {
  const fetchedAt = now()

  // installation_id must be present — if null, we cannot authenticate the query
  if (entry.installation_id === null) {
    logger.warning('No installation_id for repo; marking stale', safeRepoLogIdentity(entry))
    return {rollupState: 'unknown', failingChecks: 0, openPrCount: 0, openIssueCount: 0, openAlertCount: null, stale: true, fetchedAt}
  }

  const installationId = entry.installation_id
  const vars = {owner: entry.owner, name: entry.name}

  try {
    const raw = await graphqlQueryForInstallation(installationId, REPO_STATUS_QUERY, vars)
    return parseRepoResponse(raw, fetchedAt, null)
  } catch (error) {
    // P1 #11: if the error is specifically about vulnerabilityAlerts permission,
    // retry without that field and set openAlertCount = null (not stale).
    if (isVulnerabilityAlertsPermissionError(error)) {
      logger.warning('vulnerabilityAlerts permission error; retrying without alerts field', safeRepoLogIdentity(entry))
      try {
        const raw = await graphqlQueryForInstallation(installationId, REPO_STATUS_QUERY_NO_ALERTS, vars)
        // Parse with openAlertCount=null (alerts unavailable, not stale)
        return parseRepoResponse(raw, fetchedAt, null)
      } catch (retryError) {
        logger.warning('Per-repo GraphQL fetch failed (no-alerts retry); marking stale', safeRepoErrorContext(entry, retryError))
        return {rollupState: 'unknown', failingChecks: 0, openPrCount: 0, openIssueCount: 0, openAlertCount: null, stale: true, fetchedAt}
      }
    }

    logger.warning('Per-repo GraphQL fetch failed; marking stale', safeRepoErrorContext(entry, error))
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
  const {graphqlQueryForInstallation} = deps
  const now = deps.now ?? (() => Date.now())
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = deps.clearIntervalFn ?? (id => clearInterval(id))

  // Per-repo cache: node_id → CacheEntry
  const cache = new Map<string, CacheEntry>()

  // Last-good snapshot (serves stale data when refresh fails)
  let lastGoodSnapshot: AggregatorSnapshot | null = null

  // Interval handle
  let intervalHandle: ReturnType<typeof setInterval> | null = null

  // In-flight guard: prevents overlapping refreshes. If a refresh cycle takes
  // longer than the 60s interval, the next tick is skipped rather than piling
  // up concurrent refreshes that race on lastGoodSnapshot and the per-repo cache.
  let refreshing = false

  /**
   * Perform a full refresh cycle.
   *
   * Security: if readMetadata fails (denylist unavailable), we MUST NOT build
   * a fresh union. We serve last-good cache + staleBanner, or empty on cold start.
   */
  async function runRefresh(): Promise<void> {
    // 1. Read metadata + denylist FIRST
    const metadataResult = await deps.readMetadata(metadataReader)

    if (isErr(metadataResult)) {
      // FAIL-CLOSED: denylist unavailable — do NOT build a fresh union
      logger.warning('Metadata read failed; failing closed — serving stale/empty snapshot', {
        error: sanitizeErrorMessage(metadataResult.error.message),
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

    let installRepos: readonly {node_id: string; database_id: number; owner: string; name: string; full_name: string; installation_id: number}[] = []
    let enumerationFailed = false
    if (isOk(enumerateResult)) {
      installRepos = enumerateResult.data.repos
    } else {
      enumerationFailed = true
      logger.warning('Installation enumeration failed; using empty install set — snapshot will be incomplete', {
        error: sanitizeErrorMessage(String((enumerateResult as {error: unknown}).error)),
      })
    }

    // 3. Build working set — DENYLIST-BEFORE-QUERY applied here
    const {workingSet: rawWorkingSet, driftCount, denylistComplete} = buildWorkingSet(installRepos, metadata)

    // Resolve installation_id for metadata-only repos (those with installation_id=null).
    // These are public repos in metadata that weren't found in the installation channel.
    // We use resolveInstallationIdForRepo (App JWT endpoint) to find the right installation.
    // If unavailable or resolution fails, the repo is skipped (not queried without auth context).
    let workingSet: WorkingSetEntry[]
    if (deps.resolveInstallationIdForRepo === undefined) {
      // No resolver: filter out repos with no installation_id (cannot query safely)
      workingSet = rawWorkingSet.filter(e => e.installation_id !== null)
    } else {
      const resolveInstallation = deps.resolveInstallationIdForRepo
      const resolvedEntries: WorkingSetEntry[] = []
      for (const entry of rawWorkingSet) {
        if (entry.installation_id !== null) {
          resolvedEntries.push(entry)
          continue
        }
        // Metadata-only repo: resolve installation_id via App JWT
        try {
          const resolvedId = await resolveInstallation(entry.owner, entry.name)
          resolvedEntries.push({...entry, installation_id: resolvedId})
        } catch (resolveError) {
          logger.warning('Could not resolve installation for metadata-only repo; skipping', safeRepoErrorContext(entry, resolveError))
          // Skip: no valid auth context — do NOT query with an ambient token
        }
      }
      workingSet = resolvedEntries
    }

    // Warn if cross-format denylist protection is partial (new-format node_ids that
    // couldn't be decoded to a databaseId). The primary node_id guard still applies;
    // only the secondary databaseId guard is absent for those entries.
    if (!denylistComplete) {
      logger.warning(
        'Denylist cross-format protection is partial: one or more redacted entries have new-format node_ids (R_kgDO...) ' +
        'that could not be decoded to a numeric databaseId. The primary node_id guard still applies for same-format matches. ' +
        'If the installation channel returns the same repo under a different node_id format, it may not be excluded by the secondary guard.',
      )
    }

    if (workingSet.length === 0) {
      // staleBanner=true if enumeration failed (data is incomplete — install repos missing)
      lastGoodSnapshot = {repos: [], staleBanner: enumerationFailed, driftCount, refreshedAt: now()}
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

      const status = await fetchRepoStatus(entry, graphqlQueryForInstallation, now)
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
    // staleBanner=true if enumeration failed — data is incomplete (install repos missing).
    // We still show metadata publicRepos (they are public and safe), but the operator
    // must know the installation channel data is absent.
    lastGoodSnapshot = {repos: sorted, staleBanner: enumerationFailed, driftCount, refreshedAt: now()}

    logger.info('Aggregator refresh complete', {
      repoCount: sorted.length,
      driftCount,
      enumerationFailed,
    })
  }

  /**
   * Perform a refresh cycle, guarded against overlap. If a refresh is already
   * in flight, this call is skipped (returns immediately) so concurrent cycles
   * never race on shared state.
   */
  async function refresh(): Promise<void> {
    if (refreshing) {
      logger.debug('Refresh already in flight; skipping overlapping cycle')
      return
    }
    refreshing = true
    try {
      await runRefresh()
    } finally {
      refreshing = false
    }
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
          error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
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
