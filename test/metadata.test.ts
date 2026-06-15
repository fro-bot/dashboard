/**
 * Test suite for src/github/metadata.ts
 *
 * All tests inject a fake reader — no network calls.
 * Covers: happy path, security invariants, schema validation, error paths, edge cases.
 *
 * Security tests are the primary gate: they assert that redacted entries'
 * owner/name NEVER appear in the result, and that the denylist is populated.
 */

import {Buffer} from 'node:buffer'

import {describe, expect, it} from 'vitest'
import {
  deriveDatabaseId,
  makeNotFoundError,
  MetadataParseError,
  MetadataSchemaError,
  MetadataTransportError,
  MetadataUnavailableError,
  readRepoMetadata,
} from '../src/github/metadata.ts'
import {isErr, isOk} from '../src/result.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Canonical fixture: 3 public repos + 2 redacted entries.
 * Mirrors the real repos.yaml schema exactly.
 */
const FIXTURE_YAML = `
version: 1
repos:
  - owner: marcusrbrown
    name: ha-config
    added: 2026-04-17
    onboarding_status: onboarded
    last_survey_at: 2026-06-10
    last_survey_status: success
    has_fro_bot_workflow: false
    has_renovate: true
    next_survey_eligible_at: 2026-07-12
    discovery_channel: collab
    private: false
    node_id: R_kgDOJ_bMaQ

  - owner: fro-bot
    name: agent
    added: 2026-01-01
    onboarding_status: onboarded
    last_survey_at: 2026-06-01
    last_survey_status: success
    has_fro_bot_workflow: true
    has_renovate: true
    next_survey_eligible_at: 2026-07-01
    discovery_channel: collab
    private: false
    node_id: R_kgDOPublicTwo

  - owner: fro-bot
    name: dashboard
    added: 2026-02-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    next_survey_eligible_at: null
    discovery_channel: collab
    private: false
    node_id: R_kgDOPublicThree

  - owner: '[REDACTED]'
    name: R_kgDOSVJgdw
    added: 2026-06-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: true
    has_renovate: true
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
    node_id: R_kgDOSVJgdw

  - owner: '[REDACTED]'
    name: R_kgDOAnotherPrivate
    added: 2026-05-15
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
    node_id: R_kgDOAnotherPrivate
`

