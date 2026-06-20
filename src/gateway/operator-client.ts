/**
 * Typed Gateway operator API client contract.
 *
 * @contract-churn-prone — Gateway Phase B route units (4-6, 8) have not landed.
 * This module defines the mocked boundary contract only; no live /operator/* calls
 * are made until Gateway Phase B Unit 8 smoke readiness is confirmed.
 *
 * Security invariants:
 * - All paths must be relative (/operator/*); absolute URLs are rejected.
 * - Mutating calls (launchRun, decideApproval) reject before fetch when CSRF
 *   token or idempotency key is missing or blank.
 * - Logger receives only coarse metadata: path, status, event type, error code.
 *   Never logs: prompts, tool args, workspace paths, internal URLs, tokens,
 *   session IDs, cookies, or CSRF values.
 * - SSE transport is injectable; no DOM EventSource dependency.
 */

import type {Logger} from '../logger.ts'
import type {Result} from '../result.ts'
import type {OperatorCsrfToken, OperatorDecisionState, OperatorSessionInfo, OperatorWebStatus, RunStreamFrame} from './operator-contract/index.ts'
import {err, ok} from '../result.ts'
import {parseOperatorCsrfToken, parseOperatorSessionInfo} from './operator-contract/index.ts'

// ---------------------------------------------------------------------------
// Run status union
// ---------------------------------------------------------------------------

/** Canonical operator-facing run statuses from contract v1.0.0. */
export type RunStatus = OperatorWebStatus

// ---------------------------------------------------------------------------
// Approval state union
// ---------------------------------------------------------------------------

/** Canonical operator-facing decision states from contract v1.0.0. */
export type ApprovalDecisionState = OperatorDecisionState

// ---------------------------------------------------------------------------
// DTOs — frozen canonical shapes from operator contract v1.0.0
// ---------------------------------------------------------------------------

/** Canonical session response shape. expiresAt is ms-since-epoch (number). */
export type SessionDto = OperatorSessionInfo

/** Canonical CSRF token response shape. Field is csrfToken (not token). */
export type CsrfDto = OperatorCsrfToken

// ---------------------------------------------------------------------------
// MOCK-ONLY / DEFERRED — NOT part of frozen contract v1.0.0
//
// The following DTOs (LaunchRunRequest, LaunchRunResponse, RunSnapshotDto,
// PendingApprovalSummary, PendingApprovalsResponse, ApprovalDecisionRequest,
// ApprovalDecisionResponse) and the RunStreamEvent SSE union are MOCK-ONLY.
//
// Only the following are frozen in operator contract v1.0.0:
//   - GET /operator/session → OperatorSessionInfo (SessionDto)
//   - GET /operator/session/csrf → OperatorCsrfToken (CsrfDto)
//   - OperatorWebStatus (RunStatus)
//   - OperatorDecisionState (ApprovalDecisionState)
//
// These deferred types will be aligned to the canonical contract when
// Gateway Phase B route units (4-6, 8) land. Do NOT add conformance
// assertions over these types until they are frozen upstream.
// ---------------------------------------------------------------------------

export interface LaunchRunRequest {
  readonly owner: string
  readonly repo: string
  readonly prompt: string
  readonly idempotencyKey: string
  readonly csrfToken: string
}

export interface LaunchRunResponse {
  readonly runId: string
  readonly status: RunStatus
}

export interface RunSnapshotDto {
  readonly runId: string
  readonly status: RunStatus
  readonly owner: string
  readonly repo: string
  readonly createdAt: string
  readonly updatedAt?: string
}

export interface PendingApprovalSummary {
  readonly requestId: string
  readonly runId: string
  readonly safeSummary: string
  readonly approvalScope: string
  readonly createdAt: string
}

export interface PendingApprovalsResponse {
  readonly approvals: readonly PendingApprovalSummary[]
}

export interface ApprovalDecisionRequest {
  readonly requestId: string
  readonly decision: 'approve' | 'reject'
  readonly approvalScope: string
  readonly idempotencyKey: string
  readonly csrfToken: string
}

