/**
 * One wiki save.
 *
 * A save runs the request checks, the gate contract, the page and corrections
 * guards, and the shared gates against a fresh snapshot, then commits as Fro Bot
 * and calls the injected dispatch port. Conflict detection is per page: the
 * page's blob SHA and this page's corrections digest must match what the editor
 * loaded. A head that moves under a save is retried inside the request, within
 * a small bound. The `Fro-Operation-Id` trailer is the only idempotency record.
 *
 * The data client is injected, so the token source behind it (write scope) is
 * decided by the caller. Nothing here names a credential.
 */

import type {CorrectionRecord} from '@fro.bot/wiki-write-core'
import type {GitHubCommit, TreeEntry, WikiDataClient} from './data-client.ts'
import type {GateContractDecision, GateContractVerdict} from './gate-contract.ts'
import type {GateFinding, SaveMark, SaveTransition, TransitionAction} from './gates.ts'
import type {PageCorrection} from './pages.ts'

import {Buffer} from 'node:buffer'
import {randomUUID} from 'node:crypto'
import {parseFrontmatterDocument, reconstructFrontmatter} from '@fro.bot/wiki-write-core'
import {logger} from '../logger.ts'
import {isRefusal, rateLimitOf, RequestNotSentError, WikiDataUnavailableError} from './data-client.ts'
import {classifyGateContract} from './gate-contract.ts'
import {
  applyCorrectionChanges,
  boundFindings,
  readCorrectionsFile,
  runWikiGates,
} from './gates.ts'
import {isRecord, statusOf} from './guards.ts'
import {correctionsDigest, toPageCorrections} from './pages.ts'
import {CORRECTIONS_PATH, parsePageId, resolvePagePath, writableSetFor} from './paths.ts'

export const MAX_BODY_BYTES = 512 * 1024
export const MAX_HEAD_ATTEMPTS = 3
/** Allowance for clock difference between this host and GitHub when listing history. */
export const RECONCILE_SKEW_MS = 60_000
/** The latest time a JavaScript Date can hold, in ms since the epoch. */
export const MAX_DATE_MS = 8.64e15
export const OPERATION_TRAILER = 'Fro-Operation-Id'
export const OPERATOR_TRAILER = 'Fro-Operator'

const MAX_MARKS = 100
const MAX_TRANSITIONS = 100
const MAX_MARK_TEXT_LENGTH = 4096
const MAX_ID_LENGTH = 100
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const BLOB_SHA = /^[\w-]{1,64}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u
const TRANSITION_ACTIONS: readonly TransitionAction[] = ['retire', 'flag', 'reconfirm']

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DispatchResult = {readonly ok: true} | {readonly ok: false}

/** Sends the promotion dispatch. Reports failure as a value and never throws. */
export interface DispatchPort {
  readonly dispatch: () => Promise<DispatchResult>
}

/** The verified session behind a save. */
export interface WriteContext {
  readonly operatorLogin: string
}

export interface WikiSaveRequest {
  readonly operationId: string
  readonly pageId: string
  /** Blob SHA of the page when the editor loaded it. */
  readonly pageBlobSha: string
  /** Digest of this page's corrections entries when the editor loaded them. */
  readonly correctionsBase: string
  readonly body: string
  readonly marks: readonly SaveMark[]
  readonly transitions: readonly SaveTransition[]
}

export type RejectReason =
  | 'invalid-request'
  | 'invalid-session'
  | 'content-too-large'
  | 'mark-unavailable'
  | 'invalid-transition'
  | 'no-change'
  | 'gate'

