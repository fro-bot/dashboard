/**
 * Typed SSE fixture scenarios for the operator local fixture harness.
 *
 * Security invariants:
 * - All identifiers are visually fixture-prefixed and must not look like
 *   production tokens, cookies, UUIDs, or real operator data.
 * - No real prompts, tool args, workspace paths, internal URLs, tokens,
 *   session cookies, or CSRF values.
 * - OPERATOR_CONTRACT_VERSION is emitted for matching scenarios; drift is
 *   explicit and opt-in via the contract_drift scenario.
 * - Serialized SSE bytes are consumed by the existing production parsers
 *   (parseSseChunk / parseSseFrame) without modification.
 */

import type {
  OperatorCheckoutPreparation,
  OperatorCheckoutProvenance,
  OperatorRemoteFreshness,
} from './operator-contract/provenance.ts'
import type {
  PendingQuestionDTO,
  QuestionDecisionErrorResponse,
  QuestionDecisionResponse,
} from './operator-contract/question-frame.ts'
import type {OperatorFailureKind} from './operator-contract/run-status.ts'
import {OPERATOR_CONTRACT_VERSION} from './operator-contract/version.ts'
import {FIXTURE_KNOWN_FAILURE_REASON, FIXTURE_UNKNOWN_FAILURE_REASON} from './operator-fixtures.ts'

/** Canonical scenario names. Code-safe: lowercase with underscores, no spaces. */
export const FIXTURE_SCENARIO_NAMES = {
  /** Successful launch: ready → running → output → terminal succeeded. */
  success: 'success',
  /** Terminal failure after visible output, no reason: ready → running → output → terminal failed. */
  terminal_failure: 'terminal_failure',
  /** Terminal failure with a known reason code, output preserved. */
  terminal_failure_known_reason: 'terminal_failure_known_reason',
  /** Terminal failure with a visibly synthetic, unrecognized reason code — must degrade to generic Failed. */
  terminal_failure_unknown_reason: 'terminal_failure_unknown_reason',
  /** Non-failed terminal status carrying a reason code — reason must be ignored by parsers/renderers. */
  non_failed_with_reason: 'non_failed_with_reason',
  /** Unsupported contract version: ready with mismatched version → absorbing drift. */
  contract_drift: 'contract_drift',
  /** Malformed/unavailable stream: contains a malformed SSE record that fails closed. */
  malformed_unavailable: 'malformed_unavailable',
  /** No-output run: ready → running → empty terminal output → terminal succeeded. */
  no_output: 'no_output',
  /** Stream reset with a terminal reason: ready → running → reset (closes without reconnect). */
  stream_reset: 'stream_reset',
  /** Approval open→settle round trip: ready → running → approval open → approval settle → terminal succeeded. */
  approval_flow: 'approval_flow',

  // -- Checkout provenance: a run that reached EXECUTING reports what it started from. --
  /** Clean attached head, remote not checked. */
  checkout_provenance_clean: 'checkout_provenance_clean',
  /** Clean attached head, remote checked and unchanged. */
  checkout_provenance_up_to_date: 'checkout_provenance_up_to_date',
  /** Clean attached head, remote checked and fast-forwarded. */
  checkout_provenance_fast_forward: 'checkout_provenance_fast_forward',
  /** Detached head, dirty worktree (all four counts), rebase in progress. */
  checkout_provenance_dirty_operation: 'checkout_provenance_dirty_operation',
  /** Inspection failed: unavailable provenance. */
  checkout_provenance_unavailable: 'checkout_provenance_unavailable',

  // -- Checkout preparation, refused: a run that never reached EXECUTING, no failureKind unless noted. --
  checkout_refused_needs_recovery: 'checkout_refused_needs_recovery',
  /** Refused checkout-substituted, alongside failureKind checkout-substituted. */
  checkout_refused_substituted: 'checkout_refused_substituted',
  checkout_refused_layout: 'checkout_refused_layout',
  /** Disallowed git config keys (list). */
  checkout_refused_config: 'checkout_refused_config',
  checkout_refused_operation: 'checkout_refused_operation',
  /** Uncommitted changes: more than the 10-entry cap, one over-long path. */
  checkout_refused_dirty: 'checkout_refused_dirty',
  /** Initialized submodules (list). */
  checkout_refused_submodule: 'checkout_refused_submodule',
  checkout_refused_detached: 'checkout_refused_detached',
  checkout_refused_non_default_branch: 'checkout_refused_non_default_branch',
  checkout_refused_diverged: 'checkout_refused_diverged',
  checkout_refused_ahead: 'checkout_refused_ahead',
  /** Files in the way: one entry of every obstruction kind. */
  checkout_refused_obstructed: 'checkout_refused_obstructed',
  checkout_refused_maintenance_hold: 'checkout_refused_maintenance_hold',
  /** Uncommitted changes whose paths carry bidi and control characters. */
  checkout_refused_bidi_path: 'checkout_refused_bidi_path',

  // -- Checkout preparation, failed update: flag combinations. --
  /** permanent:true, mutationStarted:'possibly'. */
  checkout_update_failed_permanent: 'checkout_update_failed_permanent',
  /** permanent:false, mutationStarted:true. */
  checkout_update_failed_mutated: 'checkout_update_failed_mutated',
  /** permanent:false, mutationStarted:false — no flag lines. */
  checkout_update_failed_transient: 'checkout_update_failed_transient',

  // -- Failure kinds with no preparation. --
  /** failureKind workspace-unavailable, no preparation. */
  workspace_unavailable: 'workspace_unavailable',
  /** A malformed nested preparation field plus failureKind: absent, but the run still terminalizes with its label. */
  checkout_malformed_preparation: 'checkout_malformed_preparation',

  // -- Agent questions (contract 1.9.0). Each has a recent-runs row; the harness question routes
  // -- answer per scenario. Streams that end open (no terminal frame) are held open by the route. --
  /** One single-choice question with options and a custom answer. */
  question_single: 'question_single',
  /** One request, four questions: single-choice, multiple, custom-only, unanswerable. */
  question_multi_shapes: 'question_multi_shapes',
  /** A question opens, then a settle frame arrives later in the stream (answered elsewhere). */
  question_settled_elsewhere: 'question_settled_elsewhere',
  /** A question opens, then the run ends failed with no settle frame. */
  question_terminal_pending: 'question_terminal_pending',
  /** Decision → already_claimed; the list omits the request first, then lists it again. */
  question_already_claimed_reopens: 'question_already_claimed_reopens',
  /** Decision → failed_to_settle, then already_settled on the retry. */
  question_failed_to_settle: 'question_failed_to_settle',
  /** Two questions; the decision is refused 400 unknown-option on question 2 (index 1). */
  question_invalid_answer: 'question_invalid_answer',
  /** The decision is the masked 404. */
  question_masked_404: 'question_masked_404',
  /** HTML tags, a Markdown link, and bidi/control characters in header, text, labels, descriptions. */
  question_text_sentinels: 'question_text_sentinels',

  // -- Expired snapshot (#583): the gateway answers a subscribe for a run with no replay entry with `reset` (no-snapshot). --
  /** ready → reset no-snapshot → terminal succeeded status, no output. */
  expired_completed_terminal_frame: 'expired_completed_terminal_frame',
  /** ready → reset no-snapshot → nothing; the stream stays open and the run-list row is terminal. */
  expired_completed_silent: 'expired_completed_silent',
  /** ready → reset no-snapshot → running status → output; the stream stays open. */
  running_after_no_snapshot: 'running_after_no_snapshot',
} as const

