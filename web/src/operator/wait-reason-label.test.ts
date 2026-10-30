/**
 * The wait-reason label on a streamed card. The real stream module paints the header line
 * (`[data-role="run-reason"]`) over jsdom; the run list's own repaint is exercised through the real
 * run-index module. The label is a function of the current state only, so every path that should
 * not show it is pinned here, and so is every path that could leave it stale.
 */

import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  clearFinishedRuns,
  initOperatorStream,
  PINNED_CONTRACT_VERSION,
  resetQuestionPageStore,
  takeUsableFinishedRun,
} from '../../../public/operator-stream.js'
import {discoverCardStreamTargets} from './runtime.ts'

type RunIndexModule = typeof import('../../../public/operator-run-index.js')

const RUN_ID = 'run-wait-label'

const WAIT_COPY = {
  'agent-working': 'Agent still working',
  'awaiting-reply': 'Finishing its reply',
  'awaiting-background-task': 'Waiting on a background task',
  'confirming-completion': 'Confirming it has finished',
} as const

const RUNNING_STATUS = {
  runId: RUN_ID,
  entityRef: 'fro-bot/agent',
  surface: 'github',
  phase: 'EXECUTING',
  status: 'running',
  startedAt: '2026-06-20T10:00:00Z',
  stale: false,
}

function frame(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

const statusFrame = (overrides: Record<string, unknown> = {}) => {
  const status = (overrides.status as string | undefined) ?? 'running'
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status)
  return frame('status', {
    ...RUNNING_STATUS,
    ...(terminal ? {phase: 'COMPLETED', completedAt: '2026-06-20T10:05:00Z'} : {}),
    ...overrides,
  })
}
const running = (waitReason?: string) => statusFrame(waitReason === undefined ? {} : {waitReason})

const READY = frame('ready', {contractVersion: PINNED_CONTRACT_VERSION})
const OUTPUT = frame('output', {runId: RUN_ID, text: 'some output', final: false, seq: 0})
const FINAL_OUTPUT = frame('output', {runId: RUN_ID, text: 'the final answer', final: true, seq: 1})
const APPROVAL = (settled: boolean) =>
  frame('approval', {runId: RUN_ID, requestID: 'req-wait', permission: 'shell', command: 'echo hello', settled})
const QUESTION_PAYLOAD = {
  runId: RUN_ID,
  requestID: 'req-q',
  questions: [{header: 'Pick one', text: 'Which way?', options: [{label: 'A', description: 'Go A'}, {label: 'B', description: 'Go B'}], multiple: false, custom: true}],
}
const OPEN_QUESTION = frame('question', {...QUESTION_PAYLOAD, settled: false})
const SETTLED_QUESTION = frame('question', {runId: RUN_ID, requestID: 'req-q', settled: true})

/** A fetch stub whose response bodies the test feeds frame by frame. Run-list requests get a running run. */
const RUNNING_ROW = {runId: RUN_ID, repo: 'fro-bot/agent', status: 'running', createdAt: '2026-06-26T12:00:00.000Z'}

function stubStreamFetch(options: {statusFor?: (attachment: number) => number; row?: Record<string, unknown>} = {}) {
  const pushes: Array<(text: string) => void> = []
  const ends: Array<() => void> = []
  let streamRequests = 0
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: unknown) => {
    if (String(input).endsWith('/runs')) {
      return new Response(
        JSON.stringify({runs: [options.row ?? RUNNING_ROW]}),
        {status: 200, headers: {'content-type': 'application/json'}},
      )
    }
    streamRequests += 1
    const status = options.statusFor?.(streamRequests) ?? 200
    if (status !== 200) return {status, headers: {get: () => null}, body: null}
    const queue: Array<string | null> = []
    let wake: (() => void) | null = null
    pushes.push(text => {
      queue.push(text)
      wake?.()
    })
    ends.push(() => {
      queue.push(null)
      wake?.()
    })
    return {
      status: 200,
      headers: {get: () => 'text/event-stream'},
      body: {
        getReader: () => ({
          read: async () => {
            while (queue.length === 0) {
              await new Promise<void>(resolve => {
                wake = resolve
              })
            }
            const next = queue.shift()
            return next === null ? {done: true, value: undefined} : {done: false, value: new TextEncoder().encode(next)}
          },
        }),
      },
    }
  }))
  return {
    pushToLatest: (text: string) => pushes.at(-1)?.(text),
    endLatest: () => ends.at(-1)?.(),
    attachments: () => pushes.length,
    streamRequests: () => streamRequests,
  }
}

