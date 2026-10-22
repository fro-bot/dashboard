/**
 * In-memory IndexedDB fake for the draft store tests.
 *
 * It implements exactly the operations the draft store declares, and every other member
 * throws. That keeps the store from depending on more of IndexedDB than it lists:
 *
 *   factory:        open
 *   open request:   result, error, onsuccess, onerror, onupgradeneeded, onblocked
 *   database:       createObjectStore, transaction, close, onversionchange
 *   transaction:    objectStore, error, oncomplete, onerror, onabort
 *   object store:   get, put, delete, getAll
 *   request:        result, error, onsuccess, onerror
 *
 * Writes are staged and apply when the transaction completes. A transaction aborts as a
 * whole, so a failed write leaves earlier data untouched. A write fault behaves as in a
 * browser: `request.onerror`, then `tx.onerror`, then `tx.onabort`, and never `onsuccess`. Values are structured-cloned in
 * and out. Test controls (`plant`, `failNext`, ...) sit on the returned object, not on the
 * factory, so they are outside the restricted surface.
 */

import {DRAFT_DB_NAME, DRAFT_STORE_NAME} from '../drafts.ts'

export type FaultOperation = 'get' | 'getAll' | 'put' | 'delete'
/**
 * `blocked` fires `onblocked` and never settles. `blocked-then-ok` fires `onblocked` and then
 * opens anyway, as a browser does once the blocking connection closes. `hang` fires nothing.
 */
export type OpenMode = 'ok' | 'blocked' | 'blocked-then-ok' | 'hang' | 'error' | 'throw'

export interface MemoryIdb {
  readonly factory: IDBFactory
  openMode: OpenMode
  /** Every operation the code under test used, by name. */
  readonly operations: string[]
  /** Clones of every stored value. */
  records: () => unknown[]
  /** Store a value directly, as if an older or damaged build had written it. */
  plant: (value: unknown) => void
  /**
   * Fail the next matching operation: the request errors with this error name (a quota error
   * is the usual case) and the transaction aborts. A failed `put` or `delete` is not applied.
   * `skip` lets that many matching operations through first.
   */
  failNext: (operation: FaultOperation, errorName: string, options?: {skip?: number}) => void
  /** Run `change` on the live stored values right after the next write commits. */
  afterNextCommit: (change: (live: Record<string, unknown>[]) => void) => void
  /** Close every open connection, as the browser may do when storage is cleared. */
  dropConnection: () => void
  /** Tell every open connection that a newer schema wants to open, as another tab's upgrade does. */
  versionChange: () => void
  /** How many connections are open: opened and not closed. */
  openConnections: () => number
}

type Handler = ((event: unknown) => void) | null

interface RequestState {
  result: unknown
  error: DOMException | null
  onsuccess: Handler
  onerror: Handler
}

interface OpenState extends RequestState {
  onupgradeneeded: Handler
  onblocked: Handler
}

interface TransactionState {
  error: DOMException | null
  oncomplete: Handler
  onerror: Handler
  onabort: Handler
}

interface Fault {
  readonly operation: FaultOperation
  readonly errorName: string
  skip: number
}

interface StoreState {
  readonly keyPath: string
  readonly data: Map<string, unknown>
}

interface DbState {
  version: number
  readonly stores: Map<string, StoreState>
}

interface ConnectionState {
  closed: boolean
  onversionchange: Handler
}

const DELETED = Symbol('deleted')

function unsupported(member: string): Error {
  return new Error(`memory-idb: unsupported operation ${member}`)
}

/** Allow only the named reads and writes. Anything else throws. */
function restrict<T extends object>(label: string, target: T, readable: readonly string[], writable: readonly string[]): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then') return Reflect.get(object, property, receiver) as unknown
      if (!readable.includes(property)) throw unsupported(`${label}.${property}`)
      const value = Reflect.get(object, property, object) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(object) : value
    },
    set(object, property, value) {
      if (typeof property === 'symbol' || !writable.includes(property)) throw unsupported(`${label}.${String(property)}`)
      return Reflect.set(object, property, value, object)
    },
  })
}

function fire(handler: Handler, target: unknown): void {
  handler?.({target})
}

