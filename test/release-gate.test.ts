import type {GateInput, MergeFacts} from '../scripts/release/gate.ts'

import {describe, expect, it} from 'vitest'
import {decideRelease, proveSquash, recheckRelease} from '../scripts/release/gate.ts'

const candidate = {
  repo: 'fro-bot/dashboard', pr: 42, headRepo: 'fro-bot/dashboard', headBranch: 'release/pending',
  baseBranch: 'main', state: 'open' as const, head: 'head', base: 'base', parents: ['base'],
  tree: 'tree', expectedTree: 'tree', currentBase: 'base',
}
const run = {repo: 'fro-bot/dashboard', workflow: 'held-release', revision: 'trusted', runId: 100, attempt: 1, verified: true}
const review = {id: 1, userId: 7, state: 'approved' as const, head: 'head', submittedAt: '2026-11-18T10:00:00Z'}
const base: GateInput = {
  expected: {repo: 'fro-bot/dashboard', pr: 42, branch: 'release/pending', baseBranch: 'main', ownerId: 7, workflow: 'held-release', trustedRevision: 'trusted'},
  activeSince: '2026-11-18T00:00:00Z', priorAttempt: 'resolved', candidate, run,
  checks: {verified: true, ready: true, head: 'head', base: 'base', applicableRevision: 'merge', checks: [{name: 'CI', revision: 'merge', disposition: 'pass'}]},
  trigger: {kind: 'review', reviewsVerified: true, reviews: [review]},
}
const schedule: GateInput = {
  ...base,
  trigger: {kind: 'schedule', cron: '0 15 * * 3', originalRunAt: '2026-11-18T15:00:00Z', now: '2026-11-18T16:00:00Z', slotUsed: false,
    hold: {state: 'clear', source: 'owner', ownerId: 7, pr: 42, verified: true}},
}
const authorized = (input: GateInput = base) => {
  const result = decideRelease(input)
  if (result.kind !== 'authorize') throw new Error(`Expected authorization: ${result.reason}`)
  return result.authorization
}
const merge: MergeFacts = {verified: true, repo: 'fro-bot/dashboard', pr: 42, merged: true, actorAppId: 99, head: 'head', base: 'base', squashSha: 'squash', commit: {verified: true, sha: 'squash', parents: ['base'], tree: 'tree', authorizationArtifactId: 101}, association: {verified: true, sha: 'squash', prs: [42]}}
const origin = {...run, artifactId: 101}

