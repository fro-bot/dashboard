import type {ImageObservation} from './controller-io.ts'
import type {AuthorizationRecord} from './controller.ts'
import type {GitHubApi} from './github-release-api.ts'
import type {Known} from './publication.ts'
import type {Predecessor, PredecessorObservations} from './recovery.ts'
import type {Allocation} from './release-evidence.ts'
import type {ControllerConfig} from './run-controller.ts'
import {createControllerIo, inspectImage, readCommitFacts, readFirstParentHistory} from './controller-io.ts'
import {createReleaseState} from './controller-production.ts'
import {startRuntime} from './controller-runtime.ts'
import {createGitHubApi} from './github-release-api.ts'
import {listHeldArtifacts, readAuthorizationById, readHeldOrigin} from './github-release-history.ts'
import {proveReleaseSource} from './github-release-proof.ts'
import {parseAllocation, parseGate} from './release-evidence.ts'

const unknown = () => ({state: 'unknown' as const, reason: 'read-failed' as const})
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Evidence is only authoritative after source authentication and a complete artifact window. */
export function createEvidenceReaders(config: Pick<ControllerConfig, 'repositoryId' | 'runId' | 'attempt'>, api: GitHubApi, provedSource: (source: string, history: string[]) => Promise<AuthorizationRecord | null>, image: (tag: string) => Promise<ImageObservation>) {
  const context = (history: string[]) => ({repositoryId: config.repositoryId, firstParent: history, current: {runId: config.runId, attempt: config.attempt}})
  async function evidence(source: string, history: string[]) {
    const proof = await provedSource(source, history)
    if (!proof || !history.includes(source)) return null
    const run = await api.get(`/actions/runs/${proof.origin.runId}`)
    if (!object(run) || run.id !== proof.origin.runId || run.head_sha !== proof.origin.revision || run.path !== '.github/workflows/held-release.yaml' ||
      !object(run.repository) || run.repository.id !== config.repositoryId || run.repository.full_name !== api.repo ||
      !object(run.head_repository) || run.head_repository.id !== config.repositoryId || run.head_repository.full_name !== api.repo ||
      typeof run.created_at !== 'string' || !Number.isFinite(Date.parse(run.created_at))) return null
    const result = await listHeldArtifacts(api, context(history), run.created_at)
    return result.state === 'present' ? result.value : null
  }
  async function allocations(source: string, history: string[]): Promise<Known<Allocation[]>> {
    try {
      const records = await evidence(source, history)
      if (!records) return unknown()
      const result: Allocation[] = []
      for (const record of records.filter(item => item.kind === 'allocation')) {
        const artifact = await readHeldOrigin(api, context(history), record.id, 'allocation')
        if (!artifact) return unknown()
        const value: unknown = JSON.parse(artifact.text)
        if (!object(value) || typeof value.version !== 'string') return unknown()
        const allocation = parseAllocation(artifact.text, artifact.origin, {source, version: value.version})
        if (!allocation) return unknown()
        result.push(allocation)
      }
      return {state: 'present', value: result}
    } catch { return unknown() }
  }
  async function releaseProof(identity: Predecessor, history: string[]): Promise<PredecessorObservations['gate']> {
    try {
      const records = await evidence(identity.source, history)
      const target = history.indexOf(identity.source)
      if (!records || target === -1) return unknown()
      const candidates: Allocation[] = []
      const gates: NonNullable<ReturnType<typeof parseGate>>[] = []
      for (const record of records) {
        if (record.kind === 'authorization') continue
        const artifact = await readHeldOrigin(api, context(history), record.id, record.kind)
        if (!artifact) return unknown()
        const value: unknown = JSON.parse(artifact.text)
        if (!object(value) || typeof value.source !== 'string' || typeof value.version !== 'string') return unknown()
        const sourceIndex = history.indexOf(value.source)
        if (sourceIndex === -1 || sourceIndex > target) return unknown()
        if (record.kind === 'allocation') {
          const allocation = parseAllocation(artifact.text, artifact.origin, {source: value.source, version: value.version})
          if (!allocation) return unknown()
          if (sourceIndex === target) candidates.push(allocation)
        } else {
          if (typeof value.digest !== 'string' || !object(value.candidate) || typeof value.candidate.runId !== 'number' || typeof value.candidate.attempt !== 'number') return unknown()
          const gate = parseGate(artifact.text, artifact.origin, {source: value.source, version: value.version, digest: value.digest, candidate: {runId: value.candidate.runId, attempt: value.candidate.attempt}})
          if (!gate) return unknown()
          if (sourceIndex === target) gates.push(gate)
        }
      }
      if (candidates.some(a => a.version !== identity.version) || new Set(candidates.map(a => a.tag)).size !== candidates.length) return unknown()
      const images = await Promise.all(candidates.map(async allocation => ({allocation, image: await image(allocation.tag)})))
      if (images.some(item => item.image.state === 'unknown')) return unknown()
      const present = images.filter(item => item.image.state === 'present')
      const selected = present[0]
      if (present.length !== 1 || !selected || selected.image.state !== 'present' || selected.image.value.digest !== identity.digest || gates.length === 0 ||
        gates.some(gate => gate.version !== identity.version || gate.digest !== identity.digest || gate.candidate.runId !== selected.allocation.runId || gate.candidate.attempt !== selected.allocation.attempt)) return unknown()
      return {state: 'present', value: {...identity, smoke: 'pass', trivy: 'pass', enforced: true}}
    } catch { return unknown() }
  }
  return {allocations, releaseProof}
}

export async function startController(config: ControllerConfig, repoDir: string) {
  const api = createGitHubApi({repo: 'fro-bot/dashboard', repositoryId: config.repositoryId, readToken: config.readToken, writeToken: config.appToken})
  const local = createControllerIo({repoDir, appToken: config.appToken})
  const provedSource = async (source: string, history: string[]) => {
    try {
      const index = history.indexOf(source)
      if (index === -1 || index + 1 >= history.length) return null
      const [facts, bot] = await Promise.all([readCommitFacts(repoDir, source), api.botUser(config.appSlug)])
      if (facts.state !== 'present' || facts.value.sha !== source || facts.value.parents[0] !== history[index + 1] || !bot) return null
      return await proveReleaseSource(api, facts.value, {appId: config.appId, botId: bot.id, botLogin: bot.login}, config.ownerId,
        async (id, candidate) => readAuthorizationById(api, {repositoryId: config.repositoryId, firstParent: history, current: {runId: config.runId, attempt: config.attempt}}, id, candidate))
    } catch { return null }
  }
  const readers = createEvidenceReaders(config, api, provedSource, inspectImage)
  const io = {repoDir, syncObjects: async ({main, candidate}: {main: string; candidate: string | null}) => local.syncMain(main, candidate), firstParent: readFirstParentHistory, commit: readCommitFacts, image: inspectImage, nextVersion: local.nextVersion, pushCandidate: local.pushCandidate, provedSource, ...readers}
  return startRuntime(config, api, createReleaseState(config, api, io))
}
