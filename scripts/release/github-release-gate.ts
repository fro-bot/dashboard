import type {CandidateStatus} from './candidate-github.ts'
import type {GateInput} from './gate.ts'
import {verifyReleaseChecks} from './checks.ts'

/** All paths are repository-relative; pages must return all pages or throw. */
export interface GateApi {
  get: (path: string) => Promise<unknown>
  getAsApp: (path: string) => Promise<unknown>
  pages: (path: string, wrapper?: string) => Promise<unknown[]>
}

type Ready = Extract<CandidateStatus, {status: 'ready' | 'stale'}>
export interface GateObservationInput {
  repo: string
  main: string
  appUserId: number
  /** Fresh result of inspectCandidate for this repository and exact main. */
  inspected: Ready
  /** Independently calculated candidateTree for inspectCandidate's batch and main. */
  expectedTree: string
}
type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid observation')
  return v as Obj
}
const id = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const sha = (v: unknown): v is string => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)
const requireValue = (value: boolean) => {
  if (!value) throw new Error('invalid observation')
}

/** Establish a Test check's workflow and exact current attempt independently of its conclusion. */
async function realTest(api: GateApi, repo: string, revision: string, checks: unknown[]): Promise<{name: string; integrationId: number}[]> {
  const matches = checks.filter(c => obj(c).name === 'Test')
  if (matches.length > 20) throw new Error('CI unavailable')
  const result: {name: string; integrationId: number}[] = []
  for (const raw of matches) {
    const c = obj(raw)
    const app = obj(c.app)
    requireValue(id(c.id) && id(app.id) && c.head_sha === revision && typeof c.details_url === 'string')
    const url = new URL(c.details_url as string)
    const m = /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)$/.exec(url.pathname)
    requireValue(url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash && !!m && `${m[1]}/${m[2]}` === repo)
    if (!m) throw new Error('CI unavailable')
    const runId = Number(m[3])
    const jobId = Number(m[4])
    requireValue(id(runId) && id(jobId))
    const run = obj(await api.get(`/actions/runs/${runId}`))
    requireValue(run.id === runId && id(run.run_attempt) && run.head_sha === revision && run.path === '.github/workflows/main.yaml' && run.event === 'pull_request' && obj(run.repository).full_name === repo && obj(run.head_repository).full_name === repo)
    const jobs = await api.pages(`/actions/runs/${runId}/attempts/${run.run_attempt as number}/jobs`, 'jobs')
    const job = jobs.map(obj).filter(j => j.id === jobId)
    requireValue(job.length === 1 && job[0]?.run_id === runId && job[0].run_attempt === run.run_attempt && job[0].head_sha === revision && job[0].name === 'Test' && job[0].status === c.status && job[0].conclusion === c.conclusion && job[0].check_run_url === `https://api.github.com/repos/${repo}/check-runs/${c.id as number}`)
    result.push({name: 'Test', integrationId: app.id as number})
  }
  return result
}

