import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest'
import * as wikiApi from '../api/wiki.ts'
import type {PromotionStatus, WikiPageList, WikiPageSummary} from '../api/wiki.ts'
import {createDraftStore, type DraftInput, type DraftStore} from '../wiki/drafts.ts'
import * as sessionRecovery from '../wiki/session-recovery.ts'
import {createMemoryIdb} from '../wiki/test-support/memory-idb.ts'
import {WikiList} from './WikiList.tsx'

const ALPHA: WikiPageSummary = {id: 'repos.acme--alpha', title: 'acme/alpha', type: 'repos', updated: '2026-02-01', canMark: true}
const BETA: WikiPageSummary = {id: 'repos.acme--beta', title: 'acme/beta', type: 'repos', updated: '2026-02-03', canMark: true}
const TOPIC: WikiPageSummary = {id: 'topics.beta-topic', title: 'Beta topic', type: 'topics', updated: null, canMark: false}
const ENTITY: WikiPageSummary = {id: 'entities.gamma', title: 'Gamma', type: 'entities', updated: '2026-02-02', canMark: false}

function listOf(pages: readonly WikiPageSummary[], overrides: Partial<WikiPageList> = {}): WikiPageList {
  return {headSha: 'commit-1', pages, canWrite: true, canWriteReason: null, ...overrides}
}

const ok = <T,>(value: T) => ({ok: true as const, value})
const fail = (kind: string) => ({ok: false as const, error: {kind}}) as never

const SETTLED: PromotionStatus = {state: 'settled', pr: null}

function draftInput(pageId: string, overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    pageId,
    baseBlobSha: 'blob-1',
    baseText: 'base\n',
    correctionsBase: {entries: [], digest: 'digest-1'},
    draftText: 'edited\n',
    pending: null,
    ...overrides,
  }
}

let store: DraftStore
let idb: ReturnType<typeof createMemoryIdb>
let listSpy: MockInstance<typeof wikiApi.listWikiPages>
let statusSpy: MockInstance<typeof wikiApi.promotionStatus>

