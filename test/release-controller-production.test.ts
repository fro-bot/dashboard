import type {CommitFacts, LocalObservation} from '../scripts/release/controller-io.ts'
import type {AuthorizationRecord} from '../scripts/release/controller.ts'
import type {GitHubApi} from '../scripts/release/github-release-api.ts'
import type {Known} from '../scripts/release/publication.ts'
import type {PredecessorObservations} from '../scripts/release/recovery.ts'
import type {Allocation} from '../scripts/release/release-evidence.ts'
import type {ControllerConfig} from '../scripts/release/run-controller.ts'
import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {describe, expect, it, vi} from 'vitest'
import {createReleaseState} from '../scripts/release/controller-production.ts'
import {renderReleaseBody} from '../scripts/release/publisher.ts'

const main = 'a'.repeat(40)
const candidate = 'b'.repeat(40)
const config = {revision: main, ownerId: 831617, repositoryId: 3, runId: 5, attempt: 1, event: 'workflow_run', appId: 1, appSlug: 'fro-bot'} as ControllerConfig

function fixture() {
  const mocks = {
    repo: 'fro-bot/dashboard',
    get: vi.fn(async (_path: string) => ({ref: 'refs/heads/main', object: {type: 'commit', sha: main}})),
    getOptional: vi.fn(async () => ({ref: 'refs/heads/release/pending', object: {type: 'commit', sha: candidate}})),
    releasePages: vi.fn(async (): Promise<unknown[]> => []),
    pages: vi.fn(async (_path: string): Promise<unknown[]> => []),
  }
  const api = mocks as unknown as GitHubApi
  const io = {
    repoDir: '/repo',
    syncObjects: vi.fn(async () => {}),
    firstParent: vi.fn(async () => ({state: 'present' as const, value: [main]})),
    pushCandidate: vi.fn(async () => {}),
    commit: vi.fn(async (_dir: string, _sha: string): Promise<LocalObservation<CommitFacts>> => ({state: 'unknown', reason: 'read-failed'})),
    image: vi.fn(async (_tag: string) => ({state: 'unknown' as const, reason: 'read-failed' as const})),
    nextVersion: vi.fn(async () => ({state: 'unknown' as const, reason: 'read-failed' as const})),
    provedSource: vi.fn(async (_sha: string, _history: string[]): Promise<AuthorizationRecord | null> => null),
    releaseProof: vi.fn(async (): Promise<PredecessorObservations['gate']> => ({state: 'unknown', reason: 'read-failed'})),
    allocations: vi.fn(async (_source: string, _history: string[]): Promise<Known<Allocation[]>> => ({state: 'unknown', reason: 'read-failed'})),
  }
  return {api, io, mocks}
}

function settledFixture(f: ReturnType<typeof fixture>, entries: {source: string; parent: string; pr: number; version: string}[], digest: string, missing?: number) {
  const author = {id: 2, login: 'fro-bot[bot]', type: 'Bot'}
  const tree = 'f'.repeat(40)
  const message = 'Release\n\nFro-Release-Authorization: 12'
  let currentSource = ''
  f.mocks.releasePages.mockResolvedValue(entries.map(e => ({id: e.pr, author, tag_name: e.version, body: renderReleaseBody(f.api.repo, {...e, digest, notes: 'release'}), draft: false, prerelease: false})))
  Object.assign(f.api, {
    botUser: async () => ({id: author.id, login: author.login}),
    releaseAssetPages: async (id: number) => {
      const e = entries.find(item => item.pr === id)
      if (!e || id === missing) return []
      const bytes = Buffer.from(JSON.stringify({schema: 1, repo: f.api.repo, releaseId: id, version: e.version, source: e.source, digest}))
      return [{id, name: 'release-proof.json', state: 'uploaded', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, uploader: author}]
    },
    releaseAssetBytes: async (id: number) => {
      const e = entries.find(item => item.pr === id)
      if (!e) throw new Error('unknown release')
      return Buffer.from(JSON.stringify({schema: 1, repo: f.api.repo, releaseId: id, version: e.version, source: e.source, digest}))
    },
  })
  f.mocks.get.mockImplementation(async path => {
    if (path === '/git/ref/heads/main') return {ref: 'refs/heads/main', object: {type: 'commit', sha: main}}
    const e = entries.find(item => path === `/pulls/${item.pr}` || path === `/commits/${item.source}`)
    if (e && path === `/pulls/${e.pr}`) return {number: e.pr, state: 'closed', merged: true, merge_commit_sha: e.source, user: author, merged_by: author, head: {ref: 'release/pending', sha: candidate, repo: {full_name: f.api.repo}}, base: {ref: 'main', repo: {full_name: f.api.repo}}} as never
    if (e) return {sha: e.source, parents: [{sha: e.parent}], commit: {tree: {sha: tree}, message}} as never
    if (path === `/commits/${candidate}`) return {sha: candidate, parents: [{sha: entries.find(item => item.source === currentSource)?.parent}], commit: {tree: {sha: tree}, message}} as never
    throw new Error('unexpected path')
  })
  const pages = f.mocks.pages.getMockImplementation()
  f.mocks.pages.mockImplementation(async path => {
    const e = entries.find(item => path === `/commits/${item.source}/pulls`)
    if (e) {
      currentSource = e.source
      return [{number: e.pr}]
    }
    return pages ? pages(path) : []
  })
}

