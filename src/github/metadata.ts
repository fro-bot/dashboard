/**
 * Repo metadata reader for the dashboard.
 *
 * Reads `metadata/repos.yaml` from the `fro-bot/.github` `data` branch and
 * exports a denylist of redacted node_ids for the aggregator.
 *
 * Security invariants:
 * - Redacted entries (private:true / owner:'[REDACTED]') are NEVER included in
 *   publicRepos. Their owner/name are never stored, logged, or returned.
 * - Only the node_id of a redacted entry is retained (it is the denylist key).
 * - The aggregator MUST exclude denylisted repos BEFORE any per-repo query.
 * - ALL error paths return err(...) — nothing throws out of readRepoMetadata.
 * - 404 / data-branch missing → err(MetadataUnavailableError), logged at warning.
 * - Malformed YAML / parse failure → err(MetadataParseError), logged at error.
 * - Transport error (reader rejects) → err(MetadataTransportError), logged at error.
 * - Wrong schema version → err(MetadataSchemaError), logged at error. FAIL CLOSED.
 *
 * Aggregator contract:
 *   - ok(MetadataResult) → use publicRepos + redactedNodeIds normally.
 *   - err(MetadataUnavailableError) → data branch missing; fail closed (serve stale/empty).
 *   - err(MetadataParseError | MetadataSchemaError | MetadataTransportError) → hard error;
 *     fail closed (do NOT build a fresh union against an incomplete denylist).
 */

import type {Result} from '../result.ts'

import {Buffer} from 'node:buffer'
import {parse} from 'yaml'

import {logger, sanitizeErrorMessage} from '../logger.ts'
import {err, ok} from '../result.ts'

// ---------------------------------------------------------------------------
// Reader interface (injectable — tests inject a fake, production injects real)
// ---------------------------------------------------------------------------

/**
 * Injectable content reader. Receives a file path and git ref, returns the
 * raw file contents as a string.
 *
 * Implementations MUST throw a `MetadataNotFoundError`-shaped error (or any
 * error with `code === 'NOT_FOUND'`) when the file/ref does not exist, so
 * `readRepoMetadata` can distinguish 404 from other transport failures.
 *
 * For convenience, `makeNotFoundError()` is exported below.
 */
export type MetadataReader = (path: string, ref: string) => Promise<string>

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A non-private repo entry from repos.yaml.
 * Only the fields needed by the aggregator are surfaced here.
 */
export interface PublicRepo {
  readonly owner: string
  readonly name: string
  readonly node_id: string
  readonly discovery_channel: string
}

/**
 * The result of a successful metadata read.
 */
export interface MetadataResult {
  /** Non-private repos with owner/name/channel/node_id. */
  readonly publicRepos: readonly PublicRepo[]
  /**
   * node_id of EVERY private:true / [REDACTED] entry.
   * The aggregator must exclude these BEFORE any per-repo query.
   *
   * Cross-format note: GitHub has two node_id formats (legacy base64
   * `MDEwOlJlcG9zaXRvcnkx` and new `R_kgDO...`). In practice both channels
   * use the same format for a given API version, so this set is the primary
   * denylist key. The secondary key is `redactedDatabaseIds` (see below).
   */
  readonly redactedNodeIds: ReadonlySet<string>
  /**
   * Numeric databaseId of EVERY private:true / [REDACTED] entry, when the
   * repos.yaml entry carries a `database_id` (or `id`) field.
   *
   * This is the format-independent join key: the numeric id is stable across
   * both node_id formats. Currently empty unless repos.yaml entries include a
   * `database_id`/`id` field. The aggregator checks BOTH sets — whichever
   * matches first excludes the repo.
   */
  readonly redactedDatabaseIds: ReadonlySet<number>
}

// ---------------------------------------------------------------------------
// Error types (discriminated by name for aggregator instanceof checks)
// ---------------------------------------------------------------------------

/**
 * The data branch or metadata file does not exist (404).
 * Logged at WARNING. The aggregator should fail closed (serve stale/empty).
 */
export class MetadataUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataUnavailableError'
  }
}

/**
 * The YAML content could not be parsed.
 * Logged at ERROR. The aggregator must fail closed.
 */
export class MetadataParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataParseError'
  }
}

/**
 * The YAML schema version is not supported (version !== 1 or missing).
 * Logged at ERROR. The aggregator must fail closed.
 */
export class MetadataSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataSchemaError'
  }
}

/**
 * The reader threw an unexpected transport error (network, auth, etc.).
 * Logged at ERROR. The aggregator must fail closed.
 */
export class MetadataTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataTransportError'
  }
}

export type MetadataError =
  | MetadataUnavailableError
  | MetadataParseError
  | MetadataSchemaError
  | MetadataTransportError

// ---------------------------------------------------------------------------
// Not-found sentinel (for reader implementations)
// ---------------------------------------------------------------------------