/** Union of all canonical scenario name values. */
export type FixtureScenarioName = (typeof FIXTURE_SCENARIO_NAMES)[keyof typeof FIXTURE_SCENARIO_NAMES]

/** The scenarios that carry checkout provenance or preparation, or one of the new failure kinds. */
export type CheckoutScenarioName =
  | 'checkout_provenance_clean'
  | 'checkout_provenance_up_to_date'
  | 'checkout_provenance_fast_forward'
  | 'checkout_provenance_dirty_operation'
  | 'checkout_provenance_unavailable'
  | 'checkout_refused_needs_recovery'
  | 'checkout_refused_substituted'
  | 'checkout_refused_layout'
  | 'checkout_refused_config'
  | 'checkout_refused_operation'
  | 'checkout_refused_dirty'
  | 'checkout_refused_submodule'
  | 'checkout_refused_detached'
  | 'checkout_refused_non_default_branch'
  | 'checkout_refused_diverged'
  | 'checkout_refused_ahead'
  | 'checkout_refused_obstructed'
  | 'checkout_refused_maintenance_hold'
  | 'checkout_refused_bidi_path'
  | 'checkout_update_failed_permanent'
  | 'checkout_update_failed_mutated'
  | 'checkout_update_failed_transient'
  | 'workspace_unavailable'
  | 'checkout_malformed_preparation'

/** The scenarios that carry agent questions or exercise the expired-snapshot (#583) paths. */
export type QuestionScenarioName =
  | 'question_single'
  | 'question_multi_shapes'
  | 'question_settled_elsewhere'
  | 'question_terminal_pending'
  | 'question_already_claimed_reopens'
  | 'question_failed_to_settle'
  | 'question_invalid_answer'
  | 'question_masked_404'
  | 'question_text_sentinels'
  | 'expired_completed_terminal_frame'
  | 'expired_completed_silent'
  | 'running_after_no_snapshot'

const FIXTURE_RUN_ID_MALFORMED = 'run-fixture-malformed-001'

/**
 * Canonical fixture run ID for use in tests that call serializeScenarioToSse
 * directly (parser/reducer tests that don't go through the launch route).
 * Must be fixture-prefixed per the synthetic-only ID policy.
 */
export const FIXTURE_RUN_ID_FOR_TESTS = 'run-fixture-test-001'

/** Unsupported contract version for the drift scenario — explicitly not the pinned version. */
const FIXTURE_DRIFT_CONTRACT_VERSION = '0.0.0-fixture-drift'

/**
 * Known/unknown reason codes for reason-bearing scenarios — shared with the
 * fixture-harness route so the same known value binds recent-row and
 * live-stream cases. See src/gateway/operator-fixtures.ts.
 */
const FIXTURE_KNOWN_REASON = FIXTURE_KNOWN_FAILURE_REASON
const FIXTURE_UNKNOWN_REASON = FIXTURE_UNKNOWN_FAILURE_REASON

/** Serialize a single SSE record to wire format: `event: <name>\ndata: <json>\n\n` */
function sseRecord(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
}

function readyFrame(contractVersion: string): string {
  return sseRecord('ready', {contractVersion})
}

/**
 * Optional checkout fields on a status frame, typed from the vendored contract so a fixture
 * can only emit the wire shape the gateway defines (timestamps included).
 */
interface CheckoutFrameFields {
  readonly checkoutProvenance?: OperatorCheckoutProvenance
  readonly checkoutPreparation?: OperatorCheckoutPreparation
  /** Emitted as `checkoutPreparation` verbatim, untyped: only for scenarios that violate the contract on purpose. */
  readonly rawCheckoutPreparation?: unknown
}

function statusFrame(
  runId: string,
  status: string,
  phase: string,
  startedAt: string,
  failureKind?: string,
  checkout: CheckoutFrameFields = {},
): string {
  return sseRecord('status', {
    runId,
    entityRef: 'fixture-org/fixture-repo',
    surface: 'github',
    phase,
    status,
    startedAt,
    stale: false,
    ...(failureKind === undefined ? {} : {failureKind}),
    ...(checkout.checkoutProvenance === undefined ? {} : {checkoutProvenance: checkout.checkoutProvenance}),
    ...(checkout.checkoutPreparation === undefined ? {} : {checkoutPreparation: checkout.checkoutPreparation}),
    ...(checkout.rawCheckoutPreparation === undefined ? {} : {checkoutPreparation: checkout.rawCheckoutPreparation}),
  })
}

