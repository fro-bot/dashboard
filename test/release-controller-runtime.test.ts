import type {GitHubApi} from '../scripts/release/github-release-api.ts'
import type {ControllerConfig} from '../scripts/release/run-controller.ts'
import {describe, expect, it, vi} from 'vitest'
import {inspectCandidate, prepareCandidate} from '../scripts/release/candidate-github.ts'
import {candidateApi, readCurrentRun, startRuntime} from '../scripts/release/controller-runtime.ts'
import {finish, inspect} from '../scripts/release/controller.ts'
import {observeOwnerReviews, observeReleaseGate} from '../scripts/release/github-release-gate.ts'
import {mergeRelease, readMergeFacts} from '../scripts/release/github-release-proof.ts'
import {runController} from '../scripts/release/run-controller.ts'

const revision = 'a'.repeat(40)
vi.mock('../scripts/release/candidate-github.ts', () => ({inspectCandidate: vi.fn(), prepareCandidate: vi.fn()}))
vi.mock('../scripts/release/candidate.ts', () => ({candidateTree: vi.fn(() => 'c'.repeat(40))}))
vi.mock('../scripts/release/github-release-gate.ts', () => ({
  observeReleaseGate: vi.fn(async () => ({candidate: {repo: 'fro-bot/dashboard', pr: 1, headRepo: 'fro-bot/dashboard', headBranch: 'release/pending', baseBranch: 'main', state: 'open', head: 'b'.repeat(40), base: revision, currentBase: revision, parents: [revision], tree: 'c'.repeat(40), expectedTree: 'c'.repeat(40)}, checks: {verified: true, ready: true, head: 'b'.repeat(40), base: revision, applicableRevision: 'b'.repeat(40), checks: [{name: 'Test', revision: 'b'.repeat(40), disposition: 'pass'}]}, reason: null})),
  observeOwnerReviews: vi.fn(async () => ({reviewsVerified: true, reviews: [{id: 3, userId: 831617, state: 'approved', head: 'b'.repeat(40), submittedAt: '2026-11-18T16:00:00Z'}]})),
}))
vi.mock('../scripts/release/github-release-proof.ts', () => ({mergeRelease: vi.fn(async () => {}), readMergeFacts: vi.fn()}))

const config = {revision, runId: 12, attempt: 2, repositoryId: 42, event: 'workflow_run' as const}
const run = () => ({id: 12, run_attempt: 2, head_sha: revision, head_branch: 'main', path: '.github/workflows/held-release.yaml', event: 'workflow_run', status: 'in_progress', repository: {id: 42, full_name: 'fro-bot/dashboard'}, head_repository: {id: 42, full_name: 'fro-bot/dashboard'}, created_at: '2026-11-18T15:00:00Z'})

describe('controller runtime trust boundaries', () => {
  it('independently reads the exact attempt and original run creation', async () => {
    const get = vi.fn(async (_path: string) => run())
    expect(await readCurrentRun({get}, config)).toEqual({createdAt: '2026-11-18T15:00:00Z'})
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/actions/runs/12/attempts/2', '/actions/runs/12'])
  })

  it.each([
    {head_sha: 'b'.repeat(40)}, {run_attempt: 1}, {event: 'push'}, {status: 'completed'},
    {head_branch: 'other'}, {path: 'other.yaml'}, {repository: {id: 43, full_name: 'fro-bot/dashboard'}},
    {head_repository: {id: 42, full_name: 'foreign/repo'}},
  ])('rejects an untrusted current attempt: %o', async change => {
    const get = vi.fn(async (path: string) => path.endsWith('/attempts/2') ? {...run(), ...change} : run())
    expect(await readCurrentRun({get}, config)).toBeNull()
  })

  it('translates only the exact repository prefix and uses complete pagination', async () => {
    const api = {getOptional: vi.fn(async () => null), get: vi.fn(async () => ({})), pages: vi.fn(async () => []), post: vi.fn(async () => ({}))}
    const pushCandidate = vi.fn(async () => {})
    const port = candidateApi(api, pushCandidate)
    await port.list('/repos/fro-bot/dashboard/pulls?state=all')
    await port.get('/repos/fro-bot/dashboard/git/ref/heads/release/pending')
    expect(api.pages).toHaveBeenCalledExactlyOnceWith('/pulls?state=all')
    expect(api.getOptional).toHaveBeenCalledExactlyOnceWith('/git/ref/heads/release/pending')
    await expect(port.list('/repos/fro-bot/dashboard-other/pulls')).rejects.toThrow()
    await expect(port.write('/repos/other/repo/pulls', {})).rejects.toThrow()
  })
})

