/**
 * Authorization for wiki writes.
 *
 * Pure decisions over an injected policy and a verified session. A write needs
 * configured write capability, an identity match (KTD6), an exact `Origin`
 * match, and a JSON content type. The routes answer every identity or origin
 * refusal with the same body, so a refusal does not say which check failed.
 */

import type {WikiWriteOffReason} from './config.ts'
import type {WriteAccess} from './pages.ts'

/** The verified session behind a request. */
export type WikiSession =
  | {readonly kind: 'gateway'; readonly operatorId: number; readonly login: string}
  | {readonly kind: 'arctic'; readonly login: string}

export type WriteCapability =
  | {
    readonly enabled: true
    /** The configured numeric operator ID. Null when only the fixture identity applies. */
    readonly operatorId: number | null
    readonly dashboardOrigin: string
  }
  | {readonly enabled: false; readonly reason: WikiWriteOffReason}

export interface IdentityPolicy {
  readonly capability: WriteCapability
  /**
   * The login an Arctic session needs to write. Set only while the fixture
   * harness is active. Null in every other deployment.
   */
  readonly fixtureOperatorLogin: string | null
}

/**
 * Whether the session may write. A gateway session needs `operatorId` equal to
 * the configured ID. An Arctic session never writes unless the fixture login
 * matches. Every other combination is read-only.
 */
export function resolveWriteAccess(policy: IdentityPolicy, session: WikiSession | null): WriteAccess {
  const {capability} = policy
  if (!capability.enabled) return {canWrite: false, reason: capability.reason}
  if (session === null) return {canWrite: false, reason: 'not-operator'}

  if (session.kind === 'gateway') {
    const matches = capability.operatorId !== null && session.operatorId === capability.operatorId
    return matches ? {canWrite: true} : {canWrite: false, reason: 'not-operator'}
  }

  if (policy.fixtureOperatorLogin === null) return {canWrite: false, reason: 'session-not-supported'}
  return session.login === policy.fixtureOperatorLogin ? {canWrite: true} : {canWrite: false, reason: 'not-operator'}
}

/** Exact comparison with the configured origin. A missing, `null`, or different value fails. */
export function originMatches(header: string | undefined, expected: string): boolean {
  return header !== undefined && expected !== '' && header === expected
}

export function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false
  return header.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

/** Rate-limit key for a writer. Its own key space, apart from client IPs. */
export function operatorRateLimitKey(session: WikiSession): string {
  return session.kind === 'gateway' ? `operator:${session.operatorId}` : `operator:login:${session.login}`
}
