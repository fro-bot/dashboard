/**
 * The wiki editor: entering edit mode, drafts, cancel, and the navigation guard.
 * Saving and its outcomes are in `WikiEditor.save.test.tsx`.
 */

import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
import * as wikiApi from '../api/wiki.ts'
import type {PromotionStatus, WikiPage} from '../api/wiki.ts'
import {createDraftStore, type DraftInput, type DraftStore} from '../wiki/drafts.ts'
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
