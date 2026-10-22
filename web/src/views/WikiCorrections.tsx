/**
 * The corrections panel: the page's corrections with their status, the actions staged on them, and
 * the marks of the draft that Save waits on.
 *
 * Markup only, as in the rest of the wiki views: real headings, lists and buttons, `role="status"`
 * for the notice, and stable class names and `data-*` hooks for the later visual pass. The panel
 * holds no state. The edit session owns the marks and the staged actions and passes them in.
 *
 * Retire and Flag for reconfirmation are offered on an active correction, and Reconfirm on a
 * flagged one. Choosing one stages it in the draft (KTD10); it is committed with Save and can be
 * undone before then. Without the edit surface (`actions` false) the panel shows what is staged
 * and offers nothing.
 */

import type {WikiCorrection} from '../api/wiki.ts'
import {CORRECTION_STATUS_LABEL, CORRECTIONS_COPY, PAGE_COPY} from '../wiki/copy.ts'
import type {Mark, MarkState} from '../wiki/marks.ts'
import {availableActions, type StagedAction, type StagedKind} from '../wiki/staged.ts'

export interface MarkRow {
  readonly mark: Mark
  readonly state: MarkState
}

export interface WikiCorrectionsProps {
  readonly corrections: readonly WikiCorrection[]
  readonly staged: readonly StagedAction[]
  /** The draft's marks with their state. Empty outside the edit surface. */
  readonly marks: readonly MarkRow[]
  /** Offer the actions: staging, undo, and the mark buttons. False in the read-only view. */
  readonly actions: boolean
  /** Disable the actions while a save is running. */
  readonly busy?: boolean
  /** Said once when staged actions were dropped because their corrections changed. */
  readonly droppedNotice: string | null
  /** Said when an action could not be staged. */
  readonly stageStatus?: string | null
  readonly onStage: (correction: WikiCorrection, action: StagedKind) => void
  readonly onUndo: (correctionId: string) => void
  readonly onJumpToMark: (markId: string) => void
  readonly onKeepMark: (markId: string) => void
  readonly onRemoveMark: (markId: string) => void
}

/** The calendar date of an ISO timestamp, matching the list's date display. Anything else is shown as stored. */
function recordedDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : value
}

const ACTION_LABEL: Readonly<Record<StagedKind, string>> = {
  retire: CORRECTIONS_COPY.retire,
  flag: CORRECTIONS_COPY.flag,
  reconfirm: CORRECTIONS_COPY.reconfirm,
}

const STAGED_COPY: Readonly<Record<StagedKind, string>> = {
  retire: CORRECTIONS_COPY.stagedRetire,
  flag: CORRECTIONS_COPY.stagedFlag,
  reconfirm: CORRECTIONS_COPY.stagedReconfirm,
}

