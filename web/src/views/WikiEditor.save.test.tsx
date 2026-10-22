/**
 * The wiki editor: saving, every outcome, resolving an unknown save, and promotion status.
 * Entering edit mode, drafts and the navigation guard are in `WikiEditor.edit.test.tsx`.
 */

import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
import * as wikiApi from '../api/wiki.ts'
import type {PromotionStatus, WikiCorrection, WikiPage} from '../api/wiki.ts'
import {createDraftStore, type DraftInput, type DraftStore} from '../wiki/drafts.ts'
import {guardedWikiPageId} from '../wiki/navigation-guard.ts'
import {PROMOTION_POLL_INTERVAL_MS} from '../wiki/use-promotion-polling.ts'
import {createMemoryIdb} from '../wiki/test-support/memory-idb.ts'
import {WikiEditor} from './WikiEditor.tsx'

const PAGE_ID = 'repos.acme--alpha'
const BODY = '\n# acme/alpha\n\nAlpha builds widgets. See [[nope]] and [[also-nope]].\n'
const EDITED = `${BODY}One more line.\n`
const NOW = 1_900_000_000_000
const COMMIT = {operationId: 'op-1', commitSha: 'c1', committedAt: '2026-10-21T10:00:00Z'}
const BASE_ENTRY: WikiCorrection = {
  id: 'c1',
  status: 'active',
  span: {text: 'Alpha builds widgets'},
  attribution: {actor: 'marcus', recordedAt: '2026-02-04T10:00:00Z'},
  reason: 'It builds gadgets now.',
  supersededBy: null,
  stale: false,
}

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
    corrections: [BASE_ENTRY],
    correctionsBase: 'digest-1',
    headSha: 'commit-1',
    contract: {ok: true},
    canWrite: true,
    canWriteReason: null,
    ...overrides,
  }
}

const ok = <T,>(value: T) => ({ok: true as const, value})
const saveFailure = (error: object) => ({ok: false as const, error}) as never
const lookupOk = (value: object) => ok(value) as never
const lookupFailure = (kind: string, extra: object = {}) => ({ok: false as const, error: {kind, ...extra}}) as never
const settledStatus: PromotionStatus = {state: 'settled', pr: null}
const PR = {number: 12, url: 'https://github.com/fro-bot/.github/pull/12'}

let store: DraftStore
let idb: ReturnType<typeof createMemoryIdb>
let getSpy: MockInstance<typeof wikiApi.getWikiPage>
let statusSpy: MockInstance<typeof wikiApi.promotionStatus>
let saveSpy: MockInstance<typeof wikiApi.saveWikiPage>
let lookupSpy: MockInstance<typeof wikiApi.lookupWikiOperation>
let dispatchSpy: MockInstance<typeof wikiApi.retryPromotionDispatch>
let uuidSpy: MockInstance<typeof crypto.randomUUID>
let uuidCount = 0

beforeEach(() => {
  idb = createMemoryIdb()
  store = createDraftStore({indexedDB: idb.factory, now: () => NOW})
  getSpy = vi.spyOn(wikiApi, 'getWikiPage').mockResolvedValue(ok(pageOf()))
  statusSpy = vi.spyOn(wikiApi, 'promotionStatus').mockResolvedValue(ok(settledStatus))
  saveSpy = vi.spyOn(wikiApi, 'saveWikiPage').mockResolvedValue(ok({state: 'saved', ...COMMIT}))
  lookupSpy = vi.spyOn(wikiApi, 'lookupWikiOperation').mockResolvedValue(lookupOk({state: 'missing'}))
  dispatchSpy = vi.spyOn(wikiApi, 'retryPromotionDispatch').mockResolvedValue(ok({state: 'dispatched'}))
  uuidCount = 0
  uuidSpy = vi.spyOn(crypto, 'randomUUID').mockImplementation((() => {
    uuidCount += 1
    return `op-${uuidCount}`
  }) as typeof crypto.randomUUID)
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  sessionStorage.clear()
  Reflect.deleteProperty(navigator, 'clipboard')
})

async function flush() {
  for (let i = 0; i < 12; i += 1) await act(async () => {})
}

/** Let a real timer of zero delay fire (the first promotion read is scheduled with one). */
async function macrotask() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
  })
}

async function renderPage(props: Partial<React.ComponentProps<typeof WikiEditor>> = {}) {
  const view = render(<WikiEditor pageId={PAGE_ID} onBackToList={vi.fn()} draftStore={store} {...props} />)
  await flush()
  return view
}

const textbox = () => screen.getByRole<HTMLTextAreaElement>('textbox', {name: 'Page text (raw Markdown)'})
const button = (name: string) => screen.getByRole('button', {name})
const queryButton = (name: string) => screen.queryByRole('button', {name})
const announcer = () => screen.getByTestId('wiki-save-status')
const outcome = () => screen.getByTestId('wiki-outcome')

function type(value: string) {
  fireEvent.change(textbox(), {target: {value}})
}

/**
 * Click Save (or Save again). A changed draft asks for confirmation first (U11), so this
 * confirms when the question is open; a draft already confirmed for this base and text goes straight out.
 */
function clickSave(name = 'Save') {
  fireEvent.click(button(name))
  const confirm = queryButton('Confirm save')
  if (confirm !== null) fireEvent.click(confirm)
}

async function startEditing(text = EDITED) {
  fireEvent.click(button('Edit'))
  await flush()
  type(text)
}

async function editAndSave(text = EDITED) {
  await startEditing(text)
  clickSave()
  await flush()
}

function records() {
  return idb.records() as {draftText: string; baseBlobSha: string; correctionsBase: {digest: string; entries: unknown[]}; pending: null | {operationId: string; state: string; sentAt: number}}[]
}