export interface ApprovalDecisionResponse {
  readonly state: ApprovalDecisionState
  readonly requestId: string
  readonly timestamp: string
}

// ---------------------------------------------------------------------------
// SSE run-stream event type — canonical named frames for /operator/runs/:runId/stream
//
// Sourced from the gateway's SSE surface (fro-bot/agent v0.72.0, PRs #961/#962).
// Named events: ready, status, reset. Heartbeat is an SSE comment, not a frame.
// ---------------------------------------------------------------------------

/**
 * Canonical SSE frame union for the run stream endpoint.
 * Re-exported from the operator contract for use by stream consumers.
 */
export type RunStreamEvent = RunStreamFrame

// ---------------------------------------------------------------------------
// SSE transport interface (injectable; no DOM EventSource)
// ---------------------------------------------------------------------------

export interface RunStreamEventMeta {
  readonly eventId?: string
}

export interface EventStreamHandle {
  readonly start: (
    onEvent: (event: RunStreamEvent, meta?: RunStreamEventMeta) => void,
    onError: (error: Error) => void,
    onClose: () => void,
  ) => void
  readonly close: () => void
}

export interface EventStreamOptions {
  readonly lastEventId?: string
}

// ---------------------------------------------------------------------------
// Client error types
// ---------------------------------------------------------------------------

export interface GatewayHttpError {
  readonly kind: 'http'
  readonly status: number
}

export interface GatewayValidationError {
  readonly kind: 'validation'
  readonly code:
    | 'missing_csrf'
    | 'missing_idempotency_key'
    | 'invalid_path'
    | 'missing_run_id'
    | 'missing_request_id'
  readonly message: string
}

export interface GatewayNetworkError {
  readonly kind: 'network'
  readonly message: string
}

export interface GatewayProtocolError {
  readonly kind: 'protocol'
  readonly message: string
}