function outputFrame(
  runId: string,
  text: string,
  final: boolean,
  seq: number,
): string {
  return sseRecord('output', {runId, text, final, seq})
}

function resetFrame(runId: string, reason: string): string {
  return sseRecord('reset', {runId, reason})
}

function approvalOpenFrame(
  runId: string,
  requestID: string,
  permission: string,
  command: string,
): string {
  return sseRecord('approval', {runId, requestID, permission, command, settled: false})
}

function approvalSettleFrame(runId: string, requestID: string): string {
  return sseRecord('approval', {runId, requestID, settled: true})
}

function buildSuccessScenario(activeRunId: string): string {
  const startedAt = '2026-06-28T10:00:00Z'

  return (
    readyFrame(OPERATOR_CONTRACT_VERSION) +
    statusFrame(activeRunId, 'running', 'EXECUTING', startedAt) +
    outputFrame(activeRunId, '[Fixture output — synthetic run result]', false, 0) +
    outputFrame(activeRunId, '[Fixture output — synthetic run result (final)]', true, 1) +
    statusFrame(activeRunId, 'succeeded', 'COMPLETED', startedAt)
  )
}

function buildTerminalFailureScenario(activeRunId: string): string {
  const startedAt = '2026-06-28T10:01:00Z'

  return (
    readyFrame(OPERATOR_CONTRACT_VERSION) +
    statusFrame(activeRunId, 'running', 'EXECUTING', startedAt) +
    outputFrame(activeRunId, '[Fixture output — synthetic partial result before failure]', false, 0) +
    outputFrame(activeRunId, '[Fixture output — synthetic partial result before failure (final)]', true, 1) +
    statusFrame(activeRunId, 'failed', 'FAILED', startedAt)
  )
}

function buildTerminalFailureKnownReasonScenario(activeRunId: string): string {
  const startedAt = '2026-06-28T10:01:30Z'

  return (
    readyFrame(OPERATOR_CONTRACT_VERSION) +
    statusFrame(activeRunId, 'running', 'EXECUTING', startedAt) +
    outputFrame(activeRunId, '[Fixture output — synthetic partial result before failure]', false, 0) +
    outputFrame(activeRunId, '[Fixture output — synthetic partial result before failure (final)]', true, 1) +
    statusFrame(activeRunId, 'failed', 'FAILED', startedAt, FIXTURE_KNOWN_REASON)
  )
}

function buildTerminalFailureUnknownReasonScenario(activeRunId: string): string {
  const startedAt = '2026-06-28T10:01:45Z'

  return (
    readyFrame(OPERATOR_CONTRACT_VERSION) +
    statusFrame(activeRunId, 'running', 'EXECUTING', startedAt) +
    outputFrame(activeRunId, '[Fixture output — synthetic partial result before failure]', false, 0) +
    outputFrame(activeRunId, '[Fixture output — synthetic partial result before failure (final)]', true, 1) +
    statusFrame(activeRunId, 'failed', 'FAILED', startedAt, FIXTURE_UNKNOWN_REASON)
  )
}

function buildNonFailedWithReasonScenario(activeRunId: string): string {
  const startedAt = '2026-06-28T10:01:50Z'

  return (
    readyFrame(OPERATOR_CONTRACT_VERSION) +
    statusFrame(activeRunId, 'running', 'EXECUTING', startedAt) +
    outputFrame(activeRunId, '[Fixture output — synthetic run result]', false, 0) +
    outputFrame(activeRunId, '[Fixture output — synthetic run result (final)]', true, 1) +
    // succeeded status carrying a reason code — must be ignored by parsers/renderers.
    statusFrame(activeRunId, 'succeeded', 'COMPLETED', startedAt, FIXTURE_KNOWN_REASON)
  )
}

function buildContractDriftScenario(activeRunId: string): string {
  const startedAt = '2026-06-28T10:02:00Z'

  return (
    readyFrame(FIXTURE_DRIFT_CONTRACT_VERSION) +
    // These frames follow the drift-triggering ready and must be absorbed:
    statusFrame(activeRunId, 'running', 'EXECUTING', startedAt) +
    outputFrame(activeRunId, '[Fixture output — must be absorbed after drift]', true, 0) +
    statusFrame(activeRunId, 'succeeded', 'COMPLETED', startedAt)
  )
}

function buildMalformedUnavailableScenario(_activeRunId: string): string {
  // Unrecognized event name → parser returns a typed failure with a fixed error string
  // that does not echo the event name. sseRecord() serializes the id via JSON.stringify
  // so the fixture sanitization regex (which scans source text) does not see a literal
  // runId key-value pair in the source.
  return sseRecord('fixture-unknown-event', {
    id: FIXTURE_RUN_ID_MALFORMED,
    reason: 'fixture-malformed',
  })
}

function buildNoOutputScenario(activeRunId: string): string {
  const startedAt = '2026-06-28T10:03:00Z'

  return (
    readyFrame(OPERATOR_CONTRACT_VERSION) +
    statusFrame(activeRunId, 'running', 'EXECUTING', startedAt) +
    outputFrame(activeRunId, '', true, 0) +
    statusFrame(activeRunId, 'succeeded', 'COMPLETED', startedAt)
  )
}

function buildStreamResetScenario(activeRunId: string): string {
  const startedAt = '2026-06-28T10:04:00Z'

  return (
    readyFrame(OPERATOR_CONTRACT_VERSION) +
    statusFrame(activeRunId, 'running', 'EXECUTING', startedAt) +
    resetFrame(activeRunId, 'terminal')
  )
}

function questionOpenFrame(runId: string, request: PendingQuestionDTO): string {
  return sseRecord('question', {runId, requestID: request.requestID, settled: false, questions: request.questions})
}

