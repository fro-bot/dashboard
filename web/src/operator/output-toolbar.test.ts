/**
 * Behavioral tests for the run-output toolbar (Rendered/Raw toggle and Copy raw) and for the card
 * click guard. They run the real stream module and the real run-index card builder over jsdom, with a
 * fake renderer: real-renderer integration lives with the runtime wiring tests.
 *
 * Every click test carries a parent click listener. The card never stops propagation, so the listener
 * must always see the click; what varies is whether the card handler acted on it.
 */

import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  clearFinishedRuns,
  initOperatorStream,
  PINNED_CONTRACT_VERSION,
  resetOutputView,
  resetQuestionPageStore,
} from '../../../public/operator-stream.js'
import {discoverCardStreamTargets} from './runtime.ts'

type RunIndexModule = typeof import('../../../public/operator-run-index.js')
type StreamHandle = ReturnType<typeof initOperatorStream>

const RUN_ID = 'run-toolbar'
const OTHER_RUN_ID = 'run-toolbar-other'
const COPY_FAILED = 'Copy failed. Select the text and copy it.'
const TRUNCATION_NOTE = '256,000'

let runIndexMod: RunIndexModule | undefined
let streamFetch: ((input: string) => Promise<unknown>) | undefined
const handles: StreamHandle[] = []

/** The renderer stands in for the Markdown module: a paragraph holding the text and one link. */
const fakeRenderer = vi.fn((text: string, ctx: {doc: Document; origin: string}) => {
  const fragment = ctx.doc.createDocumentFragment()
  const paragraph = ctx.doc.createElement('p')
  paragraph.className = 'rendered-line'
  paragraph.append(`rendered:${text} `)
  const link = ctx.doc.createElement('a')
  link.href = 'https://elsewhere.example/page'
  link.textContent = 'a link'
  paragraph.append(link)
  fragment.append(paragraph)
  return fragment
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}})
}

/** Build list cards through the real run-index renderer. Returns them with the click-spy they report to. */
async function mountListCards(runIds: string[] = [RUN_ID]) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input).endsWith('/runs')) {
      return jsonResponse({
        runs: runIds.map(runId => ({runId, repo: 'fro-bot/agent', status: 'succeeded', createdAt: '2026-06-26T12:00:00.000Z'})),
      })
    }
    // Anything else is a run stream: served by the test, or left pending.
    return streamFetch === undefined ? new Promise<never>(() => {}) : streamFetch(String(input))
  }))
  runIndexMod = await import('../../../public/operator-run-index.js')
  runIndexMod.resetRunIndexState()
  document.body.innerHTML = '<div data-role="run-index"><div data-role="run-index-list"></div></div>'
  const onSelectRun = vi.fn()
  await runIndexMod.initOperatorRunIndex({endpointBase: '/operator', onSelectRun})

  const list = document.querySelector<HTMLElement>('[data-role="run-index-list"]') as HTMLElement
  // Preventing the default keeps jsdom from navigating when a test clicks a rendered link.
  const parentClick = vi.fn((event: Event) => event.preventDefault())
  list.addEventListener('click', parentClick)
  const cards = new Map(runIds.map(runId => [runId, document.querySelector<HTMLElement>(`[data-run-id="${runId}"]`) as HTMLElement]))
  return {list, cards, onSelectRun, parentClick}
}

function record(runId: string, extra: Record<string, unknown> = {}) {
  return {
    runId,
    status: 'succeeded',
    terminal: true,
    phase: 'COMPLETED',
    stale: false,
    startedAt: '2026-06-20T10:00:00Z',
    outputText: 'final **answer**',
    outputTruncated: false,
    outputCoalesced: false,
    ...extra,
  }
}