beforeEach(() => {
  idb = createMemoryIdb()
  store = createDraftStore({indexedDB: idb.factory, now: () => 1_900_000_000_000})
  listSpy = vi.spyOn(wikiApi, 'listWikiPages').mockResolvedValue(ok(listOf([ALPHA, BETA, TOPIC, ENTITY])))
  statusSpy = vi.spyOn(wikiApi, 'promotionStatus').mockResolvedValue(ok(SETTLED))
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

async function renderList(props: Partial<React.ComponentProps<typeof WikiList>> = {}) {
  const onOpenPage = vi.fn()
  const view = render(<WikiList onOpenPage={onOpenPage} draftStore={store} {...props} />)
  await act(async () => {})
  return {onOpenPage, ...view}
}

describe('WikiList — load states', () => {
  it('shows an explicit loading state with a live region while the list is pending', async () => {
    listSpy.mockReturnValue(new Promise(() => {}))
    await renderList()
    const loading = screen.getByTestId('wiki-list-loading')
    expect(loading).toHaveAttribute('role', 'status')
    expect(loading).toHaveTextContent(/loading/iu)
    expect(screen.queryByTestId('wiki-list-empty')).toBeNull()
  })

  it('shows the Wiki heading', async () => {
    await renderList()
    expect(screen.getByRole('heading', {level: 2, name: 'Wiki'})).toBeInTheDocument()
  })

  it('groups pages by type in the canonical order, each with title and updated date', async () => {
    await renderList()

    const groups = screen.getAllByTestId('wiki-group')
    expect(groups.map(group => group.getAttribute('data-type'))).toEqual(['repos', 'topics', 'entities'])

    const repos = within(groups[0] as HTMLElement)
    expect(repos.getByRole('heading', {level: 3, name: 'Repositories'})).toBeInTheDocument()
    const rows = repos.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByRole('link', {name: 'acme/alpha'})).toBeInTheDocument()
    expect(rows[0]).toHaveTextContent('2026-02-01')
    expect(rows[1]).toHaveTextContent('acme/beta')
    expect(rows[1]).toHaveTextContent('2026-02-03')
  })

  it('shows a placeholder for a page with no date', async () => {
    await renderList()
    const row = screen.getByRole('link', {name: 'Beta topic'}).closest('li') as HTMLElement
    expect(row).toHaveTextContent(/no date/iu)
  })

  it('omits a type with no pages', async () => {
    listSpy.mockResolvedValue(ok(listOf([ALPHA])))
    await renderList()
    expect(screen.getAllByTestId('wiki-group')).toHaveLength(1)
    expect(screen.queryByRole('heading', {name: 'Topics'})).toBeNull()
  })

  it('each page row is a real link to its deep link', async () => {
    await renderList()
    expect(screen.getByRole('link', {name: 'acme/alpha'})).toHaveAttribute('href', '/wiki/repos.acme--alpha')
  })

  it('shows an explicit empty state when the wiki has no pages', async () => {
    listSpy.mockResolvedValue(ok(listOf([])))
    await renderList()
    expect(screen.getByTestId('wiki-list-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-group')).toBeNull()
  })

  it('shows an error with a retry when the list call fails, and the retry loads the list', async () => {
    listSpy.mockResolvedValueOnce(fail('network'))
    await renderList()

    const error = screen.getByTestId('wiki-list-error')
    expect(error).toHaveAttribute('role', 'alert')
    expect(screen.queryByTestId('wiki-group')).toBeNull()

    fireEvent.click(within(error).getByRole('button', {name: 'Try again'}))
    await act(async () => {})

    expect(screen.queryByTestId('wiki-list-error')).toBeNull()
    expect(screen.getAllByTestId('wiki-group').length).toBeGreaterThan(0)
    expect(listSpy).toHaveBeenCalledTimes(2)
  })

  it.each(['timeout', 'rate-limited', 'contract-drift'])('a %s failure shows the error state with a retry', async kind => {
    listSpy.mockResolvedValue(fail(kind))
    await renderList()
    expect(screen.getByTestId('wiki-list-error')).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Try again'})).toBeInTheDocument()
  })

  it('shows an unavailable state, with a retry, when the wiki reports itself unavailable', async () => {
    listSpy.mockResolvedValue(fail('unavailable'))
    await renderList()
    const unavailable = screen.getByTestId('wiki-list-unavailable')
    expect(unavailable).toHaveAttribute('role', 'alert')
    expect(within(unavailable).getByRole('button', {name: 'Try again'})).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-list-error')).toBeNull()
  })

  it('does not offer a retry for a forbidden session', async () => {
    listSpy.mockResolvedValue(fail('forbidden'))
    await renderList()
    expect(screen.getByTestId('wiki-list-error')).toBeInTheDocument()
    expect(screen.queryByRole('button', {name: 'Try again'})).toBeNull()
  })

  it('shows no response body, status code, or reason code in an error', async () => {
    listSpy.mockResolvedValue(fail('contract-drift'))
    await renderList()
    const text = screen.getByTestId('wiki-list-error').textContent ?? ''
    expect(text).not.toMatch(/contract-drift|50\d|json|undefined/iu)
  })
})

describe('WikiList — opening a page', () => {
  it('an unmodified click on a row opens the page without following the link', async () => {
    const {onOpenPage} = await renderList()
    const link = screen.getByRole('link', {name: 'Gamma'})

    const notPrevented = fireEvent.click(link)

    expect(onOpenPage).toHaveBeenCalledTimes(1)
    expect(onOpenPage).toHaveBeenCalledWith('entities.gamma')
    expect(notPrevented).toBe(false)
  })

  it.each([
    ['ctrl', {ctrlKey: true}],
    ['meta', {metaKey: true}],
    ['shift', {shiftKey: true}],
    ['middle button', {button: 1}],
  ])('a %s click is left to the browser (new tab or window)', async (_label, init) => {
    const {onOpenPage} = await renderList()
    // Record whether anything in the app cancelled the click, then cancel it here so jsdom does not
    // try to navigate the test document.
    let prevented: boolean | undefined
    const record = (event: Event) => {
      prevented = event.defaultPrevented
      event.preventDefault()
    }
    document.addEventListener('click', record)

    fireEvent.click(screen.getByRole('link', {name: 'Gamma'}), init)
    document.removeEventListener('click', record)

    expect(onOpenPage).not.toHaveBeenCalled()
    expect(prevented).toBe(false)
  })
})

describe('WikiList — write capability', () => {
  it('shows the reason when canWrite is false, as a sentence and not the wire code', async () => {
    listSpy.mockResolvedValue(ok(listOf([ALPHA], {canWrite: false, canWriteReason: 'not-operator'})))
    await renderList()
    const notice = screen.getByTestId('wiki-write-notice')
    expect(notice).toHaveAttribute('role', 'status')
    expect(notice).toHaveTextContent(/read-only/iu)
    expect(notice).not.toHaveTextContent('not-operator')
  })

  it('shows no notice when the session can write', async () => {
    await renderList()
    expect(screen.queryByTestId('wiki-write-notice')).toBeNull()
  })
})

describe('WikiList — promotion status', () => {
  it('reads the promotion status once on load', async () => {
    await renderList()
    expect(statusSpy).toHaveBeenCalledTimes(1)
  })

  it('does not read it again when the operator opens a page row', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('link', {name: 'Gamma'}))
    await act(async () => {})
    expect(statusSpy).toHaveBeenCalledTimes(1)
  })

  it('a blocked branch shows the banner with the reason sentence and a link to the run', async () => {
    statusSpy.mockResolvedValue(
      ok<PromotionStatus>({
        state: 'blocked',
        reason: 'privacy-check',
        runUrl: 'https://github.com/fro-bot/.github/actions/runs/42',
        pr: null,
      }),
    )
    await renderList()

    const banner = screen.getByTestId('wiki-promotion-blocked')
    expect(banner).toHaveAttribute('role', 'alert')
    expect(banner).toHaveTextContent('The privacy check failed.')
    expect(banner).not.toHaveTextContent('privacy-check')
    const link = within(banner).getByRole('link', {name: 'View the blocked run'})
    expect(link).toHaveAttribute('href', 'https://github.com/fro-bot/.github/actions/runs/42')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(screen.getAllByTestId('wiki-group').length).toBeGreaterThan(0)
  })

  it('a blocked branch links its pull request when one exists', async () => {
    statusSpy.mockResolvedValue(
      ok<PromotionStatus>({
        state: 'blocked',
        reason: 'merge',
        runUrl: 'https://github.com/fro-bot/.github/actions/runs/42',
        pr: {number: 7, url: 'https://github.com/fro-bot/.github/pull/7'},
      }),
    )
    await renderList()
    const banner = screen.getByTestId('wiki-promotion-blocked')
    expect(within(banner).getByRole('link', {name: 'View the pull request'})).toHaveAttribute(
      'href',
      'https://github.com/fro-bot/.github/pull/7',
    )
  })

  it('a pending branch shows the pending banner', async () => {
    statusSpy.mockResolvedValue(ok<PromotionStatus>({state: 'pending', pr: null}))
    await renderList()
    const banner = screen.getByTestId('wiki-promotion-pending')
    expect(banner).toHaveAttribute('role', 'status')
    expect(screen.queryByTestId('wiki-promotion-blocked')).toBeNull()
  })

  it('a settled branch shows no banner and no note', async () => {
    await renderList()
    expect(screen.queryByTestId('wiki-promotion-blocked')).toBeNull()
    expect(screen.queryByTestId('wiki-promotion-pending')).toBeNull()
    expect(screen.queryByTestId('wiki-promotion-unavailable')).toBeNull()
  })

  it.each(['unavailable', 'network', 'timeout', 'rate-limited', 'configuration-fault', 'contract-drift'])(
    'a %s status read shows an unavailable note and the list still renders',
    async kind => {
      statusSpy.mockResolvedValue(fail(kind))
      await renderList()
      expect(screen.getByTestId('wiki-promotion-unavailable')).toHaveAttribute('role', 'status')
      expect(screen.getAllByTestId('wiki-group').length).toBeGreaterThan(0)
      expect(screen.queryByTestId('wiki-list-error')).toBeNull()
    },
  )

  it('the status read does not hold up the list', async () => {
    statusSpy.mockReturnValue(new Promise(() => {}))
    await renderList()
    expect(screen.getAllByTestId('wiki-group').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('wiki-promotion-unavailable')).toBeNull()
  })

  it('a retry reads the status again', async () => {
    listSpy.mockResolvedValueOnce(fail('network'))
    await renderList()
    fireEvent.click(screen.getByRole('button', {name: 'Try again'}))
    await act(async () => {})
    expect(statusSpy).toHaveBeenCalledTimes(2)
  })
})

