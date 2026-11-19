import {execFileSync} from 'node:child_process'
import process from 'node:process'

import {discoverBatch} from './batch.ts'
import {candidateTree, createCandidate} from './candidate.ts'

const branch = 'release/pending'
const label = 'release-hold'

/** list must return every page, or throw; get returns null only for a confirmed 404. */
export interface CandidatePort {
  get: (path: string) => Promise<unknown>
  list: (path: string) => Promise<unknown>
  write: (path: string, body: unknown) => Promise<unknown>
  /** Run exactly args; caller must ensure origin is the authenticated input repo. */
  pushCandidate: (input: {repoDir: string; head: string; ref: 'refs/heads/release/pending'; expected: string | null; args: string[]}) => Promise<void>
}

export interface CandidateInput {
  repo: string
  repoDir: string
  baseline: string
  main: string
  appUserId: number
  ownerId?: number
  /** Independently verified generated predecessor, including its settled merge. */
  predecessor?: {number: number; head: string; merge: string; clearance: 'cleared' | 'held' | 'unknown'}
}

export type CandidateStatus =
  | {status: 'blocked'; reason: string}
  | {status: 'not-needed'}
  | {status: 'absent'; notes: string; lease: string | null; carry: boolean}
  | {status: 'ready' | 'stale'; notes: string; number: number; head: string; lease: string; held: boolean}

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed GitHub response')
  return value as ObjectValue
}
function oid(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}
function id(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function labels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Malformed labels')
  return value.map(entry => {
    const name = object(entry).name
    if (typeof name !== 'string') throw new Error('Malformed label')
    return name
  })
}

function holdEvidence(input: {labels: unknown; timeline: unknown; ownerId: number}): 'held' | 'cleared' | 'none' | 'unknown' {
  try {
    if (!id(input.ownerId)) return 'unknown'
    if (labels(input.labels).includes(label)) return 'held'
    if (!Array.isArray(input.timeline)) return 'unknown'
    let last: 'held' | 'cleared' | 'none' | 'unknown' = 'none'
    let previousRelevant = ''
    for (const item of input.timeline) {
      const event = object(item)
      if (event.event !== 'labeled' && event.event !== 'unlabeled') continue
      if (object(event.label).name !== label) continue
      if (typeof event.created_at !== 'string' || !Number.isFinite(Date.parse(event.created_at)) || event.created_at <= previousRelevant || (previousRelevant !== '' && Math.floor(Date.parse(event.created_at) / 1000) === Math.floor(Date.parse(previousRelevant) / 1000))) return 'unknown'
      previousRelevant = event.created_at
      const actor = object(event.actor)
      if (!id(actor.id)) return 'unknown'
      last = event.event === 'labeled' ? 'held' : actor.id === input.ownerId ? 'cleared' : 'unknown'
    }
    // A labeled event with no live label is inconsistent, not proof of a hold.
    return last === 'held' ? 'unknown' : last
  } catch {
    return 'unknown'
  }
}

/** Complete, chronological timeline and current labels are required for clearance. */
export function holdProof(input: {labels: unknown; timeline: unknown; ownerId: number}): 'held' | 'cleared' | 'unknown' {
  const proof = holdEvidence(input)
  return proof === 'none' ? 'unknown' : proof
}

