import type {Action, Artifacts, ArtifactTarget, Build, DispatchState, Evidence, Identity, Known, Obs, Plan, PublicationPorts, Records, ReleaseRecord, RunContext} from '../scripts/release/publication.ts'

import {describe, expect, it} from 'vitest'
import {planPublication, reconcilePublication} from '../scripts/release/publication.ts'

const SOURCE = 'a'.repeat(40)
const MAIN_TIP = 'b'.repeat(40)
const OTHER_SOURCE = 'c'.repeat(40)
const NOTES = '## Release\n\n- Add held releases (#1)\n'
const PREDECESSOR = {version: '2026.11.2', digest: `sha256:${'1'.repeat(64)}`}
const at = <T>(list: T[], index = 0): T => {
  const value = list[index]
  if (value === undefined) throw new Error('fixture: missing entry')
  return value
}
const digestOf = (n: number) => `sha256:${String(n).repeat(64)}`
const SHA_ALIAS = `sha-${SOURCE.slice(0, 7)}`

type WriteAction = Parameters<PublicationPorts['apply']>[0]
type WriteKey = 'allocate' | 'create-draft' | 'create-tag' | 'alias:version' | 'alias:sha' | 'publish-release' | 'set-latest'
interface Fault {op: WriteKey; mode: 'before' | 'after' | 'noop'}

const keyOf = (action: WriteAction): WriteKey => (action.kind === 'create-alias' ? (`alias:${action.alias}` as WriteKey) : action.kind)

/** In-memory durable state that replays real observations and applies writes with injectable faults. */
class World {
  month = '2026.11'
  source: string | null = SOURCE
  notes: string | null = NOTES
  predecessor: {version: string; digest: string} | null = {...PREDECESSOR}
  mainTip = MAIN_TIP
  releases = new Map<string, {draft: boolean; verified: boolean; identity: Identity | null}>()
  builds: Build[] = []
  evidence: Evidence[] = []
  tags = new Map<string, string>([[PREDECESSOR.version, 'd'.repeat(40)]])
  images = new Map<string, string>([['latest', PREDECESSOR.digest]])
  dispatch: DispatchState = 'never-sent'
  unreadable = new Set<string>()
  faults: Fault[] = []
  writes: WriteKey[] = []
  allocateCalls = 0
  digests = 0
  runId = 100

  get version(): string {
    const build = this.builds.at(0)
    if (!build) throw new Error('fixture: nothing allocated')
    return build.version
  }

  get identity(): Identity {
    const build = this.builds.at(0)
    if (build?.digest === undefined || build.digest === null) throw new Error('fixture: no candidate')
    return {version: build.version, source: SOURCE, digest: build.digest, notes: NOTES}
  }

  records(): Records {
    const read = <T>(name: string, value: T): Known<T> => (this.unreadable.has(name) ? {state: 'unknown', reason: 'read-failed'} : {state: 'present', value})
    return {
      expected: {source: this.source, notes: this.notes},
      predecessor: this.predecessor,
      releases: read<ReleaseRecord[]>('releases', [...this.releases].map(([tag, r]) => ({tag, ...r}))),
      builds: read<Build[]>('builds', structuredClone(this.builds)),
      evidence: read<Evidence[]>('evidence', structuredClone(this.evidence)),
    }
  }

  artifacts(target: ArtifactTarget): Artifacts {
    const {version} = target
    const obs = <T>(name: string, value: T | undefined): Obs<T> =>
      this.unreadable.has(name) ? {state: 'unknown', reason: 'read-failed'} : value === undefined ? {state: 'absent'} : {state: 'present', value}
    const sha = this.tags.get(version)
    const digestOfImage = (name: string) => this.images.get(name)
    const image = (name: string) => {
      const digest = digestOfImage(name)
      return digest === undefined ? undefined : {digest}
    }
    return {
      target,
      tagRef: obs('tag', sha === undefined ? undefined : {sha}),
      versionAlias: obs('alias:version', image(version)),
      shaAlias: obs('alias:sha', image(target.shaAlias)),
      latest: obs('latest', image('latest')),
      dispatch: this.unreadable.has('dispatch') ? {state: 'unknown', reason: 'read-failed'} : {state: 'present', value: this.dispatch},
    }
  }

  /** Candidate build for the allocated version, as pushed to the original attempt's CI tag. */
  build(): string {
    const build = this.builds.find(b => b.digest === null)
    if (!build) throw new Error('fixture: no pending build')
    this.digests += 1
    build.digest = digestOf(this.digests + 2)
    return build.digest
  }

  /** A retry attempt's fresh candidate for an already allocated version. */
  rebuild(version: string): string {
    this.runId += 1
    this.digests += 1
    const digest = digestOf(this.digests + 2)
    this.builds.push({runId: this.runId, attempt: 2, version, source: SOURCE, digest, verified: true})
    return digest
  }

  gate(digest?: string, overrides: Partial<Evidence> = {}): void {
    const build = this.builds.find(b => b.digest === (digest ?? b.digest) && b.digest !== null)
    if (build?.digest === undefined || build.digest === null) throw new Error('fixture: no candidate to gate')
    this.evidence.push({runId: build.runId, attempt: build.attempt, version: build.version, source: SOURCE, digest: build.digest, verified: true, smoke: 'pass', trivy: {enforced: true, result: 'pass'}, ...overrides})
  }

