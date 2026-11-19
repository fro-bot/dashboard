import {describe, expect, it} from 'vitest'
import {verifyReleaseChecks, type CheckEvidence} from '../scripts/release/checks.ts'

const rule = (type: string, parameters: unknown) => ({type, parameters})
const run = (name = 'CI', id = 17, conclusion = 'success', headSha = 'merge') =>
  ({id: 1, name, head_sha: headSha, app: {id}, status: 'completed', conclusion})

function evidence(): CheckEvidence {
  return {
    candidate: {verified: true, head: 'head', base: 'base', generatedAppPr: true},
    merge: {verified: true, sha: 'merge', parents: ['base', 'head']},
    realCi: {verified: true, checks: [{name: 'CI', integrationId: 17}]},
    effectiveRules: {complete: true, noBypass: true, rules: [
      rule('pull_request', {allowed_merge_methods: ['squash']}),
      rule('required_status_checks', {strict_required_status_checks_policy: true, required_status_checks: [
        {context: 'CI', integration_id: 17}, {context: 'Fro Bot', integration_id: 18},
      ]}),
      rule('code_scanning', {code_scanning_tools: [{tool: 'CodeQL', alerts_threshold: 'none', security_alerts_threshold: 'high_or_higher'}]}),
    ]},
    head: {complete: true, checks: [], statuses: []},
    testMerge: {complete: true, checks: [run(), run('Fro Bot', 18, 'skipped')], statuses: []},
  }
}

describe('release check evidence', () => {
  it.each([
    ['missing', (e: CheckEvidence) => { e.testMerge.checks.pop() }],
    ['queued', (e: CheckEvidence) => { e.testMerge.checks[1] = {...run('Fro Bot', 18), status: 'queued', conclusion: null} }],
    ['failed', (e: CheckEvidence) => { e.testMerge.checks[1] = run('Fro Bot', 18, 'failure') }],
  ])('recognizes complete provenance with %s required check as a wait', (_name, change) => {
    const e = evidence()
    change(e)
    expect(verifyReleaseChecks(e)).toMatchObject({verified: true, ready: false})
  })

  it('does not let a missing check conceal a wrong provider', () => {
    const e = evidence()
    e.testMerge.checks = [run('Fro Bot', 99)]
    expect(verifyReleaseChecks(e)).toMatchObject({verified: false, ready: false})
  })
  it('accepts provider-bound CI and the intentional generated-PR skip', () => {
    expect(verifyReleaseChecks(evidence())).toEqual({verified: true, ready: true, head: 'head', base: 'base', applicableRevision: 'merge', checks: [
      {name: 'CI', revision: 'merge', disposition: 'pass'},
      {name: 'Fro Bot', revision: 'merge', disposition: 'accepted-skip'},
    ]})
  })

  it('falls back to head only after complete empty merge reads', () => {
    const e = evidence()
    e.testMerge.checks = []
    e.head.checks = [run('CI', 17, 'success', 'head'), run('Fro Bot', 18, 'success', 'head')]
    expect(verifyReleaseChecks(e)).toMatchObject({ready: true, applicableRevision: 'head'})
  })

  it.each([
    ['unverified candidate', (e: CheckEvidence) => { e.candidate.verified = false }],
    ['unverified merge', (e: CheckEvidence) => { e.merge.verified = false }],
    ['wrong merge parents', (e: CheckEvidence) => { e.merge.parents = ['head', 'base'] }],
    ['incomplete rules', (e: CheckEvidence) => { e.effectiveRules.complete = false }],
    ['bypass not excluded', (e: CheckEvidence) => { e.effectiveRules.noBypass = false }],
    ['incomplete head', (e: CheckEvidence) => { e.head.complete = false }],
    ['incomplete merge', (e: CheckEvidence) => { e.testMerge.complete = false }],
    ['missing CodeQL', (e: CheckEvidence) => { e.effectiveRules.rules.pop() }],
    ['wrong provider', (e: CheckEvidence) => { e.testMerge.checks[0] = run('CI', 99) }],
    ['wrong SHA', (e: CheckEvidence) => { e.testMerge.checks[0] = run('CI', 17, 'success', 'head') }],
    ['failing newer run', (e: CheckEvidence) => { e.testMerge.checks.push({...run(), id: 2, status: 'queued', conclusion: null}) }],
    ['neutral CI', (e: CheckEvidence) => { e.testMerge.checks[0] = run('CI', 17, 'neutral') }],
    ['unverified skip', (e: CheckEvidence) => { e.candidate.generatedAppPr = false }],
    ['no real CI', (e: CheckEvidence) => { e.testMerge.checks[0] = run('CI', 17, 'skipped') }],
    ['unverified CI identity', (e: CheckEvidence) => { e.realCi.verified = false }],
    ['conflicting status', (e: CheckEvidence) => { e.testMerge.statuses.push({context: 'CI', state: 'failure'}) }],
    ['malformed check', (e: CheckEvidence) => { e.testMerge.checks.push(null) }],
  ])('fails closed for %s', (_label, change) => {
    const e = evidence()
    change(e)
    expect(verifyReleaseChecks(e)?.ready).not.toBe(true)
  })

  it('uses merge revision when it has even an unrelated status', () => {
    const e = evidence()
    e.testMerge.checks = []
    e.testMerge.statuses = [{context: 'other', state: 'success'}]
    e.head.checks = [run('CI', 17, 'success', 'head')]
    expect(verifyReleaseChecks(e)).toMatchObject({ready: false, applicableRevision: 'merge'})
  })

  it.each([undefined, 'none'])('rejects missing or disabled CodeQL security threshold: %s', threshold => {
    const e = evidence()
    e.effectiveRules.rules[2] = rule('code_scanning', {code_scanning_tools: [
      {tool: 'CodeQL', alerts_threshold: 'none', security_alerts_threshold: threshold},
    ]})
    expect(verifyReleaseChecks(e)?.ready).not.toBe(true)
  })
})