function questionSettleFrame(runId: string, request: PendingQuestionDTO): string {
  return sseRecord('question', {runId, requestID: request.requestID, settled: true})
}

function buildApprovalFlowScenario(activeRunId: string): string {
  const startedAt = '2026-06-28T10:05:00Z'
  const requestID = 'req-fixture-approval-001'

  return (
    readyFrame(OPERATOR_CONTRACT_VERSION) +
    statusFrame(activeRunId, 'running', 'EXECUTING', startedAt) +
    approvalOpenFrame(activeRunId, requestID, 'shell', '[fixture command — synthetic]') +
    approvalSettleFrame(activeRunId, requestID) +
    statusFrame(activeRunId, 'succeeded', 'COMPLETED', startedAt)
  )
}

// ---------------------------------------------------------------------------
// Checkout provenance / preparation scenarios
//
// Contract-realistic: provenance rides only on a run that reached EXECUTING, and
// preparation only on a FAILED run that never did (usually without a failureKind).
// Every free-form value is synthetic and `fixture`-prefixed. SHAs are derived at
// module load so no 40-hex literal sits in source.
// ---------------------------------------------------------------------------

const FIXTURE_SHA_HEAD = 'a1'.repeat(20)
const FIXTURE_SHA_REMOTE = 'b2'.repeat(20)
const FIXTURE_SHA_PREVIOUS = 'c3'.repeat(20)
const FIXTURE_OBSERVED_AT = '2026-06-28T10:06:00Z'
const FIXTURE_CHECKED_AT = '2026-06-28T10:06:01Z'
const FIXTURE_DEFAULT_BRANCH = 'fixture-main'

function fixtureObserved(
  observation: Partial<Extract<OperatorCheckoutProvenance, {kind: 'observed'}>['observation']>,
  remote: OperatorRemoteFreshness,
): OperatorCheckoutProvenance {
  return {
    kind: 'observed',
    observation: {
      head: {kind: 'attached', branch: FIXTURE_DEFAULT_BRANCH, sha: FIXTURE_SHA_HEAD},
      worktree: {kind: 'clean'},
      operationInProgress: 'none',
      observedAt: FIXTURE_OBSERVED_AT,
      ...observation,
    },
    remote,
  }
}

const FIXTURE_REMOTE_NOT_CHECKED: OperatorRemoteFreshness = {kind: 'not-checked'}

function fixtureNumberedPaths(count: number): string[] {
  return Array.from({length: count}, (_, i) => `fixture/changed-${String(i + 1).padStart(2, '0')}.txt`)
}

interface CheckoutScenarioSpec {
  /** Status the recent-runs row shows before the stream is opened. */
  readonly summaryStatus: 'running' | 'failed'
  /** failureKind on the terminal frame (and the failed row). */
  readonly failureKind?: OperatorFailureKind
  /** Present → the run reached EXECUTING (and ends succeeded). */
  readonly provenance?: OperatorCheckoutProvenance
  /** Present → the run never reached EXECUTING (and ends failed). */
  readonly preparation?: OperatorCheckoutPreparation
  /** Present → emitted on the wire in place of `preparation`; for malformed-contract scenarios only. */
  readonly rawPreparation?: unknown
}

const FIXTURE_UNSAFE_PATHS = [
  'fixture/plain.txt',
  // right-to-left override: renders "fixture/gpj.txt" backwards if not stripped
  'fixture/\u202Egpj.txt',
  // C0 control (bell) and a C1 control
  'fixture/ctrl\u0007bell\u009Fend.txt',
  // only bidi/control characters: empty after sanitizing, so the entry is dropped
  '\u202E\u2066\u061C\u0000',
  // marks and isolates in the middle
  'fixture/mark\u200E\u200F\u2067iso\u2069.txt',
]

