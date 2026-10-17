/**
 * Integration tests for run output as Markdown: the real stream module, the real run-index card
 * builder and the real renderer over jsdom. The unit suites fake one side or the other; these prove
 * the two fit together on every path that paints output.
 *
 * Every click test carries a parent click listener: the card never stops propagation, so the
 * listener must always see the click, and what varies is whether the card handler acted on it.
 */

import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  clearFinishedRuns,
  initOperatorStream,
  PINNED_CONTRACT_VERSION,
  resetOutputView,
  resetQuestionPageStore,
} from '../../../public/operator-stream.js'
import {renderOutput} from './markdown-output.ts'
import {discoverCardStreamTargets} from './runtime.ts'

type RunIndexModule = typeof import('../../../public/operator-run-index.js')
type StreamHandle = ReturnType<typeof initOperatorStream>

const RUN_ID = 'run-markdown'
const RAW = 'Read the **docs** at [the guide](https://elsewhere.example/page).\n\n- one\n- two'

let runIndexMod: RunIndexModule | undefined
let streamFetch: (() => Promise<unknown>) | undefined
const handles: StreamHandle[] = []

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}})
}

/** One real list card, built by the run index, with the click spies it reports to. */
async function mountListCard() {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input).endsWith('/runs')) {
      return jsonResponse({runs: [{runId: RUN_ID, repo: 'fro-bot/agent', status: 'succeeded', createdAt: '2026-06-26T12:00:00.000Z'}]})
    }
    return streamFetch === undefined ? new Promise<never>(() => {}) : streamFetch()
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
  const card = document.querySelector<HTMLElement>(`[data-run-id="${RUN_ID}"]`) as HTMLElement
  return {card, onSelectRun, parentClick}
}

function finishedRecord(outputText: string) {
  return {
    runId: RUN_ID,
    status: 'succeeded',
    terminal: true,
    phase: 'COMPLETED',
    stale: false,
    startedAt: '2026-06-20T10:00:00Z',
    outputText,
    outputTruncated: false,
    outputCoalesced: false,
  }
}

/** Attach the real stream to the card through the runtime's own region discovery, with the real renderer. */
function attach(card: HTMLElement, extra: Record<string, unknown> = {}): StreamHandle {
  const handle = initOperatorStream({
    runId: RUN_ID,
    statusEl: card.querySelector('[data-role="run-status"]'),
    noticeEl: document.createElement('p'),
    ...discoverCardStreamTargets(RUN_ID),
    renderOutput,
    ...extra,
  } as never)
  handles.push(handle)
  return handle
}

/** A live stream the test feeds frame by frame. */
function feedStream() {
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
  const sse = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  return {
    ready: async () => {
      await vi.waitFor(() => expect(frames).toHaveLength(1))
      frames[0]?.(sse('ready', {contractVersion: PINNED_CONTRACT_VERSION}))
    },
    delta: (text: string, seq: number) => frames[0]?.(sse('output', {runId: RUN_ID, text, final: false, seq})),
    final: (text: string, seq: number) => frames[0]?.(sse('output', {runId: RUN_ID, text, final: true, seq})),
  }
}

const output = (card: HTMLElement) => card.querySelector<HTMLElement>('[data-role="run-output"]') as HTMLElement
const tools = (card: HTMLElement) => card.querySelector<HTMLElement>('[data-role="run-output-tools"]') as HTMLElement
const toggleButton = (card: HTMLElement) => tools(card).querySelector<HTMLButtonElement>('button.run-output-toggle') as HTMLButtonElement
const copyButton = (card: HTMLElement) => tools(card).querySelector<HTMLButtonElement>('button.run-output-copy') as HTMLButtonElement

function click(el: Element): MouseEvent {
  const event = new MouseEvent('click', {bubbles: true, cancelable: true})
  el.dispatchEvent(event)
  return event
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  vi.unstubAllGlobals()
  streamFetch = undefined
  Reflect.deleteProperty(navigator, 'clipboard')
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  runIndexMod?.resetRunIndexState()
  resetOutputView()
  resetQuestionPageStore()
  clearFinishedRuns()
})

