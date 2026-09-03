import {describe, expect, it} from 'vitest'
import {OPERATION_MAX_AGE_MS, OPERATION_MAX_ROWS, selectOperationIdsToPrune} from '../src/retention.ts'

describe('operation retention', () => {
  it('does not delete unresolved indeterminate records when age and count bounds are exceeded', () => {
    const now = 2_000_000_000_000
    const records = [
      {operationId: 'indeterminate', state: 'indeterminate' as const, createdAt: now - OPERATION_MAX_AGE_MS - 1},
      ...Array.from({length: OPERATION_MAX_ROWS + 1}, (_, index) => ({
        operationId: `succeeded-${index}`,
        state: 'succeeded' as const,
        createdAt: now - index,
      })),
    ]

    const pruned = selectOperationIdsToPrune(records, now)

    expect(pruned).not.toContain('indeterminate')
    expect(pruned).toContain('succeeded-500')
  })
})
