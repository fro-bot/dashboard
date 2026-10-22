/**
 * Client for the `/api/wiki` routes.
 *
 * Every call makes one request and returns a `WikiResult`; nothing is retried here. Every
 * response is checked by a strict validator, and a shape or state the client does not know
 * is `contract-drift`. The client switches on the body `state`, and each state must arrive
 * on its expected status.
 *
 * Session loss: the dashboard middleware answers a dead session with a redirect, so a
 * request that follows no redirect (`redirect: 'manual'`) and gets one back means the
 * session is lost. A save that loses its session, its network or its time budget is
 * `status-unknown`, because the commit may have landed.
 *
 * Rate limit: lookups share the server's per-operator budget (10 a minute) with saves. This
 * module never polls a lookup. A caller that polls must stay inside that budget.
 *
 * A save with `contract-drift` may also have landed, so `saveWikiPage` reports it as
 * `status-unknown` with cause `contract-drift`. The caller's stored pending operation is
 * what resolves it.
 */

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export const WIKI_PAGE_TYPES = ['repos', 'topics', 'entities', 'comparisons'] as const
export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number]

export interface WikiPageSummary {
  readonly id: string
  readonly title: string
  readonly type: WikiPageType
  readonly updated: string | null
  readonly canMark: boolean
}

export interface WikiPageList {
  readonly headSha: string
  readonly pages: readonly WikiPageSummary[]
  readonly canWrite: boolean
  readonly canWriteReason: string | null
}

export type CorrectionStatus = 'active' | 'superseded' | 'retired' | 'needs-reconfirmation'

export interface WikiCorrection {
  readonly id: string
  readonly status: CorrectionStatus
  readonly span: {readonly text: string; readonly start?: number; readonly end?: number}
  readonly attribution: {readonly actor: string; readonly recordedAt: string} | null
  readonly reason: string | null
  readonly supersededBy: string | null
  readonly stale: boolean
}

export type GateContractVerdict =
  | {readonly ok: true}
  | {readonly ok: false; readonly kind: 'mismatch'; readonly retry: false}
  | {readonly ok: false; readonly kind: 'unreadable'; readonly retry: true}

export interface WikiPage {
  readonly id: string
  readonly type: WikiPageType
  readonly title: string
  readonly updated: string | null
  readonly body: string
  readonly pageBlobSha: string
  readonly nodeId: string | null
  readonly canMark: boolean
  readonly corrections: readonly WikiCorrection[]
  readonly correctionsBase: string
  readonly headSha: string
  readonly contract: GateContractVerdict
  readonly canWrite: boolean
  readonly canWriteReason: string | null
}

export interface SaveMark {
  readonly text: string
  readonly start: number
  readonly end: number
}

export interface SaveTransition {
  readonly id: string
  readonly action: 'retire' | 'flag' | 'reconfirm'
}

export interface GateFinding {
  readonly kind: string
  readonly path: string
  readonly message: string
  readonly target?: string
}

export type RejectReason =
  | 'invalid-request'
  | 'invalid-session'
  | 'content-too-large'
  | 'mark-unavailable'
  | 'invalid-transition'
  | 'no-change'
  | 'gate'

export interface SaveInput {
  readonly pageId: string
  /** Minted by the caller with `crypto.randomUUID()`, and stored as pending before this call. */
  readonly operationId: string
  readonly pageBlobSha: string
  readonly correctionsBase: string
  readonly body: string
  readonly marks?: readonly SaveMark[]
  readonly transitions?: readonly SaveTransition[]
}

export interface SavedCommit {
  readonly state: 'saved' | 'saved-not-promoted'
  readonly operationId: string
  readonly commitSha: string
  readonly committedAt: string
}

export type SaveConflict =
  | {readonly kind: 'page'; readonly currentBlobSha: string}
  | {readonly kind: 'page-removed'}
  | {
    readonly kind: 'corrections'
    readonly currentCorrections: readonly WikiCorrection[]
    readonly correctionsBase: string
  }

export type LookupOutcome =
  | {readonly state: 'found'; readonly commitSha: string; readonly committedAt: string | null}
  | {readonly state: 'missing'}
  | {readonly state: 'unknown'}

