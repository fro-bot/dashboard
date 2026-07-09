/**
 * Pure payload → safe-notification mapping, imported by `sw.ts`.
 *
 * SW no-leak discipline: this module performs no I/O, has no `console.*`
 * calls, and never echoes payload free-text into rendered copy or into an
 * error/reason string. It maps a raw (attacker-influenced, since push
 * payloads are network-delivered) `unknown` payload to a fixed,
 * dashboard-owned notification descriptor.
 *
 * Safe-copy notification rendering: copy is a fixed map keyed by
 * `payload.type`, plus an optional `failureLabel` that must be a member of
 * the `KNOWN_FAILURE_LABELS` allowlist. Unknown/absent labels fall back to
 * generic "Run failed" copy — the raw label is NEVER rendered.
 */

export type PushNotificationType = 'approval' | 'run_failed'

/**
 * Allowlisted `failureLabel` values. An unrecognized label (including any
 * attacker-controlled string from the push payload) is never rendered —
 * only membership in this set unlocks the specific copy variant.
 */
export const KNOWN_FAILURE_LABELS: ReadonlySet<string> = new Set(['timeout', 'error', 'cancelled'])

export interface SafeNotification {
  readonly title: string
  readonly body: string
  readonly data: {readonly type: string; readonly route: '/'}
}

const GENERIC_FALLBACK: SafeNotification = {
  title: 'Fro Bot',
  body: 'You have a new notification.',
  data: {type: 'unknown', route: '/'},
}

const RUN_FAILED_GENERIC_BODY = 'A run failed.'

/** Exhaustive over known `type` values — every entry must produce copy without reading raw payload text. */
const COPY_MAP: Record<PushNotificationType, (failureLabel: string | undefined) => SafeNotification> = {
  approval: () => ({
    title: 'Approval needed',
    body: 'A run is waiting for your approval.',
    data: {type: 'approval', route: '/'},
  }),
  run_failed: failureLabel => ({
    title: 'Run failed',
    body:
      failureLabel !== undefined && KNOWN_FAILURE_LABELS.has(failureLabel)
        ? `A run failed: ${failureLabel}.`
        : RUN_FAILED_GENERIC_BODY,
    data: {type: 'run_failed', route: '/'},
  }),
}

function isKnownType(value: unknown): value is PushNotificationType {
  return value === 'approval' || value === 'run_failed'
}

/**
 * Build a safe notification descriptor from a raw, untrusted push payload.
 *
 * Always returns a notification — never throws, never returns null/undefined
 * — so callers can unconditionally `showNotification`. Any payload shape
 * that isn't a recognized `{type, failureLabel?}` object falls back to the
 * generic notification. `failureLabel` is only ever rendered if it is a
 * member of `KNOWN_FAILURE_LABELS`; otherwise it is discarded.
 */
export function buildNotification(rawPayload: unknown): SafeNotification {
  if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
    return GENERIC_FALLBACK
  }

  const candidate = rawPayload as Record<string, unknown>
  const {type} = candidate

  if (isKnownType(type) === false) {
    return GENERIC_FALLBACK
  }

  const rawFailureLabel = candidate.failureLabel
  const failureLabel = typeof rawFailureLabel === 'string' ? rawFailureLabel : undefined

  return COPY_MAP[type](failureLabel)
}
