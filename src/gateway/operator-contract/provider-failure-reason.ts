/**
 * Operator-facing provider failure reason.
 *
 * A closed, kebab-case wire enum carried as a sibling of `failureKind` on `RunSummary` and
 * `OperatorRunStatus`. It says WHY a `session-error` run failed at the provider, which `failureKind`
 * alone cannot express.
 *
 * Only the wire values and their type are vendored. The gateway's internal-reason mapping and its
 * projection helpers depend on gateway-only types and are omitted; `isOperatorProviderFailureReason`
 * is the dashboard's membership guard for untrusted input.
 *
 * Security: the enum is fixed values with no provider-controlled or user text. Membership is checked
 * against a `Set`, never by indexing a plain object, so `toString`, `constructor` and `__proto__` do not
 * resolve to prototype members.
 */

/**
 * The closed wire set of provider failure reasons. `unclassified` is the catch-all: a provider failure
 * with no more specific cause. Consumers must tolerate values added later.
 */
export const OPERATOR_PROVIDER_FAILURE_REASONS = [
  'provider-auth-unavailable',
  'model-not-available',
  'provider-rejected-request',
  'unclassified',
] as const

export type OperatorProviderFailureReason = (typeof OPERATOR_PROVIDER_FAILURE_REASONS)[number]

const OPERATOR_PROVIDER_FAILURE_REASON_SET: ReadonlySet<string> = new Set<string>(OPERATOR_PROVIDER_FAILURE_REASONS)

/** Narrow an unknown value to OperatorProviderFailureReason when it is exactly one of the known wire strings. */
export function isOperatorProviderFailureReason(value: unknown): value is OperatorProviderFailureReason {
  return typeof value === 'string' && OPERATOR_PROVIDER_FAILURE_REASON_SET.has(value)
}
