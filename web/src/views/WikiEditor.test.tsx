import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
import * as wikiApi from '../api/wiki.ts'
import type {WikiCorrection, WikiPage} from '../api/wiki.ts'
import {createDraftStore, type DraftInput, type DraftStore} from '../wiki/drafts.ts'
import * as sessionRecovery from '../wiki/session-recovery.ts'
import {createMemoryIdb} from '../wiki/test-support/memory-idb.ts'
import {WikiEditor} from './WikiEditor.tsx'

const PAGE_ID = 'repos.acme--alpha'

function correction(overrides: Partial<WikiCorrection> = {}): WikiCorrection {
  return {
    id: 'c1',
    status: 'active',
    span: {text: 'Alpha builds widgets'},
    attribution: {actor: 'marcus', recordedAt: '2026-02-04T10:00:00Z'},
    reason: 'It builds gadgets now.',
    supersededBy: null,
    stale: false,
    ...overrides,
  }
}

function pageOf(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    id: PAGE_ID,
    type: 'repos',
    title: 'acme/alpha',
    updated: '2026-02-01',
    body: '\n# acme/alpha\n\nAlpha builds widgets. See [[beta-topic]].\n',
    pageBlobSha: 'blob-1',
    nodeId: 'R_alpha',
    canMark: true,
    corrections: [correction()],
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

function draftInput(pageId: string, overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    pageId,
    baseBlobSha: 'blob-1',
    baseText: 'base\n',
    correctionsBase: {entries: [], digest: 'digest-1'},
    draftText: '# Gone page\n\nMy unsaved <b>words</b>.\n',
    pending: null,
    ...overrides,
  }
}

let store: DraftStore
let idb: ReturnType<typeof createMemoryIdb>
let getSpy: MockInstance<typeof wikiApi.getWikiPage>

beforeEach(() => {
  idb = createMemoryIdb()
  store = createDraftStore({indexedDB: idb.factory, now: () => 1_900_000_000_000})
  getSpy = vi.spyOn(wikiApi, 'getWikiPage').mockResolvedValue(ok(pageOf()))
  vi.spyOn(wikiApi, 'promotionStatus').mockResolvedValue(ok({state: 'settled', pr: null}))
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sessionStorage.clear()
  Reflect.deleteProperty(navigator, 'clipboard')
})

async function renderPage(props: Partial<React.ComponentProps<typeof WikiEditor>> = {}) {
  const onBackToList = vi.fn()
  const view = render(<WikiEditor pageId={PAGE_ID} onBackToList={onBackToList} draftStore={store} {...props} />)
  await act(async () => {})
  return {onBackToList, ...view}
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}})
}