export interface PromotionPr {
  readonly number: number
  readonly url: string
}

export type BlockReason =
  | 'private-page'
  | 'private-repo-name'
  | 'promotion-diff'
  | 'privacy-check'
  | 'merge'
  | 'open-pr'
  | 'unknown'

export type PromotionStatus =
  | {readonly state: 'pending'; readonly pr: PromotionPr | null}
  | {readonly state: 'settled'; readonly pr: PromotionPr | null}
  | {
    readonly state: 'blocked'
    readonly reason: BlockReason
    readonly runUrl: string
    readonly pr: PromotionPr | null
  }

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Failures every call can report, whatever the route. */
export type TransportError =
  | {readonly kind: 'session-lost'}
  | {readonly kind: 'network'}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'rate-limited'; readonly retryAfterSeconds: number | null}
  | {readonly kind: 'contract-drift'}

export type WikiResult<V, E> =
  | {readonly ok: true; readonly value: V}
  | {readonly ok: false; readonly error: E | TransportError}

export type ReadFailureKind = 'not-found' | 'page-invalid' | 'corrections-corrupt' | 'unavailable' | 'forbidden'
export type ReadError = {readonly kind: ReadFailureKind}

export type SaveError =
  | {readonly kind: 'rejected'; readonly reason: RejectReason; readonly findings: readonly GateFinding[]}
  | {readonly kind: 'conflict'; readonly conflict: SaveConflict}
  | {readonly kind: 'failed'; readonly operationId: string; readonly retryable: boolean}
  | {readonly kind: 'contract-rejected'; readonly reason: 'mismatch' | 'unreadable'; readonly retry: boolean}
  /** The commit may or may not have landed. The caller must not retry; it asks for a lookup. */
  | {
    readonly kind: 'status-unknown'
    readonly cause: 'indeterminate' | 'session-lost' | 'network' | 'timeout' | 'contract-drift'
  }
  | {
    readonly kind: 'forbidden' | 'not-found' | 'bad-request' | 'unsupported-media-type' | 'payload-too-large'
  }

export type LookupError = {readonly kind: 'invalid-request' | 'forbidden'}
export type DispatchError = {
  readonly kind: 'dispatch-failed' | 'forbidden' | 'bad-request' | 'unsupported-media-type' | 'payload-too-large'
}
export type StatusError = {readonly kind: 'unavailable' | 'configuration-fault' | 'bad-request' | 'forbidden'}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const BASE = '/api/wiki'
/** Reads and the dispatch retry. Longer than the server's 30 s GitHub budget per request. */
const REQUEST_TIMEOUT_MS = 45_000
/**
 * A save can spend several GitHub round trips, each with a 30 s budget, so the client waits
 * well past one budget before it calls the result unknown.
 */
export const SAVE_TIMEOUT_MS = 90_000

type Raw =
  | {readonly kind: 'response'; readonly status: number; readonly body: unknown; readonly retryAfter: number | null}
  | {readonly kind: 'session-lost' | 'network' | 'timeout'}

interface RequestOptions {
  readonly method: 'GET' | 'POST'
  readonly json?: string
  readonly timeoutMs: number
}

function parseSeconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value === 'string' && /^\d{1,9}$/u.test(value)) return Number(value)
  return null
}

async function request(path: string, options: RequestOptions): Promise<Raw> {
  const signal = AbortSignal.timeout(options.timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: options.method,
      credentials: 'same-origin',
      redirect: 'manual',
      signal,
      ...(options.json === undefined
        ? {}
        : {headers: {'Content-Type': 'application/json'}, body: options.json}),
    })

    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return {kind: 'session-lost'}

    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    return {kind: 'response', status: res.status, body, retryAfter: parseSeconds(res.headers.get('retry-after'))}
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof DOMException && error.name === 'TimeoutError')
    return {kind: timedOut ? 'timeout' : 'network'}
  }
}

type Interpreted<V, E> = {readonly ok: true; readonly value: V} | {readonly ok: false; readonly error: E}