  /** Unwrapped effect: what the durable store looks like after a write is applied. */
  effect(action: WriteAction): void {
    if (action.kind === 'allocate') {
      this.allocateCalls += 1
      const patches = [...this.tags.keys(), ...this.releases.keys(), ...this.builds.map(b => b.version)]
        .filter(tag => tag.startsWith(`${this.month}.`))
        .map(tag => Number(tag.slice(this.month.length + 1)))
      this.runId += 1
      this.builds.push({runId: this.runId, attempt: 1, version: `${this.month}.${patches.length === 0 ? 0 : Math.max(...patches) + 1}`, source: SOURCE, digest: null, verified: true})
    } else if (action.kind === 'create-draft') {
      this.releases.set(action.identity.version, {draft: true, verified: false, identity: action.identity})
    } else if (action.kind === 'create-tag') {
      this.tags.set(action.version, action.source)
    } else if (action.kind === 'create-alias') {
      this.images.set(action.name, action.digest)
    } else if (action.kind === 'publish-release') {
      const release = this.releases.get(action.version)
      if (!release) throw new Error('fixture: no draft')
      release.draft = false
      release.verified = true
    } else {
      this.images.set('latest', action.digest)
    }
    this.writes.push(keyOf(action))
  }

  ports(): PublicationPorts {
    return {
      observeRecords: async () => this.records(),
      observeArtifacts: async target => this.artifacts(target),
      apply: async action => {
        const index = this.faults.findIndex(f => f.op === keyOf(action))
        const fault = index === -1 ? undefined : this.faults.splice(index, 1)[0]
        if (fault?.mode === 'before') throw new Error(`lost before ${fault.op}`)
        if (fault?.mode === 'noop') return
        this.effect(action)
        if (fault?.mode === 'after') throw new Error(`response lost after ${fault.op}`)
      },
    }
  }
}

const planOf = (world: World, ctx: RunContext = {attempt: 1, created: true}): Plan => {
  const first = planPublication({...world.records(), artifacts: null}, ctx)
  if (first.kind !== 'observe-artifacts') return first
  return planPublication({...world.records(), artifacts: world.artifacts(first.target)}, ctx)
}

/** Allocated, built and gated for the expected source: ready for the publisher-side writes. */
const gated = (world = new World()) => {
  world.effect({kind: 'allocate'})
  world.writes.length = 0
  world.build()
  world.gate()
  return world
}

/** Replays the policy against observed state, applying each write cleanly, until it stops. */
const replay = (world: World, ctx: RunContext = {attempt: 1, created: true}) => {
  const actions: Action[] = []
  for (let i = 0; i < 20; i++) {
    const plan = planOf(world, ctx)
    if (plan.kind !== 'act') return {plan, actions}
    actions.push(plan.action)
    if (plan.action.kind === 'build') world.build()
    else if (plan.action.kind === 'gate') world.gate(plan.action.digest)
    else world.effect(plan.action)
  }
  throw new Error('replay did not settle')
}

const otherRecord = (overrides: Partial<ReleaseRecord> & {tag: string}): ReleaseRecord => ({
  draft: false,
  verified: true,
  identity: {version: overrides.tag, source: OTHER_SOURCE, digest: digestOf(9), notes: 'other'},
  ...overrides,
})
const seedOther = (world: World, record: ReleaseRecord) => world.releases.set(record.tag, {draft: record.draft, verified: record.verified, identity: record.identity})

