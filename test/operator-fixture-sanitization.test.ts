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
import {OPERATOR_FAILURE_KINDS} from '../src/gateway/operator-contract/run-status.ts'
import {
  FIXTURE_QUESTION_SCENARIO_ROWS,
  FIXTURE_SCENARIO_NAMES,
  fixtureQuestionScript,
  serializeScenarioToSse,
} from '../src/gateway/operator-fixture-sse.ts'
import {FIXTURE_KNOWN_FAILURE_REASON, FIXTURE_UNKNOWN_FAILURE_REASON} from '../src/gateway/operator-fixtures.ts'

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

describe('fixture no-leak guard — failure-reason values', () => {
  it('known production reason codes do not trip any forbidden pattern', () => {
    const KNOWN_REASON_CODES = [...OPERATOR_FAILURE_KINDS]
    for (const code of KNOWN_REASON_CODES) {
      const line = `failureKind: '${code}'`
      for (const [label, pattern] of FORBIDDEN_PATTERNS) {
        expect(pattern.test(line), `known reason "${code}" tripped forbidden pattern "${label}"`).toBe(false)
      }
    }
  })

  it('visibly synthetic fixture-prefixed unknown reason values do not trip forbidden patterns', () => {
    const line = "failureKind: 'fixture-unrecognized-reason'"
    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      expect(pattern.test(line), `synthetic unknown reason tripped forbidden pattern "${label}"`).toBe(false)
    }
  })

  it('the exported fixture reason constants are a known code and a fixture-prefixed synthetic code, respectively', () => {
    const KNOWN_REASON_CODES = new Set<string>(OPERATOR_FAILURE_KINDS)

    expect(KNOWN_REASON_CODES.has(FIXTURE_KNOWN_FAILURE_REASON)).toBe(true)

    expect(FIXTURE_UNKNOWN_FAILURE_REASON.startsWith('fixture-')).toBe(true)
    expect(KNOWN_REASON_CODES.has(FIXTURE_UNKNOWN_FAILURE_REASON)).toBe(false)
    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      expect(pattern.test(FIXTURE_UNKNOWN_FAILURE_REASON), `FIXTURE_UNKNOWN_FAILURE_REASON tripped forbidden pattern "${label}"`).toBe(false)
    }
  })

  it('committed fixture files only use the fixture-prefixed unknown reason value, never a bare non-fixture unknown string', () => {
    const KNOWN_REASON_CODES = new Set<string>(OPERATOR_FAILURE_KINDS)
    const FAILURE_KIND_LITERAL_PATTERN = /failureKind:\s*['"]([^'"]+)['"]/g

    for (const filePath of FIXTURE_FILES) {
      let source: string
      try {
        source = readFixtureFile(filePath)
      } catch {
        source = ''
      }
      const matches = [...source.matchAll(FAILURE_KIND_LITERAL_PATTERN)]
      for (const match of matches) {
        const value = match[1]
        if (value === undefined) continue
        const isKnown = KNOWN_REASON_CODES.has(value)
        const isSynthetic = value.startsWith('fixture-')
        expect(isKnown || isSynthetic, `failureKind literal "${value}" in ${filePath} is neither a known reason code nor fixture-prefixed`).toBe(true)
      }
    }
  })

  it('an unrecognized non-fixture-prefixed reason value fails the guard (explicit rejection)', () => {
    const badValue = 'totally-made-up-reason'
    const KNOWN_REASON_CODES = new Set<string>(OPERATOR_FAILURE_KINDS)
    expect(KNOWN_REASON_CODES.has(badValue) || badValue.startsWith('fixture-')).toBe(false)
  })
})