describe('streamed output', () => {
  it('renders deltas as Markdown elements, and the final frame replaces them', async () => {
    const {card} = await mountListCard()
    const stream = feedStream()
    attach(card)
    await stream.ready()

    stream.delta('Intro **bold** text', 0)
    await vi.waitFor(() => expect(output(card).querySelector('strong')?.textContent).toBe('bold'))
    expect(output(card).getAttribute('data-output-view')).toBe('rendered')

    stream.delta('\n\n- first\n- second', 1)
    await vi.waitFor(() => expect(output(card).querySelectorAll('li')).toHaveLength(2))
    expect(output(card).querySelector('strong')?.textContent).toBe('bold')

    stream.final('The *final* answer', 2)
    await vi.waitFor(() => expect(output(card).querySelector('em')?.textContent).toBe('final'))
    expect(output(card).textContent).toBe('The final answer')
    expect(output(card).querySelector('li')).toBeNull()
    expect(output(card).querySelector('strong')).toBeNull()
  })
})

describe('recorded repaint', () => {
  it('renders the record as Markdown at init, with the safe link', async () => {
    const {card} = await mountListCard()

    attach(card, {finishedRecord: finishedRecord(RAW)})

    expect(output(card).querySelector('strong')?.textContent).toBe('docs')
    expect(output(card).querySelectorAll('li')).toHaveLength(2)
    const anchor = output(card).querySelector('a') as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe('https://elsewhere.example/page')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('stays plain text when no renderer is passed', async () => {
    const {card} = await mountListCard()

    attach(card, {finishedRecord: finishedRecord(RAW), renderOutput: undefined})

    expect(output(card).textContent).toBe(RAW)
    expect(output(card).querySelector('strong, li, a')).toBeNull()
    expect(toggleButton(card).hidden).toBe(true)
  })
})

describe('hostile output', () => {
  const HOSTILE = [
    '<script>globalThis.__pwned = 1</script>',
    '<img src="https://elsewhere.example/x.png" onerror="globalThis.__pwned = 1">',
    '[click](javascript:globalThis.__pwned=1)',
    '![pixel](https://elsewhere.example/pixel.png)',
    '<a href="javascript:globalThis.__pwned=1" onclick="globalThis.__pwned=1">raw anchor</a>',
  ].join('\n\n')

  it('stays inert: no script, image or handler is created, and no link carries a script URL', async () => {
    const {card} = await mountListCard()

    attach(card, {finishedRecord: finishedRecord(HOSTILE)})

    const out = output(card)
    expect(out.querySelector('script, img, iframe, style, object, embed, svg')).toBeNull()
    for (const el of out.querySelectorAll('*')) {
      expect(el.getAttributeNames().filter(name => name.startsWith('on') || name === 'style' || name === 'src')).toEqual([])
    }
    for (const anchor of out.querySelectorAll('a')) {
      expect(anchor.getAttribute('href')).toMatch(/^https?:/)
    }
    expect(out.textContent).toContain('<script>globalThis.__pwned = 1</script>')
    expect(out.textContent).toContain('javascript:globalThis.__pwned=1')
    expect((globalThis as {__pwned?: number}).__pwned).toBeUndefined()
  })
})

describe('Rendered/Raw toggle and Copy raw', () => {
  it('flips to the raw text and back', async () => {
    const {card} = await mountListCard()
    attach(card, {finishedRecord: finishedRecord(RAW)})

    click(toggleButton(card))

    expect(toggleButton(card).getAttribute('aria-pressed')).toBe('true')
    expect(output(card).getAttribute('data-output-view')).toBe('raw')
    expect(output(card).textContent).toBe(RAW)
    expect(output(card).querySelector('strong, li, a')).toBeNull()

    click(toggleButton(card))

    expect(toggleButton(card).getAttribute('aria-pressed')).toBe('false')
    expect(output(card).getAttribute('data-output-view')).toBe('rendered')
    expect(output(card).querySelector('strong')?.textContent).toBe('docs')
  })

  it('Copy raw reads the raw text, not the rendered DOM', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true})
    const {card} = await mountListCard()
    attach(card, {finishedRecord: finishedRecord(RAW)})
    expect(output(card).textContent).not.toBe(RAW)

    click(copyButton(card))

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(RAW)
  })
})

describe('card click guard with rendered links', () => {
  it('clicking a rendered link does not toggle the card, and the click still bubbles', async () => {
    const {card, onSelectRun, parentClick} = await mountListCard()
    click(card) // the operator expands the card
    expect(card.dataset.expanded).toBe('true')
    onSelectRun.mockClear()
    parentClick.mockClear()
    attach(card, {finishedRecord: finishedRecord(RAW)})
    const anchor = output(card).querySelector('a') as HTMLElement

    const event = click(anchor)

    expect(onSelectRun).not.toHaveBeenCalled()
    expect(card.dataset.expanded).toBe('true')
    expect(parentClick).toHaveBeenCalledTimes(1)
    expect(event.cancelBubble).toBe(false)
  })
})