describe('publication policy: identity and allocation', () => {
  it('allocates only after authoritative absence of any recorded identity', () => {
    expect(planOf(new World())).toEqual({kind: 'act', action: {kind: 'allocate'}})
  })

  it('reuses a recorded version across a month boundary instead of allocating again', () => {
    const world = new World()
    world.effect({kind: 'allocate'})
    world.month = '2026.12'
    expect(planOf(world)).toEqual({kind: 'act', action: {kind: 'build', version: '2026.11.3'}})
  })

  it('never allocates while the batch record is unreadable or not proved', () => {
    for (const name of ['releases', 'builds', 'evidence']) {
      const world = new World()
      world.unreadable.add(name)
      expect(planOf(world)).toMatchObject({kind: 'stop', reason: `${name}-unreadable`})
    }
    const unproven = new World()
    unproven.source = null
    expect(planOf(unproven)).toMatchObject({kind: 'stop', reason: 'source-unproven'})
    unproven.source = 'not-a-sha'
    expect(planOf(unproven)).toMatchObject({kind: 'stop', reason: 'source-unproven'})
    const noNotes = new World()
    noNotes.notes = null
    expect(planOf(noNotes)).toMatchObject({kind: 'stop', reason: 'notes-unproven'})
    const noPredecessor = new World()
    noPredecessor.predecessor = null
    expect(planOf(noPredecessor)).toMatchObject({kind: 'stop', reason: 'predecessor-unproven'})
  })

  it('gates the recorded candidate digest rather than rebuilding it', () => {
    const world = new World()
    world.effect({kind: 'allocate'})
    const digest = world.build()
    expect(planOf(world)).toEqual({kind: 'act', action: {kind: 'gate', version: '2026.11.3', digest}})
  })

  it('rebuilds the same version only when every candidate failed its gates', () => {
    const world = new World()
    world.effect({kind: 'allocate'})
    world.build()
    world.gate(undefined, {smoke: 'fail'})
    expect(planOf(world)).toEqual({kind: 'act', action: {kind: 'build', version: '2026.11.3'}})
  })

  it('refuses ambiguous candidates and unusable gate evidence', () => {
    const two = new World()
    two.effect({kind: 'allocate'})
    two.build()
    two.builds.push({...at(two.builds), runId: 777, digest: digestOf(8)})
    expect(planOf(two)).toMatchObject({kind: 'stop', reason: 'candidate-ambiguous'})

    const unenforced = gated()
    unenforced.evidence[0] = {...at(unenforced.evidence), trivy: {enforced: false, result: 'pass'}}
    expect(planOf(unenforced)).toMatchObject({kind: 'stop', reason: 'evidence-invalid'})

    const unverified = gated()
    unverified.evidence[0] = {...at(unverified.evidence), verified: false}
    expect(planOf(unverified)).toMatchObject({kind: 'stop', reason: 'unverified-record'})
    const unverifiedBuild = gated()
    unverifiedBuild.builds[0] = {...at(unverifiedBuild.builds), verified: false}
    expect(planOf(unverifiedBuild)).toMatchObject({kind: 'stop', reason: 'unverified-record'})

    const split = gated()
    split.evidence.push({...at(split.evidence), digest: digestOf(8)})
    expect(planOf(split)).toMatchObject({kind: 'stop', reason: 'conflicting-evidence'})

    const moved = gated()
    moved.builds[0] = {...at(moved.builds), digest: digestOf(7)}
    expect(planOf(moved)).toMatchObject({kind: 'stop', reason: 'candidate-mismatch'})

    const versions = gated()
    versions.evidence[0] = {...at(versions.evidence), version: '2026.11.9'}
    expect(planOf(versions)).toMatchObject({kind: 'stop', reason: 'conflicting-versions'})
  })

  it('does not treat evidence for another source, version or digest as authority', () => {
    const world = new World()
    world.effect({kind: 'allocate'})
    const digest = world.build()
    world.gate(digest, {source: OTHER_SOURCE})
    // evidence for another source is that other attempt's record: it blocks, it never authorizes
    expect(planOf(world)).toMatchObject({kind: 'stop', reason: 'other-unresolved'})
  })

  it('blocks a wrong or unrelated release record', () => {
    const malformed = new World()
    malformed.releases.set('2026.11.3', {draft: true, verified: false, identity: null})
    expect(planOf(malformed)).toMatchObject({kind: 'stop', reason: 'malformed-release'})

    const mislabeled = new World()
    seedOther(mislabeled, otherRecord({tag: '2026.11.3', identity: {version: '2026.11.4', source: SOURCE, digest: digestOf(3), notes: NOTES}}))
    expect(planOf(mislabeled)).toMatchObject({kind: 'stop', reason: 'malformed-release'})

    const draft = new World()
    seedOther(draft, otherRecord({tag: '2026.11.3', draft: true, verified: false}))
    expect(planOf(draft)).toMatchObject({kind: 'stop', reason: 'other-unresolved'})

    const incomplete = new World()
    seedOther(incomplete, otherRecord({tag: '2026.11.3', verified: false}))
    expect(planOf(incomplete)).toMatchObject({kind: 'stop', reason: 'other-unresolved'})

    const collision = gated()
    seedOther(collision, otherRecord({tag: collision.version}))
    expect(planOf(collision)).toMatchObject({kind: 'stop', reason: 'version-collision'})

    const released = new World()
    seedOther(released, otherRecord({tag: PREDECESSOR.version, identity: {version: PREDECESSOR.version, source: SOURCE, digest: PREDECESSOR.digest, notes: ''}}))
    expect(planOf(released)).toMatchObject({kind: 'stop', reason: 'already-released'})

    const duplicate = gated()
    duplicate.releases.set('2026.11.3', {draft: true, verified: false, identity: duplicate.identity})
    duplicate.releases.set('2026.11.4', {draft: true, verified: false, identity: {...duplicate.identity, version: '2026.11.4'}})
    expect(planOf(duplicate)).toMatchObject({kind: 'stop', reason: 'duplicate-release'})

    const old = new World()
    seedOther(old, otherRecord({tag: '2026.10.4', draft: true, verified: false}))
    expect(planOf(old)).toEqual({kind: 'act', action: {kind: 'allocate'}})

    const stale = gated()
    stale.builds[0] = {...at(stale.builds), version: PREDECESSOR.version}
    stale.evidence[0] = {...at(stale.evidence), version: PREDECESSOR.version}
    expect(planOf(stale)).toMatchObject({kind: 'stop', reason: 'version-not-advancing'})
  })

  it('treats another batch as superseding only when verified and as unresolved otherwise', () => {
    const newer = new World()
    seedOther(newer, otherRecord({tag: '2026.11.3'}))
    expect(planOf(newer)).toMatchObject({kind: 'stop', reason: 'superseded'})

    const otherCandidate = new World()
    otherCandidate.builds.push({runId: 5, attempt: 1, version: '2026.11.3', source: OTHER_SOURCE, digest: null, verified: true})
    expect(planOf(otherCandidate)).toMatchObject({kind: 'stop', reason: 'other-unresolved'})
  })

  it('freezes notes and gate evidence for a durable draft', () => {
    const noEvidence = gated()
    noEvidence.releases.set(noEvidence.version, {draft: true, verified: false, identity: noEvidence.identity})
    noEvidence.evidence.length = 0
    expect(planOf(noEvidence)).toMatchObject({kind: 'stop', reason: 'evidence-missing'})

    const otherNotes = gated()
    otherNotes.releases.set(otherNotes.version, {draft: true, verified: false, identity: {...otherNotes.identity, notes: 'edited in the draft body'}})
    expect(planOf(otherNotes)).toMatchObject({kind: 'stop', reason: 'notes-mismatch'})

    const otherDigest = gated()
    otherDigest.releases.set(otherDigest.version, {draft: true, verified: false, identity: {...otherDigest.identity, digest: digestOf(8)}})
    expect(planOf(otherDigest)).toMatchObject({kind: 'stop', reason: 'evidence-mismatch'})

    const failed = gated()
    failed.releases.set(failed.version, {draft: true, verified: false, identity: failed.identity})
    failed.evidence[0] = {...at(failed.evidence), smoke: 'fail'}
    expect(planOf(failed)).toMatchObject({kind: 'stop', reason: 'gate-failed'})
  })
})

