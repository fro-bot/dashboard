import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {handleNotificationClick, type ClickClients, type ClickWindowClient} from './notification-click.ts'

const RUN_ID = '3f2b9c1e-7a4d-4e8b-9c55-0d1e2f3a4b5c'

interface FakeClient extends ClickWindowClient {
  readonly focusCalls: number[]
  readonly messages: unknown[]
  /** Whether the worker controls this window. The real WindowClient has no such flag; matchAll filters on it. */
  readonly controlled: boolean
}

function makeClient(
  url: string,
  options: {focused?: boolean; visibilityState?: string; focusRejects?: boolean; controlled?: boolean} = {},
): FakeClient {
  const focusCalls: number[] = []
  const messages: unknown[] = []
  return {
    url,
    focused: options.focused ?? false,
    visibilityState: options.visibilityState ?? 'hidden',
    focusCalls,
    messages,
    controlled: options.controlled ?? true,
    focus: () => {
      focusCalls.push(1)
      return options.focusRejects === true ? Promise.reject(new Error('focus denied')) : Promise.resolve(undefined)
    },
    postMessage: (message: unknown) => {
      messages.push(message)
    },
  }
}

function makeClients(windowClients: readonly (ClickWindowClient & {readonly controlled?: boolean})[]) {
  const opened: string[] = []
  const matchAllOptions: unknown[] = []
  const clients: ClickClients = {
    matchAll: options => {
      matchAllOptions.push(options)
      // Like the real API: uncontrolled windows only come back when asked for.
      return Promise.resolve(windowClients.filter(client => options.includeUncontrolled || client.controlled !== false))
    },
    openWindow: url => {
      opened.push(url)
      return Promise.resolve(undefined)
    },
  }
  return {clients, opened, matchAllOptions}
}

