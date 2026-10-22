import {act, renderHook} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
import * as wikiApi from '../api/wiki.ts'
import type {PromotionStatus} from '../api/wiki.ts'
import {PROMOTION_POLL_INTERVAL_MS, usePromotionPolling} from './use-promotion-polling.ts'

const pending: PromotionStatus = {state: 'pending', pr: null}
const SINCE = '2026-10-21T10:00:00Z'

type Failure = {ok: false; error: {kind: string}}
const failure = (kind: string): Failure => ({ok: false, error: {kind}})

let statusSpy: MockInstance<typeof wikiApi.promotionStatus>
let visibility: DocumentVisibilityState = 'visible'

function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility})
  statusSpy = vi.spyOn(wikiApi, 'promotionStatus').mockResolvedValue({ok: true, value: pending})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'visibilityState')
})

function mount(overrides: Partial<Parameters<typeof usePromotionPolling>[0]> = {}) {
  const onStatus = vi.fn()
  const onUnavailable = vi.fn()
  const view = renderHook(
    (props: Parameters<typeof usePromotionPolling>[0]) => {
      usePromotionPolling(props)
    },
    {initialProps: {active: true, since: SINCE, onStatus, onUnavailable, ...overrides}},
  )
  return {onStatus, onUnavailable, ...view}
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('usePromotionPolling', () => {
  it('uses an interval of at least 15 seconds', () => {
    expect(PROMOTION_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(15_000)
  })

  it('reads once straight away with `since` set to the commit time', async () => {
    const {onStatus} = mount()
    await advance(0)
    expect(statusSpy).toHaveBeenCalledTimes(1)
    expect(statusSpy).toHaveBeenCalledWith(SINCE)
    expect(onStatus).toHaveBeenCalledWith(pending)
  })

  it('does not read again before the interval elapses', async () => {
    mount()
    await advance(0)
    await advance(PROMOTION_POLL_INTERVAL_MS - 1)
    expect(statusSpy).toHaveBeenCalledTimes(1)
  })

  it('reads again once the interval elapses while the state is pending', async () => {
    mount()
    await advance(0)
    await advance(PROMOTION_POLL_INTERVAL_MS)
    expect(statusSpy).toHaveBeenCalledTimes(2)
    await advance(PROMOTION_POLL_INTERVAL_MS)
    expect(statusSpy).toHaveBeenCalledTimes(3)
  })

  it('stops when the state settles', async () => {
    statusSpy.mockResolvedValue({ok: true, value: {state: 'settled', pr: null}})
    mount()
    await advance(0)
    await advance(PROMOTION_POLL_INTERVAL_MS * 4)
    expect(statusSpy).toHaveBeenCalledTimes(1)
  })

  it('stops when the promotion is blocked', async () => {
    statusSpy.mockResolvedValue({
      ok: true,
      value: {state: 'blocked', reason: 'privacy-check', runUrl: 'https://github.com/o/r/actions/runs/1', pr: null},
    })
    mount()
    await advance(0)
    await advance(PROMOTION_POLL_INTERVAL_MS * 4)
    expect(statusSpy).toHaveBeenCalledTimes(1)
  })

  it('stops reading when the tab is hidden', async () => {
    mount()
    await advance(0)
    act(() => {
      setVisibility('hidden')
    })
    await advance(PROMOTION_POLL_INTERVAL_MS * 4)
    expect(statusSpy).toHaveBeenCalledTimes(1)
  })

  it('does not read at all while the tab starts hidden', async () => {
    visibility = 'hidden'
    mount()
    await advance(PROMOTION_POLL_INTERVAL_MS * 2)
    expect(statusSpy).not.toHaveBeenCalled()
  })

  it('picks up again when the tab is visible, never sooner than the interval after the last read', async () => {
    mount()
    await advance(0)
    await advance(5_000)
    act(() => {
      setVisibility('hidden')
    })
    await advance(1_000)
    act(() => {
      setVisibility('visible')
    })
    await advance(0)
    expect(statusSpy).toHaveBeenCalledTimes(1)

    await advance(PROMOTION_POLL_INTERVAL_MS - 6_000)
    expect(statusSpy).toHaveBeenCalledTimes(2)
  })

  it('reads at once when the tab comes back after more than the interval', async () => {
    mount()
    await advance(0)
    act(() => {
      setVisibility('hidden')
    })
    await advance(PROMOTION_POLL_INTERVAL_MS * 3)
    act(() => {
      setVisibility('visible')
    })
    await advance(0)
    expect(statusSpy).toHaveBeenCalledTimes(2)
  })

  it('does not read when inactive', async () => {
    mount({active: false})
    await advance(PROMOTION_POLL_INTERVAL_MS * 2)
    expect(statusSpy).not.toHaveBeenCalled()
  })

  it('stops on unmount, and a late answer is ignored', async () => {
    let resolve: (value: Awaited<ReturnType<typeof wikiApi.promotionStatus>>) => void = () => {}
    statusSpy.mockReturnValue(
      new Promise(r => {
        resolve = r
      }),
    )
    const {onStatus, unmount} = mount()
    await advance(0)
    unmount()
    await act(async () => {
      resolve({ok: true, value: pending})
      await Promise.resolve()
    })
    await advance(PROMOTION_POLL_INTERVAL_MS * 2)
    expect(onStatus).not.toHaveBeenCalled()
    expect(statusSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores a late answer for an earlier `since`', async () => {
    let resolveFirst: (value: Awaited<ReturnType<typeof wikiApi.promotionStatus>>) => void = () => {}
    statusSpy.mockReturnValueOnce(
      new Promise(r => {
        resolveFirst = r
      }),
    )
    const {onStatus, rerender} = mount()
    await advance(0)

    rerender({active: true, since: '2026-10-21T11:00:00Z', onStatus, onUnavailable: vi.fn()})
    await advance(0)
    onStatus.mockClear()

    await act(async () => {
      resolveFirst({ok: true, value: {state: 'settled', pr: null}})
      await Promise.resolve()
    })
    expect(onStatus).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'network', 'timeout', 'rate-limited'])(
    'a transient %s failure is reported and polling goes on',
    async kind => {
      statusSpy.mockResolvedValueOnce(failure(kind) as never)
      const {onUnavailable} = mount()
      await advance(0)
      expect(onUnavailable).toHaveBeenCalledTimes(1)
      await advance(PROMOTION_POLL_INTERVAL_MS)
      expect(statusSpy).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['session-lost', 'configuration-fault', 'forbidden', 'bad-request', 'contract-drift'])(
    'a %s failure is reported and polling stops',
    async kind => {
      statusSpy.mockResolvedValue(failure(kind) as never)
      const {onUnavailable} = mount()
      await advance(0)
      await advance(PROMOTION_POLL_INTERVAL_MS * 3)
      expect(onUnavailable).toHaveBeenCalledTimes(1)
      expect(statusSpy).toHaveBeenCalledTimes(1)
    },
  )
})
