/**
 * Sign-out ends an in-flight launch. The runtime hands the launch module a reset when the session is
 * gone, so a launch that resolves afterwards is stale: no optimistic Pending card, no stream and no
 * hash write. The real launch module runs here over a mocked run index and stream module.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createOperatorRuntime, type OperatorRuntimeHandle} from './runtime.ts'
import {renderOutput} from './markdown-output.ts'
import {setOutputRendererLoader} from './renderer-source.ts'

const STREAM_SPECIFIER = '/static/operator-stream.js?manual=1'
const RUN_INDEX_SPECIFIER = '/static/operator-run-index.js?manual=1'
const LAUNCH_SPECIFIER = '/static/operator-launch.js?manual=1'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

describe('sign-out while a launch is in flight', () => {
  const runtimes: OperatorRuntimeHandle[] = []

  beforeEach(() => {
    setOutputRendererLoader(async () => renderOutput)
  })

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.cleanup()
    document.body.innerHTML = ''
    if (location.hash !== '') history.replaceState(null, '', location.pathname + location.search)
    vi.doUnmock(STREAM_SPECIFIER)
    vi.doUnmock(RUN_INDEX_SPECIFIER)
    vi.doUnmock(LAUNCH_SPECIFIER)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Mount the runtime over mocked sibling modules; the launch module is the real one unless replaced. */
  async function mountRuntime(options: {launchModule?: Record<string, unknown>} = {}) {
    const initOperatorStream = vi.fn(() => ({close: vi.fn(), getConnectionStatus: vi.fn(() => 'active')}))
    let captured: {onAuthRequired: () => void} | undefined
    vi.doMock(STREAM_SPECIFIER, () => ({
      initOperatorStream,
      bootstrapOperatorStreams: vi.fn(),
      resetBootstrapState: vi.fn(),
      takeUsableFinishedRun: vi.fn(() => undefined),
      pruneFinishedRuns: vi.fn(),
      clearFinishedRuns: vi.fn(),
      resetOutputView: vi.fn(),
    }))
    vi.doMock(RUN_INDEX_SPECIFIER, () => ({
      initOperatorRunIndex: async (opts: NonNullable<typeof captured>) => {
        captured = opts
        return 'loaded'
      },
      refreshOperatorRunIndex: vi.fn(async () => true),
      resetRunIndexState: vi.fn(),
      markRunStreamAttached: vi.fn(),
      markCardExpandedForLaunch: vi.fn(),
      setPromptRenderer: vi.fn(),
    }))
    vi.doMock(LAUNCH_SPECIFIER, () => options.launchModule ?? import('../../../public/operator-launch.js'))

    const container = document.createElement('div')
    document.body.append(container)
    const runtime = createOperatorRuntime({container, onStateChange: vi.fn()})
    runtimes.push(runtime)
    return {initOperatorStream, signOut: () => captured?.onAuthRequired(), isReady: () => captured !== undefined}
  }

  it('hands the launch module a reset when the session is gone', async () => {
    const resetLaunchState = vi.fn()
    const mounted = await mountRuntime({launchModule: {initOperatorLaunch: vi.fn(async () => {}), resetLaunchState}})
    await vi.waitFor(() => expect(mounted.isReady()).toBe(true))
    await vi.waitFor(() => expect(resetLaunchState).toHaveBeenCalled())
    const before = resetLaunchState.mock.calls.length

    mounted.signOut()

    expect(resetLaunchState.mock.calls.length).toBeGreaterThan(before)
  })

  it('a launch that resolves after sign-out inserts no card, attaches no stream and writes no hash', async () => {
    let answerLaunch: (response: Response) => void = () => {}
    let launchPosted = false
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.endsWith('/session/csrf')) return jsonResponse(200, {csrfToken: 'tok'})
      if (input.endsWith('/repos')) return jsonResponse(200, [{owner: 'fro-bot', repo: 'agent'}])
      if (input.endsWith('/runs')) {
        launchPosted = true
        return new Promise<Response>(resolve => {
          answerLaunch = resolve
        })
      }
      return jsonResponse(404, {})
    }))
    document.body.innerHTML = `
      <div id="repo-picker-container"></div>
      <form id="launch-form">
        <textarea id="launch-prompt" name="prompt"></textarea>
        <div id="launch-error" role="alert" hidden></div>
        <button type="submit">Launch</button>
      </form>
      <div data-role="run-index-list"></div>
      <div data-role="stream-status"></div>`
    const mounted = await mountRuntime()
    await vi.waitFor(() => expect(document.querySelector('#launch-repo-select')).not.toBeNull())
    await vi.waitFor(() => expect(mounted.isReady()).toBe(true))

    const textarea = document.querySelector<HTMLTextAreaElement>('#launch-prompt') as HTMLTextAreaElement
    const button = document.querySelector<HTMLButtonElement>('[type="submit"]') as HTMLButtonElement
    textarea.value = 'a prompt'
    document.querySelector('#launch-form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
    await vi.waitFor(() => expect(launchPosted).toBe(true))

    mounted.signOut()
    answerLaunch(jsonResponse(202, {runId: 'run-signout-001'}))
    await vi.waitFor(() => expect(button.disabled).toBe(false))

    expect(document.querySelector('[data-optimistic]')).toBeNull()
    expect(document.querySelector('[data-role="run-index-list"]')?.children).toHaveLength(0)
    expect(mounted.initOperatorStream).not.toHaveBeenCalled()
    expect(location.hash).toBe('')
  })
})
