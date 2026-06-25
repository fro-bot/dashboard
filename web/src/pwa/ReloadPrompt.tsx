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
      role="alert"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'var(--space-4)',
        right: 'var(--space-4)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-accent)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3) var(--space-4)',
        boxShadow: 'var(--shadow-sm)',
        fontSize: 'var(--text-body-sm)',
        color: 'var(--color-text)',
        maxWidth: '20rem',
      }}
    >
      <span style={{flex: 1}}>New version available</span>
      <button
        type="button"
        data-testid="reload-prompt-refresh"
        onClick={() => {
          // No args — the bool arg is a deprecated no-op in vite-plugin-pwa v1.
          updateServiceWorker()
        }}
        style={{
          padding: 'var(--space-1) var(--space-3)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-accent)',
          backgroundColor: 'var(--color-accent)',
          color: 'var(--color-bg)',
          fontSize: 'var(--text-label)',
          fontWeight: 600,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        Refresh
      </button>
      <button
        type="button"
        data-testid="reload-prompt-dismiss"
        aria-label="Dismiss update notification"
        onClick={() => setNeedRefresh(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '1.5rem',
          height: '1.5rem',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--color-border)',
          backgroundColor: 'transparent',
          color: 'var(--color-text-muted)',
          cursor: 'pointer',
          fontSize: 'var(--text-label)',
          flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>
  )
}
