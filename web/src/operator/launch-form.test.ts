/**
 * Behavioral tests for the launch form in public/operator-launch.js: the prompt length limit, the
 * disabled state, the status announcement and the handling of the gateway's prompt rejections. They
 * run the real submit path with the stream module import and fetch stubbed.
 */

import {afterEach, describe, expect, it, vi} from 'vitest'

type LaunchModule = typeof import('../../../public/operator-launch.js')

// The specifier initOperatorLaunch imports (the core test pins streamModuleSpecifier() to it).
const STREAM_SPECIFIER = '/static/operator-stream.js?manual=1'

const LIMIT = 8000
const TOO_LONG_COPY = 'Prompt is too long. Keep it to 8,000 characters or fewer; emoji can count as more than one.'
const REQUIRED_COPY = 'Please enter a prompt before launching.'
const GENERIC_FAILURE_COPY = 'Launch failed. Please try again.'

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

type RunsHandler = (init: RequestInit) => Response | Promise<Response>

interface Harness {
  readonly form: HTMLFormElement
  readonly textarea: HTMLTextAreaElement
  readonly button: HTMLButtonElement
  readonly status: HTMLElement
  readonly error: HTMLElement
  readonly csrfCalls: () => number
  readonly runCalls: () => RequestInit[]
}

