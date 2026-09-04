import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {selectOperationIdsToPrune, type RetentionOperationRecord} from './retention.ts'

export type OperationState = 'pending' | 'succeeded' | 'failed' | 'indeterminate'

export interface OperationIntent {
  readonly operationId: string
  readonly repository: string
  readonly ref: string
  readonly path: string
  readonly expectedParentSha: string
  readonly contentDigest: string
  readonly createdAt: number
}

export interface OperationRecord extends OperationIntent {
  readonly state: OperationState
  readonly commitSha: string | null
  readonly updatedAt: number
}

export type OperationCompletion =
  | {readonly state: 'pending' | 'failed' | 'indeterminate'; readonly updatedAt: number}
  | {readonly state: 'succeeded'; readonly commitSha: string; readonly updatedAt: number}

export interface OperationLedger {
  readonly begin: (intent: OperationIntent) => void
  readonly complete: (operationId: string, completion: OperationCompletion) => void
  readonly get: (operationId: string) => OperationRecord | undefined
  readonly list: () => OperationRecord[]
  readonly listIndeterminate: () => OperationRecord[]
  readonly prune: (now: number) => void
  readonly close: () => void
}

interface OperationRow {
  operation_id: string
  repository: string
  ref: string
  path: string
  expected_parent_sha: string
  content_digest: string
  state: OperationState
  created_at: number
  updated_at: number
  commit_sha: string | null
}

const OPERATION_STATES = new Set<OperationState>(['pending', 'succeeded', 'failed', 'indeterminate'])

export class OperationRowValidationError extends Error {
  constructor(operationId: unknown, reason: string) {
    const id = typeof operationId === 'string' && operationId.length > 0 ? operationId : '<unreadable>'
    super(`Ledger row for operation ${id} failed validation: ${reason}`)
    this.name = 'OperationRowValidationError'
  }
}

function isOperationRow(value: unknown): value is OperationRow {
  if (value === null || typeof value !== 'object') {
    throw new OperationRowValidationError(undefined, 'row is not an object')
  }
  const row = value as Record<string, unknown>
  const operationId = row.operation_id

  if (typeof row.operation_id !== 'string' || row.operation_id.length === 0) {
    throw new OperationRowValidationError(operationId, 'operation_id is not a non-empty string')
  }
  if (typeof row.repository !== 'string' || row.repository.length === 0) {
    throw new OperationRowValidationError(operationId, 'repository is not a non-empty string')
  }
  if (typeof row.ref !== 'string' || row.ref.length === 0) {
    throw new OperationRowValidationError(operationId, 'ref is not a non-empty string')
  }
  if (typeof row.path !== 'string' || row.path.length === 0) {
    throw new OperationRowValidationError(operationId, 'path is not a non-empty string')
  }
  if (typeof row.expected_parent_sha !== 'string' || row.expected_parent_sha.length === 0) {
    throw new OperationRowValidationError(operationId, 'expected_parent_sha is not a non-empty string')
  }
  if (typeof row.content_digest !== 'string' || row.content_digest.length === 0) {
    throw new OperationRowValidationError(operationId, 'content_digest is not a non-empty string')
  }
  if (typeof row.state !== 'string' || !OPERATION_STATES.has(row.state as OperationState)) {
    throw new OperationRowValidationError(operationId, `state is not one of the permitted lifecycle values (got ${JSON.stringify(row.state)})`)
  }
  if (typeof row.created_at !== 'number' || !Number.isFinite(row.created_at)) {
    throw new OperationRowValidationError(operationId, 'created_at is not a finite number')
  }
  if (typeof row.updated_at !== 'number' || !Number.isFinite(row.updated_at)) {
    throw new OperationRowValidationError(operationId, 'updated_at is not a finite number')
  }
  if (row.commit_sha !== null && typeof row.commit_sha !== 'string') {
    throw new OperationRowValidationError(operationId, 'commit_sha is neither null nor a string')
  }

  return true
}

function toOperationRow(value: unknown): OperationRow {
  if (!isOperationRow(value)) throw new OperationRowValidationError(undefined, 'row failed validation')
  return value
}

export function createOperationLedger(dbPath: string): OperationLedger {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), {recursive: true})

  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_write_operations (
      operation_id TEXT PRIMARY KEY,
      repository TEXT NOT NULL,
      ref TEXT NOT NULL,
      path TEXT NOT NULL,
      expected_parent_sha TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      commit_sha TEXT NULL
    )
  `)

  const insert = db.prepare(`
    INSERT INTO wiki_write_operations
      (operation_id, repository, ref, path, expected_parent_sha, content_digest, state, created_at, updated_at, commit_sha)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
  `)
  const update = db.prepare('UPDATE wiki_write_operations SET state = ?, updated_at = ?, commit_sha = ? WHERE operation_id = ?')
  const select = db.prepare('SELECT * FROM wiki_write_operations WHERE operation_id = ?')
  const selectAll = db.prepare('SELECT * FROM wiki_write_operations ORDER BY created_at ASC')
  const selectIndeterminate = db.prepare("SELECT * FROM wiki_write_operations WHERE state = 'indeterminate' ORDER BY created_at ASC")

  function begin(intent: OperationIntent): void {
    try {
      insert.run(
        intent.operationId,
        intent.repository,
        intent.ref,
        intent.path,
        intent.expectedParentSha,
        intent.contentDigest,
        intent.createdAt,
        intent.createdAt,
      )
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) throw new Error('operation intent already exists')
      throw error
    }
  }

  function complete(operationId: string, completion: OperationCompletion): void {
    const commitSha = completion.state === 'succeeded' ? completion.commitSha : null
    const result = update.run(completion.state, completion.updatedAt, commitSha, operationId)
    if (Number(result.changes) !== 1) throw new Error('operation intent was not found')
  }

  function get(operationId: string): OperationRecord | undefined {
    const row = select.get(operationId)
    return row === undefined ? undefined : rowToRecord(toOperationRow(row))
  }

  function list(): OperationRecord[] {
    return selectAll.all().map(row => rowToRecord(toOperationRow(row)))
  }

  function listIndeterminate(): OperationRecord[] {
    return selectIndeterminate.all().map(row => rowToRecord(toOperationRow(row)))
  }

  function prune(now: number): void {
    const records = list()
    const ids = selectOperationIdsToPrune(records satisfies readonly RetentionOperationRecord[], now)
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(', ')
    db.prepare(`DELETE FROM wiki_write_operations WHERE operation_id IN (${placeholders})`).run(...ids)
  }

  function close(): void {
    db.close()
  }

  return {begin, complete, get, list, listIndeterminate, prune, close}
}

function rowToRecord(row: OperationRow): OperationRecord {
  return {
    operationId: row.operation_id,
    repository: row.repository,
    ref: row.ref,
    path: row.path,
    expectedParentSha: row.expected_parent_sha,
    contentDigest: row.content_digest,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    commitSha: row.commit_sha,
  }
}