const questionData = (runId: unknown) => ({type: 'question', route: '/', runId})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('handleNotificationClick: question with a valid runId', () => {
  it('opens /#<runId> when there is no app window', async () => {
    const {clients, opened} = makeClients([])
    await handleNotificationClick(clients, questionData(RUN_ID))
    expect(opened).toEqual([`/#${RUN_ID}`])
  })

  it('focuses the focused app window and posts exactly one OPEN_RUN message to it, opening nothing', async () => {
    const focused = makeClient('https://dash.example/', {focused: true, visibilityState: 'visible'})
    const visible = makeClient('https://dash.example/', {visibilityState: 'visible'})
    const hidden = makeClient('https://dash.example/', {visibilityState: 'hidden'})
    const {clients, opened} = makeClients([hidden, visible, focused])

    await handleNotificationClick(clients, questionData(RUN_ID))

    expect(focused.focusCalls).toHaveLength(1)
    expect(focused.messages).toEqual([{type: 'OPEN_RUN', runId: RUN_ID}])
    expect(visible.focusCalls).toHaveLength(0)
    expect(visible.messages).toEqual([])
    expect(hidden.focusCalls).toHaveLength(0)
    expect(hidden.messages).toEqual([])
    expect(opened).toEqual([])
  })

  it('prefers a visible app window over a hidden one when none is focused', async () => {
    const hidden = makeClient('https://dash.example/', {visibilityState: 'hidden'})
    const visible = makeClient('https://dash.example/', {visibilityState: 'visible'})
    const {clients, opened} = makeClients([hidden, visible])

    await handleNotificationClick(clients, questionData(RUN_ID))

    expect(visible.messages).toEqual([{type: 'OPEN_RUN', runId: RUN_ID}])
    expect(hidden.messages).toEqual([])
    expect(opened).toEqual([])
  })

  it('focuses and messages a hidden-only app window', async () => {
    const hidden = makeClient('https://dash.example/', {visibilityState: 'hidden'})
    const {clients, opened} = makeClients([hidden])

    await handleNotificationClick(clients, questionData(RUN_ID))

    expect(hidden.focusCalls).toHaveLength(1)
    expect(hidden.messages).toEqual([{type: 'OPEN_RUN', runId: RUN_ID}])
    expect(opened).toEqual([])
  })

  it('counts an app window whose URL carries a hash or query (pathname is still /)', async () => {
    const app = makeClient('https://dash.example/?x=1#some-run', {visibilityState: 'visible'})
    const {clients, opened} = makeClients([app])

    await handleNotificationClick(clients, questionData(RUN_ID))

    expect(app.messages).toEqual([{type: 'OPEN_RUN', runId: RUN_ID}])
    expect(opened).toEqual([])
  })

  it('opens /#<runId> when the only window is /privacy, and posts nothing to it', async () => {
    const privacy = makeClient('https://dash.example/privacy', {focused: true, visibilityState: 'visible'})
    const {clients, opened} = makeClients([privacy])

    await handleNotificationClick(clients, questionData(RUN_ID))

    expect(opened).toEqual([`/#${RUN_ID}`])
    expect(privacy.messages).toEqual([])
    expect(privacy.focusCalls).toHaveLength(0)
  })

  it('ignores non-app windows (/privacy, /operator) when an app window also exists', async () => {
    const privacy = makeClient('https://dash.example/privacy', {focused: true, visibilityState: 'visible'})
    const operator = makeClient('https://dash.example/operator', {visibilityState: 'visible'})
    const app = makeClient('https://dash.example/', {visibilityState: 'hidden'})
    const {clients, opened} = makeClients([privacy, operator, app])

    await handleNotificationClick(clients, questionData(RUN_ID))

    expect(app.messages).toEqual([{type: 'OPEN_RUN', runId: RUN_ID}])
    expect(privacy.messages).toEqual([])
    expect(operator.messages).toEqual([])
    expect(opened).toEqual([])
  })

  it('ignores a client whose URL cannot be parsed', async () => {
    const broken = makeClient('not a url', {focused: true, visibilityState: 'visible'})
    const {clients, opened} = makeClients([broken])

    await handleNotificationClick(clients, questionData(RUN_ID))

    expect(broken.messages).toEqual([])
    expect(opened).toEqual([`/#${RUN_ID}`])
  })

  it('still posts the message when focus() rejects', async () => {
    const app = makeClient('https://dash.example/', {focused: true, visibilityState: 'visible', focusRejects: true})
    const {clients, opened} = makeClients([app])

    await expect(handleNotificationClick(clients, questionData(RUN_ID))).resolves.toBeUndefined()

    expect(app.focusCalls).toHaveLength(1)
    expect(app.messages).toEqual([{type: 'OPEN_RUN', runId: RUN_ID}])
    expect(opened).toEqual([])
  })

  it('asks only for controlled window clients, the only ones that can receive the message', async () => {
    const {clients, matchAllOptions} = makeClients([])
    await handleNotificationClick(clients, questionData(RUN_ID))
    expect(matchAllOptions).toEqual([{type: 'window', includeUncontrolled: false}])
  })

  it('opens /#<runId> when the only app window is uncontrolled: no focus, no message to a window that would drop it', async () => {
    const uncontrolled = makeClient('https://dash.example/', {focused: true, visibilityState: 'visible', controlled: false})
    const {clients, opened} = makeClients([uncontrolled])

    await handleNotificationClick(clients, questionData(RUN_ID))

    expect(opened).toEqual([`/#${RUN_ID}`])
    expect(uncontrolled.focusCalls).toHaveLength(0)
    expect(uncontrolled.messages).toEqual([])
  })

  it('messages the controlled app window even when an uncontrolled one is focused', async () => {
    const uncontrolled = makeClient('https://dash.example/', {focused: true, visibilityState: 'visible', controlled: false})
    const controlled = makeClient('https://dash.example/', {visibilityState: 'hidden'})
    const {clients, opened} = makeClients([uncontrolled, controlled])

    await handleNotificationClick(clients, questionData(RUN_ID))

    expect(controlled.focusCalls).toHaveLength(1)
    expect(controlled.messages).toEqual([{type: 'OPEN_RUN', runId: RUN_ID}])
    expect(uncontrolled.focusCalls).toHaveLength(0)
    expect(uncontrolled.messages).toEqual([])
    expect(opened).toEqual([])
  })
})

