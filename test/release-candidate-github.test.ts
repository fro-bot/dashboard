import type {CandidateInput, CandidatePort} from '../scripts/release/candidate-github.ts'

import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import process from 'node:process'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {discoverBatch} from '../scripts/release/batch.ts'
import {holdProof, inspectCandidate, prepareCandidate} from '../scripts/release/candidate-github.ts'
import {createCandidate} from '../scripts/release/candidate.ts'

let dir: string
let input: CandidateInput
let pulls: unknown[]
let remote: string | null
let timeline: unknown[]
let pushes: Parameters<CandidatePort['pushCandidate']>[0][]
let writes: {path: string; body: unknown}[]
let port: CandidatePort

function git(...args: string[]) {
  return execFileSync('git', args, {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()
}
function put(path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), {recursive: true})
  writeFileSync(join(dir, path), text)
}
function commit(message: string) {
  git('add', '--all')
  git('commit', '--no-gpg-sign', '--quiet', '-m', message)
  return git('rev-parse', 'HEAD')
}
function pull(head: string, overrides: Record<string, unknown> = {}) {
  return {number: 7, state: 'open', user: {id: 42}, head: {ref: 'release/pending', sha: head, repo: {full_name: 'fro-bot/dashboard'}}, base: {ref: 'main', repo: {full_name: 'fro-bot/dashboard'}}, labels: [], merge_commit_sha: null, ...overrides}
}
function candidate(base = input.main) {
  const notes = discoverBatch({repoDir: dir, baseline: input.baseline, main: base})?.notes
  if (notes === undefined) throw new Error('fixture needs notes')
  return createCandidate({repoDir: dir, base, notes}).head
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'candidate-github-'))
  git('init', '--quiet', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  put('package.json', '{}')
  put('src/app.ts', 'one')
  const baseline = commit('baseline')
  put('src/app.ts', 'two')
  const main = commit('feature')
  input = {repo: 'fro-bot/dashboard', repoDir: dir, baseline, main, appUserId: 42, ownerId: 9}
  pulls = []
  remote = null
  timeline = []
  pushes = []
  writes = []
  port = {
    async get() { return remote === null ? null : {ref: 'refs/heads/release/pending', object: {type: 'commit', sha: remote}} },
    async list(path) { return path.includes('/timeline') ? timeline : pulls },
    async pushCandidate(value) {
      pushes.push(value)
      remote = value.head
    },
    async write(path, body) {
      writes.push({path, body})
      if (path.endsWith('/pulls')) {
        const created = pull(remote ?? '')
        pulls.push(created)
        return created
      }
      return [{name: 'release-hold'}]
    },
  }
})
afterEach(() => rmSync(dir, {recursive: true, force: true}))

describe('candidate hold proof', () => {
  it('recognizes a live hold label', () => {
    expect(holdProof({labels: [{name: 'release-hold'}], timeline: [], ownerId: 9})).toBe('held')
  })
  it('requires the last relevant chronological removal to be by the owner', () => {
    const event = (kind: string, actor: number, date: string) => ({event: kind, actor: {id: actor}, label: {name: 'release-hold'}, created_at: date})
    const events = [event('labeled', 42, '2026-01-01T00:00:00Z'), event('unlabeled', 9, '2026-01-02T00:00:00Z')]
    expect(holdProof({labels: [], timeline: events, ownerId: 9})).toBe('cleared')
    expect(holdProof({labels: [], timeline: [...events, event('unlabeled', 8, '2026-01-03T00:00:00Z')], ownerId: 9})).toBe('unknown')
    expect(holdProof({labels: [], timeline: events.toReversed(), ownerId: 9})).toBe('unknown')
    expect(holdProof({labels: [], timeline: [{event: 'committed'}, ...events, {event: 'commented'}], ownerId: 9})).toBe('cleared')
    expect(holdProof({labels: [], timeline: [event('labeled', 42, '2026-01-01T00:00:00.100Z'), event('unlabeled', 9, '2026-01-01T00:00:00.200Z')], ownerId: 9})).toBe('unknown')
  })
})