/** Shared handling for the statuses that mean the same thing on every route. */
function settle<V, E>(
  raw: Raw,
  interpret: (status: number, body: unknown) => Interpreted<V, E> | null,
): WikiResult<V, E> {
  if (raw.kind !== 'response') return {ok: false, error: {kind: raw.kind}}
  if (raw.status === 401) return {ok: false, error: {kind: 'session-lost'}}
  if (raw.status === 429) {
    return {ok: false, error: {kind: 'rate-limited', retryAfterSeconds: rateLimitSeconds(raw)}}
  }
  return interpret(raw.status, raw.body) ?? {ok: false, error: {kind: 'contract-drift'}}
}

function rateLimitSeconds(raw: Extract<Raw, {kind: 'response'}>): number | null {
  if (isRecord(raw.body)) {
    const fromBody = parseSeconds(raw.body.retryAfterSeconds)
    if (fromBody !== null) return fromBody
  }
  return raw.retryAfter
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isPageType(value: unknown): value is WikiPageType {
  return (WIKI_PAGE_TYPES as readonly unknown[]).includes(value)
}

function parseArray<T>(value: unknown, parseItem: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const items: T[] = []
  for (const item of value as unknown[]) {
    const parsed = parseItem(item)
    if (parsed === null) return null
    items.push(parsed)
  }
  return items
}

function parsePageSummary(value: unknown): WikiPageSummary | null {
  if (!isRecord(value)) return null
  const {id, title, type, updated, canMark} = value
  if (!isNonEmptyString(id) || !isString(title) || !isPageType(type)) return null
  if (!isStringOrNull(updated) || typeof canMark !== 'boolean') return null
  return {id, title, type, updated, canMark}
}

const CORRECTION_STATUSES: readonly unknown[] = ['active', 'superseded', 'retired', 'needs-reconfirmation']

function isCorrectionStatus(value: unknown): value is CorrectionStatus {
  return CORRECTION_STATUSES.includes(value)
}

function parseSpan(value: unknown): WikiCorrection['span'] | null {
  if (!isRecord(value) || !isString(value.text)) return null
  const {text, start, end} = value
  if (start !== undefined && typeof start !== 'number') return null
  if (end !== undefined && typeof end !== 'number') return null
  return {
    text,
    ...(typeof start === 'number' ? {start} : {}),
    ...(typeof end === 'number' ? {end} : {}),
  }
}

/** Parse one correction as the read model sends it. The draft store reuses this for its corrections base. */
export function parseWikiCorrection(value: unknown): WikiCorrection | null {
  if (!isRecord(value)) return null
  const {id, status, span, attribution, reason, supersededBy, stale} = value
  if (!isNonEmptyString(id) || !isCorrectionStatus(status) || typeof stale !== 'boolean') return null
  if (!isStringOrNull(reason) || !isStringOrNull(supersededBy)) return null

  const parsedSpan = parseSpan(span)
  if (parsedSpan === null) return null

  let parsedAttribution: WikiCorrection['attribution'] = null
  if (attribution !== null) {
    if (!isRecord(attribution) || !isString(attribution.actor) || !isString(attribution.recordedAt)) return null
    parsedAttribution = {actor: attribution.actor, recordedAt: attribution.recordedAt}
  }
  return {id, status, span: parsedSpan, attribution: parsedAttribution, reason, supersededBy, stale}
}

function parseContract(value: unknown): GateContractVerdict | null {
  if (!isRecord(value)) return null
  if (value.ok === true) return {ok: true}
  if (value.ok !== false) return null
  if (value.kind === 'mismatch' && value.retry === false) return {ok: false, kind: 'mismatch', retry: false}
  if (value.kind === 'unreadable' && value.retry === true) return {ok: false, kind: 'unreadable', retry: true}
  return null
}

function parseList(value: unknown): WikiPageList | null {
  if (!isRecord(value)) return null
  const {headSha, pages, canWrite, canWriteReason} = value
  if (!isNonEmptyString(headSha) || typeof canWrite !== 'boolean' || !isStringOrNull(canWriteReason)) return null
  const parsedPages = parseArray(pages, parsePageSummary)
  return parsedPages === null ? null : {headSha, pages: parsedPages, canWrite, canWriteReason}
}

function parsePage(value: unknown): WikiPage | null {
  if (!isRecord(value)) return null
  const {id, type, title, updated, body, pageBlobSha, nodeId, canMark, correctionsBase, headSha, canWrite} = value
  if (!isNonEmptyString(id) || !isPageType(type) || !isString(title) || !isStringOrNull(updated)) return null
  if (!isString(body) || !isNonEmptyString(pageBlobSha) || !isStringOrNull(nodeId)) return null
  if (typeof canMark !== 'boolean' || !isNonEmptyString(correctionsBase) || !isNonEmptyString(headSha)) return null
  if (typeof canWrite !== 'boolean' || !isStringOrNull(value.canWriteReason)) return null

  const corrections = parseArray(value.corrections, parseWikiCorrection)
  const contract = parseContract(value.contract)
  if (corrections === null || contract === null) return null

  return {
    id,
    type,
    title,
    updated,
    body,
    pageBlobSha,
    nodeId,
    canMark,
    corrections,
    correctionsBase,
    headSha,
    contract,
    canWrite,
    canWriteReason: value.canWriteReason,
  }
}

function parseFinding(value: unknown): GateFinding | null {
  if (!isRecord(value)) return null
  const {kind, path, message, target} = value
  if (!isString(kind) || !isString(path) || !isString(message)) return null
  if (target !== undefined && !isString(target)) return null
  return {kind, path, message, ...(target === undefined ? {} : {target})}
}

const REJECT_REASONS: readonly unknown[] = [
  'invalid-request',
  'invalid-session',
  'content-too-large',
  'mark-unavailable',
  'invalid-transition',
  'no-change',
  'gate',
]

function isRejectReason(value: unknown): value is RejectReason {
  return REJECT_REASONS.includes(value)
}

const BLOCK_REASONS: readonly unknown[] = [
  'private-page',
  'private-repo-name',
  'promotion-diff',
  'privacy-check',
  'merge',
  'open-pr',
  'unknown',
]

function isBlockReason(value: unknown): value is BlockReason {
  return BLOCK_REASONS.includes(value)
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://')
}

function parsePr(value: unknown): PromotionPr | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const {number, url} = value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || !isHttpsUrl(url)) return undefined
  return {number, url}
}

