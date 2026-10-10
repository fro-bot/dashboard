/**
 * Question frame, pending-question DTO, and decision request types for the
 * operator API.
 *
 * An agent running in a gateway workspace can call OpenCode's `question` tool.
 * The gateway forwards the pending question to operators over the run's SSE
 * stream and a reconnect-listing REST read, and accepts an answer or a skip.
 *
 * ### Untrusted text — render inertly
 *
 * **Every question and answer string in this module is untrusted, model- or
 * operator-authored plain text.** That covers `header`, `text`, option `label`,
 * option `description`, and every answer string. The gateway carries them
 * verbatim apart from bounding (length caps) and control-character stripping at
 * the build site; it never pre-renders, escapes, or sanitizes them as HTML or
 * Markdown. Consumers MUST display them as inert text (for example a text node
 * or `textContent`) and MUST NOT interpret them as HTML, Markdown, or links. A
 * string such as `<img src=x onerror=alert(1)>` is data, not markup.
 *
 * Question and answer text never appears in gateway logs, errors, audit events,
 * or push payloads — only request ids and reason codes do.
 *
 * ### Frame modes
 *
 * - **Open frame** (`settled: false`): a question is pending. The browser should
 *   show a prompt and let the operator answer or skip.
 * - **Settle/clear frame** (`settled: true`): the request is resolved (answered,
 *   skipped, expired, rejected, or torn down). The browser should dismiss the
 *   prompt. It carries only `requestID`, `runId`, and `settled: true`.
 *
 * A request settles as a whole: an operator submits answers for every question
 * in the request in one decision.
 */

// ---------------------------------------------------------------------------
// QuestionPromptDetail / QuestionRequestDetail — shared field shapes
// ---------------------------------------------------------------------------

/** One selectable option of a question. Both strings are untrusted plain text. */
export interface QuestionOptionDetail {
  /**
   * Option label. Also the answer value an operator submits when choosing this
   * option. Bounded and control-character-stripped; if bounding altered it,
   * submitting the altered label will not match the option.
   */
  readonly label: string
  /** Option description. Untrusted plain text, bounded. */
  readonly description: string
}

/** One question of a request. All strings are untrusted plain text, bounded. */
export interface QuestionPromptDetail {
  /** Short label for the question. */
  readonly header: string
  /** The question text. */
  readonly text: string
  /** Selectable options; may be empty when only a custom answer is meaningful. */
  readonly options: readonly QuestionOptionDetail[]
  /** True when more than one option may be chosen. Normalized: always a boolean. */
  readonly multiple: boolean
  /**
   * True when a free-text answer is accepted in addition to the options.
   * Normalized: upstream allows a custom answer unless it is explicitly
   * disabled, so an omitted upstream value arrives here as `true`.
   */
  readonly custom: boolean
}

/**
 * The shared field shape for a pending question request: the single source of
 * truth for the open `QuestionFrameData` variant and `PendingQuestionDTO`, so
 * the SSE frame and the REST listing cannot drift.
 */
export interface QuestionRequestDetail {
  /** The unique request identifier — matches the registry entry. */
  readonly requestID: string
  /** One entry per question, in question order. Answers must match this arity. */
  readonly questions: readonly QuestionPromptDetail[]
}

// ---------------------------------------------------------------------------
// QuestionFrameData — SSE frame payload
// ---------------------------------------------------------------------------

/**
 * Payload for a `question` frame delivered over the operator run-stream.
 *
 * Open frames carry the full bounded request so the browser can render a
 * prompt. Settle/clear frames carry only `requestID` and `runId`.
 */
export type QuestionFrameData =
  | (QuestionRequestDetail & {
    /** The run the question belongs to. */
    readonly runId: string
    /** Discriminant: false for open (pending) frames. */
    readonly settled: false
  })
  | {
    /** The unique request identifier — matches the registry entry. */
    readonly requestID: string
    /** The run the question belonged to. */
    readonly runId: string
    /** Discriminant: true for settle/clear frames. */
    readonly settled: true
  }

// ---------------------------------------------------------------------------
// PendingQuestionDTO — reconnect listing entry
// ---------------------------------------------------------------------------

/**
 * A pending question as listed for a reconnecting operator. Same bounded shape
 * as the open frame, minus the run id (the listing is scoped to one run).
 *
 * Distinct from the gateway-internal registry DTO of the same name, which holds
 * raw, unbounded text. This is the operator-facing, bounded form.
 */
export type PendingQuestionDTO = QuestionRequestDetail

// ---------------------------------------------------------------------------
// Decision request and response types
// ---------------------------------------------------------------------------