describe('publication policy: public writes in plan order', () => {
  it('walks draft, tag, version alias, sha alias, publish, latest and only then completes', () => {
    const world = gated()
    const {plan, actions} = replay(world)
    const {identity} = world
    expect(actions).toEqual([
      {kind: 'create-draft', identity},
      {kind: 'create-tag', version: identity.version, source: SOURCE},
      {kind: 'create-alias', alias: 'version', name: identity.version, digest: identity.digest},
      {kind: 'create-alias', alias: 'sha', name: SHA_ALIAS, digest: identity.digest},
      {kind: 'publish-release', version: identity.version},
      {kind: 'set-latest', digest: identity.digest},
    ])
    expect(plan).toEqual({kind: 'complete', identity, deploy: 'eligible'})
    expect(world.tags.get(identity.version)).toBe(SOURCE)
    expect(world.tags.get(identity.version)).not.toBe(MAIN_TIP)
  })

  it('treats matching tag and aliases as no-ops under a staged draft', () => {
    const world = gated()
    const {identity} = world
    world.effect({kind: 'create-draft', identity})
    world.tags.set(identity.version, SOURCE)
    world.images.set(identity.version, identity.digest)
    world.images.set(SHA_ALIAS, identity.digest)
    expect(replay(world).actions.map(a => a.kind)).toEqual(['publish-release', 'set-latest'])
  })

  it('stops on conflicting unique artifacts before any write', () => {
    const tag = gated()
    tag.tags.set(tag.version, MAIN_TIP)
    expect(planOf(tag)).toMatchObject({kind: 'stop', reason: 'tag-conflict'})
    const version = gated()
    version.images.set(version.version, digestOf(8))
    expect(planOf(version)).toMatchObject({kind: 'stop', reason: 'alias-conflict'})
    const sha = gated()
    sha.images.set(SHA_ALIAS, digestOf(8))
    expect(planOf(sha)).toMatchObject({kind: 'stop', reason: 'alias-conflict'})
  })

  it('stops precisely on unreadable artifact state and never reads absence from a failure', () => {
    for (const [name, reason] of [['tag', 'tag-unreadable'], ['alias:version', 'alias-unreadable'], ['alias:sha', 'alias-unreadable'], ['latest', 'latest-unreadable']] as const) {
      const world = gated()
      world.unreadable.add(name)
      expect(planOf(world)).toMatchObject({kind: 'stop', reason})
    }
  })

  it('requires artifacts observed for the resolved version', () => {
    const world = gated()
    const target = {version: world.version, source: SOURCE, shaAlias: SHA_ALIAS}
    const ctx = {attempt: 1, created: true}
    expect(planPublication({...world.records(), artifacts: null}, ctx)).toEqual({kind: 'observe-artifacts', target})
    for (const wrong of [{...target, version: '2026.11.9'}, {...target, shaAlias: 'sha-0000000'}, {...target, source: OTHER_SOURCE}]) {
      expect(planPublication({...world.records(), artifacts: world.artifacts(wrong)}, ctx)).toMatchObject({kind: 'stop', reason: 'artifacts-wrong-target'})
    }
  })

  it('advances latest only from the proven predecessor or our own digest', () => {
    const unrelated = gated()
    unrelated.images.set('latest', digestOf(8))
    expect(planOf(unrelated)).toMatchObject({kind: 'stop', reason: 'latest-conflict'})
    const missing = gated()
    missing.images.delete('latest')
    expect(planOf(missing)).toMatchObject({kind: 'stop', reason: 'latest-unproven'})
    const none = gated()
    none.predecessor = {...PREDECESSOR, digest: digestOf(8)}
    none.images.set('latest', PREDECESSOR.digest)
    expect(planOf(none)).toMatchObject({kind: 'stop', reason: 'latest-conflict'})
    const ours = gated()
    ours.effect({kind: 'create-draft', identity: ours.identity})
    ours.images.set('latest', ours.identity.digest)
    const actions = replay(ours).actions.map(a => a.kind)
    expect(actions).toEqual(['create-tag', 'create-alias', 'create-alias', 'publish-release'])
  })

  it('blocks a stale attempt after a newer verified publication from touching latest or deploying', () => {
    const world = gated()
    replay(world)
    seedOther(world, otherRecord({tag: '2026.11.4'}))
    world.images.set('latest', digestOf(9))
    expect(planOf(world)).toMatchObject({kind: 'stop', reason: 'superseded'})
    const half = gated()
    half.effect({kind: 'create-draft', identity: half.identity})
    seedOther(half, otherRecord({tag: '2026.11.4'}))
    expect(planOf(half)).toMatchObject({kind: 'stop', reason: 'superseded'})
  })

  it('offers deployment only for fresh verified publication in the original attempt', () => {
    const fresh = gated()
    replay(fresh)
    expect(planOf(fresh, {attempt: 1, created: true})).toMatchObject({kind: 'complete', deploy: 'eligible'})
    expect(planOf(fresh, {attempt: 2, created: true})).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
    expect(planOf(fresh, {attempt: 1, created: false})).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
  })

  it('never resends an accepted, rejected or uncertain dispatch', () => {
    const expected = {accepted: 'delivered', rejected: 'not-delivered', uncertain: 'uncertain'} as const
    for (const [state, deploy] of Object.entries(expected)) {
      const world = gated()
      replay(world)
      world.dispatch = state as DispatchState
      expect(planOf(world, {attempt: 1, created: true})).toMatchObject({kind: 'complete', deploy})
    }
    const unknown = gated()
    replay(unknown)
    unknown.unreadable.add('dispatch')
    expect(planOf(unknown, {attempt: 1, created: true})).toMatchObject({kind: 'complete', deploy: 'unreadable'})
  })
})

