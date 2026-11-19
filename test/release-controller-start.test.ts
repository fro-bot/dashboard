import {createHash} from 'node:crypto'
import {afterEach, expect, it, vi} from 'vitest'
import {createEvidenceReaders} from '../scripts/release/controller-start.ts'
import {createGitHubApi} from '../scripts/release/github-release-api.ts'
import * as history from '../scripts/release/github-release-history.ts'
import {validateOrigin} from '../scripts/release/release-evidence.ts'
import {releaseZip} from './release-test-zip.ts'

const source = 'a'.repeat(40)
const base = 'b'.repeat(40)
const repo = 'fro-bot/dashboard'
const workflow = '.github/workflows/held-release.yaml'
const config = {repositoryId: 3, runId: 5, attempt: 1}
afterEach(() => vi.restoreAllMocks())

it('requires a complete scan before reporting empty allocation history', async () => {
  let fail = false
  const api = createGitHubApi({repo, readToken: 'r', writeToken: 'w', fetch: async input => {
    const path = new URL(String(input)).pathname
    if (fail) throw new Error('offline')
    if (path.endsWith('/actions/runs/7')) return Response.json({id: 7, created_at: '2026-01-01T00:00:00Z', head_sha: base, path: workflow, repository: {id: 3, full_name: repo}, head_repository: {id: 3, full_name: repo}})
    if (path.endsWith('/actions/workflows/held-release.yaml')) return Response.json({id: 4, path: workflow})
    if (path.endsWith('/actions/workflows/4/runs')) return Response.json({workflow_runs: []})
    return new Response('', {status: 404})
  }})
  const proof = {origin: {runId: 7, revision: base}, authorization: {base}} as never
  const readers = createEvidenceReaders(config, api, async () => proof, async () => ({state: 'absent'}))
  expect(await readers.allocations(source, [source, base])).toEqual({state: 'present', value: []})
  fail = true
  expect((await readers.allocations(source, [source, base])).state).toBe('unknown')
})

it('scopes predecessor evidence and authenticates retries and re-gates', async () => {
  const digest = `sha256:${'d'.repeat(64)}`
  const identity = {version: '2026.11.1', source, digest}
  const newer = 'c'.repeat(40)
  const api = createGitHubApi({repo, readToken: 'r', writeToken: 'w', fetch: async () => Response.json({id: 7, created_at: '2026-01-01T00:00:00Z', head_sha: base, path: workflow, repository: {id: 3, full_name: repo}, head_repository: {id: 3, full_name: repo}})})
  const record = (kind: 'allocation' | 'gate', artifactId: number, runId: number, revision: string) => {
    const expected = {kind, artifactId, runId, attempt: 1, repo, repositoryId: 3, workflowId: 4, workflow, branch: 'main' as const, revision}
    const origin = validateOrigin(expected, {id: artifactId, name: `release-${kind}-${runId}-1`, expired: false, digest, workflow_run: {id: runId, repository_id: 3, head_repository_id: 3, head_branch: 'main', head_sha: revision}}, {id: runId, run_attempt: 1, repository: {id: 3, full_name: repo}, head_repository: {id: 3, full_name: repo}, workflow_id: 4, path: workflow, head_branch: 'main', head_sha: revision, event: 'push'}, digest)
    if (!origin) throw new Error('invalid fixture')
    return origin
  }
  const allocation = {runId: 8, attempt: 1, version: identity.version, source, tag: 'ci-8-1'}
  const gate = {...identity, candidate: {runId: 8, attempt: 1}, gate: {runId: 9, attempt: 1}, smoke: 'pass', trivy: {enforced: true, result: 'pass'}}
  const artifacts: history.HeldArtifact[] = [
    {id: 10, kind: 'allocation', runId: 8, attempt: 1, revision: source, runEvent: 'push', runCreatedAt: '2026-01-01T00:00:00Z'},
    {id: 11, kind: 'gate', runId: 9, attempt: 1, revision: source, runEvent: 'push', runCreatedAt: '2026-01-01T00:00:00Z'},
  ]
  const texts = new Map<number, unknown>([[10, allocation], [11, gate]])
  const add = (id: number, kind: 'allocation' | 'gate', runId: number, revision: string, value: unknown) => {
    artifacts.push({id, kind, runId, attempt: 1, revision, runEvent: 'push', runCreatedAt: '2026-01-01T00:00:00Z'})
    texts.set(id, value)
  }
  const scan = vi.spyOn(history, 'listHeldArtifacts').mockImplementation(async () => ({state: 'present', value: artifacts}))
  vi.spyOn(history, 'readHeldOrigin').mockImplementation(async (_api, _context, id) => {
    const artifact = artifacts.find(item => item.id === id)
    if (!artifact || artifact.kind === 'authorization') return null
    return {origin: record(artifact.kind, id, artifact.runId, artifact.revision), text: JSON.stringify(texts.get(id))}
  })
  const proof = {origin: {runId: 7, revision: base}} as never
  let retry: 'absent' | 'unknown' | 'present' = 'absent'
  const readers = createEvidenceReaders(config, api, async () => proof, async tag => tag === 'ci-12-1' ? retry === 'unknown' ? {state: 'unknown', reason: 'read-failed'} : retry === 'absent' ? {state: 'absent'} : {state: 'present', value: {digest}} : {state: 'present', value: {digest}})
  const parents = [newer, source, base]
  add(12, 'allocation', 12, source, {...allocation, runId: 12, tag: 'ci-12-1'})
  add(13, 'allocation', 13, newer, {...allocation, source: newer, version: '2026.11.2', runId: 13, tag: 'ci-13-1'})
  add(14, 'gate', 14, newer, {...gate, source: newer, version: '2026.11.2', candidate: {runId: 13, attempt: 1}, gate: {runId: 14, attempt: 1}})
  add(15, 'gate', 15, source, {...gate, gate: {runId: 15, attempt: 1}})
  expect((await readers.releaseProof(identity, parents)).state).toBe('present')
  expect(scan).toHaveBeenCalledTimes(1)
  expect((await readers.allocations(source, parents)).state).toBe('unknown')
  retry = 'unknown'
  expect((await readers.releaseProof(identity, parents)).state).toBe('unknown')
  retry = 'present'
  expect((await readers.releaseProof(identity, parents)).state).toBe('unknown')
  retry = 'absent'
  const newerAllocation = texts.get(13) as typeof allocation
  newerAllocation.source = base
  expect((await readers.releaseProof(identity, parents)).state).toBe('unknown')
  newerAllocation.source = 'f'.repeat(40)
  expect((await readers.releaseProof(identity, parents)).state).toBe('unknown')
  newerAllocation.source = newer
  newerAllocation.tag = 'invalid'
  expect((await readers.releaseProof(identity, parents)).state).toBe('unknown')
  newerAllocation.tag = 'ci-13-1'
  gate.digest = `sha256:${'e'.repeat(64)}`
  expect((await readers.releaseProof(identity, parents)).state).toBe('unknown')
  gate.digest = digest
  gate.candidate.runId = 12
  expect((await readers.releaseProof(identity, parents)).state).toBe('unknown')
})

