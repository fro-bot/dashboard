import {afterEach, describe, expect, it, vi} from 'vitest'
import {FIRST_FRAME_TIMEOUT_MS, PINNED_CONTRACT_VERSION, initOperatorStream, resetQuestionPageStore} from '../../../public/operator-stream.js'

const RUN_ID = 'run-reattach'

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

const READY = frame('ready', {contractVersion: PINNED_CONTRACT_VERSION})
const RUNNING = frame('status', RUNNING_STATUS)
const APPROVAL = frame('approval', {
  runId: RUN_ID,
  requestID: 'req-reattach',
  permission: 'shell',
  command: 'echo hello',
  settled: false,
})
const LATE_APPROVAL = frame('approval', {
  runId: RUN_ID,
  requestID: 'req-late',
  permission: 'shell',
  command: 'echo late',
  settled: false,
})
const SUCCEEDED = frame('status', {...RUNNING_STATUS, status: 'succeeded', phase: 'COMPLETED', completedAt: '2026-06-20T10:05:00Z'})

/** A fetch stub whose response bodies the test feeds frame by frame. */
function stubStreamFetch() {
  const pushes: Array<(text: string) => void> = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
    const queue: string[] = []
    let wake: (() => void) | null = null
    pushes.push(text => {
      queue.push(text)
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
            return {done: false, value: new TextEncoder().encode(queue.shift() as string)}
          },
        }),
      },
    }
  }))
  return {
    pushToLatest: (text: string) => pushes.at(-1)?.(text),
    pushTo: (attachment: number, text: string) => pushes[attachment]?.(text),
  }
}

function makeCard() {
  const card = document.createElement('div')
  card.dataset.runId = RUN_ID
  const statusEl = document.createElement('span')
  const approvalsEl = document.createElement('div')
  approvalsEl.dataset.role = 'run-approvals'
  approvalsEl.hidden = true
  const badgeEl = document.createElement('span')
  badgeEl.dataset.role = 'approval-badge'
  badgeEl.hidden = true
  const cancelEl = document.createElement('div')
  cancelEl.dataset.role = 'run-cancel'
  cancelEl.hidden = true
  card.append(statusEl, approvalsEl, badgeEl, cancelEl)
  document.body.append(card)
  return {card, statusEl, approvalsEl, badgeEl, cancelEl}
}

function attach(parts: ReturnType<typeof makeCard>) {
  return initOperatorStream({
    runId: RUN_ID,
    statusEl: parts.statusEl,
    noticeEl: document.createElement('p'),
    approvalsEl: parts.approvalsEl,
    badgeEl: parts.badgeEl,
    cancelEl: parts.cancelEl,
    approvalClient: {
      decideRunApproval: vi.fn(),
      listRunApprovals: vi.fn(() => new Promise<never>(() => {})),
    },
    cancelClient: {
      cancelRun: vi.fn(),
      refreshCsrf: vi.fn(),
    },
  } as never)
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  resetQuestionPageStore()
})