/** Attach the real stream to a list card through the runtime's own region discovery. */
function attach(card: HTMLElement, runId: string, extra: Record<string, unknown> = {}): StreamHandle {
  const targets = discoverCardStreamTargets(runId)
  expect(card.contains(targets.outputEl)).toBe(true)
  const handle = initOperatorStream({
    runId,
    statusEl: card.querySelector('[data-role="run-status"]'),
    noticeEl: document.createElement('p'),
    ...targets,
    finishedRecord: record(runId),
    renderOutput: fakeRenderer,
    ...extra,
  } as never)
  handles.push(handle)
  return handle
}

const region = (card: HTMLElement, role: string) => card.querySelector<HTMLElement>(`[data-role="${role}"]`) as HTMLElement
const tools = (card: HTMLElement) => region(card, 'run-output-tools')
const toggleButton = (card: HTMLElement) => tools(card).querySelector<HTMLButtonElement>('button.run-output-toggle') as HTMLButtonElement
const copyButton = (card: HTMLElement) => tools(card).querySelector<HTMLButtonElement>('button.run-output-copy') as HTMLButtonElement
const copyStatus = (card: HTMLElement) => tools(card).querySelector<HTMLElement>('[role="status"]') as HTMLElement

function click(el: Element): MouseEvent {
  const event = new MouseEvent('click', {bubbles: true, cancelable: true})
  el.dispatchEvent(event)
  return event
}

function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {value: writeText === undefined ? undefined : {writeText}, configurable: true})
}

const flush = () => vi.advanceTimersByTimeAsync(0)

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  streamFetch = undefined
  Reflect.deleteProperty(navigator, 'clipboard')
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  runIndexMod?.resetRunIndexState()
  resetOutputView()
  resetQuestionPageStore()
  clearFinishedRuns()
  fakeRenderer.mockClear()
})

describe('output toolbar region', () => {
  it('sits right after the output region on a list card, hidden and empty', async () => {
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    const roles = [...card.children].map(child => (child as HTMLElement).dataset.role)

    expect(roles.indexOf('run-output-tools')).toBe(roles.indexOf('run-output') + 1)
    expect(tools(card).hidden).toBe(true)
    expect(tools(card).childElementCount).toBe(0)
  })

  it('is handed to the stream by the runtime region discovery', async () => {
    const {cards} = await mountListCards()
    expect(discoverCardStreamTargets(RUN_ID).toolsEl).toBe(tools(cards.get(RUN_ID) as HTMLElement))
  })

  it.each([
    ['finished output', {outputText: 'hello'}, false],
    ['an empty result', {outputText: ''}, true],
    ['an unavailable snapshot', {outputText: undefined, outputUnavailable: true}, true],
  ])('for %s the toolbar hidden state is %s', async (_name, extra, hidden) => {
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    attach(card, RUN_ID, {finishedRecord: record(RUN_ID, extra)})

    expect(tools(card).hidden).toBe(hidden)
  })

  it('is cleared and hidden again when the card is attached afresh', async () => {
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    const first = attach(card, RUN_ID)
    expect(tools(card).hidden).toBe(false)
    first.close()

    attach(card, RUN_ID, {finishedRecord: record(RUN_ID, {outputText: ''})})
    expect(tools(card).hidden).toBe(true)
  })

  it('is hidden by collapsing the card', async () => {
    const {cards, onSelectRun} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    click(card)
    attach(card, RUN_ID)
    expect(tools(card).hidden).toBe(false)

    click(card)

    expect(card.dataset.expanded).toBe('false')
    expect(tools(card).hidden).toBe(true)
    expect(onSelectRun).toHaveBeenCalledTimes(2)
  })

  it('is hidden when the handle closes, leaving no live controls behind', async () => {
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    const handle = attach(card, RUN_ID)

    handle.close()

    expect(tools(card).hidden).toBe(true)
  })
})