it('authenticates scanned allocation and gate ZIPs against their origins and candidate image', async () => {
  const digest = `sha256:${'d'.repeat(64)}`
  const identity = {version: '2026.11.1', source, digest}
  const allocation = {runId: 8, attempt: 1, version: identity.version, source, tag: 'ci-8-1'}
  const gate = {...identity, candidate: {runId: 8, attempt: 1}, gate: {runId: 9, attempt: 1}, smoke: 'pass', trivy: {enforced: true, result: 'pass'}}
  const repoInfo = {id: 3, full_name: repo}
  const run = (id: number) => ({id, run_attempt: 1, workflow_id: 4, path: workflow, head_branch: 'main', head_sha: source, event: 'push', status: 'completed', conclusion: 'success', repository: repoInfo, head_repository: repoInfo, created_at: '2026-01-02T00:00:00Z'})
  const archives = new Map([[10, releaseZip('release-allocation.json', JSON.stringify(allocation))], [11, releaseZip('release-gate.json', JSON.stringify(gate))]])
  let corruptDigest = false
  let wrongRun = false
  let timeout = false
  const api = createGitHubApi({repo, readToken: 'r', writeToken: 'w', timeoutMs: 20, fetch: async (input, init) => {
    const url = new URL(String(input))
    const path = url.pathname
    if (timeout) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), {once: true}))
    if (url.hostname === 'assets.example') {
      const archive = archives.get(Number(path.slice(1)))
      return archive === undefined ? new Response('', {status: 404}) : new Response(new Uint8Array(archive))
    }
    if (path.endsWith('/actions/runs/7')) return Response.json({...run(7), head_sha: base, created_at: '2026-01-01T00:00:00Z'})
    if (path.endsWith('/actions/workflows/held-release.yaml')) return Response.json({id: 4, path: workflow})
    if (path.endsWith('/actions/workflows/4/runs')) return Response.json({workflow_runs: [run(8), run(9)]})
    const runArtifacts = /\/actions\/runs\/(8|9)\/artifacts$/u.exec(path)
    if (runArtifacts) {
      const id = runArtifacts[1] === '8' ? 10 : 11
      return Response.json({artifacts: [{id, name: `release-${id === 10 ? 'allocation-8' : 'gate-9'}-1`, expired: false}]})
    }
    const attempt = /\/actions\/runs\/(8|9)\/attempts\/1$/u.exec(path)
    if (attempt) return Response.json({...run(Number(attempt[1])), ...(wrongRun && attempt[1] === '9' ? {head_sha: base} : {})})
    const artifact = /\/actions\/artifacts\/(10|11)(\/zip)?$/u.exec(path)
    if (artifact) {
      const id = Number(artifact[1])
      if (artifact[2] !== undefined) return new Response(null, {status: 302, headers: {location: `https://assets.example/${id}`}})
      const archive = archives.get(id)
      if (archive === undefined) return new Response('', {status: 404})
      const sha = createHash('sha256').update(archive).digest('hex')
      return Response.json({id, name: `release-${id === 10 ? 'allocation-8' : 'gate-9'}-1`, expired: false, digest: `sha256:${corruptDigest && id === 11 ? '0'.repeat(64) : sha}`, workflow_run: {id: id === 10 ? 8 : 9, repository_id: 3, head_repository_id: 3, head_branch: 'main', head_sha: source}})
    }
    return new Response('', {status: 404})
  }})
  const proof = {origin: {runId: 7, revision: base}} as never
  let imageDigest = digest
  const readers = createEvidenceReaders(config, api, async () => proof, async () => ({state: 'present', value: {digest: imageDigest}}))
  expect((await readers.allocations(source, [source, base])).state).toBe('present')
  expect(await readers.releaseProof(identity, [source, base])).toEqual({state: 'present', value: {...identity, smoke: 'pass', trivy: 'pass', enforced: true}})
  corruptDigest = true
  expect((await readers.releaseProof(identity, [source, base])).state).toBe('unknown')
  corruptDigest = false
  wrongRun = true
  expect((await readers.releaseProof(identity, [source, base])).state).toBe('unknown')
  wrongRun = false
  imageDigest = `sha256:${'e'.repeat(64)}`
  expect((await readers.releaseProof(identity, [source, base])).state).toBe('unknown')
  imageDigest = digest
  timeout = true
  expect((await readers.releaseProof(identity, [source, base])).state).toBe('unknown')
})
