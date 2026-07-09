/**
 * Fixed copy for the operator push notifications consent/settings surface.
 *
 * Maps each of the 8 permission/support states to human-readable, safe copy.
 *
 * Security invariants:
 * - NO raw endpoints, tokens, cookies, CSRF values, or HTTP status/error codes.
 * - NO API paths (like `/operator/*`).
 * - NO dynamic interpolation of sensitive values.
 */

export type NotificationUiState =
  | 'not-requested'
  | 'subscribed'
  | 'denied'
  | 'dismissed'
  | 'unsupported'
  | 'ios-not-installed'
  | 'sw-not-ready'
  | 'subscribe-failed'

export interface NotificationStateCopy {
  readonly headline: string
  readonly detail: string
  readonly ctaText: string | null
  readonly recoveryHint: string
}

const COPY: Record<NotificationUiState, NotificationStateCopy> = {
  'not-requested': {
    headline: 'Push Alerts',
    detail: 'Get notified of pending approvals and failed run outcomes. Sensitive keys and payloads never leave the server.',
    ctaText: 'Enable notifications',
    recoveryHint: '',
  },
  subscribed: {
    headline: 'Alerts Active',
    detail: 'Monitoring pending approvals and failed run outcomes for this device.',
    ctaText: 'Disable notifications',
    recoveryHint: '',
  },
  denied: {
    headline: 'Alerts Blocked',
    detail: 'Permission was denied at the browser level. To receive alerts, manually update site permissions in your browser settings.',
    ctaText: null,
    recoveryHint: 'Reset site permissions to resume.',
  },
  dismissed: {
    headline: 'Prompt Closed',
    detail: 'The permission request was dismissed. You can retry the setup when ready.',
    ctaText: 'Try again',
    recoveryHint: '',
  },
  unsupported: {
    headline: 'Alerts Unsupported',
    detail: 'This browser profile or environment does not support the native push and notifications engine.',
    ctaText: null,
    recoveryHint: 'Use a compatible browser or enable native system notifications.',
  },
  'ios-not-installed': {
    headline: 'Installation Required',
    detail: 'Web Push on iOS requires launching this dashboard as an installed Home Screen app.',
    ctaText: 'Install App',
    recoveryHint: 'Open the share menu and select "Add to Home Screen" to install.',
  },
  'sw-not-ready': {
    headline: 'Initializing background sync',
    detail: 'The background service worker is initializing or temporarily unavailable.',
    ctaText: 'Retry',
    recoveryHint: 'Wait a moment, or click Retry to check status again.',
  },
  'subscribe-failed': {
    headline: 'Setup Failed',
    detail: 'Site permission is active, but registering the subscription with the gateway failed.',
    ctaText: 'Retry Registration',
    recoveryHint: 'Verify your session and network connection, then try again.',
  },
}

export function getNotificationCopy(state: NotificationUiState): NotificationStateCopy {
  return COPY[state]
}
