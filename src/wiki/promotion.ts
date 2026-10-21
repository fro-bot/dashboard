/**
 * Promotion: the dispatch port and branch-level promotion status.
 *
 * A save is promoted by a `promote-data` repository dispatch. Whether that
 * promotion is pending, settled, or blocked is read from GitHub: the open PR from
 * `data` into `main` and the newest run of the `merge-data` workflow. The privacy
 * checks run as steps inside that run, so a blocked promotion is a failed run.
 *
 * The data client is injected, so the token source behind it (write scope) is the
 * caller's choice. Responses carry only states, coarse step reasons, and links
 * built from IDs. Logs carry status codes and no GitHub text.
 */

import type {PromotionPull, PromotionRun, RateLimitInfo, RunJob, WikiDataClient} from './data-client.ts'

import {logger} from '../logger.ts'
import {isRefusal, rateLimitOf} from './data-client.ts'
import {statusOf} from './guards.ts'
import {WIKI_REPOSITORY} from './paths.ts'

/** Shorter than the client's 15 s poll, so each poll reads fresh while bursts coalesce. */
export const PROMOTION_CACHE_TTL_MS = 10_000
export const PROMOTION_CACHE_MAX_ENTRIES = 16

const REPOSITORY_URL = `https://github.com/${WIKI_REPOSITORY}`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PromotionClient = Pick<
  WikiDataClient,
  'createPromotionDispatch' | 'getLatestPromotionRun' | 'listPromotionPulls' | 'listRunJobs'
>

export type BlockReason =
  | 'private-page'
  | 'private-repo-name'
  | 'promotion-diff'
  | 'privacy-check'
  | 'merge'
  | 'open-pr'
  | 'unknown'

export interface PromotionPr {
  readonly number: number
  readonly url: string
}

export type PromotionStatus =
  | {readonly state: 'pending'; readonly pr: PromotionPr | null}
  | {readonly state: 'settled'; readonly pr: PromotionPr | null}
  | {
    readonly state: 'blocked'
    readonly reason: BlockReason
    readonly runUrl: string
    readonly pr: PromotionPr | null
  }
  | {readonly state: 'unavailable'}
  | {readonly state: 'configuration-fault'}

export type PromotionDispatchResult =
  | {readonly ok: true}
  | {readonly ok: false; readonly rateLimit: RateLimitInfo | null}

