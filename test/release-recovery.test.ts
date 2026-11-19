import {describe, expect, it} from 'vitest'
import {renderReleaseBody} from '../scripts/release/publisher.ts'
import {discoverPredecessor, planHandoff, selectReleaseCandidates} from '../scripts/release/recovery.ts'

const source = 'a'.repeat(40)
const nextSource = 'b'.repeat(40)
const digest = `sha256:${'c'.repeat(64)}`
const otherDigest = `sha256:${'d'.repeat(64)}`
const present = <T>(value: T): {state: 'present'; value: T} => ({state: 'present', value})
const absent = {state: 'absent' as const}
const unknown = {state: 'unknown' as const, reason: 'read-failed' as const}
const identity = {version: '2026.11.9', source, digest, notes: 'notes'}
const release = {tag: identity.version, body: renderReleaseBody('fro-bot/dashboard', identity), draft: false, prerelease: false}
const observations = {
  repo: 'fro-bot/dashboard', firstParent: present([nextSource, source]),
  tag: present({version: identity.version, sha: source}),
  versionAlias: present({version: identity.version, digest}),
  shaAlias: present({name: `sha-${source.slice(0, 7)}`, digest}), latest: present({digest}),
  gate: present({version: identity.version, source, digest, smoke: 'pass' as const, trivy: 'pass' as const, enforced: true as const}),
}
const predecessor = {version: identity.version, source, digest}
const allocation = {source: nextSource, version: '2026.12.0', runId: 12, attempt: 1, tag: 'ci-12-1', candidate: absent}
const handoff = {source: nextSource, predecessor, recovery: true, allocations: present([allocation]), draft: absent, allocatedVersion: absent}

describe('predecessor discovery', () => {
  it('selects the highest numeric published release after matching every proof', () => {
    const old = {...release, tag: '2026.11.8'}
    expect(discoverPredecessor(present([old, release]), observations)).toEqual({kind: 'predecessor', predecessor})
  })
  it('never falls back when the newest release is incomplete or ambiguous', () => {
    expect(discoverPredecessor(present([release, {...release, tag: '2026.11.10'}]), observations)).toMatchObject({kind: 'stop'})
    expect(discoverPredecessor(present([release, release]), observations)).toMatchObject({kind: 'stop'})
    expect(discoverPredecessor(present([]), observations)).toMatchObject({kind: 'stop'})
    expect(discoverPredecessor(unknown, observations)).toMatchObject({kind: 'stop'})
  })
  it('rejects unknown or contradictory tags, aliases, ancestry, and gates', () => {
    for (const change of [
      {tag: absent}, {tag: present({version: identity.version, sha: nextSource})},
      {versionAlias: unknown}, {shaAlias: present({name: `sha-${source.slice(0, 7)}`, digest: otherDigest})},
      {latest: absent}, {firstParent: present([nextSource])}, {gate: unknown},
      {gate: present({...observations.gate.value, enforced: false})},
    ]) expect(discoverPredecessor(present([release]), {...observations, ...change})).toMatchObject({kind: 'stop'})
  })
  it('ignores drafts, prereleases, and non-CalVer tags', () => {
    const ignored = [{...release, tag: '2027.01.0', prerelease: true}, {...release, tag: '2028.01.0', draft: true}, {...release, tag: 'v999'}]
    expect(discoverPredecessor(present([release, ...ignored]), observations)).toEqual({kind: 'predecessor', predecessor})
  })
  it('recovers a verified newer public release while latest still names the proved predecessor', () => {
    const pending = {version: '2026.12.0', source: nextSource, digest: otherDigest, notes: 'next'}
    const newer = {...release, tag: pending.version, body: renderReleaseBody('fro-bot/dashboard', pending)}
    expect(selectReleaseCandidates(present([release, newer]))).toMatchObject({kind: 'candidates', newest: newer, previous: release})
    expect(discoverPredecessor(present([release, newer]), observations, present(pending))).toEqual({kind: 'predecessor', predecessor})
    expect(discoverPredecessor(present([release, newer]), observations)).toMatchObject({kind: 'stop'})
    expect(discoverPredecessor(present([release, newer]), {...observations, latest: unknown}, present(pending))).toMatchObject({kind: 'stop'})
    expect(discoverPredecessor(present([release, newer]), {...observations, latest: present({digest: otherDigest})}, present(pending))).toMatchObject({kind: 'stop'})
    expect(discoverPredecessor(present([release, newer]), observations, present({...pending, digest}))).toMatchObject({kind: 'stop'})
    expect(discoverPredecessor(present([release, newer]), observations, unknown)).toMatchObject({kind: 'stop'})
    expect(discoverPredecessor(present([newer]), observations, present(pending))).toMatchObject({kind: 'stop'})
    expect(discoverPredecessor(present([release, newer]), {...observations, firstParent: present([source, nextSource])}, present(pending))).toMatchObject({kind: 'stop'})
  })
})

