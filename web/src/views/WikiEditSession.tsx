/**
 * The edit session for one wiki page: view, edit, save, and every outcome.
 *
 * Markup only: real headings, buttons, a labelled text area, `role="status"` for the polite
 * announcements and `role="alert"` for blocking errors only, and stable class names and
 * `data-*` hooks for the later visual pass. No styling lives here.
 *
 * The lifecycle is the plan's save state diagram (see `outcomes.ts` for the display of each
 * outcome). Rules that hold across every state:
 *   - Editing is explicit, and the draft is the working copy. It is written to the local
 *     draft store on a short debounce, and a failed write never blocks editing.
 *   - A save mints a new operation ID, stores it as pending in the draft, and only then
 *     sends. A save with an unknown outcome is never retried. "Check save status" asks the
 *     server once per click, and the same check runs once when the page reopens.
 *   - A response whose operation is no longer current changes nothing.
 *   - Every state has a visible way forward: a button, a link, or Cancel.
 */

import {useEffect, useMemo, useRef, useState} from 'react'
import {
  getWikiPage,
  lookupWikiOperation,
  retryPromotionDispatch,
  saveWikiPage,
  type GateFinding,
  type PromotionStatus,
  type WikiCorrection,
  type WikiPage,
} from '../api/wiki.ts'
import {
  canWriteReasonCopy,
  CORRECTIONS_COPY,
  EDITOR_COPY,
  MARK_COPY,
  PAGE_COPY,
  PAGE_TYPE_LABEL,
  UNMARKED_COPY,
} from '../wiki/copy.ts'
import {
  sendWithPendingOperation,
  type CorrectionsBase,
  type DraftInput,
  type DraftRecord,
  type DraftResult,
  type DraftStore,
} from '../wiki/drafts.ts'
import {DRAFT_DEBOUNCE_MS} from '../wiki/editor-timing.ts'
import {
  createMark,
  keepMark,
  locateMark,
  markState,
  rebaseAndLimit,
  type EditHint,
  removeMark,
  saveMarksOf,
  type Mark,
  type MarkRefusal,
} from '../wiki/marks.ts'
import type {MergeOutput} from '../wiki/merge.ts'
import {confirmLeaveWiki, registerNavigationGuard} from '../wiki/navigation-guard.ts'
import {
  describeDispatchFailure,
  describeLookup,
  describePreSendFailure,
  describePromotion,
  describeSaveResult,
  OUTCOME_COPY,
  PROMOTION_OUTCOME_COPY,
  type OutcomeAction,
  type OutcomeDisplay,
} from '../wiki/outcomes.ts'
import {remapMarks} from '../wiki/remap-marks.ts'
import {wikiSignInUrl} from '../wiki/session-recovery.ts'
import {
  reconcileStaged,
  stageAction,
  transitionsOf,
  undoStaged,
  type StagedAction,
  type StagedKind,
  stagingFull,
} from '../wiki/staged.ts'
import {checkUnmarkedChanges} from '../wiki/unmarked.ts'
import {usePromotionPolling} from '../wiki/use-promotion-polling.ts'
import {PromotionBanner} from './PromotionBanner.tsx'
import {WikiCorrections} from './WikiCorrections.tsx'
import {WikiMerge} from './WikiMerge.tsx'

/** The gate's finding for a marked correction that is no longer in the page. Its target is the correction ID. */
const ERODED_FINDING = 'correction-eroded'

export type OpenPromotion =
  | {readonly kind: 'loading'}
  | {readonly kind: 'ready'; readonly status: PromotionStatus}
  | {readonly kind: 'unavailable'}

export interface WikiEditSessionProps {
  readonly page: WikiPage
  /** The local draft found when the page opened, or null. */
  readonly draft: DraftRecord | null
  /**
   * A draft record exists for this page but fails validation. It is left in place until the
   * operator discards it or their first edit replaces it.
   */
  readonly draftUnreadable: boolean
  /**
   * Reading the draft failed, so a record may exist that was never seen. Nothing is written
   * or deleted for this page while the editor is open, so that record is not overwritten.
   */
  readonly draftReadFailed: boolean
  readonly store: DraftStore
  readonly openPromotion: OpenPromotion
  /** The shell is re-reading the page after a save, so its blob is not yet current. */
  readonly refreshing: boolean
  readonly refreshFailed: boolean
  /** The page changed on the server. Read it again, quietly. */
  readonly onRefresh: () => void
  /** Read the page again from the start. */
  readonly onReload: () => void
}

// ---------------------------------------------------------------------------
// Working copy
// ---------------------------------------------------------------------------

/** The page version a draft started from. */
interface Base {
  readonly blobSha: string
  readonly text: string
  readonly correctionsBase: CorrectionsBase
}

/** A save whose outcome is not known. The lookup resolves it. */
interface UnknownOperation {
  readonly operationId: string
  /** When the request was sent, in ms since the epoch. The lookup passes it as `startedAt`. */
  readonly sentAt: number
  /** Whether the request carried a changed body, as it was sent. A save of staged actions alone does not. */
  readonly bodyChanged: boolean
  /** False when the draft store could not hold the record, so only this session can resolve it. */
  readonly persisted: boolean
}

interface Doc {
  readonly text: string
  readonly base: Base
  /** The spans marked as corrections in `text`. */
  readonly marks: readonly Mark[]
  /** Correction actions to commit with the next save. */
  readonly staged: readonly StagedAction[]
  readonly unknownOp: UnknownOperation | null
}

function docFromDraft(draft: DraftRecord): Doc {
  return {
    text: draft.draftText,
    base: {
      blobSha: draft.baseBlobSha,
      text: draft.baseText,
      correctionsBase: draft.correctionsBase,
    },
    marks: draft.marks,
    staged: draft.staged,
    unknownOp:
      draft.pending === null
        ? null
        : {
            operationId: draft.pending.operationId,
            sentAt: draft.pending.sentAt,
            bodyChanged: draft.pending.bodyChanged,
            persisted: true,
          },
  }
}

function docFromPage(page: WikiPage): Doc {
  return {
    text: page.body,
    base: {
      blobSha: page.pageBlobSha,
      text: page.body,
      correctionsBase: {entries: page.corrections, digest: page.correctionsBase},
    },
    marks: [],
    staged: [],
    unknownOp: null,
  }
}

/** The draft holds work the wiki does not have yet, other than an unconfirmed save. */
function hasWork(doc: Doc): boolean {
  return doc.text !== doc.base.text || doc.marks.length > 0 || doc.staged.length > 0
}

const WRITES_WITHHELD: DraftResult<never> = {ok: false, error: {kind: 'unavailable'}}

/**
 * The store with every write turned into `unavailable`. The editor already copes with a store
 * that cannot write: edits stay in the session, the guard says they are not stored, and a save
 * is sent without a pending record.
 */
function withheldWrites(store: DraftStore): DraftStore {
  return {
    now: store.now,
    getDraft: store.getDraft,
    listDrafts: store.listDrafts,
    putDraft: async () => WRITES_WITHHELD,
    deleteDraft: async () => WRITES_WITHHELD,
    deleteUnreadableDraft: async () => WRITES_WITHHELD,
    markPendingUnknown: async () => WRITES_WITHHELD,
    clearPendingOperation: async () => WRITES_WITHHELD,
  }
}

/**
 * The stored record is this save's: it carries this operation, or it holds the base and text
 * this tab sent. Another tab's draft for the same page is neither.
 */
function belongsToSave(record: DraftRecord, operationId: string, sent: Doc): boolean {
  return (
    record.pending?.operationId === operationId ||
    (record.baseBlobSha === sent.base.blobSha && record.draftText === sent.text)
  )
}

function draftInputOf(pageId: string, doc: Doc): DraftInput {
  return {
    pageId,
    baseBlobSha: doc.base.blobSha,
    baseText: doc.base.text,
    correctionsBase: doc.base.correctionsBase,
    draftText: doc.text,
    marks: doc.marks,
    staged: doc.staged,
    pending:
      doc.unknownOp === null || !doc.unknownOp.persisted
        ? null
        : {
            operationId: doc.unknownOp.operationId,
            sentAt: doc.unknownOp.sentAt,
            bodyChanged: doc.unknownOp.bodyChanged,
            state: 'unknown',
          },
  }
}

/** State that the async handlers also need the latest value of. */
function useLatestState<T>(initial: T) {
  const [value, setValue] = useState<T>(initial)
  const ref = useRef<T>(value)
  const set = (next: T | ((previous: T) => T)) => {
    ref.current = typeof next === 'function' ? (next as (previous: T) => T)(ref.current) : next
    setValue(ref.current)
  }
  return [value, set, ref] as const
}

const shortVersion = (sha: string) => sha.slice(0, 7)

/**
 * What the browser says about an input event: where the caret is after it, and how much text it
 * inserted. Typing, composition and line breaks say; a paste, a drop and an undo do not.
 */
