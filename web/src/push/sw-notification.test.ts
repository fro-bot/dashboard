import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'
import {buildNotification, KNOWN_FAILURE_LABELS} from './sw-notification.ts'

/**
 * Payloads exactly as the gateway serializes them: top-level `title`/`body`
 * are i18n keys, and `type`/`route`/`failureLabel` live under `data`.
 */
const WIRE = {
  approval: {
    title: 'operator.approval_needed.title',
    body: 'operator.approval_needed.body',
    data: {type: 'approval', route: '/'},
  },
  question: {
    title: 'operator.question_pending.title',
    body: 'operator.question_pending.body',
    data: {type: 'question', route: '/'},
  },
  runFailedWithLabel: (failureLabel: string) => ({
    title: 'operator.run_failed.title',
    body: 'operator.run_failed.body',
    data: {type: 'run_failed', route: '/', failureLabel},
  }),
  runFailedNoLabel: {
    title: 'operator.run_failed.title',
    body: 'operator.run_failed.body',
    data: {type: 'run_failed', route: '/'},
  },
} as const

const GENERIC = {
  title: 'Fro Bot',
  body: 'You have a new notification.',
  data: {type: 'unknown', route: '/'},
}

describe('buildNotification (wire payload shape)', () => {
  it('approval: nested payload renders fixed "Approval needed" copy', () => {
    expect(buildNotification(WIRE.approval)).toEqual({
      title: 'Approval needed',
      body: 'A run is waiting for your approval.',
      data: {type: 'approval', route: '/'},
    })
  })

  it('question: nested payload renders fixed "Answer needed" copy', () => {
    expect(buildNotification(WIRE.question)).toEqual({
      title: 'Answer needed',
      body: 'A run is waiting for your answer.',
      data: {type: 'question', route: '/'},
    })
  })

  it('run_failed with a known allowlisted failureLabel renders that label', () => {
    expect(KNOWN_FAILURE_LABELS.size).toBeGreaterThan(0)
    for (const label of KNOWN_FAILURE_LABELS) {
      const result = buildNotification(WIRE.runFailedWithLabel(label))
      expect(result).toEqual({
        title: 'Run failed',
        body: `A run failed: ${label}.`,
        data: {type: 'run_failed', route: '/'},
      })
    }
  })

  it('run_failed with an unknown failureLabel renders generic run-failed copy and never the label', () => {
    // 'stream-ended' is a real gateway OperatorFailureKind that the dashboard does not allowlist.
    for (const label of ['stream-ended', 'session-error', 'sql-injection-attempt']) {
      const result = buildNotification(WIRE.runFailedWithLabel(label))
      expect(result).toEqual({
        title: 'Run failed',
        body: 'A run failed.',
        data: {type: 'run_failed', route: '/'},
      })
      expect(JSON.stringify(result)).not.toContain(label)
    }
  })

  it('run_failed without a failureLabel renders generic run-failed copy', () => {
    expect(buildNotification(WIRE.runFailedNoLabel)).toEqual({
      title: 'Run failed',
      body: 'A run failed.',
      data: {type: 'run_failed', route: '/'},
    })
  })

  it('i18n keys in top-level title/body are never rendered', () => {
    const payloads = [
      WIRE.approval,
      WIRE.question,
      WIRE.runFailedNoLabel,
      WIRE.runFailedWithLabel('timeout'),
      WIRE.runFailedWithLabel('stream-ended'),
    ]
    for (const payload of payloads) {
      const serialized = JSON.stringify(buildNotification(payload))
      expect(serialized).not.toContain('operator.')
      expect(serialized).not.toContain(payload.title)
      expect(serialized).not.toContain(payload.body)
    }
  })

  it('top-level title/body are never rendered even when they are hostile free text', () => {
    const result = buildNotification({
      title: 'SENTINEL-title-77c1',
      body: 'SENTINEL-body-77c1',
      data: {type: 'approval', route: '/'},
    })
    expect(result.title).toBe('Approval needed')
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
  })

  it('legacy flat shape {type} (never sent by the gateway) renders the generic fallback', () => {
    expect(buildNotification({type: 'approval'})).toEqual(GENERIC)
    expect(buildNotification({type: 'question'})).toEqual(GENERIC)
    expect(buildNotification({type: 'run_failed', failureLabel: 'timeout'})).toEqual(GENERIC)
  })

  it('data missing, null, array, string, number, or boolean renders the generic fallback', () => {
    const base = {title: 'operator.approval_needed.title', body: 'operator.approval_needed.body'}
    expect(buildNotification(base)).toEqual(GENERIC)
    expect(buildNotification({...base, data: null})).toEqual(GENERIC)
    expect(buildNotification({...base, data: [{type: 'approval', route: '/'}]})).toEqual(GENERIC)
    expect(buildNotification({...base, data: 'approval'})).toEqual(GENERIC)
    expect(buildNotification({...base, data: 42})).toEqual(GENERIC)
    expect(buildNotification({...base, data: true})).toEqual(GENERIC)
  })

  it('data with an unknown or non-string type renders the generic fallback', () => {
    expect(buildNotification({...WIRE.approval, data: {type: 'delete_everything', route: '/'}})).toEqual(GENERIC)
    expect(buildNotification({...WIRE.approval, data: {type: 42, route: '/'}})).toEqual(GENERIC)
    expect(buildNotification({...WIRE.approval, data: {route: '/'}})).toEqual(GENERIC)
  })

  it('empty/undecodable payload renders the generic fallback', () => {
    expect(buildNotification(undefined)).toEqual(GENERIC)
    expect(buildNotification(null)).toEqual(GENERIC)
    expect(buildNotification('not an object')).toEqual(GENERIC)
    expect(buildNotification(42)).toEqual(GENERIC)
    expect(buildNotification([])).toEqual(GENERIC)
    expect(buildNotification({})).toEqual(GENERIC)
  })

  it('a non-string failureLabel is discarded', () => {
    const result = buildNotification({...WIRE.runFailedNoLabel, data: {type: 'run_failed', route: '/', failureLabel: 7}})
    expect(result.body).toBe('A run failed.')
  })

  it('a top-level failureLabel/type outside data is ignored', () => {
    const result = buildNotification({
      type: 'approval',
      failureLabel: 'timeout',
      data: {type: 'run_failed', route: '/'},
    })
    expect(result.title).toBe('Run failed')
    expect(result.body).toBe('A run failed.')
  })

  it('privacy: extra wire fields are never reflected', () => {
    const sentinel = 'SENTINEL-question-text-9f3a'
    const result = buildNotification({
      title: sentinel,
      body: sentinel,
      text: sentinel,
      repo: 'fro-bot/secret-repo',
      prompt: 'do something secret',
      command: 'rm -rf /',
      endpoint: 'https://push.example.com/secret-endpoint',
      keys: {p256dh: 'abc', auth: 'def'},
      data: {
        type: 'run_failed',
        route: '/elsewhere',
        failureLabel: 'timeout',
        runId: sentinel,
        question: sentinel,
        options: [{label: sentinel}],
        failureKind: 'raw-internal-kind',
      },
    })
    expect(result).toEqual({
      title: 'Run failed',
      body: 'A run failed: timeout.',
      data: {type: 'run_failed', route: '/'},
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(sentinel)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('elsewhere')
    expect(serialized).not.toContain('rm -rf')
    expect(serialized).not.toContain('raw-internal-kind')
    expect(serialized).not.toContain('push.example.com')
    expect(serialized).not.toContain('p256dh')
  })

  it('invariant: output data is exactly {type, route: "/"} even when wire data carries route and runId', () => {
    const wires = [
      {...WIRE.approval, data: {type: 'approval', route: '/operator#abc', runId: 'run-123'}},
      {...WIRE.question, data: {type: 'question', route: '/operator#abc', runId: 'run-123'}},
      {
        ...WIRE.runFailedNoLabel,
        data: {type: 'run_failed', route: '/operator#abc', runId: 'run-123', failureLabel: 'timeout'},
      },
    ]
    for (const wire of wires) {
      const result = buildNotification(wire)
      expect(Object.keys(result.data).sort()).toEqual(['route', 'type'])
      expect(result.data.route).toBe('/')
      expect(JSON.stringify(result)).not.toContain('abc')
      expect(JSON.stringify(result)).not.toContain('run-123')
    }

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
