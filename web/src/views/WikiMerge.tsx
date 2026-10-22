/**
 * The merge view for a page conflict: the draft and the current page, merged.
 *
 * Changes that do not overlap are applied without asking. Each overlapping change is a hunk with a
 * heading, both versions as plain text, and two native buttons, Accept mine and Accept theirs. The
 * buttons are ordinary tab stops. One polite `role="status"` region announces each resolution, and
 * focus never moves. Once every hunk is resolved, "Use merged text" hands the merged text and its
 * stretches to the caller. A merge with no hunks is applied the same way, in one step.
 *
 * Markup only: stable class names and `data-*` hooks. The styling lives in `web/src/index.css`.
 */

import {useMemo, useState} from 'react'
import {MERGE_COPY} from '../wiki/copy.ts'
import {applyResolutions, mergeTexts, type MergeHunk, type MergeOutput, type Resolution} from '../wiki/merge.ts'

export interface WikiMergeProps {
  /** The draft. */
  readonly mine: string
  /** The page text the draft started from. */
  readonly base: string
  /** The page text now. */
  readonly theirs: string
  /** A save, check or re-base is under way. */
  readonly busy: boolean
  /** The merged text and its stretches, once every change is resolved. */
  readonly onUse: (output: MergeOutput) => void
}

function announcementOf(position: number, total: number, choice: Resolution, complete: boolean): string {
  const resolved = choice === 'mine' ? MERGE_COPY.announceMine(position, total) : MERGE_COPY.announceTheirs(position, total)
  return complete ? `${resolved}. ${MERGE_COPY.announceAllResolved}` : resolved
}

function Version({
  heading,
  text,
  testId,
  className,
}: {
  readonly heading: string
  readonly text: string
  readonly testId: string
  readonly className: string
}) {
  return (
    <section className={`wiki-merge-version ${className}-block`} data-testid={`${testId}-block`}>
      <h6>{heading}</h6>
      {text === '' ? (
        <p className="wiki-merge-removed">{MERGE_COPY.removed}</p>
      ) : (
        <pre className={`wiki-page-body ${className}`} data-testid={testId}>
          {text}
        </pre>
      )}
    </section>
  )
}

function Hunk({
  hunk,
  position,
  total,
  resolution,
  busy,
  onChoose,
}: {
  readonly hunk: MergeHunk
  readonly position: number
  readonly total: number
  readonly resolution: Resolution | undefined
  readonly busy: boolean
  readonly onChoose: (choice: Resolution) => void
}) {
  const headingId = `wiki-merge-change-${String(position)}`
  return (
    <li
      className="wiki-merge-hunk"
      data-testid="wiki-merge-hunk"
      data-hunk={position}
      data-resolution={resolution ?? 'unresolved'}
    >
      <h5 id={headingId}>{MERGE_COPY.changeHeading(position, total)}</h5>
      <Version heading={MERGE_COPY.mineHeading} text={hunk.mine} testId="wiki-merge-mine" className="wiki-merge-mine" />
      <Version
        heading={MERGE_COPY.theirsHeading}
        text={hunk.theirs}
        testId="wiki-merge-theirs"
        className="wiki-merge-theirs"
      />
      <p className="wiki-merge-resolution" data-testid="wiki-merge-resolution">
        {resolution === undefined
          ? MERGE_COPY.unresolved
          : resolution === 'mine'
            ? MERGE_COPY.resolvedMine
            : MERGE_COPY.resolvedTheirs}
      </p>
      <div className="wiki-merge-choices">
        <button
          type="button"
          className="wiki-merge-accept wiki-merge-accept-mine"
          aria-describedby={headingId}
          aria-pressed={resolution === 'mine'}
          disabled={busy}
          onClick={() => {
            onChoose('mine')
          }}
        >
          {MERGE_COPY.acceptMine}
        </button>
        <button
          type="button"
          className="wiki-merge-accept wiki-merge-accept-theirs"
          aria-describedby={headingId}
          aria-pressed={resolution === 'theirs'}
          disabled={busy}
          onClick={() => {
            onChoose('theirs')
          }}
        >
          {MERGE_COPY.acceptTheirs}
        </button>
      </div>
    </li>
  )
}

export function WikiMerge({mine, base, theirs, busy, onUse}: WikiMergeProps) {
  const merge = useMemo(() => mergeTexts(mine, base, theirs), [mine, base, theirs])
  const [resolutions, setResolutions] = useState<readonly (Resolution | undefined)[]>([])
  const [announcement, setAnnouncement] = useState('')

  const total = merge.hunks.length
  const resolved = merge.hunks.filter((_, index) => resolutions[index] !== undefined).length
  const output = useMemo(() => applyResolutions(merge, resolutions), [merge, resolutions])

  const choose = (index: number, choice: Resolution) => {
    if (resolutions[index] === choice) return
    const next = merge.hunks.map((_, at) => (at === index ? choice : resolutions[at]))
    setResolutions(next)
    setAnnouncement(
      announcementOf(
        index + 1,
        total,
        choice,
        next.every(entry => entry !== undefined),
      ),
    )
  }

  return (
    <section
      className="wiki-merge"
      data-testid="wiki-merge"
      data-hunks={total}
      data-coarse={merge.coarse}
      data-resolved={resolved}
      data-complete={output !== null}
      aria-labelledby="wiki-merge-heading"
    >
      <h4 id="wiki-merge-heading">{MERGE_COPY.heading}</h4>
      <p className="wiki-merge-summary" data-testid="wiki-merge-summary">
        {merge.coarse && total > 0
          ? MERGE_COPY.summaryCoarse
          : total === 0
            ? MERGE_COPY.summaryNone
            : total === 1
              ? MERGE_COPY.summaryOne
              : MERGE_COPY.summaryMany(total)}
      </p>
      {total === 0 ? null : (
        <p className="wiki-merge-progress" data-testid="wiki-merge-progress">
          {MERGE_COPY.progress(resolved, total)}
        </p>
      )}

      <p className="wiki-merge-status sr-only" data-testid="wiki-merge-status" role="status" aria-live="polite">
        {announcement}
      </p>

      {total === 0 ? null : (
        <ol className="wiki-merge-hunks">
          {merge.hunks.map((hunk, index) => (
            <Hunk
              key={index}
              hunk={hunk}
              position={index + 1}
              total={total}
              resolution={resolutions[index]}
              busy={busy}
              onChoose={choice => {
                choose(index, choice)
              }}
            />
          ))}
        </ol>
      )}

      <div className="wiki-merge-actions">
        <button
          type="button"
          className="wiki-merge-use"
          aria-describedby={output === null ? 'wiki-merge-waiting' : undefined}
          disabled={busy || output === null}
          onClick={() => {
            if (output !== null) onUse(output)
          }}
        >
          {MERGE_COPY.useMerged}
        </button>
        {output === null ? (
          <span className="wiki-merge-waiting" id="wiki-merge-waiting">
            {MERGE_COPY.useMergedWaiting}
          </span>
        ) : null}
      </div>
    </section>
  )
}