function editHintOf(native: Event, caret: number): EditHint {
  const {data, inputType} = native as Partial<InputEvent>
  if (typeof data === 'string') return {caret, inserted: data.length}
  if (typeof inputType === 'string' && inputType.startsWith('delete')) return {caret, inserted: 0}
  if (inputType === 'insertLineBreak') return {caret, inserted: 1}
  return {caret}
}

/** A time a Date cannot hold has no ISO form, and `toISOString` would throw on it. */
function isoOrUndefined(ms: number): string | undefined {
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * What a confirmation is recorded against: the base the draft started from (blob, text and
 * corrections base) and the draft text. Any change to either makes it a different snapshot.
 */
interface Snapshot {
  readonly blobSha: string
  readonly baseText: string
  readonly digest: string
  readonly text: string
  /** The marked spans, so removing a mark makes it a different snapshot. */
  readonly marks: string
}

function snapshotOf(doc: Doc): Snapshot {
  return {
    blobSha: doc.base.blobSha,
    baseText: doc.base.text,
    digest: doc.base.correctionsBase.digest,
    text: doc.text,
    marks: JSON.stringify(saveMarksOf(doc.text, doc.marks)),
  }
}

function sameSnapshot(a: Snapshot | null, b: Snapshot | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.blobSha === b.blobSha &&
    a.baseText === b.baseText &&
    a.digest === b.digest &&
    a.text === b.text &&
    a.marks === b.marks
  )
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

type Mode = 'viewing' | 'editing' | 'conflict'
type Phase = 'idle' | 'saving' | 'checking'
type Note = 'kept' | 'kept-failed' | 'discard-kept-stored' | 'rebased' | 'merged' | null

function droppedNoticeFor(count: number): string | null {
  if (count === 0) return null
  return count === 1 ? CORRECTIONS_COPY.stagedDroppedOne : CORRECTIONS_COPY.stagedDroppedMany(count)
}

const MARK_REFUSAL_COPY: Readonly<Record<MarkRefusal, string>> = {
  empty: MARK_COPY.hint,
  'too-long': MARK_COPY.tooLong,
  'too-many': MARK_COPY.tooMany,
  duplicate: MARK_COPY.duplicate,
}

/** What the operator has been told about a draft record that could not be read. */
type UnreadableNotice = 'none' | 'present' | 'replaced' | 'resolved'

interface SavedBase {
  /** Passed to the status read: runs created before the commit are ignored. Undefined means no bound. */
  readonly since: string | undefined
}

/** The save was sent for publication. Promotion status is read while it is pending. */
interface PromotedState extends SavedBase {
  readonly kind: 'saved'
  readonly promotion: PromotionStatus | null
  readonly unavailable: boolean
  readonly polling: boolean
}

interface DispatchState {
  readonly dispatch:
    | {readonly kind: 'idle'}
    | {readonly kind: 'sending'}
    | {readonly kind: 'failed'; readonly message: string}
}

/** The commit landed but the publication request did not go out, or its result is unknown. */
interface NotPromotedState extends SavedBase, DispatchState {
  readonly kind: 'saved-not-promoted'
  /** The save was found by the lookup rather than seen. */
  readonly foundLate: boolean
}

type SavedState = PromotedState | NotPromotedState

type ConflictCurrent =
  | {readonly kind: 'loading'}
  | {readonly kind: 'ready'; readonly page: WikiPage}
  | {readonly kind: 'removed'}
  | {readonly kind: 'failed'}

interface ConflictState {
  readonly display: OutcomeDisplay
  /** The corrections as the server holds them now, for the corrections kind. */
  readonly corrections: {readonly current: readonly WikiCorrection[]; readonly digest: string} | null
  readonly current: ConflictCurrent
  readonly confirming: boolean
}

function unknownSaveDisplay(op: UnknownOperation): OutcomeDisplay {
  return describeSaveResult({ok: false, error: {kind: 'status-unknown', cause: 'indeterminate'}}, {persisted: op.persisted})
}

function announcementOf(display: OutcomeDisplay): string {
  // A blocking error is announced by its own alert. Announcing it twice would be noise.
  return display.urgency === 'alert' ? '' : display.headline
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WikiEditSession(props: WikiEditSessionProps) {
  const {page, draftUnreadable, draftReadFailed, openPromotion, refreshing, refreshFailed, onRefresh, onReload} = props
  const pageId = page.id
  const store = useMemo(
    () => (draftReadFailed ? withheldWrites(props.store) : props.store),
    [draftReadFailed, props.store],
  )

  const [initial] = useState(() => {
    const restored = page.canWrite && props.draft !== null ? docFromDraft(props.draft) : null
    // The page has been read again since the draft was stored. An action staged on a correction that
    // has gone, or changed, is dropped instead of being sent.
    const reconciled = restored === null ? null : reconcileStaged(restored.staged, page.corrections)
    const doc = restored === null || reconciled === null ? null : {...restored, staged: reconciled.kept}
    return {doc, unknownOp: doc?.unknownOp ?? null, dropped: reconciled?.dropped.length ?? 0}
  })

  const [doc, setDoc, docRef] = useLatestState<Doc | null>(initial.doc)
  const [mode, setMode] = useState<Mode>(initial.doc === null ? 'viewing' : 'editing')
  const [phase, setPhase] = useState<Phase>(initial.unknownOp === null ? 'idle' : 'checking')
  const [outcome, setOutcome] = useState<OutcomeDisplay | null>(
    initial.unknownOp === null ? null : unknownSaveDisplay(initial.unknownOp),
  )
  const [announcement, setAnnouncement] = useState('')
  const [localSaveFailed, setLocalSaveFailed] = useState(draftReadFailed)
  const [unreadable, setUnreadable] = useState<UnreadableNotice>(draftUnreadable ? 'present' : 'none')
  const [discardingUnreadable, setDiscardingUnreadable] = useState(false)
  const [unreadableStatus, setUnreadableStatus] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  /** How many marks the last merge flagged for review, for the note that follows it. */
  const [mergeFlagged, setMergeFlagged] = useState(0)
  const [saved, setSaved] = useState<SavedState | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelStatus, setCancelStatus] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  /** The unmarked-change confirmation is open for this snapshot, or null. */
  const [confirmOpen, setConfirmOpen] = useState<Snapshot | null>(null)
  /** The operator confirmed unmarked changes for this snapshot, or null. */
  const [confirmed, setConfirmed] = useState<Snapshot | null>(null)
  /** The open confirmation is for a change too large to check which parts are marked. */
  const [confirmUnavailable, setConfirmUnavailable] = useState(false)
  /** The corrections as the page last read them, or as a re-base found them. */
  const [corrections, setCorrections] = useState<readonly WikiCorrection[]>(page.corrections)
  const [droppedNotice, setDroppedNotice] = useState<string | null>(droppedNoticeFor(initial.dropped))
  /** The text area's selection, kept so the Mark as correction button follows it. */
  const [selection, setSelection] = useState({start: 0, end: 0})
  const [markStatus, setMarkStatus] = useState<string | null>(null)
  /** Said when an action could not be staged because the draft already holds as many as a save can carry. */
  const [stageStatus, setStageStatus] = useState<string | null>(null)

  const mountedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const confirmHeadingRef = useRef<HTMLHeadingElement | null>(null)
  /** The operation whose answer is awaited. Any other answer is stale. */
  const opRef = useRef<string | null>(null)
  const sendingRef = useRef(false)
  /** A merge is being applied: the draft is written before the conflict view goes. */
  const applyingMergeRef = useRef(false)
  const checkingRef = useRef(false)
  const openLookupRef = useRef(false)
  /** Bumped whenever the saved panel is replaced, so a late dispatch answer can be told apart. */
  const savedEpochRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // -------------------------------------------------------------------------
  // Draft store
  // -------------------------------------------------------------------------

  const clearTimer = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  /** The first write that goes through replaces a draft record that could not be read. */
  const noteUnreadableReplaced = () => {
    if (mountedRef.current) setUnreadable(current => (current === 'present' ? 'replaced' : current))
  }

  /**
   * Write the working copy to the draft store now. No changes and nothing pending means no
   * draft. One record per page is shared by every tab, so another tab's unknown-save marker is
   * kept (unless this tab abandons its own, `dropPending`), and a record is removed only when it
   * is empty. An unreadable record is replaced by the first write, never removed. Returns false
   * when the write was refused.
   */
  const persistNow = async (options?: {readonly dropPending?: boolean}): Promise<boolean> => {
    clearTimer()
    const current = docRef.current
    if (current === null) return true
    if (!hasWork(current) && current.unknownOp === null) {
      // Abandoning this tab's own unknown save removes its marker with the record. Otherwise another
      // tab's marker is not ours to delete.
      const result = await store.deleteDraft(
        pageId,
        {onlyIf: options?.dropPending === true ? () => true : record => record.pending === null},
      )
      return result.ok
    }
    const result = await store.putDraft(draftInputOf(pageId, current), {
      keepStoredPending: current.unknownOp === null && options?.dropPending !== true,
      replaceUnreadable: draftUnreadable,
    })
    if (mountedRef.current) setLocalSaveFailed(!result.ok)
    if (result.ok) noteUnreadableReplaced()
    return result.ok
  }

  const persistNowRef = useRef(persistNow)
  persistNowRef.current = persistNow

  // A pending debounce is written when the editor goes away.
  useEffect(
    () => () => {
      if (timerRef.current !== null) void persistNowRef.current()
    },
    [],
  )

  // A reload or a closing tab skips the unmount above, so a pending debounce is also written when
  // the page is hidden or put away. This narrows the window for losing the last keystrokes; the
  // browser does not promise an unload write finishes.
  useEffect(() => {
    const flush = () => {
      if (timerRef.current !== null) void persistNowRef.current()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const scheduleDraftWrite = () => {
    clearTimer()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void persistNowRef.current()
    }, DRAFT_DEBOUNCE_MS)
  }

  const onTextChange = (value: string, hint?: EditHint) => {
    // The marks follow the text through the edit. A mark that grew past the length limit is dropped,
    // so it never reaches the draft store or a save.
    const rebased = docRef.current === null ? null : rebaseAndLimit(docRef.current.marks, docRef.current.text, value, hint)
    setDoc(current => (current === null || rebased === null ? current : {...current, text: value, marks: rebased.marks}))
    setNote(null)
    setMarkStatus(rebased !== null && rebased.dropped > 0 ? MARK_COPY.grewTooLong : null)
    scheduleDraftWrite()
    syncSelection()
  }

  /** Change the marks or the staged actions of the draft. They are written like a text edit. */
  const changeWork = (change: (current: Doc) => Doc) => {
    setDoc(current => (current === null ? current : change(current)))
    setNote(null)
    scheduleDraftWrite()
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const hasUnknown = doc?.unknownOp != null
  const pendingWork = doc !== null && hasWork(doc)
  const dirty = pendingWork || hasUnknown
  const holding = dirty || phase === 'saving'
  const contractMismatch = !page.contract.ok && page.contract.kind === 'mismatch'
  const draftIsStale = doc !== null && doc.base.blobSha !== page.pageBlobSha

  // Each mark is settled, or Save waits: a flagged mark must be kept or removed, and a mark whose
  // text has left the draft must be removed.
  const markRows = useMemo(
    () => (doc === null ? [] : doc.marks.map(mark => ({mark, state: markState(doc.text, mark)}))),
    [doc],
  )
  const marksUnsettled = markRows.some(row => row.state !== 'ok')

  const saveBlocked =
    mode !== 'editing' ||
    phase !== 'idle' ||
    !pendingWork ||
    marksUnsettled ||
    hasUnknown ||
    contractMismatch ||
    (outcome?.saveDisabled ?? false)

  // The unmarked-change confirmation (U11). It is a record of one snapshot, so any change to the
  // base or the text clears it, and it is never carried back by editing to the same text again.
  const markable = page.canMark && page.nodeId !== null
  const snapshot = doc === null ? null : snapshotOf(doc)
  const confirmIsOpen = sameSnapshot(confirmOpen, snapshot)
  const alreadyConfirmed = sameSnapshot(confirmed, snapshot)
  const snapshotKey = snapshot === null ? null : JSON.stringify(snapshot)

  useEffect(() => {
    setConfirmOpen(current => (current !== null && !sameSnapshot(current, snapshot) ? null : current))
    setConfirmed(current => (current !== null && !sameSnapshot(current, snapshot) ? null : current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotKey])

  // Read the question out: focus goes to its heading when it opens.
  useEffect(() => {
    if (confirmIsOpen) confirmHeadingRef.current?.focus()
  }, [confirmIsOpen])

  // The navigation guard: held while there is work that the wiki does not have.
  useEffect(() => {
    if (!holding) return
    const message = hasUnknown
      ? EDITOR_COPY.guardUnknown
      : localSaveFailed
        ? EDITOR_COPY.guardNotStored
        : EDITOR_COPY.guardStored
    return registerNavigationGuard({pageId, message})
  }, [holding, hasUnknown, localSaveFailed, pageId])

  // Rejection: select the first finding that points at text the draft contains.
  const selectTarget = (target: string) => {
    const area = textareaRef.current
    if (area === null) return
    const index = area.value.indexOf(target)
    if (index < 0) return
    area.focus()
    area.setSelectionRange(index, index + target.length)
  }

  useEffect(() => {
    if (outcome?.kind !== 'rejected') return
    const first = outcome.findings.find(
      finding =>
        // An eroded-correction finding names a correction ID, not text of the page.
        finding.kind !== ERODED_FINDING &&
        finding.target !== undefined &&
        finding.target !== '' &&
        (textareaRef.current?.value.includes(finding.target) ?? false),
    )
    if (first?.target !== undefined) selectTarget(first.target)
  }, [outcome])

  // -------------------------------------------------------------------------
  // Marking
  // -------------------------------------------------------------------------

  /** Read the text area's selection. Called from every event that can change it. */
  const syncSelection = () => {
    const area = textareaRef.current
    if (area === null) return
    const next = {start: area.selectionStart, end: area.selectionEnd}
    setSelection(current => (current.start === next.start && current.end === next.end ? current : next))
  }
  const syncSelectionRef = useRef(syncSelection)
  syncSelectionRef.current = syncSelection

  // Keyboard, pointer and touch each change the selection by a different event, and the browser's
  // `select` event does not fire when a selection collapses. The button follows the live selection.
  const editingSurface = mode === 'editing' && doc !== null
  useEffect(() => {
    const area = textareaRef.current
    if (!editingSurface || area === null) return
    const sync = () => {
      syncSelectionRef.current()
    }
    // The document fires `selectionchange` for every selection on the page. Only the focused text
    // area's selection matters here, and dragging a touch selection handle fires nothing else.
    const syncFocused = () => {
      if (document.activeElement === area) sync()
    }
    const events = ['select', 'keyup', 'mouseup', 'touchend', 'focus', 'blur'] as const
    for (const name of events) area.addEventListener(name, sync)
    document.addEventListener('selectionchange', syncFocused)
    sync()
    return () => {
      for (const name of events) area.removeEventListener(name, sync)
      document.removeEventListener('selectionchange', syncFocused)
    }
  }, [editingSurface])

  const markingAvailable = markable && mode === 'editing' && phase === 'idle' && !hasUnknown
  const canMarkSelection = markingAvailable && selection.end > selection.start

  const markSelection = () => {
    const area = textareaRef.current
    const working = docRef.current
    if (area === null || working === null || !markingAvailable) return
    // The live selection decides, not the last one seen: it is what the operator is looking at.
    const result = createMark(working.text, {start: area.selectionStart, end: area.selectionEnd}, working.marks)
    if (!result.ok) {
      setMarkStatus(MARK_REFUSAL_COPY[result.reason])
      return
    }
    setMarkStatus(null)
    setAnnouncement(MARK_COPY.marked)
    changeWork(current => ({...current, marks: [...current.marks, result.mark]}))
  }

  const jumpToMark = (markId: string) => {
    const area = textareaRef.current
    const working = docRef.current
    const mark = working?.marks.find(item => item.id === markId)
    if (area === null || working === undefined || working === null || mark === undefined) return
    const range = locateMark(working.text, mark)
    if (range === null) return
    area.focus()
    area.setSelectionRange(range.start, range.end)
    syncSelection()
  }

  const dropMark = (markId: string) => {
    setAnnouncement(MARK_COPY.removed)
    changeWork(current => ({...current, marks: removeMark(current.marks, markId)}))
  }

  const confirmMark = (markId: string) => {
    setAnnouncement(MARK_COPY.kept)
    changeWork(current => ({...current, marks: keepMark(current.marks, markId, current.text)}))
  }

  // -------------------------------------------------------------------------
  // Staged correction actions
  // -------------------------------------------------------------------------

  const canStage = markable && mode === 'editing' && phase === 'idle' && !hasUnknown

  const stage = (correction: WikiCorrection, action: StagedKind) => {
    if (!canStage) return
    if (stagingFull(docRef.current?.staged ?? [], correction.id)) {
      setStageStatus(CORRECTIONS_COPY.stagingFull)
      return
    }
    setStageStatus(null)
    setDroppedNotice(null)
    changeWork(current => ({...current, staged: stageAction(current.staged, correction, action)}))
  }

  const undoStage = (correctionId: string) => {
    if (!canStage) return
    setStageStatus(null)
    changeWork(current => ({...current, staged: undoStaged(current.staged, correctionId)}))
  }

  /**
   * The corrections were read again: after the page reloads, or after a re-base. An action staged on a
   * correction that has gone or changed is dropped with a notice, never sent.
   */
  const refreshCorrections = (next: readonly WikiCorrection[], target: Doc | null = docRef.current): Doc | null => {
    setCorrections(next)
    if (target === null) return null
    const {kept, dropped} = reconcileStaged(target.staged, next)
    if (dropped.length === 0) return target
    setDroppedNotice(droppedNoticeFor(dropped.length))
    return {...target, staged: kept}
  }

  const seenCorrectionsRef = useRef(page.corrections)
  useEffect(() => {
    if (seenCorrectionsRef.current === page.corrections) return
    seenCorrectionsRef.current = page.corrections
    const next = refreshCorrections(page.corrections)
    if (next !== null && next !== docRef.current) {
      setDoc(next)
      scheduleDraftWrite()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.corrections])

  // -------------------------------------------------------------------------
  // Promotion polling (after a save)
  // -------------------------------------------------------------------------

  usePromotionPolling({
    active: saved?.kind === 'saved' && saved.polling,
    since: saved?.since,
    onStatus: status => {
      setSaved(current =>
        current?.kind === 'saved'
          ? {...current, promotion: status, unavailable: false, polling: status.state === 'pending'}
          : current,
      )
    },
    onUnavailable: () => {
      setSaved(current => (current?.kind === 'saved' ? {...current, unavailable: true} : current))
    },
  })

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  const startEditing = () => {
    setNote(null)
    setCancelOpen(false)
    setCancelStatus(null)
    if (docRef.current === null) setDoc(docFromPage(page))
    setMode('editing')
  }

  const cancel = () => {
    if (!dirty) {
      // Only an empty record is cleared. Another tab's draft or marker, and a record that could not
      // be read, are not ours to delete.
      void store.deleteDraft(pageId, {onlyIf: record => record.pending === null && record.draftText === record.baseText})
      setDoc(null)
      setOutcome(null)
      setMode('viewing')
      return
    }
    setCancelStatus(null)
    setCancelOpen(true)
  }

  const keepDraft = async () => {
    if (phase !== 'idle') return
    const stored = await persistNow()
    if (!mountedRef.current) return
    setCancelOpen(false)
    setNote(stored ? 'kept' : 'kept-failed')
    setMode('viewing')
  }

  const discardDraft = async () => {
    if (phase !== 'idle') return
    const result = await store.deleteDraft(pageId)
    if (!mountedRef.current) return
    if (!result.ok && result.error.kind !== 'unavailable') {
      setCancelStatus(EDITOR_COPY.discardFailed)
      return
    }
    clearTimer()
    setDoc(null)
    setCancelOpen(false)
    setCancelStatus(null)
    setOutcome(null)
    setConflict(null)
    // With the read failed, the stored draft was never touched: say it is still there.
    setNote(draftReadFailed ? 'discard-kept-stored' : null)
    setMode('viewing')
  }

  const discardUnreadable = async () => {
    if (phase !== 'idle') return
    const result = await store.deleteUnreadableDraft(pageId)
    if (!mountedRef.current) return
    setDiscardingUnreadable(false)
    if (result.ok) {
      // `readable`: another tab replaced the record since this tab read it, so it is not unreadable
      // any more and is left alone.
      setUnreadable('resolved')
      setUnreadableStatus(
        result.value === 'readable' ? EDITOR_COPY.unreadableAlreadyReplaced : EDITOR_COPY.discardUnreadableDone,
      )
    } else {
      setUnreadableStatus(EDITOR_COPY.discardUnreadableFailed)
    }
  }

  const copyDraft = async () => {
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new TypeError('no clipboard')
      await navigator.clipboard.writeText(docRef.current?.text ?? '')
      setCopyStatus(EDITOR_COPY.copied)
    } catch {
      setCopyStatus(EDITOR_COPY.copyFailed)
    }
  }

  // -------------------------------------------------------------------------
  // Conflict
  // -------------------------------------------------------------------------

  const loadCurrent = async () => {
    setConflict(current => (current === null ? current : {...current, current: {kind: 'loading'}}))
    const result = await getWikiPage(pageId)
    if (!mountedRef.current) return
    const next: ConflictCurrent = result.ok
      ? {kind: 'ready', page: result.value}
      : result.error.kind === 'not-found'
        ? {kind: 'removed'}
        : {kind: 'failed'}
    setConflict(current => (current === null ? current : {...current, current: next}))
  }

  const openConflict = (display: OutcomeDisplay, corrections: ConflictState['corrections']) => {
    setOutcome(null)
    setCopyStatus(null)
    setConflict({display, corrections, current: {kind: 'loading'}, confirming: false})
    setMode('conflict')
    void loadCurrent()
  }

  const leaveConflict = () => {
    const op = docRef.current?.unknownOp ?? null
    setConflict(null)
    setOutcome(op === null ? null : unknownSaveDisplay(op))
    setMode('editing')
  }

  const overwrite = async () => {
    const current = docRef.current
    if (conflict === null || conflict.current.kind !== 'ready' || current === null) return
    const latest = conflict.current.page
    const correctionsBase: CorrectionsBase =
      conflict.corrections === null
        ? {entries: latest.corrections, digest: latest.correctionsBase}
        : {entries: conflict.corrections.current, digest: conflict.corrections.digest}

    // The page blob and the corrections base are re-based together, and the draft record stores both.
    // The corrections just changed, so a staged action that no longer applies is dropped.
    const rebased: Doc = {
      ...current,
      base: {blobSha: latest.pageBlobSha, text: latest.body, correctionsBase},
      unknownOp: null,
    }
    setDoc(refreshCorrections(correctionsBase.entries, rebased) ?? rebased)
    await persistNow({dropPending: true})
    if (!mountedRef.current) return
    setConflict(null)
    setOutcome(null)
    setNote('rebased')
    setMode('editing')
  }

  /**
   * Use the merged text as the draft. The page base becomes the current blob and text, the corrections
   * base is read from the current page, and the marks are carried through the merge. The base changed,
   * so a recorded unmarked-change confirmation no longer applies.
   */
  const applyMerge = async (output: MergeOutput) => {
    // The conflict stays up until the write settles. A second press must not merge the merged marks again.
    if (applyingMergeRef.current) return
    const current = docRef.current
    if (conflict === null || conflict.current.kind !== 'ready' || current === null) return
    applyingMergeRef.current = true
    try {
      const latest = conflict.current.page
      const correctionsBase: CorrectionsBase = {entries: latest.corrections, digest: latest.correctionsBase}

      const marks = remapMarks(current.marks, current.text, output)
      const merged: Doc = {
        ...current,
        text: output.text,
        marks,
        base: {blobSha: latest.pageBlobSha, text: latest.body, correctionsBase},
        unknownOp: null,
      }
      setDoc(refreshCorrections(correctionsBase.entries, merged) ?? merged)
      setConfirmOpen(null)
      setConfirmed(null)
      setMergeFlagged(marks.filter((mark, index) => mark.needsReview && current.marks[index]?.needsReview === false).length)
      await persistNow({dropPending: true})
      if (!mountedRef.current) return
      setConflict(null)
      setOutcome(null)
      setNote('merged')
      setMode('editing')
    } finally {
      applyingMergeRef.current = false
    }
  }

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  const showOutcome = (display: OutcomeDisplay) => {
    setOutcome(display)
    setAnnouncement(announcementOf(display))
  }

  const save = async () => {
    const working = docRef.current
    if (working === null || sendingRef.current || saveBlocked) return

    sendingRef.current = true
    clearTimer()
    // Keep draft and Discard draft rewrite or delete the record this save is about to write.
    setCancelOpen(false)
    setCancelStatus(null)
    const operationId = crypto.randomUUID()
    opRef.current = operationId
    savedEpochRef.current += 1
    setSaved(null)
    setOutcome(null)
    setNote(null)
    setPhase('saving')
    setAnnouncement(EDITOR_COPY.savingAnnouncement)

    const startedAt = store.now()
    const sent = await sendWithPendingOperation(
      store,
      {
        draft: {...draftInputOf(pageId, working), pending: null},
        operationId,
        bodyChanged: working.text !== working.base.text,
        replaceUnreadable: draftUnreadable,
      },
      () =>
        saveWikiPage({
          pageId,
          operationId,
          pageBlobSha: working.base.blobSha,
          correctionsBase: working.base.correctionsBase.digest,
          body: working.text,
          marks: saveMarksOf(working.text, working.marks),
          transitions: transitionsOf(working.staged),
        }),
    )

    // A response for an operation that is no longer current changes nothing. The pending
    // operation stays in the draft store, so a reopen can still resolve it.
    if (!mountedRef.current || opRef.current !== operationId) return
    opRef.current = null
    sendingRef.current = false
    setPhase('idle')

    if (!sent.ok) {
      setLocalSaveFailed(true)
      showOutcome(describePreSendFailure())
      return
    }

    const {value: result, persisted} = sent
    const display = describeSaveResult(result, {persisted})
    if (persisted) noteUnreadableReplaced()

    if (result.ok) {
      setAnnouncement(announcementOf(display))
      // Another tab may have stored its own draft for this page meanwhile. Only this save's record goes.
      await store.deleteDraft(pageId, {onlyIf: record => belongsToSave(record, operationId, working)})
      if (!mountedRef.current) return
      savedEpochRef.current += 1
      setDoc(null)
      setConflict(null)
      setMode('viewing')
      const since = result.value.committedAt
      setSaved(
        result.value.state === 'saved'
          ? {kind: 'saved', since, promotion: null, unavailable: false, polling: true}
          : {kind: 'saved-not-promoted', since, dispatch: {kind: 'idle'}, foundLate: false},
      )
      onRefresh()
      return
    }

    setAnnouncement(announcementOf(display))

    if (display.draft === 'kept-with-pending') {
      const marked = persisted ? await store.markPendingUnknown(pageId) : null
      if (!mountedRef.current) return
      const sentAt = marked?.ok && marked.value.pending !== null ? marked.value.pending.sentAt : startedAt
      setDoc(current => (current === null ? current : {...current, unknownOp: {operationId, sentAt, bodyChanged: working.text !== working.base.text, persisted}}))
      setOutcome(display)
      return
    }

    // Nothing landed. The draft stays and the pending operation is settled.
    if (persisted) await store.clearPendingOperation(pageId)
    if (!mountedRef.current) return

    // A page or corrections conflict opens the comparison. A removed page has nothing to compare
    // with: the editor stays, Save is disabled, and the draft can be copied out.
    const {error} = result
    if (error.kind === 'conflict' && error.conflict.kind !== 'page-removed') {
      const {conflict: detail} = error
      openConflict(
        display,
        detail.kind === 'corrections' ? {current: detail.currentCorrections, digest: detail.correctionsBase} : null,
      )
      return
    }
    setOutcome(display)
  }

  // -------------------------------------------------------------------------
  // Check save status
  // -------------------------------------------------------------------------

  const checkStatus = async () => {
    const op = docRef.current?.unknownOp ?? null
    if (op === null || checkingRef.current) return

    checkingRef.current = true
    setPhase('checking')
    setAnnouncement(EDITOR_COPY.checkingAnnouncement)
    const result = await lookupWikiOperation({operationId: op.operationId, pageId, startedAt: op.sentAt})
    checkingRef.current = false

    if (!mountedRef.current) return
    if (docRef.current?.unknownOp?.operationId !== op.operationId) {
      // The operation was dropped while the lookup ran. Do not leave the editor waiting, unless a
      // newer save has taken over the phase.
      if (!sendingRef.current) setPhase('idle')
      return
    }
    setPhase('idle')

    const display = describeLookup(result)
    setAnnouncement(announcementOf(display))

    if (!result.ok) {
      setOutcome(display)
      return
    }

    switch (result.value.state) {
      case 'found': {
        const committedAt = result.value.committedAt
        const sentDoc = docRef.current
        await store.deleteDraft(pageId, {
          onlyIf: record => sentDoc !== null && belongsToSave(record, op.operationId, sentDoc),
        })
        if (!mountedRef.current) return
        savedEpochRef.current += 1
        setDoc(null)
        setOutcome(null)
        setConflict(null)
        setMode('viewing')
        setSaved({
          kind: 'saved-not-promoted',
          since: committedAt ?? isoOrUndefined(op.sentAt),
          dispatch: {kind: 'idle'},
          foundLate: true,
        })
        onRefresh()
        return
      }
      case 'missing': {
        if (op.persisted) await store.clearPendingOperation(pageId)
        if (!mountedRef.current) return
        setDoc(current => (current === null ? current : {...current, unknownOp: null}))
        setConflict(null)
        setMode('editing')
        setOutcome(display)
        return
      }
      case 'unknown': {
        setOutcome(null)
        setCopyStatus(null)
        setConflict({display, corrections: null, current: {kind: 'loading'}, confirming: false})
        setMode('conflict')
        void loadCurrent()
        return
      }
    }
  }

  // A draft that holds a pending operation is looked up once when the page opens.
  useEffect(() => {
    if (initial.unknownOp === null || openLookupRef.current) return
    openLookupRef.current = true
    void store.markPendingUnknown(pageId)
    void checkStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -------------------------------------------------------------------------
  // Retry dispatch
  // -------------------------------------------------------------------------

  const retryDispatch = async () => {
    if (saved === null || saved.kind !== 'saved-not-promoted' || saved.dispatch.kind === 'sending') return
    const epoch = savedEpochRef.current
    setSaved({...saved, dispatch: {kind: 'sending'}})

    const result = await retryPromotionDispatch()
    if (!mountedRef.current || savedEpochRef.current !== epoch) return

    if (result.ok) {
      setAnnouncement(OUTCOME_COPY.savedHeadline)
      setSaved(current =>
        current === null
          ? current
          : {kind: 'saved', since: current.since, promotion: null, unavailable: false, polling: true},
      )
      return
    }
    const message = describeDispatchFailure(result.error)
    setAnnouncement(message)
    setSaved(current =>
      current?.kind === 'saved-not-promoted' ? {...current, dispatch: {kind: 'failed', message}} : current,
    )
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Save of a changed draft asks first, unless this exact base, text and marks were already confirmed.
  // A change too large to check is treated as unmarked: the question is asked, and says why.
  const requestSave = () => {
    const working = docRef.current
    if (working === null || saveBlocked) return
    // Only the body is checked. A save with staged actions and an unchanged body has nothing to mark.
    if (working.text === working.base.text || alreadyConfirmed) {
      void save()
      return
    }
    const result = checkUnmarkedChanges({
      baseText: working.base.text,
      draftText: working.text,
      marks: saveMarksOf(working.text, working.marks),
    })
    if (result === 'marked') {
      void save()
      return
    }
    setConfirmUnavailable(result === 'unavailable')
    setConfirmOpen(snapshotOf(working))
  }

  const confirmSave = () => {
    const working = docRef.current
    if (working === null) return
    setConfirmed(snapshotOf(working))
    setConfirmOpen(null)
    void save()
  }

  const cancelConfirm = () => {
    setConfirmOpen(null)
    textareaRef.current?.focus()
  }

  const runAction = (action: OutcomeAction): void => {
    if (action === 'save-again') requestSave()
    else if (action === 'check-status') void checkStatus()
    else if (action === 'copy-draft') void copyDraft()
    else if (action === 'retry-dispatch') void retryDispatch()
  }

  const busy = phase !== 'idle'

  const unreadableNotice = (
    <UnreadableDraft
      state={unreadable}
      confirming={discardingUnreadable}
      status={unreadableStatus}
      busy={busy}
      onAskDiscard={() => {
        setDiscardingUnreadable(true)
        setUnreadableStatus(null)
      }}
      onCancelDiscard={() => {
        setDiscardingUnreadable(false)
      }}
      onDiscard={() => void discardUnreadable()}
    />
  )

  return (
    <article
      className="wiki-page-content wiki-editor"
      data-testid="wiki-editor"
      data-mode={mode}
      data-phase={phase}
    >
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

      {contractMismatch ? (
        <div className="wiki-note wiki-contract-notice" data-testid="wiki-contract-notice" data-contract="mismatch" role="alert">
          <h3>{OUTCOME_COPY.contractMismatchHeadline}</h3>
          <p>{OUTCOME_COPY.contractMismatchDetail}</p>
        </div>
      ) : null}
      {!page.contract.ok && page.contract.kind === 'unreadable' ? (
        <div className="wiki-note wiki-contract-notice" data-testid="wiki-contract-notice" data-contract="unreadable" role="status">
          <p>{EDITOR_COPY.contractUnreadableNotice}</p>
          <button
            type="button"
            onClick={() => {
              // Reading the page again drops the working copy, so the navigation guard asks first.
              if (confirmLeaveWiki(null)) onReload()
            }}
          >
            {EDITOR_COPY.retry}
          </button>
        </div>
      ) : null}
      {draftReadFailed ? (
        <p className="wiki-note wiki-draft-read-failed" data-testid="wiki-draft-read-failed" role="status">
          {EDITOR_COPY.draftReadFailed}
        </p>
      ) : null}

      <p
        className={`wiki-note wiki-unmarked-notice wiki-unmarked-notice-${markable ? 'marked-only' : 'no-node-id'}`}
        id="wiki-unmarked-notice"
        data-testid="wiki-unmarked-notice"
        data-notice={markable ? 'marked-only' : 'no-node-id'}
      >
        {markable ? UNMARKED_COPY.noticeMarkedOnly : UNMARKED_COPY.noticeNoNodeId}
      </p>

      {saved === null && openPromotion.kind === 'ready' ? <PromotionBanner status={openPromotion.status} /> : null}
      {saved === null && openPromotion.kind === 'unavailable' ? (
        <p className="wiki-note wiki-promotion-unavailable" data-testid="wiki-promotion-unavailable" role="status">
          {PROMOTION_OUTCOME_COPY.unavailable}
        </p>
      ) : null}

      <p className="wiki-save-status sr-only" data-testid="wiki-save-status" role="status">
        {announcement}
      </p>

      {saved === null ? null : <SavedPanel saved={saved} onRetryDispatch={() => void retryDispatch()} />}

      {refreshing ? (
        <p className="wiki-note wiki-refreshing" data-testid="wiki-refreshing">
          {EDITOR_COPY.refreshing}
        </p>
      ) : null}
      {refreshFailed ? (
        <div className="wiki-note wiki-refresh-failed" data-testid="wiki-refresh-failed" role="status">
          <p>{EDITOR_COPY.refreshFailed}</p>
          <button type="button" onClick={onRefresh}>
            {EDITOR_COPY.retry}
          </button>
        </div>
      ) : null}

      {outcome === null ? null : (
        <OutcomePanel
          outcome={outcome}
          pageId={pageId}
          busy={busy}
          saveDisabled={saveBlocked}
          copyStatus={copyStatus}
          onAction={runAction}
          onShowFinding={selectTarget}
          corrections={corrections}
          staged={doc?.staged ?? []}
          canStage={canStage}
          onRetire={correction => {
            stage(correction, 'retire')
          }}
        />
      )}

      {mode === 'viewing' ? (
        <section className="wiki-page-text" aria-labelledby="wiki-page-text-heading">
          <h3 id="wiki-page-text-heading">{PAGE_COPY.bodyHeading}</h3>
          <p className="wiki-page-text-note">{PAGE_COPY.bodyNote}</p>
          <pre className="wiki-page-body" data-testid="wiki-page-body">
            {page.body}
          </pre>

          {unreadableNotice}
          {note === 'kept' ? (
            <p className="wiki-note wiki-draft-kept" data-testid="wiki-draft-kept" role="status">
              {EDITOR_COPY.draftKept}
            </p>
          ) : null}
          {note === 'discard-kept-stored' ? (
            <p
              className="wiki-note wiki-draft-discard-kept-stored"
              data-testid="wiki-draft-discard-kept-stored"
              role="status"
            >
              {EDITOR_COPY.discardKeptStored}
            </p>
          ) : null}
          {note === 'kept-failed' ? (
            <p className="wiki-note wiki-draft-local-failed" data-testid="wiki-draft-local-failed" role="status">
              {EDITOR_COPY.draftNotStoredLocally}
            </p>
          ) : null}

          {page.canWrite ? (
            <div className="wiki-edit-actions">
              <button type="button" className="wiki-edit" onClick={startEditing} disabled={refreshing || refreshFailed}>
                {doc === null ? EDITOR_COPY.edit : EDITOR_COPY.resume}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {mode === 'editing' && doc !== null ? (
        <section className="wiki-edit-surface" data-testid="wiki-edit-surface" aria-labelledby="wiki-edit-text-label">
          <p className="wiki-note wiki-frontmatter-note" data-testid="wiki-frontmatter-note">
            {EDITOR_COPY.frontmatterNote}
          </p>
          <p className="wiki-draft-base" data-testid="wiki-draft-base">
            {EDITOR_COPY.draftBaseLabel} <code>{shortVersion(doc.base.blobSha)}</code>
          </p>
          {draftIsStale ? (
            <p className="wiki-note wiki-draft-stale" data-testid="wiki-draft-stale" role="status">
              {EDITOR_COPY.draftStaleLead} <code>{shortVersion(page.pageBlobSha)}</code>. {EDITOR_COPY.draftStaleTail}
            </p>
          ) : null}
          {note === 'rebased' ? (
            <p className="wiki-note wiki-draft-rebased" data-testid="wiki-draft-rebased" role="status">
              {EDITOR_COPY.rebased}
            </p>
          ) : null}
          {note === 'merged' ? (
            <p className="wiki-note wiki-draft-merged" data-testid="wiki-draft-merged" role="status">
              {EDITOR_COPY.merged}
            </p>
          ) : null}
          {note === 'merged' && mergeFlagged > 0 ? (
            <p className="wiki-note wiki-merge-marks-review" data-testid="wiki-merge-marks-review" role="status">
              {EDITOR_COPY.mergedMarksNeedReview(mergeFlagged)}
            </p>
          ) : null}
          {localSaveFailed ? (
            <p className="wiki-note wiki-draft-local-failed" data-testid="wiki-draft-local-failed" role="status">
              {EDITOR_COPY.draftNotStoredLocally}
            </p>
          ) : null}
          {unreadableNotice}

          <label id="wiki-edit-text-label" htmlFor="wiki-edit-text">
            {EDITOR_COPY.textLabel}
          </label>
          <textarea
            id="wiki-edit-text"
            ref={textareaRef}
            className="wiki-edit-text"
            data-testid="wiki-edit-text"
            value={doc.text}
            readOnly={busy || hasUnknown}
            spellCheck={false}
            onChange={event => {
              onTextChange(event.target.value, editHintOf(event.nativeEvent, event.target.selectionStart))
            }}
          />

          <div className="wiki-mark-controls" data-testid="wiki-mark-controls">
            <button
              type="button"
              className="wiki-mark"
              data-testid="wiki-mark-button"
              aria-describedby="wiki-unmarked-notice"
              disabled={!canMarkSelection}
              onClick={markSelection}
            >
              {MARK_COPY.button}
            </button>
            {markable ? <span className="wiki-mark-hint">{MARK_COPY.hint}</span> : null}
          </div>
          {markStatus === null ? null : (
            <p className="wiki-note wiki-mark-status" data-testid="wiki-mark-status" role="status">
              {markStatus}
            </p>
          )}

          <div className="wiki-edit-actions">
            <button type="button" className="wiki-save" onClick={requestSave} disabled={saveBlocked}>
              {EDITOR_COPY.save}
            </button>
            <button type="button" className="wiki-cancel" onClick={cancel} disabled={busy || cancelOpen}>
              {EDITOR_COPY.cancel}
            </button>
          </div>

          {confirmIsOpen ? (
            <div
              className="wiki-unmarked-confirm"
              data-testid="wiki-unmarked-confirm"
              data-confirm={markable ? 'marked-only' : 'no-node-id'}
              role="group"
              aria-labelledby="wiki-unmarked-confirm-heading"
              aria-describedby="wiki-unmarked-confirm-detail"
            >
              <h3 id="wiki-unmarked-confirm-heading" ref={confirmHeadingRef} tabIndex={-1}>
                {UNMARKED_COPY.confirmHeading}
              </h3>
              <p id="wiki-unmarked-confirm-detail">
                {markable ? UNMARKED_COPY.confirmMarkedOnly : UNMARKED_COPY.confirmNoNodeId}
              </p>
              {confirmUnavailable ? (
                <p className="wiki-note wiki-unmarked-unavailable" data-testid="wiki-unmarked-unavailable">
                  {UNMARKED_COPY.unavailable}
                </p>
              ) : null}
              <button type="button" className="wiki-unmarked-confirm-yes" onClick={confirmSave}>
                {UNMARKED_COPY.confirm}
              </button>
              <button type="button" className="wiki-unmarked-confirm-no" onClick={cancelConfirm}>
                {UNMARKED_COPY.cancel}
              </button>
            </div>
          ) : null}

          {cancelOpen ? (
            <div
              className="wiki-cancel-confirm"
              data-testid="wiki-cancel-confirm"
              role="group"
              aria-labelledby="wiki-cancel-heading"
            >
              <h3 id="wiki-cancel-heading">{EDITOR_COPY.cancelHeading}</h3>
              <p>{EDITOR_COPY.cancelDetail}</p>
              {hasUnknown ? <p>{EDITOR_COPY.cancelPendingDetail}</p> : null}
              <button type="button" className="wiki-keep-draft" onClick={() => void keepDraft()} disabled={busy}>
                {EDITOR_COPY.keepDraft}
              </button>
              <button type="button" className="wiki-discard-draft" onClick={() => void discardDraft()} disabled={busy}>
                {EDITOR_COPY.discardDraft}
              </button>
              <button
                type="button"
                className="wiki-keep-editing"
                onClick={() => {
                  setCancelOpen(false)
                  setCancelStatus(null)
                }}
              >
                {EDITOR_COPY.keepEditing}
              </button>
              {cancelStatus === null ? null : (
                <p className="wiki-cancel-status" data-testid="wiki-cancel-status" role="status">
                  {cancelStatus}
                </p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {mode === 'conflict' && conflict !== null && doc !== null ? (
        <ConflictView
          conflict={conflict}
          draft={doc.text}
          base={doc.base}
          busy={busy}
          copyStatus={copyStatus}
          onAction={runAction}
          onAskOverwrite={() => {
            setConflict({...conflict, confirming: true})
          }}
          onCancelOverwrite={() => {
            setConflict({...conflict, confirming: false})
          }}
          onOverwrite={() => void overwrite()}
          onUseMerged={output => void applyMerge(output)}
          onReload={() => void loadCurrent()}
          onKeepEditing={leaveConflict}
        />
      ) : null}

      <WikiCorrections
        corrections={corrections}
        staged={doc?.staged ?? []}
        marks={mode === 'editing' && markable ? markRows : []}
        actions={editingSurface && markable}
        busy={busy || hasUnknown}
        droppedNotice={droppedNotice}
        stageStatus={stageStatus}
        onStage={stage}
        onUndo={undoStage}
        onJumpToMark={jumpToMark}
        onKeepMark={confirmMark}
        onRemoveMark={dropMark}
      />
    </article>
  )
}

// ---------------------------------------------------------------------------
// Draft record that could not be read
// ---------------------------------------------------------------------------

function UnreadableDraft({
  state,
  confirming,
  status,
  busy,
  onAskDiscard,
  onCancelDiscard,
  onDiscard,
}: {
  readonly state: UnreadableNotice
  readonly confirming: boolean
  readonly status: string | null
  readonly busy: boolean
  readonly onAskDiscard: () => void
  readonly onCancelDiscard: () => void
  readonly onDiscard: () => void
}) {
  if (state === 'none') return null
  if (state === 'replaced') {
    return (
      <p
        className="wiki-note wiki-draft-unreadable-replaced"
        data-testid="wiki-draft-unreadable-replaced"
        role="status"
      >
        {EDITOR_COPY.draftUnreadableReplaced}
      </p>
    )
  }

  const statusNote =
    status === null ? null : (
      <p className="wiki-note wiki-draft-unreadable-status" data-testid="wiki-draft-unreadable-status" role="status">
        {status}
      </p>
    )
  if (state === 'resolved') return statusNote

  return (
    <div className="wiki-note wiki-draft-unreadable" data-testid="wiki-draft-unreadable" role="status">
      <p>{EDITOR_COPY.draftUnreadable}</p>
      <button type="button" className="wiki-discard wiki-discard-unreadable" onClick={onAskDiscard} disabled={confirming || busy}>
        {EDITOR_COPY.discardUnreadable}
      </button>
      {confirming ? (
        <div
          className="wiki-discard-confirm wiki-discard-unreadable-confirm"
          data-testid="wiki-discard-unreadable-confirm"
          role="group"
          aria-labelledby="wiki-discard-unreadable-heading"
        >
          <h3 id="wiki-discard-unreadable-heading">{EDITOR_COPY.discardUnreadableHeading}</h3>
          <p>{EDITOR_COPY.discardUnreadableDetail}</p>
          <button type="button" className="wiki-discard-confirm-yes wiki-discard-unreadable-yes" onClick={onDiscard} disabled={busy}>
            {EDITOR_COPY.discardUnreadableConfirm}
          </button>
          <button type="button" className="wiki-discard-confirm-no wiki-discard-unreadable-no" onClick={onCancelDiscard} disabled={busy}>
            {EDITOR_COPY.discardUnreadableCancel}
          </button>
        </div>
      ) : null}
      {statusNote}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Outcome panel
// ---------------------------------------------------------------------------

const ACTION_LABEL: Readonly<Partial<Record<OutcomeAction, string>>> = {
  'save-again': EDITOR_COPY.saveAgain,
  'check-status': EDITOR_COPY.checkStatus,
  'copy-draft': EDITOR_COPY.copyDraft,
  'sign-in': EDITOR_COPY.signIn,
}

function OutcomePanel({
  outcome,
  pageId,
  busy,
  saveDisabled,
  copyStatus,
  onAction,
  onShowFinding,
  corrections,
  staged,
  canStage,
  onRetire,
}: {
  readonly outcome: OutcomeDisplay
  readonly pageId: string
  readonly busy: boolean
  readonly saveDisabled: boolean
  readonly copyStatus: string | null
  readonly onAction: (action: OutcomeAction) => void
  readonly onShowFinding: (target: string) => void
  readonly corrections: readonly WikiCorrection[]
  readonly staged: readonly StagedAction[]
  readonly canStage: boolean
  readonly onRetire: (correction: WikiCorrection) => void
}) {
  return (
    <div
      className="wiki-outcome"
      data-testid="wiki-outcome"
      data-outcome={outcome.kind}
      data-draft={outcome.draft}
      role={outcome.urgency === 'alert' ? 'alert' : undefined}
    >
      <h3>{outcome.headline}</h3>
      <p>{outcome.detail}</p>

      {outcome.findings.length === 0 ? null : (
        <Findings
          findings={outcome.findings}
          onShow={onShowFinding}
          corrections={corrections}
          staged={staged}
          canStage={canStage && !busy}
          onRetire={onRetire}
        />
      )}

      {outcome.actions.length === 0 ? null : (
        <div className="wiki-outcome-actions">
          {outcome.actions.map(action => {
            if (action === 'sign-in') {
              return (
                <a key={action} className="wiki-sign-in" href={wikiSignInUrl(pageId)}>
                  {EDITOR_COPY.signIn}
                </a>
              )
            }
            const label = ACTION_LABEL[action]
            if (label === undefined) return null
            return (
              <button
                key={action}
                type="button"
                className={`wiki-action wiki-action-${action}`}
                disabled={action === 'save-again' ? saveDisabled : busy}
                onClick={() => {
                  onAction(action)
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}

      {copyStatus === null ? null : (
        <p className="wiki-note wiki-copy-status" data-testid="wiki-copy-status" role="status">
          {copyStatus}
        </p>
      )}
    </div>
  )
}

function Findings({
  findings,
  onShow,
  corrections,
  staged,
  canStage,
  onRetire,
}: {
  readonly findings: readonly GateFinding[]
  readonly onShow: (target: string) => void
  readonly corrections: readonly WikiCorrection[]
  readonly staged: readonly StagedAction[]
  readonly canStage: boolean
  readonly onRetire: (correction: WikiCorrection) => void
}) {
  return (
    <section className="wiki-findings" data-testid="wiki-findings" aria-labelledby="wiki-findings-heading">
      <h4 id="wiki-findings-heading">{EDITOR_COPY.findingsHeading}</h4>
      <ul className="wiki-finding-list">
        {findings.map((finding, index) => {
          const target = finding.target
          const located = target !== undefined && target !== ''
          // An eroded correction is named by ID. Retiring it is the way to let the save through.
          const eroded =
            finding.kind === ERODED_FINDING && located
              ? corrections.find(correction => correction.id === target)
              : undefined
          if (eroded !== undefined) {
            const retireStaged = staged.some(item => item.correctionId === eroded.id && item.action === 'retire')
            return (
              <li
                key={index}
                className="wiki-finding wiki-finding-eroded"
                data-testid="wiki-finding"
                data-finding-kind={finding.kind}
                data-located="true"
              >
                <p className="wiki-finding-message">{finding.message}</p>
                <p className="wiki-finding-target">
                  <span className="wiki-label">{EDITOR_COPY.findingCorrectionLabel}: </span>
                  <q>{eroded.span.text}</q>
                </p>
                {retireStaged ? (
                  <p className="wiki-finding-retire-staged">{EDITOR_COPY.findingRetireStaged}</p>
                ) : eroded.status === 'active' ? (
                  <button
                    type="button"
                    className="wiki-finding-retire"
                    disabled={!canStage}
                    onClick={() => {
                      onRetire(eroded)
                    }}
                  >
                    {EDITOR_COPY.findingRetire}
                  </button>
                ) : null}
              </li>
            )
          }
          return (
            <li
              // Findings carry no ID, and their order is stable for one response.
              key={index}
              className="wiki-finding"
              data-testid="wiki-finding"
              data-finding-kind={finding.kind}
              data-located={located ? 'true' : 'false'}
            >
              <p className="wiki-finding-message">{finding.message}</p>
              {located ? (
                <>
                  <p className="wiki-finding-target">
                    <q>{target}</q>
                  </p>
                  <button
                    type="button"
                    className="wiki-finding-show"
                    onClick={() => {
                      onShow(target)
                    }}
                  >
                    {EDITOR_COPY.findingShow}
                  </button>
                </>
              ) : (
                <p className="wiki-finding-page-level">{EDITOR_COPY.findingPageLevel}</p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Saved panel (promotion status)
// ---------------------------------------------------------------------------

function SavedPanel({saved, onRetryDispatch}: {readonly saved: SavedState; readonly onRetryDispatch: () => void}) {
  if (saved.kind === 'saved-not-promoted') {
    return (
      <div
        className="wiki-saved wiki-saved-not-promoted"
        data-testid="wiki-saved"
        data-saved="saved-not-promoted"
      >
        <h3>{saved.foundLate ? OUTCOME_COPY.lookupFoundHeadline : OUTCOME_COPY.savedNotPromotedHeadline}</h3>
        <p>{saved.foundLate ? OUTCOME_COPY.lookupFoundDetail : OUTCOME_COPY.savedNotPromotedDetail}</p>
        <button
          type="button"
          className="wiki-action wiki-action-retry-dispatch"
          onClick={onRetryDispatch}
          disabled={saved.dispatch.kind === 'sending'}
        >
          {saved.dispatch.kind === 'sending' ? EDITOR_COPY.retryingDispatch : EDITOR_COPY.retryDispatch}
        </button>
        {saved.dispatch.kind === 'failed' ? (
          <p className="wiki-note wiki-dispatch-failed" data-testid="wiki-dispatch-failed" role="status">
            {saved.dispatch.message}
          </p>
        ) : null}
      </div>
    )
  }

  const promotion = describePromotion(saved.promotion)
  return (
    <div
      className={`wiki-saved wiki-saved-${promotion.kind}`}
      data-testid="wiki-saved"
      data-saved="saved"
      data-promotion={promotion.kind}
      role={promotion.kind === 'blocked' ? 'alert' : undefined}
    >
      <h3>{promotion.headline}</h3>
      <p>{promotion.detail}</p>
      {promotion.hint === null ? null : <p className="wiki-saved-hint">{promotion.hint}</p>}
      {promotion.prUrl === null ? null : (
        <a href={promotion.prUrl} target="_blank" rel="noopener noreferrer">
          {EDITOR_COPY.promotionPrLink}
        </a>
      )}
      {promotion.runUrl === null ? null : (
        <a href={promotion.runUrl} target="_blank" rel="noopener noreferrer">
          {EDITOR_COPY.promotionRunLink}
        </a>
      )}
      {saved.unavailable ? (
        <p className="wiki-note wiki-promotion-unavailable" data-testid="wiki-saved-unavailable">
          {PROMOTION_OUTCOME_COPY.unavailable}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Conflict view
// ---------------------------------------------------------------------------

function conflictKindOf(display: OutcomeDisplay): string {
  switch (display.kind) {
    case 'conflict-page':
      return 'page'
    case 'conflict-corrections':
      return 'corrections'
    case 'conflict-page-removed':
      return 'page-removed'
    default:
      return 'possibly-saved'
  }
}

function CorrectionSummaryList({
  heading,
  testId,
  corrections,
}: {
  readonly heading: string
  readonly testId: string
  readonly corrections: readonly WikiCorrection[]
}) {
  return (
    <section className="wiki-conflict-corrections" data-testid={testId} aria-label={heading}>
      <h4>{heading}</h4>
      {corrections.length === 0 ? (
        <p>{EDITOR_COPY.noCorrections}</p>
      ) : (
        <ul>
          {corrections.map(correction => (
            <li key={correction.id} data-correction-id={correction.id} data-status={correction.status}>
              <q>{correction.span.text}</q>
              {correction.reason === null ? null : <> {correction.reason}</>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ConflictView({
  conflict,
  draft,
  base,
  busy,
  copyStatus,
  onAction,
  onAskOverwrite,
  onCancelOverwrite,
  onOverwrite,
  onUseMerged,
  onReload,
  onKeepEditing,
}: {
  readonly conflict: ConflictState
  readonly draft: string
  readonly base: Base
  readonly busy: boolean
  readonly copyStatus: string | null
  readonly onAction: (action: OutcomeAction) => void
  readonly onAskOverwrite: () => void
  readonly onCancelOverwrite: () => void
  readonly onOverwrite: () => void
  readonly onUseMerged: (output: MergeOutput) => void
  readonly onReload: () => void
  readonly onKeepEditing: () => void
}) {
  const {display, current} = conflict
  // A page conflict is resolved by merging. The other kinds compare the two versions as they were.
  const merging = display.kind === 'conflict-page' && current.kind === 'ready'
  const canOverwrite = display.actions.includes('overwrite')
  const currentLabel = display.versionLabel ?? EDITOR_COPY.conflictCurrentHeading

  return (
    <section
      className="wiki-conflict"
      data-testid="wiki-conflict"
      data-conflict-kind={conflictKindOf(display)}
      aria-labelledby="wiki-conflict-heading"
      role={display.urgency === 'alert' ? 'alert' : undefined}
    >
      <h3 id="wiki-conflict-heading">{display.headline}</h3>
      <p>{display.detail}</p>

      {current.kind === 'loading' ? (
        <p className="wiki-conflict-loading" data-testid="wiki-conflict-loading" role="status">
          {EDITOR_COPY.conflictLoading}
        </p>
      ) : null}
      {current.kind === 'failed' ? (
        <div className="wiki-conflict-load-failed" data-testid="wiki-conflict-load-failed" role="status">
          <p>{EDITOR_COPY.conflictLoadFailed}</p>
          <button type="button" onClick={onReload}>
            {EDITOR_COPY.retry}
          </button>
        </div>
      ) : null}
      {current.kind === 'removed' && display.kind !== 'conflict-page-removed' ? (
        <p className="wiki-conflict-removed" data-testid="wiki-conflict-removed" role="status">
          {EDITOR_COPY.conflictRemoved}
        </p>
      ) : null}

      {merging && current.kind === 'ready' ? (
        <WikiMerge
          key={current.page.pageBlobSha}
          mine={draft}
          base={base.text}
          theirs={current.page.body}
          busy={busy}
          onUse={onUseMerged}
        />
      ) : null}

      {!merging && current.kind === 'ready' ? (
        <section className="wiki-conflict-version" aria-labelledby="wiki-conflict-current-heading">
          <h4 id="wiki-conflict-current-heading">{currentLabel}</h4>
          <pre className="wiki-page-body wiki-conflict-current" data-testid="wiki-conflict-current">
            {current.page.body}
          </pre>
        </section>
      ) : null}

      {merging ? null : (
        <section className="wiki-conflict-version" aria-labelledby="wiki-conflict-draft-heading">
          <h4 id="wiki-conflict-draft-heading">{EDITOR_COPY.conflictDraftHeading}</h4>
          <pre className="wiki-page-body wiki-conflict-draft" data-testid="wiki-conflict-draft">
            {draft}
          </pre>
        </section>
      )}

      {display.kind === 'conflict-corrections' && conflict.corrections !== null ? (
        <div className="wiki-conflict-corrections-compare" data-testid="wiki-conflict-corrections">
          <CorrectionSummaryList
            heading={EDITOR_COPY.conflictCorrectionsBaseHeading}
            testId="wiki-conflict-corrections-base"
            corrections={base.correctionsBase.entries}
          />
          <CorrectionSummaryList
            heading={EDITOR_COPY.conflictCorrectionsCurrentHeading}
            testId="wiki-conflict-corrections-current"
            corrections={conflict.corrections.current}
          />
        </div>
      ) : null}

      <div className="wiki-conflict-actions">
        {canOverwrite ? (
          <button
            type="button"
            className="wiki-action wiki-action-overwrite"
            onClick={onAskOverwrite}
            disabled={current.kind !== 'ready' || conflict.confirming || busy}
          >
            {EDITOR_COPY.overwrite}
          </button>
        ) : null}
        {display.actions.includes('check-status') ? (
          <button type="button" className="wiki-action wiki-action-check-status" onClick={() => { onAction('check-status') }} disabled={busy}>
            {EDITOR_COPY.checkStatus}
          </button>
        ) : null}
        {display.actions.includes('copy-draft') ? (
          <button type="button" className="wiki-action wiki-action-copy-draft" onClick={() => { onAction('copy-draft') }}>
            {EDITOR_COPY.copyDraft}
          </button>
        ) : null}
        {display.kind === 'conflict-page-removed' ? null : (
          <button type="button" className="wiki-keep-editing" onClick={onKeepEditing} disabled={busy}>
            {EDITOR_COPY.keepEditing}
          </button>
        )}
      </div>

      {conflict.confirming ? (
        <div
          className="wiki-overwrite-confirm"
          data-testid="wiki-overwrite-confirm"
          role="group"
          aria-labelledby="wiki-overwrite-heading"
        >
          <h4 id="wiki-overwrite-heading">{EDITOR_COPY.overwriteConfirmHeading}</h4>
          <p>{EDITOR_COPY.overwriteConfirmDetail}</p>
          <button type="button" className="wiki-overwrite-yes" onClick={onOverwrite}>
            {EDITOR_COPY.overwriteConfirm}
          </button>
          <button type="button" className="wiki-overwrite-no" onClick={onCancelOverwrite}>
            {EDITOR_COPY.overwriteCancel}
          </button>
        </div>
      ) : null}

      {copyStatus === null ? null : (
        <p className="wiki-note wiki-copy-status" data-testid="wiki-copy-status" role="status">
          {copyStatus}
        </p>
      )}
    </section>
  )
}
