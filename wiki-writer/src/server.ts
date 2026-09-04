import type {AuditSink, InternalWikiWriterAppOptions, WikiWriteOperationHandler, WikiWriterApp, WikiWriterAppOptions} from './contract.ts'
import {Buffer} from 'node:buffer'
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {isCompleteWikiWriteRequest, isWikiWriteRequest, WIKI_WRITER_HEALTH_PATH, WIKI_WRITER_WRITE_PATH} from './contract.ts'
import {createGateContractChecker} from './gate-contract.ts'
import {createGitHubDataClient} from './github-data-client.ts'
import {authenticateInternalRequest, createRequestSignature, emitAuditRejection, InMemoryReplayStore, loadInternalAuthSecret} from './internal-auth.ts'
import {createOperationLedger} from './operation-ledger.ts'
import {createWikiWriteOperation, type WikiWriteResult} from './write-operation.ts'

export const WIKI_WRITER_MAX_RAW_BYTES = 1024 * 1024

export async function createWikiWriterApp(options: WikiWriterAppOptions): Promise<WikiWriterApp> {
  const secret = await loadInternalAuthSecret(options.secretFilePath)
  const writeOperation = options.writeOperation ?? await createProductionWriteOperation(options)
  return createWikiWriterAppWithInjectedSecret(secret, {...options, writeOperation})
}

/**
 * Production callers must use createWikiWriterApp, which enforces file-mounted
 * loading and fail-closed length validation. This variant exists so tests and
 * the synthetic fixture can supply bytes directly; routing a real deployment
 * through it would bypass the file-mount invariant.
 */
export function createWikiWriterAppWithInjectedSecret(secret: Uint8Array, options: InternalWikiWriterAppOptions = {}): WikiWriterApp {
  const replayStore = options.replayStore ?? new InMemoryReplayStore()
  const authorizeOperation = options.authorizeOperation ?? (() => ({allowed: false as const, reasonClass: 'operation_not_authorized' as const}))

  return {
    fetch: async request => {
      const url = new URL(request.url)
      // Use one path value for both signing verification and routing so they cannot diverge.
      const path = `${url.pathname}${url.search}`
      const rawBody = await readBoundedRequestBody(request)
      if (rawBody === null) return rejectBodyTooLarge(options.audit, request.headers.get('x-request-id') ?? 'unknown')
      const auth = authenticateInternalRequest({
        secret,
        method: request.method,
        path,
        rawBody,
        headers: request.headers,
        nowSeconds: options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
        skewSeconds: options.skewSeconds,
        replayStore,
        audit: options.audit,
      })

      if (!auth.ok) return jsonResponse({error: 'unauthorized'}, 401)

      if (request.method === 'GET' && path === WIKI_WRITER_HEALTH_PATH) {
        return jsonResponse({ready: true})
      }

      if (request.method !== 'POST' || path !== WIKI_WRITER_WRITE_PATH) {
        return jsonResponse({error: 'not-found'}, 404)
      }

      let payload: unknown
      try {
        payload = JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown
      } catch {
        return jsonResponse({error: 'invalid-request'}, 400)
      }

      if (!isWikiWriteRequest(payload)) return jsonResponse({error: 'invalid-request'}, 400)

      if (options.writeOperation !== undefined) {
        if (!isCompleteWikiWriteRequest(payload)) return jsonResponse({error: 'invalid-request'}, 400)
        const result = await options.writeOperation.execute(payload)
        return writeResultResponse(result)
      }

      const authorization = await authorizeOperation(payload)
      if (!authorization.allowed) return jsonResponse({error: 'forbidden'}, 403)
      return jsonResponse({accepted: true}, 202)
    },
    rejectBodyTooLarge: requestId => rejectBodyTooLarge(options.audit, requestId),
  }
}

export interface WikiWriterHttpOptions {
  readonly host?: string
  readonly port?: number
}

export function createWikiWriterHttpServer(app: WikiWriterApp): Server {
  return createServer((request, response) => {
    handleNodeRequest(app, request, response).catch(() => {
      response.statusCode = 500
      response.end()
    })
  })
}