const CHECKOUT_SCENARIO_SPECS: Readonly<Record<CheckoutScenarioName, CheckoutScenarioSpec>> = {
  checkout_provenance_clean: {
    summaryStatus: 'running',
    provenance: fixtureObserved({}, FIXTURE_REMOTE_NOT_CHECKED),
  },
  checkout_provenance_up_to_date: {
    summaryStatus: 'running',
    provenance: fixtureObserved({}, {
      kind: 'checked',
      defaultBranch: FIXTURE_DEFAULT_BRANCH,
      sha: FIXTURE_SHA_HEAD,
      checkedAt: FIXTURE_CHECKED_AT,
      change: 'unchanged',
    }),
  },
  checkout_provenance_fast_forward: {
    summaryStatus: 'running',
    provenance: fixtureObserved({head: {kind: 'attached', branch: FIXTURE_DEFAULT_BRANCH, sha: FIXTURE_SHA_REMOTE}}, {
      kind: 'checked',
      defaultBranch: FIXTURE_DEFAULT_BRANCH,
      sha: FIXTURE_SHA_REMOTE,
      checkedAt: FIXTURE_CHECKED_AT,
      change: 'fast-forward',
      fromSha: FIXTURE_SHA_PREVIOUS,
    }),
  },
  checkout_provenance_dirty_operation: {
    summaryStatus: 'running',
    provenance: fixtureObserved(
      {
        head: {kind: 'detached', sha: FIXTURE_SHA_HEAD},
        worktree: {kind: 'dirty', staged: 2, unstaged: 3, untracked: 1, conflicted: 1},
        operationInProgress: 'rebase',
      },
      FIXTURE_REMOTE_NOT_CHECKED,
    ),
  },
  checkout_provenance_unavailable: {
    summaryStatus: 'running',
    provenance: {kind: 'unavailable', remote: FIXTURE_REMOTE_NOT_CHECKED},
  },

  checkout_refused_needs_recovery: {
    summaryStatus: 'failed',
    preparation: {outcome: 'refused', reason: 'needs-recovery'},
  },
  checkout_refused_substituted: {
    summaryStatus: 'failed',
    failureKind: 'checkout-substituted',
    preparation: {outcome: 'refused', reason: 'checkout-substituted'},
  },
  checkout_refused_layout: {
    summaryStatus: 'failed',
    preparation: {outcome: 'refused', reason: 'unsupported-layout', layoutReason: 'shallow'},
  },
  checkout_refused_config: {
    summaryStatus: 'failed',
    preparation: {
      outcome: 'refused',
      reason: 'unsupported-config',
      disallowedKeys: ['fixture.hooksPath', 'fixture.fsmonitor', 'fixture.sshCommand'],
    },
  },
  checkout_refused_operation: {
    summaryStatus: 'failed',
    preparation: {outcome: 'refused', reason: 'operation-in-progress', operation: 'rebase'},
  },
  checkout_refused_dirty: {
    summaryStatus: 'failed',
    preparation: {
      outcome: 'refused',
      reason: 'dirty',
      // 13 short paths plus one over-long one: 14 entries, so the card shows 10 and "and 4 more".
      changedPaths: [...fixtureNumberedPaths(13), `fixture/${'long-segment-'.repeat(30)}end.txt`],
    },
  },
  checkout_refused_submodule: {
    summaryStatus: 'failed',
    preparation: {
      outcome: 'refused',
      reason: 'submodule-initialized',
      submodules: ['fixture-vendor/alpha', 'fixture-vendor/beta', 'fixture-vendor/gamma'],
    },
  },
  checkout_refused_detached: {
    summaryStatus: 'failed',
    preparation: {outcome: 'refused', reason: 'detached'},
  },
  checkout_refused_non_default_branch: {
    summaryStatus: 'failed',
    preparation: {outcome: 'refused', reason: 'non-default-branch', branch: 'fixture-feature/checkout-detail'},
  },
  checkout_refused_diverged: {
    summaryStatus: 'failed',
    preparation: {outcome: 'refused', reason: 'diverged'},
  },
  checkout_refused_ahead: {
    summaryStatus: 'failed',
    preparation: {outcome: 'refused', reason: 'ahead'},
  },
  checkout_refused_obstructed: {
    summaryStatus: 'failed',
    preparation: {
      outcome: 'refused',
      reason: 'obstructed',
      obstructions: [
        {path: 'fixture/exact.txt', kind: 'exact-conflict'},
        {path: 'fixture/prefix', kind: 'prefix-conflict'},
        {path: 'fixture/identical.txt', kind: 'identical-content'},
        {path: 'fixture/link/inner.txt', kind: 'symlink-ancestor'},
      ],
    },
  },
  checkout_refused_maintenance_hold: {
    summaryStatus: 'failed',
    preparation: {outcome: 'refused', reason: 'maintenance-hold'},
  },
  checkout_refused_bidi_path: {
    summaryStatus: 'failed',
    preparation: {outcome: 'refused', reason: 'dirty', changedPaths: FIXTURE_UNSAFE_PATHS},
  },

  checkout_update_failed_permanent: {
    summaryStatus: 'failed',
    preparation: {outcome: 'failed', reason: 'apply-failed', mutationStarted: 'possibly', permanent: true},
  },
  checkout_update_failed_mutated: {
    summaryStatus: 'failed',
    preparation: {outcome: 'failed', reason: 'remote-moved', mutationStarted: true, permanent: false},
  },
  checkout_update_failed_transient: {
    summaryStatus: 'failed',
    preparation: {outcome: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false},
  },

  workspace_unavailable: {
    summaryStatus: 'failed',
    failureKind: 'workspace-unavailable',
  },
  checkout_malformed_preparation: {
    summaryStatus: 'failed',
    failureKind: 'checkout-substituted',
    // A corrupted nested field: changedPaths holds a non-string. Upstream rules (and ours) drop the
    // whole object, so the card shows only the failureKind label. This raw value is the one deliberate
    // contract violation in this file.
    rawPreparation: {
      outcome: 'refused',
      reason: 'dirty',
      changedPaths: ['fixture/ok.txt', 7],
    },
  },
}

/**
 * Rows for the recent-runs list: one per checkout scenario, so each is selectable from the
 * local harness without the launch drawer. Order follows FIXTURE_SCENARIO_NAMES.
 */
export const FIXTURE_CHECKOUT_SCENARIO_ROWS: readonly {
  readonly scenario: CheckoutScenarioName
  readonly summaryStatus: 'running' | 'failed'
  readonly failureKind?: OperatorFailureKind
}[] = (Object.keys(CHECKOUT_SCENARIO_SPECS) as CheckoutScenarioName[]).map(scenario => {
  const {summaryStatus, failureKind} = CHECKOUT_SCENARIO_SPECS[scenario]
  return failureKind === undefined ? {scenario, summaryStatus} : {scenario, summaryStatus, failureKind}
})

function buildCheckoutScenario(scenario: CheckoutScenarioName, activeRunId: string): string {
  const spec = CHECKOUT_SCENARIO_SPECS[scenario]
  const startedAt = '2026-06-28T10:06:00Z'

  if (spec.provenance !== undefined) {
    // Reached EXECUTING: provenance on the running frame, replayed on the terminal frame.
    const checkout = {checkoutProvenance: spec.provenance}
    return (
      readyFrame(OPERATOR_CONTRACT_VERSION) +
      statusFrame(activeRunId, 'queued', 'PENDING', startedAt) +
      statusFrame(activeRunId, 'running', 'EXECUTING', startedAt, undefined, checkout) +
      outputFrame(activeRunId, '[Fixture output — synthetic run result]', false, 0) +
      outputFrame(activeRunId, '[Fixture output — synthetic run result (final)]', true, 1) +
      statusFrame(activeRunId, 'succeeded', 'COMPLETED', startedAt, undefined, checkout)
    )
  }

  // Never reached EXECUTING: queued, then FAILED. The gateway always emits a terminal output
  // frame (empty here) before the terminal status.
  return (
    readyFrame(OPERATOR_CONTRACT_VERSION) +
    statusFrame(activeRunId, 'queued', 'PENDING', startedAt) +
    outputFrame(activeRunId, '', true, 0) +
    statusFrame(
      activeRunId,
      'failed',
      'FAILED',
      startedAt,
      spec.failureKind,
      {
        ...(spec.preparation === undefined ? {} : {checkoutPreparation: spec.preparation}),
        ...(spec.rawPreparation === undefined ? {} : {rawCheckoutPreparation: spec.rawPreparation}),
      },
    )
  )
}

