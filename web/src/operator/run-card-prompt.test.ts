/**
 * The launch prompt on run cards: anatomy, list-owned paint, rendering on expand and click behavior.
 *
 * These run the real run index, the real launch module (stream import stubbed) and the real Markdown
 * renderer in jsdom. Only `fetch` is a stub.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {initOperatorStream, resetQuestionPageStore} from '../../../public/operator-stream.js'
import {
  initOperatorRunIndex,
  markCardExpandedForLaunch,
  refreshOperatorRunIndex,
  resetRunIndexState,
  setPromptRenderer,
} from '../../../public/operator-run-index.js'
import {renderOutput} from './markdown-output.ts'

type LaunchModule = typeof import('../../../public/operator-launch.js')
type RunSummaryLike = Record<string, unknown>

// The renderer demotes headings, so a Markdown `#` is not an h1.
const HEADING = 'h1, h2, h3, h4, h5, h6'

const STREAM_SPECIFIER = '/static/operator-stream.js?manual=1'

const MARKDOWN_PROMPT = [
  '# Plan',
  '',
  '- first',
  '- second',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  'See [the docs](https://example.com/docs)',
].join('\n')

// The roles every card shape carries, in DOM order: the header row, the prompt pair, then the
// stream-owned regions.
const CARD_ROLES = [
  'run-status-group',
  'run-repo',
  'run-updated-at',
  'run-prompt-preview',
  'run-prompt',
  'run-checkout-detail',
  'run-waiting',
  'run-output',
  'run-output-tools',
  'run-output-coalesced',
  'run-approvals',
  'run-questions',
  'approval-badge',
  'run-cancel',
]

const summary = (runId: string, extra: RunSummaryLike = {}): RunSummaryLike => ({
  runId,
  repo: 'fro-bot/agent',
  status: 'succeeded',
  createdAt: '2026-10-06T10:00:00.000Z',
  updatedAt: '2026-10-06T10:05:00.000Z',
  ...extra,
})

let runs: RunSummaryLike[] = []

function mountList(): HTMLElement {
  document.body.innerHTML = `
    <section data-role="run-index">
      <div data-role="run-index-loading"></div>
      <div data-role="run-index-list"></div>
      <div data-role="run-index-empty"></div>
      <div data-role="run-index-unavailable"></div>
    </section>`
  return document.querySelector<HTMLElement>('[data-role="run-index-list"]') as HTMLElement
}

function stubRunsFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, status: 200, json: async () => ({runs})})))
}

async function loadList(initial: RunSummaryLike[], onSelectRun = vi.fn()): Promise<HTMLElement> {
  runs = initial
  const list = mountList()
  stubRunsFetch()
  await initOperatorRunIndex({onSelectRun})
  return list
}

async function refreshWith(next: RunSummaryLike[]): Promise<void> {
  runs = next
  expect(await refreshOperatorRunIndex()).toBe(true)
}

const cardOf = (runId: string) => document.querySelector<HTMLElement>(`[data-run-id="${runId}"]`) as HTMLElement
const part = (card: HTMLElement, role: string) => card.querySelector<HTMLElement>(`[data-role="${role}"]`) as HTMLElement
const roles = (card: HTMLElement) => Array.from(card.children, child => (child as HTMLElement).dataset.role)

beforeEach(() => {
  window.location.hash = ''
})

afterEach(() => {
  setPromptRenderer(undefined)
  resetRunIndexState()
  resetQuestionPageStore()
  document.body.replaceChildren()
  vi.doUnmock(STREAM_SPECIFIER)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('prompt elements — same position on every card shape', () => {
  it('a fetched card has the preview and the body between the header row and the stream regions', async () => {
    await loadList([summary('run-fetched')])
    expect(roles(cardOf('run-fetched'))).toEqual(CARD_ROLES)
  })

  it('an upgraded launch-shaped card without the prompt elements gains them in the same slot', async () => {
    mountList()
    const list = document.querySelector<HTMLElement>('[data-role="run-index-list"]') as HTMLElement
    const old = document.createElement('div')
    old.dataset.runId = 'run-old-shape'
    old.dataset.optimistic = 'true'
    for (const role of ['run-status-group', 'run-updated-at', 'run-checkout-detail', 'run-waiting', 'run-output', 'run-output-tools', 'run-output-coalesced', 'run-approvals', 'run-questions', 'approval-badge', 'run-cancel']) {
      const el = document.createElement(role === 'run-updated-at' ? 'time' : 'div')
      el.dataset.role = role
      old.append(el)
    }
    list.append(old)
    runs = [summary('run-old-shape', {prompt: 'sent text'})]
    stubRunsFetch()
    await initOperatorRunIndex({onSelectRun: vi.fn()})

    expect(roles(cardOf('run-old-shape'))).toEqual(CARD_ROLES)
    expect(part(cardOf('run-old-shape'), 'run-prompt-preview').textContent).toBe('sent text')
  })

  it('a card first rendered without updatedAt gains its time ahead of the prompt elements', async () => {
    const withoutTime = summary('run-late-time')
    delete withoutTime.updatedAt
    await loadList([withoutTime])
    expect(roles(cardOf('run-late-time'))).toEqual(CARD_ROLES.filter(role => role !== 'run-updated-at'))

    await refreshWith([summary('run-late-time')])
    expect(roles(cardOf('run-late-time'))).toEqual(CARD_ROLES)
  })

  it('a launch card matches a fetched card, including after the list adopts it', async () => {
    const launched = await launchCard('run-launched', 'sent prompt')
    expect(roles(launched)).toEqual(CARD_ROLES)

    runs = [summary('run-launched', {prompt: 'sent prompt'})]
    stubRunsFetch()
    await initOperatorRunIndex({onSelectRun: vi.fn()})
    expect(roles(cardOf('run-launched'))).toEqual(CARD_ROLES)
  })

  it('collapse hides none of the prompt elements', async () => {
    await loadList([summary('run-collapse', {prompt: 'keep me'})])
    const card = cardOf('run-collapse')
    card.click()
    card.click()
    expect(card.dataset.expanded).toBe('false')
    expect(part(card, 'run-prompt-preview').hidden).toBe(false)
    expect(part(card, 'run-prompt').hidden).toBe(false)
  })
})

describe('prompt paint — list-owned', () => {
  it('shows the raw prompt in the preview and as plain text in the body', async () => {
    await loadList([summary('run-paint', {prompt: MARKDOWN_PROMPT})])
    const card = cardOf('run-paint')
    expect(part(card, 'run-prompt-preview').textContent).toBe(MARKDOWN_PROMPT)
    expect(part(card, 'run-prompt').textContent).toBe(MARKDOWN_PROMPT)
    expect(part(card, 'run-prompt').children).toHaveLength(0)
  })

  it('a run with no prompt shows nothing', async () => {
    await loadList([summary('run-none')])
    const card = cardOf('run-none')
    expect(part(card, 'run-prompt-preview').matches(':empty')).toBe(true)
    expect(part(card, 'run-prompt').matches(':empty')).toBe(true)
  })

  it('a list that loses the prompt clears both elements, including a rendered body', async () => {
    setPromptRenderer(renderOutput)
    await loadList([summary('run-lost', {prompt: MARKDOWN_PROMPT})])
    const card = cardOf('run-lost')
    card.click()
    card.click()
    expect(part(card, 'run-prompt').querySelector(HEADING)).not.toBeNull()

    await refreshWith([summary('run-lost')])
    expect(part(card, 'run-prompt-preview').matches(':empty')).toBe(true)
    expect(part(card, 'run-prompt').matches(':empty')).toBe(true)
  })

  it('a changed prompt resets the body to plain text and the next expand renders the new text', async () => {
    setPromptRenderer(renderOutput)
    await loadList([summary('run-changed', {prompt: '# One'})])
    const card = cardOf('run-changed')
    card.click()
    expect(part(card, 'run-prompt').querySelector(HEADING)?.textContent).toBe('One')
    card.click()

    await refreshWith([summary('run-changed', {prompt: '# Two'})])
    expect(part(card, 'run-prompt-preview').textContent).toBe('# Two')
    expect(part(card, 'run-prompt').textContent).toBe('# Two')
    expect(part(card, 'run-prompt').children).toHaveLength(0)

    card.click()
    expect(part(card, 'run-prompt').querySelector(HEADING)?.textContent).toBe('Two')
  })

  it('an unchanged prompt keeps its rendered body across a refresh', async () => {
    setPromptRenderer(renderOutput)
    await loadList([summary('run-stable', {prompt: MARKDOWN_PROMPT})])
    const card = cardOf('run-stable')
    card.click()
    card.click()
    const heading = part(card, 'run-prompt').querySelector(HEADING)
    expect(heading).not.toBeNull()

    await refreshWith([summary('run-stable', {prompt: MARKDOWN_PROMPT})])
    expect(part(card, 'run-prompt').querySelector(HEADING)).toBe(heading)
  })

  it('keeps a prompt of trailing and leading whitespace byte for byte', async () => {
    const prompt = '  \n  padded  \n\t'
    await loadList([summary('run-padded', {prompt})])
    expect(part(cardOf('run-padded'), 'run-prompt-preview').textContent).toBe(prompt)
    expect(part(cardOf('run-padded'), 'run-prompt').textContent).toBe(prompt)
  })
})

describe('prompt body — rendered on expand', () => {
  it('expanding a card with a Markdown prompt renders headings, lists and code', async () => {
    setPromptRenderer(renderOutput)
    await loadList([summary('run-md', {prompt: MARKDOWN_PROMPT})])
    const card = cardOf('run-md')

    card.click()

    const body = part(card, 'run-prompt')
    expect(body.querySelector(HEADING)?.textContent).toBe('Plan')
    expect(body.querySelectorAll('li')).toHaveLength(2)
    expect(body.querySelector('pre code')?.textContent).toContain('const x = 1')
    expect(body.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs')
    // The preview stays the raw text.
    expect(part(card, 'run-prompt-preview').textContent).toBe(MARKDOWN_PROMPT)
  })

  it('HTML in a prompt stays literal text on the assembled card', async () => {
    setPromptRenderer(renderOutput)
    const html = '<img src=x onerror="globalThis.__promptXss = 1"><script>globalThis.__promptXss = 2</script>\n\n[bad](javascript:alert(1))'
    await loadList([summary('run-html', {prompt: html})])
    const card = cardOf('run-html')

    card.click()

    const body = part(card, 'run-prompt')
    expect(body.querySelector('img, script, iframe')).toBeNull()
    expect(body.textContent).toContain('<img src=x')
    expect(body.textContent).toContain('<script>')
    for (const anchor of body.querySelectorAll('a')) expect(anchor.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
    expect((globalThis as {__promptXss?: number}).__promptXss).toBeUndefined()
    expect(part(card, 'run-prompt-preview').children).toHaveLength(0)
  })

  it('expanding before the renderer loads shows plain text, and the next expand after setPromptRenderer renders Markdown', async () => {
    await loadList([summary('run-early', {prompt: MARKDOWN_PROMPT})])
    const card = cardOf('run-early')

    card.click()
    expect(part(card, 'run-prompt').textContent).toBe(MARKDOWN_PROMPT)
    expect(part(card, 'run-prompt').querySelector(HEADING)).toBeNull()

    setPromptRenderer(renderOutput)
    // No global repaint: the open card keeps its plain text until it is expanded again.
    expect(part(card, 'run-prompt').querySelector(HEADING)).toBeNull()

    card.click()
    card.click()
    expect(part(card, 'run-prompt').querySelector(HEADING)?.textContent).toBe('Plan')
  })

  it('a renderer that throws leaves plain text, and a working renderer renders on the next expand', async () => {
    setPromptRenderer(() => {
      throw new Error('renderer failed')
    })
    await loadList([summary('run-throws', {prompt: MARKDOWN_PROMPT})])
    const card = cardOf('run-throws')

    expect(() => card.click()).not.toThrow()
    expect(card.dataset.expanded).toBe('true')
    expect(part(card, 'run-prompt').textContent).toBe(MARKDOWN_PROMPT)
    expect(part(card, 'run-prompt').children).toHaveLength(0)

    setPromptRenderer(renderOutput)
    card.click()
    card.click()
    expect(part(card, 'run-prompt').querySelector(HEADING)).not.toBeNull()
  })

  it('a renderer that throws after building nodes leaves no partial body', async () => {
    setPromptRenderer((_text, context) => {
      const fragment = context.doc.createDocumentFragment()
      fragment.append(context.doc.createElement('h1'))
      throw new Error('late failure')
    })
    await loadList([summary('run-partial', {prompt: 'plain'})])
    const card = cardOf('run-partial')

    card.click()
    expect(part(card, 'run-prompt').textContent).toBe('plain')
    expect(part(card, 'run-prompt').children).toHaveLength(0)
  })

  it('clearing the renderer makes a new prompt expand as plain text', async () => {
    setPromptRenderer(renderOutput)
    setPromptRenderer(undefined)
    await loadList([summary('run-cleared', {prompt: '# Plain'})])
    const card = cardOf('run-cleared')
    card.click()
    expect(part(card, 'run-prompt').querySelector(HEADING)).toBeNull()
  })

  it('a card with no prompt does not call the renderer on expand', async () => {
    const renderer = vi.fn(renderOutput)
    setPromptRenderer(renderer)
    await loadList([summary('run-no-render')])
    cardOf('run-no-render').click()
    expect(renderer).not.toHaveBeenCalled()
  })

  it('a restore-expanded card renders its body too', async () => {
    setPromptRenderer(renderOutput)
    runs = [summary('run-restore', {prompt: '# Restored'})]
    mountList()
    stubRunsFetch()
    await initOperatorRunIndex({onSelectRun: vi.fn(), restoreRunId: 'run-restore', onRestoreRun: vi.fn()})
    expect(part(cardOf('run-restore'), 'run-prompt').querySelector(HEADING)?.textContent).toBe('Restored')
  })
})

describe('launched card', () => {
  it('seeds the preview and body with the exact prompt that was sent', async () => {
    const sent = ' \n# Sent\n\n- a\n- b\n '
    const card = await launchCard('run-seed', sent)
    expect(part(card, 'run-prompt-preview').textContent).toBe(sent)
    expect(part(card, 'run-prompt').textContent).toBe(sent)
    expect(part(card, 'run-prompt').children).toHaveLength(0)
  })

  it('expanded at launch, it shows the sent prompt as Markdown once the renderer is set', async () => {
    setPromptRenderer(renderOutput)
    const sent = '# Sent\n\n- a\n- b'
    const card = await launchCard('run-seed-md', sent)

    markCardExpandedForLaunch('run-seed-md')

    expect(card.dataset.expanded).toBe('true')
    expect(part(card, 'run-prompt').querySelector(HEADING)?.textContent).toBe('Sent')
    expect(part(card, 'run-prompt').querySelectorAll('li')).toHaveLength(2)
  })

  it('expanded at launch with no renderer, it shows the sent prompt as plain text', async () => {
    const sent = '# Sent'
    const card = await launchCard('run-seed-plain', sent)

    markCardExpandedForLaunch('run-seed-plain')

    expect(card.dataset.expanded).toBe('true')
    expect(part(card, 'run-prompt').textContent).toBe(sent)
    expect(part(card, 'run-prompt').children).toHaveLength(0)
  })

  it('adoption by the list keeps the seeded prompt when the list carries the same text', async () => {
    const sent = '# Same'
    await launchCard('run-adopt', sent)
    runs = [summary('run-adopt', {prompt: sent})]
    stubRunsFetch()
    await initOperatorRunIndex({onSelectRun: vi.fn()})
    const card = cardOf('run-adopt')
    expect(part(card, 'run-prompt-preview').textContent).toBe(sent)
    expect(part(card, 'run-prompt').textContent).toBe(sent)
  })
})

// The document-level listener that keeps a link click inert; removed after each test so it never
// cancels a later test's clicks.
let cancelClicks: ((event: Event) => void) | undefined

describe('clicks inside the prompt body', () => {
  afterEach(() => {
    if (cancelClicks !== undefined) document.removeEventListener('click', cancelClicks)
    cancelClicks = undefined
  })

  // A parent click counter proves the click reached the card's ancestors: the card's own guard is the only
  // thing that keeps the toggle from firing.
  async function expandedMarkdownCard() {
    setPromptRenderer(renderOutput)
    const onSelectRun = vi.fn()
    const list = await loadList([summary('run-click', {prompt: MARKDOWN_PROMPT})], onSelectRun)
    const card = cardOf('run-click')
    card.click()
    expect(onSelectRun).toHaveBeenCalledTimes(1)
    const parentClicks = vi.fn()
    list.addEventListener('click', parentClicks)
    // jsdom does not navigate; cancel the default so a link click stays inert.
    cancelClicks = event => event.preventDefault()
    document.addEventListener('click', cancelClicks)
    return {card, onSelectRun, parentClicks}
  }

  it('a click on a link inside the body does not toggle the card', async () => {
    const {card, onSelectRun, parentClicks} = await expandedMarkdownCard()
    const link = part(card, 'run-prompt').querySelector('a') as HTMLAnchorElement
    expect(link).not.toBeNull()

    link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, detail: 1}))

    expect(parentClicks).toHaveBeenCalledTimes(1)
    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(card.dataset.expanded).toBe('true')
  })

  it('a click while text in the body is selected does not toggle the card', async () => {
    const {card, onSelectRun, parentClicks} = await expandedMarkdownCard()
    const body = part(card, 'run-prompt')
    const range = document.createRange()
    range.selectNodeContents(body.querySelector(HEADING) as HTMLElement)
    const selection = document.getSelection() as Selection
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selection.isCollapsed).toBe(false)

    body.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))

    expect(parentClicks).toHaveBeenCalledTimes(1)
    expect(onSelectRun).toHaveBeenCalledTimes(1)
    expect(card.dataset.expanded).toBe('true')
    selection.removeAllRanges()
  })
})

describe('document click listeners between tests', () => {
  it('leaves no listener behind that cancels a later click', () => {
    const target = document.createElement('div')
    document.body.append(target)
    const click = new MouseEvent('click', {bubbles: true, cancelable: true})

    target.dispatchEvent(click)

    expect(click.defaultPrevented).toBe(false)
  })
})

describe('finished-run cache hit', () => {
  it('painting a finished record leaves the prompt and its rendered body in place', async () => {
    setPromptRenderer(renderOutput)
    await loadList([summary('run-cached', {prompt: MARKDOWN_PROMPT})])
    const card = cardOf('run-cached')
    card.click()
    const body = part(card, 'run-prompt')
    const heading = body.querySelector(HEADING)
    expect(heading).not.toBeNull()

    const handle = initOperatorStream({
      runId: 'run-cached',
      statusEl: part(card, 'run-status'),
      noticeEl: document.createElement('div'),
      reasonEl: part(card, 'run-reason'),
      outputEl: part(card, 'run-output') as HTMLElement & {hidden: boolean},
      checkoutEl: part(card, 'run-checkout-detail') as HTMLElement & {hidden: boolean},
      waitingEl: part(card, 'run-waiting') as HTMLElement & {hidden: boolean},
      finishedRecord: Object.freeze({
        runId: 'run-cached',
        status: 'succeeded',
        terminal: true as const,
        phase: 'COMPLETED',
        stale: false,
        startedAt: '2026-10-06T10:00:00Z',
        outputText: 'finished output',
        outputTruncated: false,
        outputCoalesced: false,
      }),
    })

    expect(handle.getConnectionStatus()).toBe('terminal')
    expect(part(card, 'run-output').textContent).toBe('finished output')
    expect(part(card, 'run-prompt-preview').textContent).toBe(MARKDOWN_PROMPT)
    expect(part(card, 'run-prompt').querySelector(HEADING)).toBe(heading)
    expect(roles(card)).toEqual(CARD_ROLES)
    handle.close()
  })
})

/**
 * Submit a launch through the real launch module and return the card it inserts. The stream import is
 * stubbed; the form needs a repo option, which the stubbed repo list provides.
 */
