/**
 * Pure payload → safe-notification mapping, imported by `sw.ts`.
 *
 * SW no-leak discipline: this module performs no I/O, has no `console.*`
 * calls, and never echoes payload free-text into rendered copy or into an
 * error/reason string. It maps a raw (attacker-influenced, since push
 * payloads are network-delivered) `unknown` payload to a fixed,
 * dashboard-owned notification descriptor.
 *
 * Wire shape: the gateway sends `{title, body, data: {type, route, runId?, failureLabel?}}`.
 * Top-level `title` and `body` are i18n keys, not display text, and are never
 * rendered. Only `data.type`, `data.failureLabel`, and (for `question` only)
 * `data.runId` with `data.route` are read; any other field is ignored. The
 * output `route` is always the literal `/`: the notification never carries a
 * URL built from wire text. A `question` keeps its `runId` only when the ID
 * matches `RUN_ID_PATTERN` and the wire `route` is exactly `/operator#<runId>`;
 * the click handler turns that ID into a target and nothing else reads it.
 *
 * Safe-copy notification rendering: copy is a fixed map keyed by
 * `data.type`, plus an optional `data.failureLabel` that must be a member of
 * the `KNOWN_FAILURE_LABELS` allowlist and maps to fixed reason text. Unknown,
 * absent, or reasonless labels fall back to generic "Run failed" copy — the raw
 * label is NEVER rendered.
 */

import {RUN_ID_PATTERN} from '../operator/run-id.ts'

/** Notification types the gateway sends. Mirrors the vendored `OPERATOR_PUSH_TRIGGER_KINDS`; a root test pins the two together. */
export const PUSH_NOTIFICATION_TYPES = ['approval', 'run_failed', 'question'] as const

export type PushNotificationType = (typeof PUSH_NOTIFICATION_TYPES)[number]

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

/** A question that asked from a known run. The only shape that carries a `runId`. */
export interface QuestionRunNotificationData {
  readonly type: 'question'
  readonly route: '/'
  readonly runId: string
}

/** A question whose payload had no admissible `runId` (absent, malformed, or a mismatched route). */
export interface QuestionNoRunNotificationData {
  readonly type: 'question'
  readonly route: '/'
  readonly runId?: never
}

/** Every other notification: no `runId`. `question` is excluded, so each question shape is one of the two above. */
export interface PlainNotificationData {
  readonly type: Exclude<PushNotificationType, 'question'> | 'unknown'
  readonly route: '/'
  readonly runId?: never
}

/**
 * Narrow on `runId`: `data.runId !== undefined` selects `QuestionRunNotificationData` and gives
 * `runId: string`; `data.type === 'question'` alone leaves the run and no-run question shapes.
 */
export type SafeNotificationData = QuestionRunNotificationData | QuestionNoRunNotificationData | PlainNotificationData

export interface SafeNotification {
  readonly title: string
  readonly body: string
  readonly data: SafeNotificationData
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
  return PUSH_NOTIFICATION_TYPES.some(known => known === value)
}

/**
 * A question's `runId`, or `undefined`. Admitted only when the ID matches
 * `RUN_ID_PATTERN` and the wire `route` equals exactly `/operator#<runId>`, the
 * only shape the gateway emits for it.
 */
function readWireQuestionRunId(candidate: Record<string, unknown>): string | undefined {
  const {runId, route} = candidate
  if (typeof runId !== 'string' || RUN_ID_PATTERN.test(runId) === false) return undefined
  return route === `/operator#${runId}` ? runId : undefined
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
    case 'question': {
      const notification = COPY_MAP.question(failureLabel)
      const runId = readWireQuestionRunId(candidate)
      return runId === undefined ? notification : {...notification, data: {type: 'question', route: '/', runId}}
    }
    default: {
      const exhaustiveType: never = type
      return exhaustiveType
    }
  }
}
