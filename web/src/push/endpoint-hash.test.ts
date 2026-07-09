import {describe, expect, it} from 'vitest'
import {endpointHash} from './endpoint-hash.ts'

describe('endpointHash', () => {
  it('returns 64-character lowercase hex output', async () => {
    const hash = await endpointHash('https://push.example.com/subscription/abc123')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', async () => {
    const endpoint = 'https://push.example.com/subscription/xyz789'
    const first = await endpointHash(endpoint)
    const second = await endpointHash(endpoint)
    expect(first).toBe(second)
  })

  it('produces different hashes for different endpoints', async () => {
    const hashA = await endpointHash('https://push.example.com/subscription/a')
    const hashB = await endpointHash('https://push.example.com/subscription/b')
    expect(hashA).not.toBe(hashB)
  })

  it('returns lowercase hex SHA-256 matching a known vector for a fixed test string', async () => {
    // Precomputed via: printf '%s' 'https://example.test/ep' | shasum -a 256
    const expected = '9fd0760e6a11c6fe4781525b54b98295bca9d334bd308c3bc57b62b767742feb'
    const actual = await endpointHash('https://example.test/ep')
    expect(actual).toBe(expected)
  })
})
