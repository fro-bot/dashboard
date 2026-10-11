/**
 * Operator run stream client — pure core + thin DOM shell.
 *
 * This file is valid plain ES module that runs in a browser as-is (no TS syntax,
 * no imports of Node/TS modules). It is also directly importable by Vitest (Node 24
 * ESM) because it uses only standard JS. DOM-touching code lives exclusively inside
 * initOperatorStream() and is never executed at module top-level.
 *
 * Architecture: pure exports (parseSseFrame, nextStreamState, toSafeRunView,
 * constants) are tested by test/operator-stream-core.test.ts without a browser.
 * The DOM shell (initOperatorStream) is the only part that touches document.*.
 *
 * Security invariants:
 * - Never console.log/console.error/console.warn frame data, run IDs, repo names,
 *   stream URLs, or status payloads.
 * - Render only phase/status/timestamps plus validated, capped checkout DTO values —
 *   never entityRef/surface/output/tool or unchecked wire paths.
 * - All 404s collapse to one not-found state; no cause inference from body or timing.
 * - Read-only: GET stream only; no POST/PUT/DELETE, no telemetry endpoint.
 * - Same-origin: credentials:'include', no URL rewriting.
 * - redirect:'error' prevents auth-redirect loops from being parsed as streams.
 * - Content-Type must be text/event-stream on 200; otherwise fail closed.
 * - Buffer is capped at MAX_SSE_BUFFER_BYTES; overflow → abort + failed state.
 * - status/phase/surface are allowlist-gated; out-of-set values → parse failure.
 * - Status labels are rendered from a local map, never from the raw wire string.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Contract version this client expects on the ready frame. */
export const PINNED_CONTRACT_VERSION = '1.9.0'

/** Base delay in milliseconds for exponential backoff. */
export const RETRY_BASE_MS = 1000

/** Exponential backoff multiplier. */
export const RETRY_FACTOR = 2

/** Maximum number of reconnect attempts before transitioning to failed. */
export const RETRY_MAX_COUNT = 5

/** Hard cap on the incremental SSE buffer in bytes. Overflow → abort + failed. */
export const MAX_SSE_BUFFER_BYTES = 1_000_000

/**
 * Hard cap on cumulative accumulated run-output characters. The raw SSE buffer cap
 * bounds a single frame; this bounds the reducer's growing answer string so a stream
 * of many valid deltas cannot exhaust browser memory. On overflow the text is
 * truncated and a fixed truncation hint is shown — never an echoed count.
 */
export const MAX_OUTPUT_TEXT_CHARS = 256_000

/**
 * Hard cap on the per-run approval tombstone map. A hostile stream could send many
 * distinct settle frames; this bounds the map size. When the cap is reached, the
 * oldest entry (FIFO) is evicted before adding the new one.
 */
export const MAX_APPROVAL_TOMBSTONES = 1000

/**
 * Hard cap on the per-run open-approvals map. A hostile stream could send many
 * distinct open frames; this bounds the map size. When the cap is reached, new open
 * frames for unseen requestIDs are ignored (existing prompts are never evicted).
 */
export const MAX_OPEN_APPROVALS = 100

/**
 * Mirrors the gateway's PENDING_APPROVALS_MAX_RESULTS cap (50) from
 * fro-bot/agent v0.76.2 packages/gateway/src/web/operator/pending-approvals-route.ts.
 *
 * The reconnect-reconcile caller uses this to guard against truncated recovery
 * responses: if the recovered set size is >= this cap, the response may be
 * truncated and corrective pruning is skipped (additive-only fallback).
 *
 * NOTE: This is an external contract value with no in-repo source of truth.
 * If the gateway cap is bumped, update this mirror and the guard in reconcileApprovals.
 * A stale mirror silently tightens the guard (ghosts persist) but never causes
 * catastrophic wipe — the safe failure direction.
 */
export const GATEWAY_PENDING_APPROVALS_CAP = 50

/**
 * Hard cap on the per-run open-questions map. It equals the gateway's pending-question
 * list cap (50). Excess opens for unseen requestIDs are rejected, never evicting a real
 * pending question: losing one the operator can still answer is worse than dropping overflow.
 */
export const MAX_OPEN_QUESTIONS = 50

/**
 * Mirrors the gateway's pending-question list cap (50) from fro-bot/agent
 * `GET /operator/runs/:runId/questions`. A list at or above this size may be truncated, so
 * the question reconcile treats it as additive only and never prunes from it.
 *
 * NOTE: External contract value with no in-repo source of truth. A stale mirror tightens
 * the guard (ghosts persist) but never wipes real questions — the safe direction.
 */
export const GATEWAY_PENDING_QUESTIONS_CAP = 50

/**
 * Bounded timeout in milliseconds for receiving the first SSE frame after opening
 * a stream. If no frame arrives within this window, the connection transitions to
 * 'submitted-unobservable' — the run was accepted but is not yet streaming (e.g.
 * queued behind the concurrency cap or still starting). A manual retry re-opens.
 */
export const FIRST_FRAME_TIMEOUT_MS = 15_000

/** Terminal OperatorWebStatus values — a run in one of these states will not progress. */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Statuses a run-list summary can carry (the run index parser keeps only these). The optional
 * `summaryStatus` init option is accepted only from this set; anything else is dropped.
 */
const SUMMARY_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled'])

/** In-card copy for an expired run snapshot. Dashboard-owned; never wire text. */
const OUTPUT_UNAVAILABLE_COPY = 'Output no longer available.'

/** Valid ResetReason values from the gateway SSE surface. */
const VALID_RESET_REASONS = new Set([
  'no-snapshot',
  'terminal',
  'shutdown',
  'max-duration',
  'writer-error',
  'overflow',
])

/** Allowlisted status values — out-of-set values are parse failures. */
const VALID_STATUSES = new Set([
  'queued',
  'blocked',
  'running',
  'waiting_for_approval',
  'waiting_for_question',
  'succeeded',
  'failed',
  'cancelled',
])

/** Allowlisted phase values — out-of-set values are parse failures. */
const VALID_PHASES = new Set([
  'PENDING',
  'ACKNOWLEDGED',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
])

/** Allowlisted surface values — out-of-set values are parse failures. */
const VALID_SURFACES = new Set(['github', 'discord', 'web'])

/**
 * Safe status label map — render labels from this map, never the raw wire string.
 * classList.add throws on whitespace; raw wire values like 'waiting_for_approval'
 * are safe for classList but must still go through this map for display text.
 */