/**
 * Sentinel error code that reader implementations MUST use to signal a 404 /
 * file-not-found condition. `readRepoMetadata` checks `error.code === NOT_FOUND_CODE`
 * to distinguish unavailability from transport failures.
 */
export const NOT_FOUND_CODE = 'NOT_FOUND' as const

/**
 * Convenience factory for reader implementations to signal a 404.
 *
 * Usage in a real Octokit reader:
 *   if (response.status === 404) throw makeNotFoundError(`data branch not found`)
 */
export function makeNotFoundError(message: string): Error & {code: typeof NOT_FOUND_CODE} {
  const error = new Error(message) as Error & {code: typeof NOT_FOUND_CODE}
  error.code = NOT_FOUND_CODE
  return error
}

// ---------------------------------------------------------------------------
// Internal schema types (raw YAML shape — not exported)
// ---------------------------------------------------------------------------

interface RawRepoEntry {
  owner: unknown
  name: unknown
  added: unknown
  onboarding_status: unknown
  last_survey_at: unknown
  last_survey_status: unknown
  has_fro_bot_workflow: unknown
  has_renovate: unknown
  next_survey_eligible_at: unknown
  discovery_channel: unknown
  private: unknown
  node_id: unknown
  /** Optional numeric databaseId — future-proofing for format-independent denylist matching. */
  database_id: unknown
  /** Alias for database_id — accepted for convenience. */
  id: unknown
}

interface RawYaml {
  version: unknown
  repos: unknown
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

const REDACTED_OWNER = '[REDACTED]'
const DATA_REF = 'data'
const METADATA_PATH = 'metadata/repos.yaml'

/**
 * Read and parse `metadata/repos.yaml` from the `data` branch.
 *
 * @param reader - Injectable content reader. Must throw with `code === NOT_FOUND_CODE`
 *   for 404 / missing file/branch conditions.
 *
 * @returns
 *   - `ok(MetadataResult)` — parsed successfully; use publicRepos + redactedNodeIds.
 *   - `err(MetadataUnavailableError)` — 404 / data branch missing; fail closed.
 *   - `err(MetadataParseError)` — YAML parse failure; fail closed.
 *   - `err(MetadataSchemaError)` — unsupported schema version; fail closed.
 *   - `err(MetadataTransportError)` — unexpected transport error; fail closed.
 */
export async function readRepoMetadata(reader: MetadataReader): Promise<Result<MetadataResult, MetadataError>> {
  // 1. Fetch the file
  let raw: string
  try {
    raw = await reader(METADATA_PATH, DATA_REF)
  } catch (fetchError) {
    // Distinguish 404 (unavailable) from other transport errors
    if (isNotFoundError(fetchError)) {
      logger.warning('metadata/repos.yaml not found on data branch — denylist unavailable', {
        path: METADATA_PATH,
        ref: DATA_REF,
      })
      return err(new MetadataUnavailableError(`${METADATA_PATH} not found on ref=${DATA_REF}`))
    }
    const msg = sanitizeErrorMessage(fetchError instanceof Error ? fetchError.message : String(fetchError))
    logger.error('Transport error reading metadata/repos.yaml', {path: METADATA_PATH, ref: DATA_REF, error: msg})
    return err(new MetadataTransportError(`Transport error reading ${METADATA_PATH}: ${msg}`))
  }

  // 2. Parse YAML
  let parsed: unknown
  try {
    parsed = parse(raw)
  } catch (parseError) {
    const msg = sanitizeErrorMessage(parseError instanceof Error ? parseError.message : String(parseError))
    logger.error('Failed to parse metadata/repos.yaml', {error: msg})
    return err(new MetadataParseError(`Failed to parse ${METADATA_PATH}: ${msg}`))
  }

  // 3. Validate top-level shape
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.error('metadata/repos.yaml has unexpected top-level shape (expected object)')
    return err(new MetadataParseError(`${METADATA_PATH}: expected top-level object, got ${typeof parsed}`))
  }

  const doc = parsed as RawYaml

  // 4. Check schema version — FAIL CLOSED on mismatch
  if (doc.version !== 1) {
    logger.error('metadata/repos.yaml has unsupported schema version', {version: doc.version})
    return err(
      new MetadataSchemaError(
        `${METADATA_PATH}: unsupported schema version ${String(doc.version)} (expected 1)`,
      ),
    )
  }

  // 5. Validate repos array
  if (!Array.isArray(doc.repos)) {
    logger.error('metadata/repos.yaml missing repos array')
    return err(new MetadataParseError(`${METADATA_PATH}: expected repos to be an array`))
  }

  // 6. Iterate entries — classify as public or redacted
  const publicRepos: PublicRepo[] = []
  const redactedNodeIds = new Set<string>()
  const redactedDatabaseIds = new Set<number>()

