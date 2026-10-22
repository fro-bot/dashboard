import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {getWikiPage, saveWikiPage} from '../api/wiki.ts'
import {
  createDraftStore,
  DRAFT_OPEN_TIMEOUT_MS,
  type DraftInput,
  type DraftRecord,
  type DraftStore,
  sendWithPendingOperation,
} from './drafts.ts'
import {createMemoryIdb, type MemoryIdb} from './test-support/memory-idb.ts'

const OPERATION_ID = '00000000-0000-4000-8000-000000000001'
const NOW = 1_900_000_000_000

const CORRECTION = {
  id: 'c1',
  status: 'active',
  span: {text: 'Alpha builds widgets'},
  attribution: null,
  reason: null,
  supersededBy: null,
  stale: false,
} as const

function input(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    pageId: 'repos.acme--alpha',
    baseBlobSha: 'blob-bc079bf35740',
    baseText: '\n# acme/alpha\n\nAlpha builds widgets.\n',
    correctionsBase: {entries: [CORRECTION], digest: '84af704b511188e099d585af405ec64aa728d795249bc5cccdffcec5602b731f'},
    draftText: '\n# acme/alpha\n\nAlpha builds gadgets.\n',
    pending: null,
    ...overrides,
  }
}

function setup(): {idb: MemoryIdb; store: DraftStore} {
  const idb = createMemoryIdb()
  return {idb, store: createDraftStore({indexedDB: idb.factory, now: () => NOW})}
}

