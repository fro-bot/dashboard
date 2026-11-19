/**
 * Publication and recovery policy for one authorized, proved squash.
 *
 * Pure policy plus a small driver over supplied observations and narrow ports. No network,
 * no GitHub/GHCR client and no credentials live here: the controller (U3B) adapts GitHub,
 * GHCR and Actions state into these observation shapes and performs the writes.
 *
 * Provenance contract for the adapter (the policy cannot check it, only refuse to trust it):
 * - `builds` are attempt-bound allocation/build records written to durable Actions evidence
 *   BEFORE the build, `digest` read from the original attempt's candidate CI tag (null only when
 *   that tag is authoritatively absent). Artifact REST metadata has no run_attempt and its head
 *   SHA is the controller revision, so `verified` must come from run/attempt lookup, not names.
 * - `evidence` is gate evidence bound to one version, source and digest: smoke success AND
 *   enforced Trivy success for that digest. A named SARIF artifact proves neither.
 * - `RunContext.attempt` is the CURRENT controller `github.run_attempt`, never a recorded build's.
 * - Neither the draft release body nor a user-supplied SHA is gate authority.
 */

export interface Unknown {state: 'unknown'; reason: 'read-failed' | 'ambiguous' | 'malformed'}
/** Authoritative presence, authoritative absence, or an unreadable/ambiguous/malformed read. */
export type Obs<T> = {state: 'present'; value: T} | {state: 'absent'} | Unknown
/** A read that is either complete (an empty list is authoritative absence) or unknown. */
export type Known<T> = {state: 'present'; value: T} | Unknown

export interface Identity {version: string; source: string; digest: string; notes: string}
export interface ReleaseRecord {tag: string; draft: boolean; verified: boolean; identity: Identity | null}
/** One candidate image: runId/attempt identify the run that BUILT it (its CI tag `ci-<run>-<attempt>`). */
export interface Build {runId: number; attempt: number; version: string; source: string; digest: string | null; verified: boolean}
/**
 * Gate proof for one candidate. runId/attempt name the CANDIDATE run that produced the image, not
 * the run that gated it: a later run may gate an existing candidate. The adapter authenticates the
 * gating artifact's own origin (repo, workflow, trusted revision, its run and attempt) separately
 * and sets `verified` only after that; the policy never sees the gating run.
 */
export interface Evidence {
  runId: number
  attempt: number
  version: string
  source: string
  digest: string
  verified: boolean
  smoke: 'pass' | 'fail'
  trivy: {enforced: boolean; result: 'pass' | 'fail'}
}
/** never-sent: no send was ever started. rejected: confirmed non-delivery. uncertain: started, outcome unknown. */
export type DispatchState = 'never-sent' | 'accepted' | 'rejected' | 'uncertain'

export interface Records {
  expected: {source: string | null; notes: string | null}
  /** The verified release this batch advances from; the only `latest` we may advance past. */
  predecessor: {version: string; digest: string} | null
  releases: Known<ReleaseRecord[]>
  builds: Known<Build[]>
  evidence: Known<Evidence[]>
}
/** What the adapter must read: one selected identity, so reads and writes share one key path. */
export interface ArtifactTarget {version: string; source: string; shaAlias: string}
export interface Artifacts {
  /** Echo of the requested target; the policy refuses artifacts read for any other target. */
  target: ArtifactTarget
  tagRef: Obs<{sha: string}>
  versionAlias: Obs<{digest: string}>
  shaAlias: Obs<{digest: string}>
  latest: Obs<{digest: string}>
  dispatch: Known<DispatchState>
}
export interface Observations extends Records {artifacts: Artifacts | null}

export type Action =
  | {kind: 'allocate'}
  | {kind: 'build'; version: string}
  | {kind: 'gate'; version: string; digest: string}
  | {kind: 'create-draft'; identity: Identity}
  | {kind: 'create-tag'; version: string; source: string}
  | {kind: 'create-alias'; alias: 'version' | 'sha'; name: string; digest: string}
  | {kind: 'publish-release'; version: string}
  | {kind: 'set-latest'; digest: string}

export type Deploy = 'eligible' | 'delivered' | 'not-delivered' | 'uncertain' | 'unreadable' | 'not-fresh'
export type Plan =
  | {kind: 'observe-artifacts'; target: ArtifactTarget}
  | {kind: 'act'; action: Action}
  | {kind: 'stop'; reason: string; detail?: string}
  | {kind: 'complete'; identity: Identity; deploy: Deploy}