const STATUS_LABELS = {
  queued: 'Queued',
  blocked: 'Blocked',
  running: 'Running',
  waiting_for_approval: 'Waiting for approval',
  waiting_for_question: 'Waiting for answer',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/**
 * Allowlisted OperatorFailureKind values — out-of-set values normalize to
 * absent, never parsed through.
 * Mirrors src/gateway/operator-contract/run-status.ts OPERATOR_FAILURE_KINDS.
 */
const VALID_FAILURE_KINDS = new Set([
  'inactivity-timeout',
  'max-duration-timeout',
  'stream-ended',
  'workspace-unreachable',
  'session-error',
  'checkout-substituted',
  'workspace-unavailable',
  'unknown',
])

/**
 * Dashboard-owned display labels for known failure reasons — render labels from
 * this map, never the raw failureKind wire string. A missing or unmapped reason
 * has no entry here and falls back to generic 'Failed' at the render boundary.
 * Every OperatorFailureKind value has an explicit display decision.
 */
export const FAILURE_REASON_LABELS = {
  'inactivity-timeout': 'No recent activity',
  'max-duration-timeout': 'Run timed out',
  'stream-ended': 'Stream ended early',
  'workspace-unreachable': 'Workspace unreachable',
  'session-error': 'Session error',
  'checkout-substituted': 'Checkout mismatch',
  'workspace-unavailable': 'Workspace unavailable',
  unknown: 'Unknown failure',
}

// ---------------------------------------------------------------------------
// Checkout provenance / checkout preparation — labels
//
// Dashboard-owned copy. Every vendored value has a label here; tests compare each
// map's keys with the vocabularies exported by the vendored contract. Labels are
// only ever rendered through textContent. A `{name}` token is filled by
// fillLabelTemplate() from sanitized values — never from raw wire text.
// ---------------------------------------------------------------------------

/** Display labels for checkout refusal reasons. Doubles as the refusal-reason allowlist. */
export const CHECKOUT_REFUSAL_REASON_LABELS = {
  'needs-recovery': 'needs recovery',
  'checkout-substituted': 'checkout mismatch',
  'unsupported-layout': 'unsupported repository layout ({layout})',
  'unsupported-config': 'disallowed git config',
  'operation-in-progress': '{operation} in progress',
  dirty: 'uncommitted changes',
  'submodule-initialized': 'submodules initialized',
  detached: 'detached HEAD',
  'non-default-branch': 'on branch {branch}, not the default',
  diverged: 'diverged from remote',
  ahead: 'local commits not on remote',
  obstructed: 'files in the way',
  'maintenance-hold': 'maintenance hold',
}

/** Display labels for checkout update-failure reasons. Doubles as the update-failure allowlist. */
export const CHECKOUT_UPDATE_FAILURE_REASON_LABELS = {
  aborted: 'aborted',
  'inspection-failed': 'inspection failed',
  'fetch-auth-rejected': 'fetch rejected credentials',
  'fetch-not-found': 'repository not found',
  'fetch-forbidden': 'fetch forbidden',
  'fetch-rate-limited': 'fetch rate limited',
  'fetch-unreachable': 'remote unreachable',
  'fetch-timeout': 'fetch timed out',
  'fetch-failed': 'fetch failed',
  'remote-moved': 'remote changed during update',
  'apply-failed': "couldn't apply update",
  'termination-unconfirmed': 'stop not confirmed',
}

/** Display labels for unsupported-layout reasons. Doubles as the layout-reason allowlist. */
export const CHECKOUT_LAYOUT_REASON_LABELS = {
  'core-worktree': 'custom core.worktree',
  gitfile: '.git is a file',
  'symlinked-git-dir': 'symlinked .git directory',
  'symlinked-config': 'symlinked git config',
  alternates: 'object alternates',
  'replace-refs': 'replace refs',
  grafts: 'grafts',
  shallow: 'shallow clone',
  'partial-clone': 'partial clone',
  'linked-worktree': 'linked worktree',
  'unsupported-index-flag': 'unsupported index flag',
  'bare-repository': 'bare repository',
}

/** Display labels for obstruction kinds. Doubles as the obstruction-kind allowlist. */
export const CHECKOUT_OBSTRUCTION_KIND_LABELS = {
  'exact-conflict': 'conflicts with a file',
  'prefix-conflict': 'conflicts with a directory',
  'identical-content': 'identical file present',
  'symlink-ancestor': 'behind a symlink',
}

/**
 * Display labels for in-progress git operations. `none` is deliberately absent: it is a
 * valid wire value that renders nothing. Tests pin this exception explicitly.
 */
export const CHECKOUT_OPERATION_LABELS = {
  merge: 'Merge',
  rebase: 'Rebase',
  am: 'Patch apply',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
  bisect: 'Bisect',
}

/** Headline templates for a preparation record that has no failureKind of its own. */
export const CHECKOUT_PREPARATION_HEADLINE_LABELS = {
  refused: 'Checkout refused: {reason}',
  failed: 'Checkout update failed: {reason}',
}

/** Lines for the failed-preparation flags. */
export const CHECKOUT_FAILURE_FLAG_LABELS = {
  permanent: "Retrying won't help.",
  mutationStarted: 'The checkout was partly changed.',
  mutationPossibly: 'The checkout may have been partly changed.',
}

/** Lines describing what a run started from. `{sha}`/`{fromSha}` take the 7-character form. */
export const CHECKOUT_PROVENANCE_LABELS = {
  headAttached: 'Started from {branch} at {sha}',
  headDetached: 'Started from detached {sha}',
  worktreeClean: 'Clean worktree',
  worktreeDirty: 'Uncommitted changes:',
  operationInProgress: '{operation} in progress',
  remoteNotChecked: 'Remote not checked',
  remoteUpToDate: 'Up to date with {defaultBranch}',
  remoteFastForwarded: 'Fast-forwarded {fromSha} → {sha} on {defaultBranch}',
  unavailable: 'Checkout state unavailable',
}

/**
 * Fill `{name}` tokens in a label template in a single pass. Substituted text is never
 * re-scanned, and the replacement is applied through a function so `$&`-style patterns in
 * a value stay literal. A token with no value is left as written.
 */
export function fillLabelTemplate(template, values) {
  return template.replaceAll(/\{(\w+)\}/g, (token, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token,
  )
}

// ---------------------------------------------------------------------------
// Checkout provenance / checkout preparation — validation, caps and sanitizing
//
// The browser is the sanitization boundary. Validation ports the vendored
// contract's rules (src/gateway/operator-contract/provenance.ts); on top of
// those, every free-form string is stripped of control and bidi characters and
// capped, lists are bounded, and the result is a closed DTO. Anything invalid
// becomes undefined ("absent"), and one bad nested field drops the whole
// object — it never rejects the status frame.
// ---------------------------------------------------------------------------

/** Per-string cap for every free-form checkout string (branches, paths, keys). */
export const MAX_CHECKOUT_STRING_CHARS = 256

/** Entries kept per free-form list; the remainder is reported as a count. */
export const MAX_CHECKOUT_LIST_ENTRIES = 10

const CHECKOUT_SHA_RE = /^[0-9a-f]{40}$/

/** Allowed values — the label maps are the allowlists, so an unlabeled value cannot be accepted. */
const CHECKOUT_REFUSAL_REASONS = new Set(Object.keys(CHECKOUT_REFUSAL_REASON_LABELS))
const CHECKOUT_UPDATE_FAILURE_REASONS = new Set(Object.keys(CHECKOUT_UPDATE_FAILURE_REASON_LABELS))
const CHECKOUT_LAYOUT_REASONS = new Set(Object.keys(CHECKOUT_LAYOUT_REASON_LABELS))
const CHECKOUT_OBSTRUCTION_KINDS = new Set(Object.keys(CHECKOUT_OBSTRUCTION_KIND_LABELS))
const CHECKOUT_OPERATIONS = new Set(['none', ...Object.keys(CHECKOUT_OPERATION_LABELS)])

// C0 controls and DEL, C1 controls, and every Unicode bidi control: embeddings and
// overrides (U+202A–U+202E), isolates (U+2066–U+2069), and marks (U+200E, U+200F, U+061C).
// eslint-disable-next-line no-control-regex
const CHECKOUT_STRIPPED_CHARS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

function stripCheckoutText(value) {
  return value.replaceAll(CHECKOUT_STRIPPED_CHARS, '')
}

function capCheckoutText(stripped, cap) {
  if (stripped.length <= cap) return stripped
  let head = stripped.slice(0, cap - 1)
  // Never leave half a surrogate pair at the cut.
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xD800 && last <= 0xDBFF) head = head.slice(0, -1)
  return `${head}…`
}

/**
 * Strip control and bidi characters, then truncate to `cap` characters (the trailing
 * ellipsis counts toward the cap). Total: any string in, a string out.
 */
export function sanitizeCheckoutText(value, cap = MAX_CHECKOUT_STRING_CHARS) {
  return capCheckoutText(stripCheckoutText(value), cap)
}

function isObjectLike(value) {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isValidSha(value) {
  return typeof value === 'string' && CHECKOUT_SHA_RE.test(value)
}

function isNonNegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A required free-form scalar: non-empty on the wire AND non-empty after sanitizing, else undefined. */
function sanitizeRequiredText(value) {
  if (!isNonEmptyString(value)) return undefined
  const sanitized = sanitizeCheckoutText(value)
  return sanitized === '' ? undefined : sanitized
}

/**
 * Bound a list of free-form strings: sanitize each entry, drop entries that are empty
 * afterwards, keep the first MAX_CHECKOUT_LIST_ENTRIES and count the rest. The caller has
 * already validated that every entry is a string.
 */
function boundTextList(entries, toText) {
  const items = []
  let more = 0
  for (const entry of entries) {
    const stripped = stripCheckoutText(toText(entry))
    if (stripped === '') continue
    if (items.length < MAX_CHECKOUT_LIST_ENTRIES) {
      items.push({entry, text: capCheckoutText(stripped, MAX_CHECKOUT_STRING_CHARS)})
    } else {
      more += 1
    }
  }
  return {items, more}
}

function normalizeStringList(value) {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) return undefined
  const {items, more} = boundTextList(value, entry => entry)
  return {items: items.map(item => item.text), more}
}

function normalizeObstructions(value) {
  if (!Array.isArray(value)) return undefined
  const valid = value.every(
    entry =>
      isObjectLike(entry) &&
      typeof entry.path === 'string' &&
      typeof entry.kind === 'string' &&
      CHECKOUT_OBSTRUCTION_KINDS.has(entry.kind),
  )
  if (!valid) return undefined
  const {items, more} = boundTextList(value, entry => entry.path)
  return {items: items.map(item => ({path: item.text, kind: item.entry.kind})), more}
}

function normalizeRemoteFreshness(value) {
  if (!isObjectLike(value)) return undefined
  if (value.kind === 'not-checked') return {kind: 'not-checked'}
  if (value.kind !== 'checked') return undefined
  // checkedAt is validated but not carried into browser state.
  if (!isNonEmptyString(value.checkedAt) || !isValidSha(value.sha)) return undefined
  const defaultBranch = sanitizeRequiredText(value.defaultBranch)
  if (defaultBranch === undefined) return undefined
  if (value.change === 'unchanged') {
    return {kind: 'checked', change: 'unchanged', defaultBranch, sha: value.sha}
  }
  if (value.change === 'fast-forward') {
    if (!isValidSha(value.fromSha) || value.fromSha === value.sha) return undefined
    return {kind: 'checked', change: 'fast-forward', defaultBranch, sha: value.sha, fromSha: value.fromSha}
  }
  return undefined
}

function normalizeCheckoutHead(value) {
  if (!isObjectLike(value)) return undefined
  if (value.kind === 'attached') {
    const branch = sanitizeRequiredText(value.branch)
    return branch !== undefined && isValidSha(value.sha) ? {kind: 'attached', branch, sha: value.sha} : undefined
  }
  if (value.kind === 'detached') {
    return isValidSha(value.sha) ? {kind: 'detached', sha: value.sha} : undefined
  }
  // Unknown kind — a missing branch must never be read as "detached".
  return undefined
}

function normalizeWorktreeState(value) {
  if (!isObjectLike(value)) return undefined
  if (value.kind === 'clean') return {kind: 'clean'}
  if (
    value.kind === 'dirty' &&
    isNonNegativeSafeInteger(value.staged) &&
    isNonNegativeSafeInteger(value.unstaged) &&
    isNonNegativeSafeInteger(value.untracked) &&
    isNonNegativeSafeInteger(value.conflicted)
  ) {
    return {
      kind: 'dirty',
      staged: value.staged,
      unstaged: value.unstaged,
      untracked: value.untracked,
      conflicted: value.conflicted,
    }
  }
  return undefined
}

/**
 * Validate and close a wire `checkoutProvenance` into a DTO, or undefined.
 * observedAt / checkedAt are validated for presence but never carried.
 */
function normalizeCheckoutProvenance(value) {
  if (!isObjectLike(value)) return undefined
  const remote = normalizeRemoteFreshness(value.remote)
  if (remote === undefined) return undefined
  if (value.kind === 'unavailable') return {kind: 'unavailable', remote}
  if (value.kind !== 'observed') return undefined
  const observation = value.observation
  if (!isObjectLike(observation)) return undefined
  const head = normalizeCheckoutHead(observation.head)
  const worktree = normalizeWorktreeState(observation.worktree)
  if (
    head === undefined ||
    worktree === undefined ||
    typeof observation.operationInProgress !== 'string' ||
    !CHECKOUT_OPERATIONS.has(observation.operationInProgress) ||
    !isNonEmptyString(observation.observedAt)
  ) {
    return undefined
  }
  return {kind: 'observed', head, worktree, operation: observation.operationInProgress, remote}
}

function normalizeCheckoutPreparationRefused(value) {
  const {reason} = value
  if (typeof reason !== 'string' || !CHECKOUT_REFUSAL_REASONS.has(reason)) return undefined
  switch (reason) {
    case 'unsupported-layout': {
      return typeof value.layoutReason === 'string' && CHECKOUT_LAYOUT_REASONS.has(value.layoutReason)
        ? {outcome: 'refused', reason, layoutReason: value.layoutReason}
        : undefined
    }
    case 'unsupported-config': {
      const disallowedKeys = normalizeStringList(value.disallowedKeys)
      return disallowedKeys === undefined ? undefined : {outcome: 'refused', reason, disallowedKeys}
    }
    case 'operation-in-progress': {
      return typeof value.operation === 'string' && CHECKOUT_OPERATIONS.has(value.operation)
        ? {outcome: 'refused', reason, operation: value.operation}
        : undefined
    }
    case 'dirty': {
      const changedPaths = normalizeStringList(value.changedPaths)
      return changedPaths === undefined ? undefined : {outcome: 'refused', reason, changedPaths}
    }
    case 'submodule-initialized': {
      const submodules = normalizeStringList(value.submodules)
      return submodules === undefined ? undefined : {outcome: 'refused', reason, submodules}
    }
    case 'non-default-branch': {
      const branch = sanitizeRequiredText(value.branch)
      return branch === undefined ? undefined : {outcome: 'refused', reason, branch}
    }
    case 'obstructed': {
      const obstructions = normalizeObstructions(value.obstructions)
      return obstructions === undefined ? undefined : {outcome: 'refused', reason, obstructions}
    }
    default: {
      // needs-recovery, checkout-substituted, detached, diverged, ahead, maintenance-hold
      return {outcome: 'refused', reason}
    }
  }
}

/** Validate and close a wire `checkoutPreparation` into a DTO, or undefined. */
function normalizeCheckoutPreparation(value) {
  if (!isObjectLike(value)) return undefined
  if (value.outcome === 'refused') return normalizeCheckoutPreparationRefused(value)
  if (value.outcome !== 'failed') return undefined
  if (typeof value.reason !== 'string' || !CHECKOUT_UPDATE_FAILURE_REASONS.has(value.reason)) return undefined
  if (value.mutationStarted !== true && value.mutationStarted !== false && value.mutationStarted !== 'possibly') {
    return undefined
  }
  if (typeof value.permanent !== 'boolean') return undefined
  return {
    outcome: 'failed',
    reason: value.reason,
    mutationStarted: value.mutationStarted,
    permanent: value.permanent,
  }
}

// ---------------------------------------------------------------------------
// CRLF normalization
// ---------------------------------------------------------------------------

/**
 * Normalize CRLF and lone CR line endings to LF.
 * Must be applied before searching for record boundaries.
 */
function normalizeCrlf(text) {
  // Replace \r\n first (order matters — avoids double-replacing the \r)
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

// ---------------------------------------------------------------------------
// Question frame parser
//
// Behaves identically to the server reader's parseQuestionFrame
// (src/gateway/operator-contract/question-frame.ts); a parity test feeds the same
// inputs to both. Question and answer text is untrusted: the text rule converts tab,
// newline and carriage return to spaces and removes every other control and bidi
// character. Bounds are enforced after that rule. A frame that is malformed, closed-
// object-violating (any extra key, including an own __proto__) or over-bound is
// rejected whole — never truncated. Zero questions is valid.
// ---------------------------------------------------------------------------

const QUESTION_HEADER_MAX_LENGTH = 128
const QUESTION_TEXT_MAX_LENGTH = 4096
const QUESTION_OPTION_LABEL_MAX_LENGTH = 256
const QUESTION_OPTION_DESCRIPTION_MAX_LENGTH = 1024
const MAX_QUESTIONS_PER_REQUEST = 8
const MAX_OPTIONS_PER_QUESTION = 64

// Removed outright: C0 controls except tab/LF/CR, DEL, C1 controls, and every Unicode bidi control
// (marks U+200E/U+200F/U+061C, embeddings and overrides U+202A-U+202E, isolates U+2066-U+2069).
// eslint-disable-next-line no-control-regex
const QUESTION_REMOVED_CHARS = /[\u0000-\u0008\v\f\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
const QUESTION_WHITESPACE_CHARS = /[\t\n\r]/g

function sanitizeQuestionText(value) {
  return value.replaceAll(QUESTION_WHITESPACE_CHARS, ' ').replaceAll(QUESTION_REMOVED_CHARS, '')
}

function isQuestionRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when the value's own enumerable keys are exactly `keys`. An own `__proto__` counts as a key, so it fails. */
function hasExactKeys(value, keys) {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** Sanitize a bounded string, or null when it is not a string or is over its bound after sanitizing. */
function boundedQuestionText(value, maxLength) {
  if (typeof value !== 'string') return null
  const clean = sanitizeQuestionText(value)
  return clean.length <= maxLength ? clean : null
}

function parseQuestionOption(value) {
  if (!isQuestionRecord(value) || !hasExactKeys(value, ['label', 'description'])) return null
  const label = boundedQuestionText(value.label, QUESTION_OPTION_LABEL_MAX_LENGTH)
  const description = boundedQuestionText(value.description, QUESTION_OPTION_DESCRIPTION_MAX_LENGTH)
  if (label === null || description === null) return null
  return {label, description}
}

function parseQuestionPrompt(value) {
  if (!isQuestionRecord(value) || !hasExactKeys(value, ['header', 'text', 'options', 'multiple', 'custom'])) return null
  const header = boundedQuestionText(value.header, QUESTION_HEADER_MAX_LENGTH)
  const text = boundedQuestionText(value.text, QUESTION_TEXT_MAX_LENGTH)
  if (header === null || text === null) return null
  if (typeof value.multiple !== 'boolean' || typeof value.custom !== 'boolean') return null
  if (!Array.isArray(value.options) || value.options.length > MAX_OPTIONS_PER_QUESTION) return null
  const options = []
  for (const entry of value.options) {
    const option = parseQuestionOption(entry)
    if (option === null) return null
    options.push(option)
  }
  return {header, text, options, multiple: value.multiple, custom: value.custom}
}

/**
 * Validate one `question` frame payload (already JSON-parsed) into a closed frame object, or
 * null when it is malformed or out of bounds. Never throws; the result is rebuilt field by
 * field so no input object or nested part reaches a caller.
 */
function parseQuestionFramePayload(value) {
  if (!isQuestionRecord(value) || typeof value.settled !== 'boolean') return null
  if (!isNonEmptyString(value.runId) || !isNonEmptyString(value.requestID)) return null

  if (value.settled) {
    if (!hasExactKeys(value, ['runId', 'requestID', 'settled'])) return null
    return {runId: value.runId, requestID: value.requestID, settled: true}
  }

  if (!hasExactKeys(value, ['runId', 'requestID', 'settled', 'questions'])) return null
  if (!Array.isArray(value.questions) || value.questions.length > MAX_QUESTIONS_PER_REQUEST) return null
  const questions = []
  for (const entry of value.questions) {
    const question = parseQuestionPrompt(entry)
    if (question === null) return null
    questions.push(question)
  }
  return {runId: value.runId, requestID: value.requestID, settled: false, questions}
}

// ---------------------------------------------------------------------------
// Pure SSE frame parser
// ---------------------------------------------------------------------------

/**
 * Parse a single SSE record (the text between two blank lines) into a typed
 * frame result or null (for comment-only records like heartbeats).
 *
 * Returns:
 *   null                          — comment-only record (heartbeat); no frame
 *   { success: true, frame }      — a valid named frame
 *   { success: false, error }     — parse failure; error is a fixed string (no-oracle)
 *
 * NO-ORACLE: error strings are fixed. They never echo, interpolate, or stringify
 * any part of the input.
 *
 * Input is normalized for CRLF before parsing.
 */
export function parseSseFrame(record) {
  const normalized = normalizeCrlf(record)
  const lines = normalized.split('\n')
  let eventName
  let dataLine

  for (const line of lines) {
    if (line.startsWith(':')) {
      // SSE comment (e.g. ": heartbeat") — skip
      continue
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLine = line.slice('data:'.length).trim()
    }
  }

  // Comment-only record (heartbeat) — produce no frame
  if (eventName === undefined && dataLine === undefined) {
    return null
  }

  // Record has data but no event name
  if (eventName === undefined) {
    return {success: false, error: 'sse record missing event name'}
  }

  // Parse the data field as JSON
  let parsed
  try {
    parsed = JSON.parse(dataLine ?? 'null')
  } catch {
    return {success: false, error: 'sse record data is not valid JSON'}
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {success: false, error: 'sse record data is not a JSON object'}
  }

  if (eventName === 'ready') {
    if (typeof parsed.contractVersion !== 'string') {
      return {success: false, error: 'ready frame missing contractVersion string'}
    }
    return {
      success: true,
      frame: {type: 'ready', data: {contractVersion: parsed.contractVersion}},
    }
  }

  if (eventName === 'status') {
    if (
      typeof parsed.runId !== 'string' ||
      typeof parsed.entityRef !== 'string' ||
      typeof parsed.surface !== 'string' ||
      typeof parsed.phase !== 'string' ||
      typeof parsed.status !== 'string' ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.stale !== 'boolean'
    ) {
      return {success: false, error: 'status frame missing required fields'}
    }
    // Allowlist-gate enumerated fields — fail closed on out-of-set values
    if (!VALID_STATUSES.has(parsed.status)) {
      return {success: false, error: 'status frame status value not in allowlist'}
    }
    if (!VALID_PHASES.has(parsed.phase)) {
      return {success: false, error: 'status frame phase value not in allowlist'}
    }
    if (!VALID_SURFACES.has(parsed.surface)) {
      return {success: false, error: 'status frame surface value not in allowlist'}
    }
    // failureKind is optional and allowlist-gated; an unrecognized or absent
    // value normalizes to omitted — it never fails validity of the status frame.
    const failureKind = VALID_FAILURE_KINDS.has(parsed.failureKind) ? parsed.failureKind : undefined
    // checkoutProvenance / checkoutPreparation follow the same soft rule: validated
    // field by field, capped and sanitized, closed into a DTO. Invalid or absent →
    // omitted. They never fail the status frame.
    const checkoutProvenance = normalizeCheckoutProvenance(parsed.checkoutProvenance)
    const checkoutPreparation = normalizeCheckoutPreparation(parsed.checkoutPreparation)
    return {
      success: true,
      frame: {
        type: 'status',
        data: {
          runId: parsed.runId,
          entityRef: parsed.entityRef,
          surface: parsed.surface,
          phase: parsed.phase,
          status: parsed.status,
          startedAt: parsed.startedAt,
          stale: parsed.stale,
          ...(failureKind === undefined ? {} : {failureKind}),
          ...(checkoutProvenance === undefined ? {} : {checkoutProvenance}),
          ...(checkoutPreparation === undefined ? {} : {checkoutPreparation}),
        },
      },
    }
  }

  if (eventName === 'reset') {
    if (typeof parsed.runId !== 'string') {
      return {success: false, error: 'reset frame missing runId string'}
    }
    if (typeof parsed.reason !== 'string' || !VALID_RESET_REASONS.has(parsed.reason)) {
      return {success: false, error: 'reset frame has unrecognized reason value'}
    }
    return {
      success: true,
      frame: {type: 'reset', data: {runId: parsed.runId, reason: parsed.reason}},
    }
  }

  if (eventName === 'output') {
    if (
      typeof parsed.runId !== 'string' ||
      typeof parsed.text !== 'string' ||
      typeof parsed.final !== 'boolean' ||
      typeof parsed.seq !== 'number' ||
      !Number.isSafeInteger(parsed.seq) ||
      parsed.seq < 0
    ) {
      return {success: false, error: 'output frame missing required fields'}
    }
    if (
      parsed.droppedCount !== undefined &&
      (typeof parsed.droppedCount !== 'number' ||
        !Number.isSafeInteger(parsed.droppedCount) ||
        parsed.droppedCount < 0)
    ) {
      return {success: false, error: 'output frame droppedCount is not a non-negative integer'}
    }
    const data =
      parsed.droppedCount === undefined
        ? {runId: parsed.runId, text: parsed.text, final: parsed.final, seq: parsed.seq}
        : {runId: parsed.runId, text: parsed.text, final: parsed.final, seq: parsed.seq, droppedCount: parsed.droppedCount}
    return {success: true, frame: {type: 'output', data}}
  }

  if (eventName === 'approval') {
    // Validate runId and requestID — required on both variants; must be non-empty strings
    if (
      typeof parsed.runId !== 'string' ||
      parsed.runId.length === 0 ||
      typeof parsed.requestID !== 'string' ||
      parsed.requestID.length === 0
    ) {
      return {success: false, error: 'approval frame missing required fields'}
    }
    // settled must be a boolean — reject anything else (string, number, null, etc.)
    if (typeof parsed.settled !== 'boolean') {
      return {success: false, error: 'approval frame has invalid settled discriminator'}
    }
    if (parsed.settled === false) {
      // Open variant: permission is required and must be non-empty; command and filepath are optional strings
      if (typeof parsed.permission !== 'string' || parsed.permission.length === 0) {
        return {success: false, error: 'approval frame missing required fields'}
      }
      if (parsed.command !== undefined && typeof parsed.command !== 'string') {
        return {success: false, error: 'approval frame missing required fields'}
      }
      if (parsed.filepath !== undefined && typeof parsed.filepath !== 'string') {
        return {success: false, error: 'approval frame missing required fields'}
      }
      const data = {
        runId: parsed.runId,
        requestID: parsed.requestID,
        permission: parsed.permission,
        settled: false,
        ...(parsed.command === undefined ? {} : {command: parsed.command}),
        ...(parsed.filepath === undefined ? {} : {filepath: parsed.filepath}),
      }
      return {success: true, frame: {type: 'approval', data}}
    } else {
      // Settle variant: only runId/requestID/settled required
      const data = {
        runId: parsed.runId,
        requestID: parsed.requestID,
        settled: true,
      }
      return {success: true, frame: {type: 'approval', data}}
    }
  }

  if (eventName === 'question') {
    // The reject path returns a fixed string: question text and IDs are never echoed or logged.
    const data = parseQuestionFramePayload(parsed)
    if (data === null) {
      return {success: false, error: 'question frame failed validation'}
    }
    return {success: true, frame: {type: 'question', data}}
  }

  // Unknown event name — fixed error string, never echoes the name
  return {success: false, error: 'sse record has unrecognized event name'}
}

// ---------------------------------------------------------------------------
// Question page store
//
// Tombstones and drafts outlive stream handles: stream state is created fresh on each
// attach, so keeping them there would let a late pending list resurrect a settled
// request after a card collapses and re-expands. The store is a module-level map keyed
// by run ID, in memory only (never persisted), and dies with the page — logout navigates.
//
// Tombstones are NOT evicted: they grow only with questions actually settled, which keeps
// "a settled request never reappears" true for the page. Drafts are keyed by requestID.
//
// The reducer reads and writes this store directly. That makes nextStreamState impure for
// question frames by design: the store must be visible to a new handle for the same run,
// which a value held in the reducer's own state can never be.
// ---------------------------------------------------------------------------

const questionPageStore = new Map()

// Statuses kept for a request that is no longer open (a note until the card collapses). Every
// other status leaves with its request.
const QUESTION_NOTE_KINDS = new Set(['claimed', 'already-settled', 'gone'])

// Statuses while a decision or check is outstanding: the card refuses new decisions. A request
// claimed elsewhere is not here: the operator may answer it, and the gateway's single settlement
// resolves the race (already_settled and claimed clear it, already_claimed keeps the note).
const QUESTION_SEND_BLOCKED_KINDS = new Set(['in-flight', 'checking'])

// The one wording for each note outcome, shared by the note card and the open card.
const QUESTION_NOTE_COPY = Object.freeze({
  claimed: 'This question is no longer open.',
  'already-settled': 'This question is no longer open.',
  gone: 'This question is no longer open. Your answer may have been recorded.',
})

/**
 * The page-level question record for a run: `{tombstones: Set<requestID>, drafts: Map<requestID, draft>}`.
 * Created on first use. The returned object is live — callers mutate it directly.
 */
export function getQuestionPageStore(runId) {
  let record = questionPageStore.get(runId)
  if (record === undefined) {
    record = {tombstones: new Set(), drafts: new Map()}
    questionPageStore.set(runId, record)
  }
  return record
}

/** Drop every run's tombstones and drafts. For tests and logout-equivalent teardown. */
export function resetQuestionPageStore() {
  questionPageStore.clear()
}

/**
 * Tombstone a question request for the page and drop it from the run entry: its open request, its
 * draft, and any claimed exemption. Shared by the settle frame and by this page's own
 * `claimed` / `already_settled` decision response, which settle a request the same way. A request
 * never seen open still tombstones (settle-before-open). `base` is the run entry (or its stub).
 */
function settleQuestionInState(current, base, runId, requestID) {
  const store = getQuestionPageStore(runId)
  store.tombstones.add(requestID)
  store.drafts.delete(requestID)
  const nextOpen = new Map(base.questionOpen ?? new Map())
  nextOpen.delete(requestID)
  const nextExempt = new Set(base.questionClaimedExempt ?? new Set())
  nextExempt.delete(requestID)
  const updatedEntry = {...base, questionOpen: nextOpen, questionClaimedExempt: nextExempt}
  return {...current, runs: Object.assign(Object.create(null), current.runs, {[runId]: updatedEntry})}
}

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * Pure reducer: given the current stream state and an event, return the next state.
 *
 * State shape:
 *   connection: 'connecting' | 'live' | 'reconnecting' | 'drift' | 'not-found' |
 *               'backpressure' | 'failed' | 'closed'
 *   runs: Object.create(null) — null-prototype map keyed by runId
 *   retryCount: number
 *   shouldReconnect: boolean
 *   summaryStatus?: the run-list summary status for the stream's run (optional; set at init).
 *                   A terminal value lets `reset` (no-snapshot) close the card without a status frame.
 *   snapshotMissing?: null-prototype map of runId → true after a no-snapshot reset that left the
 *                     run live. Cleared by an output frame; read by a terminal status frame.
 *
 * Events (discriminated by type):
 *   { type: 'ready', data: { contractVersion } }
 *   { type: 'status', data: OperatorRunStatus }
 *   { type: 'reset', data: { runId, reason } }
 *   { type: 'http-status', code: 404 | 429 }
 *   { type: 'network-error' }
 *   { type: 'stream-closed' }
 *   { type: 'unexpected-close' }
 *
 * Drift is absorbing: once in drift, ready/status do not move back to live.
 * A status before any ready is not rendered.
 */
export function nextStreamState(current, event) {
  switch (event.type) {
    case 'ready': {
      // Drift is absorbing — a second ready does not escape drift
      if (current.connection === 'drift') {
        return current
      }
      if (event.data.contractVersion !== PINNED_CONTRACT_VERSION) {
        // Contract version mismatch — fail closed, clear all run state
        return {
          connection: 'drift',
          runs: Object.create(null),
          retryCount: current.retryCount,
          shouldReconnect: false,
        }
      }
      return {
        ...current,
        connection: 'live',
        shouldReconnect: false,
      }
    }

    case 'status': {
      // Status before ready (connection !== 'live') is not rendered
      if (current.connection !== 'live') {
        return current
      }
      const {runId, status, phase, startedAt, stale, failureKind, checkoutProvenance, checkoutPreparation} = event.data
      const isTerminal = TERMINAL_STATUSES.has(status)
      // Use a null-prototype object to guard against __proto__ key pollution.
      // Spread the prior entry so accumulated output fields (outputText/outputSeq/
      // outputFinal/outputCoalesced) survive a status update — a terminal status frame
      // arrives AFTER the final output frame, so a bare replacement would drop it.
      const prevStatusEntry = current.runs[runId]
      // Reason label is derived only for a failed status carrying a known failureKind.
      // A non-failed status ignores any failureKind entirely. Once set, the label
      // is sticky — a later non-terminal frame for the same run (e.g. a stale/duplicate
      // frame) must not clear a previously stored terminal-failure label.
      const derivedReasonLabel =
        status === 'failed' && failureKind !== undefined ? FAILURE_REASON_LABELS[failureKind] : undefined
      const reasonLabel = derivedReasonLabel ?? prevStatusEntry?.reasonLabel
      // On terminal status, clear all open approval prompts for this run.
      // Terminal is absorbing for approvals: once terminal, no open prompt can reappear.
      // Tombstones are preserved so that any late open frames are still ignored.
      const approvalFields = isTerminal
        ? {
            approvalOpenPrompts: Object.create(null),
            approvalTombstones: prevStatusEntry?.approvalTombstones ?? Object.create(null),
          }
        : {
            approvalOpenPrompts: prevStatusEntry?.approvalOpenPrompts,
            approvalTombstones: prevStatusEntry?.approvalTombstones,
          }
      const nextEntry = {
        ...prevStatusEntry,
        ...approvalFields,
        runId,
        status,
        phase,
        startedAt,
        stale,
        terminal: isTerminal,
        // Terminal-wins: a terminal status frame from ANY source clears cancelInFlight.
        // A non-terminal frame preserves whatever the prior entry carried (spread above).
        ...(isTerminal ? {cancelInFlight: false} : {}),
        ...(reasonLabel === undefined ? {} : {reasonLabel}),
      }
      // Checkout fields: latest VALID value wins, per field. An absent or invalid value
      // (the parser omitted it) keeps whatever is stored — including on the terminal frame.
      // The two are exclusive in browser state: the contract sends provenance only for runs
      // that reached EXECUTING and preparation only for runs that never did, so storing a
      // valid value for one clears the other. If a (contract-impossible) frame carries both,
      // preparation is applied last and wins.
      if (checkoutProvenance !== undefined) {
        nextEntry.checkoutProvenance = checkoutProvenance
        delete nextEntry.checkoutPreparation
      }
      if (checkoutPreparation !== undefined) {
        nextEntry.checkoutPreparation = checkoutPreparation
        delete nextEntry.checkoutProvenance
      }
      // Terminal clears the run's open questions, the claimed exemption, and every draft in the
      // page store — with NO tombstone (the gateway sends no settle frame at terminal; terminal
      // is absorbing, so nothing can reopen). Tombstones stay: they are the page's memory.
      if (isTerminal) {
        questionPageStore.get(runId)?.drafts.clear()
        if (prevStatusEntry?.questionOpen !== undefined) {
          nextEntry.questionOpen = new Map()
          nextEntry.questionClaimedExempt = new Set()
        }
        // A terminal status after a no-snapshot reset with no output since: the snapshot (and the
        // output it carried) expired, so say so in the card. An output frame clears the mark.
        if (current.snapshotMissing?.[runId] === true && typeof prevStatusEntry?.outputSeq !== 'number') {
          nextEntry.outputUnavailable = true
        }
      }
      const updatedRuns = Object.assign(Object.create(null), current.runs, {[runId]: nextEntry})
      // If all observed runs are terminal, close the stream
      const allTerminal =
        Object.keys(updatedRuns).length > 0 &&
        Object.values(updatedRuns).every(r => r.terminal)
      return {
        ...current,
        runs: updatedRuns,
        connection: allTerminal ? 'closed' : current.connection,
        shouldReconnect: allTerminal ? false : current.shouldReconnect,
      }
    }

    case 'cancel': {
      // Dispatched when the browser sends the cancel POST for a run. Marks the run
      // as having a cancel in flight — an internal-only field, never exposed via
      // toSafeRunView. Terminal is absorbing: a cancel action on an already-terminal
      // run entry must never re-open it or set cancelInFlight (terminal-wins).
      if (current.connection !== 'live') {
        return current
      }
      const {runId} = event.data
      const prevEntry = current.runs[runId]
      if (prevEntry !== undefined && prevEntry.terminal) {
        return current
      }
      const base = prevEntry ?? {
        runId,
        status: '',
        phase: '',
        startedAt: '',
        stale: false,
        terminal: false,
      }
      const updatedRuns = Object.assign(Object.create(null), current.runs, {
        [runId]: {
          ...base,
          cancelInFlight: true,
        },
      })
      return {...current, runs: updatedRuns}
    }

    case 'approval': {
      // Approval frames before ready (connection !== 'live') are ignored — mirrors output/status gating.
      if (current.connection !== 'live') {
        return current
      }
      const {runId, requestID, settled} = event.data
      const prevEntry = current.runs[runId]

      // If the run is already terminal, all approval frames are ignored (terminal is absorbing).
      if (prevEntry !== undefined && prevEntry.terminal) {
        return current
      }

      // Build the base entry (may be a new run entry if we've never seen a status for this run).
      const base = prevEntry ?? {
        runId,
        status: '',
        phase: '',
        startedAt: '',
        stale: false,
        terminal: false,
      }

      // Null-proto maps for open prompts and tombstones — guard against __proto__ key pollution.
      const prevOpenPrompts = base.approvalOpenPrompts ?? Object.create(null)
      const prevTombstones = base.approvalTombstones ?? Object.create(null)

      if (settled) {
        // Settle frame: remove from open-prompts map AND add to tombstone set.
        // A settle for a requestID never seen open → still tombstone it (no spurious UI).
        const nextOpenPrompts = Object.assign(Object.create(null), prevOpenPrompts)
        delete nextOpenPrompts[requestID]
        // Cap the tombstone map: if at cap and requestID is new, evict the oldest entry (FIFO).
        let tombstoneBase = prevTombstones
        if (!(requestID in prevTombstones) && Object.keys(prevTombstones).length >= MAX_APPROVAL_TOMBSTONES) {
          const oldestKey = Object.keys(prevTombstones)[0]
          tombstoneBase = Object.assign(Object.create(null), prevTombstones)
          delete tombstoneBase[oldestKey]
        }
        const nextTombstones = Object.assign(Object.create(null), tombstoneBase, {[requestID]: true})
        const updatedEntry = {
          ...base,
          approvalOpenPrompts: nextOpenPrompts,
          approvalTombstones: nextTombstones,
        }
        const updatedRuns = Object.assign(Object.create(null), current.runs, {[runId]: updatedEntry})
        return {...current, runs: updatedRuns}
      } else {
        // Open frame: if requestID is already tombstoned → IGNORE (open-after-settle / id-reuse guard).
        if (prevTombstones[requestID] === true) {
          return current
        }
        // Cap the open-prompts map: if at cap and requestID is new, ignore the overflow open.
        // (Never evict an existing open prompt — losing a real pending prompt is worse than dropping overflow.)
        if (!(requestID in prevOpenPrompts) && Object.keys(prevOpenPrompts).length >= MAX_OPEN_APPROVALS) {
          return current
        }
        // Add/replace in the open-prompts map (duplicate open for same id is idempotent).
        const promptData = {
          runId: event.data.runId,
          requestID: event.data.requestID,
          permission: event.data.permission,
          settled: false,
          ...(event.data.command === undefined ? {} : {command: event.data.command}),
          ...(event.data.filepath === undefined ? {} : {filepath: event.data.filepath}),
        }
        const nextOpenPrompts = Object.assign(Object.create(null), prevOpenPrompts, {[requestID]: promptData})
        const updatedEntry = {
          ...base,
          approvalOpenPrompts: nextOpenPrompts,
          approvalTombstones: prevTombstones,
        }
        const updatedRuns = Object.assign(Object.create(null), current.runs, {[runId]: updatedEntry})
        return {...current, runs: updatedRuns}
      }
    }

    case 'output': {
      // Output before ready (connection !== 'live') is not applied.
      if (current.connection !== 'live') {
        return current
      }
      const {runId, text, final, seq, droppedCount} = event.data
      const prev = current.runs[runId]
      const prevText = prev?.outputText ?? ''
      const prevSeq = prev?.outputSeq ?? -1
      const prevCoalesced = prev?.outputCoalesced ?? false
      const coalesced = prevCoalesced || (typeof droppedCount === 'number' && droppedCount > 0)

      let nextText = prevText
      let nextSeq = prevSeq
      if (final) {
        // Authoritative complete answer replaces the accumulated text regardless of seq.
        nextText = text
        nextSeq = seq
      } else if (seq > prevSeq) {
        // Apply deltas only in strictly increasing seq order; drop stale/duplicate seqs.
        nextText = prevText + text
        nextSeq = seq
      } else if (coalesced === prevCoalesced) {
        // Out-of-order / duplicate delta with no new coalesced signal — ignore entirely.
        return current
      }
      // else: stale-seq delta but a new coalesced signal — fall through to record it.

      // Bound cumulative growth: a stream of valid deltas must not grow the answer
      // without limit. Truncate and flag — never echo a count.
      const prevTruncated = prev?.outputTruncated ?? false
      let truncated = prevTruncated
      if (nextText.length > MAX_OUTPUT_TEXT_CHARS) {
        nextText = nextText.slice(0, MAX_OUTPUT_TEXT_CHARS)
        truncated = true
      }

      const base = prev ?? {runId, status: '', phase: '', startedAt: '', stale: false, terminal: false}
      const nextOutputEntry = {
        ...base,
        runId,
        outputText: nextText,
        outputSeq: nextSeq,
        outputFinal: final ? true : (prev?.outputFinal ?? false),
        outputCoalesced: coalesced,
        outputTruncated: truncated,
      }
      // An output frame proves the snapshot is not missing: clear the mark and any unavailable state.
      delete nextOutputEntry.outputUnavailable
      const updatedRuns = Object.assign(Object.create(null), current.runs, {[runId]: nextOutputEntry})
      if (current.snapshotMissing?.[runId] !== true) {
        return {...current, runs: updatedRuns}
      }
      const remainingMissing = Object.assign(Object.create(null), current.snapshotMissing)
      delete remainingMissing[runId]
      return {...current, runs: updatedRuns, snapshotMissing: remainingMissing}
    }

    case 'reset': {
      const {reason} = event.data

      // Terminal reset reason → close (no reconnect)
      if (reason === 'terminal') {
        return {
          ...current,
          connection: 'closed',
          shouldReconnect: false,
        }
      }

      // max-duration: reconnect only if the run is still active
      if (reason === 'max-duration') {
        const runEntry = current.runs[event.data.runId]
        const runIsActive = runEntry !== undefined && !runEntry.terminal
        if (!runIsActive) {
          return {
            ...current,
            connection: 'closed',
            shouldReconnect: false,
          }
        }
      }

      // no-snapshot: the gateway has no replay entry for this run (expired after its
      // retention window, or lost on restart) and KEEPS THE SUBSCRIPTION OPEN afterwards, so a
      // reconnect would park on a reader that never ends and strand the card on "Connecting".
      // Never reconnect for it:
      //   - the run is known terminal (from the stream, or from its run-list summary): show that
      //     terminal status plus the unavailable state, and close;
      //   - otherwise the run's state is unknown, which is not evidence of terminal: stay live,
      //     spend no retry, and mark the snapshot missing so a later terminal status with no
      //     output since can show the unavailable state.
      if (reason === 'no-snapshot') {
        const resetRunId = event.data.runId
        const runEntry = current.runs[resetRunId]
        const summaryStatus = current.summaryStatus
        const summaryIsTerminal = typeof summaryStatus === 'string' && TERMINAL_STATUSES.has(summaryStatus)
        if (runEntry?.terminal === true || summaryIsTerminal) {
          // Terminal clears the page store's drafts, as the status-frame terminal path does.
          questionPageStore.get(resetRunId)?.drafts.clear()
          const knownTerminal = runEntry?.terminal === true
          const terminalEntry = knownTerminal
            ? {...runEntry}
            : {
                phase: '',
                startedAt: '',
                stale: false,
                ...runEntry,
                runId: resetRunId,
                status: summaryStatus,
                terminal: true,
                cancelInFlight: false,
                approvalOpenPrompts: Object.create(null),
                ...(runEntry?.questionOpen === undefined
                  ? {}
                  : {questionOpen: new Map(), questionClaimedExempt: new Set()}),
              }
          if (typeof terminalEntry.outputSeq !== 'number') {
            terminalEntry.outputUnavailable = true
          }
          return {
            ...current,
            runs: Object.assign(Object.create(null), current.runs, {[resetRunId]: terminalEntry}),
            connection: 'closed',
            shouldReconnect: false,
          }
        }
        return {
          ...current,
          snapshotMissing: Object.assign(Object.create(null), current.snapshotMissing, {[resetRunId]: true}),
        }
      }

      // Increment retryCount on reset and cap at RETRY_MAX_COUNT
      if (current.retryCount >= RETRY_MAX_COUNT) {
        return {
          ...current,
          connection: 'failed',
          shouldReconnect: false,
        }
      }
      return {
        ...current,
        connection: 'reconnecting',
        retryCount: current.retryCount + 1,
        shouldReconnect: true,
      }
    }

    case 'http-status': {
      if (event.code === 404) {
        return {
          ...current,
          connection: 'not-found',
          shouldReconnect: false,
        }
      }
      if (event.code === 429) {
        return {
          ...current,
          connection: 'backpressure',
          shouldReconnect: false,
        }
      }
      return {
        ...current,
        connection: 'failed',
        shouldReconnect: false,
      }
    }

    case 'network-error': {
      // Guard terminal-ish display states: abort-rejection from close() must not reopen
      if (
        current.connection === 'closed' ||
        current.connection === 'submitted-unobservable'
      ) {
        return current
      }
      if (current.retryCount >= RETRY_MAX_COUNT) {
        return {
          ...current,
          connection: 'failed',
          shouldReconnect: false,
        }
      }
      return {
        ...current,
        connection: 'reconnecting',
        retryCount: current.retryCount + 1,
        shouldReconnect: true,
      }
    }

    case 'stream-closed': {
      return {
        ...current,
        connection: 'closed',
        shouldReconnect: false,
      }
    }

    case 'unexpected-close': {
      // Guard terminal-ish display states: abort-rejection from close() must not reopen
      if (
        current.connection === 'closed' ||
        current.connection === 'submitted-unobservable'
      ) {
        return current
      }
      if (current.retryCount >= RETRY_MAX_COUNT) {
        return {
          ...current,
          connection: 'failed',
          shouldReconnect: false,
        }
      }
      return {
        ...current,
        connection: 'reconnecting',
        retryCount: current.retryCount + 1,
        shouldReconnect: true,
      }
    }

    case 'approval-reconcile': {
      // Corrective reconcile action dispatched by reconcileApprovals on reconnect.
      // The reconnect-reconcile caller computes the explicit pruneIds and addPrompts lists from
      // a pre-GET snapshot diff — the reducer does NOT re-derive the diff, which is
      // what makes the reconcile-window race impossible.
      //
      // Before ready (connection !== 'live') → ignore (mirrors approval/output gating).
      if (current.connection !== 'live') {
        return current
      }
      const {runId, pruneIds, addPrompts} = event
      const prevEntry = current.runs[runId]

      // If the run is already terminal, all approval frames are ignored (terminal is absorbing).
      if (prevEntry !== undefined && prevEntry.terminal) {
        return current
      }

      // Build the base entry (may be a new run entry if we've never seen a status for this run).
      const base = prevEntry ?? {
        runId,
        status: '',
        phase: '',
        startedAt: '',
        stale: false,
        terminal: false,
      }

      // Null-proto maps for open prompts and tombstones — guard against __proto__ key pollution.
      let nextOpenPrompts = Object.assign(Object.create(null), base.approvalOpenPrompts ?? Object.create(null))
      let nextTombstones = base.approvalTombstones ?? Object.create(null)

      // --- Prune path ---
      // For each id in pruneIds: remove from open-prompts and add to tombstones.
      // Removing an id that's already absent is a no-op.
      // Re-tombstoning an already-tombstoned id is idempotent.
      // Reuses the FIFO-cap logic from the settle branch (~L460-472).
      for (const requestID of pruneIds) {
        // Guard against __proto__ key injection
        if (requestID === '__proto__') continue
        // Remove from open-prompts (no-op if absent)
        if (requestID in nextOpenPrompts) {
          const updated = Object.assign(Object.create(null), nextOpenPrompts)
          delete updated[requestID]
          nextOpenPrompts = updated
        }
        // Add to tombstones with FIFO cap (mirrors settle branch)
        if (!(requestID in nextTombstones) && Object.keys(nextTombstones).length >= MAX_APPROVAL_TOMBSTONES) {
          const oldestKey = Object.keys(nextTombstones)[0]
          const trimmed = Object.assign(Object.create(null), nextTombstones)
          delete trimmed[oldestKey]
          nextTombstones = trimmed
        }
        nextTombstones = Object.assign(Object.create(null), nextTombstones, {[requestID]: true})
      }

      // --- Add path ---
      // For each prompt in addPrompts whose requestID is NOT already in open-prompts
      // AND NOT tombstoned: add it. Respects the existing MAX_OPEN_APPROVALS overflow guard.
      // Mirrors the open branch (~L480-505).
      for (const prompt of addPrompts) {
        const {requestID} = prompt
        // Guard against __proto__ key injection
        if (requestID === '__proto__') continue
        // Ignore if tombstoned (tombstone precedence)
        if (nextTombstones[requestID] === true) continue
        // Ignore if already open (idempotent)
        if (requestID in nextOpenPrompts) continue
        // Overflow guard: if at cap, ignore the new prompt
        if (Object.keys(nextOpenPrompts).length >= MAX_OPEN_APPROVALS) continue
        const promptData = {
          runId,
          requestID,
          permission: prompt.permission,
          settled: false,
          ...(prompt.command === undefined ? {} : {command: prompt.command}),
          ...(prompt.filepath === undefined ? {} : {filepath: prompt.filepath}),
        }
        nextOpenPrompts = Object.assign(Object.create(null), nextOpenPrompts, {[requestID]: promptData})
      }

      const updatedEntry = {
        ...base,
        approvalOpenPrompts: nextOpenPrompts,
        approvalTombstones: nextTombstones,
      }
      const updatedRuns = Object.assign(Object.create(null), current.runs, {[runId]: updatedEntry})
      return {...current, runs: updatedRuns}
    }

    case 'question': {
      // Question frames before ready (connection !== 'live') are ignored — mirrors approval gating.
      if (current.connection !== 'live') {
        return current
      }
      const {runId, requestID, settled} = event.data
      const prevEntry = current.runs[runId]

      // Terminal is absorbing: once the run is terminal, all question frames are ignored.
      if (prevEntry !== undefined && prevEntry.terminal) {
        return current
      }

      const base = prevEntry ?? {
        runId,
        status: '',
        phase: '',
        startedAt: '',
        stale: false,
        terminal: false,
      }
      const store = getQuestionPageStore(runId)
      const prevOpen = base.questionOpen ?? new Map()
      const prevExempt = base.questionClaimedExempt ?? new Set()

      if (settled) {
        // Settle frame: tombstone for the page, remove the request, its draft, and any claimed
        // exemption. A settle for a request never seen open still tombstones (settle-before-open).
        return settleQuestionInState(current, base, runId, requestID)
      }

      // Open frame: a tombstoned request is ignored (open-after-settle / id-reuse guard).
      if (store.tombstones.has(requestID)) {
        return current
      }
      // A repeated open keeps the existing entry and its draft — replayed opens add nothing.
      if (prevOpen.has(requestID)) {
        return current
      }
      // Cap: reject the overflow open; never evict a real pending question.
      if (prevOpen.size >= MAX_OPEN_QUESTIONS) {
        return current
      }
      const nextOpen = new Map(prevOpen)
      nextOpen.set(requestID, {requestID, questions: event.data.questions})
      const updatedEntry = {
        ...base,
        questionOpen: nextOpen,
        questionClaimedExempt: prevExempt,
      }
      return {...current, runs: Object.assign(Object.create(null), current.runs, {[runId]: updatedEntry})}
    }

    case 'question-reconcile': {
      // Result of a pending-question list check. Like approval-reconcile, the caller computes the
      // inputs from a pre-GET snapshot (`snapshotIds`) — the ids open locally BEFORE the request —
      // so anything that opened over SSE during the await is never eligible for removal.
      //
      //   invalidBody  the response body failed validation: change nothing (not even the flag)
      //   partial      the caller dropped invalid entries: the list is not a complete picture
      //   requests     the valid listed requests, `{requestID, questions}`
      //
      // Failures (network, 429, 5xx) never reach here — the caller dispatches nothing for them.
      //
      // Before ready (connection !== 'live') → ignore (mirrors question/approval gating).
      if (current.connection !== 'live') {
        return current
      }
      const {runId, snapshotIds, requests, invalidBody, partial} = event
      if (invalidBody === true) {
        return current
      }
      const prevEntry = current.runs[runId]

      // Terminal is absorbing.
      if (prevEntry !== undefined && prevEntry.terminal) {
        return current
      }

      const base = prevEntry ?? {
        runId,
        status: '',
        phase: '',
        startedAt: '',
        stale: false,
        terminal: false,
      }
      const store = getQuestionPageStore(runId)
      const nextOpen = new Map(base.questionOpen ?? new Map())
      const nextExempt = new Set(base.questionClaimedExempt ?? new Set())
      const listedIds = new Set(requests.map(request => request.requestID))

      // --- Removal path ---
      // A full list may be truncated at the gateway cap, and a partial one is missing entries the
      // caller could not validate: either way absence proves nothing, so the diff is additive only.
      // Removal never tombstones — the request may return on a later frame or list — and a
      // claimed-exempt request is skipped: the gateway excludes claimed requests from the list,
      // so its absence says nothing about them. An exemption ends only on a settle frame, a terminal
      // status, or a list that shows the request open again (the add path below).
      const additiveOnly = partial === true || requests.length >= GATEWAY_PENDING_QUESTIONS_CAP
      if (!additiveOnly) {
        for (const requestID of snapshotIds) {
          if (!listedIds.has(requestID) && !nextExempt.has(requestID)) {
            nextOpen.delete(requestID)
          }
        }
      }

      // --- Add path ---
      // Listed and not tombstoned → add (unless already open or at the cap). A list that shows a
      // claimed-exempt request ends its exemption: the claimant failed and it is open again.
      for (const request of requests) {
        const {requestID} = request
        if (nextExempt.has(requestID)) nextExempt.delete(requestID)
        if (store.tombstones.has(requestID)) continue
        if (nextOpen.has(requestID)) continue
        if (nextOpen.size >= MAX_OPEN_QUESTIONS) continue
        nextOpen.set(requestID, {requestID, questions: request.questions})
      }

      const updatedEntry = {
        ...base,
        questionOpen: nextOpen,
        questionClaimedExempt: nextExempt,
        questionReconcileDone: true,
      }
      return {...current, runs: Object.assign(Object.create(null), current.runs, {[runId]: updatedEntry})}
    }

    case 'question-reconcile-reset': {
      // A new connection cycle starts: the question list applied in the previous cycle says nothing
      // about this one, so the completed flag clears until the new cycle's list is applied. Only an
      // existing, non-terminal run entry carries the flag.
      const prevEntry = current.runs[event.runId]
      if (prevEntry === undefined || prevEntry.terminal || prevEntry.questionReconcileDone !== true) {
        return current
      }
      const updatedEntry = {...prevEntry, questionReconcileDone: false}
      return {...current, runs: Object.assign(Object.create(null), current.runs, {[event.runId]: updatedEntry})}
    }

    case 'question-resolved': {
      // This page's own decision got `claimed` or `already_settled`: the request is settled, so it is
      // tombstoned and removed exactly as a settle frame would. Unlike the frame it is not gated on
      // the connection — the POST can resolve while the stream is reconnecting. Terminal is absorbing.
      const {runId, requestID} = event
      const prevEntry = current.runs[runId]
      if (prevEntry !== undefined && prevEntry.terminal) {
        return current
      }
      const base = prevEntry ?? {
        runId,
        status: '',
        phase: '',
        startedAt: '',
        stale: false,
        terminal: false,
      }
      return settleQuestionInState(current, base, runId, requestID)
    }

    case 'question-claimed': {
      // This page got `already_claimed` for an open request: the gateway omits claimed requests from
      // the pending list, so exempt it from removal by absence. A request that is not open (or is
      // tombstoned) has nothing to protect.
      const {runId, requestID} = event
      const prevEntry = current.runs[runId]
      if (prevEntry === undefined || prevEntry.terminal) {
        return current
      }
      if (prevEntry.questionOpen?.has(requestID) !== true) {
        return current
      }
      if (getQuestionPageStore(runId).tombstones.has(requestID)) {
        return current
      }
      const nextExempt = new Set(prevEntry.questionClaimedExempt ?? new Set())
      nextExempt.add(requestID)
      const updatedEntry = {...prevEntry, questionClaimedExempt: nextExempt}
      return {...current, runs: Object.assign(Object.create(null), current.runs, {[runId]: updatedEntry})}
    }

    case 'buffer-overflow': {
      // A stream that exceeds the buffer cap is hostile or broken — fail closed
      // terminally with no reconnect, regardless of retry budget.
      return {
        ...current,
        connection: 'failed',
        shouldReconnect: false,
      }
    }

    case 'first-frame-timeout': {
      // Only applies when no frame has arrived yet (still in the initial connecting
      // or reconnecting phase). Any state that already received a frame (live, drift,
      // not-found, failed, closed, backpressure) is left unchanged — the timeout
      // fires only when the stream opened but stayed silent.
      if (
        current.connection === 'connecting' ||
        current.connection === 'reconnecting'
      ) {
        return {
          ...current,
          connection: 'submitted-unobservable',
          shouldReconnect: false,
        }
      }
      return current
    }

    default: {
      return current
    }
  }
}

// ---------------------------------------------------------------------------
// Safe render model mapper
// ---------------------------------------------------------------------------

/**
 * Map a run status object to the safe render model.
 *
 * Returns ONLY: { runId, status, phase, startedAt, stale, reasonLabel? }
 *
 * Explicitly excluded: entityRef, surface, output, tool, path, repoName,
 * failureKind, and any other field not in the safe set. This is a whitelist,
 * not a blacklist. reasonLabel is a pre-resolved dashboard display label —
 * never the raw failureKind wire value — and is present only when the run
 * entry carries one (set by nextStreamState on a failed status with a known
 * failureKind, and sticky across later frames for the same run).
 */
export function toSafeRunView(runStatus) {
  return {
    runId: runStatus.runId,
    status: runStatus.status,
    phase: runStatus.phase,
    startedAt: runStatus.startedAt,
    stale: runStatus.stale,
    ...(runStatus.reasonLabel === undefined ? {} : {reasonLabel: runStatus.reasonLabel}),
  }
}

// ---------------------------------------------------------------------------
// Approval derivation helpers
// ---------------------------------------------------------------------------

/**
 * Returns true iff the run entry has at least one open (non-tombstoned) approval prompt.
 *
 * This is the canonical visibility signal for the `waiting_for_approval` overlay and
 * the in-page open-prompt indicator. Both must derive from this one state so
 * they cannot desync.
 *
 * @param {object} runEntry - A RunEntry from the stream state's runs map.
 * @returns {boolean} True iff the run has at least one open approval prompt.
 */
export function hasOpenApprovals(runEntry) {
  if (runEntry === undefined || runEntry === null) return false
  const openPrompts = runEntry.approvalOpenPrompts
  if (openPrompts === undefined || openPrompts === null) return false
  return Object.keys(openPrompts).length > 0
}

/**
 * Returns the list of open (non-tombstoned) approval prompts for a run entry,
 * in insertion order. Each element is an open ApprovalFrameData object with
 * `{runId, requestID, permission, settled:false, command?, filepath?}`.
 *
 * Returns an empty array when there are no open prompts.
 *
 * @param {object} runEntry - A RunEntry from the stream state's runs map.
 * @returns {Array} The list of open approval prompt objects, or an empty array.
 */
export function getOpenApprovals(runEntry) {
  if (runEntry === undefined || runEntry === null) return []
  const openPrompts = runEntry.approvalOpenPrompts
  if (openPrompts === undefined || openPrompts === null) return []
  return Object.values(openPrompts)
}

// ---------------------------------------------------------------------------
// Question derivation helpers
// ---------------------------------------------------------------------------

/**
 * Returns the open questions for a run entry in arrival order. Each element is
 * `{requestID, questions}` where `questions` are the parsed, sanitized prompts.
 * Returns an empty array when there are none.
 *
 * @param {object} runEntry - A RunEntry from the stream state's runs map.
 * @returns {Array} The open question requests, or an empty array.
 */
export function getOpenQuestions(runEntry) {
  if (runEntry === undefined || runEntry === null) return []
  const open = runEntry.questionOpen
  if (open === undefined || open === null) return []
  return [...open.values()]
}

/**
 * Returns true iff the run entry has at least one open question request.
 *
 * @param {object} runEntry - A RunEntry from the stream state's runs map.
 * @returns {boolean} True iff the run has at least one open question request.
 */
export function hasOpenQuestions(runEntry) {
  if (runEntry === undefined || runEntry === null) return false
  const open = runEntry.questionOpen
  return open !== undefined && open !== null && open.size > 0
}

/**
 * The status to render for a run: the wire status adjusted by what the browser knows about
 * open questions. Computed at render and NEVER stored — the next `running` frame would
 * overwrite a stored derived value.
 *
 *   1. Terminal wins.
 *   2. Wire `waiting_for_approval` stays (the gateway lets approval win over questions).
 *   3. A `running` run with any open question is `waiting_for_question`.
 *   4. A wire `waiting_for_question` with an open question stays; with none, once a question
 *      reconcile has completed in the current connection cycle, it is really `running`. (Before
 *      that, a missed settle frame cannot be told from a question the list has not yet shown, so
 *      the wire value is kept.)
 *   5. Anything else is the wire value (so `queued` and `blocked` stay put).
 *
 * @param {object|undefined|null} runEntry - A RunEntry from the stream state's runs map.
 * @returns {string} The status value to label and style; '' when there is no entry.
 */
export function getEffectiveStatus(runEntry) {
  if (runEntry === undefined || runEntry === null) return ''
  const wire = runEntry.status
  if (runEntry.terminal === true) return wire
  if (wire === 'waiting_for_approval') return wire
  if (wire === 'running') return hasOpenQuestions(runEntry) ? 'waiting_for_question' : wire
  if (wire === 'waiting_for_question') {
    if (hasOpenQuestions(runEntry)) return wire
    return runEntry.questionReconcileDone === true ? 'running' : wire
  }
  return wire
}

// ---------------------------------------------------------------------------
// Backoff delay calculator
// ---------------------------------------------------------------------------

/**
 * Calculate the delay in milliseconds for a given retry attempt (0-indexed).
 * Uses exponential backoff: base * factor^attempt.
 * backoffDelay(0) === RETRY_BASE_MS (1000ms on first retry).
 */
function backoffDelay(attempt) {
  return RETRY_BASE_MS * RETRY_FACTOR ** attempt
}

// ---------------------------------------------------------------------------
// DOM shell — only runs in a browser (document must exist)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transport helpers shared by the approval, question and cancel clients
// ---------------------------------------------------------------------------

/**
 * Append the fixture session id as a query param. Only appended when a fixtureSessionId is
 * provided (fixture mode) — never in production.
 */
function withFixtureParam(fixtureSessionId, url) {
  return fixtureSessionId === undefined
    ? url
    : `${url}${url.includes('?') ? '&' : '?'}fixtureSessionId=${encodeURIComponent(fixtureSessionId)}`
}

/**
 * Same-origin fetch with the cookie riding and redirects refused. A `timeoutMs` bounds the request
 * with its own timeout signal (where AbortSignal.timeout exists), so a hung socket rejects instead
 * of waiting forever; that signal is the request's own, never the stream's.
 */
function browserFetch(input, init, timeoutMs) {
  const signal = timeoutMs !== undefined && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
  return globalThis.fetch(input, {
    ...init,
    credentials: 'include',
    redirect: 'error',
    ...(signal === undefined ? {} : {signal}),
  })
}

/**
 * Fetch a fresh CSRF token. Resolves to `{success:true, data:{csrfToken}}`, or
 * `{success:false, error:{kind:'http', status}}` | `{kind:'protocol'}` | `{kind:'network'}`.
 */
async function refreshCsrf(endpointBase, fixtureSessionId, timeoutMs) {
  try {
    const res = await browserFetch(
      withFixtureParam(fixtureSessionId, `${endpointBase}/session/csrf`),
      {headers: {'content-type': 'application/json'}},
      timeoutMs,
    )
    if (!res.ok) return {success: false, error: {kind: 'http', status: res.status}}
    const data = await res.json()
    if (data === null || typeof data !== 'object' || typeof data.csrfToken !== 'string') {
      return {success: false, error: {kind: 'protocol'}}
    }
    return {success: true, data: {csrfToken: data.csrfToken}}
  } catch {
    return {success: false, error: {kind: 'network'}}
  }
}

// ---------------------------------------------------------------------------
// Browser-direct approval client (same-origin relative /operator/* paths)
// ---------------------------------------------------------------------------

/**
 * Build a browser-direct approval client for the inline approval prompt UI.
 *
 * Uses same-origin relative paths (owned by the public reverse proxy in production,
 * or the fixture harness in dev). credentials:'include' and redirect:'error' are set
 * on all fetch calls so the cookie, Origin, and Sec-Fetch metadata ride automatically.
 *
 * Accepts an optional endpointBase (default: '/operator') so the runtime-loader
 * seam can configure a different endpoint base in dev mode without modifying
 * production behavior.
 *
 * Accepts an optional fixtureSessionId. When provided (fixture mode only), it is
 * appended as a query param to all requests so the fixture harness can route them
 * to the correct session. Never included in production mode (no fixtureSessionId).
 *
 * Security:
 * - Never logs runId, requestId, decision, csrf, or idempotency key.
 * - All 404s collapse to one denial-class signal (no cause inference).
 * - Transport errors are distinct from denial (approval decision failure handling).
 * - CSRF-400 retried once with the same idempotency key (mirrors launch pattern).
 *
 * @param {object} [opts] - Optional configuration.
 * @param {string} [opts.endpointBase] - The endpoint base path. Defaults to '/operator'.
 * @param {string} [opts.fixtureSessionId] - Fixture session ID (fixture mode only).
 * @returns {object} An object with refreshCsrf(), decideRunApproval(), and listRunApprovals() methods.
 */
export function buildApprovalClient(opts) {
  const endpointBase = opts?.endpointBase ?? '/operator'
  const fixtureSessionId = opts?.fixtureSessionId
  const withFixture = url => withFixtureParam(fixtureSessionId, url)
  const getCsrf = async () => refreshCsrf(endpointBase, fixtureSessionId)

  /**
   * POST a decision for a pending approval.
   *
   * Returns:
   *   {success: true, data: {state}}  — decision accepted; state is the gateway's response
   *   {success: false, error: {kind: 'http', status: 404}}  — denial-class (uniform not-found)
   *   {success: false, error: {kind: 'network'}}  — transport failure (retryable)
   *   {success: false, error: {kind: 'http', status: N}}  — other HTTP error
   *
   * One CSRF-400 retry reusing the same idempotency key (mirrors launch pattern).
   */
  async function decideRunApproval(runId, requestId, decision, idempotencyKey) {
    // Get initial CSRF token. Propagate an HTTP failure (e.g. an expired session
    // returning 401/403) so the caller can show the reload state instead of an
    // endless retry; only a true transport failure collapses to 'network'.
    const csrfResult = await getCsrf()
    if (!csrfResult.success) {
      return csrfResult.error.kind === 'http'
        ? {success: false, error: {kind: 'http', status: csrfResult.error.status}}
        : {success: false, error: {kind: 'network'}}
    }
    const csrfToken = csrfResult.data.csrfToken

    const path = withFixture(`${endpointBase}/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(requestId)}/decision`)
    const body = JSON.stringify({decision})
    const makeInit = csrf => ({
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': idempotencyKey,
      },
      body,
    })

    let res
    try {
      res = await browserFetch(path, makeInit(csrfToken))
    } catch {
      return {success: false, error: {kind: 'network'}}
    }

    // CSRF-400 retry: refresh CSRF once and retry with the same idempotency key
    if (res.status === 400) {
      const retrycsrfResult = await getCsrf()
      if (!retrycsrfResult.success) {
        return retrycsrfResult.error.kind === 'http'
          ? {success: false, error: {kind: 'http', status: retrycsrfResult.error.status}}
          : {success: false, error: {kind: 'network'}}
      }
      try {
        res = await browserFetch(path, makeInit(retrycsrfResult.data.csrfToken))
      } catch {
        return {success: false, error: {kind: 'network'}}
      }
    }

    if (res.ok) {
      let data
      try {
        data = await res.json()
      } catch {
        return {success: false, error: {kind: 'network'}}
      }
      return {success: true, data: {state: data.state}}
    }

    return {success: false, error: {kind: 'http', status: res.status}}
  }

  /**
   * GET open approvals for a run (reconcile on reconnect).
   *
   * Returns a discriminated result:
   *   {success: true, data: {approvals: [...]}}  — 2xx with a valid approvals array
   *   {success: false, error: {kind: 'http', status}}  — non-2xx response
   *   {success: false, error: {kind: 'network'}}  — fetch threw (transport failure)
   *   {success: false, error: {kind: 'protocol'}}  — 200 but missing/non-array approvals
   *
   * A malformed body is NOT treated as success-empty: under corrective pruning,
   * a failed reconcile must never wipe open prompts. The caller dispatches the
   * corrective action only on success:true.
   */
  async function listRunApprovals(runId) {
    try {
      const res = await browserFetch(
        withFixture(`${endpointBase}/runs/${encodeURIComponent(runId)}/approvals`),
        {headers: {'content-type': 'application/json'}},
      )
      if (!res.ok) return {success: false, error: {kind: 'http', status: res.status}}
      const data = await res.json()
      if (!data || !Array.isArray(data.approvals)) return {success: false, error: {kind: 'protocol'}}
      return {success: true, data: {approvals: data.approvals}}
    } catch {
      return {success: false, error: {kind: 'network'}}
    }
  }

  return {refreshCsrf: getCsrf, decideRunApproval, listRunApprovals}
}

// ---------------------------------------------------------------------------
// Browser-direct question client (same-origin relative /operator/* paths)
// ---------------------------------------------------------------------------

/** Decision states a 200 can carry. Mirrors the vendored QUESTION_DECISION_STATES (a test pins parity). */
export const QUESTION_DECISION_STATES = Object.freeze(['claimed', 'already_claimed', 'already_settled', 'failed_to_settle'])

/** Reasons a 400 can carry. Mirrors the vendored QUESTION_INVALID_REASONS (a test pins parity). */
export const QUESTION_INVALID_REASONS = Object.freeze([
  'malformed',
  'arity-mismatch',
  'unknown-option',
  'multiple-not-allowed',
  'empty-value',
  'text-too-long',
])

const QUESTION_DECISION_STATE_SET = new Set(QUESTION_DECISION_STATES)
const QUESTION_INVALID_REASON_SET = new Set(QUESTION_INVALID_REASONS)

/** Delays between successive re-lists after an `already_claimed`: about 2, 5, 10 and 20 seconds, then stop. */
export const QUESTION_CLAIM_RECHECK_DELAYS_MS = Object.freeze([2000, 5000, 10_000, 20_000])

/**
 * Bound on each fetch of the question client (list, CSRF, decision POST): a hung request must end
 * as its designed failure (a decision POST as an unknown outcome, a list as a network failure)
 * instead of holding a question in flight or a list check open forever. It is a separate constant
 * from the cancel client's bound because the recovery differs, though the value is the same.
 */
export const QUESTION_FETCH_TIMEOUT_MS = 10_000

/** One pending-list entry `{requestID, questions}` (no per-item runId), or null when invalid. */
function parsePendingQuestionEntry(value) {
  if (!isQuestionRecord(value) || !hasExactKeys(value, ['requestID', 'questions'])) return null
  if (!isNonEmptyString(value.requestID)) return null
  if (!Array.isArray(value.questions) || value.questions.length > MAX_QUESTIONS_PER_REQUEST) return null
  const questions = []
  for (const entry of value.questions) {
    const question = parseQuestionPrompt(entry)
    if (question === null) return null
    questions.push(question)
  }
  return {requestID: value.requestID, questions}
}

/**
 * Validate a pending-list body `{requests:[...]}`. Null when the whole body is invalid (not exactly
 * that shape, or more entries than the gateway's cap). Otherwise the valid entries plus `partial`:
 * true when any entry was dropped (invalid or duplicate), because the list is then not a complete
 * picture. Never throws; the result shares nothing with the input.
 */
function parsePendingQuestionsBody(body) {
  if (!isQuestionRecord(body) || !hasExactKeys(body, ['requests'])) return null
  if (!Array.isArray(body.requests) || body.requests.length > GATEWAY_PENDING_QUESTIONS_CAP) return null
  const requests = []
  const seen = new Set()
  let partial = false
  for (const entry of body.requests) {
    const parsed = parsePendingQuestionEntry(entry)
    if (parsed === null || seen.has(parsed.requestID)) {
      partial = true
      continue
    }
    seen.add(parsed.requestID)
    requests.push(parsed)
  }
  return {requests, partial}
}

/** Rebuild a decision as a closed request body, or null when it is not an answer/skip shape. */
function buildQuestionDecisionBody(decision) {
  if (!isQuestionRecord(decision)) return null
  if (decision.decision === 'skip') return {decision: 'skip'}
  if (decision.decision !== 'answer' || !Array.isArray(decision.answers)) return null
  const answers = []
  for (const answer of decision.answers) {
    if (!isQuestionRecord(answer)) return null
    const out = {}
    if (answer.options !== undefined) {
      if (!Array.isArray(answer.options)) return null
      if (!answer.options.every(index => Number.isSafeInteger(index) && index >= 0)) return null
      out.options = [...answer.options]
    }
    if (answer.text !== undefined) {
      if (typeof answer.text !== 'string') return null
      out.text = answer.text
    }
    answers.push(out)
  }
  return {decision: 'answer', answers}
}

const QUESTION_REQUEST_LEVEL_INVALID = Object.freeze({kind: 'invalid', reason: null, questionIndex: null})

/**
 * Read a 400. Null when it carries no `reason` — the browser guard's refusal (CSRF, Origin, Fetch
 * Metadata), which fires before the handler and is the only 400 worth a CSRF retry. Otherwise the
 * invalid-answer outcome: a known reason with an in-range question index, or a request-level one
 * (unknown reason; missing, non-integer or out-of-range index). The body is never kept or logged.
 */
async function readQuestionBadRequest(res, answerCount) {
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!isQuestionRecord(data) || !Object.hasOwn(data, 'reason')) return null
  if (typeof data.reason !== 'string' || !QUESTION_INVALID_REASON_SET.has(data.reason)) {
    return QUESTION_REQUEST_LEVEL_INVALID
  }
  const {questionIndex} = data
  const inRange = Number.isInteger(questionIndex) && questionIndex >= 0 && questionIndex < answerCount
  return {kind: 'invalid', reason: data.reason, questionIndex: inRange ? questionIndex : null}
}

/**
 * Classify every response of a question decision except a 400, which the caller handles.
 *   200, known state → {kind:'decided', state}
 *   200, unknown state → {kind:'failed'} (request-level, retryable)
 *   200, unreadable body, 429, 5xx, anything else → {kind:'unknown'} (outcome unknown: re-list, never resubmit)
 *   401/403 → {kind:'session-expired'}; 404 (the masked denial) → {kind:'cant-answer'}
 */
async function classifyQuestionDecisionResponse(res) {
  if (res.ok) {
    let data
    try {
      data = await res.json()
    } catch {
      return {kind: 'unknown'}
    }
    const state = isQuestionRecord(data) ? data.state : undefined
    return typeof state === 'string' && QUESTION_DECISION_STATE_SET.has(state)
      ? {kind: 'decided', state}
      : {kind: 'failed'}
  }
  if (res.status === 401 || res.status === 403) return {kind: 'session-expired'}
  if (res.status === 404) return {kind: 'cant-answer'}
  return {kind: 'unknown'}
}

/**
 * Build the browser-direct question client: list the pending questions of a run and submit one
 * decision. Same transport posture as the approval client (same-origin paths, `credentials`
 * include, `redirect: 'error'`, CSRF fetched first, fixture session id only in fixture mode) and
 * it shares that client's transport helpers. It does NOT share the approval client's retry-on-any-400.
 * Every fetch (list, CSRF, decision POST) is bounded by QUESTION_FETCH_TIMEOUT_MS: a timed-out
 * decision POST is an unknown outcome (it may have been recorded), a timed-out list is a network
 * failure.
 *
 * Security: never logs or stores a run id, request id, answer text, response text or CSRF token.
 * Path IDs are validated before they are embedded. There is no idempotency key: the gateway's
 * question route does not read one; single settlement comes from its claim states.
 *
 * `listRunQuestions(runId)` →
 *   {success:true, data:{requests, invalidBody, partial}}  — 2xx; `invalidBody` when the body fails
 *       validation (requests is then empty), `partial` when entries were dropped
 *   {success:false, error:{kind:'http', status}} | {kind:'network'} | {kind:'invalid-id'}
 *
 * `decideRunQuestion(runId, requestId, decision)` → one of
 *   {kind:'decided', state}                 — 200 with a known state
 *   {kind:'invalid', reason, questionIndex} — 400 with a `reason` (both null when request-level)
 *   {kind:'cant-answer'}                    — 404, the masked denial
 *   {kind:'session-expired'}                — 401/403, from the CSRF fetch or the POST
 *   {kind:'unknown'}                        — network failure or an unclassifiable response after the
 *                                             POST was sent: it may have been recorded
 *   {kind:'failed'}                         — request-level and retryable: not sent, or an unknown state
 *
 * A 400 without a `reason` refreshes CSRF and retries once; a second one is request-level invalid.
 * A 400 with a `reason` is never retried.
 *
 * @param {object} [opts] - Optional configuration.
 * @param {string} [opts.endpointBase] - The endpoint base path. Defaults to '/operator'.
 * @param {string} [opts.fixtureSessionId] - Fixture session ID (fixture mode only).
 */
export function buildQuestionClient(opts) {
  const endpointBase = opts?.endpointBase ?? '/operator'
  const fixtureSessionId = opts?.fixtureSessionId
  const withFixture = url => withFixtureParam(fixtureSessionId, url)
  const timedFetch = async (input, init) => browserFetch(input, init, QUESTION_FETCH_TIMEOUT_MS)
  const getCsrf = async () => refreshCsrf(endpointBase, fixtureSessionId, QUESTION_FETCH_TIMEOUT_MS)

  async function listRunQuestions(runId) {
    if (!validateDynamicId(runId)) return {success: false, error: {kind: 'invalid-id'}}
    try {
      const res = await timedFetch(
        withFixture(`${endpointBase}/runs/${encodeURIComponent(runId)}/questions`),
        {headers: {'content-type': 'application/json'}},
      )
      if (!res.ok) return {success: false, error: {kind: 'http', status: res.status}}
      let body
      try {
        body = await res.json()
      } catch {
        body = null
      }
      const parsed = parsePendingQuestionsBody(body)
      if (parsed === null) return {success: true, data: {requests: [], invalidBody: true, partial: false}}
      return {success: true, data: {requests: parsed.requests, invalidBody: false, partial: parsed.partial}}
    } catch {
      return {success: false, error: {kind: 'network'}}
    }
  }

  async function decideRunQuestion(runId, requestId, decision) {
    if (!validateDynamicId(runId) || !validateDynamicId(requestId)) return {kind: 'failed'}
    const body = buildQuestionDecisionBody(decision)
    if (body === null) return {kind: 'failed'}
    const answerCount = body.decision === 'answer' ? body.answers.length : 0
    const payload = JSON.stringify(body)
    const path = withFixture(
      `${endpointBase}/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(requestId)}/decision`,
    )

    // Two attempts at most, and only a 400 without a `reason` gets the second.
    for (let attempt = 0; attempt < 2; attempt++) {
      const csrfResult = await getCsrf()
      if (!csrfResult.success) {
        const {error} = csrfResult
        return error.kind === 'http' && (error.status === 401 || error.status === 403)
          ? {kind: 'session-expired'}
          : {kind: 'failed'}
      }

      let res
      try {
        res = await timedFetch(path, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfResult.data.csrfToken,
          },
          body: payload,
        })
      } catch {
        return {kind: 'unknown'}
      }

      if (res.status === 400) {
        const invalid = await readQuestionBadRequest(res, answerCount)
        if (invalid === null) continue
        return invalid
      }
      return classifyQuestionDecisionResponse(res)
    }
    return QUESTION_REQUEST_LEVEL_INVALID
  }

  return {listRunQuestions, decideRunQuestion}
}

