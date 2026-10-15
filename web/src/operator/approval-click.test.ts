/**
 * Clicking inside an approval prompt must never toggle the run card it lives in.
 *
 * Bug: the prompt's Once/Always/Confirm/Cancel/Reject click handlers did not stop propagation, so the
 * click bubbled to the card's expand/collapse listener. The card collapsed, the runtime closed the
 * stream, and "Confirm always" was rendered into a card that had just collapsed. The decision never
 * took effect from the operator's point of view.
 *
 * These tests run the real stack end to end in jsdom: the real default runtime loader
 * (createOperatorRuntime), the real run index (which builds the card and binds its toggle), the real
 * stream module (which renders the prompt) and the real browser approval client. Only `fetch` is a
 * stub. The static module specifiers the loader imports at runtime are pointed at the real files.
 */

import {afterEach, describe, expect, it, vi} from 'vitest'
import {PINNED_CONTRACT_VERSION, resetQuestionPageStore} from '../../../public/operator-stream.js'
import {createOperatorRuntime, type OperatorRuntimeHandle} from './runtime.ts'

const RUN_ID = 'run-approval-click'
const REQUEST_ID = 'req-approval-click'
const CSRF_TOKEN = 'csrf-token-approval-click'
const DECISION_PATH = `/operator/runs/${RUN_ID}/approvals/${REQUEST_ID}/decision`

const sse = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
const STREAM_FRAMES = [
  sse('ready', {contractVersion: PINNED_CONTRACT_VERSION}),
  sse('status', {
    runId: RUN_ID,
    entityRef: 'fro-bot/agent',
    surface: 'github',
    phase: 'EXECUTING',
    status: 'waiting_for_approval',
    startedAt: '2026-06-20T10:00:00Z',
    stale: false,
  }),
  sse('approval', {runId: RUN_ID, requestID: REQUEST_ID, permission: 'shell', command: 'echo hello', settled: false}),
].join('')

type DecisionCall = {url: string; headers: Record<string, string>; body: unknown}

/** `fetch` stub for the run list, the SSE stream, the CSRF endpoint and the decision POST. */
function stubGateway() {
  const decisions: DecisionCall[] = []
  const csrfRequests: string[] = []
  let streamsOpened = 0
  let streamsAborted = 0

  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    const json = (data: unknown) => ({ok: true, status: 200, json: async () => data})

    if (url.endsWith('/stream')) {
      streamsOpened++
      const signal = init?.signal
      signal?.addEventListener('abort', () => {
        streamsAborted++
      })
      let delivered = false
      return {
        ok: true,
        status: 200,
        headers: {get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null)},
        body: {
          getReader: () => ({
            read: async () => {
              if (!delivered) {
                delivered = true
                return {done: false, value: new TextEncoder().encode(STREAM_FRAMES)}
              }
              return new Promise<never>(() => {})
            },
          }),
        },
      }
    }
    if (url.endsWith('/session/csrf')) {
      csrfRequests.push(url)
      return json({csrfToken: CSRF_TOKEN})
    }
    if (url.includes('/decision')) {
      decisions.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      })
      return json({state: 'claimed'})
    }
    if (url.endsWith(`/runs/${RUN_ID}/approvals`)) return json({approvals: []})
    if (url.endsWith('/operator/runs')) {
      return json({runs: [{runId: RUN_ID, repo: 'fro-bot/agent', status: 'waiting_for_approval', createdAt: '2026-06-20T10:00:00.000Z', updatedAt: '2026-06-20T10:01:00.000Z'}]})
    }
    return new Promise<never>(() => {})
  }))

  return {
    decisions,
    csrfRequests,
    streamsOpened: () => streamsOpened,
    streamsAborted: () => streamsAborted,
  }
}

let runtime: OperatorRuntimeHandle | null = null

