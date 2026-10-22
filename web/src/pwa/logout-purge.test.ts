/**
 * logout-purge tests — verifies the page-side SW cache cleanup.
 *
 * Mocks caches.delete and navigator.serviceWorker.controller.postMessage
 * to assert both purge paths are called with the correct arguments.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {purgeOperatorCache} from './logout-purge.ts'
import {OPERATOR_RUNTIME_CACHE} from './cache-names.ts'
import {createDraftStore} from '../wiki/drafts.ts'
import {createMemoryIdb} from '../wiki/test-support/memory-idb.ts'

describe('purgeOperatorCache', () => {
  const mockCachesDelete = vi.fn().mockResolvedValue(true)
  const mockPostMessage = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()

    // Stub caches.delete
    Object.defineProperty(globalThis, 'caches', {
      writable: true,
      configurable: true,
      value: {delete: mockCachesDelete},
    })

    // Stub navigator.serviceWorker.controller.postMessage
    Object.defineProperty(navigator, 'serviceWorker', {
      writable: true,
      configurable: true,
      value: {
        controller: {postMessage: mockPostMessage},
      },
    })
  })

  it('calls caches.delete with the operator runtime cache name', () => {
    purgeOperatorCache()
    expect(mockCachesDelete).toHaveBeenCalledWith(OPERATOR_RUNTIME_CACHE)
  })

  it('LEGACY PURGE: also calls caches.delete with the old monitoring-v1 cache name', () => {
    purgeOperatorCache()
    expect(mockCachesDelete).toHaveBeenCalledWith('monitoring-v1')
  })

  it('posts PURGE_RUNTIME to the SW controller', () => {
    purgeOperatorCache()
    expect(mockPostMessage).toHaveBeenCalledWith({type: 'PURGE_RUNTIME'})
  })

  it('calls caches.delete twice (operator-runtime-v1 + legacy monitoring-v1) in a single invocation', () => {
    purgeOperatorCache()
    expect(mockCachesDelete).toHaveBeenCalledTimes(2)
    expect(mockPostMessage).toHaveBeenCalledTimes(1)
  })

  it('does not throw when caches is undefined', () => {
    Object.defineProperty(globalThis, 'caches', {
      writable: true,
      configurable: true,
      value: undefined,
    })
    expect(() => purgeOperatorCache()).not.toThrow()
  })

  it('does not throw when navigator.serviceWorker is undefined', () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      writable: true,
      configurable: true,
      value: undefined,
    })
    expect(() => purgeOperatorCache()).not.toThrow()
  })

  it('does not throw when navigator.serviceWorker.controller is null', () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      writable: true,
      configurable: true,
      value: {controller: null},
    })
    expect(() => purgeOperatorCache()).not.toThrow()
  })
})

describe('purgeOperatorCache and drafts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('leaves every draft intact: drafts survive sign-out', async () => {
    Object.defineProperty(globalThis, 'caches', {
      writable: true,
      configurable: true,
      value: {delete: vi.fn().mockResolvedValue(true)},
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      writable: true,
      configurable: true,
      value: {controller: {postMessage: vi.fn()}},
    })

    const idb = createMemoryIdb()
    // Global too, so a purge that reached for `indexedDB` would hit the fake and throw.
    vi.stubGlobal('indexedDB', idb.factory)
    const store = createDraftStore({indexedDB: idb.factory})
    const draft = {
      pageId: 'repos.acme--alpha',
      baseBlobSha: 'blob-1',
      baseText: 'base',
      correctionsBase: {entries: [], digest: 'a'.repeat(64)},
      draftText: 'unsaved work',
      pending: null,
    }
    await store.putDraft(draft)
    await store.putDraft({...draft, pageId: 'topics.other'})
    const operationsBefore = idb.operations.length

    purgeOperatorCache()
    await Promise.resolve()

    // Logout never opens or deletes the draft database.
    expect(idb.operations).toHaveLength(operationsBefore)
    const listed = await store.listDrafts()
    expect(listed.ok && listed.value.drafts.map(d => d.draftText)).toEqual(['unsaved work', 'unsaved work'])
    expect(listed.ok && listed.value.unreadable).toEqual([])
  })
})
