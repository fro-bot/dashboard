import {describe, expect, it} from 'vitest'
import {observeOwnerReviews, observeReleaseGate} from '../scripts/release/github-release-gate.ts'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const merge = 'c'.repeat(40)
const tree = 'd'.repeat(40)
const repo = 'fro-bot/dashboard'
const rule = (type: string, parameters: unknown) => ({type, parameters, ruleset_source_type: 'Repository', ruleset_source: repo, ruleset_id: 9})

function fixture() {
  const values: Record<string, unknown> = {
    '/pulls/7': {number: 7, user: {id: 2}, state: 'open', draft: false, head: {ref: 'release/pending', sha: head, repo: {full_name: repo}}, base: {ref: 'main', sha: base, repo: {full_name: repo}}, merge_commit_sha: merge},
    '/git/ref/heads/main': {ref: 'refs/heads/main', object: {type: 'commit', sha: base}},
    [`/commits/${head}`]: {sha: head, parents: [{sha: base}], commit: {tree: {sha: tree}}},
    [`/commits/${merge}`]: {sha: merge, parents: [{sha: base}, {sha: head}]},
    '/actions/runs/30': {id: 30, head_sha: head, run_attempt: 2, path: '.github/workflows/main.yaml', event: 'pull_request', repository: {full_name: repo}, head_repository: {full_name: repo}},
    '/rulesets/9': {id: 9, source_type: 'Repository', source: repo, enforcement: 'active', current_user_can_bypass: 'never'},
    '/rules/branches/main': [rule('pull_request', {allowed_merge_methods: ['squash']}), rule('required_status_checks', {strict_required_status_checks_policy: true, required_status_checks: [{context: 'Test', integration_id: 17}, {context: 'Fro Bot', integration_id: 17}]}), rule('code_scanning', {code_scanning_tools: [{tool: 'CodeQL', alerts_threshold: 'none', security_alerts_threshold: 'high_or_higher'}]})],
    [`/commits/${head}/check-runs`]: [
      {id: 41, name: 'Test', status: 'completed', conclusion: 'success', head_sha: head, app: {id: 17}, details_url: `https://github.com/${repo}/actions/runs/30/job/40`},
      {id: 42, name: 'Fro Bot', status: 'completed', conclusion: 'skipped', head_sha: head, app: {id: 17}},
    ],
    [`/commits/${head}/statuses`]: [], [`/commits/${merge}/check-runs`]: [], [`/commits/${merge}/statuses`]: [],
    '/actions/runs/30/attempts/2/jobs': [{id: 40, run_id: 30, run_attempt: 2, head_sha: head, name: 'Test', status: 'completed', conclusion: 'success', check_run_url: `https://api.github.com/repos/${repo}/check-runs/41`}],
    '/pulls/7/reviews': [{id: 1, user: {id: 3}, state: 'APPROVED', commit_id: head, submitted_at: '2026-01-01T00:00:00Z'}],
  }
  const get = async (path: string) => {
    if (!(path in values)) throw new Error('missing')
    return values[path]
  }
  const api = {get, getAsApp: get, pages: async (path: string, _wrapper?: string): Promise<unknown[]> => {
    const v = await get(path)
    if (!Array.isArray(v)) throw new Error('not array')
    return v as unknown[]
  }}
  const input = {repo, main: base, appUserId: 2, inspected: {status: 'ready' as const, notes: 'notes', number: 7, head, lease: head, held: true}, expectedTree: tree}
  return {values, api, input}
}

describe('GitHub release observations', () => {
  it('observes validated candidate, head checks, and CI job binding', async () => {
    const {api, input} = fixture()
    const result = await observeReleaseGate(api, input)
    expect(result.candidate).toMatchObject({pr: 7, head, base, tree, parents: [base]})
    expect(result.checks).toMatchObject({verified: true, ready: true, applicableRevision: head})
  })
  it.each([
    ['bypass', (v: Record<string, unknown>) => { v['/rulesets/9'] = {id: 9, source_type: 'Repository', source: repo, enforcement: 'active'} }],
    ['wrong workflow', (v: Record<string, unknown>) => { (v['/actions/runs/30'] as {path: string}).path = '.github/workflows/other.yaml' }],
    ['wrong job check', (v: Record<string, unknown>) => { v['/actions/runs/30/attempts/2/jobs'] = [] }],
    ['foreign rule source', (v: Record<string, unknown>) => { v['/rules/branches/main'] = [{type: 'pull_request', ruleset_source_type: 'Organization', ruleset_source: repo, ruleset_id: 9}] }],
    ['draft', (v: Record<string, unknown>) => { (v['/pulls/7'] as {draft: boolean}).draft = true }],
    ['changed main', (v: Record<string, unknown>) => { v['/git/ref/heads/main'] = {ref: 'refs/heads/main', object: {type: 'commit', sha: head}} }],
    ['wrong merge parents', (v: Record<string, unknown>) => { v[`/commits/${merge}`] = {sha: merge, parents: [{sha: head}, {sha: base}]} }],
    ['merge status selects merge', (v: Record<string, unknown>) => { v[`/commits/${merge}/statuses`] = [{context: 'other', state: 'success'}] }],
    ['wrong provider', (v: Record<string, unknown>) => { v[`/commits/${head}/check-runs`] = [{id: 41, name: 'Test', status: 'completed', conclusion: 'success', head_sha: head, app: {id: 99}, details_url: `https://github.com/${repo}/actions/runs/30/job/40`}] }],
  ])('fails closed on %s', async (_name, mutate) => {
    const {api, input, values} = fixture()
    mutate(values)
    expect((await observeReleaseGate(api, input)).checks?.ready).not.toBe(true)
  })
  it('reads reviews in order and rejects unreadable decisive timestamp', async () => {
    const {api, values} = fixture()
    expect(await observeOwnerReviews(api, 7, 3)).toMatchObject({reviewsVerified: true, reviews: [{id: 1, state: 'approved', head}]})
    values['/pulls/7/reviews'] = [{id: 1, user: {id: 3}, state: 'APPROVED', commit_id: head, submitted_at: null}]
    expect(await observeOwnerReviews(api, 7, 3)).toMatchObject({reviewsVerified: false})
  })
})