describe('WikiList — local drafts', () => {
  it('marks a page that has a local draft, and only that page', async () => {
    await store.putDraft(draftInput(ALPHA.id))
    await renderList()

    const alpha = screen.getByRole('link', {name: 'acme/alpha'}).closest('li') as HTMLElement
    const beta = screen.getByRole('link', {name: 'acme/beta'}).closest('li') as HTMLElement
    expect(within(alpha).getByTestId('wiki-draft-marker')).toHaveTextContent('Local draft')
    expect(within(beta).queryByTestId('wiki-draft-marker')).toBeNull()
  })

  it('lists a draft whose page is gone in the orphaned section and not in the page groups', async () => {
    await store.putDraft(draftInput('repos.gone--forever'))
    await renderList()

    const section = screen.getByTestId('wiki-orphaned-drafts')
    expect(within(section).getByRole('heading', {level: 3, name: 'Drafts without a page'})).toBeInTheDocument()
    const rows = within(section).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('repos.gone--forever')
    expect(rows[0]).toHaveTextContent('2030-03-17')
    expect(within(section).getByRole('link', {name: /open draft/iu})).toHaveAttribute('href', '/wiki/repos.gone--forever')
    expect(screen.queryByTestId('wiki-draft-marker')).toBeNull()
  })

  it('opening an orphaned draft opens its page route, the same as a page row', async () => {
    await store.putDraft(draftInput('repos.gone--forever'))
    const {onOpenPage} = await renderList()

    fireEvent.click(within(screen.getByTestId('wiki-orphaned-drafts')).getByRole('link', {name: /open draft/iu}))

    expect(onOpenPage).toHaveBeenCalledWith('repos.gone--forever')
  })

  it('shows no orphaned section when every draft has its page', async () => {
    await store.putDraft(draftInput(ALPHA.id))
    await renderList()
    expect(screen.queryByTestId('wiki-orphaned-drafts')).toBeNull()
  })

  it('still shows the orphaned section when the wiki has no pages', async () => {
    listSpy.mockResolvedValue(ok(listOf([])))
    await store.putDraft(draftInput('repos.gone--forever'))
    await renderList()
    expect(screen.getByTestId('wiki-list-empty')).toBeInTheDocument()
    expect(screen.getByTestId('wiki-orphaned-drafts')).toBeInTheDocument()
  })

  it('does not call a draft orphaned when the list failed (the page set is unknown)', async () => {
    listSpy.mockResolvedValue(fail('network'))
    await store.putDraft(draftInput('repos.gone--forever'))
    await renderList()
    expect(screen.queryByTestId('wiki-orphaned-drafts')).toBeNull()
  })

  it('notes drafts it could not read, and does not delete them', async () => {
    idb.plant({pageId: 'repos.broken', schemaVersion: 99})
    await renderList()
    expect(screen.getByTestId('wiki-drafts-unreadable')).toHaveAttribute('role', 'status')
    expect(idb.records()).toHaveLength(1)
  })

  it('renders the list, with a note, when local drafts are unavailable in this browser', async () => {
    const noStorage = createDraftStore({indexedDB: undefined})
    await renderList({draftStore: noStorage})
    expect(screen.getByTestId('wiki-drafts-unavailable')).toHaveAttribute('role', 'status')
    expect(screen.getAllByTestId('wiki-group').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('wiki-draft-marker')).toBeNull()
  })

  it('does not write to the draft store', async () => {
    await store.putDraft(draftInput(ALPHA.id))
    const before = JSON.stringify(idb.records())
    await renderList()
    expect(JSON.stringify(idb.records())).toBe(before)
  })
})

