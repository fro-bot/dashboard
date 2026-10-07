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
    // whole object, so the card shows only the failureKind label. The cast is the one deliberate
    // contract violation in this file.
    preparation: {
      outcome: 'refused',
      reason: 'dirty',
      changedPaths: ['fixture/ok.txt', 7],
    } as unknown as OperatorCheckoutPreparation,
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
      spec.preparation === undefined ? {} : {checkoutPreparation: spec.preparation},
    )
  )
}

const CHECKOUT_SCENARIO_BUILDERS = Object.fromEntries(
  (Object.keys(CHECKOUT_SCENARIO_SPECS) as CheckoutScenarioName[]).map(scenario => [
    scenario,
    (activeRunId: string) => buildCheckoutScenario(scenario, activeRunId),
  ]),
) as Readonly<Record<CheckoutScenarioName, (activeRunId: string) => string>>

const SCENARIO_BUILDERS: Readonly<Record<FixtureScenarioName, (activeRunId: string) => string>> = {
  ...CHECKOUT_SCENARIO_BUILDERS,
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