function git(input: CandidateInput, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, {GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'})
  return execFileSync('git', args, {cwd: input.repoDir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe']}).trim()
}

function parsePull(value: unknown, repo: string, appUserId: number) {
  const pull = object(value)
  const head = object(pull.head)
  const base = object(pull.base)
  if (typeof head.ref !== 'string' || typeof base.ref !== 'string') throw new Error('Ambiguous pull refs')
  if (head.ref !== branch) throw new Error('Conflicting pull head')
  if (base.ref !== 'main' || object(head.repo).full_name !== repo || object(base.repo).full_name !== repo ||
    object(pull.user).id !== appUserId || !id(pull.number) || !oid(head.sha) ||
    (pull.state !== 'open' && pull.state !== 'closed')) throw new Error('Foreign or malformed candidate pull request')
  return {number: pull.number, head: head.sha, state: pull.state, labels: labels(pull.labels), merge: pull.merge_commit_sha}
}

/** Inspect without writing. A malformed response or uncertain identity fails closed. */
export async function inspectCandidate(input: CandidateInput, port: CandidatePort): Promise<CandidateStatus> {
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo) || !id(input.appUserId) || !oid(input.baseline) || !oid(input.main) || input.baseline.length !== input.main.length) throw new Error('Invalid candidate inputs')
    if (git(input, 'rev-parse', '--is-shallow-repository') !== 'false') throw new Error('Shallow repository')
    for (const sha of [input.baseline, input.main]) {
      if (git(input, 'cat-file', '-t', sha) !== 'commit') throw new Error('Missing commit')
    }
    const prefix = `/repos/${input.repo}`
    const owner = input.repo.split('/')[0]
    const [rawPulls, rawRef] = await Promise.all([port.list(`${prefix}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`), port.get(`${prefix}/git/ref/heads/${branch}`)])
    if (!Array.isArray(rawPulls)) throw new Error('Incomplete pull list')
    const pulls = rawPulls.map(pull => parsePull(pull, input.repo, input.appUserId)).filter(pull => pull !== null)
    const previous = input.predecessor
    if (previous !== undefined) {
      const matches = pulls.filter(pull => pull.number === previous.number)
      if (!id(previous.number) || !oid(previous.head) || previous.merge !== input.baseline ||
        !['cleared', 'held', 'unknown'].includes(previous.clearance) || matches.length !== 1 ||
        matches[0]?.state !== 'closed' || matches[0].head !== previous.head || matches[0].merge !== previous.merge) throw new Error('Unverified predecessor')
    }
    const open = pulls.filter(pull => pull.state === 'open')
    if (open.length > 1) throw new Error('Duplicate candidate pulls')
    let remote: string | null = null
    if (rawRef !== null) {
      const ref = object(rawRef)
      const target = object(ref.object)
      if (ref.ref !== `refs/heads/${branch}` || target.type !== 'commit' || !oid(target.sha)) throw new Error('Ambiguous candidate ref')
      remote = target.sha
      if (git(input, 'cat-file', '-t', remote) !== 'commit') throw new Error('Candidate head unavailable')
    }
    const batch = discoverBatch({repoDir: input.repoDir, baseline: input.baseline, main: input.main})
    const current = open[0]
    if (current) {
      if (remote !== current.head) throw new Error('Pull head differs from remote branch')
      const parents = git(input, 'rev-list', '--parents', '-n', '1', current.head).split(' ')
      if (parents.length !== 2 || parents[0] !== current.head || !oid(parents[1])) throw new Error('Invalid candidate parent')
      const parent = parents[1]
      if (!git(input, 'rev-list', '--first-parent', input.main).split('\n').includes(parent)) throw new Error('Candidate parent is not on main first-parent history')
      const oldBatch = discoverBatch({repoDir: input.repoDir, baseline: input.baseline, main: parent})
      if (!oldBatch || candidateTree({repoDir: input.repoDir, base: parent, notes: oldBatch.notes}) !== git(input, 'rev-parse', `${current.head}^{tree}`)) throw new Error('Candidate tree does not match historical batch')
      if (!batch) return {status: 'not-needed'}
      const expected = candidateTree({repoDir: input.repoDir, base: input.main, notes: batch.notes})
      return {status: parent === input.main && git(input, 'rev-parse', `${current.head}^{tree}`) === expected ? 'ready' : 'stale', notes: batch.notes, number: current.number, head: current.head, lease: current.head, held: current.labels.includes(label)}
    }
    const carry = previous?.clearance === 'cleared'
    if (remote !== null) {
      const match = pulls.filter(pull => pull.state === 'closed' && pull.head === remote)
      const predecessorHead = previous && previous.head === remote && match.length === 1 && match[0]?.number === previous.number && match[0]?.merge === previous.merge
      if (!predecessorHead) {
        if (match.length !== 0 || !batch) throw new Error('Unverified orphan candidate branch')
        const parents = git(input, 'rev-list', '--parents', '-n', '1', remote).split(' ')
        if (parents.length !== 2 || parents[0] !== remote || parents[1] !== input.main ||
          candidateTree({repoDir: input.repoDir, base: input.main, notes: batch.notes}) !== git(input, 'rev-parse', `${remote}^{tree}`)) throw new Error('Unverified orphan candidate branch')
      }
    }
    if (!batch) return {status: 'not-needed'}
    return {status: 'absent', notes: batch.notes, lease: remote, carry}
  } catch {
    return {status: 'blocked', reason: 'candidate-inspection-failed'}
  }
}

