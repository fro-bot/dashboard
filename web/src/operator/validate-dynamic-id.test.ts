import {describe, expect, it} from 'vitest'
import {validateDynamicId} from './validate-dynamic-id.ts'

describe('validateDynamicId (web-local copy)', () => {
  it('rejects blank input', () => {
    expect(validateDynamicId('')).toBe(false)
    expect(validateDynamicId('   ')).toBe(false)
  })

  it('rejects forward and backward slashes', () => {
    expect(validateDynamicId('a/b')).toBe(false)
    expect(validateDynamicId('a\\b')).toBe(false)
  })

  it('rejects encoded slash variants', () => {
    expect(validateDynamicId('a%2fb')).toBe(false)
    expect(validateDynamicId('a%2Fb')).toBe(false)
    expect(validateDynamicId('a%5cb')).toBe(false)
    expect(validateDynamicId('a%5Cb')).toBe(false)
  })

  it('rejects dot and dot-dot after decoding', () => {
    expect(validateDynamicId('.')).toBe(false)
    expect(validateDynamicId('..')).toBe(false)
    expect(validateDynamicId('%2e')).toBe(false)
    expect(validateDynamicId('%2e%2e')).toBe(false)
  })

  it('rejects malformed percent-encoding', () => {
    expect(validateDynamicId('%')).toBe(false)
    expect(validateDynamicId('%zz')).toBe(false)
  })

  it('accepts a valid UUID', () => {
    expect(validateDynamicId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
  })

  it('accepts a simple alphanumeric id', () => {
    expect(validateDynamicId('run_12345')).toBe(true)
  })
})