describe('production snapshot', () => {
  it('synchronizes the exact live refs and refuses to report an unproved predecessor clear', async () => {
    const {api, io, mocks} = fixture()
    const state = await createReleaseState(config, api, io).load()
    expect(io.syncObjects).toHaveBeenCalledExactlyOnceWith({main, candidate})
    expect(io.firstParent).toHaveBeenCalledExactlyOnceWith('/repo', main)
    expect(mocks.releasePages).toHaveBeenCalledExactlyOnceWith()
    expect(state).toMatchObject({main, repoDir: '/repo', predecessor: null, prior: {state: 'unknown'}})
  })

  it('fails closed on a malformed candidate ref before syncing', async () => {
    const {api, io, mocks} = fixture()
    mocks.getOptional.mockResolvedValue({ref: 'refs/heads/release/pending', object: {type: 'tag', sha: candidate}})
    await expect(createReleaseState(config, api, io).load()).rejects.toThrow()
    expect(io.syncObjects).not.toHaveBeenCalled()
  })

  it('fails closed when complete first-parent history cannot be read', async () => {
    const {api, io} = fixture()
    io.firstParent.mockResolvedValueOnce({state: 'unknown', reason: 'read-failed'} as never)
    await expect(createReleaseState(config, api, io).load()).rejects.toThrow()
  })
})

describe('settled receipt predecessor', () => {
  it.each(['valid', 'missing', 'wrong-author'])('uses only a proved receipt after Actions expire: %s', async variant => {
    const {api, io, mocks} = fixture()
    const parent = 'd'.repeat(40)
    const tree = 'f'.repeat(40)
    const digest = `sha256:${'e'.repeat(64)}`
    const version = '2026.11.2'
    const author = {id: 2, login: 'fro-bot[bot]', type: 'Bot'}
    const message = 'Release\n\nFro-Release-Authorization: 12'
    const cfg = {...config, appId: 1, appSlug: 'fro-bot'}
    const identity = {repo: api.repo, releaseId: 42, version, source: main, digest}
    const bytes = Buffer.from(JSON.stringify({schema: 1, ...identity}))
    mocks.releasePages.mockResolvedValue([{id: 42, author: variant === 'wrong-author' ? {...author, id: 3} : author, tag_name: version, body: renderReleaseBody(api.repo, {...identity, notes: 'notes'}), draft: false, prerelease: false}])
    io.firstParent.mockResolvedValue({state: 'present', value: [main, parent]})
    io.image.mockResolvedValue({state: 'present', value: {digest}} as never)
    io.commit.mockResolvedValue({state: 'present', value: {sha: main, parents: [parent], tree, message, paths: ['docs/releases/batch.md']}})
    const pull = {number: 7, state: 'closed', merged: true, merge_commit_sha: main, user: author, merged_by: author,
      head: {ref: 'release/pending', sha: candidate, repo: {full_name: api.repo}}, base: {ref: 'main', repo: {full_name: api.repo}}}
    const commit = (sha: string) => ({sha, parents: [{sha: parent}], commit: {tree: {sha: tree}, message}})
    Object.assign(api, {
      botUser: vi.fn(async () => ({id: author.id, login: author.login})),
      releaseAssetPages: vi.fn(async () => variant === 'missing' ? [] : [{id: 19, name: 'release-proof.json', state: 'uploaded', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, uploader: author}]),
      releaseAssetBytes: vi.fn(async () => bytes),
    })
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/git/ref/heads/main') return {ref: 'refs/heads/main', object: {type: 'commit', sha: main}}
      if (path === '/pulls/7') return pull as never
      if (path === `/commits/${main}`) return commit(main) as never
      if (path === `/commits/${candidate}`) return commit(candidate) as never
      throw new Error('unexpected path')
    })
    mocks.pages.mockImplementation(async path => {
      if (path.startsWith('/git/matching-refs/')) return [{ref: `refs/tags/${version}`, object: {type: 'commit', sha: main}}]
      if (path === `/commits/${main}/pulls`) return [{number: 7}]
      if (path.endsWith('/labels')) return []
      if (path.endsWith('/timeline')) return [{event: 'unlabeled', label: {name: 'release-hold'}, actor: {id: config.ownerId}, created_at: '2026-11-18T15:01:00Z'}]
      throw new Error('Actions evidence expired')
    })
    const state = await createReleaseState(cfg, api, io).load()
    if (variant === 'valid') expect(state).toMatchObject({predecessor: {version, source: main, digest}, predecessorCandidate: {number: 7, head: candidate, clearance: 'cleared'}, prior: {state: 'clear'}})
    else expect(state).toMatchObject({predecessor: null, prior: {state: 'unknown'}})
    expect(io.provedSource).not.toHaveBeenCalled()
    expect(io.releaseProof).not.toHaveBeenCalled()
  })
})