function pendingDraft(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    pageId: PAGE_ID,
    baseBlobSha: 'blob-1',
    baseText: BODY,
    correctionsBase: {entries: [BASE_ENTRY], digest: 'digest-1'},
    draftText: EDITED,
    pending: {operationId: 'op-9', sentAt: NOW - 5_000, bodyChanged: true, state: 'unknown'},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe('save — the happy path', () => {
  it('sends the draft with the base it started from, a fresh operation ID, and no head guard', async () => {
    await renderPage()
    await editAndSave()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const input = saveSpy.mock.calls[0]?.[0]
    expect(input).toEqual({
      pageId: PAGE_ID,
      operationId: 'op-1',
      pageBlobSha: 'blob-1',
      correctionsBase: 'digest-1',
      body: EDITED,
    })
    expect(uuidSpy).toHaveBeenCalledTimes(1)
  })

  it('shows "Saved, pending publication" with the open PR, clears the draft, and returns to viewing', async () => {
    statusSpy.mockResolvedValueOnce(ok(settledStatus)).mockResolvedValue(ok({state: 'pending', pr: PR}))
    await renderPage()
    await editAndSave()
    await macrotask()

    const panel = screen.getByTestId('wiki-saved')
    expect(panel).toHaveAttribute('data-saved', 'saved')
    expect(panel).toHaveTextContent('Saved, pending publication')
    expect(within(panel).getByRole('link', {name: 'View the pull request'})).toHaveAttribute('href', PR.url)
    expect(records()).toHaveLength(0)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByTestId('wiki-editor')).toHaveAttribute('data-mode', 'viewing')
    expect(guardedWikiPageId()).toBeNull()
  })

  it('the pending copy says the weekly schedule also promotes and saving again is not needed', async () => {
    statusSpy.mockResolvedValueOnce(ok(settledStatus)).mockResolvedValue(ok({state: 'pending', pr: null}))
    await renderPage()
    await editAndSave()
    expect(screen.getByTestId('wiki-saved')).toHaveTextContent(/weekly schedule/iu)
    expect(screen.getByTestId('wiki-saved')).toHaveTextContent(/saving again is not needed/iu)
  })

  it('reads the page again after a save, so a later edit starts from the new version', async () => {
    await renderPage()
    expect(getSpy).toHaveBeenCalledTimes(1)
    await editAndSave()
    expect(getSpy).toHaveBeenCalledTimes(2)
  })

  it('stores the pending operation in the draft before the request goes out', async () => {
    let seen: unknown = null
    saveSpy.mockImplementation(async () => {
      const draft = await store.getDraft(PAGE_ID)
      seen = draft.ok ? draft.value?.pending : 'unreadable'
      return ok({state: 'saved' as const, ...COMMIT})
    })
    await renderPage()
    await editAndSave()
    expect(seen).toEqual({operationId: 'op-1', sentAt: NOW, bodyChanged: true, state: 'sending'})
  })

  it('a save while other pages changed upstream still succeeds: the request carries only this page’s blob', async () => {
    getSpy.mockResolvedValueOnce(ok(pageOf({headSha: 'commit-1'}))).mockResolvedValue(ok(pageOf({headSha: 'commit-99'})))
    await renderPage()
    await editAndSave()
    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-saved', 'saved')
    expect(saveSpy.mock.calls[0]?.[0]).not.toHaveProperty('headSha')
  })
})

describe('save — while sending', () => {
  it('disables Save and the text, says "Saving…", and cannot double-submit', async () => {
    let finish: (value: Awaited<ReturnType<typeof wikiApi.saveWikiPage>>) => void = () => {}
    saveSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      }),
    )
    await renderPage()
    await startEditing()

    fireEvent.click(button('Save'))
    const confirm = button('Confirm save')
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await flush()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(button('Save')).toBeDisabled()
    expect(button('Cancel')).toBeDisabled()
    expect(textbox()).toHaveAttribute('readonly')
    expect(announcer()).toHaveTextContent('Saving…')
    expect(screen.getByTestId('wiki-editor')).toHaveAttribute('data-phase', 'saving')
    expect(guardedWikiPageId()).toBe(PAGE_ID)

    await act(async () => {
      finish(ok({state: 'saved', ...COMMIT}))
    })
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('the polite status region announces saving then saved, once each', async () => {
    const seen: string[] = []
    await renderPage()
    await startEditing()
    const region = announcer()
    expect(region).toHaveAttribute('role', 'status')
    new MutationObserver(() => {
      seen.push(region.textContent ?? '')
    }).observe(region, {childList: true, characterData: true, subtree: true})

    clickSave()
    await flush()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(seen).toEqual(['Saving…', 'Saved, pending publication'])
  })

  it('announces saving then a failure, once each', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'failed', operationId: 'op-1', retryable: true}))
    const seen: string[] = []
    await renderPage()
    await startEditing()
    const region = announcer()
    new MutationObserver(() => {
      seen.push(region.textContent ?? '')
    }).observe(region, {childList: true, characterData: true, subtree: true})

    clickSave()
    await flush()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(seen).toEqual(['Saving…', 'Save failed'])
  })

  it('does not send when the local store refuses the pending operation, and says nothing was sent', async () => {
    await renderPage()
    await startEditing()
    idb.failNext('put', 'QuotaExceededError')
    clickSave()
    await flush()

    expect(saveSpy).not.toHaveBeenCalled()
    expect(outcome()).toHaveAttribute('data-outcome', 'not-sent')
    expect(outcome()).toHaveTextContent(/nothing was sent/iu)
    expect(textbox().value).toBe(EDITED)
    expect(button('Save again')).toBeEnabled()
  })
})

describe('save — rejected', () => {
  const findings = [
    {kind: 'gate', path: 'wiki/repos.acme--alpha.md', message: 'Unknown link.', target: '[[also-nope]]'},
    {kind: 'gate', path: 'wiki/repos.acme--alpha.md', message: 'Unknown link.', target: '[[nope]]'},
    {kind: 'gate', path: 'wiki/repos.acme--alpha.md', message: 'The page has no summary.'},
  ]

  beforeEach(() => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'rejected', reason: 'gate', findings}))
  })

  it('lists every finding and keeps the draft', async () => {
    await renderPage()
    await editAndSave()

    expect(outcome()).toHaveAttribute('data-outcome', 'rejected')
    expect(outcome()).toHaveAttribute('data-draft', 'kept')
    const items = within(screen.getByTestId('wiki-findings')).getAllByTestId('wiki-finding')
    expect(items).toHaveLength(3)
    expect(items[2]).toHaveAttribute('data-located', 'false')
    expect(items[2]).toHaveTextContent('The page has no summary.')
    expect(textbox().value).toBe(EDITED)
    expect(records()[0]?.draftText).toBe(EDITED)
    expect(records()[0]?.pending).toBeNull()
  })

  it('selects the first occurrence of the first located target in the text', async () => {
    await renderPage()
    await editAndSave()

    const target = '[[also-nope]]'
    const start = EDITED.indexOf(target)
    expect(textbox().selectionStart).toBe(start)
    expect(textbox().selectionEnd).toBe(start + target.length)
    expect(textbox()).toHaveFocus()
  })

  it('Show in text selects another located finding', async () => {
    await renderPage()
    await editAndSave()

    const items = screen.getAllByTestId('wiki-finding')
    fireEvent.click(within(items[1] as HTMLElement).getByRole('button', {name: 'Show in text'}))
    const start = EDITED.indexOf('[[nope]]')
    expect(textbox().selectionStart).toBe(start)
    expect(textbox().selectionEnd).toBe(start + '[[nope]]'.length)
  })

  it('a target that is not in the text selects nothing and does not fail', async () => {
    saveSpy.mockResolvedValue(
      saveFailure({kind: 'rejected', reason: 'gate', findings: [{kind: 'gate', path: 'p', message: 'm', target: 'absent text'}]}),
    )
    await renderPage()
    await editAndSave()
    expect(textbox().selectionStart).toBe(textbox().selectionEnd)
  })

  it('lets the operator fix the text and save again', async () => {
    await renderPage()
    await editAndSave()
    saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-2'}))
    type('fixed')
    clickSave()
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(2)
    expect(saveSpy.mock.calls[1]?.[0].operationId).toBe('op-2')
    expect(screen.getByTestId('wiki-saved')).toBeInTheDocument()
  })

  it('a rejection with no findings still says why', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'rejected', reason: 'no-change', findings: []}))
    await renderPage()
    await editAndSave()
    expect(outcome()).toHaveTextContent(/no changes/iu)
    expect(screen.queryByTestId('wiki-findings')).toBeNull()
  })
})

