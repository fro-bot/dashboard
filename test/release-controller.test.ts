import {describe, expect, it, vi} from 'vitest'
import {finish, inspect, type ControllerPorts, type Observation} from '../scripts/release/controller.ts'
import {decideRelease, type GateInput, type MergeFacts} from '../scripts/release/gate.ts'

const gate = (): GateInput => ({
  expected: {repo: 'o/r', pr: 1, branch: 'release', baseBranch: 'main', ownerId: 7, workflow: 'release', trustedRevision: 'rev'},
  activeSince: '2026-11-01T00:00:00Z', priorAttempt: 'resolved',
  candidate: {repo: 'o/r', pr: 1, headRepo: 'o/r', headBranch: 'release', baseBranch: 'main', state: 'open', head: 'head', base: 'base', currentBase: 'base', parents: ['base'], tree: 'tree', expectedTree: 'tree'},
  run: {repo: 'o/r', workflow: 'release', revision: 'rev', runId: 10, attempt: 1, verified: true},
  checks: {verified: true, ready: true, head: 'head', base: 'base', applicableRevision: 'rev', checks: [{name: 'CI', revision: 'rev', disposition: 'pass'}]},
  trigger: {kind: 'review', reviewsVerified: true, reviews: [{id: 3, userId: 7, state: 'approved', head: 'head', submittedAt: '2026-11-02T00:00:00Z'}]},
})
const observation = (): Observation => {
  const g = gate()
  return {mode: 'active', activation: g.activeSince, trusted: {repo: 'o/r', workflow: 'release', revision: 'rev', appId: 9}, run: g.run, trigger: g.trigger, ownerId: 7, baseBranch: 'main', predecessor: 'verified', prior: {state: 'clear'}, candidate: {state: 'ready', gate: g}}
}
function setup() {
  let current = observation()
  const decision = decideRelease(gate())
  if (decision.kind !== 'authorize') throw new Error('fixture invalid')
  const record = {origin: {...gate().run, artifactId: 11}, authorization: decision.authorization}
  const facts: MergeFacts = {verified: true, repo: 'o/r', pr: 1, merged: true, actorAppId: 9, head: 'head', base: 'base', squashSha: 'squash', commit: {verified: true, sha: 'squash', parents: ['base'], tree: 'tree', authorizationArtifactId: 11}, association: {verified: true, sha: 'squash', prs: [1]}}
  const ports: ControllerPorts = {observe: vi.fn(async () => structuredClone(current)), prepare: vi.fn(async () => {}), authorization: vi.fn(async () => record), recoveryRevision: vi.fn(async () => true), merge: vi.fn(async () => {}), mergeFacts: vi.fn(async () => facts)}
  return {ports, record, facts, set: (value: Observation) => {
    current = value
  }}
}