const CHECKOUT_SCENARIO_BUILDERS = Object.fromEntries(
  (Object.keys(CHECKOUT_SCENARIO_SPECS) as CheckoutScenarioName[]).map(scenario => [
    scenario,
    (activeRunId: string) => buildCheckoutScenario(scenario, activeRunId),
  ]),
) as Readonly<Record<CheckoutScenarioName, (activeRunId: string) => string>>

// ---------------------------------------------------------------------------
// Question and expired-snapshot scenarios
//
// Wire shapes follow fro-bot/agent v0.119.1: open frames `{runId, requestID, settled:false, questions}`,
// settle frames `{runId, requestID, settled:true}`, no settle frame at terminal. Status frames stay
// `running` while a question is pending: `waiting_for_question` is overlaid only at lifecycle
// transitions and the fixtures do not model one. Every request ID is `req-fixture-` prefixed and every
// free-form string starts with `fixture`, ignoring the deliberate bidi/control characters in the
// sentinel scenario.
// ---------------------------------------------------------------------------

const QUESTION_STARTED_AT = '2026-10-10T10:00:00Z'

const QUESTION_SINGLE: PendingQuestionDTO = {
  requestID: 'req-fixture-question-single-001',
  questions: [
    {
      header: 'fixture choice',
      text: 'fixture question: which synthetic option should the agent use?',
      options: [
        {label: 'fixture-alpha', description: 'fixture first synthetic option'},
        {label: 'fixture-beta', description: 'fixture second synthetic option'},
        {label: 'fixture-gamma', description: 'fixture third synthetic option'},
      ],
      multiple: false,
      custom: true,
    },
  ],
}

// Every shape flag combination the card renders, in one request.
const QUESTION_MULTI: PendingQuestionDTO = {
  requestID: 'req-fixture-question-multi-001',
  questions: [
    {
      header: 'fixture single choice',
      text: 'fixture question 1: pick one option, or type your own.',
      options: [
        {label: 'fixture-red', description: 'fixture first synthetic option'},
        {label: 'fixture-green', description: 'fixture second synthetic option'},
      ],
      multiple: false,
      custom: true,
    },
    {
      header: 'fixture multiple',
      text: 'fixture question 2: pick any number of options.',
      options: [
        {label: 'fixture-one', description: 'fixture first synthetic option'},
        {label: 'fixture-two', description: 'fixture second synthetic option'},
        {label: 'fixture-three', description: 'fixture third synthetic option'},
      ],
      multiple: true,
      custom: true,
    },
    {
      header: 'fixture custom only',
      text: 'fixture question 3: no options, type an answer.',
      options: [],
      multiple: false,
      custom: true,
    },
    {
      header: 'fixture unanswerable',
      text: 'fixture question 4: no options and no custom answer, so it can only be skipped.',
      options: [],
      multiple: false,
      custom: false,
    },
  ],
}

const QUESTION_SETTLED_ELSEWHERE: PendingQuestionDTO = {
  requestID: 'req-fixture-question-settled-001',
  questions: [
    {
      header: 'fixture settled elsewhere',
      text: 'fixture question: this request is answered somewhere else.',
      options: [{label: 'fixture-yes', description: 'fixture synthetic option'}, {label: 'fixture-no', description: 'fixture synthetic option'}],
      multiple: false,
      custom: false,
    },
  ],
}

const QUESTION_TERMINAL_PENDING: PendingQuestionDTO = {
  requestID: 'req-fixture-question-terminal-001',
  questions: [
    {
      header: 'fixture pending at terminal',
      text: 'fixture question: the run ends while this is still open.',
      options: [{label: 'fixture-continue', description: 'fixture synthetic option'}],
      multiple: false,
      custom: true,
    },
  ],
}

const QUESTION_CLAIMED: PendingQuestionDTO = {
  requestID: 'req-fixture-question-claimed-001',
  questions: [
    {
      header: 'fixture claimed elsewhere',
      text: 'fixture question: another decision is in flight, then reopens.',
      options: [{label: 'fixture-approve', description: 'fixture synthetic option'}, {label: 'fixture-decline', description: 'fixture synthetic option'}],
      multiple: false,
      custom: true,
    },
  ],
}

const QUESTION_FAILED_TO_SETTLE: PendingQuestionDTO = {
  requestID: 'req-fixture-question-failsettle-001',
  questions: [
    {
      header: 'fixture failed to settle',
      text: 'fixture question: the reply to the agent fails.',
      options: [{label: 'fixture-send', description: 'fixture synthetic option'}, {label: 'fixture-hold', description: 'fixture synthetic option'}],
      multiple: false,
      custom: true,
    },
  ],
}

const QUESTION_INVALID: PendingQuestionDTO = {
  requestID: 'req-fixture-question-invalid-001',
  questions: [
    {
      header: 'fixture first question',
      text: 'fixture question 1: this answer is accepted.',
      options: [{label: 'fixture-a', description: 'fixture synthetic option'}, {label: 'fixture-b', description: 'fixture synthetic option'}],
      multiple: false,
      custom: true,
    },
    {
      header: 'fixture second question',
      text: 'fixture question 2: the gateway refuses this answer as an unknown option.',
      options: [{label: 'fixture-c', description: 'fixture synthetic option'}, {label: 'fixture-d', description: 'fixture synthetic option'}],
      multiple: false,
      custom: true,
    },
  ],
}