describe('operator stream re-attach on one card', () => {
  it('keeps one Cancel control and one approval prompt across collapse and re-expand, and none after the run succeeds', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()

    // Expand, collapse, re-expand, collapse, re-expand: three attachments on the same card.
    for (let attachment = 0; attachment < 3; attachment++) {
      const handle = attach(parts)
      pushToLatest(READY + RUNNING + APPROVAL)
      await vi.waitFor(() => expect(parts.approvalsEl.querySelectorAll('.approval-prompt')).toHaveLength(1))
      await vi.waitFor(() => expect(parts.cancelEl.querySelectorAll('.run-cancel-btn-cancel')).toHaveLength(1))

      if (attachment < 2) handle.close()
      else {
        // The third attachment stays open and receives the terminal frame.
        expect(parts.cancelEl.querySelectorAll('.run-cancel-control')).toHaveLength(1)
        expect(parts.cancelEl.querySelectorAll('button')).toHaveLength(1)
        expect(parts.approvalsEl.querySelectorAll('.approval-prompt')).toHaveLength(1)

        pushToLatest(SUCCEEDED)
        await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Succeeded'))
        expect(parts.cancelEl.querySelectorAll('button')).toHaveLength(0)
        expect(parts.card.querySelectorAll('.run-cancel-btn-cancel')).toHaveLength(0)
        expect(parts.card.querySelectorAll('.run-cancel-control')).toHaveLength(1)
        handle.close()
      }
    }
  })

  it('removes the Cancel control of a closed attachment', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeCard()
    const handle = attach(parts)
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(parts.cancelEl.querySelectorAll('.run-cancel-btn-cancel')).toHaveLength(1))

    handle.close()

    expect(parts.card.querySelectorAll('.run-cancel-control')).toHaveLength(0)
    expect(parts.cancelEl.hidden).toBe(true)
  })

  it('ignores late frames on a closed attachment while a newer attachment owns the card', async () => {
    const {pushTo, pushToLatest} = stubStreamFetch()
    const parts = makeCard()

    // Attachment A goes live but has not seen a running status when it is closed.
    const closed = attach(parts)
    pushTo(0, READY)
    await new Promise(resolve => setTimeout(resolve, 20))
    closed.close()

    const live = attach(parts)
    pushToLatest(READY + RUNNING + APPROVAL)
    await vi.waitFor(() => expect(parts.cancelEl.querySelectorAll('.run-cancel-btn-cancel')).toHaveLength(1))
    await vi.waitFor(() => expect(parts.approvalsEl.querySelectorAll('.approval-prompt')).toHaveLength(1))

    // Late frames reach the closed attachment's stream: they must not paint onto the shared card.
    pushTo(0, READY + RUNNING + LATE_APPROVAL)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(parts.cancelEl.querySelectorAll('.run-cancel-control')).toHaveLength(1)
    expect(parts.approvalsEl.querySelectorAll('.approval-prompt')).toHaveLength(1)
    live.close()
  })

  it('clears stale approval markup already in the region when a new attachment starts', () => {
    stubStreamFetch()
    const parts = makeCard()
    const stale = document.createElement('div')
    stale.className = 'approval-prompt'
    stale.textContent = 'stale prompt'
    parts.approvalsEl.append(stale)
    parts.approvalsEl.hidden = false

    const handle = attach(parts)

    expect(parts.approvalsEl.querySelectorAll('.approval-prompt')).toHaveLength(0)
    expect(parts.approvalsEl.hidden).toBe(true)
    handle.close()
  })
})

// ---------------------------------------------------------------------------
// Stream-owned regions: attach clears and hides them, and updateDOM alone shows them
// ---------------------------------------------------------------------------

const OUTPUT = frame('output', {runId: RUN_ID, text: 'earlier output', final: false, seq: 0})
const NO_SNAPSHOT = frame('reset', {runId: RUN_ID, reason: 'no-snapshot'})
const FAILED = frame('status', {...RUNNING_STATUS, status: 'failed', phase: 'COMPLETED', completedAt: '2026-06-20T10:05:00Z'})

const REGION_ROLES = ['run-checkout-detail', 'run-waiting', 'run-output', 'run-output-coalesced', 'run-approvals', 'run-questions', 'approval-badge', 'run-cancel'] as const

function makeFullCard() {
  const card = document.createElement('div')
  card.dataset.runId = RUN_ID
  const statusEl = document.createElement('span')
  const noticeEl = document.createElement('p')
  const regions = Object.fromEntries(REGION_ROLES.map(role => {
    const el = document.createElement(role === 'approval-badge' ? 'span' : 'div')
    el.dataset.role = role
    el.hidden = true
    card.append(el)
    return [role, el]
  })) as Record<(typeof REGION_ROLES)[number], HTMLElement>
  card.append(statusEl)
  document.body.append(card, noticeEl)
  return {card, statusEl, noticeEl, regions}
}

function attachFull(parts: ReturnType<typeof makeFullCard>, extra: Record<string, unknown> = {}) {
  const {regions} = parts
  return initOperatorStream({
    runId: RUN_ID,
    statusEl: parts.statusEl,
    noticeEl: parts.noticeEl,
    checkoutEl: regions['run-checkout-detail'],
    waitingEl: regions['run-waiting'],
    outputEl: regions['run-output'],
    coalescedEl: regions['run-output-coalesced'],
    approvalsEl: regions['run-approvals'],
    questionsEl: regions['run-questions'],
    badgeEl: regions['approval-badge'],
    cancelEl: regions['run-cancel'],
    approvalClient: {decideRunApproval: vi.fn(), listRunApprovals: vi.fn(() => new Promise<never>(() => {}))},
    cancelClient: {cancelRun: vi.fn(), refreshCsrf: vi.fn()},
    questionClient: {listRunQuestions: vi.fn(() => new Promise<never>(() => {})), decideRunQuestion: vi.fn()},
    ...extra,
  } as never)
}

