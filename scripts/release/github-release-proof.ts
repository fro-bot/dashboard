import type {CommitFacts} from './controller-io.ts'
import type {AuthorizationRecord} from './controller.ts'
import type {MergeFacts} from './gate.ts'
import type {GitHubApi} from './github-release-api.ts'
import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {inflateRawSync} from 'node:zlib'
import {BATCH_NOTES_PATH} from './candidate.ts'
import {proveSquash} from './gate.ts'
import {parseAuthorization, validateOrigin, type ObservedOrigin, type TrustedOrigin} from './release-evidence.ts'

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40}$/u.test(v)
const id = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** Accept only a single, ordinary ZIP entry; never extract to disk. */
function jsonEntry(zip: Uint8Array, name: string): string | null {
  try {
    const b = Buffer.from(zip)
    if (b.length < 22 || b.readUInt32LE(b.length - 22) !== 0x06054B50 || b.readUInt16LE(b.length - 2) !== 0 ||
      b.readUInt16LE(b.length - 18) !== 0 || b.readUInt16LE(b.length - 16) !== 0 ||
      b.readUInt16LE(b.length - 14) !== 1 || b.readUInt16LE(b.length - 12) !== 1) return null
    const size = b.readUInt32LE(b.length - 10)
    const offset = b.readUInt32LE(b.length - 6)
    if (offset + size !== b.length - 22 || size < 46 || b.readUInt32LE(offset) !== 0x02014B50) return null
    const flags = b.readUInt16LE(offset + 8)
    const method = b.readUInt16LE(offset + 10)
    const compressed = b.readUInt32LE(offset + 20)
    const uncompressed = b.readUInt32LE(offset + 24)
    const nameLength = b.readUInt16LE(offset + 28)
    const extraLength = b.readUInt16LE(offset + 30)
    const commentLength = b.readUInt16LE(offset + 32)
    const local = b.readUInt32LE(offset + 42)
    if ((flags & ~0x808) !== 0 || ![0, 8].includes(method) || uncompressed > 1024 * 1024 ||
      46 + nameLength + extraLength + commentLength !== size ||
      b.subarray(offset + 46, offset + 46 + nameLength).toString('utf8') !== name ||
      local + 30 > offset || b.readUInt32LE(local) !== 0x04034B50 || b.readUInt16LE(local + 6) !== flags ||
      b.readUInt16LE(local + 8) !== method) return null
    const localName = b.readUInt16LE(local + 26)
    const localExtra = b.readUInt16LE(local + 28)
    const start = local + 30 + localName + localExtra
    if (b.subarray(local + 30, local + 30 + localName).toString('utf8') !== name || start + compressed > offset) return null
    const content = b.subarray(start, start + compressed)
    const plain = method === 0 ? content : inflateRawSync(content, {maxOutputLength: 1024 * 1024})
    if (plain.length !== uncompressed) return null
    return new TextDecoder('utf-8', {fatal: true}).decode(plain)
  } catch { return null }
}

/** expected must be independently established, including the accepted first-parent revision. */
export async function readArtifact(api: GitHubApi, expected: TrustedOrigin): Promise<{origin: ObservedOrigin; text: string} | null> {
  try {
    if (expected.repo !== api.repo || !id(expected.artifactId) || !id(expected.runId) || !id(expected.attempt) ||
      !id(expected.repositoryId) || !id(expected.workflowId) || !sha(expected.revision) || expected.branch !== 'main' ||
      !/^\.github\/workflows\/[\w.-]+\.ya?ml$/u.test(expected.workflow) ||
      !['allocation', 'gate', 'authorization'].includes(expected.kind)) return null
    const artifact = await api.get(`/actions/artifacts/${expected.artifactId}`)
    const run = await api.get(`/actions/runs/${expected.runId}/attempts/${expected.attempt}`)
    const zip = await api.artifactZip(expected.artifactId)
    const digest = `sha256:${createHash('sha256').update(zip).digest('hex')}`
    const origin = validateOrigin(expected, artifact, run, digest)
    const text = jsonEntry(zip, `release-${expected.kind}.json`)
    return origin && text !== null ? {origin, text} : null
  } catch { return null }
}

