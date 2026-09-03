/**
 * Narrow wire contract for the private wiki writer boundary.
 *
 * The service has no GitHub client in this unit. The write operation ends at
 * the authorization seam and returns an acceptance acknowledgement only.
 */

export const WIKI_WRITER_HEALTH_PATH = '/healthz'
export const WIKI_WRITER_WRITE_PATH = '/write'

export interface WikiWriterHealth {
  readonly ready: true
}

export interface WikiWriteRequest {
  readonly operation: 'write'
  readonly repository: string
  readonly ref: string
  readonly path: string
  readonly content: string
  readonly operationId?: string
  readonly expectedParentSha?: string
  readonly expectedBlobSha?: string
  readonly corrections?: readonly Record<string, unknown>[]
}

export type OperationAuthorization =
  | {readonly allowed: true}
  | {readonly allowed: false; readonly reasonClass: 'operation_not_authorized'}

export type OperationAuthorizer = (request: WikiWriteRequest) => OperationAuthorization | Promise<OperationAuthorization>

export type AuditReasonClass =
  | 'missing_header'
  | 'malformed_signature'
  | 'signature_mismatch'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'duplicate_request_id'
  | 'credential_header'
  | 'body_too_large'

export interface AuditEvent {
  readonly outcome: 'rejected'
  readonly reasonClass: AuditReasonClass
  readonly requestId: string
}

export type AuditSink = (event: AuditEvent) => void

export interface WikiWriterApp {
  readonly fetch: (request: Request) => Promise<Response>
  readonly rejectBodyTooLarge: (requestId: string) => Response
}

export interface WikiWriteOperationHandler {
  readonly execute: (request: WikiWriteRequest) => Promise<unknown>
}

export interface WikiWriterAppOptions {
  readonly secretFilePath: string
  readonly githubAppId?: string | number
  readonly githubInstallationId?: number
  readonly githubPrivateKeyFilePath?: string
  readonly ledgerPath?: string
  readonly nowSeconds?: () => number
  readonly skewSeconds?: number
  readonly replayStore?: ReplayStore
  readonly audit?: AuditSink
  readonly authorizeOperation?: OperationAuthorizer
  readonly writeOperation?: WikiWriteOperationHandler
}

export interface InternalWikiWriterAppOptions {
  readonly nowSeconds?: () => number
  readonly skewSeconds?: number
  readonly replayStore?: ReplayStore
  readonly audit?: AuditSink
  readonly authorizeOperation?: OperationAuthorizer
  readonly writeOperation?: WikiWriteOperationHandler
}

export interface ReplayStore {
  readonly remember: (requestId: string, nowSeconds: number, ttlSeconds: number) => boolean
}

export function isWikiWriteRequest(value: unknown): value is WikiWriteRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.operation === 'write' &&
    typeof candidate.repository === 'string' &&
    typeof candidate.ref === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.content === 'string'
  )
}
