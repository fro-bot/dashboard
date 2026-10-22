/**
 * The wiki editor: entering edit mode, drafts, cancel, and the navigation guard.
 * Saving and its outcomes are in `WikiEditor.save.test.tsx`.
 */

import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
import * as wikiApi from '../api/wiki.ts'
import type {PromotionStatus, WikiPage} from '../api/wiki.ts'
import {createDraftStore, DRAFT_OPEN_TIMEOUT_MS, type DraftInput, type DraftStore} from '../wiki/drafts.ts'
import {DRAFT_DEBOUNCE_MS} from '../wiki/editor-timing.ts'
import {guardedWikiPageId} from '../wiki/navigation-guard.ts'
import {createMemoryIdb} from '../wiki/test-support/memory-idb.ts'
import {WikiEditor} from './WikiEditor.tsx'

const PAGE_ID = 'repos.acme--alpha'
const BODY = '\n# acme/alpha\n\nAlpha builds widgets.\n'
const CORRECTIONS = [
  {
    id: 'c1',
    status: 'active' as const,
    span: {text: 'Alpha builds widgets'},
    attribution: {actor: 'marcus', recordedAt: '2026-02-04T10:00:00Z'},
    reason: 'It builds gadgets now.',
    supersededBy: null,
    stale: false,
  },
]

function pageOf(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    id: PAGE_ID,
    type: 'repos',
    title: 'acme/alpha',
    updated: '2026-02-01',
    body: BODY,
    pageBlobSha: 'blob-1',
    nodeId: 'R_alpha',
    canMark: true,
    corrections: CORRECTIONS,
    correctionsBase: 'digest-1',
    headSha: 'commit-1',
    contract: {ok: true},
    canWrite: true,
    canWriteReason: null,
    ...overrides,
  }
}

const ok = <T,>(value: T) => ({ok: true as const, value})
const fail = (kind: string) => ({ok: false as const, error: {kind}}) as never
const settled: PromotionStatus = {state: 'settled', pr: null}

function draftInput(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    pageId: PAGE_ID,
    baseBlobSha: 'blob-1',
    baseText: BODY,
    correctionsBase: {entries: CORRECTIONS, digest: 'digest-1'},
    draftText: 'My restored draft.\n',
    pending: null,
    ...overrides,
  }
}

let store: DraftStore
let idb: ReturnType<typeof createMemoryIdb>
let getSpy: MockInstance<typeof wikiApi.getWikiPage>
let statusSpy: MockInstance<typeof wikiApi.promotionStatus>