export async function readAuthorization(api: GitHubApi, origin: TrustedOrigin, expected: Pick<AuthorizationRecord['authorization'], 'repo' | 'pr' | 'head' | 'base' | 'tree'>): Promise<AuthorizationRecord | null> {
  const artifact = await readArtifact(api, origin)
  if (!artifact) return null
  const authorization = parseAuthorization(artifact.text, artifact.origin, expected)
  return authorization ? {origin: {...artifact.origin, verified: true}, authorization} : null
}

export async function mergeRelease(api: GitHubApi, pr: number, head: string, artifactId: number): Promise<void> {
  if (!id(pr) || !sha(head) || !id(artifactId)) throw new Error('GitHub API request failed')
  await api.put(`/pulls/${pr}/merge`, {merge_method: 'squash', sha: head, commit_title: `Release dashboard (#${pr})`, commit_message: `Fro-Release-Authorization: ${artifactId}`})
}

type Candidate = Pick<AuthorizationRecord['authorization'], 'repo' | 'pr' | 'head' | 'base' | 'tree'>
interface Bot {appId: number; botId: number; botLogin: string}

/** Observe historical merge facts only; this does not establish release authorization. */
export async function observeSettledReleaseMerge(api: GitHubApi, commit: CommitFacts, bot: Bot): Promise<{pr: number; head: string} | null> {
  try {
    const base = commit.parents[0]
    const artifactId = trailerId(commit.message)
    if (!sha(commit.sha) || !sha(base) || !sha(commit.tree) || commit.parents.length !== 1 ||
      commit.paths.length !== 1 || commit.paths[0] !== BATCH_NOTES_PATH || artifactId === null ||
      !id(bot.appId) || !id(bot.botId) || typeof bot.botLogin !== 'string' || !bot.botLogin) return null
    const prs = await api.pages(`/commits/${commit.sha}/pulls`)
    if (prs.length !== 1 || !object(prs[0]) || !id(prs[0].number)) return null
    const pr = prs[0].number
    const pull = await api.get(`/pulls/${pr}`)
    if (!object(pull) || pull.number !== pr || pull.state !== 'closed' || pull.merged !== true || pull.merge_commit_sha !== commit.sha ||
      !object(pull.user) || pull.user.id !== bot.botId || pull.user.login !== bot.botLogin || pull.user.type !== 'Bot' ||
      !object(pull.head) || pull.head.ref !== 'release/pending' || !sha(pull.head.sha) || !object(pull.head.repo) || pull.head.repo.full_name !== api.repo ||
      !object(pull.base) || pull.base.ref !== 'main' || !object(pull.base.repo) || pull.base.repo.full_name !== api.repo) return null
    const head = pull.head.sha
    const facts = await readMergeFacts(api, {repo: api.repo, pr, head, base, tree: commit.tree}, bot)
    if (!facts || !facts.commit || !facts.association || facts.squashSha !== commit.sha || facts.commit.parents.length !== 1 || facts.commit.parents[0] !== base ||
      facts.commit.tree !== commit.tree || facts.commit.authorizationArtifactId !== artifactId ||
      facts.association.prs.length !== 1 || facts.association.prs[0] !== pr) return null
    const candidate = await api.get(`/commits/${head}`)
    if (!object(candidate) || candidate.sha !== head || !Array.isArray(candidate.parents) || candidate.parents.length !== 1 ||
      !object(candidate.parents[0]) || candidate.parents[0].sha !== base ||
      !object(candidate.commit) || !object(candidate.commit.tree) || candidate.commit.tree.sha !== commit.tree) return null
    return {pr, head}
  } catch { return null }
}

