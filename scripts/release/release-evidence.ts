import type {Authorization} from './gate.ts'

type Kind = 'allocation' | 'gate' | 'authorization'
interface Tuple {runId: number; attempt: number}
interface Identity {version: string; source: string}
export interface TrustedOrigin extends Tuple {
  kind: Kind
  artifactId: number
  repo: string
  repositoryId: number
  workflowId: number
  workflow: string
  branch: 'main'
  revision: string
}
const originBrand: unique symbol = Symbol('validated artifact origin')
export type ObservedOrigin = Readonly<TrustedOrigin & {[originBrand]: true}>

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const keys = (v: unknown, names: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name))
const id = (v: unknown, digits = 15): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && String(v).length <= digits
const runId = (v: unknown): v is number => id(v)
const attempt = (v: unknown): v is number => id(v, 9)
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40}$/u.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/u.test(v)
const version = (v: unknown): v is string => typeof v === 'string' && /^\d{4}\.\d{2}\.\d+$/u.test(v)
const repo = (v: unknown): v is string => typeof v === 'string' && /^[\w.-]+\/[\w.-]+$/u.test(v)
const workflow = (v: unknown): v is string => typeof v === 'string' && /^\.github\/workflows\/[\w.-]+\.ya?ml$/u.test(v)
const tuple = (v: unknown): v is Tuple => keys(v, ['runId', 'attempt']) && runId(v.runId) && attempt(v.attempt)
const sameTuple = (a: Tuple, b: Tuple) => a.runId === b.runId && a.attempt === b.attempt
const isKind = (v: unknown): v is Kind => v === 'allocation' || v === 'gate' || v === 'authorization'

export function artifactName(kind: Kind, run: number, tryNumber: number): string {
  if (!isKind(kind) || !runId(run) || !attempt(tryNumber)) throw new Error('Invalid artifact identity')
  return `release-${kind}-${run}-${tryNumber}`
}

export function parseArtifactName(value: unknown): (Tuple & {kind: Kind}) | null {
  if (typeof value !== 'string') return null
  const match = /^release-(allocation|gate|authorization)-([1-9]\d{0,14})-([1-9]\d{0,8})$/u.exec(value)
  if (!match || !isKind(match[1])) return null
  return {kind: match[1], runId: Number(match[2]), attempt: Number(match[3])}
}

/**
 * Inputs must come from authenticated artifact and exact run-attempt API reads.
 * The caller must independently establish that revision belongs to trusted main
 * history, and hash the downloaded ZIP bytes itself. No attempt is inferred from
 * artifact metadata (which does not contain one), a payload, or the latest run.
 */
export function validateOrigin(expected: TrustedOrigin, artifact: unknown, run: unknown, actualDigest: unknown): ObservedOrigin | null {
  if (!object(expected) || !isKind(expected.kind) || !id(expected.artifactId) || !id(expected.repositoryId) || !id(expected.workflowId) ||
    !repo(expected.repo) || !workflow(expected.workflow) || expected.branch !== 'main' || !sha(expected.revision) || !runId(expected.runId) || !attempt(expected.attempt) ||
    !object(artifact) || !object(artifact.workflow_run) || !object(run) || !object(run.repository) || !object(run.head_repository) ||
    !digest(actualDigest) || artifact.digest !== actualDigest || artifact.id !== expected.artifactId || artifact.expired !== false ||
    artifact.name !== artifactName(expected.kind, expected.runId, expected.attempt)) return null
  const ar = artifact.workflow_run
  if (ar.id !== expected.runId || ar.repository_id !== expected.repositoryId || ar.head_repository_id !== expected.repositoryId || ar.head_branch !== expected.branch || ar.head_sha !== expected.revision ||
    run.id !== expected.runId || run.run_attempt !== expected.attempt || run.repository.id !== expected.repositoryId || run.repository.full_name !== expected.repo ||
    run.head_repository.id !== expected.repositoryId || run.head_repository.full_name !== expected.repo || run.workflow_id !== expected.workflowId ||
    run.path !== expected.workflow || run.head_branch !== expected.branch || run.head_sha !== expected.revision ||
    !['push', 'workflow_run', 'schedule', 'workflow_dispatch'].includes(String(run.event))) return null
  return Object.freeze({...expected, [originBrand]: true as const})
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}
const validOrigin = (o: ObservedOrigin | null, kind: Kind): o is ObservedOrigin => o !== null && o[originBrand] === true && o.kind === kind
const identityMatches = (value: Record<string, unknown>, expected: Identity) => version(expected.version) && sha(expected.source) && value.version === expected.version && value.source === expected.source

