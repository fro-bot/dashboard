/**
 * logout-purge tests — verifies the page-side SW cache cleanup.
 *
 * Mocks caches.delete and navigator.serviceWorker.controller.postMessage
 * to assert both purge paths are called with the correct arguments.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {purgeOperatorCache} from './logout-purge.ts'
import {OPERATOR_RUNTIME_CACHE} from './cache-names.ts'

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

  it('does NOT call caches.delete with the old monitoring-v1 cache name', () => {
    purgeOperatorCache()
    expect(mockCachesDelete).not.toHaveBeenCalledWith('monitoring-v1')
  })

  it('posts PURGE_RUNTIME to the SW controller', () => {
    purgeOperatorCache()
    expect(mockPostMessage).toHaveBeenCalledWith({type: 'PURGE_RUNTIME'})
  })

  it('calls both purge paths in a single invocation', () => {
    purgeOperatorCache()
    expect(mockCachesDelete).toHaveBeenCalledTimes(1)
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
