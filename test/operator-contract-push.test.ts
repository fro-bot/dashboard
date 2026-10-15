import {describe, expect, it} from 'vitest'
import {parsePushSubscriptionListResponse} from '../src/gateway/operator-contract/index.ts'

const HASH = 'a'.repeat(64)

function wireRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpointHash: HASH,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_100_000,
    keyVersion: 'v1',
    active: true,
    ...overrides,
  }
}

describe('parsePushSubscriptionListResponse', () => {
  it('parses the gateway list shape with numeric timestamps', () => {
    const result = parsePushSubscriptionListResponse({subscriptions: [wireRecord()]})

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.subscriptions).toEqual([wireRecord()])
  })

  it('accepts an empty list', () => {
    const result = parsePushSubscriptionListResponse({subscriptions: []})

    expect(result.success && result.data.subscriptions).toEqual([])
  })

  it.each([
    ['a flat single record', wireRecord()],
    ['null', null],
    ['an array', []],
    ['a non-array subscriptions field', {subscriptions: 'x'}],
  ])('rejects %s', (_label, input) => {
    expect(parsePushSubscriptionListResponse(input).success).toBe(false)
  })

  it.each([
    ['string createdAt', {createdAt: '2026-07-08T00:00:00.000Z'}],
    ['string updatedAt', {updatedAt: '1'}],
    ['negative timestamp', {createdAt: -1}],
    ['NaN timestamp', {updatedAt: Number.NaN}],
    ['non-boolean active', {active: 1}],
    ['short endpoint hash', {endpointHash: 'abc'}],
    ['missing keyVersion', {keyVersion: undefined}],
  ])('drops an entry with %s', (_label, overrides) => {
    const valid = wireRecord({endpointHash: 'b'.repeat(64)})
    const result = parsePushSubscriptionListResponse({subscriptions: [wireRecord(overrides), valid]})

    expect(result.success && result.data.subscriptions).toEqual([valid])
  })

  it.each(['unsubscribed', 'dead', 'revoked', 'session-revoked'])('keeps inactiveReason %s', reason => {
    const record = wireRecord({active: false, inactiveReason: reason})
    const result = parsePushSubscriptionListResponse({subscriptions: [record]})

    expect(result.success && result.data.subscriptions).toEqual([record])
  })

  it('omits an unknown inactiveReason but keeps the entry', () => {
    const result = parsePushSubscriptionListResponse({
      subscriptions: [wireRecord({active: false, inactiveReason: 'bogus'})],
    })

    expect(result.success && result.data.subscriptions).toEqual([wireRecord({active: false})])
  })

  it('copies only declared fields', () => {
    const result = parsePushSubscriptionListResponse({subscriptions: [wireRecord({endpoint: 'https://leak', extra: 1})]})

    expect(result.success && result.data.subscriptions).toEqual([wireRecord()])
  })
})
