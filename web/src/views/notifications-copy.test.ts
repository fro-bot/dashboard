/**
 * Tests for the push notifications copy mapping.
 *
 * Security invariants:
 * - Copy must never include raw endpoints, tokens, cookies, CSRF values, or status codes.
 * - Copy must be fixed/coarse — no dynamic interpolation of sensitive values.
 */

import {describe, expect, it} from 'vitest'
import {getNotificationCopy, type NotificationUiState} from './notifications-copy.ts'

const ALL_STATES: NotificationUiState[] = [
  'not-requested',
  'subscribed',
  'denied',
  'dismissed',
  'unsupported',
  'ios-not-installed',
  'sw-not-ready',
  'subscribe-failed',
]

describe('getNotificationCopy completeness', () => {
  for (const state of ALL_STATES) {
    it(`returns non-empty headline and detail for ${state}`, () => {
      const copy = getNotificationCopy(state)
      expect(typeof copy.headline).toBe('string')
      expect(copy.headline.length).toBeGreaterThan(0)
      expect(typeof copy.detail).toBe('string')
      expect(copy.detail.length).toBeGreaterThan(0)
      expect(typeof copy.recoveryHint).toBe('string')
    })
  }
})

describe('getNotificationCopy distinctness', () => {
  it('has distinct headlines for all error/disabled states', () => {
    const headlines = ALL_STATES.map(s => getNotificationCopy(s).headline)
    const uniqueHeadlines = new Set(headlines)
    expect(uniqueHeadlines.size).toBe(ALL_STATES.length)
  })
})

describe('copy security checks', () => {
  const sensitivePatterns = [
    /\b4\d\d\b/,        // raw HTTP status codes (4xx)
    /\b5\d\d\b/,        // raw HTTP status codes (5xx)
    /\bstatus\s*[:=]\s*\d/i, // "status: 401" style
    /\bhttp\b/i,        // raw "HTTP" protocol mention
    /\/operator\//,     // raw API paths
    /\bcsrf\b/i,        // CSRF token mention
    /\btoken\b/i,       // token mention
    /\bcookie\b/i,      // cookie mention
    /\bstack\b/i,       // stack trace mention
    /\bpayload\b/i,     // payload mention
    /\bendpoint\b/i,    // endpoint
    /\bp256dh\b/i,      // p256dh key material
    /\bauth\b/i,        // auth key material/credential
  ]

  for (const state of ALL_STATES) {
    const copy = getNotificationCopy(state)

    for (const pattern of sensitivePatterns) {
      it(`state "${state}" headline does not match sensitive pattern ${pattern}`, () => {
        expect(copy.headline).not.toMatch(pattern)
      })

      it(`state "${state}" detail does not match sensitive pattern ${pattern}`, () => {
        expect(copy.detail).not.toMatch(pattern)
      })

      it(`state "${state}" recoveryHint does not match sensitive pattern ${pattern}`, () => {
        expect(copy.recoveryHint).not.toMatch(pattern)
      })

      if (copy.ctaText !== null) {
        it(`state "${state}" ctaText does not match sensitive pattern ${pattern}`, () => {
          expect(copy.ctaText).not.toMatch(pattern)
        })
      }
    }
  }
})