  for (const rawEntry of doc.repos) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      // Skip malformed entries silently (log count at end)
      continue
    }

    const entry = rawEntry as RawRepoEntry
    const isPrivate = entry.private === true
    const isRedactedOwner = entry.owner === REDACTED_OWNER

    if (isPrivate || isRedactedOwner) {
      // Security: only retain deny keys — never store/log owner or name.
      //
      // Cross-format risk: GitHub has two node_id formats (legacy base64 and
      // new R_kgDO...). Both channels use the same format per API version, so
      // node_id is the primary key. The numeric database_id (from `database_id`
      // or `id` field) is the format-independent secondary key — it closes the
      // gap if API-version skew ever produces different node_id formats for the
      // same repo across channels.
      //
      // FAIL CLOSED: if a redacted entry has NO usable deny key (no valid
      // node_id AND no valid database_id), we cannot safely exclude it from
      // the aggregator's working set. Return err to prevent building a union
      // against an incomplete denylist. Do NOT log owner/name.
      const hasValidNodeId = typeof entry.node_id === 'string' && entry.node_id.length > 0
      const rawDbId = entry.database_id ?? entry.id
      const hasValidDatabaseId = typeof rawDbId === 'number' && Number.isFinite(rawDbId)

      if (!hasValidNodeId && !hasValidDatabaseId) {
        logger.error('Redacted/private repos.yaml entry has no usable deny key (no valid node_id or database_id) — failing closed')
        return err(new MetadataSchemaError(
          `${METADATA_PATH}: redacted/private entry has no usable deny key (node_id missing or empty, database_id absent)`,
        ))
      }

      if (hasValidNodeId) {
        const nodeIdStr = entry.node_id as string
        redactedNodeIds.add(nodeIdStr)
        // Attempt to derive the numeric databaseId from the node_id string.
        // This closes the cross-format gap: if the installation channel returns
        // the same repo under a different node_id format (legacy vs new R_kgDO...),
        // the exact node_id string match misses it — but the derived databaseId
        // (format-independent) catches it via the secondary guard.
        const derivedId = deriveDatabaseId(nodeIdStr)
        if (derivedId !== null) {
          redactedDatabaseIds.add(derivedId)
        }
      }
      if (typeof rawDbId === 'number' && Number.isFinite(rawDbId)) {
        redactedDatabaseIds.add(rawDbId)
      }
      // Do NOT add to publicRepos. Do NOT log owner/name.
    } else if (
      typeof entry.owner === 'string' &&
      typeof entry.name === 'string' &&
      typeof entry.node_id === 'string' &&
      typeof entry.discovery_channel === 'string'
    ) {
      publicRepos.push({
        owner: entry.owner,
        name: entry.name,
        node_id: entry.node_id,
        discovery_channel: entry.discovery_channel,
      })
    }
  }

  logger.info('metadata/repos.yaml loaded', {
    publicCount: publicRepos.length,
    redactedCount: redactedNodeIds.size,
  })

  return ok({publicRepos, redactedNodeIds, redactedDatabaseIds})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  return (error as Record<string, unknown>).code === NOT_FOUND_CODE
}

/**
 * Derive the numeric GitHub databaseId from a repository node_id string.
 *
 * GitHub has two node_id formats:
 *
 * 1. **Legacy base64** (e.g. `MDEwOlJlcG9zaXRvcnkxODY5MTU0`):
 *    base64-decode → ASCII like `010:Repository1869154`.
 *    The trailing integer after `Repository` is the databaseId.
 *    Verified known pair: `MDEwOlJlcG9zaXRvcnkxODY5MTU0` → 1869154
 *    (marcusrbrown/.dotfiles).
 *
 * 2. **New format** (starts with `R_`, e.g. `R_kgDOJ_bMaQ`):
 *    The binary decode is not reliably hand-rollable without a known test vector.
 *    Returns `null` to fail conservatively — the node_id string primary guard
 *    still applies; only the cross-format secondary guard is absent.
 *
 * Returns `null` on any decode failure or unrecognised format.
 *
 * @param nodeId - Raw node_id string from repos.yaml or GitHub API.
 * @returns The numeric databaseId, or null if it cannot be reliably derived.
 */
export function deriveDatabaseId(nodeId: string): number | null {
  if (typeof nodeId !== 'string' || nodeId.length === 0) return null

  // New format: R_kgDO... — conservative: return null rather than guess.
  if (nodeId.startsWith('R_')) return null

  // Legacy format: base64-decode and match `...Repository<digits>` suffix.
  try {
    const decoded = Buffer.from(nodeId, 'base64').toString('ascii')
    // Match the trailing Repository<digits> pattern (e.g. "010:Repository1869154")
    const match = /Repository(\d+)$/.exec(decoded)
    if (match === null || match[1] === undefined) return null
    const id = Number.parseInt(match[1], 10)
    if (!Number.isFinite(id) || id <= 0) return null
    return id
  } catch {
    return null
  }
}