describe('Rendered/Raw toggle', () => {
  it('is labelled "Raw text", unpressed while the preference is Rendered', async () => {
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    attach(card, RUN_ID)

    expect(toggleButton(card).textContent).toBe('Raw text')
    expect(toggleButton(card).getAttribute('aria-pressed')).toBe('false')
    expect(toggleButton(card).hidden).toBe(false)
    expect(region(card, 'run-output').getAttribute('data-output-view')).toBe('rendered')
  })

  it('flips the page preference, repaints the attached card and reflects it in aria-pressed', async () => {
    const {cards, onSelectRun, parentClick} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    attach(card, RUN_ID)
    const output = region(card, 'run-output')

    click(toggleButton(card))
    expect(parentClick).toHaveBeenCalledTimes(1)
    expect(onSelectRun).not.toHaveBeenCalled()

    expect(toggleButton(card).getAttribute('aria-pressed')).toBe('true')
    expect(output.getAttribute('data-output-view')).toBe('raw')
    expect(output.textContent).toBe('final **answer**')

    click(toggleButton(card))

    expect(toggleButton(card).getAttribute('aria-pressed')).toBe('false')
    expect(output.getAttribute('data-output-view')).toBe('rendered')
    expect(output.querySelector('p.rendered-line')).not.toBeNull()
  })

  it('carries the preference to the next card the page attaches', async () => {
    const {cards} = await mountListCards([RUN_ID, OTHER_RUN_ID])
    const first = cards.get(RUN_ID) as HTMLElement
    const second = cards.get(OTHER_RUN_ID) as HTMLElement
    const handle = attach(first, RUN_ID)
    click(toggleButton(first))
    handle.close()

    attach(second, OTHER_RUN_ID, {finishedRecord: record(OTHER_RUN_ID)})

    expect(toggleButton(second).getAttribute('aria-pressed')).toBe('true')
    expect(region(second, 'run-output').getAttribute('data-output-view')).toBe('raw')
  })

  it('follows a preference set through the handle', async () => {
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    const handle = attach(card, RUN_ID)

    handle.setOutputView('raw')

    expect(toggleButton(card).getAttribute('aria-pressed')).toBe('true')
  })

  it('is hidden, not absent, when no renderer is injected, while Copy raw stays available', async () => {
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    attach(card, RUN_ID, {renderOutput: undefined})

    expect(toggleButton(card)).not.toBeNull()
    expect(toggleButton(card).hidden).toBe(true)
    expect(copyButton(card).hidden).toBe(false)
    expect(tools(card).hidden).toBe(false)
  })
})

