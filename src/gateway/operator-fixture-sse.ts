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

import {OPERATOR_CONTRACT_VERSION} from './operator-contract/version.ts'

/** Canonical scenario names. Code-safe: lowercase with underscores, no spaces. */
export const FIXTURE_SCENARIO_NAMES = {
  /** Successful launch: ready → running → output → terminal succeeded. */
  success: 'success',
  /** Terminal failure after visible output: ready → running → output → terminal failed. */
  terminal_failure: 'terminal_failure',
  /** Unsupported contract version: ready with mismatched version → absorbing drift. */
  contract_drift: 'contract_drift',
  /** Malformed/unavailable stream: contains a malformed SSE record that fails closed. */
  malformed_unavailable: 'malformed_unavailable',
  /** Contract-1.5.0 no-output run: ready → running → empty terminal output → terminal succeeded. */
  no_output: 'no_output',
  /** Stream reset with a terminal reason: ready → running → reset (closes without reconnect). */
  stream_reset: 'stream_reset',
  /** Approval open→settle round trip: ready → running → approval open → approval settle → terminal succeeded. */
  approval_flow: 'approval_flow',
} as const

/** Union of all canonical scenario name values. */
export type FixtureScenarioName = (typeof FIXTURE_SCENARIO_NAMES)[keyof typeof FIXTURE_SCENARIO_NAMES]

const FIXTURE_RUN_ID_MALFORMED = 'run-fixture-malformed-001'

/**
 * Canonical fixture run ID for use in tests that call serializeScenarioToSse
 * directly (parser/reducer tests that don't go through the launch route).
 * Must be fixture-prefixed per the synthetic-only ID policy.
 */
export const FIXTURE_RUN_ID_FOR_TESTS = 'run-fixture-test-001'

/** Unsupported contract version for the drift scenario — explicitly not the pinned version. */
const FIXTURE_DRIFT_CONTRACT_VERSION = '0.0.0-fixture-drift'

/** Serialize a single SSE record to wire format: `event: <name>\ndata: <json>\n\n` */
function sseRecord(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
}

function readyFrame(contractVersion: string): string {
  return sseRecord('ready', {contractVersion})
}

function statusFrame(
  runId: string,
  status: string,
  phase: string,
  startedAt: string,
): string {
  return sseRecord('status', {
    runId,
    entityRef: 'fixture-org/fixture-repo',
    surface: 'github',
    phase,
    status,
    startedAt,
    stale: false,
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

const SCENARIO_BUILDERS: Readonly<Record<FixtureScenarioName, (activeRunId: string) => string>> = {
  [FIXTURE_SCENARIO_NAMES.success]: buildSuccessScenario,
  [FIXTURE_SCENARIO_NAMES.terminal_failure]: buildTerminalFailureScenario,
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
