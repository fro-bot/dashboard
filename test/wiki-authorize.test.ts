import {describe, expect, it} from 'vitest'
import {
  isJsonContentType,
  operatorRateLimitKey,
  originMatches,
  resolveWriteAccess,
  type IdentityPolicy,
  type WikiSession,
} from '../src/wiki/authorize.ts'

const ORIGIN = 'https://dashboard.fro.bot'
const ENABLED = {enabled: true, operatorId: 12345, dashboardOrigin: ORIGIN} as const

function policy(overrides: Partial<IdentityPolicy> = {}): IdentityPolicy {
  return {capability: ENABLED, fixtureOperatorLogin: null, ...overrides}
}

const gateway = (operatorId: number, login = 'octocat'): WikiSession => ({kind: 'gateway', operatorId, login})
const arctic = (login = 'octocat'): WikiSession => ({kind: 'arctic', login})

describe('resolveWriteAccess: identity matrix', () => {
  it('lets a gateway session whose operator ID equals the configured ID write', () => {
    expect(resolveWriteAccess(policy(), gateway(12345))).toEqual({canWrite: true})
  })

  it('ignores the login: the numeric ID decides', () => {
    expect(resolveWriteAccess(policy(), gateway(12345, 'someone-else'))).toEqual({canWrite: true})
    expect(resolveWriteAccess(policy(), gateway(99999, 'octocat'))).toEqual({canWrite: false, reason: 'not-operator'})
  })

  it.each([0, -1, 12346, 1])('refuses a gateway session with operator ID %d', operatorId => {
    expect(resolveWriteAccess(policy(), gateway(operatorId))).toEqual({canWrite: false, reason: 'not-operator'})
  })

  it('refuses a plain Arctic OAuth session, even for the configured operator login', () => {
    expect(resolveWriteAccess(policy(), arctic('octocat'))).toEqual({canWrite: false, reason: 'session-not-supported'})
  })

  it('lets an Arctic session write only when the fixture login matches', () => {
    const fixture = policy({fixtureOperatorLogin: 'octocat'})

    expect(resolveWriteAccess(fixture, arctic('octocat'))).toEqual({canWrite: true})
    expect(resolveWriteAccess(fixture, arctic('mallory'))).toEqual({canWrite: false, reason: 'not-operator'})
  })

  it('does not let the fixture login stand in for a gateway identity', () => {
    const fixture = policy({fixtureOperatorLogin: 'octocat'})

    expect(resolveWriteAccess(fixture, gateway(99999, 'octocat'))).toEqual({canWrite: false, reason: 'not-operator'})
  })

  it('compares the fixture login exactly', () => {
    const fixture = policy({fixtureOperatorLogin: 'octocat'})

    expect(resolveWriteAccess(fixture, arctic('Octocat')).canWrite).toBe(false)
    expect(resolveWriteAccess(fixture, arctic('octocat ')).canWrite).toBe(false)
  })

  it('refuses a gateway session when the capability has no operator ID, even with a fixture login', () => {
    const capability = {enabled: true, operatorId: null, dashboardOrigin: ORIGIN} as const

    expect(resolveWriteAccess(policy({capability, fixtureOperatorLogin: 'octocat'}), gateway(12345))).toEqual({
      canWrite: false,
      reason: 'not-operator',
    })
  })

  it.each([
    ['app-credentials-absent'],
    ['app-credentials-incomplete'],
    ['operator-id-unset'],
  ] as const)('reports %s when write capability is off, whoever the session is', reason => {
    const off = policy({capability: {enabled: false, reason}, fixtureOperatorLogin: 'octocat'})

    for (const session of [gateway(12345), arctic('octocat')]) {
      expect(resolveWriteAccess(off, session)).toEqual({canWrite: false, reason})
    }
  })

  it('refuses a missing session', () => {
    expect(resolveWriteAccess(policy(), null).canWrite).toBe(false)
  })
})

describe('originMatches', () => {
  it('accepts only the exact configured origin', () => {
    expect(originMatches(ORIGIN, ORIGIN)).toBe(true)
  })

  it.each([
    ['a missing header', undefined],
    ['the string null', 'null'],
    ['an empty header', ''],
    ['another host', 'https://evil.example'],
    ['a different port', 'https://dashboard.fro.bot:8443'],
    ['a different scheme', 'http://dashboard.fro.bot'],
    ['a subdomain', 'https://x.dashboard.fro.bot'],
    ['a look-alike suffix', 'https://dashboard.fro.bot.evil.example'],
    ['a trailing slash', 'https://dashboard.fro.bot/'],
    ['a different case', 'https://Dashboard.fro.bot'],
    ['leading whitespace', ' https://dashboard.fro.bot'],
    ['a path', 'https://dashboard.fro.bot/wiki'],
  ])('refuses %s', (_label, header) => {
    expect(originMatches(header, ORIGIN)).toBe(false)
  })

  it('refuses everything when no origin is configured', () => {
    expect(originMatches(ORIGIN, '')).toBe(false)
  })
})

describe('isJsonContentType', () => {
  it.each(['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON', ' application/json ;charset=UTF-8'])(
    'accepts %j',
    value => {
      expect(isJsonContentType(value)).toBe(true)
    },
  )

  it.each([
    undefined,
    '',
    'text/plain',
    'text/plain; application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'application/json-patch+json',
    'application/jsonp',
    'application/ld+json',
    'application/json/extra',
  ])('refuses %j', value => {
    expect(isJsonContentType(value)).toBe(false)
  })
})

describe('operatorRateLimitKey', () => {
  it('keys a gateway session by its operator ID in a separate key space', () => {
    expect(operatorRateLimitKey(gateway(12345))).toBe('operator:12345')
  })

  it('keys an Arctic session by login, distinct from any numeric ID', () => {
    expect(operatorRateLimitKey(arctic('octocat'))).toBe('operator:login:octocat')
    expect(operatorRateLimitKey(arctic('12345'))).not.toBe(operatorRateLimitKey(gateway(12345)))
  })

  it('never collides with an IP address key', () => {
    expect(operatorRateLimitKey(gateway(1)).includes('.')).toBe(false)
    expect(operatorRateLimitKey(gateway(1)).startsWith('operator:')).toBe(true)
  })
})