const ROLES = ['run-output', 'run-approvals', 'run-questions', 'approval-badge', 'run-cancel', 'run-waiting'] as const

function makeCard() {
  const card = document.createElement('div')
  card.dataset.runId = RUN_ID
  const statusEl = document.createElement('span')
  const reasonEl = document.createElement('span')
  reasonEl.dataset.role = 'run-reason'
  card.append(statusEl, reasonEl)
  const regions = Object.fromEntries(ROLES.map(role => {
    const el = document.createElement(role === 'approval-badge' ? 'span' : 'div')
    el.dataset.role = role
    el.hidden = true
    card.append(el)
    return [role, el]
  })) as Record<(typeof ROLES)[number], HTMLElement>
  const noticeEl = document.createElement('p')
  document.body.append(card, noticeEl)
  return {card, statusEl, reasonEl, noticeEl, regions}
}

type Parts = ReturnType<typeof makeCard>

function attach(parts: Parts, extra: Record<string, unknown> = {}) {
  const {regions} = parts
  return initOperatorStream({
    runId: RUN_ID,
    statusEl: parts.statusEl,
    reasonEl: parts.reasonEl,
    noticeEl: parts.noticeEl,
    outputEl: regions['run-output'],
    waitingEl: regions['run-waiting'],
    approvalsEl: regions['run-approvals'],
    questionsEl: regions['run-questions'],
    badgeEl: regions['approval-badge'],
    cancelEl: regions['run-cancel'],
    approvalClient: {decideRunApproval: vi.fn(), listRunApprovals: vi.fn(() => new Promise<never>(() => {}))},
    cancelClient: {
      cancelRun: vi.fn(() => new Promise<never>(() => {})),
      refreshCsrf: vi.fn(async () => ({success: true, data: {csrfToken: 'tok'}})),
    },
    questionClient: {listRunQuestions: vi.fn(() => new Promise<never>(() => {})), decideRunQuestion: vi.fn()},
    ...extra,
  } as never)
}

const labelOf = (parts: Parts) => parts.reasonEl.textContent
const stateOf = (parts: Parts) => parts.reasonEl.dataset.reasonState
const ownerOf = (parts: Parts) => parts.reasonEl.dataset.reasonOwner
const expectNoLabel = (parts: Parts) => {
  expect(labelOf(parts)).toBe('')
  expect(stateOf(parts)).toBeUndefined()
  expect(ownerOf(parts)).toBeUndefined()
}

const handles: Array<{close: () => void}> = []
function open(parts: Parts, extra: Record<string, unknown> = {}) {
  const handle = attach(parts, extra)
  handles.push(handle)
  return handle
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  resetQuestionPageStore()
  clearFinishedRuns()
})

