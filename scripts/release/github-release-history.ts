import type {AuthorizationRecord} from './controller.ts'
import type {Authorization} from './gate.ts'
import type {GitHubApi} from './github-release-api.ts'
import type {Known} from './publication.ts'
import type {Predecessor, PredecessorObservations} from './recovery.ts'
import {readArtifact} from './github-release-proof.ts'
import {parseAllocation, parseArtifactName, parseAuthorization, parseGate, type ObservedOrigin} from './release-evidence.ts'

const held = '.github/workflows/held-release.yaml'
const legacy = '.github/workflows/release.yaml'
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && String(value).length <= 15
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const unknown = () => ({state: 'unknown' as const, reason: 'malformed' as const})

/** firstParent is the complete independently verified main history, newest first. */
export interface HistoryContext {
  repositoryId: number
  firstParent: string[]
  current: {runId: number; attempt: number}
}

export interface HeldArtifact {
  id: number
  kind: 'allocation' | 'gate' | 'authorization'
  runId: number
  attempt: number
  revision: string
  runEvent: string
  runCreatedAt: string
}

/** A complete window of candidate references; the record readers still authenticate each ZIP. */
export async function listHeldArtifacts(api: GitHubApi, context: HistoryContext, since: string): Promise<Known<HeldArtifact[]>> {
  try {
    const start = Date.parse(since)
    if (!validContext(context) || !Number.isFinite(start)) return unknown()
    const workflow = await workflowId(api, 'held-release.yaml', held)
    if (workflow === null) return unknown()
    const runs = await api.pages(`/actions/workflows/${workflow}/runs?branch=main&created=${encodeURIComponent(`>=${since}`)}`, 'workflow_runs')
    // GitHub caps filtered workflow run results at 1,000. A capped read can't prove absence.
    if (runs.length >= 1000) return unknown()
    const runIds = new Set<number>()
    const ids = new Set<number>()
    const names = new Set<string>()
    const result: HeldArtifact[] = []
    for (const run of runs) {
      if (!object(run) || !id(run.id) || runIds.has(run.id) || !id(run.run_attempt) || run.workflow_id !== workflow || run.path !== held ||
        run.head_branch !== 'main' || !sha(run.head_sha) || !context.firstParent.includes(run.head_sha) || !sameRepository(api, context, run) ||
        typeof run.event !== 'string' || !['push', 'schedule', 'workflow_run', 'workflow_dispatch'].includes(run.event) ||
        typeof run.created_at !== 'string' || !Number.isFinite(Date.parse(run.created_at)) || Date.parse(run.created_at) < start) return unknown()
      runIds.add(run.id)
      const artifacts = await api.pages(`/actions/runs/${run.id}/artifacts`, 'artifacts')
      for (const artifact of artifacts) {
        if (!object(artifact) || typeof artifact.name !== 'string') return unknown()
        if (!/^release-(?:allocation|gate|authorization)(?:-|$)/u.test(artifact.name)) continue
        const parsed = parseArtifactName(artifact.name)
        if (!parsed || parsed.runId !== run.id || parsed.attempt > run.run_attempt || !id(artifact.id) || artifact.expired !== false ||
          ids.has(artifact.id) || names.has(artifact.name)) return unknown()
        ids.add(artifact.id)
        names.add(artifact.name)
        result.push({id: artifact.id, ...parsed, revision: run.head_sha, runEvent: run.event, runCreatedAt: run.created_at})
      }
    }
    return {state: 'present', value: result}
  } catch {
    return unknown()
  }
}

function validContext(context: HistoryContext): boolean {
  return id(context.repositoryId) && id(context.current.runId) && id(context.current.attempt) &&
    Array.isArray(context.firstParent) && context.firstParent.length > 0 && context.firstParent.every(sha) && new Set(context.firstParent).size === context.firstParent.length
}

function sameRepository(api: GitHubApi, context: HistoryContext, run: Record<string, unknown>): boolean {
  return object(run.repository) && run.repository.id === context.repositoryId && run.repository.full_name === api.repo &&
    object(run.head_repository) && run.head_repository.id === context.repositoryId && run.head_repository.full_name === api.repo
}

async function workflowId(api: GitHubApi, name: 'held-release.yaml' | 'release.yaml', path: string): Promise<number | null> {
  const value = await api.get(`/actions/workflows/${name}`)
  return object(value) && id(value.id) && value.path === path ? value.id : null
}