export type SaveResult =
  | {readonly state: 'saved'; readonly operationId: string; readonly commitSha: string; readonly committedAt: string}
  | {
    readonly state: 'saved-not-promoted'
    readonly operationId: string
    readonly commitSha: string
    readonly committedAt: string
  }
  | {readonly state: 'rejected'; readonly reason: RejectReason; readonly findings?: readonly GateFinding[]}
  | {readonly state: 'conflict'; readonly kind: 'page'; readonly currentBlobSha: string}
  | {readonly state: 'conflict'; readonly kind: 'page-removed'}
  | {
    readonly state: 'conflict'
    readonly kind: 'corrections'
    readonly currentCorrections: readonly PageCorrection[]
    readonly correctionsBase: string
  }
  | {readonly state: 'failed'; readonly operationId: string; readonly retryable: boolean}
  | {readonly state: 'contract-rejected'; readonly kind: 'mismatch' | 'unreadable'; readonly retry: boolean}
  | {readonly state: 'indeterminate'; readonly operationId: string}
  | {readonly state: 'rate-limited'; readonly retryAfterSeconds: number | null}

export type LookupResult =
  | {readonly state: 'found'; readonly commitSha: string; readonly committedAt: string | null}
  | {readonly state: 'missing'}
  | {readonly state: 'unknown'}
  | {readonly state: 'invalid-request'}

export interface LookupInput {
  readonly operationId: string
  readonly pageId: string
  /** When the save started, in ms since epoch. */
  readonly startedAt: number
}

export type SaveClient = Pick<
  WikiDataClient,
  | 'createBlob'
  | 'createCommit'
  | 'createTree'
  | 'getHeadSha'
  | 'getSnapshot'
  | 'listCommitsByPath'
  | 'updateRef'
>

export interface WikiWriteDeps {
  readonly client: SaveClient
  readonly checkContract: () => Promise<GateContractDecision>
  readonly dispatch: DispatchPort
  readonly now?: (() => number) | undefined
  readonly newId?: (() => string) | undefined
}

export interface WikiWriteOperation {
  readonly save: (input: unknown, context: WriteContext) => Promise<SaveResult>
  readonly lookup: (input: LookupInput) => Promise<LookupResult>
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

type ParsedRequest =
  | {readonly ok: true; readonly value: WikiSaveRequest}
  | {readonly ok: false; readonly reason: 'invalid-request' | 'content-too-large'}

const INVALID = {ok: false, reason: 'invalid-request'} as const

function isTransitionAction(value: string): value is TransitionAction {
  return (TRANSITION_ACTIONS as readonly string[]).includes(value)
}

function parseMark(value: unknown, bodyLength: number): SaveMark | null {
  if (!isRecord(value)) return null
  const {text, start, end} = value
  if (typeof text !== 'string' || text === '' || text.length > MAX_MARK_TEXT_LENGTH) return null
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (start < 0 || end <= start || end > bodyLength) return null
  return {text, start, end}
}

function parseTransition(value: unknown): SaveTransition | null {
  if (!isRecord(value)) return null
  const {id, action} = value
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) return null
  if (typeof action !== 'string' || !isTransitionAction(action)) return null
  return {id, action}
}

/** Parse the request into a value that carries only the fields a save uses. */
export function parseSaveRequest(input: unknown): ParsedRequest {
  if (!isRecord(input)) return INVALID
  const {operationId, pageId, pageBlobSha, correctionsBase, body, marks, transitions} = input
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) return INVALID
  if (typeof pageId !== 'string' || parsePageId(pageId) === null) return INVALID
  if (typeof pageBlobSha !== 'string' || !BLOB_SHA.test(pageBlobSha)) return INVALID
  if (typeof correctionsBase !== 'string' || !DIGEST.test(correctionsBase)) return INVALID
  if (typeof body !== 'string') return INVALID
  if (!Array.isArray(marks) || marks.length > MAX_MARKS) return INVALID
  if (!Array.isArray(transitions) || transitions.length > MAX_TRANSITIONS) return INVALID

  // A null from the element parser drops the element, so a shorter result means invalid input.
  const parsedMarks = marks.flatMap((mark: unknown) => parseMark(mark, body.length) ?? [])
  const parsedTransitions = transitions.flatMap((transition: unknown) => parseTransition(transition) ?? [])
  if (parsedMarks.length !== marks.length || parsedTransitions.length !== transitions.length) return INVALID
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return {ok: false, reason: 'content-too-large'}

  return {
    ok: true,
    value: {
      operationId,
      pageId,
      pageBlobSha,
      correctionsBase,
      body,
      marks: parsedMarks,
      transitions: parsedTransitions,
    },
  }
}

