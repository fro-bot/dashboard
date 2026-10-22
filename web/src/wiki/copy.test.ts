import {describe, expect, it} from 'vitest'
import {
  blockReasonCopy,
  canWriteReasonCopy,
  CORRECTION_STATUS_LABEL,
  isRetryable,
  PAGE_TYPE_LABEL,
  readFailureCopy,
  type ReadFailureCopyKey,
} from './copy.ts'

const READ_KEYS: readonly ReadFailureCopyKey[] = [
  'not-found',
  'page-invalid',
  'corrections-corrupt',
  'unavailable',
  'forbidden',
  'session-lost',
  'network',
  'timeout',
  'rate-limited',
  'contract-drift',
]

const BLOCK_REASONS = [
  'private-page',
  'private-repo-name',
  'promotion-diff',
  'privacy-check',
  'merge',
  'open-pr',
  'unknown',
] as const

describe('wiki copy', () => {
  it.each(READ_KEYS)('has a headline and a detail for the %s read failure', key => {
    const copy = readFailureCopy(key)
    expect(copy.headline.length).toBeGreaterThan(0)
    expect(copy.detail.length).toBeGreaterThan(0)
  })

  it.each(BLOCK_REASONS)('maps the %s block reason to one plain sentence', reason => {
    const sentence = blockReasonCopy(reason)
    expect(sentence).toMatch(/\.$/u)
    // The wire code is a kebab-case token; the sentence must not show it.
    if (reason.includes('-')) expect(sentence).not.toContain(reason)
  })

  it('gives every block reason its own sentence, except none shared by accident', () => {
    const sentences = new Set(BLOCK_REASONS.map(blockReasonCopy))
    expect(sentences.size).toBe(BLOCK_REASONS.length)
  })

  it('falls back to the unknown-reason sentence for a code it does not know, and does not echo the code', () => {
    // @ts-expect-error: a code from a newer server
    const sentence = blockReasonCopy('brand-new-reason')
    expect(sentence).toBe(blockReasonCopy('unknown'))
    expect(sentence).not.toContain('brand-new-reason')
  })

  it.each(['not-operator', 'session-not-supported', 'app-credentials-absent', 'app-credentials-incomplete', 'operator-id-unset'])(
    'maps the %s write reason to a sentence that does not echo the code',
    code => {
      const sentence = canWriteReasonCopy(code)
      expect(sentence).toMatch(/read-only\.$/u)
      expect(sentence).not.toContain(code)
    },
  )

  it('falls back to a generic read-only sentence for an unknown or missing write reason', () => {
    expect(canWriteReasonCopy('something-new')).toMatch(/read-only\.$/u)
    expect(canWriteReasonCopy('something-new')).not.toContain('something-new')
    expect(canWriteReasonCopy(null)).toMatch(/read-only\.$/u)
    expect(canWriteReasonCopy('__proto__')).toMatch(/read-only\.$/u)
  })

  it('offers a retry for transient failures only', () => {
    expect(isRetryable('network')).toBe(true)
    expect(isRetryable('timeout')).toBe(true)
    expect(isRetryable('unavailable')).toBe(true)
    expect(isRetryable('rate-limited')).toBe(true)
    expect(isRetryable('contract-drift')).toBe(true)
    expect(isRetryable('forbidden')).toBe(false)
    expect(isRetryable('not-found')).toBe(false)
    expect(isRetryable('session-lost')).toBe(false)
  })

  it('labels every page type and correction status', () => {
    expect(Object.keys(PAGE_TYPE_LABEL).sort()).toEqual(['comparisons', 'entities', 'repos', 'topics'])
    expect(Object.keys(CORRECTION_STATUS_LABEL).sort()).toEqual(['active', 'needs-reconfirmation', 'retired', 'superseded'])
  })
})
