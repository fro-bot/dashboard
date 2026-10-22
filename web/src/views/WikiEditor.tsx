/**
 * Wiki page view. Read-only in this unit; the editor itself arrives later.
 *
 * Shows one page by ID: the body as plain text (raw Markdown in a `<pre>`, never rendered
 * and never injected as markup) and its corrections. A page the server does not know is
 * either an orphaned draft (a local draft exists for the ID: shown read-only with Copy and
 * Discard) or a not-found state. Neither is ever a blank page.
 *
 * Markup only: real headings, lists, buttons and links, `role` live regions, and stable
 * class names and `data-*` hooks for the later visual pass. `data-state` on the root names
 * the current state.
 */

import {type MouseEvent, useEffect, useState} from 'react'
import {getWikiPage, type WikiCorrection, type WikiPage} from '../api/wiki.ts'
import {
  canWriteReasonCopy,
  CORRECTION_STATUS_LABEL,
  isRetryable,
  ORPHAN_COPY,
  PAGE_COPY,
  PAGE_TYPE_LABEL,
  readFailureCopy,
  type ReadFailureCopyKey,
} from '../wiki/copy.ts'
import type {DraftRecord, DraftStore} from '../wiki/drafts.ts'
import {isPlainClick, WIKI_LIST_URL} from '../wiki/location.ts'
import {clearWikiSignInGuard, navigateToWikiSignIn, wikiSignInUrl} from '../wiki/session-recovery.ts'
import {sharedDraftStore} from '../wiki/shared-store.ts'

export interface WikiEditorProps {
  readonly pageId: string
  /** Return to the page list. */
  readonly onBackToList: () => void
  /** The local draft store. Defaults to the shared one; tests pass their own. */
  readonly draftStore?: DraftStore
}

type PageState =
  | {readonly kind: 'loading'}
  | {readonly kind: 'ready'; readonly page: WikiPage}
  /** `draftUnreadable`: a draft record exists for this ID but fails validation. It is left in place. */
  | {readonly kind: 'not-found'; readonly draftUnreadable: boolean}
  | {readonly kind: 'orphaned-draft'; readonly draft: DraftRecord}
  | {readonly kind: 'failed'; readonly failure: ReadFailureCopyKey}

export function WikiEditor({pageId, onBackToList, draftStore}: WikiEditorProps) {
  const [state, setState] = useState<PageState>({kind: 'loading'})
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const store = draftStore ?? sharedDraftStore()

    setState({kind: 'loading'})

    void (async () => {
      const result = await getWikiPage(pageId)
      if (cancelled) return

      if (result.ok) {
        clearWikiSignInGuard()
        setState({kind: 'ready', page: result.value})
        return
      }
      if (result.error.kind !== 'not-found') {
        setState({kind: 'failed', failure: result.error.kind})
        return
      }

      // The server does not know this page. A local draft for the ID is an orphan, and it is shown.
      const draft = await store.getDraft(pageId)
      if (cancelled) return
      if (draft.ok && draft.value !== null) setState({kind: 'orphaned-draft', draft: draft.value})
      else {
        const unreadable = !draft.ok && (draft.error.kind === 'unreadable' || draft.error.kind === 'failed')
        setState({kind: 'not-found', draftUnreadable: unreadable})
      }
    })()

    return () => {
      cancelled = true
    }
  }, [pageId, attempt, draftStore])

  const sessionLost = state.kind === 'failed' && state.failure === 'session-lost'

  useEffect(() => {
    if (sessionLost) navigateToWikiSignIn(pageId)
  }, [sessionLost, pageId])

  const stateName = state.kind === 'failed' ? (sessionLost ? 'session-lost' : 'error') : state.kind

  return (
    <section className="wiki-page" data-testid="wiki-page" data-page-id={pageId} data-state={stateName}>
      <p className="wiki-page-nav">
        <a
          className="wiki-back"
          href={WIKI_LIST_URL}
          onClick={(event: MouseEvent) => {
            // A plain click is handled in the app; a modified click is the browser's (new tab, new window).
            if (!isPlainClick(event)) return
            event.preventDefault()
            onBackToList()
          }}
        >
          {PAGE_COPY.back}
        </a>
      </p>

      {state.kind === 'loading' ? (
        <p className="wiki-page-loading" data-testid="wiki-page-loading" role="status">
          {PAGE_COPY.loading}
        </p>
      ) : null}

      {state.kind === 'ready' ? <PageBody page={state.page} /> : null}

      {state.kind === 'not-found' ? <NotFound draftUnreadable={state.draftUnreadable} /> : null}

      {state.kind === 'orphaned-draft' ? (
        <OrphanedDraft draft={state.draft} store={draftStore ?? sharedDraftStore()} />
      ) : null}

      {sessionLost ? <SessionLost pageId={pageId} /> : null}

      {state.kind === 'failed' && !sessionLost ? (
        <PageFailure
          failure={state.failure}
          onRetry={() => {
            setAttempt(n => n + 1)
          }}
        />
      ) : null}
    </section>
  )
}