describe('wait-reason label on the streamed card', () => {
  it('shows the copy for a live running frame, as a quiet wait line owned by the stream', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)

    pushToLatest(READY + running('awaiting-background-task'))

    await vi.waitFor(() => expect(labelOf(parts)).toBe('Waiting on a background task'))
    expect(stateOf(parts)).toBe('wait')
    expect(ownerOf(parts)).toBe('stream')
  })

  it.each(Object.entries(WAIT_COPY))('shows the copy for %s', async (waitReason, copy) => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)

    pushToLatest(READY + running(waitReason))

    await vi.waitFor(() => expect(labelOf(parts)).toBe(copy))
  })

  it('replaces the text when a later frame carries another value, and clears it when a frame carries none', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('agent-working'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['agent-working']))

    pushToLatest(running('confirming-completion'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['confirming-completion']))
    expect(stateOf(parts)).toBe('wait')

    pushToLatest(running())
    await vi.waitFor(() => expect(labelOf(parts)).toBe(''))
    expect(stateOf(parts)).toBeUndefined()
    expect(ownerOf(parts)).toBeUndefined()
  })

  it('shows nothing for a running frame with an unknown reason', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)

    pushToLatest(READY + running('future-reason'))

    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Running'))
    expectNoLabel(parts)
  })

  it('does not write the line again when a frame leaves the text unchanged', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))
    const records: MutationRecord[] = []
    const observer = new MutationObserver(batch => records.push(...batch))
    observer.observe(parts.reasonEl, {childList: true, characterData: true, subtree: true, attributes: true})

    pushToLatest(running('awaiting-reply') + OUTPUT)
    await vi.waitFor(() => expect(parts.regions['run-output'].textContent).toBe('some output'))

    records.push(...observer.takeRecords())
    observer.disconnect()
    expect(records).toHaveLength(0)
  })

  it('stays silent: the line is no live region and sits in no status region', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)

    pushToLatest(READY + running('awaiting-reply'))

    await vi.waitFor(() => expect(labelOf(parts)).not.toBe(''))
    expect(parts.reasonEl.hasAttribute('aria-live')).toBe(false)
    expect(parts.reasonEl.hasAttribute('role')).toBe(false)
    expect(parts.reasonEl.closest('[role="status"], [aria-live]')).toBeNull()
    expect(parts.reasonEl.childNodes).toHaveLength(1)
    expect(parts.reasonEl.firstChild?.nodeType).toBe(Node.TEXT_NODE)
  })

  it('writes dashboard copy only: no copy repeats its wire value, and no wire value reaches the DOM', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY)

    for (const [wire, copy] of Object.entries(WAIT_COPY)) {
      expect(copy).not.toBe(wire)
      pushToLatest(running(wire))
      await vi.waitFor(() => expect(labelOf(parts)).toBe(copy))
      expect(parts.card.outerHTML).not.toContain(wire)
      for (const attribute of parts.reasonEl.getAttributeNames()) {
        expect(parts.reasonEl.getAttribute(attribute), attribute).not.toContain(wire)
      }
      expect(parts.reasonEl.className).not.toContain(wire)
    }
  })
})