const QUESTION_MASKED: PendingQuestionDTO = {
  requestID: 'req-fixture-question-masked-001',
  questions: [
    {
      header: 'fixture masked denial',
      text: 'fixture question: the decision is denied with a masked 404.',
      options: [{label: 'fixture-go', description: 'fixture synthetic option'}],
      multiple: false,
      custom: true,
    },
  ],
}

// Untrusted text: HTML, a Markdown link and bidi/control characters (override, isolate, bell, newline).
// The parsers strip the controls and the browser renders the rest as plain text.
const QUESTION_SENTINELS: PendingQuestionDTO = {
  requestID: 'req-fixture-question-sentinels-001',
  questions: [
    {
      header: 'fixture <b>bold</b> header\u202E reversed',
      text:
        'fixture <img src=x onerror=alert(1)> and [a link](https://fixture.invalid/phish)\u202E reversed\u2066 isolate\u2069\nsecond line\u0007 bell',
      options: [
        {label: 'fixture <i>italic</i> \u202Elabel', description: 'fixture [markdown](https://fixture.invalid/x) **not bold**'},
        {label: 'fixture `code` \u2067isolate\u2069 label', description: 'fixture <script>fixture()</script>\u001F end'},
      ],
      multiple: false,
      custom: true,
    },
  ],
}

/** The outcome of one question decision POST. */
export type FixtureQuestionDecisionOutcome =
  | {readonly status: 200; readonly body: QuestionDecisionResponse}
  | {readonly status: 400; readonly body: QuestionDecisionErrorResponse}
  | {readonly status: 404}

/**
 * What the harness question routes answer for one scenario. Every sequence advances one step per call
 * and repeats its last entry.
 */
export interface FixtureQuestionScript {
  /** `GET .../questions` before any decision; also the whole list when `listsAfterDecision` is absent. */
  readonly openRequests: readonly PendingQuestionDTO[]
  /** Lists returned by successive GETs once a decision has been made. */
  readonly listsAfterDecision?: readonly (readonly PendingQuestionDTO[])[]
  /** Outcomes of successive decision POSTs. Absent: `{state:'claimed'}`. */
  readonly decisions?: readonly FixtureQuestionDecisionOutcome[]
}

interface QuestionScenarioSpec {
  /** Status the recent-runs row shows before the stream is opened (the card's summary status). */
  readonly summaryStatus: 'running' | 'succeeded'
  /** The stream ends open, as the gateway's does for a run that is not finished. */
  readonly holdOpen: boolean
  readonly script: FixtureQuestionScript
  readonly build: (activeRunId: string) => string
}

const claimed: FixtureQuestionDecisionOutcome = {status: 200, body: {state: 'claimed'}}

function runningWithProgress(runId: string): string {
  return (
    readyFrame(OPERATOR_CONTRACT_VERSION) +
    statusFrame(runId, 'running', 'EXECUTING', QUESTION_STARTED_AT) +
    outputFrame(runId, '[Fixture output — synthetic progress before the question]', false, 0)
  )
}

const QUESTION_SCENARIO_SPECS: Readonly<Record<QuestionScenarioName, QuestionScenarioSpec>> = {
  question_single: {
    summaryStatus: 'running',
    holdOpen: true,
    script: {openRequests: [QUESTION_SINGLE]},
    build: runId => runningWithProgress(runId) + questionOpenFrame(runId, QUESTION_SINGLE),
  },
  question_multi_shapes: {
    summaryStatus: 'running',
    holdOpen: true,
    script: {openRequests: [QUESTION_MULTI]},
    build: runId => runningWithProgress(runId) + questionOpenFrame(runId, QUESTION_MULTI),
  },
  question_settled_elsewhere: {
    summaryStatus: 'running',
    holdOpen: true,
    // Settled by the end of the stream, so a list no longer shows it.
    script: {openRequests: []},
    build: runId =>
      runningWithProgress(runId) +
      questionOpenFrame(runId, QUESTION_SETTLED_ELSEWHERE) +
      outputFrame(runId, '[Fixture output — synthetic progress after the request settled]', false, 1) +
      questionSettleFrame(runId, QUESTION_SETTLED_ELSEWHERE),
  },
  question_terminal_pending: {
    summaryStatus: 'running',
    holdOpen: false,
    // Terminal clears the run's questions with no settle frame, so a list is empty.
    script: {openRequests: []},
    build: runId =>
      runningWithProgress(runId) +
      questionOpenFrame(runId, QUESTION_TERMINAL_PENDING) +
      outputFrame(runId, '', true, 1) +
      statusFrame(runId, 'failed', 'FAILED', QUESTION_STARTED_AT),
  },
  question_already_claimed_reopens: {
    summaryStatus: 'running',
    holdOpen: true,
    script: {
      openRequests: [QUESTION_CLAIMED],
      // Claimed requests are excluded from the list; when the claimant fails the request reopens with no frame.
      listsAfterDecision: [[], [QUESTION_CLAIMED]],
      decisions: [{status: 200, body: {state: 'already_claimed'}}, claimed],
    },
    build: runId => runningWithProgress(runId) + questionOpenFrame(runId, QUESTION_CLAIMED),
  },
  question_failed_to_settle: {
    summaryStatus: 'running',
    holdOpen: true,
    script: {
      openRequests: [QUESTION_FAILED_TO_SETTLE],
      decisions: [{status: 200, body: {state: 'failed_to_settle'}}, {status: 200, body: {state: 'already_settled'}}],
    },
    build: runId => runningWithProgress(runId) + questionOpenFrame(runId, QUESTION_FAILED_TO_SETTLE),
  },
  question_invalid_answer: {
    summaryStatus: 'running',
    holdOpen: true,
    script: {
      openRequests: [QUESTION_INVALID],
      decisions: [{status: 400, body: {error: 'bad request', reason: 'unknown-option', questionIndex: 1}}],
    },
    build: runId => runningWithProgress(runId) + questionOpenFrame(runId, QUESTION_INVALID),
  },
  question_masked_404: {
    summaryStatus: 'running',
    holdOpen: true,
    script: {openRequests: [QUESTION_MASKED], decisions: [{status: 404}]},
    build: runId => runningWithProgress(runId) + questionOpenFrame(runId, QUESTION_MASKED),
  },
  question_text_sentinels: {
    summaryStatus: 'running',
    holdOpen: true,
    script: {openRequests: [QUESTION_SENTINELS]},
    build: runId => runningWithProgress(runId) + questionOpenFrame(runId, QUESTION_SENTINELS),
  },

  expired_completed_terminal_frame: {
    // A stale row: the list was read before the run finished, so the summary is not yet terminal and the
    // terminal status frame after `reset` is what tells the card the run is over.
    summaryStatus: 'running',
    holdOpen: false,
    script: {openRequests: []},
    build: runId =>
      readyFrame(OPERATOR_CONTRACT_VERSION) +
      resetFrame(runId, 'no-snapshot') +
      statusFrame(runId, 'succeeded', 'COMPLETED', QUESTION_STARTED_AT),
  },
  expired_completed_silent: {
    // The gateway could not read the stored run state, so it sends nothing after `reset`. Only the
    // run-list summary knows the run is over.
    summaryStatus: 'succeeded',
    holdOpen: true,
    script: {openRequests: []},
    build: runId => readyFrame(OPERATOR_CONTRACT_VERSION) + resetFrame(runId, 'no-snapshot'),
  },
  running_after_no_snapshot: {
    summaryStatus: 'running',
    holdOpen: true,
    script: {openRequests: []},
    build: runId =>
      readyFrame(OPERATOR_CONTRACT_VERSION) +
      resetFrame(runId, 'no-snapshot') +
      statusFrame(runId, 'running', 'EXECUTING', QUESTION_STARTED_AT) +
      outputFrame(runId, '[Fixture output — synthetic run result after the snapshot reset]', false, 0),
  },
}