const hiddenState = (parts: ReturnType<typeof makeFullCard>) => REGION_ROLES.map(role => parts.regions[role].hidden)
const ALL_REGIONS_HIDDEN = REGION_ROLES.map(() => true)

describe('operator stream owns the visibility of its regions', () => {
  it('paints "Connecting to run stream…" synchronously at attach, without a ReferenceError', () => {
    stubStreamFetch()
    const parts = makeFullCard()

    const handle = attachFull(parts)

    expect(parts.noticeEl.textContent).toBe('Connecting to run stream\u2026')
    expect(parts.noticeEl.hidden).toBe(false)
    expect(hiddenState(parts)).toEqual(ALL_REGIONS_HIDDEN)
    handle.close()
  })

  it('attach clears and hides output, the coalesced hint and the badge left over from an earlier attachment', () => {
    stubStreamFetch()
    const parts = makeFullCard()
    const {regions} = parts
    regions['run-output'].textContent = 'stale output'
    regions['run-output'].classList.add('run-output-unavailable')
    regions['run-output'].hidden = false
    regions['run-output-coalesced'].hidden = false
    regions['approval-badge'].textContent = '3'
    regions['approval-badge'].hidden = false

    const handle = attachFull(parts)

    expect(regions['run-output'].textContent).toBe('')
    expect(regions['run-output'].classList.contains('run-output-unavailable')).toBe(false)
    expect(regions['approval-badge'].textContent).toBe('')
    expect(hiddenState(parts)).toEqual(ALL_REGIONS_HIDDEN)
    handle.close()
  })

  it('a questions region holding only its announcer is cleared and hidden at attach', () => {
    stubStreamFetch()
    const parts = makeFullCard()
    const announcer = document.createElement('p')
    announcer.className = 'question-region__announcer'
    announcer.textContent = 'A new question is available.'
    parts.regions['run-questions'].append(announcer)
    parts.regions['run-questions'].hidden = false

    const handle = attachFull(parts)

    expect(parts.regions['run-questions'].hidden).toBe(true)
    expect(parts.regions['run-questions'].childNodes).toHaveLength(0)
    handle.close()
  })

  it('shows output only once output arrives, and hides it again for the next attachment before any frame', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const first = attachFull(parts)
    pushToLatest(READY + RUNNING + OUTPUT)
    await vi.waitFor(() => expect(parts.regions['run-output'].hidden).toBe(false))
    expect(parts.regions['run-output'].textContent).toBe('earlier output')
    first.close()

    const second = attachFull(parts)

    expect(parts.regions['run-output'].hidden).toBe(true)
    expect(parts.regions['run-output'].textContent).toBe('')
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Running'))
    expect(parts.regions['run-output'].hidden).toBe(true)
    expect(parts.regions['run-output'].textContent).toBe('')
    second.close()
  })

  it('re-expanding a finished run starts clean: nothing from the first attachment shows before or after the first frame', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const first = attachFull(parts)
    pushToLatest(READY + RUNNING + OUTPUT + FAILED)
    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Failed'))
    expect(parts.regions['run-output'].hidden).toBe(false)
    first.close()

    const second = attachFull(parts)
    expect(hiddenState(parts)).toEqual(ALL_REGIONS_HIDDEN)
    expect(parts.regions['run-output'].textContent).toBe('')

    pushToLatest(READY)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(parts.regions['run-output'].textContent).toBe('')
    expect(parts.regions['run-output'].hidden).toBe(true)
    expect(parts.regions['run-output-coalesced'].hidden).toBe(true)
    expect(parts.regions['approval-badge'].hidden).toBe(true)
    second.close()
  })

  it('A→B→A: the third attachment starts with every region hidden and empty', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const a1 = attachFull(parts)
    pushToLatest(READY + RUNNING + OUTPUT + APPROVAL)
    await vi.waitFor(() => expect(parts.regions['run-approvals'].hidden).toBe(false))
    a1.close()

    const other = makeFullCard()
    const b = initOperatorStream({runId: 'run-other', statusEl: other.statusEl, noticeEl: other.noticeEl, outputEl: other.regions['run-output']} as never)
    b.close()

    const a2 = attachFull(parts)

    expect(hiddenState(parts)).toEqual(ALL_REGIONS_HIDDEN)
    expect(parts.regions['run-output'].textContent).toBe('')
    expect(parts.regions['run-approvals'].childNodes).toHaveLength(0)
    expect(parts.regions['approval-badge'].textContent).toBe('')
    a2.close()
  })

  it('shows the approval region and badge when an approval arrives, and the Cancel region while the run is live', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)

    pushToLatest(READY + RUNNING + APPROVAL)

    await vi.waitFor(() => expect(parts.regions['run-approvals'].hidden).toBe(false))
    expect(parts.regions['approval-badge'].hidden).toBe(false)
    expect(parts.regions['approval-badge'].textContent).toBe('1')
    expect(parts.regions['run-cancel'].hidden).toBe(false)
    expect(parts.regions['run-cancel'].querySelectorAll('.run-cancel-btn-cancel')).toHaveLength(1)
    handle.close()
  })

  it('keeps showing "Output no longer available." after a no-snapshot reset on a terminal run, with no empty Cancel box', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts, {summaryStatus: 'succeeded'})

    pushToLatest(READY + NO_SNAPSHOT)

    await vi.waitFor(() => expect(parts.regions['run-output'].textContent).toBe('Output no longer available.'))
    expect(parts.regions['run-output'].hidden).toBe(false)
    expect(parts.statusEl.textContent).toBe('Succeeded')
    expect(parts.regions['run-cancel'].hidden).toBe(true)
    handle.close()
  })
})