export interface Allocation extends Tuple, Identity {tag: string}
export function parseAllocation(text: string, origin: ObservedOrigin | null, expected: Identity): Allocation | null {
  const v = parse(text)
  if (!validOrigin(origin, 'allocation') || !keys(v, ['runId', 'attempt', 'version', 'source', 'tag']) ||
    !identityMatches(v, expected) || v.runId !== origin.runId || v.attempt !== origin.attempt || v.tag !== `ci-${origin.runId}-${origin.attempt}`) return null
  return {runId: origin.runId, attempt: origin.attempt, version: expected.version, source: expected.source, tag: v.tag}
}

export interface GateSeal extends Identity {digest: string; candidate: Tuple; gate: Tuple; smoke: 'pass'; trivy: {enforced: true; result: 'pass'}}
/**
 * Current workflow uploads success seals only; it never uploads failure artifacts.
 * Candidate provenance must be separately authenticated by the caller.
 */
export function parseGate(text: string, origin: ObservedOrigin | null, expected: Identity & {digest: string; candidate: Tuple}): GateSeal | null {
  const v = parse(text)
  if (!validOrigin(origin, 'gate') || !keys(v, ['version', 'source', 'digest', 'candidate', 'gate', 'smoke', 'trivy']) ||
    !identityMatches(v, expected) || !digest(expected.digest) || v.digest !== expected.digest || !tuple(expected.candidate) || !tuple(v.candidate) || !sameTuple(v.candidate, expected.candidate) ||
    !tuple(v.gate) || !sameTuple(v.gate, origin) || v.smoke !== 'pass' || !keys(v.trivy, ['enforced', 'result']) || v.trivy.enforced !== true || v.trivy.result !== 'pass') return null
  return {version: expected.version, source: expected.source, digest: expected.digest, candidate: {...v.candidate}, gate: {...v.gate}, smoke: 'pass', trivy: {enforced: true, result: 'pass'}}
}

export function parseAuthorization(text: string, origin: ObservedOrigin | null, expected: Pick<Authorization, 'repo' | 'pr' | 'head' | 'base' | 'tree'>): Authorization | null {
  const v = parse(text)
  if (!validOrigin(origin, 'authorization') || !keys(v, ['repo', 'pr', 'head', 'base', 'tree', 'run', 'authority']) ||
    !repo(expected.repo) || expected.repo !== origin.repo || !id(expected.pr) || !sha(expected.head) || !sha(expected.base) || !sha(expected.tree) ||
    v.repo !== expected.repo || v.pr !== expected.pr || v.head !== expected.head || v.base !== expected.base || v.tree !== expected.tree ||
    !keys(v.run, ['repo', 'workflow', 'revision', 'runId', 'attempt']) || v.run.repo !== origin.repo || v.run.workflow !== origin.workflow ||
    v.run.revision !== origin.revision || v.run.runId !== origin.runId || v.run.attempt !== origin.attempt || !object(v.authority)) return null
  const a = v.authority
  const authority = keys(a, ['kind', 'reviewId', 'userId']) && a.kind === 'review' && id(a.reviewId) && id(a.userId)
    ? {kind: 'review' as const, reviewId: a.reviewId, userId: a.userId}
    : keys(a, ['kind', 'slot']) && a.kind === 'schedule' && typeof a.slot === 'string' && /^\d{4}-\d{2}-\d{2}\/0 15 \* \* [03]$/u.test(a.slot)
      ? {kind: 'schedule' as const, slot: a.slot}
      : null
  if (!authority) return null
  return {...expected, run: {repo: origin.repo, workflow: origin.workflow, revision: origin.revision, runId: origin.runId, attempt: origin.attempt}, authority}
}
