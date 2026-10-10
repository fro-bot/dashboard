import type {RunSummaryStatus as BrowserRunIndexSummaryStatus} from '../public/operator-run-index.js'
import type {
  QUESTION_DECISION_STATES as BROWSER_QUESTION_DECISION_STATES,
  QUESTION_INVALID_REASONS as BROWSER_QUESTION_INVALID_REASONS,
  RunSummaryStatus as BrowserStreamRunSummaryStatus,
} from '../public/operator-stream.js'
import type {ApprovalDecisionState, RunStatus} from '../src/gateway/operator-client.ts'
import type {
  OperatorApprovalFrame,
  OperatorCancelResponse,
  OperatorCheckoutOperation,
  OperatorCheckoutPreparationRefused,
  OperatorDecisionState,
  OperatorFailureKind,
  OperatorLayoutRefusalReason,
  OperatorObstructionKind,
  OperatorOutputFrame,
  OperatorRunStatus,
  OperatorUpdateFailureReason,
  OperatorWebStatus,
  QuestionDecisionInvalidReason,
  QuestionDecisionResponse,
  QuestionFrameData,
  ReadyFrame,
  RepoSummary,
  ResetFrameData,
  ResetReason,
  RunPhase,
  RunsListResponse,
  RunStreamFrame,
  RunSummary as RunSummaryType,
  StatusFrameData,
  TerminalPhase,
} from '../src/gateway/operator-contract/index.ts'
/**
 * Operator contract conformance tests.
 *
 * Verifies the vendored operator contract is correctly pinned and
 * that parse helpers behave per spec. Also verifies the SSE frame types
 * vendored from fro-bot/agent (including the run-output and approval channels)
 * are structurally correct, and that no version or release-tag literal is
 * hand-typed anywhere in the vendored directory.
 *
 * Source: fro-bot/agent
 */
import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import ts from 'typescript'
import {describe, expect, it} from 'vitest'
import {
  CHECKOUT_OPERATIONS,
  CHECKOUT_REFUSAL_REASONS,
  LAYOUT_REFUSAL_REASONS,
  MAX_OPTIONS_PER_QUESTION,
  MAX_QUESTIONS_PER_REQUEST,
  OBSTRUCTION_KINDS,
  OPERATOR_CONTRACT_VERSION,
  parseOperatorCancelResponse,
  parseOperatorCheckoutPreparation,
  parseOperatorCheckoutProvenance,
  parseOperatorCsrfToken,
  parseOperatorError,
  parseOperatorOk,
  parseOperatorSessionInfo,
  parseQuestionFrame,
  parseRepoSummary,
  parseRepoSummaryList,
  parseRunsListResponse,
  parseRunSummary,
  parseRunSummaryList,
  PHASE_TO_WEB_STATUS,
  QUESTION_DECISION_STATES,
  QUESTION_HEADER_MAX_LENGTH,
  QUESTION_INVALID_REASONS,
  QUESTION_OPTION_DESCRIPTION_MAX_LENGTH,
  QUESTION_OPTION_LABEL_MAX_LENGTH,
  QUESTION_TEXT_MAX_LENGTH,
  RUN_INDEX_CAP,
  UPDATE_FAILURE_REASONS,
} from '../src/gateway/operator-contract/index.ts'
import {isOperatorFailureKind, OPERATOR_FAILURE_KINDS} from '../src/gateway/operator-contract/run-status.ts'

// ---------------------------------------------------------------------------
// Type-level assignability: dashboard types ↔ canonical contract types
// ---------------------------------------------------------------------------
// These are compile-time checks — if the types diverge, tsc fails.
// Function-based style: declare type-checking functions that are never called.
// Using satisfies to avoid unused-variable lint while keeping the type constraint.

// ApprovalDecisionState ↔ OperatorDecisionState (mutual assignability)
type CheckApprovalToCanonical = (x: ApprovalDecisionState) => OperatorDecisionState
type CheckCanonicalToApproval = (x: OperatorDecisionState) => ApprovalDecisionState
// These type aliases are the compile-time check — if types diverge, tsc fails here.
// The identity function satisfies both directions only when the types are identical.
const checkApprovalBidirectional: CheckApprovalToCanonical & CheckCanonicalToApproval = x => x
// Suppress unused-variable lint without void
export {checkApprovalBidirectional}

// RunStatus ↔ OperatorWebStatus (mutual assignability)
type CheckRunStatusToCanonical = (x: RunStatus) => OperatorWebStatus
type CheckCanonicalToRunStatus = (x: OperatorWebStatus) => RunStatus
const checkRunStatusBidirectional: CheckRunStatusToCanonical & CheckCanonicalToRunStatus = x => x
export {checkRunStatusBidirectional}

// ---------------------------------------------------------------------------
// SSE frame type-assignability checks (compile-time)
// ---------------------------------------------------------------------------
// These are compile-time checks — if the types diverge, tsc fails.
// Function-based style: declare type-checking functions that are never called.
// Using satisfies/export to avoid unused-variable lint while keeping the type constraint.

// ReadyFrame: must accept a literal with contractVersion string
const checkReadyFrameLiteral: ReadyFrame = {contractVersion: OPERATOR_CONTRACT_VERSION}
export {checkReadyFrameLiteral}

// ResetFrameData: must accept a literal with runId + ResetReason
const checkResetFrameLiteral: ResetFrameData = {runId: 'run-001', reason: 'no-snapshot'}
export {checkResetFrameLiteral}

// StatusFrameData is aliased to OperatorRunStatus — mutual assignability
type CheckStatusToRunStatus = (x: StatusFrameData) => OperatorRunStatus
type CheckRunStatusToStatus = (x: OperatorRunStatus) => StatusFrameData
const checkStatusBidirectional: CheckStatusToRunStatus & CheckRunStatusToStatus = x => x
export {checkStatusBidirectional}

// ResetReason: all 6 values must be assignable to the union
const checkResetReasons: ResetReason[] = ['no-snapshot', 'terminal', 'shutdown', 'max-duration', 'writer-error', 'overflow']
export {checkResetReasons}

// RepoSummary: must accept literals with and without channelName
const checkRepoSummaryMinimal: RepoSummary = {owner: 'fro-bot', repo: 'agent'}
const checkRepoSummaryWithChannel: RepoSummary = {owner: 'fro-bot', repo: 'agent', channelName: 'main'}
export {checkRepoSummaryMinimal, checkRepoSummaryWithChannel}

// OperatorOutputFrame: must accept literals with and without droppedCount,
// and an empty-text authoritative final frame.
const checkOutputDelta: OperatorOutputFrame = {runId: 'run-001', text: 'partial', final: false, seq: 0}
const checkOutputFinal: OperatorOutputFrame = {runId: 'run-001', text: 'complete', final: true, seq: 3}
const checkOutputCoalesced: OperatorOutputFrame = {runId: 'run-001', text: 'partial', final: false, seq: 1, droppedCount: 2}
const checkOutputEmptyFinal: OperatorOutputFrame = {runId: 'run-001', text: '', final: true, seq: 0}
export {checkOutputCoalesced, checkOutputDelta, checkOutputEmptyFinal, checkOutputFinal}

