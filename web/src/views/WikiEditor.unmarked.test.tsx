/**
 * The unmarked-change notice and the confirmation on Save (U11). These drafts carry no marks, so
 * every change to the text is unmarked. Marks are in `WikiEditor.marking.test.tsx`.
 */

import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
import * as wikiApi from '../api/wiki.ts'
import type {WikiPage} from '../api/wiki.ts'
import {createDraftStore, type DraftStore} from '../wiki/drafts.ts'
import {createMemoryIdb} from '../wiki/test-support/memory-idb.ts'
import {WikiEditor} from './WikiEditor.tsx'

const PAGE_ID = 'repos.acme--alpha'
const BODY = '\n# acme/alpha\n\nAlpha builds widgets.\n'
const EDITED = `${BODY}One more line.\n`
const COMMIT = {operationId: 'op-1', commitSha: 'c1', committedAt: '2026-10-21T10:00:00Z'}

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
    corrections: [],
    correctionsBase: 'digest-1',
    headSha: 'commit-1',
    contract: {ok: true},
    canWrite: true,
    canWriteReason: null,
    ...overrides,
  }
}

const UNMARKABLE = {nodeId: null, canMark: false} as const

const ok = <T,>(value: T) => ({ok: true as const, value})
const saveFailure = (error: object) => ({ok: false as const, error}) as never

let store: DraftStore
let idb: ReturnType<typeof createMemoryIdb>
let getSpy: MockInstance<typeof wikiApi.getWikiPage>
let saveSpy: MockInstance<typeof wikiApi.saveWikiPage>
let uuidCount = 0