describe('WikiEditor — read-only page view', () => {
  it('shows an explicit loading state with a live region while the page is pending', async () => {
    getSpy.mockReturnValue(new Promise(() => {}))
    await renderPage()
    const root = screen.getByTestId('wiki-page')
    expect(root).toHaveAttribute('data-page-id', PAGE_ID)
    expect(root).toHaveAttribute('data-state', 'loading')
    expect(screen.getByTestId('wiki-page-loading')).toHaveAttribute('role', 'status')
  })

  it('requests the page once, by its ID', async () => {
    await renderPage()
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(getSpy).toHaveBeenCalledWith(PAGE_ID)
  })

  it('shows the title as a heading with the type and the updated date', async () => {
    await renderPage()
    expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-state', 'ready')
    expect(screen.getByRole('heading', {level: 2, name: 'acme/alpha'})).toBeInTheDocument()
    const meta = screen.getByTestId('wiki-page-meta')
    expect(meta).toHaveTextContent('Repositories')
    expect(meta).toHaveTextContent('2026-02-01')
  })

  it('shows the body as plain text: raw Markdown, nothing rendered', async () => {
    const page = pageOf()
    getSpy.mockResolvedValue(ok(page))
    await renderPage()
    const body = screen.getByTestId('wiki-page-body')
    expect(body.tagName).toBe('PRE')
    expect(body.textContent).toBe(page.body)
    expect(body.querySelector('h1, a, em, strong, p')).toBeNull()
    expect(screen.queryByRole('heading', {level: 1})).toBeNull()
  })

  it('treats page text as text, not markup', async () => {
    getSpy.mockResolvedValue(ok(pageOf({body: '<img src=x onerror="alert(1)"><script>alert(2)</script>**bold**'})))
    await renderPage()
    const body = screen.getByTestId('wiki-page-body')
    expect(body.textContent).toBe('<img src=x onerror="alert(1)"><script>alert(2)</script>**bold**')
    expect(document.querySelector('img, script')).toBeNull()
  })

  it('shows no write notice when the session can write', async () => {
    await renderPage()
    expect(screen.queryByTestId('wiki-write-notice')).toBeNull()
  })

  it('shows the reason when canWrite is false, as a sentence, and still shows the page', async () => {
    getSpy.mockResolvedValue(ok(pageOf({canWrite: false, canWriteReason: 'not-operator'})))
    await renderPage()
    const notice = screen.getByTestId('wiki-write-notice')
    expect(notice).toHaveAttribute('role', 'status')
    expect(notice).toHaveTextContent(/read-only/iu)
    expect(notice).not.toHaveTextContent('not-operator')
    expect(screen.getByTestId('wiki-page-body')).toBeInTheDocument()
  })

  it('offers no editing control', async () => {
    await renderPage()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', {name: /save/iu})).toBeNull()
  })

  it('goes back to the list from the page', async () => {
    const {onBackToList} = await renderPage()
    fireEvent.click(screen.getByRole('link', {name: 'Back to the wiki list'}))
    expect(onBackToList).toHaveBeenCalledTimes(1)
  })

  it('the way back is a real link to /wiki, handled in-app on a plain click without following the link', async () => {
    const {onBackToList} = await renderPage()
    const link = screen.getByRole('link', {name: 'Back to the wiki list'})
    expect(link).toHaveAttribute('href', '/wiki')

    const notPrevented = fireEvent.click(link)

    expect(onBackToList).toHaveBeenCalledTimes(1)
    expect(notPrevented).toBe(false)
  })

  it.each([
    ['ctrl', {ctrlKey: true}],
    ['meta', {metaKey: true}],
    ['shift', {shiftKey: true}],
    ['middle button', {button: 1}],
  ])('a %s click on the way back is left to the browser (new tab or window)', async (_label, init) => {
    const {onBackToList} = await renderPage()
    let prevented: boolean | undefined
    const record = (event: Event) => {
      prevented = event.defaultPrevented
      event.preventDefault()
    }
    document.addEventListener('click', record)

    fireEvent.click(screen.getByRole('link', {name: 'Back to the wiki list'}), init)
    document.removeEventListener('click', record)

    expect(onBackToList).not.toHaveBeenCalled()
    expect(prevented).toBe(false)
  })

  it('loads the new page when the ID changes, and does not show the old one meanwhile', async () => {
    const view = await renderPage()
    getSpy.mockReturnValue(new Promise(() => {}))

    view.rerender(<WikiEditor pageId="topics.beta-topic" onBackToList={vi.fn()} draftStore={store} />)
    await act(async () => {})

    expect(getSpy).toHaveBeenLastCalledWith('topics.beta-topic')
    expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-state', 'loading')
    expect(screen.queryByTestId('wiki-page-body')).toBeNull()
  })
})