describe('WikiList — lost session', () => {
  let assign: ReturnType<typeof vi.fn<(url: string) => void>>

  beforeEach(() => {
    assign = vi.fn<(url: string) => void>()
    const real = sessionRecovery.navigateToWikiSignIn
    vi.spyOn(sessionRecovery, 'navigateToWikiSignIn').mockImplementation(pageId => real(pageId, assign))
  })

  it('navigates to login once, with next=/wiki, when the list reports a lost session', async () => {
    listSpy.mockResolvedValue(fail('session-lost'))
    await renderList()
    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/auth/login?next=%2Fwiki')
  })

  it('navigates when only the promotion read reports a lost session', async () => {
    statusSpy.mockResolvedValue(fail('session-lost'))
    await renderList()
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('shows a manual sign-in link in the session-lost state', async () => {
    listSpy.mockResolvedValue(fail('session-lost'))
    await renderList()
    const state = screen.getByTestId('wiki-list-session-lost')
    expect(state).toHaveAttribute('role', 'status')
    expect(within(state).getByRole('link', {name: 'Sign in'})).toHaveAttribute('href', '/auth/login?next=%2Fwiki')
  })

  it('a second lost-session signal in the same tab does not navigate again', async () => {
    listSpy.mockResolvedValue(fail('session-lost'))
    const first = await renderList()
    first.unmount()

    await renderList()

    expect(assign).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', {name: 'Sign in'})).toBeInTheDocument()
  })

  it('a successful load clears the guard so a later lost session can recover again', async () => {
    listSpy.mockResolvedValueOnce(fail('session-lost'))
    const first = await renderList()
    first.unmount()
    await renderList()
    expect(sessionStorage.getItem('fro-bot.wiki-sign-in-redirect')).toBeNull()
  })

  it('does not navigate on a load that works', async () => {
    await renderList()
    expect(assign).not.toHaveBeenCalled()
  })
})

describe('WikiList — hygiene', () => {
  it('makes no console call', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    await store.putDraft(draftInput(ALPHA.id))
    await renderList()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  // React 18+ no longer warns about state updates after unmount, so a console spy proves nothing.
  // The answer handler runs `clearWikiSignInGuard()` just before it sets state. Both sit behind
  // the same `cancelled` check, so a late answer that still ran would clear the guard.
  it('ignores a list answer that arrives after unmount', async () => {
    let resolveList!: (value: ReturnType<typeof ok<WikiPageList>>) => void
    listSpy.mockReturnValue(new Promise(resolve => (resolveList = resolve)))
    const clearGuard = vi.spyOn(sessionRecovery, 'clearWikiSignInGuard')
    const view = await renderList()
    view.unmount()
    await act(async () => {
      resolveList(ok(listOf([ALPHA])))
    })
    await act(async () => {})
    expect(clearGuard).not.toHaveBeenCalled()
    expect(screen.queryByTestId('wiki-list')).toBeNull()
  })
})

describe('WikiList — a draft whose ID cannot be a route', () => {
  it('lists the draft but offers no link to open it', async () => {
    await store.putDraft(draftInput('not a page id'))
    await renderList()
    const section = screen.getByTestId('wiki-orphaned-drafts')
    expect(section).toHaveTextContent('not a page id')
    expect(within(section).queryByRole('link')).toBeNull()
  })
})