describe('operator stream Cancel region at a terminal status', () => {
  it('a run whose first frame is terminal, with no Cancel control, leaves the region hidden', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)

    pushToLatest(READY + SUCCEEDED)

    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Succeeded'))
    expect(parts.regions['run-cancel'].hidden).toBe(true)
    expect(parts.regions['run-cancel'].childNodes).toHaveLength(0)
    handle.close()
  })

  it('a run seen live that then goes terminal and neutral hides the region: the emptied control does not count', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(parts.regions['run-cancel'].hidden).toBe(false))

    pushToLatest(SUCCEEDED)

    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Succeeded'))
    expect(parts.regions['run-cancel'].querySelectorAll('.run-cancel-control')).toHaveLength(1)
    expect(parts.regions['run-cancel'].querySelectorAll('.run-cancel-btn-cancel')).toHaveLength(0)
    expect(parts.regions['run-cancel'].hidden).toBe(true)
    handle.close()
  })

  it('a run cancelled from the card keeps showing its cancelled message after the terminal frame', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const cancelRun = vi.fn(async () => ({success: true, data: {state: 'cancelled'}}))
    const handle = attachFull(parts, {cancelClient: {cancelRun, refreshCsrf: vi.fn(async () => ({success: true, data: {csrfToken: 'tok'}}))}})
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(parts.regions['run-cancel'].querySelectorAll('.run-cancel-btn-cancel')).toHaveLength(1))

    ;(parts.regions['run-cancel'].querySelector('.run-cancel-btn-cancel') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(parts.regions['run-cancel'].querySelector('.run-cancel-btn-confirm')).not.toBeNull())
    ;(parts.regions['run-cancel'].querySelector('.run-cancel-btn-confirm') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(cancelRun).toHaveBeenCalled())
    pushToLatest(frame('status', {...RUNNING_STATUS, status: 'cancelled', phase: 'COMPLETED', completedAt: '2026-06-20T10:05:00Z'}))

    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Cancelled'))
    const message = parts.regions['run-cancel'].querySelector('.run-cancel-status')
    expect(message?.textContent).not.toBe('')
    expect(parts.regions['run-cancel'].hidden).toBe(false)
    handle.close()
  })
})

// ---------------------------------------------------------------------------
// Waiting line: shown only while the stream is live and nothing else on the card is showing
// ---------------------------------------------------------------------------

const WAITING_OUTPUT_COPY = 'Waiting for output\u2026'
const WAITING_START_COPY = 'Waiting to start\u2026'

const statusFrame = (status: string, phase = 'EXECUTING') =>
  frame('status', {...RUNNING_STATUS, status, phase, ...(['succeeded', 'failed', 'cancelled'].includes(status) ? {completedAt: '2026-06-20T10:05:00Z'} : {})})
