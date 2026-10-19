/**
 * Launch prompt bound for `POST /operator/runs` and `RunSummary.prompt`.
 *
 * The gateway's stored value and the contract field share one bound, and nothing is ever truncated:
 * an over-bound prompt is rejected at launch with a 400 and the typed reason below.
 *
 * Only the wire constants and the rejection reason type are vendored. The gateway's projection helper
 * and its storage key depend on gateway-only types and are omitted.
 */

/**
 * Maximum launch prompt length, counted in UTF-16 code units (`String.prototype.length`), so a client
 * must count with `.length`, not code points or bytes. 4,001 emoji is 8,002 units and is over the bound.
 *
 * Upstream treats the bound as raise-only: it may be increased but never lowered.
 */
export const OPERATOR_LAUNCH_PROMPT_MAX_LENGTH = 8000

/** Typed 400 reason for a launch prompt longer than {@link OPERATOR_LAUNCH_PROMPT_MAX_LENGTH}. */
export const OPERATOR_LAUNCH_PROMPT_TOO_LONG = 'prompt-too-long'

/** The typed `reason` on the 400 `{error: 'bad request', reason}` launch response. */
export type OperatorLaunchPromptRejectionReason = typeof OPERATOR_LAUNCH_PROMPT_TOO_LONG
