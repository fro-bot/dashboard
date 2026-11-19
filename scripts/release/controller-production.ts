import type {CandidateInput, CandidatePort} from './candidate-github.ts'
import type {CommitFacts, ImageObservation, LocalObservation} from './controller-io.ts'
import type {RuntimeDependencies} from './controller-runtime.ts'
import type {AuthorizationRecord} from './controller.ts'
import type {GitHubApi} from './github-release-api.ts'
import type {Known} from './publication.ts'
import type {Predecessor, PredecessorObservations, PublicRelease} from './recovery.ts'
import type {Allocation} from './release-evidence.ts'
import type {ControllerConfig} from './run-controller.ts'
import {holdProof} from './candidate-github.ts'
import {readCurrentRun} from './controller-runtime.ts'
import {listHeldArtifacts, observeLegacyGate, readAuthorizationById} from './github-release-history.ts'
import {observeSettledReleaseMerge} from './github-release-proof.ts'
import {observeHandoff, observePredecessor, readPublicReleases, readVersionRef} from './github-release-state.ts'
import {parseReleaseBody} from './publisher.ts'
import {readReleaseReceipt} from './release-receipt.ts'

/** Scoped local operations. syncObjects must fetch and verify these exact object IDs. */
export interface ReleaseStateIO {
  repoDir: string
  syncObjects: (refs: {main: string; candidate: string | null}) => Promise<void>
  firstParent: (repoDir: string, main: string) => Promise<LocalObservation<string[]>>
  pushCandidate: CandidatePort['pushCandidate']
  commit: (repoDir: string, sha: string) => Promise<LocalObservation<CommitFacts>>
  image: (tag: string) => Promise<ImageObservation>
  nextVersion: () => Promise<{state: 'present'; value: string} | {state: 'absent'} | {state: 'unknown'; reason: 'malformed' | 'read-failed'}>
  /** Independently verify source, merge association, artifact origin and authorization. */
  provedSource: (sha: string, history: string[]) => Promise<AuthorizationRecord | null>
  /** Independently authenticate allocation, candidate digest and gate seal. */
  releaseProof: (identity: Predecessor, history: string[]) => Promise<PredecessorObservations['gate']>
  /** Complete authenticated allocations for this source, including rivals. */
  allocations: (source: string, history: string[]) => Promise<Known<Allocation[]>>
}

const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const untouchedHold = (labels: unknown, timeline: unknown): boolean => Array.isArray(labels) && labels.every(label => object(label) && typeof label.name === 'string' && label.name !== 'release-hold') && Array.isArray(timeline) && timeline.every(event => {
  if (!object(event) || typeof event.event !== 'string') return false
  if (event.event !== 'labeled' && event.event !== 'unlabeled') return true
  return object(event.label) && typeof event.label.name === 'string' && event.label.name !== 'release-hold'
})

function refSha(value: unknown, ref: string): string {
  if (!object(value) || value.ref !== ref || !object(value.object) || value.object.type !== 'commit' || !sha(value.object.sha)) throw new Error('Invalid release ref')
  return value.object.sha
}

