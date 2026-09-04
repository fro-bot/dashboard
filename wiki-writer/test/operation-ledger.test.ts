import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, describe, expect, it} from 'vitest'
import {createOperationLedger, OperationRowValidationError, type OperationIntent} from '../src/operation-ledger.ts'

const intent: OperationIntent = {
  operationId: '11111111-1111-4111-8111-111111111111',
  repository: 'fro-bot/.github',
  ref: 'data',
  path: 'knowledge/wiki/topics/example.md',
  expectedParentSha: 'parent-1',
  contentDigest: 'digest-1',
  createdAt: 1_700_000_000_000,
}

async function createFileBackedLedger(temporaryDirectories: string[], ledgers: ReturnType<typeof createOperationLedger>[]) {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-writer-ledger-'))
  temporaryDirectories.push(directory)
  const dbPath = join(directory, 'ledger.sqlite')
  const ledger = createOperationLedger(dbPath)
  ledgers.push(ledger)
  return {ledger, dbPath}
}

type RawColumnValue = string | number | null

interface RawRowOverrides {
  operation_id?: RawColumnValue
  repository?: RawColumnValue
  ref?: RawColumnValue
  path?: RawColumnValue
  expected_parent_sha?: RawColumnValue
  content_digest?: RawColumnValue
  state?: RawColumnValue
  created_at?: RawColumnValue
  updated_at?: RawColumnValue
  commit_sha?: RawColumnValue
}

function writeRawRow(dbPath: string, overrides: RawRowOverrides): void {
  const raw = new DatabaseSync(dbPath)
  try {
    const base = {
      operation_id: intent.operationId,
      repository: intent.repository,
      ref: intent.ref,
      path: intent.path,
      expected_parent_sha: intent.expectedParentSha,
      content_digest: intent.contentDigest,
      state: 'pending',
      created_at: intent.createdAt,
      updated_at: intent.createdAt,
      commit_sha: null as RawColumnValue,
      ...overrides,
    }
    raw.exec(`DELETE FROM wiki_write_operations WHERE operation_id = '${String(base.operation_id)}'`)
    raw
      .prepare(
        `INSERT INTO wiki_write_operations
          (operation_id, repository, ref, path, expected_parent_sha, content_digest, state, created_at, updated_at, commit_sha)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        base.operation_id,
        base.repository,
        base.ref,
        base.path,
        base.expected_parent_sha,
        base.content_digest,
        base.state,
        base.created_at,
        base.updated_at,
        base.commit_sha,
      )
  } finally {
    raw.close()
  }
}

function insertRawRow(dbPath: string, values: readonly RawColumnValue[]): void {
  const raw = new DatabaseSync(dbPath)
  try {
    raw
      .prepare(
        `INSERT INTO wiki_write_operations
          (operation_id, repository, ref, path, expected_parent_sha, content_digest, state, created_at, updated_at, commit_sha)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...values)
  } finally {
    raw.close()
  }
}

describe('operation ledger', () => {
  const ledgers: ReturnType<typeof createOperationLedger>[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    for (const ledger of ledgers.splice(0)) ledger.close()
    await Promise.all(temporaryDirectories.splice(0).map(async directory => rm(directory, {recursive: true, force: true})))
  })

  it('persists an intent and its terminal outcome', () => {
    const ledger = createOperationLedger(':memory:')
    ledgers.push(ledger)

    ledger.begin(intent)
    ledger.complete(intent.operationId, {state: 'succeeded', commitSha: 'commit-1', updatedAt: 1_700_000_000_001})

    expect(ledger.get(intent.operationId)).toEqual({
      ...intent,
      state: 'succeeded',
      commitSha: 'commit-1',
      updatedAt: 1_700_000_000_001,
    })
  })

  it('rejects duplicate operation intents without creating a second record', () => {
    const ledger = createOperationLedger(':memory:')
    ledgers.push(ledger)

    ledger.begin(intent)

    expect(() => ledger.begin(intent)).toThrow('already exists')
    expect(ledger.list()).toHaveLength(1)
  })

  it('stores indeterminate outcomes with their resolution state available', () => {
    const ledger = createOperationLedger(':memory:')
    ledgers.push(ledger)

    ledger.begin(intent)
    ledger.complete(intent.operationId, {state: 'indeterminate', updatedAt: 1_700_000_000_002})

    expect(ledger.listIndeterminate()).toEqual([{...intent, state: 'indeterminate', commitSha: null, updatedAt: 1_700_000_000_002}])
  })

  describe('row validation', () => {
    it('narrows a well-formed row and returns the expected record', async () => {
      const {ledger, dbPath} = await createFileBackedLedger(temporaryDirectories, ledgers)
      writeRawRow(dbPath, {state: 'succeeded', commit_sha: 'commit-1'})

      expect(ledger.get(intent.operationId)).toEqual({
        ...intent,
        state: 'succeeded',
        commitSha: 'commit-1',
        updatedAt: intent.createdAt,
      })
    })

    it('throws naming the operation ID when state is outside the permitted set', async () => {
      const {ledger, dbPath} = await createFileBackedLedger(temporaryDirectories, ledgers)
      writeRawRow(dbPath, {state: 'archived'})

      expect(() => ledger.get(intent.operationId)).toThrow(OperationRowValidationError)
      expect(() => ledger.get(intent.operationId)).toThrow(intent.operationId)
    })

    it('throws when a field has the wrong type', async () => {
      const {ledger, dbPath} = await createFileBackedLedger(temporaryDirectories, ledgers)
      writeRawRow(dbPath, {created_at: 'not-a-number'})

      expect(() => ledger.get(intent.operationId)).toThrow(OperationRowValidationError)
    })

    it('list() validates every row, not just the first', async () => {
      const {ledger, dbPath} = await createFileBackedLedger(temporaryDirectories, ledgers)
      writeRawRow(dbPath, {operation_id: '22222222-2222-4222-8222-222222222222', created_at: intent.createdAt})
      insertRawRow(dbPath, [
        '33333333-3333-4333-8333-333333333333',
        intent.repository,
        intent.ref,
        intent.path,
        intent.expectedParentSha,
        intent.contentDigest,
        'not-a-real-state',
        intent.createdAt + 1,
        intent.createdAt + 1,
        null,
      ])

      expect(() => ledger.list()).toThrow(OperationRowValidationError)
      expect(() => ledger.list()).toThrow('33333333-3333-4333-8333-333333333333')
    })

    it('listIndeterminate() validates every row, not just the first', async () => {
      const {ledger, dbPath} = await createFileBackedLedger(temporaryDirectories, ledgers)
      writeRawRow(dbPath, {operation_id: '44444444-4444-4444-8444-444444444444', state: 'indeterminate'})
      insertRawRow(dbPath, [
        '55555555-5555-4555-8555-555555555555',
        intent.repository,
        intent.ref,
        intent.path,
        intent.expectedParentSha,
        intent.contentDigest,
        'indeterminate',
        'not-a-number',
        intent.createdAt + 1,
        null,
      ])

      expect(() => ledger.listIndeterminate()).toThrow(OperationRowValidationError)
      expect(() => ledger.listIndeterminate()).toThrow('55555555-5555-4555-8555-555555555555')
    })
  })
})