describe('legacy cutover state', () => {
  it.each(['carry', 'changed', 'intermediate-hold', 'nonowner', 'unproved', 'hidden-squash', 'alias-conflict'])('walks a proved clearance chain without skipping ambiguity: %s', async mode => {
    const {api, io, mocks} = fixture()
    const middle = 'c'.repeat(40)
    const root = 'd'.repeat(40)
    const p1 = '1'.repeat(40)
    const p2 = '2'.repeat(40)
    const p3 = '3'.repeat(40)
    const digest = `sha256:${'e'.repeat(64)}`
    const history = [main, p1, middle, p2, root, p3]
    const entries = [{source: main, parent: p1, pr: 9, version: '2026.11.3'}, {source: middle, parent: p2, pr: 8, version: '2026.11.2'}, {source: root, parent: p3, pr: 7, version: '2026.11.1'}]
    io.firstParent.mockResolvedValue({state: 'present', value: history})
    io.image.mockResolvedValue({state: 'present', value: {digest}} as never)
    io.releaseProof.mockResolvedValue({state: 'present', value: {version: '2026.11.3', source: main, digest, smoke: 'pass', trivy: 'pass', enforced: true}})
    mocks.releasePages.mockResolvedValue(entries.map(e => ({tag_name: e.version, body: renderReleaseBody(api.repo, {...e, digest, notes: 'release'}), draft: false, prerelease: false})))
    io.provedSource.mockImplementation(async source => {
      const e = entries.find(entry => entry.source === source)
      if (!e || (mode === 'unproved' && e.pr === 8)) return null
      return {origin: {repo: api.repo, workflow: '.github/workflows/held-release.yaml', revision: e.parent, runId: e.pr, attempt: 1, verified: true, artifactId: e.pr}, authorization: {repo: api.repo, pr: e.pr, head: candidate, base: e.parent, tree: 'f'.repeat(40), run: {repo: api.repo, workflow: '.github/workflows/held-release.yaml', revision: e.parent, runId: e.pr, attempt: 1}, authority: {kind: 'review', reviewId: 8, userId: config.ownerId}}}
    })
    io.commit.mockImplementation(async (_dir, value) => {
      const index = history.indexOf(value)
      const parent = history[index + 1]
      if (parent === undefined) return {state: 'unknown', reason: 'read-failed'}
      return {state: 'present', value: {sha: value, parents: [parent], tree: 'f'.repeat(40), message: entries.some(entry => entry.source === value) ? 'Release\n\nFro-Release-Authorization: 12' : 'ordinary', paths: entries.some(entry => entry.source === value) || (value === p1 && mode === 'hidden-squash') ? ['docs/releases/batch.md'] : []}}
    })
    let currentTimelineReads = 0
    mocks.pages.mockImplementation(async path => {
      if (path.startsWith('/git/matching-refs/')) {
        const e = entries.find(entry => path.endsWith(entry.version))
        return e ? [{ref: `refs/tags/${e.version}`, object: {type: 'commit', sha: mode === 'alias-conflict' && e.pr === 8 ? candidate : e.source}}] : []
      }
      if (path.startsWith('/actions/runs?')) return []
      if (path === '/issues/8/labels' && mode === 'intermediate-hold') return [{name: 'release-hold'}]
      if (path.endsWith('/labels')) return []
      if (path === '/issues/7/timeline' || (path === '/issues/8/timeline' && mode === 'nonowner')) return [{event: 'unlabeled', label: {name: 'release-hold'}, actor: {id: path === '/issues/7/timeline' ? config.ownerId : 1}, created_at: '2026-11-18T15:01:00Z'}]
      if (path === '/issues/10/timeline' && mode === 'changed' && ++currentTimelineReads > 1) return [{event: 'labeled', label: {name: 'release-hold'}, actor: {id: 1}, created_at: '2026-11-18T15:01:00Z'}]
      if (path.endsWith('/timeline')) return []
      throw new Error('unexpected path')
    })
    settledFixture({api, io, mocks}, entries, digest, mode === 'unproved' ? 8 : undefined)
    const runtime = createReleaseState(config, api, io)
    const loaded = await runtime.load()
    expect(loaded.predecessorCandidate?.clearance).toBe(mode === 'carry' || mode === 'changed' ? 'cleared' : mode === 'intermediate-hold' ? 'held' : 'unknown')
    const result = await runtime.scheduleState?.(10, loaded.predecessorCandidate)
    if (mode === 'carry') expect(result?.hold).toMatchObject({state: 'clear', source: 'carry', carriedFromPr: 9, clearancePr: 7})
    else expect(result?.hold.state).not.toBe('clear')
  })
  it.each(['proved', 'missing-gate'])('keeps a public-before-latest release pending only with exact evidence: %s', async variant => {
    const {api, io, mocks} = fixture()
    const previous = 'd'.repeat(40)
    const oldDigest = `sha256:${'e'.repeat(64)}`
    const newDigest = `sha256:${'f'.repeat(64)}`
    const oldVersion = '2026.11.1'
    const version = '2026.11.2'
    const author = {id: 2, login: 'fro-bot[bot]', type: 'Bot'}
    const bytes = Buffer.from(JSON.stringify({schema: 1, repo: api.repo, releaseId: 42, version, source: main, digest: newDigest}))
    const assets = vi.fn(async () => [{id: 19, name: 'release-proof.json', state: 'uploaded', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, uploader: author}])
    Object.assign(api, {botUser: async () => ({id: author.id, login: author.login}), releaseAssetPages: assets, releaseAssetBytes: async () => bytes})
    mocks.releasePages.mockResolvedValue([
      {tag_name: oldVersion, body: renderReleaseBody(api.repo, {version: oldVersion, source: previous, digest: oldDigest, notes: 'old'}), draft: false, prerelease: false},
      {id: 42, author, tag_name: version, body: renderReleaseBody(api.repo, {version, source: main, digest: newDigest, notes: 'new'}), draft: false, prerelease: false},
    ])
    io.firstParent.mockResolvedValue({state: 'present', value: [main, previous]})
    io.image.mockImplementation(async tag => ({state: 'present', value: {digest: tag === 'latest' || tag === oldVersion || tag === `sha-${previous.slice(0, 7)}` ? oldDigest : newDigest}} as never))
    io.commit.mockImplementation(async (_dir, source) => source === previous ? {state: 'present', value: {sha: previous, parents: [], tree: 'c'.repeat(40), message: 'legacy', paths: []}} : {state: 'present', value: {sha: main, parents: [previous], tree: 'c'.repeat(40), message: 'Release\n\nFro-Release-Authorization: 12\n', paths: ['docs/releases/batch.md']}})
    io.provedSource.mockResolvedValue({origin: {repo: api.repo, workflow: '.github/workflows/held-release.yaml', revision: previous, runId: 4, attempt: 1, verified: true, artifactId: 12}, authorization: {repo: api.repo, pr: 7, head: candidate, base: previous, tree: 'c'.repeat(40), run: {repo: api.repo, workflow: '.github/workflows/held-release.yaml', revision: previous, runId: 4, attempt: 1}, authority: {kind: 'review', reviewId: 8, userId: config.ownerId}}})
    if (variant === 'proved') io.releaseProof.mockResolvedValue({state: 'present', value: {version, source: main, digest: newDigest, smoke: 'pass', trivy: 'pass', enforced: true}})
    io.allocations.mockResolvedValue({state: 'present', value: [{runId: 10, attempt: 1, source: main, version, tag: 'ci-10-1'}]})
    const steps = ['🧪 Smoke-test candidate image by digest', '🚦 Enforce fixed HIGH/CRITICAL vulnerabilities', '🏷️ Promote latest image tag'].map(name => ({name, status: 'completed', conclusion: 'success'}))
    mocks.pages.mockImplementation(async path => {
      if (path.startsWith('/git/matching-refs/')) return path.endsWith(oldVersion) ? [{ref: `refs/tags/${oldVersion}`, object: {type: 'commit', sha: previous}}] : [{ref: `refs/tags/${version}`, object: {type: 'commit', sha: main}}]
      if (path.startsWith('/actions/runs?')) return [{id: 9, run_attempt: 1, head_sha: previous, head_branch: 'main', workflow_id: 6, path: '.github/workflows/release.yaml', repository: {id: 3, full_name: api.repo}, head_repository: {id: 3, full_name: api.repo}, event: 'push', status: 'completed', conclusion: 'success'}]
      if (path === '/actions/runs/9/attempts/1/jobs') return [{name: 'Release', run_id: 9, run_attempt: 1, head_sha: previous, status: 'completed', conclusion: 'success', steps}]
      throw new Error('unexpected path')
    })
    const runtime = createReleaseState(config, api, io)
    expect((await runtime.load()).prior.state).toBe(variant === 'proved' ? 'unresolved' : 'unknown')
    expect((await runtime.handoff(main, true)).kind).toBe(variant === 'proved' ? 'handoff' : 'stop')
    expect(assets).not.toHaveBeenCalled()
  })
  it('returns the proved settled generated predecessor with direct owner clearance', async () => {
    const {api, io, mocks} = fixture()
    const parent = 'd'.repeat(40)
    const digest = `sha256:${'e'.repeat(64)}`
    const version = '2026.11.2'
    mocks.releasePages.mockResolvedValue([{tag_name: version, body: renderReleaseBody(api.repo, {version, source: main, digest, notes: 'notes'}), draft: false, prerelease: false}])
    io.firstParent.mockResolvedValue({state: 'present', value: [main, parent]})
    io.image.mockResolvedValue({state: 'present', value: {digest}} as never)
    io.releaseProof.mockResolvedValue({state: 'present', value: {version, source: main, digest, smoke: 'pass', trivy: 'pass', enforced: true}})
    io.commit.mockResolvedValue({state: 'present', value: {sha: main, parents: [parent], tree: 'f'.repeat(40), message: 'Release\n\nFro-Release-Authorization: 12\n', paths: ['docs/releases/batch.md']}})
    io.provedSource.mockResolvedValue({origin: {repo: api.repo, workflow: '.github/workflows/held-release.yaml', revision: parent, runId: 4, attempt: 1, verified: true, artifactId: 12}, authorization: {repo: api.repo, pr: 7, head: candidate, base: parent, tree: 'f'.repeat(40), run: {repo: api.repo, workflow: '.github/workflows/held-release.yaml', revision: parent, runId: 4, attempt: 1}, authority: {kind: 'review', reviewId: 8, userId: config.ownerId}}})
    mocks.pages.mockImplementation(async path => {
      if (path.startsWith('/git/matching-refs/')) return [{ref: `refs/tags/${version}`, object: {type: 'commit', sha: main}}]
      if (path.startsWith('/actions/runs?')) return []
      if (path.endsWith('/labels')) return []
      if (path.endsWith('/timeline')) return [{event: 'unlabeled', label: {name: 'release-hold'}, actor: {id: config.ownerId}, created_at: '2026-11-18T15:01:00Z'}]
      throw new Error('unexpected path')
    })
    settledFixture({api, io, mocks}, [{source: main, parent, pr: 7, version}], digest)
    expect(await createReleaseState(config, api, io).load()).toMatchObject({predecessorCandidate: {number: 7, head: candidate, merge: main, clearance: 'cleared'}})
    mocks.releasePages.mockResolvedValue([{tag_name: version, body: renderReleaseBody(api.repo, {version, source: main, digest, notes: 'notes'}), draft: false, prerelease: false}, {tag_name: '2026.11.1', body: 'malformed', draft: false, prerelease: false}])
    expect(await createReleaseState(config, api, io).load()).toMatchObject({predecessor: null, prior: {state: 'unknown'}})
  })
  it.each(['clean', 'draft', 'reserved', 'unknown-commit', 'proved', 'bad-proof', 'proved-draft', 'proved-draft-multiple', 'proved-draft-unknown'])('observes a verified legacy predecessor and blocks unsafe changes: %s', async variant => {
    const {api, io, mocks} = fixture()
    const source = 'd'.repeat(40)
    const digest = `sha256:${'e'.repeat(64)}`
    const version = '2026.11.1'
    const body = renderReleaseBody(api.repo, {version, source, digest, notes: 'notes'})
    const draftVersion = '2026.11.2'
    const draftBody = renderReleaseBody(api.repo, {version: draftVersion, source: main, digest, notes: 'batch'})
    const hasDraft = variant.startsWith('proved-draft')
    mocks.releasePages.mockResolvedValue([{tag_name: version, body, draft: false, prerelease: false}, ...(variant === 'draft' ? [{tag_name: 'stranger', body: '', draft: true, prerelease: false}] : hasDraft ? [{tag_name: draftVersion, body: draftBody, draft: true, prerelease: false}] : [])])
    io.firstParent.mockResolvedValue({state: 'present', value: [main, source]})
    io.image.mockResolvedValue({state: 'present', value: {digest}} as never)
    const reserved = ['reserved', 'proved', 'bad-proof'].includes(variant) || hasDraft
    io.commit.mockImplementation(async (_dir, value) => value === source ? {state: 'present', value: {sha: source, parents: [], tree: 'f'.repeat(40), message: 'legacy', paths: []}} : variant === 'unknown-commit' ? {state: 'unknown', reason: 'read-failed'} : {state: 'present', value: {sha: main, parents: [source], tree: 'f'.repeat(40), message: variant === 'reserved' ? 'manual\n' : reserved ? 'Release\n\nFro-Release-Authorization: 12\n' : 'ordinary\n', paths: [reserved ? 'docs/releases/batch.md' : 'src/server.ts']}})
    const record: AuthorizationRecord = {origin: {repo: api.repo, workflow: '.github/workflows/held-release.yaml', revision: source, runId: 4, attempt: 1, verified: true, artifactId: 12}, authorization: {repo: api.repo, pr: 7, head: candidate, base: source, tree: 'f'.repeat(40), run: {repo: api.repo, workflow: '.github/workflows/held-release.yaml', revision: source, runId: 4, attempt: 1}, authority: {kind: 'review', reviewId: 8, userId: variant === 'bad-proof' ? 1 : config.ownerId}}}
    if (variant === 'proved' || variant === 'bad-proof' || hasDraft) io.provedSource.mockResolvedValue(record)
    if (hasDraft) io.allocations.mockResolvedValue({state: 'present', value: [{runId: 10, attempt: 1, source: main, version: draftVersion, tag: 'ci-10-1'}, ...(variant === 'proved-draft' ? [] : [{runId: 11, attempt: 1, source: main, version: draftVersion, tag: 'ci-11-1'}])]})
    if (variant === 'proved-draft-multiple' || variant === 'proved-draft-unknown') io.image.mockImplementation(async tag => (tag === 'ci-11-1' ? variant === 'proved-draft-multiple' ? {state: 'absent'} : {state: 'unknown', reason: 'read-failed'} : {state: 'present', value: {digest}}) as never)
    const steps = ['🧪 Smoke-test candidate image by digest', '🚦 Enforce fixed HIGH/CRITICAL vulnerabilities', '🏷️ Promote latest image tag'].map(name => ({name, status: 'completed', conclusion: 'success'}))
    mocks.pages.mockImplementation(async path => {
      if (path.startsWith('/git/matching-refs/')) return path.endsWith(version) ? [{ref: `refs/tags/${version}`, object: {type: 'commit', sha: source}}] : []
      if (path.startsWith('/actions/runs?')) return [{id: 9, run_attempt: 1, head_sha: source, head_branch: 'main', workflow_id: 6, path: '.github/workflows/release.yaml', repository: {id: 3, full_name: api.repo}, head_repository: {id: 3, full_name: api.repo}, event: 'push', status: 'completed', conclusion: 'success'}]
      if (path === '/actions/runs/9/attempts/1/jobs') return [{name: 'Release', run_id: 9, run_attempt: 1, head_sha: source, status: 'completed', conclusion: 'success', steps}]
      throw new Error('unexpected path')
    })
    const runtime = createReleaseState(config, api, io)
    const state = await runtime.load()
    expect(state.predecessor).toEqual({version, source, digest})
    expect(state.prior.state).toBe(variant === 'clean' ? 'clear' : ['proved', 'proved-draft', 'proved-draft-multiple'].includes(variant) ? 'unresolved' : 'unknown')
    if (variant === 'proved') {
      expect(await runtime.authorization(12)).toEqual(record)
      expect(await runtime.recoveryRevision(record)).toBe(true)
      expect(await runtime.authorization(13)).toBeNull()
    }
    if (variant === 'proved-draft' || variant === 'proved-draft-multiple') {
      expect(await runtime.handoff(main, true)).toMatchObject({kind: 'handoff', source: main, version: draftVersion, action: 'gate', recovery: true, original: {runId: 10, attempt: 1, digest}})
      expect(await createReleaseState({...config, revision: source}, api, io).handoff(main, false)).toMatchObject({kind: 'handoff', recovery: false, source: main})
      expect((await createReleaseState({...config, revision: candidate}, api, io).handoff(main, false)).kind).toBe('stop')
      expect((await runtime.handoff(candidate, true)).kind).toBe('stop')
      mocks.releasePages.mockResolvedValueOnce([{tag_name: version, body, draft: false, prerelease: false}, {tag_name: draftVersion, body: draftBody, draft: true, prerelease: false}, {tag_name: 'other', body: '', draft: true, prerelease: false}])
      expect((await runtime.load()).prior.state).toBe('unknown')
    }
  })
})