/** Observe the settled predecessor and at most one independently proved in-flight source. */
export function createReleaseState(config: ControllerConfig, api: GitHubApi, io: ReleaseStateIO): RuntimeDependencies {
  async function snapshot() {
    if (api.repo !== 'fro-bot/dashboard') throw new Error('Invalid repository')
    const [mainRef, candidateRef, releases] = await Promise.all([
      api.get('/git/ref/heads/main'),
      api.getOptional('/git/ref/heads/release/pending'),
      readPublicReleases(api),
    ])
    const main = refSha(mainRef, 'refs/heads/main')
    const candidate = candidateRef === null ? null : refSha(candidateRef, 'refs/heads/release/pending')
    if (releases.state !== 'present') throw new Error('Release list unavailable')
    await io.syncObjects({main, candidate})
    const history = await io.firstParent(io.repoDir, main)
    if (history.state !== 'present' || history.value[0] !== main || !history.value.every(sha) || new Set(history.value).size !== history.value.length) throw new Error('History unavailable')
    return {main, history: history.value, releases}
  }
  async function state() {
    const snap = await snapshot()
    const context = {repositoryId: config.repositoryId, firstParent: snap.history, current: {runId: config.runId, attempt: config.attempt}}
    const unknown = {main: snap.main, repoDir: io.repoDir, predecessor: null, predecessorCandidate: undefined as CandidateInput['predecessor'], clearanceRoot: null as number | null, prior: {state: 'unknown' as const}, record: null, pendingSha: null as string | null, snap, allocations: null as Known<Allocation[]> | null}
    const pending = {source: null as string | null}
    const settled = new Map<PublicRelease, Promise<{pr: number; head: string} | null>>()
    const settledSource = async (release: PublicRelease, identity: Predecessor) => {
      let proof = settled.get(release)
      if (!proof) {
        proof = (async () => {
          try {
            const index = snap.history.indexOf(identity.source)
            const parent = snap.history[index + 1]
            if (index === -1 || parent === undefined || release.draft || release.prerelease || release.tag !== identity.version || release.id === undefined || release.author === undefined) return null
            const [bot, commit] = await Promise.all([api.botUser(config.appSlug), io.commit(io.repoDir, identity.source)])
            if (!bot || release.author.id !== bot.id || release.author.login !== bot.login || release.author.type !== 'Bot' || commit.state !== 'present' || commit.value.sha !== identity.source || commit.value.parents.length !== 1 || commit.value.parents[0] !== parent || commit.value.paths.length !== 1 || commit.value.paths[0] !== 'docs/releases/batch.md') return null
            const receipt = await readReleaseReceipt(api, {...identity, repo: api.repo, releaseId: release.id}, bot)
            if (receipt.state !== 'present') return null
            return await observeSettledReleaseMerge(api, commit.value, {appId: config.appId, botId: bot.id, botLogin: bot.login})
          } catch { return null }
        })()
        settled.set(release, proof)
      }
      return proof
    }
    const found = await observePredecessor({repo: api.repo, firstParent: {state: 'present', value: snap.history}, releases: snap.releases}, {
      api,
      image: io.image,
      gate: async (identity, release) => {
        const commit = await io.commit(io.repoDir, identity.source)
        if (commit.state !== 'present' || commit.value.sha !== identity.source || !sha(commit.value.tree) || !Array.isArray(commit.value.parents) || !commit.value.parents.every(sha) || !Array.isArray(commit.value.paths) || !commit.value.paths.every(path => typeof path === 'string') || typeof commit.value.message !== 'string') return {state: 'unknown', reason: 'malformed'}
        if (commit.value.paths.includes('docs/releases/batch.md') || /fro-release-authorization\s*:/iu.test(commit.value.message)) {
          return await settledSource(release, identity) ? {state: 'present', value: {...identity, smoke: 'pass', trivy: 'pass', enforced: true}} : {state: 'unknown', reason: 'malformed'}
        }
        return observeLegacyGate(api, context, identity)
      },
      pending: async identity => {
        const latest = await io.image('latest')
        if (latest.state !== 'present') return {state: 'unknown', reason: 'read-failed'}
        if (latest.value.digest === identity.digest) return {state: 'absent'}
        const [gate, source] = await Promise.all([io.releaseProof(identity, snap.history), io.provedSource(identity.source, snap.history)])
        if (gate.state !== 'present' || gate.value.version !== identity.version || gate.value.source !== identity.source || gate.value.digest !== identity.digest || gate.value.smoke !== 'pass' || gate.value.trivy !== 'pass' || !gate.value.enforced || !source) return {state: 'unknown', reason: 'malformed'}
        pending.source = identity.source
        return {state: 'present', value: identity}
      },
    })
    if (found.kind !== 'predecessor') return unknown
    const predecessor = found.predecessor
    let predecessorCandidate: CandidateInput['predecessor']
    let clearanceRoot: number | null = null
    try {
      const releases = snap.releases.value.filter(release => !release.draft && !release.prerelease && /^\d{4}\.\d{2}\.\d+$/u.test(release.tag)).map(release => ({release, identity: parseReleaseBody(api.repo, release.body)}))
      if (releases.some(({release, identity}) => !identity || identity.version !== release.tag) || new Set(releases.map(({release}) => release.tag)).size !== releases.length) throw new Error('Ambiguous releases')
      releases.sort((a, b) => {
        const left = a.release.tag.split('.').map(BigInt)
        const right = b.release.tag.split('.').map(BigInt)
        for (let i = 0; i < 3; i++) {
          if ((left[i] ?? 0n) !== (right[i] ?? 0n)) return (left[i] ?? 0n) > (right[i] ?? 0n) ? -1 : 1
        }
        return 0
      })
      for (let i = 1; i < releases.length; i++) {
        const newer = releases[i - 1]?.release.tag.split('.').map(BigInt)
        const older = releases[i]?.release.tag.split('.').map(BigInt)
        if (!newer || !older || newer.every((part, index) => part === older[index])) throw new Error('Ambiguous release version')
      }
      const start = releases.findIndex(entry => entry.identity?.source === predecessor.source && entry.release.tag === predecessor.version)
      if (start === -1) throw new Error('Predecessor missing')
      let newerIndex = -1
      for (const entry of releases.slice(start)) {
        const identity = entry.identity
        if (!identity) throw new Error('Malformed release')
        const index = snap.history.indexOf(identity.source)
        if (index === -1 || (newerIndex !== -1 && index <= newerIndex)) throw new Error('Unordered release')
        if (newerIndex !== -1) {
          for (let i = newerIndex + 1; i < index; i++) {
            const current = snap.history[i]
            const parent = snap.history[i + 1]
            if (current === undefined || parent === undefined) throw new Error('Incomplete history')
            const facts = await io.commit(io.repoDir, current)
            if (facts.state !== 'present' || facts.value.sha !== current || facts.value.parents[0] !== parent || facts.value.paths.includes('docs/releases/batch.md') || /fro-release-authorization\s*:/iu.test(facts.value.message)) throw new Error('Ambiguous release interval')
          }
        }
        newerIndex = index
        if (identity.source !== predecessor.source) {
          const [tag, versionImage, shaImage] = await Promise.all([readVersionRef(api, identity.version), io.image(identity.version), io.image(`sha-${identity.source.slice(0, 7)}`)])
          if (tag.state !== 'present' || tag.value.sha !== identity.source || versionImage.state !== 'present' || versionImage.value.digest !== identity.digest || shaImage.state !== 'present' || shaImage.value.digest !== identity.digest) throw new Error('Unproved historical aliases')
        }
        const proof = await settledSource(entry.release, identity)
        if (!proof) throw new Error('Unproved release')
        if (!predecessorCandidate) predecessorCandidate = {number: proof.pr, head: proof.head, merge: predecessor.source, clearance: 'unknown'}
        const [labels, timeline] = await Promise.all([api.pages(`/issues/${proof.pr}/labels`), api.pages(`/issues/${proof.pr}/timeline`)])
        const clearance = holdProof({labels, timeline, ownerId: config.ownerId})
        if (clearance === 'held') {
          predecessorCandidate.clearance = 'held'
          break
        }
        if (clearance === 'cleared') {
          predecessorCandidate.clearance = 'cleared'
          clearanceRoot = proof.pr
          break
        }
        if (!untouchedHold(labels, timeline)) break
      }
    } catch {
      // A missing predecessor PR proof must not manufacture carry clearance.
    }
    const uncertain = {...unknown, predecessor, predecessorCandidate, clearanceRoot}
    const end = snap.history.indexOf(predecessor.source)
    if (end === -1) return uncertain
    let record: AuthorizationRecord | null = null
    let pendingSha: string | null = null
    for (let i = 0; i < end; i++) {
      const commitSha = snap.history[i]
      const parent = snap.history[i + 1]
      if (commitSha === undefined || parent === undefined) return uncertain
      const result = await io.commit(io.repoDir, commitSha)
      if (result.state !== 'present') return uncertain
      const facts = result.value
      if (facts.sha !== commitSha || !sha(facts.tree) || !Array.isArray(facts.parents) || facts.parents[0] !== parent || !facts.parents.every(sha) || !Array.isArray(facts.paths) || !facts.paths.every(path => typeof path === 'string') || typeof facts.message !== 'string') return uncertain
      if (!facts.paths.includes('docs/releases/batch.md') && !/fro-release-authorization\s*:/iu.test(facts.message)) continue
      if (record || facts.parents.length !== 1 || facts.paths.length !== 1 || facts.paths[0] !== 'docs/releases/batch.md') return uncertain
      const trailers = facts.message.replace(/\n+$/u, '').split('\n')
      const last = trailers.at(-1) ?? ''
      const match = /^Fro-Release-Authorization: ([1-9]\d*)$/u.exec(last)
      if (!match || trailers.at(-2) !== '' || trailers.filter(line => /^\s*fro-release-authorization\s*:/iu.test(line)).length !== 1) return uncertain
      const id = Number(match[1])
      const proof = await io.provedSource(commitSha, snap.history)
      if (!Number.isSafeInteger(id) || !proof || !proof.origin.verified || proof.origin.artifactId !== id || proof.origin.repo !== api.repo || proof.origin.workflow !== '.github/workflows/held-release.yaml' || proof.origin.revision !== parent || proof.authorization.base !== parent || proof.authorization.tree !== facts.tree || proof.authorization.repo !== api.repo || (proof.authorization.authority.kind === 'review' && proof.authorization.authority.userId !== config.ownerId)) return uncertain
      record = proof
      pendingSha = commitSha
      if (pending.source !== null && pending.source !== commitSha) return uncertain
    }
    if (pending.source !== null && !record) return uncertain
    const drafts = snap.releases.value.filter(release => release.draft)
    let allocations: Known<Allocation[]> | null = null
    if (drafts.length > 0) {
      const draft = drafts[0]
      if (drafts.length !== 1 || !draft || !record || pendingSha === null || draft.prerelease) return uncertain
      const identity = parseReleaseBody(api.repo, draft.body)
      if (!identity || identity.version !== draft.tag || identity.source !== pendingSha) return uncertain
      allocations = await io.allocations(pendingSha, snap.history)
      if (allocations.state !== 'present' || allocations.value.length === 0) return uncertain
      const seen = new Set<string>()
      let present = 0
      for (const allocation of allocations.value) {
        if (allocation.source !== pendingSha || allocation.version !== identity.version || allocation.tag !== `ci-${allocation.runId}-${allocation.attempt}` || !Number.isSafeInteger(allocation.runId) || allocation.runId <= 0 || !Number.isSafeInteger(allocation.attempt) || allocation.attempt <= 0 || seen.has(allocation.tag)) return uncertain
        seen.add(allocation.tag)
        const image = await io.image(allocation.tag)
        if (image.state === 'unknown' || (image.state === 'present' && image.value.digest !== identity.digest)) return uncertain
        if (image.state === 'present') present++
      }
      if (present !== 1) return uncertain
      allocations = {state: 'present', value: allocations.value.map(value => ({...value}))}
    }
    return {...uncertain, prior: record ? {state: 'unresolved' as const, artifactId: record.origin.artifactId} : {state: 'clear' as const}, record, pendingSha, allocations}
  }
  async function slotUsed(): Promise<boolean> {
    try {
      if (config.event !== 'schedule' || !['0 15 * * 0', '0 15 * * 3'].includes(config.schedule ?? '')) return true
      const [current, state] = await Promise.all([readCurrentRun(api, config), snapshot()])
      if (!current || state.main !== config.revision) return true
      const date = new Date(current.createdAt)
      if (!Number.isFinite(date.getTime()) || date.getUTCHours() < 15 || date.getUTCDay() !== (config.schedule === '0 15 * * 0' ? 0 : 3)) return true
      const since = `${date.toISOString().slice(0, 10)}T00:00:00Z`
      const artifacts = await listHeldArtifacts(api, {repositoryId: config.repositoryId, firstParent: state.history, current: {runId: config.runId, attempt: config.attempt}}, since)
      const anchor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 15)
      const end = anchor + 9 * 60 * 60 * 1000
      return artifacts.state !== 'present' || artifacts.value.some(a => a.kind === 'authorization' && a.runEvent === 'schedule' && Date.parse(a.runCreatedAt) >= anchor && Date.parse(a.runCreatedAt) < end && (a.runId !== config.runId || a.attempt !== config.attempt))
    } catch {
      return true
    }
  }
  return {
    load: async () => {
      const result = await state()
      return {main: result.main, repoDir: result.repoDir, predecessor: result.predecessor, predecessorCandidate: result.predecessorCandidate, prior: result.prior}
    },
    scheduleState: async (pr, predecessorCandidate) => {
      const unknown = {hold: {state: 'unknown' as const, source: 'unknown' as const, pr, verified: false}, slotUsed: true}
      if (!Number.isSafeInteger(pr) || pr <= 0 || api.repo !== 'fro-bot/dashboard') return unknown
      try {
        const [labels, timeline, used] = await Promise.all([api.pages(`/issues/${pr}/labels`), api.pages(`/issues/${pr}/timeline`), slotUsed()])
        const hold = holdProof({labels, timeline, ownerId: config.ownerId})
        if (hold === 'cleared') return {hold: {state: 'clear', source: 'owner', pr, ownerId: config.ownerId, clearancePr: pr, verified: true}, slotUsed: used}
        if (hold === 'held') return {hold: {state: 'held', source: 'unknown', pr, verified: true}, slotUsed: used}
        if (untouchedHold(labels, timeline) && predecessorCandidate?.clearance === 'cleared' && predecessorCandidate.number !== pr) {
          const verified = await state()
          const previous = verified.predecessorCandidate
          if (verified.main === config.revision && previous?.clearance === 'cleared' && previous.number === predecessorCandidate.number && previous.head === predecessorCandidate.head && previous.merge === predecessorCandidate.merge && verified.clearanceRoot !== null) {
            const [finalLabels, finalTimeline] = await Promise.all([api.pages(`/issues/${pr}/labels`), api.pages(`/issues/${pr}/timeline`)])
            if (untouchedHold(finalLabels, finalTimeline)) return {hold: {state: 'clear', source: 'carry', pr, ownerId: config.ownerId, clearancePr: verified.clearanceRoot, carriedFromPr: previous.number, carryVerified: true, verified: true}, slotUsed: used}
          }
        }
        return {...unknown, slotUsed: used}
      } catch {
        return unknown
      }
    },
    pushCandidate: io.pushCandidate,
    authorization: async (artifactId, candidate) => {
      try {
        if (!candidate) {
          const current = await state()
          return current.main === config.revision && current.prior.state === 'unresolved' && current.prior.artifactId === artifactId ? current.record : null
        }
        if (candidate.repo !== api.repo || candidate.base !== config.revision) return null
        const current = await snapshot()
        if (current.main !== config.revision) return null
        const record = await readAuthorizationById(api, {repositoryId: config.repositoryId, firstParent: current.history, current: {runId: config.runId, attempt: config.attempt}}, artifactId, candidate)
        if (!record || record.origin.runId !== config.runId || record.origin.attempt !== config.attempt || record.origin.revision !== config.revision) return null
        const authority = record.authorization.authority
        if (authority.kind === 'review') {
          if (authority.userId !== config.ownerId || !(config.event === 'workflow_run' || (config.event === 'workflow_dispatch' && config.actorId === config.ownerId))) return null
        } else {
          if (config.event !== 'schedule' || !['0 15 * * 0', '0 15 * * 3'].includes(config.schedule ?? '')) return null
          const run = await readCurrentRun(api, config)
          if (!run) return null
          const date = new Date(run.createdAt)
          if (!Number.isFinite(date.getTime()) || date.getUTCHours() < 15 || date.getUTCDay() !== (config.schedule === '0 15 * * 0' ? 0 : 3) || authority.slot !== `${date.toISOString().slice(0, 10)}/${config.schedule}`) return null
        }
        return record
      } catch {
        return null
      }
    },
    recoveryRevision: async record => {
      try {
        const current = await state()
        return current.main === config.revision && current.prior.state === 'unresolved' && current.prior.artifactId === record.origin.artifactId &&
          current.record !== null && JSON.stringify(current.record) === JSON.stringify(record)
      } catch {
        return false
      }
    },
    handoff: async (source, recovery) => {
      try {
        const current = await state()
        if (!current.predecessor || current.prior.state !== 'unresolved' || current.pendingSha !== source || !current.snap.history.includes(source) || !current.record ||
          (!recovery && current.record.origin.revision !== config.revision) || (recovery && current.main !== config.revision)) return {kind: 'stop', reason: 'source-unproven'}
        const allocations = current.allocations ?? await io.allocations(source, current.snap.history)
        const immutable = allocations.state === 'present' ? {state: 'present' as const, value: allocations.value.map(value => ({...value}))} : allocations
        return await observeHandoff(source, current.predecessor, recovery, current.snap.releases, {
          repo: api.repo, api, image: io.image, allocations: async () => immutable, nextVersion: io.nextVersion,
          pending: async identity => {
            const gate = await io.releaseProof(identity, current.snap.history)
            return gate.state === 'present' && gate.value.version === identity.version && gate.value.source === identity.source && gate.value.digest === identity.digest && gate.value.smoke === 'pass' && gate.value.trivy === 'pass' && gate.value.enforced
              ? {state: 'present', value: identity}
              : {state: 'unknown', reason: 'malformed'}
          },
        })
      } catch {
        return {kind: 'stop', reason: 'observation-failed'}
      }
    },
  }
}