const SETTLED_APPROVAL = frame('approval', {runId: RUN_ID, requestID: 'req-gone', permission: 'shell', command: 'echo done', settled: true})
const QUESTION_PAYLOAD = {
  runId: RUN_ID,
  requestID: 'req-q',
  questions: [{header: 'Pick one', text: 'Which way?', options: [{label: 'A', description: 'Go A'}, {label: 'B', description: 'Go B'}], multiple: false, custom: true}],
}
const OPEN_QUESTION = frame('question', {...QUESTION_PAYLOAD, settled: false})
const SETTLED_QUESTION = frame('question', {runId: RUN_ID, requestID: 'req-q', settled: true})

const waitingOf = (parts: ReturnType<typeof makeFullCard>) => parts.regions['run-waiting']

describe('operator stream waiting line', () => {
  it('is hidden and empty at attach, before any frame', () => {
    stubStreamFetch()
    const parts = makeFullCard()
    waitingOf(parts).textContent = 'stale copy'
    waitingOf(parts).hidden = false

    const handle = attachFull(parts)

    expect(waitingOf(parts).hidden).toBe(true)
    expect(waitingOf(parts).textContent).toBe('')
    handle.close()
  })

  it('shows "Waiting for output…" once the stream is live with no run entry yet', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)

    pushToLatest(READY)

    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))
    expect(waitingOf(parts).textContent).toBe(WAITING_OUTPUT_COPY)
    handle.close()
  })

  it('shows "Waiting for output…" for a placeholder entry with no status yet', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)

    pushToLatest(READY + SETTLED_APPROVAL)

    await vi.waitFor(() => expect(waitingOf(parts).textContent).toBe(WAITING_OUTPUT_COPY))
    expect(waitingOf(parts).hidden).toBe(false)
    handle.close()
  })

  it('shows "Waiting for output…" for a live running run with nothing showing', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)

    pushToLatest(READY + RUNNING)

    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Running'))
    expect(waitingOf(parts).hidden).toBe(false)
    expect(waitingOf(parts).textContent).toBe(WAITING_OUTPUT_COPY)
    handle.close()
  })

  it('shows "Waiting to start…" for a live queued run', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)

    pushToLatest(READY + statusFrame('queued'))

    await vi.waitFor(() => expect(waitingOf(parts).textContent).toBe(WAITING_START_COPY))
    expect(waitingOf(parts).hidden).toBe(false)
    handle.close()
  })

  it('switches from "Waiting to start…" to "Waiting for output…" when the run starts', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    pushToLatest(READY + statusFrame('queued'))
    await vi.waitFor(() => expect(waitingOf(parts).textContent).toBe(WAITING_START_COPY))

    pushToLatest(RUNNING)

    await vi.waitFor(() => expect(waitingOf(parts).textContent).toBe(WAITING_OUTPUT_COPY))
    handle.close()
  })

  it('a stale wire waiting_for_approval with no open prompt still shows the line', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)

    pushToLatest(READY + statusFrame('waiting_for_approval'))

    await vi.waitFor(() => expect(parts.statusEl.textContent).not.toBe(''))
    expect(waitingOf(parts).hidden).toBe(false)
    expect(waitingOf(parts).textContent).toBe(WAITING_OUTPUT_COPY)
    handle.close()
  })

  it('an open approval hides the line, and it comes back when the approval settles', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))

    pushToLatest(APPROVAL)
    await vi.waitFor(() => expect(parts.regions['run-approvals'].hidden).toBe(false))
    expect(waitingOf(parts).hidden).toBe(true)

    pushToLatest(frame('approval', {runId: RUN_ID, requestID: 'req-reattach', permission: 'shell', command: 'echo hello', settled: true}))
    await vi.waitFor(() => expect(parts.regions['run-approvals'].hidden).toBe(true))
    expect(waitingOf(parts).hidden).toBe(false)
    expect(waitingOf(parts).textContent).toBe(WAITING_OUTPUT_COPY)
    handle.close()
  })

  it('an open question hides the line, and it comes back when the question settles with nothing else showing', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))

    pushToLatest(OPEN_QUESTION)
    await vi.waitFor(() => expect(parts.regions['run-questions'].hidden).toBe(false))
    expect(waitingOf(parts).hidden).toBe(true)

    pushToLatest(SETTLED_QUESTION)
    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))
    handle.close()
  })

  it('an answered-question note alone does not hide the line', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts, {
      questionClient: {listRunQuestions: vi.fn(() => new Promise<never>(() => {})), decideRunQuestion: vi.fn(async () => ({kind: 'decided', state: 'claimed'}))},
    })
    pushToLatest(READY + RUNNING + OPEN_QUESTION)
    await vi.waitFor(() => expect(parts.regions['run-questions'].hidden).toBe(false))
    expect(waitingOf(parts).hidden).toBe(true)

    const textarea = parts.regions['run-questions'].querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'Keep going'
    textarea.dispatchEvent(new Event('input', {bubbles: true}))
    ;(parts.regions['run-questions'].querySelector('.question-region__submit') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(parts.regions['run-questions'].textContent).toContain('This question is no longer open.'))

    // The note is showing, but a note is not content: the line is back.
    expect(handle.getQuestions()).toHaveLength(0)
    expect(handle.getQuestionNotes()).toHaveLength(1)
    expect(waitingOf(parts).hidden).toBe(false)
    expect(waitingOf(parts).textContent).toBe(WAITING_OUTPUT_COPY)
    handle.close()
  })

  it('output hides the line', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))

    pushToLatest(OUTPUT)
    await vi.waitFor(() => expect(parts.regions['run-output'].hidden).toBe(false))
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })

  it('checkout detail showing hides the line', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))

    pushToLatest(frame('status', {
      ...RUNNING_STATUS,
      checkoutProvenance: {
        kind: 'observed',
        observation: {
          head: {kind: 'attached', branch: 'fixture-main', sha: 'a'.repeat(40)},
          worktree: {kind: 'clean'},
          operationInProgress: 'none',
          observedAt: '2026-06-20T10:00:00Z',
        },
        remote: {kind: 'not-checked'},
      },
    }))

    await vi.waitFor(() => expect(parts.regions['run-checkout-detail'].hidden).toBe(false))
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })

  it('a Cancel control alone does not hide the line', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)

    pushToLatest(READY + RUNNING)

    await vi.waitFor(() => expect(parts.regions['run-cancel'].hidden).toBe(false))
    expect(waitingOf(parts).hidden).toBe(false)
    handle.close()
  })

  it.each(['succeeded', 'failed', 'cancelled', 'blocked'])('a %s run hides the line', async status => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))

    pushToLatest(statusFrame(status, status === 'blocked' ? 'EXECUTING' : 'COMPLETED'))

    await vi.waitFor(() => expect(parts.statusEl.textContent).not.toBe('Running'))
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })

  it('an expired terminal run shows "Output no longer available." and no waiting line', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts, {summaryStatus: 'succeeded'})

    pushToLatest(READY + NO_SNAPSHOT)

    await vi.waitFor(() => expect(parts.regions['run-output'].textContent).toBe('Output no longer available.'))
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })

  it('hides on close(), next to the Cancel region', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))

    handle.close()

    expect(waitingOf(parts).hidden).toBe(true)
    expect(parts.regions['run-cancel'].hidden).toBe(true)
  })

  it('writes the copy through textContent only, as a single text node', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)

    pushToLatest(READY + RUNNING)

    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))
    expect(waitingOf(parts).childNodes).toHaveLength(1)
    expect(waitingOf(parts).firstChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(waitingOf(parts).hasAttribute('aria-live')).toBe(false)
    handle.close()
  })

  it('a card without a waiting region is unaffected', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts, {waitingEl: null})

    pushToLatest(READY + RUNNING)

    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Running'))
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })
})

