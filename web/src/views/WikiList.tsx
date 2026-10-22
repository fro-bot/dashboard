/**
 * Wiki page list.
 *
 * Markup only: real headings, lists, links and buttons, `role` live regions, and stable
 * class names and `data-testid` hooks for the later visual pass. No styling lives here.
 *
 * Loads once on mount (and again on an explicit retry):
 *   - the page list,
 *   - the branch-level promotion status, read once and never polled,
 *   - the local draft list.
 * The three run side by side and none holds up another. A failed status read is a note, and
 * the list still renders. A draft counts as orphaned only when the list loaded and does not
 * name its page.
 */

import {type MouseEvent, useEffect, useState} from 'react'
import {
  promotionStatus,
  listWikiPages,
  WIKI_PAGE_TYPES,
  type PromotionStatus,
  type WikiPageList,
  type WikiPageSummary,
  type WikiPageType,
} from '../api/wiki.ts'
import {
  canWriteReasonCopy,
  isRetryable,
  LIST_COPY,
  PAGE_TYPE_LABEL,
  PROMOTION_COPY,
  readFailureCopy,
  type ReadFailureCopyKey,
} from '../wiki/copy.ts'
import type {DraftRecord, DraftStore} from '../wiki/drafts.ts'
import {isPlainClick, wikiPagePath} from '../wiki/location.ts'
import {clearWikiSignInGuard, navigateToWikiSignIn, wikiSignInUrl} from '../wiki/session-recovery.ts'
import {sharedDraftStore} from '../wiki/shared-store.ts'
import {PromotionBanner} from './PromotionBanner.tsx'

export interface WikiListProps {
  /** Open a page by ID. Called for an unmodified click on a page row or an orphaned draft. */
  readonly onOpenPage: (pageId: string) => void
  /** The local draft store. Defaults to the shared one; tests pass their own. */
  readonly draftStore?: DraftStore
}

type ListState =
  | {readonly kind: 'loading'}
  | {readonly kind: 'ready'; readonly list: WikiPageList}
  | {readonly kind: 'failed'; readonly failure: ReadFailureCopyKey}

type PromotionState =
  | {readonly kind: 'loading'}
  | {readonly kind: 'ready'; readonly status: PromotionStatus}
  | {readonly kind: 'unavailable'}
  | {readonly kind: 'session-lost'}

type DraftsState =
  | {readonly kind: 'loading'}
  | {readonly kind: 'ready'; readonly drafts: readonly DraftRecord[]; readonly unreadable: number}
  | {readonly kind: 'unavailable'}

function formatDraftDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function WikiList({onOpenPage, draftStore}: WikiListProps) {
  const [list, setList] = useState<ListState>({kind: 'loading'})
  const [promotion, setPromotion] = useState<PromotionState>({kind: 'loading'})
  const [drafts, setDrafts] = useState<DraftsState>({kind: 'loading'})
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const store = draftStore ?? sharedDraftStore()

    setList({kind: 'loading'})
    setPromotion({kind: 'loading'})
    setDrafts({kind: 'loading'})

    void (async () => {
      const result = await listWikiPages()
      if (cancelled) return
      if (result.ok) {
        clearWikiSignInGuard()
        setList({kind: 'ready', list: result.value})
      } else {
        setList({kind: 'failed', failure: result.error.kind})
      }
    })()

    void (async () => {
      const result = await promotionStatus()
      if (cancelled) return
      if (result.ok) setPromotion({kind: 'ready', status: result.value})
      else setPromotion(result.error.kind === 'session-lost' ? {kind: 'session-lost'} : {kind: 'unavailable'})
    })()

    void (async () => {
      const result = await store.listDrafts()
      if (cancelled) return
      setDrafts(
        result.ok
          ? {kind: 'ready', drafts: result.value.drafts, unreadable: result.value.unreadable.length}
          : {kind: 'unavailable'},
      )
    })()

    return () => {
      cancelled = true
    }
  }, [attempt, draftStore])

  const sessionLost =
    (list.kind === 'failed' && list.failure === 'session-lost') || promotion.kind === 'session-lost'

  useEffect(() => {
    if (sessionLost) navigateToWikiSignIn(null)
  }, [sessionLost])

  const open = (pageId: string) => (event: MouseEvent) => {
    if (!isPlainClick(event)) return
    event.preventDefault()
    onOpenPage(pageId)
  }

  const retry = () => {
    setAttempt(n => n + 1)
  }

  return (
    <section className="wiki-list" data-testid="wiki-list" aria-labelledby="wiki-list-heading">
      <h2 id="wiki-list-heading" className="wiki-list-heading">
        {LIST_COPY.heading}
      </h2>

      {sessionLost ? <SessionLost /> : null}

      {!sessionLost && promotion.kind === 'ready' ? <PromotionBanner status={promotion.status} /> : null}
      {!sessionLost && promotion.kind === 'unavailable' ? (
        <p className="wiki-note wiki-promotion-unavailable" data-testid="wiki-promotion-unavailable" role="status">
          {PROMOTION_COPY.unavailableNote}
        </p>
      ) : null}

      {!sessionLost && list.kind === 'ready' && !list.list.canWrite ? (
        <p className="wiki-note wiki-write-notice" data-testid="wiki-write-notice" role="status">
          {canWriteReasonCopy(list.list.canWriteReason)}
        </p>
      ) : null}

      {!sessionLost && list.kind === 'loading' ? (
        <p className="wiki-list-loading" data-testid="wiki-list-loading" role="status">
          {LIST_COPY.loading}
        </p>
      ) : null}

      {!sessionLost && list.kind === 'failed' ? <ListFailure failure={list.failure} onRetry={retry} /> : null}

      {!sessionLost && list.kind === 'ready' && list.list.pages.length === 0 ? (
        <div className="wiki-list-empty" data-testid="wiki-list-empty">
          <h3>{LIST_COPY.emptyHeadline}</h3>
          <p>{LIST_COPY.emptyDetail}</p>
        </div>
      ) : null}

      {!sessionLost && list.kind === 'ready' && list.list.pages.length > 0 ? (
        <PageGroups
          pages={list.list.pages}
          draftIds={drafts.kind === 'ready' ? new Set(drafts.drafts.map(draft => draft.pageId)) : new Set()}
          open={open}
        />
      ) : null}

      {!sessionLost && drafts.kind === 'ready' && list.kind === 'ready' ? (
        <OrphanedDrafts
          drafts={drafts.drafts.filter(draft => !list.list.pages.some(page => page.id === draft.pageId))}
          open={open}
        />
      ) : null}

      {drafts.kind === 'ready' && drafts.unreadable > 0 ? (
        <p className="wiki-note wiki-drafts-unreadable" data-testid="wiki-drafts-unreadable" role="status">
          {LIST_COPY.draftsUnreadable}
        </p>
      ) : null}
      {drafts.kind === 'unavailable' ? (
        <p className="wiki-note wiki-drafts-unavailable" data-testid="wiki-drafts-unavailable" role="status">
          {LIST_COPY.draftsUnavailable}
        </p>
      ) : null}
    </section>
  )
}