beforeEach(() => {
  idb = createMemoryIdb()
  store = createDraftStore({indexedDB: idb.factory, now: () => 1_900_000_000_000})
  getSpy = vi.spyOn(wikiApi, 'getWikiPage').mockResolvedValue(ok(pageOf()))
  statusSpy = vi.spyOn(wikiApi, 'promotionStatus').mockResolvedValue(ok(settled))
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

async function renderPage(props: Partial<React.ComponentProps<typeof WikiEditor>> = {}) {
  const onBackToList = vi.fn()
  const view = render(<WikiEditor pageId={PAGE_ID} onBackToList={onBackToList} draftStore={store} {...props} />)
  await act(async () => {})
  return {onBackToList, ...view}
}

async function settle() {
  await act(async () => {})
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const textbox = () => screen.getByRole<HTMLTextAreaElement>('textbox', {name: 'Page text (raw Markdown)'})
const type = (value: string) => {
  fireEvent.change(textbox(), {target: {value}})
}

async function enterEdit() {
  fireEvent.click(screen.getByRole('button', {name: 'Edit'}))
  await settle()
}

describe('WikiEditor — entering edit mode', () => {
  it('opens read-only, with an explicit Edit button and no text box', async () => {
    await renderPage()
    expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-state', 'ready')
    expect(screen.getByTestId('wiki-page-body')).toHaveTextContent('Alpha builds widgets.')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', {name: 'Save'})).toBeNull()
    expect(screen.getByRole('button', {name: 'Edit'})).toBeEnabled()
  })

  it('Edit opens a labelled text area holding the body only, and Save starts disabled', async () => {
    await renderPage()
    await enterEdit()

    expect(textbox().value).toBe(BODY)
    expect(textbox()).not.toHaveAttribute('readonly')
    expect(screen.getByRole('button', {name: 'Save'})).toBeDisabled()
    expect(screen.getByTestId('wiki-editor')).toHaveAttribute('data-mode', 'editing')
  })

  it('says the frontmatter is managed by the system and is not shown', async () => {
    await renderPage()
    await enterEdit()
    expect(screen.getByTestId('wiki-frontmatter-note')).toHaveTextContent(/frontmatter/iu)
  })

  it('changing the text enables Save', async () => {
    await renderPage()
    await enterEdit()
    type(`${BODY}More.\n`)
    expect(screen.getByRole('button', {name: 'Save'})).toBeEnabled()
  })

  it('changing the text back to the original disables Save again', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    type(BODY)
    expect(screen.getByRole('button', {name: 'Save'})).toBeDisabled()
  })

  it('stays read-only with the reason when the session cannot write', async () => {
    getSpy.mockResolvedValue(ok(pageOf({canWrite: false, canWriteReason: 'not-operator'})))
    await renderPage()
    expect(screen.getByTestId('wiki-write-notice')).toHaveTextContent(/read-only/iu)
    expect(screen.queryByRole('button', {name: 'Edit'})).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does not restore a draft into a read-only session', async () => {
    await store.putDraft(draftInput())
    getSpy.mockResolvedValue(ok(pageOf({canWrite: false, canWriteReason: 'not-operator'})))
    await renderPage()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByTestId('wiki-page-body')).toHaveTextContent('Alpha builds widgets.')
  })

  it('shows the corrections beside the editor', async () => {
    await renderPage()
    await enterEdit()
    expect(screen.getByTestId('wiki-corrections')).toBeInTheDocument()
  })
})

describe('WikiEditor — the gate contract on open', () => {
  it('a mismatch says the dashboard needs a deploy, still allows editing, and disables Save', async () => {
    getSpy.mockResolvedValue(ok(pageOf({contract: {ok: false, kind: 'mismatch', retry: false}})))
    await renderPage()

    const notice = screen.getByTestId('wiki-contract-notice')
    expect(notice).toHaveAttribute('role', 'alert')
    expect(notice).toHaveTextContent(/dashboard needs a deploy/iu)

    await enterEdit()
    type('changed')
    expect(screen.getByRole('button', {name: 'Save'})).toBeDisabled()
  })

  it('unreadable shows a retryable notice, and Try again reads the page again', async () => {
    getSpy.mockResolvedValue(ok(pageOf({contract: {ok: false, kind: 'unreadable', retry: true}})))
    await renderPage()

    const notice = screen.getByTestId('wiki-contract-notice')
    expect(notice).toHaveAttribute('role', 'status')
    getSpy.mockResolvedValue(ok(pageOf()))
    fireEvent.click(within(notice).getByRole('button', {name: 'Try again'}))
    await settle()

    expect(getSpy).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('wiki-contract-notice')).toBeNull()
  })

  it('Try again on an unreadable contract asks first when there are unsaved changes, and does not reload on no', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    getSpy.mockResolvedValue(ok(pageOf({contract: {ok: false, kind: 'unreadable', retry: true}})))
    await renderPage()
    await enterEdit()
    type('changed')

    fireEvent.click(within(screen.getByTestId('wiki-contract-notice')).getByRole('button', {name: 'Try again'}))
    await settle()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]?.[0]).toMatch(/unsaved changes/iu)
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(textbox().value).toBe('changed')
  })

  it('Try again on an unreadable contract reloads once the operator confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    getSpy.mockResolvedValue(ok(pageOf({contract: {ok: false, kind: 'unreadable', retry: true}})))
    await renderPage()
    await enterEdit()
    type('changed')

    getSpy.mockResolvedValue(ok(pageOf()))
    fireEvent.click(within(screen.getByTestId('wiki-contract-notice')).getByRole('button', {name: 'Try again'}))
    await settle()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(getSpy).toHaveBeenCalledTimes(2)
  })

  it('Try again on an unreadable contract does not ask when nothing would be lost', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    getSpy.mockResolvedValue(ok(pageOf({contract: {ok: false, kind: 'unreadable', retry: true}})))
    await renderPage()

    getSpy.mockResolvedValue(ok(pageOf()))
    fireEvent.click(within(screen.getByTestId('wiki-contract-notice')).getByRole('button', {name: 'Try again'}))
    await settle()

    expect(confirm).not.toHaveBeenCalled()
    expect(getSpy).toHaveBeenCalledTimes(2)
  })

  it('unreadable keeps a restored draft', async () => {
    await store.putDraft(draftInput())
    getSpy.mockResolvedValue(ok(pageOf({contract: {ok: false, kind: 'unreadable', retry: true}})))
    await renderPage()
    expect(textbox().value).toBe('My restored draft.\n')
  })

  it('shows no contract notice when the contract is fine', async () => {
    await renderPage()
    expect(screen.queryByTestId('wiki-contract-notice')).toBeNull()
  })
})