const ALL_WRITES: WriteKey[] = ['allocate', 'create-draft', 'create-tag', 'alias:version', 'alias:sha', 'publish-release', 'set-latest']

/** The controller's job chain: reconcile, hand build/gate to credential-free jobs, reconcile again. */
const ship = async (world: World, attempt = 1, ports: PublicationPorts = world.ports()) => {
  for (let i = 0; i < 10; i++) {
    const outcome = await reconcilePublication(ports, {attempt})
    if (outcome.kind !== 'handoff') return outcome
    if (outcome.action.kind === 'gate') world.gate(outcome.action.digest)
    else if (world.builds.some(b => b.digest === null)) world.build()
    else world.rebuild(outcome.action.version)
  }
  throw new Error('ship did not settle')
}

/** Exactly one public release, tag, alias set and verified latest for one identity. */
const expectPublishedOnce = (world: World, version = '2026.11.3') => {
  const release = world.releases.get(version)
  expect(world.releases.size).toBe(1)
  expect(release?.draft).toBe(false)
  const digest = release?.identity?.digest
  expect(release?.identity).toMatchObject({version, source: SOURCE, notes: NOTES})
  expect(world.tags.get(version)).toBe(SOURCE)
  expect(world.images.get(version)).toBe(digest)
  expect(world.images.get(SHA_ALIAS)).toBe(digest)
  expect(world.images.get('latest')).toBe(digest)
  for (const key of ALL_WRITES) expect(world.writes.filter(w => w === key).length).toBeLessThanOrEqual(1)
}

