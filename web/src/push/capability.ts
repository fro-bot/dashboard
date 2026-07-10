/**
 * Pure browser support / iOS-installed gate / permission read.
 *
 * NEVER calls `Notification.requestPermission()` — this module is read-only.
 * In particular, it must never be used to justify calling `requestPermission`
 * from a non-installed iOS Safari tab (Web Push there requires a Home Screen
 * install first); `needsInstall` exists precisely to let callers gate on that.
 *
 * Web-local — no import from `src/`.
 */

export interface PushSupport {
  readonly supported: boolean
  readonly needsInstall: boolean
}

/**
 * Detect iOS/iPadOS, including the desktop-UA iPad tiebreak: modern iPadOS
 * Safari reports a Mac-like `navigator.platform`/`userAgent`, so touch
 * support is the signal that distinguishes an iPad from a real desktop Mac.
 */
function isIOS(nav: Pick<Navigator, 'platform' | 'userAgent'>, doc: Pick<Document, keyof Document> | undefined): boolean {
  if (/iP(hone|ad|od)/.test(nav.platform)) return true
  if (nav.userAgent.includes('Mac') && doc !== undefined && 'ontouchend' in doc) return true
  return false
}

/**
 * Detect an installed/standalone PWA context: `display-mode: standalone`
 * media query (most engines) or `navigator.standalone` (legacy iOS Safari).
 */
function isStandalone(
  win: Pick<Window, 'matchMedia'> | undefined,
  nav: {readonly standalone?: boolean},
): boolean {
  if (win !== undefined && typeof win.matchMedia === 'function') {
    try {
      if (win.matchMedia('(display-mode: standalone)').matches) return true
    } catch {
      // matchMedia can throw in odd embed contexts — treat as not-standalone.
    }
  }
  return nav.standalone === true
}

/**
 * Pure support/gate check. Requires `serviceWorker`/`PushManager`/`Notification`
 * presence AND (not iOS OR installed-standalone). `needsInstall` is true only
 * for iOS in a non-installed context — the case where the platform APIs may
 * exist but Web Push is unavailable until the operator installs the PWA.
 */
export function getPushSupport(): PushSupport {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return {supported: false, needsInstall: false}
  }

  const hasApis =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

  const ios = isIOS(navigator, typeof document === 'undefined' ? undefined : document)
  const standalone = isStandalone(window, navigator as unknown as {readonly standalone?: boolean})
  const needsInstall = ios && standalone === false

  return {
    supported: hasApis && needsInstall === false,
    needsInstall,
  }
}

/** Read the current `Notification.permission`. Never requests permission. */
export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}
