/**
 * Span marking, the corrections panel with staged actions, and the detection of marked spans (U12).
 */

import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
import * as wikiApi from '../api/wiki.ts'
import type {SaveInput, WikiCorrection, WikiPage} from '../api/wiki.ts'
import {createDraftStore, type DraftInput, type DraftStore} from '../wiki/drafts.ts'
import type {Mark} from '../wiki/marks.ts'
import {MAX_STAGED} from '../wiki/staged.ts'
import {MAX_DIFF_AREA} from '../wiki/unmarked.ts'
import {createMemoryIdb} from '../wiki/test-support/memory-idb.ts'
import {WikiEditor} from './WikiEditor.tsx'

const PAGE_ID = 'repos.acme--alpha'
const BODY = '\n# acme/alpha\n\nAlpha builds widgets.\n'
const GADGETS = BODY.replace('widgets', 'gadgets')
const COMMIT = {operationId: 'op-1', commitSha: 'c1', committedAt: '2026-10-21T10:00:00Z'}

function correction(id: string, overrides: Partial<WikiCorrection> = {}): WikiCorrection {
  return {
    id,
    status: 'active',
    span: {text: `span of ${id}`},
    attribution: null,
    reason: null,
    supersededBy: null,
    stale: false,
    ...overrides,
  }
}

const C1 = correction('c1', {span: {text: 'Alpha builds widgets'}})

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
const markButton = () => button('Mark as correction')
const panel = () => screen.getByTestId('wiki-corrections')
const correctionItem = (id: string) => {
  const found = panel().querySelector<HTMLElement>(`[data-correction-id="${id}"]`)
  if (found === null) throw new Error(`no correction ${id} in the panel`)
  return found
}

function type(value: string) {
  fireEvent.change(textbox(), {target: {value}})
}

/** Select by keyboard: set the range and let the keyup say so. */
function select(start: number, end: number) {
  const area = textbox()
  area.focus()
  area.setSelectionRange(start, end)
  fireEvent.keyUp(area, {key: 'ArrowRight', shiftKey: true})
}

function selectText(quoted: string) {
  const start = textbox().value.indexOf(quoted)
  if (start < 0) throw new Error(`test setup: ${JSON.stringify(quoted)} is not in the text`)
  select(start, start + quoted.length)
}

async function edit(text?: string) {
  fireEvent.click(button('Edit'))
  await flush()
  if (text !== undefined) type(text)
}

function sentSave(call = 0): SaveInput {
  const input = saveSpy.mock.calls[call]?.[0]
  if (input === undefined) throw new Error(`save ${call} was never sent`)
  return input
}

const confirmation = () => screen.queryByTestId('wiki-unmarked-confirm')

// ---------------------------------------------------------------------------
// The Mark as correction button
// ---------------------------------------------------------------------------

describe('the Mark as correction button', () => {
  it('is visible while editing, and disabled while nothing is selected', async () => {
    await renderPage()
    await edit()
    expect(markButton()).toBeDisabled()
  })

  it('is not offered before editing starts', async () => {
    await renderPage()
    expect(queryButton('Mark as correction')).toBeNull()
  })

  it('is enabled by a selection made from the keyboard', async () => {
    await renderPage()
    await edit()
    select(18, 24)
    expect(markButton()).toBeEnabled()
  })

  it('is enabled by a selection made by pointer or touch, and disabled again when it collapses', async () => {
    await renderPage()
    await edit()
    const area = textbox()
    area.setSelectionRange(18, 24)
    fireEvent.mouseUp(area)
    expect(markButton()).toBeEnabled()

    area.setSelectionRange(24, 24)
    fireEvent.touchEnd(area)
    expect(markButton()).toBeDisabled()

    area.setSelectionRange(18, 24)
    fireEvent.touchEnd(area)
    expect(markButton()).toBeEnabled()
  })

  it('is disabled again when the selection collapses from the keyboard', async () => {
    await renderPage()
    await edit()
    select(18, 24)
    select(24, 24)
    expect(markButton()).toBeDisabled()
  })

  it('stays disabled for a page that cannot be marked, with the stronger notice', async () => {
    getSpy.mockResolvedValue(ok(pageOf(UNMARKABLE)))
    await renderPage()
    await edit()
    select(18, 24)

    expect(markButton()).toBeDisabled()
    expect(screen.getByTestId('wiki-unmarked-notice')).toHaveAttribute('data-notice', 'no-node-id')
    expect(screen.getByTestId('wiki-unmarked-notice')).toHaveTextContent(/do not survive regeneration/iu)
  })

  it('stays disabled when the page has a node_id but cannot be marked', async () => {
    getSpy.mockResolvedValue(ok(pageOf({canMark: false})))
    await renderPage()
    await edit()
    select(18, 24)
    expect(markButton()).toBeDisabled()
  })

  it('stays disabled when the page can be marked by type but has no node_id', async () => {
    getSpy.mockResolvedValue(ok(pageOf({nodeId: null})))
    await renderPage()
    await edit()
    select(18, 24)
    expect(markButton()).toBeDisabled()
  })

  it('says that only marked corrections survive regeneration, and how to mark', async () => {
    await renderPage()
    await edit()
    const notice = screen.getByTestId('wiki-unmarked-notice')
    expect(notice).toHaveTextContent(/only marked corrections survive the next regeneration/iu)
    expect(notice).toHaveTextContent(/mark as correction/iu)
    expect(notice).not.toHaveTextContent(/not available yet/iu)
  })
})

// ---------------------------------------------------------------------------
// Marking a span
// ---------------------------------------------------------------------------

