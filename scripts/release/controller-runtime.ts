import type {CandidateInput, CandidatePort} from './candidate-github.ts'
import type {AuthorizationRecord, ControllerPorts, Observation} from './controller.ts'
import type {GateInput} from './gate.ts'
import type {GitHubApi} from './github-release-api.ts'
import type {Handoff, Predecessor} from './recovery.ts'
import type {ControllerConfig} from './run-controller.ts'
import {inspectCandidate, prepareCandidate} from './candidate-github.ts'
import {candidateTree} from './candidate.ts'
import {observeOwnerReviews, observeReleaseGate} from './github-release-gate.ts'
import {mergeRelease, readMergeFacts} from './github-release-proof.ts'

const repo = 'fro-bot/dashboard'
const workflow = '.github/workflows/held-release.yaml'
const prefix = `/repos/${repo}`
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Fetch the attempt and the original run independently; never use the triggering payload. */
export async function readCurrentRun(api: Pick<GitHubApi, 'get'>, config: Pick<ControllerConfig, 'revision' | 'runId' | 'attempt' | 'repositoryId' | 'event'>): Promise<{createdAt: string} | null> {
  try {
    if (!/^[a-f0-9]{40}$/u.test(config.revision) || ![config.runId, config.attempt, config.repositoryId].every(v => Number.isSafeInteger(v) && v > 0)) return null
    const attempt = await api.get(`/actions/runs/${config.runId}/attempts/${config.attempt}`)
    const original = await api.get(`/actions/runs/${config.runId}`)
    const valid = (value: unknown): value is Record<string, unknown> => object(value) &&
      value.id === config.runId && value.run_attempt === config.attempt && value.head_sha === config.revision &&
      value.head_branch === 'main' && value.path === workflow && value.event === config.event &&
      object(value.repository) && value.repository.id === config.repositoryId && value.repository.full_name === repo &&
      object(value.head_repository) && value.head_repository.id === config.repositoryId && value.head_repository.full_name === repo
    if (!valid(attempt) || attempt.status !== 'in_progress' || !valid(original) || original.status !== 'in_progress' ||
      typeof original.created_at !== 'string' || !Number.isFinite(Date.parse(original.created_at))) return null
    return {createdAt: original.created_at}
  } catch {
    return null
  }
}

/** Bridge candidate's absolute repo paths to the repo-bound GitHub API. */
export function candidateApi(api: Pick<GitHubApi, 'get' | 'getOptional' | 'pages' | 'post'>, pushCandidate: CandidatePort['pushCandidate']): CandidatePort {
  const relative = (path: string) => {
    if (!path.startsWith(`${prefix}/`)) throw new Error('Invalid repository path')
    return path.slice(prefix.length)
  }
  return {
    get: async path => {
      const p = relative(path)
      return p === '/git/ref/heads/release/pending' ? api.getOptional(p) : api.get(p)
    },
    list: async path => api.pages(relative(path)),
    write: async (path, body) => api.post(relative(path), body),
    pushCandidate,
  }
}

type Tuple = Pick<AuthorizationRecord['authorization'], 'repo' | 'pr' | 'head' | 'base' | 'tree'>
type Hold = Extract<GateInput['trigger'], {kind: 'schedule'}>['hold']
export interface RuntimeDependencies {
  /** Every load independently authenticates its state; unknown facts must not be reported as clear. */
  load: () => Promise<{main: string; repoDir: string; predecessor: Predecessor | null; prior: Observation['prior']; predecessorCandidate?: CandidateInput['predecessor']}>
  /** Complete live hold provenance and attested slot usage, read at the decision boundary. */
  scheduleState?: (pr: number, predecessorCandidate: CandidateInput['predecessor']) => Promise<{hold: Hold; slotUsed: boolean}>
  pushCandidate: CandidatePort['pushCandidate']
  authorization: (artifactId: number, freshCandidate?: Tuple) => Promise<AuthorizationRecord | null>
  recoveryRevision: (record: AuthorizationRecord) => Promise<boolean>
  /** The adapter must independently verify the source is on fresh main first-parent history. */
  handoff: (source: string, recovery: boolean) => Promise<Handoff>
}