export async function startWikiWriterServer(options: WikiWriterHttpOptions = {}): Promise<Server> {
  const secretFilePath = process.env.WIKI_WRITER_HMAC_SECRET_FILE ?? '/run/secrets/wiki_writer_hmac'
  const app = await createWikiWriterApp({
    secretFilePath,
    githubAppId: requiredEnvironment('WIKI_WRITER_GITHUB_APP_ID'),
    githubInstallationId: parseEnvironmentInteger('WIKI_WRITER_GITHUB_INSTALLATION_ID'),
    githubPrivateKeyFilePath: requiredEnvironment('WIKI_WRITER_GITHUB_PRIVATE_KEY_FILE'),
    ledgerPath: process.env.WIKI_WRITER_LEDGER_PATH ?? '/var/lib/wiki-writer/operations.sqlite',
  })
  const server = createWikiWriterHttpServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 0.0.0.0 is required for sibling-service container access; containment is
    // provided by the private network, with no published port or proxy route.
    server.listen(options.port ?? 3000, options.host ?? '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

async function handleNodeRequest(app: WikiWriterApp, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestId = readNodeHeader(request, 'x-request-id') ?? 'unknown'
  if (contentLengthExceedsLimit(request.headers['content-length'])) {
    await writeNodeResponse(app.rejectBodyTooLarge(requestId), response)
    return
  }

  const chunks: Buffer[] = []
  let bodyLength = 0
  for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
    const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(new Uint8Array(chunk))
    bodyLength += chunkBuffer.byteLength
    if (bodyLength > WIKI_WRITER_MAX_RAW_BYTES) {
      // Stop consuming immediately: early async-iterator exit destroys the
      // socket, so this refuses the remaining body without hanging or draining it.
      await writeNodeResponse(app.rejectBodyTooLarge(requestId), response)
      return
    }
    chunks.push(chunkBuffer)
  }

  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(','))
  }

  const body = Buffer.concat(chunks)
  const method = request.method ?? 'GET'
  const host = headers.get('host') ?? 'localhost'
  const url = new URL(request.url ?? '/', `http://${host}`)
  const webRequest = new Request(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  })
  const webResponse = await app.fetch(webRequest)
  await writeNodeResponse(webResponse, response)
}

async function readBoundedRequestBody(request: Request): Promise<Uint8Array | null> {
  if (contentLengthExceedsLimit(request.headers.get('content-length'))) return null
  if (request.body === null) return new Uint8Array()

  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  let bodyLength = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const chunk = result.value
      bodyLength += chunk.byteLength
      if (bodyLength > WIKI_WRITER_MAX_RAW_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(bodyLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function contentLengthExceedsLimit(value: string | string[] | null | undefined): boolean {
  const rawValue = Array.isArray(value) ? value[0] : value
  if (rawValue === undefined || rawValue === null || !/^\d+$/.test(rawValue)) return false
  const contentLength = Number(rawValue)
  return Number.isSafeInteger(contentLength) && contentLength > WIKI_WRITER_MAX_RAW_BYTES
}

function readNodeHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}

function rejectBodyTooLarge(audit: AuditSink | undefined, requestId: string): Response {
  emitAuditRejection(audit, 'body_too_large', requestId)
  return jsonResponse({error: 'payload-too-large'}, 413)
}

async function writeNodeResponse(webResponse: Response, response: ServerResponse): Promise<void> {
  response.statusCode = webResponse.status
  webResponse.headers.forEach((value, name) => response.setHeader(name, value))
  response.end(new Uint8Array(await webResponse.arrayBuffer()))
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  })
}

async function createProductionWriteOperation(options: WikiWriterAppOptions): Promise<WikiWriteOperationHandler | undefined> {
  const configuredFields = [options.githubAppId, options.githubInstallationId, options.githubPrivateKeyFilePath]
  const hasAnyGitHubConfig = configuredFields.some(value => value !== undefined)
  const hasGitHubConfig = options.githubAppId !== undefined &&
    options.githubInstallationId !== undefined &&
    options.githubPrivateKeyFilePath !== undefined
  if (hasAnyGitHubConfig && !hasGitHubConfig) throw new Error('GitHub writer configuration is incomplete')
  if (!hasGitHubConfig) return undefined

  const client = await createGitHubDataClient({
    appId: options.githubAppId,
    installationId: options.githubInstallationId,
    privateKeyFilePath: options.githubPrivateKeyFilePath,
  })
  const ledger = createOperationLedger(options.ledgerPath ?? '/var/lib/wiki-writer/operations.sqlite')
  const operation = createWikiWriteOperation({
    client,
    ledger,
    gateContractChecker: createGateContractChecker({fetch}),
  })
  return {
    execute: async request => operation.execute(request),
  }
}

function writeResultResponse(value: unknown): Response {
  if (value === null || typeof value !== 'object') return jsonResponse({error: 'write-failed'}, 500)
  const result = value as WikiWriteResult
  switch (result.state) {
    case 'succeeded':
      return jsonResponse({accepted: true, operationId: result.operationId, commitSha: result.commitSha}, 202)
    case 'conflict':
      return jsonResponse({error: 'precondition-failed'}, 412)
    case 'indeterminate':
      return jsonResponse({accepted: true, status: 'indeterminate', operationId: result.operationId}, 202)
    case 'rejected':
      if (result.reason === 'content-too-large') return jsonResponse({error: 'content-too-large'}, 413)
      return jsonResponse({error: result.reason, ...(result.findings === undefined ? {} : {findings: result.findings})}, 422)
    case 'failed':
      return jsonResponse({error: 'write-failed', correlationId: result.correlationId}, 500)
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function parseEnvironmentInteger(name: string): number {
  const value = Number(requiredEnvironment(name))
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startWikiWriterServer().catch(() => {
    process.exitCode = 1
  })
}

// Keep the signing helper available to local contract tests without duplicating
// the canonical request construction in callers.
export {createRequestSignature}