// OperatorApprovalFrame: both discriminated variants must be assignable
// Open variant — with command
const checkApprovalFrameOpenWithCommand: OperatorApprovalFrame = {
  runId: 'run-001',
  requestID: 'req-001',
  permission: 'shell',
  command: 'ls -la',
  settled: false,
}
export {checkApprovalFrameOpenWithCommand}
// Open variant — with filepath
const checkApprovalFrameOpenWithFilepath: OperatorApprovalFrame = {
  runId: 'run-001',
  requestID: 'req-001',
  permission: 'fs/write',
  filepath: '/tmp/output.txt',
  settled: false,
}
export {checkApprovalFrameOpenWithFilepath}
// Open variant — with neither command nor filepath (both optional)
const checkApprovalFrameOpenMinimal: OperatorApprovalFrame = {
  runId: 'run-001',
  requestID: 'req-001',
  permission: 'network',
  settled: false,
}
export {checkApprovalFrameOpenMinimal}
// Settle variant — exactly 3 fields
const checkApprovalFrameSettle: OperatorApprovalFrame = {
  runId: 'run-001',
  requestID: 'req-001',
  settled: true,
}
export {checkApprovalFrameSettle}

// RunStreamFrame discriminated union: each variant must be constructable
const checkReadyFrame: RunStreamFrame = {type: 'ready', data: {contractVersion: OPERATOR_CONTRACT_VERSION}}
const checkOutputFrame: RunStreamFrame = {
  type: 'output',
  data: {runId: 'run-001', text: 'partial', final: false, seq: 0},
}
export {checkOutputFrame}
const checkResetFrame: RunStreamFrame = {type: 'reset', data: {runId: 'run-001', reason: 'terminal'}}
const checkStatusFrame: RunStreamFrame = {
  type: 'status',
  data: {
    runId: 'run-001',
    entityRef: 'fro-bot/agent',
    surface: 'github',
    phase: 'EXECUTING',
    status: 'running',
    startedAt: '2026-06-20T00:00:00Z',
    stale: false,
  },
}
// Approval frame as RunStreamFrame union member
const checkApprovalRunStreamFrame: RunStreamFrame = {
  type: 'approval',
  data: {
    runId: 'run-001',
    requestID: 'req-001',
    permission: 'shell',
    command: 'echo hello',
    settled: false,
  },
}
// Question frame as RunStreamFrame union member: both discriminated variants
const checkQuestionOpenRunStreamFrame: RunStreamFrame = {
  type: 'question',
  data: {
    runId: 'run-001',
    requestID: 'req-001',
    settled: false,
    questions: [{header: 'h', text: 't', options: [{label: 'l', description: 'd'}], multiple: false, custom: true}],
  },
}
const checkQuestionSettleRunStreamFrame: RunStreamFrame = {
  type: 'question',
  data: {runId: 'run-001', requestID: 'req-001', settled: true},
}
// waiting_for_question is a member of the web status union
const checkWaitingForQuestionStatus: OperatorWebStatus = 'waiting_for_question'
export {
  checkApprovalRunStreamFrame,
  checkQuestionOpenRunStreamFrame,
  checkQuestionSettleRunStreamFrame,
  checkReadyFrame,
  checkResetFrame,
  checkStatusFrame,
  checkWaitingForQuestionStatus,
}

const CONTRACT_DIR = join(import.meta.dirname, '../src/gateway/operator-contract')

// ---------------------------------------------------------------------------
// Version pin
// ---------------------------------------------------------------------------