/** Compose live observations with independently authenticated state adapters. */
export async function startRuntime(config: ControllerConfig, api: GitHubApi, deps: RuntimeDependencies): Promise<{ports: ControllerPorts; handoff: RuntimeDependencies['handoff']}> {
  if (api.repo !== repo) throw new Error('Invalid repository')
  const candidatePort = candidateApi(api, deps.pushCandidate)
  let tuple: Tuple | undefined
  let record: AuthorizationRecord | null = null
  let bot: {id: number; login: string} | null = null
  let mergeRequested = false
  const gateApi = {
    get: async (path: string) => api.get(path),
    pages: async (path: string, wrapper?: string) => api.pages(path, wrapper),
    getAsApp: async (path: string) => {
      const match = /^\/rulesets\/([1-9]\d*)$/u.exec(path)
      if (!match) throw new Error('Invalid ruleset')
      return api.appRuleset(Number(match[1]))
    },
  }
  const ports: ControllerPorts = {
    observe: async () => {
      tuple = undefined
      bot = null
      const [state, current, user] = await Promise.all([deps.load(), readCurrentRun(api, config), api.botUser(config.appSlug)])
      if (!current || !user) throw new Error('Untrusted run or app')
      bot = user
      const run: Observation['run'] = {repo, workflow, revision: config.revision, runId: config.runId, attempt: config.attempt, verified: true}
      let trigger: Observation['trigger']
      if (config.event === 'push') trigger = {kind: 'push'}
      else if (config.event === 'schedule') trigger = {kind: 'schedule', cron: config.schedule ?? '', originalRunAt: current.createdAt, now: new Date().toISOString(), slotUsed: true, hold: {state: 'unknown', source: 'unknown', pr: 0, verified: false}}
      else if (config.event === 'workflow_dispatch') trigger = {kind: 'dispatch', actorId: config.actorId ?? 0, ref: 'refs/heads/main', refVerified: true, reviewsVerified: false, reviews: []}
      else trigger = {kind: 'review', reviewsVerified: false, reviews: []}
      const observation: Observation = {mode: config.mode, activation: config.activation, trusted: {repo, workflow, revision: config.revision, appId: config.appId}, run, trigger, ownerId: config.ownerId, baseBranch: 'main', predecessor: state.predecessor && state.main === config.revision ? 'verified' : 'unknown', prior: state.prior, candidate: {state: 'unknown'}}
      if (!state.predecessor || state.main !== config.revision || state.prior.state !== 'clear') return observation
      const input: CandidateInput = {repo, repoDir: state.repoDir, baseline: state.predecessor.source, main: state.main, appUserId: user.id, ownerId: config.ownerId, predecessor: state.predecessorCandidate}
      const candidate = await inspectCandidate(input, candidatePort)
      if (candidate.status === 'absent' || candidate.status === 'stale') {
        observation.candidate = {state: candidate.status}
        return observation
      }
      if (candidate.status !== 'ready') {
        observation.candidate = {state: candidate.status}
        return observation
      }
      const expectedTree = candidateTree({repoDir: state.repoDir, base: state.main, notes: candidate.notes})
      const live = await observeReleaseGate(gateApi, {repo, main: state.main, appUserId: user.id, inspected: candidate, expectedTree})
      if (!live.candidate || !live.checks) return observation
      tuple = {repo, pr: live.candidate.pr, head: live.candidate.head, base: live.candidate.base, tree: live.candidate.tree}
      if (trigger.kind === 'review' || trigger.kind === 'dispatch') trigger = {...trigger, ...await observeOwnerReviews(gateApi, candidate.number, config.ownerId)}
      else if (trigger.kind === 'schedule') {
        try {
          const schedule = await deps.scheduleState?.(candidate.number, state.predecessorCandidate)
          if (schedule) trigger = {...trigger, ...schedule, now: new Date().toISOString()}
        } catch {
          // Missing or incomplete provenance must never authorize a schedule.
        }
      }
      observation.trigger = trigger
      observation.candidate = {state: 'ready', gate: {expected: {repo, pr: candidate.number, branch: 'release/pending', baseBranch: 'main', ownerId: config.ownerId, workflow, trustedRevision: config.revision, mostRecentGeneratedPr: state.predecessorCandidate?.number}, activeSince: config.activation, priorAttempt: 'resolved', candidate: live.candidate, checks: live.checks, run, trigger}}
      return observation
    },
    prepare: async expected => {
      const [state, current, user] = await Promise.all([deps.load(), readCurrentRun(api, config), api.botUser(config.appSlug)])
      if (!current || !user || !state.predecessor || state.main !== config.revision || state.prior.state !== 'clear') throw new Error('Untrusted preparation')
      const input: CandidateInput = {repo, repoDir: state.repoDir, baseline: state.predecessor.source, main: state.main, appUserId: user.id, ownerId: config.ownerId, predecessor: state.predecessorCandidate}
      if ((await inspectCandidate(input, candidatePort)).status !== expected) throw new Error('Candidate changed')
      const result = await prepareCandidate(input, candidatePort)
      if (result.status !== 'ready') throw new Error('Preparation failed')
    },
    authorization: async artifactId => {
      record = await deps.authorization(artifactId, tuple)
      return record
    },
    recoveryRevision: deps.recoveryRevision,
    merge: async (head, artifactId) => {
      if (mergeRequested || !tuple || !record || record.origin.artifactId !== artifactId || tuple.head !== head || record.authorization.pr !== tuple.pr || record.authorization.head !== head || record.authorization.base !== tuple.base || record.authorization.tree !== tuple.tree || record.authorization.repo !== tuple.repo) throw new Error('Candidate changed')
      mergeRequested = true
      await mergeRelease(api, tuple.pr, head, artifactId)
    },
    mergeFacts: async authorization => bot ? readMergeFacts(api, authorization.authorization, {appId: config.appId, botId: bot.id, botLogin: bot.login}) : null,
  }
  return {ports, handoff: deps.handoff}
}
