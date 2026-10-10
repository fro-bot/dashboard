import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  PINNED_CONTRACT_VERSION,
  getQuestionPageStore,
  initOperatorStream,
  resetQuestionPageStore,
  type QuestionDecisionOutcome,
} from '../../../public/operator-stream.js'

function openFrame(requestID: string, questions: Record<string, unknown>[]) {
  return `event: question\ndata: ${JSON.stringify({runId: 'run-questions-ui', requestID, settled: false, questions})}\n\n`
}

function question(overrides: Record<string, unknown> = {}) {
  return {
    header: 'Choose a direction',
    text: 'Which direction should the run take?',
    options: [{label: 'Continue', description: 'Keep going'}, {label: 'Stop', description: 'End here'}],
    multiple: false,
    custom: true,
    ...overrides,
  }
}

function makeClient(decisionOutcome: QuestionDecisionOutcome = {kind: 'invalid', reason: 'arity-mismatch', questionIndex: 1}) {
  return {
    listRunQuestions: vi.fn(() => new Promise<never>(() => {})),
    decideRunQuestion: vi.fn(async () => decisionOutcome),
  }
}

async function mountQuestionRegion(
  frames: string[],
  decisionOutcome?: QuestionDecisionOutcome,
  parent?: HTMLElement,
) {
  const region = document.createElement('section')
  region.dataset.role = 'run-questions'
  region.hidden = true
  if (parent === undefined) {
    document.body.append(region)
  } else {
    parent.append(region)
    document.body.append(parent)
  }
  const client = makeClient(decisionOutcome)
  const body = `event: ready\ndata: {"contractVersion":"${PINNED_CONTRACT_VERSION}"}\n\n${frames.join('')}`
  let read = 0
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status: 200,
    headers: {get: () => 'text/event-stream'},
    body: {getReader: () => ({read: async () => read++ === 0
      ? {done: false, value: new TextEncoder().encode(body)}
      : new Promise(() => {})})},
  }))
  const handle = initOperatorStream({
    runId: 'run-questions-ui',
    statusEl: document.createElement('span'),
    noticeEl: document.createElement('p'),
    questionsEl: region as never,
    questionClient: client,
  })
  await vi.waitFor(() => expect(region.hidden).toBe(false))
  return {region, client, handle}
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  resetQuestionPageStore()
})

describe('operator question region accessibility', () => {
  it('does not collapse an expandable run card when an option is selected', async () => {
    const runCard = document.createElement('div')
    let toggleCount = 0
    runCard.addEventListener('click', () => {
      toggleCount++
    })
    const {region, handle} = await mountQuestionRegion([
      openFrame('req-expandable', [question()]),
    ], undefined, runCard)

    const radio = region.querySelector('input[type="radio"]') as HTMLInputElement
    radio.click()

    expect(toggleCount).toBe(0)
    expect(region.hidden).toBe(false)
    handle.close()
  })

  it('announces arrivals politely and exposes named groups with radio and checkbox semantics', async () => {
    const {region, handle} = await mountQuestionRegion([
      openFrame('req-one', [question(), question({header: 'Select any tools', multiple: true, custom: false})]),
    ])

    expect(region.querySelector('[aria-live="polite"]')).not.toBeNull()
    expect(region.querySelector('.question-region__announcer')?.textContent).toBe('A new question is available.')
    expect(region.textContent).toContain('Choose a direction')
    expect(region.querySelector('fieldset legend')?.textContent).toBe('Choose a direction')
    expect(region.querySelectorAll('input[type="radio"]')).toHaveLength(2)
    expect(region.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    expect([...region.querySelectorAll('input')].every(input => !input.checked)).toBe(true)
    handle.close()
  })

  it('leaves focus alone for ordinary outcomes and moves focus to an invalid question', async () => {
    const {region, client, handle} = await mountQuestionRegion([
      openFrame('req-focus', [question(), question({header: 'Second choice'})]),
    ])
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()

    expect(document.activeElement).toBe(other)
    const radio = region.querySelector('input[type="radio"]') as HTMLInputElement
    radio.checked = true
    radio.dispatchEvent(new Event('change', {bubbles: true}))
    const fields = region.querySelectorAll('textarea')
    fields[1]!.value = 'ready'
    fields[1]!.dispatchEvent(new Event('input', {bubbles: true}))
    expect(getQuestionPageStore('run-questions-ui').drafts.get('req-focus')).toEqual([
      {options: [0], text: ''},
      {options: [], text: 'ready'},
    ])
    expect(handle.getQuestions()[0]?.status).toEqual({kind: 'open'})
    const answer = region.querySelector('.question-region__submit') as HTMLButtonElement
    expect(answer.disabled).toBe(false)
    answer.click()
    await vi.waitFor(() => expect(client.decideRunQuestion).toHaveBeenCalled())
    await vi.waitFor(() => expect(document.activeElement).toBe(region.querySelectorAll('fieldset')[1]))
    expect(region.textContent).toContain('Check this answer and try again.')
    expect((region.querySelectorAll('textarea')[1] as HTMLTextAreaElement).value).toBe('ready')
    handle.close()
  })

  it('keeps focus unchanged for a retryable outcome and restores drafts on a new render', async () => {
    const {region, handle} = await mountQuestionRegion(
      [openFrame('req-retry', [question()])],
      {kind: 'decided', state: 'failed_to_settle'},
    )
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()
    const field = region.querySelector('textarea') as HTMLTextAreaElement
    field.value = 'preserve me'
    field.dispatchEvent(new Event('input', {bubbles: true}))
    const submit = region.querySelector('.question-region__submit') as HTMLButtonElement
    submit.click()
    await vi.waitFor(() => expect(region.textContent).toContain("Your answer wasn't recorded. Try again."))
    expect(document.activeElement).toBe(other)
    handle.close()

    const reopened = await mountQuestionRegion([openFrame('req-retry', [question()])])
    expect((reopened.region.querySelector('textarea') as HTMLTextAreaElement).value).toBe('preserve me')
    reopened.handle.close()
  })

  it('renders HTML, Markdown links, and bidi sentinels as inert sanitized text', async () => {
    const {region, handle} = await mountQuestionRegion([
      openFrame('req-literal', [question({header: '<img src=x>', text: '[open](https://example.invalid)\u202e'})]),
    ])

    expect(region.querySelector('img')).toBeNull()
    expect(region.querySelector('a')).toBeNull()
    expect(region.querySelector('legend')?.textContent).toBe('<img src=x>')
    expect(region.textContent).toContain('[open](https://example.invalid)')
    expect(region.textContent).not.toContain('\u202e')
    handle.close()
  })
})