async function mustLoad(store: DraftStore, pageId = 'repos.acme--alpha'): Promise<DraftRecord> {
  const result = await store.getDraft(pageId)
  if (!result.ok || result.value === null) throw new Error(`No readable draft for ${pageId}`)
  return result.value
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('draft round trip', () => {
  it('stores and loads every field, stamping the schema version and update time', async () => {
    const {store} = setup()
    const pending = {operationId: OPERATION_ID, sentAt: NOW - 5, bodyChanged: true, state: 'sending'} as const

    const saved = await store.putDraft(input({pending}))
    expect(saved.ok).toBe(true)

    expect(await mustLoad(store)).toEqual({
      schemaVersion: 1,
      pageId: 'repos.acme--alpha',
      baseBlobSha: 'blob-bc079bf35740',
      baseText: '\n# acme/alpha\n\nAlpha builds widgets.\n',
      correctionsBase: {entries: [CORRECTION], digest: '84af704b511188e099d585af405ec64aa728d795249bc5cccdffcec5602b731f'},
      draftText: '\n# acme/alpha\n\nAlpha builds gadgets.\n',
      updatedAt: NOW,
      pending,
    })
  })

  it('stores the corrections base exactly as the read model returned it when the page opened', async () => {
    const samples = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../test/fixtures/wiki-wire-samples.json'), 'utf8'),
    ) as {page: {ok: {status: number; body: unknown}}}
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(samples.page.ok.body), {status: 200})))
    const opened = await getWikiPage('repos.acme--alpha')
    if (!opened.ok) throw new Error('page did not open')

    const {store} = setup()
    await store.putDraft(
      input({
        baseBlobSha: opened.value.pageBlobSha,
        baseText: opened.value.body,
        correctionsBase: {entries: opened.value.corrections, digest: opened.value.correctionsBase},
        draftText: `${opened.value.body}more`,
      }),
    )

    const loaded = await mustLoad(store)
    expect(loaded.correctionsBase.entries).toEqual(opened.value.corrections)
    expect(loaded.correctionsBase.digest).toBe(opened.value.correctionsBase)
    expect(loaded.baseBlobSha).toBe(opened.value.pageBlobSha)
  })

  it('replaces the record when the same page is stored again', async () => {
    const {store} = setup()
    await store.putDraft(input({draftText: 'first'}))
    await store.putDraft(input({draftText: 'second'}))

    expect((await mustLoad(store)).draftText).toBe('second')
    const listed = await store.listDrafts()
    expect(listed.ok && listed.value.drafts).toHaveLength(1)
  })

  it('stores and loads a 512 KB draft and base text', async () => {
    const {store} = setup()
    const big = 'a'.repeat(512 * 1024)

    const saved = await store.putDraft(input({baseText: big, draftText: `${big}b`}))
    expect(saved.ok).toBe(true)

    const loaded = await mustLoad(store)
    expect(loaded.baseText.length).toBe(512 * 1024)
    expect(loaded.draftText).toBe(`${big}b`)
  })

  it('returns null for a page with no draft', async () => {
    const {store} = setup()

    expect(await store.getDraft('repos.nothing')).toEqual({ok: true, value: null})
  })

  it('survives a reload: a new store on the same database sees the draft', async () => {
    const {idb, store} = setup()
    await store.putDraft(input())

    const reloaded = createDraftStore({indexedDB: idb.factory})

    expect((await mustLoad(reloaded)).draftText).toBe('\n# acme/alpha\n\nAlpha builds gadgets.\n')
  })

  it('uses the global indexedDB when none is passed', async () => {
    const idb = createMemoryIdb()
    vi.stubGlobal('indexedDB', idb.factory)
    const store = createDraftStore()

    expect((await store.putDraft(input())).ok).toBe(true)
    expect(idb.records()).toHaveLength(1)
  })

  it('deletes a draft, and deleting a missing draft is not an error', async () => {
    const {store} = setup()
    await store.putDraft(input())

    expect(await store.deleteDraft('repos.acme--alpha')).toEqual({ok: true, value: undefined})
    expect(await store.getDraft('repos.acme--alpha')).toEqual({ok: true, value: null})
    expect((await store.deleteDraft('repos.acme--alpha')).ok).toBe(true)
  })

  it('lists every readable draft', async () => {
    const {store} = setup()
    await store.putDraft(input({pageId: 'repos.a'}))
    await store.putDraft(input({pageId: 'topics.b'}))

    const listed = await store.listDrafts()

    expect(listed.ok && listed.value.drafts.map(d => d.pageId).sort()).toEqual(['repos.a', 'topics.b'])
    expect(listed.ok && listed.value.unreadable).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Corrupt records
// ---------------------------------------------------------------------------

describe('unreadable records', () => {
  it('reports a record that fails validation as unreadable and leaves it in place', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 1, pageId: 'repos.bad', draftText: 42})

    const loaded = await store.getDraft('repos.bad')

    expect(loaded).toEqual({ok: false, error: {kind: 'unreadable', pageId: 'repos.bad'}})
    expect(idb.records()).toHaveLength(1)
  })

  // `sentAt` becomes a Date for the lookup fallback, so it must be a time a Date can hold.
  it.each([
    ['past the latest Date', 8.64e15 + 1],
    ['before the earliest Date', -8.64e15 - 1],
    ['not a whole number', 1.5],
    ['not a safe integer', 2 ** 60],
  ])('reports a pending operation whose sentAt is %s as unreadable', async (_label, sentAt) => {
    const {idb, store} = setup()
    idb.plant({
      ...input({pending: {operationId: OPERATION_ID, sentAt, bodyChanged: true, state: 'unknown'}}),
      schemaVersion: 1,
      updatedAt: NOW,
    })

    expect(await store.getDraft('repos.acme--alpha')).toEqual({
      ok: false,
      error: {kind: 'unreadable', pageId: 'repos.acme--alpha'},
    })
  })

  it.each([8.64e15, -8.64e15, 0, NOW])('reads a pending operation whose sentAt is %s', async sentAt => {
    const {store} = setup()
    await store.putDraft(input({pending: {operationId: OPERATION_ID, sentAt, bodyChanged: true, state: 'unknown'}}))

    expect((await mustLoad(store)).pending?.sentAt).toBe(sentAt)
  })

  it('reports a record from a newer schema version as unreadable, not as a draft', async () => {
    const {idb, store} = setup()
    idb.plant({...input(), schemaVersion: 2, updatedAt: NOW, extra: 'future'})

    expect(await store.getDraft('repos.acme--alpha')).toEqual({
      ok: false,
      error: {kind: 'unreadable', pageId: 'repos.acme--alpha'},
    })
    expect(idb.records()).toHaveLength(1)
  })

  it.each([
    ['a corrupt correction entry', {correctionsBase: {entries: [{id: 1}], digest: 'x'}}],
    ['a missing corrections digest', {correctionsBase: {entries: []}}],
    ['an unknown pending state', {pending: {operationId: OPERATION_ID, sentAt: 1, bodyChanged: true, state: 'done'}}],
    ['a pending operation without an ID', {pending: {sentAt: 1, bodyChanged: true, state: 'sending'}}],
    ['a non-numeric update time', {updatedAt: 'yesterday'}],
    ['a missing base blob SHA', {baseBlobSha: undefined}],
  ])('flags %s as unreadable', async (_label, change) => {
    const {idb, store} = setup()
    idb.plant({...input(), schemaVersion: 1, updatedAt: NOW, ...change})

    const loaded = await store.getDraft('repos.acme--alpha')

    expect(loaded.ok).toBe(false)
    expect(!loaded.ok && loaded.error.kind).toBe('unreadable')
    expect(idb.records()).toHaveLength(1)
  })

  it('lists an unreadable record beside the readable ones and deletes nothing', async () => {
    const {idb, store} = setup()
    await store.putDraft(input({pageId: 'repos.good'}))
    idb.plant({schemaVersion: 1, pageId: 'repos.bad', baseText: null})

    const listed = await store.listDrafts()

    expect(listed.ok && listed.value.drafts.map(d => d.pageId)).toEqual(['repos.good'])
    expect(listed.ok && listed.value.unreadable).toEqual([{pageId: 'repos.bad'}])
    expect(idb.records()).toHaveLength(2)
  })

  it('refuses to overwrite an unreadable record unless the caller says so', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 1, pageId: 'repos.acme--alpha', draftText: 7})

    const refused = await store.putDraft(input())

    expect(refused).toEqual({ok: false, error: {kind: 'unreadable', pageId: 'repos.acme--alpha'}})
    expect(idb.records()).toEqual([{schemaVersion: 1, pageId: 'repos.acme--alpha', draftText: 7}])

    const replaced = await store.putDraft(input(), {replaceUnreadable: true})
    expect(replaced.ok).toBe(true)
    expect((await mustLoad(store)).draftText).toBe('\n# acme/alpha\n\nAlpha builds gadgets.\n')
  })

  it('removes an unreadable record only through an explicit delete', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 1, pageId: 'repos.bad'})

    expect((await store.deleteDraft('repos.bad')).ok).toBe(true)
    expect(idb.records()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Failures are results
// ---------------------------------------------------------------------------

describe('quota and write errors', () => {
  it('returns a quota result and leaves the earlier draft untouched', async () => {
    const {idb, store} = setup()
    await store.putDraft(input({draftText: 'earlier'}))
    idb.failNext('put', 'QuotaExceededError')

    const result = await store.putDraft(input({draftText: 'later'}))

    expect(result).toEqual({ok: false, error: {kind: 'quota'}})
    expect((await mustLoad(store)).draftText).toBe('earlier')
  })

  it('returns a failed result for another write error and does not throw', async () => {
    const {idb, store} = setup()
    idb.failNext('put', 'UnknownError')

    await expect(store.putDraft(input())).resolves.toEqual({ok: false, error: {kind: 'failed'}})
    expect(idb.records()).toEqual([])
  })

  it('returns a failed result for a delete that errors', async () => {
    const {idb, store} = setup()
    await store.putDraft(input())
    idb.failNext('delete', 'UnknownError')

    await expect(store.deleteDraft('repos.acme--alpha')).resolves.toEqual({ok: false, error: {kind: 'failed'}})
    expect(idb.records()).toHaveLength(1)
  })

  it('returns a failed result for a read that errors', async () => {
    const {idb, store} = setup()
    idb.failNext('get', 'UnknownError')

    await expect(store.getDraft('repos.acme--alpha')).resolves.toEqual({ok: false, error: {kind: 'failed'}})
  })

  it('returns a failed result for a list that errors', async () => {
    const {idb, store} = setup()
    idb.failNext('getAll', 'UnknownError')

    await expect(store.listDrafts()).resolves.toEqual({ok: false, error: {kind: 'failed'}})
  })

  it('recovers on the next call after a failure', async () => {
    const {idb, store} = setup()
    idb.failNext('put', 'QuotaExceededError')
    await store.putDraft(input())

    expect((await store.putDraft(input())).ok).toBe(true)
  })
})

describe('unavailable IndexedDB', () => {
  it('returns unavailable from every operation when IndexedDB is missing', async () => {
    const store = createDraftStore({indexedDB: undefined})
    const unavailable = {ok: false, error: {kind: 'unavailable'}}

    expect(await store.getDraft('repos.a')).toEqual(unavailable)
    expect(await store.putDraft(input())).toEqual(unavailable)
    expect(await store.deleteDraft('repos.a')).toEqual(unavailable)
    expect(await store.listDrafts()).toEqual(unavailable)
    expect(await store.markPendingUnknown('repos.a')).toEqual(unavailable)
    expect(await store.clearPendingOperation('repos.a')).toEqual(unavailable)
  })

  it('returns unavailable when no global indexedDB exists', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const store = createDraftStore()

    expect(await store.getDraft('repos.a')).toEqual({ok: false, error: {kind: 'unavailable'}})
  })

  // A browser with no IndexedDB, or one that refuses it outright, holds no drafts. An open that
  // fails, is blocked or times out may be hiding a record the editor has not seen: that is `failed`.
  it('returns unavailable when the browser refuses to open IndexedDB at all', async () => {
    const idb = createMemoryIdb()
    idb.openMode = 'throw'
    const store = createDraftStore({indexedDB: idb.factory})

    expect(await store.putDraft(input())).toEqual({ok: false, error: {kind: 'unavailable'}})
    expect(await store.getDraft('repos.a')).toEqual({ok: false, error: {kind: 'unavailable'}})
  })

  it.each(['blocked', 'error'] as const)('returns open-failed, not unavailable, when opening the database is %s', async mode => {
    const idb = createMemoryIdb()
    idb.openMode = mode
    const store = createDraftStore({indexedDB: idb.factory})

    expect(await store.putDraft(input())).toEqual({ok: false, error: {kind: 'open-failed'}})
    expect(await store.getDraft('repos.a')).toEqual({ok: false, error: {kind: 'open-failed'}})
    expect(await store.listDrafts()).toEqual({ok: false, error: {kind: 'open-failed'}})
    expect(await store.deleteDraft('repos.a')).toEqual({ok: false, error: {kind: 'open-failed'}})
  })

  it('opens the database on a later call once it stops being blocked', async () => {
    const idb = createMemoryIdb()
    idb.openMode = 'blocked'
    const store = createDraftStore({indexedDB: idb.factory})
    await store.getDraft('repos.a')

    idb.openMode = 'ok'

    expect((await store.putDraft(input())).ok).toBe(true)
  })

  it('treats a connection that has gone away as unavailable, then reopens', async () => {
    const {idb, store} = setup()
    await store.putDraft(input())
    idb.dropConnection()

    expect(await store.getDraft('repos.acme--alpha')).toEqual({ok: false, error: {kind: 'unavailable'}})
    expect((await mustLoad(store)).draftText).toContain('gadgets')
  })

  it('closes its connection when a newer schema wants to open, and reopens on the next call', async () => {
    const {idb, store} = setup()
    await store.putDraft(input())
    expect(idb.openConnections()).toBe(1)

    idb.versionChange()

    expect(idb.openConnections()).toBe(0)
    expect((await mustLoad(store)).draftText).toContain('gadgets')
    expect(idb.openConnections()).toBe(1)
    expect(idb.operations.filter(name => name === 'open')).toHaveLength(2)
  })

  it('closes an open that was blocked and goes through later, and still reports failed for the blocked call', async () => {
    const idb = createMemoryIdb()
    idb.openMode = 'blocked-then-ok'
    const store = createDraftStore({indexedDB: idb.factory, now: () => NOW})

    expect(await store.getDraft('repos.a')).toEqual({ok: false, error: {kind: 'open-failed'}})
    await new Promise<void>(done => setTimeout(done, 0))

    expect(idb.openConnections()).toBe(0)
  })

  it('opens normally on a later call after a blocked open went through late', async () => {
    const idb = createMemoryIdb()
    idb.openMode = 'blocked-then-ok'
    const store = createDraftStore({indexedDB: idb.factory, now: () => NOW})
    await store.getDraft('repos.a')
    await new Promise<void>(done => setTimeout(done, 0))
    idb.openMode = 'ok'

    expect((await store.putDraft(input())).ok).toBe(true)
    expect(idb.openConnections()).toBe(1)
  })

  it('gives up on an open that never answers, as unavailable, and opens on a later call', async () => {
    vi.useFakeTimers()
    const idb = createMemoryIdb()
    idb.openMode = 'hang'
    const store = createDraftStore({indexedDB: idb.factory, now: () => NOW})
    const answered = vi.fn()
    void store.getDraft('repos.a').then(answered)

    await vi.advanceTimersByTimeAsync(DRAFT_OPEN_TIMEOUT_MS - 1)
    expect(answered).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(answered).toHaveBeenCalledWith({ok: false, error: {kind: 'open-failed'}})

    idb.openMode = 'ok'
    expect((await store.putDraft(input())).ok).toBe(true)
  })

  it('does not leave the open timer running once the database has opened', async () => {
    vi.useFakeTimers()
    const {store} = setup()
    await store.putDraft(input())

    expect(vi.getTimerCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The fake enforces the declared operation list
// ---------------------------------------------------------------------------

describe('memory IndexedDB fake', () => {
  function openDb(idb: MemoryIdb): Promise<IDBDatabase> {
    return new Promise((resolveDb, reject) => {
      const request = idb.factory.open('probe', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('s', {keyPath: 'pageId'})
      }
      request.onsuccess = () => resolveDb(request.result)
      request.onerror = () => reject(new Error('open failed'))
    })
  }

  it('rejects an operation outside the declared list', async () => {
    const idb = createMemoryIdb()
    const db = await openDb(idb)
    const store = db.transaction('s', 'readwrite').objectStore('s')

    expect(() => idb.factory.deleteDatabase('probe')).toThrow(/unsupported/iu)
    expect(() => db.version).toThrow(/unsupported/iu)
    expect(() => db.onclose).toThrow(/unsupported/iu)
    expect(() => db.objectStoreNames).toThrow(/unsupported/iu)
    expect(() => db.deleteObjectStore('s')).toThrow(/unsupported/iu)
    expect(() => store.openCursor()).toThrow(/unsupported/iu)
    expect(() => store.count()).toThrow(/unsupported/iu)
    expect(() => store.clear()).toThrow(/unsupported/iu)
    expect(() => store.add({pageId: 'x'})).toThrow(/unsupported/iu)
    expect(() => store.getAllKeys()).toThrow(/unsupported/iu)
    expect(() => store.createIndex('i', 'x')).toThrow(/unsupported/iu)
    expect(() => db.transaction('s').abort()).toThrow(/unsupported/iu)
    expect(() => db.transaction('s').commit()).toThrow(/unsupported/iu)
  })

  it('rejects a handler outside the declared list', async () => {
    const idb = createMemoryIdb()
    const db = await openDb(idb)
    const request = db.transaction('s').objectStore('s').getAll()

    expect(() => {
      // oncomplete exists on a transaction, not on a request.
      ;(request as unknown as Record<string, unknown>).oncomplete = () => undefined
    }).toThrow(/unsupported/iu)
  })

  it('rejects a store name the database does not have', async () => {
    const idb = createMemoryIdb()
    const db = await openDb(idb)

    expect(() => db.transaction('other')).toThrow(/NotFoundError|object store/iu)
  })

  it('applies a write only when its transaction completes', async () => {
    const idb = createMemoryIdb()
    const db = await openDb(idb)
    const tx = db.transaction('s', 'readwrite')
    tx.objectStore('s').put({pageId: 'x'})

    expect(idb.records()).toEqual([])
    await new Promise<void>(done => {
      tx.oncomplete = () => done()
    })
    expect(idb.records()).toEqual([{pageId: 'x'}])
  })

  it('allows close and onversionchange on a database, because the store declares them', async () => {
    const idb = createMemoryIdb()
    const db = await openDb(idb)
    const seen = vi.fn()

    db.onversionchange = seen
    idb.versionChange()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(idb.openConnections()).toBe(1)
    db.close()
    expect(idb.openConnections()).toBe(0)
    expect(() => db.transaction('s')).toThrow(/closing/iu)
  })

  it('fires request.onerror, then tx.onerror, then onabort for a failed write, and never onsuccess', async () => {
    const idb = createMemoryIdb()
    const db = await openDb(idb)
    idb.failNext('put', 'QuotaExceededError')
    const tx = db.transaction('s', 'readwrite')
    const events: string[] = []
    const request = tx.objectStore('s').put({pageId: 'x'})
    request.onsuccess = () => events.push('request.onsuccess')
    request.onerror = () => events.push('request.onerror')
    tx.onerror = () => events.push('tx.onerror')
    tx.oncomplete = () => events.push('tx.oncomplete')
    await new Promise<void>(done => {
      tx.onabort = () => {
        events.push('tx.onabort')
        done()
      }
    })

    expect(events).toEqual(['request.onerror', 'tx.onerror', 'tx.onabort'])
    expect(tx.error?.name).toBe('QuotaExceededError')
    expect(idb.records()).toEqual([])
  })

  it('fails a delete the same way and leaves the record in place', async () => {
    const idb = createMemoryIdb()
    const db = await openDb(idb)
    const seed = db.transaction('s', 'readwrite')
    seed.objectStore('s').put({pageId: 'x'})
    await new Promise<void>(done => {
      seed.oncomplete = () => done()
    })
    idb.failNext('delete', 'UnknownError')
    const tx = db.transaction('s', 'readwrite')
    const events: string[] = []
    const request = tx.objectStore('s').delete('x')
    request.onsuccess = () => events.push('request.onsuccess')
    request.onerror = () => events.push('request.onerror')
    tx.onerror = () => events.push('tx.onerror')
    await new Promise<void>(done => {
      tx.onabort = () => {
        events.push('tx.onabort')
        done()
      }
    })

    expect(events).toEqual(['request.onerror', 'tx.onerror', 'tx.onabort'])
    expect(idb.records()).toEqual([{pageId: 'x'}])
  })

  it('records only declared operations when the store runs a full workflow', async () => {
    const {idb, store} = setup()
    await store.putDraft(input())
    await store.getDraft('repos.acme--alpha')
    await store.listDrafts()
    await store.markPendingUnknown('repos.acme--alpha')
    await store.clearPendingOperation('repos.acme--alpha')
    await store.deleteDraft('repos.acme--alpha')

    expect(new Set(idb.operations)).toEqual(
      new Set(['open', 'createObjectStore', 'transaction', 'objectStore', 'get', 'put', 'getAll', 'delete']),
    )
  })
})

// ---------------------------------------------------------------------------
// Pending operation
// ---------------------------------------------------------------------------

describe('pending operation', () => {
  const pending = {operationId: OPERATION_ID, sentAt: NOW, bodyChanged: true, state: 'sending'} as const

  it('marks a pending operation unknown without touching the rest of the record', async () => {
    const {store} = setup()
    await store.putDraft(input({pending}))

    const marked = await store.markPendingUnknown('repos.acme--alpha')

    expect(marked.ok).toBe(true)
    const loaded = await mustLoad(store)
    expect(loaded.pending).toEqual({...pending, state: 'unknown'})
    expect(loaded.draftText).toBe('\n# acme/alpha\n\nAlpha builds gadgets.\n')
    expect(loaded.baseBlobSha).toBe('blob-bc079bf35740')
  })

  it('clears a pending operation and keeps the draft', async () => {
    const {store} = setup()
    await store.putDraft(input({pending}))

    await store.clearPendingOperation('repos.acme--alpha')

    const loaded = await mustLoad(store)
    expect(loaded.pending).toBeNull()
    expect(loaded.draftText).toContain('gadgets')
  })

  it('reports a missing draft when there is nothing to update', async () => {
    const {store} = setup()

    expect(await store.markPendingUnknown('repos.nothing')).toEqual({ok: false, error: {kind: 'missing'}})
    expect(await store.clearPendingOperation('repos.nothing')).toEqual({ok: false, error: {kind: 'missing'}})
  })

  it('leaves an unreadable record alone when updating its pending operation', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 1, pageId: 'repos.bad'})

    const result = await store.markPendingUnknown('repos.bad')

    expect(result).toEqual({ok: false, error: {kind: 'unreadable', pageId: 'repos.bad'}})
    expect(idb.records()).toEqual([{schemaVersion: 1, pageId: 'repos.bad'}])
  })

  it('does not change the draft when marking a pending operation unknown fails on quota', async () => {
    const {idb, store} = setup()
    await store.putDraft(input({pending}))
    idb.failNext('put', 'QuotaExceededError')

    expect(await store.markPendingUnknown('repos.acme--alpha')).toEqual({ok: false, error: {kind: 'quota'}})
    expect((await mustLoad(store)).pending?.state).toBe('sending')
  })
})

describe('autosave and conditional delete (two tabs, one record per page)', () => {
  const pending = {operationId: OPERATION_ID, sentAt: NOW, bodyChanged: true, state: 'unknown'} as const

  it('keeps the pending operation another tab stored when the new draft has none', async () => {
    const {store} = setup()
    await store.putDraft(input({pending}))

    const result = await store.putDraft(input({draftText: 'tab b text', pending: null}), {keepStoredPending: true})

    expect(result.ok && result.value.pending).toEqual(pending)
    const loaded = await mustLoad(store)
    expect(loaded.pending).toEqual(pending)
    expect(loaded.draftText).toBe('tab b text')
  })

  it('replaces the pending operation without the option, as before', async () => {
    const {store} = setup()
    await store.putDraft(input({pending}))

    await store.putDraft(input({draftText: 'tab b text', pending: null}))

    expect((await mustLoad(store)).pending).toBeNull()
  })

  it('lets a pending operation on the new draft win over the stored one', async () => {
    const {store} = setup()
    await store.putDraft(input({pending}))
    const newer = {...pending, operationId: '00000000-0000-4000-8000-000000000002', state: 'sending'} as const

    await store.putDraft(input({pending: newer}), {keepStoredPending: true})

    expect((await mustLoad(store)).pending).toEqual(newer)
  })

  it('stores no pending operation when there is none to keep', async () => {
    const {store} = setup()

    await store.putDraft(input(), {keepStoredPending: true})

    expect((await mustLoad(store)).pending).toBeNull()
  })

  it('keeps nothing from an unreadable record it was told to replace', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 1, pageId: 'repos.acme--alpha', draftText: 7})

    const result = await store.putDraft(input(), {keepStoredPending: true, replaceUnreadable: true})

    expect(result.ok).toBe(true)
    expect((await mustLoad(store)).pending).toBeNull()
  })

  it('deletes the record when the predicate accepts it', async () => {
    const {idb, store} = setup()
    await store.putDraft(input({pending}))
    const onlyIf = vi.fn((record: DraftRecord) => record.pending?.operationId === OPERATION_ID)

    expect(await store.deleteDraft('repos.acme--alpha', {onlyIf})).toEqual({ok: true, value: undefined})

    expect(onlyIf).toHaveBeenCalledTimes(1)
    expect(idb.records()).toEqual([])
  })

  it('keeps the record when the predicate refuses it', async () => {
    const {idb, store} = setup()
    await store.putDraft(input({draftText: 'tab b text'}))

    expect(await store.deleteDraft('repos.acme--alpha', {onlyIf: () => false})).toEqual({ok: true, value: undefined})

    expect(idb.records()).toHaveLength(1)
  })

  it('never deletes an unreadable record conditionally, and never asks the predicate about it', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 99, pageId: 'repos.acme--alpha'})
    const onlyIf = vi.fn(() => true)

    expect(await store.deleteDraft('repos.acme--alpha', {onlyIf})).toEqual({ok: true, value: undefined})

    expect(onlyIf).not.toHaveBeenCalled()
    expect(idb.records()).toHaveLength(1)
  })

  it('has nothing to do when a conditional delete finds no record', async () => {
    const {store} = setup()

    expect(await store.deleteDraft('repos.nothing', {onlyIf: () => true})).toEqual({ok: true, value: undefined})
  })

  it('still deletes an unreadable record when the caller asks for an unconditional delete', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 99, pageId: 'repos.acme--alpha'})

    expect((await store.deleteDraft('repos.acme--alpha')).ok).toBe(true)

    expect(idb.records()).toEqual([])
  })
})

