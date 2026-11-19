import type {Known, Obs} from './publication.ts'
import type {Allocation} from './release-evidence.ts'
import {parseReleaseBody} from './publisher.ts'
import {discoverPredecessor, planHandoff, selectReleaseCandidates, type Handoff, type Predecessor, type PredecessorObservations, type PublicRelease} from './recovery.ts'

/** The App-authorized list is essential: the ordinary read token can hide drafts. */
export async function readPublicReleases(api: {releasePages: () => Promise<unknown[]>}): Promise<Known<PublicRelease[]>> {
  try {
    const records = await api.releasePages()
    if (!Array.isArray(records)) return {state: 'unknown', reason: 'malformed'}
    const releases: PublicRelease[] = []
    for (const record of records) {
      if (typeof record !== 'object' || record === null || Array.isArray(record)) return {state: 'unknown', reason: 'malformed'}
      const r = record as Record<string, unknown>
      if (typeof r.tag_name !== 'string' || typeof r.body !== 'string' || typeof r.draft !== 'boolean' || typeof r.prerelease !== 'boolean') return {state: 'unknown', reason: 'malformed'}
      let metadata: Pick<PublicRelease, 'id' | 'author'> = {}
      if (r.id !== undefined || r.author !== undefined) {
        if (!Number.isSafeInteger(r.id) || (r.id as number) <= 0 || typeof r.author !== 'object' || r.author === null || Array.isArray(r.author)) return {state: 'unknown', reason: 'malformed'}
        const author = r.author as Record<string, unknown>
        if (!Number.isSafeInteger(author.id) || (author.id as number) <= 0 || typeof author.login !== 'string' || !author.login || typeof author.type !== 'string' || !author.type) return {state: 'unknown', reason: 'malformed'}
        metadata = {id: r.id as number, author: {id: author.id as number, login: author.login, type: author.type}}
      }
      releases.push({tag: r.tag_name, body: r.body, draft: r.draft, prerelease: r.prerelease, ...metadata})
    }
    return {state: 'present', value: releases}
  } catch {
    return {state: 'unknown', reason: 'read-failed'}
  }
}

export async function readVersionRef(api: {pages: (path: string) => Promise<unknown[]>}, version: string): Promise<Obs<{version: string; sha: string}>> {
  if (!/^\d{4}\.\d{2}\.\d+$/u.test(version)) return {state: 'unknown', reason: 'malformed'}
  try {
    const refs = await api.pages(`/git/matching-refs/tags/${version}`)
    if (!Array.isArray(refs)) return {state: 'unknown', reason: 'malformed'}
    const exact: {sha: string; type: string}[] = []
    for (const value of refs) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return {state: 'unknown', reason: 'malformed'}
      const ref = value as Record<string, unknown>
      if (typeof ref.ref !== 'string' || !ref.ref.startsWith(`refs/tags/${version}`) || typeof ref.object !== 'object' || ref.object === null || Array.isArray(ref.object)) return {state: 'unknown', reason: 'malformed'}
      const object = ref.object as Record<string, unknown>
      if (typeof object.sha !== 'string' || !/^[a-f\d]{40}$/u.test(object.sha) || typeof object.type !== 'string') return {state: 'unknown', reason: 'malformed'}
      if (ref.ref === `refs/tags/${version}`) exact.push({sha: object.sha, type: object.type})
    }
    if (exact.length === 0) return {state: 'absent'}
    const ref = exact[0]
    return exact.length === 1 && ref?.type === 'commit' ? {state: 'present', value: {version, sha: ref.sha}} : {state: 'unknown', reason: 'malformed'}
  } catch {
    return {state: 'unknown', reason: 'read-failed'}
  }
}

export interface PredecessorPorts {
  api: {pages: (path: string) => Promise<unknown[]>}
  image: (tag: string) => Promise<Obs<{digest: string}>>
  /** Independently authenticate the exact source and digest's gates. */
  gate: (identity: Predecessor, release: PublicRelease) => Promise<PredecessorObservations['gate']>
  /** Present only for an independently proved authorized, gated public partial. */
  pending: (identity: Predecessor) => Promise<Obs<Predecessor>>
}
export async function observePredecessor(input: {repo: string; firstParent: Known<string[]>; releases: Known<PublicRelease[]>}, ports: PredecessorPorts): Promise<ReturnType<typeof discoverPredecessor>> {
  try {
    const selected = selectReleaseCandidates(input.releases)
    if (selected.kind === 'stop') return selected
    const newest = parseReleaseBody(input.repo, selected.newest.body)
    if (!newest || newest.version !== selected.newest.tag) return {kind: 'stop', reason: 'identity-invalid'}
    const pending = await ports.pending({version: newest.version, source: newest.source, digest: newest.digest})
    if (pending.state === 'unknown') return {kind: 'stop', reason: 'pending-unknown'}
    const target = pending.state === 'present' ? selected.previous : selected.newest
    if (!target) return {kind: 'stop', reason: 'predecessor-missing'}
    const identity = parseReleaseBody(input.repo, target.body)
    if (!identity || identity.version !== target.tag) return {kind: 'stop', reason: 'identity-invalid'}
    const {version, source, digest} = identity
    const [tag, versionImage, shaImage, latest, gate] = await Promise.all([
      readVersionRef(ports.api, version), ports.image(version), ports.image(`sha-${source.slice(0, 7)}`),
      ports.image('latest'), ports.gate({version, source, digest}, target),
    ])
    const versionAlias: PredecessorObservations['versionAlias'] = versionImage.state === 'present'
      ? {state: 'present', value: {version, digest: versionImage.value.digest}}
      : versionImage
    const shaAlias: PredecessorObservations['shaAlias'] = shaImage.state === 'present'
      ? {state: 'present', value: {name: `sha-${source.slice(0, 7)}`, digest: shaImage.value.digest}}
      : shaImage
    return discoverPredecessor(input.releases, {...input, tag, versionAlias, shaAlias, latest, gate}, pending)
  } catch {
    return {kind: 'stop', reason: 'observation-failed'}
  }
}