export interface RunContext {
  /** Current `github.run_attempt` of the controller run (not a recorded build's attempt). */
  attempt: number
  /** This invocation found no draft or release and created and read back the initial draft. */
  created: boolean
}

export interface PublicationPorts {
  observeRecords: () => Promise<Records>
  observeArtifacts: (target: ArtifactTarget) => Promise<Artifacts>
  /** Performs one write. A throw may still have applied; the driver re-observes either way. */
  apply: (action: Extract<Action, {kind: 'allocate' | 'create-draft' | 'create-tag' | 'create-alias' | 'publish-release' | 'set-latest'}>) => Promise<void>
}

export type Outcome =
  | {kind: 'handoff'; action: Extract<Action, {kind: 'build' | 'gate'}>}
  | {kind: 'stop'; reason: string; detail?: string}
  | {kind: 'complete'; identity: Identity; deploy: Deploy}

const SHA = /^(?:[\da-f]{40}|[\da-f]{64})$/
const DIGEST = /^sha256:[\da-f]{64}$/
const CALVER = /^(\d{4})\.(\d{2})\.(\d+)$/
const MAX_STEPS = 16

const calver = (version: string): [number, number, number] | null => {
  const match = CALVER.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}
const compare = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const unique = <T>(values: T[]) => [...new Set(values)]
const passes = (e: Evidence) => e.smoke === 'pass' && e.trivy.enforced && e.trivy.result === 'pass'

/**
 * Next publication action for one proved squash, from complete observations. Every unknown,
 * ambiguous, malformed or disagreeing read stops with a precise reason; nothing here ever
 * deletes evidence, replaces a recorded identity, or allocates a new version to get past a
 * disagreement. Allocation happens only on authoritative absence of any record of this batch.
 */
