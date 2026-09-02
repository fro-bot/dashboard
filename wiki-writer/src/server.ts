import type {InternalWikiWriterAppOptions, WikiWriterApp, WikiWriterAppOptions} from './contract.ts'
import {Buffer} from 'node:buffer'
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {isWikiWriteRequest, WIKI_WRITER_HEALTH_PATH, WIKI_WRITER_WRITE_PATH} from './contract.ts'
import {authenticateInternalRequest, createRequestSignature, InMemoryReplayStore, loadInternalAuthSecret} from './internal-auth.ts'

export async function createWikiWriterApp(options: WikiWriterAppOptions): Promise<WikiWriterApp> {
  const secret = await loadInternalAuthSecret(options.secretFilePath)
  return createWikiWriterAppFromSecret(secret, options)
}

/** Explicit secret injection seam used only by the synthetic fixture. */
export function createWikiWriterAppFromSecret(secret: Uint8Array, options: InternalWikiWriterAppOptions = {}): WikiWriterApp {
  const replayStore = options.replayStore ?? new InMemoryReplayStore()
  const authorizeOperation = options.authorizeOperation ?? (() => ({allowed: false as const, reasonClass: 'operation_not_authorized' as const}))

  return {
    fetch: async request => {
      const url = new URL(request.url)
      const rawBody = new Uint8Array(await request.arrayBuffer())
      const auth = authenticateInternalRequest({
        secret,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        rawBody,
        headers: request.headers,
        nowSeconds: options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
        skewSeconds: options.skewSeconds,
        replayStore,
        audit: options.audit,
      })

      if (!auth.ok) return jsonResponse({error: 'unauthorized'}, 401)

      const path = `${url.pathname}${url.search}`
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

      const authorization = await authorizeOperation(payload)
      if (!authorization.allowed) return jsonResponse({error: 'forbidden'}, 403)
      return jsonResponse({accepted: true}, 202)
    },
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
  const app = await createWikiWriterApp({secretFilePath})
  const server = createWikiWriterHttpServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 3000, options.host ?? '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

async function handleNodeRequest(app: WikiWriterApp, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(new Uint8Array(chunk)))
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startWikiWriterServer().catch(() => {
    process.exitCode = 1
  })
}

// Keep the signing helper available to local contract tests without duplicating
// the canonical request construction in callers.
export {createRequestSignature}
