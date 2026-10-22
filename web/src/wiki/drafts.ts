/**
 * Draft store: unsaved wiki edits, kept on this device in raw IndexedDB.
 *
 * Drafts never leave the device and survive sign-out and session expiry, because a draft
 * is the operator's own unsaved work. One object store holds one record per page ID.
 *
 * The wrapper uses only these IndexedDB operations:
 *   `open` with an upgrade handler that creates the one store and blocked, success and
 *   error handlers, a transaction on that store, and `get`, `put`, `delete` and `getAll`
 *   requests, with success and error handlers on requests and complete, error and abort
 *   handlers on transactions. A connection is closed with `close`, and `onversionchange`
 *   closes it when another tab wants a newer schema.
 * `test-support/memory-idb.ts` implements that list and throws on anything else.
 *
 * No IndexedDB (or a browser that refuses to open it) is `unavailable`: there are no drafts to
 * lose. An open that errors, is blocked or does not answer within `DRAFT_OPEN_TIMEOUT_MS` is
 * `open-failed`, because a record may be there that was never seen. If a blocked or timed-out open
 * succeeds later, that connection is closed.
 *
 * One record per page is shared by every tab. A tab's autosave keeps the pending operation
 * another tab stored (`keepStoredPending`), and a delete can be made conditional (`onlyIf`)
 * so it removes only a record that still belongs to the caller.
 *
 * Failures come back as results and are never thrown. A missing IndexedDB is `unavailable`,
 * a failed, blocked or timed-out open is `open-failed`, and a quota error is `quota`. A record that fails validation is reported
 * as `unreadable` and is never deleted or overwritten unless the caller says so.
 */

import type {WikiCorrection} from '../api/wiki.ts'

import {parseWikiCorrection} from '../api/wiki.ts'
import {parseMarks, type Mark} from './marks.ts'
import {parseStaged, type StagedAction} from './staged.ts'

export const DRAFT_DB_NAME = 'fro-bot-wiki'
export const DRAFT_STORE_NAME = 'drafts'
/**
 * Version 2 adds the draft's marks and staged correction actions. A version 1 record is read as a
 * version 2 record with neither, and becomes version 2 on disk the next time it is written. The
 * IndexedDB database itself is unchanged: both versions live in the same store.
 */
export const DRAFT_SCHEMA_VERSION = 2

const DB_VERSION = 1

/** How long an open may take before the store gives up on it and reports `unavailable`. */
export const DRAFT_OPEN_TIMEOUT_MS = 5_000

/** The corrections as the read model returned them when the page opened, with their digest. */
export interface CorrectionsBase {
  readonly entries: readonly WikiCorrection[]
  readonly digest: string
}

/** A save that has been, or is about to be, sent. `unknown` means no answer was seen. */
export interface PendingOperation {
  readonly operationId: string
  /** When the request was sent, in ms since the epoch. The lookup passes this as `startedAt`. */
  readonly sentAt: number
  readonly bodyChanged: boolean
  readonly state: 'sending' | 'unknown'
}

export interface DraftRecord {
  readonly schemaVersion: typeof DRAFT_SCHEMA_VERSION
  readonly pageId: string
  readonly baseBlobSha: string
  readonly baseText: string
  readonly correctionsBase: CorrectionsBase
  readonly draftText: string
  /** The spans the operator marked as corrections in `draftText`. */
  readonly marks: readonly Mark[]
  /** Correction actions to commit with the next save. */
  readonly staged: readonly StagedAction[]
  readonly updatedAt: number
  readonly pending: PendingOperation | null
}

/**
 * What a caller supplies; the store stamps the schema version and update time. Marks and staged
 * actions default to none.
 */
export type DraftInput = Omit<DraftRecord, 'schemaVersion' | 'updatedAt' | 'marks' | 'staged'> & {
  readonly marks?: readonly Mark[]
  readonly staged?: readonly StagedAction[]
}

