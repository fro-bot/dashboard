import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'
import {buildNotification, KNOWN_FAILURE_LABELS} from './sw-notification.ts'

describe('buildNotification', () => {
  it('happy path: approval payload renders "Approval needed" copy', () => {
    const result = buildNotification({type: 'approval'})
    expect(result.title).toBe('Approval needed')
    expect(result.data).toEqual({type: 'approval', route: '/'})
  })

  it('happy path: run_failed with a known allowlisted failureLabel renders that label', () => {
    for (const label of KNOWN_FAILURE_LABELS) {
      const result = buildNotification({type: 'run_failed', failureLabel: label})
      expect(result.title).toBe('Run failed')
      expect(result.body).toContain(label)
    }
  })

  it('unknown/absent failureLabel renders generic "Run failed" copy', () => {
    const absent = buildNotification({type: 'run_failed'})
    expect(absent.title).toBe('Run failed')
    expect(absent.body).toBe('A run failed.')

    const unknown = buildNotification({type: 'run_failed', failureLabel: 'sql-injection-attempt'})
    expect(unknown.title).toBe('Run failed')
    expect(unknown.body).toBe('A run failed.')
    expect(unknown.body).not.toContain('sql-injection-attempt')
  })

  it('edge case: copy map is exhaustive over known type values', () => {
    const knownTypes = ['approval', 'run_failed'] as const
    for (const type of knownTypes) {
      const result = buildNotification({type})
      expect(result.title.length).toBeGreaterThan(0)
      expect(result.body.length).toBeGreaterThan(0)
    }
  })

  it('edge case: unknown type renders the generic fallback (never no-notification)', () => {
    const result = buildNotification({type: 'delete_everything'})
    expect(result.title).toBe('Fro Bot')
    expect(result.data).toEqual({type: 'unknown', route: '/'})
  })

  it('edge case: empty/undecodable payload renders the generic fallback', () => {
    expect(buildNotification(undefined).title).toBe('Fro Bot')
    expect(buildNotification(null).title).toBe('Fro Bot')
    expect(buildNotification('not an object').title).toBe('Fro Bot')
    expect(buildNotification(42).title).toBe('Fro Bot')
    expect(buildNotification([]).title).toBe('Fro Bot')
    expect(buildNotification({}).title).toBe('Fro Bot')
  })

  it('privacy: rendered title/body/data never contain sensitive payload fields', () => {
    const result = buildNotification({
      type: 'run_failed',
      failureLabel: 'timeout',
      repo: 'fro-bot/secret-repo',
      prompt: 'do something secret',
      path: '/etc/passwd',
      command: 'rm -rf /',
      output: 'sensitive stdout',
      failureKind: 'raw-internal-kind',
      endpoint: 'https://push.example.com/secret-endpoint',
      keys: {p256dh: 'abc', auth: 'def'},
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secret-repo')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('/etc/passwd')
    expect(serialized).not.toContain('rm -rf')
    expect(serialized).not.toContain('sensitive stdout')
    expect(serialized).not.toContain('raw-internal-kind')
    expect(serialized).not.toContain('push.example.com')
    expect(serialized).not.toContain('p256dh')
    expect(serialized).not.toContain('abc')
  })

  it('invariant: data is always exactly {type, route: "/"}', () => {
    const approval = buildNotification({type: 'approval', extraField: 'ignored'})
    expect(Object.keys(approval.data).sort()).toEqual(['route', 'type'])
    expect(approval.data.route).toBe('/')

    const runFailed = buildNotification({type: 'run_failed'})
    expect(Object.keys(runFailed.data).sort()).toEqual(['route', 'type'])
    expect(runFailed.data.route).toBe('/')

    const fallback = buildNotification(null)
    expect(Object.keys(fallback.data).sort()).toEqual(['route', 'type'])
    expect(fallback.data.route).toBe('/')
  })
})

describe('sw-notification.ts privacy source discipline', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'sw-notification.ts'), 'utf8')

  it('has no console.* calls', () => {
    expect(source).not.toMatch(/console\.\w+\(/)
  })

  it('has no I/O (no fetch, no caches, no self.registration references)', () => {
    expect(source).not.toContain('fetch(')
    expect(source).not.toContain('caches.')
    expect(source).not.toContain('self.registration')
  })
})
