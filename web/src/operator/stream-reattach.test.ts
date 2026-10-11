import {afterEach, describe, expect, it, vi} from 'vitest'
import {PINNED_CONTRACT_VERSION, initOperatorStream, resetQuestionPageStore} from '../../../public/operator-stream.js'

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