export function planPublication(obs: Observations, ctx: RunContext): Plan {
  const stop = (reason: string, detail?: string): Plan => ({kind: 'stop', reason, ...(detail === undefined ? {} : {detail})})
  const {source, notes} = obs.expected
  if (source === null || !SHA.test(source)) return stop('source-unproven')
  if (notes === null) return stop('notes-unproven')
  const predecessor = obs.predecessor
  const predecessorTuple = predecessor && DIGEST.test(predecessor.digest) ? calver(predecessor.version) : null
  if (!predecessor || !predecessorTuple) return stop('predecessor-unproven')
  if (obs.releases.state !== 'present') return stop('releases-unreadable', obs.releases.reason)
  if (obs.builds.state !== 'present') return stop('builds-unreadable', obs.builds.reason)
  if (obs.evidence.state !== 'present') return stop('evidence-unreadable', obs.evidence.reason)

  // Release records: ours (this source) vs another batch, ignoring history older than the predecessor.
  const mine: ReleaseRecord[] = []
  const others: ReleaseRecord[] = []
  for (const record of obs.releases.value) {
    const tuple = calver(record.tag)
    if (!tuple) {
      // A retagged or mislabeled record that still names this source is ours, damaged: never ignore it.
      if (record.identity?.source === source) return stop('malformed-release', record.tag)
      continue
    }
    if (compare(tuple, predecessorTuple) <= 0) {
      if (record.identity?.source === source) return stop('already-released', record.tag)
      continue
    }
    if (!record.identity || record.identity.version !== record.tag) return stop('malformed-release', record.tag)
    ;(record.identity.source === source ? mine : others).push(record)
  }
  if (mine.length > 1) return stop('duplicate-release')
  const record = mine.at(0)

  const myBuilds = obs.builds.value.filter(b => b.source === source)
  const myEvidence = obs.evidence.value.filter(e => e.source === source)
  const validRun = (r: {runId: number; attempt: number}) => Number.isSafeInteger(r.runId) && r.runId > 0 && Number.isSafeInteger(r.attempt) && r.attempt > 0
  if (!myBuilds.every(validRun) || !myEvidence.every(validRun)) return stop('malformed-record')
  if (myBuilds.some(b => !b.verified) || myEvidence.some(e => !e.verified)) return stop('unverified-record')
  if (myBuilds.some(b => b.digest !== null && !DIGEST.test(b.digest)) || myEvidence.some(e => !DIGEST.test(e.digest))) {
    return stop('malformed-record')
  }
  const versions = unique([...myBuilds.map(b => b.version), ...myEvidence.map(e => e.version), ...(record ? [record.tag] : [])])
  if (versions.some(v => !calver(v))) return stop('malformed-record')
  if (versions.length > 1) return stop('conflicting-versions')
  const version = versions.at(0)
  const versionTuple = version === undefined ? null : calver(version)
  if (versionTuple && compare(versionTuple, predecessorTuple) <= 0) return stop('version-not-advancing', version)
  if (version !== undefined && others.some(r => r.tag === version)) return stop('version-collision', version)

  // Another batch's unresolved or newer publication blocks before any write or allocation.
  if (others.some(r => !r.draft && r.verified)) return stop('superseded')
  if (others.length > 0) return stop('other-unresolved', others.at(0)?.tag)
  // Settled only by a verified public release of the same version AND the same source.
  const settled = (item: {version: string; source: string}) =>
    obs.releases.state === 'present' && obs.releases.value.some(r => r.tag === item.version && !r.draft && r.verified && r.identity?.source === item.source)
  const foreign = [...obs.builds.value.filter(b => b.source !== source), ...obs.evidence.value.filter(e => e.source !== source)]
  for (const item of foreign) {
    const tuple = calver(item.version)
    if (tuple && compare(tuple, predecessorTuple) > 0 && !settled(item)) return stop('other-unresolved', item.version)
  }
  if (version === undefined) return {kind: 'act', action: {kind: 'allocate'}}

  // Gate authority: verified evidence bound to this version, source and digest; never a draft body.
  if (myEvidence.some(e => !e.trivy.enforced)) return stop('evidence-invalid')
  // Verified, enforced verdicts that disagree about one digest cannot authorize anything, even a draft.
  if (myEvidence.some(e => passes(e) && myEvidence.some(o => o.digest === e.digest && !passes(o)))) return stop('gate-conflict')
  const passing = unique(myEvidence.filter(passes).map(e => e.digest))
  if (passing.length > 1) return stop('conflicting-evidence')
  // A candidate run/attempt yields exactly one image: duplicates are ambiguous, never merged.
  const candidateKeys = myBuilds.map(b => `${b.runId}/${b.attempt}`)
  if (new Set(candidateKeys).size !== candidateKeys.length) return stop('candidate-ambiguous', 'duplicate')
  // Passing gate proof needs the authoritative original candidate with the same version and digest.
  // A missing candidate blocks automatic recovery; it is never a reason to rebuild a gated identity.
  for (const e of myEvidence.filter(passes)) {
    const candidate = myBuilds.find(b => b.runId === e.runId && b.attempt === e.attempt)
    if (!candidate || candidate.digest === null) return stop('candidate-missing')
    if (candidate.digest !== e.digest || candidate.version !== e.version) return stop('candidate-mismatch')
  }
  let identity: Identity
  if (record?.identity) {
    identity = record.identity
    if (identity.notes !== notes) return stop('notes-mismatch')
    if (!DIGEST.test(identity.digest)) return stop('malformed-release')
    const evidence = myEvidence.filter(e => e.digest === identity.digest)
    if (!evidence.some(passes)) {
      if (evidence.length > 0) return stop('gate-failed')
      return stop(myEvidence.length > 0 ? 'evidence-mismatch' : 'evidence-missing')
    }
  } else if (passing.length === 1) {
    identity = {version, source, digest: passing[0] ?? '', notes}
  } else {
    const failed = new Set(myEvidence.map(e => e.digest))
    const candidates = unique(myBuilds.flatMap(b => (b.digest !== null && !failed.has(b.digest) ? [b.digest] : [])))
    if (candidates.length > 1) return stop('candidate-ambiguous')
    const [candidate] = candidates
    return {kind: 'act', action: candidate === undefined ? {kind: 'build', version} : {kind: 'gate', version, digest: candidate}}
  }

  const artifacts = obs.artifacts
  const shaName = `sha-${source.slice(0, 7)}`
  const target: ArtifactTarget = {version, source, shaAlias: shaName}
  if (!artifacts) return {kind: 'observe-artifacts', target}
  const got = artifacts.target
  if (got.version !== version || got.source !== source || got.shaAlias !== shaName) return stop('artifacts-wrong-target')
  const {tagRef, versionAlias, shaAlias, latest} = artifacts
  if (tagRef.state === 'unknown') return stop('tag-unreadable', tagRef.reason)
  if (tagRef.state === 'present' && tagRef.value.sha !== source) return stop('tag-conflict')
  for (const [alias, read] of [['version', versionAlias], ['sha', shaAlias]] as const) {
    if (read.state === 'unknown') return stop('alias-unreadable', alias)
    if (read.state === 'present' && read.value.digest !== identity.digest) return stop('alias-conflict', alias)
  }
  if (latest.state === 'unknown') return stop('latest-unreadable', latest.reason)
  if (latest.state === 'absent') return stop('latest-unproven')
  if (latest.value.digest !== identity.digest && latest.value.digest !== predecessor.digest) return stop('latest-conflict')

  const act = (action: Action): Plan => ({kind: 'act', action})
  if (!record) {
    // No draft or release, yet public refs already carry our digest: the record was lost or deleted.
    // Never recreate it or deploy; conflicts above already stopped any ref that disagrees.
    const published = tagRef.state === 'present' || versionAlias.state === 'present' || shaAlias.state === 'present' || latest.value.digest === identity.digest
    return published ? stop('release-record-missing') : act({kind: 'create-draft', identity})
  }
  if (tagRef.state === 'absent') return act({kind: 'create-tag', version, source})
  if (versionAlias.state === 'absent') return act({kind: 'create-alias', alias: 'version', name: version, digest: identity.digest})
  if (shaAlias.state === 'absent') return act({kind: 'create-alias', alias: 'sha', name: shaName, digest: identity.digest})
  if (record.draft) return act({kind: 'publish-release', version})
  if (latest.value.digest !== identity.digest) return act({kind: 'set-latest', digest: identity.digest})

  // Verified publication. A send is offered once, and only to the fresh original attempt.
  const dispatch = artifacts.dispatch
  if (dispatch.state !== 'present') return {kind: 'complete', identity, deploy: 'unreadable'}
  const fresh = ctx.attempt === 1 && ctx.created
  const deploy: Deploy = {accepted: 'delivered', rejected: 'not-delivered', uncertain: 'uncertain', 'never-sent': fresh ? 'eligible' : 'not-fresh'}[dispatch.value] as Deploy
  return {kind: 'complete', identity, deploy}
}

