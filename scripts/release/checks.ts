import type {GateInput} from './gate.ts'

/**
 * All attestations must come from independent, current GitHub reads, not check metadata.
 * `rules` is the complete paginated effective active branch-rules response. `noBypass`
 * independently establishes that the actual merge actor cannot bypass those rules.
 * `realCi` identifies genuine CI contexts and their providers independently of runs.
 * Both revision reads include all paginated check runs and commit statuses.
 */
export interface CheckEvidence {
  candidate: {verified: boolean; head: string; base: string; generatedAppPr: boolean}
  merge: {verified: boolean; sha: string; parents: string[]}
  realCi: {verified: boolean; checks: {name: string; integrationId: number}[]}
  effectiveRules: {complete: boolean; noBypass: boolean; rules: unknown[]}
  head: {complete: boolean; checks: unknown[]; statuses: unknown[]}
  testMerge: {complete: boolean; checks: unknown[]; statuses: unknown[]}
}

type ObjectValue = Record<string, unknown>
const object = (x: unknown): x is ObjectValue => typeof x === 'object' && x !== null && !Array.isArray(x)
const positiveId = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0
const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0

/**
 * Provider-bound check-runs only: legacy commit statuses cannot prove the required
 * integration_id, so a required status without a check run fails closed. Any
 * same-name status also fails closed rather than resolving a conflicting signal.
 * All matching runs must pass: stale failures can delay release until reconciled.
 */
export function verifyReleaseChecks(e: CheckEvidence): GateInput['checks'] {
  const {candidate, merge, effectiveRules} = e
  const revision = e.testMerge.checks.length || e.testMerge.statuses.length ? merge.sha : candidate.head
  const result: NonNullable<GateInput['checks']> = {verified: false, ready: false, head: candidate.head, base: candidate.base, applicableRevision: revision, checks: []}
  if (!candidate.verified || !text(candidate.head) || !text(candidate.base) || !merge.verified ||
    !text(merge.sha) || merge.sha === candidate.head || merge.parents.length !== 2 ||
    merge.parents[0] !== candidate.base || merge.parents[1] !== candidate.head ||
    !effectiveRules.complete || !effectiveRules.noBypass || !e.realCi.verified ||
    !e.head.complete || !e.testMerge.complete) return result

  const requirements: {name: string; provider: number}[] = []
  let pr = false
  let strict = false
  let codeql = false
  for (const raw of effectiveRules.rules) {
    if (!object(raw) || !text(raw.type)) return result
    if (raw.type !== 'pull_request' && raw.type !== 'required_status_checks' && raw.type !== 'code_scanning') continue
    if (!object(raw.parameters)) return result
    const p = raw.parameters
    if (raw.type === 'pull_request') {
      if (!Array.isArray(p.allowed_merge_methods) || p.allowed_merge_methods.length !== 1 || p.allowed_merge_methods[0] !== 'squash') return result
      pr = true
    } else if (raw.type === 'required_status_checks') {
      if (p.strict_required_status_checks_policy !== true || !Array.isArray(p.required_status_checks) || !p.required_status_checks.length) return result
      for (const check of p.required_status_checks) {
        if (!object(check) || !text(check.context) || !positiveId(check.integration_id)) return result
        requirements.push({name: check.context, provider: check.integration_id})
      }
      strict = true
    } else {
      if (!Array.isArray(p.code_scanning_tools) || !p.code_scanning_tools.length) return result
      for (const tool of p.code_scanning_tools) {
        if (!object(tool) || !text(tool.tool) || !['none', 'errors', 'errors_and_warnings', 'all'].includes(String(tool.alerts_threshold)) ||
          !['none', 'critical', 'high_or_higher', 'medium_or_higher', 'all'].includes(String(tool.security_alerts_threshold))) return result
        if (tool.tool === 'CodeQL' && tool.security_alerts_threshold !== 'none') codeql = true
      }
    }
  }
  if (!pr || !strict || !codeql) return result
  const selected = revision === merge.sha ? e.testMerge : e.head
  for (const status of selected.statuses) {
    if (!object(status) || !text(status.context) || !['error', 'failure', 'pending', 'success'].includes(String(status.state))) return result
    if (requirements.some(r => r.name === status.context)) return result
  }
  for (const check of selected.checks) {
    if (!object(check) || !text(check.name) || check.head_sha !== revision || !positiveId(check.id) ||
      !object(check.app) || !positiveId(check.app.id) || !text(check.status)) return result
  }
  let realCiPassed = false
  let allPassed = true
  for (const requirement of requirements) {
    const matching = selected.checks.filter((c): c is ObjectValue => object(c) && c.name === requirement.name)
    let disposition: 'pass' | 'accepted-skip' | 'nonpassing' = matching.length ? 'pass' : 'nonpassing'
    for (const check of matching) {
      if (!object(check.app) || check.app.id !== requirement.provider) return result
      if (check.status !== 'completed') {
        if (!['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(String(check.status)) || check.conclusion !== null) return result
        disposition = 'nonpassing'
        continue
      }
      if (check.conclusion === 'success') continue
      if (check.conclusion === 'skipped' && requirement.name === 'Fro Bot' && candidate.generatedAppPr) {
        if (disposition === 'pass') disposition = 'accepted-skip'
      } else if (['failure', 'neutral', 'cancelled', 'timed_out', 'action_required', 'stale', 'skipped', 'startup_failure'].includes(String(check.conclusion))) disposition = 'nonpassing'
      else return result
    }
    if (disposition === 'nonpassing') allPassed = false
    if (disposition === 'pass' && e.realCi.checks.some(ci => ci.name === requirement.name && ci.integrationId === requirement.provider)) realCiPassed = true
    result.checks.push({name: requirement.name, revision, disposition})
  }
  result.verified = true
  result.ready = allPassed && realCiPassed
  return result
}