describe('save — conflict', () => {
  const NEWER = '\n# acme/alpha\n\nSomeone else rewrote this.\n'

  describe('page kind', () => {
    beforeEach(() => {
      saveSpy.mockResolvedValue(saveFailure({kind: 'conflict', conflict: {kind: 'page', currentBlobSha: 'blob-2'}}))
    })

    async function conflicted() {
      await renderPage()
      getSpy.mockResolvedValue(ok(pageOf({body: NEWER, pageBlobSha: 'blob-2'})))
      await editAndSave()
    }

    it('names the kind, shows the current version and the draft as plain text, and keeps the draft', async () => {
      await conflicted()

      const view = screen.getByTestId('wiki-conflict')
      expect(view).toHaveAttribute('data-conflict-kind', 'page')
      expect(within(view).getByRole('heading', {name: 'The page changed'})).toBeInTheDocument()
      expect(screen.getByTestId('wiki-conflict-current').tagName).toBe('PRE')
      expect(screen.getByTestId('wiki-conflict-current').textContent).toBe(NEWER)
      expect(screen.getByTestId('wiki-conflict-draft').textContent).toBe(EDITED)
      expect(records()[0]?.draftText).toBe(EDITED)
      expect(records()[0]?.pending).toBeNull()
      expect(screen.queryByRole('textbox')).toBeNull()
    })

    it('treats both versions as text, not markup', async () => {
      saveSpy.mockResolvedValue(saveFailure({kind: 'conflict', conflict: {kind: 'page', currentBlobSha: 'blob-2'}}))
      await renderPage()
      getSpy.mockResolvedValue(ok(pageOf({body: '<img src=x onerror=alert(1)>', pageBlobSha: 'blob-2'})))
      await editAndSave('<script>alert(2)</script>')
      expect(document.querySelector('img, script')).toBeNull()
      expect(screen.getByTestId('wiki-conflict-current').textContent).toBe('<img src=x onerror=alert(1)>')
    })

    it('requires an explicit, confirmed overwrite, which re-bases the draft on the current blob', async () => {
      await conflicted()

      fireEvent.click(button('Overwrite with my draft'))
      expect(saveSpy).toHaveBeenCalledTimes(1)
      const confirm = screen.getByTestId('wiki-overwrite-confirm')
      expect(within(confirm).getByRole('heading', {name: 'Overwrite the current version?'})).toBeInTheDocument()

      fireEvent.click(within(confirm).getByRole('button', {name: 'Yes, overwrite'}))
      await flush()

      expect(screen.getByTestId('wiki-draft-rebased')).toBeInTheDocument()
      expect(textbox().value).toBe(EDITED)
      expect(records()[0]?.baseBlobSha).toBe('blob-2')
      expect(screen.getByTestId('wiki-draft-base')).toHaveTextContent('blob-2')

      saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-2'}))
      clickSave()
      await flush()
      expect(saveSpy).toHaveBeenCalledTimes(2)
      expect(saveSpy.mock.calls[1]?.[0]).toMatchObject({pageBlobSha: 'blob-2', body: EDITED})
    })

    it('declining the overwrite changes nothing', async () => {
      await conflicted()
      fireEvent.click(button('Overwrite with my draft'))
      fireEvent.click(button('Keep comparing'))
      expect(screen.queryByTestId('wiki-overwrite-confirm')).toBeNull()
      expect(screen.getByTestId('wiki-conflict')).toBeInTheDocument()
      expect(saveSpy).toHaveBeenCalledTimes(1)
    })

    it('Keep editing returns to the text with the draft', async () => {
      await conflicted()
      fireEvent.click(button('Keep editing'))
      expect(textbox().value).toBe(EDITED)
    })

    it('cannot overwrite until the current version has loaded, and offers a retry when it cannot', async () => {
      saveSpy.mockResolvedValue(saveFailure({kind: 'conflict', conflict: {kind: 'page', currentBlobSha: 'blob-2'}}))
      await renderPage()
      getSpy.mockResolvedValue({ok: false, error: {kind: 'unavailable'}} as never)
      await editAndSave()

      expect(button('Overwrite with my draft')).toBeDisabled()
      const failed = screen.getByTestId('wiki-conflict-load-failed')
      getSpy.mockResolvedValue(ok(pageOf({body: NEWER, pageBlobSha: 'blob-2'})))
      fireEvent.click(within(failed).getByRole('button', {name: 'Try again'}))
      await flush()

      expect(button('Overwrite with my draft')).toBeEnabled()
      expect(screen.getByTestId('wiki-conflict-current').textContent).toBe(NEWER)
    })

    it('the page vanishing while the comparison loads says so and cannot be overwritten', async () => {
      await renderPage()
      getSpy.mockResolvedValue({ok: false, error: {kind: 'not-found'}} as never)
      await editAndSave()
      expect(screen.getByTestId('wiki-conflict-removed')).toBeInTheDocument()
      expect(button('Overwrite with my draft')).toBeDisabled()
    })
  })

  describe('corrections kind', () => {
    const CURRENT_ENTRY: WikiCorrection = {...BASE_ENTRY, id: 'c2', span: {text: 'Beta is old'}, reason: 'Added elsewhere.'}

    beforeEach(() => {
      saveSpy.mockResolvedValue(
        saveFailure({
          kind: 'conflict',
          conflict: {kind: 'corrections', currentCorrections: [BASE_ENTRY, CURRENT_ENTRY], correctionsBase: 'digest-2'},
        }),
      )
    })

    it('names its kind and shows the base entries against the current ones', async () => {
      await renderPage()
      getSpy.mockResolvedValue(ok(pageOf({pageBlobSha: 'blob-3', correctionsBase: 'digest-2', corrections: [BASE_ENTRY, CURRENT_ENTRY]})))
      await editAndSave()

      const view = screen.getByTestId('wiki-conflict')
      expect(view).toHaveAttribute('data-conflict-kind', 'corrections')
      expect(within(view).getByRole('heading', {name: 'The corrections changed'})).toBeInTheDocument()
      expect(within(screen.getByTestId('wiki-conflict-corrections-base')).getAllByRole('listitem')).toHaveLength(1)
      const current = within(screen.getByTestId('wiki-conflict-corrections-current')).getAllByRole('listitem')
      expect(current).toHaveLength(2)
      expect(current[1]).toHaveTextContent('Beta is old')
      expect(records()[0]?.draftText).toBe(EDITED)
    })

    it('overwrite re-bases the page blob and the corrections base together, and the draft stores both', async () => {
      await renderPage()
      getSpy.mockResolvedValue(ok(pageOf({pageBlobSha: 'blob-3', correctionsBase: 'digest-2', corrections: [BASE_ENTRY, CURRENT_ENTRY]})))
      await editAndSave()

      fireEvent.click(button('Overwrite with my draft'))
      fireEvent.click(button('Yes, overwrite'))
      await flush()

      const [record] = records()
      expect(record?.baseBlobSha).toBe('blob-3')
      expect(record?.correctionsBase.digest).toBe('digest-2')
      expect(record?.correctionsBase.entries).toHaveLength(2)

      saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-2'}))
      clickSave()
      await flush()
      expect(saveSpy.mock.calls[1]?.[0]).toMatchObject({pageBlobSha: 'blob-3', correctionsBase: 'digest-2'})
    })
  })

  describe('page-removed kind', () => {
    beforeEach(() => {
      saveSpy.mockResolvedValue(saveFailure({kind: 'conflict', conflict: {kind: 'page-removed'}}))
    })

    it('disables Save, keeps the draft, and lets the text be copied out', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}})
      await renderPage()
      await editAndSave()

      expect(outcome()).toHaveAttribute('data-outcome', 'conflict-page-removed')
      expect(outcome()).toHaveAttribute('role', 'alert')
      expect(button('Save')).toBeDisabled()
      expect(textbox().value).toBe(EDITED)
      expect(records()[0]?.draftText).toBe(EDITED)

      fireEvent.click(button('Copy draft'))
      await flush()
      expect(writeText).toHaveBeenCalledWith(EDITED)
      expect(screen.getByTestId('wiki-copy-status')).toHaveTextContent('Draft copied.')
    })

    it('still lets the operator cancel and keep or discard the draft', async () => {
      await renderPage()
      await editAndSave()
      fireEvent.click(button('Cancel'))
      expect(screen.getByTestId('wiki-cancel-confirm')).toBeInTheDocument()
    })
  })
})