describe('deleteUnreadableDraft', () => {
  it('deletes a record that still fails validation', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 99, pageId: 'repos.acme--alpha'})

    expect(await store.deleteUnreadableDraft('repos.acme--alpha')).toEqual({ok: true, value: 'deleted'})

    expect(idb.records()).toEqual([])
  })

  it('leaves a record alone that is readable now, and says so', async () => {
    const {idb, store} = setup()
    await store.putDraft(input({draftText: 'another tab replaced it'}))

    expect(await store.deleteUnreadableDraft('repos.acme--alpha')).toEqual({ok: true, value: 'readable'})

    expect(idb.records()).toHaveLength(1)
    expect((await mustLoad(store)).draftText).toBe('another tab replaced it')
  })

  it('reports a record that is already gone', async () => {
    const {store} = setup()

    expect(await store.deleteUnreadableDraft('repos.nothing')).toEqual({ok: true, value: 'missing'})
  })

  it('reports a failed delete and keeps the record', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 99, pageId: 'repos.acme--alpha'})
    idb.failNext('delete', 'UnknownError')

    expect(await store.deleteUnreadableDraft('repos.acme--alpha')).toEqual({ok: false, error: {kind: 'failed'}})
    expect(idb.records()).toHaveLength(1)
  })
})

describe('sendWithPendingOperation', () => {
  it('has the pending operation readable from the store at the moment the request is sent', async () => {
    const {store} = setup()
    let seen: DraftRecord | null = null
    const send = vi.fn(async () => {
      seen = await mustLoad(store)
      return 'sent'
    })

    const result = await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, send)

    expect(result).toEqual({ok: true, value: 'sent', persisted: true})
    expect(send).toHaveBeenCalledTimes(1)
    expect(seen).not.toBeNull()
    expect((seen as DraftRecord | null)?.pending).toEqual({
      operationId: OPERATION_ID,
      sentAt: NOW,
      bodyChanged: true,
      state: 'sending',
    })
    expect((seen as DraftRecord | null)?.draftText).toContain('gadgets')
  })

  it('has the pending operation readable when the real save call is made against a fake fetch', async () => {
    const {store} = setup()
    let observed: DraftRecord | null = null
    const fakeFetch = vi.fn(async () => {
      observed = await mustLoad(store)
      return new Response('Too Many Requests', {status: 429})
    })
    vi.stubGlobal('fetch', fakeFetch)

    await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, async () =>
      saveWikiPage({
        pageId: 'repos.acme--alpha',
        operationId: OPERATION_ID,
        pageBlobSha: 'blob-bc079bf35740',
        correctionsBase: 'a'.repeat(64),
        body: 'x',
      }),
    )

    expect(fakeFetch).toHaveBeenCalledTimes(1)
    expect((observed as DraftRecord | null)?.pending?.operationId).toBe(OPERATION_ID)
  })

  it('does not send when the pending operation cannot be written (quota)', async () => {
    const {idb, store} = setup()
    idb.failNext('put', 'QuotaExceededError')
    const send = vi.fn(async () => 'sent')

    const result = await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, send)

    expect(result).toEqual({ok: false, error: {kind: 'quota'}})
    expect(send).not.toHaveBeenCalled()
  })

  it('sends without storing anything when IndexedDB is unavailable, and says it was not persisted', async () => {
    const store = createDraftStore({indexedDB: undefined})
    const send = vi.fn(async () => 'sent')

    const result = await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: false}, send)

    expect(result).toEqual({ok: true, value: 'sent', persisted: false})
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends and reports not persisted when the browser refuses to open IndexedDB at all', async () => {
    const idb = createMemoryIdb()
    idb.openMode = 'throw'
    const store = createDraftStore({indexedDB: idb.factory})
    const send = vi.fn(async () => 'sent')

    const result = await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, send)

    expect(result).toEqual({ok: true, value: 'sent', persisted: false})
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each(['blocked', 'error'] as const)(
    'sends and reports not persisted when opening the database is %s, so the editor stays usable',
    async mode => {
      const idb = createMemoryIdb()
      idb.openMode = mode
      const store = createDraftStore({indexedDB: idb.factory})
      const send = vi.fn(async () => 'sent')

      const result = await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, send)

      expect(result).toEqual({ok: true, value: 'sent', persisted: false})
      expect(send).toHaveBeenCalledTimes(1)
    },
  )

  it('sends and reports not persisted when the open times out', async () => {
    vi.useFakeTimers()
    const idb = createMemoryIdb()
    idb.openMode = 'hang'
    const store = createDraftStore({indexedDB: idb.factory})
    const send = vi.fn(async () => 'sent')
    const answered = vi.fn()
    void sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, send).then(answered)

    await vi.advanceTimersByTimeAsync(DRAFT_OPEN_TIMEOUT_MS)

    expect(answered).toHaveBeenCalledWith({ok: true, value: 'sent', persisted: false})
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends and reports not persisted when the store goes away between the write and the read back', async () => {
    const {idb, store} = setup()
    idb.afterNextCommit(() => {
      idb.dropConnection()
    })
    const send = vi.fn(async () => 'sent')

    const result = await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, send)

    expect(result).toEqual({ok: true, value: 'sent', persisted: false})
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not send when the store is available but the write fails for another reason', async () => {
    const {idb, store} = setup()
    idb.failNext('put', 'UnknownError')
    const send = vi.fn(async () => 'sent')

    const result = await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, send)

    expect(result).toEqual({ok: false, error: {kind: 'failed'}})
    expect(send).not.toHaveBeenCalled()
  })

  it('does not send when the stored record cannot be read back', async () => {
    const {idb, store} = setup()
    idb.failNext('get', 'UnknownError', {skip: 1})
    const send = vi.fn(async () => 'sent')

    const result = await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, send)

    expect(result).toEqual({ok: false, error: {kind: 'failed'}})
    expect(send).not.toHaveBeenCalled()
  })

  it('does not send when the read back shows a different pending operation', async () => {
    const {idb, store} = setup()
    idb.afterNextCommit(records => {
      // Another tab wins the race between the write and the read back.
      const first = records[0] as {pending: {operationId: string}} | undefined
      if (first !== undefined) first.pending.operationId = '00000000-0000-4000-8000-0000000000ff'
    })
    const send = vi.fn(async () => 'sent')

    const result = await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, send)

    expect(result).toEqual({ok: false, error: {kind: 'failed'}})
    expect(send).not.toHaveBeenCalled()
  })

  it('does not overwrite an unreadable record or send', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 1, pageId: 'repos.acme--alpha', draftText: 7})
    const send = vi.fn(async () => 'sent')

    const result = await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, send)

    expect(result).toEqual({ok: false, error: {kind: 'unreadable', pageId: 'repos.acme--alpha'}})
    expect(send).not.toHaveBeenCalled()
  })

  it('replaces an unreadable record and sends when the caller says it may', async () => {
    const {idb, store} = setup()
    idb.plant({schemaVersion: 1, pageId: 'repos.acme--alpha', draftText: 7})
    const send = vi.fn(async () => 'sent')

    const result = await sendWithPendingOperation(
      store,
      {draft: input(), operationId: OPERATION_ID, bodyChanged: true, replaceUnreadable: true},
      send,
    )

    expect(result).toEqual({ok: true, value: 'sent', persisted: true})
    expect((await mustLoad(store)).pending?.operationId).toBe(OPERATION_ID)
  })

  it('keeps the pending operation after the send, for the caller to resolve', async () => {
    const {store} = setup()

    await sendWithPendingOperation(store, {draft: input(), operationId: OPERATION_ID, bodyChanged: true}, async () => 'lost')

    expect((await mustLoad(store)).pending?.state).toBe('sending')
  })
})
