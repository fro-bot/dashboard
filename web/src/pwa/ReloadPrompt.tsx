/**
 * ReloadPrompt — shows a non-intrusive banner when a new build is waiting.
 *
 * Uses vite-plugin-pwa's useRegisterSW to register the service worker and
 * detect when a new version is available. When needRefresh is true, a banner
 * appears prompting the operator to reload. Clicking "Refresh" activates the
 * waiting SW and reloads the page.
 *
 * The hourly update check (setInterval → r.update()) ensures the operator
 * sees new builds within an hour even if they leave the tab open.
 */

import {useRegisterSW} from 'virtual:pwa-register/react'

export function ReloadPrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(registration) {
      if (registration) {
        // Check for updates every hour so long-lived tabs pick up new builds.
        setInterval(() => {
          registration.update().catch(() => {
            // Ignore update check failures (offline, etc.)
          })
        }, 60 * 60 * 1000)
      }
    },
    onRegisterError(error) {
      // SW registration failure must not crash the app — it still works as a
      // plain SPA. Log for diagnostics only.
      console.error('[SW] Registration error:', error)
    },
  })

  if (!needRefresh) return null

  return (
    <div
      data-testid="reload-prompt"
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 bg-surface border border-accent rounded-md px-4 py-3 shadow-sm text-body-sm text-text max-w-[calc(100vw-2rem)] sm:max-w-xs animate-slide-in"
    >
      <span style={{flex: 1}}>New version available</span>
      <button
        type="button"
        data-testid="reload-prompt-refresh"
        onClick={() => {
          // No args — the bool arg is a deprecated no-op in vite-plugin-pwa v1.
          updateServiceWorker()
        }}
        className="px-3 py-1 rounded-md border border-accent bg-accent text-bg text-label font-semibold cursor-pointer whitespace-nowrap transition-colors duration-fast ease-standard hover:bg-accent-hover hover:border-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Refresh
      </button>
      <button
        type="button"
        data-testid="reload-prompt-dismiss"
        aria-label="Dismiss update notification"
        onClick={() => setNeedRefresh(false)}
        className="flex items-center justify-center w-6 h-6 rounded-sm border border-border bg-transparent text-muted text-label shrink-0 cursor-pointer transition-colors duration-fast ease-standard hover:text-text hover:border-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        ✕
      </button>
    </div>
  )
}