describe('WikiEditor — corrections', () => {
  it('lists each correction with its status, text, reason, and who recorded it', async () => {
    getSpy.mockResolvedValue(
      ok(
        pageOf({
          corrections: [
            correction(),
            correction({
              id: 'c2',
              status: 'superseded',
              span: {text: 'Beta is old'},
              attribution: null,
              reason: null,
              supersededBy: 'c3',
              stale: true,
            }),
          ],
        }),
      ),
    )
    await renderPage()

    const section = screen.getByTestId('wiki-corrections')
    expect(within(section).getByRole('heading', {level: 3, name: 'Corrections'})).toBeInTheDocument()
    const items = within(section).getAllByRole('listitem')
    expect(items).toHaveLength(2)

    expect(items[0]).toHaveAttribute('data-correction-id', 'c1')
    expect(items[0]).toHaveAttribute('data-status', 'active')
    expect(items[0]).toHaveTextContent('Active')
    expect(items[0]).toHaveTextContent('Alpha builds widgets')
    expect(items[0]).toHaveTextContent('It builds gadgets now.')
    expect(items[0]).toHaveTextContent('marcus')
    expect(items[0]).toHaveTextContent('marcus, 2026-02-04')
    expect(items[0]).not.toHaveTextContent('T10:00:00Z')
    expect(within(section).getByText('2026-02-04')).toHaveAttribute('datetime', '2026-02-04T10:00:00Z')
    expect(items[0]).not.toHaveTextContent('Out of date')

    expect(items[1]).toHaveAttribute('data-status', 'superseded')
    expect(items[1]).toHaveTextContent('Superseded')
    expect(items[1]).toHaveTextContent('Beta is old')
    expect(items[1]).toHaveTextContent('Replaced by')
    expect(items[1]).toHaveTextContent('c3')
    expect(items[1]).toHaveTextContent('Out of date')
  })

  it('shows correction text as text, not markup', async () => {
    getSpy.mockResolvedValue(ok(pageOf({corrections: [correction({span: {text: '<b>x</b>'}, reason: '<i>y</i>'})]})))
    await renderPage()
    const section = screen.getByTestId('wiki-corrections')
    expect(section.querySelector('b, i')).toBeNull()
    expect(section).toHaveTextContent('<b>x</b>')
  })

  it('says so when the page has no corrections', async () => {
    getSpy.mockResolvedValue(ok(pageOf({corrections: []})))
    await renderPage()
    expect(screen.getByTestId('wiki-corrections')).toHaveTextContent(/no corrections/iu)
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})

describe('WikiEditor — page not found', () => {
  it('an unknown ID shows not-found with a path back to the list, never a blank page', async () => {
    getSpy.mockResolvedValue(fail('not-found'))
    const {onBackToList} = await renderPage()

    const root = screen.getByTestId('wiki-page')
    expect(root).toHaveAttribute('data-state', 'not-found')
    expect(screen.getByTestId('wiki-page-not-found')).toHaveTextContent('Page not found')
    expect(screen.queryByTestId('wiki-orphaned-draft')).toBeNull()

    fireEvent.click(screen.getByRole('link', {name: 'Back to the wiki list'}))
    expect(onBackToList).toHaveBeenCalledTimes(1)
  })

  it('notes a draft it could not read, leaves it in place, and still shows not-found', async () => {
    getSpy.mockResolvedValue(fail('not-found'))
    idb.plant({pageId: PAGE_ID, schemaVersion: 99})
    await renderPage()
    expect(screen.getByTestId('wiki-page-not-found')).toBeInTheDocument()
    expect(screen.getByTestId('wiki-page-draft-unreadable')).toHaveAttribute('role', 'status')
    expect(idb.records()).toHaveLength(1)
  })

  it('still shows not-found when local drafts are unavailable in this browser', async () => {
    getSpy.mockResolvedValue(fail('not-found'))
    await renderPage({draftStore: createDraftStore({indexedDB: undefined})})
    expect(screen.getByTestId('wiki-page-not-found')).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-page-draft-unreadable')).toBeNull()
  })
})

describe('WikiEditor — orphaned draft', () => {
  beforeEach(async () => {
    getSpy.mockResolvedValue(fail('not-found'))
    await store.putDraft(draftInput(PAGE_ID))
  })

  it('shows the draft read-only, not the not-found state', async () => {
    await renderPage()

    expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-state', 'orphaned-draft')
    expect(screen.queryByTestId('wiki-page-not-found')).toBeNull()
    const section = screen.getByTestId('wiki-orphaned-draft')
    expect(within(section).getByRole('heading', {level: 2, name: 'Draft without a page'})).toBeInTheDocument()
    expect(section).toHaveTextContent(PAGE_ID)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows the draft text as plain text', async () => {
    await renderPage()
    const text = screen.getByTestId('wiki-orphaned-draft-text')
    expect(text.tagName).toBe('PRE')
    expect(text.textContent).toBe('# Gone page\n\nMy unsaved <b>words</b>.\n')
    expect(text.querySelector('b')).toBeNull()
  })

  it('Copy puts the draft text on the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    await renderPage()

    fireEvent.click(screen.getByRole('button', {name: 'Copy draft'}))
    await act(async () => {})

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('# Gone page\n\nMy unsaved <b>words</b>.\n')
    expect(screen.getByTestId('wiki-orphaned-draft-status')).toHaveAttribute('role', 'status')
    expect(screen.getByTestId('wiki-orphaned-draft-status')).toHaveTextContent('Draft copied.')
  })

  it('Copy says so when the clipboard refuses, and the draft stays', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
    await renderPage()

    fireEvent.click(screen.getByRole('button', {name: 'Copy draft'}))
    await act(async () => {})

    expect(screen.getByTestId('wiki-orphaned-draft-status')).toHaveTextContent(/could not be copied/iu)
    expect(screen.getByTestId('wiki-orphaned-draft-text')).toBeInTheDocument()
  })

  it('Copy says so when the browser has no clipboard API', async () => {
    await renderPage()
    expect(navigator.clipboard).toBeUndefined()

    fireEvent.click(screen.getByRole('button', {name: 'Copy draft'}))
    await act(async () => {})

    expect(screen.getByTestId('wiki-orphaned-draft-status')).toHaveTextContent(/could not be copied/iu)
  })

  it('Discard asks for confirmation first and deletes nothing yet', async () => {
    await renderPage()

    fireEvent.click(screen.getByRole('button', {name: 'Discard draft'}))
    await act(async () => {})

    const confirm = screen.getByTestId('wiki-orphaned-draft-confirm')
    expect(within(confirm).getByRole('heading', {name: 'Discard this draft?'})).toBeInTheDocument()
    expect(idb.records()).toHaveLength(1)
  })

  it('cancelling the confirmation keeps the draft, in the store and on screen', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', {name: 'Discard draft'}))

    fireEvent.click(within(screen.getByTestId('wiki-orphaned-draft-confirm')).getByRole('button', {name: 'Keep draft'}))
    await act(async () => {})

    expect(screen.queryByTestId('wiki-orphaned-draft-confirm')).toBeNull()
    expect(screen.getByTestId('wiki-orphaned-draft-text')).toBeInTheDocument()
    expect(idb.records()).toHaveLength(1)
  })

  it('confirming deletes the draft from this device and says so', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', {name: 'Discard draft'}))

    fireEvent.click(within(screen.getByTestId('wiki-orphaned-draft-confirm')).getByRole('button', {name: 'Discard draft'}))
    await act(async () => {})

    expect(idb.records()).toHaveLength(0)
    expect(screen.queryByTestId('wiki-orphaned-draft-text')).toBeNull()
    expect(screen.getByTestId('wiki-orphaned-draft-status')).toHaveTextContent('Draft discarded.')
    expect(screen.getByRole('link', {name: 'Back to the wiki list'})).toBeInTheDocument()
  })

  it('keeps the draft and says so when the delete fails', async () => {
    await renderPage()
    idb.failNext('delete', 'UnknownError')
    fireEvent.click(screen.getByRole('button', {name: 'Discard draft'}))

    fireEvent.click(within(screen.getByTestId('wiki-orphaned-draft-confirm')).getByRole('button', {name: 'Discard draft'}))
    await act(async () => {})

    expect(idb.records()).toHaveLength(1)
    expect(screen.getByTestId('wiki-orphaned-draft-text')).toBeInTheDocument()
    expect(screen.getByTestId('wiki-orphaned-draft-status')).toHaveTextContent(/could not be discarded/iu)
  })

  it('goes back to the list', async () => {
    const {onBackToList} = await renderPage()
    fireEvent.click(screen.getByRole('link', {name: 'Back to the wiki list'}))
    expect(onBackToList).toHaveBeenCalledTimes(1)
  })

  it('shows the page instead when the page is listed again', async () => {
    getSpy.mockResolvedValue(ok(pageOf()))
    await renderPage()
    expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-state', 'ready')
    expect(screen.queryByTestId('wiki-orphaned-draft')).toBeNull()
  })

  it('reads the draft once when the page is found, so an editor can restore it', async () => {
    getSpy.mockResolvedValue(ok(pageOf()))
    const readSpy = vi.spyOn(store, 'getDraft')
    await renderPage()
    expect(readSpy).toHaveBeenCalledTimes(1)
  })
})