export interface HandoffPorts {
  repo: string
  api: PredecessorPorts['api']
  image: PredecessorPorts['image']
  /** Complete history of authenticated allocations, including rivals. */
  allocations: (source: string) => Promise<Known<Allocation[]>>
  nextVersion: () => Promise<Obs<string>>
  pending: PredecessorPorts['pending']
}
/** Source and all allocation/partial proofs must be authenticated independently by the caller. */
export async function observeHandoff(source: string, predecessor: Predecessor, recovery: boolean, releases: Known<PublicRelease[]>, ports: HandoffPorts): Promise<Handoff> {
  try {
    if (!/^[a-f\d]{40}$/u.test(source)) return {kind: 'stop', reason: 'source-invalid'}
    if (releases.state !== 'present') return {kind: 'stop', reason: 'releases-unknown'}
    const compare = (a: string, b: string): number | null => {
      if (!/^\d{4}\.\d{2}\.\d+$/u.test(a) || !/^\d{4}\.\d{2}\.\d+$/u.test(b)) return null
      const left = a.split('.').map(BigInt)
      const right = b.split('.').map(BigInt)
      for (let i = 0; i < 3; i++) {
        if ((left[i] ?? 0n) > (right[i] ?? 0n)) return 1
        if ((left[i] ?? 0n) < (right[i] ?? 0n)) return -1
      }
      return 0
    }
    let record: {version: string; source: string; digest: string; draft: boolean} | null = null
    for (const release of releases.value) {
      const order = compare(release.tag, predecessor.version)
      if (order === null) {
        if (release.draft) return {kind: 'stop', reason: 'rival-release'}
        continue
      }
      if (order <= 0 && !release.draft) continue
      const identity = parseReleaseBody(ports.repo, release.body)
      if (!identity || identity.version !== release.tag || identity.source !== source || release.prerelease || order <= 0 || record) return {kind: 'stop', reason: 'rival-release'}
      record = {...identity, draft: release.draft}
    }
    const allocations = await ports.allocations(source)
    if (allocations.state !== 'present') return {kind: 'stop', reason: 'allocations-unknown'}
    if (allocations.value.some(a => a.source !== source || !Number.isSafeInteger(a.runId) || a.runId < 1 || !Number.isSafeInteger(a.attempt) || a.attempt < 1 || a.tag !== `ci-${a.runId}-${a.attempt}`)) return {kind: 'stop', reason: 'allocation-invalid'}
    const candidates = await Promise.all(allocations.value.map(async a => ({...a, candidate: await ports.image(a.tag)})))
    if (record && candidates.length === 0) return {kind: 'stop', reason: 'allocation-missing'}
    if (record && !record.draft) {
      const proof = await ports.pending(record)
      if (proof.state !== 'present' || proof.value.version !== record.version || proof.value.source !== record.source || proof.value.digest !== record.digest) return {kind: 'stop', reason: 'pending-unproven'}
    }
    const shaAlias = await ports.image(`sha-${source.slice(0, 7)}`)
    if (shaAlias.state === 'unknown') return {kind: 'stop', reason: 'availability-unknown'}
    if (candidates.length === 0 && shaAlias.state !== 'absent') return {kind: 'stop', reason: 'alias-conflict'}
    const allocatedVersion = candidates.length === 0 ? await ports.nextVersion() : {state: 'absent' as const}
    const version = candidates[0]?.version ?? (allocatedVersion.state === 'present' ? allocatedVersion.value : null)
    if (version === null) return {kind: 'stop', reason: 'version-unknown'}
    if (!/^\d{4}\.\d{2}\.\d+$/u.test(version)) return {kind: 'stop', reason: 'version-invalid'}
    if (releases.value.some(r => r.tag === version && (!record || r.tag !== record.version))) return {kind: 'stop', reason: 'rival-release'}
    const [tag, versionAlias] = await Promise.all([readVersionRef(ports.api, version), ports.image(version)])
    if (tag.state === 'unknown' || versionAlias.state === 'unknown') return {kind: 'stop', reason: 'availability-unknown'}
    if (tag.state === 'present' && tag.value.sha !== source) return {kind: 'stop', reason: 'tag-conflict'}
    const candidate = candidates.find(item => item.candidate.state === 'present')?.candidate
    const candidateDigest = candidate?.state === 'present' ? candidate.value.digest : null
    if ((versionAlias.state === 'present' && versionAlias.value.digest !== candidateDigest) ||
      (shaAlias.state === 'present' && shaAlias.value.digest !== candidateDigest) ||
      (tag.state === 'present' && candidateDigest === null)) return {kind: 'stop', reason: 'alias-conflict'}
    if (record && !record.draft && (tag.state !== 'present' || versionAlias.state !== 'present' || shaAlias.state !== 'present')) return {kind: 'stop', reason: 'partial-artifacts-missing'}
    const draft = record ? {state: 'present' as const, value: {version: record.version, source: record.source, digest: record.digest}} : {state: 'absent' as const}
    return planHandoff({source, predecessor, recovery, allocations: {state: 'present', value: candidates}, draft, allocatedVersion})
  } catch {
    return {kind: 'stop', reason: 'observation-failed'}
  }
}