describe('handoff planning', () => {
  it('rebuilds the authenticated allocated version rather than allocating again', () => {
    expect(planHandoff(handoff)).toMatchObject({kind: 'handoff', action: 'build', version: '2026.12.0', recovery: true})
  })
  it('re-gates an existing exact candidate with its original run and attempt', () => {
    const candidate = {...allocation, candidate: present({digest})}
    expect(planHandoff({...handoff, allocations: present([candidate])})).toMatchObject({kind: 'handoff', action: 'gate', original: {runId: 12, attempt: 1, digest}})
  })
  it('accepts only a draft bound to the exact known candidate', () => {
    const candidate = {...allocation, candidate: present({digest})}
    expect(planHandoff({...handoff, allocations: present([candidate]), draft: present({version: allocation.version, source: nextSource, digest})})).toMatchObject({kind: 'handoff', action: 'gate'})
  })
  it('uses an externally allocated version only for a known empty allocation history', () => {
    expect(planHandoff({...handoff, allocations: present([]), allocatedVersion: present('2026.12.1')})).toMatchObject({kind: 'handoff', action: 'build', version: '2026.12.1'})
    expect(planHandoff({...handoff, allocations: present([])})).toMatchObject({kind: 'stop'})
    expect(planHandoff({...handoff, allocations: unknown, allocatedVersion: present('2026.12.1')})).toMatchObject({kind: 'stop'})
  })
  it('blocks duplicate, unknown, wrong-source, and draft contradictions', () => {
    for (const changes of [
      {allocations: present([allocation, allocation])},
      {allocations: present([{...allocation, candidate: unknown}])},
      {allocations: present([{...allocation, source}])},
      {draft: present({version: allocation.version, source: nextSource, digest})},
      {allocations: present([{...allocation, candidate: present({digest})}]), draft: present({version: allocation.version, source: nextSource, digest: otherDigest})},
      {draft: unknown},
    ]) expect(planHandoff({...handoff, ...changes})).toMatchObject({kind: 'stop'})
  })
  it('reconciles repeated authenticated allocations for the same version', () => {
    const retry = {...allocation, runId: 13, attempt: 2, tag: 'ci-13-2'}
    expect(planHandoff({...handoff, allocations: present([allocation, retry])})).toMatchObject({kind: 'handoff', action: 'build', version: allocation.version})
    expect(planHandoff({...handoff, allocations: present([allocation, {...retry, candidate: present({digest})}])})).toMatchObject({kind: 'handoff', action: 'gate', original: {runId: 13, attempt: 2, digest}})
    for (const records of [
      [allocation, {...retry, candidate: unknown}],
      [{...allocation, candidate: present({digest})}, {...retry, candidate: present({digest})}],
      [allocation, {...retry, version: '2026.12.1'}],
      [allocation, {...retry, source}],
      [allocation, {...retry, tag: 'ci-12-1'}],
      [allocation, allocation],
    ]) expect(planHandoff({...handoff, allocations: present(records)})).toMatchObject({kind: 'stop'})
  })
})