describe('WikiEditor — the branch promotion status on open', () => {
  it('reads the status once, with no `since`', async () => {
    await renderPage()
    expect(statusSpy).toHaveBeenCalledTimes(1)
    expect(statusSpy).toHaveBeenCalledWith()
  })

  it('a blocked branch shows the blocked banner with the reason and run link before any save', async () => {
    statusSpy.mockResolvedValue(
      ok({state: 'blocked', reason: 'privacy-check', runUrl: 'https://github.com/o/r/actions/runs/5', pr: null}),
    )
    await renderPage()

    const banner = screen.getByTestId('wiki-promotion-blocked')
    expect(banner).toHaveTextContent('The privacy check failed.')
    expect(within(banner).getByRole('link', {name: 'View the blocked run'})).toHaveAttribute(
      'href',
      'https://github.com/o/r/actions/runs/5',
    )
  })

  it('a pending branch shows the pending banner', async () => {
    statusSpy.mockResolvedValue(ok({state: 'pending', pr: {number: 4, url: 'https://github.com/o/r/pull/4'}}))
    await renderPage()
    expect(within(screen.getByTestId('wiki-promotion-pending')).getByRole('link')).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/4',
    )
  })

  it('a settled branch shows no banner', async () => {
    await renderPage()
    expect(screen.queryByTestId('wiki-promotion-pending')).toBeNull()
    expect(screen.queryByTestId('wiki-promotion-blocked')).toBeNull()
  })

  it('an unreadable status is a note and does not stop the page', async () => {
    statusSpy.mockResolvedValue(fail('unavailable'))
    await renderPage()
    expect(screen.getByTestId('wiki-promotion-unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Edit'})).toBeEnabled()
  })
})

describe('WikiEditor — drafts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('does not write a draft until the text changes', async () => {
    const put = vi.spyOn(store, 'putDraft')
    await renderPage()
    await enterEdit()
    await advance(DRAFT_DEBOUNCE_MS * 3)
    expect(put).not.toHaveBeenCalled()
    expect(idb.records()).toHaveLength(0)
  })

  it('saves the draft after a short debounce, with the base it started from', async () => {
    await renderPage()
    await enterEdit()
    type('first')
    await advance(DRAFT_DEBOUNCE_MS - 1)
    expect(idb.records()).toHaveLength(0)

    await advance(1)
    const [record] = idb.records() as Record<string, unknown>[]
    expect(record).toMatchObject({
      pageId: PAGE_ID,
      baseBlobSha: 'blob-1',
      baseText: BODY,
      draftText: 'first',
      pending: null,
      correctionsBase: {digest: 'digest-1', entries: CORRECTIONS},
    })
  })

  it('writes once for a burst of typing, with the last text', async () => {
    const put = vi.spyOn(store, 'putDraft')
    await renderPage()
    await enterEdit()
    type('a')
    await advance(DRAFT_DEBOUNCE_MS / 2)
    type('ab')
    await advance(DRAFT_DEBOUNCE_MS / 2)
    type('abc')
    await advance(DRAFT_DEBOUNCE_MS)

    expect(put).toHaveBeenCalledTimes(1)
    expect((idb.records()[0] as {draftText: string}).draftText).toBe('abc')
  })

  it('removes the stored draft when the text goes back to the original', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    await advance(DRAFT_DEBOUNCE_MS)
    expect(idb.records()).toHaveLength(1)

    type(BODY)
    await advance(DRAFT_DEBOUNCE_MS)
    expect(idb.records()).toHaveLength(0)
  })

  it('writes a pending debounce when the editor goes away', async () => {
    const view = await renderPage()
    await enterEdit()
    type('typed just before leaving')
    view.unmount()
    await settle()
    expect((idb.records()[0] as {draftText: string}).draftText).toBe('typed just before leaving')
  })

  it('a failed local save shows "draft not saved locally" and does not block editing', async () => {
    await renderPage()
    await enterEdit()
    idb.failNext('put', 'QuotaExceededError')
    type('first')
    await advance(DRAFT_DEBOUNCE_MS)

    const note = screen.getByTestId('wiki-draft-local-failed')
    expect(note).toHaveAttribute('role', 'status')
    expect(note).toHaveTextContent(/draft not saved locally/iu)
    expect(textbox()).not.toHaveAttribute('readonly')
    expect(textbox()).toBeEnabled()
    expect(screen.getByRole('button', {name: 'Save'})).toBeEnabled()

    type('second')
    expect(textbox().value).toBe('second')
  })

  it('the note goes away when a later local save works', async () => {
    await renderPage()
    await enterEdit()
    idb.failNext('put', 'QuotaExceededError')
    type('first')
    await advance(DRAFT_DEBOUNCE_MS)
    expect(screen.getByTestId('wiki-draft-local-failed')).toBeInTheDocument()

    type('second')
    await advance(DRAFT_DEBOUNCE_MS)
    expect(screen.queryByTestId('wiki-draft-local-failed')).toBeNull()
    expect((idb.records()[0] as {draftText: string}).draftText).toBe('second')
  })

  it('editing still works with no local store at all, and says so', async () => {
    store = createDraftStore({indexedDB: undefined})
    await renderPage()
    await enterEdit()
    type('first')
    await advance(DRAFT_DEBOUNCE_MS)
    expect(screen.getByTestId('wiki-draft-local-failed')).toBeInTheDocument()
    expect(textbox().value).toBe('first')
  })
})