describe('WikiEditor — failures', () => {
  it('shows an error with a retry, and the retry loads the page', async () => {
    getSpy.mockResolvedValueOnce(fail('network'))
    await renderPage()

    const error = screen.getByTestId('wiki-page-error')
    expect(error).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-state', 'error')

    fireEvent.click(within(error).getByRole('button', {name: 'Try again'}))
    await act(async () => {})

    expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-state', 'ready')
    expect(getSpy).toHaveBeenCalledTimes(2)
  })

  it.each(['unavailable', 'page-invalid', 'corrections-corrupt', 'timeout', 'rate-limited', 'contract-drift'])(
    'a %s failure shows an error state with a retry and a way back',
    async kind => {
      getSpy.mockResolvedValue(fail(kind))
      await renderPage()
      expect(screen.getByTestId('wiki-page-error')).toBeInTheDocument()
      expect(screen.getByRole('button', {name: 'Try again'})).toBeInTheDocument()
      expect(screen.getByRole('link', {name: 'Back to the wiki list'})).toBeInTheDocument()
    },
  )

  it('does not offer a retry for a forbidden session', async () => {
    getSpy.mockResolvedValue(fail('forbidden'))
    await renderPage()
    expect(screen.getByTestId('wiki-page-error')).toBeInTheDocument()
    expect(screen.queryByRole('button', {name: 'Try again'})).toBeNull()
  })

  it('shows no response body, status code, or error code', async () => {
    getSpy.mockResolvedValue(fail('corrections-corrupt'))
    await renderPage()
    expect(screen.getByTestId('wiki-page-error').textContent).not.toMatch(/corrections-corrupt|50\d|json|undefined/iu)
  })
})