/** No history enumeration is implied; callers must prove scan completeness and rival absence. */
export async function readHeldOrigin(api: GitHubApi, context: HistoryContext, artifactId: number, kind: 'allocation' | 'gate' | 'authorization'): Promise<{origin: ObservedOrigin; text: string} | null> {
  try {
    if (!validContext(context) || !id(artifactId)) return null
    const workflow = await workflowId(api, 'held-release.yaml', held)
    const artifact = await api.get(`/actions/artifacts/${artifactId}`)
    if (workflow === null || !object(artifact) || artifact.id !== artifactId || !object(artifact.workflow_run)) return null
    const tuple = parseArtifactName(artifact.name)
    const revision = artifact.workflow_run.head_sha
    if (!tuple || tuple.kind !== kind || !sha(revision) || !context.firstParent.includes(revision)) return null
    const run = await api.get(`/actions/runs/${tuple.runId}/attempts/${tuple.attempt}`)
    const current = tuple.runId === context.current.runId && tuple.attempt === context.current.attempt
    // A seal may precede a later failure; the artifact itself is authenticated below.
    if (!object(run) || (!(run.status === 'completed' && typeof run.conclusion === 'string' && run.conclusion.length > 0) && !(current && run.status === 'in_progress' && run.conclusion === null))) return null
    return await readArtifact(api, {artifactId, repo: api.repo, repositoryId: context.repositoryId, workflowId: workflow, workflow: held, branch: 'main', revision, ...tuple})
  } catch { return null }
}

/** The candidate's PR, head, base and tree must be independently established. */
export async function readAuthorizationById(api: GitHubApi, context: HistoryContext, artifactId: number, candidate: Pick<Authorization, 'repo' | 'pr' | 'head' | 'base' | 'tree'>): Promise<AuthorizationRecord | null> {
  const artifact = await readHeldOrigin(api, context, artifactId, 'authorization')
  if (!artifact) return null
  const authorization = parseAuthorization(artifact.text, artifact.origin, candidate)
  return authorization ? {origin: {...artifact.origin, verified: true}, authorization} : null
}

/** Null is unknown, never proof that an allocation is absent. */
export async function readHeldAllocation(api: GitHubApi, context: HistoryContext, artifactId: number, identity: {version: string; source: string}) {
  const artifact = await readHeldOrigin(api, context, artifactId, 'allocation')
  return artifact ? parseAllocation(artifact.text, artifact.origin, identity) : null
}

/** Candidate CI alias and digest must be independently checked by the caller. */
export async function readHeldGate(api: GitHubApi, context: HistoryContext, artifactId: number, identity: {version: string; source: string; digest: string; candidate: {runId: number; attempt: number}}) {
  const artifact = await readHeldOrigin(api, context, artifactId, 'gate')
  return artifact ? parseGate(artifact.text, artifact.origin, identity) : null
}

/** The version/tag, image aliases and digest are independently checked by observePredecessor. */
export async function observeLegacyGate(api: GitHubApi, context: HistoryContext, identity: Predecessor): Promise<PredecessorObservations['gate']> {
  try {
    if (!validContext(context) || !sha(identity.source) || !context.firstParent.includes(identity.source) || !/^\d{4}\.\d{2}\.\d+$/u.test(identity.version) || !/^sha256:[a-f0-9]{64}$/u.test(identity.digest)) return unknown()
    const runs = await api.pages(`/actions/runs?head_sha=${identity.source}&branch=main`, 'workflow_runs')
    if (runs.length >= 1000) return unknown()
    const matches: {runId: number; attempt: number}[] = []
    for (const run of runs) {
      if (!object(run) || typeof run.path !== 'string') return unknown()
      if (run.path !== legacy) continue
      if (!id(run.id) || !id(run.run_attempt) || run.head_sha !== identity.source || run.head_branch !== 'main' || !id(run.workflow_id) || !sameRepository(api, context, run) || !['push', 'workflow_dispatch'].includes(String(run.event)) || typeof run.status !== 'string') return unknown()
      // GitHub's list only exposes the latest attempt; older attempts could also have published.
      if (run.run_attempt !== 1 || run.status !== 'completed') return unknown()
      if (run.conclusion === 'success') matches.push({runId: run.id, attempt: run.run_attempt})
      else if (typeof run.conclusion !== 'string') return unknown()
    }
    if (matches.length !== 1) return unknown()
    const match = matches[0]
    if (!match) return unknown()
    const jobs = await api.pages(`/actions/runs/${match.runId}/attempts/${match.attempt}/jobs`, 'jobs')
    const release = jobs.filter(job => object(job) && job.name === 'Release')
    if (release.length !== 1 || !object(release[0]) || release[0].run_id !== match.runId || release[0].run_attempt !== match.attempt || release[0].head_sha !== identity.source || release[0].status !== 'completed' || release[0].conclusion !== 'success' || !Array.isArray(release[0].steps)) return unknown()
    for (const name of ['🧪 Smoke-test candidate image by digest', '🚦 Enforce fixed HIGH/CRITICAL vulnerabilities', '🏷️ Promote latest image tag']) {
      const steps = release[0].steps.filter(step => object(step) && step.name === name)
      if (steps.length !== 1 || !object(steps[0]) || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') return unknown()
    }
    return {state: 'present', value: {...identity, smoke: 'pass', trivy: 'pass', enforced: true}}
  } catch { return unknown() }
}
