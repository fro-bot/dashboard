/**
 * Pieces of the page view that the shell and the edit session share.
 *
 * Markup only, as in the rest of the wiki views.
 */

import type {WikiCorrection} from '../api/wiki.ts'
import {CORRECTION_STATUS_LABEL, PAGE_COPY} from '../wiki/copy.ts'

export function Corrections({corrections}: {readonly corrections: readonly WikiCorrection[]}) {
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