describe('save — nothing committed', () => {
  it('failed and retryable: says nothing was saved, keeps the draft, and Save again sends a fresh operation', async () => {
    saveSpy.mockResolvedValueOnce(saveFailure({kind: 'failed', operationId: 'op-1', retryable: true}))
    await renderPage()
    await editAndSave()

    expect(outcome()).toHaveAttribute('data-outcome', 'failed')
    expect(outcome()).toHaveTextContent(/nothing was saved/iu)
    expect(records()[0]?.draftText).toBe(EDITED)
    expect(records()[0]?.pending).toBeNull()

    saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-2'}))
    clickSave('Save again')
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(2)
    expect(saveSpy.mock.calls[1]?.[0].operationId).toBe('op-2')
    expect(screen.getByTestId('wiki-saved')).toBeInTheDocument()
  })

  it('failed and not retryable: a configuration message, no retry, Save disabled, draft kept', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'failed', operationId: 'op-1', retryable: false}))
    await renderPage()
    await editAndSave()

    expect(outcome()).toHaveAttribute('data-outcome', 'failed-configuration')
    expect(outcome()).toHaveAttribute('role', 'alert')
    expect(outcome()).toHaveTextContent(/configuration/iu)
    expect(queryButton('Save again')).toBeNull()
    expect(button('Save')).toBeDisabled()
    expect(records()[0]?.draftText).toBe(EDITED)
  })

  it('contract mismatch on save: the dashboard needs a deploy, Save disabled, draft kept', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'contract-rejected', reason: 'mismatch', retry: false}))
    await renderPage()
    await editAndSave()

    expect(outcome()).toHaveAttribute('data-outcome', 'contract-mismatch')
    expect(outcome()).toHaveTextContent(/dashboard needs a deploy/iu)
    expect(button('Save')).toBeDisabled()
    expect(queryButton('Save again')).toBeNull()
    expect(records()[0]?.draftText).toBe(EDITED)
  })

  it('contract unreadable on save: offers Save again, draft kept', async () => {
    saveSpy.mockResolvedValueOnce(saveFailure({kind: 'contract-rejected', reason: 'unreadable', retry: true}))
    await renderPage()
    await editAndSave()

    expect(outcome()).toHaveAttribute('data-outcome', 'contract-unreadable')
    expect(button('Save again')).toBeEnabled()
    clickSave('Save again')
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(2)
  })

  it('rate-limited: its own message with the retry hint, draft kept, Save available', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'rate-limited', retryAfterSeconds: 30}))
    await renderPage()
    await editAndSave()

    expect(outcome()).toHaveAttribute('data-outcome', 'rate-limited')
    expect(outcome()).toHaveTextContent('30 seconds')
    expect(records()[0]?.draftText).toBe(EDITED)
    expect(records()[0]?.pending).toBeNull()
    expect(button('Save')).toBeEnabled()
  })

  it('a removed page on save (not-found) disables Save and keeps the draft', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'not-found'}))
    await renderPage()
    await editAndSave()
    expect(button('Save')).toBeDisabled()
    expect(records()[0]?.draftText).toBe(EDITED)
  })

  it('a refused request asks for a reload and shows no status code', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'bad-request'}))
    await renderPage()
    await editAndSave()
    expect(outcome()).toHaveTextContent(/reload/iu)
    expect(outcome().textContent).not.toMatch(/400|bad-request/u)
    expect(button('Save')).toBeDisabled()
  })
})