export type GatewayClientError = GatewayHttpError | GatewayValidationError | GatewayNetworkError | GatewayProtocolError

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface OperatorClient {
  readonly getCurrentSession: () => Promise<Result<SessionDto, GatewayClientError>>
  readonly refreshCsrf: () => Promise<Result<CsrfDto, GatewayClientError>>
  readonly launchRun: (req: LaunchRunRequest) => Promise<Result<LaunchRunResponse, GatewayClientError>>
  readonly getRunSnapshot: (runId: string) => Promise<Result<RunSnapshotDto, GatewayClientError>>
  readonly connectRunStream: (
    runId: string,
    opts: {
      readonly onEvent: (event: RunStreamEvent, meta?: RunStreamEventMeta) => void
      readonly onError: (error: Error) => void
      readonly onClose: () => void
      readonly lastEventId?: string
    },
  ) => Result<EventStreamHandle, GatewayClientError>
  readonly listPendingApprovals: (opts?: {
    readonly runId?: string
  }) => Promise<Result<PendingApprovalsResponse, GatewayClientError>>
  readonly decideApproval: (
    req: ApprovalDecisionRequest,
  ) => Promise<Result<ApprovalDecisionResponse, GatewayClientError>>
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface OperatorClientOptions {
  /**
   * Injectable fetch implementation. Must accept relative paths only.
   * Required — callers must provide an explicit fetch to prevent accidental
   * live /operator/* calls in test or non-browser contexts.
   */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  /**
   * Injectable SSE transport factory. Receives a relative path and options.
   * Must not rely on DOM EventSource.
   */
  readonly createEventStream: (path: string, opts?: EventStreamOptions) => EventStreamHandle
  /**
   * Optional logger. Receives only coarse metadata — never sensitive values.
   */
  readonly logger?: Logger
}

// ---------------------------------------------------------------------------
// Guard helpers (module-level so they can be reused without closure capture)
// ---------------------------------------------------------------------------

/**
 * Validate that a path is a same-origin relative /operator/* path.
 *
 * Allowlist: must start with `/operator/` (or be exactly `/operator/`).
 * Rejects: any scheme-like URL (http:, https:, file:, data:, blob:, ftp:, etc.),
 * protocol-relative (//...), and any relative path not under /operator/.
 *
 * Exported as a test seam — do not use for anything other than path validation.
 */
export function validateOperatorPath(path: string): GatewayValidationError | null {
  const invalid = (message: string): GatewayValidationError =>
    ({kind: 'validation', code: 'invalid_path', message})

  // Reject leading/trailing whitespace
  if (path !== path.trim()) {
    return invalid('Path must not have leading or trailing whitespace.')
  }
  // Reject unsafe control characters: null bytes, CRLF, bare CR/LF
  if (/[\0\r\n]/.test(path)) {
    return invalid('Path must not contain null bytes or line terminators.')
  }
  // Reject protocol-relative URLs
  if (path.startsWith('//')) {
    return invalid('Absolute URLs are not allowed; use relative /operator/* paths only.')
  }
  // Reject any scheme-like URL: anything with a colon before the first slash
  // This covers http:, https:, file:, data:, blob:, ftp:, javascript:, etc.
  const colonIdx = path.indexOf(':')
  const firstSlashIdx = path.indexOf('/')
  if (colonIdx !== -1 && (firstSlashIdx === -1 || colonIdx < firstSlashIdx)) {
    return invalid('Absolute URLs are not allowed; use relative /operator/* paths only.')
  }
  // Allowlist: must start with /operator/ or be exactly /operator
  if (!path.startsWith('/operator/') && path !== '/operator') {
    return invalid('Absolute URLs are not allowed; use relative /operator/* paths only.')
  }
  // Reject path traversal: decoded .. segments anywhere in the path component
  // Split off query string first, then check path segments
  const pathComponent = path.split('?')[0] ?? path
  const segments = pathComponent.split('/')
  for (const segment of segments) {
    if (segment === '..') {
      return invalid('Path traversal is not allowed.')
    }
  }
  return null
}

function requireCsrf(csrfToken: string): GatewayValidationError | null {
  if (csrfToken.trim() === '') {
    return {kind: 'validation', code: 'missing_csrf', message: 'CSRF token is required for mutating calls.'}
  }
  return null
}

function requireIdempotencyKey(idempotencyKey: string): GatewayValidationError | null {
  if (idempotencyKey.trim() === '') {
    return {
      kind: 'validation',
      code: 'missing_idempotency_key',
      message: 'Idempotency key is required for mutating calls.',
    }
  }
  return null
}

/**
 * Validate a dynamic path ID (runId, requestId) before it is embedded in a URL.
 *
 * Rejects:
 * - blank or whitespace-only values
 * - any literal `/` or `\` (path separator injection)
 * - any percent-encoded slash (`%2F`, `%2f`) or backslash (`%5C`, `%5c`)
 * - any decoded segment equal to `.` or `..` (traversal after percent-decoding)
 *
 * Does NOT log the raw ID value — callers must use the error code only.
 */
function validateDynamicId(id: string): boolean {
  if (id.trim() === '') return false
  // Reject literal slash or backslash
  if (id.includes('/') || id.includes('\\')) return false
  // Reject percent-encoded slash (%2F/%2f) or backslash (%5C/%5c)
  if (/%(?:2f|5c)/i.test(id)) return false
  // Reject decoded `.` or `..` segments (after safe percent-decode attempt)
  let decoded: string
  try {
    decoded = decodeURIComponent(id)
  } catch {
    // Malformed percent-encoding — reject
    return false
  }
  if (decoded === '.' || decoded === '..') return false
  // Split decoded value on path separators and check each segment
  const segments = decoded.split(/[/\\]/)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return false
  }
  return true
}

function requireRunId(runId: string): GatewayValidationError | null {
  if (!validateDynamicId(runId)) {
    return {kind: 'validation', code: 'missing_run_id', message: 'Run ID is required and must not contain path separators or traversal sequences.'}
  }
  return null
}

