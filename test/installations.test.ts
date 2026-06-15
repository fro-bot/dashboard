/**
 * Test suite for src/github/installations.ts
 *
 * Tests the pure transform logic via dependency injection — no network calls.
 * Covers: happy path, edge cases, error paths, and security invariants.
 */

import type {InstallationRecord, InstallationsClient, RepoRecord} from '../src/github/installations.ts'

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {
  CORE_READ_PERMISSIONS,
  enumerateRepos,
  FetchInstallationsError,
  FULL_READ_PERMISSIONS,
  mintReadOnlyToken,
  OPTIONAL_READ_PERMISSIONS,
} from '../src/github/installations.ts'
import {isErr, isOk} from '../src/result.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    node_id: 'MDEwOlJlcG9zaXRvcnkx',
    owner: 'fro-bot',
    name: 'agent',
    full_name: 'fro-bot/agent',
    ...overrides,
  }
}

function makeInstall(id: number, account = 'fro-bot'): InstallationRecord {
  return {id, account}
}

function makeClient(overrides: Partial<InstallationsClient> = {}): InstallationsClient {
  return {
    listInstallations: vi.fn().mockResolvedValue([]),
    mintInstallationToken: vi.fn().mockResolvedValue('ghs_fake_token'),
    listInstallationRepos: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('enumerateRepos — happy path', () => {
  it('unions repos from 2 installations, dedupes overlapping node_id', async () => {
    const sharedRepo = makeRepo({node_id: 'SHARED', full_name: 'fro-bot/shared'})
    const repoA = makeRepo({node_id: 'REPO_A', full_name: 'fro-bot/agent'})
    const repoB = makeRepo({node_id: 'REPO_B', full_name: 'fro-bot/dashboard'})

    const client = makeClient({
      listInstallations: vi.fn().mockResolvedValue([makeInstall(1), makeInstall(2)]),
      mintInstallationToken: vi.fn().mockResolvedValue('ghs_fake_token'),
      listInstallationRepos: vi
        .fn()
        // install 1 has sharedRepo + repoA
        .mockResolvedValueOnce([sharedRepo, repoA])
        // install 2 has sharedRepo (duplicate) + repoB
        .mockResolvedValueOnce([sharedRepo, repoB]),
    })

    const result = await enumerateRepos(client)

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    const {repos} = result.data
    // 3 unique repos (sharedRepo deduped)
    expect(repos).toHaveLength(3)
    const nodeIds = repos.map(r => r.node_id)
    expect(nodeIds).toContain('SHARED')
    expect(nodeIds).toContain('REPO_A')
    expect(nodeIds).toContain('REPO_B')
    // SHARED appears exactly once
    expect(nodeIds.filter(id => id === 'SHARED')).toHaveLength(1)
  })

  it('returns both installations in the result', async () => {
    const client = makeClient({
      listInstallations: vi.fn().mockResolvedValue([makeInstall(10, 'org-a'), makeInstall(20, 'org-b')]),
      listInstallationRepos: vi.fn().mockResolvedValue([makeRepo()]),
    })

    const result = await enumerateRepos(client)
    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    expect(result.data.installations).toHaveLength(2)
    expect(result.data.installations[0]?.id).toBe(10)
    expect(result.data.installations[1]?.id).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('enumerateRepos — edge cases', () => {
  it('returns empty repos for 0 installations without crashing', async () => {
    const client = makeClient({
      listInstallations: vi.fn().mockResolvedValue([]),
    })

    const result = await enumerateRepos(client)

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.data.repos).toHaveLength(0)
    expect(result.data.installations).toHaveLength(0)
  })

  it('installation with 0 accessible repos contributes nothing', async () => {
    const client = makeClient({
      listInstallations: vi.fn().mockResolvedValue([makeInstall(1)]),
      listInstallationRepos: vi.fn().mockResolvedValue([]),
    })

    const result = await enumerateRepos(client)

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.data.repos).toHaveLength(0)
  })

  it('skips an installation whose token mint fails, continues with others', async () => {
    const repoB = makeRepo({node_id: 'REPO_B', full_name: 'fro-bot/dashboard'})

    const client = makeClient({
      listInstallations: vi.fn().mockResolvedValue([makeInstall(1), makeInstall(2)]),
      mintInstallationToken: vi
        .fn()
        // install 1: full permissions fail, core-only also fails → skip
        .mockRejectedValueOnce(new Error('scope not registered'))
        .mockRejectedValueOnce(new Error('scope not registered'))
        // install 2: succeeds
        .mockResolvedValueOnce('ghs_install2_token'),
      listInstallationRepos: vi.fn().mockResolvedValue([repoB]),
    })

    const result = await enumerateRepos(client)

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    // Only install 2's repos
    expect(result.data.repos).toHaveLength(1)
    expect(result.data.repos[0]?.node_id).toBe('REPO_B')
  })
})

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe('enumerateRepos — error path', () => {
  it('returns err(FetchInstallationsError) when listInstallations rejects', async () => {
    const client = makeClient({
      listInstallations: vi.fn().mockRejectedValue(new Error('network timeout')),
    })

    const result = await enumerateRepos(client)

    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(FetchInstallationsError)
    expect(result.error.message).toContain('network timeout')
  })

  it('does not throw — always returns a Result', async () => {
    const client = makeClient({
      listInstallations: vi.fn().mockRejectedValue(new Error('boom')),
    })

    // Must not throw
    await expect(enumerateRepos(client)).resolves.toBeDefined()
    const result = await enumerateRepos(client)
    expect(isErr(result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Security: PEM redaction
// ---------------------------------------------------------------------------

describe('security — PEM redaction', () => {
  it('safeErrorMessage strips PEM blocks from error messages', async () => {
    const {safeErrorMessage} = await import('../src/github/app-client.ts')

    const fakePem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4PAtEsHAAAAAAAAAAAAAAAAAA==
-----END RSA PRIVATE KEY-----`

    const error = new Error(`Auth failed: ${fakePem}`)
    const safe = safeErrorMessage(error)

    expect(safe).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(safe).not.toContain('MIIEowIBAAKCAQEA')
    expect(safe).toContain('[REDACTED]')
  })

  it('safeErrorMessage strips JWT-shaped strings from error messages', async () => {
    const {safeErrorMessage} = await import('../src/github/app-client.ts')

    const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const error = new Error(`Token rejected: ${fakeJwt}`)
    const safe = safeErrorMessage(error)

    expect(safe).not.toContain('eyJhbGciOiJSUzI1NiJ9')
    expect(safe).toContain('[REDACTED]')
  })

  it('FetchInstallationsError message does not contain PEM key bytes when listInstallations fails with a PEM in the error', async () => {
    const fakePem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn\n-----END RSA PRIVATE KEY-----`
    const client = makeClient({
      listInstallations: vi.fn().mockRejectedValue(new Error(`Auth failed: ${fakePem}`)),
    })

    const result = await enumerateRepos(client)

    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error.message).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(result.error.message).not.toContain('MIIEowIBAAKCAQEA')
    expect(result.error.message).toContain('[REDACTED]')
  })
})

// ---------------------------------------------------------------------------
// Security: read-only permissions invariant
// ---------------------------------------------------------------------------

describe('security — read-only permissions invariant', () => {
  it('CORE_READ_PERMISSIONS contains only "read" values', () => {
    for (const [key, value] of Object.entries(CORE_READ_PERMISSIONS)) {
      expect(value).toBe('read')
      // Must not contain write or admin
      expect(value).not.toBe('write')
      expect(value).not.toBe('admin')
      // Sanity: key is a non-empty string
      expect(key.length).toBeGreaterThan(0)
    }
  })

  it('FULL_READ_PERMISSIONS contains only "read" values (no write/admin scopes)', () => {
    for (const [key, value] of Object.entries(FULL_READ_PERMISSIONS)) {
      expect(value).toBe('read')
      expect(value).not.toBe('write')
      expect(value).not.toBe('admin')
      expect(key.length).toBeGreaterThan(0)
    }
  })

  it('every mintInstallationToken call passes a permissions object with only "read" values', async () => {
    const mintFn = vi.fn().mockResolvedValue('ghs_token')

    // Use IDs not used in any other test to avoid token cache hits
    const client = makeClient({
      listInstallations: vi.fn().mockResolvedValue([makeInstall(501), makeInstall(502)]),
      mintInstallationToken: mintFn,
      listInstallationRepos: vi.fn().mockResolvedValue([makeRepo()]),
    })

    await enumerateRepos(client)

    // mintFn should have been called for each installation
    expect(mintFn).toHaveBeenCalled()

    for (const call of mintFn.mock.calls) {
      const permissions = call[1] as Record<string, string>
      expect(permissions).toBeDefined()
      for (const [key, value] of Object.entries(permissions)) {
        expect(value).toBe('read')
        expect(value).not.toBe('write')
        expect(value).not.toBe('admin')
        expect(key.length).toBeGreaterThan(0)
      }
    }
  })

  it('CORE_READ_PERMISSIONS includes the required scopes', () => {
    expect(CORE_READ_PERMISSIONS).toHaveProperty('pull_requests', 'read')
    expect(CORE_READ_PERMISSIONS).toHaveProperty('checks', 'read')
    expect(CORE_READ_PERMISSIONS).toHaveProperty('issues', 'read')
    expect(CORE_READ_PERMISSIONS).toHaveProperty('contents', 'read')
    expect(CORE_READ_PERMISSIONS).toHaveProperty('metadata', 'read')
  })

  it('OPTIONAL_READ_PERMISSIONS includes security_events and vulnerability_alerts', () => {
    expect(OPTIONAL_READ_PERMISSIONS).toHaveProperty('security_events', 'read')
    expect(OPTIONAL_READ_PERMISSIONS).toHaveProperty('vulnerability_alerts', 'read')
  })
})

// ---------------------------------------------------------------------------
// Security: optional-scope graceful degradation
// ---------------------------------------------------------------------------

describe('security — optional-scope graceful degradation', () => {
  beforeEach(() => {
    // Clear module-level token cache between tests by using fresh mocks
  })

  it('retries with core-only permissions when full-permissions mint fails', async () => {
    const mintFn = vi
      .fn()
      // First call (full permissions) fails
      .mockRejectedValueOnce(new Error('Resource not accessible by integration'))
      // Second call (core-only) succeeds
      .mockResolvedValueOnce('ghs_core_only_token')

    const token = await mintReadOnlyToken(99, mintFn)

    expect(token).toBe('ghs_core_only_token')
    expect(mintFn).toHaveBeenCalledTimes(2)

    // First call: full permissions
    const firstCallPerms = mintFn.mock.calls[0]?.[1] as Record<string, string>
    expect(firstCallPerms).toMatchObject(FULL_READ_PERMISSIONS)
    expect(firstCallPerms).toHaveProperty('security_events', 'read')
    expect(firstCallPerms).toHaveProperty('vulnerability_alerts', 'read')

    // Second call: core-only permissions (no optional scopes)
    const secondCallPerms = mintFn.mock.calls[1]?.[1] as Record<string, string>
    expect(secondCallPerms).toMatchObject(CORE_READ_PERMISSIONS)
    expect(secondCallPerms).not.toHaveProperty('security_events')
    expect(secondCallPerms).not.toHaveProperty('vulnerability_alerts')
  })

  it('succeeds with full permissions on first try when App has all scopes', async () => {
    const mintFn = vi.fn().mockResolvedValueOnce('ghs_full_token')

    const token = await mintReadOnlyToken(100, mintFn)

    expect(token).toBe('ghs_full_token')
    expect(mintFn).toHaveBeenCalledTimes(1)

    const callPerms = mintFn.mock.calls[0]?.[1] as Record<string, string>
    expect(callPerms).toMatchObject(FULL_READ_PERMISSIONS)
  })

  it('throws when both full and core-only mint attempts fail', async () => {
    const mintFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('full scope fail'))
      .mockRejectedValueOnce(new Error('core scope fail'))

    await expect(mintReadOnlyToken(101, mintFn)).rejects.toThrow('core scope fail')
    expect(mintFn).toHaveBeenCalledTimes(2)
  })

  it('enumerateRepos succeeds with core-only token when optional scopes unavailable', async () => {
    const repoA = makeRepo({node_id: 'REPO_A'})

    const mintFn = vi
      .fn()
      // Full permissions fail
      .mockRejectedValueOnce(new Error('security_events not registered'))
      // Core-only succeeds
      .mockResolvedValueOnce('ghs_core_token')

    const client = makeClient({
      listInstallations: vi.fn().mockResolvedValue([makeInstall(200)]),
      mintInstallationToken: mintFn,
      listInstallationRepos: vi.fn().mockResolvedValue([repoA]),
    })

    const result = await enumerateRepos(client)

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.data.repos).toHaveLength(1)
    expect(result.data.repos[0]?.node_id).toBe('REPO_A')

    // Verify the second mint call used core-only permissions
    const secondCallPerms = mintFn.mock.calls[1]?.[1] as Record<string, string>
    expect(secondCallPerms).not.toHaveProperty('security_events')
    expect(secondCallPerms).not.toHaveProperty('vulnerability_alerts')
    // All values must still be 'read'
    for (const value of Object.values(secondCallPerms)) {
      expect(value).toBe('read')
    }
  })
})