describe('marking a span', () => {
  it('marks the selection, saves, and sends the span text with its offsets', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())

    const start = GADGETS.indexOf('gadgets')
    expect(screen.getByTestId('wiki-mark-item')).toHaveTextContent('gadgets')

    fireEvent.click(button('Save'))
    await flush()

    expect(confirmation()).toBeNull()
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(sentSave()).toMatchObject({
      pageId: PAGE_ID,
      pageBlobSha: 'blob-1',
      body: GADGETS,
      marks: [{text: 'gadgets', start, end: start + 7}],
      transitions: [],
    })
  })

  it('shows the new correction as active in the panel after the save', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())

    getSpy.mockResolvedValue(
      ok(
        pageOf({
          body: GADGETS,
          pageBlobSha: 'blob-2',
          corrections: [C1, correction('c2', {span: {text: 'gadgets', start: 20, end: 27}})],
          correctionsBase: 'digest-2',
        }),
      ),
    )
    fireEvent.click(button('Save'))
    await flush()

    expect(screen.getByTestId('wiki-saved')).toBeInTheDocument()
    expect(correctionItem('c2')).toHaveAttribute('data-status', 'active')
    expect(correctionItem('c2')).toHaveTextContent('gadgets')
  })

  it('keeps the exact text and the UTF-16 offsets of a span with emoji and combining characters', async () => {
    const base = 'Note: cafe\u0301 is open.\n'
    const draft = 'Note: cafe\u0301 \u{1F44D}\u{1F3FD} is open.\n'
    getSpy.mockResolvedValue(ok(pageOf({body: base, corrections: []})))
    await renderPage()
    await edit(draft)

    const marked = ' \u{1F44D}\u{1F3FD} '
    selectText(marked)
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))
    await flush()

    expect(confirmation()).toBeNull()
    const [mark] = sentSave().marks ?? []
    expect(mark?.text).toBe(marked)
    expect(mark?.start).toBe(draft.indexOf(marked))
    expect((mark?.end ?? 0) - (mark?.start ?? 0)).toBe(marked.length)
    expect(marked).toHaveLength(6)
    expect(draft.slice(mark?.start, mark?.end)).toBe(marked)
  })

  it('keeps a combining character with its base letter when the selection includes both', async () => {
    const base = 'Note: cafe\u0301 is open.\n'
    getSpy.mockResolvedValue(ok(pageOf({body: base, corrections: []})))
    await renderPage()
    await edit('Note: cafe\u0300 is open.\n')
    selectText('cafe\u0300')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))
    await flush()

    expect(confirmation()).toBeNull()
    expect(sentSave().marks).toEqual([{text: 'cafe\u0300', start: 6, end: 11}])
  })

  it('widens a selection that splits an emoji to the whole emoji', async () => {
    getSpy.mockResolvedValue(ok(pageOf({body: 'a\n', corrections: []})))
    await renderPage()
    await edit('a \u{1F44D} b\n')
    // [3, 4) is the low half of the emoji at [2, 4).
    select(3, 5)
    fireEvent.click(markButton())
    expect(screen.getByTestId('wiki-mark-item').querySelector('q')?.textContent).toBe('\u{1F44D} ')
  })

  it('does not mark a selection that has collapsed by the time the button is pressed', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    textbox().setSelectionRange(5, 5)
    fireEvent.click(markButton())
    expect(screen.queryByTestId('wiki-mark-item')).toBeNull()
  })

  it('does not mark the same span twice', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())
    fireEvent.click(markButton())
    expect(screen.getAllByTestId('wiki-mark-item')).toHaveLength(1)
  })

  it('refuses a span longer than the server accepts, and says so', async () => {
    getSpy.mockResolvedValue(ok(pageOf({body: 'seed\n', corrections: []})))
    await renderPage()
    await edit('x'.repeat(5000))
    select(0, 5000)
    fireEvent.click(markButton())

    expect(screen.queryByTestId('wiki-mark-item')).toBeNull()
    expect(screen.getByTestId('wiki-mark-status')).toHaveTextContent(/too long/iu)
    expect(screen.getByTestId('wiki-mark-status')).toHaveAttribute('role', 'status')
  })

  it('removes a mark', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())
    fireEvent.click(within(screen.getByTestId('wiki-mark-item')).getByRole('button', {name: 'Remove'}))

    expect(screen.queryByTestId('wiki-mark-item')).toBeNull()
    fireEvent.click(button('Save'))
    await flush()
    // The change is no longer marked, so it asks.
    expect(confirmation()).toBeInTheDocument()
    fireEvent.click(button('Confirm save'))
    await flush()
    expect(sentSave().marks).toEqual([])
  })

  it('jumps to the span: the text area selects it and takes focus', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())
    textbox().setSelectionRange(0, 0)
    button('Save').focus()

    fireEvent.click(within(screen.getByTestId('wiki-mark-item')).getByRole('button', {name: 'Jump to span'}))

    const start = GADGETS.indexOf('gadgets')
    expect(textbox()).toHaveFocus()
    expect(textbox().selectionStart).toBe(start)
    expect(textbox().selectionEnd).toBe(start + 7)
  })

  it('keeps a mark on its text when the text before it changes', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())

    const shifted = `Intro.\n${GADGETS}`
    type(shifted)
    expect(screen.getByTestId('wiki-mark-item')).toHaveAttribute('data-mark-state', 'ok')

    fireEvent.click(button('Save'))
    // The intro is a change outside the mark, so it asks first.
    expect(confirmation()).toBeInTheDocument()
    fireEvent.click(button('Confirm save'))
    await flush()

    const start = shifted.indexOf('gadgets')
    expect(sentSave().marks).toEqual([{text: 'gadgets', start, end: start + 7}])
  })

  it('blocks Save and offers Remove when the marked text is deleted', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())
    type(GADGETS.replace('gadgets', ''))

    const item = screen.getByTestId('wiki-mark-item')
    expect(item).toHaveAttribute('data-mark-state', 'detached')
    expect(button('Save')).toBeDisabled()

    fireEvent.click(within(item).getByRole('button', {name: 'Remove'}))
    expect(button('Save')).toBeEnabled()
  })

  it('does not mark in the read-only view', async () => {
    getSpy.mockResolvedValue(ok(pageOf({canWrite: false, canWriteReason: 'not-operator'})))
    await renderPage()
    expect(queryButton('Mark as correction')).toBeNull()
  })
})

