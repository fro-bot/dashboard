/**
 * Behavioral tests for the launch idempotency key in public/operator-launch.js. They run the real
 * submit path with the stream module import and fetch stubbed, and fake only the timer functions.
 * The key travels in the JSON body (the field the gateway reads) and in the header. One key is held
 * for a (repo, prompt) submission until a definitive answer, so a re-click after a timeout or
 * network failure repeats the same launch instead of starting a second one.
 */

import {afterEach, describe, expect, it, vi} from 'vitest'

type LaunchModule = typeof import('../../../public/operator-launch.js')

// The specifier initOperatorLaunch imports (the core test pins streamModuleSpecifier() to it).
const STREAM_SPECIFIER = '/static/operator-stream.js?manual=1'

// The gateway rejects a longer key.
const GATEWAY_KEY_MAX_LENGTH = 256

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

/** A promise that never settles, as a stalled connection would. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

type Handler = (attempt: number) => Response | Promise<Response>

interface SentRun {
  readonly bodyKey: unknown
  readonly headerKey: unknown
  readonly repo: unknown
  readonly prompt: unknown
}

describe('launch idempotency key', () => {
  let launchModule: LaunchModule | undefined

  afterEach(() => {
    launchModule?.resetLaunchState()
    launchModule = undefined
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.doUnmock(STREAM_SPECIFIER)
    vi.unstubAllGlobals()
  })

  /** Mount over a `/runs` handler that gets the 1-based attempt number; two repos are on offer. */
  async function mount(runs: Handler = () => jsonResponse(202, {runId: 'run-idem-001'})) {
    vi.doMock(STREAM_SPECIFIER, () => ({
      initOperatorStream: vi.fn(),
      takeUsableFinishedRun: vi.fn(() => undefined),
      pruneFinishedRuns: vi.fn(),
      clearFinishedRuns: vi.fn(),
      resetOutputView: vi.fn(),
    }))
    launchModule = await import('../../../public/operator-launch.js')

    const sent: SentRun[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      if (input.endsWith('/session/csrf')) return jsonResponse(200, {csrfToken: 'tok'})
      if (input.endsWith('/repos')) {
        return jsonResponse(200, [{owner: 'fro-bot', repo: 'agent'}, {owner: 'fro-bot', repo: 'dashboard'}])
      }
      if (input.endsWith('/runs')) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        sent.push({
          bodyKey: body.idempotencyKey,
          headerKey: (init.headers as Record<string, string>)['idempotency-key'],
          repo: body.repo,
          prompt: body.prompt,
        })
        return runs(sent.length)
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

    const mountInit = () => launchModule?.initOperatorLaunch({onRunLaunched: vi.fn()})
    await mountInit()
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})

    const form = document.querySelector<HTMLFormElement>('#launch-form') as HTMLFormElement
    const textarea = document.querySelector<HTMLTextAreaElement>('#launch-prompt') as HTMLTextAreaElement
    const timeoutMs = launchModule.LAUNCH_FETCH_TIMEOUT_MS

    const flush = async () => {
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0)
    }
    return {
      sent,
      form,
      textarea,
      remount: async () => {
        vi.useRealTimers()
        await mountInit()
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
      },
      /** Submit and let the request settle; `stall` runs the clock past the deadline first. */
      submit: async (prompt = 'a prompt', options: {repo?: string; stall?: boolean} = {}) => {
        const select = document.querySelector<HTMLSelectElement>('#launch-repo-select')
        if (options.repo !== undefined && select !== null) select.value = options.repo
        textarea.value = prompt
        form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
        await flush()
        if (options.stall === true) await vi.advanceTimersByTimeAsync(timeoutMs + 1)
        await flush()
      },
    }
  }

  const keysOf = (sent: readonly SentRun[]) => sent.map(run => run.bodyKey)

  it('sends the key in the JSON body, outside fixture mode, and in the header', async () => {
    const m = await mount()
    await m.submit()

    expect(m.sent).toHaveLength(1)
    const [run] = m.sent
    expect(typeof run?.bodyKey).toBe('string')
    expect((run?.bodyKey as string).length).toBeGreaterThan(0)
    expect((run?.bodyKey as string).length).toBeLessThanOrEqual(GATEWAY_KEY_MAX_LENGTH)
    expect(run?.headerKey).toBe(run?.bodyKey)
  })

  it('a re-click with the same repo and prompt after a timeout sends the same key', async () => {
    const m = await mount(attempt => (attempt === 1 ? never<Response>() : jsonResponse(202, {runId: 'run-idem-002'})))
    await m.submit('same prompt', {stall: true})
    await m.submit('same prompt')

    expect(m.sent).toHaveLength(2)
    expect(typeof m.sent[0]?.bodyKey).toBe('string')
    expect(m.sent[1]?.bodyKey).toBe(m.sent[0]?.bodyKey)
    expect(m.sent[1]?.headerKey).toBe(m.sent[0]?.bodyKey)
  })

  it('a re-click after a network failure sends the same key', async () => {
    const m = await mount(attempt => {
      if (attempt === 1) throw new TypeError('network down')
      return jsonResponse(202, {runId: 'run-idem-003'})
    })
    await m.submit('same prompt')
    await m.submit('same prompt')

    expect(m.sent).toHaveLength(2)
    expect(typeof m.sent[0]?.bodyKey).toBe('string')
    expect(m.sent[1]?.bodyKey).toBe(m.sent[0]?.bodyKey)
  })

  it('a re-click that times out again keeps the same key for the next try', async () => {
    const m = await mount(attempt => (attempt <= 2 ? never<Response>() : jsonResponse(202, {runId: 'run-idem-004'})))
    await m.submit('same prompt', {stall: true})
    await m.submit('same prompt', {stall: true})
    await m.submit('same prompt')

    expect(typeof m.sent[0]?.bodyKey).toBe('string')
    expect(new Set(keysOf(m.sent)).size).toBe(1)
    expect(m.sent).toHaveLength(3)
  })

  it('a changed prompt after a timeout gets a new key', async () => {
    const m = await mount(attempt => (attempt === 1 ? never<Response>() : jsonResponse(202, {runId: 'run-idem-005'})))
    await m.submit('first prompt', {stall: true})
    await m.submit('first prompt!')

    expect(m.sent).toHaveLength(2)
    expect(m.sent[1]?.bodyKey).not.toBe(m.sent[0]?.bodyKey)
  })

  it('a changed repo after a timeout gets a new key', async () => {
    const m = await mount(attempt => (attempt === 1 ? never<Response>() : jsonResponse(202, {runId: 'run-idem-006'})))
    await m.submit('same prompt', {repo: 'fro-bot/agent', stall: true})
    await m.submit('same prompt', {repo: 'fro-bot/dashboard'})

    expect(m.sent).toHaveLength(2)
    expect(m.sent[0]?.repo).toBe('fro-bot/agent')
    expect(m.sent[1]?.repo).toBe('fro-bot/dashboard')
    expect(m.sent[1]?.bodyKey).not.toBe(m.sent[0]?.bodyKey)
  })

  it('going back to the original prompt after a change does not revive the old key', async () => {
    const m = await mount(attempt => (attempt <= 2 ? never<Response>() : jsonResponse(202, {runId: 'run-idem-007'})))
    await m.submit('first prompt', {stall: true})
    await m.submit('second prompt', {stall: true})
    await m.submit('first prompt')

    expect(new Set(keysOf(m.sent)).size).toBe(3)
  })

  it.each([
    ['a generic 400', () => jsonResponse(400, {error: 'bad request'})],
    ['a prompt rejection', () => jsonResponse(400, {error: 'bad request', reason: 'prompt-too-long'})],
    ['a 404', () => jsonResponse(404, {})],
    ['a 429', () => jsonResponse(429, {})],
    ['a 500', () => jsonResponse(500, {})],
    ['a 202 without a run id', () => jsonResponse(202, {})],
  ])('after %s the next submit gets a new key', async (_name, respond) => {
    const m = await mount(() => respond())
    await m.submit('same prompt')
    const firstAnswerCount = m.sent.length
    await m.submit('same prompt')

    const first = keysOf(m.sent.slice(0, firstAnswerCount))
    const second = keysOf(m.sent.slice(firstAnswerCount))
    expect(new Set(first).size).toBe(1)
    expect(new Set(second).size).toBe(1)
    expect(second[0]).not.toBe(first[0])
  })

  it('after a timeout followed by a definitive answer, the next submit gets a new key', async () => {
    const m = await mount(attempt => {
      if (attempt === 1) return never<Response>()
      return jsonResponse(404, {})
    })
    await m.submit('same prompt', {stall: true})
    await m.submit('same prompt')
    await m.submit('same prompt')

    expect(m.sent).toHaveLength(3)
    expect(m.sent[1]?.bodyKey).toBe(m.sent[0]?.bodyKey)
    expect(m.sent[2]?.bodyKey).not.toBe(m.sent[1]?.bodyKey)
  })

  it('after a successful launch the next launch gets a new key', async () => {
    const m = await mount()
    await m.submit('same prompt')
    await m.submit('same prompt')

    expect(m.sent).toHaveLength(2)
    expect(m.sent[1]?.bodyKey).not.toBe(m.sent[0]?.bodyKey)
  })

  it('a timeout followed by success releases the key', async () => {
    const m = await mount(attempt => (attempt === 1 ? never<Response>() : jsonResponse(202, {runId: 'run-idem-009'})))
    await m.submit('same prompt', {stall: true})
    await m.submit('same prompt')
    await m.submit('same prompt')

    expect(m.sent).toHaveLength(3)
    expect(m.sent[1]?.bodyKey).toBe(m.sent[0]?.bodyKey)
    expect(m.sent[2]?.bodyKey).not.toBe(m.sent[1]?.bodyKey)
  })

  it('the CSRF retry carries the same key in the body as the first request', async () => {
    const m = await mount(attempt => (attempt === 1 ? new Response(null, {status: 400}) : jsonResponse(202, {runId: 'run-idem-010'})))
    await m.submit()

    expect(m.sent).toHaveLength(2)
    expect(typeof m.sent[0]?.bodyKey).toBe('string')
    expect(m.sent[1]?.bodyKey).toBe(m.sent[0]?.bodyKey)
    expect(m.sent[1]?.headerKey).toBe(m.sent[0]?.headerKey)
  })

  it('a timeout on the CSRF retry keeps the key for the next click', async () => {
    const m = await mount(attempt => {
      if (attempt === 1) return new Response(null, {status: 400})
      if (attempt === 2) return never<Response>()
      return jsonResponse(202, {runId: 'run-idem-011'})
    })
    await m.submit('same prompt', {stall: true})
    await m.submit('same prompt')

    expect(m.sent).toHaveLength(3)
    expect(typeof m.sent[0]?.bodyKey).toBe('string')
    expect(new Set(keysOf(m.sent)).size).toBe(1)
  })

  it('resetting the form drops the held key', async () => {
    const m = await mount(attempt => (attempt === 1 ? never<Response>() : jsonResponse(202, {runId: 'run-idem-012'})))
    await m.submit('same prompt', {stall: true})
    m.form.reset()
    await m.submit('same prompt')

    expect(m.sent).toHaveLength(2)
    expect(m.sent[1]?.bodyKey).not.toBe(m.sent[0]?.bodyKey)
  })

  it('tearing the launch UI down drops the held key', async () => {
    const m = await mount(attempt => (attempt === 1 ? never<Response>() : jsonResponse(202, {runId: 'run-idem-013'})))
    await m.submit('same prompt', {stall: true})
    launchModule?.resetLaunchState()
    await m.remount()
    await m.submit('same prompt')

    expect(m.sent).toHaveLength(2)
    expect(m.sent[1]?.bodyKey).not.toBe(m.sent[0]?.bodyKey)
  })
})
