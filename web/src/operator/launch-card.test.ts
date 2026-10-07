/**
 * Behavioral test for the optimistic card public/operator-launch.js builds after a
 * successful launch: it runs the real submit path, with the stream module import and
 * fetch stubbed, and inspects the card that lands in the run-index list.
 */

import {afterEach, describe, expect, it, vi} from 'vitest'

type LaunchModule = typeof import('../../../public/operator-launch.js')

// The specifier initOperatorLaunch imports (the core test pins streamModuleSpecifier() to it).
const STREAM_SPECIFIER = '/static/operator-stream.js?manual=1'

/**
 * The module auto-starts on import when a document exists, importing the stream module.
 * That import must therefore already be mocked, and the document is still empty, so the
 * auto-start finds nothing to wire.
 */
async function importLaunchModuleWithStreamMock(): Promise<LaunchModule> {
  vi.doMock(STREAM_SPECIFIER, () => ({initOperatorStream: vi.fn()}))
  return import('../../../public/operator-launch.js')
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

describe('optimistic launch card — checkout-detail region', () => {
  let launchModule: LaunchModule | undefined

  afterEach(() => {
    launchModule?.resetLaunchState()
    document.body.innerHTML = ''
    vi.doUnmock(STREAM_SPECIFIER)
    vi.unstubAllGlobals()
  })

  it('a successful launch inserts a card with exactly one hidden, empty checkout-detail region right after the header row', async () => {
    launchModule = await importLaunchModuleWithStreamMock()
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.endsWith('/session/csrf')) return jsonResponse(200, {csrfToken: 'tok-card'})
      if (input.endsWith('/repos')) return jsonResponse(200, [{owner: 'fro-bot', repo: 'agent'}])
      if (input.endsWith('/runs')) return jsonResponse(202, {runId: 'run-card-001'})
      return jsonResponse(404, {})
    }))
    document.body.innerHTML = `
      <div id="repo-picker-container"></div>
      <form id="launch-form"><textarea name="prompt"></textarea><button type="submit">Launch</button></form>
      <p id="launch-error" hidden></p>
      <div data-role="run-index-list"></div>`
    const form = document.querySelector<HTMLFormElement>('#launch-form')
    const prompt = document.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')
    expect(form).not.toBeNull()
    expect(prompt).not.toBeNull()

    const launched = new Promise<HTMLElement>(resolve => {
      launchModule?.initOperatorLaunch({onRunLaunched: (_runId: string, card: HTMLElement) => resolve(card)})?.then(() => {
        if (prompt !== null) prompt.value = 'do the thing'
        form?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
      })
    })
    const card = await launched

    expect(card.dataset.runId).toBe('run-card-001')
    expect(document.querySelector('[data-role="run-index-list"]')?.firstElementChild).toBe(card)

    const regions = card.querySelectorAll<HTMLElement>('[data-role="run-checkout-detail"]')
    expect(regions).toHaveLength(1)
    const region = regions[0]
    expect(region?.hidden).toBe(true)
    expect(region?.textContent).toBe('')
    expect(region?.parentElement).toBe(card)

    const roles = Array.from(card.children).map(child => (child as HTMLElement).dataset.role)
    const at = roles.indexOf('run-checkout-detail')
    expect(roles[at - 1]).toBe('run-repo')
    expect(roles[at + 1]).toBe('run-output')
  })
})
