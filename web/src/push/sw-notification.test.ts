import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {FAILURE_REASON_LABELS} from '../../../public/operator-stream.js'
import {buildNotification, KNOWN_FAILURE_LABELS, PUSH_NOTIFICATION_TYPES} from './sw-notification.ts'
import type {
  NoRunNotificationData,
  PlainNotificationData,
  RunNotificationData,
  SafeNotificationData,
} from './sw-notification.ts'

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

  it('run_failed renders the reason body for each gateway failure label', () => {
    const expected = {
      'inactivity-timeout': 'A run failed: no recent activity.',
      'max-duration-timeout': 'A run failed: run timed out.',
      'stream-ended': 'A run failed: stream ended early.',
      'workspace-unreachable': 'A run failed: workspace unreachable.',
      'session-error': 'A run failed: session error.',
    }
    for (const [label, body] of Object.entries(expected)) {
      expect(buildNotification(WIRE.runFailedWithLabel(label))).toEqual({
        title: 'Run failed',
        body,
        data: {type: 'run_failed', route: '/'},
      })
    }
  })

  it('run_failed with the gateway "unknown" label renders generic run-failed copy', () => {
    const result = buildNotification(WIRE.runFailedWithLabel('unknown'))
    expect(result.body).toBe('A run failed.')
    expect(JSON.stringify(result)).not.toContain('unknown')
  })

  it('run_failed with an unrecognized failureLabel renders generic run-failed copy and never the label', () => {
    // Labels the dashboard previously allowlisted, kinds the gateway never pushes,
    // hostile text, and Object.prototype names must all collapse to generic copy.
    const labels = [
      'timeout',
      'error',
      'cancelled',
      'checkout-substituted',
      'workspace-unavailable',
      'sql-injection-attempt',
      'constructor',
      '__proto__',
      'toString',
    ]
    for (const label of labels) {
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
      WIRE.runFailedWithLabel('inactivity-timeout'),
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
    expect(buildNotification({type: 'run_failed', failureLabel: 'stream-ended'})).toEqual(GENERIC)
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
      failureLabel: 'stream-ended',
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
        failureLabel: 'session-error',
        runId: sentinel,
        question: sentinel,
        options: [{label: sentinel}],
        failureKind: 'raw-internal-kind',
      },
    })
    expect(result).toEqual({
      title: 'Run failed',
      body: 'A run failed: session error.',
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
        data: {type: 'run_failed', route: '/operator#abc', runId: 'run-123', failureLabel: 'stream-ended'},
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

describe('question runId (discriminated data)', () => {
  const RUN_ID = '3f2b9c1e-7a4d-4e8b-9c55-0d1e2f3a4b5c'
  const questionWire = (data: Record<string, unknown>) => ({...WIRE.question, data: {type: 'question', ...data}})
  const approvalWire = (data: Record<string, unknown>) => ({...WIRE.approval, data: {type: 'approval', ...data}})

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports the runtime tuple of notification types', () => {
    expect([...PUSH_NOTIFICATION_TYPES].sort()).toEqual(['approval', 'question', 'run_failed'])
  })

  it('a question keeps a valid runId when route is exactly /operator#<runId>', () => {
    expect(buildNotification(questionWire({route: `/operator#${RUN_ID}`, runId: RUN_ID}))).toEqual({
      title: 'Answer needed',
      body: 'A run is waiting for your answer.',
      data: {type: 'question', route: '/', runId: RUN_ID},
    })
  })

  it('a question drops runId when it fails the pattern', () => {
    const bad = ['a'.repeat(129), '', '../x', 'a/b', '%2F', 'has space', 'javascript:alert(1)', 12345, null]
    for (const runId of bad) {
      const result = buildNotification(questionWire({route: `/operator#${String(runId)}`, runId}))
      expect(result.data).toEqual({type: 'question', route: '/'})
      expect(Object.hasOwn(result.data, 'runId')).toBe(false)
    }
  })

  it('a question drops a valid runId when route is not exactly /operator#<runId>', () => {
    const routes = [
      '/',
      '/operator',
      '/operator#',
      `/operator#${RUN_ID}x`,
      `/operator#other`,
      `/operator/#${RUN_ID}`,
      `https://evil.example/operator#${RUN_ID}`,
      `//evil.example/operator#${RUN_ID}`,
      undefined,
      42,
    ]
    for (const route of routes) {
      const result = buildNotification(questionWire({route, runId: RUN_ID}))
      expect(result.data).toEqual({type: 'question', route: '/'})
    }
    expect(buildNotification(questionWire({runId: RUN_ID})).data).toEqual({type: 'question', route: '/'})
  })

  it('run_failed never carries a runId, even when the wire has a matching route', () => {
    const result = buildNotification({data: {type: 'run_failed', route: `/operator#${RUN_ID}`, runId: RUN_ID}})
    expect(Object.hasOwn(result.data, 'runId')).toBe(false)
    expect(JSON.stringify(result)).not.toContain(RUN_ID)
  })

  it('narrows SafeNotificationData: runId is a string only on the run-bearing variant', () => {
    // Compile-time contract (pnpm check-types): each branch assigns to exactly one variant.
    const classify = (data: SafeNotificationData): string => {
      if (data.runId !== undefined) {
        const withRun: RunNotificationData = data
        const runId: string = withRun.runId
        return runId === '' ? 'empty' : `${withRun.type}-run`
      }
      if (data.type === 'question' || data.type === 'approval') {
        const withoutRun: NoRunNotificationData = data
        return `${withoutRun.type}-no-run`
      }
      const plain: PlainNotificationData = data
      return plain.type
    }

    expect(classify(buildNotification(questionWire({route: `/operator#${RUN_ID}`, runId: RUN_ID})).data)).toBe('question-run')
    expect(classify(buildNotification(questionWire({route: '/', runId: '../x'})).data)).toBe('question-no-run')
    expect(classify(buildNotification(approvalWire({route: `/operator#${RUN_ID}`, runId: RUN_ID})).data)).toBe('approval-run')
    expect(classify(buildNotification(WIRE.approval).data)).toBe('approval-no-run')
    expect(classify(buildNotification(WIRE.runFailedNoLabel).data)).toBe('run_failed')
    expect(classify(buildNotification(null).data)).toBe('unknown')
  })

  it('an approval keeps a valid runId when route is exactly /operator#<runId>', () => {
    expect(buildNotification(approvalWire({route: `/operator#${RUN_ID}`, runId: RUN_ID}))).toEqual({
      title: 'Approval needed',
      body: 'A run is waiting for your approval.',
      data: {type: 'approval', route: '/', runId: RUN_ID},
    })
  })

  it('an approval drops runId when it fails the pattern', () => {
    const bad = ['a'.repeat(129), '', '../x', 'a/b', '%2F', 'has space', 'javascript:alert(1)', 12345, null]
    for (const runId of bad) {
      const result = buildNotification(approvalWire({route: `/operator#${String(runId)}`, runId}))
      expect(result.data).toEqual({type: 'approval', route: '/'})
      expect(Object.hasOwn(result.data, 'runId')).toBe(false)
    }
  })

  it('an approval drops a valid runId when route is not exactly /operator#<runId>', () => {
    const routes = [
      '/',
      '/operator',
      '/operator#',
      `/operator#${RUN_ID}x`,
      `/operator#other`,
      `/operator/#${RUN_ID}`,
      `https://evil.example/operator#${RUN_ID}`,
      `//evil.example/operator#${RUN_ID}`,
      undefined,
      42,
    ]
    for (const route of routes) {
      const result = buildNotification(approvalWire({route, runId: RUN_ID}))
      expect(result.data).toEqual({type: 'approval', route: '/'})
      expect(Object.hasOwn(result.data, 'runId')).toBe(false)
    }
    expect(buildNotification(approvalWire({runId: RUN_ID})).data).toEqual({type: 'approval', route: '/'})
  })

  it('an approval with no runId keeps its current shape', () => {
    expect(buildNotification(WIRE.approval).data).toEqual({type: 'approval', route: '/'})
    expect(buildNotification(approvalWire({route: `/operator#${RUN_ID}`})).data).toEqual({type: 'approval', route: '/'})
  })

  it('a top-level runId outside data is ignored', () => {
    const result = buildNotification({runId: RUN_ID, data: {type: 'question', route: `/operator#${RUN_ID}`}})
    expect(result.data).toEqual({type: 'question', route: '/'})
  })

  it('makes no console.* calls', () => {
    const spies = (['debug', 'error', 'info', 'log', 'trace', 'warn'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    buildNotification(questionWire({route: `/operator#${RUN_ID}`, runId: RUN_ID}))
    buildNotification(questionWire({route: '/', runId: '../x'}))
    buildNotification(approvalWire({route: `/operator#${RUN_ID}`, runId: RUN_ID}))
    buildNotification(null)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('failure reason parity with run cards', () => {
  const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)
  const pushKinds = [...KNOWN_FAILURE_LABELS].filter(kind => kind !== 'unknown')

  it('the push allowlist is the gateway push allowlist', () => {
    expect([...KNOWN_FAILURE_LABELS].sort()).toEqual(
      [
        'inactivity-timeout',
        'max-duration-timeout',
        'session-error',
        'stream-ended',
        'unknown',
        'workspace-unreachable',
      ].sort(),
    )
  })

  it('every pushed failure kind has a run-card label', () => {
    expect(pushKinds.length).toBeGreaterThan(0)
    for (const kind of pushKinds) {
      expect(Object.hasOwn(FAILURE_REASON_LABELS, kind), `run-card label missing for ${kind}`).toBe(true)
    }
  })

  it('each push reason is the run-card label for the same kind, lower-cased into a sentence', () => {
    for (const kind of pushKinds) {
      const label = (FAILURE_REASON_LABELS as Record<string, string>)[kind]
      expect(label).toBeTypeOf('string')
      expect(buildNotification({data: {type: 'run_failed', route: '/', failureLabel: kind}}).body).toBe(
        `A run failed: ${lowerFirst(label as string)}.`,
      )
    }
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