describe('wait-reason label precedence', () => {
  it('an open approval hides the label, and closing it shows the stored reason again', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))

    pushToLatest(APPROVAL(false))
    await vi.waitFor(() => expect(parts.regions['run-approvals'].hidden).toBe(false))
    expectNoLabel(parts)

    pushToLatest(APPROVAL(true))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))
    expect(stateOf(parts)).toBe('wait')
    expect(ownerOf(parts)).toBe('stream')
  })

  it('an open question hides the label, and closing it shows the stored reason again', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('agent-working'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['agent-working']))

    pushToLatest(OPEN_QUESTION)
    await vi.waitFor(() => expect(parts.regions['run-questions'].hidden).toBe(false))
    expectNoLabel(parts)

    pushToLatest(SETTLED_QUESTION)
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['agent-working']))
  })

  it('a waiting_for_approval frame clears the label, and the next running frame with a reason shows it', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))

    pushToLatest(statusFrame({status: 'waiting_for_approval'}))
    await vi.waitFor(() => expect(parts.statusEl.textContent).not.toBe('Running'))
    expectNoLabel(parts)

    pushToLatest(running('confirming-completion'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['confirming-completion']))
  })

  it('a cancel in flight hides the label', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    const cancelRun = vi.fn(() => new Promise<never>(() => {}))
    open(parts, {cancelClient: {cancelRun, refreshCsrf: vi.fn(async () => ({success: true, data: {csrfToken: 'tok'}}))}})
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))

    ;(parts.regions['run-cancel'].querySelector('.run-cancel-btn-cancel') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(parts.regions['run-cancel'].querySelector('.run-cancel-btn-confirm')).not.toBeNull())
    ;(parts.regions['run-cancel'].querySelector('.run-cancel-btn-confirm') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(cancelRun).toHaveBeenCalled())

    expectNoLabel(parts)

    // The gateway keeps sending the reason while the cancel is pending: the label stays hidden.
    pushToLatest(running('confirming-completion'))
    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Running'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expectNoLabel(parts)
  })

  it('a preparation headline wins over a reason', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)

    pushToLatest(READY + statusFrame({waitReason: 'awaiting-reply', checkoutPreparation: {outcome: 'refused', reason: 'detached'}}))

    await vi.waitFor(() => expect(labelOf(parts)).not.toBe(''))
    expect(parts.reasonEl.textContent).toBe('Checkout refused: detached HEAD')
    expect(labelOf(parts)).not.toBe(WAIT_COPY['awaiting-reply'])
    expect(stateOf(parts)).toBe('present')
    expect(ownerOf(parts)).toBe('stream')
  })

  it('a failed frame after a reason leaves only the failure reason', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('confirming-completion'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['confirming-completion']))

    pushToLatest(statusFrame({status: 'failed', failureKind: 'inactivity-timeout'}))

    await vi.waitFor(() => expect(labelOf(parts)).toBe('No recent activity'))
    expect(stateOf(parts)).toBe('present')
  })

  it.each(['succeeded', 'cancelled'])('a %s frame after a reason clears the line', async terminalStatus => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))

    pushToLatest(statusFrame({status: terminalStatus}))

    await vi.waitFor(() => expect(labelOf(parts)).toBe(''))
    expect(stateOf(parts)).toBeUndefined()
    expect(ownerOf(parts)).toBeUndefined()
  })

  it('a reset with no snapshot on a live run keeps the label showing', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))

    pushToLatest(frame('reset', {runId: RUN_ID, reason: 'no-snapshot'}) + OUTPUT)

    await vi.waitFor(() => expect(parts.regions['run-output'].textContent).toBe('some output'))
    expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply'])
    expect(stateOf(parts)).toBe('wait')
    expect(ownerOf(parts)).toBe('stream')
  })

  it('a reset with no snapshot on a run whose summary is terminal clears the line', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts, {summaryStatus: 'succeeded'})
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))

    pushToLatest(frame('reset', {runId: RUN_ID, reason: 'no-snapshot'}))

    await vi.waitFor(() => expect(labelOf(parts)).toBe(''))
    expect(stateOf(parts)).toBeUndefined()
    expect(ownerOf(parts)).toBeUndefined()
  })
})

describe('wait-reason label by connection state', () => {
  it('a reconnecting connection clears a painted label, and a replayed running frame shows it again', async () => {
    const {pushToLatest, endLatest, attachments} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('awaiting-background-task'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-background-task']))

    pushToLatest(frame('reset', {runId: RUN_ID, reason: 'shutdown'}))
    endLatest()
    await vi.waitFor(() => expect(parts.noticeEl.textContent).toContain('Connecting to run stream'))
    expectNoLabel(parts)

    await vi.waitFor(() => expect(attachments()).toBe(2), {timeout: 3000})
    pushToLatest(READY + running('awaiting-background-task'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-background-task']), {timeout: 3000})
    expect(stateOf(parts)).toBe('wait')
    expect(ownerOf(parts)).toBe('stream')
  })

  it('a backpressure connection clears a painted label and leaves the stream owning nothing', async () => {
    const {pushToLatest, endLatest, streamRequests} = stubStreamFetch({statusFor: attachment => (attachment === 1 ? 200 : 429)})
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))

    pushToLatest(frame('reset', {runId: RUN_ID, reason: 'shutdown'}))
    endLatest()
    await vi.waitFor(() => expect(streamRequests()).toBe(2), {timeout: 3000})

    await vi.waitFor(() => expect(parts.noticeEl.textContent).toContain('Stream temporarily unavailable'))
    expectNoLabel(parts)
  })

  it('a contract drift clears a painted label', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))

    pushToLatest(frame('ready', {contractVersion: `${PINNED_CONTRACT_VERSION}-other`}))

    await vi.waitFor(() => expect(parts.noticeEl.textContent).toContain('Stream version mismatch'))
    expectNoLabel(parts)
  })

  it('a stream that closes before a result clears a painted label', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))

    pushToLatest(frame('reset', {runId: RUN_ID, reason: 'terminal'}))

    await vi.waitFor(() => expect(parts.noticeEl.textContent).toContain('Run stream ended before a result was available.'))
    expectNoLabel(parts)
  })
})