export function createMemoryIdb(): MemoryIdb {
  const databases = new Map<string, DbState>()
  const operations: string[] = []
  const faults: Fault[] = []
  const commitHooks: ((live: Record<string, unknown>[]) => void)[] = []
  const connections: ConnectionState[] = []
  let openMode: OpenMode = 'ok'

  const used = (name: string): void => {
    operations.push(name)
  }

  const allValues = (): Record<string, unknown>[] =>
    [...databases.values()].flatMap(db => [...db.stores.values()].flatMap(store => [...store.data.values()])) as Record<string, unknown>[]

  function takeFault(operation: FaultOperation): Fault | null {
    const index = faults.findIndex(fault => fault.operation === operation)
    const fault = faults[index]
    if (fault === undefined) return null
    if (fault.skip > 0) {
      fault.skip -= 1
      return null
    }
    faults.splice(index, 1)
    return fault
  }

  function keyOf(store: StoreState, value: unknown): string {
    const key = (value as Record<string, unknown> | null)?.[store.keyPath]
    if (typeof key !== 'string') throw new DOMException('The key path yields no valid key.', 'DataError')
    return key
  }

  function createTransaction(db: DbState, storeNames: readonly string[], mode: string) {
    const state: TransactionState = {error: null, oncomplete: null, onerror: null, onabort: null}
    const staged: {store: StoreState; key: string; value: unknown}[] = []
    let pending = 0
    let finished = false
    let failure: string | null = null

    const finish = (): void => {
      if (finished || pending > 0) return
      finished = true
      if (failure !== null) {
        state.error = new DOMException('The transaction was aborted.', failure)
        fire(state.onabort, tx)
        return
      }
      for (const write of staged) {
        if (write.value === DELETED) write.store.data.delete(write.key)
        else write.store.data.set(write.key, write.value)
      }
      if (staged.length > 0) commitHooks.shift()?.(allValues())
      fire(state.oncomplete, tx)
    }

    const abortWith = (error: DOMException): void => {
      failure = error.name
      state.error = error
      fire(state.onerror, tx)
    }

    const schedule = (run: () => unknown, operation: FaultOperation, readonly: boolean): IDBRequest => {
      if (finished) throw new DOMException('The transaction has finished.', 'TransactionInactiveError')
      if (!readonly && mode !== 'readwrite') throw new DOMException('The transaction is read-only.', 'ReadOnlyError')
      const request: RequestState = {result: undefined, error: null, onsuccess: null, onerror: null}
      const proxy = restrict('request', request, ['result', 'error', 'onsuccess', 'onerror'], ['onsuccess', 'onerror'])
      pending += 1
      queueMicrotask(() => {
        const fault = takeFault(operation)
        if (fault !== null) {
          // A failed request errors and aborts its transaction. It never succeeds, and a failed write is not applied.
          request.error = new DOMException('The request failed.', fault.errorName)
          fire(request.onerror, proxy)
          abortWith(request.error)
        } else {
          request.result = run()
          fire(request.onsuccess, proxy)
        }
        pending -= 1
        if (pending === 0) queueMicrotask(finish)
      })
      return proxy as unknown as IDBRequest
    }

    const lookup = (store: StoreState, key: string): unknown => {
      for (let index = staged.length - 1; index >= 0; index -= 1) {
        const write = staged[index]
        if (write !== undefined && write.store === store && write.key === key) {
          return write.value === DELETED ? undefined : write.value
        }
      }
      return store.data.get(key)
    }

    const objectStore = (name: string) => {
      used('objectStore')
      const store = db.stores.get(name)
      if (store === undefined) throw new DOMException(`The object store ${name} was not found.`, 'NotFoundError')
      return restrict(
        'objectStore',
        {
          get: (key: string) => {
            used('get')
            return schedule(() => structuredClone(lookup(store, key)), 'get', true)
          },
          getAll: () => {
            used('getAll')
            return schedule(
              () => [...store.data.keys()].sort().map(key => structuredClone(lookup(store, key))),
              'getAll',
              true,
            )
          },
          put: (value: unknown) => {
            used('put')
            const key = keyOf(store, value)
            const copy = structuredClone(value)
            return schedule(() => {
              staged.push({store, key, value: copy})
              return key
            }, 'put', false)
          },
          delete: (key: string) => {
            used('delete')
            return schedule(() => {
              staged.push({store, key, value: DELETED})
              return undefined
            }, 'delete', false)
          },
        },
        ['get', 'getAll', 'put', 'delete'],
        [],
      ) as unknown as IDBObjectStore
    }

    const tx = restrict(
      'transaction',
      Object.assign(state, {objectStore}),
      ['objectStore', 'error', 'oncomplete', 'onerror', 'onabort'],
      ['oncomplete', 'onerror', 'onabort'],
    )
    for (const name of storeNames) {
      if (!db.stores.has(name)) throw new DOMException(`The object store ${name} was not found.`, 'NotFoundError')
    }
    // A transaction that never gets a request still completes.
    queueMicrotask(finish)
    return tx as unknown as IDBTransaction
  }

  function openDatabase(name: string, version: number): IDBOpenDBRequest {
    used('open')
    if (openMode === 'throw') throw new DOMException('IndexedDB is not allowed here.', 'SecurityError')

    const request: OpenState = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    }
    const proxy = restrict(
      'openRequest',
      request,
      ['result', 'error', 'onsuccess', 'onerror', 'onupgradeneeded', 'onblocked'],
      ['onsuccess', 'onerror', 'onupgradeneeded', 'onblocked'],
    )

    const proceed = (): void => {
      let db = databases.get(name)
      const upgrading = db === undefined || db.version < version
      if (db === undefined) {
        db = {version, stores: new Map()}
        databases.set(name, db)
      } else if (upgrading) {
        db.version = version
      }
      const state = db

      // Each open is its own connection, so closing one does not close the others.
      const connection: ConnectionState = {closed: false, onversionchange: null}
      connections.push(connection)

      const database = restrict(
        'database',
        Object.assign(connection, {
          createObjectStore: (storeName: string, options: {keyPath: string}) => {
            used('createObjectStore')
            state.stores.set(storeName, {keyPath: options.keyPath, data: new Map()})
            return undefined
          },
          transaction: (storeNames: string | string[], mode?: string) => {
            used('transaction')
            if (connection.closed) throw new DOMException('The database connection is closing.', 'InvalidStateError')
            return createTransaction(state, Array.isArray(storeNames) ? storeNames : [storeNames], mode ?? 'readonly')
          },
          close: () => {
            used('close')
            connection.closed = true
          },
        }),
        ['createObjectStore', 'transaction', 'close', 'onversionchange'],
        ['onversionchange'],
      )
      request.result = database
      if (upgrading) fire(request.onupgradeneeded, proxy)
      fire(request.onsuccess, proxy)
    }

    queueMicrotask(() => {
      if (openMode === 'hang') return
      if (openMode === 'blocked') {
        fire(request.onblocked, proxy)
        return
      }
      if (openMode === 'error') {
        request.error = new DOMException('The database could not be opened.', 'UnknownError')
        fire(request.onerror, proxy)
        return
      }
      if (openMode === 'blocked-then-ok') {
        // The open is queued behind another connection and goes through once that one closes.
        fire(request.onblocked, proxy)
        queueMicrotask(proceed)
        return
      }
      proceed()
    })
    return proxy as unknown as IDBOpenDBRequest
  }

  const factory = restrict('factory', {open: openDatabase}, ['open'], []) as unknown as IDBFactory

  return {
    factory,
    get openMode() {
      return openMode
    },
    set openMode(mode: OpenMode) {
      openMode = mode
    },
    operations,
    records: () => allValues().map(value => structuredClone(value)),
    plant: value => {
      const db = databases.get(DRAFT_DB_NAME) ?? {version: 1, stores: new Map<string, StoreState>()}
      databases.set(DRAFT_DB_NAME, db)
      const store = db.stores.get(DRAFT_STORE_NAME) ?? {keyPath: 'pageId', data: new Map<string, unknown>()}
      db.stores.set(DRAFT_STORE_NAME, store)
      store.data.set(keyOf(store, value), structuredClone(value))
    },
    failNext: (operation, errorName, options) => {
      faults.push({operation, errorName, skip: options?.skip ?? 0})
    },
    afterNextCommit: change => {
      commitHooks.push(change)
    },
    dropConnection: () => {
      for (const connection of connections) connection.closed = true
    },
    versionChange: () => {
      for (const connection of connections) {
        if (!connection.closed) fire(connection.onversionchange, connection)
      }
    },
    openConnections: () => connections.filter(connection => !connection.closed).length,
  }
}
