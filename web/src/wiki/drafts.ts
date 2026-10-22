/**
 * Draft store: unsaved wiki edits, kept on this device in raw IndexedDB.
 *
 * Drafts never leave the device and survive sign-out and session expiry, because a draft
 * is the operator's own unsaved work. One object store holds one record per page ID.
 *
 * The wrapper uses only these IndexedDB operations:
 *   `open` with an upgrade handler that creates the one store, a transaction on that
 *   store, and `get`, `put`, `delete` and `getAll` requests, with success and error
 *   handlers on requests and complete, error and abort handlers on transactions.
 * `test-support/memory-idb.ts` implements that list and throws on anything else.
 *
 * Failures come back as results and are never thrown. A missing or blocked IndexedDB is
 * `unavailable`, and a quota error is `quota`. A record that fails validation is reported
 * as `unreadable` and is never deleted or overwritten unless the caller says so.
 */

import type {WikiCorrection} from '../api/wiki.ts'

import {parseWikiCorrection} from '../api/wiki.ts'

export const DRAFT_DB_NAME = 'fro-bot-wiki'
export const DRAFT_STORE_NAME = 'drafts'
export const DRAFT_SCHEMA_VERSION = 1

const DB_VERSION = 1

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
  readonly updatedAt: number
  readonly pending: PendingOperation | null
}

/** What a caller supplies; the store stamps the schema version and update time. */
export type DraftInput = Omit<DraftRecord, 'schemaVersion' | 'updatedAt'>

export type DraftError =
  | {readonly kind: 'unavailable'}
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

export interface DraftStore {
  /** The clock the store stamps with. Pending-operation send times come from it. */
  readonly now: () => number
  readonly getDraft: (pageId: string) => Promise<DraftResult<DraftRecord | null>>
  /** Replace the record for the page. An unreadable record is refused unless `replaceUnreadable` is set. */
  readonly putDraft: (input: DraftInput, options?: {readonly replaceUnreadable?: boolean}) => Promise<DraftResult<DraftRecord>>
  readonly deleteDraft: (pageId: string) => Promise<DraftResult<undefined>>
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

function parsePending(value: unknown): PendingOperation | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const {operationId, sentAt, bodyChanged, state} = value
  if (!isNonEmptyString(operationId) || typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return undefined
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

function parseRecord(value: unknown): DraftRecord | null {
  if (!isRecord(value) || value.schemaVersion !== DRAFT_SCHEMA_VERSION) return null
  const {pageId, baseBlobSha, baseText, draftText, updatedAt} = value
  if (!isNonEmptyString(pageId) || !isNonEmptyString(baseBlobSha)) return null
  if (typeof baseText !== 'string' || typeof draftText !== 'string') return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null

  const correctionsBase = parseCorrectionsBase(value.correctionsBase)
  const pending = parsePending(value.pending)
  if (correctionsBase === null || pending === undefined) return null

  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    pageId,
    baseBlobSha,
    baseText,
    correctionsBase,
    draftText,
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

export function createDraftStore(options: DraftStoreOptions = {}): DraftStore {
  const now = options.now ?? Date.now
  const factory = (): IDBFactory | undefined => (Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalFactory())

  let connection: IDBDatabase | null = null
  let opening: Promise<IDBDatabase | null> | null = null

  function openDatabase(): Promise<IDBDatabase | null> {
    return new Promise(resolve => {
      const idb = factory()
      if (idb === undefined) {
        resolve(null)
        return
      }
      try {
        const request = idb.open(DRAFT_DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
          request.result.createObjectStore(DRAFT_STORE_NAME, {keyPath: 'pageId'})
        }
        request.onsuccess = () => {
          resolve(request.result)
        }
        request.onerror = () => {
          resolve(null)
        }
        request.onblocked = () => {
          resolve(null)
        }
      } catch {
        resolve(null)
      }
    })
  }

  /** Reuse one open connection. A failed open is not cached, so a later call tries again. */
  async function connect(): Promise<IDBDatabase | null> {
    if (connection !== null) return connection
    opening ??= openDatabase().then(db => {
      connection = db
      opening = null
      return db
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
    if (db === null) return UNAVAILABLE

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

  async function putDraft(input: DraftInput, putOptions?: {readonly replaceUnreadable?: boolean}): Promise<DraftResult<DraftRecord>> {
    const record: DraftRecord = {...input, schemaVersion: DRAFT_SCHEMA_VERSION, updatedAt: now()}
    return transact<DraftRecord>('readwrite', (store, run, settle) => {
      run(store.get(record.pageId), existing => {
        if (existing !== undefined && putOptions?.replaceUnreadable !== true && parseRecord(existing) === null) {
          settle({ok: false, error: {kind: 'unreadable', pageId: record.pageId}})
          return
        }
        run(store.put(record), () => {
          settle({ok: true, value: record})
        })
      })
    })
  }

  async function deleteDraft(pageId: string): Promise<DraftResult<undefined>> {
    return transact<undefined>('readwrite', (store, run, settle) => {
      run(store.delete(pageId), () => {
        settle({ok: true, value: undefined})
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

/**
 * Store the pending operation, read it back, and only then call `send`. A save request
 * does not go out unless the operation is already on disk, so a lost response can always
 * be looked up.
 *
 * If the store is unavailable (IndexedDB missing, blocked, or gone), `send` is still called
 * and `persisted` is false. If the store works and the write or the read back fails for any
 * other reason (`quota`, `failed`, `unreadable`), `send` is not called and the error is
 * returned. The pending operation stays stored after `send`; the caller clears it on a
 * definite outcome or marks it unknown.
 */
export async function sendWithPendingOperation<T>(
  store: DraftStore,
  pendingSend: PendingSend,
  send: () => Promise<T>,
): Promise<PendingSendResult<T>> {
  const {draft, operationId, bodyChanged} = pendingSend
  const pending: PendingOperation = {operationId, sentAt: store.now(), bodyChanged, state: 'sending'}

  const stored = await store.putDraft({...draft, pending})
  if (!stored.ok) {
    return stored.error.kind === 'unavailable' ? {ok: true, value: await send(), persisted: false} : stored
  }

  const confirmed = await store.getDraft(draft.pageId)
  if (!confirmed.ok) {
    // The write landed but cannot be confirmed because the store went away: treat it as not persisted.
    return confirmed.error.kind === 'unavailable' ? {ok: true, value: await send(), persisted: false} : confirmed
  }
  if (confirmed.value?.pending?.operationId !== operationId) return {ok: false, error: {kind: 'failed'}}

  return {ok: true, value: await send(), persisted: true}
}