describe('OPERATOR_CONTRACT_VERSION', () => {
  it('is a well-formed major.minor.patch version (the value itself is never re-typed in tests)', () => {
    expect(OPERATOR_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('is the single version literal in the vendored directory: none in any comment or in the README', () => {
    const files = readdirSync(CONTRACT_DIR).filter(name => name.endsWith('.ts') || name.endsWith('.md'))
    expect(files).toContain('version.ts')
    expect(files).toContain('README.md')
    expect(files).toContain('provenance.ts')
    expect(files).toContain('question-frame.ts')

    for (const name of files) {
      const text = readFileSync(join(CONTRACT_DIR, name), 'utf8')
      const prose = name.endsWith('.md') ? [text] : commentRanges(text).map(range => text.slice(range.pos, range.end))
      for (const chunk of prose) {
        expect(findVersionLiterals(chunk), `${name} comment/prose carries a version or tag literal`).toEqual([])
      }
    }
  })

  it('version.ts holds OPERATOR_CONTRACT_VERSION as the only literal outside comments', () => {
    const text = readFileSync(join(CONTRACT_DIR, 'version.ts'), 'utf8')
    const code = blankRanges(text, commentRanges(text))
    expect(findVersionLiterals(code)).toEqual([OPERATOR_CONTRACT_VERSION])
  })
})

// ---------------------------------------------------------------------------
// OperatorFailureKind
// ---------------------------------------------------------------------------

// Exhaustive over the union: adding or removing a member without updating this record fails tsc.
const FAILURE_KIND_RECORD = {
  'inactivity-timeout': true,
  'max-duration-timeout': true,
  'stream-ended': true,
  'workspace-unreachable': true,
  'session-error': true,
  'checkout-substituted': true,
  'workspace-unavailable': true,
  unknown: true,
} satisfies Record<OperatorFailureKind, true>

describe('OperatorFailureKind', () => {
  it('all known reason codes are assignable to the union', () => {
    const checkFailureKinds: OperatorFailureKind[] = [
      'inactivity-timeout',
      'max-duration-timeout',
      'stream-ended',
      'workspace-unreachable',
      'session-error',
      'checkout-substituted',
      'workspace-unavailable',
      'unknown',
    ]
    expect(checkFailureKinds).toHaveLength(Object.keys(FAILURE_KIND_RECORD).length)
  })

  it('OPERATOR_FAILURE_KINDS equals the union members, no more and no fewer', () => {
    expect([...OPERATOR_FAILURE_KINDS].toSorted()).toEqual(Object.keys(FAILURE_KIND_RECORD).toSorted())
  })

  it('isOperatorFailureKind accepts every member and rejects anything else', () => {
    for (const kind of Object.keys(FAILURE_KIND_RECORD)) {
      expect(isOperatorFailureKind(kind)).toBe(true)
    }
    for (const bad of ['fixture-unknown-kind', '', 'Checkout-Substituted', 7, null, undefined, {}, ['unknown']]) {
      expect(isOperatorFailureKind(bad)).toBe(false)
    }
  })

  it('OperatorRunStatus accepts an optional failureKind on a failed status', () => {
    const checkStatusWithFailureKind: OperatorRunStatus = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'FAILED',
      status: 'failed',
      startedAt: '2026-07-07T00:00:00Z',
      stale: false,
      failureKind: 'inactivity-timeout',
    }
    const checkStatusWithoutFailureKind: OperatorRunStatus = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'FAILED',
      status: 'failed',
      startedAt: '2026-07-07T00:00:00Z',
      stale: false,
    }
    expect(checkStatusWithFailureKind.failureKind).toBe('inactivity-timeout')
    expect(checkStatusWithoutFailureKind.failureKind).toBeUndefined()
  })

  it('OperatorRunStatus accepts optional checkoutProvenance and checkoutPreparation', () => {
    const base = {
      runId: 'run-001',
      entityRef: 'fro-bot/agent',
      surface: 'github',
      phase: 'FAILED',
      status: 'failed',
      startedAt: '2026-07-07T00:00:00Z',
      stale: false,
    } as const
    const withPreparation: OperatorRunStatus = {
      ...base,
      checkoutPreparation: {outcome: 'refused', reason: 'detached'},
    }
    const withProvenance: OperatorRunStatus = {
      ...base,
      checkoutProvenance: {kind: 'unavailable', remote: {kind: 'not-checked'}},
    }
    expect(withPreparation.checkoutPreparation?.outcome).toBe('refused')
    expect(withProvenance.checkoutProvenance?.kind).toBe('unavailable')
  })
})

// ---------------------------------------------------------------------------
// Runtime vocabularies — exported so coverage tests can read them. Each set is
// compared with an exhaustive record keyed by the vendored union, so a value
// added to one side and not the other fails here (compile time and run time).
// ---------------------------------------------------------------------------

const LAYOUT_REASON_RECORD = {
  'core-worktree': true,
  gitfile: true,
  'symlinked-git-dir': true,
  'symlinked-config': true,
  alternates: true,
  'replace-refs': true,
  grafts: true,
  shallow: true,
  'partial-clone': true,
  'linked-worktree': true,
  'unsupported-index-flag': true,
  'bare-repository': true,
} satisfies Record<OperatorLayoutRefusalReason, true>

const OBSTRUCTION_KIND_RECORD = {
  'exact-conflict': true,
  'prefix-conflict': true,
  'identical-content': true,
  'symlink-ancestor': true,
} satisfies Record<OperatorObstructionKind, true>

const UPDATE_FAILURE_REASON_RECORD = {
  aborted: true,
  'inspection-failed': true,
  'fetch-auth-rejected': true,
  'fetch-not-found': true,
  'fetch-forbidden': true,
  'fetch-rate-limited': true,
  'fetch-unreachable': true,
  'fetch-timeout': true,
  'fetch-failed': true,
  'remote-moved': true,
  'apply-failed': true,
  'termination-unconfirmed': true,
} satisfies Record<OperatorUpdateFailureReason, true>

const CHECKOUT_OPERATION_RECORD = {
  none: true,
  merge: true,
  rebase: true,
  am: true,
  'cherry-pick': true,
  revert: true,
  bisect: true,
} satisfies Record<OperatorCheckoutOperation, true>

const REFUSAL_REASON_RECORD = {
  'needs-recovery': true,
  'checkout-substituted': true,
  'unsupported-layout': true,
  'unsupported-config': true,
  'operation-in-progress': true,
  dirty: true,
  'submodule-initialized': true,
  detached: true,
  'non-default-branch': true,
  diverged: true,
  ahead: true,
  obstructed: true,
  'maintenance-hold': true,
} satisfies Record<OperatorCheckoutPreparationRefused['reason'], true>

describe('provenance runtime vocabularies', () => {
  it.each([
    ['layout refusal reasons', LAYOUT_REFUSAL_REASONS, LAYOUT_REASON_RECORD],
    ['obstruction kinds', OBSTRUCTION_KINDS, OBSTRUCTION_KIND_RECORD],
    ['update-failure reasons', UPDATE_FAILURE_REASONS, UPDATE_FAILURE_REASON_RECORD],
    ['checkout operations', CHECKOUT_OPERATIONS, CHECKOUT_OPERATION_RECORD],
  ] as const)('%s: the exported set equals the union', (_name, set, record) => {
    expect([...set].toSorted()).toEqual(Object.keys(record).toSorted())
  })

  it('refusal reasons: the exported list equals the union, with no duplicates', () => {
    expect([...CHECKOUT_REFUSAL_REASONS].toSorted()).toEqual(Object.keys(REFUSAL_REASON_RECORD).toSorted())
    expect(new Set(CHECKOUT_REFUSAL_REASONS).size).toBe(CHECKOUT_REFUSAL_REASONS.length)
  })

  it('every listed refusal reason is a parseable refusal shape, and an unlisted reason is not', () => {
    // Per-reason minimal valid payloads; the loop proves the list and the parser's switch agree.
    const payloads: Record<(typeof CHECKOUT_REFUSAL_REASONS)[number], Record<string, unknown>> = {
      'needs-recovery': {},
      'checkout-substituted': {},
      'unsupported-layout': {layoutReason: 'shallow'},
      'unsupported-config': {disallowedKeys: []},
      'operation-in-progress': {operation: 'merge'},
      dirty: {changedPaths: []},
      'submodule-initialized': {submodules: []},
      detached: {},
      'non-default-branch': {branch: 'fixture-feature'},
      diverged: {},
      ahead: {},
      obstructed: {obstructions: []},
      'maintenance-hold': {},
    }
    for (const reason of CHECKOUT_REFUSAL_REASONS) {
      const parsed = parseOperatorCheckoutPreparation({outcome: 'refused', reason, ...payloads[reason]})
      expect(parsed?.outcome, reason).toBe('refused')
    }
    expect(parseOperatorCheckoutPreparation({outcome: 'refused', reason: 'fixture-unknown-reason'})).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Question frame: runtime vocabularies and parser
// ---------------------------------------------------------------------------

// Exhaustive over the unions: adding or removing a member without updating a record fails tsc.
const QUESTION_STATE_RECORD = {
  claimed: true,
  already_claimed: true,
  already_settled: true,
  failed_to_settle: true,
} satisfies Record<QuestionDecisionResponse['state'], true>

const QUESTION_REASON_RECORD = {
  malformed: true,
  'arity-mismatch': true,
  'unknown-option': true,
  'multiple-not-allowed': true,
  'empty-value': true,
  'text-too-long': true,
} satisfies Record<QuestionDecisionInvalidReason, true>

// The browser declaration files re-declare these vocabularies by hand. Each alias below is `true`
// only while the browser copy and the contract union are the same set, so a copy that drifts
// fails `check-types` here.
type IsExactMatch<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type AssertTrue<T extends true> = T

export type BrowserQuestionDecisionStatesAreExact = AssertTrue<
  IsExactMatch<(typeof BROWSER_QUESTION_DECISION_STATES)[number], QuestionDecisionResponse['state']>
>
export type BrowserQuestionInvalidReasonsAreExact = AssertTrue<
  IsExactMatch<(typeof BROWSER_QUESTION_INVALID_REASONS)[number], QuestionDecisionInvalidReason>
>
export type BrowserStreamRunSummaryStatusIsExact = AssertTrue<
  IsExactMatch<BrowserStreamRunSummaryStatus, RunSummaryType['status']>
>
export type BrowserRunIndexSummaryStatusIsExact = AssertTrue<
  IsExactMatch<BrowserRunIndexSummaryStatus, RunSummaryType['status']>
>

describe('question runtime vocabularies', () => {
  it('decision states: the exported list equals the union, with no duplicates', () => {
    expect([...QUESTION_DECISION_STATES].toSorted()).toEqual(Object.keys(QUESTION_STATE_RECORD).toSorted())
    expect(new Set(QUESTION_DECISION_STATES).size).toBe(QUESTION_DECISION_STATES.length)
  })

  it('invalid-answer reasons: the exported list equals the union, with no duplicates', () => {
    expect([...QUESTION_INVALID_REASONS].toSorted()).toEqual(Object.keys(QUESTION_REASON_RECORD).toSorted())
    expect(new Set(QUESTION_INVALID_REASONS).size).toBe(QUESTION_INVALID_REASONS.length)
  })

  it('exports the upstream bounds', () => {
    expect(QUESTION_HEADER_MAX_LENGTH).toBe(128)
    expect(QUESTION_TEXT_MAX_LENGTH).toBe(4096)
    expect(QUESTION_OPTION_LABEL_MAX_LENGTH).toBe(256)
    expect(QUESTION_OPTION_DESCRIPTION_MAX_LENGTH).toBe(1024)
    expect(MAX_QUESTIONS_PER_REQUEST).toBe(8)
    expect(MAX_OPTIONS_PER_QUESTION).toBe(64)
  })
})

describe('parseQuestionFrame', () => {
  const question = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    header: 'Pick one',
    text: 'Which path?',
    options: [{label: 'A', description: 'first'}],
    multiple: false,
    custom: true,
    ...overrides,
  })
  const openFrame = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    runId: 'run-001',
    requestID: 'req-001',
    settled: false,
    questions: [question()],
    ...overrides,
  })

  it('parses an open frame with two questions into a closed object', () => {
    const input = openFrame({
      questions: [
        question(),
        question({header: 'Second', text: 'More?', options: [{label: 'X', description: 'x'}, {label: 'Y', description: 'y'}], multiple: true, custom: false}),
      ],
    })
    const parsed = parseQuestionFrame(input)
    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    if (parsed === null || parsed.settled) throw new Error('expected open frame')
    expect(parsed.questions).not.toBe(input.questions)
    expect(parsed.questions[0]).not.toBe((input.questions as unknown[])[0])
  })

  it('parses a settle frame to exactly {runId, requestID, settled:true}', () => {
    const parsed = parseQuestionFrame({runId: 'run-001', requestID: 'req-001', settled: true})
    expect(parsed).toEqual({runId: 'run-001', requestID: 'req-001', settled: true})
  })

  it('accepts zero options, custom:false, multiple:true, and a request with zero questions', () => {
    const noOptions = parseQuestionFrame(openFrame({questions: [question({options: []})]}))
    expect(noOptions).not.toBeNull()
    const flags = parseQuestionFrame(openFrame({questions: [question({multiple: true, custom: false})]}))
    expect(flags).not.toBeNull()
    const zeroQuestions = parseQuestionFrame(openFrame({questions: []}))
    expect(zeroQuestions).toEqual({runId: 'run-001', requestID: 'req-001', settled: false, questions: []})
  })

  it('accepts exactly the upstream bounds', () => {
    const atBounds = openFrame({
      questions: Array.from({length: 8}, () =>
        question({
          header: 'h'.repeat(128),
          text: 't'.repeat(4096),
          options: Array.from({length: 64}, () => ({label: 'l'.repeat(256), description: 'd'.repeat(1024)})),
        }),
      ),
    })
    expect(parseQuestionFrame(atBounds)).not.toBeNull()
  })

  it('converts tab, newline and carriage return to spaces', () => {
    const parsed = parseQuestionFrame(
      openFrame({questions: [question({text: 'a\tb\nc\rd', options: [{label: 'x\ty', description: 'p\nq'}]})]}),
    )
    if (parsed === null || parsed.settled) throw new Error('expected open frame')
    expect(parsed.questions[0]?.text).toBe('a b c d')
    expect(parsed.questions[0]?.options[0]).toEqual({label: 'x y', description: 'p q'})
  })

  it('removes C0, C1 and bidi controls, including U+061C, but keeps ordinary text', () => {
    const dirty = 'a\u0000b\u001Bc\u007Fd\u0085e\u061Cf\u200Eg\u200Fh\u202Ei\u2066j\u2069k Ünïcode 日本'
    const parsed = parseQuestionFrame(openFrame({questions: [question({header: dirty, text: dirty})]}))
    if (parsed === null || parsed.settled) throw new Error('expected open frame')
    expect(parsed.questions[0]?.header).toBe('abcdefghijk Ünïcode 日本')
    expect(parsed.questions[0]?.text).toBe('abcdefghijk Ünïcode 日本')
  })

  it('measures bounds after control removal', () => {
    const padded = `${'h'.repeat(128)}\u202E\u0000`
    expect(parseQuestionFrame(openFrame({questions: [question({header: padded})]}))).not.toBeNull()
  })

  it.each([
    ['9 questions', openFrame({questions: Array.from({length: 9}, () => question())})],
    ['65 options', openFrame({questions: [question({options: Array.from({length: 65}, () => ({label: 'l', description: 'd'}))})]})],
    ['a 129-character header', openFrame({questions: [question({header: 'h'.repeat(129)})]})],
    ['a 4097-character text', openFrame({questions: [question({text: 't'.repeat(4097)})]})],
    ['a 257-character label', openFrame({questions: [question({options: [{label: 'l'.repeat(257), description: 'd'}]})]})],
    ['a 1025-character description', openFrame({questions: [question({options: [{label: 'l', description: 'd'.repeat(1025)}]})]})],
    ['a non-boolean multiple', openFrame({questions: [question({multiple: 'yes'})]})],
    ['a missing custom', openFrame({questions: [question({custom: undefined})]})],
    ['a non-string header', openFrame({questions: [question({header: 5})]})],
    ['a non-array options', openFrame({questions: [question({options: 'A'})]})],
    ['a non-object option', openFrame({questions: [question({options: ['A']})]})],
    ['a non-array questions', openFrame({questions: {}})],
    ['an extra frame key', openFrame({extra: 1})],
    ['an extra question key', openFrame({questions: [question({extra: 1})]})],
    ['an extra option key', openFrame({questions: [question({options: [{label: 'l', description: 'd', extra: 1}]})]})],
    ['an empty runId', openFrame({runId: ''})],
    ['an empty requestID', openFrame({requestID: ''})],
    ['a non-boolean settled', openFrame({settled: 'false'})],
    ['a missing settled', openFrame({settled: undefined})],
    ['a settle frame with questions', {runId: 'run-001', requestID: 'req-001', settled: true, questions: []}],
    ['a settle frame with an extra key', {runId: 'run-001', requestID: 'req-001', settled: true, extra: 1}],
    ['an open frame without questions', {runId: 'run-001', requestID: 'req-001', settled: false}],
  ])('rejects %s', (_name, input) => {
    expect(parseQuestionFrame(input)).toBeNull()
  })

  it.each([null, undefined, 'x', 5, [], [openFrame()]])('rejects a non-object value (%#)', input => {
    expect(parseQuestionFrame(input)).toBeNull()
  })

  it('rejects rather than truncates: an over-bound string never yields a shortened result', () => {
    const parsed = parseQuestionFrame(openFrame({questions: [question({text: 't'.repeat(5000)})]}))
    expect(parsed).toBeNull()
  })

  it('never passes an own __proto__ key through', () => {
    const polluted = JSON.parse(
      '{"runId":"run-001","requestID":"req-001","settled":false,"questions":[{"header":"h","text":"t","options":[],"multiple":false,"custom":true,"__proto__":{"polluted":true}}]}',
    ) as unknown
    const parsed = parseQuestionFrame(polluted)
    expect(parsed).toBeNull()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

    const topLevel = JSON.parse('{"runId":"run-001","requestID":"req-001","settled":true,"__proto__":{"polluted":true}}') as unknown
    const settle = parseQuestionFrame(topLevel)
    expect(settle === null || !Object.hasOwn(settle, '__proto__')).toBe(true)
  })

  it('returns a value assignable to QuestionFrameData', () => {
    const parsed: QuestionFrameData | null = parseQuestionFrame({runId: 'r', requestID: 'q', settled: true})
    expect(parsed?.settled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseOperatorCheckoutProvenance / parseOperatorCheckoutPreparation — direct
// ---------------------------------------------------------------------------

const FIXTURE_SHA = 'c'.repeat(40)

describe('parseOperatorCheckoutProvenance', () => {
  const observed = {
    kind: 'observed',
    observation: {
      head: {kind: 'attached', branch: 'fixture-main', sha: FIXTURE_SHA},
      worktree: {kind: 'clean'},
      operationInProgress: 'none',
      observedAt: '2026-10-06T00:00:00Z',
    },
    remote: {kind: 'not-checked'},
  }

  it('accepts a valid observed provenance and an unavailable provenance', () => {
    expect(parseOperatorCheckoutProvenance(observed)).toEqual(observed)
    const unavailable = {kind: 'unavailable', remote: {kind: 'not-checked'}}
    expect(parseOperatorCheckoutProvenance(unavailable)).toEqual(unavailable)
  })

  it('rejects absent and non-object inputs to undefined', () => {
    for (const bad of [undefined, null, 'x', 1, true, []]) {
      expect(parseOperatorCheckoutProvenance(bad)).toBeUndefined()
    }
  })

  it('rejects a 39-character SHA, and a fast-forward whose fromSha equals sha', () => {
    const short = {...observed, observation: {...observed.observation, head: {kind: 'detached', sha: 'c'.repeat(39)}}}
    expect(parseOperatorCheckoutProvenance(short)).toBeUndefined()
    const noAdvance = {
      ...observed,
      remote: {
        kind: 'checked',
        defaultBranch: 'main',
        sha: FIXTURE_SHA,
        checkedAt: '2026-10-06T00:00:00Z',
        change: 'fast-forward',
        fromSha: FIXTURE_SHA,
      },
    }
    expect(parseOperatorCheckoutProvenance(noAdvance)).toBeUndefined()
  })

  it('accepts an unchanged checked remote and a real fast-forward', () => {
    const unchanged = {
      ...observed,
      remote: {kind: 'checked', defaultBranch: 'main', sha: FIXTURE_SHA, checkedAt: 'now', change: 'unchanged'},
    }
    expect(parseOperatorCheckoutProvenance(unchanged)).toEqual(unchanged)
    const fastForward = {
      ...observed,
      remote: {
        kind: 'checked',
        defaultBranch: 'main',
        sha: FIXTURE_SHA,
        checkedAt: 'now',
        change: 'fast-forward',
        fromSha: 'd'.repeat(40),
      },
    }
    expect(parseOperatorCheckoutProvenance(fastForward)).toEqual(fastForward)
  })
})

// ---------------------------------------------------------------------------
// Static helpers for the version-literal scan
// ---------------------------------------------------------------------------

function commentRanges(text: string): {pos: number; end: number}[] {
  const sourceFile = ts.createSourceFile('contract.ts', text, ts.ScriptTarget.Latest, true)
  const ranges = new Map<number, {pos: number; end: number}>()
  const visit = (node: ts.Node): void => {
    const found = [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]
    for (const range of found) ranges.set(range.pos, {pos: range.pos, end: range.end})
    for (const child of node.getChildren(sourceFile)) visit(child)
  }
  visit(sourceFile)
  return [...ranges.values()]
}

function blankRanges(text: string, ranges: readonly {pos: number; end: number}[]): string {
  let out = text
  for (const {pos, end} of ranges) {
    out = out.slice(0, pos) + ' '.repeat(end - pos) + out.slice(end)
  }
  return out
}

/** Dotted version strings, optionally v-prefixed, and bare v-prefixed tags. */
function findVersionLiterals(text: string): string[] {
  return text.match(/\bv?\d+(?:\.\d+)+\b|\bv\d+\b/g) ?? []
}

// ---------------------------------------------------------------------------
// parseOperatorSessionInfo
// ---------------------------------------------------------------------------

describe('parseOperatorSessionInfo', () => {
  it('accepts valid shape with numeric expiresAt', () => {
    const input = {operatorId: 42, login: 'octocat', expiresAt: 4070908800000}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.operatorId).toBe(42)
      expect(result.data.login).toBe('octocat')
      expect(result.data.expiresAt).toBe(4070908800000)
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {operatorId: 1, login: 'x', expiresAt: 1000, extra: 'ignored'}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(true)
  })

  it('rejects string expiresAt (canonical type is number)', () => {
    const input = {operatorId: 42, login: 'octocat', expiresAt: '2099-01-01T00:00:00Z'}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      // Error message must be a fixed string — never echoes input
      expect(result.error.message).toBe('invalid operator session info shape')
    }
  })

  it('rejects missing operatorId', () => {
    const input = {login: 'octocat', expiresAt: 1000}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(false)
  })

  it('rejects null', () => {
    const result = parseOperatorSessionInfo(null)
    expect(result.success).toBe(false)
  })

  it('rejects array', () => {
    const result = parseOperatorSessionInfo([])
    expect(result.success).toBe(false)
  })

  it('rejects non-integer operatorId', () => {
    const input = {operatorId: 1.5, login: 'x', expiresAt: 1000}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(false)
  })

  it('rejects non-finite expiresAt (Infinity)', () => {
    const input = {operatorId: 1, login: 'x', expiresAt: Infinity}
    const result = parseOperatorSessionInfo(input)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseOperatorCsrfToken
// ---------------------------------------------------------------------------

describe('parseOperatorCsrfToken', () => {
  it('accepts {csrfToken} shape', () => {
    const input = {csrfToken: 'tok-abc123'}
    const result = parseOperatorCsrfToken(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.csrfToken).toBe('tok-abc123')
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {csrfToken: 'tok', extra: 'ignored', expiresAt: '2099-01-01'}
    const result = parseOperatorCsrfToken(input)
    expect(result.success).toBe(true)
  })

  it('rejects {token, expiresAt} shape (old DTO — canonical field is csrfToken)', () => {
    const input = {token: 'tok-abc123', expiresAt: '2099-01-01T00:00:00Z'}
    const result = parseOperatorCsrfToken(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid operator csrf token shape')
    }
  })

  it('rejects missing csrfToken', () => {
    const result = parseOperatorCsrfToken({})
    expect(result.success).toBe(false)
  })

  it('rejects null', () => {
    const result = parseOperatorCsrfToken(null)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseOperatorError
// ---------------------------------------------------------------------------

describe('parseOperatorError', () => {
  it('accepts {error} shape', () => {
    const input = {error: 'unauthorized'}
    const result = parseOperatorError(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.error).toBe('unauthorized')
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {error: 'bad_request', message: 'extra field ignored', code: 400}
    const result = parseOperatorError(input)
    expect(result.success).toBe(true)
  })

  it('rejects missing error field', () => {
    const result = parseOperatorError({message: 'something went wrong'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid operator error shape')
    }
  })

  it('rejects null', () => {
    const result = parseOperatorError(null)
    expect(result.success).toBe(false)
  })

  it('rejects non-string error field', () => {
    const result = parseOperatorError({error: 42})
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseOperatorOk
// ---------------------------------------------------------------------------

describe('parseOperatorOk', () => {
  it('accepts {ok: true} shape', () => {
    const input = {ok: true}
    const result = parseOperatorOk(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.ok).toBe(true)
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {ok: true, message: 'extra field ignored', code: 200}
    const result = parseOperatorOk(input)
    expect(result.success).toBe(true)
  })

  it('rejects {ok: false} (discriminant must be literal true)', () => {
    const result = parseOperatorOk({ok: false})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid operator ok shape')
    }
  })

  it('rejects {} (missing ok field)', () => {
    const result = parseOperatorOk({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid operator ok shape')
    }
  })

  it('rejects a non-object (string)', () => {
    const result = parseOperatorOk('ok')
    expect(result.success).toBe(false)
  })

  it('rejects null', () => {
    const result = parseOperatorOk(null)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseRepoSummary
// ---------------------------------------------------------------------------

describe('parseRepoSummary', () => {
  it('accepts {owner, repo} without channelName', () => {
    const input = {owner: 'fro-bot', repo: 'agent'}
    const result = parseRepoSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.owner).toBe('fro-bot')
      expect(result.data.repo).toBe('agent')
      expect(result.data.channelName).toBeUndefined()
    }
  })

  it('accepts {owner, repo, channelName} with channelName present', () => {
    const input = {owner: 'fro-bot', repo: 'agent', channelName: 'main'}
    const result = parseRepoSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.owner).toBe('fro-bot')
      expect(result.data.repo).toBe('agent')
      expect(result.data.channelName).toBe('main')
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {owner: 'fro-bot', repo: 'agent', extra: 'ignored', count: 42}
    const result = parseRepoSummary(input)
    expect(result.success).toBe(true)
  })

  it('rejects missing owner', () => {
    const result = parseRepoSummary({repo: 'agent'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects non-string owner', () => {
    const result = parseRepoSummary({owner: 42, repo: 'agent'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects missing repo', () => {
    const result = parseRepoSummary({owner: 'fro-bot'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects non-string repo', () => {
    const result = parseRepoSummary({owner: 'fro-bot', repo: true})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects non-string channelName when present', () => {
    const result = parseRepoSummary({owner: 'fro-bot', repo: 'agent', channelName: 99})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects null', () => {
    const result = parseRepoSummary(null)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary shape')
    }
  })

  it('rejects a non-object (string)', () => {
    const result = parseRepoSummary('fro-bot/agent')
    expect(result.success).toBe(false)
  })

  it('rejects an array', () => {
    const result = parseRepoSummary([{owner: 'fro-bot', repo: 'agent'}])
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RunSummary type-level checks (compile-time)
// ---------------------------------------------------------------------------

// RunSummary: must accept literals with and without updatedAt
const checkRunSummaryMinimal: RunSummaryType = {
  runId: 'run-abc-123',
  repo: 'fro-bot/agent',
  status: 'running',
  createdAt: '2026-06-01T00:00:00.000Z',
}
const checkRunSummaryWithUpdatedAt: RunSummaryType = {
  runId: 'run-abc-123',
  repo: 'fro-bot/agent',
  status: 'succeeded',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T01:00:00.000Z',
}
// RunSummary: must accept a failed summary with an optional failureKind
const checkRunSummaryWithFailureKind: RunSummaryType = {
  runId: 'run-abc-123',
  repo: 'fro-bot/agent',
  status: 'failed',
  createdAt: '2026-06-01T00:00:00.000Z',
  failureKind: 'workspace-unreachable',
}
export {checkRunSummaryMinimal, checkRunSummaryWithFailureKind, checkRunSummaryWithUpdatedAt}

// ---------------------------------------------------------------------------
// RunsListResponse type-level check (compile-time)
// ---------------------------------------------------------------------------

// RunsListResponse: must accept the envelope shape {runs: RunSummary[]}
const checkRunsListResponse: RunsListResponse = {
  runs: [checkRunSummaryMinimal],
}
export {checkRunsListResponse}

// ---------------------------------------------------------------------------
// parseRunsListResponse
// ---------------------------------------------------------------------------

describe('parseRunsListResponse', () => {
  it('accepts the envelope shape {runs: []}', () => {
    const result = parseRunsListResponse({runs: []})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runs).toEqual([])
    }
  })

  it('accepts the envelope shape with valid summaries', () => {
    const input = {
      runs: [
        {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'},
      ],
    }
    const result = parseRunsListResponse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runs).toHaveLength(1)
      expect(result.data.runs[0]?.runId).toBe('run-1')
    }
  })

  it('rejects a bare array (no envelope)', () => {
    const result = parseRunsListResponse([
      {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'},
    ])
    expect(result.success).toBe(false)
  })

  it('rejects a non-array runs field', () => {
    const result = parseRunsListResponse({runs: 'nope'})
    expect(result.success).toBe(false)
  })

  it('rejects a missing runs field', () => {
    const result = parseRunsListResponse({})
    expect(result.success).toBe(false)
  })

  it('rejects null', () => {
    const result = parseRunsListResponse(null)
    expect(result.success).toBe(false)
  })

  it('rejects a non-object (string)', () => {
    const result = parseRunsListResponse('not-a-response')
    expect(result.success).toBe(false)
  })

  it('skips invalid items within runs (per-item validation)', () => {
    const input = {
      runs: [
        {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'},
        {runId: 'run-2', repo: 'fro-bot/agent', status: 'blocked', createdAt: '2026-06-01T00:00:00.000Z'}, // invalid status
      ],
    }
    const result = parseRunsListResponse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runs).toHaveLength(1)
      expect(result.data.runs[0]?.runId).toBe('run-1')
    }
  })
})

// ---------------------------------------------------------------------------
// parseRepoSummaryList
// ---------------------------------------------------------------------------

describe('parseRepoSummaryList', () => {
  it('accepts an empty array', () => {
    const result = parseRepoSummaryList([])
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual([])
    }
  })

  it('accepts an array of valid items without channelName', () => {
    const input = [
      {owner: 'fro-bot', repo: 'agent'},
      {owner: 'fro-bot', repo: 'dashboard'},
    ]
    const result = parseRepoSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(2)
      expect(result.data[0]?.owner).toBe('fro-bot')
      expect(result.data[1]?.repo).toBe('dashboard')
    }
  })

  it('accepts an array of valid items with channelName', () => {
    const input = [
      {owner: 'fro-bot', repo: 'agent', channelName: 'main'},
      {owner: 'fro-bot', repo: 'dashboard'},
    ]
    const result = parseRepoSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data[0]?.channelName).toBe('main')
      expect(result.data[1]?.channelName).toBeUndefined()
    }
  })

  it('rejects a non-array input (object)', () => {
    const result = parseRepoSummaryList({owner: 'fro-bot', repo: 'agent'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary list: expected array')
    }
  })

  it('rejects a non-array input (null)', () => {
    const result = parseRepoSummaryList(null)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary list: expected array')
    }
  })

  it('rejects a non-array input (string)', () => {
    const result = parseRepoSummaryList('fro-bot/agent')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary list: expected array')
    }
  })

  it('fails the whole list if any item is invalid (fail closed)', () => {
    const input = [
      {owner: 'fro-bot', repo: 'agent'},
      {owner: 'fro-bot'}, // missing repo — invalid
    ]
    const result = parseRepoSummaryList(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid repo summary list: item failed validation')
    }
  })

  it('fails the whole list if the first item is invalid', () => {
    const input = [
      {repo: 'agent'}, // missing owner — invalid
      {owner: 'fro-bot', repo: 'dashboard'},
    ]
    const result = parseRepoSummaryList(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid repo summary list: item failed validation')
    }
  })

  it('fails the whole list if any item has a non-string channelName', () => {
    const input = [
      {owner: 'fro-bot', repo: 'agent', channelName: 0},
    ]
    const result = parseRepoSummaryList(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid repo summary list: item failed validation')
    }
  })
})

// ---------------------------------------------------------------------------
// parseRunSummary
// ---------------------------------------------------------------------------

describe('parseRunSummary', () => {
  it('accepts a minimal valid run summary (no updatedAt)', () => {
    const input = {
      runId: 'run-abc-123',
      repo: 'fro-bot/agent',
      status: 'running',
      createdAt: '2026-06-01T00:00:00.000Z',
    }
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.runId).toBe('run-abc-123')
      expect(result.data.repo).toBe('fro-bot/agent')
      expect(result.data.status).toBe('running')
      expect(result.data.createdAt).toBe('2026-06-01T00:00:00.000Z')
      expect(result.data.updatedAt).toBeUndefined()
    }
  })

  it('accepts a run summary with updatedAt present', () => {
    const input = {
      runId: 'run-abc-123',
      repo: 'fro-bot/agent',
      status: 'succeeded',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T01:00:00.000Z',
    }
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.updatedAt).toBe('2026-06-01T01:00:00.000Z')
    }
  })

  it('updatedAt is absent (key not present) when omitted from input', () => {
    const input = {
      runId: 'run-abc-123',
      repo: 'fro-bot/agent',
      status: 'queued',
      createdAt: '2026-06-01T00:00:00.000Z',
    }
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Object.prototype.hasOwnProperty.call(result.data, 'updatedAt')).toBe(false)
    }
  })

  it('accepts extra fields (permissive structural subtyping)', () => {
    const input = {
      runId: 'run-abc-123',
      repo: 'fro-bot/agent',
      status: 'failed',
      createdAt: '2026-06-01T00:00:00.000Z',
      extra: 'ignored',
      internalField: 42,
    }
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      // Extra fields must not be accessible through the typed result
      expect(Object.keys(result.data)).not.toContain('extra')
      expect(Object.keys(result.data)).not.toContain('internalField')
    }
  })

  it('accepts all five valid index statuses', () => {
    const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
    for (const status of statuses) {
      const input = {runId: 'run-1', repo: 'fro-bot/agent', status, createdAt: '2026-06-01T00:00:00.000Z'}
      const result = parseRunSummary(input)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.status).toBe(status)
      }
    }
  })

  it('rejects unknown status (fails closed)', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'unknown_status', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects stream-only status: waiting_for_approval', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'waiting_for_approval', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects stream-only status: blocked', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'blocked', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects missing runId', () => {
    const input = {repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects non-string runId', () => {
    const input = {runId: 42, repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects missing repo', () => {
    const input = {runId: 'run-1', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
  })

  it('rejects non-string repo', () => {
    const input = {runId: 'run-1', repo: 99, status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
  })

  it('rejects missing createdAt', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'running'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
  })

  it('rejects non-string createdAt', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: 1234567890}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
  })

  it('rejects non-string updatedAt when present', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: 9999}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects oversized runId without logging raw value', () => {
    const input = {runId: 'r'.repeat(513), repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      // Error message must be fixed — never echoes the oversized value
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects oversized repo without logging raw value', () => {
    const input = {runId: 'run-1', repo: 'x'.repeat(513), status: 'running', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects oversized createdAt without logging raw value', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2'.repeat(129)}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects oversized updatedAt without logging raw value', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2'.repeat(129)}
    const result = parseRunSummary(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary shape')
    }
  })

  it('rejects null', () => {
    const result = parseRunSummary(null)
    expect(result.success).toBe(false)
  })

  it('rejects an array', () => {
    const result = parseRunSummary([])
    expect(result.success).toBe(false)
  })

  it('rejects a non-object (string)', () => {
    const result = parseRunSummary('run-abc-123')
    expect(result.success).toBe(false)
  })

  // -------------------------------------------------------------------------
  // failureKind
  // -------------------------------------------------------------------------

  it('accepts a failed summary with each known failureKind', () => {
    const kinds = [
      'inactivity-timeout',
      'max-duration-timeout',
      'stream-ended',
      'workspace-unreachable',
      'session-error',
      'checkout-substituted',
      'workspace-unavailable',
      'unknown',
    ] as const
    for (const failureKind of kinds) {
      const input = {
        runId: 'run-1',
        repo: 'fro-bot/agent',
        status: 'failed',
        createdAt: '2026-06-01T00:00:00.000Z',
        failureKind,
      }
      const result = parseRunSummary(input)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.failureKind).toBe(failureKind)
      }
    }
  })

  it('failureKind is absent (key not present) when omitted from input', () => {
    const input = {runId: 'run-1', repo: 'fro-bot/agent', status: 'failed', createdAt: '2026-06-01T00:00:00.000Z'}
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Object.prototype.hasOwnProperty.call(result.data, 'failureKind')).toBe(false)
    }
  })

  it('normalizes an unknown failureKind value to absent — does not reject the summary', () => {
    const input = {
      runId: 'run-1',
      repo: 'fro-bot/agent',
      status: 'failed',
      createdAt: '2026-06-01T00:00:00.000Z',
      failureKind: 'some-future-fixture-reason',
    }
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.failureKind).toBeUndefined()
      expect(Object.prototype.hasOwnProperty.call(result.data, 'failureKind')).toBe(false)
    }
  })

  it('a non-failed status carrying a failureKind still parses, leaving failureKind unavailable to renderers is a downstream concern', () => {
    const input = {
      runId: 'run-1',
      repo: 'fro-bot/agent',
      status: 'running',
      createdAt: '2026-06-01T00:00:00.000Z',
      failureKind: 'inactivity-timeout',
    }
    const result = parseRunSummary(input)
    expect(result.success).toBe(true)
    if (result.success) {
      // Contract layer is permissive; it parses the field. Renderer-level
      // ignoring of non-failed reasons is a browser-module concern.
      expect(result.data.status).toBe('running')
    }
  })
})

// ---------------------------------------------------------------------------
// parseRunSummaryList
// ---------------------------------------------------------------------------

describe('parseRunSummaryList', () => {
  it('accepts an empty array', () => {
    const result = parseRunSummaryList([])
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual([])
    }
  })

  it('accepts an array of valid summaries', () => {
    const input = [
      {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'},
      {runId: 'run-2', repo: 'fro-bot/dashboard', status: 'succeeded', createdAt: '2026-06-02T00:00:00.000Z'},
    ]
    const result = parseRunSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(2)
      expect(result.data[0]?.runId).toBe('run-1')
      expect(result.data[1]?.status).toBe('succeeded')
    }
  })

  it('deduplicates by runId: keeps first valid entry, suppresses later duplicates', () => {
    const input = [
      {runId: 'run-dup', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'},
      {runId: 'run-dup', repo: 'fro-bot/agent', status: 'succeeded', createdAt: '2026-06-01T01:00:00.000Z'},
      {runId: 'run-other', repo: 'fro-bot/agent', status: 'queued', createdAt: '2026-06-01T02:00:00.000Z'},
    ]
    const result = parseRunSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(2)
      // First entry for run-dup is kept (status: running)
      expect(result.data[0]?.runId).toBe('run-dup')
      expect(result.data[0]?.status).toBe('running')
      expect(result.data[1]?.runId).toBe('run-other')
    }
  })

  it('skips invalid items (per-item validation, not whole-list fail)', () => {
    const input = [
      {runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'},
      {runId: 'run-2', repo: 'fro-bot/agent', status: 'blocked', createdAt: '2026-06-01T00:00:00.000Z'}, // invalid status
      {runId: 'run-3', repo: 'fro-bot/agent', status: 'succeeded', createdAt: '2026-06-01T00:00:00.000Z'},
    ]
    const result = parseRunSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      // Invalid item is skipped, valid ones are kept
      expect(result.data).toHaveLength(2)
      expect(result.data[0]?.runId).toBe('run-1')
      expect(result.data[1]?.runId).toBe('run-3')
    }
  })

  it('rejects a non-array input (object)', () => {
    const result = parseRunSummaryList({runId: 'run-1', repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-01T00:00:00.000Z'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid run summary list: expected array')
    }
  })

  it('rejects a non-array input (null)', () => {
    const result = parseRunSummaryList(null)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary list: expected array')
    }
  })

  it('rejects a non-array input (string)', () => {
    const result = parseRunSummaryList('run-1')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid run summary list: expected array')
    }
  })

  it('returns empty array when all items are invalid', () => {
    const input = [
      {runId: 'run-1', repo: 'fro-bot/agent', status: 'blocked', createdAt: '2026-06-01T00:00:00.000Z'},
      {runId: 'run-2', repo: 'fro-bot/agent', status: 'waiting_for_approval', createdAt: '2026-06-01T00:00:00.000Z'},
    ]
    const result = parseRunSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(0)
    }
  })

  it('caps output at RUN_INDEX_CAP (100) valid unique summaries even when input has more', () => {
    // 110 unique valid items — only the first 100 should be returned
    const input = Array.from({length: 110}, (_, i) => ({
      runId: `run-${i}`,
      repo: 'fro-bot/agent',
      status: 'running',
      createdAt: '2026-06-01T00:00:00.000Z',
    }))
    const result = parseRunSummaryList(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(100)
      expect(result.data[0]?.runId).toBe('run-0')
      expect(result.data[99]?.runId).toBe('run-99')
    }
  })

  it('RUN_INDEX_CAP matches browser JS constant (parity)', () => {
    expect(RUN_INDEX_CAP).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// parseOperatorCancelResponse
// ---------------------------------------------------------------------------

describe('parseOperatorCancelResponse', () => {
  it('accepts {ok: true, runId, phase: CANCELLED}', () => {
    const input = {ok: true, runId: 'run-1', phase: 'CANCELLED'}
    const result = parseOperatorCancelResponse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.ok).toBe(true)
      expect(result.data.runId).toBe('run-1')
      expect(result.data.phase).toBe('CANCELLED')
    }
  })

  it('accepts phase: COMPLETED (idempotent no-op cancel of an already-terminal run)', () => {
    const input = {ok: true, runId: 'run-1', phase: 'COMPLETED'}
    const result = parseOperatorCancelResponse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.phase).toBe('COMPLETED')
    }
  })

  it('accepts phase: FAILED (idempotent no-op cancel of an already-terminal run)', () => {
    const input = {ok: true, runId: 'run-1', phase: 'FAILED'}
    const result = parseOperatorCancelResponse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.phase).toBe('FAILED')
    }
  })

  it('rejects missing ok', () => {
    const result = parseOperatorCancelResponse({runId: 'run-1', phase: 'CANCELLED'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe('invalid operator cancel response shape')
    }
  })

  it('rejects ok: false', () => {
    const result = parseOperatorCancelResponse({ok: false, runId: 'run-1', phase: 'CANCELLED'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid operator cancel response shape')
    }
  })

  it('rejects non-string runId', () => {
    const result = parseOperatorCancelResponse({ok: true, runId: 42, phase: 'CANCELLED'})
    expect(result.success).toBe(false)
  })

  it('rejects phase not in the UPPERCASE terminal set: EXECUTING', () => {
    const result = parseOperatorCancelResponse({ok: true, runId: 'run-1', phase: 'EXECUTING'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid operator cancel response shape')
    }
  })

  it('rejects lowercase phase: cancelled', () => {
    const result = parseOperatorCancelResponse({ok: true, runId: 'run-1', phase: 'cancelled'})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid operator cancel response shape')
    }
  })

  it('rejects null', () => {
    const result = parseOperatorCancelResponse(null)
    expect(result.success).toBe(false)
    if (!result.success) {
      // Fixed error string — never echoes the input value
      expect(result.error.message).toBe('invalid operator cancel response shape')
    }
  })

  it('rejects an array', () => {
    const result = parseOperatorCancelResponse([{ok: true, runId: 'run-1', phase: 'CANCELLED'}])
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toBe('invalid operator cancel response shape')
    }
  })
})

