/**
 * Resolving a page conflict by merge, the mark remap through it, and the removed-page variant (U13).
 */

import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
import * as wikiApi from '../api/wiki.ts'
import type {SaveInput, WikiCorrection, WikiPage} from '../api/wiki.ts'
import {createDraftStore, type DraftStore} from '../wiki/drafts.ts'
import {createMemoryIdb} from '../wiki/test-support/memory-idb.ts'
import {WikiEditor} from './WikiEditor.tsx'
import {WikiList} from './WikiList.tsx'

const PAGE_ID = 'repos.acme--alpha'
const BODY = '# acme/alpha\n\nIntro line.\n\nAlpha builds widgets.\n\nMiddle line.\n\nTail line.\n'
const NOW = 1_900_000_000_000
const COMMIT = {operationId: 'op-1', commitSha: 'c1', committedAt: '2026-10-21T10:00:00Z'}

const C1: WikiCorrection = {
  id: 'c1',
  status: 'active',
  span: {text: 'Alpha builds widgets'},
  attribution: null,
  reason: null,
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
    corrections: [C1],
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
const PAGE_CONFLICT = saveFailure({kind: 'conflict', conflict: {kind: 'page', currentBlobSha: 'blob-2'}})

let store: DraftStore
let idb: ReturnType<typeof createMemoryIdb>
let getSpy: MockInstance<typeof wikiApi.getWikiPage>
let saveSpy: MockInstance<typeof wikiApi.saveWikiPage>
let uuidCount = 0

beforeEach(() => {
  idb = createMemoryIdb()
  store = createDraftStore({indexedDB: idb.factory, now: () => NOW})
  getSpy = vi.spyOn(wikiApi, 'getWikiPage').mockResolvedValue(ok(pageOf()))
  vi.spyOn(wikiApi, 'promotionStatus').mockResolvedValue(ok({state: 'settled', pr: null}))
  saveSpy = vi.spyOn(wikiApi, 'saveWikiPage').mockResolvedValue(PAGE_CONFLICT)
  uuidCount = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation((() => {
    uuidCount += 1
    return `op-${String(uuidCount)}`
  }) as typeof crypto.randomUUID)
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sessionStorage.clear()
  Reflect.deleteProperty(navigator, 'clipboard')
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
const markItem = () => screen.getByTestId('wiki-mark-item')
const hunks = () => screen.queryAllByTestId('wiki-merge-hunk')

function type(value: string) {
  fireEvent.change(textbox(), {target: {value}})
}

function selectText(quoted: string) {
  const area = textbox()
  const start = area.value.indexOf(quoted)
  if (start < 0) throw new Error(`test setup: ${JSON.stringify(quoted)} is not in the text`)
  area.focus()
  area.setSelectionRange(start, start + quoted.length)
  fireEvent.keyUp(area, {key: 'ArrowRight', shiftKey: true})
}

function markText(quoted: string) {
  selectText(quoted)
  fireEvent.click(button('Mark as correction'))
}

async function edit(text?: string) {
  fireEvent.click(button('Edit'))
  await flush()
  if (text !== undefined) type(text)
}

/** Click Save, and confirm when unmarked changes ask for it. */
async function save() {
  fireEvent.click(button('Save'))
  const confirm = queryButton('Confirm save')
  if (confirm !== null) fireEvent.click(confirm)
  await flush()
}

/** The page as the server holds it after someone else changed it. */
function pageChanged(body: string, overrides: Partial<WikiPage> = {}) {
  getSpy.mockResolvedValue(ok(pageOf({body, pageBlobSha: 'blob-2', correctionsBase: 'digest-2', ...overrides})))
}

function sentSave(call: number): SaveInput {
  const input = saveSpy.mock.calls[call]?.[0]
  if (input === undefined) throw new Error(`save ${String(call)} was never sent`)
  return input
}

interface StoredMark {
  text: string
  start: number
  end: number
  needsReview: boolean
}

function record() {
  const [stored] = idb.records() as {
    baseBlobSha: string
    baseText: string
    draftText: string
    correctionsBase: {digest: string; entries: {id: string}[]}
    marks: StoredMark[]
    pending: unknown
  }[]
  if (stored === undefined) throw new Error('no draft is stored')
  return stored
}

const useMerged = () => button('Use merged text')

function accept(index: number, choice: 'mine' | 'theirs') {
  fireEvent.click(within(hunks()[index] as HTMLElement).getByRole('button', {name: choice === 'mine' ? 'Accept mine' : 'Accept theirs'}))
}

// ---------------------------------------------------------------------------

describe('merge — changes that do not overlap', () => {
  const MINE = BODY.replace('Intro line.', 'Intro edited.')
  const THEIRS = BODY.replace('Tail line.', 'Tail rewritten.')
  const MERGED = MINE.replace('Tail line.', 'Tail rewritten.')

  async function conflicted() {
    await renderPage()
    await edit(MINE)
    markText('Alpha builds widgets')
    pageChanged(THEIRS)
    await save()
  }

  it('replaces the side by side view with the merge, which has nothing to resolve', async () => {
    await conflicted()

    const view = screen.getByTestId('wiki-conflict')
    expect(view).toHaveAttribute('data-conflict-kind', 'page')
    expect(screen.getByTestId('wiki-merge')).toHaveAttribute('data-hunks', '0')
    expect(hunks()).toHaveLength(0)
    expect(screen.queryByTestId('wiki-conflict-current')).toBeNull()
    expect(screen.queryByTestId('wiki-conflict-draft')).toBeNull()
    expect(useMerged()).toBeEnabled()
    expect(button('Overwrite with my draft')).toBeEnabled()
    expect(record().draftText).toBe(MINE)
  })

  it('applies in one step: the merged text is the draft and the base is the current blob and text', async () => {
    await conflicted()
    fireEvent.click(useMerged())
    await flush()

    expect(screen.queryByTestId('wiki-conflict')).toBeNull()
    expect(textbox().value).toBe(MERGED)
    expect(screen.getByTestId('wiki-draft-merged')).toHaveTextContent(/merged text/iu)
    expect(screen.getByTestId('wiki-draft-base')).toHaveTextContent('blob-2')

    expect(record().baseBlobSha).toBe('blob-2')
    expect(record().baseText).toBe(THEIRS)
    expect(record().draftText).toBe(MERGED)
    expect(record().correctionsBase.digest).toBe('digest-2')
    expect(record().pending).toBeNull()
  })

  it('keeps the mark on its text, verified at its new position', async () => {
    await conflicted()
    fireEvent.click(useMerged())
    await flush()

    expect(markItem()).toHaveAttribute('data-mark-state', 'ok')
    expect(screen.queryByTestId('wiki-merge-marks-review')).toBeNull()
    const start = MERGED.indexOf('Alpha builds widgets')
    expect(record().marks).toEqual([
      expect.objectContaining({text: 'Alpha builds widgets', start, end: start + 'Alpha builds widgets'.length, needsReview: false}),
    ])
  })

  it('saves against the current blob, and the promotion state shows as usual', async () => {
    await conflicted()
    fireEvent.click(useMerged())
    await flush()

    saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-2'}))
    await save()

    expect(saveSpy).toHaveBeenCalledTimes(2)
    const start = MERGED.indexOf('Alpha builds widgets')
    expect(sentSave(1)).toMatchObject({
      pageBlobSha: 'blob-2',
      correctionsBase: 'digest-2',
      body: MERGED,
      marks: [{text: 'Alpha builds widgets', start, end: start + 'Alpha builds widgets'.length}],
    })
    expect(screen.getByTestId('wiki-saved')).toHaveAttribute('data-saved', 'saved')
  })

  it('clears the unmarked-change confirmation, so the next save asks again', async () => {
    await conflicted()
    // The first save was confirmed. The merge changes the base, so that confirmation is gone.
    fireEvent.click(useMerged())
    await flush()

    fireEvent.click(button('Save'))
    expect(screen.getByTestId('wiki-unmarked-confirm')).toBeInTheDocument()
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })
})

describe('merge — pressing Use merged text twice', () => {
  it('applies once: a second press before the write settles changes nothing', async () => {
    const mine = BODY.replace('Intro line.', 'Intro edited line with more text.')
    const theirs = `Top.\n\n${BODY.replace('Tail line.', 'Tail rewritten.')}`
    const merged = `Top.\n\n${mine.replace('Tail line.', 'Tail rewritten.')}`
    await renderPage()
    await edit(mine)
    markText('Alpha builds widgets')
    pageChanged(theirs)
    await save()

    // The write of the merged draft is held until both presses are in.
    const put = store.putDraft.bind(store)
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const putSpy = vi.spyOn(store, 'putDraft').mockImplementation(async (...args) => {
      await held
      return put(...args)
    })

    fireEvent.click(useMerged())
    fireEvent.click(useMerged())
    await act(async () => {
      release()
    })
    await flush()

    expect(putSpy).toHaveBeenCalledTimes(1)
    expect(textbox().value).toBe(merged)
    expect(markItem()).toHaveAttribute('data-mark-state', 'ok')
    const start = merged.indexOf('Alpha builds widgets')
    expect(record().marks).toEqual([expect.objectContaining({start, end: start + 'Alpha builds widgets'.length, needsReview: false})])
  })
})

describe('merge — overlapping changes', () => {
  const MINE = BODY.replace('Intro line.', 'Intro mine.').replace('Middle line.', 'Middle mine.')
  const THEIRS = BODY.replace('Intro line.', 'Intro theirs.').replace('Middle line.', 'Middle theirs.')

  async function conflicted() {
    await renderPage()
    await edit(MINE)
    pageChanged(THEIRS)
    await save()
  }

  it('shows each overlapping change as a hunk with both versions and waits for each to be resolved', async () => {
    await conflicted()

    expect(screen.getByTestId('wiki-merge')).toHaveAttribute('data-hunks', '2')
    expect(hunks()).toHaveLength(2)
    expect(within(hunks()[0] as HTMLElement).getByTestId('wiki-merge-mine').textContent).toBe('Intro mine.\n')
    expect(within(hunks()[0] as HTMLElement).getByTestId('wiki-merge-theirs').textContent).toBe('Intro theirs.\n')
    expect(within(hunks()[1] as HTMLElement).getByRole('heading', {name: 'Change 2 of 2'})).toBeInTheDocument()
    expect(useMerged()).toBeDisabled()
  })

  it('resolves one as mine and one as theirs, announces each once, and uses the merged text', async () => {
    await conflicted()
    const status = screen.getByTestId('wiki-merge-status')

    accept(0, 'mine')
    expect(status).toHaveTextContent('Change 1 of 2: kept yours')
    expect(useMerged()).toBeDisabled()

    accept(1, 'theirs')
    expect(status).toHaveTextContent('Change 2 of 2: took theirs. All changes are resolved.')
    expect(useMerged()).toBeEnabled()

    fireEvent.click(useMerged())
    await flush()

    expect(textbox().value).toBe(BODY.replace('Intro line.', 'Intro mine.').replace('Middle line.', 'Middle theirs.'))
    expect(record().baseBlobSha).toBe('blob-2')
    expect(record().baseText).toBe(THEIRS)
  })

  it('resolves every change with the keyboard alone and never moves focus', async () => {
    await conflicted()
    const tabbable = () =>
      Array.from(screen.getByTestId('wiki-merge').querySelectorAll<HTMLButtonElement>('button')).filter(
        element => !element.disabled && element.tabIndex >= 0,
      )

    const first = within(hunks()[0] as HTMLElement).getByRole('button', {name: 'Accept theirs'})
    first.focus()
    for (const [index, choice] of (['Accept theirs', 'Accept mine'] as const).entries()) {
      const target = within(hunks()[index] as HTMLElement).getByRole('button', {name: choice})
      target.focus()
      // Enter and Space on a focused native button are a click on it.
      fireEvent.click(target)
      expect(document.activeElement).toBe(target)
    }
    expect(tabbable().map(element => element.textContent)).toEqual([
      'Accept mine',
      'Accept theirs',
      'Accept mine',
      'Accept theirs',
      'Use merged text',
    ])
    expect(screen.getAllByRole('status').filter(element => element.getAttribute('data-testid') === 'wiki-merge-status')).toHaveLength(1)
    expect(useMerged()).toBeEnabled()
  })

  it('still offers an explicit, confirmed overwrite', async () => {
    await conflicted()
    fireEvent.click(button('Overwrite with my draft'))
    expect(screen.getByTestId('wiki-overwrite-confirm')).toBeInTheDocument()
    fireEvent.click(button('Yes, overwrite'))
    await flush()
    expect(textbox().value).toBe(MINE)
    expect(record().baseBlobSha).toBe('blob-2')
  })

  it('keeps editing from the merge view leaves the draft as it was', async () => {
    await conflicted()
    accept(0, 'theirs')
    fireEvent.click(button('Keep editing'))
    expect(textbox().value).toBe(MINE)
    expect(record().baseBlobSha).toBe('blob-1')
  })
})

describe('merge — a draft that did not change the text', () => {
  const THEIRS = `New top line.\n\n${BODY.replace('Tail line.', 'Tail rewritten.')}`

  it('takes the current text wholesale and keeps a mark on text that is still there', async () => {
    await renderPage()
    await edit()
    markText('Alpha builds widgets')
    pageChanged(THEIRS)
    await save()

    expect(screen.getByTestId('wiki-merge')).toHaveAttribute('data-hunks', '0')
    fireEvent.click(useMerged())
    await flush()

    expect(textbox().value).toBe(THEIRS)
    expect(markItem()).toHaveAttribute('data-mark-state', 'ok')
    expect(record().marks[0]).toMatchObject({start: THEIRS.indexOf('Alpha builds widgets'), needsReview: false})
  })
})

describe('merge — marks that touch text from the current version', () => {
  it('flags a mark when upstream changed text inside it, and Save waits', async () => {
    await renderPage()
    await edit(BODY.replace('Intro line.', 'Intro edited.'))
    markText('builds widgets')
    pageChanged(BODY.replace('builds widgets', 'builds gadgets'))
    await save()
    fireEvent.click(useMerged())
    await flush()

    expect(textbox().value).toContain('builds gadgets')
    expect(markItem()).toHaveAttribute('data-mark-state', 'detached')
    expect(record().marks[0]).toMatchObject({text: 'builds widgets', needsReview: true})
    expect(screen.getByTestId('wiki-merge-marks-review')).toHaveTextContent(/one marked correction/iu)
    expect(button('Save')).toBeDisabled()
  })

  it('flags a mark when a change resolved as theirs removes its text', async () => {
    const mine = BODY.replace('Alpha builds widgets.', 'Alpha builds MY widgets.')
    await renderPage()
    await edit(mine)
    markText('MY widgets')
    pageChanged(BODY.replace('Alpha builds widgets.\n\n', ''))
    await save()

    expect(hunks()).toHaveLength(1)
    accept(0, 'theirs')
    fireEvent.click(useMerged())
    await flush()

    expect(textbox().value).not.toContain('MY widgets')
    expect(markItem()).toHaveAttribute('data-mark-state', 'detached')
    expect(record().marks[0]?.needsReview).toBe(true)
    expect(button('Save')).toBeDisabled()
  })

  it('keeps the mark when the same change is resolved as mine', async () => {
    const mine = BODY.replace('Alpha builds widgets.', 'Alpha builds MY widgets.')
    await renderPage()
    await edit(mine)
    markText('MY widgets')
    pageChanged(BODY.replace('Alpha builds widgets.\n\n', ''))
    await save()

    accept(0, 'mine')
    fireEvent.click(useMerged())
    await flush()

    expect(markItem()).toHaveAttribute('data-mark-state', 'ok')
    expect(record().marks[0]).toMatchObject({text: 'MY widgets', needsReview: false})
    expect(textbox().value.slice(record().marks[0]?.start, record().marks[0]?.end)).toBe('MY widgets')
  })

  it('leaves a mark the merge could not carry without a place, so it can only be removed', async () => {
    await renderPage()
    await edit(BODY.replace('Intro line.', 'Intro edited.'))
    markText('Alpha builds widgets')
    // Upstream rewrote the line but left the same words in another place.
    pageChanged(BODY.replace('Alpha builds widgets.', 'Alpha builds widgets, now rewritten.'))
    await save()
    fireEvent.click(useMerged())
    await flush()

    expect(record().marks[0]).toMatchObject({text: 'Alpha builds widgets', needsReview: true})
    expect(markItem()).toHaveAttribute('data-mark-state', 'detached')
    expect(within(markItem()).queryByRole('button', {name: 'Keep'})).toBeNull()
    expect(markItem()).toHaveTextContent(/moved or changed in the merge/iu)
    expect(button('Save')).toBeDisabled()

    fireEvent.click(within(markItem()).getByRole('button', {name: 'Remove'}))
    expect(screen.queryByTestId('wiki-mark-item')).toBeNull()
    expect(button('Save')).toBeEnabled()
  })
})

describe('merge — a flagged mark is never kept on another occurrence of its words', () => {
  const BASE_TEXT = 'Note: look at the plan.\nSee the plan again.\n'
  const MINE = 'Note: see the plan.\nSee the plan again.\n'
  const THEIRS = 'Note: read the spec.\nSee the plan again.\n'

  async function mergedAsTheirs() {
    getSpy.mockResolvedValue(ok(pageOf({body: BASE_TEXT})))
    await renderPage()
    await edit(MINE)
    markText('the plan')
    expect(textbox().value.indexOf('the plan')).toBe(10)
    pageChanged(THEIRS)
    await save()
    expect(hunks()).toHaveLength(1)
    accept(0, 'theirs')
    fireEvent.click(useMerged())
    await flush()
  }

  it('offers no Keep, offers Remove, and Save waits', async () => {
    await mergedAsTheirs()

    expect(textbox().value).toBe(THEIRS)
    expect(markItem()).toHaveAttribute('data-mark-state', 'detached')
    expect(within(markItem()).queryByRole('button', {name: 'Keep'})).toBeNull()
    expect(within(markItem()).getByRole('button', {name: 'Remove'})).toBeEnabled()
    expect(button('Save')).toBeDisabled()
    expect(screen.getByTestId('wiki-marks-blocking')).toBeInTheDocument()
  })

  it('sends no mark at the other occurrence once the mark is removed', async () => {
    await mergedAsTheirs()
    fireEvent.click(within(markItem()).getByRole('button', {name: 'Remove'}))
    // The text now equals the current page, so there is nothing to save until it changes.
    expect(button('Save')).toBeDisabled()
    type(`${THEIRS}more\n`)
    expect(button('Save')).toBeEnabled()

    saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-2'}))
    await save()

    expect(sentSave(1).marks).toEqual([])
    expect(sentSave(1).marks).not.toContainEqual(expect.objectContaining({start: 25, end: 33}))
  })

  it('keeps the mark unplaced through further typing', async () => {
    await mergedAsTheirs()
    type(`${THEIRS}more\n`)
    expect(markItem()).toHaveAttribute('data-mark-state', 'detached')
    expect(within(markItem()).queryByRole('button', {name: 'Keep'})).toBeNull()
    expect(button('Save')).toBeDisabled()
  })

  it('carries a mark on text the draft kept, and it stays settled', async () => {
    getSpy.mockResolvedValue(ok(pageOf({body: BASE_TEXT})))
    await renderPage()
    await edit(MINE)
    markText('the plan')
    pageChanged(`${BASE_TEXT}Tail.\n`)
    await save()
    fireEvent.click(useMerged())
    await flush()
    expect(markItem()).toHaveAttribute('data-mark-state', 'ok')
  })
})

describe('merge — corrections', () => {
  it('drops a staged retire whose correction changed upstream, with a notice', async () => {
    await renderPage()
    await edit(BODY.replace('Intro line.', 'Intro edited.'))
    fireEvent.click(within(screen.getByTestId('wiki-corrections').querySelector('[data-correction-id="c1"]') as HTMLElement).getByRole('button', {name: 'Retire'}))
    pageChanged(BODY.replace('Tail line.', 'Tail rewritten.'), {corrections: [{...C1, status: 'retired'}]})
    await save()

    fireEvent.click(useMerged())
    await flush()

    expect(screen.getByTestId('wiki-staged-dropped')).toBeInTheDocument()
    expect(record().correctionsBase.digest).toBe('digest-2')
    expect(screen.getByTestId('wiki-corrections').querySelector('[data-correction-id="c1"]')).toHaveAttribute('data-status', 'retired')
  })

  it('keeps the corrections conflict view for a corrections change', async () => {
    saveSpy.mockResolvedValue(
      saveFailure({
        kind: 'conflict',
        conflict: {kind: 'corrections', currentCorrections: [C1], correctionsBase: 'digest-2'},
      }),
    )
    await renderPage()
    await edit(BODY.replace('Intro line.', 'Intro edited.'))
    pageChanged(BODY, {corrections: [C1]})
    await save()

    expect(screen.getByTestId('wiki-conflict')).toHaveAttribute('data-conflict-kind', 'corrections')
    expect(screen.queryByTestId('wiki-merge')).toBeNull()
    expect(screen.getByTestId('wiki-conflict-corrections')).toBeInTheDocument()
  })
})

describe('merge — a second conflict after a merge', () => {
  it('restarts the merge from the latest base', async () => {
    const mine = BODY.replace('Intro line.', 'Intro edited.')
    const first = BODY.replace('Tail line.', 'Tail one.')
    await renderPage()
    await edit(mine)
    pageChanged(first)
    await save()
    fireEvent.click(useMerged())
    await flush()
    expect(record().baseBlobSha).toBe('blob-2')
    expect(record().baseText).toBe(first)

    // The page moves again, and the save against blob-2 conflicts again.
    const second = first.replace('Intro line.', 'Intro theirs.')
    getSpy.mockResolvedValue(ok(pageOf({body: second, pageBlobSha: 'blob-3', correctionsBase: 'digest-3'})))
    saveSpy.mockResolvedValue(saveFailure({kind: 'conflict', conflict: {kind: 'page', currentBlobSha: 'blob-3'}}))
    await save()

    expect(sentSave(1).pageBlobSha).toBe('blob-2')
    expect(screen.getByTestId('wiki-merge')).toHaveAttribute('data-hunks', '1')
    const hunk = hunks()[0] as HTMLElement
    expect(within(hunk).getByTestId('wiki-merge-mine').textContent).toBe('Intro edited.\n')
    expect(within(hunk).getByTestId('wiki-merge-theirs').textContent).toBe('Intro theirs.\n')
    expect(within(hunk).queryByText('Intro line.')).toBeNull()

    accept(0, 'mine')
    fireEvent.click(useMerged())
    await flush()
    expect(textbox().value).toBe(second.replace('Intro theirs.', 'Intro edited.'))
    expect(record().baseBlobSha).toBe('blob-3')
    expect(record().baseText).toBe(second)

    saveSpy.mockResolvedValue(ok({state: 'saved', ...COMMIT, operationId: 'op-3'}))
    await save()
    expect(sentSave(2).pageBlobSha).toBe('blob-3')
    expect(screen.getByTestId('wiki-saved')).toBeInTheDocument()
  })

  it('takes the new page wholesale when the draft then equals it, leaving nothing to save', async () => {
    await renderPage()
    await edit(BODY.replace('Intro line.', 'Intro edited.'))
    pageChanged(BODY.replace('Intro line.', 'Intro theirs.'))
    await save()
    accept(0, 'theirs')
    fireEvent.click(useMerged())
    await flush()
    expect(textbox().value).toBe(BODY.replace('Intro line.', 'Intro theirs.'))
    expect(button('Save')).toBeDisabled()
  })
})

describe('the page-removed variant', () => {
  const REMOVED = saveFailure({kind: 'conflict', conflict: {kind: 'page-removed'}})
  const EDITED = BODY.replace('Intro line.', 'Intro edited.')

  async function removed() {
    saveSpy.mockResolvedValue(REMOVED)
    await renderPage()
    await edit(EDITED)
    await save()
  }

  it('says the page no longer exists, keeps the draft, keeps Save disabled and offers copy-out', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}})
    await removed()

    const outcome = screen.getByTestId('wiki-outcome')
    expect(outcome).toHaveAttribute('data-outcome', 'conflict-page-removed')
    expect(outcome).toHaveAttribute('role', 'alert')
    expect(outcome).toHaveTextContent(/no longer in the wiki/iu)
    expect(screen.queryByTestId('wiki-merge')).toBeNull()
    expect(button('Save')).toBeDisabled()
    expect(textbox().value).toBe(EDITED)
    expect(record().draftText).toBe(EDITED)

    // More typing does not bring Save back.
    type(`${EDITED}more\n`)
    expect(button('Save')).toBeDisabled()
    fireEvent.click(button('Copy draft'))
    await flush()
    expect(writeText).toHaveBeenCalledWith(`${EDITED}more\n`)
    expect(screen.getByTestId('wiki-copy-status')).toHaveTextContent('Draft copied.')
  })

  it('leaves the draft in the orphaned-draft list until the operator discards it', async () => {
    await removed()
    cleanup()

    // The wiki no longer lists the page.
    vi.spyOn(wikiApi, 'listWikiPages').mockResolvedValue(ok({headSha: 'commit-2', pages: [], canWrite: true, canWriteReason: null}))
    render(<WikiList onOpenPage={vi.fn()} draftStore={store} />)
    await flush()
    const section = screen.getByTestId('wiki-orphaned-drafts')
    expect(within(section).getAllByRole('listitem')).toHaveLength(1)
    expect(section).toHaveTextContent(PAGE_ID)

    // Opening it shows the draft read-only. It stays until discarded.
    cleanup()
    getSpy.mockResolvedValue({ok: false, error: {kind: 'not-found'}} as never)
    await renderPage()
    expect(screen.getByTestId('wiki-orphaned-draft-text').textContent).toBe(EDITED)
    expect((idb.records() as unknown[]).length).toBe(1)

    fireEvent.click(button('Discard draft'))
    fireEvent.click(within(screen.getByTestId('wiki-orphaned-draft-confirm')).getByRole('button', {name: 'Discard draft'}))
    await flush()
    expect((idb.records() as unknown[]).length).toBe(0)

    cleanup()
    render(<WikiList onOpenPage={vi.fn()} draftStore={store} />)
    await flush()
    expect(screen.queryByTestId('wiki-orphaned-drafts')).toBeNull()
  })
})
