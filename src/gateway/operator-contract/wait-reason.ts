/**
 * Operator-facing wait reason: why a draining `running` run has not finished yet.
 *
 * A closed, kebab-case wire enum carried as an optional sibling of `status` on `OperatorRunStatus`. It is an
 * in-memory overlay on a live run, never a stored field, and it never carries raw text.
 *
 * Only the wire values and their type are vendored. The gateway's mapping from its internal completion-gate codes
 * depends on gateway-only types and is omitted; `isOperatorWaitReason` is the dashboard's membership guard for
 * untrusted input.
 *
 * Security: membership is checked against a `Set`, never by indexing a plain object, so `toString`, `constructor` and
 * `__proto__` do not resolve to prototype members. Unknown or non-string input is not a wait reason.
 */

/** The closed wire set. Consumers must tolerate values added later. */
export const OPERATOR_WAIT_REASONS = [
  'agent-working',
  'awaiting-reply',
  'awaiting-background-task',
  'confirming-completion',
] as const

export type OperatorWaitReason = (typeof OPERATOR_WAIT_REASONS)[number]

const OPERATOR_WAIT_REASON_SET: ReadonlySet<string> = new Set<string>(OPERATOR_WAIT_REASONS)

/** Whether `value` is exactly one of the known wire wait reasons. */
export function isOperatorWaitReason(value: unknown): value is OperatorWaitReason {
  return typeof value === 'string' && OPERATOR_WAIT_REASON_SET.has(value)
}