/** Rows for the recent-runs list: one per question or expired-snapshot scenario. Order follows FIXTURE_SCENARIO_NAMES. */
export const FIXTURE_QUESTION_SCENARIO_ROWS: readonly {
  readonly scenario: QuestionScenarioName
  readonly summaryStatus: 'running' | 'succeeded'
}[] = (Object.keys(QUESTION_SCENARIO_SPECS) as QuestionScenarioName[]).map(scenario => ({
  scenario,
  summaryStatus: QUESTION_SCENARIO_SPECS[scenario].summaryStatus,
}))

function isQuestionScenarioName(name: string): name is QuestionScenarioName {
  return Object.hasOwn(QUESTION_SCENARIO_SPECS, name)
}

/** The scripted question routes for a scenario, or undefined for a scenario with no questions. */
export function fixtureQuestionScript(scenarioName: string): FixtureQuestionScript | undefined {
  return isQuestionScenarioName(scenarioName) ? QUESTION_SCENARIO_SPECS[scenarioName].script : undefined
}

/** True when the scenario's stream ends open, with no terminal frame, as the gateway's does for a live run. */
export function isHeldOpenScenario(scenarioName: string): boolean {
  return isQuestionScenarioName(scenarioName) && QUESTION_SCENARIO_SPECS[scenarioName].holdOpen
}

const QUESTION_SCENARIO_BUILDERS = Object.fromEntries(
  (Object.keys(QUESTION_SCENARIO_SPECS) as QuestionScenarioName[]).map(scenario => [
    scenario,
    QUESTION_SCENARIO_SPECS[scenario].build,
  ]),
) as Readonly<Record<QuestionScenarioName, (activeRunId: string) => string>>

const SCENARIO_BUILDERS: Readonly<Record<FixtureScenarioName, (activeRunId: string) => string>> = {
  ...CHECKOUT_SCENARIO_BUILDERS,
  ...QUESTION_SCENARIO_BUILDERS,
  [FIXTURE_SCENARIO_NAMES.success]: buildSuccessScenario,
  [FIXTURE_SCENARIO_NAMES.terminal_failure]: buildTerminalFailureScenario,
  [FIXTURE_SCENARIO_NAMES.terminal_failure_known_reason]: buildTerminalFailureKnownReasonScenario,
  [FIXTURE_SCENARIO_NAMES.terminal_failure_unknown_reason]: buildTerminalFailureUnknownReasonScenario,
  [FIXTURE_SCENARIO_NAMES.non_failed_with_reason]: buildNonFailedWithReasonScenario,
  [FIXTURE_SCENARIO_NAMES.contract_drift]: buildContractDriftScenario,
  [FIXTURE_SCENARIO_NAMES.malformed_unavailable]: buildMalformedUnavailableScenario,
  [FIXTURE_SCENARIO_NAMES.no_output]: buildNoOutputScenario,
  [FIXTURE_SCENARIO_NAMES.stream_reset]: buildStreamResetScenario,
  [FIXTURE_SCENARIO_NAMES.approval_flow]: buildApprovalFlowScenario,
}

/**
 * Serialize a fixture scenario to SSE wire bytes, binding the active run ID into
 * all run-scoped frames (status, output). The ready frame is contract-only and
 * carries no run ID. The malformed scenario uses a non-runId field.
 *
 * @throws {Error} If the scenario name is not a known canonical scenario.
 */
export function serializeScenarioToSse(scenarioName: string, activeRunId: string): string {
  const builder = SCENARIO_BUILDERS[scenarioName as FixtureScenarioName]
  if (builder === undefined) {
    throw new Error(`fixture-sse: unknown scenario name (not in FIXTURE_SCENARIO_NAMES)`)
  }
  return builder(activeRunId)
}