// ---------------------------------------------------------------------------
// History lookup
// ---------------------------------------------------------------------------

function hasTrailer(message: string, operationId: string): boolean {
  const escaped = operationId.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
  return new RegExp(`^${OPERATION_TRAILER}: ${escaped}$`, 'mu').test(message)
}

type HistoryMatch =
  | {readonly state: 'found'; readonly commit: GitHubCommit}
  | {readonly state: 'missing'}
  | {readonly state: 'unknown'}

/** Find the commit carrying an operation trailer in the page's and corrections' history. */
async function findOperationCommit(
  client: Pick<SaveClient, 'listCommitsByPath'>,
  paths: readonly string[],
  operationId: string,
  startedAt: number,
): Promise<HistoryMatch> {
  const since = new Date(startedAt - RECONCILE_SKEW_MS).toISOString()
  try {
    const listings = await Promise.all(paths.map(async path => client.listCommitsByPath(path, {since})))
    const commit = listings.flat().find(candidate => hasTrailer(candidate.message, operationId))
    return commit === undefined ? {state: 'missing'} : {state: 'found', commit}
  } catch {
    return {state: 'unknown'}
  }
}

/**
 * Look up a save by operation ID in the page's path-scoped history. Serves the
 * reopen case, where the client lost the response to a save. The page path comes
 * from the ID's syntax, so a page that has since been removed still answers.
 */
