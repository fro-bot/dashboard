/**
 * Pure discovery over complete, independently authenticated CLI observations.
 * `present` gate facts must come from completed legacy gates or held authorization and
 * gate seals; allocations must be authenticated with release-evidence.ts. Unknown,
 * expired, incomplete or untrusted reads must be passed as unknown, not as absence.
 * The caller checks all rival records and the proposed version's availability before
 * supplying allocatedVersion. This module neither reads nor allocates anything.
 */
import type {Known, Obs} from './publication.ts'
import type {Allocation} from './release-evidence.ts'
import {parseReleaseBody} from './publisher.ts'

export interface PublicRelease {tag: string; body: string; draft: boolean; prerelease: boolean; id?: number; author?: {id: number; login: string; type: string}}
export interface Predecessor {version: string; source: string; digest: string}
export interface PredecessorObservations {
  repo: string
  /** Complete first-parent main history, newest first. */
  firstParent: Known<string[]>
  tag: Obs<{version: string; sha: string}>
  versionAlias: Obs<{version: string; digest: string}>
  shaAlias: Obs<{name: string; digest: string}>
  latest: Obs<{digest: string}>
  /** Authenticated and completed legacy image gates, or held authorization and gates. */
  gate: Obs<{version: string; source: string; digest: string; smoke: 'pass' | 'fail'; trivy: 'pass' | 'fail'; enforced: boolean}>
}
interface Stop {kind: 'stop'; reason: string}
type Discovery = Stop | {kind: 'predecessor'; predecessor: Predecessor}
const stop = (reason: string): Stop => ({kind: 'stop', reason})
const sha = (s: string) => /^[a-f\d]{40}$/u.test(s)
const digest = (s: string) => /^sha256:[a-f\d]{64}$/u.test(s)
const calver = (s: string): bigint[] | null => {
  if (!/^\d{4}\.\d{2}\.\d+$/u.test(s)) return null
  return s.split('.').map(part => BigInt(part))
}
function compare(a: string, b: string): number {
  const x = calver(a)
  const y = calver(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) {
    const left = x[i] ?? 0n
    const right = y[i] ?? 0n
    if (left > right) return 1
    if (left < right) return -1
  }
  return 0
}

/** Refuse a damaged newest release rather than silently choosing older history. */
/** Select both lookup keys before the caller fetches version-specific facts. */
export function selectReleaseCandidates(releases: Known<PublicRelease[]>): Stop | {kind: 'candidates'; newest: PublicRelease; previous: PublicRelease | null} {
  if (releases.state !== 'present') return stop('releases-unknown')
  const eligible = releases.value.filter(r => !r.draft && !r.prerelease && calver(r.tag) !== null)
    .sort((a, b) => compare(b.tag, a.tag))
  const newest = eligible[0]
  if (!newest) return stop('predecessor-missing')
  if (eligible[1] && compare(newest.tag, eligible[1].tag) === 0) return stop('predecessor-ambiguous')
  if (eligible[1] && eligible[2] && compare(eligible[1].tag, eligible[2].tag) === 0) return stop('predecessor-ambiguous')
  return {kind: 'candidates', newest, previous: eligible[1] ?? null}
}

/**
 * Pending proof is independently authenticated authorization, candidate and gate
 * evidence for the newest public release, not an inference from its body. In this
 * mode all version-specific observations must describe the previous release.
 */