describe('GitHub candidate', () => {
  it('creates with an absent-ref lease and verifies additive hold', async () => {
    const paths: string[] = []
    const list = port.list
    port.list = async path => {
      paths.push(path)
      return list(path)
    }
    const result = await prepareCandidate(input, port)
    expect(result).toMatchObject({status: 'ready', held: true, number: 7})
    expect(pushes).toEqual([{repoDir: dir, head: remote, ref: 'refs/heads/release/pending', expected: null, args: ['push', '--force-with-lease=refs/heads/release/pending:', 'origin', `${remote}:refs/heads/release/pending`]}])
    expect(writes).toEqual([
      {path: '/repos/fro-bot/dashboard/pulls', body: {title: 'Prepare release batch', head: 'release/pending', base: 'main', body: 'Automated release batch.'}},
      {path: '/repos/fro-bot/dashboard/issues/7/labels', body: {labels: ['release-hold']}},
    ])
    expect(paths[0]).toBe('/repos/fro-bot/dashboard/pulls?state=all&head=fro-bot%3Arelease%2Fpending&per_page=100')
  })
  it('does not push an already identical verified candidate', async () => {
    remote = candidate()
    pulls = [pull(remote, {labels: [{name: 'release-hold'}]})]
    expect(await prepareCandidate(input, port)).toMatchObject({status: 'ready', held: true})
    expect(pushes).toEqual([])
    expect(writes).toEqual([])
  })
  it('uses the exact old head as lease for a validated stale candidate', async () => {
    remote = candidate()
    const old = remote
    pulls = [pull(old, {labels: [{name: 'release-hold'}]})]
    put('src/app.ts', 'three')
    input.main = commit('another feature')
    expect(await prepareCandidate(input, port)).toMatchObject({status: 'ready', held: true})
    expect(pushes[0]).toMatchObject({expected: old, ref: 'refs/heads/release/pending', head: remote})
    expect(pushes[0]?.args).toEqual(['push', `--force-with-lease=refs/heads/release/pending:${old}`, 'origin', `${remote}:refs/heads/release/pending`])
    expect(remote).not.toBe(old)
  })
  it('blocks foreign, duplicate, and mismatched branch identities', async () => {
    remote = candidate()
    for (const list of [[pull(remote, {user: {id: 8}})], [pull(remote), pull(remote, {number: 8})], [pull('0'.repeat(40))]]) {
      pulls = list
      expect((await inspectCandidate(input, port)).status).toBe('blocked')
    }
    expect(writes).toEqual([])
  })
  it('rejects a candidate with the right parent but the wrong notes tree', async () => {
    remote = createCandidate({repoDir: dir, base: input.main, notes: 'forged notes\n'}).head
    pulls = [pull(remote)]
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    expect(pushes).toEqual([])
  })
  it('recovers an interrupted creation without another push and reads back the hold', async () => {
    const write = port.write
    port.write = async () => {
      throw new Error('lost response')
    }
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    if (remote === null) throw new Error('candidate was not pushed')
    const tree = git('rev-parse', `${remote}^{tree}`)
    const original = execFileSync('git', ['commit-tree', tree, '-p', input.main, '-m', 'same tree'], {
      cwd: dir, encoding: 'utf8', env: {...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z'},
    }).trim()
    expect(original).not.toBe(remote)
    remote = original
    port.write = async (path, body) => {
      const result = await write(path, body)
      if (path.endsWith('/labels')) pulls = [pull(original, {labels: [{name: 'release-hold'}]})]
      return result
    }
    expect(await prepareCandidate(input, port)).toMatchObject({status: 'ready', head: original, held: true})
    expect(pushes).toHaveLength(1)
    expect(remote).toBe(original)
  })
  it('refuses orphan adoption for wrong tree, old main, closed use, or unreadable listings', async () => {
    remote = createCandidate({repoDir: dir, base: input.main, notes: 'forged\n'}).head
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    remote = candidate()
    pulls = [pull(remote, {state: 'closed', merge_commit_sha: null})]
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    pulls = []
    put('src/app.ts', 'three')
    input.main = commit('new main')
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    port.list = async () => {
      throw new Error('unreadable')
    }
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    expect(pushes).toEqual([])
    expect(writes).toEqual([])
  })
  it('fails closed if the created orphan pull cannot be re-observed', async () => {
    remote = candidate()
    const list = port.list
    port.list = async path => path.includes('/pulls?') && writes.length > 0 ? [] : list(path)
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    expect(pushes).toEqual([])
  })
  it('carries settled predecessor clearance onto a recovered orphan', async () => {
    const old = candidate()
    pulls = [pull(old, {state: 'closed', merge_commit_sha: input.baseline})]
    input.predecessor = {number: 7, head: old, merge: input.baseline, clearance: 'cleared'}
    put('src/app.ts', 'three')
    input.main = commit('new main')
    remote = candidate()
    const orphanHead = remote
    port.write = async (path, body) => {
      writes.push({path, body})
      const created = pull(orphanHead, {number: 8})
      pulls.push(created)
      return created
    }
    expect(await prepareCandidate(input, port)).toMatchObject({status: 'ready', head: orphanHead, number: 8, held: false})
    expect(pushes).toEqual([])
    expect(writes).toHaveLength(1)
  }, 15_000)
  it('refuses malformed listings and a ref changing before orphan creation', async () => {
    remote = candidate()
    pulls = [pull(remote, {user: {id: 99}})]
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    pulls = [{}]
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    pulls = [pull(remote, {head: {ref: 'other'}})]
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    pulls = []
    let reads = 0
    const get = port.get
    port.get = async path => ++reads === 2 ? null : get(path)
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
    expect(pushes).toEqual([])
    expect(writes).toEqual([])
  })
  it('honors owner clearance and blocks failed hold addition', async () => {
    remote = candidate()
    pulls = [pull(remote)]
    timeline = [{event: 'unlabeled', actor: {id: 9}, label: {name: 'release-hold'}, created_at: '2026-01-02T00:00:00Z'}]
    expect(await prepareCandidate(input, port)).toMatchObject({status: 'ready', held: false})
    expect(writes).toEqual([])
    timeline = []
    port.write = async () => {
      throw new Error('label failed')
    }
    expect((await prepareCandidate(input, port)).status).toBe('blocked')
  })
  it('carries only an explicitly verified settled predecessor clearance', async () => {
    remote = candidate()
    pulls = [pull(remote, {state: 'closed', merge_commit_sha: input.baseline})]
    input.predecessor = {number: 7, head: remote, merge: input.baseline, clearance: 'cleared'}
    expect(await inspectCandidate(input, port)).toMatchObject({status: 'absent', carry: true, lease: remote})
    input.predecessor.clearance = 'unknown'
    expect(await inspectCandidate(input, port)).toMatchObject({status: 'absent', carry: false})
    input.predecessor.merge = input.main
    expect((await inspectCandidate(input, port)).status).toBe('blocked')
  })
  it('carries a verified predecessor clearance after branch deletion', async () => {
    const old = candidate()
    pulls = [pull(old, {state: 'closed', merge_commit_sha: input.baseline})]
    input.predecessor = {number: 7, head: old, merge: input.baseline, clearance: 'cleared'}
    expect(await inspectCandidate(input, port)).toMatchObject({status: 'absent', carry: true, lease: null})
    expect(await prepareCandidate(input, port)).toMatchObject({status: 'ready', held: false})
    expect(writes).toHaveLength(1)
  })
  it('does not carry a missing or foreign predecessor after branch deletion', async () => {
    const old = candidate()
    input.predecessor = {number: 7, head: old, merge: input.baseline, clearance: 'cleared'}
    expect((await inspectCandidate(input, port)).status).toBe('blocked')
    pulls = [pull(old, {state: 'closed', merge_commit_sha: input.baseline, user: {id: 8}})]
    expect((await inspectCandidate(input, port)).status).toBe('blocked')
  })
  it('never carries clearance over an unverified current removal', async () => {
    const old = candidate()
    pulls = [pull(old, {state: 'closed', merge_commit_sha: input.baseline})]
    input.predecessor = {number: 7, head: old, merge: input.baseline, clearance: 'cleared'}
    timeline = [{event: 'unlabeled', actor: {id: 8}, label: {name: 'release-hold'}, created_at: '2026-01-02T00:00:00Z'}]
    expect(await prepareCandidate(input, port)).toMatchObject({status: 'ready', held: true})
    expect(writes[1]?.body).toEqual({labels: ['release-hold']})
  })
  it('returns safe failure codes rather than exception messages', async () => {
    port.list = async () => {
      throw new Error('secret-token')
    }
    const result = await inspectCandidate(input, port)
    expect(result).toEqual({status: 'blocked', reason: 'candidate-inspection-failed'})
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })
  it('returns a safe preparation failure without exposing write errors', async () => {
    port.write = async () => {
      throw new Error('secret-write-token')
    }
    const result = await prepareCandidate(input, port)
    expect(result).toEqual({status: 'blocked', reason: 'candidate-preparation-failed'})
  })
})