describe('save — status unknown', () => {
  async function unknownSave(error: object = {kind: 'status-unknown', cause: 'timeout'}) {
    saveSpy.mockResolvedValue(saveFailure(error))
    await renderPage()
    await editAndSave()
  }

  it('a timeout shows "Save status unknown" with no retry, and keeps the pending operation', async () => {
    await unknownSave()

    expect(outcome()).toHaveAttribute('data-outcome', 'status-unknown')
    expect(outcome()).toHaveTextContent('Save status unknown')
    expect(queryButton('Save again')).toBeNull()
    expect(button('Save')).toBeDisabled()
    expect(textbox()).toHaveAttribute('readonly')
    expect(button('Check save status')).toBeEnabled()
    expect(records()[0]?.draftText).toBe(EDITED)
    expect(records()[0]?.pending).toMatchObject({operationId: 'op-1', state: 'unknown'})
    expect(guardedWikiPageId()).toBe(PAGE_ID)
  })

  it('never retries automatically', async () => {
    vi.useFakeTimers()
    await unknownSave()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROMOTION_POLL_INTERVAL_MS * 10)
    })
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(lookupSpy).not.toHaveBeenCalled()
  })

  it('a network error mid-save is "Save status unknown", not a failure', async () => {
    await unknownSave({kind: 'status-unknown', cause: 'network'})
    expect(outcome()).toHaveAttribute('data-outcome', 'status-unknown')
    expect(screen.queryByText('Save failed')).toBeNull()
  })

  it('a lost session mid-save is "Save status unknown" with a way to sign in', async () => {
    await unknownSave({kind: 'status-unknown', cause: 'session-lost'})
    expect(outcome()).toHaveAttribute('data-outcome', 'status-unknown')
    expect(within(outcome()).getByRole('link', {name: 'Sign in'})).toHaveAttribute(
      'href',
      '/auth/login?next=%2Fwiki%2Frepos.acme--alpha',
    )
    expect(records()[0]?.pending).not.toBeNull()
  })

  it('an indeterminate reply is "Save status unknown"', async () => {
    await unknownSave({kind: 'status-unknown', cause: 'indeterminate'})
    expect(outcome()).toHaveAttribute('data-outcome', 'status-unknown')
  })

  it('a save contract-drift is "Save status unknown" and never retried', async () => {
    await unknownSave({kind: 'contract-drift'})
    expect(outcome()).toHaveAttribute('data-outcome', 'status-unknown')
    expect(queryButton('Save again')).toBeNull()
    expect(button('Check save status')).toBeInTheDocument()
  })

  it('"Check save status" asks once per click, and finds the commit: draft cleared, saved not promoted, retry dispatch', async () => {
    lookupSpy.mockResolvedValue(lookupOk({state: 'found', commitSha: 'c1', committedAt: COMMIT.committedAt}))
    await unknownSave()
    fireEvent.click(button('Check save status'))
    await flush()

    expect(lookupSpy).toHaveBeenCalledTimes(1)
    expect(lookupSpy).toHaveBeenCalledWith({operationId: 'op-1', pageId: PAGE_ID, startedAt: NOW})
    expect(records()).toHaveLength(0)
    const panel = screen.getByTestId('wiki-saved')
    expect(panel).toHaveAttribute('data-saved', 'saved-not-promoted')
    // The lookup cannot see the dispatch result, so the headline does not claim one.
    expect(within(panel).getByRole('heading', {level: 3})).toHaveTextContent('Saved, publication unknown')
    expect(panel).not.toHaveTextContent('Saved, not promoted')
    expect(within(panel).getByRole('button', {name: 'Retry dispatch'})).toBeEnabled()
    expect(screen.queryByTestId('wiki-outcome')).toBeNull()
    expect(guardedWikiPageId()).toBeNull()
  })

  it('a missing commit restores the draft with Save again, and the next save has a fresh operation ID', async () => {
    lookupSpy.mockResolvedValue(lookupOk({state: 'missing'}))
    await unknownSave()
    fireEvent.click(button('Check save status'))
    await flush()

    expect(outcome()).toHaveAttribute('data-outcome', 'lookup-missing')
    expect(textbox().value).toBe(EDITED)
    expect(textbox()).not.toHaveAttribute('readonly')
    expect(records()[0]?.pending).toBeNull()

    saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-2'}))
    clickSave('Save again')
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(2)
    expect(saveSpy.mock.calls[1]?.[0].operationId).toBe('op-2')
  })

  it('an undecidable lookup shows the conflict view with the newer version labeled "possibly your save"', async () => {
    lookupSpy.mockResolvedValue(lookupOk({state: 'unknown'}))
    await unknownSave()
    getSpy.mockResolvedValue(ok(pageOf({body: 'newer text\n', pageBlobSha: 'blob-2'})))
    fireEvent.click(button('Check save status'))
    await flush()

    const view = screen.getByTestId('wiki-conflict')
    expect(view).toHaveAttribute('data-conflict-kind', 'possibly-saved')
    expect(within(view).getByRole('heading', {name: 'Current version (possibly your save)'})).toBeInTheDocument()
    expect(screen.getByTestId('wiki-conflict-current').textContent).toBe('newer text\n')
    expect(screen.getByTestId('wiki-conflict-draft').textContent).toBe(EDITED)
    expect(records()[0]?.pending).not.toBeNull()
    expect(button('Check save status')).toBeEnabled()
  })

  it('overwriting from the possibly-saved view abandons the old operation and re-bases the draft', async () => {
    lookupSpy.mockResolvedValue(lookupOk({state: 'unknown'}))
    await unknownSave()
    getSpy.mockResolvedValue(ok(pageOf({body: 'newer text\n', pageBlobSha: 'blob-2'})))
    fireEvent.click(button('Check save status'))
    await flush()
    fireEvent.click(button('Overwrite with my draft'))
    fireEvent.click(button('Yes, overwrite'))
    await flush()

    expect(records()[0]?.pending).toBeNull()
    expect(records()[0]?.baseBlobSha).toBe('blob-2')
    expect(textbox()).not.toHaveAttribute('readonly')
  })

  it('checking again after an undecidable result asks the server again, once per click', async () => {
    lookupSpy.mockResolvedValue(lookupOk({state: 'unknown'}))
    await unknownSave()
    fireEvent.click(button('Check save status'))
    await flush()
    expect(lookupSpy).toHaveBeenCalledTimes(1)

    lookupSpy.mockResolvedValue(lookupOk({state: 'found', commitSha: 'c1', committedAt: null}))
    fireEvent.click(button('Check save status'))
    await flush()
    expect(lookupSpy).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-saved', 'saved-not-promoted')
  })

  it('a double click on Check save status asks once', async () => {
    let finish: (value: never) => void = () => {}
    lookupSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    await unknownSave()
    const check = button('Check save status')
    fireEvent.click(check)
    fireEvent.click(check)
    await flush()
    expect(lookupSpy).toHaveBeenCalledTimes(1)
    expect(button('Check save status')).toBeDisabled()
    expect(announcer()).toHaveTextContent('Checking the save status')

    await act(async () => {
      finish(lookupOk({state: 'missing'}))
    })
    await flush()
    expect(lookupSpy).toHaveBeenCalledTimes(1)
  })

  it('a rate-limited check stays unknown, says to wait, and keeps the pending operation', async () => {
    lookupSpy.mockResolvedValue(lookupFailure('rate-limited', {retryAfterSeconds: 20}))
    await unknownSave()
    fireEvent.click(button('Check save status'))
    await flush()

    expect(outcome()).toHaveAttribute('data-outcome', 'lookup-failed')
    expect(outcome()).toHaveTextContent('20 seconds')
    expect(button('Check save status')).toBeEnabled()
    expect(records()[0]?.pending).not.toBeNull()
  })

  it.each(['network', 'timeout', 'contract-drift'])('a %s failure on the check stays unknown and can be checked again', async kind => {
    lookupSpy.mockResolvedValue(lookupFailure(kind))
    await unknownSave()
    fireEvent.click(button('Check save status'))
    await flush()
    expect(outcome()).toHaveAttribute('data-outcome', 'lookup-failed')
    expect(button('Check save status')).toBeEnabled()
  })

  it('a lost session on the check offers sign-in', async () => {
    lookupSpy.mockResolvedValue(lookupFailure('session-lost'))
    await unknownSave()
    fireEvent.click(button('Check save status'))
    await flush()
    expect(within(outcome()).getByRole('link', {name: 'Sign in'})).toBeInTheDocument()
  })

  it('cancel while unknown asks keep or discard, and discarding forgets the unconfirmed save', async () => {
    await unknownSave()
    fireEvent.click(button('Cancel'))
    expect(screen.getByTestId('wiki-cancel-confirm')).toHaveTextContent(/unconfirmed/iu)
    fireEvent.click(button('Discard draft'))
    await flush()
    expect(records()).toHaveLength(0)
  })

  describe('when the pending operation could not be stored', () => {
    beforeEach(() => {
      store = createDraftStore({indexedDB: undefined, now: () => NOW})
    })

    it('says resolution works only until the page is left, and still resolves in the session', async () => {
      lookupSpy.mockResolvedValue(lookupOk({state: 'found', commitSha: 'c1', committedAt: COMMIT.committedAt}))
      await unknownSave()

      expect(outcome()).toHaveTextContent(/only until you leave or reload/iu)
      expect(guardedWikiPageId()).toBe(PAGE_ID)

      fireEvent.click(button('Check save status'))
      await flush()
      expect(lookupSpy).toHaveBeenCalledWith({operationId: 'op-1', pageId: PAGE_ID, startedAt: NOW})
      expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-saved', 'saved-not-promoted')
    })

    it('a missing commit restores the in-memory draft', async () => {
      await unknownSave()
      fireEvent.click(button('Check save status'))
      await flush()
      expect(textbox().value).toBe(EDITED)
      expect(button('Save again')).toBeEnabled()
    })
  })
})

