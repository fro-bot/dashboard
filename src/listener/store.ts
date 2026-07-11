/**
 * `node:sqlite`-backed persistence for the operator listener channel.
 *
 * See docs/contracts/operator-listener-channel.md — retention policy (500 rows
 * / 30 days) and idempotency (dedupeKey upsert) are enforced here.
 */
import type {IngestMessage, ListenerLink, ListenerMessage, MessagesResponse} from './contract.ts'
import {randomUUID} from 'node:crypto'
import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {DatabaseSync} from 'node:sqlite'

export interface ListenerStore {
  insert: (input: IngestMessage) => {id: string; receivedAt: string}
  list: (opts: {unreadOnly?: boolean; limit?: number}) => MessagesResponse
  ack: (id: string) => {acked: boolean; readAt: string | null}
  ackAll: () => number
  prune: () => void
  close: () => void
}

/** Raw row shape as read back from `node:sqlite`. */
interface MessageRow {
  id: string
  source: string
  kind: string
  severity: string
  title: string
  body: string
  links: string
  dedupe_key: string | null
  created_at: string
  received_at: string
  read_at: string | null
}

const RETENTION_MAX_ROWS = 500
const RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_LIST_LIMIT = 100
const MIN_LIST_LIMIT = 1
const MAX_LIST_LIMIT = 200

function rowToMessage(row: MessageRow): ListenerMessage {
  return {
    id: row.id,
    source: row.source as ListenerMessage['source'],
    kind: row.kind,
    severity: row.severity as ListenerMessage['severity'],
    title: row.title,
    body: row.body,
    links: JSON.parse(row.links) as readonly ListenerLink[],
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    receivedAt: row.received_at,
    read: row.read_at !== null,
  }
}

export function createListenerStore(dbPath: string): ListenerStore {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), {recursive: true})
  }

  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      links TEXT NOT NULL,
      dedupe_key TEXT NULL,
      created_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      read_at TEXT NULL
    )
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_dedupe
      ON messages(source, dedupe_key)
      WHERE dedupe_key IS NOT NULL
  `)

  const findByDedupeStmt = db.prepare('SELECT id FROM messages WHERE source = ? AND dedupe_key = ?')
  const insertStmt = db.prepare(`
    INSERT INTO messages (id, source, kind, severity, title, body, links, dedupe_key, created_at, received_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `)
  const updateByIdStmt = db.prepare(`
    UPDATE messages
    SET kind = ?, severity = ?, title = ?, body = ?, links = ?, created_at = ?, received_at = ?, read_at = NULL
    WHERE id = ?
  `)
  const selectAllStmt = db.prepare('SELECT * FROM messages ORDER BY received_at DESC LIMIT ?')
  const selectUnreadStmt = db.prepare('SELECT * FROM messages WHERE read_at IS NULL ORDER BY received_at DESC LIMIT ?')
  const countUnreadStmt = db.prepare('SELECT COUNT(*) as n FROM messages WHERE read_at IS NULL')
  const selectByIdStmt = db.prepare('SELECT id, read_at FROM messages WHERE id = ?')
  const ackStmt = db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL')
  const ackAllStmt = db.prepare('UPDATE messages SET read_at = ? WHERE read_at IS NULL')
  const pruneCountStmt = db.prepare('SELECT COUNT(*) as n FROM messages')
  const pruneOverflowStmt = db.prepare(`
    DELETE FROM messages WHERE id IN (
      SELECT id FROM messages ORDER BY received_at DESC LIMIT -1 OFFSET ?
    )
  `)
  const pruneAgeStmt = db.prepare('DELETE FROM messages WHERE received_at < ?')

  function insert(input: IngestMessage): {id: string; receivedAt: string} {
    const receivedAt = new Date().toISOString()
    const linksJson = JSON.stringify(input.links)

    if (input.dedupeKey !== null) {
      const existing = findByDedupeStmt.get(input.source, input.dedupeKey) as unknown as {id: string} | undefined
      if (existing !== undefined) {
        updateByIdStmt.run(
          input.kind,
          input.severity,
          input.title,
          input.body,
          linksJson,
          input.createdAt,
          receivedAt,
          existing.id,
        )
        prune()
        return {id: existing.id, receivedAt}
      }
    }

    const id = randomUUID()
    insertStmt.run(
      id,
      input.source,
      input.kind,
      input.severity,
      input.title,
      input.body,
      linksJson,
      input.dedupeKey,
      input.createdAt,
      receivedAt,
    )
    prune()
    return {id, receivedAt}
  }

  function list(opts: {unreadOnly?: boolean; limit?: number}): MessagesResponse {
    const rawLimit = opts.limit ?? DEFAULT_LIST_LIMIT
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(MIN_LIST_LIMIT, rawLimit))

    const rows =
      opts.unreadOnly === true
        ? (selectUnreadStmt.all(limit) as unknown as MessageRow[])
        : (selectAllStmt.all(limit) as unknown as MessageRow[])

    const unreadCountRow = countUnreadStmt.get() as unknown as {n: number}

    return {
      messages: rows.map(rowToMessage),
      unreadCount: unreadCountRow.n,
    }
  }

  function ack(id: string): {acked: boolean; readAt: string | null} {
    const existing = selectByIdStmt.get(id) as unknown as {id: string; read_at: string | null} | undefined
    if (existing === undefined) return {acked: false, readAt: null}
    if (existing.read_at !== null) return {acked: true, readAt: existing.read_at}
    const readAt = new Date().toISOString()
    ackStmt.run(readAt, id)
    return {acked: true, readAt}
  }

  function ackAll(): number {
    const result = ackAllStmt.run(new Date().toISOString())
    return Number(result.changes)
  }

  function prune(): void {
    const totalRow = pruneCountStmt.get() as unknown as {n: number}
    if (totalRow.n > RETENTION_MAX_ROWS) {
      pruneOverflowStmt.run(RETENTION_MAX_ROWS)
    }
    const cutoff = new Date(Date.now() - RETENTION_MAX_AGE_MS).toISOString()
    pruneAgeStmt.run(cutoff)
  }

  function close(): void {
    db.close()
  }

  return {insert, list, ack, ackAll, prune, close}
}
