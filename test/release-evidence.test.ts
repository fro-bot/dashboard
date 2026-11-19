import {describe, expect, it} from 'vitest'
import {artifactName, parseAllocation, parseArtifactName, parseAuthorization, parseGate, validateOrigin} from '../scripts/release/release-evidence.ts'

const sha = 'a'.repeat(40)
const other = 'b'.repeat(40)
const digest = `sha256:${'c'.repeat(64)}`
const expected = {kind: 'allocation' as const, artifactId: 77, repo: 'fro-bot/dashboard', repositoryId: 9, workflowId: 12, workflow: '.github/workflows/held-release.yaml', branch: 'main' as const, revision: sha, runId: 123, attempt: 2}
const artifact = {id: 77, name: 'release-allocation-123-2', expired: false, digest, workflow_run: {id: 123, repository_id: 9, head_repository_id: 9, head_branch: 'main', head_sha: sha}}
const run = {id: 123, run_attempt: 2, repository: {id: 9, full_name: 'fro-bot/dashboard'}, head_repository: {id: 9, full_name: 'fro-bot/dashboard'}, workflow_id: 12, path: '.github/workflows/held-release.yaml', head_branch: 'main', head_sha: sha, event: 'push'}
const allocation = {runId: 123, attempt: 2, version: '2026.11.1', source: other, tag: 'ci-123-2'}
const gate = {version: allocation.version, source: other, digest, candidate: {runId: 42, attempt: 1}, gate: {runId: 123, attempt: 2}, smoke: 'pass', trivy: {enforced: true, result: 'pass'}}
const authorization = {repo: expected.repo, pr: 7, head: other, base: sha, tree: sha, run: {repo: expected.repo, workflow: expected.workflow, revision: sha, runId: 123, attempt: 2}, authority: {kind: 'review', reviewId: 8, userId: 10}}
const origin = (kind: 'allocation' | 'gate' | 'authorization' = 'allocation') => validateOrigin({...expected, kind}, {...artifact, name: `release-${kind}-123-2`}, run, digest)

describe('release artifact origin', () => {
  it('uses canonical bounded names', () => {
    expect(artifactName('gate', 123, 2)).toBe('release-gate-123-2')
    expect(parseArtifactName('release-gate-123-2')).toEqual({kind: 'gate', runId: 123, attempt: 2})
    for (const name of ['release-gate-0123-2', 'release-gate-123-0', 'release-gate-123-1234567890', 'release-gate-1234567890123456-1']) expect(parseArtifactName(name)).toBeNull()
    expect(() => artifactName('gate', 0, 2)).toThrow()
  })
  it('accepts independently observed old attempts only when exact', () => {
    expect(origin()).not.toBeNull()
    expect(validateOrigin(expected, artifact, {...run, run_attempt: 3}, digest)).toBeNull()
    expect(validateOrigin({...expected, attempt: 3}, artifact, run, digest)).toBeNull()
  })
  it('rejects wrong artifact, repository, fork, workflow, branch, revision and digest', () => {
    for (const a of [{...artifact, id: 78}, {...artifact, expired: true}, {...artifact, digest: null}, {...artifact, digest: `sha256:${'d'.repeat(64)}`}, {...artifact, workflow_run: {...artifact.workflow_run, head_repository_id: 10}}, {...artifact, workflow_run: {...artifact.workflow_run, head_sha: other}}]) expect(validateOrigin(expected, a, run, digest)).toBeNull()
    for (const r of [{...run, repository: {id: 10, full_name: expected.repo}}, {...run, head_repository: {id: 9, full_name: 'evil/fork'}}, {...run, workflow_id: 13}, {...run, path: '.github/workflows/evil.yaml'}, {...run, head_branch: 'dev'}, {...run, head_sha: other}, {...run, event: 'pull_request'}]) expect(validateOrigin(expected, artifact, r, digest)).toBeNull()
    expect(validateOrigin(expected, artifact, run, 'sha256:bad')).toBeNull()
  })
})

describe('strict payloads', () => {
  it('binds allocation identity to observed attempt and expected source/version', () => {
    const identity = {source: other, version: allocation.version}
    expect(parseAllocation(JSON.stringify(allocation), origin(), identity)).toEqual(allocation)
    for (const value of [{...allocation, source: sha}, {...allocation, version: '2026.11.2'}, {...allocation, attempt: 1}, {...allocation, tag: 'ci-123-1'}, {...allocation, digest}]) expect(parseAllocation(JSON.stringify(value), origin(), identity)).toBeNull()
    expect(parseAllocation('{', origin(), identity)).toBeNull()
    expect(parseAllocation(JSON.stringify(allocation), origin('gate'), identity)).toBeNull()
  })
  it('accepts only success gate seals, binding the gate and candidate independently', () => {
    const identity = {source: other, version: allocation.version, digest, candidate: {runId: 42, attempt: 1}}
    expect(parseGate(JSON.stringify(gate), origin('gate'), identity)).toEqual(gate)
    for (const value of [{...gate, source: sha}, {...gate, version: '2026.11.2'}, {...gate, digest: 'bad'}, {...gate, gate: {runId: 123, attempt: 1}}, {...gate, candidate: {runId: 42, attempt: 2}}, {...gate, smoke: 'fail'}, {...gate, trivy: {enforced: false, result: 'pass'}}]) expect(parseGate(JSON.stringify(value), origin('gate'), identity)).toBeNull()
  })
  it('binds authorization run to origin and rejects untrusted authority or extra claims', () => {
    const identity = {repo: expected.repo, pr: 7, head: other, base: sha, tree: sha}
    expect(parseAuthorization(JSON.stringify(authorization), origin('authorization'), identity)).toEqual(authorization)
    for (const value of [{...authorization, head: sha}, {...authorization, run: {...authorization.run, attempt: 1}}, {...authorization, authority: {kind: 'push'}}, {...authorization, verified: true}, {...authorization, artifactId: 77}]) expect(parseAuthorization(JSON.stringify(value), origin('authorization'), identity)).toBeNull()
    expect(parseAuthorization('no', origin('authorization'), identity)).toBeNull()
  })
})
