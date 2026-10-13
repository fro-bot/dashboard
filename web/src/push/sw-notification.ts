/**
 * Pure payload → safe-notification mapping, imported by `sw.ts`.
 *
 * SW no-leak discipline: this module performs no I/O, has no `console.*`
 * calls, and never echoes payload free-text into rendered copy or into an
 * error/reason string. It maps a raw (attacker-influenced, since push
 * payloads are network-delivered) `unknown` payload to a fixed,
 * dashboard-owned notification descriptor.
 *
 * Wire shape: the gateway sends `{title, body, data: {type, route, failureLabel?}}`.
 * Top-level `title` and `body` are i18n keys, not display text, and are never
 * rendered. Only `data.type` and `data.failureLabel` are read; `data.route`
 * and any other field are ignored (the notification always routes to `/`).
 *
 * Safe-copy notification rendering: copy is a fixed map keyed by
 * `data.type`, plus an optional `data.failureLabel` that must be a member of
 * the `KNOWN_FAILURE_LABELS` allowlist and maps to fixed reason text. Unknown,
 * absent, or reasonless labels fall back to generic "Run failed" copy — the raw
 * label is NEVER rendered.
 */

export type PushNotificationType = 'approval' | 'run_failed' | 'question'

/**
 * Reason text for each failure kind the gateway may put in `data.failureLabel`.
 * Each entry is the run-card label for the same kind (`FAILURE_REASON_LABELS` in
 * `public/operator-stream.js`) with its first letter lower-cased, so it reads as
 * the tail of a sentence; a test pins the two together. A `Map` keeps
 * `Object.prototype` names like `constructor` from matching.
 */
const FAILURE_REASONS: ReadonlyMap<string, string> = new Map([
  ['inactivity-timeout', 'no recent activity'],
  ['max-duration-timeout', 'run timed out'],
  ['stream-ended', 'stream ended early'],
  ['workspace-unreachable', 'workspace unreachable'],
  ['session-error', 'session error'],
])

/**
 * Allowlisted `data.failureLabel` values: the failure kinds the gateway puts in
 * a push payload. The gateway's push allowlist leaves out
 * `checkout-substituted` and `workspace-unavailable`, so those never arrive as
 * a label. An unrecognized label (including any attacker-controlled string
 * from the push payload) is never rendered. `unknown` is allowlisted but has
 * no reason text, so it renders the generic copy.
 */
export const KNOWN_FAILURE_LABELS: ReadonlySet<string> = new Set([...FAILURE_REASONS.keys(), 'unknown'])

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

function runFailedBody(failureLabel: string | undefined): string {
  const reason = failureLabel === undefined ? undefined : FAILURE_REASONS.get(failureLabel)
  return reason === undefined ? RUN_FAILED_GENERIC_BODY : `A run failed: ${reason}.`
}

/** Exhaustive over known `type` values — every entry must produce copy without reading raw payload text. */
const COPY_MAP: Record<PushNotificationType, (failureLabel: string | undefined) => SafeNotification> = {
  approval: () => ({
    title: 'Approval needed',
    body: 'A run is waiting for your approval.',
    data: {type: 'approval', route: '/'},
  }),
  run_failed: failureLabel => ({
    title: 'Run failed',
    body: runFailedBody(failureLabel),
    data: {type: 'run_failed', route: '/'},
  }),
  question: () => ({
    title: 'Answer needed',
    body: 'A run is waiting for your answer.',
    data: {type: 'question', route: '/'},
  }),
}

function isKnownType(value: unknown): value is PushNotificationType {
  return value === 'approval' || value === 'run_failed' || value === 'question'
}

/**
 * Build a safe notification descriptor from a raw, untrusted push payload.
 *
 * Always returns a notification — never throws, never returns null/undefined
 * — so callers can unconditionally `showNotification`. The payload must be an
 * object whose `data` property is a non-array object with a recognized
 * `type`; anything else (including a flat `{type}` payload, or a missing,
 * null, array, or primitive `data`) falls back to the generic notification.
 * `data.failureLabel` is only ever rendered if it is a member of
 * `KNOWN_FAILURE_LABELS` and has reason text; otherwise it is discarded.
 */
export function buildNotification(rawPayload: unknown): SafeNotification {
  if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
    return GENERIC_FALLBACK
  }

  const {data} = rawPayload as Record<string, unknown>
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return GENERIC_FALLBACK
  }

  const candidate = data as Record<string, unknown>
  const {type} = candidate

  if (isKnownType(type) === false) {
    return GENERIC_FALLBACK
  }

  const rawFailureLabel = candidate.failureLabel
  const failureLabel = typeof rawFailureLabel === 'string' ? rawFailureLabel : undefined

  switch (type) {
    case 'approval':
      return COPY_MAP.approval(failureLabel)
    case 'run_failed':
      return COPY_MAP.run_failed(failureLabel)
    case 'question':
      return COPY_MAP.question(failureLabel)
    default: {
      const exhaustiveType: never = type
      return exhaustiveType
    }
  }
}