describe('publication driver: reconcile against durable state', () => {
  it('publishes once in plan order and offers deployment only to the fresh original attempt', async () => {
    const world = new World()
    const outcome = await ship(world)
    expect(outcome).toMatchObject({kind: 'complete', deploy: 'eligible'})
    expect(world.writes).toEqual(ALL_WRITES)
    expectPublishedOnce(world)
    expect(world.tags.get('2026.11.3')).not.toBe(world.mainTip)

    world.writes.length = 0
    expect(await ship(world, 2)).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
    expect(await ship(world, 1)).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
    expect(world.writes).toEqual([])
    expect(world.allocateCalls).toBe(1)
  })

  it('keeps the allocated identity across a month boundary', async () => {
    const stopped = new World()
    expect(await reconcilePublication(stopped.ports(), {attempt: 1})).toMatchObject({kind: 'handoff', action: {kind: 'build', version: '2026.11.3'}})
    stopped.month = '2026.12'
    expect(await ship(stopped, 2)).toMatchObject({kind: 'complete', identity: {version: '2026.11.3'}})
    expect(stopped.allocateCalls).toBe(1)
    expect(stopped.tags.has('2026.12.0')).toBe(false)

    const interrupted = new World()
    interrupted.faults.push({op: 'create-tag', mode: 'before'})
    expect(await ship(interrupted)).toMatchObject({kind: 'stop', reason: 'write-unconfirmed'})
    interrupted.month = '2026.12'
    expect(await ship(interrupted, 2)).toMatchObject({kind: 'complete', identity: {version: '2026.11.3'}})
    expect(interrupted.allocateCalls).toBe(1)
    expectPublishedOnce(interrupted)
  })

  describe.each(ALL_WRITES)('a fault at %s', op => {
    it('converges when the write applied but the response was lost', async () => {
      const world = new World()
      world.faults.push({op, mode: 'after'})
      expect(await ship(world)).toMatchObject({kind: 'complete', deploy: 'eligible'})
      expectPublishedOnce(world)
      expect(world.writes.filter(w => w === op)).toHaveLength(1)
      expect(world.allocateCalls).toBe(1)
    })

    it('stops precisely when the write did not apply, then resumes the same identity', async () => {
      const world = new World()
      world.faults.push({op, mode: 'before'})
      expect(await ship(world)).toMatchObject({kind: 'stop', reason: 'write-unconfirmed', detail: op.split(':')[0] === 'alias' ? 'create-alias' : op})
      expect(world.writes).not.toContain(op)
      expect(await ship(world, 2)).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
      expectPublishedOnce(world)
      expect(world.allocateCalls).toBe(1)
    })

    it('never trusts a claimed success the next read does not show, and never offers deployment', async () => {
      const world = new World()
      world.faults.push({op, mode: 'noop'})
      const outcome = await ship(world)
      expect(outcome).toMatchObject({kind: 'stop', reason: 'write-unproven'})
      expect(await ship(world, 2)).toMatchObject({kind: 'complete'})
      expectPublishedOnce(world)
    })
  })

  it('does not deploy while latest cannot be verified', async () => {
    const world = new World()
    world.faults.push({op: 'set-latest', mode: 'noop'})
    const outcome = await ship(world)
    expect(outcome.kind).toBe('stop')
    expect(world.images.get('latest')).toBe(PREDECESSOR.digest)
    expect(world.releases.get('2026.11.3')?.draft).toBe(false)
  })

  it('reuses the recorded candidate and evidence after losses before the draft', async () => {
    const world = new World()
    expect(await reconcilePublication(world.ports(), {attempt: 1})).toMatchObject({kind: 'handoff', action: {kind: 'build'}})
    const digest = world.build()
    // the gate ran but its evidence record was lost: gate the same digest, never rebuild or reallocate
    for (const attempt of [2, 3]) {
      expect(await reconcilePublication(world.ports(), {attempt})).toEqual({kind: 'handoff', action: {kind: 'gate', version: '2026.11.3', digest}})
    }
    expect(world.builds).toHaveLength(1)
    expect(world.allocateCalls).toBe(1)
    world.gate(digest)
    expect(await ship(world, 4)).toMatchObject({kind: 'complete', identity: {digest}})
    expectPublishedOnce(world)
  })

  it('blocks on unreadable candidate or evidence state without writing or allocating', async () => {
    for (const [name, reason] of [['builds', 'builds-unreadable'], ['evidence', 'evidence-unreadable'], ['releases', 'releases-unreadable']] as const) {
      const world = new World()
      world.unreadable.add(name)
      expect(await ship(world)).toMatchObject({kind: 'stop', reason})
      expect(world.writes).toEqual([])
    }
    const throwing: PublicationPorts = {...new World().ports(), observeRecords: async () => {
      throw new Error('boom')
    }}
    expect(await reconcilePublication(throwing, {attempt: 1})).toMatchObject({kind: 'stop', reason: 'observe-failed'})
  })

  it('rebuilds a failed candidate under the same version and never reuses the failed digest', async () => {
    const world = new World()
    world.effect({kind: 'allocate'})
    const failed = world.build()
    world.gate(failed, {trivy: {enforced: true, result: 'fail'}})
    const outcome = await ship(world, 2)
    expect(outcome).toMatchObject({kind: 'complete'})
    expect(world.identity.digest).toBe(failed)
    expect(world.releases.get('2026.11.3')?.identity?.digest).not.toBe(failed)
    expect(world.allocateCalls).toBe(1)
  })

  it('never substitutes a different gated digest for a recorded identity', async () => {
    const world = gated()
    const recorded = world.identity
    world.effect({kind: 'create-draft', identity: recorded})
    const other = world.rebuild(world.version)
    world.gate(other)
    expect(await ship(world, 2)).toMatchObject({kind: 'stop', reason: 'conflicting-evidence'})
    expect(world.releases.get(recorded.version)?.identity?.digest).toBe(recorded.digest)
    expect(world.tags.has(recorded.version)).toBe(false)
  })

  it('writes nothing and allocates nothing when identity or collisions disagree', async () => {
    const cases: [string, (w: World) => void][] = [
      ['draft body without gate evidence', w => {
        w.effect({kind: 'create-draft', identity: w.identity})
        w.evidence.length = 0
      }],
      ['draft with other notes', w => w.effect({kind: 'create-draft', identity: {...w.identity, notes: 'edited'}})],
      ['tag at another commit', w => w.tags.set(w.version, MAIN_TIP)],
      ['version alias at another digest', w => w.images.set(w.version, digestOf(8))],
      ['sha alias at another digest', w => w.images.set(SHA_ALIAS, digestOf(8))],
      ['latest elsewhere', w => w.images.set('latest', digestOf(8))],
      ['unproven source', w => {
        w.source = null
      }],
    ]
    for (const [name, setup] of cases) {
      const world = gated()
      setup(world)
      const before = {writes: world.writes.length, allocate: world.allocateCalls, tags: [...world.tags], images: [...world.images], releases: [...world.releases]}
      const outcome = await ship(world, 2)
      expect(outcome.kind, name).toBe('stop')
      expect(world.writes.length, name).toBe(before.writes)
      expect(world.allocateCalls, name).toBe(before.allocate)
      expect([...world.tags], name).toEqual(before.tags)
      expect([...world.images], name).toEqual(before.images)
      expect([...world.releases], name).toEqual(before.releases)
    }
  })

  it('stops a stale retry after a newer verified publication without touching latest or deploying', async () => {
    const world = new World()
    const base = world.ports()
    const ports: PublicationPorts = {
      ...base,
      apply: async action => {
        await base.apply(action)
        if (action.kind === 'publish-release') seedOther(world, otherRecord({tag: '2026.11.4'}))
      },
    }
    const outcome = await ship(world, 1, ports)
    expect(outcome).toMatchObject({kind: 'stop', reason: 'superseded'})
    expect(world.writes).not.toContain('set-latest')
    expect(world.images.get('latest')).toBe(PREDECESSOR.digest)
  })

  it('ignores an unrelated main tip and publishes only the proved source', async () => {
    const world = new World()
    world.mainTip = 'e'.repeat(40)
    expect(await ship(world)).toMatchObject({kind: 'complete', identity: {source: SOURCE}})
    expect([...world.tags.values()]).not.toContain(world.mainTip)
  })

  it('stops on an unreadable artifact after earlier writes instead of reading it as absent', async () => {
    const world = new World()
    const base = world.ports()
    const ports: PublicationPorts = {
      ...base,
      apply: async action => {
        await base.apply(action)
        if (action.kind === 'create-draft') world.unreadable.add('tag')
      },
    }
    expect(await ship(world, 1, ports)).toMatchObject({kind: 'stop', reason: 'tag-unreadable'})
    expect(world.writes).not.toContain('create-tag')
  })

  it('reports dispatch outcomes separately and never offers a resend', async () => {
    const expected = {'never-sent': 'eligible', accepted: 'delivered', rejected: 'not-delivered', uncertain: 'uncertain'} as const
    for (const [state, deploy] of Object.entries(expected)) {
      const world = new World()
      world.dispatch = state as DispatchState
      const outcome = await ship(world)
      expect(outcome, state).toMatchObject({kind: 'complete', deploy})
      expectPublishedOnce(world)
    }
    // an already-published attempt resumed by a rerun is never offered a send, even if no send is recorded
    const resumed = new World()
    await ship(resumed)
    expect(await ship(resumed, 2)).toMatchObject({deploy: 'not-fresh'})
    resumed.dispatch = 'uncertain'
    expect(await ship(resumed, 2)).toMatchObject({deploy: 'uncertain'})
    resumed.unreadable.add('dispatch')
    expect(await ship(resumed, 2)).toMatchObject({kind: 'complete', deploy: 'unreadable'})
  })
})

