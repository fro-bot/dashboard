import {afterEach, describe, expect, it} from 'vitest'
import {createOperationLedger, type OperationIntent} from '../src/operation-ledger.ts'

const intent: OperationIntent = {
  operationId: '11111111-1111-4111-8111-111111111111',
  repository: 'fro-bot/.github',
  ref: 'data',
  path: 'knowledge/wiki/topics/example.md',
  expectedParentSha: 'parent-1',
  contentDigest: 'digest-1',
  createdAt: 1_700_000_000_000,
}

describe('operation ledger', () => {
  const ledgers: ReturnType<typeof createOperationLedger>[] = []

  afterEach(() => {
    for (const ledger of ledgers.splice(0)) ledger.close()
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
})
