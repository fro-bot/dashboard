export const OPERATION_MAX_ROWS = 500
export const OPERATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export type RetentionOperationState = 'pending' | 'succeeded' | 'failed' | 'indeterminate'

export interface RetentionOperationRecord {
  readonly operationId: string
  readonly state: RetentionOperationState
  readonly createdAt: number
}

/**
 * Select only resolved records for deletion. Pending and indeterminate records
 * are deliberately retained until an explicit resolution path handles them.
 */
export function selectOperationIdsToPrune(records: readonly RetentionOperationRecord[], now: number): string[] {
  const resolved = records
    .filter(record => record.state === 'succeeded' || record.state === 'failed')
    .sort((left, right) => left.createdAt - right.createdAt)
  const ids = new Set<string>()

  for (const record of resolved) {
    if (now - record.createdAt > OPERATION_MAX_AGE_MS) ids.add(record.operationId)
  }

  const remainingResolved = resolved.filter(record => !ids.has(record.operationId))
  const overflow = Math.max(0, records.length - OPERATION_MAX_ROWS)
  for (const record of [...remainingResolved, ...resolved.filter(record => ids.has(record.operationId))]) {
    if (ids.size >= overflow) break
    ids.add(record.operationId)
  }

  return [...ids]
}
