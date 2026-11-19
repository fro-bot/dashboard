import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect, it} from 'vitest'
import {discoverBatch} from '../scripts/release/batch.ts'
import {createCandidate} from '../scripts/release/candidate.ts'
import {startRuntime} from '../scripts/release/controller-runtime.ts'
import {finish, inspect} from '../scripts/release/controller.ts'
import {createGitHubApi} from '../scripts/release/github-release-api.ts'
import {runController} from '../scripts/release/run-controller.ts'

it('composes real candidate, gate and owner observations with separate read and App credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'held-runtime-'))
  const git = (...args: string[]) => execFileSync('git', args, {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()
  try {
    git('init', '--quiet', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'package.json'), '{}')
    writeFileSync(join(dir, 'src/app.ts'), 'one')
    git('add', '--all')
    git('commit', '--no-gpg-sign', '--quiet', '-m', 'baseline')
    const baseline = git('rev-parse', 'HEAD')
    writeFileSync(join(dir, 'src/app.ts'), 'two')
    git('add', '--all')
    git('commit', '--no-gpg-sign', '--quiet', '-m', 'feature')
    const main = git('rev-parse', 'HEAD')
    const notes = discoverBatch({repoDir: dir, baseline, main})?.notes
    if (notes === undefined) throw new Error('fixture requires release notes')
    const {head} = createCandidate({repoDir: dir, base: main, notes})
    const tree = git('rev-parse', `${head}^{tree}`)
    const merge = 'f'.repeat(40)
    const repo = 'fro-bot/dashboard'
    const rule = (type: string, parameters: unknown) => ({type, parameters, ruleset_source_type: 'Repository', ruleset_source: repo, ruleset_id: 9})
    const pull = {number: 7, user: {id: 2}, state: 'open', draft: false, labels: [], head: {ref: 'release/pending', sha: head, repo: {full_name: repo}}, base: {ref: 'main', sha: main, repo: {full_name: repo}}, merge_commit_sha: merge}
    const run = {id: 12, run_attempt: 1, head_sha: main, head_branch: 'main', path: '.github/workflows/held-release.yaml', event: 'workflow_run', status: 'in_progress', repository: {id: 42, full_name: repo}, head_repository: {id: 42, full_name: repo}, created_at: '2026-11-18T15:00:00Z'}
    const values: Record<string, unknown> = {
      '/users/app%5Bbot%5D': {id: 2, login: 'app[bot]', type: 'Bot'},
      '/pulls': [pull], '/pulls/7': pull,
      '/git/ref/heads/release/pending': {ref: 'refs/heads/release/pending', object: {type: 'commit', sha: head}},
      '/git/ref/heads/main': {ref: 'refs/heads/main', object: {type: 'commit', sha: main}},
      '/actions/runs/12': run, '/actions/runs/12/attempts/1': run,
      [`/commits/${head}`]: {sha: head, parents: [{sha: main}], commit: {tree: {sha: tree}}},
      [`/commits/${merge}`]: {sha: merge, parents: [{sha: main}, {sha: head}]},
      '/rules/branches/main': [rule('pull_request', {allowed_merge_methods: ['squash']}), rule('required_status_checks', {strict_required_status_checks_policy: true, required_status_checks: [{context: 'Test', integration_id: 17}, {context: 'Fro Bot', integration_id: 17}]}), rule('code_scanning', {code_scanning_tools: [{tool: 'CodeQL', alerts_threshold: 'none', security_alerts_threshold: 'high_or_higher'}]})],
      '/rulesets/9': {id: 9, source_type: 'Repository', source: repo, enforcement: 'active', current_user_can_bypass: 'never'},
      [`/commits/${head}/check-runs`]: {check_runs: [{id: 41, name: 'Test', status: 'completed', conclusion: 'success', head_sha: head, app: {id: 17}, details_url: `https://github.com/${repo}/actions/runs/30/job/40`}, {id: 42, name: 'Fro Bot', status: 'completed', conclusion: 'skipped', head_sha: head, app: {id: 17}}]},
      [`/commits/${head}/statuses`]: [], [`/commits/${merge}/check-runs`]: {check_runs: []}, [`/commits/${merge}/statuses`]: [],
      '/actions/runs/30': {id: 30, head_sha: head, run_attempt: 2, path: '.github/workflows/main.yaml', event: 'pull_request', repository: {full_name: repo}, head_repository: {full_name: repo}},
      '/actions/runs/30/attempts/2/jobs': {jobs: [{id: 40, run_id: 30, run_attempt: 2, head_sha: head, name: 'Test', status: 'completed', conclusion: 'success', check_run_url: `https://api.github.com/repos/${repo}/check-runs/41`}]},
      '/pulls/7/reviews': [{id: 1, user: {id: 831617}, state: 'APPROVED', commit_id: head, submitted_at: '2026-11-18T16:00:00Z'}],
    }
    const calls: {path: string; auth: string | null}[] = []
    const api = createGitHubApi({repo, readToken: 'read-fixture', writeToken: 'app-fixture', fetch: async (input, init) => {
      const pathname = new URL(String(input)).pathname
      const path = pathname.startsWith(`/repos/${repo}`) ? pathname.slice(`/repos/${repo}`.length) : pathname
      calls.push({path, auth: new Headers(init?.headers).get('authorization')})
      return path in values ? Response.json(values[path]) : new Response('', {status: 404})
    }})
    const config = {mode: 'active' as const, activation: '2026-11-01T00:00:00Z', revision: main, runId: 12, attempt: 1, repositoryId: 42, event: 'workflow_run' as const, actorId: null, schedule: null, ownerId: 831617 as const, readToken: 'read-fixture', appToken: 'app-fixture', appId: 17, appSlug: 'app'}
    let revoke = false
    let authorization: Awaited<ReturnType<typeof inspect>> | null = null
    const runtime = await startRuntime(config, api, {
      load: async () => ({main, repoDir: dir, predecessor: {source: baseline, version: '2026.11.1', digest: `sha256:${'e'.repeat(64)}`}, prior: {state: 'clear'}}),
      pushCandidate: async () => { throw new Error('unexpected write') },
      authorization: async () => {
        if (revoke) values['/pulls/7/reviews'] = [{id: 1, user: {id: 831617}, state: 'DISMISSED', commit_id: head, submitted_at: '2026-11-18T16:00:00Z'}]
        if (!authorization || authorization.kind !== 'authorize') return null
        return {origin: {...authorization.authorization.run, verified: true, artifactId: 55}, authorization: authorization.authorization}
      },
      recoveryRevision: async () => false,
      handoff: async () => { throw new Error('unexpected handoff') },
    })
    authorization = await inspect(runtime.ports)
    expect(authorization.kind).toBe('authorize')
    expect(calls.filter(call => call.path === '/rulesets/9')).toEqual([{path: '/rulesets/9', auth: 'Bearer app-fixture'}])
    expect(calls.filter(call => call.path !== '/rulesets/9').every(call => call.auth === 'Bearer read-fixture')).toBe(true)
    const originalChecks = values[`/commits/${head}/check-runs`]
    values[`/commits/${head}/check-runs`] = {check_runs: [{id: 42, name: 'Fro Bot', status: 'completed', conclusion: 'skipped', head_sha: head, app: {id: 17}}]}
    const waiting = await runtime.ports.observe()
    expect(waiting.candidate.state).toBe('ready')
    if (waiting.candidate.state !== 'ready') throw new Error('missing checks must be a known wait')
    expect(waiting.candidate.gate.checks).toMatchObject({verified: true, ready: false})
    expect(await inspect(runtime.ports)).toEqual({kind: 'skip', reason: 'checks'})
    const outputs: string[] = []
    const summaries: string[] = []
    const cliEnv = {GITHUB_REPOSITORY: repo, GITHUB_REF: 'refs/heads/main', RELEASE_WORKFLOW_REF: `${repo}/.github/workflows/held-release.yaml@refs/heads/main`, RELEASE_WORKFLOW_SHA: main, GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY_ID: '42', GITHUB_EVENT_NAME: 'workflow_run', RUNNER_TEMP: '/runner/temp', GITHUB_OUTPUT: '/runner/output', RELEASE_READ_TOKEN: 'read-fixture', RELEASE_APP_TOKEN: 'app-fixture', RELEASE_APP_ID: '17', RELEASE_APP_SLUG: 'app'}
    const cliDeps = {
      head: async () => main,
      settings: async () => ({active: true, activation: config.activation}),
      ownerId: async () => 831617,
      schedule: async () => null,
      start: async () => runtime,
      write: async () => { throw new Error('unexpected authorization') },
      output: async (text: string) => { outputs.push(text) },
      summary: async (text: string) => { summaries.push(text) },
    }
    expect(await runController(['inspect'], cliEnv, cliDeps)).toBe(0)
    expect(summaries).toEqual(['### Held release\n\nSkipped: checks.\n'])
    expect(outputs).toEqual([])
    values[`/commits/${head}/check-runs`] = {check_runs: []}
    const empty = await runtime.ports.observe()
    expect(empty.candidate.state).toBe('ready')
    if (empty.candidate.state !== 'ready') throw new Error('empty checks must be a known wait')
    expect(empty.candidate.gate.checks).toMatchObject({verified: true, ready: false})
    const testCheck = {id: 41, name: 'Test', status: 'completed', conclusion: 'success', head_sha: head, app: {id: 17}, details_url: `https://github.com/${repo}/actions/runs/30/job/40`}
    values[`/commits/${head}/check-runs`] = {check_runs: [{...testCheck, app: {id: 99}}]}
    const wrongProvider = await runtime.ports.observe()
    expect(wrongProvider.candidate.state).toBe('ready')
    if (wrongProvider.candidate.state !== 'ready') throw new Error('expected parsed evidence')
    expect(wrongProvider.candidate.gate.checks).toMatchObject({verified: false, ready: false})
    expect((await inspect(runtime.ports)).kind).not.toBe('authorize')
    values[`/commits/${head}/check-runs`] = {check_runs: [{...testCheck, details_url: null}]}
    expect((await runtime.ports.observe()).candidate.state).toBe('unknown')
    values[`/commits/${head}/check-runs`] = {check_runs: [testCheck]}
    const originalJobs = values['/actions/runs/30/attempts/2/jobs']
    values['/actions/runs/30/attempts/2/jobs'] = {jobs: []}
    expect((await runtime.ports.observe()).candidate.state).toBe('unknown')
    values['/actions/runs/30/attempts/2/jobs'] = originalJobs
    values[`/commits/${head}/check-runs`] = originalChecks
    revoke = true
    expect(await finish(runtime.ports, 55)).toEqual({kind: 'skip', reason: 'recheck-failed'})
    values['/pulls/7/reviews'] = [{id: 1, user: {id: 831617}, state: 'APPROVED', commit_id: head, submitted_at: '2026-11-18T16:00:00Z'}]
    values['/rulesets/9'] = {id: 9, source_type: 'Repository', source: repo, enforcement: 'active', current_user_can_bypass: 'always'}
    expect((await inspect(runtime.ports)).kind).not.toBe('authorize')
    values['/rulesets/9'] = {id: 9, source_type: 'Repository', source: repo, enforcement: 'active', current_user_can_bypass: 'never'}
    values['/rules/branches/main'] = []
    expect((await inspect(runtime.ports)).kind).not.toBe('authorize')
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}, 20_000)