// ---------------------------------------------------------------------------
// Dynamic ID validator (mirrors src/gateway/operator-client.ts validateDynamicId
// and web/src/operator/validate-dynamic-id.ts — kept in sync manually; this file
// cannot import from src/ or web/ since it ships as a standalone browser bundle)
// ---------------------------------------------------------------------------

/**
 * Validate a dynamic path ID (e.g. runId) before it is embedded in a URL.
 *
 * Rejects blank/whitespace-only values, literal `/`/`\`, percent-encoded
 * slash/backslash, any decoded segment equal to `.` or `..`, literal
 * NUL/CR/LF/control chars, and percent-encoded NUL/CR/LF.
 *
 * Does NOT log the raw ID value — callers must use the error code only.
 */
function validateDynamicId(id) {
  if (id.trim() === '') return false
  if (id.includes('/') || id.includes('\\')) return false
  if (/%(?:2f|5c)/i.test(id)) return false
  // eslint-disable-next-line no-control-regex -- intentional control-char rejection
  if (/[\u0000-\u001F]/.test(id)) return false
  if (/%(?:00|0d|0a)/i.test(id)) return false
  let decoded
  try {
    decoded = decodeURIComponent(id)
  } catch {
    return false
  }
  if (decoded === '.' || decoded === '..') return false
  const segments = decoded.split(/[/\\]/)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Allowlisted cancel-response phase values (mirrors
// src/gateway/operator-contract/parse.ts VALID_CANCEL_PHASES)
// ---------------------------------------------------------------------------

const VALID_CANCEL_PHASES = new Set(['CANCELLED', 'COMPLETED', 'FAILED'])

/**
 * Local mirror of src/gateway/operator-contract/run-status.ts PHASE_TO_WEB_STATUS.
 * Maps the UPPERCASE cancel-response phase to the lowercase render status. Kept in
 * sync manually (this file cannot import src/ — it ships as a standalone browser
 * bundle); drift is caught by a conformance test. Never render the raw phase.
 */
export const PHASE_TO_WEB_STATUS = {
  PENDING: 'queued',
  ACKNOWLEDGED: 'running',
  EXECUTING: 'running',
  COMPLETED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

/**
 * Parse an unknown value as an OperatorCancelResponse ({ok:true, runId, phase}).
 * Mirrors src/gateway/operator-contract/parse.ts parseOperatorCancelResponse.
 * Returns {success:true, data} or {success:false}. No echo of the input.
 */
function parseOperatorCancelResponse(input) {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    input.ok !== true ||
    typeof input.runId !== 'string' ||
    typeof input.phase !== 'string' ||
    !VALID_CANCEL_PHASES.has(input.phase)
  ) {
    return {success: false}
  }
  return {success: true, data: {ok: true, runId: input.runId, phase: input.phase}}
}

// ---------------------------------------------------------------------------
// Browser-direct cancel client (same-origin relative /operator/* paths)
// ---------------------------------------------------------------------------

/**
 * Build a browser-direct cancel client mirroring buildApprovalClient's CSRF +
 * idempotency + retry + no-leak posture.
 *
 * Security:
 * - Never logs runId, csrfToken, or idempotencyKey — the logger (if provided)
 *   receives only the static route template and a coarse HTTP status.
 * - Validates runId with the dynamic-id validator BEFORE any fetch.
 * - Rejects blank csrfToken/idempotencyKey before any fetch.
 * - One retry only on HTTP 400, reusing the SAME idempotency key.
 * - No request body is sent.
 *
 * @param {object} [opts] - Optional configuration.
 * @param {string} [opts.endpointBase] - The endpoint base path. Defaults to '/operator'.
 * @param {string} [opts.fixtureSessionId] - Fixture session ID (fixture mode only).
 * @param {{error: (message: string, meta?: object) => void}} [opts.logger] - Optional logger.
 * @returns {object} An object with a cancelRun() method.
 */
// Bound on the cancel client's CSRF and cancel-POST fetches — a hung fetch (no
// server response) must not leave the control stuck pending forever.
const CANCEL_FETCH_TIMEOUT_MS = 10_000

export function buildCancelClient(opts) {
  const endpointBase = opts?.endpointBase ?? '/operator'
  const fixtureSessionId = opts?.fixtureSessionId
  const logger = opts?.logger

  const withFixture = url => withFixtureParam(fixtureSessionId, url)
  const timedFetch = async (input, init) => browserFetch(input, init, CANCEL_FETCH_TIMEOUT_MS)

  const ROUTE_TEMPLATE = '/operator/runs/:runId/cancel'
  const CSRF_ROUTE_TEMPLATE = '/operator/session/csrf'

  /**
   * Fetch a fresh CSRF token for the cancel POST: the shared fetch, bounded by
   * CANCEL_FETCH_TIMEOUT_MS, with each failure logged by static route template only.
   */
  async function getCsrf() {
    const result = await refreshCsrf(endpointBase, fixtureSessionId, CANCEL_FETCH_TIMEOUT_MS)
    if (!result.success) {
      const {error} = result
      if (error.kind === 'http') {
        logger?.error('operator-cancel-client: csrf http error', {route: CSRF_ROUTE_TEMPLATE, status: error.status})
      } else {
        logger?.error(`operator-cancel-client: csrf ${error.kind} error`, {route: CSRF_ROUTE_TEMPLATE})
      }
    }
    return result
  }

  /**
   * POST a cancel request for a run.
   *
   * Returns:
   *   {success: true, data: {ok, runId, phase}}  — cancel accepted or run was
   *     already terminal (idempotent no-op; both are 200 and benign).
   *   {success: false, error: {kind: 'validation', code}}  — reject-before-fetch
   *   {success: false, error: {kind: 'http', status}}  — non-200 response
   *   {success: false, error: {kind: 'network'}}  — transport failure
   *   {success: false, error: {kind: 'protocol'}}  — malformed 200 body
   *
   * One CSRF-400 retry reusing the SAME idempotency key (mirrors decideRunApproval).
   */
  async function cancelRun(runId, idempotencyKey, csrfToken) {
    if (!validateDynamicId(runId)) {
      return {success: false, error: {kind: 'validation', code: 'invalid_run_id'}}
    }
    if (csrfToken.trim() === '') {
      return {success: false, error: {kind: 'validation', code: 'missing_csrf'}}
    }
    if (idempotencyKey.trim() === '') {
      return {success: false, error: {kind: 'validation', code: 'missing_idempotency_key'}}
    }

    const path = withFixture(`${endpointBase}/runs/${encodeURIComponent(runId)}/cancel`)
    const init = {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        'idempotency-key': idempotencyKey,
      },
    }

    let res
    try {
      res = await timedFetch(path, init)
    } catch {
      logger?.error('operator-cancel-client: network error', {route: ROUTE_TEMPLATE})
      return {success: false, error: {kind: 'network'}}
    }

    // One retry only on HTTP 400, reusing the SAME idempotency key and init.
    if (res.status === 400) {
      try {
        res = await timedFetch(path, init)
      } catch {
        logger?.error('operator-cancel-client: network error', {route: ROUTE_TEMPLATE})
        return {success: false, error: {kind: 'network'}}
      }
    }

    if (res.ok) {
      let data
      try {
        data = await res.json()
      } catch {
        logger?.error('operator-cancel-client: json parse error', {route: ROUTE_TEMPLATE, status: res.status})
        return {success: false, error: {kind: 'protocol'}}
      }
      const parsed = parseOperatorCancelResponse(data)
      if (!parsed.success) {
        logger?.error('operator-cancel-client: malformed response body', {route: ROUTE_TEMPLATE, status: res.status})
        return {success: false, error: {kind: 'protocol'}}
      }
      return {success: true, data: parsed.data}
    }

    logger?.error('operator-cancel-client: http error', {route: ROUTE_TEMPLATE, status: res.status})
    return {success: false, error: {kind: 'http', status: res.status}}
  }

  return {cancelRun, refreshCsrf: getCsrf}
}

// ---------------------------------------------------------------------------
// Approval prompt interaction state machine (per-prompt, browser-side)
// ---------------------------------------------------------------------------

/**
 * Prompt interaction states (per-prompt, browser-side):
 *   'open'              — controls active: once, always, reject
 *   'always-confirm'    — always first-click: show confirm + cancel; once/reject suppressed
 *   'in-flight'         — POST pending: all controls disabled
 *   'cant-approve'      — denial-class 404: generic no-access copy, controls gone
 *   'transport-failure' — transport error: "try again" state, controls re-enabled
 *   'already-settled'   — already_claimed/unavailable: inline settled copy
 */

export function renderApprovalPrompt(prompt, runId, approvalClient, _onSettle) {
  const {requestID, permission, command, filepath} = prompt

  // Determine if this is an edit-class prompt (filepath-based, contents not previewed)
  const isEditClass = permission === 'edit' || permission === 'external_directory'

  // Safe permission label — never the raw token
  const permLabel = (() => {
    switch (permission) {
      case 'shell': return 'Shell command'
      case 'edit': return 'File edit'
      case 'external_directory': return 'External directory access'
      case 'network': return 'Network access'
      case 'read': return 'File read'
      case 'write': return 'File write'
      default: return 'Tool action'
    }
  })()

  // Build the prompt container
  const el = document.createElement('div')
  el.className = 'approval-prompt'
  el.setAttribute('role', 'region')
  el.setAttribute('aria-label', 'Approval prompt')

  // Permission label
  const permEl = document.createElement('div')
  permEl.className = 'approval-prompt-permission'
  permEl.textContent = permLabel
  el.append(permEl)

  // Gated action — strictly inert textContent, never innerHTML
  if (command !== undefined || filepath !== undefined) {
    const actionEl = document.createElement('pre')
    actionEl.className = 'approval-prompt-action'
    actionEl.setAttribute('aria-label', 'Requested action (read-only)')
    // textContent only — never innerHTML. This is the injection-safety guarantee.
    actionEl.textContent = command === undefined ? (filepath ?? '') : command
    el.append(actionEl)
  }

  // Edit-class caveat
  if (isEditClass) {
    const caveEl = document.createElement('p')
    caveEl.className = 'approval-prompt-caveat-edit'
    caveEl.textContent = 'File-level only \u2014 contents not previewed.'
    el.append(caveEl)
  }

  // Access caveat
  const accessCaveEl = document.createElement('p')
  accessCaveEl.className = 'approval-prompt-caveat-access'
  accessCaveEl.textContent = 'Approval requires write access to this run. Unavailable decisions fail safely.'
  el.append(accessCaveEl)

  // Status/feedback area (for in-flight, failure, settled states)
  const statusEl = document.createElement('div')
  statusEl.className = 'approval-prompt-status'
  statusEl.setAttribute('role', 'status')
  statusEl.setAttribute('aria-live', 'polite')
  el.append(statusEl)

  // Controls area
  const controlsEl = document.createElement('div')
  controlsEl.className = 'approval-prompt-controls'
  el.append(controlsEl)

  // Always-confirm area (hidden until always first-click)
  const alwaysConfirmEl = document.createElement('div')
  alwaysConfirmEl.className = 'approval-prompt-always-confirm'
  alwaysConfirmEl.hidden = true
  el.append(alwaysConfirmEl)

  const alwaysConsequenceEl = document.createElement('p')
  alwaysConsequenceEl.className = 'approval-prompt-always-consequence'
  alwaysConsequenceEl.textContent = 'This installs a standing approval that auto-approves matching requests for the rest of this run, as defined by the gateway\u2019s grant rule.'
  alwaysConfirmEl.append(alwaysConsequenceEl)

  const alwaysConfirmBtnsEl = document.createElement('div')
  alwaysConfirmBtnsEl.className = 'approval-prompt-always-btns'
  alwaysConfirmEl.append(alwaysConfirmBtnsEl)

  // Interaction state machine
  let promptState = 'open' // 'open' | 'always-confirm' | 'in-flight' | 'cant-approve' | 'session-expired' | 'transport-failure' | 'already-settled'

  function updateStateAttr() {
    el.dataset.state = promptState
  }
  updateStateAttr()

  function setInFlight() {
    promptState = 'in-flight'
    updateStateAttr()
    statusEl.textContent = 'Sending decision\u2026'
    // Disable all buttons
    for (const btn of el.querySelectorAll('button')) {
      btn.disabled = true
    }
  }

  function setTransportFailure() {
    promptState = 'transport-failure'
    updateStateAttr()
    // Re-enable controls first (renderControls clears statusEl.textContent),
    // then set the status message so it survives and is visible alongside the controls.
    renderControls()
    statusEl.textContent = 'Decision didn\u2019t go through \u2014 try again.'
  }

  function setCantApprove() {
    promptState = 'cant-approve'
    updateStateAttr()
    statusEl.textContent = 'You may not have approval access for this run. If you believe this is an error, check your gateway operator session.'
    // Remove controls
    controlsEl.textContent = ''
    alwaysConfirmEl.hidden = true
  }

  function setAlreadySettled() {
    promptState = 'already-settled'
    updateStateAttr()
    statusEl.textContent = 'This approval request has already been settled.'
    controlsEl.textContent = ''
    alwaysConfirmEl.hidden = true
  }

  function setSessionFailure() {
    promptState = 'session-expired'
    updateStateAttr()
    statusEl.textContent = 'Your session may have expired \u2014 reload the page to approve.'
    // Remove controls
    controlsEl.textContent = ''
    alwaysConfirmEl.hidden = true
  }

  async function handleDecision(decision) {
    if (promptState === 'in-flight') return
    setInFlight()

    const idempotencyKey = (
      globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    )

    const result = await approvalClient.decideRunApproval(runId, requestID, decision, idempotencyKey)

    if (result.success) {
      const {state} = result.data
      if (state === 'already_claimed' || state === 'unavailable') {
        setAlreadySettled()
      } else if (state === 'scope_mismatch') {
        promptState = 'already-settled'
        updateStateAttr()
        statusEl.textContent = 'Approval scope didn\u2019t match \u2014 decision not applied.'
        controlsEl.textContent = ''
        alwaysConfirmEl.hidden = true
      } else if (state === 'failed_to_settle') {
        setTransportFailure()
        statusEl.textContent = 'Couldn\u2019t finalize the decision \u2014 please try again.'
      } else if (state === 'pending') {
        renderControls()
      } else {
        statusEl.textContent = ''
      }
    } else {
      const {error} = result
      if (error.kind === 'http' && error.status === 404) {
        setCantApprove()
      } else if (error.kind === 'http' && (error.status === 400 || error.status === 401 || error.status === 403)) {
        setSessionFailure()
      } else {
        setTransportFailure()
      }
    }
  }

  function renderControls() {
    controlsEl.textContent = ''
    alwaysConfirmEl.hidden = true
    statusEl.textContent = ''

    const onceBtn = document.createElement('button')
    onceBtn.type = 'button'
    onceBtn.className = 'approval-prompt-btn-once'
    onceBtn.textContent = 'Once'
    onceBtn.addEventListener('click', () => {
      handleDecision('once')
    })
    controlsEl.append(onceBtn)

    const alwaysBtn = document.createElement('button')
    alwaysBtn.type = 'button'
    alwaysBtn.className = 'approval-prompt-btn-always'
    alwaysBtn.textContent = 'Always'
    alwaysBtn.addEventListener('click', () => {
      if (promptState !== 'open' && promptState !== 'transport-failure') return
      promptState = 'always-confirm'
      updateStateAttr()

      // Suppress once/reject during always-confirm pending
      controlsEl.textContent = ''
      alwaysConfirmEl.hidden = false

      // Confirm button
      const confirmBtn = document.createElement('button')
      confirmBtn.type = 'button'
      confirmBtn.className = 'approval-prompt-btn-confirm'
      confirmBtn.textContent = 'Confirm always'
      confirmBtn.addEventListener('click', () => {
        handleDecision('always')
      })

      // Cancel button
      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'approval-prompt-btn-cancel'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.addEventListener('click', () => {
        promptState = 'open'
        updateStateAttr()
        renderControls()
      })

      alwaysConfirmBtnsEl.textContent = ''
      alwaysConfirmBtnsEl.append(confirmBtn, cancelBtn)
    })
    controlsEl.append(alwaysBtn)

    const rejectBtn = document.createElement('button')
    rejectBtn.type = 'button'
    rejectBtn.className = 'approval-prompt-btn-reject'
    rejectBtn.textContent = 'Reject'
    rejectBtn.addEventListener('click', () => {
      handleDecision('reject')
    })
    controlsEl.append(rejectBtn)
  }

  renderControls()

  return el
}

// ---------------------------------------------------------------------------
// Cancel control interaction state machine (per-run, browser-side)
// ---------------------------------------------------------------------------

/**
 * Bounded retry count for a transient (HTTP 503) cancel response. This handler
 * owns the retry bound — the reducer intentionally does not track attempt counts.
 * After this many attempts, the control falls to the unavailable state.
 */
export const CANCEL_RETRY_MAX_ATTEMPTS = 3

/**
 * Cancel control interaction states (per-run, browser-side; mirrors the
 * approval-prompt precedent in renderApprovalPrompt):
 *   'idle'             — a single Cancel button, no request in flight
 *   'armed'            — first click armed the Confirm/Dismiss pair
 *   'pending'          — POST in flight: all controls disabled
 *   'retrying'         — a transient (503) response is being retried, bounded
 *   'cancelled'         — benign terminal outcome (any terminal phase, incl. already-terminal)
 *   'unavailable'      — 404 / protocol / validation / retry-bound-exceeded
 *   'session-expired'  — persistent 400/401/403: reload affordance, not a retry loop
 *   'transport-failure' — network error: retryable, "didn't go through"
 */

/**
 * Render a Cancel control with an inline two-step confirm for a single run.
 *
 * Mirrors renderApprovalPrompt: first click arms a Confirm/Dismiss pair in place;
 * Confirm issues the cancel POST; Dismiss is the SOLE way back to idle (no Esc,
 * no click-outside). An in-flight mutex (`canceling`) additionally guards the
 * handler itself — not just `disabled` — against a second concurrent cancel.
 *
 * Rendering is allowlist-only: every visible state comes from the fixed state
 * union above via textContent/dataset — never a raw phase, wire status, or HTTP
 * status code reaches the DOM as text, data-*, or class.
 *
 * @param {string} runId - The run ID to cancel.
 * @param {{cancelRun: (runId: string, idempotencyKey: string, csrfToken: string) => Promise<object>, refreshCsrf: () => Promise<object>}} cancelClient
 * @param {(runId: string) => void} onCancelDispatch - Called once the cancel POST is
 *   sent, so the caller can dispatch the reducer's `cancel` action (cancelInFlight tracking).
 * @returns {{el: HTMLElement, notifyTerminal: () => void, dispose: () => void}} The
 *   rendered control element, a notifyTerminal() callback the caller invokes on a
 *   terminal stream frame, and a dispose() callback the caller invokes on teardown.
 */
export function renderCancelControl(runId, cancelClient, onCancelDispatch) {
  const el = document.createElement('div')
  el.className = 'run-cancel-control'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', 'Cancel run')

  const statusEl = document.createElement('div')
  statusEl.className = 'run-cancel-status'
  statusEl.setAttribute('role', 'status')
  statusEl.setAttribute('aria-live', 'polite')
  el.append(statusEl)

  const controlsEl = document.createElement('div')
  controlsEl.className = 'run-cancel-controls'
  el.append(controlsEl)

  let controlState = 'idle'
  let canceling = false
  let retryAttempt = 0
  let retryTimer = null

  // Terminal-wins fence: once the live stream reports this run terminal (or the
  // control is disposed on stream teardown), no late-resolving cancel attempt
  // (a pending fetch, a queued retry) may mutate the UI, schedule a retry, or
  // issue another cancelRun POST. Checked after every await boundary in
  // issueCancel/attemptCancel.
  let terminalObserved = false
  let disposed = false

  // Set true only once handleCancel actually dispatches a cancel POST. Used to
  // gate the "Run stopped." cancelled copy — a run that goes terminal on its
  // own (succeeded/failed normally) must not show a cancel-outcome message.
  let cancelInitiated = false

  function updateStateAttr() {
    el.dataset.state = controlState
  }
  updateStateAttr()

  function clearRetryTimer() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  let idleCancelBtn = null

  function renderIdle() {
    controlState = 'idle'
    updateStateAttr()
    statusEl.textContent = ''
    controlsEl.textContent = ''

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'run-cancel-btn-cancel'
    cancelBtn.textContent = 'Cancel run'
    cancelBtn.addEventListener('click', e => {
      e.stopPropagation()
      renderArmed()
    })
    controlsEl.append(cancelBtn)
    idleCancelBtn = cancelBtn
  }

  function renderArmed() {
    controlState = 'armed'
    updateStateAttr()
    statusEl.textContent = ''
    controlsEl.textContent = ''

    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = 'run-cancel-btn-confirm'
    confirmBtn.textContent = 'Confirm cancel'
    confirmBtn.addEventListener('click', e => {
      e.stopPropagation()
      handleCancel()
    })
    controlsEl.append(confirmBtn)

    const dismissBtn = document.createElement('button')
    dismissBtn.type = 'button'
    dismissBtn.className = 'run-cancel-btn-dismiss'
    dismissBtn.textContent = 'Dismiss'
    dismissBtn.addEventListener('click', e => {
      e.stopPropagation()
      renderIdle()
      cancelBtnFocus()
    })
    controlsEl.append(dismissBtn)

    // Focus management: move focus onto the newly-armed Confirm button.
    if (typeof confirmBtn.focus === 'function') confirmBtn.focus()
  }

  function cancelBtnFocus() {
    if (idleCancelBtn !== null && typeof idleCancelBtn.focus === 'function') idleCancelBtn.focus()
  }

  function setPending() {
    controlState = 'pending'
    updateStateAttr()
    statusEl.textContent = 'Sending cancel request\u2026'
    for (const btn of el.querySelectorAll('button')) {
      btn.disabled = true
    }
  }

  function setRetrying() {
    controlState = 'retrying'
    updateStateAttr()
    statusEl.textContent = 'Run temporarily unavailable \u2014 retrying cancel\u2026'
    controlsEl.textContent = ''
  }

  function setCancelled() {
    controlState = 'cancelled'
    updateStateAttr()
    statusEl.textContent = 'Run stopped.'
    controlsEl.textContent = ''
  }

  /** Neutral terminal rendering for a run that went terminal without an operator cancel. */
  function setNeutralTerminal() {
    controlState = 'cancelled'
    updateStateAttr()
    statusEl.textContent = ''
    controlsEl.textContent = ''
  }

  function setUnavailable() {
    controlState = 'unavailable'
    updateStateAttr()
    statusEl.textContent = 'Cancel is unavailable for this run.'
    controlsEl.textContent = ''
  }

  function setSessionExpired() {
    controlState = 'session-expired'
    updateStateAttr()
    statusEl.textContent = 'Your session may have expired \u2014 reload the page to cancel.'
    controlsEl.textContent = ''
  }

  function setTransportFailure() {
    controlState = 'transport-failure'
    updateStateAttr()
    statusEl.textContent = 'Cancel request didn\u2019t go through \u2014 try again.'
    controlsEl.textContent = ''

    const retryBtn = document.createElement('button')
    retryBtn.type = 'button'
    retryBtn.className = 'run-cancel-btn-retry'
    retryBtn.textContent = 'Try again'
    retryBtn.addEventListener('click', e => {
      e.stopPropagation()
      handleCancel()
    })
    controlsEl.append(retryBtn)
  }

  async function issueCancel(idempotencyKey) {
    const csrfResult = await cancelClient.refreshCsrf()
    // Terminal-wins fence: a terminal frame (or dispose) may have arrived while
    // refreshCsrf was in flight. Do not POST a cancel after terminal has won.
    if (terminalObserved || disposed) {
      return {success: true, data: {ok: true, runId, phase: 'CANCELLED'}}
    }
    if (!csrfResult.success) {
      return csrfResult.error.kind === 'http'
        ? {success: false, error: {kind: 'http', status: csrfResult.error.status}}
        : {success: false, error: {kind: 'network'}}
    }
    return cancelClient.cancelRun(runId, idempotencyKey, csrfResult.data.csrfToken)
  }

  async function handleCancel() {
    // In-flight mutex — guards the handler itself, not just `disabled`.
    if (canceling) return
    canceling = true
    cancelInitiated = true
    clearRetryTimer()
    retryAttempt = 0
    setPending()

    const idempotencyKey = (
      globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    )

    if (typeof onCancelDispatch === 'function') onCancelDispatch(runId)

    try {
      await attemptCancel(idempotencyKey)
    } catch {
      // Unexpected throw from refreshCsrf/cancelRun/onCancelDispatch (not one of
      // issueCancel's discriminated error results) — reset the mutex so the
      // control isn't stuck pending, and render a retryable transport failure.
      canceling = false
      if (!terminalObserved && !disposed) setTransportFailure()
    }
  }

  async function attemptCancel(idempotencyKey) {
    const result = await issueCancel(idempotencyKey)

    // Terminal-wins fence: after the await above resolves, a terminal frame or
    // dispose may have landed. Never overwrite the terminal/disposed outcome,
    // never schedule a retry, never mutate the UI again.
    if (terminalObserved || disposed) return

    if (result.success) {
      canceling = false
      // Any terminal phase (incl. already-terminal COMPLETED/FAILED) is a benign
      // success — never rendered as an error.
      setCancelled()
      return
    }

    const {error} = result

    if (error.kind === 'http' && error.status === 503) {
      if (retryAttempt < CANCEL_RETRY_MAX_ATTEMPTS) {
        retryAttempt += 1
        setRetrying()
        retryTimer = setTimeout(() => {
          retryTimer = null
          // Terminal-wins fence: a terminal frame or dispose may have landed
          // while this timer was armed. Don't re-arm or re-issue the cancel.
          if (terminalObserved || disposed) return
          attemptCancel(idempotencyKey)
        }, backoffDelay(retryAttempt - 1))
        return
      }
      canceling = false
      setUnavailable()
      return
    }

    canceling = false

    if (error.kind === 'http' && error.status === 404) {
      setUnavailable()
    } else if (error.kind === 'http' && (error.status === 400 || error.status === 401 || error.status === 403)) {
      setSessionExpired()
    } else if (error.kind === 'network') {
      setTransportFailure()
    } else {
      // protocol / validation / any other http status: generic unavailable.
      setUnavailable()
    }
  }

  /**
   * Stop any pending retry and mark the control terminal (terminal-wins from
   * the live stream — called by the caller when a terminal status frame arrives
   * for this run from any source, even mid-retry). Sets terminalObserved so any
   * still-in-flight cancel attempt fences itself off after its next await.
   *
   * Only renders the "Run stopped." cancelled copy if a cancel was actually
   * initiated by the operator; otherwise the control goes neutral (no message
   * — the run card's own status pill already communicates succeeded/failed).
   */
  function notifyTerminal() {
    terminalObserved = true
    clearRetryTimer()
    canceling = false
    if (cancelInitiated) {
      if (controlState !== 'cancelled') setCancelled()
    } else {
      setNeutralTerminal()
    }
  }

  /**
   * Tear down the control on stream close/teardown: fences off any in-flight
   * cancel attempt (same mechanism as notifyTerminal) and clears any pending
   * retry timer so it can never fire after the caller has moved on.
   */
  function dispose() {
    disposed = true
    clearRetryTimer()
    canceling = false
  }

  renderIdle()

  return {el, notifyTerminal, dispose}
}

function appendCheckoutText(parent, text) {
  parent.append(document.createTextNode(text))
}

function addCheckoutLine(region, text, className = 'checkout-detail__line') {
  const line = document.createElement('p')
  line.className = className
  appendCheckoutText(line, text)
  region.append(line)
}

function addCheckoutList(region, items, more, toText = value => value) {
  if (items.length === 0) return
  const list = document.createElement('ul')
  list.className = 'checkout-detail__list'
  for (const item of items) {
    const entry = document.createElement('li')
    entry.className = 'checkout-detail__item'
    appendCheckoutText(entry, toText(item))
    list.append(entry)
  }
  region.append(list)
  if (more > 0) addCheckoutLine(region, `and ${more} more`, 'checkout-detail__overflow')
}

function formatCheckoutProvenance(region, provenance) {
  if (provenance.kind === 'unavailable') {
    addCheckoutLine(region, CHECKOUT_PROVENANCE_LABELS.unavailable)
  } else {
    const {head, worktree, operation} = provenance
    if (head.kind === 'attached') {
      addCheckoutLine(region, fillLabelTemplate(CHECKOUT_PROVENANCE_LABELS.headAttached, {branch: head.branch, sha: head.sha.slice(0, 7)}))
    } else {
      addCheckoutLine(region, fillLabelTemplate(CHECKOUT_PROVENANCE_LABELS.headDetached, {sha: head.sha.slice(0, 7)}))
    }
    if (worktree.kind === 'clean') {
      addCheckoutLine(region, CHECKOUT_PROVENANCE_LABELS.worktreeClean)
    } else {
      addCheckoutLine(region, `${CHECKOUT_PROVENANCE_LABELS.worktreeDirty} ${[
        ['staged', worktree.staged], ['unstaged', worktree.unstaged],
        ['untracked', worktree.untracked], ['conflicted', worktree.conflicted],
      ].filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`).join(', ')}`)
    }
    const operationLabel = CHECKOUT_OPERATION_LABELS[operation]
    if (operationLabel !== undefined) {
      addCheckoutLine(region, fillLabelTemplate(CHECKOUT_PROVENANCE_LABELS.operationInProgress, {operation: operationLabel}))
    }
  }

  const {remote} = provenance
  if (remote.kind === 'not-checked') {
    addCheckoutLine(region, CHECKOUT_PROVENANCE_LABELS.remoteNotChecked)
  } else if (remote.change === 'unchanged') {
    addCheckoutLine(region, fillLabelTemplate(CHECKOUT_PROVENANCE_LABELS.remoteUpToDate, {defaultBranch: remote.defaultBranch}))
  } else {
    addCheckoutLine(region, fillLabelTemplate(CHECKOUT_PROVENANCE_LABELS.remoteFastForwarded, {
      fromSha: remote.fromSha.slice(0, 7), sha: remote.sha.slice(0, 7), defaultBranch: remote.defaultBranch,
    }))
  }
}

/** Refusal copy when the contract reports an in-progress operation as `none` (no name to fill in). */
const CHECKOUT_UNNAMED_OPERATION_REASON = 'operation in progress'

/** The display reason for a preparation record, built only from label maps and sanitized values. */
function describeCheckoutPreparationReason(preparation) {
  if (preparation.outcome === 'failed') return CHECKOUT_UPDATE_FAILURE_REASON_LABELS[preparation.reason]
  if (preparation.reason === 'operation-in-progress' && preparation.operation === 'none') return CHECKOUT_UNNAMED_OPERATION_REASON
  return fillLabelTemplate(CHECKOUT_REFUSAL_REASON_LABELS[preparation.reason], {
    ...(preparation.layoutReason === undefined ? {} : {layout: CHECKOUT_LAYOUT_REASON_LABELS[preparation.layoutReason]}),
    ...(preparation.operation === undefined ? {} : {operation: CHECKOUT_OPERATION_LABELS[preparation.operation] ?? ''}),
    ...(preparation.branch === undefined ? {} : {branch: preparation.branch}),
  })
}

function formatCheckoutPreparation(region, preparation, omitRepeatedReason) {
  const reason = describeCheckoutPreparationReason(preparation)
  if (!omitRepeatedReason) addCheckoutLine(region, reason, 'checkout-detail__line checkout-detail__preparation')

  if (preparation.outcome === 'refused') {
    if (preparation.reason === 'dirty') addCheckoutList(region, preparation.changedPaths.items, preparation.changedPaths.more)
    if (preparation.reason === 'submodule-initialized') addCheckoutList(region, preparation.submodules.items, preparation.submodules.more)
    if (preparation.reason === 'unsupported-config') addCheckoutList(region, preparation.disallowedKeys.items, preparation.disallowedKeys.more)
    if (preparation.reason === 'obstructed') {
      addCheckoutList(region, preparation.obstructions.items, preparation.obstructions.more,
        item => `${item.path} — ${CHECKOUT_OBSTRUCTION_KIND_LABELS[item.kind]}`)
    }
  } else {
    if (preparation.permanent) addCheckoutLine(region, CHECKOUT_FAILURE_FLAG_LABELS.permanent, 'checkout-detail__line checkout-detail__flags')
    if (preparation.mutationStarted === true) addCheckoutLine(region, CHECKOUT_FAILURE_FLAG_LABELS.mutationStarted, 'checkout-detail__line checkout-detail__flags')
    if (preparation.mutationStarted === 'possibly') addCheckoutLine(region, CHECKOUT_FAILURE_FLAG_LABELS.mutationPossibly, 'checkout-detail__line checkout-detail__flags')
  }
}

function renderCheckoutDetail(region, runEntry, reasonShownElsewhere) {
  region.textContent = ''
  const provenance = runEntry?.checkoutProvenance
  const preparation = runEntry?.checkoutPreparation
  if (provenance === undefined && preparation === undefined) {
    region.hidden = true
    return
  }

  const group = document.createElement('div')
  group.className = 'checkout-detail'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Checkout details')
  if (provenance !== undefined) formatCheckoutProvenance(group, provenance)
  if (preparation !== undefined) {
    formatCheckoutPreparation(group, preparation, reasonShownElsewhere)
  }
  region.append(group)
  region.hidden = false
}

function makeQuestionNoteCard(status) {
  const el = document.createElement('section')
  el.className = 'question-region__request'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', 'Agent question request')
  const message = document.createElement('p')
  message.className = 'question-region__status'
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  message.textContent = QUESTION_NOTE_COPY[status.kind] ?? ''
  el.append(message)
  return {
    el,
    isNote: true,
    update(next) {
      message.textContent = QUESTION_NOTE_COPY[next.kind] ?? ''
    },
  }
}

/**
 * Initialize the operator run stream for a given run ID.
 *
 * This function touches the DOM and must only be called from a browser context.
 * It is never called at module top-level, so Vitest can import this file safely.
 *
 * Options:
 *   runId       — the run ID to subscribe to (used only in the fetch URL)
 *   statusEl    — element with [data-role="run-status"] to update
 *   noticeEl    — element to show stream connection state notices
 *   approvalsEl — element with [data-role="run-approvals"] to render approval prompts
 *   badgeEl     — element with [data-role="approval-badge"] for the approval count badge
 *   checkoutEl  — element with [data-role="run-checkout-detail"], the target for checkout
 *                 provenance / preparation, rendered only from the sanitized closed DTOs.
 *   summaryStatus — optional run-list summary status for this run (queued | running | succeeded |
 *                 failed | cancelled). A terminal value lets an expired run (reset no-snapshot)
 *                 show its status plus "Output no longer available." without a status frame.
 *   approvalClient — optional pre-built approval client (for testing); if absent,
 *                    buildApprovalClient() is called when the flag is on
 *
 * Security:
 * - Never logs frame data, run IDs, repo names, or stream URLs.
 * - Renders phase/status/timestamps via toSafeRunView; checkout values only from
 *   validated, capped, sanitized DTOs and only through text nodes.
 * - Status labels rendered from STATUS_LABELS map, never raw wire strings.
 * - Approval prompt content rendered via textContent only — never innerHTML.
 * - All 404s → one not-found state, one retry policy.
 * - Read-only: GET only for stream; approval decisions are operator-forwarded writes.
 */
export function initOperatorStream(opts) {
  const {runId, statusEl, noticeEl, outputEl, coalescedEl, approvalsEl, badgeEl, reasonEl, checkoutEl, cancelEl, questionsEl, approvalClient: injectedApprovalClient, cancelClient: injectedCancelClient, questionClient: injectedQuestionClient, endpointBase, fixtureSessionId} = opts

  // The run-list summary status for this run, when the caller has one. Only a known summary status
  // is kept; it lets a no-snapshot reset close an expired terminal run without a status frame.
  const summaryStatus = typeof opts.summaryStatus === 'string' && SUMMARY_STATUSES.has(opts.summaryStatus)
    ? opts.summaryStatus
    : undefined

  if (checkoutEl) {
    checkoutEl.textContent = ''
    checkoutEl.hidden = true
  }

  if (questionsEl !== undefined && questionsEl !== null) {
    questionsEl.textContent = ''
    questionsEl.classList?.add('question-region')
    questionsEl.hidden = true
  }

  // The approval and cancel regions belong to the card and outlive any one stream attachment, so
  // each attachment starts them empty: a re-expanded card never stacks a second prompt or Cancel
  // control on top of the previous attachment's.
  if (approvalsEl !== undefined && approvalsEl !== null) {
    approvalsEl.textContent = ''
    approvalsEl.hidden = true
  }
  if (cancelEl !== undefined && cancelEl !== null) {
    cancelEl.textContent = ''
    cancelEl.hidden = true
  }

  // Build the approval client lazily (only if approvalsEl is present).
  // Pass endpointBase and fixtureSessionId so fixture mode uses the fixture approval routes
  // and includes the session ID in all approval requests.
  const approvalClient = approvalsEl !== undefined && approvalsEl !== null
    ? (injectedApprovalClient ?? buildApprovalClient(
        endpointBase === undefined && fixtureSessionId === undefined
          ? undefined
          : {
              ...(endpointBase === undefined ? {} : {endpointBase}),
              ...(fixtureSessionId === undefined ? {} : {fixtureSessionId}),
            },
      ))
    : null

  // Build the question client only when the caller wires questions: an injected client, or the
  // question region element. A stream with neither never touches the questions routes.
  const questionClient = injectedQuestionClient ?? (
    questionsEl !== undefined && questionsEl !== null
      ? buildQuestionClient(
          endpointBase === undefined && fixtureSessionId === undefined
            ? undefined
            : {
                ...(endpointBase === undefined ? {} : {endpointBase}),
                ...(fixtureSessionId === undefined ? {} : {fixtureSessionId}),
              },
        )
      : null
  )

  // Build the cancel client lazily (only if cancelEl is present).
  const cancelClient = cancelEl !== undefined && cancelEl !== null
    ? (injectedCancelClient ?? buildCancelClient(
        endpointBase === undefined && fixtureSessionId === undefined
          ? undefined
          : {
              ...(endpointBase === undefined ? {} : {endpointBase}),
              ...(fixtureSessionId === undefined ? {} : {fixtureSessionId}),
            },
      ))
    : null

  // The rendered cancel control instance ({el, notifyTerminal}), created lazily
  // the first time updateDOM sees a non-terminal run for this stream.
  let cancelControl = null

  // Track rendered prompt elements by requestID so we can remove them on settle
  // without re-rendering the entire list. Map: requestID → DOM element.
  const renderedPrompts = new Map()

  // Question cards persist between stream updates so status changes never replace focused input.
  // Drafts remain in the page-scoped store and are never persisted outside memory.
  const renderedQuestionCards = new Map()
  const questionStatuses = new Map() // requestID → status
  let nextQuestionRadioGroup = 0
  let questionAnnouncer = null

  function makeQuestionCard(request, initialStatus) {
    const store = getQuestionPageStore(runId)
    const saved = store.drafts.get(request.requestID)
    const answers = request.questions.map((prompt, index) => {
      const draft = Array.isArray(saved) ? saved[index] : undefined
      return {
        options: Array.isArray(draft?.options)
          ? draft.options.filter(option => Number.isInteger(option) && option >= 0 && option < prompt.options.length)
          : [],
        text: typeof draft?.text === 'string' ? draft.text : '',
      }
    })
    let status = initialStatus
    let lastStatusKind = status.kind
    const el = document.createElement('section')
    el.className = 'question-region__request'
    el.setAttribute('role', 'group')
    el.setAttribute('aria-label', 'Agent question request')
    el.addEventListener('click', event => {
      event.stopPropagation()
    })

    const heading = document.createElement('h3')
    heading.className = 'question-region__heading'
    heading.textContent = 'Questions'
    el.append(heading)

    const statusEl = document.createElement('p')
    statusEl.className = 'question-region__status'
    statusEl.setAttribute('role', 'status')
    statusEl.setAttribute('aria-live', 'polite')
    el.append(statusEl)

    const questionEls = []
    request.questions.forEach((prompt, questionIndex) => {
      const fieldset = document.createElement('fieldset')
      fieldset.className = 'question-region__question'
      fieldset.tabIndex = -1
      const legend = document.createElement('legend')
      legend.textContent = prompt.header
      fieldset.append(legend)

      const textEl = document.createElement('p')
      textEl.className = 'question-region__text'
      textEl.textContent = prompt.text
      fieldset.append(textEl)

      const errorEl = document.createElement('p')
      errorEl.className = 'question-region__error'
      errorEl.hidden = true
      fieldset.append(errorEl)

      const answer = answers[questionIndex]
      const radioName = `question-choice-${nextQuestionRadioGroup++}`
      prompt.options.forEach((option, optionIndex) => {
        const label = document.createElement('label')
        label.className = 'question-region__option'
        const input = document.createElement('input')
        input.type = prompt.multiple ? 'checkbox' : 'radio'
        if (!prompt.multiple) input.name = radioName
        input.checked = answer.options.includes(optionIndex)
        input.addEventListener('change', () => {
          if (QUESTION_NOTE_KINDS.has(status.kind)) {
            input.checked = answer.options.includes(optionIndex)
            return
          }
          if (prompt.multiple) {
            answer.options = input.checked
              ? [...new Set([...answer.options, optionIndex])].toSorted((a, b) => a - b)
              : answer.options.filter(index => index !== optionIndex)
          } else {
            answer.options = input.checked ? [optionIndex] : []
          }
          saveDraft()
          refreshValidation()
        })
        const copy = document.createElement('span')
        copy.className = 'question-region__option-copy'
        copy.textContent = option.label
        label.append(input, copy)
        if (option.description !== '') {
          const description = document.createElement('span')
          description.className = 'question-region__description'
          description.textContent = option.description
          label.append(description)
        }
        fieldset.append(label)
      })

      if (prompt.custom) {
        const textLabel = document.createElement('label')
        textLabel.className = 'question-region__custom-label'
        textLabel.textContent = 'Your answer'
        const textarea = document.createElement('textarea')
        textarea.className = 'question-region__input'
        textarea.rows = 2
        textarea.value = answer.text
        textarea.addEventListener('input', () => {
          if (QUESTION_NOTE_KINDS.has(status.kind)) {
            textarea.value = answer.text
            return
          }
          answer.text = textarea.value
          saveDraft()
          refreshValidation()
        })
        textLabel.append(textarea)
        fieldset.append(textLabel)
      }
      questionEls.push({fieldset, errorEl})
      el.append(fieldset)
    })

    const controlsEl = document.createElement('div')
    controlsEl.className = 'question-region__controls'
    const submitButton = document.createElement('button')
    submitButton.type = 'button'
    submitButton.className = 'question-region__submit'
    submitButton.textContent = 'Submit answers'
    const skipButton = document.createElement('button')
    skipButton.type = 'button'
    skipButton.className = 'question-region__skip'
    skipButton.textContent = 'Skip'
    controlsEl.append(submitButton, skipButton)
    el.append(controlsEl)

    const checkButton = document.createElement('button')
    checkButton.type = 'button'
    checkButton.className = 'question-region__check'
    checkButton.textContent = 'Check again'
    checkButton.hidden = true
    checkButton.addEventListener('click', () => {
      checkQuestions(request.requestID)
    })
    el.append(checkButton)

    function saveDraft() {
      store.drafts.set(request.requestID, answers.map(answer => ({options: [...answer.options], text: answer.text})))
    }

    function validationMessage() {
      for (let index = 0; index < request.questions.length; index++) {
        const prompt = request.questions[index]
        const answer = answers[index]
        if (answer.text.length > 4000) return 'Shorten this answer to 4,000 characters or fewer.'
        if (!prompt.multiple && answer.options.length > 0 && answer.text.trim() !== '') {
          return 'Choose an option or type an answer, not both.'
        }
      }
      return ''
    }

    function canSubmit() {
      if (validationMessage() !== '') return false
      return request.questions.every((prompt, index) => {
        if (prompt.options.length === 0 && !prompt.custom) return true
        return answers[index].options.length > 0 || answers[index].text.trim() !== ''
      })
    }

    function refreshValidation() {
      submitButton.disabled = !canSubmit() || QUESTION_SEND_BLOCKED_KINDS.has(status.kind)
      for (const [index, question] of questionEls.entries()) {
        question.errorEl.textContent = ''
        question.errorEl.hidden = true
        const prompt = request.questions[index]
        const answer = answers[index]
        let message = ''
        if (answer.text.length > 4000) {
          message = 'Shorten this answer to 4,000 characters or fewer.'
        } else if (!prompt.multiple && answer.options.length > 0 && answer.text.trim() !== '') {
          message = 'Choose an option or type an answer, not both.'
        }
        if (message !== '') {
          question.errorEl.textContent = message
          question.errorEl.hidden = false
        }
      }
    }

    function answerDecision() {
      const payload = request.questions.map((prompt, index) => {
        if (prompt.options.length === 0 && !prompt.custom) return {}
        const answer = answers[index]
        const text = answer.text.trim()
        return {
          ...(answer.options.length === 0 ? {} : {options: [...answer.options]}),
          ...(text === '' ? {} : {text}),
        }
      })
      return {decision: 'answer', answers: payload}
    }

    submitButton.addEventListener('click', () => {
      if (submitButton.disabled || QUESTION_NOTE_KINDS.has(status.kind)) return
      decideQuestion(request.requestID, answerDecision()).then(() => undefined)
    })
    skipButton.addEventListener('click', () => {
      if (skipButton.disabled || QUESTION_NOTE_KINDS.has(status.kind)) return
      store.drafts.delete(request.requestID)
      decideQuestion(request.requestID, {decision: 'skip'}).then(() => undefined)
    })

    function update(nextStatus) {
      const priorKind = lastStatusKind
      status = nextStatus ?? {kind: 'open'}
      lastStatusKind = status.kind
      const labels = {
        'in-flight': 'Sending answers…',
        'claimed-elsewhere': 'This question is being answered elsewhere.',
        checking: 'Checking whether your answer was recorded…',
        ...QUESTION_NOTE_COPY,
        'failed-to-settle': "Your answer wasn't recorded. Try again.",
        'cant-answer': "You can't answer questions for this run.",
        'session-expired': 'Your session expired. Sign in again in another tab, then try again.',
        'check-failed': "Couldn't check for questions. Try again.",
      }
      const invalidCopy = status.kind === 'invalid'
        ? status.reason === 'multiple-not-allowed'
          ? 'Choose an option or type an answer, not both.'
          : status.reason === 'empty-value'
            ? 'This answer is empty.'
            : status.questionIndex === null
              ? 'Your answers couldn\'t be sent. Check them and try again.'
              : 'Check this answer and try again.'
        : ''
      statusEl.textContent = invalidCopy || labels[status.kind] || ''
      const blocked = QUESTION_SEND_BLOCKED_KINDS.has(status.kind) || status.kind === 'cant-answer'
      const removed = status.kind === 'cant-answer'
      const note = QUESTION_NOTE_KINDS.has(status.kind)
      for (const input of el.querySelectorAll('input, textarea')) {
        input.disabled = blocked || note
        input.tabIndex = note ? -1 : 0
      }
      controlsEl.hidden = removed || note
      controlsEl.setAttribute('aria-disabled', String(note))
      for (const button of [submitButton, skipButton]) {
        button.tabIndex = note ? -1 : 0
      }
      for (const question of questionEls) {
        question.fieldset.hidden = note
        question.fieldset.setAttribute('aria-disabled', String(note))
      }
      checkButton.hidden = status.kind !== 'claimed-elsewhere' && status.kind !== 'check-failed'
      skipButton.disabled = blocked
      submitButton.disabled = blocked || !canSubmit()
      for (const question of questionEls) {
        question.errorEl.textContent = ''
        question.errorEl.hidden = true
      }
      if (status.kind === 'invalid' && status.questionIndex !== null && questionEls[status.questionIndex] !== undefined) {
        questionEls[status.questionIndex].errorEl.textContent = invalidCopy
        questionEls[status.questionIndex].errorEl.hidden = false
        if (priorKind !== 'invalid') questionEls[status.questionIndex].fieldset.focus()
      } else {
        refreshValidation()
      }
    }

    update(initialStatus)
    return {el, update}
  }

  let state = {
    connection: 'connecting',
    runs: Object.create(null), // null-prototype to guard against __proto__ key pollution
    retryCount: 0,
    shouldReconnect: false,
    ...(summaryStatus === undefined ? {} : {summaryStatus}),
  }

  let abortController = null
  let reconnectTimer = null // track pending reconnect timer
  let firstFrameTimer = null // track pending first-frame timeout
  let aborted = false // set by close() to prevent late timer from fetching
  let announcedFailure = false
  let paintedPreparationHeadline = false // reasonEl currently shows a headline this stream wrote from checkoutPreparation

  function updateDOM() {
    // Late-frame guard: after close(), no write of any kind (notice, status,
    // output, coalesced hint, approvals, or badge) may reach the DOM. A late
    // buffered frame or microtask resolving after close() must not paint stale
    // state onto a card that may already be collapsed or reused for another run.
    if (aborted) return

    if (noticeEl) {
      const conn = state.connection
      // Expose the connection state as a machine-readable attribute so agents
      // can query state without text parsing. The value mirrors the connection
      // token from the state machine (e.g. 'live', 'failed', 'not-found').
      noticeEl.dataset.connectionState = conn

      const runEntry = state.runs[runId]
      const currentStatus = runEntry?.status ?? null

      if (currentStatus === 'failed' && !announcedFailure) {
        announcedFailure = true
        const view = toSafeRunView(runEntry)
        const reasonPart = view.reasonLabel ? `: ${view.reasonLabel}` : ''
        noticeEl.textContent = `Run failed${reasonPart}`
        noticeEl.hidden = false
      }

      if (conn === 'live') {
        if (currentStatus === 'failed' && announcedFailure) {
          // Keep failure announcement
        } else {
          noticeEl.textContent = ''
          noticeEl.hidden = true
        }
      } else if (conn === 'connecting' || conn === 'reconnecting') {
        noticeEl.textContent = 'Connecting to run stream\u2026'
        noticeEl.hidden = false
      } else if (conn === 'drift') {
        noticeEl.textContent = 'Stream version mismatch \u2014 refresh the page.'
        noticeEl.hidden = false
      } else if (conn === 'not-found') {
        noticeEl.textContent = 'Run stream unavailable.'
        noticeEl.hidden = false
      } else if (conn === 'backpressure') {
        noticeEl.textContent = 'Stream temporarily unavailable \u2014 retrying\u2026'
        noticeEl.hidden = false
      } else if (conn === 'failed') {
        noticeEl.textContent = 'Stream connection failed.'
        noticeEl.hidden = false
      } else if (conn === 'submitted-unobservable') {
        noticeEl.textContent =
          'Run submitted \u2014 not yet observable (it may be queued or still starting).'
        noticeEl.hidden = false
      } else if (conn === 'closed') {
        // If the stream closed before the run reached a terminal status, surface a
        // generic path-unaware unavailable notice. This covers malformed/truncated
        // streams that close without emitting a terminal status frame for the run.
        const runIsTerminal = runEntry !== undefined && runEntry.terminal === true
        if (runIsTerminal) {
          if (currentStatus === 'failed' && announcedFailure) {
            // Keep failure announcement
          } else {
            noticeEl.textContent = ''
            noticeEl.hidden = true
          }
        } else {
          noticeEl.textContent = 'Run stream ended before a result was available.'
          noticeEl.hidden = false
        }
      }
    }

    if (statusEl) {
      const runEntry = state.runs[runId]
      if (runEntry && (state.connection === 'live' || runEntry.terminal)) {
        // The effective status folds open questions into the wire status; it is derived here
        // on every render and never stored.
        const effectiveStatus = getEffectiveStatus(runEntry)
        // Render label from local map, never the raw wire string into textContent
        const label = STATUS_LABELS[effectiveStatus] ?? ''
        statusEl.textContent = label
        // Update status class for styling — use allowlisted status value (no whitespace)
        statusEl.className = statusEl.className.replaceAll(/\bstatus-\S+/g, '')
        statusEl.classList.add(`status-${effectiveStatus.replaceAll('_', '-')}`)
      } else if (!aborted) {
        const conn = state.connection
        const runIsTerminal = runEntry !== undefined && runEntry.terminal === true
        if (
          !runIsTerminal &&
          (conn === 'drift' ||
            conn === 'not-found' ||
            conn === 'failed' ||
            conn === 'submitted-unobservable' ||
            conn === 'closed')
        ) {
          statusEl.textContent = 'Unavailable'
          statusEl.className = `${statusEl.className.replaceAll(/\bstatus-\S+/g, '')} status-unavailable`
            .replaceAll(/\s+/g, ' ')
            .trim()
        }
      }
    }

    // True when reasonEl was painted in this pass with a failure label that already states the
    // preparation's reason (a checkout-substituted refusal), so the region need not repeat it.
    let failureLabelStatesPreparation = false
    if (reasonEl) {
      const runEntry = state.runs[runId]
      const runIsTerminal = runEntry !== undefined && runEntry.terminal === true
      if (runEntry && (state.connection === 'live' || runIsTerminal)) {
        const view = toSafeRunView(runEntry)
        if (view.reasonLabel !== undefined) {
          reasonEl.textContent = view.reasonLabel
          if (reasonEl.dataset) reasonEl.dataset.reasonState = 'present'
          paintedPreparationHeadline = false
          const preparation = runEntry.checkoutPreparation
          failureLabelStatesPreparation = view.reasonLabel === FAILURE_REASON_LABELS['checkout-substituted'] &&
            preparation?.outcome === 'refused' && preparation.reason === 'checkout-substituted'
        } else if (runEntry.checkoutPreparation !== undefined) {
          const preparation = runEntry.checkoutPreparation
          const template = CHECKOUT_PREPARATION_HEADLINE_LABELS[preparation.outcome]
          reasonEl.textContent = fillLabelTemplate(template, {reason: describeCheckoutPreparationReason(preparation)})
          if (reasonEl.dataset) reasonEl.dataset.reasonState = 'present'
          paintedPreparationHeadline = true
        } else if (paintedPreparationHeadline) {
          // The preparation this stream painted is gone; a reason painted at page load is left alone.
          reasonEl.textContent = ''
          if (reasonEl.dataset) delete reasonEl.dataset.reasonState
          paintedPreparationHeadline = false
        }
      } else if (!aborted) {
        const conn = state.connection
        if (
          !runIsTerminal &&
          (conn === 'drift' ||
            conn === 'not-found' ||
            conn === 'failed' ||
            conn === 'submitted-unobservable' ||
            conn === 'closed')
        ) {
          reasonEl.textContent = ''
          if (reasonEl.dataset) delete reasonEl.dataset.reasonState
          paintedPreparationHeadline = false
        }
      }
    }

    if (checkoutEl) renderCheckoutDetail(checkoutEl, state.runs[runId], paintedPreparationHeadline || failureLabelStatesPreparation)

    // Run output: render the accumulated answer via textContent only — `text` is
    // free-form agent output and must NEVER be interpolated as HTML. droppedCount is
    // never echoed; a fixed-label hint is toggled instead. Other output-frame fields
    // are not rendered.
    if (outputEl) {
      const runEntry = state.runs[runId]
      const outputText = runEntry?.outputText
      if (runEntry?.outputUnavailable === true) {
        // Expired snapshot: fixed dashboard copy as a single text node, never wire text.
        outputEl.textContent = OUTPUT_UNAVAILABLE_COPY
        outputEl.hidden = false
        outputEl.classList?.add('run-output-unavailable')
      } else if (typeof outputText === 'string' && outputText !== '') {
        outputEl.textContent = outputText
        outputEl.hidden = false
        outputEl.classList?.remove('run-output-unavailable')
      } else {
        outputEl.classList?.remove('run-output-unavailable')
        // No output (or an authoritative empty final): clear any stale text and re-hide.
        outputEl.textContent = ''
        outputEl.hidden = true
      }
      if (coalescedEl) {
        // Show the fixed hint when output was coalesced or truncated — never an echoed count.
        const flagged = runEntry?.outputCoalesced === true || runEntry?.outputTruncated === true
        coalescedEl.hidden = !flagged
      }
    }

    // Approval prompts: render open prompts from getOpenApprovals(runEntry).
    // Uses safe DOM (textContent only — never innerHTML). Prompts are added/removed
    // as the reducer state changes; settled prompts are removed silently.
    if (approvalsEl !== undefined && approvalsEl !== null && approvalClient !== null) {
      const runEntry = state.runs[runId]
      const openPrompts = getOpenApprovals(runEntry)
      const openIds = new Set(openPrompts.map(p => p.requestID))

      // Remove prompts that are no longer open (settled/dismissed)
      for (const [reqId, promptEl] of renderedPrompts) {
        if (!openIds.has(reqId)) {
          promptEl.remove()
          renderedPrompts.delete(reqId)
        }
      }

      // Add new prompts that aren't yet rendered
      for (const prompt of openPrompts) {
        if (!renderedPrompts.has(prompt.requestID)) {
          const promptEl = renderApprovalPrompt(prompt, runId, approvalClient, () => {
            // onSettle: called when the prompt decides to remove itself
            // (the reducer will handle the actual removal on the next settle frame)
          })
          renderedPrompts.set(prompt.requestID, promptEl)
          approvalsEl.append(promptEl)
        }
      }

      // Show/hide the approvals container
      approvalsEl.hidden = openPrompts.length === 0

      // Update the badge indicator (hasOpenApprovals)
      if (badgeEl !== undefined && badgeEl !== null) {
        const hasOpen = hasOpenApprovals(runEntry)
        if (hasOpen) {
          badgeEl.textContent = String(openPrompts.length)
          badgeEl.hidden = false
        } else {
          badgeEl.textContent = ''
          badgeEl.hidden = true
        }
      }
    }

    // Question region: render one persistent card per open request and retain final outcomes as notes.
    if (questionsEl !== undefined && questionsEl !== null && questionClient !== null) {
      const requests = getQuestions()
      const notes = getQuestionNotes()
      const presentIds = new Set()
      for (const request of requests) {
        presentIds.add(request.requestID)
        let card = renderedQuestionCards.get(request.requestID)
        // A request that was a note (gone) and is open again needs a real card, not its note.
        if (card?.isNote === true) {
          card.el.remove()
          renderedQuestionCards.delete(request.requestID)
          card = undefined
        }
        if (card === undefined) {
          card = makeQuestionCard(request, request.status)
          renderedQuestionCards.set(request.requestID, card)
          if (questionAnnouncer === null) {
            questionAnnouncer = document.createElement('p')
            questionAnnouncer.className = 'question-region__announcer'
            questionAnnouncer.setAttribute('role', 'status')
            questionAnnouncer.setAttribute('aria-live', 'polite')
            questionAnnouncer.setAttribute('aria-atomic', 'true')
          }
          questionsEl.append(card.el, questionAnnouncer)
          questionAnnouncer.textContent = 'A new question is available.'
        } else {
          card.update(request.status)
        }
      }
      for (const note of notes) {
        presentIds.add(note.requestID)
        let card = renderedQuestionCards.get(note.requestID)
        if (card === undefined) {
          card = makeQuestionNoteCard(note.status)
          renderedQuestionCards.set(note.requestID, card)
          questionsEl.append(card.el)
        } else {
          card.update(note.status)
        }
      }
      for (const [requestID, card] of renderedQuestionCards) {
        if (!presentIds.has(requestID)) {
          if (questionStatuses.get(requestID)?.kind === 'checking') {
            presentIds.add(requestID)
            continue
          }
          card.el.remove()
          renderedQuestionCards.delete(requestID)
        }
      }
      questionsEl.hidden = presentIds.size === 0
    }

    // Cancel control (R1/R2): render on non-terminal runs, hide once terminal.
    // Gated on run status via the reducer's `terminal` flag, not local optimism.
    if (cancelEl !== undefined && cancelEl !== null && cancelClient !== null) {
      const runEntry = state.runs[runId]
      const runIsTerminal = runEntry !== undefined && runEntry.terminal === true

      if (runIsTerminal) {
        if (cancelControl !== null) {
          cancelControl.notifyTerminal()
        }
        cancelEl.hidden = false
      } else if (state.connection === 'live' && runEntry !== undefined) {
        if (cancelControl === null) {
          cancelControl = renderCancelControl(runId, cancelClient, targetRunId => {
            dispatch({type: 'cancel', data: {runId: targetRunId}})
          })
          cancelEl.append(cancelControl.el)
        }
        cancelEl.hidden = false
      } else {
        cancelEl.hidden = true
      }
    }
  }

  function clearFirstFrameTimer() {
    if (firstFrameTimer !== null) {
      clearTimeout(firstFrameTimer)
      firstFrameTimer = null
    }
  }

  // Track whether we've done the reconcile GET for the current connection attempt.
  // Reset on each connect() call so reconnects trigger a fresh reconcile.
  let reconcileDone = false

  // Monotonic counter incremented on every connect() call. Each reconcileApprovals
  // invocation captures the epoch before its await; if the epoch changed by the time
  // the GET resolves, the result is stale and must be discarded.
  let connectEpoch = 0

  function dispatch(event) {
    const prevConnection = state.connection
    state = nextStreamState(state, event)
    syncQuestionStatuses()
    updateDOM()
    // Trigger reconcile when the stream first goes live (or re-goes live after reconnect).
    // This is the one-shot GET on (re)connect.
    if (prevConnection !== 'live' && state.connection === 'live') {
      reconcileApprovals()
      // The question check is its own trigger with its own flag and epoch, not the approval latch.
      // A request claimed elsewhere keeps its exemption across the transition, and its re-list
      // schedule restarts so a request the claimant released is found.
      reconcileQuestions()
      restartClaimedRechecks()
    }
  }

  /**
   * Reconcile open approvals on (re)connect: one-shot corrective GET on stream open.
   *
   * Snapshots the locally-open approval ids BEFORE the GET so that any prompt
   * opening via SSE during the await window is never eligible for pruning (race-proof).
   * On a successful response, dispatches a single approval-reconcile action that
   * both prunes ghost prompts and adds any recovered-but-not-local prompts.
   * On any failure, dispatches nothing — open prompts are preserved (fail-closed).
   *
   * Truncation guard: if the recovered set is at or above the gateway cap it may be
   * incomplete, so pruneIds is left empty (additive-only) to avoid false pruning.
   *
   * Never called on a timer — only once per connect() invocation.
   */
  async function reconcileApprovals() {
    if (approvalClient === null) return
    if (reconcileDone) return
    reconcileDone = true

    // Capture the epoch before the await. If connect() increments connectEpoch
    // while the GET is in flight, myEpoch will differ from connectEpoch when we
    // resume — that means this reconcile is stale and must be discarded.
    const myEpoch = connectEpoch

    // Snapshot the locally-open ids BEFORE the await. Only prompts open at this
    // moment are eligible for pruning — prompts that arrive via SSE during the
    // GET window are never in this set and therefore never pruned.
    const runEntry = state.runs[runId]
    const preGetLocalOpenIds = getOpenApprovals(runEntry).map(p => p.requestID)

    const listResult = await approvalClient.listRunApprovals(runId)

    // Epoch staleness check: if connect() started a new connection cycle during
    // the await, connectEpoch will have advanced — discard this stale result.
    if (myEpoch !== connectEpoch) return

    // On any failure, abort — never prune on an unsafe signal.
    if (!listResult.success) return

    const recovered = listResult.data.approvals

    // Validate each recovered summary and build the recovered open-id set and
    // the list of prompts to add (those not already locally open).
    const recoveredOpenIds = new Set()
    const addPrompts = []
    let sawMalformed = false
    for (const approval of recovered) {
      if (
        typeof approval.requestID !== 'string' ||
        approval.requestID.length === 0 ||
        typeof approval.permission !== 'string' ||
        approval.permission.length === 0
      ) {
        sawMalformed = true
        continue
      }
      recoveredOpenIds.add(approval.requestID)
      addPrompts.push({
        requestID: approval.requestID,
        permission: approval.permission,
        ...(typeof approval.command === 'string' ? {command: approval.command} : {}),
        ...(typeof approval.filepath === 'string' ? {filepath: approval.filepath} : {}),
      })
    }

    // Partial-malformed guard: if ANY entry failed validation the recovered set is
    // not a trustworthy complete picture — fall back to additive-only (no prune).
    // A genuinely empty response (recovered.length === 0, sawMalformed === false)
    // is authoritative and still prunes normally.
    // An all-invalid response (recoveredOpenIds.size === 0, sawMalformed === true)
    // is also additive-only — the valid subset is empty so addPrompts is empty too,
    // meaning the dispatch is a no-op, but we never prune on a corrupt response.
    if (sawMalformed) {
      dispatch({type: 'approval-reconcile', runId, pruneIds: [], addPrompts})
      return
    }

    // Truncation guard: if the recovered VALID set is at or above the gateway cap
    // it may be incomplete — fall back to additive-only to avoid pruning real open
    // prompts. Uses recoveredOpenIds.size (valid entries only) to match the metric
    // used by the prune diff below.
    const pruneIds = recoveredOpenIds.size >= GATEWAY_PENDING_APPROVALS_CAP
      ? []
      : preGetLocalOpenIds.filter(id => !recoveredOpenIds.has(id))

    dispatch({type: 'approval-reconcile', runId, pruneIds, addPrompts})
  }

  // -------------------------------------------------------------------------
  // Questions: per-request status, decisions, and the three re-list triggers
  //
  // The reducer stays pure; everything with a clock or a network lives here. Per-request status
  // is stream state, NOT page-store state: the page store holds only tombstones and drafts.
  // A request with no entry in `questionStatuses` is simply `open`.
  //
  //   {kind:'open'}
  //   {kind:'in-flight'}                         a decision POST is outstanding
  //   {kind:'claimed-elsewhere'}                 already_claimed; re-listing on a backoff (restarted at
  //                                              each live transition), then manual
  //   {kind:'checking'}                          a list check is pending (unknown outcome, or manual)
  //   {kind:'gone'}                              unknown outcome, then absent: may have been recorded
  //   {kind:'invalid', reason, questionIndex}    400 with a reason; questionIndex null = whole request
  //   {kind:'failed-to-settle'}                  failed_to_settle, or any retryable request-level error
  //   {kind:'cant-answer'}                       masked 404 (applies to every open request of the run)
  //   {kind:'session-expired'}                   401/403
  //   {kind:'check-failed'}                      a check that surfaced to the operator failed
  //   {kind:'claimed'} | {kind:'already-settled'}  settled; note for a request that is no longer open
  //
  // Never logs, and never stores, request bodies, answer text or response text.
  // -------------------------------------------------------------------------

  const questionRecheckTimers = new Map() // requestID → timer
  let questionsCantAnswer = false // masked 404: the run's questions cannot be answered by this session
  let questionEpoch = 0 // advanced by every connect(); a flight from an older epoch is discarded
  let questionFlight = null // the in-flight list check, if any: {id, epoch, promise}
  let questionFlightSeq = 0

  function isQuestionOpen(requestID) {
    return state.runs[runId]?.questionOpen?.has(requestID) === true
  }

  function setQuestionStatus(requestID, status) {
    questionStatuses.set(requestID, status)
    updateDOM()
  }

  function clearQuestionRecheck(requestID) {
    const timer = questionRecheckTimers.get(requestID)
    if (timer !== undefined) {
      clearTimeout(timer)
      questionRecheckTimers.delete(requestID)
    }
  }

  function clearQuestionRechecks() {
    for (const timer of questionRecheckTimers.values()) clearTimeout(timer)
    questionRecheckTimers.clear()
  }

  /**
   * Drop statuses the state no longer supports. Runs after every reducer event: a request that
   * left (settle frame, list removal, terminal) loses its status unless it is a settled/gone note;
   * a note whose request returned open is dropped; a claimed request whose exemption ended (a
   * settle frame, a list that shows it open again) is simply open.
   */
  function syncQuestionStatuses() {
    if (questionStatuses.size === 0) return
    const entry = state.runs[runId]
    if (entry?.terminal === true) {
      questionStatuses.clear()
      clearQuestionRechecks()
      return
    }
    const open = entry?.questionOpen
    const exempt = entry?.questionClaimedExempt
    for (const [requestID, status] of [...questionStatuses]) {
      if (open?.has(requestID) !== true) {
        if (!QUESTION_NOTE_KINDS.has(status.kind)) {
          questionStatuses.delete(requestID)
          clearQuestionRecheck(requestID)
        }
      } else if (QUESTION_NOTE_KINDS.has(status.kind)) {
        questionStatuses.delete(requestID)
      } else if (status.kind === 'claimed-elsewhere' && exempt?.has(requestID) !== true) {
        questionStatuses.delete(requestID)
        clearQuestionRecheck(requestID)
      }
    }
  }

  /** The UI-facing status of one request, or null for a request this stream knows nothing about. */
  function getQuestionStatus(requestID) {
    if (!isQuestionOpen(requestID)) return questionStatuses.get(requestID) ?? null
    if (questionsCantAnswer) return {kind: 'cant-answer'}
    return questionStatuses.get(requestID) ?? {kind: 'open'}
  }

  /** Open requests in arrival order, each with its parsed prompts and UI-facing status. */
  function getQuestions() {
    return getOpenQuestions(state.runs[runId]).map(request => ({
      requestID: request.requestID,
      questions: request.questions,
      status: getQuestionStatus(request.requestID),
    }))
  }

  /** Notes for requests that are no longer open (settled, or gone after an unknown outcome). */
  function getQuestionNotes() {
    const notes = []
    for (const [requestID, status] of questionStatuses) {
      if (QUESTION_NOTE_KINDS.has(status.kind) && !isQuestionOpen(requestID)) notes.push({requestID, status})
    }
    return notes
  }

  /** Surface a failed check on every request whose check was pending (it was `checking`). */
  function failQuestionChecks(targets) {
    for (const requestID of targets) {
      if (isQuestionOpen(requestID)) questionStatuses.set(requestID, {kind: 'check-failed'})
    }
    updateDOM()
  }

  /**
   * Settle the pending checks after a good list was applied. A request still open goes back to
   * claimed-elsewhere if it is still exempt, else to open. A request that is gone from the open set
   * — and was not tombstoned by a settle, nor cleared by a terminal status — is `gone`: the list
   * omitted it after an unknown outcome, so the answer may have been recorded.
   */
  function resolveQuestionChecks(targets) {
    const entry = state.runs[runId]
    const tombstones = getQuestionPageStore(runId).tombstones
    for (const requestID of targets) {
      if (isQuestionOpen(requestID)) {
        const status = questionStatuses.get(requestID)
        if (status?.kind !== 'checking' && status?.kind !== 'check-failed') continue
        if (entry?.questionClaimedExempt?.has(requestID) === true) {
          questionStatuses.set(requestID, {kind: 'claimed-elsewhere'})
        } else {
          questionStatuses.delete(requestID)
        }
      } else if (!tombstones.has(requestID) && entry?.terminal !== true) {
        questionStatuses.set(requestID, {kind: 'gone'})
      }
    }
    updateDOM()
  }

  /**
   * One list check: snapshot the open ids BEFORE the GET, list, dispatch the diff, then settle
   * whatever checks were pending. Resolves true only for a valid list applied in the current epoch.
   * A failure (network, 429, 5xx, non-OK, invalid body) never prunes; it surfaces `check-failed`
   * only on requests whose check was pending, and is never retried automatically.
   */
  async function runQuestionFlight(flight) {
    try {
      const targets = new Set()
      for (const [requestID, status] of questionStatuses) {
        if (status.kind === 'checking' || status.kind === 'check-failed') targets.add(requestID)
      }
      if (state.connection !== 'live') {
        failQuestionChecks(targets)
        return false
      }
      const snapshotIds = getOpenQuestions(state.runs[runId]).map(request => request.requestID)

      const result = await questionClient.listRunQuestions(runId)

      // Stale: close() ran, or connect() started a new cycle during the await.
      if (aborted || flight.epoch !== questionEpoch) return false

      if (!result.success) {
        failQuestionChecks(targets)
        return false
      }
      const {requests, invalidBody, partial} = result.data
      if (invalidBody === true || state.connection !== 'live') {
        // An invalid body changes nothing; a connection that dropped mid-GET ignores the result too.
        if (invalidBody === true) {
          dispatch({type: 'question-reconcile', runId, snapshotIds, requests: [], invalidBody: true, partial: false})
        }
        failQuestionChecks(targets)
        return false
      }
      dispatch({
        type: 'question-reconcile',
        runId,
        snapshotIds,
        requests,
        invalidBody: false,
        partial,
      })
      resolveQuestionChecks(targets)
      return true
    } finally {
      if (questionFlight === flight) questionFlight = null
    }
  }

  /**
   * Re-list the run's pending questions. Has its own in-flight flag and epoch; it is not the
   * approval `reconcileDone` latch. Calls coalesce into the flight already running, except
   * `fresh` ones (an unknown outcome, a manual check), which need a list issued after they were
   * asked for: they wait out an older flight and then run, or join one started after them.
   * Resolves to whether a valid list was applied.
   */
  async function reconcileQuestions({fresh = false} = {}) {
    if (questionClient === null || aborted) return false
    const askedAfter = questionFlightSeq
    for (;;) {
      const running = questionFlight
      if (running === null || running.epoch !== questionEpoch) break
      if (!fresh || running.id > askedAfter) return running.promise
      await running.promise
      if (aborted) return false
    }
    const flight = {id: ++questionFlightSeq, epoch: questionEpoch, promise: null}
    questionFlight = flight
    flight.promise = runQuestionFlight(flight)
    return flight.promise
  }

  /**
   * Re-list after `already_claimed`: about 2, 5, 10 and 20 seconds apart, then stop and leave
   * "Check again" to the operator. The schedule ends early if the request stops being claimed
   * elsewhere, if the connection is not live, or if a check fails (never retried automatically).
   */
  function scheduleQuestionRecheck(requestID, attempt) {
    clearQuestionRecheck(requestID)
    if (aborted || attempt >= QUESTION_CLAIM_RECHECK_DELAYS_MS.length) return
    const timer = setTimeout(async () => {
      questionRecheckTimers.delete(requestID)
      if (aborted) return
      if (questionStatuses.get(requestID)?.kind !== 'claimed-elsewhere' || state.connection !== 'live') return
      const ok = await reconcileQuestions()
      if (!ok || aborted) return
      if (questionStatuses.get(requestID)?.kind === 'claimed-elsewhere') scheduleQuestionRecheck(requestID, attempt + 1)
    }, QUESTION_CLAIM_RECHECK_DELAYS_MS[attempt])
    questionRecheckTimers.set(requestID, timer)
  }

  /** Start the re-list schedule over for every request that is claimed elsewhere. */
  function restartClaimedRechecks() {
    for (const [requestID, status] of questionStatuses) {
      if (status.kind === 'claimed-elsewhere' && isQuestionOpen(requestID)) scheduleQuestionRecheck(requestID, 0)
    }
  }

  /** Apply a decision outcome. Resolves after the follow-up list check, when there is one. */
  async function applyQuestionOutcome(requestID, outcome) {
    const stillOpen = isQuestionOpen(requestID)

    // This page's own claimed / already_settled settles the request for the page, like a settle
    // frame: tombstone, remove, drop the draft. A request that is gone already is still tombstoned
    // so a later list cannot resurrect it; a request cleared by a terminal status is ignored.
    if (outcome.kind === 'decided' && (outcome.state === 'claimed' || outcome.state === 'already_settled')) {
      if (state.runs[runId]?.terminal === true) return
      const store = getQuestionPageStore(runId)
      store.tombstones.add(requestID)
      store.drafts.delete(requestID)
      if (!stillOpen) return
      questionStatuses.set(requestID, {kind: outcome.state === 'claimed' ? 'claimed' : 'already-settled'})
      dispatch({type: 'question-resolved', runId, requestID})
      return
    }

    // Any other outcome for a request that settled or was cleared meanwhile is ignored.
    if (!stillOpen) return

    switch (outcome.kind) {
      case 'decided': {
        if (outcome.state === 'already_claimed') {
          // Kept, exempt from removal by absence (the gateway omits claimed requests from the list).
          setQuestionStatus(requestID, {kind: 'claimed-elsewhere'})
          dispatch({type: 'question-claimed', runId, requestID})
          if (questionStatuses.get(requestID)?.kind === 'claimed-elsewhere') scheduleQuestionRecheck(requestID, 0)
          return
        }
        setQuestionStatus(requestID, {kind: 'failed-to-settle'})
        return
      }
      case 'invalid': {
        setQuestionStatus(requestID, {kind: 'invalid', reason: outcome.reason, questionIndex: outcome.questionIndex})
        return
      }
      case 'cant-answer': {
        questionsCantAnswer = true
        questionStatuses.delete(requestID)
        updateDOM()
        return
      }
      case 'session-expired': {
        setQuestionStatus(requestID, {kind: 'session-expired'})
        return
      }
      case 'unknown': {
        // Never resubmit. Re-list with a fresh GET; absent afterwards means it may have been recorded.
        setQuestionStatus(requestID, {kind: 'checking'})
        await reconcileQuestions({fresh: true})
        return
      }
      default: {
        setQuestionStatus(requestID, {kind: 'failed-to-settle'})
      }
    }
  }

  /**
   * Submit a decision for one open request: `{decision:'skip'}` or
   * `{decision:'answer', answers:[{options?:number[], text?:string}]}` (one entry per question).
   * Refused (returns the current status, sends nothing) while the request is in flight or being
   * checked, and once the run's questions are known to be unanswerable. A request claimed elsewhere
   * can be answered: a missed settle surfaces as `already_settled`.
   * Resolves to the request's status afterwards, or null when the request is not open.
   */
  async function decideQuestion(requestID, decision) {
    if (questionClient === null || aborted) return null
    if (typeof requestID !== 'string' || !isQuestionOpen(requestID)) return null
    if (questionsCantAnswer) return getQuestionStatus(requestID)
    const current = questionStatuses.get(requestID)
    if (current !== undefined && QUESTION_SEND_BLOCKED_KINDS.has(current.kind)) return current
    setQuestionStatus(requestID, {kind: 'in-flight'})
    const outcome = await questionClient.decideRunQuestion(runId, requestID, decision)
    if (aborted) return null
    await applyQuestionOutcome(requestID, outcome)
    return getQuestionStatus(requestID)
  }

  /**
   * "Check again": re-list on demand. With a request ID it targets that request, otherwise every
   * request that is claimed elsewhere or whose last check failed. Those go `checking`, and a failed
   * check leaves `check-failed`. A request already being checked or in flight is left alone.
   */
  async function checkQuestions(requestID) {
    if (questionClient === null || aborted || questionsCantAnswer) return
    const checkable = status => status !== undefined && (status.kind === 'claimed-elsewhere' || status.kind === 'check-failed')
    if (requestID === undefined) {
      for (const [id, status] of [...questionStatuses]) {
        if (checkable(status) && isQuestionOpen(id)) questionStatuses.set(id, {kind: 'checking'})
      }
      updateDOM()
    } else {
      if (!isQuestionOpen(requestID)) return
      const status = questionStatuses.get(requestID)
      if (status?.kind === 'checking' || status?.kind === 'in-flight') return
      if (checkable(status)) setQuestionStatus(requestID, {kind: 'checking'})
    }
    await reconcileQuestions({fresh: true})
  }

  function connect() {
    // Don't fetch if close() was called
    if (aborted) return

    // Reset reconcile flag for this connection attempt — each connect/reconnect
    // triggers a fresh one-shot reconcile GET when the stream goes live.
    reconcileDone = false

    // Advance the epoch so any in-flight reconcile from the previous connection
    // cycle sees a stale epoch and discards its result. The question check keeps its own
    // epoch and its own completed flag, both reset here; the claimed re-list timers end here and
    // restart at the live transition.
    connectEpoch++
    questionEpoch++
    clearQuestionRechecks()
    if (state.runs[runId]?.questionReconcileDone === true) {
      dispatch({type: 'question-reconcile-reset', runId})
    }

    // Clear any previously-pending first-frame timer before arming a new one.
    // Without this, a reconnect would leak the old timer, which could fire later
    // and wrongly dispatch first-frame-timeout on a recovering stream.
    clearFirstFrameTimer()

    const connectionController = new AbortController()
    abortController = connectionController
    const signal = connectionController.signal

    // Set when this connection aborts its own request because the reducer reached a
    // non-reading terminal state. The resulting abort rejection is intentional: it must
    // not dispatch unexpected-close or schedule a reconnect.
    let abortedByUs = false

    // Arm the first-frame timeout. If no ready/status/reset frame arrives within
    // FIRST_FRAME_TIMEOUT_MS, the run is considered submitted but not yet observable.
    // The timer is cleared as soon as the first frame is dispatched or on close().
    firstFrameTimer = setTimeout(() => {
      firstFrameTimer = null
      dispatch({type: 'first-frame-timeout'})
    }, FIRST_FRAME_TIMEOUT_MS)

    // Build the stream URL — runId is used only here, never logged.
    // endpointBase defaults to '/operator'; dev mode may pass a different base.
    // fixtureSessionId is appended as a query param in fixture mode only.
    const _streamEndpointBase = endpointBase ?? '/operator'
    const _streamPath = `${_streamEndpointBase}/runs/${encodeURIComponent(runId)}/stream`
    const path = fixtureSessionId === undefined
      ? _streamPath
      : `${_streamPath}?fixtureSessionId=${encodeURIComponent(fixtureSessionId)}`

    fetch(path, {
      credentials: 'include',
      redirect: 'error', // prevent auth-redirect loops
      signal,
      headers: {accept: 'text/event-stream'},
    })
      .then(response => {
        if (response.status === 404) {
          clearFirstFrameTimer()
          dispatch({type: 'http-status', code: 404})
          return
        }
        if (response.status === 429) {
          clearFirstFrameTimer()
          dispatch({type: 'http-status', code: 429})
          return
        }
        if (response.status !== 200) {
          clearFirstFrameTimer()
          dispatch({type: 'network-error'})
          scheduleReconnect()
          return
        }
        // Require Content-Type text/event-stream on 200
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.startsWith('text/event-stream')) {
          clearFirstFrameTimer()
          dispatch({type: 'network-error'})
          return
        }
        if (!response.body) {
          clearFirstFrameTimer()
          dispatch({type: 'network-error'})
          scheduleReconnect()
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''
        const reader = response.body.getReader()

        function readChunk() {
          reader
            .read()
            .then(({done, value}) => {
              if (done) {
                // Flush remaining buffer before handling done
                if (buffer.trim() !== '') {
                  const flushResult = parseSseFrame(`${buffer}\n\n`)
                  if (flushResult !== null && flushResult.success) {
                    clearFirstFrameTimer()
                    dispatch(flushResult.frame)
                  }
                  buffer = ''
                }
                // Stream ended — check if we should reconnect
                if (state.shouldReconnect) {
                  scheduleReconnect()
                } else {
                  dispatch({type: 'stream-closed'})
                }
                return
              }

              if (value) {
                // Normalize CRLF on each appended chunk
                buffer += normalizeCrlf(decoder.decode(value, {stream: true}))
              }

              // Hard buffer cap — abort the reader and fail closed terminally
              // (no reconnect) if exceeded without a record boundary.
              if (buffer.length > MAX_SSE_BUFFER_BYTES) {
                clearFirstFrameTimer()
                if (abortController) {
                  abortController.abort()
                }
                dispatch({type: 'buffer-overflow'})
                return
              }

              // Process complete SSE records (terminated by \n\n)
              let boundary = buffer.indexOf('\n\n')
              while (boundary !== -1) {
                const record = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)

                const result = parseSseFrame(`${record}\n\n`)
                if (result !== null && result.success) {
                  // Clear the first-frame timer on the first successfully parsed frame
                  clearFirstFrameTimer()
                  dispatch(result.frame)
                  // Parse failures are silently dropped (fail closed, no logging of frame data)
                }

                boundary = buffer.indexOf('\n\n')
              }

              // Continue reading if still connected; otherwise release the socket. The
              // gateway keeps a subscriber open (no frames) after a client-side close such as
              // reset:no-snapshot for a terminal run, so merely ceasing to read would leak the
              // stream and its subscriber slot until the gateway's max duration.
              if (
                state.connection !== 'closed' &&
                state.connection !== 'failed' &&
                state.connection !== 'not-found' &&
                state.connection !== 'drift' && // stop reading on drift
                state.connection !== 'submitted-unobservable' // stop reading after first-frame timeout
              ) {
                readChunk()
              } else {
                abortedByUs = true
                clearFirstFrameTimer()
                connectionController.abort()
              }
            })
            .catch(() => {
              if (abortedByUs) return
              // Stream read error — fail closed, no logging of error details
              clearFirstFrameTimer()
              dispatch({type: 'unexpected-close'})
              if (state.shouldReconnect) {
                scheduleReconnect()
              }
            })
        }

        readChunk()
      })
      .catch(() => {
        if (abortedByUs) return
        // Network error — fail closed, no logging of error details
        clearFirstFrameTimer()
        dispatch({type: 'network-error'})
        if (state.shouldReconnect) {
          scheduleReconnect()
        }
      })
  }

  function scheduleReconnect() {
    if (!state.shouldReconnect) return
    if (aborted) return // don't schedule if close() was called
    // use backoffDelay(retryCount) — retryCount >= 0 → 1000ms on first retry
    const delay = backoffDelay(state.retryCount)
    reconnectTimer = setTimeout(connect, delay)
  }

  // Start the connection
  connect()

  // Return a handle to allow external abort (e.g. page unload)
  return {
    decideQuestion,
    checkQuestions,
    getQuestions,
    getQuestionNotes,
    getQuestionStatus,
    close() {
      aborted = true // prevent late timer from fetching
      // Clear any pending timers
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      clearFirstFrameTimer()
      clearQuestionRechecks()
      if (abortController) {
        abortController.abort()
      }
      // Dispose the cancel control (if rendered) so a pending retry timer or
      // in-flight cancel attempt can never fire/mutate after close().
      if (cancelControl !== null) {
        cancelControl.dispose()
        // A disposed control can no longer cancel; remove it rather than leave an inert button.
        cancelControl.el.remove()
      }
      state = nextStreamState(state, {type: 'stream-closed'})
    },
  }
}

/**
 * Browser bootstrap. Discovers the run cards in the run-status section, starts a
 * stream for each, and closes all handles on page unload. Runs only in a browser
 * (guarded on `document`), so importing this module in Node for tests is a no-op.
 */
// Module-level state: tracks whether bootstrapOperatorStreams has been called,
// the active stream handles, and the registered pagehide listener.
// resetBootstrapState() closes handles and removes the listener before clearing.
let _bootstrapCalled = false
let _bootstrapHandles = []
let _pagehideListener = null

export function bootstrapOperatorStreams(opts) {
  // Idempotency guard: only bootstrap once per page load.
  // The React runtime seam calls this explicitly after the DOM skeleton is
  // rendered; the auto-start guard below also fires on DOMContentLoaded.
  // Without this guard, double-calling would register duplicate pagehide
  // listeners and duplicate stream handles.
  if (_bootstrapCalled) return
  _bootstrapCalled = true

  const endpointBase = opts?.endpointBase
  const fixtureSessionId = opts?.fixtureSessionId

  // Cards (index-created and launch-created) live in the unified run-index
  // list, not a separate #run-status-section. The shared stream-status notice
  // lives with the list too. Per-card streams start on expansion, not on
  // bootstrap discovery — this remains a one-shot fixture/test entry point
  // that discovers any pre-rendered cards.
  const section = document.querySelector('[data-role="run-index-list"]')
  if (section === null) return

  const noticeEl = document.querySelector('[data-role="stream-status"]')
  const cards = section.querySelectorAll('[data-run-id]')
  const handles = []

  for (const card of cards) {
    const runId = card.dataset.runId
    if (runId === null || runId === '') continue
    const statusEl = card.querySelector('[data-role="run-status"]')
    const outputEl = card.querySelector('[data-role="run-output"]')
    const coalescedEl = card.querySelector('[data-role="run-output-coalesced"]')
    // Discover the approval region and badge elements
    const approvalsEl = card.querySelector('[data-role="run-approvals"]')
    const badgeEl = card.querySelector('[data-role="approval-badge"]')
    handles.push(initOperatorStream({runId, statusEl, noticeEl, outputEl, coalescedEl, approvalsEl, badgeEl, endpointBase, fixtureSessionId}))
  }

  _bootstrapHandles = handles

  const listener = () => {
    for (const handle of handles) handle.close()
  }
  _pagehideListener = listener
  globalThis.addEventListener('pagehide', listener)
}

/**
 * Reset the bootstrap state.
 *
 * Closes all active stream handles and removes the pagehide listener registered
 * during the last bootstrapOperatorStreams() call. Called by the React runtime
 * seam cleanup so that a remount (e.g. after auth expiry and re-login) can
 * re-bootstrap the streams without leaking handles or duplicate listeners.
 * Also used in tests.
 */
export function resetBootstrapState() {
  // Close all active handles before clearing state
  for (const handle of _bootstrapHandles) {
    try {
      handle.close()
    } catch {
      // ignore close errors
    }
  }
  _bootstrapHandles = []

  // Remove the pagehide listener before clearing state
  if (_pagehideListener !== null) {
    if (typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('pagehide', _pagehideListener)
    }
    _pagehideListener = null
  }

  _bootstrapCalled = false
}

// Auto-start in the browser. Guarded so a Node/test import never touches the DOM.
// When imported with ?manual=1 (by the React runtime seam), auto-bootstrap is
// skipped so the seam has deterministic lifecycle control. Normal /static/operator-
// stream.js loads (without ?manual=1) retain the legacy auto-start behavior.
if (typeof document !== 'undefined') {
  const isManual = (() => {
    try {
      return new URL(import.meta.url).searchParams.has('manual')
    } catch {
      return false
    }
  })()
  if (!isManual) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootstrapOperatorStreams)
    } else {
      bootstrapOperatorStreams()
    }
  }
}