function archive(text: string): Buffer {
  const name = Buffer.from('release-authorization.json')
  const data = Buffer.from(text)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034B50)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014B50)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + data.length, 16)
  return Buffer.concat([local, name, data, central, name, end])
}

describe('fresh authorization authority', () => {
  it.each([831617, 1])('only accepts authenticated current-run owner review (user %i)', async userId => {
    const {api, io, mocks} = fixture()
    const tuple = {repo: 'fro-bot/dashboard', pr: 7, head: candidate, base: main, tree: 'c'.repeat(40)}
    const workflow = '.github/workflows/held-release.yaml'
    const auth = {...tuple, run: {repo: tuple.repo, workflow, revision: main, runId: 5, attempt: 1}, authority: {kind: 'review', reviewId: 8, userId}}
    const zip = archive(JSON.stringify(auth))
    const artifact = {id: 12, name: 'release-authorization-5-1', expired: false, digest: `sha256:${createHash('sha256').update(zip).digest('hex')}`, workflow_run: {id: 5, repository_id: 3, head_repository_id: 3, head_branch: 'main', head_sha: main}}
    const run = {id: 5, run_attempt: 1, repository: {id: 3, full_name: tuple.repo}, head_repository: {id: 3, full_name: tuple.repo}, workflow_id: 4, path: workflow, head_branch: 'main', head_sha: main, event: 'workflow_run', status: 'in_progress', conclusion: null}
    const get = async (path: string): Promise<unknown> => {
      if (path === '/git/ref/heads/main') return {ref: 'refs/heads/main', object: {type: 'commit', sha: main}}
      if (path === '/actions/workflows/held-release.yaml') return {id: 4, path: workflow}
      if (path === '/actions/artifacts/12') return artifact
      if (path === '/actions/runs/5/attempts/1') return run
      throw new Error('unexpected path')
    }
    Object.assign(api, {get, artifactZip: async () => zip})
    const result = await createReleaseState(config, api, io).authorization(12, tuple)
    if (userId === config.ownerId) expect(result?.authorization).toEqual(auth)
    else expect(result).toBeNull()
    expect(mocks.releasePages).toHaveBeenCalled()
    expect(await createReleaseState(config, api, io).authorization(12, {...tuple, tree: 'd'.repeat(40)})).toBeNull()
    expect(await createReleaseState({...config, runId: 6}, api, io).authorization(12, tuple)).toBeNull()
  })

  it.each(['valid', 'bad-slot', 'bad-event', 'bad-day'])('binds schedule authorization to the trusted original run: %s', async variant => {
    const {api, io} = fixture()
    const tuple = {repo: api.repo, pr: 7, head: candidate, base: main, tree: 'c'.repeat(40)}
    const workflow = '.github/workflows/held-release.yaml'
    const scheduled = {...config, event: variant === 'bad-event' ? 'workflow_run' as const : 'schedule' as const, schedule: '0 15 * * 3'}
    const slot = `${variant === 'bad-slot' ? '2026-11-19' : '2026-11-18'}/0 15 * * 3`
    const auth = {...tuple, run: {repo: api.repo, workflow, revision: main, runId: 5, attempt: 1}, authority: {kind: 'schedule', slot}}
    const zip = archive(JSON.stringify(auth))
    const artifact = {id: 12, name: 'release-authorization-5-1', expired: false, digest: `sha256:${createHash('sha256').update(zip).digest('hex')}`, workflow_run: {id: 5, repository_id: 3, head_repository_id: 3, head_branch: 'main', head_sha: main}}
    const run = {id: 5, run_attempt: 1, repository: {id: 3, full_name: api.repo}, head_repository: {id: 3, full_name: api.repo}, workflow_id: 4, path: workflow, head_branch: 'main', head_sha: main, event: scheduled.event, status: 'in_progress', conclusion: null, created_at: variant === 'bad-day' ? '2026-11-19T15:00:00Z' : '2026-11-18T15:00:00Z'}
    Object.assign(api, {get: async (path: string) => {
      if (path === '/git/ref/heads/main') return {ref: 'refs/heads/main', object: {type: 'commit', sha: main}}
      if (path === '/actions/workflows/held-release.yaml') return {id: 4, path: workflow}
      if (path === '/actions/artifacts/12') return artifact
      if (path === '/actions/runs/5/attempts/1' || path === '/actions/runs/5') return run
      throw new Error('unexpected path')
    }, artifactZip: async () => zip})
    const result = await createReleaseState(scheduled, api, io).authorization(12, tuple)
    expect(result?.authorization ?? null).toEqual(variant === 'valid' ? auth : null)
  })
})

