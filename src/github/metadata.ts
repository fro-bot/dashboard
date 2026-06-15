/**
 * Repo metadata reader for the dashboard.
 *
 * Reads `metadata/repos.yaml` from the `fro-bot/.github` `data` branch and
 * exports a denylist of redacted node_ids for the aggregator (Unit 4).
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
 * Unit 4 (aggregator) contract:
 *   - ok(MetadataResult) → use publicRepos + redactedNodeIds normally.
 *   - err(MetadataUnavailableError) → data branch missing; fail closed (serve stale/empty).
 *   - err(MetadataParseError | MetadataSchemaError | MetadataTransportError) → hard error;
 *     fail closed (do NOT build a fresh union against an incomplete denylist).
 */

import type {Result} from '../result.ts'

import {parse} from 'yaml'

import {logger} from '../logger.ts'
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
   */
  readonly redactedNodeIds: ReadonlySet<string>
}

// ---------------------------------------------------------------------------
// Error types (discriminated by name for Unit 4 instanceof checks)
// ---------------------------------------------------------------------------

/**
 * The data branch or metadata file does not exist (404).
 * Logged at WARNING. Unit 4 should fail closed (serve stale/empty).
 */
export class MetadataUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataUnavailableError'
  }
}

/**
 * The YAML content could not be parsed.
 * Logged at ERROR. Unit 4 must fail closed.
 */
export class MetadataParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataParseError'
  }
}

/**
 * The YAML schema version is not supported (version !== 1 or missing).
 * Logged at ERROR. Unit 4 must fail closed.
 */
export class MetadataSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataSchemaError'
  }
}

/**
 * The reader threw an unexpected transport error (network, auth, etc.).
 * Logged at ERROR. Unit 4 must fail closed.
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
    const msg = safeMessage(fetchError)
    logger.error('Transport error reading metadata/repos.yaml', {path: METADATA_PATH, ref: DATA_REF, error: msg})
    return err(new MetadataTransportError(`Transport error reading ${METADATA_PATH}: ${msg}`))
  }

  // 2. Parse YAML
  let parsed: unknown
  try {
    parsed = parse(raw)
  } catch (parseError) {
    const msg = safeMessage(parseError)
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

  for (const rawEntry of doc.repos) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      // Skip malformed entries silently (log count at end)
      continue
    }

    const entry = rawEntry as RawRepoEntry
    const isPrivate = entry.private === true
    const isRedactedOwner = entry.owner === REDACTED_OWNER

    if (isPrivate || isRedactedOwner) {
      // Security: only retain the node_id — never store/log owner or name
      if (typeof entry.node_id === 'string' && entry.node_id.length > 0) {
        redactedNodeIds.add(entry.node_id)
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

  return ok({publicRepos, redactedNodeIds})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  return (error as Record<string, unknown>).code === NOT_FOUND_CODE
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
