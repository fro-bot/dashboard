import {useCallback, useEffect, useRef, useState} from 'react'
import {getPushSupport} from '../push/capability.ts'
import {getLogoutAbortSignal} from '../push/logout-abort.ts'
import {
  INITIAL_RECONCILE_SWEEP_CACHE,
  resubscribeStaleKey,
  runReconcileSweep,
  subscribeOptIn,
  unsubscribeOptOut,
} from '../push/subscribe.ts'
import type {MinimalServiceWorkerRegistration, ReconcileSweepCache} from '../push/subscribe.ts'
import {buildPushClient} from '../push/subscribe.ts'
import {getNotificationCopy} from './notifications-copy.ts'
import type {NotificationUiState} from './notifications-copy.ts'

const DISMISS_SETTINGS_KEY = 'fro-bot-notifications-dismissed'

function readPushEnabledMeta(): boolean {
  if (typeof document === 'undefined') return false
  const meta = document.querySelector('meta[name="push-enabled"]')
  return meta?.getAttribute('content') === 'true'
}

interface NotificationsProps {
  /**
   * Fixture-mode push endpoint base (e.g. '/__fixture/operator/push').
   * Read once at first pushClient construction — stable for the page
   * lifetime, so a later change to this prop won't rebuild the client.
   */
  pushEndpointBase?: string
}