describe('publication driver: deployment freshness', () => {
  const publishThrough = (world: World, last: WriteKey) => {
    const {identity} = world
    const steps: [WriteKey, WriteAction][] = [
      ['create-draft', {kind: 'create-draft', identity}],
      ['create-tag', {kind: 'create-tag', version: identity.version, source: SOURCE}],
      ['alias:version', {kind: 'create-alias', alias: 'version', name: identity.version, digest: identity.digest}],
      ['alias:sha', {kind: 'create-alias', alias: 'sha', name: SHA_ALIAS, digest: identity.digest}],
      ['publish-release', {kind: 'publish-release', version: identity.version}],
    ]
    for (const [key, action] of steps) {
      world.effect(action)
      if (key === last) return
    }
  }

  it('does not offer deployment when a new attempt 1 finds a prior draft, even with no recorded send', async () => {
    for (const last of ['create-draft', 'create-tag', 'alias:version', 'alias:sha'] as const) {
      const world = gated()
      publishThrough(world, last)
      world.writes.length = 0
      expect(world.dispatch).toBe('never-sent')
      expect(await ship(world, 1), last).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
      expect(world.writes.length).toBeGreaterThan(0)
      expectPublishedOnce(world)
    }
  })

  it('does not offer deployment when a new attempt 1 repairs a public release whose latest is still the old one', async () => {
    const world = gated()
    publishThrough(world, 'publish-release')
    expect(world.images.get('latest')).toBe(PREDECESSOR.digest)
    world.writes.length = 0
    expect(await ship(world, 1)).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
    expect(world.writes).toEqual(['set-latest'])
    expectPublishedOnce(world)
  })

  it('treats a second invocation in the same attempt as a resume, not a fresh publication', async () => {
    const world = new World()
    world.faults.push({op: 'create-tag', mode: 'before'})
    expect(await ship(world, 1)).toMatchObject({kind: 'stop', reason: 'write-unconfirmed'})
    expect(await ship(world, 1)).toMatchObject({kind: 'complete', deploy: 'not-fresh'})
  })
})

describe('publication policy: candidate origin for gate evidence', () => {
  it('requires one verified candidate with the same run, attempt, version and digest as passing evidence', () => {
    const missing = gated()
    missing.builds.length = 0
    expect(planOf(missing)).toMatchObject({kind: 'stop', reason: 'candidate-missing'})

    const noDigest = gated()
    at(noDigest.builds).digest = null
    expect(planOf(noDigest)).toMatchObject({kind: 'stop', reason: 'candidate-missing'})

    const otherRun = gated()
    at(otherRun.evidence).runId = 999
    expect(planOf(otherRun)).toMatchObject({kind: 'stop', reason: 'candidate-missing'})

    const otherAttempt = gated()
    at(otherAttempt.evidence).attempt = 2
    expect(planOf(otherAttempt)).toMatchObject({kind: 'stop', reason: 'candidate-missing'})

    const moved = gated()
    at(moved.builds).digest = digestOf(7)
    expect(planOf(moved)).toMatchObject({kind: 'stop', reason: 'candidate-mismatch'})

    const duplicate = gated()
    duplicate.builds.push({...at(duplicate.builds)})
    expect(planOf(duplicate)).toMatchObject({kind: 'stop', reason: 'candidate-ambiguous'})

    const conflicting = gated()
    conflicting.builds.push({...at(conflicting.builds), digest: digestOf(7)})
    expect(planOf(conflicting)).toMatchObject({kind: 'stop', reason: 'candidate-ambiguous'})

    expect(planOf(gated())).toMatchObject({kind: 'act', action: {kind: 'create-draft'}})
  })

  it('also requires the candidate for a draft that already exists', () => {
    const world = gated()
    world.effect({kind: 'create-draft', identity: world.identity})
    world.builds.length = 0
    expect(planOf(world)).toMatchObject({kind: 'stop', reason: 'candidate-missing'})
  })

  it('never mints a draft from orphan gate proof and never rebuilds to replace a gated identity', async () => {
    const dropBuilds = (w: World) => {
      w.builds.length = 0
    }
    const dropDigest = (w: World) => {
      at(w.builds).digest = null
    }
    for (const setup of [dropBuilds, dropDigest]) {
      const world = gated()
      setup(world)
      const before = {allocate: world.allocateCalls, builds: structuredClone(world.builds)}
      expect(await ship(world, 2)).toMatchObject({kind: 'stop', reason: 'candidate-missing'})
      expect(world.writes).toEqual([])
      expect(world.releases.size).toBe(0)
      expect(world.allocateCalls).toBe(before.allocate)
      expect(world.builds).toEqual(before.builds)
    }
  })
})

