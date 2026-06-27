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

import {type ReactNode, useCallback, useEffect, useState} from 'react'
import {InstallPrompt} from '../pwa/InstallPrompt.tsx'
import {ReloadPrompt} from '../pwa/ReloadPrompt.tsx'
import {purgeOperatorCache} from '../pwa/logout-purge.ts'

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
}

export function AppShell({children}: AppShellProps) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    applyTheme(theme)
    window.localStorage.setItem('fro-bot-theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  /**
   * Logout: purge operator runtime caches then submit the logout form POST.
   * The CSRF token is fetched from /auth/logout-csrf (authenticated endpoint)
   * immediately before submission so it is always fresh.
   */
  const handleLogout = useCallback(async () => {
    // Purge operator runtime caches before navigating away so a
    // logged-out user cannot see cached operator data offline.
    purgeOperatorCache()

    try {
      const res = await fetch('/auth/logout-csrf', {credentials: 'same-origin'})
      if (!res.ok) {
        // If we can't get the CSRF token, fall back to navigating to login.
        window.location.href = '/auth/login'
        return
      }
      const {csrfToken} = (await res.json()) as {csrfToken: string}

      // Submit a form POST to /auth/logout with the CSRF token.
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = '/auth/logout'
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = 'csrf_token'
      input.value = csrfToken
      form.appendChild(input)
      document.body.appendChild(form)
      form.submit()
    } catch {
      // Network error — fall back to login page.
      window.location.href = '/auth/login'
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
              className="flex items-center justify-center w-8 h-8 rounded-md border border-border bg-transparent text-muted cursor-pointer transition-colors duration-fast ease-standard hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
        {children}
      </main>

      <ReloadPrompt />
    </div>
  )
}
