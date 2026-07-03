/**
 * RunSummary type and parse helpers for the operator contract.
 *
 * Mirrors the gateway's RunSummary from fro-bot/agent v0.78.0.
 * Error messages are fixed strings — never echo or interpolate input.
 * Extra fields are ignored (permissive structural subtyping).
 * Oversized strings are rejected without logging raw values.
 */

import type {Result} from '../../result.ts'

import {err, ok} from '../../result.ts'

/**
 * Index-only status set. 'blocked' and 'waiting_for_approval' are stream-only
 * overlays — never produced by the run-summary projector.
 */
export type RunSummaryStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * Operator-safe projection of a run's summary.
 * Internal coordination fields are excluded by construction.
 * updatedAt is optional — omitted when last_heartbeat is absent on the Gateway side.
 */
export interface RunSummary {
  readonly runId: string
  readonly repo: string
  readonly status: RunSummaryStatus
  readonly createdAt: string
  readonly updatedAt?: string
}

/** Maximum valid unique summaries returned by parseRunSummaryList. Matches browser JS RUN_INDEX_CAP. */
export const RUN_INDEX_CAP = 100

// Practical caps: GitHub run IDs and owner/repo paths are well under 512 chars;
// ISO 8601 dates are at most ~35 chars.
const MAX_ID_LENGTH = 512
const MAX_DATE_LENGTH = 128

const VALID_RUN_SUMMARY_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

function hasValidRunSummaryShape(value: unknown): value is RunSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.runId !== 'string' || candidate.runId.length > MAX_ID_LENGTH) {
    return false
  }

  if (typeof candidate.repo !== 'string' || candidate.repo.length > MAX_ID_LENGTH) {
    return false
  }

  if (typeof candidate.status !== 'string' || !VALID_RUN_SUMMARY_STATUSES.has(candidate.status)) {
    return false
  }

  if (typeof candidate.createdAt !== 'string' || candidate.createdAt.length > MAX_DATE_LENGTH) {
    return false
  }

  // updatedAt is optional — if present must be a length-capped string
  if (
    'updatedAt' in candidate &&
    (typeof candidate.updatedAt !== 'string' || candidate.updatedAt.length > MAX_DATE_LENGTH)
  ) {
    return false
  }

  return true
}

/** Parse an unknown value as RunSummary. Returns err with a fixed reason string on failure. */
export function parseRunSummary(input: unknown): Result<RunSummary, Error> {
  if (hasValidRunSummaryShape(input) === false) {
    return err(new Error('invalid run summary shape'))
  }

  // Closed DTO — copy only declared fields; never spread input.
  const summary: RunSummary = {
    runId: input.runId,
    repo: input.repo,
    status: input.status,
    createdAt: input.createdAt,
    ...('updatedAt' in input ? {updatedAt: input.updatedAt} : {}),
  }

  return ok(summary)
}

/**
 * Canonical response shape for GET /operator/runs (run index listing).
 * Mirrors the gateway's envelope: `{runs: RunSummary[]}` — never a bare array.
 */
export interface RunsListResponse {
  readonly runs: readonly RunSummary[]
}

/**
 * Parse an unknown value as an array of RunSummary.
 * Invalid items are skipped (per-item validation, not whole-list fail).
 * Duplicate runIds: keeps first valid entry (Gateway sorts newest-first).
 */
export function parseRunSummaryList(input: unknown): Result<RunSummary[], Error> {
  if (!Array.isArray(input)) {
    return err(new Error('invalid run summary list: expected array'))
  }

  const seen = new Set<string>()
  const valid: RunSummary[] = []

  for (const item of input) {
    if (valid.length >= RUN_INDEX_CAP) break

    const parsed = parseRunSummary(item)
    if (!parsed.success) continue

    const {runId} = parsed.data
    if (seen.has(runId)) continue

    seen.add(runId)
    valid.push(parsed.data)
  }

  return ok(valid)
}

/**
 * Parse an unknown value as RunsListResponse: `{runs: RunSummary[]}`.
 * A bare array is rejected — the Gateway always wraps run listings in an envelope.
 * Invalid items within `runs` are skipped (delegates to parseRunSummaryList).
 */
export function parseRunsListResponse(input: unknown): Result<RunsListResponse, Error> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err(new Error('invalid runs list response shape'))
  }

  const candidate = input as Record<string, unknown>

  if (!Array.isArray(candidate.runs)) {
    return err(new Error('invalid runs list response shape'))
  }

  const parsed = parseRunSummaryList(candidate.runs)
  if (!parsed.success) {
    return err(new Error('invalid runs list response shape'))
  }

  return ok({runs: parsed.data})
}
