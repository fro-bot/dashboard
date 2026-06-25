/**
 * InstallPrompt — custom in-app install affordance.
 *
 * Captures the browser's beforeinstallprompt event (which fires when the PWA
 * is installable but not yet installed), stashes it, and shows an "Install"
 * button. Clicking the button calls the stashed event's prompt() method to
 * trigger the native install dialog.
 *
 * The control is hidden once the app is installed (appinstalled event) or
 * after the user has been prompted (to avoid re-prompting on the same session).
 * Dismiss state is persisted to localStorage so the prompt doesn't reappear
 * on reload after the user explicitly dismisses it.
 *
 * Browser-only: all window/document access is guarded for SSR safety.
 */

import {useEffect, useState} from 'react'

/** Minimal interface for the BeforeInstallPromptEvent (not in standard TS lib). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
}

const DISMISS_KEY = 'fro-bot-install-dismissed'

function isDismissed(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(DISMISS_KEY) === '1'
}

export function InstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [dismissed, setDismissed] = useState<boolean>(isDismissed)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleBeforeInstallPrompt = (e: Event) => {
      // Prevent the browser's default mini-infobar from appearing.
      e.preventDefault()
      setPromptEvent(e as BeforeInstallPromptEvent)
    }

    const handleAppInstalled = () => {
      // Hide the control once the app is installed.
      setPromptEvent(null)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  // Don't render if: no prompt event captured, already dismissed, or already installed.
  if (!promptEvent || dismissed) return null

  const handleInstall = async () => {
    await promptEvent.prompt()
    // Hide after prompting — don't re-prompt in the same session.
    setPromptEvent(null)
  }

  const handleDismiss = () => {
    setDismissed(true)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DISMISS_KEY, '1')
    }
  }

  return (
    <div
      data-testid="install-prompt"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
      }}
    >
      <button
        type="button"
        data-testid="install-prompt-button"
        onClick={handleInstall}
        className="flex items-center gap-1 px-3 py-1 rounded-md border border-border bg-transparent text-muted text-label font-semibold cursor-pointer whitespace-nowrap transition-colors duration-fast ease-standard hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 1v7M3 5l3 3 3-3M1 10h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Install
      </button>
      <button
        type="button"
        data-testid="install-prompt-dismiss"
        aria-label="Dismiss install prompt"
        onClick={handleDismiss}
        className="flex items-center justify-center w-5 h-5 rounded-sm border-none bg-transparent text-muted cursor-pointer shrink-0 transition-colors duration-fast ease-standard hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        style={{ fontSize: '0.65rem' }}
      >
        ✕
      </button>
    </div>
  )
}
