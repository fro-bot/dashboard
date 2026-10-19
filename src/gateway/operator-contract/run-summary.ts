/**
 * RunSummary type and parse helpers for the operator contract.
 *
 * Mirrors the gateway's RunSummary from fro-bot/agent.
 * Error messages are fixed strings — never echo or interpolate input.
 * Extra fields are ignored (permissive structural subtyping).
 * Oversized strings are rejected without logging raw values.
 *
 * failureKind: optional operator-safe failure-reason code, populated only
 * for failed runs. Allowlist-gated against OperatorFailureKind — any
 * unrecognized string normalizes to absent rather than rejecting the whole
 * summary (reason codes are a display supplement, never a validity requirement).
 *
 * providerFailureReason: kept only when it is a known wire value, the status is 'failed' and
 * failureKind is 'session-error'. Anything else normalizes to absent.
 *
 * prompt: kept only when it is a string, not empty after trim(), and at most
 * OPERATOR_LAUNCH_PROMPT_MAX_LENGTH UTF-16 units. It is stored exactly as received: no trimming, truncating
 * or sanitizing. Anything else normalizes to absent. The prompt is untrusted text for the consumer to render inertly.
 */

import type {Result} from '../../result.ts'
import type {OperatorProviderFailureReason} from './provider-failure-reason.ts'
import type {OperatorFailureKind} from './run-status.ts'

import {err, ok} from '../../result.ts'
import {OPERATOR_LAUNCH_PROMPT_MAX_LENGTH} from './launch-prompt.ts'
import {isOperatorProviderFailureReason} from './provider-failure-reason.ts'
import {isOperatorFailureKind} from './run-status.ts'

/**
 * The status set a run summary can carry: the five lifecycle values plus the two
 * waiting overlays, which the gateway applies only on a running run. 'blocked' is
 * never carried by a summary.
 */
export type RunSummaryStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting_for_approval' | 'waiting_for_question'

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
  readonly failureKind?: OperatorFailureKind
  /** Why a `session-error` run failed at the provider. Closed enum; see `OperatorRunStatus`. */
  readonly providerFailureReason?: OperatorProviderFailureReason
  /**
   * The operator's launch prompt, as submitted. Present only on runs launched through `POST /operator/runs`;
   * absent on runs from any other surface and on older records. UNTRUSTED text: consumers must render it
   * inertly. Bounded by `OPERATOR_LAUNCH_PROMPT_MAX_LENGTH` (UTF-16 code units); never truncated. Carried on
   * the summary only, never on `OperatorRunStatus`.
   */
  readonly prompt?: string
}

/** Maximum valid unique summaries returned by parseRunSummaryList. Matches browser JS RUN_INDEX_CAP. */
export const RUN_INDEX_CAP = 100

// Practical caps: GitHub run IDs and owner/repo paths are well under 512 chars;
// ISO 8601 dates are at most ~35 chars.
const MAX_ID_LENGTH = 512
const MAX_DATE_LENGTH = 128

/**
 * The summary statuses as a runtime list, so a compile-time check can hold it to
 * `RunSummaryStatus` in both directions. The parser's allowlist is built from it.
 */
export const RUN_SUMMARY_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'waiting_for_approval',
  'waiting_for_question',
] as const

const VALID_RUN_SUMMARY_STATUSES: ReadonlySet<string> = new Set(RUN_SUMMARY_STATUSES)

function isKeptLaunchPrompt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= OPERATOR_LAUNCH_PROMPT_MAX_LENGTH
}

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
  // Capture the raw optional fields before the shape guard narrows input's type.
  const rawOptional: Record<string, unknown> =
    typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const rawFailureKind = rawOptional.failureKind

  if (hasValidRunSummaryShape(input) === false) {
    return err(new Error('invalid run summary shape'))
  }

  // failureKind is optional and allowlist-gated; an unrecognized or absent
  // value normalizes to omitted — it never fails validity of the summary.
  const failureKind: OperatorFailureKind | undefined = isOperatorFailureKind(rawFailureKind)
    ? rawFailureKind
    : undefined

  // providerFailureReason refines a failed session-error run only; elsewhere it is omitted.
  const providerFailureReason: OperatorProviderFailureReason | undefined =
    input.status === 'failed' && failureKind === 'session-error' && isOperatorProviderFailureReason(rawOptional.providerFailureReason)
      ? rawOptional.providerFailureReason
      : undefined

  const prompt = isKeptLaunchPrompt(rawOptional.prompt) ? rawOptional.prompt : undefined

  // Closed DTO — copy only declared fields; never spread input.
  const summary: RunSummary = {
    runId: input.runId,
    repo: input.repo,
    status: input.status,
    createdAt: input.createdAt,
    ...('updatedAt' in input ? {updatedAt: input.updatedAt} : {}),
    ...(failureKind === undefined ? {} : {failureKind}),
    ...(providerFailureReason === undefined ? {} : {providerFailureReason}),
    ...(prompt === undefined ? {} : {prompt}),
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