export type DraftError =
  | {readonly kind: 'unavailable'}
  /**
   * IndexedDB exists but the open errored, was blocked or timed out. A record may be there that
   * was never seen, so this is not an empty store: draft writes must be withheld. Nothing is open,
   * though, so a save has no pending record to protect.
   */
  | {readonly kind: 'open-failed'}
  | {readonly kind: 'quota'}
  | {readonly kind: 'failed'}
  /** There is no record to update. */
  | {readonly kind: 'missing'}
  /** A record exists but fails validation. `pageId` is null when the record names none. */
  | {readonly kind: 'unreadable'; readonly pageId: string | null}

export type DraftResult<T> = {readonly ok: true; readonly value: T} | {readonly ok: false; readonly error: DraftError}

export interface DraftList {
  readonly drafts: readonly DraftRecord[]
  readonly unreadable: readonly {readonly pageId: string | null}[]
}

export interface PutOptions {
  readonly replaceUnreadable?: boolean
  readonly keepStoredPending?: boolean
}

export interface DeleteOptions {
  readonly onlyIf?: (record: DraftRecord) => boolean
}

export interface DraftStore {
  /** The clock the store stamps with. Pending-operation send times come from it. */
  readonly now: () => number
  readonly getDraft: (pageId: string) => Promise<DraftResult<DraftRecord | null>>
  /**
   * Replace the record for the page. An unreadable record is refused unless `replaceUnreadable`
   * is set. With `keepStoredPending`, an input with no pending operation keeps the one already
   * stored for the page, read in the same transaction.
   */
  readonly putDraft: (input: DraftInput, options?: PutOptions) => Promise<DraftResult<DraftRecord>>
  /**
   * Delete the record for the page. With `onlyIf`, the record is deleted only when it reads and
   * the predicate accepts it. A missing, unreadable or refused record is left alone, and the
   * call still succeeds.
   */
  readonly deleteDraft: (pageId: string, options?: DeleteOptions) => Promise<DraftResult<undefined>>
  /**
   * Delete the record only if it still fails validation. `deleted`: it did, and is gone.
   * `readable`: it reads now (another tab replaced it), so it was left alone. `missing`: there is
   * no record.
   */
  readonly deleteUnreadableDraft: (pageId: string) => Promise<DraftResult<'deleted' | 'readable' | 'missing'>>
  readonly listDrafts: () => Promise<DraftResult<DraftList>>
  readonly markPendingUnknown: (pageId: string) => Promise<DraftResult<DraftRecord>>
  readonly clearPendingOperation: (pageId: string) => Promise<DraftResult<DraftRecord>>
}

export interface DraftStoreOptions {
  /** Defaults to the global `indexedDB`. Pass `undefined` to model a browser without it. */
  readonly indexedDB?: IDBFactory | undefined
  readonly now?: () => number
}

// ---------------------------------------------------------------------------
// Record validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** A whole number of ms that a Date can hold. A pending time becomes a Date for the lookup fallback. */
function isDateMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15
}

function parsePending(value: unknown): PendingOperation | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const {operationId, sentAt, bodyChanged, state} = value
  if (!isNonEmptyString(operationId) || !isDateMs(sentAt)) return undefined
  if (typeof bodyChanged !== 'boolean' || (state !== 'sending' && state !== 'unknown')) return undefined
  return {operationId, sentAt, bodyChanged, state}
}

function parseCorrectionsBase(value: unknown): CorrectionsBase | null {
  if (!isRecord(value) || !isNonEmptyString(value.digest) || !Array.isArray(value.entries)) return null
  const entries: WikiCorrection[] = []
  for (const entry of value.entries as unknown[]) {
    const parsed = parseWikiCorrection(entry)
    if (parsed === null) return null
    entries.push(parsed)
  }
  return {entries, digest: value.digest}
}

/** Marks and staged actions: absent from a version 1 record, required in version 2. */
function parseWork(value: Record<string, unknown>): {marks: Mark[]; staged: StagedAction[]} | null {
  if (value.schemaVersion === 1) return {marks: [], staged: []}
  const marks = parseMarks(value.marks)
  const staged = parseStaged(value.staged)
  return marks === null || staged === null ? null : {marks, staged}
}

