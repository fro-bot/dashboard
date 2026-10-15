/**
 * Tests for the shared time helpers in public/operator-time.js: the relative-time formatter, the ISO
 * timestamp normalizer, and the constants other modules share (timestamp cap, launch time marker).
 */
import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import * as runIndex from '../public/operator-run-index.js'
import {formatRelativeTime, LAUNCH_TIME_SOURCE, MAX_TIMESTAMP_LENGTH, normalizeIsoTimestamp} from '../public/operator-time.js'

const NOW = Date.parse('2026-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const ago = ms => new Date(NOW - ms).toISOString()

describe('formatRelativeTime', () => {
  it('says "just now" under a minute, and flips to minutes at 60s', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('just now')
    expect(formatRelativeTime(ago(59 * SECOND), NOW)).toBe('just now')
    expect(formatRelativeTime(ago(60 * SECOND), NOW)).toBe('1 minute ago')
  })

  it('flips from minutes to hours at 60m, with plurals', () => {
    expect(formatRelativeTime(ago(2 * MINUTE), NOW)).toBe('2 minutes ago')
    expect(formatRelativeTime(ago(59 * MINUTE + 59 * SECOND), NOW)).toBe('59 minutes ago')
    expect(formatRelativeTime(ago(60 * MINUTE), NOW)).toBe('1 hour ago')
  })

  it('flips from hours to days at 24h, with plurals', () => {
    expect(formatRelativeTime(ago(2 * HOUR), NOW)).toBe('2 hours ago')
    expect(formatRelativeTime(ago(23 * HOUR + 59 * MINUTE), NOW)).toBe('23 hours ago')
    expect(formatRelativeTime(ago(24 * HOUR), NOW)).toBe('1 day ago')
    expect(formatRelativeTime(ago(3 * DAY), NOW)).toBe('3 days ago')
  })

  it('clamps a future timestamp to "just now"', () => {
    expect(formatRelativeTime(new Date(NOW + 5 * MINUTE).toISOString(), NOW)).toBe('just now')
    expect(formatRelativeTime(new Date(NOW + 400 * DAY).toISOString(), NOW)).toBe('just now')
  })

  it('returns an empty string for an absent or unparseable value', () => {
    for (const value of [undefined, null, '', 'not a date']) {
      expect(formatRelativeTime(value, NOW), String(value)).toBe('')
    }
  })

  it('defaults to the current time when no clock is given', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('just now')
    expect(formatRelativeTime(new Date(Date.now() - 2 * HOUR).toISOString())).toBe('2 hours ago')
  })

  it('is the same function the run index exports, so existing importers are unchanged', () => {
    expect(runIndex.formatRelativeTime).toBe(formatRelativeTime)
  })
})