export function Notifications({pushEndpointBase}: NotificationsProps = {}) {
  const [metaEnabled] = useState<boolean>(readPushEnabledMeta)
  const [currentUiState, setCurrentUiState] = useState<NotificationUiState>('not-requested')
  const [inFlight, setInFlight] = useState(false)
  const [isCardDismissed, setIsCardDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(DISMISS_SETTINGS_KEY) === '1'
  })

  const cacheRef = useRef<ReconcileSweepCache>(INITIAL_RECONCILE_SWEEP_CACHE)
  const ctaRef = useRef<HTMLButtonElement>(null)
  const headlineRef = useRef<HTMLHeadingElement>(null)

  const pushClientRef = useRef<ReturnType<typeof buildPushClient> | null>(null)
  if (pushClientRef.current === null) {
    pushClientRef.current = buildPushClient(
      pushEndpointBase !== undefined ? {endpointBase: pushEndpointBase} : undefined,
    )
  }
  const pushClient = pushClientRef.current

  const enableInFlightRef = useRef(false)
  const disableInFlightRef = useRef(false)
  const sweepDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Run pure sweep and execute reconcile actions
  const runSweep = useCallback(async () => {
    // Immediate capability checks before sweep to avoid starting service workers on unsupported platforms
    const support = getPushSupport()
    if (support.needsInstall) {
      setCurrentUiState('ios-not-installed')
      return
    }
    if (support.supported === false) {
      setCurrentUiState('unsupported')
      return
    }

    const result = await runReconcileSweep(
      {
        getLocalSubscription: () =>
          navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()),
        pushClient,
      },
      cacheRef.current,
    )

    if (result.skipped) return

    cacheRef.current = result.nextCache

    if (result.action && result.action !== 'none') {
      try {
        if (result.action === 'register') {
          const outcome = await subscribeOptIn({
            serviceWorkerReady: () => navigator.serviceWorker.ready as unknown as Promise<MinimalServiceWorkerRegistration>,
            requestPermission: () => Notification.requestPermission(),
            pushClient,
            signal: getLogoutAbortSignal(),
          })
          if (outcome.kind === 'subscribed') {
            setCurrentUiState('subscribed')
          } else if (outcome.kind === 'subscribe-failed') {
            setCurrentUiState('subscribe-failed')
          } else if (outcome.kind === 'sw-not-ready') {
            setCurrentUiState('sw-not-ready')
          } else if (outcome.kind === 'dismissed') {
            setCurrentUiState('dismissed')
          }
        } else if (result.action === 'resubscribe') {
          const outcome = await resubscribeStaleKey({
            serviceWorkerReady: () => navigator.serviceWorker.ready as unknown as Promise<MinimalServiceWorkerRegistration>,
            requestPermission: () => Notification.requestPermission(),
            pushClient,
            signal: getLogoutAbortSignal(),
          })
          if (outcome.kind === 'subscribed') {
            setCurrentUiState('subscribed')
          } else if (outcome.kind === 'subscribe-failed') {
            setCurrentUiState('subscribe-failed')
          } else if (outcome.kind === 'sw-not-ready') {
            setCurrentUiState('sw-not-ready')
          }
        } else if (result.action === 'cleanup') {
          const reg = await navigator.serviceWorker.ready
          const sub = await reg.pushManager.getSubscription()
          if (sub) {
            await sub.unsubscribe().catch(() => false)
          }
          // Honor the state reconcile derived — `cleanup` fires for
          // push_disabled (→ unsupported), denied-without-subscription
          // (→ denied), and granted-but-drifted (→ not-requested). Hardcoding
          // one of them mislabels the other two (e.g. a blocked browser showing
          // "Unsupported" instead of "Blocked").
          setCurrentUiState(result.uiState ?? 'not-requested')
        } else if (result.action === 'cleanup-and-unsubscribe') {
          await unsubscribeOptOut({
            getLocalSubscription: () =>
              navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()),
            pushClient,
          })
          setCurrentUiState(result.uiState ?? 'not-requested')
        }
      } catch {
        setCurrentUiState('subscribe-failed')
      }
    } else if (result.uiState) {
      if (result.uiState === 'subscribed') {
        setCurrentUiState('subscribed')
      } else if (result.uiState === 'denied') {
        setCurrentUiState('denied')
      } else if (result.uiState === 'unsupported') {
        setCurrentUiState('unsupported')
      } else if (result.uiState === 'not-requested') {
        setCurrentUiState((prev) => {
          if (prev === 'dismissed' || prev === 'subscribe-failed' || prev === 'sw-not-ready') {
            return prev
          }
          return 'not-requested'
        })
      }
    }
  }, [pushClient])

  // Initial and reactive sweep listeners
  useEffect(() => {
    if (!metaEnabled) return

    void runSweep()

    // visibilitychange and focus both fire on tab activation — debounce so
    // the pair coalesces into a single sweep instead of running it twice.
    const scheduleSweep = () => {
      if (sweepDebounceRef.current !== null) {
        clearTimeout(sweepDebounceRef.current)
      }
      sweepDebounceRef.current = setTimeout(() => {
        sweepDebounceRef.current = null
        void runSweep()
      }, 250)
    }

    window.addEventListener('visibilitychange', scheduleSweep)
    window.addEventListener('focus', scheduleSweep)

    const handleMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'PUSH_SUBSCRIPTION_CHANGE') {
        void runSweep()
      }
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleMessage)
    }

    return () => {
      window.removeEventListener('visibilitychange', scheduleSweep)
      window.removeEventListener('focus', scheduleSweep)
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleMessage)
      }
      if (sweepDebounceRef.current !== null) {
        clearTimeout(sweepDebounceRef.current)
        sweepDebounceRef.current = null
      }
    }
  }, [metaEnabled, runSweep])

  // iOS standalone app installation listener
  useEffect(() => {
    if (!metaEnabled) return

    const handleAppInstalled = () => {
      const support = getPushSupport()
      if (!support.needsInstall && support.supported) {
        setCurrentUiState('not-requested')
        void runSweep()
      }
    }

    window.addEventListener('appinstalled', handleAppInstalled)
    return () => window.removeEventListener('appinstalled', handleAppInstalled)
  }, [metaEnabled, runSweep])

  // A11y Focus Management: Move focus to the primary CTA or the status headline on transitions
  useEffect(() => {
    if (ctaRef.current) {
      ctaRef.current.focus()
    } else if (headlineRef.current) {
      headlineRef.current.focus()
    }
  }, [currentUiState])

  if (!metaEnabled || isCardDismissed) {
    return null
  }

  const copy = getNotificationCopy(currentUiState)

  const handleEnable = async () => {
    if (enableInFlightRef.current) return
    enableInFlightRef.current = true
    setInFlight(true)
    try {
      const outcome = await subscribeOptIn({
        serviceWorkerReady: () => navigator.serviceWorker.ready as unknown as Promise<MinimalServiceWorkerRegistration>,
        requestPermission: () => Notification.requestPermission(),
        pushClient,
        signal: getLogoutAbortSignal(),
      })

      if (outcome.kind === 'subscribed') {
        setCurrentUiState('subscribed')
      } else if (outcome.kind === 'subscribe-failed') {
        setCurrentUiState('subscribe-failed')
      } else if (outcome.kind === 'sw-not-ready') {
        setCurrentUiState('sw-not-ready')
      } else if (outcome.kind === 'dismissed') {
        setCurrentUiState('dismissed')
      } else if (outcome.kind === 'denied') {
        setCurrentUiState('denied')
      }
    } finally {
      setInFlight(false)
      enableInFlightRef.current = false
    }
  }

  const handleDisable = async () => {
    if (disableInFlightRef.current) return
    disableInFlightRef.current = true
    setInFlight(true)
    try {
      await unsubscribeOptOut({
        getLocalSubscription: () =>
          navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()),
        pushClient,
      })
      setCurrentUiState('not-requested')
    } finally {
      setInFlight(false)
      disableInFlightRef.current = false
    }
  }

  const handleDismissCard = () => {
    setIsCardDismissed(true)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DISMISS_SETTINGS_KEY, '1')
    }
  }

  // Choose accent coloring and styling for container and labels
  const containerBorderClass =
    currentUiState === 'subscribed'
      ? 'border-success'
      : currentUiState === 'denied' || currentUiState === 'subscribe-failed'
        ? 'border-error'
        : 'border-border'

  const showCta = copy.ctaText !== null

  return (
    <div
      data-testid="notifications-settings"
      className={`relative w-full p-4 mb-6 rounded-lg border ${containerBorderClass} bg-surface transition-colors duration-normal ease-standard`}
    >
      {/* Dismiss button for the notifications settings block */}
      {(currentUiState === 'not-requested' || currentUiState === 'dismissed') && (
        <button
          type="button"
          data-testid="notifications-card-dismiss"
          aria-label="Dismiss notification settings"
          onClick={handleDismissCard}
          className="absolute top-4 right-4 flex items-center justify-center w-6 h-6 rounded-md border border-border bg-transparent text-text-muted cursor-pointer transition-colors duration-fast hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          ✕
        </button>
      )}

      <div className="flex flex-col gap-3 pr-8">
        <div>
          <h2
            ref={headlineRef}
            tabIndex={-1}
            data-testid="notifications-headline"
            className="text-h4 font-display font-semibold text-text tracking-heading focus:outline-none"
          >
            {copy.headline}
          </h2>
          <p
            data-testid="notifications-detail"
            className="mt-1 text-body-sm text-text-muted leading-relaxed"
          >
            {copy.detail}
          </p>
        </div>

        {copy.recoveryHint.length > 0 && (
          <p
            data-testid="notifications-recovery"
            className="text-label font-mono text-highlight uppercase tracking-label"
          >
            {copy.recoveryHint}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 mt-1">
          {showCta && (
            <button
              type="button"
              ref={ctaRef}
              disabled={inFlight}
              data-testid="notifications-cta"
              onClick={currentUiState === 'subscribed' ? handleDisable : handleEnable}
              className={`px-4 py-2 rounded-md font-semibold text-body-sm whitespace-nowrap cursor-pointer transition-all duration-fast focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 disabled:cursor-not-allowed ${
                currentUiState === 'subscribed'
                  ? 'border border-border bg-transparent text-text hover:border-cta hover:text-cta shadow-glow-magenta'
                  : 'bg-accent text-frobot-void hover:bg-frobot-cyan-bright shadow-glow'
              }`}
            >
              {inFlight ? 'Processing…' : copy.ctaText}
            </button>
          )}

          {/* ARIA-live status announcement region */}
          <div
            role="status"
            aria-live="polite"
            data-testid="notifications-status-announcer"
            className="sr-only"
          >
            {inFlight ? 'Updating push subscription…' : `${copy.headline}: ${copy.detail}`}
          </div>

          {/* DEV-gated synthetic push button */}
          {import.meta.env.DEV && (
            <button
              type="button"
              data-testid="synthetic-push-btn"
              onClick={() => {
                if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                  navigator.serviceWorker.controller.postMessage({
                    type: 'MOCK_SYNTHETIC_PUSH',
                    payload: {type: 'approval'},
                  })
                }
              }}
              className="px-3 py-1.5 rounded-md border border-border bg-transparent text-text-muted text-label font-mono uppercase tracking-label cursor-pointer transition-colors duration-fast hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Simulate Push
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