describe('WikiEditor — saving the draft when the page goes away', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  const setVisibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: state})
  }

  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState')
  })

  it('writes a pending debounce on pagehide, before the debounce has run out', async () => {
    await renderPage()
    await enterEdit()
    type('typed just before the reload')
    expect(idb.records()).toHaveLength(0)

    window.dispatchEvent(new Event('pagehide'))
    await settle()

    expect((idb.records()[0] as {draftText: string}).draftText).toBe('typed just before the reload')
  })

  it('writes a pending debounce when the page becomes hidden', async () => {
    await renderPage()
    await enterEdit()
    type('typed just before switching away')

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    expect((idb.records()[0] as {draftText: string}).draftText).toBe('typed just before switching away')
  })

  it('does nothing when the page becomes visible again', async () => {
    await renderPage()
    await enterEdit()
    type('still typing')

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    expect(idb.records()).toHaveLength(0)
  })

  it('writes nothing on pagehide when there is no pending debounce', async () => {
    const put = vi.spyOn(store, 'putDraft')
    await renderPage()
    await enterEdit()
    window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(put).not.toHaveBeenCalled()

    type('written by the debounce')
    await advance(DRAFT_DEBOUNCE_MS)
    expect(put).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('keeps the debounce: typing alone still waits', async () => {
    await renderPage()
    await enterEdit()
    type('first')
    await advance(DRAFT_DEBOUNCE_MS - 1)
    expect(idb.records()).toHaveLength(0)
    await advance(1)
    expect(idb.records()).toHaveLength(1)
  })

  it('removes both listeners when the editor goes away', async () => {
    const addWindow = vi.spyOn(window, 'addEventListener')
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const addDocument = vi.spyOn(document, 'addEventListener')
    const removeDocument = vi.spyOn(document, 'removeEventListener')
    const view = await renderPage()

    const pagehide = addWindow.mock.calls.find(call => call[0] === 'pagehide')?.[1]
    const visibility = addDocument.mock.calls.find(call => call[0] === 'visibilitychange')?.[1]
    expect(pagehide).toBeDefined()
    expect(visibility).toBeDefined()

    view.unmount()

    expect(removeWindow).toHaveBeenCalledWith('pagehide', pagehide)
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', visibility)
  })
})