describe('release controller', () => {
  it('authorizes only a ready live decision', async () => {
    const {ports, record} = setup()
    expect(await inspect(ports)).toEqual({kind: 'authorize', authorization: record.authorization})
    expect(ports.merge).not.toHaveBeenCalled()
  })
  it('proves a squash rather than trusting merge response', async () => {
    const {ports} = setup()
    expect(await finish(ports, 11)).toEqual({kind: 'source', source: 'squash', recovery: false})
    expect(ports.merge).toHaveBeenCalledExactlyOnceWith('head', 11)
  })
  it.each(['disabled', 'prepare'] as const)('%s cannot fetch authorization or merge', async mode => {
    const {ports, set} = setup()
    set({...observation(), mode, candidate: {state: 'absent'}})
    await inspect(ports)
    await finish(ports, 11)
    expect(ports.authorization).not.toHaveBeenCalled()
    expect(ports.merge).not.toHaveBeenCalled()
    expect(ports.prepare).toHaveBeenCalledTimes(mode === 'prepare' ? 1 : 0)
  })
  it('push cannot authorize even with a ready candidate', async () => {
    const {ports, set} = setup()
    set({...observation(), trigger: {kind: 'push'}})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'trigger'})
    expect(await finish(ports, 11)).toEqual({kind: 'skip', reason: 'recheck-failed'})
    expect(ports.merge).not.toHaveBeenCalled()
  })
  it.each(['blocked', 'unknown'] as const)('candidate %s blocks authorization', async state => {
    const {ports, set} = setup()
    set({...observation(), candidate: {state}})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'candidate'})
    expect(ports.merge).not.toHaveBeenCalled()
  })
  it('refreshes stale candidate without authorizing', async () => {
    const {ports, set} = setup()
    set({...observation(), candidate: {state: 'stale'}})
    expect(await inspect(ports)).toEqual({kind: 'prepared'})
    expect(ports.prepare).toHaveBeenCalledExactlyOnceWith('stale')
    expect(ports.authorization).not.toHaveBeenCalled()
  })
  it('fails closed on unknown baseline or prior and foreign candidate', async () => {
    const {ports, set} = setup()
    set({...observation(), predecessor: 'unknown', candidate: {state: 'absent'}})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'predecessor'})
    set({...observation(), prior: {state: 'unknown'}, candidate: {state: 'absent'}})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'prior-unknown'})
    const g = gate()
    if (!g.candidate) throw new Error('fixture invalid')
    g.candidate.headRepo = 'foreign/repo'
    set({...observation(), candidate: {state: 'ready', gate: g}})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'candidate'})
    expect(ports.prepare).not.toHaveBeenCalled()
  })
  it.each([{actorId: 8, ref: 'refs/heads/main'}, {actorId: 7, ref: 'refs/heads/other'}])('rejects invalid dispatch before writes', async dispatch => {
    const {ports, set} = setup()
    set({...observation(), candidate: {state: 'absent'}, trigger: {kind: 'dispatch', ...dispatch, refVerified: true, reviewsVerified: true, reviews: []}})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'trigger'})
    expect(ports.prepare).not.toHaveBeenCalled()
  })
  it('rejects pre-activation review and rechecks revocation', async () => {
    const {ports, set} = setup()
    set({...observation(), activation: '2026-11-03T00:00:00Z'})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'review'})
    expect(await finish(ports, 11)).toEqual({kind: 'skip', reason: 'recheck-failed'})
    expect(ports.merge).not.toHaveBeenCalled()
  })
  it('authorizes an eligible schedule but rejects a live hold on finish', async () => {
    const {ports, set, record} = setup()
    const trigger: GateInput['trigger'] = {kind: 'schedule', cron: '0 15 * * 0', originalRunAt: '2026-11-08T15:00:00Z', now: '2026-11-08T16:00:00Z', slotUsed: false, hold: {state: 'clear', source: 'owner', ownerId: 7, pr: 1, verified: true}}
    set({...observation(), trigger})
    const decision = await inspect(ports)
    expect(decision.kind).toBe('authorize')
    if (decision.kind !== 'authorize') throw new Error('fixture invalid')
    vi.mocked(ports.authorization).mockResolvedValue({...record, authorization: decision.authorization})
    trigger.hold.state = 'held'
    expect(await finish(ports, 11)).toEqual({kind: 'skip', reason: 'recheck-failed'})
    expect(ports.merge).not.toHaveBeenCalled()
  })
  it('rejects mismatched artifact and rechecks live review', async () => {
    const {ports, record, set} = setup()
    vi.mocked(ports.authorization).mockResolvedValueOnce({...record, origin: {...record.origin, artifactId: 12}})
    expect(await finish(ports, 11)).toEqual({kind: 'skip', reason: 'authorization-invalid'})
    set({...observation(), trigger: {kind: 'review', reviewsVerified: true, reviews: []}})
    expect(await finish(ports, 11)).toEqual({kind: 'skip', reason: 'recheck-failed'})
    expect(ports.merge).not.toHaveBeenCalled()
  })
  it('reconciles a lost response exactly once and refuses unproved facts', async () => {
    const {ports, facts} = setup()
    vi.mocked(ports.merge).mockRejectedValue(new Error('lost'))
    expect(await finish(ports, 11)).toEqual({kind: 'source', source: 'squash', recovery: false})
    expect(ports.merge).toHaveBeenCalledTimes(1)
    facts.actorAppId = 100
    expect(await finish(ports, 11)).toEqual({kind: 'skip', reason: 'squash-unproven'})
  })
  it('blocks unresolved attempts except active owner-main recovery with original evidence', async () => {
    const {ports, set} = setup()
    const prior = {state: 'unresolved', artifactId: 11} as const
    set({...observation(), mode: 'prepare', prior})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'unresolved'})
    set({...observation(), prior})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'unresolved'})
    set({...observation(), prior, trigger: {kind: 'dispatch', actorId: 7, ref: 'refs/heads/main', refVerified: true, reviewsVerified: false, reviews: []}})
    expect(await inspect(ports)).toEqual({kind: 'source', source: 'squash', recovery: true})
    expect(ports.merge).not.toHaveBeenCalled()
    expect(ports.prepare).not.toHaveBeenCalled()
  })
  it('blocks recovery for inactive mode, foreign dispatch or unverified original record', async () => {
    const {ports, set, record} = setup()
    const prior = {state: 'unresolved', artifactId: 11} as const
    const dispatch: GateInput['trigger'] = {kind: 'dispatch', actorId: 7, ref: 'refs/heads/main', refVerified: true, reviewsVerified: false, reviews: []}
    set({...observation(), activation: null, prior, trigger: dispatch})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'inactive'})
    set({...observation(), prior, trigger: {...dispatch, actorId: 8}})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'trigger'})
    set({...observation(), prior, trigger: dispatch})
    vi.mocked(ports.authorization).mockResolvedValue({...record, origin: {...record.origin, verified: false}})
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'authorization-invalid'})
    expect(ports.merge).not.toHaveBeenCalled()
  })
  it('recovers an independently accepted older trusted revision but not a foreign origin', async () => {
    const {ports, set, record} = setup()
    const prior = {state: 'unresolved', artifactId: 11} as const
    const trigger: GateInput['trigger'] = {kind: 'dispatch', actorId: 7, ref: 'refs/heads/main', refVerified: true, reviewsVerified: false, reviews: []}
    const current = observation()
    current.trusted.revision = 'new-rev'
    current.run.revision = 'new-rev'
    set({...current, prior, trigger})
    expect(await finish(ports, 11)).toEqual({kind: 'skip', reason: 'unresolved'})
    expect(await inspect(ports)).toEqual({kind: 'source', source: 'squash', recovery: true})
    expect(ports.recoveryRevision).toHaveBeenCalledWith(record)
    vi.mocked(ports.recoveryRevision).mockResolvedValueOnce(false)
    expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'authorization-invalid'})
    for (const origin of [{...record.origin, repo: 'foreign/repo'}, {...record.origin, workflow: 'foreign'}]) {
      vi.mocked(ports.authorization).mockResolvedValueOnce({...record, origin})
      expect(await inspect(ports)).toEqual({kind: 'skip', reason: 'authorization-invalid'})
    }
    expect(ports.merge).not.toHaveBeenCalled()
  })
  it('does not accept an older run record for a new normal merge', async () => {
    const {ports, set} = setup()
    const current = observation()
    current.trusted.revision = 'new-rev'
    current.run.revision = 'new-rev'
    if (current.candidate.state !== 'ready') throw new Error('fixture invalid')
    current.candidate.gate.expected.trustedRevision = 'new-rev'
    set(current)
    expect(await finish(ports, 11)).toEqual({kind: 'skip', reason: 'recheck-failed'})
    expect(ports.merge).not.toHaveBeenCalled()
  })
})