describe('release gate', () => {
  it('rejects an owner dispatch without a verified exact base ref', () => {
    const trigger = {kind: 'dispatch' as const, actorId: 7, reviewsVerified: true, reviews: [review], ref: 'refs/heads/other', refVerified: true}
    expect(decideRelease({...base, trigger}).kind).toBe('skip')
    expect(decideRelease({...base, trigger: {...trigger, ref: '', refVerified: false}}).kind).toBe('skip')
    expect(decideRelease({...base, trigger: {...trigger, ref: null}}).kind).toBe('skip')
    expect(decideRelease({...base, trigger: {...trigger, ref: 'refs/heads/main', refVerified: false}}).kind).toBe('skip')
    expect(decideRelease({...base, trigger: {...trigger, ref: 'refs/heads/main'}}).kind).toBe('authorize')
  })
  it('rejects independently fetched commit or association at a different SHA', () => {
    const evidence = {origin, authorization: authorized()}
    const facts = {...merge, commit: {verified: true, sha: 'other', parents: ['base'], tree: 'tree', authorizationArtifactId: 101}, association: {verified: true, sha: 'squash', prs: [42]}}
    const trusted = {repo: run.repo, workflow: run.workflow, revision: run.revision, appId: 99}
    expect(proveSquash(evidence, facts, trusted)).toBeNull()
    expect(proveSquash(evidence, {...facts, commit: {...facts.commit, sha: 'squash'}, association: {...facts.association, sha: 'other'}}, trusted)).toBeNull()
    expect(proveSquash(evidence, {...facts, commit: {...facts.commit, sha: 'squash', verified: false}}, trusted)).toBeNull()
    expect(proveSquash(evidence, {...facts, commit: {...facts.commit, sha: 'squash'}, association: {...facts.association, verified: false}}, trusted)).toBeNull()
  })
  it('rejects artifact origin metadata mismatched to its payload in recheck and proof', () => {
    const evidence = {origin: {...origin, attempt: 2}, authorization: authorized()}
    expect(recheckRelease(base, evidence)).toBe(false)
    expect(proveSquash(evidence, merge, {repo: run.repo, workflow: run.workflow, revision: run.revision, appId: 99})).toBeNull()
    for (const change of [{repo: 'other'}, {workflow: 'other'}, {revision: 'other'}, {runId: 101}, {verified: false}]) {
      const mismatch = {...evidence, origin: {...origin, ...change}}
      expect(recheckRelease(base, mismatch)).toBe(false)
      expect(proveSquash(mismatch, merge, {repo: run.repo, workflow: run.workflow, revision: run.revision, appId: 99})).toBeNull()
    }
  })
  it('accepts substantiated normalized skips only when real CI ran', () => {
    const checks = {verified: true, ready: true, head: 'head', base: 'base', applicableRevision: 'merge', checks: [
      {name: 'CI', revision: 'merge', disposition: 'pass'},
      {name: 'Fro Bot', revision: 'merge', disposition: 'accepted-skip'},
    ]} as const
    const input = {...base, checks: {...checks, checks: [...checks.checks]}} as unknown as GateInput
    expect(decideRelease(input).kind).toBe('authorize')
    expect(decideRelease({...base, checks: {...checks, checks: [checks.checks[0], {...checks.checks[1], disposition: 'accepted-neutral'}]}}).kind).toBe('authorize')
    for (const changed of [{...checks, ready: false}, {...checks, verified: false}, {...checks, head: 'old'}, {...checks, checks: [...checks.checks, {name: 'x', revision: 'merge', disposition: 'nonpassing'}]}, {...checks, checks: [...checks.checks, {name: 'x', revision: 'merge', disposition: 'skip'}]}]) {
      expect(decideRelease({...base, checks: changed} as unknown as GateInput).kind).toBe('skip')
    }
  })
  it('binds merge proof to the referenced authorization artifact', () => {
    const first = {origin, authorization: authorized()}
    const second = {origin: {...origin, artifactId: 102, attempt: 2}, authorization: {...authorized(), run: {...authorized().run, attempt: 2}}}
    const facts = merge
    const trusted = {repo: run.repo, workflow: run.workflow, revision: run.revision, appId: 99}
    expect(proveSquash(second, facts, trusted)).toBeNull()
    expect(proveSquash(first, facts, trusted)).toBe('squash')
    if (!facts.commit) throw new Error('fixture')
    expect(proveSquash({...first, origin: {...origin, artifactId: 0}}, {...facts, commit: {...facts.commit, authorizationArtifactId: 0}}, trusted)).toBeNull()
    expect(proveSquash(first, {...facts, commit: {...facts.commit, authorizationArtifactId: null}}, trusted)).toBeNull()
  })
  it('binds separate cron entries to weekday and activation at original run time', () => {
    const trigger = schedule.trigger
    if (trigger.kind !== 'schedule') throw new Error('fixture')
    const wednesday = {...trigger, cron: '0 15 * * 3'}
    expect(decideRelease({...schedule, trigger: wednesday}).kind).toBe('authorize')
    expect(decideRelease({...schedule, trigger: {...wednesday, cron: '0 15 * * 0'}}).kind).toBe('skip')
    expect(decideRelease({...schedule, activeSince: '2026-11-18T15:01:00Z', trigger: wednesday}).kind).toBe('skip')
    expect(decideRelease({...schedule, activeSince: '2026-11-18T15:00:00Z', trigger: wednesday}).kind).toBe('authorize')
    expect(decideRelease({...schedule, activeSince: '2026-11-15T00:00:00Z', trigger: {...wednesday, cron: '0 15 * * 0', originalRunAt: '2026-11-15T15:00:00Z', now: '2026-11-15T16:00:00Z'}}).kind).toBe('authorize')
  })
  it('carries the same owner clearance through consecutive verified predecessors', () => {
    const trigger = schedule.trigger
    if (trigger.kind !== 'schedule') throw new Error('fixture')
    const hold = {state: 'clear', source: 'carry', ownerId: 7, pr: 42, verified: true, clearancePr: 40, carriedFromPr: 41, carryVerified: true} as const
    const input = {...schedule, expected: {...schedule.expected, mostRecentGeneratedPr: 41}, trigger: {...trigger, hold}}
    expect(decideRelease(input).kind).toBe('authorize')
    expect(decideRelease({...input, trigger: {...trigger, hold: {...hold, carriedFromPr: 39}}}).kind).toBe('skip')
    expect(decideRelease({...input, trigger: {...trigger, hold: {...hold, carryVerified: false}}}).kind).toBe('skip')
    expect(decideRelease({...input, trigger: {...trigger, hold: {...hold, state: 'unknown'}}}).kind).toBe('skip')
    const next = {...input, expected: {...input.expected, pr: 43, mostRecentGeneratedPr: 42}, candidate: {...candidate, pr: 43}, trigger: {...trigger, hold: {...hold, pr: 43, carriedFromPr: 42}}}
    expect(decideRelease(next).kind).toBe('authorize')
  })
  it('authorizes the current review and binds the entire candidate and run', () => {
    expect(authorized()).toEqual({repo: 'fro-bot/dashboard', pr: 42, head: 'head', base: 'base', tree: 'tree', run: {repo: run.repo, workflow: run.workflow, revision: run.revision, runId: 100, attempt: 1}, authority: {kind: 'review', reviewId: 1, userId: 7}})
  })
  it('allows only owner dispatch to recheck an existing current approval', () => {
    expect(decideRelease({...base, trigger: {kind: 'dispatch', actorId: 7, ref: 'refs/heads/main', refVerified: true, reviewsVerified: true, reviews: [review]}}).kind).toBe('authorize')
    expect(decideRelease({...base, trigger: {kind: 'dispatch', actorId: 8, ref: 'refs/heads/main', refVerified: true, reviewsVerified: true, reviews: [review]}}).kind).toBe('skip')
    expect(decideRelease({...base, trigger: {kind: 'dispatch', actorId: 7, ref: 'refs/heads/main', refVerified: true, reviewsVerified: true, reviews: []}}).kind).toBe('skip')
  })
  it('ignores comments and pending reviews but rejects later decisive or dismissed reviews', () => {
    for (const state of ['commented', 'pending'] as const) expect(decideRelease({...base, trigger: {kind: 'review', reviewsVerified: true, reviews: [review, {...review, id: 2, state}]}}).kind).toBe('authorize')
    for (const state of ['changes_requested', 'dismissed'] as const) expect(decideRelease({...base, trigger: {kind: 'review', reviewsVerified: true, reviews: [review, {...review, id: 2, state}]}}).kind).toBe('skip')
    expect(decideRelease({...base, trigger: {kind: 'review', reviewsVerified: false, reviews: [review]}}).kind).toBe('skip')
  })
  it('rejects old approval and stale or unrelated candidates, including docs-only base advances', () => {
    const candidates = [null, {...candidate, currentBase: 'docs-only'}, {...candidate, headRepo: 'fork'}, {...candidate, pr: 43}, {...candidate, pr: 0}, {...candidate, state: 'closed' as const}, {...candidate, parents: ['base', 'other']}, {...candidate, tree: 'changed'}]
    for (const value of candidates) expect(decideRelease({...base, candidate: value}).kind).toBe('skip')
    expect(decideRelease({...base, trigger: {kind: 'review', reviewsVerified: true, reviews: [{...review, submittedAt: '2026-11-17T00:00:00Z'}]}}).kind).toBe('skip')
  })
  it('rejects missing, stale, failed or unverified applicable checks', () => {
    const checks = base.checks
    if (!checks) throw new Error('fixture')
    for (const observation of [null, {...checks, checks: []}, {...checks, base: 'old'}, {...checks, verified: false}, {...checks, checks: [{name: 'CI', revision: 'old', disposition: 'pass' as const}]}]) {
      expect(decideRelease({...base, checks: observation}).kind).toBe('skip')
    }
  })
  it('does not authorize pushes, inactive controllers, untrusted runs or unresolved attempts', () => {
    expect(decideRelease({...base, trigger: {kind: 'push'}}).kind).toBe('skip')
    expect(decideRelease({...base, activeSince: null}).kind).toBe('skip')
    expect(decideRelease({...base, priorAttempt: 'unresolved'}).kind).toBe('skip')
    expect(decideRelease({...base, run: {...run, verified: false}}).kind).toBe('skip')
  })
  it('authorizes only the identified unused slot on its original UTC day', () => {
    expect(authorized(schedule).authority).toEqual({kind: 'schedule', slot: '2026-11-18/0 15 * * 3'})
    const trigger = schedule.trigger
    if (trigger.kind !== 'schedule') throw new Error('fixture')
    for (const change of [{slotUsed: true}, {now: '2026-11-19T00:00:00Z'}, {now: '2026-11-18T14:59:00Z'}, {originalRunAt: '2026-11-19T15:00:00Z'}, {cron: 'unknown'}]) {
      expect(decideRelease({...schedule, trigger: {...trigger, ...change}}).kind).toBe('skip')
    }
  })
  it('requires an authenticated owner clearance; a carried hold blocks schedule but not approval', () => {
    const trigger = schedule.trigger
    if (trigger.kind !== 'schedule') throw new Error('fixture')
    for (const hold of [{state: 'held', source: 'carry', pr: 41, verified: true}, {state: 'clear', source: 'carry', pr: 41, verified: true}, {state: 'clear', source: 'owner', ownerId: 8, pr: 42, verified: true}, {state: 'clear', source: 'owner', ownerId: 7, pr: 42, verified: false}] as const) {
      expect(decideRelease({...schedule, trigger: {...trigger, hold}}).kind).toBe('skip')
    }
    expect(decideRelease(base).kind).toBe('authorize')
    const inherited = {state: 'clear', source: 'carry', ownerId: 7, pr: 42, verified: true, clearancePr: 41, carriedFromPr: 41, carryVerified: true} as const
    expect(decideRelease({...schedule, expected: {...schedule.expected, mostRecentGeneratedPr: 41}, trigger: {...trigger, hold: inherited}}).kind).toBe('authorize')
    expect(decideRelease({...schedule, expected: {...schedule.expected, mostRecentGeneratedPr: 41}, trigger: {...trigger, hold: {...inherited, carryVerified: false}}}).kind).toBe('skip')
    expect(decideRelease({...schedule, expected: {...schedule.expected, mostRecentGeneratedPr: 41}, trigger: {...trigger, hold: {...inherited, pr: 41}}}).kind).toBe('skip')
  })
  it('rechecks the exact recorded decision immediately before merge', () => {
    const record = {origin, authorization: authorized(schedule)}
    expect(recheckRelease(schedule, record)).toBe(true)
    const trigger = schedule.trigger
    if (trigger.kind !== 'schedule') throw new Error('fixture')
    expect(recheckRelease({...schedule, trigger: {...trigger, hold: {state: 'held', source: 'owner', ownerId: 7, pr: 42, verified: true}}}, record)).toBe(false)
    expect(recheckRelease({...schedule, candidate: {...candidate, currentBase: 'new'}}, record)).toBe(false)
    expect(recheckRelease(base, record)).toBe(false)
    expect(recheckRelease(schedule, {...record, origin: {...origin, verified: false}})).toBe(false)
  })
  it('proves only a matching independently fetched squash and verified record', () => {
    const record = authorized()
    const evidence = {origin, authorization: record}
    expect(proveSquash(evidence, merge, {repo: run.repo, workflow: run.workflow, revision: run.revision, appId: 99})).toBe('squash')
    if (!merge.commit || !merge.association) throw new Error('fixture')
    for (const change of [{pr: 43}, {actorAppId: 100}, {head: 'wrong'}, {base: 'wrong'}, {commit: {...merge.commit, parents: ['wrong']}}, {commit: {...merge.commit, tree: 'wrong'}}, {association: {...merge.association, prs: [43]}}, {verified: false}, {merged: false}, {squashSha: ''}, {commit: null}, {association: null}]) {
      expect(proveSquash(evidence, {...merge, ...change}, {repo: run.repo, workflow: run.workflow, revision: run.revision, appId: 99})).toBeNull()
    }
    expect(proveSquash({...evidence, origin: {...origin, verified: false}}, merge, {repo: run.repo, workflow: run.workflow, revision: run.revision, appId: 99})).toBeNull()
  })
})