describe('WikiEditor — a draft that could not be read from the device', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it.each(['UnknownError', 'QuotaExceededError'])(
    'a %s on the read does not let autosave overwrite the stored draft',
    async errorName => {
      await store.putDraft(draftInput())
      idb.failNext('get', errorName)
      await renderPage()

      expect(screen.getByTestId('wiki-draft-read-failed')).toHaveAttribute('role', 'status')
      await enterEdit()
      type('typed over it')
      await advance(DRAFT_DEBOUNCE_MS)

      expect((idb.records()[0] as {draftText: string}).draftText).toBe('My restored draft.\n')
      expect(screen.getByTestId('wiki-draft-local-failed')).toBeInTheDocument()
      expect(textbox().value).toBe('typed over it')
      expect(guardedWikiPageId()).toBe(PAGE_ID)
    },
  )

  it.each(['error', 'blocked', 'hang'] as const)(
    'a draft read whose open is %s does not let autosave overwrite the stored draft once IndexedDB recovers',
    async mode => {
      await store.putDraft(draftInput())
      const reopened = createDraftStore({indexedDB: idb.factory, now: () => 1_900_000_000_000})
      idb.openMode = mode
      await renderPage({draftStore: reopened})
      await advance(DRAFT_OPEN_TIMEOUT_MS)
      idb.openMode = 'ok'

      expect(screen.getByTestId('wiki-draft-read-failed')).toBeInTheDocument()
      await enterEdit()
      type('typed over it')
      await advance(DRAFT_DEBOUNCE_MS)

      expect((idb.records()[0] as {draftText: string}).draftText).toBe('My restored draft.\n')
      expect(screen.getByTestId('wiki-draft-local-failed')).toBeInTheDocument()
    },
  )

  it('Save still goes out after an open that failed, and the stored draft is left alone', async () => {
    const save = vi
      .spyOn(wikiApi, 'saveWikiPage')
      .mockResolvedValue({ok: false, error: {kind: 'failed', operationId: 'op', retryable: true}})
    await store.putDraft(draftInput())
    const reopened = createDraftStore({indexedDB: idb.factory, now: () => 1_900_000_000_000})
    idb.openMode = 'error'
    await renderPage({draftStore: reopened})
    idb.openMode = 'ok'
    await enterEdit()
    type('typed over it')
    fireEvent.click(screen.getByRole('button', {name: 'Save'}))
    fireEvent.click(screen.getByRole('button', {name: 'Confirm save'}))
    await settle()
    await settle()

    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Save not sent')).toBeNull()
    expect((idb.records()[0] as {draftText: string}).draftText).toBe('My restored draft.\n')
  })

  it('a browser with no IndexedDB at all is not a failed read: no such note', async () => {
    await renderPage({draftStore: createDraftStore({indexedDB: undefined})})
    expect(screen.queryByTestId('wiki-draft-read-failed')).toBeNull()
  })

  it('Discard says the stored draft could not be removed and is left on the device', async () => {
    await store.putDraft(draftInput())
    idb.failNext('get', 'UnknownError')
    await renderPage()
    await enterEdit()
    type('typed over it')
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    fireEvent.click(screen.getByRole('button', {name: 'Discard draft'}))
    await settle()

    expect(screen.queryByRole('textbox')).toBeNull()
    const note = screen.getByTestId('wiki-draft-discard-kept-stored')
    expect(note).toHaveAttribute('role', 'status')
    expect(note).toHaveTextContent(/could not be removed/iu)
    expect(idb.records()).toHaveLength(1)
  })

  it('does not delete the stored draft on Cancel or Discard either', async () => {
    await store.putDraft(draftInput())
    idb.failNext('get', 'UnknownError')
    await renderPage()
    await enterEdit()
    type('typed over it')
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    fireEvent.click(screen.getByRole('button', {name: 'Discard draft'}))
    await settle()

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(idb.records()).toHaveLength(1)
    expect((idb.records()[0] as {draftText: string}).draftText).toBe('My restored draft.\n')
  })

  it('does not overwrite the stored draft with the pending operation on Save', async () => {
    vi.spyOn(wikiApi, 'saveWikiPage').mockResolvedValue({ok: false, error: {kind: 'failed', operationId: 'op', retryable: true}})
    await store.putDraft(draftInput())
    idb.failNext('get', 'UnknownError')
    await renderPage()
    await enterEdit()
    type('typed over it')
    fireEvent.click(screen.getByRole('button', {name: 'Save'}))
    fireEvent.click(screen.getByRole('button', {name: 'Confirm save'}))
    await settle()
    await settle()

    expect((idb.records()[0] as {draftText: string; pending: unknown}).draftText).toBe('My restored draft.\n')
    expect((idb.records()[0] as {pending: unknown}).pending).toBeNull()
  })

  it('a read that works shows no such note', async () => {
    await renderPage()
    expect(screen.queryByTestId('wiki-draft-read-failed')).toBeNull()
  })
})