describe('handleNotificationClick: other types focus an app window and never post a message', () => {
  for (const type of ['approval', 'run_failed'] as const) {
    it(`${type}: focuses the focused window and posts no message`, async () => {
      const focused = makeClient('https://dash.example/', {focused: true, visibilityState: 'visible'})
      const other = makeClient('https://dash.example/', {visibilityState: 'visible'})
      const {clients, opened} = makeClients([other, focused])

      await handleNotificationClick(clients, {type, route: '/'})

      expect(focused.focusCalls).toHaveLength(1)
      expect(other.focusCalls).toHaveLength(0)
      expect(focused.messages).toEqual([])
      expect(other.messages).toEqual([])
      expect(opened).toEqual([])
    })

    it(`${type}: falls back to a visible app window, then to a hidden-only app window, opening nothing`, async () => {
      const hiddenFirst = makeClient('https://dash.example/', {visibilityState: 'hidden'})
      const visible = makeClient('https://dash.example/', {visibilityState: 'visible'})
      const first = makeClients([hiddenFirst, visible])
      await handleNotificationClick(first.clients, {type, route: '/'})
      expect(visible.focusCalls).toHaveLength(1)
      expect(hiddenFirst.focusCalls).toHaveLength(0)
      expect(visible.messages).toEqual([])
      expect(first.opened).toEqual([])

      const hidden = makeClient('https://dash.example/', {visibilityState: 'hidden'})
      const second = makeClients([hidden])
      await handleNotificationClick(second.clients, {type, route: '/'})
      expect(hidden.focusCalls).toHaveLength(1)
      expect(hidden.messages).toEqual([])
      expect(second.opened).toEqual([])
    })

    it(`${type}: a /privacy-only window is never focused; opens /`, async () => {
      const privacy = makeClient('https://dash.example/privacy', {focused: true, visibilityState: 'visible'})
      const {clients, opened} = makeClients([privacy])

      await handleNotificationClick(clients, {type, route: '/'})

      expect(privacy.focusCalls).toHaveLength(0)
      expect(privacy.messages).toEqual([])
      expect(opened).toEqual(['/'])
    })

    it(`${type}: skips non-app windows and focuses the app window`, async () => {
      const privacy = makeClient('https://dash.example/privacy', {focused: true, visibilityState: 'visible'})
      const app = makeClient('https://dash.example/', {visibilityState: 'hidden'})
      const {clients, opened} = makeClients([privacy, app])

      await handleNotificationClick(clients, {type, route: '/'})

      expect(app.focusCalls).toHaveLength(1)
      expect(privacy.focusCalls).toHaveLength(0)
      expect(opened).toEqual([])
    })

    it(`${type}: ignores a runId in its data`, async () => {
      const {clients, opened} = makeClients([])
      await handleNotificationClick(clients, {type, route: '/', runId: RUN_ID})
      expect(opened).toEqual(['/'])
    })
  }

  for (const type of ['approval', 'run_failed'] as const) {
    it(`${type}: keeps looking at uncontrolled windows too, and focuses an uncontrolled-only app window`, async () => {
      const uncontrolled = makeClient('https://dash.example/', {visibilityState: 'visible', controlled: false})
      const {clients, opened, matchAllOptions} = makeClients([uncontrolled])

      await handleNotificationClick(clients, {type, route: '/'})

      expect(matchAllOptions).toEqual([{type: 'window', includeUncontrolled: true}])
      expect(uncontrolled.focusCalls).toHaveLength(1)
      expect(uncontrolled.messages).toEqual([])
      expect(opened).toEqual([])
    })
  }

  it('a question without a valid runId keeps looking at uncontrolled windows too', async () => {
    const uncontrolled = makeClient('https://dash.example/', {visibilityState: 'visible', controlled: false})
    const {clients, opened, matchAllOptions} = makeClients([uncontrolled])

    await handleNotificationClick(clients, questionData('../x'))

    expect(matchAllOptions).toEqual([{type: 'window', includeUncontrolled: true}])
    expect(uncontrolled.focusCalls).toHaveLength(1)
    expect(uncontrolled.messages).toEqual([])
    expect(opened).toEqual([])
  })

  it('a notification shown by the previous SW (data without runId) opens /', async () => {
    const {clients, opened} = makeClients([])
    await handleNotificationClick(clients, {type: 'question', route: '/'})
    expect(opened).toEqual(['/'])
  })

  it('a notification shown by the previous SW never focuses a /privacy-only window', async () => {
    const privacy = makeClient('https://dash.example/privacy', {focused: true, visibilityState: 'visible'})
    const {clients, opened} = makeClients([privacy])
    await handleNotificationClick(clients, {type: 'question', route: '/'})
    expect(privacy.focusCalls).toHaveLength(0)
    expect(opened).toEqual(['/'])
  })

  it('missing, null, or non-object notification data opens /', async () => {
    for (const data of [undefined, null, 'question', 42, [], {}]) {
      const {clients, opened} = makeClients([])
      await handleNotificationClick(clients, data)
      expect(opened).toEqual(['/'])
    }
  })
})

