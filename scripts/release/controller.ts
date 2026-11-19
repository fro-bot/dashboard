import {decideRelease, proveSquash, recheckRelease, type Authorization, type GateInput, type MergeFacts} from './gate.ts'

export type AuthorizationRecord = Parameters<typeof import('./gate.ts').recheckRelease>[1]
export type Trusted = Parameters<typeof import('./gate.ts').proveSquash>[2]
export interface Observation {
  mode: 'disabled' | 'prepare' | 'active'
  activation: string | null
  trusted: Trusted
  run: GateInput['run']
  trigger: GateInput['trigger']
  ownerId: number
  baseBranch: string
  predecessor: 'verified' | 'unknown'
  prior: {state: 'clear' | 'unknown'} | {state: 'unresolved'; artifactId: number}
  candidate: {state: 'absent' | 'stale' | 'not-needed' | 'blocked' | 'unknown'} | {state: 'ready'; gate: GateInput}
}
export interface ControllerPorts {
  /**
   * Complete, independently verified observations; event payloads are only wake-up signals.
   * A schedule's slotUsed excludes this exact run/attempt's own artifact reservation.
   */
  observe: () => Promise<Observation>
  prepare: (state: 'absent' | 'stale') => Promise<void>
  /** Verify immutable artifact metadata independently from its payload; null on malformed input. */
  authorization: (artifactId: number) => Promise<AuthorizationRecord | null>
  /** Independently attest the origin revision is accepted trusted first-parent history. */
  recoveryRevision: (record: AuthorizationRecord) => Promise<boolean>
  merge: (head: string, artifactId: number) => Promise<void>
  mergeFacts: (record: AuthorizationRecord) => Promise<MergeFacts | null>
}
export type SkipReason = Extract<ReturnType<typeof decideRelease>, {kind: 'skip'}>['reason']
  | 'disabled' | 'predecessor' | 'prior-unknown' | 'authorization-invalid' | 'squash-unproven'
  | 'observation-changed' | 'prepare-only' | 'observation-failed' | 'recheck-failed'
export type Outcome = {kind: 'skip'; reason: SkipReason} | {kind: 'prepared'} | {kind: 'authorize'; authorization: Authorization} | {kind: 'source'; source: string; recovery: boolean}

const skip = (reason: SkipReason): Outcome => ({kind: 'skip', reason})
const validId = (id: number) => Number.isSafeInteger(id) && id > 0

function preflight(o: Observation): SkipReason | null {
  if (o.mode === 'disabled') return 'disabled'
  const {run, trusted, trigger} = o
  if (!run.verified || run.repo !== trusted.repo || run.workflow !== trusted.workflow ||
    run.revision !== trusted.revision || !run.revision || !validId(run.runId) || !validId(run.attempt) ||
    !validId(trusted.appId) || !validId(o.ownerId) || !o.baseBranch) return 'untrusted-run'
  if (trigger.kind === 'dispatch' && (trigger.actorId !== o.ownerId || !trigger.refVerified || trigger.ref !== `refs/heads/${o.baseBranch}`)) return 'trigger'
  if (o.predecessor !== 'verified') return 'predecessor'
  if (o.mode === 'active' && (o.activation === null || !Number.isFinite(Date.parse(o.activation)))) return 'inactive'
  return null
}

function liveGate(o: Observation): GateInput | null {
  if (o.mode !== 'active' || o.prior.state !== 'clear' || o.candidate.state !== 'ready') return null
  const g = o.candidate.gate
  if (g.expected.repo !== o.trusted.repo || g.expected.workflow !== o.trusted.workflow ||
    g.expected.trustedRevision !== o.trusted.revision || g.expected.ownerId !== o.ownerId ||
    g.expected.baseBranch !== o.baseBranch) return null
  return {...g, activeSince: o.activation, priorAttempt: 'resolved', run: o.run, trigger: o.trigger}
}

async function proof(ports: ControllerPorts, record: AuthorizationRecord, trusted: Trusted, recovery: boolean): Promise<Outcome> {
  try {
    const source = proveSquash(record, await ports.mergeFacts(record), trusted)
    return source === null ? skip('squash-unproven') : {kind: 'source', source, recovery}
  } catch {
    return skip('squash-unproven')
  }
}

/** First phase: prepare or return a decision for a separately uploaded immutable artifact. */
export async function inspect(ports: ControllerPorts): Promise<Outcome> {
  try {
    let o = await ports.observe()
    let reason = preflight(o)
    if (reason !== null) return skip(reason)
    if (o.prior.state === 'unknown') return skip('prior-unknown')
    if (o.prior.state === 'unresolved') {
      if (o.mode !== 'active' || o.trigger.kind !== 'dispatch') return skip('unresolved')
      const id = o.prior.artifactId
      if (!validId(id)) return skip('authorization-invalid')
      const record = await ports.authorization(id)
      if (!record || record.origin.artifactId !== id) return skip('authorization-invalid')
      if (!record.origin.verified || record.origin.repo !== o.trusted.repo || record.origin.workflow !== o.trusted.workflow ||
        !record.origin.revision || !(await ports.recoveryRevision(record))) return skip('authorization-invalid')
      return await proof(ports, record, {...o.trusted, revision: record.origin.revision}, true)
    }
    if (o.candidate.state === 'absent' || o.candidate.state === 'stale') {
      const state = o.candidate.state
      o = await ports.observe()
      reason = preflight(o)
      if (reason !== null) return skip(reason)
      if (o.prior.state !== 'clear' || o.candidate.state !== state) return skip('observation-changed')
      await ports.prepare(state)
      return {kind: 'prepared'}
    }
    if (o.candidate.state !== 'ready') return skip('candidate')
    if (o.mode !== 'active') return skip('prepare-only')
    const input = liveGate(o)
    return input ? decideRelease(input) : skip('candidate')
  } catch {
    return skip('observation-failed')
  }
}

/** Second phase: independently fetch the artifact, then re-observe immediately before one merge. */
export async function finish(ports: ControllerPorts, artifactId: number): Promise<Outcome> {
  if (!validId(artifactId)) return skip('authorization-invalid')
  try {
    const initial = await ports.observe()
    const initialReason = preflight(initial)
    if (initialReason !== null) return skip(initialReason)
    if (initial.mode !== 'active') return skip('prepare-only')
    if (initial.prior.state !== 'clear') return skip('unresolved')
    const record = await ports.authorization(artifactId)
    if (!record || record.origin.artifactId !== artifactId) return skip('authorization-invalid')
    const o = await ports.observe()
    const reason = preflight(o)
    if (reason !== null) return skip(reason)
    const input = liveGate(o)
    if (!input || !recheckRelease(input, record)) return skip('recheck-failed')
    try {
      await ports.merge(record.authorization.head, artifactId)
    } catch {
      // The request may have landed. Never retry; only independent proof can establish source.
    }
    return await proof(ports, record, o.trusted, false)
  } catch {
    return skip('observation-failed')
  }
}