function Marks({
  marks,
  busy,
  onJump,
  onKeep,
  onRemove,
}: {
  readonly marks: readonly MarkRow[]
  readonly busy: boolean
  readonly onJump: (markId: string) => void
  readonly onKeep: (markId: string) => void
  readonly onRemove: (markId: string) => void
}) {
  const blocking = marks.some(row => row.state !== 'ok')
  return (
    <section className="wiki-marks" data-testid="wiki-marks" aria-labelledby="wiki-marks-heading">
      <h4 id="wiki-marks-heading">{CORRECTIONS_COPY.marksHeading}</h4>
      <p className="wiki-marks-note">{CORRECTIONS_COPY.marksNote}</p>
      {blocking ? (
        <p className="wiki-note wiki-marks-blocking" data-testid="wiki-marks-blocking" role="status">
          {CORRECTIONS_COPY.marksBlocking}
        </p>
      ) : null}
      <ul className="wiki-mark-list">
        {marks.map(({mark, state}) => (
          <li
            key={mark.id}
            className="wiki-mark-item"
            data-testid="wiki-mark-item"
            data-mark-id={mark.id}
            data-mark-state={state}
          >
            <p className="wiki-mark-text">
              <q>{mark.text}</q>
            </p>
            {state === 'review' ? <p className="wiki-mark-state">{CORRECTIONS_COPY.markReview}</p> : null}
            {state === 'detached' ? <p className="wiki-mark-state">{CORRECTIONS_COPY.markDetached}</p> : null}
            <div className="wiki-mark-actions">
              {state === 'detached' ? null : (
                <button type="button" className="wiki-mark-jump" onClick={() => { onJump(mark.id) }}>
                  {CORRECTIONS_COPY.jump}
                </button>
              )}
              {state === 'review' ? (
                <button type="button" className="wiki-mark-keep" onClick={() => { onKeep(mark.id) }} disabled={busy}>
                  {CORRECTIONS_COPY.keep}
                </button>
              ) : null}
              <button type="button" className="wiki-mark-remove" onClick={() => { onRemove(mark.id) }} disabled={busy}>
                {CORRECTIONS_COPY.remove}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function WikiCorrections({
  corrections,
  staged,
  marks,
  actions,
  busy = false,
  droppedNotice,
  stageStatus = null,
  onStage,
  onUndo,
  onJumpToMark,
  onKeepMark,
  onRemoveMark,
}: WikiCorrectionsProps) {
  return (
    <section className="wiki-corrections" data-testid="wiki-corrections" aria-labelledby="wiki-corrections-heading">
      <h3 id="wiki-corrections-heading">{PAGE_COPY.correctionsHeading}</h3>

      {droppedNotice === null ? null : (
        <p className="wiki-note wiki-staged-dropped" data-testid="wiki-staged-dropped" role="status">
          {droppedNotice}
        </p>
      )}

      {stageStatus === null ? null : (
        <p className="wiki-note wiki-stage-status" data-testid="wiki-stage-status" role="status">
          {stageStatus}
        </p>
      )}

      {marks.length === 0 ? null : (
        <Marks marks={marks} busy={busy} onJump={onJumpToMark} onKeep={onKeepMark} onRemove={onRemoveMark} />
      )}

      {corrections.length === 0 ? (
        <p className="wiki-corrections-empty">{PAGE_COPY.noCorrections}</p>
      ) : (
        <ul className="wiki-correction-list">
          {corrections.map(correction => {
            const stagedAction = staged.find(item => item.correctionId === correction.id)
            const spanId = `wiki-correction-span-${correction.id}`
            return (
              <li
                key={correction.id}
                className="wiki-correction"
                data-correction-id={correction.id}
                data-status={correction.status}
                data-stale={correction.stale ? 'true' : undefined}
                data-staged={stagedAction?.action}
              >
                <p className="wiki-correction-status">
                  <span className="wiki-correction-status-label">{CORRECTION_STATUS_LABEL[correction.status]}</span>
                  {correction.stale ? (
                    <>
                      {' '}
                      <span className="wiki-correction-stale">{PAGE_COPY.stale}</span>{' '}
                      <span className="wiki-correction-stale-detail">{PAGE_COPY.staleDetail}</span>
                    </>
                  ) : null}
                </p>
                <p className="wiki-correction-span" id={spanId}>
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
                    {correction.attribution.actor},{' '}
                    <time dateTime={correction.attribution.recordedAt}>{recordedDate(correction.attribution.recordedAt)}</time>
                  </p>
                )}
                {correction.supersededBy === null ? null : (
                  <p className="wiki-correction-superseded-by">
                    <span className="wiki-label">{PAGE_COPY.supersededByLabel}: </span>
                    {correction.supersededBy}
                  </p>
                )}

                {stagedAction === undefined ? null : (
                  <p className="wiki-correction-staged" data-testid="wiki-correction-staged">
                    {STAGED_COPY[stagedAction.action]}
                  </p>
                )}
                {actions ? (
                  <div className="wiki-correction-actions">
                    {stagedAction === undefined ? (
                      availableActions(correction).map(action => (
                        <button
                          key={action}
                          type="button"
                          className={`wiki-correction-action wiki-correction-${action}`}
                          aria-describedby={spanId}
                          disabled={busy}
                          onClick={() => { onStage(correction, action) }}
                        >
                          {ACTION_LABEL[action]}
                        </button>
                      ))
                    ) : (
                      <button
                        type="button"
                        className="wiki-correction-action wiki-correction-undo"
                        aria-describedby={spanId}
                        disabled={busy}
                        onClick={() => { onUndo(correction.id) }}
                      >
                        {CORRECTIONS_COPY.undo}
                      </button>
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