/** Mount the real runtime, expand the real card, and wait for the approval prompt to render. */
async function mountExpandedCardWithPrompt() {
  vi.doMock('/static/operator-stream.js?manual=1', () => import('../../../public/operator-stream.js'))
  vi.doMock('/static/operator-run-index.js?manual=1', () => import('../../../public/operator-run-index.js'))
  vi.doMock('/static/operator-launch.js?manual=1', () => ({
    initOperatorLaunch: vi.fn(async () => {}),
    resetLaunchState: vi.fn(),
  }))
  const runIndexMod = await import('../../../public/operator-run-index.js')
  runIndexMod.resetRunIndexState()

  // A previous test's expand writes the run id to location.hash, and a mount restores from it.
  window.location.hash = ''
  document.body.innerHTML = '<div data-role="run-index-list"></div><div data-role="stream-status" hidden></div>'
  const gateway = stubGateway()
  const container = document.createElement('div')
  document.body.append(container)
  runtime = createOperatorRuntime({container, onStateChange: vi.fn()})

  const card = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-run-id="${RUN_ID}"]`)
    expect(found).not.toBeNull()
    return found as HTMLElement
  })

  card.click() // the operator expands the card
  expect(card.dataset.expanded).toBe('true')

  const prompt = await vi.waitFor(() => {
    const found = card.querySelector<HTMLElement>('.approval-prompt')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  expect(card.querySelector<HTMLElement>('[data-role="run-approvals"]')?.hidden).toBe(false)
  expect(gateway.streamsOpened()).toBe(1)
  expect(gateway.streamsAborted()).toBe(0)

  const button = (selector: string) => prompt.querySelector<HTMLButtonElement>(selector) as HTMLButtonElement
  return {card, prompt, button, gateway}
}

afterEach(() => {
  runtime?.cleanup()
  runtime = null
  document.body.replaceChildren()
  window.location.hash = ''
  vi.doUnmock('/static/operator-stream.js?manual=1')
  vi.doUnmock('/static/operator-run-index.js?manual=1')
  vi.doUnmock('/static/operator-launch.js?manual=1')
  vi.unstubAllGlobals()
  resetQuestionPageStore()
})

describe('Cancel control inside an expanded run card', () => {
  it('arming and dismissing Cancel, and clicking its status area, never collapse the card', async () => {
    const {card, gateway} = await mountExpandedCardWithPrompt()
    const control = await vi.waitFor(() => {
      const found = card.querySelector<HTMLElement>('.run-cancel-control')
      expect(found?.querySelector('.run-cancel-btn-cancel')).not.toBeNull()
      return found as HTMLElement
    })

    control.querySelector<HTMLButtonElement>('.run-cancel-btn-cancel')?.click()
    expect(control.dataset.state).toBe('armed')
    expect(card.dataset.expanded).toBe('true')

    control.querySelector<HTMLButtonElement>('.run-cancel-btn-dismiss')?.click()
    expect(control.dataset.state).toBe('idle')
    expect(card.dataset.expanded).toBe('true')

    // Not a button: the status text and the control's own padding.
    control.querySelector<HTMLElement>('.run-cancel-status')?.click()
    control.click()
    expect(card.dataset.expanded).toBe('true')
    expect(gateway.streamsAborted()).toBe(0)
  })
})

describe('approval prompt controls inside an expanded run card', () => {
  it('Once keeps the card expanded and sends exactly one decision POST with a CSRF token', async () => {
    const {card, button, gateway} = await mountExpandedCardWithPrompt()

    button('.approval-prompt-btn-once').click()

    await vi.waitFor(() => expect(gateway.decisions).toHaveLength(1))
    expect(card.dataset.expanded).toBe('true')
    expect(gateway.streamsAborted()).toBe(0)
    expect(gateway.decisions[0]?.url).toBe(DECISION_PATH)
    expect(gateway.decisions[0]?.body).toEqual({decision: 'once'})
    expect(gateway.decisions[0]?.headers['x-csrf-token']).toBe(CSRF_TOKEN)
  })

  it('Always, then Confirm always, keeps the card expanded and sends {decision: "always"}', async () => {
    const {card, prompt, button, gateway} = await mountExpandedCardWithPrompt()

    button('.approval-prompt-btn-always').click()

    expect(card.dataset.expanded).toBe('true')
    expect(gateway.decisions).toHaveLength(0)
    const confirm = prompt.querySelector<HTMLButtonElement>('.approval-prompt-btn-confirm')
    expect(confirm).not.toBeNull()
    expect(prompt.querySelector<HTMLElement>('.approval-prompt-always-confirm')?.hidden).toBe(false)

    confirm?.click()

    await vi.waitFor(() => expect(gateway.decisions).toHaveLength(1))
    expect(card.dataset.expanded).toBe('true')
    expect(gateway.streamsAborted()).toBe(0)
    expect(gateway.decisions[0]?.url).toBe(DECISION_PATH)
    expect(gateway.decisions[0]?.body).toEqual({decision: 'always'})
    expect(gateway.decisions[0]?.headers['x-csrf-token']).toBe(CSRF_TOKEN)
  })

  it('Always, then Cancel, returns to the three buttons without collapsing the card or sending anything', async () => {
    const {card, prompt, button, gateway} = await mountExpandedCardWithPrompt()

    button('.approval-prompt-btn-always').click()
    prompt.querySelector<HTMLButtonElement>('.approval-prompt-btn-cancel')?.click()

    expect(card.dataset.expanded).toBe('true')
    expect(prompt.querySelector('.approval-prompt-btn-once')).not.toBeNull()
    expect(prompt.querySelector('.approval-prompt-btn-always')).not.toBeNull()
    expect(prompt.querySelector('.approval-prompt-btn-reject')).not.toBeNull()
    expect(gateway.decisions).toHaveLength(0)
    expect(gateway.streamsAborted()).toBe(0)
  })

  it('Reject is a single click (no confirm step): it keeps the card expanded and sends {decision: "reject"}', async () => {
    const {card, button, gateway} = await mountExpandedCardWithPrompt()

    button('.approval-prompt-btn-reject').click()

    await vi.waitFor(() => expect(gateway.decisions).toHaveLength(1))
    expect(card.dataset.expanded).toBe('true')
    expect(gateway.streamsAborted()).toBe(0)
    expect(gateway.decisions[0]?.url).toBe(DECISION_PATH)
    expect(gateway.decisions[0]?.body).toEqual({decision: 'reject'})
    expect(gateway.decisions[0]?.headers['x-csrf-token']).toBe(CSRF_TOKEN)
  })

  // jsdom does not turn Enter/Space on a <button> into a click the way a browser does, so the test
  // plays the browser's part: the key event first, then the click activation it produces. The card's
  // own keydown handler already ignores keys from nested controls (target !== card); the activation
  // click is what used to collapse the card.
  it.each([
    ['Enter', 'keydown'],
    [' ', 'keyup'],
  ])('keyboard activation (%j) of Once does not collapse the card', async (key, activationPhase) => {
    const {card, button, gateway} = await mountExpandedCardWithPrompt()
    const once = button('.approval-prompt-btn-once')
    once.focus()

    once.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}))
    expect(card.dataset.expanded).toBe('true')
    if (activationPhase === 'keyup') once.dispatchEvent(new KeyboardEvent('keyup', {key, bubbles: true, cancelable: true}))
    once.click()

    await vi.waitFor(() => expect(gateway.decisions).toHaveLength(1))
    expect(card.dataset.expanded).toBe('true')
    expect(gateway.streamsAborted()).toBe(0)
    expect(gateway.decisions[0]?.body).toEqual({decision: 'once'})
  })

  it('clicking the prompt text (the command, the caveat) does not collapse the card', async () => {
    const {card, prompt, gateway} = await mountExpandedCardWithPrompt()

    prompt.querySelector<HTMLElement>('.approval-prompt-action')?.click()
    prompt.querySelector<HTMLElement>('.approval-prompt-caveat-access')?.click()
    prompt.click()

    expect(card.dataset.expanded).toBe('true')
    expect(gateway.streamsAborted()).toBe(0)
    expect(gateway.decisions).toHaveLength(0)
  })

  it('clicking the card itself (outside the prompt) still collapses it and closes the stream', async () => {
    const {card, gateway} = await mountExpandedCardWithPrompt()

    card.click()

    expect(card.dataset.expanded).toBe('false')
    await vi.waitFor(() => expect(gateway.streamsAborted()).toBe(1))
  })
})
