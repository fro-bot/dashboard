/**
 * Pure policy only. The future controller must supply complete, live, independently
 * verified observations; these types do not authenticate GitHub or persist records.
 */
interface Run {repo: string; workflow: string; revision: string; runId: number; attempt: number; verified: boolean}
interface Review {id: number; userId: number; state: 'approved' | 'changes_requested' | 'dismissed' | 'commented' | 'pending'; head: string; submittedAt: string}
interface Hold {state: 'held' | 'clear' | 'unknown'; source: 'owner' | 'carry' | 'unknown'; ownerId?: number; pr: number; verified: boolean; clearancePr?: number; carriedFromPr?: number; carryVerified?: boolean}
type Trigger =
  | {kind: 'push'}
  | {kind: 'review'; reviewsVerified: boolean; reviews: Review[]}
  | {kind: 'dispatch'; actorId: number; ref: string | null; refVerified: boolean; reviewsVerified: boolean; reviews: Review[]}
  // slotUsed means consumed by a different authorization; the recorded tuple's
  // own reservation must remain recheckable, never available to another run.
  | {kind: 'schedule'; cron: string; originalRunAt: string; now: string; slotUsed: boolean; hold: Hold}

export interface GateInput {
  expected: {repo: string; pr: number; branch: string; baseBranch: string; ownerId: number; workflow: string; trustedRevision: string; mostRecentGeneratedPr?: number}
  activeSince: string | null
  priorAttempt: 'resolved' | 'unresolved'
  candidate: {repo: string; pr: number; headRepo: string; headBranch: string; baseBranch: string; state: 'open' | 'closed'; head: string; base: string; currentBase: string; parents: string[]; tree: string; expectedTree: string} | null
  run: Run
  /**
   * verified and ready attest applicable rules/providers and that real CI ran.
   * Accepted dispositions require GitHub and policy evidence, not mere absence.
   */
  checks: {verified: boolean; ready: boolean; head: string; base: string; applicableRevision: string; checks: {name: string; revision: string; disposition: 'pass' | 'accepted-skip' | 'accepted-neutral' | 'nonpassing'}[]} | null
  trigger: Trigger
}

type Authority = {kind: 'review'; reviewId: number; userId: number} | {kind: 'schedule'; slot: string}
export interface Authorization {repo: string; pr: number; head: string; base: string; tree: string; run: Omit<Run, 'verified'>; authority: Authority}
type Decision = {kind: 'authorize'; authorization: Authorization} | {kind: 'skip'; reason: 'inactive' | 'unresolved' | 'untrusted-run' | 'candidate' | 'checks' | 'trigger' | 'review' | 'slot' | 'hold'}

const instant = (value: string) => Date.parse(value)
const validId = (value: number) => Number.isSafeInteger(value) && value > 0
// Origin comes from independently verified artifact/run metadata, not the payload.
interface AuthorizationRecord {origin: Run & {artifactId: number}; authorization: Authorization}

function validRecord(record: AuthorizationRecord): boolean {
  const {origin, authorization} = record
  const run = authorization.run
  return origin.verified && validId(origin.artifactId) && origin.repo === run.repo &&
    origin.workflow === run.workflow && origin.revision === run.revision &&
    origin.runId === run.runId && origin.attempt === run.attempt &&
    validId(origin.runId) && validId(origin.attempt)
}

