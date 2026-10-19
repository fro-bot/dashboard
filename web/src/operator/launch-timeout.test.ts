/**
 * Behavioral tests for the launch request deadline in public/operator-launch.js. They run the real
 * submit path with the stream module import and fetch stubbed, and fake only the timer functions.
 * A request that never settles — the headers, or the body read — must end in the generic launch
 * failure with Launch enabled again.
 */

import {afterEach, describe, expect, it, vi} from 'vitest'

type LaunchModule = typeof import('../../../public/operator-launch.js')

// The specifier initOperatorLaunch imports (the core test pins streamModuleSpecifier() to it).
const STREAM_SPECIFIER = '/static/operator-stream.js?manual=1'

const GENERIC_FAILURE_COPY = 'Launch failed. Please try again.'
const REPO_LIST_NETWORK_COPY = 'Repository list unavailable \u2014 check your connection.'

async function importLaunchModuleWithStreamMock(): Promise<LaunchModule> {
  vi.doMock(STREAM_SPECIFIER, () => ({
    initOperatorStream: vi.fn(),
    takeUsableFinishedRun: vi.fn(() => undefined),
    pruneFinishedRuns: vi.fn(),
    clearFinishedRuns: vi.fn(),
    resetOutputView: vi.fn(),
  }))
  return import('../../../public/operator-launch.js')
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

/** A promise that never settles, as a stalled connection would. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

/** A response whose headers arrived but whose body never settles. */
function stalledBody(status: number): Response {
  return {ok: status >= 200 && status < 300, status, json: () => never<unknown>()} as unknown as Response
}

type Handler = (init: RequestInit) => Response | Promise<Response>

interface Handlers {
  readonly csrf?: Handler
  readonly repos?: Handler
  readonly runs?: Handler
}

describe('launch request deadline', () => {
  let launchModule: LaunchModule | undefined

  afterEach(() => {
    launchModule?.resetLaunchState()
    launchModule = undefined
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.doUnmock(STREAM_SPECIFIER)
    vi.unstubAllGlobals()
  })

  function renderForm(): void {
    document.body.innerHTML = `
      <div id="repo-picker-container"></div>
      <form id="launch-form">
        <textarea id="launch-prompt" name="prompt"></textarea>
        <div id="launch-prompt-status" role="status"></div>
        <div id="launch-error" role="alert" hidden></div>
        <button type="submit">Launch</button>
      </form>
      <div data-role="run-index-list"></div>`
  }

  function stubFetch(handlers: Handlers) {
    const calls = {csrf: [] as RequestInit[], repos: [] as RequestInit[], runs: [] as RequestInit[]}
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      if (input.endsWith('/session/csrf')) {
        calls.csrf.push(init)
        return handlers.csrf?.(init) ?? jsonResponse(200, {csrfToken: 'tok'})
      }
      if (input.endsWith('/repos')) {
        calls.repos.push(init)
        return handlers.repos?.(init) ?? jsonResponse(200, [{owner: 'fro-bot', repo: 'agent'}])
      }
      if (input.endsWith('/runs')) {
        calls.runs.push(init)
        return handlers.runs?.(init) ?? jsonResponse(202, {runId: 'run-timeout-001'})
      }
      return jsonResponse(404, {})
    }))
    return calls
  }

  function elements() {
    return {
      form: document.querySelector<HTMLFormElement>('#launch-form') as HTMLFormElement,
      textarea: document.querySelector<HTMLTextAreaElement>('#launch-prompt') as HTMLTextAreaElement,
      button: document.querySelector<HTMLButtonElement>('[type="submit"]') as HTMLButtonElement,
      error: document.querySelector<HTMLElement>('#launch-error') as HTMLElement,
      picker: document.querySelector<HTMLElement>('#repo-picker-container') as HTMLElement,
    }
  }

  /** Init with real timers, then fake only the timer functions so the deadline can be advanced. */
  async function mount(handlers: Handlers) {
    launchModule = await importLaunchModuleWithStreamMock()
    const calls = stubFetch(handlers)
    renderForm()
    const onRunLaunched = vi.fn()
    await launchModule.initOperatorLaunch({onRunLaunched})
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    return {calls, onRunLaunched, ...elements(), timeoutMs: launchModule.LAUNCH_FETCH_TIMEOUT_MS}
  }

  function submitPrompt(m: Awaited<ReturnType<typeof mount>>, prompt = 'a prompt'): void {
    m.textarea.value = prompt
    m.form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
  }

  async function expectGenericFailure(m: Awaited<ReturnType<typeof mount>>): Promise<void> {
    expect(m.button.disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(m.timeoutMs + 1)
    expect(m.error.hidden).toBe(false)
    expect(m.error.textContent).toBe(GENERIC_FAILURE_COPY)
    expect(m.button.disabled).toBe(false)
    expect(m.onRunLaunched).not.toHaveBeenCalled()
  }

  it('exports a positive deadline', async () => {
    launchModule = await importLaunchModuleWithStreamMock()
    expect(launchModule.LAUNCH_FETCH_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('a CSRF request that never settles ends in the generic failure and re-enables Launch', async () => {
    const m = await mount({csrf: () => never<Response>()})
    submitPrompt(m)
    await expectGenericFailure(m)
    expect(m.calls.runs).toHaveLength(0)
  })

  it('a CSRF response whose body never settles ends in the generic failure', async () => {
    const m = await mount({csrf: () => stalledBody(200)})
    submitPrompt(m)
    await expectGenericFailure(m)
    expect(m.calls.runs).toHaveLength(0)
  })

  it('a launch POST that never settles ends in the generic failure, with no retry', async () => {
    const m = await mount({runs: () => never<Response>()})
    submitPrompt(m)
    await expectGenericFailure(m)
    expect(m.calls.runs).toHaveLength(1)
    expect(m.calls.csrf).toHaveLength(1)
  })

  it('a 202 whose body never settles ends in the generic failure', async () => {
    const m = await mount({runs: () => stalledBody(202)})
    submitPrompt(m)
    await expectGenericFailure(m)
    expect(m.calls.runs).toHaveLength(1)
  })

  it('a 400 whose body never settles ends in the generic failure, with no retry', async () => {
    const m = await mount({runs: () => stalledBody(400)})
    submitPrompt(m)
    await expectGenericFailure(m)
    expect(m.calls.runs).toHaveLength(1)
    expect(m.calls.csrf).toHaveLength(1)
  })

  it('aborts the request signal when the deadline passes', async () => {
    const m = await mount({runs: () => never<Response>()})
    submitPrompt(m)
    await vi.advanceTimersByTimeAsync(0)
    const signal = m.calls.runs[0]?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(m.timeoutMs + 1)
    expect(signal?.aborted).toBe(true)
  })

  it('does not abort a request that settles in time, and leaves no timer running', async () => {
    const m = await mount({})
    submitPrompt(m)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(m.onRunLaunched).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(m.timeoutMs + 1)
    expect(m.calls.csrf[0]?.signal?.aborted).toBe(false)
    expect(m.calls.runs[0]?.signal?.aborted).toBe(false)
    expect(m.error.hidden).toBe(true)
  })

  it('the next submit after a timeout goes through', async () => {
    let attempt = 0
    const m = await mount({
      runs: () => {
        attempt += 1
        return attempt === 1 ? never<Response>() : jsonResponse(202, {runId: 'run-after-timeout'})
      },
    })
    submitPrompt(m)
    await expectGenericFailure(m)

    submitPrompt(m)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(m.calls.runs).toHaveLength(2)
    expect(m.onRunLaunched).toHaveBeenCalledTimes(1)
  })

  it('a repo list request that never settles shows the existing network copy', async () => {
    launchModule = await importLaunchModuleWithStreamMock()
    stubFetch({repos: () => never<Response>()})
    renderForm()
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})

    const init = launchModule.initOperatorLaunch({onRunLaunched: vi.fn()})
    await vi.advanceTimersByTimeAsync(launchModule.LAUNCH_FETCH_TIMEOUT_MS + 1)
    await init

    expect(elements().picker.textContent).toBe(REPO_LIST_NETWORK_COPY)
  })
})