function parseRecord(value: unknown): DraftRecord | null {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== DRAFT_SCHEMA_VERSION)) return null
  const {pageId, baseBlobSha, baseText, draftText, updatedAt} = value
  if (!isNonEmptyString(pageId) || !isNonEmptyString(baseBlobSha)) return null
  if (typeof baseText !== 'string' || typeof draftText !== 'string') return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null

  const correctionsBase = parseCorrectionsBase(value.correctionsBase)
  const pending = parsePending(value.pending)
  const work = parseWork(value)
  if (correctionsBase === null || pending === undefined || work === null) return null

  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    pageId,
    baseBlobSha,
    baseText,
    correctionsBase,
    draftText,
    marks: work.marks,
    staged: work.staged,
    updatedAt,
    pending,
  }
}

function pageIdOf(value: unknown): string | null {
  return isRecord(value) && isNonEmptyString(value.pageId) ? value.pageId : null
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

const UNAVAILABLE: DraftResult<never> = {ok: false, error: {kind: 'unavailable'}}
const OPEN_FAILED: DraftResult<never> = {ok: false, error: {kind: 'open-failed'}}
const FAILED: DraftResult<never> = {ok: false, error: {kind: 'failed'}}

function classify(error: {readonly name?: string} | null | undefined): DraftError {
  return error?.name === 'QuotaExceededError' ? {kind: 'quota'} : {kind: 'failed'}
}

function globalFactory(): IDBFactory | undefined {
  try {
    return typeof indexedDB === 'undefined' ? undefined : indexedDB
  } catch {
    // Some browsers throw on access when storage is disabled.
    return undefined
  }
}

type Run = <R>(request: IDBRequest<R>, onResult: (result: R) => void) => void

type Opened = IDBDatabase | 'unavailable' | 'open-failed'

export function createDraftStore(options: DraftStoreOptions = {}): DraftStore {
  const now = options.now ?? Date.now
  const factory = (): IDBFactory | undefined => (Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalFactory())

  let connection: IDBDatabase | null = null
  let opening: Promise<Opened> | null = null

  /**
   * `unavailable`: this browser has no IndexedDB, or refuses it outright, so it holds no drafts.
   * `open-failed`: IndexedDB exists but the open errored, was blocked or timed out, so a record may be
   * there that was never seen. Callers must not treat that as an empty store.
   */
  function openDatabase(): Promise<Opened> {
    return new Promise(resolve => {
      const idb = factory()
      if (idb === undefined) {
        resolve('unavailable')
        return
      }

      let answered = false
      let timer: ReturnType<typeof setTimeout> | undefined
      /** The first answer wins. False means an earlier answer already settled this open. */
      const answer = (db: Opened): boolean => {
        if (answered) return false
        answered = true
        clearTimeout(timer)
        resolve(db)
        return true
      }

      try {
        const request = idb.open(DRAFT_DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
          request.result.createObjectStore(DRAFT_STORE_NAME, {keyPath: 'pageId'})
        }
        request.onsuccess = () => {
          const db = request.result
          if (!answer(db)) {
            // The open was given up on (blocked or timed out) and nothing awaits it. Do not hold the connection.
            db.close()
            return
          }
          // Another tab wants a newer schema: let go, and open again on the next call.
          db.onversionchange = () => {
            db.close()
            if (connection === db) connection = null
          }
        }
        request.onerror = () => {
          answer('open-failed')
        }
        request.onblocked = () => {
          answer('open-failed')
        }
        timer = setTimeout(() => {
          answer('open-failed')
        }, DRAFT_OPEN_TIMEOUT_MS)
      } catch {
        // `open` itself threw: the browser refuses IndexedDB here (storage disabled).
        answer('unavailable')
      }
    })
  }

  /** Reuse one open connection. A failed open is not cached, so a later call tries again. */
  async function connect(): Promise<Opened> {
    if (connection !== null) return connection
    opening ??= openDatabase().then(opened => {
      if (typeof opened !== 'string') connection = opened
      opening = null
      return opened
    })
    return opening
  }

  /**
   * Run one transaction. `body` issues requests through `run` and reports the answer with
   * `settle`. The answer is returned only if the transaction completes; an abort wins.
   */
  async function transact<T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore, run: Run, settle: (result: DraftResult<T>) => void) => void,
  ): Promise<DraftResult<T>> {
    const db = await connect()
    if (db === 'unavailable') return UNAVAILABLE
    if (db === 'open-failed') return OPEN_FAILED

    let tx: IDBTransaction
    try {
      tx = db.transaction(DRAFT_STORE_NAME, mode)
    } catch {
      // The connection went away (storage cleared, browser closed it). Reopen on the next call.
      connection = null
      return UNAVAILABLE
    }

    return new Promise<DraftResult<T>>(resolve => {
      let answer: DraftResult<T> | null = null
      let failure: DraftError | null = null

      tx.oncomplete = () => {
        resolve(answer ?? FAILED)
      }
      tx.onerror = () => {
        failure ??= classify(tx.error)
      }
      tx.onabort = () => {
        resolve({ok: false, error: failure ?? classify(tx.error)})
      }

      const run: Run = (request, onResult) => {
        request.onsuccess = () => {
          onResult(request.result)
        }
        request.onerror = () => {
          failure ??= classify(request.error)
        }
      }

      try {
        body(
          tx.objectStore(DRAFT_STORE_NAME),
          run,
          result => {
            answer = result
          },
        )
      } catch (error) {
        resolve({ok: false, error: classify(error as {name?: string})})
      }
    })
  }

  function fromStored(pageId: string, raw: unknown): DraftResult<DraftRecord | null> {
    if (raw === undefined) return {ok: true, value: null}
    const record = parseRecord(raw)
    return record === null ? {ok: false, error: {kind: 'unreadable', pageId}} : {ok: true, value: record}
  }

  async function getDraft(pageId: string): Promise<DraftResult<DraftRecord | null>> {
    return transact<DraftRecord | null>('readonly', (store, run, settle) => {
      run(store.get(pageId), raw => {
        settle(fromStored(pageId, raw))
      })
    })
  }

  async function putDraft(input: DraftInput, putOptions?: PutOptions): Promise<DraftResult<DraftRecord>> {
    const draft: DraftRecord = {
      ...input,
      marks: input.marks ?? [],
      staged: input.staged ?? [],
      schemaVersion: DRAFT_SCHEMA_VERSION,
      updatedAt: now(),
    }
    return transact<DraftRecord>('readwrite', (store, run, settle) => {
      run(store.get(draft.pageId), existing => {
        const stored = existing === undefined ? null : parseRecord(existing)
        if (existing !== undefined && stored === null && putOptions?.replaceUnreadable !== true) {
          settle({ok: false, error: {kind: 'unreadable', pageId: draft.pageId}})
          return
        }
        const record: DraftRecord =
          putOptions?.keepStoredPending === true && draft.pending === null && stored !== null
            ? {...draft, pending: stored.pending}
            : draft
        run(store.put(record), () => {
          settle({ok: true, value: record})
        })
      })
    })
  }

  async function deleteDraft(pageId: string, deleteOptions?: DeleteOptions): Promise<DraftResult<undefined>> {
    const onlyIf = deleteOptions?.onlyIf
    return transact<undefined>('readwrite', (store, run, settle) => {
      const done = () => {
        settle({ok: true, value: undefined})
      }
      if (onlyIf === undefined) {
        run(store.delete(pageId), done)
        return
      }
      run(store.get(pageId), existing => {
        const stored = existing === undefined ? null : parseRecord(existing)
        if (stored === null || !onlyIf(stored)) {
          done()
          return
        }
        run(store.delete(pageId), done)
      })
    })
  }

  async function deleteUnreadableDraft(pageId: string): Promise<DraftResult<'deleted' | 'readable' | 'missing'>> {
    return transact<'deleted' | 'readable' | 'missing'>('readwrite', (store, run, settle) => {
      run(store.get(pageId), existing => {
        if (existing === undefined) {
          settle({ok: true, value: 'missing'})
          return
        }
        if (parseRecord(existing) !== null) {
          settle({ok: true, value: 'readable'})
          return
        }
        run(store.delete(pageId), () => {
          settle({ok: true, value: 'deleted'})
        })
      })
    })
  }

  async function listDrafts(): Promise<DraftResult<DraftList>> {
    return transact<DraftList>('readonly', (store, run, settle) => {
      run(store.getAll() as IDBRequest<unknown[]>, all => {
        const drafts: DraftRecord[] = []
        const unreadable: {pageId: string | null}[] = []
        for (const raw of all) {
          const record = parseRecord(raw)
          if (record === null) unreadable.push({pageId: pageIdOf(raw)})
          else drafts.push(record)
        }
        settle({ok: true, value: {drafts, unreadable}})
      })
    })
  }

  /** Read, change and write the pending operation in one transaction. */
  async function updatePending(
    pageId: string,
    change: (pending: PendingOperation | null) => PendingOperation | null,
  ): Promise<DraftResult<DraftRecord>> {
    return transact<DraftRecord>('readwrite', (store, run, settle) => {
      run(store.get(pageId), raw => {
        if (raw === undefined) {
          settle({ok: false, error: {kind: 'missing'}})
          return
        }
        const current = parseRecord(raw)
        if (current === null) {
          settle({ok: false, error: {kind: 'unreadable', pageId}})
          return
        }
        const updated: DraftRecord = {...current, pending: change(current.pending)}
        run(store.put(updated), () => {
          settle({ok: true, value: updated})
        })
      })
    })
  }

  return {
    now,
    getDraft,
    putDraft,
    deleteDraft,
    deleteUnreadableDraft,
    listDrafts,
    markPendingUnknown: async pageId =>
      updatePending(pageId, pending => (pending === null ? null : {...pending, state: 'unknown'})),
    clearPendingOperation: async pageId => updatePending(pageId, () => null),
  }
}