describe('publication driver: adapter contract', () => {
  it('hands the selected version, source and SHA alias to the artifact reader', async () => {
    const world = new World()
    const seen: ArtifactTarget[] = []
    const base = world.ports()
    const ports: PublicationPorts = {...base, observeArtifacts: async target => {
      seen.push(target)
      return base.observeArtifacts(target)
    }}
    expect(await ship(world, 1, ports)).toMatchObject({kind: 'complete'})
    expect(seen.length).toBeGreaterThan(0)
    for (const target of seen) expect(target).toEqual({version: '2026.11.3', source: SOURCE, shaAlias: SHA_ALIAS})
    expect(world.images.get(SHA_ALIAS)).toBe(world.identity.digest)
  })

  it('never exposes a raw thrown error in the public outcome', async () => {
    const sentinel = 'SENTINEL ghp_secret https://api.github.com/repos/x 500 Server Error'
    const fail = async (): Promise<never> => {
      throw new Error(sentinel)
    }
    const outcomeWith = async (override: Partial<PublicationPorts>) => {
      const world = gated()
      return reconcilePublication({...world.ports(), ...override}, {attempt: 1})
    }
    const outcomes = [
      await outcomeWith({observeRecords: fail}),
      await outcomeWith({observeArtifacts: fail}),
      await outcomeWith({apply: fail}),
    ]
    expect(outcomes).toEqual([
      {kind: 'stop', reason: 'observe-failed', detail: 'records'},
      {kind: 'stop', reason: 'observe-failed', detail: 'artifacts'},
      {kind: 'stop', reason: 'write-unconfirmed', detail: 'create-draft'},
    ])
    expect(JSON.stringify(outcomes)).not.toMatch(/SENTINEL|ghp_|api\.github\.com/)
  })
})

describe('publication policy: missing records and conflicting evidence', () => {
  const arrangements: [string, (w: World) => void][] = [
    ['tag', w => w.tags.set(w.version, SOURCE)],
    ['version alias', w => w.images.set(w.version, w.identity.digest)],
    ['sha alias', w => w.images.set(SHA_ALIAS, w.identity.digest)],
    ['latest', w => w.images.set('latest', w.identity.digest)],
  ]

  it.each(arrangements)('stops release-record-missing when the %s already matches and no draft or record exists', async (_name, arrange) => {
    const world = gated()
    arrange(world)
    expect(planOf(world)).toMatchObject({kind: 'stop', reason: 'release-record-missing'})
    expect(await reconcilePublication(world.ports(), {attempt: 1})).toMatchObject({kind: 'stop', reason: 'release-record-missing'})
    expect(world.writes).toEqual([])
  })

  it('still reports conflicts before a missing record', () => {
    const world = gated()
    world.tags.set(world.version, MAIN_TIP)
    expect(planOf(world)).toMatchObject({kind: 'stop', reason: 'tag-conflict'})
  })

  it('stops, rather than recreating the draft or deploying, when the release is deleted after a full attempt-1 publish', async () => {
    const world = gated()
    expect(await reconcilePublication(world.ports(), {attempt: 1})).toMatchObject({kind: 'complete', deploy: 'eligible'})
    world.releases.delete(world.version)
    const writes = world.writes.length
    for (const ctx of [{attempt: 1, created: true}, {attempt: 1, created: false}, {attempt: 2, created: false}]) {
      expect(planOf(world, ctx)).toMatchObject({kind: 'stop', reason: 'release-record-missing'})
    }
    expect(await reconcilePublication(world.ports(), {attempt: 1})).toMatchObject({kind: 'stop', reason: 'release-record-missing'})
    expect(world.writes).toHaveLength(writes)
    expect(world.releases.size).toBe(0)
  })

  it('stops on a non-CalVer release tag whose body identifies this source, and ignores one for another source', () => {
    const retagged = {draft: false, verified: true, identity: {version: '2026.11.3', source: SOURCE, digest: digestOf(3), notes: NOTES}}
    for (const world of [new World(), gated()]) {
      world.releases.set('v2026.11.3', retagged)
      expect(planOf(world)).toMatchObject({kind: 'stop', reason: 'malformed-release'})
    }
    const unrelated = new World()
    unrelated.releases.set('v1', {...retagged, identity: {...retagged.identity, source: OTHER_SOURCE}})
    unrelated.releases.set('notes', {draft: false, verified: false, identity: null})
    expect(planOf(unrelated)).toEqual({kind: 'act', action: {kind: 'allocate'}})
  })

  it.each([
    ['failed smoke', {smoke: 'fail'}],
    ['failed trivy', {trivy: {enforced: true, result: 'fail'}}],
  ] as const)('stops gate-conflict when a verified %s verdict contradicts a pass for the same digest', async (_name, failing) => {
    const world = gated()
    world.gate(undefined, failing)
    expect(planOf(world)).toMatchObject({kind: 'stop', reason: 'gate-conflict'})
    const staged = gated()
    staged.effect({kind: 'create-draft', identity: staged.identity})
    staged.writes.length = 0
    staged.gate(undefined, failing)
    expect(planOf(staged)).toMatchObject({kind: 'stop', reason: 'gate-conflict'})
    expect(await reconcilePublication(staged.ports(), {attempt: 1})).toMatchObject({kind: 'stop', reason: 'gate-conflict'})
    expect(staged.writes).toEqual([])
  })

  it('leaves distinct digests and all-failed rebuilds alone', () => {
    const distinct = gated()
    distinct.evidence.push({...at(distinct.evidence), runId: 999, digest: digestOf(8), smoke: 'fail'})
    expect(planOf(distinct)).toEqual({kind: 'act', action: {kind: 'create-draft', identity: distinct.identity}})

    const allFailed = new World()
    allFailed.effect({kind: 'allocate'})
    allFailed.build()
    allFailed.gate(undefined, {smoke: 'fail'})
    allFailed.gate(undefined, {trivy: {enforced: true, result: 'fail'}})
    expect(planOf(allFailed)).toEqual({kind: 'act', action: {kind: 'build', version: '2026.11.3'}})
  })

  it('settles a foreign record only for the same version and source of a verified public release', () => {
    const world = gated()
    replay(world)
    world.builds.push({runId: 9, attempt: 1, version: world.version, source: OTHER_SOURCE, digest: null, verified: true})
    expect(planOf(world)).toMatchObject({kind: 'stop', reason: 'other-unresolved', detail: world.version})
  })
})