function setup() {
  vi.clearAllMocks()
  const config: ControllerConfig = {mode: 'active', activation: '2026-11-01T00:00:00Z', revision, runId: 12, attempt: 2, repositoryId: 42, event: 'workflow_run', actorId: null, schedule: null, ownerId: 831617, readToken: 'read', appToken: 'write', appId: 9, appSlug: 'app'}
  const api = {repo: 'fro-bot/dashboard', get: vi.fn(async () => run()), botUser: vi.fn(async () => ({id: 8, login: 'app[bot]'}))} as unknown as GitHubApi
  const state = {main: revision, repoDir: '/repo', predecessor: {source: 'd'.repeat(40), version: '2026.11.1', digest: `sha256:${'e'.repeat(64)}`}, prior: {state: 'clear' as const}}
  const deps = {load: vi.fn(async () => state), pushCandidate: vi.fn(async () => {}), authorization: vi.fn(), recoveryRevision: vi.fn(async () => false), handoff: vi.fn()}
  vi.mocked(inspectCandidate).mockResolvedValue({status: 'ready', notes: 'notes', number: 1, head: 'b'.repeat(40), lease: 'b'.repeat(40), held: false})
  return {config, api, state, deps}
}

describe('controller composition', () => {
  it.each([['not-needed', 0], ['blocked', 1]] as const)('reports candidate inspection %s through the CLI', async (status, expected) => {
    const f = setup()
    vi.mocked(inspectCandidate).mockResolvedValue(status === 'blocked' ? {status, reason: 'candidate-inspection-failed'} : {status})
    const runtime = await startRuntime(f.config, f.api, f.deps)
    expect((await runtime.ports.observe()).candidate).toEqual({state: status})
    const summary = vi.fn(async (_text: string) => {})
    const deps = {head: async () => revision, settings: async () => ({active: true, activation: f.config.activation}), ownerId: async () => 831617, schedule: async () => null, start: async () => runtime, write: vi.fn(), output: vi.fn(), summary}
    const env = {GITHUB_REPOSITORY: 'fro-bot/dashboard', GITHUB_REF: 'refs/heads/main', RELEASE_WORKFLOW_REF: 'fro-bot/dashboard/.github/workflows/held-release.yaml@refs/heads/main', RELEASE_WORKFLOW_SHA: revision, GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY_ID: '42', GITHUB_EVENT_NAME: 'workflow_run', RUNNER_TEMP: '/tmp', GITHUB_OUTPUT: '/tmp/output', RELEASE_READ_TOKEN: 'read', RELEASE_APP_TOKEN: 'write', RELEASE_APP_ID: '9', RELEASE_APP_SLUG: 'app'}
    expect(await runController(['inspect'], env, deps)).toBe(expected)
    expect(deps.output).not.toHaveBeenCalled()
    expect(deps.write).not.toHaveBeenCalled()
    expect(summary.mock.calls[0]?.[0]).toContain(expected ? 'Stopped:' : 'Skipped:')
  })
  it('never inspects a candidate when prior is unresolved or main changed', async () => {
    const f = setup()
    f.state.main = 'f'.repeat(40)
    const runtime = await startRuntime(f.config, f.api, f.deps)
    await inspect(runtime.ports)
    expect(inspectCandidate).not.toHaveBeenCalled()
    f.state.main = revision
    f.deps.load.mockResolvedValueOnce({...f.state, prior: {state: 'unresolved', artifactId: 55}} as never)
    await inspect(runtime.ports)
    expect(inspectCandidate).not.toHaveBeenCalled()
    expect(prepareCandidate).not.toHaveBeenCalled()
  })

  it('reobserves and merges exactly the authorized head and PR once', async () => {
    const f = setup()
    const runtime = await startRuntime(f.config, f.api, f.deps)
    const decision = await inspect(runtime.ports)
    expect(decision.kind).toBe('authorize')
    if (decision.kind !== 'authorize') throw new Error('fixture invalid')
    const record = {origin: {...decision.authorization.run, verified: true, artifactId: 55}, authorization: decision.authorization}
    f.deps.authorization.mockResolvedValue(record)
    vi.mocked(readMergeFacts).mockResolvedValue({verified: true, repo: 'fro-bot/dashboard', pr: 1, merged: true, actorAppId: 9, head: 'b'.repeat(40), base: revision, squashSha: 'f'.repeat(40), commit: {verified: true, sha: 'f'.repeat(40), parents: [revision], tree: 'c'.repeat(40), authorizationArtifactId: 55}, association: {verified: true, sha: 'f'.repeat(40), prs: [1]}})
    expect(await finish(runtime.ports, 55)).toEqual({kind: 'source', source: 'f'.repeat(40), recovery: false})
    expect(mergeRelease).toHaveBeenCalledExactlyOnceWith(f.api, 1, 'b'.repeat(40), 55)
    expect(f.deps.authorization).toHaveBeenCalledWith(55, {repo: 'fro-bot/dashboard', pr: 1, head: 'b'.repeat(40), base: revision, tree: 'c'.repeat(40)})
  })

  it('reads the schedule hold after gate checks and stops when the hold returns before merge', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-18T16:00:00Z'))
    try {
      const f = setup()
      f.config.event = 'schedule'
      f.config.schedule = '0 15 * * 3'
      vi.spyOn(f.api, 'get').mockImplementation(async () => ({...run(), event: 'schedule'}))
      const order: string[] = []
      const gate = vi.mocked(observeReleaseGate).getMockImplementation()
      if (!gate) throw new Error('fixture invalid')
      vi.mocked(observeReleaseGate).mockImplementation(async (...args) => {
        order.push('gate')
        return gate(...args)
      })
      let held = false
      const scheduleState = vi.fn(async () => {
        order.push('hold')
        return {hold: {state: held ? 'held' as const : 'clear' as const, source: 'owner' as const, pr: 1, ownerId: 831617, verified: true}, slotUsed: false}
      })
      const runtime = await startRuntime(f.config, f.api, {...f.deps, scheduleState})
      const decision = await inspect(runtime.ports)
      expect(decision.kind).toBe('authorize')
      if (decision.kind !== 'authorize') throw new Error('fixture invalid')
      f.deps.authorization.mockImplementation(async () => {
        held = true
        return {origin: {...decision.authorization.run, verified: true, artifactId: 55}, authorization: decision.authorization}
      })
      expect(await finish(runtime.ports, 55)).toEqual({kind: 'skip', reason: 'recheck-failed'})
      expect(order).toEqual(['gate', 'hold', 'gate', 'hold', 'gate', 'hold'])
      expect(mergeRelease).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads reviews last and rejects a review revoked during authorization', async () => {
    const f = setup()
    const order: string[] = []
    const gate = vi.mocked(observeReleaseGate).getMockImplementation()
    const reviews = vi.mocked(observeOwnerReviews).getMockImplementation()
    if (!gate || !reviews) throw new Error('fixture invalid')
    let revoked = false
    vi.mocked(observeReleaseGate).mockImplementation(async (...args) => {
      order.push('gate')
      return gate(...args)
    })
    vi.mocked(observeOwnerReviews).mockImplementation(async (...args) => {
      order.push('reviews')
      return revoked ? {reviewsVerified: true, reviews: []} : reviews(...args)
    })
    const runtime = await startRuntime(f.config, f.api, f.deps)
    const decision = await inspect(runtime.ports)
    if (decision.kind !== 'authorize') throw new Error('fixture invalid')
    f.deps.authorization.mockImplementation(async () => {
      revoked = true
      return {origin: {...decision.authorization.run, verified: true, artifactId: 55}, authorization: decision.authorization}
    })
    expect(await finish(runtime.ports, 55)).toEqual({kind: 'skip', reason: 'recheck-failed'})
    expect(order).toEqual(['gate', 'reviews', 'gate', 'reviews', 'gate', 'reviews'])
    expect(mergeRelease).not.toHaveBeenCalled()
  })
})