async function launchCard(runId: string, prompt: string): Promise<HTMLElement> {
  vi.doMock(STREAM_SPECIFIER, () => ({
    initOperatorStream: vi.fn(),
    takeUsableFinishedRun: vi.fn(() => undefined),
    pruneFinishedRuns: vi.fn(),
    clearFinishedRuns: vi.fn(),
    resetOutputView: vi.fn(),
  }))
  const launch: LaunchModule = await import('../../../public/operator-launch.js')
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.endsWith('/session/csrf')) return json(200, {csrfToken: 'csrf-token'})
    if (input.endsWith('/repos')) return json(200, [{owner: 'fro-bot', repo: 'agent'}])
    if (input.endsWith('/runs')) return json(202, {runId})
    return json(404, {})
  }))
  document.body.innerHTML = `
    <div id="repo-picker-container"></div>
    <form id="launch-form">
      <textarea id="launch-prompt" name="prompt" aria-describedby="launch-prompt-status"></textarea>
      <div id="launch-prompt-status" role="status"></div>
      <div id="launch-error" role="alert" hidden></div>
      <button type="submit">Launch</button>
    </form>
    <section data-role="run-index"><div data-role="run-index-list"></div></section>`
  await launch.initOperatorLaunch({onRunLaunched: vi.fn()})
  const textarea = document.querySelector<HTMLTextAreaElement>('#launch-prompt') as HTMLTextAreaElement
  textarea.value = prompt
  textarea.dispatchEvent(new Event('input', {bubbles: true}))
  const form = document.querySelector<HTMLFormElement>('#launch-form') as HTMLFormElement
  form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
  const card = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-run-id="${runId}"]`)
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  launch.resetLaunchState()
  return card
}
