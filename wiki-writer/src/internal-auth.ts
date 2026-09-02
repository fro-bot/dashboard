import type {AuditEvent, AuditReasonClass, AuditSink, ReplayStore} from './contract.ts'
import {Buffer} from 'node:buffer'
import {createHash, createHmac, timingSafeEqual} from 'node:crypto'
import {readFile} from 'node:fs/promises'

const MIN_SECRET_BYTES = 32
const DEFAULT_SKEW_SECONDS = 300
const DEFAULT_MAX_REPLAY_ENTRIES = 10_000
const SIGNATURE_RE = /^sha256=([\da-f]{64})$/i
const ALTERNATE_CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-service-token',
  'x-writer-token',
  'x-access-token',
  'x-credential',
  'x-secret',
  'x-token',
])

export interface InternalAuthInput {
  readonly secret: Uint8Array
  readonly method: string
  readonly path: string
  readonly rawBody: Uint8Array
  readonly headers: Headers
  readonly nowSeconds: number
  readonly skewSeconds?: number
  readonly replayStore?: ReplayStore
  readonly audit?: AuditSink
}

export type InternalAuthResult =
  | {readonly ok: true; readonly requestId: string}
  | {readonly ok: false; readonly reasonClass: AuditReasonClass; readonly requestId: string}

export function emitAuditRejection(audit: AuditSink | undefined, reasonClass: AuditReasonClass, requestId: string): void {
  const event: AuditEvent = {outcome: 'rejected', reasonClass, requestId}
  try {
    audit?.(event)
  } catch {
    // An audit sink cannot turn a bounded authentication rejection into a success.
  }
}

/** Load only raw bytes from the configured file-mounted secret. */
export async function loadInternalAuthSecret(secretFilePath: string): Promise<Buffer> {
  const secret = await readFile(secretFilePath)
  assertSecretLength(secret)
  return secret
}

/**
 * Compute the request signature over method, path, timestamp, raw-body hash,
 * and request ID, in that order. The body hash is calculated from raw bytes.
 */
export function createRequestSignature(
  secret: Uint8Array,
  method: string,
  path: string,
  timestamp: string,
  rawBody: Uint8Array,
  requestId: string,
): string {
  assertSecretLength(secret)
  const bodyHash = createHash('sha256').update(rawBody).digest('hex')
  const signedValue = `${method}${path}${timestamp}${bodyHash}${requestId}`
  return `sha256=${createHmac('sha256', secret).update(signedValue).digest('hex')}`
}

/** Verify the HMAC before timestamp, replay, or operation checks. */
export function authenticateInternalRequest(input: InternalAuthInput): InternalAuthResult {
  assertSecretLength(input.secret)

  const requestId = input.headers.get('x-request-id') ?? 'unknown'
  const timestamp = input.headers.get('x-timestamp')
  const signature = input.headers.get('x-signature')

  if (timestamp === null || signature === null || input.headers.get('x-request-id') === null) {
    return reject(input.audit, 'missing_header', requestId)
  }

  const signatureMatch = SIGNATURE_RE.exec(signature)
  if (signatureMatch === null) {
    return reject(input.audit, 'malformed_signature', requestId)
  }

  const expectedSignature = createRequestSignature(input.secret, input.method, input.path, timestamp, input.rawBody, requestId)
  const expectedBytes = Buffer.from(expectedSignature, 'utf8')
  const providedBytes = Buffer.from(signature, 'utf8')
  if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) {
    return reject(input.audit, 'signature_mismatch', requestId)
  }

  const timestampNumber = Number(timestamp)
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(timestampNumber)) {
    return reject(input.audit, 'invalid_timestamp', requestId)
  }

  const skewSeconds = input.skewSeconds ?? DEFAULT_SKEW_SECONDS
  if (Math.abs(input.nowSeconds - timestampNumber) > skewSeconds) {
    return reject(input.audit, 'stale_timestamp', requestId)
  }

  if (hasAlternateCredentialHeader(input.headers)) {
    return reject(input.audit, 'credential_header', requestId)
  }

  if (input.replayStore !== undefined && !input.replayStore.remember(requestId, input.nowSeconds, skewSeconds)) {
    return reject(input.audit, 'duplicate_request_id', requestId)
  }

  return {ok: true, requestId}
}

/**
 * Bounded in-memory replay protection for Unit 1. The oldest entries are
 * evicted at capacity, so this is deliberately window-limited; Unit 2 adds
 * durable replay state for stronger retention across restarts and floods.
 */
export class InMemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, number>()
  private readonly maxEntries: number

  constructor(maxEntries = DEFAULT_MAX_REPLAY_ENTRIES) {
    this.maxEntries = maxEntries
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Replay store capacity must be a positive safe integer')
    }
  }

  get size(): number {
    return this.entries.size
  }

  remember(requestId: string, nowSeconds: number, ttlSeconds: number): boolean {
    for (const [storedRequestId, storedAt] of this.entries) {
      if (nowSeconds - storedAt > ttlSeconds) this.entries.delete(storedRequestId)
    }

    if (this.entries.has(requestId)) return false
    this.entries.set(requestId, nowSeconds)

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest !== 'string') break
      this.entries.delete(oldest)
    }
    return true
  }
}

function hasAlternateCredentialHeader(headers: Headers): boolean {
  for (const headerName of headers.keys()) {
    if (ALTERNATE_CREDENTIAL_HEADERS.has(headerName.toLowerCase())) return true
  }
  return false
}

function reject(audit: AuditSink | undefined, reasonClass: AuditReasonClass, requestId: string): InternalAuthResult {
  emitAuditRejection(audit, reasonClass, requestId)
  return {ok: false, reasonClass, requestId}
}

function assertSecretLength(secret: Uint8Array): void {
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(`Internal auth secret must be at least ${MIN_SECRET_BYTES} bytes`)
  }
}