// ---------------------------------------------------------------------------
// Pending operation ordering
// ---------------------------------------------------------------------------

export interface PendingSend {
  /** The draft as it stands. Stored with the pending operation in one write. */
  readonly draft: DraftInput
  readonly operationId: string
  readonly bodyChanged: boolean
  /** The caller may overwrite a stored record that fails validation. */
  readonly replaceUnreadable?: boolean
}

export type PendingSendResult<T> =
  | {
    readonly ok: true
    readonly value: T
    /**
     * False when the store was unavailable, so no pending operation is on disk. An unknown
     * outcome can then be resolved only within this session. The editor still works.
     */
    readonly persisted: boolean
  }
  | {readonly ok: false; readonly error: DraftError}

/** No connection to the store was made, so there is nothing on disk to protect or to look up. */
function nothingOpen(error: DraftError): boolean {
  return error.kind === 'unavailable' || error.kind === 'open-failed'
}

/**
 * Store the pending operation, read it back, and only then call `send`. A save request
 * does not go out unless the operation is already on disk, so a lost response can always
 * be looked up.
 *
 * If nothing could be opened (`unavailable`: no IndexedDB in this browser or the connection is
 * gone; `open-failed`: the open errored, was blocked or timed out), `send` is still called and
 * `persisted` is false, so the editor stays usable. If the store is open and the write or the
 * read back fails (`failed`, `quota`, `unreadable`), `send` is not called and the error is
 * returned. The pending operation stays stored after `send`; the caller clears it on a
 * definite outcome or marks it unknown.
 */
export async function sendWithPendingOperation<T>(
  store: DraftStore,
  pendingSend: PendingSend,
  send: () => Promise<T>,
): Promise<PendingSendResult<T>> {
  const {draft, operationId, bodyChanged, replaceUnreadable} = pendingSend
  const pending: PendingOperation = {operationId, sentAt: store.now(), bodyChanged, state: 'sending'}

  const stored = await store.putDraft({...draft, pending}, replaceUnreadable === true ? {replaceUnreadable: true} : undefined)
  if (!stored.ok) {
    return nothingOpen(stored.error) ? {ok: true, value: await send(), persisted: false} : stored
  }

  const confirmed = await store.getDraft(draft.pageId)
  if (!confirmed.ok) {
    // The write landed but cannot be confirmed because the store went away: treat it as not persisted.
    return nothingOpen(confirmed.error) ? {ok: true, value: await send(), persisted: false} : confirmed
  }
  if (confirmed.value?.pending?.operationId !== operationId) return {ok: false, error: {kind: 'failed'}}

  return {ok: true, value: await send(), persisted: true}
}
