/**
 * Shared relative-time helpers for the operator browser modules.
 * Pure: no DOM, no I/O, no module state.
 */

/** Longest timestamp string accepted, here and by the run index for `createdAt` and `updatedAt`. */
export const MAX_TIMESTAMP_LENGTH = 128

/** The `data-time-source` value that marks a launch-seeded <time> until the run list adopts it. */
export const LAUNCH_TIME_SOURCE = 'launch'

/**
 * Format an ISO timestamp as a coarse relative time string.
 * Returns 'just now', 'N minute(s) ago', 'N hour(s) ago', or 'N day(s) ago'.
 */
export function formatRelativeTime(isoString, nowMs = Date.now()) {
  if (!isoString) return ''
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''

  const diff = Math.max(0, nowMs - date.getTime())
  if (diff < 60_000) return 'just now'

  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`

  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * The canonical ISO string for a timestamp, or undefined when `value` is not a string, is empty
 * after trimming, is longer than 128 characters, or does not parse to a finite time.
 */
export function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_TIMESTAMP_LENGTH) return undefined
  const time = Date.parse(trimmed)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}
