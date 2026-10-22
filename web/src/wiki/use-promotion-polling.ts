/**
 * Promotion status polling after a save (KTD5).
 *
 * One read straight away with `since` set to the commit time, then one every
 * `PROMOTION_POLL_INTERVAL_MS` while the state is pending. Polling stops when the state
 * settles or is blocked, when the tab is hidden, on a failure that retrying cannot fix, and
 * when the hook is released. A hidden tab resumes on `visibilitychange`, and never reads
 * sooner than one interval after the last read.
 *
 * Status reads use their own route and do not count toward the per-operator budget that
 * saves and lookups share. This hook never reads a lookup.
 */

import {useEffect, useRef} from 'react'
import {promotionStatus, type PromotionStatus} from '../api/wiki.ts'

/** KTD5: at least 15 seconds between reads. */
export const PROMOTION_POLL_INTERVAL_MS = 15_000

/** Failures that may pass on their own. Anything else stops the polling. */
const TRANSIENT_FAILURES: ReadonlySet<string> = new Set(['unavailable', 'network', 'timeout', 'rate-limited'])

export interface PromotionPollingOptions {
  readonly active: boolean
  /** The commit time. Runs created before it are ignored. */
  readonly since: string | undefined
  readonly onStatus: (status: PromotionStatus) => void
  /** A read failed. `kind` is the failure kind; the display says only that status is unavailable. */
  readonly onUnavailable: (kind: string) => void
}

function tabIsHidden(): boolean {
  return document.visibilityState === 'hidden'
}

export function usePromotionPolling({active, since, onStatus, onUnavailable}: PromotionPollingOptions): void {
  const handlers = useRef({onStatus, onUnavailable})

  useEffect(() => {
    handlers.current = {onStatus, onUnavailable}
  })

  useEffect(() => {
    if (!active) return

    let stopped = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastReadAt: number | null = null

    const clear = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }

    const schedule = (delay: number) => {
      clear()
      if (stopped || tabIsHidden()) return
      timer = setTimeout(() => {
        void read()
      }, delay)
    }

    const read = async () => {
      timer = null
      if (stopped || inFlight || tabIsHidden()) return
      inFlight = true
      lastReadAt = Date.now()
      const result = await promotionStatus(since)
      inFlight = false
      // A late answer for a released or replaced poll changes nothing.
      if (stopped) return

      if (result.ok) {
        handlers.current.onStatus(result.value)
        if (result.value.state === 'pending') schedule(PROMOTION_POLL_INTERVAL_MS)
        else stopped = true
        return
      }

      handlers.current.onUnavailable(result.error.kind)
      if (TRANSIENT_FAILURES.has(result.error.kind)) schedule(PROMOTION_POLL_INTERVAL_MS)
      else stopped = true
    }

    const onVisibilityChange = () => {
      if (stopped) return
      if (tabIsHidden()) {
        clear()
        return
      }
      if (timer !== null || inFlight) return
      schedule(lastReadAt === null ? 0 : Math.max(0, lastReadAt + PROMOTION_POLL_INTERVAL_MS - Date.now()))
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    schedule(0)

    return () => {
      stopped = true
      clear()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [active, since])
}