/** Independently re-read the PR, current main, merge, rules, and both revisions' signals. */
export async function observeReleaseGate(api: GateApi, input: GateObservationInput): Promise<{candidate: GateInput['candidate']; checks: GateInput['checks']; reason: 'observation-failed' | null}> {
  const failed = {candidate: null, checks: null, reason: 'observation-failed' as const}
  try {
    const {repo, main, inspected, appUserId, expectedTree} = input
    requireValue(/^[\w.-]+\/[\w.-]+$/.test(repo) && sha(main) && sha(expectedTree) && id(appUserId) && inspected.status === 'ready' && id(inspected.number) && sha(inspected.head) && inspected.lease === inspected.head)
    const pull = obj(await api.get(`/pulls/${inspected.number}`))
    const h = obj(pull.head)
    const b = obj(pull.base)
    requireValue(pull.number === inspected.number && pull.state === 'open' && pull.draft === false && obj(pull.user).id === appUserId && h.ref === 'release/pending' && h.sha === inspected.head && obj(h.repo).full_name === repo && b.ref === 'main' && b.sha === main && obj(b.repo).full_name === repo && sha(pull.merge_commit_sha))
    const mergeSha = pull.merge_commit_sha as string
    const [refRaw, headRaw, mergeRaw, rules, headChecks, headStatuses, mergeChecks, mergeStatuses] = await Promise.all([
      api.get('/git/ref/heads/main'), api.get(`/commits/${inspected.head}`), api.get(`/commits/${mergeSha}`), api.pages('/rules/branches/main'),
      api.pages(`/commits/${inspected.head}/check-runs`, 'check_runs'), api.pages(`/commits/${inspected.head}/statuses`),
      api.pages(`/commits/${mergeSha}/check-runs`, 'check_runs'), api.pages(`/commits/${mergeSha}/statuses`),
    ])
    const ref = obj(refRaw)
    const target = obj(ref.object)
    const headCommit = obj(headRaw)
    const mergeCommit = obj(mergeRaw)
    requireValue(ref.ref === 'refs/heads/main' && target.type === 'commit' && target.sha === main && headCommit.sha === inspected.head && Array.isArray(headCommit.parents) && headCommit.parents.length === 1 && obj(headCommit.parents[0]).sha === main && obj(obj(headCommit.commit).tree).sha === expectedTree && mergeCommit.sha === mergeSha && mergeSha !== inspected.head && Array.isArray(mergeCommit.parents) && mergeCommit.parents.length === 2 && obj(mergeCommit.parents[0]).sha === main && obj(mergeCommit.parents[1]).sha === inspected.head)
    const candidate: NonNullable<GateInput['candidate']> = {repo, pr: inspected.number, headRepo: repo, headBranch: 'release/pending', baseBranch: 'main', state: 'open', head: inspected.head, base: main, currentBase: main, parents: [main], tree: expectedTree, expectedTree}
    const ids = new Set<number>()
    for (const raw of rules) {
      const rule = obj(raw)
      requireValue(typeof rule.type === 'string' && rule.ruleset_source_type === 'Repository' && rule.ruleset_source === repo && id(rule.ruleset_id))
      ids.add(rule.ruleset_id as number)
    }
    requireValue(ids.size > 0 && ids.size <= 100)
    for (const ruleId of ids) {
      const r = obj(await api.getAsApp(`/rulesets/${ruleId}`))
      requireValue(r.id === ruleId && r.source_type === 'Repository' && r.source === repo && r.enforcement === 'active' && r.current_user_can_bypass === 'never')
    }
    const selected = mergeChecks.length || mergeStatuses.length ? mergeChecks : headChecks
    const revision = mergeChecks.length || mergeStatuses.length ? mergeSha : inspected.head
    const ci = await realTest(api, repo, revision, selected)
    const checks = verifyReleaseChecks({candidate: {verified: true, head: inspected.head, base: main, generatedAppPr: true}, merge: {verified: true, sha: mergeSha, parents: [main, inspected.head]}, realCi: {verified: true, checks: ci}, effectiveRules: {complete: true, noBypass: true, rules}, head: {complete: true, checks: headChecks, statuses: headStatuses}, testMerge: {complete: true, checks: mergeChecks, statuses: mergeStatuses}})
    return {candidate, checks, reason: null}
  } catch {
    return failed
  }
}

/** Returns owner reviews in the complete endpoint's chronological order. */
export async function observeOwnerReviews(api: GateApi, pr: number, ownerId: number): Promise<{reviewsVerified: boolean; reviews: Extract<GateInput['trigger'], {kind: 'review'}>['reviews']}> {
  try {
    requireValue(id(pr) && id(ownerId))
    const reviews: Extract<GateInput['trigger'], {kind: 'review'}>['reviews'] = []
    let last = -Infinity
    for (const raw of await api.pages(`/pulls/${pr}/reviews`)) {
      const r = obj(raw)
      const user = obj(r.user)
      requireValue(id(user.id))
      if (user.id !== ownerId) continue
      requireValue(id(r.id) && typeof r.state === 'string')
      const state = (r.state as string).toLowerCase()
      requireValue(['approved', 'changes_requested', 'dismissed', 'commented', 'pending'].includes(state))
      const decisive = !['commented', 'pending'].includes(state)
      if (decisive) {
        requireValue(sha(r.commit_id) && typeof r.submitted_at === 'string' && Number.isFinite(Date.parse(r.submitted_at)) && Date.parse(r.submitted_at) >= last)
        last = Date.parse(r.submitted_at as string)
      }
      reviews.push({id: r.id as number, userId: ownerId, state: state as typeof reviews[number]['state'], head: typeof r.commit_id === 'string' ? r.commit_id : '', submittedAt: typeof r.submitted_at === 'string' ? r.submitted_at : ''})
    }
    return {reviewsVerified: true, reviews}
  } catch {
    return {reviewsVerified: false, reviews: []}
  }
}