function requireRequestId(requestId: string): GatewayValidationError | null {
  if (!validateDynamicId(requestId)) {
    return {kind: 'validation', code: 'missing_request_id', message: 'Request ID is required and must not contain path separators or traversal sequences.'}
  }
  return null
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a typed Gateway operator API client.
 *
 * All paths are relative /operator/* URLs. Absolute URLs are rejected.
 * Mutating calls require non-blank CSRF token and idempotency key.
 * The logger receives only coarse metadata (path, status, event type, error code).
 */
export function createOperatorClient(options: OperatorClientOptions): OperatorClient {
  const {fetch: fetchImpl, createEventStream, logger} = options

  // -------------------------------------------------------------------------
  // Internal fetch wrapper — validates relative paths, logs coarse metadata only
  // route is a static template string (e.g. '/operator/runs/:runId') used for
  // logging instead of the dynamic path to avoid leaking untrusted IDs.
  // -------------------------------------------------------------------------

  async function fetchJson<T>(
    path: string,
    route: string,
    init?: RequestInit,
  ): Promise<Result<T, GatewayClientError>> {
    const pathErr = validateOperatorPath(path)
    if (pathErr !== null) return err(pathErr)

    let response: Response
    try {
      response = await fetchImpl(path, init)
    } catch {
      const networkErr: GatewayNetworkError = {
        kind: 'network',
        // Coarse message only — do not include raw error text which may contain paths/tokens
        message: 'Network error',
      }
      logger?.error('operator-client: network error', {route})
      return err(networkErr)
    }

    if (response.ok) {
      let data: T
      try {
        // response.json() returns unknown; cast to T at the boundary
        const raw: unknown = await response.json()
        data = raw as T
      } catch {
        const protocolErr: GatewayProtocolError = {
          kind: 'protocol',
          message: 'Failed to parse response JSON',
        }
        logger?.error('operator-client: json parse error', {route})
        return err(protocolErr)
      }
      return ok(data)
    }

    const httpErr: GatewayHttpError = {
      kind: 'http',
      status: response.status,
    }
    // Log only coarse metadata: route template and status. Never log dynamic path or response body.
    logger?.error('operator-client: http error', {route, status: response.status})
    return err(httpErr)
  }

  // -------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------

  async function getCurrentSession(): Promise<Result<SessionDto, GatewayClientError>> {
    const raw = await fetchJson<unknown>('/operator/session', '/operator/session')
    if (!raw.success) return raw
    const parsed = parseOperatorSessionInfo(raw.data)
    if (!parsed.success) {
      const protocolErr: GatewayProtocolError = {kind: 'protocol', message: 'Failed to parse session response'}
      logger?.error('operator-client: session parse error', {route: '/operator/session'})
      return err(protocolErr)
    }
    return ok(parsed.data)
  }

  async function refreshCsrf(): Promise<Result<CsrfDto, GatewayClientError>> {
    const raw = await fetchJson<unknown>('/operator/session/csrf', '/operator/session/csrf')
    if (!raw.success) return raw
    const parsed = parseOperatorCsrfToken(raw.data)
    if (!parsed.success) {
      const protocolErr: GatewayProtocolError = {kind: 'protocol', message: 'Failed to parse csrf response'}
      logger?.error('operator-client: csrf parse error', {route: '/operator/session/csrf'})
      return err(protocolErr)
    }
    return ok(parsed.data)
  }

  async function launchRun(req: LaunchRunRequest): Promise<Result<LaunchRunResponse, GatewayClientError>> {
    const csrfGuard = requireCsrf(req.csrfToken)
    if (csrfGuard !== null) return err(csrfGuard)

    const idemGuard = requireIdempotencyKey(req.idempotencyKey)
    if (idemGuard !== null) return err(idemGuard)

    // Build request body — exclude csrfToken and idempotencyKey from body;
    // they travel as headers. Never include prompt in logs.
    const body = JSON.stringify({
      owner: req.owner,
      repo: req.repo,
      prompt: req.prompt,
    })

    return fetchJson<LaunchRunResponse>(
      '/operator/runs',
      '/operator/runs',
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': req.csrfToken,
          'idempotency-key': req.idempotencyKey,
        },
        body,
      },
    )
  }

  async function getRunSnapshot(runId: string): Promise<Result<RunSnapshotDto, GatewayClientError>> {
    const runIdErr = requireRunId(runId)
    if (runIdErr !== null) return err(runIdErr)

    return fetchJson<RunSnapshotDto>(
      `/operator/runs/${encodeURIComponent(runId)}`,
      '/operator/runs/:runId',
    )
  }

  function connectRunStream(
    runId: string,
    opts: {
      readonly onEvent: (event: RunStreamEvent, meta?: RunStreamEventMeta) => void
      readonly onError: (error: Error) => void
      readonly onClose: () => void
      readonly lastEventId?: string
    },
  ): Result<EventStreamHandle, GatewayClientError> {
    const runIdErr = requireRunId(runId)
    if (runIdErr !== null) {
      return err(runIdErr)
    }

    const path = `/operator/runs/${encodeURIComponent(runId)}/stream`
    const streamOpts: EventStreamOptions =
      opts.lastEventId === undefined ? {} : {lastEventId: opts.lastEventId}

    let handle: EventStreamHandle
    try {
      handle = createEventStream(path, streamOpts)
    } catch {
      logger?.error('operator-client: stream setup error', {route: '/operator/runs/:runId/stream'})
      return err({kind: 'network', message: 'Network error'} satisfies GatewayNetworkError)
    }

    try {
      handle.start(
        (event, meta) => opts.onEvent(event, meta),
        error => {
          // Log only coarse route template — never the dynamic path which contains the runId
          logger?.error('operator-client: stream error', {route: '/operator/runs/:runId/stream', eventType: 'stream.error'})
          opts.onError(error)
        },
        opts.onClose,
      )
    } catch {
      logger?.error('operator-client: stream setup error', {route: '/operator/runs/:runId/stream'})
      return err({kind: 'network', message: 'Network error'} satisfies GatewayNetworkError)
    }

    return ok(handle)
  }

  async function listPendingApprovals(
    listOpts?: {readonly runId?: string},
  ): Promise<Result<PendingApprovalsResponse, GatewayClientError>> {
    if (listOpts?.runId !== undefined) {
      const runIdErr = requireRunId(listOpts.runId)
      if (runIdErr !== null) return err(runIdErr)
    }
    const path =
      listOpts?.runId === undefined
        ? '/operator/approvals'
        : `/operator/approvals?runId=${encodeURIComponent(listOpts.runId)}`
    return fetchJson<PendingApprovalsResponse>(path, '/operator/approvals')
  }

  async function decideApproval(
    req: ApprovalDecisionRequest,
  ): Promise<Result<ApprovalDecisionResponse, GatewayClientError>> {
    const requestIdErr = requireRequestId(req.requestId)
    if (requestIdErr !== null) return err(requestIdErr)

    const csrfGuard = requireCsrf(req.csrfToken)
    if (csrfGuard !== null) return err(csrfGuard)

    const idemGuard = requireIdempotencyKey(req.idempotencyKey)
    if (idemGuard !== null) return err(idemGuard)

    const body = JSON.stringify({
      decision: req.decision,
      approvalScope: req.approvalScope,
    })

    return fetchJson<ApprovalDecisionResponse>(
      `/operator/approvals/${encodeURIComponent(req.requestId)}/decision`,
      '/operator/approvals/:requestId/decision',
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': req.csrfToken,
          'idempotency-key': req.idempotencyKey,
        },
        body,
      },
    )
  }

  return {
    getCurrentSession,
    refreshCsrf,
    launchRun,
    getRunSnapshot,
    connectRunStream,
    listPendingApprovals,
    decideApproval,
  }
}