function PageBody({page}: {readonly page: WikiPage}) {
  return (
    <article className="wiki-page-content">
      <h2 className="wiki-page-title">{page.title}</h2>
      <p className="wiki-page-meta" data-testid="wiki-page-meta">
        <span className="wiki-page-type">{PAGE_TYPE_LABEL[page.type]}</span>{' '}
        {page.updated === null ? null : (
          <span className="wiki-page-updated">
            <time dateTime={page.updated}>{page.updated}</time>
          </span>
        )}
      </p>

      {page.canWrite ? null : (
        <p className="wiki-note wiki-write-notice" data-testid="wiki-write-notice" role="status">
          {canWriteReasonCopy(page.canWriteReason)}
        </p>
      )}

      <section className="wiki-page-text" aria-labelledby="wiki-page-text-heading">
        <h3 id="wiki-page-text-heading">{PAGE_COPY.bodyHeading}</h3>
        <p className="wiki-page-text-note">{PAGE_COPY.bodyNote}</p>
        <pre className="wiki-page-body" data-testid="wiki-page-body">
          {page.body}
        </pre>
      </section>

      <Corrections corrections={page.corrections} />
    </article>
  )
}

function Corrections({corrections}: {readonly corrections: readonly WikiCorrection[]}) {
  return (
    <section
      className="wiki-corrections"
      data-testid="wiki-corrections"
      aria-labelledby="wiki-corrections-heading"
    >
      <h3 id="wiki-corrections-heading">{PAGE_COPY.correctionsHeading}</h3>
      {corrections.length === 0 ? (
        <p className="wiki-corrections-empty">{PAGE_COPY.noCorrections}</p>
      ) : (
        <ul className="wiki-correction-list">
          {corrections.map(correction => (
            <li
              key={correction.id}
              className="wiki-correction"
              data-correction-id={correction.id}
              data-status={correction.status}
            >
              <p className="wiki-correction-status">
                <span className="wiki-correction-status-label">{CORRECTION_STATUS_LABEL[correction.status]}</span>
                {correction.stale ? (
                  <>
                    {' '}
                    <span className="wiki-correction-stale">{PAGE_COPY.stale}</span>
                  </>
                ) : null}
              </p>
              <p className="wiki-correction-span">
                <span className="wiki-label">{PAGE_COPY.spanLabel}: </span>
                <q>{correction.span.text}</q>
              </p>
              {correction.reason === null ? null : (
                <p className="wiki-correction-reason">
                  <span className="wiki-label">{PAGE_COPY.reasonLabel}: </span>
                  {correction.reason}
                </p>
              )}
              {correction.attribution === null ? null : (
                <p className="wiki-correction-attribution">
                  <span className="wiki-label">{PAGE_COPY.recordedLabel}: </span>
                  {correction.attribution.actor}, <time dateTime={correction.attribution.recordedAt}>{correction.attribution.recordedAt}</time>
                </p>
              )}
              {correction.supersededBy === null ? null : (
                <p className="wiki-correction-superseded-by">
                  <span className="wiki-label">{PAGE_COPY.supersededByLabel}: </span>
                  {correction.supersededBy}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function NotFound({draftUnreadable}: {readonly draftUnreadable: boolean}) {
  return (
    <div className="wiki-page-not-found" data-testid="wiki-page-not-found">
      <h2>{PAGE_COPY.notFoundHeadline}</h2>
      <p>{PAGE_COPY.notFoundDetail}</p>
      {draftUnreadable ? (
        <p className="wiki-note" data-testid="wiki-page-draft-unreadable" role="status">
          {ORPHAN_COPY.loadFailed}
        </p>
      ) : null}
    </div>
  )
}

function SessionLost({pageId}: {readonly pageId: string}) {
  const copy = readFailureCopy('session-lost')
  return (
    <div className="wiki-session-lost" data-testid="wiki-page-session-lost" role="status">
      <h2>{copy.headline}</h2>
      <p>{copy.detail}</p>
      <a href={wikiSignInUrl(pageId)}>{PAGE_COPY.signIn}</a>
    </div>
  )
}

function PageFailure({failure, onRetry}: {readonly failure: ReadFailureCopyKey; readonly onRetry: () => void}) {
  const copy = readFailureCopy(failure)
  return (
    <div className="wiki-page-failure" data-testid="wiki-page-error" data-failure={failure} role="alert">
      <h2>{copy.headline}</h2>
      <p>{copy.detail}</p>
      {isRetryable(failure) ? (
        <button type="button" onClick={onRetry}>
          {PAGE_COPY.retry}
        </button>
      ) : null}
    </div>
  )
}

type DraftStatus = 'copied' | 'copy-failed' | 'discarded' | 'discard-failed' | null

const DRAFT_STATUS_COPY: Readonly<Record<Exclude<DraftStatus, null>, string>> = {
  copied: ORPHAN_COPY.copied,
  'copy-failed': ORPHAN_COPY.copyFailed,
  discarded: ORPHAN_COPY.discarded,
  'discard-failed': ORPHAN_COPY.discardFailed,
}

function OrphanedDraft({draft, store}: {readonly draft: DraftRecord; readonly store: DraftStore}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [discarded, setDiscarded] = useState(false)
  const [status, setStatus] = useState<DraftStatus>(null)

  const copy = async () => {
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new TypeError('no clipboard')
      await navigator.clipboard.writeText(draft.draftText)
      setStatus('copied')
    } catch {
      setStatus('copy-failed')
    }
  }

  const discard = async () => {
    if (busy) return
    setBusy(true)
    const result = await store.deleteDraft(draft.pageId)
    setBusy(false)
    setConfirming(false)
    if (result.ok) {
      setDiscarded(true)
      setStatus('discarded')
    } else {
      setStatus('discard-failed')
    }
  }

  return (
    <div className="wiki-orphaned-draft" data-testid="wiki-orphaned-draft">
      <h2>{ORPHAN_COPY.heading}</h2>
      <p className="wiki-orphaned-draft-id">{draft.pageId}</p>
      <p>{ORPHAN_COPY.detail}</p>

      {discarded ? null : (
        <>
          <section aria-labelledby="wiki-orphaned-draft-text-heading">
            <h3 id="wiki-orphaned-draft-text-heading">{ORPHAN_COPY.textHeading}</h3>
            <pre className="wiki-page-body wiki-orphaned-draft-text" data-testid="wiki-orphaned-draft-text">
              {draft.draftText}
            </pre>
          </section>

          <div className="wiki-orphaned-draft-actions">
            <button type="button" className="wiki-copy" onClick={() => void copy()}>
              {ORPHAN_COPY.copy}
            </button>
            <button
              type="button"
              className="wiki-discard"
              onClick={() => {
                setConfirming(true)
                setStatus(null)
              }}
              disabled={confirming}
            >
              {ORPHAN_COPY.discard}
            </button>
          </div>

          {confirming ? (
            <div
              className="wiki-discard-confirm"
              data-testid="wiki-orphaned-draft-confirm"
              role="group"
              aria-labelledby="wiki-discard-confirm-heading"
            >
              <h3 id="wiki-discard-confirm-heading">{ORPHAN_COPY.discardConfirmHeading}</h3>
              <p>{ORPHAN_COPY.discardConfirmDetail}</p>
              <button type="button" className="wiki-discard-confirm-yes" onClick={() => void discard()} disabled={busy}>
                {ORPHAN_COPY.discardConfirm}
              </button>
              <button
                type="button"
                className="wiki-discard-confirm-no"
                onClick={() => {
                  setConfirming(false)
                }}
                disabled={busy}
              >
                {ORPHAN_COPY.discardCancel}
              </button>
            </div>
          ) : null}
        </>
      )}

      {status === null ? null : (
        <p className="wiki-orphaned-draft-status" data-testid="wiki-orphaned-draft-status" role="status">
          {DRAFT_STATUS_COPY[status]}
        </p>
      )}
    </div>
  )
}