/**
 * The operator's answer to one question: which options they chose and, when the
 * question's `custom` is true, free text.
 *
 * Options are chosen by zero-based **index into that question's `options`**, never
 * by label. The labels a consumer displays are bounded and control-stripped, so
 * they can differ from the raw labels the agent sent; the gateway maps each index
 * back to the raw label before replying. `options` holds at most one index unless
 * the question's `multiple` is true. `text` is untrusted plain text, at most 4,000
 * characters; an omitted or empty `text` means no free-text answer. A question with
 * neither is left unanswered.
 */
export interface QuestionAnswerChoice {
  readonly options?: readonly number[]
  readonly text?: string
}

/**
 * Answer a pending question request: one choice per question, in question order.
 * The array length must equal the request's question count.
 */
export interface QuestionAnswerRequest {
  readonly decision: 'answer'
  readonly answers: readonly QuestionAnswerChoice[]
}

/**
 * Skip a pending question request. The agent sees the question as unanswered
 * and continues; the run does not fail.
 */
export interface QuestionSkipRequest {
  readonly decision: 'skip'
}

/** Body of an operator question decision: answer or skip. */
export type QuestionDecisionRequest = QuestionAnswerRequest | QuestionSkipRequest

/** Response body of `GET /operator/runs/:runId/questions`: the run's open question requests. */
export interface PendingQuestionsResponse {
  readonly requests: readonly PendingQuestionDTO[]
}

/**
 * Why a decision was refused as malformed (HTTP 400). The request stays pending.
 * `malformed` covers a body that is not an answer/skip shape, duplicate or non-integer
 * option indices, and non-string text; the others mirror the gateway's answer validation.
 */
export type QuestionDecisionInvalidReason =
  'malformed' | 'arity-mismatch' | 'unknown-option' | 'multiple-not-allowed' | 'empty-value' | 'text-too-long'

/**
 * Outcome of an accepted question decision (HTTP 200).
 *
 * - `claimed`         — accepted; the reply is on its way to the agent.
 * - `already_claimed` — another decision for this request is in flight; nothing changed.
 * - `already_settled` — the request is no longer pending (answered, skipped, expired, or
 *                       never existed for this run). Repeating a submission lands here.
 * - `failed_to_settle`— the reply to the agent failed; the request is pending again.
 *
 * A refused body is not a state: it is HTTP 400 with {@link QuestionDecisionErrorResponse}.
 */
export interface QuestionDecisionResponse {
  readonly state: 'claimed' | 'already_claimed' | 'already_settled' | 'failed_to_settle'
}

/**
 * Body of the HTTP 400 for a refused question decision. Follows the operator error envelope
 * (`{error: string}`, like the approval decision route's `{error: 'bad request'}`) and adds the
 * refusal detail. The request stays pending.
 */
export interface QuestionDecisionErrorResponse {
  readonly error: 'bad request'
  readonly reason: QuestionDecisionInvalidReason
  /** The question the problem is in, or null when it concerns the whole request. */
  readonly questionIndex: number | null
}

// ---------------------------------------------------------------------------
// Dashboard-local additions. Everything below is NOT part of the upstream file.
// The upstream file is types only; the dashboard needs runtime values to read
// (vocabularies, bounds) and a parser to validate frames off the wire.
// ---------------------------------------------------------------------------

/** Runtime mirror of `QuestionDecisionResponse['state']`. Checked against the union at compile time below. */
export const QUESTION_DECISION_STATES = ['claimed', 'already_claimed', 'already_settled', 'failed_to_settle'] as const

/** Runtime mirror of `QuestionDecisionInvalidReason`. Checked against the union at compile time below. */
export const QUESTION_INVALID_REASONS = [
  'malformed',
  'arity-mismatch',
  'unknown-option',
  'multiple-not-allowed',
  'empty-value',
  'text-too-long',
] as const

type IsExactMatch<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type AssertTrue<T extends true> = T

/** Compile-time only: resolves to `true` when the reason list and the union are the same set of reasons. */
export type QuestionInvalidReasonsAreExact = AssertTrue<
  IsExactMatch<(typeof QUESTION_INVALID_REASONS)[number], QuestionDecisionInvalidReason>
>

/** Compile-time only: resolves to `true` when the state list and the union are the same set of states. */
export type QuestionDecisionStatesAreExact = AssertTrue<
  IsExactMatch<(typeof QUESTION_DECISION_STATES)[number], QuestionDecisionResponse['state']>
>

// Field bounds (UTF-16 code units, counted after control removal) and list caps. The gateway
// enforces the same numbers at the build site; a frame outside them is rejected, never truncated.