function makeReader(yaml: string) {
  return async (_path: string, _ref: string): Promise<string> => yaml
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('readRepoMetadata — happy path', () => {
  it('parses public entries with owner/name/channel/node_id', async () => {
    const result = await readRepoMetadata(makeReader(FIXTURE_YAML))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    const {publicRepos} = result.data
    expect(publicRepos).toHaveLength(3)

    const first = publicRepos[0]
    expect(first?.owner).toBe('marcusrbrown')
    expect(first?.name).toBe('ha-config')
    expect(first?.node_id).toBe('R_kgDOJ_bMaQ')
    expect(first?.discovery_channel).toBe('collab')

    const second = publicRepos[1]
    expect(second?.owner).toBe('fro-bot')
    expect(second?.name).toBe('agent')
    expect(second?.node_id).toBe('R_kgDOPublicTwo')

    const third = publicRepos[2]
    expect(third?.owner).toBe('fro-bot')
    expect(third?.name).toBe('dashboard')
    expect(third?.node_id).toBe('R_kgDOPublicThree')
  })

  it('returns a MetadataResult with both publicRepos and redactedNodeIds', async () => {
    const result = await readRepoMetadata(makeReader(FIXTURE_YAML))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    expect(result.data).toHaveProperty('publicRepos')
    expect(result.data).toHaveProperty('redactedNodeIds')
    expect(result.data.redactedNodeIds).toBeInstanceOf(Set)
  })
})

// ---------------------------------------------------------------------------
// Security: redacted entries excluded from publicRepos
// ---------------------------------------------------------------------------

describe('security — redacted entries excluded from publicRepos', () => {
  it('redacted entries are NOT present in publicRepos', async () => {
    const result = await readRepoMetadata(makeReader(FIXTURE_YAML))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    const {publicRepos} = result.data

    // No public repo should have a redacted node_id
    const nodeIds = publicRepos.map(r => r.node_id)
    expect(nodeIds).not.toContain('R_kgDOSVJgdw')
    expect(nodeIds).not.toContain('R_kgDOAnotherPrivate')

    // No public repo should have '[REDACTED]' as owner
    const owners = publicRepos.map(r => r.owner)
    expect(owners).not.toContain('[REDACTED]')
  })

  it('redacted owner/name strings never appear in serialized result', async () => {
    const result = await readRepoMetadata(makeReader(FIXTURE_YAML))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    // Serialize the entire result to JSON and check for leakage
    // publicRepos only — redactedNodeIds is a Set (not JSON-serializable directly)
    const serialized = JSON.stringify(result.data.publicRepos)

    // The redacted owner string must not appear
    expect(serialized).not.toContain('[REDACTED]')

    // The redacted name strings (which equal the node_ids) must not appear
    // as owner or name values in publicRepos
    for (const repo of result.data.publicRepos) {
      expect(repo.owner).not.toBe('[REDACTED]')
      // The name 'R_kgDOSVJgdw' is a node_id used as name for redacted entries
      // It must not appear as a public repo's name
      expect(repo.name).not.toBe('R_kgDOSVJgdw')
      expect(repo.name).not.toBe('R_kgDOAnotherPrivate')
    }
  })
})

// ---------------------------------------------------------------------------
// Security: redacted node_ids populate the denylist
// ---------------------------------------------------------------------------

describe('security — redacted node_ids populate redactedNodeIds', () => {
  it('redactedNodeIds contains the expected ids for 2 redacted entries', async () => {
    const result = await readRepoMetadata(makeReader(FIXTURE_YAML))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    const {redactedNodeIds} = result.data

    expect(redactedNodeIds.size).toBe(2)
    expect(redactedNodeIds.has('R_kgDOSVJgdw')).toBe(true)
    expect(redactedNodeIds.has('R_kgDOAnotherPrivate')).toBe(true)
  })

  it('redactedNodeIds is non-empty when fixture has redacted entries', async () => {
    const result = await readRepoMetadata(makeReader(FIXTURE_YAML))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    expect(result.data.redactedNodeIds.size).toBeGreaterThan(0)
  })

  it('a private:true entry without [REDACTED] owner is still denylisted', async () => {
    const yaml = `
version: 1
repos:
  - owner: some-org
    name: secret-repo
    added: 2026-01-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
    node_id: R_kgDOPrivateByFlag
`
    const result = await readRepoMetadata(makeReader(yaml))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    // private:true → denylist, not publicRepos
    expect(result.data.redactedNodeIds.has('R_kgDOPrivateByFlag')).toBe(true)
    expect(result.data.publicRepos).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('readRepoMetadata — schema validation', () => {
  it('version: 2 returns err(MetadataSchemaError)', async () => {
    const yaml = `
version: 2
repos: []
`
    const result = await readRepoMetadata(makeReader(yaml))

    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataSchemaError)
  })

  it('missing version field returns err(MetadataSchemaError)', async () => {
    const yaml = `
repos: []
`
    const result = await readRepoMetadata(makeReader(yaml))

    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataSchemaError)
  })

  it('version mismatch does NOT silently return empty — it returns err', async () => {
    const yaml = `
version: 99
repos:
  - owner: fro-bot
    name: agent
    node_id: R_kgDOPublicTwo
    discovery_channel: collab
    private: false
    added: 2026-01-01
    onboarding_status: onboarded
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    next_survey_eligible_at: null
`
    const result = await readRepoMetadata(makeReader(yaml))

    // Must be err, not ok with empty arrays
    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataSchemaError)
    expect(result.error.message).toContain('99')
  })
})

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('readRepoMetadata — error paths', () => {
  it('reader throwing a NOT_FOUND error returns err(MetadataUnavailableError)', async () => {
    const reader = async (_path: string, _ref: string): Promise<string> => {
      throw makeNotFoundError('data branch not found')
    }

    const result = await readRepoMetadata(reader)

    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataUnavailableError)
  })

  it('404 / unavailable does NOT throw — returns err', async () => {
    const reader = async (): Promise<string> => {
      throw makeNotFoundError('not found')
    }

    await expect(readRepoMetadata(reader)).resolves.toBeDefined()
    const result = await readRepoMetadata(reader)
    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataUnavailableError)
  })

  it('transport error (reader rejects with generic error) returns err(MetadataTransportError)', async () => {
    const reader = async (): Promise<string> => {
      throw new Error('ECONNREFUSED')
    }

    const result = await readRepoMetadata(reader)

    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataTransportError)
    expect(result.error.message).toContain('ECONNREFUSED')
  })

  it('transport error does NOT throw — returns err', async () => {
    const reader = async (): Promise<string> => {
      throw new Error('network timeout')
    }

    await expect(readRepoMetadata(reader)).resolves.toBeDefined()
    const result = await readRepoMetadata(reader)
    expect(isErr(result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('readRepoMetadata — edge cases', () => {
  it('malformed YAML returns err(MetadataParseError), does not throw', async () => {
    const yaml = `
version: 1
repos:
  - owner: [unclosed bracket
    name: bad
`
    const result = await readRepoMetadata(makeReader(yaml))

    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataParseError)
  })

  it('completely invalid YAML (not an object) returns err(MetadataParseError)', async () => {
    const yaml = `just a plain string`

    const result = await readRepoMetadata(makeReader(yaml))

    // 'just a plain string' parses as a string, not an object → parse error
    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataParseError)
  })

  it('empty repos array returns ok with empty publicRepos and empty denylist', async () => {
    const yaml = `
version: 1
repos: []
`
    const result = await readRepoMetadata(makeReader(yaml))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    expect(result.data.publicRepos).toHaveLength(0)
    expect(result.data.redactedNodeIds.size).toBe(0)
  })

  it('does not throw for any input — always returns a Result', async () => {
    const inputs = [
      '',
      'null',
      '[]',
      'version: 1\nrepos: []',
      FIXTURE_YAML,
    ]

    for (const yaml of inputs) {
      await expect(readRepoMetadata(makeReader(yaml))).resolves.toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Security: FIX #2 — fail closed on redacted entry with no usable deny key
// ---------------------------------------------------------------------------

describe('security — fail closed on redacted entry with no usable deny key', () => {
  it('private:true entry with missing node_id (and no database_id) returns err(MetadataSchemaError)', async () => {
    const yaml = `
version: 1
repos:
  - owner: '[REDACTED]'
    name: some-private-repo
    added: 2026-01-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
`
    const result = await readRepoMetadata(makeReader(yaml))

    // Must fail closed — not ok
    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataSchemaError)
    // Must NOT contain owner or name in the error message
    expect(result.error.message).not.toContain('[REDACTED]')
    expect(result.error.message).not.toContain('some-private-repo')
  })

  it('private:true entry with empty string node_id (and no database_id) returns err(MetadataSchemaError)', async () => {
    const yaml = `
version: 1
repos:
  - owner: '[REDACTED]'
    name: another-private-repo
    added: 2026-01-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
    node_id: ''
`
    const result = await readRepoMetadata(makeReader(yaml))

    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataSchemaError)
    expect(result.error.message).not.toContain('[REDACTED]')
    expect(result.error.message).not.toContain('another-private-repo')
  })

  it('private:true entry with non-string node_id (and no database_id) returns err(MetadataSchemaError)', async () => {
    const yaml = `
version: 1
repos:
  - owner: '[REDACTED]'
    name: yet-another-private-repo
    added: 2026-01-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
    node_id: 12345
`
    const result = await readRepoMetadata(makeReader(yaml))

    expect(isErr(result)).toBe(true)
    if (!isErr(result)) return
    expect(result.error).toBeInstanceOf(MetadataSchemaError)
  })

  it('private:true entry with valid node_id still works (regression guard)', async () => {
    const yaml = `
version: 1
repos:
  - owner: '[REDACTED]'
    name: valid-private-repo
    added: 2026-01-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
    node_id: R_kgDOValidPrivate
`
    const result = await readRepoMetadata(makeReader(yaml))

    // Must succeed — valid node_id is a usable deny key
    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.data.redactedNodeIds.has('R_kgDOValidPrivate')).toBe(true)
    expect(result.data.publicRepos).toHaveLength(0)
  })

  it('private:true entry with no node_id but valid database_id succeeds (database_id is a usable deny key)', async () => {
    const yaml = `
version: 1
repos:
  - owner: '[REDACTED]'
    name: db-id-only-private-repo
    added: 2026-01-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
    database_id: 987654321
`
    const result = await readRepoMetadata(makeReader(yaml))

    // Must succeed — database_id is a usable deny key
    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.data.redactedDatabaseIds.has(987654321)).toBe(true)
    expect(result.data.redactedNodeIds.size).toBe(0)
    expect(result.data.publicRepos).toHaveLength(0)
  })

  it('MetadataResult includes redactedDatabaseIds as a Set', async () => {
    const result = await readRepoMetadata(makeReader(FIXTURE_YAML))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.data).toHaveProperty('redactedDatabaseIds')
    expect(result.data.redactedDatabaseIds).toBeInstanceOf(Set)
  })
})

// ---------------------------------------------------------------------------
// Integration boundary: Unit 4 fail-closed contract
// ---------------------------------------------------------------------------

describe('Unit 4 fail-closed contract', () => {
  it('ok result provides both publicRepos and redactedNodeIds for aggregator use', async () => {
    const result = await readRepoMetadata(makeReader(FIXTURE_YAML))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    // Aggregator can use these directly
    const {publicRepos, redactedNodeIds} = result.data
    expect(Array.isArray(publicRepos)).toBe(true)
    expect(redactedNodeIds instanceof Set).toBe(true)
  })

  it('MetadataUnavailableError is distinguishable from MetadataTransportError', async () => {
    const unavailableReader = async (): Promise<string> => {
      throw makeNotFoundError('not found')
    }
    const transportReader = async (): Promise<string> => {
      throw new Error('network error')
    }

    const unavailableResult = await readRepoMetadata(unavailableReader)
    const transportResult = await readRepoMetadata(transportReader)

    expect(isErr(unavailableResult)).toBe(true)
    expect(isErr(transportResult)).toBe(true)

    if (!isErr(unavailableResult) || !isErr(transportResult)) return

    expect(unavailableResult.error).toBeInstanceOf(MetadataUnavailableError)
    expect(transportResult.error).toBeInstanceOf(MetadataTransportError)

    // Unit 4 can distinguish them by instanceof
    expect(unavailableResult.error instanceof MetadataUnavailableError).toBe(true)
    expect(transportResult.error instanceof MetadataTransportError).toBe(true)
  })

  it('MetadataSchemaError is distinguishable from MetadataParseError', async () => {
    const schemaReader = makeReader('version: 2\nrepos: []')
    const parseReader = makeReader('version: 1\nrepos:\n  - owner: [bad')

    const schemaResult = await readRepoMetadata(schemaReader)
    const parseResult = await readRepoMetadata(parseReader)

    expect(isErr(schemaResult)).toBe(true)
    expect(isErr(parseResult)).toBe(true)

    if (!isErr(schemaResult) || !isErr(parseResult)) return

    expect(schemaResult.error).toBeInstanceOf(MetadataSchemaError)
    expect(parseResult.error).toBeInstanceOf(MetadataParseError)
  })
})

// ---------------------------------------------------------------------------
// deriveDatabaseId — unit tests
// ---------------------------------------------------------------------------

describe('deriveDatabaseId — legacy base64 decode', () => {
  it('decodes the known real pair: MDEwOlJlcG9zaXRvcnkxODY5MTU0 → 1869154', () => {
    // Verified: base64-decode → "010:Repository1869154" → databaseId 1869154
    // This is marcusrbrown/.dotfiles from repos.yaml.
    expect(deriveDatabaseId('MDEwOlJlcG9zaXRvcnkxODY5MTU0')).toBe(1869154)
  })

  it('decodes another legacy node_id with a different databaseId', () => {
    // base64-encode "010:Repository42" → "MDEwOlJlcG9zaXRvcnk0Mg=="
    // Verify the decode works for arbitrary legacy ids.
    const encoded = Buffer.from('010:Repository42').toString('base64')
    expect(deriveDatabaseId(encoded)).toBe(42)
  })

  it('returns null for new-format node_ids (R_kgDO...)', () => {
    // Conservative: new-format cannot be reliably decoded without a known test vector.
    expect(deriveDatabaseId('R_kgDOJ_bMaQ')).toBeNull()
    expect(deriveDatabaseId('R_kgDOSVJgdw')).toBeNull()
    expect(deriveDatabaseId('R_kgDOAnotherPrivate')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(deriveDatabaseId('')).toBeNull()
  })

  it('returns null for a base64 string that does not match the Repository<digits> pattern', () => {
    // base64-encode "010:User12345" — not a Repository node_id
    const encoded = Buffer.from('010:User12345').toString('base64')
    expect(deriveDatabaseId(encoded)).toBeNull()
  })

  it('returns null for a non-base64 garbage string', () => {
    expect(deriveDatabaseId('not-valid-base64!!!')).toBeNull()
  })
})

describe('deriveDatabaseId — integration with readRepoMetadata', () => {
  it('a redacted entry with a legacy node_id populates redactedDatabaseIds with the derived id', async () => {
    // MDEwOlJlcG9zaXRvcnkxODY5MTU0 → databaseId 1869154
    const yaml = `
version: 1
repos:
  - owner: '[REDACTED]'
    name: dotfiles
    added: 2026-01-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
    node_id: MDEwOlJlcG9zaXRvcnkxODY5MTU0
`
    const result = await readRepoMetadata(makeReader(yaml))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    // node_id still in redactedNodeIds (primary guard)
    expect(result.data.redactedNodeIds.has('MDEwOlJlcG9zaXRvcnkxODY5MTU0')).toBe(true)
    // derived databaseId in redactedDatabaseIds (secondary guard)
    expect(result.data.redactedDatabaseIds.has(1869154)).toBe(true)
  })

  it('a new-format node_id that cannot be decoded does not add a bogus entry to redactedDatabaseIds', async () => {
    const yaml = `
version: 1
repos:
  - owner: '[REDACTED]'
    name: new-format-private
    added: 2026-01-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
    node_id: R_kgDOSVJgdw
`
    const result = await readRepoMetadata(makeReader(yaml))

    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return

    // node_id still in redactedNodeIds (primary guard still works)
    expect(result.data.redactedNodeIds.has('R_kgDOSVJgdw')).toBe(true)
    // No bogus entry in redactedDatabaseIds — new-format decode returns null
    expect(result.data.redactedDatabaseIds.size).toBe(0)
  })

  it('no crash when new-format node_id cannot be decoded — result is still ok', async () => {
    const yaml = `
version: 1
repos:
  - owner: '[REDACTED]'
    name: new-format-private
    added: 2026-01-01
    onboarding_status: pending
    last_survey_at: null
    last_survey_status: null
    has_fro_bot_workflow: false
    has_renovate: false
    discovery_channel: collab
    next_survey_eligible_at: null
    private: true
    node_id: R_kgDOAnotherPrivate
`
    await expect(readRepoMetadata(makeReader(yaml))).resolves.toBeDefined()
    const result = await readRepoMetadata(makeReader(yaml))
    expect(isOk(result)).toBe(true)
  })
})