/** Writes only a fixed ref, a fixed PR and the additive hold label. */
export async function prepareCandidate(input: CandidateInput, port: CandidatePort): Promise<CandidateStatus> {
  const state = await inspectCandidate(input, port)
  if (state.status === 'blocked' || state.status === 'not-needed') return state
  try {
    const prefix = `/repos/${input.repo}`
    let number: number
    let head: string
    let held: boolean
    const orphan = state.status === 'absent' && state.lease !== null && state.lease !== input.predecessor?.head
    if (state.status === 'absent' || state.status === 'stale') {
      head = orphan && state.lease !== null ? state.lease : createCandidate({repoDir: input.repoDir, base: input.main, notes: state.notes}).head
      if (head !== state.lease) await port.pushCandidate({
        repoDir: input.repoDir, head, ref: 'refs/heads/release/pending', expected: state.lease,
        args: ['push', `--force-with-lease=refs/heads/release/pending:${state.lease ?? ''}`, 'origin', `${head}:refs/heads/release/pending`],
      })
      if (state.status === 'absent') {
        if (orphan) {
          const observed = await inspectCandidate(input, port)
          if (observed.status !== 'absent' || observed.lease !== head || observed.notes !== state.notes || observed.carry !== state.carry) throw new Error('Orphan changed before creation')
        }
        const created = parsePull(await port.write(`${prefix}/pulls`, {title: 'Prepare release batch', head: branch, base: 'main', body: 'Automated release batch.'}), input.repo, input.appUserId)
        if (created.state !== 'open' || created.head !== head) throw new Error('Unverified created pull request')
        number = created.number
        held = created.labels.includes(label)
        if (orphan) {
          const observed = await inspectCandidate(input, port)
          if (observed.status !== 'ready' || observed.number !== number || observed.head !== head || observed.held !== held) throw new Error('Created pull not observed')
        }
      } else {
        number = state.number
        held = state.held
      }
    } else {
      number = state.number
      head = state.head
      held = state.held
    }
    let cleared = false
    if (!held && input.ownerId !== undefined) {
      const timeline = await port.list(`${prefix}/issues/${number}/timeline?per_page=100`)
      const proof = holdEvidence({labels: [], timeline, ownerId: input.ownerId})
      cleared = proof === 'cleared' || (proof === 'none' && state.status === 'absent' && state.carry)
    }
    const mustHold = !held && !cleared
    if (mustHold) {
      const added = await port.write(`${prefix}/issues/${number}/labels`, {labels: [label]})
      if (!labels(added).includes(label)) throw new Error('Hold label not verified')
      held = true
    }
    if (orphan) {
      const observed = await inspectCandidate(input, port)
      if (observed.status !== 'ready' || observed.number !== number || observed.head !== head || observed.held !== held) throw new Error('Candidate readback failed')
      if (!held && input.ownerId !== undefined) {
        const proof = holdEvidence({labels: [], timeline: await port.list(`${prefix}/issues/${number}/timeline?per_page=100`), ownerId: input.ownerId})
        if (proof !== 'cleared' && !(proof === 'none' && state.status === 'absent' && state.carry)) throw new Error('Clearance readback failed')
      }
    }
    return {status: 'ready', notes: state.notes, number, head, lease: head, held}
  } catch {
    return {status: 'blocked', reason: 'candidate-preparation-failed'}
  }
}