describe('wait-reason label lifecycle', () => {
  it('close() clears the label, and re-expanding shows none until a frame arrives', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    const first = attach(parts)
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))

    first.close()

    expectNoLabel(parts)

    open(parts)
    expectNoLabel(parts)
    pushToLatest(READY)
    await vi.waitFor(() => expect(parts.regions['run-waiting'].hidden).toBe(false))
    expectNoLabel(parts)

    pushToLatest(running('agent-working'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['agent-working']))
  })

  it('a late frame on a closed attachment does not repaint the label', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    const handle = attach(parts)
    pushToLatest(READY + running('awaiting-reply'))
    await vi.waitFor(() => expect(labelOf(parts)).toBe(WAIT_COPY['awaiting-reply']))
    handle.close()

    pushToLatest(running('agent-working'))
    await new Promise(resolve => setTimeout(resolve, 30))

    expectNoLabel(parts)
  })

  it('a new attachment clears a stream-owned label left by an earlier one, and leaves list-owned text alone', () => {
    stubStreamFetch()
    const parts = makeCard()
    parts.reasonEl.textContent = 'Waiting on a background task'
    parts.reasonEl.dataset.reasonState = 'wait'
    parts.reasonEl.dataset.reasonOwner = 'stream'

    open(parts)

    expectNoLabel(parts)
    handles.pop()?.close()

    parts.reasonEl.textContent = 'No recent activity'
    parts.reasonEl.dataset.reasonState = 'present'
    open(parts)

    expect(labelOf(parts)).toBe('No recent activity')
    expect(stateOf(parts)).toBe('present')
    expect(ownerOf(parts)).toBeUndefined()
  })

  it('a new attachment drops a stream-owner marker from text that is not a wait label, and keeps the text', () => {
    stubStreamFetch()
    const parts = makeCard()
    parts.reasonEl.textContent = 'No recent activity'
    parts.reasonEl.dataset.reasonState = 'present'
    parts.reasonEl.dataset.reasonOwner = 'stream'

    open(parts)

    expect(labelOf(parts)).toBe('No recent activity')
    expect(stateOf(parts)).toBe('present')
    expect(ownerOf(parts)).toBeUndefined()
  })

  it('an attachment before its first frame, as on a freshly launched card, shows no label', () => {
    stubStreamFetch()
    const parts = makeCard()

    open(parts)

    expectNoLabel(parts)
  })

  it('a live stream with no run entry yet shows no label', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts)

    pushToLatest(READY)

    await vi.waitFor(() => expect(parts.regions['run-waiting'].hidden).toBe(false))
    expectNoLabel(parts)
  })

  it('a recorded re-expand of a finished run shows no label', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    const live = attach(parts)
    pushToLatest(READY + running('awaiting-reply') + FINAL_OUTPUT + statusFrame({status: 'succeeded'}))
    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Succeeded'))
    expectNoLabel(parts)
    live.close()
    const record = takeUsableFinishedRun(RUN_ID, 'succeeded')
    expect(record).toBeDefined()
    expect(Object.keys(record ?? {})).not.toContain('waitReason')

    open(parts, {finishedRecord: record})

    expect(parts.statusEl.textContent).toBe('Succeeded')
    expectNoLabel(parts)
  })

  it('a card without a reason line is unaffected', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    open(parts, {reasonEl: null})

    pushToLatest(READY + running('awaiting-reply'))

    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Running'))
    expectNoLabel(parts)
  })
})

