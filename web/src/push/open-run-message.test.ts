import {describe, expect, it} from 'vitest'
import {OPEN_RUN_MESSAGE_TYPE, parseOpenRunMessage} from './open-run-message.ts'

describe('parseOpenRunMessage', () => {
  it('accepts exactly {type: "OPEN_RUN", runId} with a runId that matches the run ID pattern', () => {
    expect(OPEN_RUN_MESSAGE_TYPE).toBe('OPEN_RUN')
    expect(parseOpenRunMessage({type: 'OPEN_RUN', runId: 'run_A-1'})).toEqual({runId: 'run_A-1'})
    expect(parseOpenRunMessage({type: 'OPEN_RUN', runId: 'a'.repeat(128)})).toEqual({runId: 'a'.repeat(128)})
  })

  it('accepts a null-prototype plain object', () => {
    const data = Object.assign(Object.create(null) as Record<string, unknown>, {type: 'OPEN_RUN', runId: 'run-1'})
    expect(parseOpenRunMessage(data)).toEqual({runId: 'run-1'})
  })

  const notObjects: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'OPEN_RUN'],
    ['a number', 7],
    ['an array', ['OPEN_RUN', 'run-1']],
    ['a function', () => ({type: 'OPEN_RUN', runId: 'run-1'})],
    ['a class instance', new (class Msg {
      type = 'OPEN_RUN'
      runId = 'run-1'
    })()],
  ]
  it.each(notObjects)('rejects %s', (_label, data) => {
    expect(parseOpenRunMessage(data)).toBeNull()
  })

  const badShapes: [string, unknown][] = [
    ['a wrong type', {type: 'PUSH_SUBSCRIPTION_CHANGE', runId: 'run-1'}],
    ['a lower-case type', {type: 'open_run', runId: 'run-1'}],
    ['a missing type', {runId: 'run-1'}],
    ['a missing runId', {type: 'OPEN_RUN'}],
    ['an extra key', {type: 'OPEN_RUN', runId: 'run-1', route: '/x'}],
    ['a numeric runId', {type: 'OPEN_RUN', runId: 12}],
    ['an empty runId', {type: 'OPEN_RUN', runId: ''}],
    ['an over-long runId', {type: 'OPEN_RUN', runId: 'a'.repeat(129)}],
    ['a runId with a slash', {type: 'OPEN_RUN', runId: 'a/b'}],
    ['a runId with a dot', {type: 'OPEN_RUN', runId: 'a.b'}],
    ['a runId with a percent escape', {type: 'OPEN_RUN', runId: '%41'}],
    ['a runId with whitespace', {type: 'OPEN_RUN', runId: 'run 1'}],
    ['a runId with a trailing newline', {type: 'OPEN_RUN', runId: 'run-1\n'}],
  ]
  it.each(badShapes)('rejects %s', (_label, data) => {
    expect(parseOpenRunMessage(data)).toBeNull()
  })

  it('does not read inherited or accessor properties', () => {
    const inherited = Object.create({type: 'OPEN_RUN', runId: 'run-1'}) as unknown
    expect(parseOpenRunMessage(inherited)).toBeNull()

    let reads = 0
    const accessor = {
      get type() {
        reads++
        return 'OPEN_RUN'
      },
      runId: 'run-1',
    }
    expect(parseOpenRunMessage(accessor)).toBeNull()
    expect(reads).toBe(0)
  })
})
