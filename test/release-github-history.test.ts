import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {describe, expect, it} from 'vitest'
import {createGitHubApi} from '../scripts/release/github-release-api.ts'
import * as history from '../scripts/release/github-release-history.ts'
import {observeLegacyGate, readAuthorizationById} from '../scripts/release/github-release-history.ts'

const repo = 'fro-bot/dashboard'
const source = 'a'.repeat(40)
const candidate = {repo, pr: 7, head: 'b'.repeat(40), base: source, tree: 'c'.repeat(40)}
const context = {repositoryId: 3, firstParent: [source], current: {runId: 5, attempt: 1}}
const identity = {version: '2026.11.1', source, digest: `sha256:${'d'.repeat(64)}`}
const steps = ['🧪 Smoke-test candidate image by digest', '🚦 Enforce fixed HIGH/CRITICAL vulnerabilities', '🏷️ Promote latest image tag'].map(name => ({name, status: 'completed', conclusion: 'success'}))

function zip(name: string, text: string): Buffer {
  const filename = Buffer.from(name)
  const data = Buffer.from(text)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034B50)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014B50)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(filename.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12)
  end.writeUInt32LE(local.length + filename.length + data.length, 16)
  return Buffer.concat([local, filename, data, central, filename, end])
}

describe('GitHub release history', () => {
  it('exposes authenticated held-origin and typed allocation and gate readers', () => {
    expect(history).toHaveProperty('readHeldOrigin', expect.any(Function))
    expect(history).toHaveProperty('readHeldAllocation', expect.any(Function))
    expect(history).toHaveProperty('readHeldGate', expect.any(Function))
  })
  it('authenticates exact authorization artifact and current in-progress attempt', async () => {
    const workflow = '.github/workflows/held-release.yaml'
    const authorization = {...candidate, run: {repo, workflow, revision: source, runId: 5, attempt: 1}, authority: {kind: 'review', reviewId: 8, userId: 9}}
    let kind = 'authorization'
    let status = 'in_progress'
    let conclusion: string | null = null
    let archive = zip('release-authorization.json', JSON.stringify(authorization))
    let digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`
    const paths: string[] = []
    const api = createGitHubApi({repo, readToken: 'r', writeToken: 'w', fetch: async input => {
      const url = new URL(String(input))
      paths.push(url.pathname)
      if (url.hostname !== 'api.github.com') return new Response(new Uint8Array(archive))
      if (url.pathname.endsWith('/actions/workflows/held-release.yaml')) return Response.json({id: 4, path: workflow})
      if (url.pathname.endsWith('/actions/artifacts/12')) return Response.json({id: 12, name: `release-${kind}-5-1`, expired: false, digest, workflow_run: {id: 5, repository_id: 3, head_repository_id: 3, head_branch: 'main', head_sha: source}})
      if (url.pathname.endsWith('/actions/runs/5/attempts/1')) return Response.json({id: 5, run_attempt: 1, repository: {id: 3, full_name: repo}, head_repository: {id: 3, full_name: repo}, workflow_id: 4, path: workflow, head_branch: 'main', head_sha: source, event: 'push', status, conclusion})
      if (url.pathname.endsWith('/actions/artifacts/12/zip')) return new Response(null, {status: 302, headers: {location: 'https://assets.example/archive'}})
      return new Response('', {status: 404})
    }})
    expect((await readAuthorizationById(api, context, 12, candidate))?.authorization).toEqual(authorization)
    status = 'completed'
    conclusion = 'failure'
    expect((await readAuthorizationById(api, context, 12, candidate))?.authorization).toEqual(authorization)
    expect(paths).toContain('/repos/fro-bot/dashboard/actions/runs/5/attempts/1')
    expect(await readAuthorizationById(api, {...context, firstParent: ['e'.repeat(40)]}, 12, candidate)).toBeNull()
    expect(await readAuthorizationById(api, context, 12, {...candidate, head: source})).toBeNull()
    const allocation = {runId: 5, attempt: 1, version: identity.version, source: candidate.head, tag: 'ci-5-1'}
    kind = 'allocation'
    archive = zip('release-allocation.json', JSON.stringify(allocation))
    digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`
    expect(await history.readHeldAllocation(api, context, 12, {version: identity.version, source: candidate.head})).toEqual(allocation)
    expect(await history.readHeldAllocation(api, context, 12, identity)).toBeNull()
    const gate = {version: identity.version, source: candidate.head, digest: identity.digest, candidate: {runId: 5, attempt: 1}, gate: {runId: 5, attempt: 1}, smoke: 'pass', trivy: {enforced: true, result: 'pass'}}
    kind = 'gate'
    archive = zip('release-gate.json', JSON.stringify(gate))
    digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`
    expect(await history.readHeldGate(api, context, 12, {version: identity.version, source: candidate.head, digest: identity.digest, candidate: gate.candidate})).toEqual(gate)
    expect(await history.readHeldGate(api, context, 12, {...identity, candidate: gate.candidate})).toBeNull()
  })

  it('requires a unique successful legacy release with all exact gates', async () => {
    let runs = [{id: 10, run_attempt: 1, head_sha: source, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', workflow_id: 6, path: '.github/workflows/release.yaml', repository: {id: 3, full_name: repo}, head_repository: {id: 3, full_name: repo}}]
    let jobSteps = steps
    const api = createGitHubApi({repo, readToken: 'r', writeToken: 'w', fetch: async input => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/actions/runs') && url.searchParams.get('head_sha') === source) return Response.json({workflow_runs: runs})
      if (url.pathname.endsWith('/actions/runs/10/attempts/1/jobs')) return Response.json({jobs: [{name: 'Release', run_id: 10, run_attempt: 1, head_sha: source, status: 'completed', conclusion: 'success', steps: jobSteps}]})
      return new Response('', {status: 404})
    }})
    expect(await observeLegacyGate(api, context, identity)).toEqual({state: 'present', value: {...identity, smoke: 'pass', trivy: 'pass', enforced: true}})
    jobSteps = steps.slice(0, 2)
    expect((await observeLegacyGate(api, context, identity)).state).toBe('unknown')
    jobSteps = steps
    runs = [...runs, {...runs[0], id: 11} as typeof runs[number]]
    expect((await observeLegacyGate(api, context, identity)).state).toBe('unknown')
  })

  it('enumerates the scoped held evidence window without accepting expired or duplicate records', async () => {
    const path = '.github/workflows/held-release.yaml'
    const since = '2026-11-17T00:00:00Z'
    const created = '2026-11-19T00:00:00Z'
    const repository = {id: 3, full_name: repo}
    const run = {id: 10, run_attempt: 2, head_branch: 'main', head_sha: source, workflow_id: 4, path, event: 'schedule', created_at: created, repository, head_repository: repository}
    const first = {id: 12, name: 'release-allocation-10-1', expired: false}
    let artifacts = [first, {id: 13, name: 'release-gate-10-2', expired: false}]
    let runs = [run]
    let errors = false
    const api = createGitHubApi({repo, readToken: 'r', writeToken: 'w', fetch: async input => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/actions/workflows/held-release.yaml')) return Response.json({id: 4, path})
      if (url.pathname.endsWith('/actions/workflows/4/runs') && url.searchParams.get('created') === `>=${since}` && url.searchParams.get('branch') === 'main') return Response.json({workflow_runs: runs})
      if (url.pathname.endsWith('/actions/runs/10/artifacts') && !errors) return Response.json({artifacts})
      return new Response('', {status: 503})
    }})
    const scan = async () => history.listHeldArtifacts(api, context, since)
    expect(await scan()).toEqual({state: 'present', value: [
      {id: 12, kind: 'allocation', runId: 10, attempt: 1, revision: source, runEvent: 'schedule', runCreatedAt: created},
      {id: 13, kind: 'gate', runId: 10, attempt: 2, revision: source, runEvent: 'schedule', runCreatedAt: created},
    ]})
    for (const bad of [{...first, expired: true}, {...first, id: 14}, {...first, id: 14, name: 'release-gate-10-3'}]) {
      artifacts = [first, bad]
      expect((await scan()).state).toBe('unknown')
    }
    artifacts = [first]
    errors = true
    expect((await scan()).state).toBe('unknown')
    errors = false
    runs = [run, run]
    expect((await scan()).state).toBe('unknown')
    runs = []
    expect(await scan()).toEqual({state: 'present', value: []})
  })
})