describe('run list refresh against a stream-owned reason line', () => {
  let runIndexMod: RunIndexModule | undefined

  afterEach(() => {
    runIndexMod?.resetRunIndexState()
  })

  async function mountListCard(row?: Record<string, unknown>) {
    const net = stubStreamFetch({row})
    runIndexMod = await import('../../../public/operator-run-index.js')
    runIndexMod.resetRunIndexState()
    document.body.innerHTML = '<div data-role="run-index"><div data-role="run-index-list"></div></div>'
    await runIndexMod.initOperatorRunIndex({endpointBase: '/operator', onSelectRun: vi.fn()})
    const card = document.querySelector<HTMLElement>(`[data-run-id="${RUN_ID}"]`) as HTMLElement
    const targets = discoverCardStreamTargets(RUN_ID)
    expect(card.contains(targets.reasonEl)).toBe(true)
    const handle = initOperatorStream({
      runId: RUN_ID,
      statusEl: card.querySelector('[data-role="run-status"]'),
      noticeEl: document.createElement('p'),
      ...targets,
    } as never)
    handles.push(handle)
    return {...net, card, reasonEl: targets.reasonEl as HTMLElement, handle}
  }

  it('leaves the wait label in place, and repaints the list text once the stream has closed', async () => {
    const {pushToLatest, reasonEl, handle} = await mountListCard()
    pushToLatest(READY + running('awaiting-background-task'))
    await vi.waitFor(() => expect(reasonEl.textContent).toBe(WAIT_COPY['awaiting-background-task']))

    await (runIndexMod as RunIndexModule).refreshOperatorRunIndex()

    expect(reasonEl.textContent).toBe(WAIT_COPY['awaiting-background-task'])
    expect(reasonEl.dataset.reasonState).toBe('wait')
    expect(reasonEl.dataset.reasonOwner).toBe('stream')

    handle.close()
    await (runIndexMod as RunIndexModule).refreshOperatorRunIndex()

    expect(reasonEl.textContent).toBe('')
    expect(reasonEl.dataset.reasonState).toBeUndefined()
    expect(reasonEl.dataset.reasonOwner).toBeUndefined()
  })

  it('leaves a failure reason in place while the stream owns the line, and repaints the list text once the stream has closed', async () => {
    // The list row carries a different reason than the stream frame, so a list repaint is visible.
    const {pushToLatest, reasonEl, handle} = await mountListCard({...RUNNING_ROW, status: 'failed', failureKind: 'max-duration-timeout'})
    expect(reasonEl.textContent).toBe('Run timed out')
    pushToLatest(READY + statusFrame({status: 'failed', failureKind: 'inactivity-timeout'}))
    await vi.waitFor(() => expect(reasonEl.textContent).toBe('No recent activity'))
    expect(reasonEl.dataset.reasonState).toBe('present')
    expect(reasonEl.dataset.reasonOwner).toBe('stream')

    await (runIndexMod as RunIndexModule).refreshOperatorRunIndex()

    expect(reasonEl.textContent).toBe('No recent activity')
    expect(reasonEl.dataset.reasonOwner).toBe('stream')

    handle.close()
    await (runIndexMod as RunIndexModule).refreshOperatorRunIndex()

    expect(reasonEl.textContent).toBe('Run timed out')
    expect(reasonEl.dataset.reasonState).toBe('present')
    expect(reasonEl.dataset.reasonOwner).toBeUndefined()
  })

  it('leaves a checkout preparation headline in place', async () => {
    const {pushToLatest, reasonEl} = await mountListCard()
    pushToLatest(READY + statusFrame({checkoutPreparation: {outcome: 'refused', reason: 'detached'}}))
    await vi.waitFor(() => expect(reasonEl.textContent).not.toBe(''))
    const headline = reasonEl.textContent

    await (runIndexMod as RunIndexModule).refreshOperatorRunIndex()

    expect(reasonEl.textContent).toBe(headline)
    expect(reasonEl.dataset.reasonOwner).toBe('stream')
  })
})