function stateOf(body: unknown): string | null {
  return isRecord(body) && typeof body.state === 'string' ? body.state : null
}

/** Pair a failure state with its status. A known state on another status is drift. */
function failureKind<K extends string>(status: number, body: unknown, table: Readonly<Record<K, number>>): K | null {
  const state = stateOf(body)
  if (state === null || !Object.hasOwn(table, state)) return null
  return table[state as K] === status ? (state as K) : null
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const READ_FAILURE_STATUS: Readonly<Record<ReadFailureKind, number>> = {
  'not-found': 404,
  'page-invalid': 502,
  'corrections-corrupt': 502,
  unavailable: 503,
  forbidden: 403,
}

function interpretRead<V>(parse: (body: unknown) => V | null) {
  return (status: number, body: unknown): Interpreted<V, ReadError> | null => {
    if (status === 200) {
      const value = parse(body)
      return value === null ? null : {ok: true, value}
    }
    const kind = failureKind(status, body, READ_FAILURE_STATUS)
    return kind === null ? null : {ok: false, error: {kind}}
  }
}

export async function listWikiPages(): Promise<WikiResult<WikiPageList, ReadError>> {
  return settle(await request('/pages', {method: 'GET', timeoutMs: REQUEST_TIMEOUT_MS}), interpretRead(parseList))
}

export async function getWikiPage(pageId: string): Promise<WikiResult<WikiPage, ReadError>> {
  const raw = await request(`/pages/${encodeURIComponent(pageId)}`, {method: 'GET', timeoutMs: REQUEST_TIMEOUT_MS})
  return settle(raw, interpretRead(parsePage))
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function parseSaved(body: unknown, state: SavedCommit['state']): SavedCommit | null {
  if (!isRecord(body)) return null
  const {operationId, commitSha, committedAt} = body
  if (!isNonEmptyString(operationId) || !isNonEmptyString(commitSha) || !isNonEmptyString(committedAt)) return null
  return {state, operationId, commitSha, committedAt}
}

function parseConflict(body: Record<string, unknown>): SaveConflict | null {
  if (body.kind === 'page') {
    return isNonEmptyString(body.currentBlobSha) ? {kind: 'page', currentBlobSha: body.currentBlobSha} : null
  }
  if (body.kind === 'page-removed') return {kind: 'page-removed'}
  if (body.kind === 'corrections') {
    const currentCorrections = parseArray(body.currentCorrections, parseWikiCorrection)
    if (currentCorrections === null || !isNonEmptyString(body.correctionsBase)) return null
    return {kind: 'corrections', currentCorrections, correctionsBase: body.correctionsBase}
  }
  return null
}

const SAVE_REFUSAL_STATUS = {
  forbidden: 403,
  'not-found': 404,
  'bad-request': 400,
  'unsupported-media-type': 415,
  'payload-too-large': 413,
} as const

function interpretSave(status: number, body: unknown): Interpreted<SavedCommit, SaveError> | null {
  const state = stateOf(body)
  if (!isRecord(body) || state === null) return null

  if (state === 'saved' && status === 200) {
    const saved = parseSaved(body, 'saved')
    return saved === null ? null : {ok: true, value: saved}
  }
  if (state === 'saved-not-promoted' && status === 202) {
    const saved = parseSaved(body, 'saved-not-promoted')
    return saved === null ? null : {ok: true, value: saved}
  }
  if (state === 'rejected' && status === 422) {
    const findings = body.findings === undefined ? [] : parseArray(body.findings, parseFinding)
    if (!isRejectReason(body.reason) || findings === null) return null
    return {ok: false, error: {kind: 'rejected', reason: body.reason, findings}}
  }
  if (state === 'conflict' && status === 409) {
    const conflict = parseConflict(body)
    return conflict === null ? null : {ok: false, error: {kind: 'conflict', conflict}}
  }
  if (state === 'failed' && status === 502) {
    if (!isNonEmptyString(body.operationId) || typeof body.retryable !== 'boolean') return null
    return {ok: false, error: {kind: 'failed', operationId: body.operationId, retryable: body.retryable}}
  }
  if (state === 'contract-rejected' && status === 424) {
    if (body.kind === 'mismatch' && body.retry === false) {
      return {ok: false, error: {kind: 'contract-rejected', reason: 'mismatch', retry: false}}
    }
    if (body.kind === 'unreadable' && body.retry === true) {
      return {ok: false, error: {kind: 'contract-rejected', reason: 'unreadable', retry: true}}
    }
    return null
  }
  if (state === 'indeterminate' && status === 504) {
    return isNonEmptyString(body.operationId)
      ? {ok: false, error: {kind: 'status-unknown', cause: 'indeterminate'}}
      : null
  }

  const refusal = failureKind(status, body, SAVE_REFUSAL_STATUS)
  return refusal === null ? null : {ok: false, error: {kind: refusal}}
}

/**
 * Save a page. Never retries. A lost session, a network error, a timeout or a reply the
 * client cannot read (`contract-drift`) comes back as `status-unknown`, because the commit
 * may have landed. Store the pending operation first
 * (see `sendWithPendingOperation`).
 */
export async function saveWikiPage(input: SaveInput): Promise<WikiResult<SavedCommit, SaveError>> {
  const json = JSON.stringify({
    operationId: input.operationId,
    pageBlobSha: input.pageBlobSha,
    correctionsBase: input.correctionsBase,
    body: input.body,
    marks: input.marks ?? [],
    transitions: input.transitions ?? [],
  })
  const raw = await request(`/pages/${encodeURIComponent(input.pageId)}/save`, {
    method: 'POST',
    json,
    timeoutMs: SAVE_TIMEOUT_MS,
  })

  const result = settle(raw, interpretSave)
  if (result.ok) return result
  switch (result.error.kind) {
    case 'session-lost':
    case 'network':
    case 'timeout':
    case 'contract-drift':
      return {ok: false, error: {kind: 'status-unknown', cause: result.error.kind}}
    default:
      return result
  }
}

// ---------------------------------------------------------------------------
// Dispatch, lookup, promotion status
// ---------------------------------------------------------------------------

const DISPATCH_FAILURE_STATUS = {
  'dispatch-failed': 502,
  forbidden: 403,
  'bad-request': 400,
  'unsupported-media-type': 415,
  'payload-too-large': 413,
} as const

/** Send only the promotion dispatch. No new commit. */
export async function retryPromotionDispatch(): Promise<
  WikiResult<{readonly state: 'dispatched'}, DispatchError>
> {
  const raw = await request('/promotion/dispatch', {method: 'POST', json: '{}', timeoutMs: REQUEST_TIMEOUT_MS})
  return settle(raw, (status, body): Interpreted<{readonly state: 'dispatched'}, DispatchError> | null => {
    if (status === 200) return stateOf(body) === 'dispatched' ? {ok: true, value: {state: 'dispatched'}} : null
    const kind = failureKind(status, body, DISPATCH_FAILURE_STATUS)
    return kind === null ? null : {ok: false, error: {kind}}
  })
}

export interface LookupInput {
  readonly operationId: string
  readonly pageId: string
  /** The pending operation's send time, in ms since the epoch. */
  readonly startedAt: number
}

/**
 * Ask the server to find an operation in path-scoped history. One request per call: lookups
 * share the per-operator budget with saves.
 */
export async function lookupWikiOperation(input: LookupInput): Promise<WikiResult<LookupOutcome, LookupError>> {
  const query = new URLSearchParams({pageId: input.pageId, startedAt: String(input.startedAt)})
  const raw = await request(`/operations/${encodeURIComponent(input.operationId)}?${query.toString()}`, {
    method: 'GET',
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  return settle(raw, (status, body): Interpreted<LookupOutcome, LookupError> | null => {
    const state = stateOf(body)
    if (status === 200 && isRecord(body)) {
      if (state === 'missing') return {ok: true, value: {state: 'missing'}}
      if (state === 'unknown') return {ok: true, value: {state: 'unknown'}}
      if (state === 'found') {
        const {commitSha, committedAt} = body
        if (!isNonEmptyString(commitSha) || !isStringOrNull(committedAt)) return null
        return {ok: true, value: {state: 'found', commitSha, committedAt}}
      }
      return null
    }
    if (status === 400 && state === 'invalid-request') return {ok: false, error: {kind: 'invalid-request'}}
    if (status === 403 && state === 'forbidden') return {ok: false, error: {kind: 'forbidden'}}
    return null
  })
}

const STATUS_FAILURE_STATUS = {
  unavailable: 503,
  'configuration-fault': 502,
  'bad-request': 400,
  forbidden: 403,
} as const

function parsePromotionStatus(body: unknown): PromotionStatus | null {
  if (!isRecord(body)) return null
  const pr = parsePr(body.pr)
  if (pr === undefined) return null
  if (body.state === 'pending') return {state: 'pending', pr}
  if (body.state === 'settled') return {state: 'settled', pr}
  if (body.state === 'blocked') {
    if (!isBlockReason(body.reason) || !isHttpsUrl(body.runUrl)) return null
    return {state: 'blocked', reason: body.reason, runUrl: body.runUrl, pr}
  }
  return null
}

/** Branch-level promotion status. `since` ignores runs created before that time. */
export async function promotionStatus(since?: string): Promise<WikiResult<PromotionStatus, StatusError>> {
  const query = since === undefined ? '' : `?${new URLSearchParams({since}).toString()}`
  const raw = await request(`/promotion/status${query}`, {method: 'GET', timeoutMs: REQUEST_TIMEOUT_MS})
  return settle(raw, (status, body): Interpreted<PromotionStatus, StatusError> | null => {
    if (status === 200) {
      const parsed = parsePromotionStatus(body)
      return parsed === null ? null : {ok: true, value: parsed}
    }
    const kind = failureKind(status, body, STATUS_FAILURE_STATUS)
    return kind === null ? null : {ok: false, error: {kind}}
  })
}