describe('handleNotificationClick: a question without a valid runId falls back to /', () => {
  const invalid: [string, unknown][] = [
    ['missing', undefined],
    ['129 characters', 'a'.repeat(129)],
    ['empty', ''],
    ['path traversal', '../x'],
    ['slash', 'a/b'],
    ['percent-encoded slash', '%2F'],
    ['space', 'has space'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['non-string', 12345],
    ['non-ASCII word character', 'r\u00e9sum\u00e9'],
  ]

  for (const [name, runId] of invalid) {
    it(`${name} opens / and posts no message`, async () => {
      const app = makeClient('https://dash.example/', {focused: true, visibilityState: 'visible'})
      const none = makeClients([])
      await handleNotificationClick(none.clients, questionData(runId))
      expect(none.opened).toEqual(['/'])

      const withApp = makeClients([app])
      await handleNotificationClick(withApp.clients, questionData(runId))
      expect(app.messages).toEqual([])
      expect(app.focusCalls).toHaveLength(1)
      expect(withApp.opened).toEqual([])

      const privacy = makeClient('https://dash.example/privacy', {focused: true, visibilityState: 'visible'})
      const privacyOnly = makeClients([privacy])
      await handleNotificationClick(privacyOnly.clients, questionData(runId))
      expect(privacy.focusCalls).toHaveLength(0)
      expect(privacy.messages).toEqual([])
      expect(privacyOnly.opened).toEqual(['/'])
    })
  }

  it('accepts a 128-character runId', async () => {
    const runId = 'a'.repeat(128)
    const {clients, opened} = makeClients([])
    await handleNotificationClick(clients, questionData(runId))
    expect(opened).toEqual([`/#${runId}`])
  })
})

describe('no run-ID logging', () => {
  it('makes no console.* calls while resolving a click, including a rejecting focus', async () => {
    const spies = (['debug', 'error', 'info', 'log', 'trace', 'warn'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    const app = makeClient('https://dash.example/', {focused: true, visibilityState: 'visible', focusRejects: true})

    await handleNotificationClick(makeClients([app]).clients, questionData(RUN_ID))
    await handleNotificationClick(makeClients([]).clients, questionData(RUN_ID))
    await handleNotificationClick(makeClients([]).clients, questionData('../x'))

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('has no console.* calls in its source', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'notification-click.ts'), 'utf8')
    expect(source).not.toMatch(/console\.\w+\(/)
  })
})