describe('launch form prompt limit and rejections', () => {
  let launchModule: LaunchModule | undefined

  afterEach(() => {
    launchModule?.resetLaunchState()
    launchModule = undefined
    document.body.innerHTML = ''
    vi.doUnmock(STREAM_SPECIFIER)
    vi.unstubAllGlobals()
  })

  async function setup(runsHandler: RunsHandler): Promise<Harness> {
    launchModule = await importLaunchModuleWithStreamMock()
    const csrfCalls: string[] = []
    const runCalls: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      if (input.endsWith('/session/csrf')) {
        csrfCalls.push(input)
        return jsonResponse(200, {csrfToken: `tok-${csrfCalls.length}`})
      }
      if (input.endsWith('/repos')) return jsonResponse(200, [{owner: 'fro-bot', repo: 'agent'}])
      if (input.endsWith('/runs')) {
        runCalls.push(init)
        return runsHandler(init)
      }
      return jsonResponse(404, {})
    }))
    document.body.innerHTML = `
      <div id="repo-picker-container"></div>
      <form id="launch-form">
        <textarea id="launch-prompt" name="prompt" aria-describedby="launch-prompt-status"></textarea>
        <div id="launch-prompt-status" role="status"></div>
        <div id="launch-error" role="alert" hidden></div>
        <button type="submit">Launch</button>
      </form>
      <div data-role="run-index-list"></div>`
    await launchModule.initOperatorLaunch({onRunLaunched: vi.fn()})
    return {
      form: document.querySelector<HTMLFormElement>('#launch-form') as HTMLFormElement,
      textarea: document.querySelector<HTMLTextAreaElement>('#launch-prompt') as HTMLTextAreaElement,
      button: document.querySelector<HTMLButtonElement>('[type="submit"]') as HTMLButtonElement,
      status: document.querySelector<HTMLElement>('#launch-prompt-status') as HTMLElement,
      error: document.querySelector<HTMLElement>('#launch-error') as HTMLElement,
      csrfCalls: () => csrfCalls.length,
      runCalls: () => runCalls,
    }
  }

  function type(harness: Harness, value: string): void {
    harness.textarea.value = value
    harness.textarea.dispatchEvent(new Event('input', {bubbles: true}))
  }

  function submit(harness: Harness): void {
    harness.form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
  }

  function sentPrompt(init: RequestInit): unknown {
    return (JSON.parse(String(init.body)) as {prompt: unknown}).prompt
  }

  it('a prompt of exactly 8,000 units including emoji, with surrounding whitespace, is sent untrimmed', async () => {
    const harness = await setup(() => jsonResponse(202, {runId: 'run-limit-001'}))
    const prompt = ` ${'\u{1F600}'.repeat((LIMIT - 2) / 2)} `
    expect(prompt.length).toBe(LIMIT)

    type(harness, prompt)
    expect(harness.button.disabled).toBe(false)
    expect(harness.status.textContent).toBe('')
    submit(harness)

    await vi.waitFor(() => expect(harness.runCalls()).toHaveLength(1))
    expect(sentPrompt(harness.runCalls()[0] as RequestInit)).toBe(prompt)
  })

  it('a whitespace-only prompt is not sent and keeps the existing prompt-required copy', async () => {
    const harness = await setup(() => jsonResponse(202, {runId: 'run-never'}))
    type(harness, ' \n\t ')
    submit(harness)

    await vi.waitFor(() => expect(harness.error.hidden).toBe(false))
    expect(harness.error.textContent).toBe('Please enter a prompt before launching.')
    expect(harness.csrfCalls()).toBe(0)
    expect(harness.runCalls()).toHaveLength(0)
  })

  it('8,001 units disables Launch and announces once; going back under clears it and re-enables Launch', async () => {
    const harness = await setup(() => jsonResponse(202, {runId: 'run-never'}))

    type(harness, 'a'.repeat(LIMIT + 1))
    expect(harness.button.disabled).toBe(true)
    expect(harness.status.textContent).toBe(TOO_LONG_COPY)
    expect(harness.textarea.getAttribute('aria-invalid')).toBe('true')
    const announced = harness.status.firstChild

    // Still over: nothing is announced again.
    type(harness, 'a'.repeat(LIMIT + 5))
    expect(harness.status.firstChild).toBe(announced)
    expect(harness.status.textContent).toBe(TOO_LONG_COPY)
    expect(harness.button.disabled).toBe(true)

    type(harness, 'a'.repeat(LIMIT))
    expect(harness.status.textContent).toBe('')
    expect(harness.textarea.hasAttribute('aria-invalid')).toBe(false)
    expect(harness.button.disabled).toBe(false)

    // Crossing again announces again.
    type(harness, 'a'.repeat(LIMIT + 1))
    expect(harness.status.textContent).toBe(TOO_LONG_COPY)
  })

  it('counts emoji as two units each, so 4,001 emoji is over the limit', async () => {
    const harness = await setup(() => jsonResponse(202, {runId: 'run-never'}))
    type(harness, '\u{1F600}'.repeat(LIMIT / 2))
    expect(harness.button.disabled).toBe(false)
    type(harness, '\u{1F600}'.repeat(LIMIT / 2 + 1))
    expect(harness.button.disabled).toBe(true)
    expect(harness.status.textContent).toBe(TOO_LONG_COPY)
  })

  it('keeps Launch disabled when an in-flight launch finishes while the prompt is over the limit', async () => {
    let finishRun: (response: Response) => void = () => {}
    const harness = await setup(
      () =>
        new Promise<Response>(resolve => {
          finishRun = resolve
        }),
    )

    type(harness, 'a launch that is in flight')
    submit(harness)
    await vi.waitFor(() => expect(harness.runCalls()).toHaveLength(1))
    expect(harness.button.disabled).toBe(true)

    type(harness, 'a'.repeat(LIMIT + 1))
    finishRun(jsonResponse(500, {}))

    await vi.waitFor(() => expect(harness.error.textContent).toBe(GENERIC_FAILURE_COPY))
    expect(harness.button.disabled).toBe(true)
    expect(harness.status.textContent).toBe(TOO_LONG_COPY)
  })

  it('re-enables Launch after an in-flight launch finishes with a prompt within the limit', async () => {
    let finishRun: (response: Response) => void = () => {}
    const harness = await setup(
      () =>
        new Promise<Response>(resolve => {
          finishRun = resolve
        }),
    )

    type(harness, 'a launch that is in flight')
    submit(harness)
    await vi.waitFor(() => expect(harness.runCalls()).toHaveLength(1))
    expect(harness.button.disabled).toBe(true)

    finishRun(jsonResponse(500, {}))
    await vi.waitFor(() => expect(harness.button.disabled).toBe(false))
  })

  it('re-enables Launch after a successful launch resets the form', async () => {
    const harness = await setup(() => jsonResponse(202, {runId: 'run-reset-001'}))
    type(harness, 'a prompt that launches')
    submit(harness)

    await vi.waitFor(() => expect(harness.textarea.value).toBe(''))
    expect(harness.button.disabled).toBe(false)
    expect(harness.status.textContent).toBe('')
  })

  it('requestSubmit() with an over-limit prompt sends nothing', async () => {
    const harness = await setup(() => jsonResponse(202, {runId: 'run-never'}))

    // No input event: only the submit handler's own re-check can catch this.
    harness.textarea.value = 'a'.repeat(LIMIT + 1)
    harness.form.requestSubmit()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(harness.csrfCalls()).toBe(0)
    expect(harness.runCalls()).toHaveLength(0)
    expect(harness.status.textContent).toBe(TOO_LONG_COPY)
    expect(harness.button.disabled).toBe(true)
  })

  it('a prompt-too-long 400 shows the fixed copy and makes one request only', async () => {
    const harness = await setup(() => jsonResponse(400, {error: 'bad request', reason: 'prompt-too-long'}))
    type(harness, 'within the limit as far as the browser knows')
    submit(harness)

    await vi.waitFor(() => expect(harness.error.hidden).toBe(false))
    expect(harness.error.textContent).toBe(TOO_LONG_COPY)
    expect(harness.csrfCalls()).toBe(1)
    expect(harness.runCalls()).toHaveLength(1)
    expect(harness.button.disabled).toBe(false)
  })

  it('a prompt-is-required 400 shows the fixed copy and makes one request only', async () => {
    const harness = await setup(() => jsonResponse(400, {error: 'prompt is required'}))
    type(harness, 'not empty as far as the browser knows')
    submit(harness)

    await vi.waitFor(() => expect(harness.error.hidden).toBe(false))
    expect(harness.error.textContent).toBe(REQUIRED_COPY)
    expect(harness.csrfCalls()).toBe(1)
    expect(harness.runCalls()).toHaveLength(1)
  })

  it('never renders the response body', async () => {
    const harness = await setup(() => jsonResponse(400, {error: 'bad request', reason: 'prompt-too-long', detail: 'SECRET-BODY-TEXT'}))
    type(harness, 'a prompt')
    submit(harness)

    await vi.waitFor(() => expect(harness.error.hidden).toBe(false))
    expect(document.body.textContent).not.toContain('SECRET-BODY-TEXT')
    expect(document.body.innerHTML).not.toContain('SECRET-BODY-TEXT')
  })

  it.each([
    ['no body', () => new Response(null, {status: 400})],
    ['a non-JSON body', () => new Response('nope', {status: 400})],
    ['another JSON shape', () => jsonResponse(400, {error: 'bad request'})],
    ['an unknown reason', () => jsonResponse(400, {error: 'bad request', reason: 'something-else'})],
    ['a non-object body', () => jsonResponse(400, ['prompt-too-long'])],
  ])('a 400 with %s keeps the CSRF refresh and one retry', async (_name, respond) => {
    const harness = await setup(() => respond())
    type(harness, 'a prompt')
    submit(harness)

    await vi.waitFor(() => expect(harness.error.hidden).toBe(false))
    expect(harness.error.textContent).toBe(GENERIC_FAILURE_COPY)
    expect(harness.csrfCalls()).toBe(2)
    expect(harness.runCalls()).toHaveLength(2)
  })

  it.each([
    ['prompt-too-long', {error: 'bad request', reason: 'prompt-too-long'}, TOO_LONG_COPY],
    ['prompt is required', {error: 'prompt is required'}, REQUIRED_COPY],
  ])('a %s 400 on the CSRF retry shows the same fixed copy and makes no third request', async (_name, body, copy) => {
    let attempt = 0
    const harness = await setup(() => {
      attempt += 1
      return attempt === 1 ? new Response(null, {status: 400}) : jsonResponse(400, body)
    })
    type(harness, 'a prompt')
    submit(harness)

    await vi.waitFor(() => expect(harness.error.hidden).toBe(false))
    expect(harness.error.textContent).toBe(copy)
    expect(harness.csrfCalls()).toBe(2)
    expect(harness.runCalls()).toHaveLength(2)
  })

  it('a 400 that a refreshed CSRF token clears launches on the retry', async () => {
    let attempt = 0
    const harness = await setup(() => {
      attempt += 1
      return attempt === 1 ? new Response(null, {status: 400}) : jsonResponse(202, {runId: 'run-retry-001'})
    })
    type(harness, 'a prompt')
    submit(harness)

    await vi.waitFor(() => expect(harness.runCalls()).toHaveLength(2))
    await vi.waitFor(() => expect(harness.textarea.value).toBe(''))
    expect(harness.csrfCalls()).toBe(2)
  })
})