describe('reopening a page with a pending operation', () => {
  it('looks the operation up once on open without a click, and shows the commit as done', async () => {
    await store.putDraft(pendingDraft())
    lookupSpy.mockResolvedValue(lookupOk({state: 'found', commitSha: 'c1', committedAt: COMMIT.committedAt}))
    await renderPage()

    expect(lookupSpy).toHaveBeenCalledTimes(1)
    expect(lookupSpy).toHaveBeenCalledWith({operationId: 'op-9', pageId: PAGE_ID, startedAt: NOW - 5_000})
    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-saved', 'saved-not-promoted')
    expect(records()).toHaveLength(0)
  })

  it('shows Save status unknown while the lookup runs', async () => {
    await store.putDraft(pendingDraft())
    let finish: (value: never) => void = () => {}
    lookupSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    await renderPage()

    expect(outcome()).toHaveAttribute('data-outcome', 'status-unknown')
    expect(button('Check save status')).toBeDisabled()
    expect(announcer()).toHaveTextContent('Checking the save status')
    await act(async () => {
      finish(lookupOk({state: 'missing'}))
    })
    await flush()
  })

  it('a missing commit restores the draft with Save again', async () => {
    await store.putDraft(pendingDraft())
    lookupSpy.mockResolvedValue(lookupOk({state: 'missing'}))
    await renderPage()

    expect(textbox().value).toBe(EDITED)
    expect(button('Save again')).toBeEnabled()
    expect(records()[0]?.pending).toBeNull()
  })

  it('a pending operation still marked sending (the tab died mid-send) is looked up too', async () => {
    await store.putDraft(pendingDraft({pending: {operationId: 'op-9', sentAt: NOW - 5_000, bodyChanged: true, state: 'sending'}}))
    await renderPage()
    expect(lookupSpy).toHaveBeenCalledTimes(1)
  })

  it('an undecidable lookup on open shows the conflict view', async () => {
    await store.putDraft(pendingDraft())
    lookupSpy.mockResolvedValue(lookupOk({state: 'unknown'}))
    getSpy.mockResolvedValue(ok(pageOf({pageBlobSha: 'blob-2', body: 'newer\n'})))
    await renderPage()
    expect(screen.getByTestId('wiki-conflict')).toHaveAttribute('data-conflict-kind', 'possibly-saved')
  })

  it('a failed lookup on open stays unknown and does not repeat on its own', async () => {
    vi.useFakeTimers()
    await store.putDraft(pendingDraft())
    lookupSpy.mockResolvedValue(lookupFailure('network'))
    await renderPage()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROMOTION_POLL_INTERVAL_MS * 10)
    })
    expect(lookupSpy).toHaveBeenCalledTimes(1)
    expect(button('Check save status')).toBeEnabled()
  })

  it('does not look anything up when the draft has no pending operation', async () => {
    await store.putDraft(pendingDraft({pending: null}))
    await renderPage()
    expect(lookupSpy).not.toHaveBeenCalled()
  })

  it('does not look anything up in a read-only session', async () => {
    await store.putDraft(pendingDraft())
    getSpy.mockResolvedValue(ok(pageOf({canWrite: false, canWriteReason: 'not-operator'})))
    await renderPage()
    expect(lookupSpy).not.toHaveBeenCalled()
  })
})

describe('saved, not promoted — retry dispatch', () => {
  beforeEach(() => {
    saveSpy.mockResolvedValue(ok({state: 'saved-not-promoted', ...COMMIT}))
  })

  it('shows "Saved, not promoted" with Retry dispatch and clears the draft', async () => {
    await renderPage()
    await editAndSave()

    const panel = screen.getByTestId('wiki-saved')
    expect(panel).toHaveAttribute('data-saved', 'saved-not-promoted')
    expect(panel).toHaveTextContent('Saved, not promoted')
    expect(within(panel).getByRole('button', {name: 'Retry dispatch'})).toBeEnabled()
    expect(records()).toHaveLength(0)
  })

  it('does not poll promotion status until the dispatch is retried', async () => {
    vi.useFakeTimers()
    await renderPage()
    await editAndSave()
    statusSpy.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROMOTION_POLL_INTERVAL_MS * 3)
    })
    expect(statusSpy).not.toHaveBeenCalled()
  })

  it('retry sends no new commit, moves to pending, and starts reading promotion status', async () => {
    await renderPage()
    await editAndSave()
    statusSpy.mockClear()
    statusSpy.mockResolvedValue(ok({state: 'pending', pr: PR}))

    fireEvent.click(button('Retry dispatch'))
    await flush()
    await macrotask()

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy).toHaveBeenCalledTimes(1)
    const panel = screen.getByTestId('wiki-saved')
    expect(panel).toHaveAttribute('data-saved', 'saved')
    expect(panel).toHaveTextContent('Saved, pending publication')
    expect(statusSpy).toHaveBeenCalledWith(COMMIT.committedAt)
    expect(within(panel).getByRole('link', {name: 'View the pull request'})).toHaveAttribute('href', PR.url)
  })

  it('a retry that fails says so and leaves the retry available', async () => {
    dispatchSpy.mockResolvedValue({ok: false, error: {kind: 'dispatch-failed'}} as never)
    await renderPage()
    await editAndSave()
    fireEvent.click(button('Retry dispatch'))
    await flush()

    expect(screen.getByTestId('wiki-dispatch-failed')).toHaveAttribute('role', 'status')
    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-saved', 'saved-not-promoted')
    expect(button('Retry dispatch')).toBeEnabled()
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('disables Retry dispatch while it is sending and sends once', async () => {
    let finish: (value: never) => void = () => {}
    dispatchSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    await renderPage()
    await editAndSave()
    const retry = button('Retry dispatch')
    fireEvent.click(retry)
    fireEvent.click(retry)
    await flush()
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', {name: 'Sending…'})).toBeDisabled()

    await act(async () => {
      finish(ok({state: 'dispatched'}) as never)
    })
    await flush()
  })

  it('a late answer from the dispatch after the page is closed changes nothing', async () => {
    let finish: (value: never) => void = () => {}
    dispatchSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    const view = await renderPage()
    await editAndSave()
    fireEvent.click(button('Retry dispatch'))
    await flush()
    view.unmount()
    await act(async () => {
      finish(ok({state: 'dispatched'}) as never)
    })
    expect(screen.queryByTestId('wiki-saved')).toBeNull()
  })
})