describe('a mark that grows past the length the server accepts', () => {
  const HUNDRED = 'x'.repeat(100)
  const LONG_BODY = `\nBefore ${HUNDRED} after.\n`

  async function markHundred() {
    getSpy.mockResolvedValue(ok(pageOf({body: LONG_BODY, corrections: []})))
    await renderPage()
    await edit(`${LONG_BODY}tail\n`)
    selectText(HUNDRED)
    fireEvent.click(markButton())
    expect(screen.getByTestId('wiki-mark-item')).toBeInTheDocument()
  }

  function pasteInside(length: number) {
    const text = textbox().value
    const at = text.indexOf(HUNDRED) + 50
    type(`${text.slice(0, at)}${'y'.repeat(length)}${text.slice(at)}`)
  }

  it('is dropped with a notice when about 4,000 characters are pasted inside it', async () => {
    await markHundred()
    pasteInside(4000)

    expect(screen.queryByTestId('wiki-mark-item')).toBeNull()
    expect(screen.getByTestId('wiki-mark-status')).toHaveTextContent(/grew past the length limit, so it was removed/iu)
    expect(screen.getByTestId('wiki-mark-status')).toHaveAttribute('role', 'status')
  })

  it('never reaches the draft store: the draft is written without it and reads back', async () => {
    await markHundred()
    pasteInside(4000)
    cleanup()
    await flush()

    const stored = await store.getDraft(PAGE_ID)
    expect(stored.ok).toBe(true)
    expect(stored.ok && stored.value?.marks).toEqual([])
    expect(stored.ok && stored.value?.draftText).toContain('y'.repeat(4000))
  })

  it('never reaches the save request', async () => {
    await markHundred()
    pasteInside(4000)
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()

    expect(sentSave().marks).toEqual([])
  })

  it('keeps a mark that grows but stays within the limit', async () => {
    await markHundred()
    pasteInside(500)

    expect(screen.getByTestId('wiki-mark-item')).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-mark-status')).toBeNull()
  })
})