describe('operator stream waiting line by connection state', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays hidden while connecting, and for a drifted contract version', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    expect(waitingOf(parts).hidden).toBe(true)

    pushToLatest(frame('ready', {contractVersion: `${PINNED_CONTRACT_VERSION}-other`}) + RUNNING)

    await vi.waitFor(() => expect(parts.noticeEl.textContent).toContain('Stream version mismatch'))
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })

  it.each([
    ['not-found', 404, 'Run stream unavailable.'],
    ['backpressure', 429, 'Stream temporarily unavailable'],
    ['reconnecting', 500, 'Connecting to run stream'],
  ])('stays hidden when the connection is %s', async (_state, code, noticeText) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({status: code, headers: {get: () => null}, body: null})))
    const parts = makeFullCard()
    const handle = attachFull(parts)

    await vi.waitFor(() => expect(parts.noticeEl.textContent).toContain(noticeText))
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })

  it('hides the line again when the stream closes after a terminal reset', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))

    pushToLatest(frame('reset', {runId: RUN_ID, reason: 'terminal'}))

    await vi.waitFor(() => expect(parts.noticeEl.textContent).toContain('Run stream ended before a result was available.'))
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })

  it('hides the line when the connection drops and the stream is reconnecting', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts)
    pushToLatest(READY + RUNNING)
    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))

    pushToLatest(frame('reset', {runId: RUN_ID, reason: 'shutdown'}))

    await vi.waitFor(() => expect(parts.noticeEl.textContent).toContain('Connecting to run stream'))
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })

  it('stays hidden in the "not yet observable" state', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    const parts = makeFullCard()
    const handle = attachFull(parts)

    await vi.advanceTimersByTimeAsync(FIRST_FRAME_TIMEOUT_MS + 1)

    expect(parts.noticeEl.textContent).toContain('not yet observable')
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })
})