describe('normalizeIsoTimestamp', () => {
  it('returns the canonical ISO form of a valid timestamp', () => {
    expect(normalizeIsoTimestamp('2026-06-15T12:00:00Z')).toBe('2026-06-15T12:00:00.000Z')
    expect(normalizeIsoTimestamp('2026-06-15T12:00:00.123Z')).toBe('2026-06-15T12:00:00.123Z')
    expect(normalizeIsoTimestamp('2026-06-15T14:00:00+02:00')).toBe('2026-06-15T12:00:00.000Z')
  })

  it('is idempotent on its own output', () => {
    const once = normalizeIsoTimestamp('2026-06-15T12:00:00Z')
    expect(normalizeIsoTimestamp(once)).toBe(once)
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(normalizeIsoTimestamp('  2026-06-15T12:00:00Z \n')).toBe('2026-06-15T12:00:00.000Z')
  })

  it('returns nothing for an empty, whitespace-only or garbage string', () => {
    for (const value of ['', '   ', 'garbage', '2026-13-45T99:99:99Z', 'NaN']) {
      expect(normalizeIsoTimestamp(value), JSON.stringify(value)).toBeUndefined()
    }
  })

  it('returns nothing for a non-string value', () => {
    for (const value of [undefined, null, 0, 1_781_524_800_000, true, {}, [], ['2026-06-15T12:00:00Z']]) {
      expect(normalizeIsoTimestamp(value), String(value)).toBeUndefined()
    }
  })

  it('caps the length at 128 characters, after trimming', () => {
    const base = 'Mon, 15 Jun 2026 12:00:00 GMT'
    const withinCap = `${base} (${'x'.repeat(128 - base.length - 3)})`
    const overCap = `${base} (${'x'.repeat(128 - base.length - 2)})`
    expect(withinCap).toHaveLength(128)
    expect(overCap).toHaveLength(129)
    // Both parse, so only the cap separates them.
    expect(Number.isFinite(Date.parse(withinCap))).toBe(true)
    expect(Number.isFinite(Date.parse(overCap))).toBe(true)

    expect(normalizeIsoTimestamp(withinCap)).toBe('2026-06-15T12:00:00.000Z')
    expect(normalizeIsoTimestamp(overCap)).toBeUndefined()
    expect(normalizeIsoTimestamp(`${' '.repeat(50)}2026-06-15T12:00:00Z${' '.repeat(50)}`)).toBe('2026-06-15T12:00:00.000Z')
  })

  it('returns nothing for a 129-character string of any kind', () => {
    expect(normalizeIsoTimestamp('2'.repeat(129))).toBeUndefined()
    expect(normalizeIsoTimestamp(`2026-06-15T12:00:00Z${'0'.repeat(109)}`)).toBeUndefined()
  })

  it('accepts only what formatRelativeTime can then render', () => {
    const normalized = normalizeIsoTimestamp('2026-06-15T11:00:00Z')
    expect(formatRelativeTime(normalized, NOW)).toBe('1 hour ago')
  })
})

describe('shared constants', () => {
  const source = file => readFileSync(file, 'utf8')

  it('exports the 128-character timestamp cap the normalizer enforces', () => {
    expect(MAX_TIMESTAMP_LENGTH).toBe(128)
    const base = 'Mon, 15 Jun 2026 12:00:00 GMT'
    const padded = length => `${base} (${'x'.repeat(length - base.length - 3)})`
    expect(normalizeIsoTimestamp(padded(MAX_TIMESTAMP_LENGTH))).toBe('2026-06-15T12:00:00.000Z')
    expect(normalizeIsoTimestamp(padded(MAX_TIMESTAMP_LENGTH + 1))).toBeUndefined()
  })

  it('the run index caps createdAt and updatedAt with that same exported constant', () => {
    const src = source('public/operator-run-index.js')
    expect(src).toMatch(/import \{[^}]*MAX_TIMESTAMP_LENGTH[^}]*\} from '\.\/operator-time\.js'/)
    expect(src).not.toContain('MAX_DATE_LENGTH')
    expect(src).not.toMatch(/=\s*128\b/)
  })

  it('the run index accepts a 128-character timestamp and rejects 129', () => {
    const base = {runId: 'run-cap-001', repo: 'fro-bot/agent', status: 'running'}
    const at = length => `2026-06-15T12:00:00Z${' '.repeat(length - 20)}`
    expect(runIndex.parseRunSummaryItem({...base, createdAt: at(MAX_TIMESTAMP_LENGTH)}).success).toBe(true)
    expect(runIndex.parseRunSummaryItem({...base, createdAt: at(MAX_TIMESTAMP_LENGTH + 1)}).success).toBe(false)
  })

  it('the launch time marker is "launch"', () => {
    expect(LAUNCH_TIME_SOURCE).toBe('launch')
  })

  it('the launch builder and the run index use the exported marker, not their own literal', () => {
    for (const file of ['public/operator-launch.js', 'public/operator-run-index.js']) {
      const src = source(file)
      expect(src, file).toMatch(/import \{[^}]*LAUNCH_TIME_SOURCE[^}]*\} from '\.\/operator-time\.js'/)
      expect(src, file).not.toMatch(/timeSource\s*(?:=|!==|===)\s*'launch'/)
    }
  })

  it('the runtime seam selects the same marker value (it cannot import the public module)', () => {
    expect(source('web/src/operator/runtime.ts')).toContain(`[data-role="run-updated-at"][data-time-source="${LAUNCH_TIME_SOURCE}"]`)
  })
})