describe('a paste that crosses the edge of a mark', () => {
  const PAGE_TEXT = 'The cat sat on the mat. Dogs bark loudly at night.\n'

  it('does not take the pasted text into the mark: the mark is detached and Save is blocked', async () => {
    getSpy.mockResolvedValue(ok(pageOf({body: PAGE_TEXT, corrections: []})))
    await renderPage()
    await edit(PAGE_TEXT.replace('cat', 'CAT'))
    selectText('CAT')
    fireEvent.click(markButton())

    // One paste replaces everything from "CAT" to the end with "dog".
    type('The dog')

    expect(screen.getByTestId('wiki-mark-item')).toHaveAttribute('data-mark-state', 'detached')
    expect(button('Save')).toBeDisabled()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('flags a mark that is clipped by a paste over its end, and Save waits', async () => {
    getSpy.mockResolvedValue(ok(pageOf({body: PAGE_TEXT, corrections: []})))
    await renderPage()
    await edit(PAGE_TEXT.replace('cat', 'CAT'))
    selectText('CAT sat')
    fireEvent.click(markButton())
    type(PAGE_TEXT.replace('cat sat on the mat', 'CAT ran'))

    expect(screen.getByTestId('wiki-mark-item')).toHaveAttribute('data-mark-state', 'review')
    expect(button('Save')).toBeDisabled()
  })
})

describe('typing next to a mark, one input event at a time', () => {
  const PAGE_TEXT = 'The cat sat on the mat.\n'

  /** Type `typed` at `at`, one change event per character, as a textarea does. */
  function typeEach(at: number, typed: string, replacing = 0) {
    let caret = at
    for (const [index, char] of [...typed].entries()) {
      const value = textbox().value
      type(value.slice(0, caret) + char + value.slice(caret + (index === 0 ? replacing : 0)))
      caret += char.length
    }
  }

  async function markCat() {
    getSpy.mockResolvedValue(ok(pageOf({body: PAGE_TEXT, corrections: []})))
    await renderPage()
    await edit()
    selectText('cat')
    fireEvent.click(markButton())
  }

  it('does not grow the mark when " sat" is typed after it, and Save asks for the confirmation', async () => {
    await markCat()
    typeEach(textbox().value.indexOf('cat') + 3, ' sat')

    expect(textbox().value).toBe('The cat sat sat on the mat.\n')
    expect(screen.getByTestId('wiki-mark-item')).toHaveTextContent('cat')
    expect(screen.getByTestId('wiki-mark-item').querySelector('q')?.textContent).toBe('cat')
    expect(screen.getByTestId('wiki-mark-item')).toHaveAttribute('data-mark-state', 'ok')

    fireEvent.click(button('Save'))
    expect(confirmation()).toBeInTheDocument()
    expect(saveSpy).not.toHaveBeenCalled()

    fireEvent.click(button('Confirm save'))
    await flush()
    expect(sentSave().marks).toEqual([{text: 'cat', start: 4, end: 7}])
  })

  it('does not grow the mark when text is typed at its start', async () => {
    await markCat()
    typeEach(textbox().value.indexOf('cat'), 'ccc')

    expect(screen.getByTestId('wiki-mark-item').querySelector('q')?.textContent).toBe('cat')
    fireEvent.click(button('Save'))
    expect(confirmation()).toBeInTheDocument()
  })

  it('clips the mark when text is selected from inside it to past its end, and typing over it adds nothing', async () => {
    getSpy.mockResolvedValue(ok(pageOf({body: PAGE_TEXT, corrections: []})))
    await renderPage()
    await edit()
    selectText('cat sat')
    fireEvent.click(markButton())
    typeEach(textbox().value.indexOf('sat'), 'replacement', 'sat on'.length)

    expect(textbox().value).toBe('The cat replacement the mat.\n')
    expect(screen.getByTestId('wiki-mark-item').querySelector('q')?.textContent).toBe('cat ')
    expect(screen.getByTestId('wiki-mark-item')).toHaveAttribute('data-mark-state', 'review')
    expect(button('Save')).toBeDisabled()
  })
})

describe('typing over a selection that crosses the edge of a mark, as a browser reports it', () => {
  const LEAD = `${'p'.repeat(212 - '\n\n\nAn extra sentence.\n\n\n'.length)}\n\n\nAn extra sentence.\n\n\n`
  const PAGE_TEXT = `${LEAD}left right suffix.`

  /**
   * Type one character as a browser does: the value changes, the caret sits after the character, and
   * the input event says what was inserted. `replacing` characters are replaced by the first one.
   */
  function typeAsBrowser(typed: string, replacing: number) {
    const area = textbox()
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set as (value: string) => void
    let caret = area.selectionStart
    for (const [index, char] of [...typed].entries()) {
      const value = area.value
      setValue.call(area, value.slice(0, caret) + char + value.slice(caret + (index === 0 ? replacing : 0)))
      caret += char.length
      area.setSelectionRange(caret, caret)
      fireEvent(area, new InputEvent('input', {bubbles: true, data: char, inputType: 'insertText'}))
    }
  }

  async function markLeftRight() {
    getSpy.mockResolvedValue(ok(pageOf({body: PAGE_TEXT, corrections: []})))
    await renderPage()
    await edit()
    select(212, 222)
    fireEvent.click(markButton())
    expect(screen.getByTestId('wiki-mark-item').querySelector('q')?.textContent).toBe('left right')
  }

  it('replays the browser case: the mark ends as the surviving "left ", flagged, with none of the typed text', async () => {
    await markLeftRight()
    textbox().setSelectionRange(217, 227)
    typeAsBrowser('replacement', 10)

    expect(textbox().value.slice(212)).toBe('left replacementix.')
    expect(screen.getByTestId('wiki-mark-item').querySelector('q')?.textContent).toBe('left ')
    expect(screen.getByTestId('wiki-mark-item')).toHaveAttribute('data-mark-state', 'review')
    expect(button('Save')).toBeDisabled()
  })

  it('keeps the same result when the typed text begins with the character after the selection', async () => {
    await markLeftRight()
    textbox().setSelectionRange(217, 227)
    typeAsBrowser('ixed', 10)

    expect(screen.getByTestId('wiki-mark-item').querySelector('q')?.textContent).toBe('left ')
    expect(screen.getByTestId('wiki-mark-item')).toHaveAttribute('data-mark-state', 'review')
  })

  it('still grows a mark when text is typed strictly inside it, with the same events', async () => {
    await markLeftRight()
    textbox().setSelectionRange(214, 214)
    typeAsBrowser('XY', 0)

    expect(screen.getByTestId('wiki-mark-item').querySelector('q')?.textContent).toBe('leXYft right')
    expect(screen.getByTestId('wiki-mark-item')).toHaveAttribute('data-mark-state', 'ok')
  })
})

describe('the pending operation of an unknown save records whether the body was sent', () => {
  const unknown = () => saveSpy.mockResolvedValue({ok: false as const, error: {kind: 'status-unknown', cause: 'timeout'}} as never)
  const pending = () => (idb.records()[0] as {pending: {bodyChanged: boolean; state: string} | null}).pending

  /** Cancel and Keep draft rewrite the draft record while the unknown save is still pending. */
  async function keepDraftWhilePending() {
    fireEvent.click(button('Cancel'))
    fireEvent.click(button('Keep draft'))
    await flush()
  }

  it('is bodyChanged false for a save that only carries a staged action, and stays false when the draft is rewritten', async () => {
    unknown()
    await renderPage()
    fireEvent.click(button('Edit'))
    await flush()
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Retire'}))
    fireEvent.click(button('Save'))
    await flush()

    expect(sentSave().body).toBe(BODY)
    expect(sentSave().transitions).toEqual([{id: 'c1', action: 'retire'}])
    expect(pending()).toMatchObject({state: 'unknown', bodyChanged: false})

    await keepDraftWhilePending()
    expect(pending()).toMatchObject({state: 'unknown', bodyChanged: false})
  })

  it('is bodyChanged true for a save that changes the body, and stays true when the draft is rewritten', async () => {
    unknown()
    await renderPage()
    await edit(GADGETS)
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()

    expect(pending()).toMatchObject({state: 'unknown', bodyChanged: true})

    await keepDraftWhilePending()
    expect(pending()).toMatchObject({state: 'unknown', bodyChanged: true})
  })

  it('keeps the value when the page is opened again from the stored record', async () => {
    unknown()
    await renderPage()
    fireEvent.click(button('Edit'))
    await flush()
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Retire'}))
    fireEvent.click(button('Save'))
    await flush()
    cleanup()
    await flush()
    expect(pending()).toMatchObject({bodyChanged: false})

    await renderPage()
    await keepDraftWhilePending()
    expect(pending()).toMatchObject({state: 'unknown', bodyChanged: false})
  })
})

// ---------------------------------------------------------------------------
// Marks and staged actions persist
// ---------------------------------------------------------------------------

describe('marks and staged actions persist in the draft', () => {
  it('stores them, and shows them again when the page is opened later', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Retire'}))
    cleanup() // closing the page writes the pending draft
    await flush()

    expect(idb.records()[0]).toMatchObject({
      schemaVersion: 2,
      draftText: GADGETS,
      marks: [{text: 'gadgets', start: GADGETS.indexOf('gadgets')}],
      staged: [{correctionId: 'c1', action: 'retire', from: 'active', spanText: 'Alpha builds widgets'}],
    })

    await renderPage()
    expect(textbox().value).toBe(GADGETS)
    expect(screen.getByTestId('wiki-mark-item')).toHaveTextContent('gadgets')
    expect(correctionItem('c1')).toHaveAttribute('data-staged', 'retire')

    fireEvent.click(button('Save'))
    await flush()
    expect(confirmation()).toBeNull()
    expect(sentSave()).toMatchObject({
      marks: [{text: 'gadgets', start: GADGETS.indexOf('gadgets'), end: GADGETS.indexOf('gadgets') + 7}],
      transitions: [{id: 'c1', action: 'retire'}],
    })
  })

  it('reads a version 1 draft record as a draft with no marks and nothing staged', async () => {
    idb.plant({
      schemaVersion: 1,
      pageId: PAGE_ID,
      baseBlobSha: 'blob-1',
      baseText: BODY,
      correctionsBase: {entries: [C1], digest: 'digest-1'},
      draftText: GADGETS,
      updatedAt: 1,
      pending: null,
    })
    await renderPage()

    expect(textbox().value).toBe(GADGETS)
    expect(screen.queryByTestId('wiki-mark-item')).toBeNull()
    expect(correctionItem('c1')).not.toHaveAttribute('data-staged')
    expect(screen.queryByTestId('wiki-draft-unreadable')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The corrections panel
// ---------------------------------------------------------------------------

describe('the corrections panel', () => {
  it('shows the empty state for a page with no corrections', async () => {
    getSpy.mockResolvedValue(ok(pageOf({corrections: []})))
    await renderPage()
    expect(panel()).toHaveTextContent('No corrections recorded for this page.')
  })

  it('shows a correction whose span no longer matches the page as stale', async () => {
    getSpy.mockResolvedValue(ok(pageOf({corrections: [C1, correction('c2', {stale: true})]})))
    await renderPage()

    expect(correctionItem('c1')).not.toHaveTextContent('Out of date')
    expect(correctionItem('c2')).toHaveAttribute('data-stale', 'true')
    expect(correctionItem('c2')).toHaveTextContent('Out of date')
  })

  it('is read-only without the edit surface: no actions, even for a page that can be edited', async () => {
    await renderPage()
    expect(within(panel()).queryByRole('button')).toBeNull()
  })

  it('is read-only for a session that cannot write', async () => {
    getSpy.mockResolvedValue(ok(pageOf({canWrite: false, canWriteReason: 'not-operator'})))
    await renderPage()
    expect(within(panel()).queryByRole('button')).toBeNull()
    expect(correctionItem('c1')).toHaveTextContent('Alpha builds widgets')
  })

  it('offers no actions on a page that cannot be marked', async () => {
    getSpy.mockResolvedValue(ok(pageOf(UNMARKABLE)))
    await renderPage()
    await edit()
    expect(within(panel()).queryByRole('button', {name: 'Retire'})).toBeNull()
  })

  it('stages Retire, shows it as staged, and undoes it', async () => {
    await renderPage()
    await edit()
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Retire'}))

    expect(correctionItem('c1')).toHaveAttribute('data-staged', 'retire')
    expect(within(correctionItem('c1')).getByTestId('wiki-correction-staged')).toHaveTextContent(/retired when you save/iu)
    expect(button('Save')).toBeEnabled()

    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Undo'}))
    expect(correctionItem('c1')).not.toHaveAttribute('data-staged')
    expect(button('Save')).toBeDisabled()
  })

  it('commits a staged Retire with Save as a corrections-only save, and the panel shows it retired', async () => {
    await renderPage()
    await edit()
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Retire'}))

    getSpy.mockResolvedValue(
      ok(pageOf({pageBlobSha: 'blob-2', corrections: [{...C1, status: 'retired'}], correctionsBase: 'digest-2'})),
    )
    fireEvent.click(button('Save'))
    await flush()

    // The body is unchanged, so there is nothing to confirm.
    expect(confirmation()).toBeNull()
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(sentSave()).toMatchObject({
      body: BODY,
      pageBlobSha: 'blob-1',
      correctionsBase: 'digest-1',
      marks: [],
      transitions: [{id: 'c1', action: 'retire'}],
    })
    expect(correctionItem('c1')).toHaveAttribute('data-status', 'retired')
    expect(correctionItem('c1')).toHaveTextContent('Retired')
  })

  it('stages a flag, saves it, and then reconfirms the flagged correction', async () => {
    await renderPage()
    await edit()
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Flag for reconfirmation'}))
    expect(correctionItem('c1')).toHaveAttribute('data-staged', 'flag')

    getSpy.mockResolvedValue(
      ok(
        pageOf({
          pageBlobSha: 'blob-2',
          corrections: [{...C1, status: 'needs-reconfirmation'}],
          correctionsBase: 'digest-2',
        }),
      ),
    )
    fireEvent.click(button('Save'))
    await flush()
    expect(sentSave(0).transitions).toEqual([{id: 'c1', action: 'flag'}])
    expect(correctionItem('c1')).toHaveAttribute('data-status', 'needs-reconfirmation')

    await edit()
    expect(within(correctionItem('c1')).queryByRole('button', {name: 'Retire'})).toBeNull()
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Reconfirm'}))
    expect(correctionItem('c1')).toHaveAttribute('data-staged', 'reconfirm')

    fireEvent.click(button('Save'))
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(2)
    expect(sentSave(1)).toMatchObject({
      pageBlobSha: 'blob-2',
      correctionsBase: 'digest-2',
      transitions: [{id: 'c1', action: 'reconfirm'}],
    })
  })

  it('sends a staged action together with a marked change in one save', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Retire'}))
    fireEvent.click(button('Save'))
    await flush()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(sentSave()).toMatchObject({
      body: GADGETS,
      marks: [{text: 'gadgets'}],
      transitions: [{id: 'c1', action: 'retire'}],
    })
  })

  it('disables the panel buttons while a save is in flight', async () => {
    let finish: (value: never) => void = () => {}
    saveSpy.mockReturnValue(
      new Promise(resolve => {
        finish = resolve as (value: never) => void
      }),
    )
    await renderPage()
    await edit()
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Retire'}))
    fireEvent.click(button('Save'))
    await flush()

    expect(within(correctionItem('c1')).getByRole('button', {name: 'Undo'})).toBeDisabled()
    await act(async () => {
      finish(ok({state: 'saved', ...COMMIT}) as never)
    })
  })
})

// ---------------------------------------------------------------------------
// Staged actions that a refresh invalidates
// ---------------------------------------------------------------------------

function storedDraft(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    pageId: PAGE_ID,
    baseBlobSha: 'blob-1',
    baseText: BODY,
    correctionsBase: {entries: [C1], digest: 'digest-1'},
    draftText: GADGETS,
    pending: null,
    ...overrides,
  }
}

describe('staged actions when the corrections refresh', () => {
  const STAGED_VANISHED = {correctionId: 'c9', action: 'retire', from: 'active', spanText: 'Gone'} as const
  const STAGED_C1 = {correctionId: 'c1', action: 'retire', from: 'active', spanText: 'Alpha builds widgets'} as const

  it('drops an action whose correction has vanished, says so, and does not send it', async () => {
    await store.putDraft(storedDraft({staged: [STAGED_VANISHED, STAGED_C1]}))
    await renderPage()

    expect(screen.getByTestId('wiki-staged-dropped')).toHaveTextContent(/one staged change was dropped/iu)
    expect(correctionItem('c1')).toHaveAttribute('data-staged', 'retire')

    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()
    expect(sentSave().transitions).toEqual([{id: 'c1', action: 'retire'}])
  })

  it('drops an action whose correction has changed status since it was staged', async () => {
    await store.putDraft(storedDraft({staged: [STAGED_C1]}))
    getSpy.mockResolvedValue(ok(pageOf({corrections: [{...C1, status: 'retired'}], correctionsBase: 'digest-2'})))
    await renderPage()

    expect(screen.getByTestId('wiki-staged-dropped')).toBeInTheDocument()
    expect(correctionItem('c1')).not.toHaveAttribute('data-staged')
  })

  it('drops an action whose correction has changed text since it was staged', async () => {
    await store.putDraft(storedDraft({staged: [STAGED_C1]}))
    getSpy.mockResolvedValue(ok(pageOf({corrections: [correction('c1', {span: {text: 'Something else'}})]})))
    await renderPage()

    expect(screen.getByTestId('wiki-staged-dropped')).toBeInTheDocument()
    expect(correctionItem('c1')).not.toHaveAttribute('data-staged')
  })

  it('counts several dropped actions', async () => {
    await store.putDraft(storedDraft({staged: [STAGED_VANISHED, {...STAGED_VANISHED, correctionId: 'c8'}]}))
    await renderPage()
    expect(screen.getByTestId('wiki-staged-dropped')).toHaveTextContent(/2 staged changes were dropped/iu)
  })

  it('sends nothing for an action that was dropped, and a lone dropped action leaves nothing to save', async () => {
    await store.putDraft(storedDraft({draftText: BODY, staged: [STAGED_VANISHED]}))
    await renderPage()

    expect(screen.getByTestId('wiki-staged-dropped')).toBeInTheDocument()
    expect(button('Save')).toBeDisabled()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('shows no notice when every staged action still applies', async () => {
    await store.putDraft(storedDraft({staged: [STAGED_C1]}))
    await renderPage()
    expect(screen.queryByTestId('wiki-staged-dropped')).toBeNull()
  })

  it('re-bases after a corrections conflict and drops an action the new corrections no longer allow', async () => {
    await renderPage()
    await edit(GADGETS)
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Retire'}))

    const current = [{...C1, status: 'retired' as const}]
    saveSpy.mockResolvedValueOnce(
      saveFailure({kind: 'conflict', conflict: {kind: 'corrections', currentCorrections: current, correctionsBase: 'digest-2'}}),
    )
    getSpy.mockResolvedValue(ok(pageOf({corrections: current, correctionsBase: 'digest-2'})))
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()
    expect(screen.getByTestId('wiki-conflict')).toBeInTheDocument()

    fireEvent.click(button('Overwrite with my draft'))
    fireEvent.click(button('Yes, overwrite'))
    await flush()

    expect(screen.getByTestId('wiki-staged-dropped')).toBeInTheDocument()
    expect(correctionItem('c1')).toHaveAttribute('data-status', 'retired')
    expect(correctionItem('c1')).not.toHaveAttribute('data-staged')
  })
})

describe('the staging cap', () => {
  const many = Array.from({length: MAX_STAGED + 1}, (_unused, index) => correction(`c${String(index)}`))
  const stagedFor = (list: readonly WikiCorrection[]) =>
    list.map(item => ({correctionId: item.id, action: 'retire' as const, from: 'active' as const, spanText: item.span.text}))

  it('refuses a new staged action at the cap, says so, and keeps what is staged', async () => {
    getSpy.mockResolvedValue(ok(pageOf({corrections: many})))
    await store.putDraft(storedDraft({draftText: BODY, correctionsBase: {entries: many, digest: 'digest-1'}, staged: stagedFor(many.slice(0, MAX_STAGED))}))
    await renderPage()

    fireEvent.click(within(correctionItem(`c${String(MAX_STAGED)}`)).getByRole('button', {name: 'Retire'}))

    expect(correctionItem(`c${String(MAX_STAGED)}`)).not.toHaveAttribute('data-staged')
    expect(screen.getByTestId('wiki-stage-status')).toHaveTextContent(/most changes a save can carry/iu)
    expect(screen.getByTestId('wiki-stage-status')).toHaveAttribute('role', 'status')
    expect(panel().querySelectorAll('[data-staged]')).toHaveLength(MAX_STAGED)
  })

  it('still lets Undo free a place, and then stages the next one', async () => {
    getSpy.mockResolvedValue(ok(pageOf({corrections: many})))
    await store.putDraft(storedDraft({draftText: BODY, correctionsBase: {entries: many, digest: 'digest-1'}, staged: stagedFor(many.slice(0, MAX_STAGED))}))
    await renderPage()

    fireEvent.click(within(correctionItem('c0')).getByRole('button', {name: 'Undo'}))
    fireEvent.click(within(correctionItem(`c${String(MAX_STAGED)}`)).getByRole('button', {name: 'Retire'}))
    expect(correctionItem(`c${String(MAX_STAGED)}`)).toHaveAttribute('data-staged', 'retire')
    expect(screen.queryByTestId('wiki-stage-status')).toBeNull()
  })

  it('writes a draft at the cap that can be read back', async () => {
    getSpy.mockResolvedValue(ok(pageOf({corrections: many})))
    await store.putDraft(storedDraft({draftText: BODY, correctionsBase: {entries: many, digest: 'digest-1'}, staged: stagedFor(many.slice(0, MAX_STAGED - 1))}))
    await renderPage()
    fireEvent.click(within(correctionItem(`c${String(MAX_STAGED - 1)}`)).getByRole('button', {name: 'Retire'}))
    fireEvent.click(within(correctionItem(`c${String(MAX_STAGED)}`)).getByRole('button', {name: 'Retire'}))
    cleanup()
    await flush()

    const loaded = await store.getDraft(PAGE_ID)
    expect(loaded.ok && loaded.value?.staged).toHaveLength(MAX_STAGED)
  })
})

// ---------------------------------------------------------------------------
// Flagged marks
// ---------------------------------------------------------------------------

describe('a flagged mark', () => {
  const flagged: Mark = {
    id: 'm1',
    start: 3,
    end: 11,
    text: 'restored',
    prefix: 'My ',
    suffix: ' draft.\n',
    needsReview: true,
  }

  async function renderFlagged() {
    await store.putDraft(storedDraft({draftText: 'My restored draft.\n', marks: [flagged]}))
    await renderPage()
  }

  it('appears in the panel, and Save stays disabled until it is kept', async () => {
    await renderFlagged()

    const item = screen.getByTestId('wiki-mark-item')
    expect(item).toHaveAttribute('data-mark-state', 'review')
    expect(panel()).toContainElement(item)
    expect(button('Save')).toBeDisabled()

    fireEvent.click(within(item).getByRole('button', {name: 'Keep'}))
    expect(screen.getByTestId('wiki-mark-item')).toHaveAttribute('data-mark-state', 'ok')
    expect(button('Save')).toBeEnabled()
  })

  it('also lets Save through once it is removed', async () => {
    await renderFlagged()
    expect(button('Save')).toBeDisabled()

    fireEvent.click(within(screen.getByTestId('wiki-mark-item')).getByRole('button', {name: 'Remove'}))
    expect(button('Save')).toBeEnabled()
  })

  it('does not send a flagged mark', async () => {
    await renderFlagged()
    fireEvent.click(button('Save'))
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('keeps the flag across a reload', async () => {
    await renderFlagged()
    cleanup()
    await flush()
    await renderPage()
    expect(screen.getByTestId('wiki-mark-item')).toHaveAttribute('data-mark-state', 'review')
  })
})

// ---------------------------------------------------------------------------
// Unmarked changes
// ---------------------------------------------------------------------------

describe('Save and the unmarked changes', () => {
  it('saves a draft whose only changes are marked without asking', async () => {
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))
    await flush()

    expect(confirmation()).toBeNull()
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('asks about a draft with a change outside the marks; Cancel returns to editing, Confirm saves (AE7)', async () => {
    await renderPage()
    await edit(GADGETS.replace('Alpha', 'Omega'))
    selectText('gadgets')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))

    expect(confirmation()).toBeInTheDocument()
    expect(saveSpy).not.toHaveBeenCalled()

    fireEvent.click(button('Back to editing'))
    expect(confirmation()).toBeNull()
    expect(textbox()).toHaveFocus()
    expect(saveSpy).not.toHaveBeenCalled()

    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(sentSave().marks).toEqual([{text: 'gadgets', start: expect.any(Number), end: expect.any(Number)}])
  })

  it('counts a deletion with a mark around the gap, on both sides of it, as marked', async () => {
    await renderPage()
    const draft = BODY.replace('widgets', '')
    await edit(draft)
    selectText('Alpha builds .')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))
    await flush()

    expect(confirmation()).toBeNull()
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('asks about a deletion whose mark only touches one side of the gap', async () => {
    await renderPage()
    await edit(BODY.replace('widgets', ''))
    selectText('Alpha builds ')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))

    expect(confirmation()).toBeInTheDocument()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('counts a deletion with no mark as unmarked', async () => {
    await renderPage()
    await edit(BODY.replace('widgets', ''))
    fireEvent.click(button('Save'))
    expect(confirmation()).toBeInTheDocument()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('skips the check for a corrections-only save', async () => {
    await renderPage()
    await edit()
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Flag for reconfirmation'}))
    fireEvent.click(button('Save'))
    await flush()

    expect(confirmation()).toBeNull()
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('still asks for a changed body when actions are staged too', async () => {
    await renderPage()
    await edit(`${BODY}One more line.\n`)
    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Retire'}))
    fireEvent.click(button('Save'))

    expect(confirmation()).toBeInTheDocument()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('asks again when a mark is removed after confirming, because the change is no longer marked', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'rejected', reason: 'gate', findings: []}))
    await renderPage()
    await edit(GADGETS.replace('Alpha', 'Omega'))
    selectText('gadgets')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(1)

    fireEvent.click(within(screen.getByTestId('wiki-mark-item')).getByRole('button', {name: 'Remove'}))
    fireEvent.click(button('Save'))
    expect(confirmation()).toBeInTheDocument()
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('a page without a node_id still asks, and sends no marks', async () => {
    getSpy.mockResolvedValue(ok(pageOf(UNMARKABLE)))
    await renderPage()
    await edit(GADGETS)
    selectText('gadgets')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))
    expect(confirmation()).toHaveAttribute('data-confirm', 'no-node-id')
    fireEvent.click(button('Confirm save'))
    await flush()
    expect(sentSave().marks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// An eroded correction
// ---------------------------------------------------------------------------

describe('an eroded-correction rejection', () => {
  const ERODED = {
    kind: 'correction-eroded',
    path: 'knowledge/corrections.yaml',
    message: 'A marked correction is no longer present in the page.',
    target: 'c1',
  }

  it('lists the finding with the correction it is about', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'rejected', reason: 'gate', findings: [ERODED]}))
    await renderPage()
    await edit(BODY.replace('Alpha builds widgets', 'Gone'))
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()

    const finding = screen.getByTestId('wiki-finding')
    expect(finding).toHaveAttribute('data-finding-kind', 'correction-eroded')
    expect(finding).toHaveTextContent('A marked correction is no longer present in the page.')
    expect(finding).toHaveTextContent('Alpha builds widgets')
    expect(within(finding).getByRole('button', {name: 'Retire this correction'})).toBeEnabled()
  })

  it('lets the next save pass once a retire is staged for it', async () => {
    saveSpy.mockResolvedValueOnce(saveFailure({kind: 'rejected', reason: 'gate', findings: [ERODED]}))
    await renderPage()
    await edit(BODY.replace('Alpha builds widgets', 'Gone'))
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()
    expect(sentSave(0).transitions).toEqual([])

    fireEvent.click(within(screen.getByTestId('wiki-finding')).getByRole('button', {name: 'Retire this correction'}))
    expect(correctionItem('c1')).toHaveAttribute('data-staged', 'retire')

    fireEvent.click(button('Save'))
    await flush()

    expect(saveSpy).toHaveBeenCalledTimes(2)
    expect(sentSave(1).transitions).toEqual([{id: 'c1', action: 'retire'}])
    expect(screen.getByTestId('wiki-saved')).toBeInTheDocument()
  })

  it('also lets the operator stage the retire from the panel', async () => {
    saveSpy.mockResolvedValueOnce(saveFailure({kind: 'rejected', reason: 'gate', findings: [ERODED]}))
    await renderPage()
    await edit(BODY.replace('Alpha builds widgets', 'Gone'))
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()

    fireEvent.click(within(correctionItem('c1')).getByRole('button', {name: 'Retire'}))
    fireEvent.click(button('Save'))
    await flush()
    expect(sentSave(1).transitions).toEqual([{id: 'c1', action: 'retire'}])
  })

  it('offers no retire for a finding that names no correction on the page', async () => {
    saveSpy.mockResolvedValue(
      saveFailure({kind: 'rejected', reason: 'gate', findings: [{...ERODED, target: 'c-unknown'}]}),
    )
    await renderPage()
    await edit(`${BODY}x\n`)
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()

    expect(within(screen.getByTestId('wiki-finding')).queryByRole('button', {name: 'Retire this correction'})).toBeNull()
  })

  it('no longer offers the retire once it is staged', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'rejected', reason: 'gate', findings: [ERODED]}))
    await renderPage()
    await edit(BODY.replace('Alpha builds widgets', 'Gone'))
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()

    fireEvent.click(within(screen.getByTestId('wiki-finding')).getByRole('button', {name: 'Retire this correction'}))
    expect(within(screen.getByTestId('wiki-finding')).queryByRole('button', {name: 'Retire this correction'})).toBeNull()
    expect(screen.getByTestId('wiki-finding')).toHaveTextContent(/retire is staged/iu)
  })
})

// ---------------------------------------------------------------------------
// A change too large to check
// ---------------------------------------------------------------------------

describe('when a change is too large to check which parts are marked', () => {
  // One line about 1.4 times the side of the threshold, of distinct words so the page is plain.
  const count = Math.ceil(Math.sqrt(MAX_DIFF_AREA) / 4)
  const words = (edit?: number) => Array.from({length: count}, (_unused, i) => (i === edit ? 'EDITED' : `w${String(i)}`)).join(' ')
  const WIDE_BODY = `${words()}\n`
  const WIDE_EDITED = `${words(3)}\n`
  const unavailable = () => screen.queryByTestId('wiki-unmarked-unavailable')

  async function renderWide(overrides: Partial<WikiPage> = {}) {
    getSpy.mockResolvedValue(ok(pageOf({body: WIDE_BODY, corrections: [], ...overrides})))
    await renderPage()
    await edit(WIDE_EDITED)
  }

  it('says it could not check which changes are marked, and still asks for the confirmation', async () => {
    await renderWide()
    selectText('EDITED')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))

    expect(saveSpy).not.toHaveBeenCalled()
    expect(confirmation()).toBeInTheDocument()
    expect(unavailable()).toHaveTextContent(/could not check which changes are marked/iu)
    expect(unavailable()).toHaveTextContent(/too large/iu)
    expect(confirmation()).toContainElement(unavailable())
  })

  it('saves after Confirm, with the marks it has', async () => {
    await renderWide()
    selectText('EDITED')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(sentSave().marks).toEqual([{text: 'EDITED', start: WIDE_EDITED.indexOf('EDITED'), end: WIDE_EDITED.indexOf('EDITED') + 6}])
  })

  it('returns to editing on Cancel, sends nothing, and asks again on the next Save', async () => {
    await renderWide()
    selectText('EDITED')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))
    fireEvent.click(button('Back to editing'))

    expect(confirmation()).toBeNull()
    expect(unavailable()).toBeNull()
    expect(saveSpy).not.toHaveBeenCalled()

    fireEvent.click(button('Save'))
    expect(unavailable()).toBeInTheDocument()
  })

  it('does not say it for a change it can check', async () => {
    await renderPage()
    await edit(GADGETS.replace('Alpha', 'Omega'))
    selectText('gadgets')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))

    expect(confirmation()).toBeInTheDocument()
    expect(unavailable()).toBeNull()
  })

  it('does not say it when nothing is marked: then every change is unmarked and the ordinary question is asked', async () => {
    await renderWide()
    fireEvent.click(button('Save'))

    expect(confirmation()).toBeInTheDocument()
    expect(unavailable()).toBeNull()
  })

  it('does not say it on a page that cannot be marked', async () => {
    await renderWide(UNMARKABLE)
    fireEvent.click(button('Save'))

    expect(confirmation()).toHaveAttribute('data-confirm', 'no-node-id')
    expect(unavailable()).toBeNull()
  })

  it('does not ask twice for the same text and marks after confirming', async () => {
    saveSpy.mockResolvedValue(saveFailure({kind: 'rejected', reason: 'gate', findings: []}))
    await renderWide()
    selectText('EDITED')
    fireEvent.click(markButton())
    fireEvent.click(button('Save'))
    fireEvent.click(button('Confirm save'))
    await flush()
    fireEvent.click(button('Save'))
    await flush()

    expect(confirmation()).toBeNull()
    expect(saveSpy).toHaveBeenCalledTimes(2)
  })
})