describe('WikiEditor — lost session', () => {
  let assign: ReturnType<typeof vi.fn<(url: string) => void>>

  beforeEach(() => {
    assign = vi.fn<(url: string) => void>()
    const real = sessionRecovery.navigateToWikiSignIn
    vi.spyOn(sessionRecovery, 'navigateToWikiSignIn').mockImplementation(pageId => real(pageId, assign))
    getSpy.mockResolvedValue(fail('session-lost'))
  })

  it('navigates to login once with the page target encoded', async () => {
    await renderPage()
    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/auth/login?next=%2Fwiki%2Frepos.acme--alpha')
  })

  it('shows a manual sign-in link carrying the same target', async () => {
    await renderPage()
    const state = screen.getByTestId('wiki-page-session-lost')
    expect(screen.getByTestId('wiki-page')).toHaveAttribute('data-state', 'session-lost')
    expect(state).toHaveAttribute('role', 'status')
    expect(within(state).getByRole('link', {name: 'Sign in'})).toHaveAttribute(
      'href',
      '/auth/login?next=%2Fwiki%2Frepos.acme--alpha',
    )
  })

  it('a second lost-session signal does not loop', async () => {
    const first = await renderPage()
    first.unmount()

    await renderPage()

    expect(assign).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', {name: 'Sign in'})).toBeInTheDocument()
  })

  it('a successful load clears the guard', async () => {
    const first = await renderPage()
    first.unmount()
    expect(sessionStorage.getItem('fro-bot.wiki-sign-in-redirect')).not.toBeNull()

    getSpy.mockResolvedValue(ok(pageOf()))
    await renderPage()

    expect(sessionStorage.getItem('fro-bot.wiki-sign-in-redirect')).toBeNull()
  })
})

describe('WikiEditor — read-only guarantees', () => {
  it('makes no save, dispatch, lookup, or draft write', async () => {
    const save = vi.spyOn(wikiApi, 'saveWikiPage')
    const dispatch = vi.spyOn(wikiApi, 'retryPromotionDispatch')
    const lookup = vi.spyOn(wikiApi, 'lookupWikiOperation')
    const put = vi.spyOn(store, 'putDraft')
    await renderPage()
    expect(save).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('makes no console call', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    await renderPage()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})