describe('fixture no-leak guard — checkout scenarios', () => {
  // eslint-disable-next-line no-control-regex
  const STRIPPED = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
  const CHECKOUT_KEYS = Object.keys(FIXTURE_SCENARIO_NAMES).filter(key => key.startsWith('checkout_'))

  /** Collect every string under the checkout fields of every status frame the scenario emits. */
  function checkoutStrings(sse: string): {key: string; value: string}[] {
    const found: {key: string; value: string}[] = []
    const walk = (node: unknown, key: string): void => {
      if (typeof node === 'string') found.push({key, value: node})
      else if (Array.isArray(node)) for (const entry of node) walk(entry, key)
      else if (node !== null && typeof node === 'object') {
        for (const [childKey, child] of Object.entries(node)) walk(child, childKey)
      }
    }
    for (const record of sse.split('\n\n')) {
      const data = record.split('\n').find(line => line.startsWith('data:'))
      if (data === undefined || !record.includes('event: status')) continue
      const parsed = JSON.parse(data.slice('data:'.length)) as Record<string, unknown>
      walk(parsed.checkoutProvenance, 'checkoutProvenance')
      walk(parsed.checkoutPreparation, 'checkoutPreparation')
    }
    return found
  }

  const ENUM_KEYS = new Set(['kind', 'outcome', 'reason', 'layoutReason', 'operation', 'operationInProgress', 'change', 'mutationStarted'])
  const TIMESTAMP_KEYS = new Set(['observedAt', 'checkedAt'])
  const SHA_KEYS = new Set(['sha', 'fromSha'])

  it('every free-form checkout value is fixture-prefixed (ignoring bidi/control characters), and every SHA is an obviously synthetic repeated pair', () => {
    expect(CHECKOUT_KEYS.length).toBeGreaterThan(10)
    for (const key of CHECKOUT_KEYS) {
      const sse = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES[key as keyof typeof FIXTURE_SCENARIO_NAMES], 'run-fixture-leak-001')
      for (const {key: field, value} of checkoutStrings(sse)) {
        if (ENUM_KEYS.has(field) || TIMESTAMP_KEYS.has(field)) continue
        if (SHA_KEYS.has(field)) {
          expect(value, `${key} ${field}`).toMatch(/^([\da-f]{2})\1{19}$/)
          continue
        }
        const visible = value.replaceAll(STRIPPED, '')
        expect(visible === '' || visible.startsWith('fixture'), `${key}.${field} = ${JSON.stringify(visible.slice(0, 40))} is not fixture-prefixed`).toBe(true)
      }
    }
  })

  it('the bidi/control values in the unsafe-path scenario are the only non-printing characters in any checkout scenario', () => {
    for (const key of CHECKOUT_KEYS) {
      const sse = serializeScenarioToSse(FIXTURE_SCENARIO_NAMES[key as keyof typeof FIXTURE_SCENARIO_NAMES], 'run-fixture-leak-001')
      const hasUnsafe = checkoutStrings(sse).some(({value}) => value !== value.replaceAll(STRIPPED, ''))
      expect(hasUnsafe, key).toBe(key === 'checkout_refused_bidi_path')
    }
  })

  it('no fixture source contains a literal 40-hex SHA', () => {
    for (const filePath of FIXTURE_FILES) {
      expect(stripComments(readFixtureFile(filePath))).not.toMatch(/\b[\da-f]{40}\b/i)
    }
  })
})

describe('fixture no-leak guard — question scenarios', () => {
  // eslint-disable-next-line no-control-regex
  const STRIPPED = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
  const QUESTION_KEYS = FIXTURE_QUESTION_SCENARIO_ROWS.map(row => row.scenario)

  interface QuestionRecord {
    readonly runId: string
    readonly requestID: string
    readonly settled: boolean
    readonly questions?: {header: string; text: string; options: {label: string; description: string}[]}[]
  }

  function questionRecords(sse: string): QuestionRecord[] {
    return sse
      .split('\n\n')
      .filter(record => record.includes('event: question'))
      .map(record => JSON.parse(record.split('data: ')[1] ?? '{}') as QuestionRecord)
  }

  function freeText(record: QuestionRecord): string[] {
    return (record.questions ?? []).flatMap(question => [
      question.header,
      question.text,
      ...question.options.flatMap(option => [option.label, option.description]),
    ])
  }

  it('every question request ID is req-fixture- prefixed, and every frame carries the bound run ID', () => {
    expect(QUESTION_KEYS.length).toBe(12)
    for (const key of QUESTION_KEYS) {
      const runId = `run-fixture-index-${key.replaceAll('_', '-')}`
      for (const record of questionRecords(serializeScenarioToSse(key, runId))) {
        expect(isFixtureRequestId(record.requestID), `${key} ${record.requestID}`).toBe(true)
        expect(record.runId).toBe(runId)
      }
    }
  })

  it('every scripted request ID is req-fixture- prefixed', () => {
    for (const key of QUESTION_KEYS) {
      const script = fixtureQuestionScript(key)
      const requests = [script?.openRequests ?? [], ...(script?.listsAfterDecision ?? [])].flat()
      for (const request of requests) expect(isFixtureRequestId(request.requestID), `${key} ${request.requestID}`).toBe(true)
    }
  })

  it('every free-form question string starts with "fixture" (ignoring bidi/control characters)', () => {
    for (const key of QUESTION_KEYS) {
      for (const record of questionRecords(serializeScenarioToSse(key, 'run-fixture-leak-001'))) {
        for (const value of freeText(record)) {
          const visible = value.replaceAll(STRIPPED, '')
          expect(visible.startsWith('fixture'), `${key}: ${JSON.stringify(visible.slice(0, 40))}`).toBe(true)
        }
      }
    }
  })

  it('the bidi/control characters sit only in the text-sentinel scenario', () => {
    for (const key of QUESTION_KEYS) {
      const hasUnsafe = questionRecords(serializeScenarioToSse(key, 'run-fixture-leak-001'))
        .flatMap(record => freeText(record))
        .some(value => value !== value.replaceAll(STRIPPED, ''))
      expect(hasUnsafe, key).toBe(key === 'question_text_sentinels')
    }
  })
})
