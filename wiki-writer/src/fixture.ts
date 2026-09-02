import type {InternalWikiWriterAppOptions, WikiWriterApp} from './contract.ts'
import {Buffer} from 'node:buffer'
import {createRequestSignature} from './internal-auth.ts'
import {createWikiWriterAppWithInjectedSecret} from './server.ts'

const FIXTURE_SECRET = Buffer.from('wiki-writer-fixture-secret-which-is-long-enough')
const FIXTURE_NOW_SECONDS = 1_756_000_000

/**
 * Synthetic-only writer app. This module imports no GitHub package and has no
 * dependency injection point from which a GitHub client could be constructed.
 */
export function createFixtureWikiWriterApp(options: InternalWikiWriterAppOptions = {}): WikiWriterApp {
  return createWikiWriterAppWithInjectedSecret(FIXTURE_SECRET, {
    nowSeconds: options.nowSeconds ?? (() => FIXTURE_NOW_SECONDS),
    skewSeconds: options.skewSeconds,
    replayStore: options.replayStore,
    audit: options.audit,
    authorizeOperation: options.authorizeOperation ?? (() => ({allowed: true as const})),
  })
}

export function signFixtureRequest(method: string, path: string, body: string, requestId: string): Request {
  const timestamp = String(FIXTURE_NOW_SECONDS)
  const rawBody = Buffer.from(body)
  return new Request(`http://wiki-writer.fixture${path}`, {
    method,
    headers: {
      'x-request-id': requestId,
      'x-timestamp': timestamp,
      'x-signature': createRequestSignature(FIXTURE_SECRET, method, path, timestamp, rawBody, requestId),
    },
    body: method === 'GET' ? undefined : rawBody,
  })
}
