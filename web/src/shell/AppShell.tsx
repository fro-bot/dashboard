/**
 * AppShell — responsive nav frame + content slot.
 *
 * Layout:
 *   - Mobile (<md): stacked header + scrollable main
 *   - Tablet (md+): same, header gains more horizontal padding
 *   - Desktop (lg+): wider max-width container
 *
 * Theme: dark by default ([data-theme] on <html>). Toggle button flips
 * between "dark" and "light" without any Radix primitive — a plain <button>
 * is sufficient for this single-operator app surface.
 *
 * All colors come from CSS vars (tokens.css). No inline hex.
 */

import {type ReactNode, useCallback, useEffect, useRef, useState} from 'react'
import {triggerLogoutAbort} from '../push/logout-abort.ts'
import {buildPushClient, unsubscribeOptOut} from '../push/subscribe.ts'
import {InstallPrompt} from '../pwa/InstallPrompt.tsx'
import {ReloadPrompt} from '../pwa/ReloadPrompt.tsx'
import {purgeOperatorCache} from '../pwa/logout-purge.ts'
import {Notifications} from '../views/Notifications.tsx'

/**
 * Best-effort push teardown on logout. Runs local `unsubscribe()` + Gateway
 * unsubscribe via `unsubscribeOptOut` — endpointless case is a no-op
 * (never persists the endpoint). Swallows all errors: Gateway session
 * inactivation on logout is the authoritative revocation path, so a
 * teardown failure must never block navigation to the login page.
 */
function teardownPushOnLogout(): Promise<unknown> {
  return unsubscribeOptOut({
    getLocalSubscription: () =>
      navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()),
    pushClient: buildPushClient(),
  }).catch(() => undefined)
}

// Fail-closed redirect target for any logout outcome (success or failure).
// The Gateway session cookie is HttpOnly — it cannot be cleared client-side,
// so failure paths navigate here too and rely on server-side reauth.
const AUTH_LOGIN_PATH = '/auth/login'

function redirectToLogin(): void {
  window.location.href = AUTH_LOGIN_PATH
}

type Theme = 'dark' | 'light'

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const stored = window.localStorage.getItem('fro-bot-theme')
  if (stored === 'dark' || stored === 'light') return stored
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
}

interface AppShellProps {
  children: ReactNode
  /**
   * Fixture-mode push endpoint base (e.g. '/__fixture/operator/push').
   * Undefined in production — Notifications' push client then falls back
   * to buildPushClient's default '/operator/push'.
   */
  pushEndpointBase?: string
}

