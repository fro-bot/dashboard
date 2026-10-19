/**
 * Behavioral tests for a launch that resolves after the launch UI was torn down
 * (resetLaunchState). The submit path must not insert a card, hand the run to the runtime,
 * attach a stream or announce success on a page that no longer owns them, and it must still
 * release the submit lock so a later mount can launch.
 */

import {afterEach, describe, expect, it, vi} from 'vitest'

type LaunchModule = typeof import('../../../public/operator-launch.js')

// The specifier initOperatorLaunch imports (the core test pins streamModuleSpecifier() to it).
const STREAM_SPECIFIER = '/static/operator-stream.js?manual=1'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

describe('launch resolving after teardown', () => {
  let launchModule: LaunchModule | undefined

  afterEach(() => {
    launchModule?.resetLaunchState()
    launchModule = undefined
    document.body.innerHTML = ''
    vi.doUnmock(STREAM_SPECIFIER)
    vi.unstubAllGlobals()
  })

  /** Mount the launch UI over a POST the test settles by hand. */
  async function mount(options: {withCallback: boolean}) {
    const initOperatorStream = vi.fn()
    vi.doMock(STREAM_SPECIFIER, () => ({
      initOperatorStream,
      takeUsableFinishedRun: vi.fn(() => undefined),
      pruneFinishedRuns: vi.fn(),
      clearFinishedRuns: vi.fn(),
      resetOutputView: vi.fn(),
    }))
    launchModule = await import('../../../public/operator-launch.js')

    const settlers: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.endsWith('/session/csrf')) return jsonResponse(200, {csrfToken: 'tok'})
      if (input.endsWith('/repos')) return jsonResponse(200, [{owner: 'fro-bot', repo: 'agent'}])
      if (input.endsWith('/runs')) {
        return new Promise<Response>(resolve => {
          settlers.push(resolve)
        })
      }
      return jsonResponse(404, {})
    }))
    document.body.innerHTML = `
      <div id="repo-picker-container"></div>
      <form id="launch-form">
        <textarea id="launch-prompt" name="prompt"></textarea>
        <div id="launch-prompt-status" role="status"></div>
        <div id="launch-error" role="alert" hidden></div>
        <button type="submit">Launch</button>
      </form>
      <div data-role="run-index-list"></div>`

    const onRunLaunched = vi.fn()
    const mountInit = () => launchModule?.initOperatorLaunch(options.withCallback ? {onRunLaunched} : undefined)
    await mountInit()

    const form = document.querySelector<HTMLFormElement>('#launch-form') as HTMLFormElement
    const textarea = document.querySelector<HTMLTextAreaElement>('#launch-prompt') as HTMLTextAreaElement
    const button = document.querySelector<HTMLButtonElement>('[type="submit"]') as HTMLButtonElement
    const error = document.querySelector<HTMLElement>('#launch-error') as HTMLElement
    const list = document.querySelector<HTMLElement>('[data-role="run-index-list"]') as HTMLElement
    const launchSuccess = vi.fn()
    form.addEventListener('launch-success', launchSuccess)

    return {
      initOperatorStream,
      onRunLaunched,
      launchSuccess,
      button,
      error,
      list,
      remount: async () => { await mountInit() },
      submit: async (prompt = 'a prompt') => {
        textarea.value = prompt
        form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
        await vi.waitFor(() => expect(settlers.length).toBeGreaterThan(0))
        expect(button.disabled).toBe(true)
      },
      teardown: () => launchModule?.resetLaunchState(),
      settle: async (response: Response) => {
        settlers.shift()?.(response)
        // The finally of the submit handler re-enables Launch; everything after it ran by then.
        await vi.waitFor(() => expect(button.disabled).toBe(false))
      },
    }
  }

  it.each([
    ['with the runtime callback', true],
    ['on the legacy path', false],
  ])('a launch that succeeds after teardown attaches nothing %s', async (_name, withCallback) => {
    const m = await mount({withCallback})
    await m.submit()
    m.teardown()

    await m.settle(jsonResponse(202, {runId: 'run-late-001'}))

    expect(m.onRunLaunched).not.toHaveBeenCalled()
    expect(m.initOperatorStream).not.toHaveBeenCalled()
    expect(m.launchSuccess).not.toHaveBeenCalled()
    expect(m.list.children).toHaveLength(0)
  })

  it('a launch that fails after teardown writes no failure copy', async () => {
    const m = await mount({withCallback: true})
    await m.submit()
    m.teardown()

    await m.settle(jsonResponse(500, {}))

    expect(m.error.hidden).toBe(true)
    expect(m.error.textContent).toBe('')
  })

  it('a launch that resolves while the view is still mounted still attaches', async () => {
    const m = await mount({withCallback: true})
    await m.submit()

    await m.settle(jsonResponse(202, {runId: 'run-live-001'}))

    expect(m.onRunLaunched).toHaveBeenCalledTimes(1)
    expect(m.onRunLaunched.mock.calls[0]?.[0]).toBe('run-live-001')
    expect(m.launchSuccess).toHaveBeenCalledTimes(1)
  })

  it('the stale submit still releases the lock, so a remount can launch', async () => {
    const m = await mount({withCallback: true})
    await m.submit()
    m.teardown()
    await m.settle(jsonResponse(202, {runId: 'run-late-002'}))

    await m.remount()
    await m.submit('second prompt')
    await m.settle(jsonResponse(202, {runId: 'run-second-001'}))

    expect(m.onRunLaunched).toHaveBeenCalledTimes(1)
    expect(m.onRunLaunched.mock.calls[0]?.[0]).toBe('run-second-001')
  })
})