// Only stable reasons leave this module: raw errors can carry URLs, tokens or response bodies.
const stopped = (reason: string, detail?: string): Outcome => ({kind: 'stop', reason, ...(detail === undefined ? {} : {detail})})

/**
 * Observe, plan, apply one write, then re-observe. Durable state is always re-read: a write
 * that threw may have applied (converge), and a write that claimed success may not have
 * (stop). build and gate are handed back; they run in credential-free jobs, not here.
 *
 * Deployment is offered (`eligible`) only to the original attempt (`run.attempt === 1`) in an
 * invocation that entered with no draft or release for this source and created and read back the
 * initial draft. Any draft or release at entry (repair of aliases, publish or `latest`, a new
 * recovery workflow's attempt 1, or a second invocation in the same attempt) yields `not-fresh`
 * regardless of the recorded dispatch state, so do the whole publication in one invocation.
 */
export async function reconcilePublication(ports: PublicationPorts, run: {attempt: number}): Promise<Outcome> {
  // True only once this invocation found no draft and created (and so read back) the initial one.
  let created = false
  const last: {key: string | null; threw: boolean} = {key: null, threw: false}
  for (let step = 0; step < MAX_STEPS; step++) {
    const ctx = {attempt: run.attempt, created}
    let plan: Plan
    let reading = 'records'
    try {
      const records = await ports.observeRecords()
      plan = planPublication({...records, artifacts: null}, ctx)
      if (plan.kind === 'observe-artifacts') {
        reading = 'artifacts'
        plan = planPublication({...records, artifacts: await ports.observeArtifacts(plan.target)}, ctx)
      }
    } catch {
      return stopped('observe-failed', reading)
    }
    if (plan.kind === 'observe-artifacts') return stopped('observe-failed', 'artifacts')
    if (plan.kind === 'stop') return stopped(plan.reason, plan.detail)
    if (plan.kind === 'complete') return plan
    const {action} = plan
    if (action.kind === 'build' || action.kind === 'gate') return {kind: 'handoff', action}
    const key = JSON.stringify(action)
    if (last.key === key) return stopped(last.threw ? 'write-unconfirmed' : 'write-unproven', action.kind)
    let threw = false
    try {
      await ports.apply(action)
    } catch {
      threw = true
    }
    if (action.kind === 'create-draft') created = true
    last.key = key
    last.threw = threw
  }
  return stopped('step-limit')
}