describe('Rendered/Raw toggle across attachments and render failure', () => {
  const failingRenderer = () => {
    throw new Error('render failed')
  }

  it('repaints every attached card, aria-pressed included, and leaves a closed one alone', async () => {
    const {cards} = await mountListCards([RUN_ID, OTHER_RUN_ID])
    const first = cards.get(RUN_ID) as HTMLElement
    const second = cards.get(OTHER_RUN_ID) as HTMLElement
    const firstHandle = attach(first, RUN_ID)
    attach(second, OTHER_RUN_ID, {finishedRecord: record(OTHER_RUN_ID)})

    click(toggleButton(first))

    expect(toggleButton(second).getAttribute('aria-pressed')).toBe('true')
    expect(region(second, 'run-output').getAttribute('data-output-view')).toBe('raw')
    expect(region(second, 'run-output').textContent).toBe('final **answer**')

    firstHandle.close()
    const staleOutput = region(first, 'run-output').getAttribute('data-output-view')
    click(toggleButton(second))

    expect(toggleButton(second).getAttribute('aria-pressed')).toBe('false')
    expect(region(second, 'run-output').getAttribute('data-output-view')).toBe('rendered')
    expect(region(first, 'run-output').getAttribute('data-output-view')).toBe(staleOutput)
  })

  it('hides the toggle while the renderer failure is latched, keeps Copy raw, and reports the painted view', async () => {
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    attach(card, RUN_ID, {renderOutput: failingRenderer})

    expect(region(card, 'run-output').getAttribute('data-output-view')).toBe('raw')
    expect(region(card, 'run-output').textContent).toBe('final **answer**')
    expect(toggleButton(card).hidden).toBe(true)
    expect(toggleButton(card).getAttribute('aria-pressed')).toBe('true')
    expect(copyButton(card).hidden).toBe(false)
    expect(tools(card).hidden).toBe(false)
  })

  it('shows the toggle again once the view changes, and hides it again if the renderer keeps failing', async () => {
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    const handle = attach(card, RUN_ID, {renderOutput: failingRenderer})
    expect(toggleButton(card).hidden).toBe(true)

    handle.setOutputView('raw')
    expect(toggleButton(card).hidden).toBe(false)
    expect(toggleButton(card).getAttribute('aria-pressed')).toBe('true')

    handle.setOutputView('rendered')
    expect(toggleButton(card).hidden).toBe(true)
    expect(toggleButton(card).getAttribute('aria-pressed')).toBe('true')
    expect(region(card, 'run-output').getAttribute('data-output-view')).toBe('raw')
  })

  it('a card whose render succeeds is untouched by another card latching', async () => {
    const {cards} = await mountListCards([RUN_ID, OTHER_RUN_ID])
    const healthy = cards.get(RUN_ID) as HTMLElement
    const failing = cards.get(OTHER_RUN_ID) as HTMLElement
    attach(healthy, RUN_ID)
    attach(failing, OTHER_RUN_ID, {finishedRecord: record(OTHER_RUN_ID), renderOutput: failingRenderer})

    expect(toggleButton(failing).hidden).toBe(true)
    expect(toggleButton(healthy).hidden).toBe(false)
    expect(toggleButton(healthy).getAttribute('aria-pressed')).toBe('false')
    expect(region(healthy, 'run-output').getAttribute('data-output-view')).toBe('rendered')
  })
})