describe('WikiEditor — restoring a draft', () => {
  it('reopens in edit mode with the draft text and says which page version it started from', async () => {
    await store.putDraft(draftInput())
    await renderPage()

    expect(screen.getByTestId('wiki-editor')).toHaveAttribute('data-mode', 'editing')
    expect(textbox().value).toBe('My restored draft.\n')
    expect(screen.getByTestId('wiki-draft-base')).toHaveTextContent('Started from page version blob-1')
    expect(screen.queryByTestId('wiki-draft-stale')).toBeNull()
  })

  it('warns before saving when the page has changed since the draft started', async () => {
    await store.putDraft(draftInput({baseBlobSha: 'blob-0', baseText: 'older\n'}))
    await renderPage()

    expect(screen.getByTestId('wiki-draft-base')).toHaveTextContent('blob-0')
    const warning = screen.getByTestId('wiki-draft-stale')
    expect(warning).toHaveTextContent(/page has changed since/iu)
    expect(warning).toHaveTextContent('blob-1')
    expect(screen.getByRole('button', {name: 'Save'})).toBeEnabled()
  })

  it('says a draft could not be read and leaves it in place', async () => {
    idb.plant({pageId: PAGE_ID, schemaVersion: 99})
    await renderPage()

    expect(screen.getByTestId('wiki-draft-unreadable')).toHaveTextContent(/could not be read/iu)
    expect(idb.records()).toHaveLength(1)
    expect(screen.getByRole('button', {name: 'Edit'})).toBeEnabled()
  })

  it('reads the draft once when the page opens', async () => {
    const read = vi.spyOn(store, 'getDraft')
    await renderPage()
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('WikiEditor — an unreadable draft', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    idb.plant({pageId: PAGE_ID, schemaVersion: 99})
  })

  it('Cancel right after Edit leaves it in place, and the notice stays', async () => {
    await renderPage()
    await enterEdit()
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    await settle()

    expect(idb.records()).toEqual([{pageId: PAGE_ID, schemaVersion: 99}])
    expect(screen.getByTestId('wiki-draft-unreadable')).toBeInTheDocument()
  })

  it('the notice is also shown while editing, before the first change', async () => {
    await renderPage()
    await enterEdit()
    expect(screen.getByTestId('wiki-draft-unreadable')).toHaveTextContent(/could not be read/iu)
    expect(screen.getByRole('button', {name: 'Discard unreadable draft'})).toBeEnabled()
  })

  it('offers Discard unreadable draft, which asks first and deletes nothing yet', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', {name: 'Discard unreadable draft'}))
    await settle()

    const confirm = screen.getByTestId('wiki-discard-unreadable-confirm')
    expect(within(confirm).getByRole('heading', {name: 'Discard the unreadable draft?'})).toBeInTheDocument()
    expect(idb.records()).toHaveLength(1)
  })

  it('keeping it on the question changes nothing', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', {name: 'Discard unreadable draft'}))
    fireEvent.click(within(screen.getByTestId('wiki-discard-unreadable-confirm')).getByRole('button', {name: 'Keep it'}))
    await settle()

    expect(screen.queryByTestId('wiki-discard-unreadable-confirm')).toBeNull()
    expect(screen.getByTestId('wiki-draft-unreadable')).toBeInTheDocument()
    expect(idb.records()).toHaveLength(1)
  })

  it('confirming deletes it and says so', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', {name: 'Discard unreadable draft'}))
    fireEvent.click(within(screen.getByTestId('wiki-discard-unreadable-confirm')).getByRole('button', {name: 'Yes, discard it'}))
    await settle()

    expect(idb.records()).toHaveLength(0)
    expect(screen.queryByTestId('wiki-draft-unreadable')).toBeNull()
    expect(screen.getByTestId('wiki-draft-unreadable-status')).toHaveTextContent('The unreadable draft was discarded.')
  })

  it('leaves a draft another tab replaced meanwhile, refreshes the notice, and says so', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', {name: 'Discard unreadable draft'}))
    await store.putDraft(draftInput({draftText: 'another tab words'}), {replaceUnreadable: true})
    fireEvent.click(within(screen.getByTestId('wiki-discard-unreadable-confirm')).getByRole('button', {name: 'Yes, discard it'}))
    await settle()

    expect(idb.records()).toHaveLength(1)
    expect((idb.records()[0] as {draftText: string}).draftText).toBe('another tab words')
    expect(screen.queryByTestId('wiki-draft-unreadable')).toBeNull()
    expect(screen.queryByTestId('wiki-discard-unreadable-confirm')).toBeNull()
    expect(screen.getByTestId('wiki-draft-unreadable-status')).toHaveTextContent(/already replaced/iu)
  })

  it('a record that is already gone counts as discarded', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', {name: 'Discard unreadable draft'}))
    await store.deleteDraft(PAGE_ID)
    fireEvent.click(within(screen.getByTestId('wiki-discard-unreadable-confirm')).getByRole('button', {name: 'Yes, discard it'}))
    await settle()

    expect(idb.records()).toHaveLength(0)
    expect(screen.getByTestId('wiki-draft-unreadable-status')).toHaveTextContent('The unreadable draft was discarded.')
  })

  it('says so when it cannot be deleted, and keeps it', async () => {
    await renderPage()
    idb.failNext('delete', 'UnknownError')
    fireEvent.click(screen.getByRole('button', {name: 'Discard unreadable draft'}))
    fireEvent.click(within(screen.getByTestId('wiki-discard-unreadable-confirm')).getByRole('button', {name: 'Yes, discard it'}))
    await settle()

    expect(idb.records()).toHaveLength(1)
    expect(screen.getByTestId('wiki-draft-unreadable')).toBeInTheDocument()
    expect(screen.getByTestId('wiki-draft-unreadable-status')).toHaveTextContent(/could not be discarded/iu)
  })

  it('the first real edit replaces it, and the notice says it was replaced', async () => {
    await renderPage()
    await enterEdit()
    expect(idb.records()).toHaveLength(1)

    type('my words')
    await advance(DRAFT_DEBOUNCE_MS)

    expect(idb.records()).toHaveLength(1)
    expect(idb.records()[0]).toMatchObject({pageId: PAGE_ID, schemaVersion: 1, draftText: 'my words'})
    expect(screen.queryByTestId('wiki-draft-unreadable')).toBeNull()
    expect(screen.getByTestId('wiki-draft-unreadable-replaced')).toHaveTextContent(/was replaced/iu)
    expect(screen.queryByTestId('wiki-draft-local-failed')).toBeNull()
  })

  it('does not replace it until there is an edit', async () => {
    await renderPage()
    await enterEdit()
    await advance(DRAFT_DEBOUNCE_MS * 3)

    expect(idb.records()).toEqual([{pageId: PAGE_ID, schemaVersion: 99}])
    expect(screen.queryByTestId('wiki-draft-unreadable-replaced')).toBeNull()
  })
})