export function discoverPredecessor(releases: Known<PublicRelease[]>, o: PredecessorObservations, pending?: Obs<Predecessor>): Discovery {
  const selected = selectReleaseCandidates(releases)
  if (selected.kind === 'stop') return selected
  if (pending?.state === 'unknown') return stop('pending-unknown')
  let target = selected.newest
  if (pending?.state === 'present') {
    const found = parseReleaseBody(o.repo, selected.newest.body)
    const expected = pending.value
    if (!found || found.version !== selected.newest.tag || found.version !== expected.version ||
      found.source !== expected.source || found.digest !== expected.digest || !selected.previous) return stop('pending-invalid')
    target = selected.previous
  }
  const identity = parseReleaseBody(o.repo, target.body)
  if (!identity || identity.version !== target.tag || !sha(identity.source)) return stop('identity-invalid')
  const {version, source, digest: imageDigest} = identity
  if (o.firstParent.state !== 'present' || !o.firstParent.value.includes(source)) return stop('ancestry-unproven')
  if (pending?.state === 'present') {
    const pendingIndex = o.firstParent.value.indexOf(pending.value.source)
    if (pendingIndex === -1 || pendingIndex >= o.firstParent.value.indexOf(source)) return stop('pending-ancestry-unproven')
  }
  if (o.tag.state !== 'present' || o.tag.value.version !== version || o.tag.value.sha !== source) return stop('tag-unproven')
  if (o.versionAlias.state !== 'present' || o.versionAlias.value.version !== version || o.versionAlias.value.digest !== imageDigest) return stop('version-alias-unproven')
  if (o.shaAlias.state !== 'present' || o.shaAlias.value.name !== `sha-${source.slice(0, 7)}` || o.shaAlias.value.digest !== imageDigest) return stop('sha-alias-unproven')
  if (o.latest.state !== 'present' || o.latest.value.digest !== imageDigest) return stop('latest-unproven')
  if (o.gate.state !== 'present' || o.gate.value.version !== version || o.gate.value.source !== source ||
    o.gate.value.digest !== imageDigest || o.gate.value.smoke !== 'pass' || o.gate.value.trivy !== 'pass' || !o.gate.value.enforced) return stop('gates-unproven')
  return {kind: 'predecessor', predecessor: {version, source, digest: imageDigest}}
}

/** Each candidate read names exactly the CI alias of the authenticated allocation. */
export type CandidateAllocation = Allocation & {candidate: Obs<{digest: string}>}
export interface HandoffInput {
  /** Already independently proved authorized squash on first-parent main. */
  source: string
  predecessor: Predecessor
  /** Must be carried through publication to fence the fresh deploy offer. */
  recovery: boolean
  /** Complete authenticated allocation history, including rivals. */
  allocations: Known<CandidateAllocation[]>
  draft: Obs<{version: string; source: string; digest: string}>
  /** CLI-proposed version, only after complete GitHub, registry and rival checks. */
  allocatedVersion: Obs<string>
}
export type Handoff = Stop | {
  kind: 'handoff'
  source: string
  predecessor: Predecessor
  recovery: boolean
  version: string
  action: 'build' | 'gate'
  original: {runId: number; attempt: number; digest: string} | null
}

export function planHandoff(input: HandoffInput): Handoff {
  const {source, predecessor, recovery, allocations, draft, allocatedVersion} = input
  if (!sha(source) || !sha(predecessor.source) || source === predecessor.source || !calver(predecessor.version) || !digest(predecessor.digest)) return stop('source-or-predecessor-invalid')
  if (allocations.state !== 'present') return stop('allocations-unknown')
  if (draft.state === 'unknown') return stop('draft-unknown')
  if (allocatedVersion.state === 'unknown') return stop('version-unknown')
  const [allocation] = allocations.value
  const keys = new Set<string>()
  for (const item of allocations.value) {
    const key = `${item.runId}/${item.attempt}`
    if (item.source !== source || !Number.isSafeInteger(item.runId) || item.runId < 1 ||
      !Number.isSafeInteger(item.attempt) || item.attempt < 1 || item.tag !== `ci-${item.runId}-${item.attempt}` ||
      item.version !== allocation?.version || keys.has(key)) return stop('allocation-invalid')
    keys.add(key)
    if (item.candidate.state === 'unknown') return stop('candidate-unknown')
    if (item.candidate.state === 'present' && !digest(item.candidate.value.digest)) return stop('candidate-invalid')
  }
  const version = allocation?.version ?? (allocatedVersion.state === 'present' ? allocatedVersion.value : null)
  if (version === null || !calver(version) || compare(version, predecessor.version) <= 0) return stop('version-unproven')
  if (allocation && allocatedVersion.state === 'present' && allocatedVersion.value !== version) return stop('version-conflict')
  const candidates = allocations.value.filter(item => item.candidate.state === 'present')
  if (candidates.length > 1) return stop('candidate-ambiguous')
  const selected = candidates[0]
  const candidate = selected?.candidate.state === 'present' ? selected.candidate.value.digest : null
  if (draft.state === 'present' && (draft.value.version !== version || draft.value.source !== source || candidate === null || draft.value.digest !== candidate)) return stop('draft-conflict')
  const original = selected && candidate !== null ? {runId: selected.runId, attempt: selected.attempt, digest: candidate} : null
  return {kind: 'handoff', source, predecessor, recovery, version, action: original ? 'gate' : 'build', original}
}