beforeEach(() => {
  idb = createMemoryIdb()
  store = createDraftStore({indexedDB: idb.factory, now: () => 1_900_000_000_000})
  getSpy = vi.spyOn(wikiApi, 'getWikiPage').mockResolvedValue(ok(pageOf()))
  vi.spyOn(wikiApi, 'promotionStatus').mockResolvedValue(ok({state: 'settled', pr: null}))
  saveSpy = vi.spyOn(wikiApi, 'saveWikiPage').mockResolvedValue(ok({state: 'saved', ...COMMIT}))
  uuidCount = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation((() => {
    uuidCount += 1
    return `op-${uuidCount}`
  }) as typeof crypto.randomUUID)
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

async function flush() {
  for (let i = 0; i < 12; i += 1) await act(async () => {})
}

async function renderPage() {
  const view = render(<WikiEditor pageId={PAGE_ID} onBackToList={vi.fn()} draftStore={store} />)
  await flush()
  return view
}

const button = (name: string) => screen.getByRole('button', {name})
const queryButton = (name: string) => screen.queryByRole('button', {name})
const textbox = () => screen.getByRole<HTMLTextAreaElement>('textbox', {name: 'Page text (raw Markdown)'})
const confirmation = () => screen.getByTestId('wiki-unmarked-confirm')

function type(value: string) {
  fireEvent.change(textbox(), {target: {value}})
}

async function startEditing(text = EDITED) {
  fireEvent.click(button('Edit'))
  await flush()
  type(text)
}

describe('the unmarked-change notice', () => {
  it('is visible while editing a markable page: only marked corrections survive, and how to mark', async () => {
    await renderPage()
    await startEditing()

    const notice = screen.getByTestId('wiki-unmarked-notice')
    expect(notice).toHaveAttribute('data-notice', 'marked-only')
    expect(notice).toHaveTextContent(/only marked corrections survive the next regeneration/iu)
    expect(notice).toHaveTextContent(/mark as correction/iu)
  })

  it('is visible in the read-only view of a markable page', async () => {
    getSpy.mockResolvedValue(ok(pageOf({canWrite: false, canWriteReason: 'not-operator'})))
    await renderPage()

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByTestId('wiki-unmarked-notice')).toHaveAttribute('data-notice', 'marked-only')
  })

  it('is visible before editing starts, and stays through the edit and back', async () => {
    await renderPage()
    expect(screen.getByTestId('wiki-unmarked-notice')).toBeInTheDocument()
    await startEditing()
    expect(screen.getByTestId('wiki-unmarked-notice')).toBeInTheDocument()
    fireEvent.click(button('Cancel'))
    fireEvent.click(button('Discard draft'))
    await flush()
    expect(screen.getByTestId('wiki-unmarked-notice')).toBeInTheDocument()
  })

  it('is plain text with no live-region role: it is a standing notice, not an event', async () => {
    await renderPage()
    expect(screen.getByTestId('wiki-unmarked-notice')).not.toHaveAttribute('role')
  })

  it('a page without a node_id shows the stronger notice: its edits do not survive regeneration', async () => {
    getSpy.mockResolvedValue(ok(pageOf(UNMARKABLE)))
    await renderPage()
    await startEditing()

    const notice = screen.getByTestId('wiki-unmarked-notice')
    expect(notice).toHaveAttribute('data-notice', 'no-node-id')
    expect(notice).toHaveTextContent(/edits to this page do not survive regeneration/iu)
    expect(notice).not.toHaveTextContent(/only marked corrections/iu)
  })

  it('the stronger notice is also shown in the read-only view', async () => {
    getSpy.mockResolvedValue(ok(pageOf({...UNMARKABLE, canWrite: false, canWriteReason: 'not-operator'})))
    await renderPage()
    expect(screen.getByTestId('wiki-unmarked-notice')).toHaveAttribute('data-notice', 'no-node-id')
  })
})

describe('Save asks for confirmation on a changed draft', () => {
  it('opens a confirmation that says unmarked changes will be lost at the next regeneration, and sends nothing yet', async () => {
    await renderPage()
    await startEditing()
    fireEvent.click(button('Save'))

    expect(saveSpy).not.toHaveBeenCalled()
    expect(within(confirmation()).getByRole('heading', {name: 'Save unmarked changes?'})).toBeInTheDocument()
    expect(confirmation()).toHaveTextContent(/unmarked changes will be lost at the next regeneration/iu)
    expect(confirmation()).toHaveAttribute('data-confirm', 'marked-only')
  })

  it('is a labelled group and moves focus to its heading so it is read out', async () => {
    await renderPage()
    await startEditing()
    fireEvent.click(button('Save'))
    await flush()

    expect(confirmation()).toHaveAttribute('role', 'group')
    expect(confirmation()).toHaveAccessibleName('Save unmarked changes?')
    expect(within(confirmation()).getByRole('heading', {name: 'Save unmarked changes?'})).toHaveFocus()
  })

  it('Confirm saves, with the draft and the base it started from', async () => {
    await renderPage()
    await startEditing()
    fireEvent.click(button('Save'))
    fireEvent.click(within(confirmation()).getByRole('button', {name: 'Confirm save'}))
    await flush()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0]?.[0]).toMatchObject({pageBlobSha: 'blob-1', body: EDITED})
    expect(screen.queryByTestId('wiki-unmarked-confirm')).toBeNull()
    expect(screen.getByTestId('wiki-saved')).toBeInTheDocument()
  })

  it('Confirm cannot double-submit', async () => {
    await renderPage()
    await startEditing()
    fireEvent.click(button('Save'))
    const confirm = within(confirmation()).getByRole('button', {name: 'Confirm save'})
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('Cancel returns to editing with the draft, focus in the text, and sends nothing', async () => {
    await renderPage()
    await startEditing()
    fireEvent.click(button('Save'))
    fireEvent.click(within(confirmation()).getByRole('button', {name: 'Back to editing'}))
    await flush()

    expect(screen.queryByTestId('wiki-unmarked-confirm')).toBeNull()
    expect(saveSpy).not.toHaveBeenCalled()
    expect(textbox().value).toBe(EDITED)
    expect(textbox()).toHaveFocus()
    expect(button('Save')).toBeEnabled()
  })

  it('asks again on the next Save after a cancel', async () => {
    await renderPage()
    await startEditing()
    fireEvent.click(button('Save'))
    fireEvent.click(button('Back to editing'))
    fireEvent.click(button('Save'))
    expect(confirmation()).toBeInTheDocument()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('a page without a node_id still asks, with the stronger wording', async () => {
    getSpy.mockResolvedValue(ok(pageOf(UNMARKABLE)))
    await renderPage()
    await startEditing()
    fireEvent.click(button('Save'))

    expect(saveSpy).not.toHaveBeenCalled()
    expect(confirmation()).toHaveAttribute('data-confirm', 'no-node-id')
    expect(confirmation()).toHaveTextContent(/do not survive the next regeneration/iu)
    fireEvent.click(button('Confirm save'))
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })
})

describe('an unchanged draft', () => {
  it('has no confirmation, and Save is disabled', async () => {
    await renderPage()
    fireEvent.click(button('Edit'))
    await flush()

    expect(button('Save')).toBeDisabled()
    fireEvent.click(button('Save'))
    expect(screen.queryByTestId('wiki-unmarked-confirm')).toBeNull()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('has none after the text is edited back to the original', async () => {
    await renderPage()
    await startEditing()
    type(BODY)
    expect(button('Save')).toBeDisabled()
    expect(screen.queryByTestId('wiki-unmarked-confirm')).toBeNull()
  })
})

describe('the confirmation is recorded against the current base and text', () => {
  beforeEach(() => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'rejected', reason: 'gate', findings: []}))
  })

  async function confirmedOnce() {
    await renderPage()
    await startEditing()
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(1)
  }

  it('saving the same text again on the same base does not ask twice', async () => {
    await confirmedOnce()
    fireEvent.click(button('Save'))
    await flush()
    expect(screen.queryByTestId('wiki-unmarked-confirm')).toBeNull()
    expect(saveSpy).toHaveBeenCalledTimes(2)
  })

  it('a further edit clears the confirmation and asks again', async () => {
    await confirmedOnce()
    type(`${EDITED}Another change.\n`)
    fireEvent.click(button('Save'))

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(confirmation()).toBeInTheDocument()
  })

  it('editing away and back to the confirmed text does not restore it: any change clears it', async () => {
    await confirmedOnce()
    type('something else')
    type(EDITED)
    fireEvent.click(button('Save'))
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(confirmation()).toBeInTheDocument()
  })

  it('a base change after confirming clears the confirmation', async () => {
    saveSpy.mockResolvedValueOnce(saveFailure({kind: 'conflict', conflict: {kind: 'page', currentBlobSha: 'blob-2'}}))
    await renderPage()
    await startEditing()
    getSpy.mockResolvedValue(ok(pageOf({body: 'newer\n', pageBlobSha: 'blob-2'})))
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()
    expect(screen.getByTestId('wiki-conflict')).toBeInTheDocument()

    fireEvent.click(button('Overwrite with my draft'))
    fireEvent.click(button('Yes, overwrite'))
    await flush()
    expect(textbox().value).toBe(EDITED)

    saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-2'}))
    fireEvent.click(button('Save'))
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(confirmation()).toBeInTheDocument()
  })

  it('a base change while the confirmation is open closes it', async () => {
    await renderPage()
    await startEditing()
    fireEvent.click(button('Save'))
    expect(confirmation()).toBeInTheDocument()

    type(`${EDITED}Typed while it was open.\n`)
    expect(screen.queryByTestId('wiki-unmarked-confirm')).toBeNull()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('the confirmation does not carry over to a new session of the page', async () => {
    await confirmedOnce()
    cleanup()
    await store.putDraft({
      pageId: PAGE_ID,
      baseBlobSha: 'blob-1',
      baseText: BODY,
      correctionsBase: {entries: [], digest: 'digest-1'},
      draftText: EDITED,
      pending: null,
    })
    await renderPage()
    fireEvent.click(button('Save'))
    expect(confirmation()).toBeInTheDocument()
  })

  it('Save again after a status check does not ask twice for the same text and base', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'status-unknown', cause: 'timeout'}))
    vi.spyOn(wikiApi, 'lookupWikiOperation').mockResolvedValue(ok({state: 'missing'}) as never)
    await renderPage()
    await startEditing()
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()
    fireEvent.click(button('Check save status'))
    await flush()

    saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-2'}))
    fireEvent.click(button('Save again'))
    await flush()
    expect(queryButton('Confirm save')).toBeNull()
    expect(saveSpy).toHaveBeenCalledTimes(2)
  })
})

describe('a restored draft', () => {
  it('asks for confirmation on Save, because nothing was confirmed in this session', async () => {
    await store.putDraft({
      pageId: PAGE_ID,
      baseBlobSha: 'blob-1',
      baseText: BODY,
      correctionsBase: {entries: [], digest: 'digest-1'},
      draftText: EDITED,
      pending: null,
    })
    await renderPage()
    fireEvent.click(button('Save'))
    expect(saveSpy).not.toHaveBeenCalled()
    expect(confirmation()).toBeInTheDocument()
  })
})