export function decideRelease(input: GateInput): Decision {
  const skip = (reason: Extract<Decision, {kind: 'skip'}>['reason']): Decision => ({kind: 'skip', reason})
  const {expected, candidate: c, run, checks, trigger} = input
  if (input.activeSince === null || !Number.isFinite(instant(input.activeSince))) return skip('inactive')
  if (input.priorAttempt !== 'resolved') return skip('unresolved')
  if (!run.verified || run.repo !== expected.repo || run.workflow !== expected.workflow ||
    run.revision !== expected.trustedRevision || !run.revision ||
    !validId(run.runId) || !validId(run.attempt)) return skip('untrusted-run')
  if (!c || c.repo !== expected.repo || c.headRepo !== expected.repo ||
    c.headBranch !== expected.branch || c.baseBranch !== expected.baseBranch ||
    c.state !== 'open' || !validId(c.pr) || c.pr !== expected.pr ||
    !c.head || !c.base || !c.tree || c.base !== c.currentBase ||
    c.parents.length !== 1 || c.parents[0] !== c.base || c.tree !== c.expectedTree) return skip('candidate')
  if (!checks || !checks.verified || !checks.ready || checks.head !== c.head ||
    checks.base !== c.base || !checks.applicableRevision || checks.checks.length === 0 ||
    checks.checks.some(check => !check.name || check.revision !== checks.applicableRevision ||
      !['pass', 'accepted-skip', 'accepted-neutral'].includes(check.disposition))) return skip('checks')
  let authority: Authority
  if (trigger.kind === 'push') return skip('trigger')
  if (trigger.kind === 'schedule') {
    const original = instant(trigger.originalRunAt)
    const now = instant(trigger.now)
    const date = new Date(original)
    const matchingDay = (trigger.cron === '0 15 * * 0' && date.getUTCDay() === 0) ||
      (trigger.cron === '0 15 * * 3' && date.getUTCDay() === 3)
    if (!Number.isFinite(original) || !Number.isFinite(now) || !matchingDay ||
      date.getUTCHours() < 15 || original < instant(input.activeSince) ||
      now < original || now >= Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) ||
      trigger.slotUsed) return skip('slot')
    const hold = trigger.hold
    // `verified` covers the live label read and complete, independent label-event
    // provenance. A previous PR's owner clearance also needs verified inheritance.
    const ownerClearance = hold.source === 'owner' && (hold.clearancePr === undefined || hold.clearancePr === c.pr)
    const inheritedClearance = hold.source === 'carry' && hold.carryVerified === true &&
      hold.clearancePr !== undefined && validId(hold.clearancePr) && hold.clearancePr !== c.pr &&
      hold.carriedFromPr !== undefined && validId(hold.carriedFromPr) &&
      hold.carriedFromPr === expected.mostRecentGeneratedPr && hold.carriedFromPr !== c.pr
    if (!hold.verified || hold.pr !== c.pr || hold.state !== 'clear' ||
      !validId(expected.ownerId) || hold.ownerId !== expected.ownerId ||
      !(ownerClearance || inheritedClearance)) return skip('hold')
    authority = {kind: 'schedule', slot: `${date.toISOString().slice(0, 10)}/${trigger.cron}`}
  } else {
    if (trigger.kind === 'dispatch' && (trigger.actorId !== expected.ownerId || !trigger.refVerified ||
      trigger.ref !== `refs/heads/${expected.baseBranch}`)) return skip('trigger')
    if (!trigger.reviewsVerified || !validId(expected.ownerId)) return skip('review')
    // Adapter provides a complete chronological list of current review states.
    const decisive = trigger.reviews.filter(review => review.userId === expected.ownerId && review.state !== 'commented' && review.state !== 'pending')
    const latest = decisive.at(-1)
    if (!latest || latest.state !== 'approved' || latest.head !== c.head || !validId(latest.id) ||
      !Number.isFinite(instant(latest.submittedAt)) ||
      instant(latest.submittedAt) < instant(input.activeSince)) return skip('review')
    authority = {kind: 'review', reviewId: latest.id, userId: latest.userId}
  }
  return {kind: 'authorize', authorization: {repo: c.repo, pr: c.pr, head: c.head, base: c.base, tree: c.tree, run: {repo: run.repo, workflow: run.workflow, revision: run.revision, runId: run.runId, attempt: run.attempt}, authority}}
}

/** Called with a newly fetched decision, immediately before the merge request. */
export function recheckRelease(input: GateInput, record: AuthorizationRecord): boolean {
  if (!validRecord(record)) return false
  const decision = decideRelease(input)
  if (decision.kind !== 'authorize') return false
  const a = decision.authorization
  const recorded = record.authorization
  const sameAuthority = a.authority.kind === 'review' && recorded.authority.kind === 'review'
    ? a.authority.reviewId === recorded.authority.reviewId && a.authority.userId === recorded.authority.userId
    : a.authority.kind === 'schedule' && recorded.authority.kind === 'schedule' &&
      a.authority.slot === recorded.authority.slot
  return a.repo === recorded.repo && a.pr === recorded.pr && a.head === recorded.head &&
    a.base === recorded.base && a.tree === recorded.tree && a.run.repo === recorded.run.repo &&
    a.run.workflow === recorded.run.workflow && a.run.revision === recorded.run.revision &&
    a.run.runId === recorded.run.runId && a.run.attempt === recorded.run.attempt && sameAuthority
}

export interface MergeFacts {
  verified: boolean
  repo: string
  pr: number
  merged: boolean
  actorAppId: number
  head: string
  base: string
  squashSha: string
  commit: {verified: boolean; sha: string; parents: string[]; tree: string; authorizationArtifactId: number | null} | null
  association: {verified: boolean; sha: string; prs: number[]} | null
}

/**
 * The controller must put exactly one Fro-Release-Authorization artifact ID
 * trailer in the squash request. The adapter independently fetches that commit
 * and its SHA-anchored PR associations, parsing a missing or ambiguous trailer
 * as null. It verifies artifact/run provenance separately from the record payload.
 * API reads, trailer parsing and writes are future controller responsibilities.
 */
export function proveSquash(record: AuthorizationRecord | null, merge: MergeFacts | null, trusted: {repo: string; workflow: string; revision: string; appId: number}): string | null {
  if (!record || !validRecord(record) || !merge?.verified || !merge.commit?.verified || !merge.association?.verified) return null
  const a = record.authorization
  const {commit, association} = merge
  if (record.origin.artifactId !== commit.authorizationArtifactId ||
    a.repo !== trusted.repo || a.run.repo !== trusted.repo || a.run.workflow !== trusted.workflow ||
    a.run.revision !== trusted.revision || !validId(a.run.runId) || !validId(a.run.attempt) ||
    !validId(trusted.appId) || !validId(a.pr) || !a.head || !a.base || !a.tree ||
    !merge.merged || merge.repo !== a.repo || merge.pr !== a.pr || merge.actorAppId !== trusted.appId ||
    merge.head !== a.head || merge.base !== a.base || !merge.squashSha ||
    commit.sha !== merge.squashSha || association.sha !== merge.squashSha ||
    commit.parents.length !== 1 || commit.parents[0] !== a.base || commit.tree !== a.tree ||
    association.prs.length !== 1 || association.prs[0] !== a.pr) return null
  return merge.squashSha
}