function SessionLost() {
  const copy = readFailureCopy('session-lost')
  return (
    <div className="wiki-session-lost" data-testid="wiki-list-session-lost" role="status">
      <h3>{copy.headline}</h3>
      <p>{copy.detail}</p>
      <a href={wikiSignInUrl(null)}>{LIST_COPY.signIn}</a>
    </div>
  )
}

function ListFailure({failure, onRetry}: {readonly failure: ReadFailureCopyKey; readonly onRetry: () => void}) {
  const copy = readFailureCopy(failure)
  const testId = failure === 'unavailable' ? 'wiki-list-unavailable' : 'wiki-list-error'
  return (
    <div className="wiki-list-failure" data-testid={testId} data-failure={failure} role="alert">
      <h3>{copy.headline}</h3>
      <p>{copy.detail}</p>
      {isRetryable(failure) ? (
        <button type="button" onClick={onRetry}>
          {LIST_COPY.retry}
        </button>
      ) : null}
    </div>
  )
}

function PageGroups({
  pages,
  draftIds,
  open,
}: {
  readonly pages: readonly WikiPageSummary[]
  readonly draftIds: ReadonlySet<string>
  readonly open: (pageId: string) => (event: MouseEvent) => void
}) {
  return (
    <div className="wiki-groups">
      {WIKI_PAGE_TYPES.map((type: WikiPageType) => {
        const group = pages.filter(page => page.type === type)
        if (group.length === 0) return null
        const headingId = `wiki-group-${type}`
        return (
          <section key={type} className="wiki-group" data-testid="wiki-group" data-type={type} aria-labelledby={headingId}>
            <h3 id={headingId}>{PAGE_TYPE_LABEL[type]}</h3>
            <ul className="wiki-page-list">
              {group.map(page => (
                <li key={page.id} className="wiki-page-row" data-page-id={page.id}>
                  <a className="wiki-page-link" href={wikiPagePath(page.id) ?? undefined} onClick={open(page.id)}>
                    {page.title}
                  </a>
                  {page.updated === null ? (
                    <span className="wiki-page-updated wiki-page-no-date">{LIST_COPY.noDate}</span>
                  ) : (
                    <span className="wiki-page-updated">
                      {LIST_COPY.updatedLabel} <time dateTime={page.updated}>{page.updated}</time>
                    </span>
                  )}
                  {draftIds.has(page.id) ? (
                    <span
                      className="wiki-draft-marker"
                      data-testid="wiki-draft-marker"
                      title={LIST_COPY.draftMarkerDetail}
                    >
                      {LIST_COPY.draftMarker}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function OrphanedDrafts({
  drafts,
  open,
}: {
  readonly drafts: readonly DraftRecord[]
  readonly open: (pageId: string) => (event: MouseEvent) => void
}) {
  if (drafts.length === 0) return null
  return (
    <section
      className="wiki-orphans"
      data-testid="wiki-orphaned-drafts"
      aria-labelledby="wiki-orphans-heading"
    >
      <h3 id="wiki-orphans-heading">{LIST_COPY.orphanHeading}</h3>
      <p>{LIST_COPY.orphanDetail}</p>
      <ul className="wiki-orphan-list">
        {drafts.map(draft => (
          <li key={draft.pageId} className="wiki-orphan-row" data-page-id={draft.pageId}>
            <span className="wiki-orphan-id">{draft.pageId}</span>
            <span className="wiki-orphan-saved">
              {LIST_COPY.orphanSaved} <time dateTime={formatDraftDate(draft.updatedAt)}>{formatDraftDate(draft.updatedAt)}</time>
            </span>
            {/* A draft whose ID fails the shape check has no route to open; it is listed and left alone. */}
            {wikiPagePath(draft.pageId) === null ? null : (
              <a className="wiki-orphan-open" href={wikiPagePath(draft.pageId) ?? undefined} onClick={open(draft.pageId)}>
                {LIST_COPY.orphanOpen}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