export async function lookupOperation(
  client: Pick<SaveClient, 'listCommitsByPath'>,
  input: LookupInput,
): Promise<LookupResult> {
  const page = parsePageId(input.pageId)
  if (
    page === null ||
    !OPERATION_ID.test(input.operationId) ||
    !Number.isSafeInteger(input.startedAt) ||
    input.startedAt < 0 ||
    input.startedAt > MAX_DATE_MS
  ) {
    return {state: 'invalid-request'}
  }
  const pagePath = `knowledge/wiki/${page.type}/${page.name}.md`
  const match = await findOperationCommit(client, [pagePath, CORRECTIONS_PATH], input.operationId, input.startedAt)
  if (match.state !== 'found') return match
  return {state: 'found', commitSha: match.commit.sha, committedAt: match.commit.committedAt ?? null}
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * A ref update whose outcome is unknown: no response, a timeout, or a server error.
 * A request that was never sent, because the token could not be obtained, is known
 * not to have landed.
 */
function isAmbiguous(error: unknown): boolean {
  if (error instanceof RequestNotSentError) return false
  const status = statusOf(error)
  return status === null || status === 408 || status >= 500
}

function pageNodeId(content: string): string | null {
  try {
    const nodeId = parseFrontmatterDocument(content).values.node_id
    return typeof nodeId === 'string' && nodeId !== '' ? nodeId : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

function failureOf(error: unknown, operationId: string): SaveResult {
  const limit = error instanceof WikiDataUnavailableError ? error.rateLimit : rateLimitOf(error)
  if (limit !== null) return {state: 'rate-limited', retryAfterSeconds: limit.retryAfterSeconds}
  // A refused credential or target is a configuration fault; retrying cannot fix it.
  return {state: 'failed', operationId, retryable: !isRefusal(error)}
}

function describeResult(result: SaveResult): Record<string, string> {
  switch (result.state) {
    case 'rejected':
      return {outcome: result.state, reason: result.reason}
    case 'conflict':
    case 'contract-rejected':
      return {outcome: result.state, kind: result.kind}
    case 'saved':
    case 'saved-not-promoted':
    case 'failed':
    case 'indeterminate':
    case 'rate-limited':
      return {outcome: result.state}
  }
}

type Attempt = {readonly kind: 'done'; readonly result: SaveResult} | {readonly kind: 'moved'}

export function createWikiWriteOperation(deps: WikiWriteDeps): WikiWriteOperation {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const {client} = deps

  async function contractVerdict(): Promise<GateContractVerdict> {
    try {
      return classifyGateContract(await deps.checkContract())
    } catch {
      return {ok: false, kind: 'unreadable', retry: true}
    }
  }

  async function runDispatch(): Promise<boolean> {
    try {
      return (await deps.dispatch.dispatch()).ok
    } catch {
      return false
    }
  }

  async function finishSaved(operationId: string, commitSha: string, committedAt: string): Promise<SaveResult> {
    const promoted = await runDispatch()
    return promoted
      ? {state: 'saved', operationId, commitSha, committedAt}
      : {state: 'saved-not-promoted', operationId, commitSha, committedAt}
  }

  async function reconcile(
    request: WikiSaveRequest,
    pagePath: string,
    startedAt: number,
  ): Promise<SaveResult> {
    const match = await findOperationCommit(client, [pagePath, CORRECTIONS_PATH], request.operationId, startedAt)
    if (match.state !== 'found') return {state: 'indeterminate', operationId: request.operationId}
    const committedAt = match.commit.committedAt ?? new Date(now()).toISOString()
    return finishSaved(request.operationId, match.commit.sha, committedAt)
  }

  async function attemptSave(
    request: WikiSaveRequest,
    context: WriteContext,
    startedAt: number,
  ): Promise<Attempt> {
    const done = (result: SaveResult): Attempt => ({kind: 'done', result})
    const reject = (reason: RejectReason, findings?: readonly GateFinding[]): Attempt =>
      done(findings === undefined ? {state: 'rejected', reason} : {state: 'rejected', reason, findings})
    const attemptTime = now()

    let snapshot
    try {
      snapshot = await client.getSnapshot()
    } catch (error) {
      return done(failureOf(error, request.operationId))
    }

    const pagePath = resolvePagePath(request.pageId, new Set(Object.keys(snapshot.fileShas)))
    const current = pagePath === null ? undefined : snapshot.files[pagePath]
    const currentBlobSha = pagePath === null ? undefined : snapshot.fileShas[pagePath]
    if (pagePath === null || current === undefined || currentBlobSha === undefined) {
      return done({state: 'conflict', kind: 'page-removed'})
    }
    if (currentBlobSha !== request.pageBlobSha) return done({state: 'conflict', kind: 'page', currentBlobSha})

    const corrections = readCorrectionsFile(snapshot.files)
    if (corrections === null) {
      const corrupt: GateFinding = {kind: 'corrupt-corrections', path: CORRECTIONS_PATH, message: ''}
      return reject('gate', boundFindings([corrupt], {texts: [], knownIds: new Set()}))
    }

    const nodeId = pageNodeId(current)
    const records: readonly CorrectionRecord[] =
      nodeId === null ? [] : corrections.corrections.filter(record => record.page_node_id === nodeId)
    // Every save carries the digest of this page's entries as the editor loaded them, so a
    // body edit cannot erase a marked span after its record changed or vanished upstream.
    const digest = correctionsDigest(records)
    if (digest !== request.correctionsBase) {
      return done({
        state: 'conflict',
        kind: 'corrections',
        currentCorrections: toPageCorrections(pagePath, current, records),
        correctionsBase: digest,
      })
    }

    let pageContent: string
    try {
      pageContent = reconstructFrontmatter(current, request.body)
    } catch {
      return reject('gate')
    }

    const changes = applyCorrectionChanges(corrections, {
      nodeId,
      marks: request.marks,
      transitions: request.transitions,
      actor: context.operatorLogin,
      recordedAt: new Date(attemptTime).toISOString(),
      newId,
    })
    if (!changes.ok) return reject(changes.reason)
    const correctionsChanged = changes.file !== corrections

    let gated
    try {
      gated = runWikiGates({
        pagePath,
        pageContent,
        files: snapshot.files,
        corrections: changes.file,
        correctionsChanged,
        now: new Date(attemptTime),
      })
    } catch {
      return reject('gate')
    }
    if (!gated.ok) {
      return reject(
        'gate',
        boundFindings(gated.findings, {
          texts: [request.body, ...request.marks.map(mark => mark.text)],
          knownIds: new Set(records.map(record => record.id)),
        }),
      )
    }

    const writable = writableSetFor(pagePath)
    const changed = Object.entries(gated.files).filter(([path, content]) => snapshot.files[path] !== content)
    if (changed.some(([path]) => !writable.has(path))) return reject('gate')
    if (gated.files[pagePath] === current && !correctionsChanged) return reject('no-change')

    const message = [
      `docs(knowledge): manual edit ${pagePath}`,
      '',
      `${OPERATION_TRAILER}: ${request.operationId}`,
      `${OPERATOR_TRAILER}: ${context.operatorLogin}`,
    ].join('\n')

    let commit
    try {
      const entries: TreeEntry[] = []
      for (const [path, content] of changed) entries.push({path, sha: await client.createBlob(content)})
      const treeSha = await client.createTree(snapshot.treeSha, entries)
      // No author or committer: GitHub then attributes the commit to the App and signs it.
      commit = await client.createCommit({treeSha, parentSha: snapshot.headSha, message})
    } catch (error) {
      return done(failureOf(error, request.operationId))
    }

    try {
      await client.updateRef(commit.sha)
    } catch (error) {
      if (rateLimitOf(error) !== null) return done(failureOf(error, request.operationId))
      if (isAmbiguous(error)) return done(await reconcile(request, pagePath, startedAt))
      try {
        if ((await client.getHeadSha()) !== snapshot.headSha) return {kind: 'moved'}
      } catch (headError) {
        return done(failureOf(headError, request.operationId))
      }
      return done(failureOf(error, request.operationId))
    }

    const committedAt = commit.committedAt ?? new Date(now()).toISOString()
    return done(await finishSaved(request.operationId, commit.sha, committedAt))
  }

  async function runSave(
    request: WikiSaveRequest,
    context: WriteContext,
    startedAt: number,
  ): Promise<{result: SaveResult; attempts: number}> {
    const verdict = await contractVerdict()
    if (!verdict.ok) {
      return {result: {state: 'contract-rejected', kind: verdict.kind, retry: verdict.retry}, attempts: 0}
    }
    let attempts = 0
    while (attempts < MAX_HEAD_ATTEMPTS) {
      attempts += 1
      const attempt = await attemptSave(request, context, startedAt)
      if (attempt.kind === 'done') return {result: attempt.result, attempts}
    }
    return {result: {state: 'failed', operationId: request.operationId, retryable: true}, attempts}
  }

  async function save(input: unknown, context: WriteContext): Promise<SaveResult> {
    const startedAt = now()
    const parsed = parseSaveRequest(input)
    if (!parsed.ok) {
      logger.info('Wiki save', {outcome: 'rejected', reason: parsed.reason, attempts: 0})
      return {state: 'rejected', reason: parsed.reason}
    }
    const {value: request} = parsed
    if (!GITHUB_LOGIN.test(context.operatorLogin)) {
      logger.info('Wiki save', {operationId: request.operationId, outcome: 'rejected', reason: 'invalid-session', attempts: 0})
      return {state: 'rejected', reason: 'invalid-session'}
    }

    let result: SaveResult
    let attempts = 0
    try {
      ;({result, attempts} = await runSave(request, context, startedAt))
    } catch {
      result = {state: 'failed', operationId: request.operationId, retryable: true}
    }

    const log = result.state === 'failed' || result.state === 'indeterminate' ? logger.warning : logger.info
    log('Wiki save', {operationId: request.operationId, ...describeResult(result), attempts})
    return result
  }

  async function lookup(input: LookupInput): Promise<LookupResult> {
    return lookupOperation(client, input)
  }

  return {save, lookup}
}
