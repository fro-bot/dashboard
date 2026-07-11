/**
 * Wire DTOs + parser for the operator listener channel.
 *
 * See docs/contracts/operator-listener-channel.md — the authoritative wire contract.
 * Parse-don't-validate: `parseIngestBody` copies only declared fields into a
 * closed DTO and returns fixed, content-free error reasons.
 */
import type {Result} from '../result.ts'
import {Buffer} from 'node:buffer'
import {err, ok} from '../result.ts'

export type ListenerSource = 'infra' | 'agent'
export type ListenerSeverity = 'info' | 'warning' | 'critical'

export interface ListenerLink {
  readonly label: string
  readonly url: string
}

/** Producer-supplied content, post-validation. Server assigns id/receivedAt/read. */
export interface IngestMessage {
  readonly source: ListenerSource
  readonly kind: string
  readonly severity: ListenerSeverity
  readonly title: string
  readonly body: string
  readonly links: readonly ListenerLink[]
  readonly dedupeKey: string | null
  readonly createdAt: string
}

/** The stored/read shape returned to the operator UI. */
export interface ListenerMessage extends IngestMessage {
  readonly id: string
  readonly receivedAt: string
  readonly read: boolean
}

export interface MessagesResponse {
  readonly messages: readonly ListenerMessage[]
  readonly unreadCount: number
}

const KIND_RE = /^[a-z0-9-]{1,64}$/
const MAX_LINKS = 10
const MAX_TITLE_CHARS = 200
const MAX_BODY_BYTES = 8192
const MAX_LABEL_CHARS = 80
const MAX_DEDUPE_KEY_CHARS = 128

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function parseLinks(raw: unknown): Result<ListenerLink[], Error> {
  if (raw === undefined) return ok([])
  if (!Array.isArray(raw)) return err(new Error('invalid links'))
  if (raw.length > MAX_LINKS) return err(new Error('too many links'))

  const links: ListenerLink[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) return err(new Error('invalid link'))
    const {label, url} = entry
    if (typeof label !== 'string') return err(new Error('invalid link label'))
    const trimmedLabel = label.trim()
    if (trimmedLabel.length < 1 || trimmedLabel.length > MAX_LABEL_CHARS) {
      return err(new Error('invalid link label'))
    }
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return err(new Error('invalid link url'))
    }
    links.push({label: trimmedLabel, url})
  }
  return ok(links)
}

/**
 * Parses and validates a raw ingest request body against the contract.
 * Returns a closed `IngestMessage` DTO on success, or a fixed-reason `Error`
 * on any violation. Never includes the offending value in the error message.
 */
export function parseIngestBody(raw: unknown): Result<IngestMessage, Error> {
  if (!isRecord(raw)) return err(new Error('invalid request body'))

  const {source, kind, severity, title, body, links, dedupeKey, createdAt} = raw

  if (source !== 'infra' && source !== 'agent') {
    return err(new Error('invalid source'))
  }

  if (typeof kind !== 'string' || !KIND_RE.test(kind)) {
    return err(new Error('invalid kind'))
  }

  if (severity !== 'info' && severity !== 'warning' && severity !== 'critical') {
    return err(new Error('invalid severity'))
  }

  if (typeof title !== 'string') return err(new Error('invalid title'))
  const trimmedTitle = title.trim()
  if (trimmedTitle.length < 1 || trimmedTitle.length > MAX_TITLE_CHARS) {
    return err(new Error('invalid title'))
  }

  if (typeof body !== 'string') return err(new Error('invalid body'))
  const trimmedBody = body.trim()
  if (trimmedBody.length < 1 || utf8ByteLength(trimmedBody) > MAX_BODY_BYTES) {
    return err(new Error('invalid body'))
  }

  const linksResult = parseLinks(links)
  if (!linksResult.success) return linksResult

  let parsedDedupeKey: string | null = null
  if (dedupeKey !== undefined && dedupeKey !== null) {
    if (typeof dedupeKey !== 'string' || dedupeKey.length > MAX_DEDUPE_KEY_CHARS || dedupeKey.length === 0) {
      return err(new Error('invalid dedupeKey'))
    }
    parsedDedupeKey = dedupeKey
  }

  if (typeof createdAt !== 'string') return err(new Error('invalid createdAt'))
  const parsedDate = new Date(createdAt)
  if (Number.isNaN(parsedDate.getTime())) {
    return err(new Error('invalid createdAt'))
  }

  return ok({
    source,
    kind,
    severity,
    title: trimmedTitle,
    body: trimmedBody,
    links: linksResult.data,
    dedupeKey: parsedDedupeKey,
    createdAt,
  })
}