export interface PromotionStatusReader {
  /** Status of the `data` promotion. `since` ignores runs created before that time. */
  readonly getStatus: (since?: string) => Promise<PromotionStatus>
  readonly cacheSize: () => number
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A rate limit is transient. A refusal (401, 403, 404) is a configuration fault
 * that retrying cannot fix. Everything else, including a timeout, a network
 * failure, a server error, or an unexpected response, is transient.
 */
function classify(error: unknown): {readonly fault: boolean; readonly status: number | null} {
  return {fault: isRefusal(error), status: statusOf(error)}
}

// ---------------------------------------------------------------------------
// Dispatch port
// ---------------------------------------------------------------------------

/**
 * The dispatch port U3 calls after a commit. It sends `promote-data` with no
 * payload and reports any failure as a value. Retrying a dispatch calls it again;
 * it commits nothing and makes no request of its own to recover.
 */
export function createDispatchPort(deps: {readonly client: PromotionClient}): {
  readonly dispatch: () => Promise<PromotionDispatchResult>
} {
  async function dispatch(): Promise<PromotionDispatchResult> {
    try {
      await deps.client.createPromotionDispatch()
      return {ok: true}
    } catch (error) {
      const {fault, status} = classify(error)
      if (fault) logger.error('Wiki promotion dispatch refused', {status})
      else logger.warning('Wiki promotion dispatch failed', {status})
      return {ok: false, rateLimit: rateLimitOf(error)}
    }
  }
  return {dispatch}
}

// ---------------------------------------------------------------------------
// Step reasons
// ---------------------------------------------------------------------------

/** Failed step names (without their leading symbol) and the reason each stands for. */
const STEP_REASONS: ReadonlyMap<string, BlockReason> = new Map([
  ['block private wiki pages', 'private-page'],
  ['block private repo names in promotion diff', 'private-repo-name'],
  ['fetch data ref for promotion diff', 'promotion-diff'],
  ['fetch data branch for privacy check', 'privacy-check'],
  ['merge main into data', 'merge'],
  ['open data merge pr', 'open-pr'],
])

function normalizeStepName(name: string): string {
  return name
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
}

/** Coarse reason for a failed step. A leading symbol is ignored; unknown names are `unknown`. */
export function reasonForStep(name: string): BlockReason {
  return STEP_REASONS.get(normalizeStepName(name)) ?? 'unknown'
}

function isFailure(conclusion: string | null): boolean {
  return conclusion === 'failure' || conclusion === 'timed_out'
}

function reasonForJobs(jobs: readonly RunJob[]): BlockReason {
  const job = jobs.find(candidate => isFailure(candidate.conclusion))
  const step = job?.steps.find(candidate => isFailure(candidate.conclusion))
  return step === undefined ? 'unknown' : reasonForStep(step.name)
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function prLink(pulls: readonly PromotionPull[]): PromotionPr | null {
  const first = pulls[0]
  return first === undefined ? null : {number: first.number, url: `${REPOSITORY_URL}/pull/${first.number}`}
}

function runLink(run: PromotionRun): string {
  return `${REPOSITORY_URL}/actions/runs/${run.id}`
}

type RunState = 'pending' | 'settled' | 'blocked'

const SETTLED_CONCLUSIONS: ReadonlySet<string | null> = new Set(['success', 'neutral', 'skipped'])
const BLOCKED_CONCLUSIONS: ReadonlySet<string | null> = new Set(['failure', 'timed_out', 'startup_failure'])

/** In progress, cancelled, or awaiting approval is pending; success is settled; failure is blocked. */
function stateOfRun(run: PromotionRun): RunState {
  if (run.status !== 'completed') return 'pending'
  if (SETTLED_CONCLUSIONS.has(run.conclusion)) return 'settled'
  return BLOCKED_CONCLUSIONS.has(run.conclusion) ? 'blocked' : 'pending'
}

function failureStatus(errors: readonly unknown[]): PromotionStatus {
  const classified = errors.map(classify)
  const refused = classified.find(entry => entry.fault)
  if (refused !== undefined) {
    logger.error('Wiki promotion status refused', {status: refused.status})
    return {state: 'configuration-fault'}
  }
  logger.warning('Wiki promotion status unavailable', {status: classified[0]?.status ?? null})
  return {state: 'unavailable'}
}

function parseSince(since: string | undefined): number | null {
  if (since === undefined) return null
  const parsed = Date.parse(since)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Reads promotion status. A read costs at most three requests: the open-PR list,
 * the newest run, and that run's jobs when it failed. Results, including
 * failures, are cached per `since` for a short time and shared by concurrent
 * reads. The cache is bounded and per reader.
 */
export function createPromotionStatusReader(deps: {
  readonly client: PromotionClient
  readonly now?: (() => number) | undefined
}): PromotionStatusReader {
  const now = deps.now ?? Date.now
  const cache = new Map<string, {readonly storedAt: number; readonly status: Promise<PromotionStatus>}>()

  async function compute(sinceMs: number | null): Promise<PromotionStatus> {
    const [pulls, latest] = await Promise.allSettled([
      deps.client.listPromotionPulls(),
      deps.client.getLatestPromotionRun(),
    ])
    if (pulls.status === 'rejected' || latest.status === 'rejected') {
      const reasons: unknown[] = []
      for (const result of [pulls, latest]) if (result.status === 'rejected') reasons.push(result.reason)
      return failureStatus(reasons)
    }

    const pr = prLink(pulls.value)
    const run = latest.value
    if (run === null) return {state: 'pending', pr}
    if (sinceMs !== null && Date.parse(run.createdAt) < sinceMs) return {state: 'pending', pr}

    const state = stateOfRun(run)
    if (state !== 'blocked') return {state, pr}

    try {
      return {state: 'blocked', reason: reasonForJobs(await deps.client.listRunJobs(run.id)), runUrl: runLink(run), pr}
    } catch (error) {
      if (classify(error).fault) return failureStatus([error])
      return {state: 'blocked', reason: 'unknown', runUrl: runLink(run), pr}
    }
  }

  async function getStatus(since?: string): Promise<PromotionStatus> {
    const sinceMs = parseSince(since)
    const key = sinceMs === null ? '' : String(sinceMs)
    const current = now()

    const cached = cache.get(key)
    if (cached !== undefined && current - cached.storedAt < PROMOTION_CACHE_TTL_MS) return cached.status

    const status = compute(sinceMs).catch((): PromotionStatus => ({state: 'unavailable'}))
    cache.delete(key)
    cache.set(key, {storedAt: current, status})
    for (const oldest of cache.keys()) {
      if (cache.size <= PROMOTION_CACHE_MAX_ENTRIES) break
      cache.delete(oldest)
    }
    return status
  }

  return {getStatus, cacheSize: () => cache.size}
}