/** Maximum length of a question header. */
export const QUESTION_HEADER_MAX_LENGTH = 128
/** Maximum length of a question text. */
export const QUESTION_TEXT_MAX_LENGTH = 4096
/** Maximum length of an option label. */
export const QUESTION_OPTION_LABEL_MAX_LENGTH = 256
/** Maximum length of an option description. */
export const QUESTION_OPTION_DESCRIPTION_MAX_LENGTH = 1024
/** Maximum number of questions in one request. */
export const MAX_QUESTIONS_PER_REQUEST = 8
/** Maximum number of options in one question. */
export const MAX_OPTIONS_PER_QUESTION = 64

// Removed outright: C0 controls except tab/LF/CR, DEL, C1 controls, and every Unicode bidi control
// (marks U+200E/U+200F/U+061C, embeddings and overrides U+202A-U+202E, isolates U+2066-U+2069).
// eslint-disable-next-line no-control-regex
const REMOVED_CHARS = /[\u0000-\u0008\v\f\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
// Whitespace controls become one space each, so a multi-line string does not glue words together.
const WHITESPACE_CHARS = /[\t\n\r]/g

/**
 * The shared text rule: tab, newline and carriage return become spaces; every other control and
 * bidi character is removed. Pure. Length is not enforced here.
 */
export function sanitizeQuestionText(value: string): string {
  return value.replaceAll(WHITESPACE_CHARS, ' ').replaceAll(REMOVED_CHARS, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when the value's own enumerable keys are exactly `keys`. An own `__proto__` counts as a key, so it fails. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Sanitize a bounded string, or null when it is not a string or is over its bound after sanitizing. */
function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const clean = sanitizeQuestionText(value)
  return clean.length <= maxLength ? clean : null
}

function parseOption(value: unknown): QuestionOptionDetail | null {
  if (!isRecord(value) || !hasExactKeys(value, ['label', 'description'])) return null
  const label = boundedText(value.label, QUESTION_OPTION_LABEL_MAX_LENGTH)
  const description = boundedText(value.description, QUESTION_OPTION_DESCRIPTION_MAX_LENGTH)
  if (label === null || description === null) return null
  return {label, description}
}

function parseQuestion(value: unknown): QuestionPromptDetail | null {
  if (!isRecord(value) || !hasExactKeys(value, ['header', 'text', 'options', 'multiple', 'custom'])) return null
  const header = boundedText(value.header, QUESTION_HEADER_MAX_LENGTH)
  const text = boundedText(value.text, QUESTION_TEXT_MAX_LENGTH)
  if (header === null || text === null) return null
  if (typeof value.multiple !== 'boolean' || typeof value.custom !== 'boolean') return null
  if (!Array.isArray(value.options) || value.options.length > MAX_OPTIONS_PER_QUESTION) return null
  const options: QuestionOptionDetail[] = []
  for (const entry of value.options as unknown[]) {
    const option = parseOption(entry)
    if (option === null) return null
    options.push(option)
  }
  return {header, text, options, multiple: value.multiple, custom: value.custom}
}

/**
 * Validate one `question` frame payload (untyped, parsed off the wire) into a `QuestionFrameData`, or
 * `null` when it is malformed or out of bounds. Never throws and never truncates: an over-bound or
 * unrecognized shape is rejected whole.
 *
 * Closed at every level: any key outside the contract (including an own `__proto__`) rejects the
 * frame, and the result is rebuilt field by field, so no input object or nested part reaches a
 * caller. Text fields follow {@link sanitizeQuestionText}. A request with zero questions is valid.
 */
export function parseQuestionFrame(value: unknown): QuestionFrameData | null {
  if (!isRecord(value) || typeof value.settled !== 'boolean') return null
  if (!isNonEmptyString(value.runId) || !isNonEmptyString(value.requestID)) return null

  if (value.settled) {
    if (!hasExactKeys(value, ['runId', 'requestID', 'settled'])) return null
    return {runId: value.runId, requestID: value.requestID, settled: true}
  }

  if (!hasExactKeys(value, ['runId', 'requestID', 'settled', 'questions'])) return null
  if (!Array.isArray(value.questions) || value.questions.length > MAX_QUESTIONS_PER_REQUEST) return null
  const questions: QuestionPromptDetail[] = []
  for (const entry of value.questions as unknown[]) {
    const question = parseQuestion(entry)
    if (question === null) return null
    questions.push(question)
  }
  return {runId: value.runId, requestID: value.requestID, settled: false, questions}
}
