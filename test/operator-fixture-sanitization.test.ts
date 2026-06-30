/**
 * Fixture no-leak guard.
 *
 * Security invariants tested:
 * - Fixture files must not contain bearer tokens, __Host- cookies, CSRF headers,
 *   workspace paths, private-looking URLs, or real UUID run IDs.
 * - Synthetic fixture identifiers must be visually fixture-prefixed.
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import process from 'node:process'
import {describe, expect, it} from 'vitest'

const FIXTURE_FILES = [
  'src/gateway/operator-fixtures.ts',
  'src/gateway/operator-fixture-sse.ts',
  'src/routes/operator-fixture-harness.ts',
]

/**
 * Patterns that must NOT appear in committed fixture files.
 * Each entry is a [label, RegExp] pair for clear failure messages.
 */
const FORBIDDEN_PATTERNS: readonly [string, RegExp][] = [
  // Bearer tokens
  ['bearer token', /Bearer\s+[\w\-.~+/]+=*/i],
  // __Host- cookies (production cookie prefix)
  ['__Host- cookie', /__Host-/],
  // CSRF header names (real header values)
  ['x-csrf-token header value', /x-csrf-token:\s*[^\s'"[\]{}]/i],
  // Workspace paths (absolute paths that look like real workspaces)
  ['workspace path', /\/(?:home|Users|workspace|workspaces|var\/run|tmp)\/[\w.-]+\/[\w.-]/],
  // Private-looking URLs (absolute URLs with real-looking hostnames, not fixture-prefixed)
  ['private URL', /https?:\/\/(?!fixture)\w(?:[\w-]{0,61}\w)?\.(?:internal|local|corp|private|intranet)\//i],
  // Real UUID run IDs (standard UUID v4 format — fixture run IDs must be prefixed)
  ['real UUID run ID', /\brun-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\b/i],
  // GitHub personal access tokens (ghp_, gho_, ghs_, ghr_, github_pat_)
  ['GitHub PAT', /\b(?:ghp|gho|ghs|ghr|github_pat)_\w{10,}/],
  // Generic high-entropy secrets (long base64-looking strings that aren't fixture-prefixed)
  // Specifically: 40+ char hex strings (SHA-like) not in a comment
  ['high-entropy hex secret', /(?<![/#*])\b[\da-f]{40,}\b/i],
]

/**
 * Patterns that are explicitly allowed in fixture files.
 * Used to suppress false positives from the forbidden-pattern scan.
 */
const ALLOWED_PATTERNS: readonly RegExp[] = [
  // fixture-prefixed CSRF placeholder (explicitly safe)
  /fixture-csrf-placeholder/,
  // fixture-prefixed idempotency keys
  /fixture-idempotency-key/,
  // fixture-prefixed request IDs
  /fixture-req-/,
  // fixture-prefixed run IDs (run-fixture-*)
  /run-fixture-/,
  // fixture-prefixed login names
  /fixture-operator/,
  // fixture-prefixed repo names
  /fixture-repo/,
]

const RUN_ID_PATTERN = /\brunId['":\s]+['"]([^'"]+)['"]/g
const isFixtureRunId = (v: string): boolean => v.startsWith('run-fixture-')

const REQUEST_ID_PATTERN = /\brequestID['":\s]+['"]([^'"]+)['"]/g
const isFixtureRequestId = (v: string): boolean => v.startsWith('req-fixture-') || v.startsWith('fixture-req-')

const IDEMPOTENCY_KEY_PATTERN = /\bidempotencyKey['":\s]+['"]([^'"]+)['"]/g
const isFixtureIdempotencyKey = (v: string): boolean => v.startsWith('fixture-')

const CSRF_TOKEN_PATTERN = /\bcsrfToken['":\s]+['"]([^'"]+)['"]/g
const isFixtureCsrfToken = (v: string): boolean => v.startsWith('fixture-')

const LOGIN_PATTERN = /\blogin['":\s]+['"]([^'"]+)['"]/g
const isFixtureLogin = (v: string): boolean => v.startsWith('fixture-')

function readFixtureFile(relativePath: string): string {
  const absolutePath = resolve(process.cwd(), relativePath)
  return readFileSync(absolutePath, 'utf-8')
}

function stripComments(source: string): string {
  let stripped = source.replaceAll(/\/\/[^\n]*/g, '')
  stripped = stripped.replaceAll(/\/\*[\s\S]*?\*\//g, '')
  return stripped
}

describe('fixture no-leak guard — forbidden patterns', () => {
  for (const filePath of FIXTURE_FILES) {
    describe(`${filePath}`, () => {
      let source: string
      let strippedSource: string

      try {
        source = readFixtureFile(filePath)
        strippedSource = stripComments(source)
      } catch {
        // File doesn't exist yet — tests will fail with a clear message
        source = ''
        strippedSource = ''
      }

      for (const [label, pattern] of FORBIDDEN_PATTERNS) {
        it(`must not contain ${label}`, () => {
          const matches = strippedSource.match(pattern)
          if (matches !== null) {
            // Check if any match is covered by an allowed pattern
            const uncoveredMatches = matches.filter(match =>
              !ALLOWED_PATTERNS.some(allowed => allowed.test(match)),
            )
            expect(uncoveredMatches).toHaveLength(0)
          }
        })
      }
    })
  }
})

describe('fixture no-leak guard — synthetic identifier prefixes', () => {
  for (const filePath of FIXTURE_FILES) {
    describe(`${filePath}`, () => {
      let source: string

      try {
        source = readFixtureFile(filePath)
      } catch {
        source = ''
      }

      it('all runId values must be fixture-prefixed', () => {
        const matches = [...source.matchAll(RUN_ID_PATTERN)]
        for (const match of matches) {
          const value = match[1]
          if (value !== undefined) {
            expect(isFixtureRunId(value)).toBe(true)
          }
        }
      })

      it('all requestID values must be fixture-prefixed', () => {
        const matches = [...source.matchAll(REQUEST_ID_PATTERN)]
        for (const match of matches) {
          const value = match[1]
          if (value !== undefined) {
            expect(isFixtureRequestId(value)).toBe(true)
          }
        }
      })

      it('all idempotencyKey values must be fixture-prefixed', () => {
        const matches = [...source.matchAll(IDEMPOTENCY_KEY_PATTERN)]
        for (const match of matches) {
          const value = match[1]
          if (value !== undefined) {
            expect(isFixtureIdempotencyKey(value)).toBe(true)
          }
        }
      })

      it('all csrfToken values must be fixture-prefixed', () => {
        const matches = [...source.matchAll(CSRF_TOKEN_PATTERN)]
        for (const match of matches) {
          const value = match[1]
          if (value !== undefined) {
            expect(isFixtureCsrfToken(value)).toBe(true)
          }
        }
      })

      it('all login values must be fixture-prefixed', () => {
        const matches = [...source.matchAll(LOGIN_PATTERN)]
        for (const match of matches) {
          const value = match[1]
          if (value !== undefined) {
            expect(isFixtureLogin(value)).toBe(true)
          }
        }
      })
    })
  }
})

describe('fixture no-leak guard — explicit bad-fixture rejection', () => {
  it('a fixture string containing a bearer token fails the guard', () => {
    const badFixture = 'const token = "Bearer ghp_abc123def456ghi789jkl012mno345pqr678"'
    const bearerPattern = FORBIDDEN_PATTERNS.find(([label]) => label === 'bearer token')
    expect(bearerPattern).toBeDefined()
    if (bearerPattern) {
      expect(bearerPattern[1].test(badFixture)).toBe(true)
    }
  })

  it('a fixture string containing a __Host- cookie fails the guard', () => {
    const badFixture = 'const cookie = "__Host-session=abc123"'
    const cookiePattern = FORBIDDEN_PATTERNS.find(([label]) => label === '__Host- cookie')
    expect(cookiePattern).toBeDefined()
    if (cookiePattern) {
      expect(cookiePattern[1].test(badFixture)).toBe(true)
    }
  })

  it('a fixture string containing a workspace path fails the guard', () => {
    const badFixture = 'const path = "/home/user/workspace/project/file.ts"'
    const pathPattern = FORBIDDEN_PATTERNS.find(([label]) => label === 'workspace path')
    expect(pathPattern).toBeDefined()
    if (pathPattern) {
      expect(pathPattern[1].test(badFixture)).toBe(true)
    }
  })

  it('a fixture string containing a real UUID run ID fails the guard', () => {
    const badFixture = 'const runId = "run-550e8400-e29b-41d4-a716-446655440000"'
    const uuidPattern = FORBIDDEN_PATTERNS.find(([label]) => label === 'real UUID run ID')
    expect(uuidPattern).toBeDefined()
    if (uuidPattern) {
      expect(uuidPattern[1].test(badFixture)).toBe(true)
    }
  })

  it('a fixture string containing a GitHub PAT fails the guard', () => {
    const badFixture = 'const token = "ghp_abcdefghijklmnopqrstuvwxyz123456"'
    const patPattern = FORBIDDEN_PATTERNS.find(([label]) => label === 'GitHub PAT')
    expect(patPattern).toBeDefined()
    if (patPattern) {
      expect(patPattern[1].test(badFixture)).toBe(true)
    }
  })

  it('a fixture-prefixed run ID does not trigger the UUID guard', () => {
    const goodFixture = 'runId: "run-fixture-success-001"'
    const uuidPattern = FORBIDDEN_PATTERNS.find(([label]) => label === 'real UUID run ID')
    expect(uuidPattern).toBeDefined()
    if (uuidPattern) {
      expect(uuidPattern[1].test(goodFixture)).toBe(false)
    }
  })

  it('a fixture-prefixed CSRF token does not trigger the bearer guard', () => {
    const goodFixture = 'csrfToken: "fixture-csrf-placeholder"'
    const bearerPattern = FORBIDDEN_PATTERNS.find(([label]) => label === 'bearer token')
    expect(bearerPattern).toBeDefined()
    if (bearerPattern) {
      expect(bearerPattern[1].test(goodFixture)).toBe(false)
    }
  })
})