// ---------------------------------------------------------------------------
// TerminalPhase / PHASE_TO_WEB_STATUS
// ---------------------------------------------------------------------------

describe('TerminalPhase and PHASE_TO_WEB_STATUS', () => {
  it('OperatorCancelResponse.phase accepts each TerminalPhase value', () => {
    const checkCompleted: OperatorCancelResponse = {ok: true, runId: 'run-1', phase: 'COMPLETED'}
    const checkFailed: OperatorCancelResponse = {ok: true, runId: 'run-1', phase: 'FAILED'}
    const checkCancelled: OperatorCancelResponse = {ok: true, runId: 'run-1', phase: 'CANCELLED'}
    expect(checkCompleted.phase).toBe('COMPLETED')
    expect(checkFailed.phase).toBe('FAILED')
    expect(checkCancelled.phase).toBe('CANCELLED')
  })

  it('maps every TerminalPhase to its documented OperatorWebStatus', () => {
    const terminalPhases: TerminalPhase[] = ['COMPLETED', 'FAILED', 'CANCELLED']
    const expected: Record<TerminalPhase, OperatorWebStatus> = {
      COMPLETED: 'succeeded',
      FAILED: 'failed',
      CANCELLED: 'cancelled',
    }
    for (const phase of terminalPhases) {
      expect(PHASE_TO_WEB_STATUS[phase]).toBe(expected[phase])
    }
  })

  it('covers all six RunPhase keys', () => {
    const allPhases: RunPhase[] = ['PENDING', 'ACKNOWLEDGED', 'EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED']
    expect(Object.keys(PHASE_TO_WEB_STATUS)).toHaveLength(6)
    for (const phase of allPhases) {
      expect(PHASE_TO_WEB_STATUS[phase]).toBeDefined()
    }
  })
})
