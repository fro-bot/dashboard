import {describe, expect, it} from 'vitest'
import type {PushSubscriptionMetadata} from './push-types.ts'
import {derivePushHandoffState, reconcile} from './reconcile.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function metadata(overrides: Partial<PushSubscriptionMetadata> = {}): PushSubscriptionMetadata {
  return {
    endpointHash: HASH_A,
    keyVersion: 'v1',
    active: true,
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:00:00.000Z',
    ...overrides,
  }
}

describe('derivePushHandoffState', () => {
  it('pushDisabled always wins -> push_disabled', () => {
    expect(derivePushHandoffState(HASH_A, 'v1', {pushDisabled: true, metadata: metadata()})).toBe('push_disabled')
    expect(derivePushHandoffState(undefined, undefined, {pushDisabled: true, metadata: undefined})).toBe(
      'push_disabled',
    )
  })

  it('no metadata -> not_subscribed', () => {
    expect(derivePushHandoffState(HASH_A, 'v1', {pushDisabled: false, metadata: undefined})).toBe('not_subscribed')
  })

  it('matching active record with current key -> subscribed', () => {
    expect(derivePushHandoffState(HASH_A, 'v1', {pushDisabled: false, metadata: metadata()})).toBe('subscribed')
  })

  it('matching active record with older key -> stale_key', () => {
    expect(
      derivePushHandoffState(HASH_A, 'v2', {pushDisabled: false, metadata: metadata({keyVersion: 'v1'})}),
    ).toBe('stale_key')
  })

  it('matching inactive record -> inactive', () => {
    expect(
      derivePushHandoffState(HASH_A, 'v1', {pushDisabled: false, metadata: metadata({active: false})}),
    ).toBe('inactive')
  })

  it('endpoint hash mismatch (different device/subscription) -> not_subscribed, never subscribed', () => {
    expect(
      derivePushHandoffState(HASH_B, 'v1', {pushDisabled: false, metadata: metadata({endpointHash: HASH_A})}),
    ).toBe('not_subscribed')
  })

  it('local endpoint hash unavailable -> conservative not_subscribed, never a false subscribed', () => {
    expect(derivePushHandoffState(undefined, 'v1', {pushDisabled: false, metadata: metadata()})).toBe(
      'not_subscribed',
    )
  })

  it('currentKeyVersion unavailable but record matches -> subscribed (no key comparison possible)', () => {
    expect(derivePushHandoffState(HASH_A, undefined, {pushDisabled: false, metadata: metadata()})).toBe('subscribed')
  })
})

describe('reconcile — drift matrix', () => {
  it('push_disabled + local present -> cleanup, unsupported', () => {
    expect(reconcile('granted', true, 'push_disabled')).toEqual({uiState: 'unsupported', action: 'cleanup'})
  })

  it('push_disabled + no local -> none, unsupported', () => {
    expect(reconcile('default', false, 'push_disabled')).toEqual({uiState: 'unsupported', action: 'none'})
  })

  it('default + none + not_subscribed -> not-requested, none (show enable CTA)', () => {
    expect(reconcile('default', false, 'not_subscribed')).toEqual({uiState: 'not-requested', action: 'none'})
  })

  it('granted + none + not_subscribed -> offer register', () => {
    expect(reconcile('granted', false, 'not_subscribed')).toEqual({uiState: 'not-requested', action: 'register'})
  })

  it('granted + none + inactive -> offer register', () => {
    expect(reconcile('granted', false, 'inactive')).toEqual({uiState: 'not-requested', action: 'register'})
  })

  it('granted + present + subscribed -> steady state', () => {
    expect(reconcile('granted', true, 'subscribed')).toEqual({uiState: 'subscribed', action: 'none'})
  })

  it('granted + present + stale_key -> resubscribe', () => {
    expect(reconcile('granted', true, 'stale_key')).toEqual({uiState: 'subscribed', action: 'resubscribe'})
  })

  it('granted + present + inactive -> cleanup', () => {
    expect(reconcile('granted', true, 'inactive')).toEqual({uiState: 'not-requested', action: 'cleanup'})
  })

  it('granted + present + not_subscribed -> cleanup', () => {
    expect(reconcile('granted', true, 'not_subscribed')).toEqual({uiState: 'not-requested', action: 'cleanup'})
  })

  it('denied + present -> cleanup-and-unsubscribe', () => {
    expect(reconcile('denied', true, 'not_subscribed')).toEqual({
      uiState: 'denied',
      action: 'cleanup-and-unsubscribe',
    })
  })

  it('denied + none -> cleanup (no endpoint to unsubscribe)', () => {
    expect(reconcile('denied', false, 'subscribed')).toEqual({uiState: 'denied', action: 'cleanup'})
  })

  it('denied + push_disabled -> denied does not override push_disabled unsupported branch', () => {
    // push_disabled always wins regardless of permission, per the drift matrix.
    expect(reconcile('denied', true, 'push_disabled')).toEqual({uiState: 'unsupported', action: 'cleanup'})
  })

  it('default + present + any -> cleanup-and-unsubscribe', () => {
    expect(reconcile('default', true, 'subscribed')).toEqual({
      uiState: 'not-requested',
      action: 'cleanup-and-unsubscribe',
    })
  })
})
