import {describe, expect, it} from 'vitest'
import {observeHandoff, observePredecessor, readPublicReleases, readVersionRef} from '../scripts/release/github-release-state.ts'
import {renderReleaseBody} from '../scripts/release/publisher.ts'

describe('publication release observations', () => {
  it('reads the complete App-authorized release list, including drafts', async () => {
    const draft = {tag_name: '2026.11.1', body: 'draft', draft: true, prerelease: false}
    const api = {releasePages: async () => [draft]}
    expect(await readPublicReleases(api)).toEqual({state: 'present', value: [{tag: draft.tag_name, body: draft.body, draft: true, prerelease: false}]})
  })

  it('preserves release identity and exact author, rejecting incomplete metadata', async () => {
    const author = {id: 123, login: 'release[bot]', type: 'Bot'}
    const wire = {id: 42, author, tag_name: '2026.11.1', body: 'body', draft: false, prerelease: false}
    expect(await readPublicReleases({releasePages: async () => [wire]})).toEqual({state: 'present', value: [{id: 42, author, tag: wire.tag_name, body: wire.body, draft: false, prerelease: false}]})
    expect(await readPublicReleases({releasePages: async () => [{...wire, author: {...author, id: 0}}]})).toEqual({state: 'unknown', reason: 'malformed'})
    expect(await readPublicReleases({releasePages: async () => [{...wire, id: undefined}]})).toEqual({state: 'unknown', reason: 'malformed'})
  })

  it('fails closed on malformed or unreadable release lists', async () => {
    expect(await readPublicReleases({releasePages: async () => [{tag_name: '2026.11.1'}]})).toEqual({state: 'unknown', reason: 'malformed'})
    expect(await readPublicReleases({releasePages: async () => {
      throw new Error('offline')
    }})).toEqual({state: 'unknown', reason: 'read-failed'})
  })
})

const repo = 'fro-bot/dashboard'
const source = 'a'.repeat(40)
const nextSource = 'b'.repeat(40)
const digest = `sha256:${'c'.repeat(64)}`
const nextDigest = `sha256:${'d'.repeat(64)}`
const identity = {version: '2026.11.1', source, digest}
const pendingIdentity = {version: '2026.11.2', source: nextSource, digest: nextDigest}
const present = <T>(value: T): {state: 'present'; value: T} => ({state: 'present', value})
const absent = {state: 'absent' as const}
const unknown = {state: 'unknown' as const, reason: 'read-failed' as const}
const release = (value: typeof identity) => ({tag: value.version, body: renderReleaseBody(repo, {...value, notes: 'notes'}), draft: false, prerelease: false})
const input = {repo, firstParent: present([nextSource, source]), releases: present([release(identity)])}
const ports = {
  api: {pages: async () => [{ref: `refs/tags/${identity.version}`, object: {type: 'commit', sha: source}}]},
  image: async (_tag: string) => present({digest}),
  gate: async () => present({...identity, smoke: 'pass' as const, trivy: 'pass' as const, enforced: true}),
  pending: async () => absent,
}

describe('predecessor observation', () => {
  it('verifies the public identity against tag, aliases, latest, and authenticated gate', async () => {
    expect(await observePredecessor(input, ports)).toEqual({kind: 'predecessor', predecessor: identity})
  })
  it('recognizes only an independently authenticated public-before-latest partial', async () => {
    const result = await observePredecessor({...input, releases: present([release(identity), release(pendingIdentity)])}, {
      ...ports, pending: async () => present(pendingIdentity),
    })
    expect(result).toEqual({kind: 'predecessor', predecessor: identity})
  })
  it('fails closed on unknown pending proof and mismatched latest', async () => {
    expect(await observePredecessor(input, {...ports, pending: async () => unknown})).toMatchObject({kind: 'stop'})
    expect(await observePredecessor(input, {...ports, image: async () => present({digest: nextDigest})})).toMatchObject({kind: 'stop'})
  })
})

describe('handoff observation', () => {
  const base = {
    repo,
    api: {pages: async () => []},
    image: async (_tag: string) => absent,
    allocations: async (_source: string) => present([]),
    nextVersion: async () => present('2026.11.2'),
    pending: async () => absent,
  }
  it('allocates only after complete history and absent exact tag and aliases', async () => {
    expect(await observeHandoff(nextSource, identity, true, input.releases, base)).toEqual({kind: 'handoff', source: nextSource, predecessor: identity, recovery: true, version: '2026.11.2', action: 'build', original: null})
  })
  it('reuses an authenticated allocation and exact CI candidate without proposing a new version', async () => {
    const allocation = {version: '2026.11.2', source: nextSource, runId: 12, attempt: 1, tag: 'ci-12-1'}
    const nextVersion = async (): Promise<never> => {
      throw new Error('must not allocate')
    }
    const image = async (tag: string) => tag === allocation.tag ? present({digest: nextDigest}) : absent
    expect(await observeHandoff(nextSource, identity, true, input.releases, {...base, allocations: async () => present([allocation]), image, nextVersion})).toMatchObject({kind: 'handoff', version: allocation.version, action: 'gate', original: {runId: 12, attempt: 1, digest: nextDigest}})
  })
  it('blocks a rival newer release and unknown availability', async () => {
    expect(await observeHandoff(nextSource, identity, false, present([release(identity), release({...pendingIdentity, source: 'f'.repeat(40)})]), base)).toMatchObject({kind: 'stop'})
    expect(await observeHandoff(nextSource, identity, false, input.releases, {...base, image: async () => unknown})).toMatchObject({kind: 'stop'})
  })
  it('recovers a public partial only with matching proof, tag and aliases', async () => {
    const allocation = {version: pendingIdentity.version, source: nextSource, runId: 12, attempt: 1, tag: 'ci-12-1'}
    const image = async (_tag: string) => present({digest: nextDigest})
    const api = {pages: async () => [{ref: `refs/tags/${pendingIdentity.version}`, object: {type: 'commit', sha: nextSource}}]}
    const options = {...base, api, image, allocations: async () => present([allocation]), pending: async () => present(pendingIdentity)}
    const releases = present([release(identity), release(pendingIdentity)])
    expect(await observeHandoff(nextSource, identity, true, releases, options)).toMatchObject({kind: 'handoff', action: 'gate', version: pendingIdentity.version})
    expect(await observeHandoff(nextSource, identity, true, releases, {...options, pending: async () => unknown})).toMatchObject({kind: 'stop'})
    expect(await observeHandoff(nextSource, identity, true, releases, {...options, api: base.api})).toMatchObject({kind: 'stop'})
  })
})

describe('version refs', () => {
  it('distinguishes exact refs from prefix matches and refuses annotated tags', async () => {
    const sha = 'a'.repeat(40)
    const entry = (tag: string, type = 'commit') => ({ref: `refs/tags/${tag}`, object: {sha, type}})
    const read = async (records: unknown[]) => readVersionRef({pages: async () => records}, '2026.11.1')
    expect(await read([entry('2026.11.10')])).toEqual({state: 'absent'})
    expect(await read([entry('2026.11.1')])).toEqual({state: 'present', value: {version: '2026.11.1', sha}})
    expect(await read([entry('2026.11.1', 'tag')])).toEqual({state: 'unknown', reason: 'malformed'})
    expect(await read([entry('2026.11.1'), entry('2026.11.1')])).toEqual({state: 'unknown', reason: 'malformed'})
  })
})