describe('scheduled authority', () => {
  it.each(['none', 'owner', 'other', 'held'])('carries only an untouched previous owner clearance: %s', async kind => {
    const {api, io, mocks} = fixture()
    const previous = {number: 6, head: candidate, merge: main, clearance: 'cleared' as const}
    mocks.pages.mockImplementation(async path => {
      if (path.endsWith('/labels')) return kind === 'held' ? [{name: 'release-hold'}] : []
      if (kind === 'owner' || kind === 'other') return [{event: 'unlabeled', label: {name: 'release-hold'}, actor: {id: kind === 'owner' ? config.ownerId : 1}, created_at: '2026-11-18T15:01:00Z'}]
      return []
    })
    const result = await createReleaseState(config, api, io).scheduleState?.(7, previous)
    expect(result?.hold.source).toBe(kind === 'owner' ? 'owner' : 'unknown')
  })
  it('reads live owner clearance but keeps the slot consumed without a complete artifact scan', async () => {
    const {api, io, mocks} = fixture()
    mocks.pages.mockImplementation(async path => path.endsWith('/timeline') ? [{event: 'unlabeled', label: {name: 'release-hold'}, actor: {id: config.ownerId}, created_at: '2026-11-18T15:01:00Z'}] : [])
    const schedule = createReleaseState(config, api, io).scheduleState
    expect(schedule).toBeDefined()
    expect(await schedule?.(7, undefined)).toEqual({hold: {state: 'clear', source: 'owner', pr: 7, ownerId: config.ownerId, clearancePr: 7, verified: true}, slotUsed: true})
    expect(mocks.pages.mock.calls.map(([path]) => path)).toEqual(['/issues/7/labels', '/issues/7/timeline'])
  })

  it.each(['absent', 'other-user', 'held', 'read-failed'])('does not authorize uncertain or held clearance: %s', async kind => {
    const {api, io, mocks} = fixture()
    mocks.pages.mockImplementation(async path => {
      if (kind === 'read-failed') throw new Error('offline')
      if (path.endsWith('/labels')) return kind === 'held' ? [{name: 'release-hold'}] : []
      return kind === 'other-user' ? [{event: 'unlabeled', label: {name: 'release-hold'}, actor: {id: 1}, created_at: '2026-11-18T15:01:00Z'}] : []
    })
    const result = await createReleaseState(config, api, io).scheduleState?.(7, undefined)
    expect(result?.slotUsed).toBe(true)
    expect(result?.hold.state).not.toBe('clear')
  })

  it.each(['empty', 'rival', 'unavailable', 'review', 'early'])('consumes a slot only after a complete rival scan: %s', async kind => {
    const {api, io, mocks} = fixture()
    const scheduled = {...config, event: 'schedule' as const, schedule: '0 15 * * 3'}
    const workflow = '.github/workflows/held-release.yaml'
    const run = {id: 5, run_attempt: 1, head_sha: main, head_branch: 'main', path: workflow, event: 'schedule', status: 'in_progress', created_at: '2026-11-18T15:00:00Z', repository: {id: 3, full_name: api.repo}, head_repository: {id: 3, full_name: api.repo}}
    Object.assign(api, {get: async (path: string) => {
      if (path === '/git/ref/heads/main') return {ref: 'refs/heads/main', object: {type: 'commit', sha: main}}
      if (path === '/actions/workflows/held-release.yaml') return {id: 4, path: workflow}
      if (path.startsWith('/actions/runs/5')) return run
      throw new Error('unexpected path')
    }})
    mocks.pages.mockImplementation(async path => {
      if (path.includes('/actions/workflows/')) {
        if (kind === 'unavailable') throw new Error('offline')
        return ['rival', 'review', 'early'].includes(kind) ? [{...run, id: 6, workflow_id: 4, event: kind === 'review' ? 'workflow_run' : 'schedule', created_at: kind === 'early' ? '2026-11-18T14:00:00Z' : run.created_at}] : []
      }
      if (path === '/actions/runs/6/artifacts') return [{id: 99, name: 'release-authorization-6-1', expired: false}]
      return []
    })
    const result = await createReleaseState(scheduled, api, io).scheduleState?.(7, undefined)
    expect(result?.slotUsed).toBe(kind === 'rival' || kind === 'unavailable')
  })
})
