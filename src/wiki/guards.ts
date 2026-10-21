/** Small shared type guards for the wiki modules. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The numeric HTTP status an error carries, or null. */
export function statusOf(error: unknown): number | null {
  const status = typeof error === 'object' && error !== null ? (error as {status?: unknown}).status : undefined
  return typeof status === 'number' ? status : null
}