describe('promotion status after a save', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    statusSpy.mockResolvedValue(ok({state: 'pending', pr: null}))
  })

  async function editAndSaveFake() {
    await renderPage()
    fireEvent.click(button('Edit'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    type(EDITED)
    statusSpy.mockClear()
    clickSave()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('reads once straight after the save, with the commit time as `since`', async () => {
    await editAndSaveFake()
    expect(statusSpy).toHaveBeenCalledTimes(1)
    expect(statusSpy).toHaveBeenCalledWith(COMMIT.committedAt)
  })

  it('does not read again before the polling interval, then reads again while pending', async () => {
    await editAndSaveFake()
    await tick(PROMOTION_POLL_INTERVAL_MS - 1)
    expect(statusSpy).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(statusSpy).toHaveBeenCalledTimes(2)
    await tick(PROMOTION_POLL_INTERVAL_MS)
    expect(statusSpy).toHaveBeenCalledTimes(3)
  })

  it('stops reading when the state settles, and says the change is published', async () => {
    await editAndSaveFake()
    statusSpy.mockResolvedValue(ok({state: 'settled', pr: PR}))
    await tick(PROMOTION_POLL_INTERVAL_MS)
    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-promotion', 'settled')
    const reads = statusSpy.mock.calls.length
    await tick(PROMOTION_POLL_INTERVAL_MS * 5)
    expect(statusSpy).toHaveBeenCalledTimes(reads)
  })

  it('stops reading while the tab is hidden', async () => {
    await editAndSaveFake()
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'})
    document.dispatchEvent(new Event('visibilitychange'))
    const reads = statusSpy.mock.calls.length
    await tick(PROMOTION_POLL_INTERVAL_MS * 5)
    expect(statusSpy).toHaveBeenCalledTimes(reads)
    Reflect.deleteProperty(document, 'visibilityState')
  })

  it('a blocked promotion shows the reason and the run link, and stops reading', async () => {
    await editAndSaveFake()
    statusSpy.mockResolvedValue(
      ok({state: 'blocked', reason: 'private-repo-name', runUrl: 'https://github.com/fro-bot/.github/actions/runs/77', pr: PR}),
    )
    await tick(PROMOTION_POLL_INTERVAL_MS)

    const panel = screen.getByTestId('wiki-saved')
    expect(panel).toHaveAttribute('data-promotion', 'blocked')
    expect(panel).toHaveAttribute('role', 'alert')
    expect(panel).toHaveTextContent('A private repository name appears in the change set.')
    expect(within(panel).getByRole('link', {name: 'View the blocked run'})).toHaveAttribute(
      'href',
      'https://github.com/fro-bot/.github/actions/runs/77',
    )
    expect(panel).toHaveTextContent(/edit and save again/iu)
    const reads = statusSpy.mock.calls.length
    await tick(PROMOTION_POLL_INTERVAL_MS * 5)
    expect(statusSpy).toHaveBeenCalledTimes(reads)
  })

  it('editing and saving again re-evaluates a blocked promotion', async () => {
    await editAndSaveFake()
    statusSpy.mockResolvedValue(
      ok({state: 'blocked', reason: 'privacy-check', runUrl: 'https://github.com/fro-bot/.github/actions/runs/77', pr: null}),
    )
    await tick(PROMOTION_POLL_INTERVAL_MS)
    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-promotion', 'blocked')

    fireEvent.click(button('Edit'))
    await tick(0)
    type(`${EDITED}Fixed.\n`)
    statusSpy.mockResolvedValue(ok({state: 'pending', pr: PR}))
    saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-2', committedAt: '2026-10-21T11:00:00Z'}))
    clickSave()
    await tick(0)
    await tick(0)

    expect(statusSpy).toHaveBeenLastCalledWith('2026-10-21T11:00:00Z')
    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-promotion', 'pending')
  })

  it('a status read that fails is a note, and the save still shows as saved', async () => {
    await editAndSaveFake()
    statusSpy.mockResolvedValue({ok: false, error: {kind: 'unavailable'}} as never)
    await tick(PROMOTION_POLL_INTERVAL_MS)
    expect(screen.getByTestId('wiki-saved-unavailable')).toBeInTheDocument()
    expect(screen.getByTestId('wiki-saved')).toHaveTextContent('Saved, pending publication')
  })

  it('never reads a lookup while polling', async () => {
    await editAndSaveFake()
    await tick(PROMOTION_POLL_INTERVAL_MS * 4)
    expect(lookupSpy).not.toHaveBeenCalled()
  })
})

describe('save — a late response for an operation that is no longer current', () => {
  it('is ignored once the editor has gone away, and the pending operation stays for the next open', async () => {
    let finish: (value: never) => void = () => {}
    saveSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    const view = await renderPage()
    await editAndSave()
    view.unmount()

    await act(async () => {
      finish(ok({state: 'saved', ...COMMIT}) as never)
    })
    await flush()

    expect(screen.queryByTestId('wiki-saved')).toBeNull()
    expect(records()).toHaveLength(1)
    expect(records()[0]?.pending).toMatchObject({operationId: 'op-1'})
    expect(guardedWikiPageId()).toBeNull()
  })

  it('does not change the page that replaced it', async () => {
    let finish: (value: never) => void = () => {}
    saveSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    const view = await renderPage()
    await editAndSave()

    getSpy.mockResolvedValue(ok(pageOf({id: 'topics.beta', type: 'topics', title: 'Beta'})))
    view.rerender(<WikiEditor pageId="topics.beta" onBackToList={vi.fn()} draftStore={store} />)
    await flush()

    await act(async () => {
      finish(saveFailure({kind: 'rejected', reason: 'gate', findings: [{kind: 'gate', path: 'p', message: 'late finding'}]}))
    })
    await flush()

    expect(screen.getByRole('heading', {level: 2, name: 'Beta'})).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-outcome')).toBeNull()
    expect(screen.queryByText('late finding')).toBeNull()
  })
})

describe('save — with the keep or discard question open', () => {
  function deferredSave() {
    let finish: (value: never) => void = () => {}
    saveSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    return (value: unknown) =>
      act(async () => {
        finish(value as never)
      })
  }

  it('Save closes the question, so Keep draft cannot erase the pending operation mid-send', async () => {
    const answer = deferredSave()
    await renderPage()
    await startEditing()
    fireEvent.click(button('Cancel'))
    expect(screen.getByTestId('wiki-cancel-confirm')).toBeInTheDocument()

    clickSave()
    await flush()

    expect(screen.getByTestId('wiki-editor')).toHaveAttribute('data-phase', 'saving')
    expect(screen.queryByTestId('wiki-cancel-confirm')).toBeNull()
    expect(queryButton('Keep draft')).toBeNull()
    expect(queryButton('Discard draft')).toBeNull()

    await answer(saveFailure({kind: 'status-unknown', cause: 'timeout'}))
    await flush()

    expect(outcome()).toHaveAttribute('data-outcome', 'status-unknown')
    expect(records()[0]?.pending).toMatchObject({operationId: 'op-1', state: 'unknown'})
  })

  it('Keep draft and Discard draft wait while a status check is running, and nothing is deleted', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'status-unknown', cause: 'timeout'}))
    let finish: (value: never) => void = () => {}
    lookupSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    await renderPage()
    await editAndSave()
    fireEvent.click(button('Cancel'))
    fireEvent.click(button('Check save status'))
    await flush()

    expect(screen.getByTestId('wiki-editor')).toHaveAttribute('data-phase', 'checking')
    expect(button('Keep draft')).toBeDisabled()
    expect(button('Discard draft')).toBeDisabled()
    fireEvent.click(button('Discard draft'))
    await flush()
    expect(records()).toHaveLength(1)
    expect(records()[0]?.pending).toMatchObject({operationId: 'op-1'})

    await act(async () => {
      finish(lookupOk({state: 'missing'}))
    })
    await flush()

    expect(screen.getByTestId('wiki-editor')).toHaveAttribute('data-phase', 'idle')
    expect(button('Keep draft')).toBeEnabled()
    expect(button('Discard draft')).toBeEnabled()
    expect(textbox()).not.toHaveAttribute('readonly')
  })
})