describe('WikiEditor — a draft another tab stored', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  const OTHER_TAB = {operationId: 'op-other-tab', sentAt: 1_900_000_000_000 - 5_000, bodyChanged: true, state: 'unknown'} as const

  it('autosave keeps the unknown-save marker the other tab stored', async () => {
    await renderPage()
    await enterEdit()
    type('my words')
    await store.putDraft(draftInput({draftText: 'other tab words', pending: OTHER_TAB}))

    await advance(DRAFT_DEBOUNCE_MS)

    expect(idb.records()[0]).toMatchObject({draftText: 'my words', pending: OTHER_TAB})
  })

  it('going back to the original text does not delete a record that holds the marker', async () => {
    await renderPage()
    await enterEdit()
    type('my words')
    await advance(DRAFT_DEBOUNCE_MS)
    await store.putDraft(draftInput({draftText: 'other tab words', pending: OTHER_TAB}))

    type(BODY)
    await advance(DRAFT_DEBOUNCE_MS)

    expect(idb.records()).toHaveLength(1)
    expect(idb.records()[0]).toMatchObject({pending: OTHER_TAB})
  })

  it('going back to the original text still deletes a record with no marker', async () => {
    await renderPage()
    await enterEdit()
    type('my words')
    await advance(DRAFT_DEBOUNCE_MS)
    expect(idb.records()).toHaveLength(1)

    type(BODY)
    await advance(DRAFT_DEBOUNCE_MS)

    expect(idb.records()).toHaveLength(0)
  })

  it('Cancel on a clean editor does not delete a record that holds the marker', async () => {
    await renderPage()
    await enterEdit()
    await store.putDraft(draftInput({draftText: 'other tab words', pending: OTHER_TAB}))

    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    await settle()

    expect(idb.records()).toHaveLength(1)
  })
})