describe('operator stream waiting line beside an open question', () => {
  it('stays hidden while an open question shows, even mid-check, and returns when the question settles', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts, {
      questionClient: {
        listRunQuestions: vi.fn(() => new Promise<never>(() => {})),
        decideRunQuestion: vi.fn(async () => ({kind: 'decided', state: 'already_claimed'})),
      },
    })
    pushToLatest(READY + RUNNING + OPEN_QUESTION)
    await vi.waitFor(() => expect(parts.regions['run-questions'].hidden).toBe(false))
    await handle.decideQuestion('req-q', {decision: 'skip'})
    void handle.checkQuestions('req-q')
    expect(handle.getQuestionStatus('req-q')).toEqual({kind: 'checking'})
    expect(parts.regions['run-questions'].textContent).toContain('Pick one')
    expect(waitingOf(parts).hidden).toBe(true)

    pushToLatest(SETTLED_QUESTION)
    await vi.waitFor(() => expect(handle.getQuestions()).toHaveLength(0))

    expect(parts.regions['run-questions'].hidden).toBe(true)
    expect(waitingOf(parts).hidden).toBe(false)
    expect(waitingOf(parts).textContent).toBe(WAITING_OUTPUT_COPY)
    handle.close()
  })
})

describe('operator stream waiting line with a run-list summary status', () => {
  it.each(['succeeded', 'failed', 'cancelled'])('a %s summary shows no waiting line at attach or after ready', async summaryStatus => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts, {summaryStatus})
    expect(waitingOf(parts).hidden).toBe(true)

    pushToLatest(READY)
    await vi.waitFor(() => expect(parts.noticeEl.hidden).toBe(true))

    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })

  it.each(['queued', 'running', 'waiting_for_approval', 'waiting_for_question'])('a non-terminal %s summary still shows the line once the stream is live', async summaryStatus => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts, {summaryStatus})

    pushToLatest(READY)

    await vi.waitFor(() => expect(waitingOf(parts).hidden).toBe(false))
    expect(waitingOf(parts).textContent).toBe(WAITING_OUTPUT_COPY)
    handle.close()
  })

  it('a stream status frame that is not terminal wins over a terminal summary', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts, {summaryStatus: 'succeeded'})

    pushToLatest(READY + RUNNING)

    await vi.waitFor(() => expect(parts.statusEl.textContent).toBe('Running'))
    expect(waitingOf(parts).hidden).toBe(false)
    expect(waitingOf(parts).textContent).toBe(WAITING_OUTPUT_COPY)
    handle.close()
  })

  it('a terminal summary with a placeholder entry and no status yet keeps the line hidden', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts, {summaryStatus: 'failed'})

    pushToLatest(READY + SETTLED_APPROVAL)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })

  it('the no-snapshot path still shows "Output no longer available." with a terminal summary', async () => {
    const {pushToLatest} = stubStreamFetch()
    const parts = makeFullCard()
    const handle = attachFull(parts, {summaryStatus: 'failed'})

    pushToLatest(READY + NO_SNAPSHOT)

    await vi.waitFor(() => expect(parts.regions['run-output'].textContent).toBe('Output no longer available.'))
    expect(parts.regions['run-output'].hidden).toBe(false)
    expect(waitingOf(parts).hidden).toBe(true)
    handle.close()
  })
})