describe('save — a draft another tab stored meanwhile', () => {
  const draftOf = (overrides: Partial<DraftInput> = {}) =>
    pendingDraft({pending: null, draftText: 'the other tab’s words', ...overrides})

  it('a successful save leaves the other tab’s draft in place', async () => {
    let finish: (value: never) => void = () => {}
    saveSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    await renderPage()
    await editAndSave()
    await store.putDraft(draftOf())

    await act(async () => {
      finish(ok({state: 'saved', ...COMMIT}) as never)
    })
    await flush()

    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-saved', 'saved')
    expect(records()).toHaveLength(1)
    expect(records()[0]?.draftText).toBe('the other tab’s words')
  })

  it('a successful save deletes a record with the same base and text, even if the pending operation was replaced', async () => {
    let finish: (value: never) => void = () => {}
    saveSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    await renderPage()
    await editAndSave()
    await store.putDraft(draftOf({draftText: EDITED}))

    await act(async () => {
      finish(ok({state: 'saved', ...COMMIT}) as never)
    })
    await flush()

    expect(records()).toHaveLength(0)
  })

  it('a successful save still deletes its own record', async () => {
    await renderPage()
    await editAndSave()
    expect(records()).toHaveLength(0)
  })

  it('a save found late by the check leaves the other tab’s draft in place', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'status-unknown', cause: 'timeout'}))
    lookupSpy.mockResolvedValue(lookupOk({state: 'found', commitSha: 'c1', committedAt: COMMIT.committedAt}))
    await renderPage()
    await editAndSave()
    await store.putDraft(draftOf())

    fireEvent.click(button('Check save status'))
    await flush()

    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-saved', 'saved-not-promoted')
    expect(records()).toHaveLength(1)
    expect(records()[0]?.draftText).toBe('the other tab’s words')
  })
})

describe('save — a draft record that cannot be read', () => {
  beforeEach(() => {
    idb.plant({pageId: PAGE_ID, schemaVersion: 99})
  })

  it('does not block Save: the request goes out and the record is replaced, then removed by the save', async () => {
    await renderPage()
    await startEditing()
    clickSave()
    await flush()

    expect(queryButton('Save again')).toBeNull()
    expect(screen.queryByText('Save not sent')).toBeNull()
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-saved', 'saved')
    expect(records()).toHaveLength(0)
  })

  it('keeps a valid record with the pending operation when the outcome is unknown', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'status-unknown', cause: 'timeout'}))
    await renderPage()
    await editAndSave()

    expect(records()).toHaveLength(1)
    expect(records()[0]).toMatchObject({draftText: EDITED, pending: {operationId: 'op-1', state: 'unknown'}})
  })
})

describe('save — overwrite from the possibly-saved view', () => {
  it('leaves no marker behind when the draft becomes the page body', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'status-unknown', cause: 'timeout'}))
    lookupSpy.mockResolvedValue(lookupOk({state: 'unknown'}))
    await renderPage()
    await editAndSave()
    expect(records()[0]?.pending).toMatchObject({operationId: 'op-1', state: 'unknown'})

    // The page now holds exactly the draft text, so the re-based draft equals its base.
    getSpy.mockResolvedValue(ok(pageOf({body: EDITED, pageBlobSha: 'blob-2'})))
    fireEvent.click(button('Check save status'))
    await flush()
    fireEvent.click(button('Overwrite with my draft'))
    fireEvent.click(button('Yes, overwrite'))
    await flush()

    expect(records()).toHaveLength(0)
    expect(guardedWikiPageId()).toBeNull()
  })
})

describe('check save status — a send time a Date cannot hold', () => {
  it('shows the saved panel for a found save with no commit time, and does not reject', async () => {
    // Only a store that cannot hold the record keeps the in-memory time, and a clock far out of range gives one.
    store = createDraftStore({indexedDB: undefined, now: () => 1e16})
    saveSpy.mockResolvedValue(saveFailure({kind: 'status-unknown', cause: 'timeout'}))
    lookupSpy.mockResolvedValue(lookupOk({state: 'found', commitSha: 'c1', committedAt: null}))
    await renderPage()
    await editAndSave()

    fireEvent.click(button('Check save status'))
    await flush()

    expect(lookupSpy).toHaveBeenCalledWith({operationId: 'op-1', pageId: PAGE_ID, startedAt: 1e16})
    const panel = screen.getByTestId('wiki-saved')
    expect(panel).toHaveAttribute('data-saved', 'saved-not-promoted')
    expect(within(panel).getByRole('button', {name: 'Retry dispatch'})).toBeEnabled()

    // With no commit time there is no bound, so the status read is made without one.
    statusSpy.mockClear()
    fireEvent.click(within(panel).getByRole('button', {name: 'Retry dispatch'}))
    await flush()
    await macrotask()
    expect(statusSpy).toHaveBeenCalled()
    expect(statusSpy.mock.calls[0]).toEqual([undefined])
  })

  it('still bounds the status read by the send time when that time is a real date', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'status-unknown', cause: 'timeout'}))
    lookupSpy.mockResolvedValue(lookupOk({state: 'found', commitSha: 'c1', committedAt: null}))
    await renderPage()
    await editAndSave()

    fireEvent.click(button('Check save status'))
    await flush()
    statusSpy.mockClear()
    fireEvent.click(button('Retry dispatch'))
    await flush()
    await macrotask()

    expect(statusSpy.mock.calls[0]).toEqual([new Date(NOW).toISOString()])
  })
})
