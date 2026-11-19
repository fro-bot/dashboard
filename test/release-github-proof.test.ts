import type {TrustedOrigin} from '../scripts/release/release-evidence.ts'
import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {describe, expect, it} from 'vitest'
import {proveSquash} from '../scripts/release/gate.ts'
import {createGitHubApi} from '../scripts/release/github-release-api.ts'
import {mergeRelease, observeSettledReleaseMerge, proveReleaseSource, readArtifact, readAuthorization, readMergeFacts} from '../scripts/release/github-release-proof.ts'
import {releaseZip} from './release-test-zip.ts'

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

describe('release merge proof', () => {
  it('observes only independently corroborated settled merge facts, without an artifact', async () => {
    const repo = 'fro-bot/dashboard'
    const head = 'a'.repeat(40)
    const base = 'b'.repeat(40)
    const tree = 'c'.repeat(40)
    const squash = 'd'.repeat(40)
    const other = 'e'.repeat(40)
    const message = 'Release\n\nFro-Release-Authorization: 12'
    const bot = {appId: 1, botId: 2, botLogin: 'fro-bot[bot]'}
    const botUser = {id: 2, login: bot.botLogin, type: 'Bot'}
    const commit = {sha: squash, parents: [base], tree, message, paths: ['docs/releases/batch.md']}
    const pull = {number: 42, state: 'closed', merged: true, merge_commit_sha: squash, user: botUser, merged_by: botUser,
      head: {ref: 'release/pending', sha: head, repo: {full_name: repo}}, base: {ref: 'main', repo: {full_name: repo}}}
    const gitCommit = (sha: string) => ({sha, parents: [{sha: base}], commit: {tree: {sha: tree}, message}})
    let association: unknown = [{number: 42}]
    let remotePull: unknown = pull
    let remoteSquash: unknown = gitCommit(squash)
    let remoteHead: unknown = gitCommit(head)
    const api = createGitHubApi({repo, readToken: 'r', writeToken: 'w', fetch: async input => {
      const {pathname} = new URL(String(input))
      if (pathname.endsWith(`/commits/${squash}/pulls`)) return Response.json(association)
      if (pathname.endsWith('/pulls/42')) return Response.json(remotePull)
      if (pathname.endsWith(`/commits/${squash}`)) return Response.json(remoteSquash)
      if (pathname.endsWith(`/commits/${head}`)) return Response.json(remoteHead)
      throw new Error('unexpected request')
    }})
    const observe = async () => observeSettledReleaseMerge(api, commit, bot)
    expect(await observe()).toEqual({pr: 42, head})
    for (const bad of [[], [{number: 42}, {number: 43}], [{}]]) {
      association = bad
      expect(await observe()).toBeNull()
    }
    association = [{number: 42}]
    for (const bad of [
      {...pull, merged: false}, {...pull, state: 'open'}, {...pull, merge_commit_sha: other},
      {...pull, user: {...botUser, id: 3}}, {...pull, user: {...botUser, login: 'other'}},
      {...pull, merged_by: {...botUser, type: 'User'}}, {...pull, merged_by: {...botUser, id: 3}},
      {...pull, head: {...pull.head, ref: 'other'}}, {...pull, base: {...pull.base, ref: 'other'}},
      {...pull, head: {...pull.head, repo: {full_name: 'other/repo'}}},
    ]) {
      remotePull = bad
      expect(await observe()).toBeNull()
    }
    remotePull = pull
    for (const bad of [
      {...gitCommit(squash), sha: other}, {...gitCommit(squash), parents: [{sha: other}]},
      {...gitCommit(squash), parents: [{sha: base}, {sha: other}]},
      {...gitCommit(squash), commit: {tree: {sha: other}, message}},
      {...gitCommit(squash), commit: {tree: {sha: tree}, message: 'Release\n\nFro-Release-Authorization: 13'}},
      null,
    ]) {
      remoteSquash = bad
      expect(await observe()).toBeNull()
    }
    remoteSquash = gitCommit(squash)
    for (const bad of [
      {...gitCommit(head), sha: other}, {...gitCommit(head), parents: []},
      {...gitCommit(head), parents: [{sha: other}]}, {...gitCommit(head), parents: [{sha: base}, {sha: other}]},
      {...gitCommit(head), commit: {tree: {sha: other}}}, null,
    ]) {
      remoteHead = bad
      expect(await observe()).toBeNull()
    }
    remoteHead = gitCommit(head)
    for (const bad of [
      {...commit, sha: 'invalid'}, {...commit, parents: []}, {...commit, parents: [base, other]},
      {...commit, paths: []}, {...commit, paths: [...commit.paths, 'other']},
      {...commit, message: `${message}\nFro-Release-Authorization: 12`}, {...commit, message: 'Release'},
    ]) expect(await observeSettledReleaseMerge(api, bad, bot)).toBeNull()
    expect(await observeSettledReleaseMerge(api, commit, {...bot, appId: 0})).toBeNull()
  })

  it('sends exactly one head-pinned squash request with one canonical trailer', async () => {
    const requests: RequestInit[] = []
    const api = createGitHubApi({repo: 'fro-bot/dashboard', readToken: 'read', writeToken: 'write', fetch: async (_url, init) => {
      requests.push(init ?? {})
      throw new Error('lost response')
    }})
    await expect(mergeRelease(api, 42, 'a'.repeat(40), 12)).rejects.toThrow('GitHub API request failed')
    expect(requests).toHaveLength(1)
    expect(JSON.parse(String(requests[0]?.body))).toEqual({merge_method: 'squash', sha: 'a'.repeat(40), commit_title: 'Release dashboard (#42)', commit_message: 'Fro-Release-Authorization: 12'})
    expect(new Headers(requests[0]?.headers).get('authorization')).toBe('Bearer write')
  })

  it('fails closed for unavailable PR evidence', async () => {
    const api = createGitHubApi({repo: 'fro-bot/dashboard', readToken: 'read', writeToken: 'write', fetch: async () => new Response('', {status: 404})})
    expect(await readMergeFacts(api, {repo: 'fro-bot/dashboard', pr: 42, head: 'a'.repeat(40), base: 'b'.repeat(40), tree: 'c'.repeat(40)}, {appId: 1, botId: 2, botLogin: 'fro-bot[bot]'})).toBeNull()
  })

  it('authenticates exact run attempt and ZIP digest without sending the token to the asset host', async () => {
    const expected: TrustedOrigin = {kind: 'authorization', artifactId: 12, repo: 'fro-bot/dashboard', repositoryId: 3, workflowId: 4, workflow: '.github/workflows/release.yml', branch: 'main', revision: 'a'.repeat(40), runId: 5, attempt: 1}
    let archive = zip('release-authorization.json', '{"hello":"world"}')
    let digest = createHash('sha256').update(archive).digest('hex')
    let location = 'https://assets.example/signed'
    let returnedAttempt = 1
    const seen: {url: string; headers: Headers}[] = []
    const api = createGitHubApi({repo: expected.repo, readToken: 'read', writeToken: 'write', fetch: async (input, init) => {
      const url = String(input)
      seen.push({url, headers: new Headers(init?.headers)})
      if (url.endsWith('/actions/artifacts/12')) return Response.json({id: 12, name: 'release-authorization-5-1', expired: false, digest: `sha256:${digest}`, workflow_run: {id: 5, repository_id: 3, head_repository_id: 3, head_branch: 'main', head_sha: expected.revision}})
      if (url.endsWith('/actions/runs/5/attempts/1')) return Response.json({id: 5, run_attempt: returnedAttempt, repository: {id: 3, full_name: expected.repo}, head_repository: {id: 3, full_name: expected.repo}, workflow_id: 4, path: expected.workflow, head_branch: 'main', head_sha: expected.revision, event: 'push'})
      if (url.endsWith('/actions/artifacts/12/zip')) return new Response(null, {status: 302, headers: {location}})
      return new Response(new Uint8Array(archive))
    }})
    expect((await readArtifact(api, expected))?.text).toBe('{"hello":"world"}')
    expect(seen.map(call => call.url)).toContain('https://api.github.com/repos/fro-bot/dashboard/actions/runs/5/attempts/1')
    expect(seen.at(-1)?.headers.get('authorization')).toBeNull()
    expect(await readArtifact(api, {...expected, attempt: 2})).toBeNull()
    returnedAttempt = 2
    expect(await readArtifact(api, expected)).toBeNull()
    returnedAttempt = 1
    const candidate = {repo: expected.repo, pr: 9, head: 'b'.repeat(40), base: 'c'.repeat(40), tree: 'd'.repeat(40)}
    const authorization = {...candidate, run: {repo: expected.repo, workflow: expected.workflow, revision: expected.revision, runId: 5, attempt: 1}, authority: {kind: 'review', reviewId: 3, userId: 4}}
    archive = zip('release-authorization.json', JSON.stringify(authorization))
    digest = createHash('sha256').update(archive).digest('hex')
    expect((await readAuthorization(api, expected, candidate))?.authorization).toEqual(authorization)
    expect(await readAuthorization(api, expected, {...candidate, head: 'e'.repeat(40)})).toBeNull()
    archive = releaseZip('release-authorization.json', JSON.stringify(authorization))
    digest = createHash('sha256').update(archive).digest('hex')
    expect((await readAuthorization(api, expected, candidate))?.authorization).toEqual(authorization)
    // Re-sign the damaged archive so the failure exercises inflation, not digest mismatch.
    archive[30 + Buffer.byteLength('release-authorization.json')] = 0xFF
    digest = createHash('sha256').update(archive).digest('hex')
    expect(await readArtifact(api, expected)).toBeNull()
    archive = zip('payload.json', JSON.stringify(authorization))
    digest = createHash('sha256').update(archive).digest('hex')
    expect(await readArtifact(api, expected)).toBeNull()
    archive = zip('release-authorization.json', '{"hello":"tampered"}')
    expect(await readArtifact(api, expected)).toBeNull()
    location = 'http://assets.example/signed'
    const count = seen.length
    expect(await readArtifact(api, expected)).toBeNull()
    expect(seen.slice(count).some(call => call.url.startsWith('http://'))).toBe(false)
  })

  it('proves the squash from its actual parent, tree, actor and paginated association', async () => {
    const head = 'a'.repeat(40)
    const base = 'b'.repeat(40)
    const tree = 'c'.repeat(40)
    const squash = 'd'.repeat(40)
    const expected = {repo: 'fro-bot/dashboard', pr: 42, head, base, tree}
    let message = 'Release\n\nFro-Release-Authorization: 12'
    let parent = base
    const api = createGitHubApi({repo: expected.repo, readToken: 'read', writeToken: 'write', fetch: async input => {
      const url = String(input)
      if (url.endsWith('/pulls/42')) return Response.json({number: 42, merged: true, merge_commit_sha: squash, head: {sha: head, repo: {full_name: expected.repo}}, base: {sha: 'e'.repeat(40), repo: {full_name: expected.repo}}, merged_by: {id: 2, login: 'fro-bot[bot]', type: 'Bot'}})
      if (url.includes('/pulls?')) return Response.json([{number: 42}])
      return Response.json({sha: squash, parents: [{sha: parent}], commit: {tree: {sha: tree}, message}})
    }})
    const run = {repo: expected.repo, workflow: '.github/workflows/release.yml', revision: 'f'.repeat(40), runId: 5, attempt: 1}
    const record = {origin: {...run, verified: true, artifactId: 12}, authorization: {...expected, run, authority: {kind: 'review' as const, reviewId: 1, userId: 1}}}
    const trusted = {repo: expected.repo, workflow: run.workflow, revision: run.revision, appId: 1}
    const read = async () => readMergeFacts(api, expected, {appId: 1, botId: 2, botLogin: 'fro-bot[bot]'})
    expect(proveSquash(record, await read(), trusted)).toBe(squash)
    parent = 'e'.repeat(40)
    expect(proveSquash(record, await read(), trusted)).toBeNull()
    parent = base
    message += '\nFro-Release-Authorization: 12'
    expect(proveSquash(record, await read(), trusted)).toBeNull()
  })

  it('recovers only a proved notes-only squash and its original owner authorization', async () => {
    const repo = 'fro-bot/dashboard'
    const head = 'a'.repeat(40)
    const base = 'b'.repeat(40)
    const tree = 'c'.repeat(40)
    const squash = 'd'.repeat(40)
    const message = 'Release\n\nFro-Release-Authorization: 12'
    const bot = {appId: 1, botId: 2, botLogin: 'fro-bot[bot]'}
    const botUser = {id: bot.botId, login: bot.botLogin, type: 'Bot'}
    const expected = {repo, pr: 42, head, base, tree}
    let actor = botUser
    const api = createGitHubApi({repo, readToken: 'r', writeToken: 'w', fetch: async input => {
      const {pathname} = new URL(String(input))
      if (pathname.endsWith(`/commits/${squash}/pulls`)) return Response.json([{number: 42}])
      if (pathname.endsWith('/pulls/42')) return Response.json({number: 42, state: 'closed', merged: true, merge_commit_sha: squash, user: actor, merged_by: botUser, head: {ref: 'release/pending', sha: head, repo: {full_name: repo}}, base: {ref: 'main', repo: {full_name: repo}}})
      const sha = pathname.endsWith(`/commits/${squash}`) ? squash : head
      return Response.json({sha, parents: [{sha: base}], commit: {tree: {sha: tree}, message}})
    }})
    const run = {repo, workflow: '.github/workflows/held-release.yaml', revision: base, runId: 5, attempt: 1}
    const record = {origin: {...run, verified: true, artifactId: 12}, authorization: {...expected, run, authority: {kind: 'review' as const, reviewId: 1, userId: 9}}}
    const commit = {sha: squash, parents: [base], tree, message, paths: ['docs/releases/batch.md']}
    const authorize = async (id: number, candidate: typeof expected) => {
      expect(id).toBe(12)
      expect(candidate).toEqual(expected)
      return record
    }
    expect(await proveReleaseSource(api, commit, bot, 9, authorize)).toEqual(record)
    expect(await proveReleaseSource(api, {...commit, paths: [...commit.paths, 'src/server.ts']}, bot, 9, authorize)).toBeNull()
    expect(await proveReleaseSource(api, commit, bot, 10, authorize)).toBeNull()
    actor = {...botUser, id: 3}
    expect(await proveReleaseSource(api, commit, bot, 9, authorize)).toBeNull()
  })
})