/** Independently prove a historical reserved commit before trusting its authorization. */
export async function proveReleaseSource(api: GitHubApi, commit: CommitFacts, bot: Bot, ownerId: number, authorize: (id: number, candidate: Candidate) => Promise<AuthorizationRecord | null>): Promise<AuthorizationRecord | null> {
  try {
    const base = commit.parents[0]
    const artifactId = trailerId(commit.message)
    if (!sha(commit.sha) || !sha(base) || !sha(commit.tree) || commit.parents.length !== 1 ||
      commit.paths.length !== 1 || commit.paths[0] !== BATCH_NOTES_PATH || artifactId === null) return null
    const prs = await api.pages(`/commits/${commit.sha}/pulls`)
    if (prs.length !== 1 || !object(prs[0]) || !id(prs[0].number)) return null
    const pr = prs[0].number
    const pull = await api.get(`/pulls/${pr}`)
    if (!object(pull) || pull.number !== pr || pull.state !== 'closed' || pull.merged !== true || pull.merge_commit_sha !== commit.sha ||
      !object(pull.user) || pull.user.id !== bot.botId || pull.user.login !== bot.botLogin || pull.user.type !== 'Bot' ||
      !object(pull.head) || pull.head.ref !== 'release/pending' || !sha(pull.head.sha) || !object(pull.head.repo) || pull.head.repo.full_name !== api.repo ||
      !object(pull.base) || pull.base.ref !== 'main' || !object(pull.base.repo) || pull.base.repo.full_name !== api.repo) return null
    const candidate = {repo: api.repo, pr, head: pull.head.sha, base, tree: commit.tree}
    const record = await authorize(artifactId, candidate)
    if (!record || record.origin.artifactId !== artifactId || record.origin.revision !== base ||
      (record.authorization.authority.kind === 'review' && record.authorization.authority.userId !== ownerId)) return null
    const proof = proveSquash(record, await readMergeFacts(api, candidate, bot), {repo: api.repo, workflow: '.github/workflows/held-release.yaml', revision: base, appId: bot.appId})
    return proof === commit.sha ? record : null
  } catch {
    return null
  }
}

function trailerId(message: string): number | null {
  const lines = message.replace(/\n+$/u, '').split('\n')
  const trailers = lines.filter(line => /^\s*fro-release-authorization\s*:/iu.test(line))
  const trailer = trailers[0]
  const match = trailers.length === 1 && trailer !== undefined && lines.at(-1) === trailer && lines.at(-2) === ''
    ? /^Fro-Release-Authorization: ([1-9]\d*)$/u.exec(trailer)
    : null
  const artifactId = match ? Number(match[1]) : null
  return id(artifactId) ? artifactId : null
}

/** bot must be obtained independently from the trusted App slug and api.botUser, not the PR or authorization. */
export async function readMergeFacts(api: GitHubApi, expected: Candidate, bot: Bot): Promise<MergeFacts | null> {
  try {
    if (expected.repo !== api.repo || !id(expected.pr) || !id(bot.appId) || !id(bot.botId) || !bot.botLogin ||
      !sha(expected.head) || !sha(expected.base) || !sha(expected.tree)) return null
    const pr = await api.get(`/pulls/${expected.pr}`)
    if (!object(pr) || pr.number !== expected.pr || pr.merged !== true || !sha(pr.merge_commit_sha) ||
      !object(pr.head) || pr.head.sha !== expected.head || !object(pr.head.repo) || pr.head.repo.full_name !== expected.repo ||
      !object(pr.base) || !object(pr.base.repo) || pr.base.repo.full_name !== expected.repo ||
      !object(pr.merged_by) || pr.merged_by.id !== bot.botId ||
      pr.merged_by.login !== bot.botLogin || pr.merged_by.type !== 'Bot') return null
    const squash = pr.merge_commit_sha
    const commit = await api.get(`/commits/${squash}`)
    const prs = await api.pages(`/commits/${squash}/pulls`)
    if (!object(commit) || commit.sha !== squash || !Array.isArray(commit.parents) ||
      !object(commit.commit) || !object(commit.commit.tree) || !sha(commit.commit.tree.sha) || typeof commit.commit.message !== 'string' ||
      !commit.parents.every(parent => object(parent) && sha(parent.sha)) ||
      !prs.every(item => object(item) && id(item.number))) return null
    const artifactId = trailerId(commit.commit.message)
    const parents = commit.parents.map(parent => (parent as {sha: string}).sha)
    return {verified: true, repo: expected.repo, pr: expected.pr, merged: true, actorAppId: bot.appId, head: expected.head,
      base: parents[0] ?? '', squashSha: squash, commit: {verified: true, sha: squash, parents, tree: commit.commit.tree.sha,
        authorizationArtifactId: artifactId}, association: {verified: true, sha: squash, prs: prs.map(item => (item as {number: number}).number)}}
  } catch { return null }
}
