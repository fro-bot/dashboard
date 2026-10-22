/**
 * Wiki page: the shell around one page's edit session.
 *
 * Opens a page by ID. The page, the branch promotion status and (once the page is known) the
 * local draft are each read once; none holds up another. A page that loads is handed to
 * `WikiEditSession`, which shows the body as plain text (raw Markdown in a `<pre>`, never
 * rendered and never injected as markup), its corrections, and the edit and save lifecycle.
 * A page the server does not know is either an orphaned draft (a local draft exists for the
 * ID: shown read-only with Copy and Discard) or a not-found state. Neither is ever a blank page.
 *
 * Markup only: real headings, lists, buttons and links, `role` live regions, and stable
 * class names and `data-*` hooks for the later visual pass. `data-state` on the root names
 * the current state.
 */

import {type MouseEvent, useEffect, useRef, useState} from 'react'
import {getWikiPage, promotionStatus, type WikiPage} from '../api/wiki.ts'
import {
  isRetryable,
  ORPHAN_COPY,
  PAGE_COPY,
  readFailureCopy,
  type ReadFailureCopyKey,
} from '../wiki/copy.ts'
import type {DraftRecord, DraftResult, DraftStore} from '../wiki/drafts.ts'
import {isPlainClick, WIKI_LIST_URL} from '../wiki/location.ts'
import {clearWikiSignInGuard, navigateToWikiSignIn, wikiSignInUrl} from '../wiki/session-recovery.ts'
import {sharedDraftStore} from '../wiki/shared-store.ts'
import {type OpenPromotion, WikiEditSession} from './WikiEditSession.tsx'

export interface WikiEditorProps {
  readonly pageId: string
  /** Return to the page list. */
  readonly onBackToList: () => void
  /** The local draft store. Defaults to the shared one; tests pass their own. */
  readonly draftStore?: DraftStore
}

type PageState =
  | {readonly kind: 'loading'}
  /**
   * `draft`: the local draft for this page, if any. `draftUnreadable`: one exists but fails validation.
   * `draftReadFailed`: the read itself failed, so a draft may exist that the editor has not seen.
   */
  | {
    readonly kind: 'ready'
    readonly page: WikiPage
    readonly draft: DraftRecord | null
    readonly draftUnreadable: boolean
    readonly draftReadFailed: boolean
  }
  /** `draftUnreadable`: a draft record exists for this ID but fails validation. It is left in place. */
  | {readonly kind: 'not-found'; readonly draftUnreadable: boolean}
  | {readonly kind: 'orphaned-draft'; readonly draft: DraftRecord}
  | {readonly kind: 'failed'; readonly failure: ReadFailureCopyKey}

/**
 * Why a draft read did not give a draft. `unreadable`: a record exists but fails validation.
 * `failed`: the read itself failed (a store error, quota, or an open that errored, was blocked or
 * timed out), so nothing is known about the record.
 * A store that is missing (`unavailable`) holds no draft, so it is not a problem here.
 */
function draftReadProblem(result: DraftResult<DraftRecord | null>): 'unreadable' | 'failed' | null {
  if (result.ok) return null
  if (result.error.kind === 'unreadable') return 'unreadable'
  const {kind} = result.error
  return kind === 'failed' || kind === 'quota' || kind === 'open-failed' ? 'failed' : null
}

export function WikiEditor({pageId, onBackToList, draftStore}: WikiEditorProps) {
  const [state, setState] = useState<PageState>({kind: 'loading'})
  const [attempt, setAttempt] = useState(0)
  const [promotion, setPromotion] = useState<OpenPromotion>({kind: 'loading'})
  const [refresh, setRefresh] = useState({refreshing: false, failed: false})
  /** Bumped when the page being shown changes, so a late answer for an earlier one is dropped. */
  const epochRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const store = draftStore ?? sharedDraftStore()
    epochRef.current += 1

    setState({kind: 'loading'})
    setPromotion({kind: 'loading'})
    setRefresh({refreshing: false, failed: false})

    // The branch promotion status is read once, beside the page. A failed read is a note.
    void (async () => {
      const result = await promotionStatus()
      if (cancelled) return
      setPromotion(result.ok ? {kind: 'ready', status: result.value} : {kind: 'unavailable'})
    })()

    void (async () => {
      const result = await getWikiPage(pageId)
      if (cancelled) return

      if (result.ok) {
        clearWikiSignInGuard()
        const draft = await store.getDraft(pageId)
        if (cancelled) return
        const problem = draftReadProblem(draft)
        setState({
          kind: 'ready',
          page: result.value,
          draft: draft.ok ? draft.value : null,
          draftUnreadable: problem === 'unreadable',
          draftReadFailed: problem === 'failed',
        })
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
      else setState({kind: 'not-found', draftUnreadable: draftReadProblem(draft) !== null})
    })()

    return () => {
      cancelled = true
    }
  }, [pageId, attempt, draftStore])

  // After a save the page changed on the server. Read it again, quietly, so a later edit starts
  // from the new version.
  const refreshPage = () => {
    const epoch = epochRef.current
    setRefresh({refreshing: true, failed: false})
    void (async () => {
      const result = await getWikiPage(pageId)
      if (epochRef.current !== epoch) return
      if (result.ok) {
        setState(current => (current.kind === 'ready' ? {...current, page: result.value} : current))
        setRefresh({refreshing: false, failed: false})
      } else {
        setRefresh({refreshing: false, failed: true})
      }
    })()
  }

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

      {state.kind === 'ready' ? (
        <WikiEditSession
          key={`${pageId}:${attempt}`}
          page={state.page}
          draft={state.draft}
          draftUnreadable={state.draftUnreadable}
          draftReadFailed={state.draftReadFailed}
          store={draftStore ?? sharedDraftStore()}
          openPromotion={promotion}
          refreshing={refresh.refreshing}
          refreshFailed={refresh.failed}
          onRefresh={refreshPage}
          onReload={() => {
            setAttempt(n => n + 1)
          }}
        />
      ) : null}

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