describe('Copy raw', () => {
  it('writes the raw output text synchronously inside the click, then says "Copied" for about 1.5 s', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const {cards, parentClick} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    attach(card, RUN_ID)

    click(copyButton(card))

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('final **answer**')
    expect(parentClick).toHaveBeenCalledTimes(1)

    await flush()
    expect(copyStatus(card).textContent).toBe('Copied')
    expect(copyStatus(card).getAttribute('aria-live')).toBe('polite')

    await vi.advanceTimersByTimeAsync(1400)
    expect(copyStatus(card).textContent).toBe('Copied')
    await vi.advanceTimersByTimeAsync(200)
    expect(copyStatus(card).textContent).toBe('')
  })

  it('copies the raw text, not the rendered DOM, while the Rendered view is showing', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    attach(card, RUN_ID, {finishedRecord: record(RUN_ID, {outputText: '# heading\n\n- item'})})
    expect(region(card, 'run-output').getAttribute('data-output-view')).toBe('rendered')

    click(copyButton(card))

    expect(writeText).toHaveBeenCalledWith('# heading\n\n- item')
  })

  it('reads the output text from state at click time, not from the painted DOM', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const frames: Array<(text: string) => void> = []
    streamFetch = async () => {
      const queue: string[] = []
      let wake: (() => void) | null = null
      frames.push(text => {
        queue.push(text)
        wake?.()
      })
      return {
        status: 200,
        headers: {get: () => 'text/event-stream'},
        body: {
          getReader: () => ({
            read: async () => {
              while (queue.length === 0) await new Promise<void>(resolve => { wake = resolve })
              return {done: false, value: new TextEncoder().encode(queue.shift() as string)}
            },
          }),
        },
      }
    }
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    attach(card, RUN_ID, {finishedRecord: undefined})
    // A live attach with no output yet: nothing to copy, so no toolbar.
    expect(tools(card).hidden).toBe(true)
    const sse = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    frames[0]?.(sse('ready', {contractVersion: PINNED_CONTRACT_VERSION}))
    frames[0]?.(sse('output', {runId: RUN_ID, text: 'one ', final: false, seq: 0}))
    await vi.waitFor(() => expect(tools(card).hidden).toBe(false))
    frames[0]?.(sse('output', {runId: RUN_ID, text: 'two', final: false, seq: 1}))
    // The throttled repaint may not have landed; state holds both deltas regardless.
    await vi.waitFor(() => expect(region(card, 'run-output').textContent).toContain('two'))

    click(copyButton(card))

    expect(writeText).toHaveBeenCalledWith('one two')
  })

  it('names the 256,000-character limit only when the output is truncated', async () => {
    stubClipboard(vi.fn(async () => {}))
    const {cards} = await mountListCards([RUN_ID, OTHER_RUN_ID])
    const plain = cards.get(RUN_ID) as HTMLElement
    const cut = cards.get(OTHER_RUN_ID) as HTMLElement

    attach(plain, RUN_ID)
    attach(cut, OTHER_RUN_ID, {finishedRecord: record(OTHER_RUN_ID, {outputTruncated: true})})

    const label = (button: HTMLButtonElement) => `${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''}`
    expect(label(copyButton(plain))).not.toContain(TRUNCATION_NOTE)
    expect(label(copyButton(cut))).toContain(TRUNCATION_NOTE)
    expect(label(copyButton(cut))).toMatch(/first 256,000 characters/)
  })

  it.each([
    ['is missing', () => stubClipboard(undefined)],
    ['rejects', () => stubClipboard(vi.fn(async () => { throw new Error('denied') }))],
    ['throws synchronously', () => stubClipboard(vi.fn(() => { throw new Error('blocked') }))],
  ])('says it failed when navigator.clipboard %s', async (_name, arrange) => {
    vi.useFakeTimers()
    arrange()
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    attach(card, RUN_ID)

    click(copyButton(card))
    await flush()

    expect(copyStatus(card).textContent).toBe(COPY_FAILED)
  })

  it('does not fall back to execCommand', async () => {
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {value: execCommand, configurable: true})
    stubClipboard(undefined)
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    attach(card, RUN_ID)

    click(copyButton(card))

    expect(execCommand).not.toHaveBeenCalled()
    Reflect.deleteProperty(document, 'execCommand')
  })

  it('clears the feedback timer when the handle closes', async () => {
    vi.useFakeTimers()
    stubClipboard(vi.fn(async () => {}))
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    const handle = attach(card, RUN_ID)
    click(copyButton(card))
    await flush()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    handle.close()

    expect(vi.getTimerCount()).toBe(0)
    expect(copyStatus(card).textContent).toBe('')
  })

  it('writes no feedback when the clipboard settles after the handle closed', async () => {
    vi.useFakeTimers()
    let settle: () => void = () => {}
    stubClipboard(vi.fn(() => new Promise<void>(resolve => { settle = resolve })))
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    const handle = attach(card, RUN_ID)
    click(copyButton(card))

    handle.close()
    settle()
    await flush()

    expect(copyStatus(card).textContent).toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('toolbar handlers across attachments', () => {
  it('bind once per attach: A to B to A copies exactly once per click', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const {cards} = await mountListCards([RUN_ID, OTHER_RUN_ID])
    const cardA = cards.get(RUN_ID) as HTMLElement
    const cardB = cards.get(OTHER_RUN_ID) as HTMLElement

    attach(cardA, RUN_ID).close()
    attach(cardB, OTHER_RUN_ID, {finishedRecord: record(OTHER_RUN_ID)}).close()
    attach(cardA, RUN_ID)

    click(copyButton(cardA))

    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('are released by close(): a button from a closed attachment does nothing', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const {cards} = await mountListCards()
    const card = cards.get(RUN_ID) as HTMLElement
    const handle = attach(card, RUN_ID)
    const staleCopy = copyButton(card)
    const staleToggle = toggleButton(card)

    handle.close()
    click(staleCopy)
    click(staleToggle)

    expect(writeText).not.toHaveBeenCalled()
    expect(staleToggle.getAttribute('aria-pressed')).toBe('false')
    expect(region(card, 'run-output').getAttribute('data-output-view')).toBe('rendered')
  })
})

describe('card click guard', () => {
  async function expandedCard() {
    const mounted = await mountListCards()
    const card = mounted.cards.get(RUN_ID) as HTMLElement
    click(card) // the operator expands the card
    expect(card.dataset.expanded).toBe('true')
    mounted.onSelectRun.mockClear()
    mounted.parentClick.mockClear()
    attach(card, RUN_ID)
    return {...mounted, card}
  }

  it.each([
    ['the toggle', (card: HTMLElement) => toggleButton(card)],
    ['Copy raw', (card: HTMLElement) => copyButton(card)],
    ['a rendered link', (card: HTMLElement) => region(card, 'run-output').querySelector('a') as HTMLElement],
  ])('clicking %s does not toggle the card, and the click still bubbles', async (_name, target) => {
    stubClipboard(vi.fn(async () => {}))
    const {card, onSelectRun, parentClick} = await expandedCard()

    const event = click(target(card))

    expect(onSelectRun).not.toHaveBeenCalled()
    expect(card.dataset.expanded).toBe('true')
    expect(parentClick).toHaveBeenCalledTimes(1)
    expect(event.cancelBubble).toBe(false)
  })

  it('clicking inside a link child (an element within the anchor) does not toggle the card either', async () => {
    const {card, onSelectRun, parentClick} = await expandedCard()
    const anchor = region(card, 'run-output').querySelector('a') as HTMLElement
    const inner = document.createElement('em')
    inner.textContent = 'deep'
    anchor.append(inner)

    click(inner)

    expect(onSelectRun).not.toHaveBeenCalled()
    expect(parentClick).toHaveBeenCalledTimes(1)
  })

  it('a plain click on output text still toggles the card', async () => {
    const {card, onSelectRun, parentClick} = await expandedCard()

    click(region(card, 'run-output').querySelector('p.rendered-line') as HTMLElement)

    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(onSelectRun).toHaveBeenCalledWith(RUN_ID)
    expect(card.dataset.expanded).toBe('false')
    expect(parentClick).toHaveBeenCalledTimes(1)
  })

  it('Space and Enter on the toolbar buttons do not toggle the card or lose their default action', async () => {
    const {card, onSelectRun} = await expandedCard()

    for (const button of [toggleButton(card), copyButton(card)]) {
      for (const key of [' ', 'Enter']) {
        const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true})
        button.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(false)
      }
    }

    expect(onSelectRun).not.toHaveBeenCalled()
    expect(card.dataset.expanded).toBe('true')
  })

  it('a click while a text selection sits inside the card does not toggle it', async () => {
    const {card, onSelectRun, parentClick} = await expandedCard()
    const line = region(card, 'run-output').querySelector('p.rendered-line') as HTMLElement
    document.getSelection()?.selectAllChildren(line)
    expect(document.getSelection()?.isCollapsed).toBe(false)

    click(line)

    expect(onSelectRun).not.toHaveBeenCalled()
    expect(card.dataset.expanded).toBe('true')
    expect(parentClick).toHaveBeenCalledTimes(1)
  })

  it('a collapsed selection inside the card, or a selection outside it, still lets a click toggle', async () => {
    const {card, onSelectRun} = await expandedCard()
    const line = region(card, 'run-output').querySelector('p.rendered-line') as HTMLElement
    const outside = document.createElement('p')
    outside.textContent = 'outside the card'
    document.body.append(outside)

    document.getSelection()?.collapse(line, 0)
    click(line)
    expect(onSelectRun).toHaveBeenCalledTimes(1)

    document.getSelection()?.selectAllChildren(outside)
    click(line)
    expect(onSelectRun).toHaveBeenCalledTimes(2)
  })

  it('a click on the card itself toggles it', async () => {
    const {card, onSelectRun} = await expandedCard()

    click(card)

    expect(onSelectRun).toHaveBeenCalledTimes(1)
  })
})