describe('WikiEditor — cancel', () => {
  it('cancel with no changes leaves edit mode without asking', async () => {
    await renderPage()
    await enterEdit()
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    await settle()

    expect(screen.queryByTestId('wiki-cancel-confirm')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', {name: 'Edit'})).toBeInTheDocument()
  })

  it('cancel with changes asks whether to keep or discard the draft', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))

    const confirm = screen.getByTestId('wiki-cancel-confirm')
    expect(within(confirm).getByRole('heading', {name: 'Keep or discard your draft?'})).toBeInTheDocument()
    expect(within(confirm).getByRole('button', {name: 'Keep draft'})).toBeInTheDocument()
    expect(within(confirm).getByRole('button', {name: 'Discard draft'})).toBeInTheDocument()
    expect(within(confirm).getByRole('button', {name: 'Keep editing'})).toBeInTheDocument()
    expect(textbox().value).toBe('changed')
  })

  it('Keep draft stores the draft, leaves edit mode, and Resume draft brings it back', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    fireEvent.click(screen.getByRole('button', {name: 'Keep draft'}))
    await settle()

    expect((idb.records()[0] as {draftText: string}).draftText).toBe('changed')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByTestId('wiki-draft-kept')).toHaveTextContent(/draft is kept/iu)

    fireEvent.click(screen.getByRole('button', {name: 'Resume draft'}))
    await settle()
    expect(textbox().value).toBe('changed')
  })

  it('Keep draft that cannot be stored says so instead of "kept", and the text stays in the session', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    idb.failNext('put', 'QuotaExceededError')
    fireEvent.click(screen.getByRole('button', {name: 'Keep draft'}))
    await settle()

    expect(idb.records()).toHaveLength(0)
    expect(screen.queryByTestId('wiki-draft-kept')).toBeNull()
    expect(screen.getByTestId('wiki-draft-local-failed')).toHaveTextContent(/draft not saved locally/iu)
    expect(guardedWikiPageId()).toBe(PAGE_ID)

    fireEvent.click(screen.getByRole('button', {name: 'Resume draft'}))
    await settle()
    expect(textbox().value).toBe('changed')
  })

  it('Keep draft after going back to the original text reports a clean-up that failed', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, DRAFT_DEBOUNCE_MS + 50))
    })
    expect(idb.records()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    type(BODY)
    idb.failNext('delete', 'UnknownError')
    fireEvent.click(screen.getByRole('button', {name: 'Keep draft'}))
    await settle()

    expect(screen.queryByTestId('wiki-draft-kept')).toBeNull()
    expect(screen.getByTestId('wiki-draft-local-failed')).toBeInTheDocument()
  })

  it('Keep draft that is stored still says kept', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    fireEvent.click(screen.getByRole('button', {name: 'Keep draft'}))
    await settle()

    expect(screen.getByTestId('wiki-draft-kept')).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-draft-local-failed')).toBeNull()
  })

  it('Discard draft deletes it, leaves edit mode, and the next edit starts from the page', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    fireEvent.click(screen.getByRole('button', {name: 'Discard draft'}))
    await settle()

    expect(idb.records()).toHaveLength(0)
    expect(screen.queryByRole('textbox')).toBeNull()

    await enterEdit()
    expect(textbox().value).toBe(BODY)
  })

  it('Discard draft that cannot delete keeps the draft and says so', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, DRAFT_DEBOUNCE_MS + 50))
    })
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    idb.failNext('delete', 'UnknownError')
    fireEvent.click(screen.getByRole('button', {name: 'Discard draft'}))
    await settle()

    expect(screen.getByTestId('wiki-cancel-status')).toHaveTextContent(/could not be discarded/iu)
    expect(idb.records()).toHaveLength(1)
    expect(textbox().value).toBe('changed')
  })

  it('Keep editing dismisses the question and changes nothing', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    fireEvent.click(screen.getByRole('button', {name: 'Keep editing'}))

    expect(screen.queryByTestId('wiki-cancel-confirm')).toBeNull()
    expect(textbox().value).toBe('changed')
  })
})

describe('WikiEditor — the navigation guard', () => {
  it('holds nothing while viewing or when nothing has changed', async () => {
    await renderPage()
    expect(guardedWikiPageId()).toBeNull()
    await enterEdit()
    expect(guardedWikiPageId()).toBeNull()
  })

  it('holds navigation while there are unsaved changes, and lets go when they are undone', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    expect(guardedWikiPageId()).toBe(PAGE_ID)

    type(BODY)
    expect(guardedWikiPageId()).toBeNull()
  })

  it('stops the browser closing or reloading the page with unsaved changes', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    const event = new Event('beforeunload', {cancelable: true})
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not stop it when there is nothing to lose', async () => {
    await renderPage()
    await enterEdit()
    const event = new Event('beforeunload', {cancelable: true})
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('holds a restored draft', async () => {
    await store.putDraft(draftInput())
    await renderPage()
    expect(guardedWikiPageId()).toBe(PAGE_ID)
  })

  it('is released when the editor goes away', async () => {
    const view = await renderPage()
    await enterEdit()
    type('changed')
    view.unmount()
    expect(guardedWikiPageId()).toBeNull()
  })

  it('is released after Discard draft', async () => {
    await renderPage()
    await enterEdit()
    type('changed')
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    fireEvent.click(screen.getByRole('button', {name: 'Discard draft'}))
    await settle()
    expect(guardedWikiPageId()).toBeNull()
  })

  it('asks with a message that says whether the draft is stored on this device', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { confirmLeaveWiki } = await import('../wiki/navigation-guard.ts')

    await renderPage()
    await enterEdit()
    type('changed')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, DRAFT_DEBOUNCE_MS + 50))
    })
    confirmLeaveWiki(null)
    expect(confirm.mock.calls[0]?.[0]).toMatch(/kept on this device/iu)

    idb.failNext('put', 'QuotaExceededError')
    type('changed again')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, DRAFT_DEBOUNCE_MS + 50))
    })
    confirmLeaveWiki(null)
    expect(confirm.mock.calls[1]?.[0]).toMatch(/not stored on this device/iu)
  })
})