export function AppShell({children, pushEndpointBase}: AppShellProps) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [loggingOut, setLoggingOut] = useState(false)
  const logoutInFlight = useRef(false)

  useEffect(() => {
    applyTheme(theme)
    window.localStorage.setItem('fro-bot-theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  /**
   * Logout: purge operator runtime caches, fetch a fresh CSRF token from the
   * gateway operator session endpoint, then POST the logout with that token.
   */
  const handleLogout = useCallback(async () => {
    // Guard against rapid double-clicks issuing duplicate CSRF/logout
    // requests. useRef gives a synchronous check (state updates are async).
    if (logoutInFlight.current) return
    logoutInFlight.current = true
    setLoggingOut(true)

    // Purge operator runtime caches before navigating away so a
    // logged-out user cannot see cached operator data offline.
    purgeOperatorCache()

    // Abort any in-flight push subscribe (e.g. started from the Notifications
    // surface) so it discards its result and never issues a dangling POST
    // after the operator has logged out.
    triggerLogoutAbort()

    try {
      const csrfRes = await fetch('/operator/session/csrf', {credentials: 'same-origin'})
      if (!csrfRes.ok) {
        redirectToLogin()
        return
      }

      const csrfBody: unknown = await csrfRes.json().catch(() => null)
      const csrfToken =
        csrfBody !== null && typeof csrfBody === 'object' && 'csrfToken' in csrfBody
          ? (csrfBody as {csrfToken: unknown}).csrfToken
          : undefined
      if (typeof csrfToken !== 'string' || csrfToken.length === 0) {
        // Malformed/missing token — fail closed rather than send a
        // logout POST with an "undefined" csrf header.
        redirectToLogin()
        return
      }

      // Best-effort push teardown runs in parallel with the logout POST.
      // Bounded by Promise.allSettled: neither its failure nor a hang can
      // block navigation — Gateway session inactivation on logout is the
      // authoritative revocation path.
      const [logoutSettled] = await Promise.allSettled([
        fetch('/operator/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {'x-csrf-token': csrfToken},
        }),
        teardownPushOnLogout(),
      ])

      if (logoutSettled.status !== 'fulfilled' || !logoutSettled.value.ok) {
        redirectToLogin()
        return
      }

      await logoutSettled.value.text().catch(() => undefined)
      redirectToLogin()
    } catch {
      // Network error — fall back to login page.
      redirectToLogin()
    }
  }, [])

  return (
    <div
      data-testid="app-shell"
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--color-bg)',
        color: 'var(--color-text)',
        fontFamily: 'var(--font-body)',
      }}
    >
      <header
        data-testid="app-nav"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          backgroundColor: 'var(--color-surface)',
          borderBottom: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div
          style={{
            maxWidth: 'var(--bp-xl)',
            margin: '0 auto',
            padding: 'var(--space-3) var(--space-4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
          }}
            className="sm:px-6 md:px-8 lg:px-10"
        >
          <a
            href="/"
            aria-label="Fro Bot Dashboard home"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              textDecoration: 'none',
              color: 'var(--color-text)',
            }}
          >
            <img
              src="/icon-192.svg"
              alt=""
              aria-hidden="true"
              width="28"
              height="28"
              style={{display: 'block', borderRadius: 'var(--radius-full)'}}
            />
            <span
              style={{
                fontSize: 'var(--text-body)',
                fontWeight: 700,
                letterSpacing: 'var(--tracking-heading)',
                color: 'var(--color-text)',
              }}
              className="hidden sm:inline"
            >
              Fro Bot
            </span>
            <span
              style={{
                fontSize: 'var(--text-label)',
                fontFamily: 'var(--font-mono)',
                letterSpacing: 'var(--tracking-label)',
                color: 'var(--color-text-muted)',
                textTransform: 'uppercase',
              }}
              className="hidden md:inline"
            >
              Dashboard
            </span>
          </a>

          <nav
            aria-label="Primary navigation"
            style={{display: 'flex', alignItems: 'center', gap: 'var(--space-2)'}}
          >
            <InstallPrompt />

            <button
              type="button"
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              data-testid="theme-toggle"
              onClick={toggleTheme}
              className="flex items-center justify-center w-8 h-8 rounded-md border border-border bg-transparent text-muted cursor-pointer transition-colors duration-fast ease-standard hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {theme === 'dark' ? (
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="8" y1="1" x2="8" y2="3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="8" y1="13" x2="8" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="1" y1="8" x2="3" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="13" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="2.93" y1="2.93" x2="4.34" y2="4.34" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="11.66" y1="11.66" x2="13.07" y2="13.07" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="2.93" y1="13.07" x2="4.34" y2="11.66" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="11.66" y1="4.34" x2="13.07" y2="2.93" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              ) : (
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>

            <button
              type="button"
              aria-label="Log out"
              data-testid="logout-button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="flex items-center justify-center w-8 h-8 rounded-md border border-border bg-transparent text-muted cursor-pointer transition-colors duration-fast ease-standard hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M10 11l3-3-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="13" y1="8" x2="6" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </nav>
        </div>
      </header>

      <main
        data-testid="app-content"
        style={{
          flex: 1,
          width: '100%',
          maxWidth: 'var(--bp-xl)',
          margin: '0 auto',
          padding: 'var(--space-6) var(--space-4)',
        }}
        className="sm:px-6 md:px-8 lg:px-10"
      >
        <Notifications pushEndpointBase={pushEndpointBase} />
        {children}
      </main>

      <ReloadPrompt />
    </div>
  )
}
