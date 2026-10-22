/**
 * Branch-level promotion banner, shared by the wiki list and the page editor.
 *
 * Settled shows nothing. Pending is a polite status. Blocked is an alert with the reason and
 * the run link, because it needs the operator's attention.
 */

import type {PromotionStatus} from '../api/wiki.ts'
import {blockReasonCopy, PROMOTION_COPY} from '../wiki/copy.ts'

export function PromotionBanner({status}: {readonly status: PromotionStatus}) {
  if (status.state === 'settled') return null

  if (status.state === 'pending') {
    return (
      <div className="wiki-promotion wiki-promotion-pending" data-testid="wiki-promotion-pending" role="status">
        <h3>{PROMOTION_COPY.pendingHeadline}</h3>
        <p>{PROMOTION_COPY.pendingDetail}</p>
        {status.pr === null ? null : (
          <a href={status.pr.url} target="_blank" rel="noopener noreferrer">
            {PROMOTION_COPY.pullRequestLink}
          </a>
        )}
      </div>
    )
  }

  return (
    <div className="wiki-promotion wiki-promotion-blocked" data-testid="wiki-promotion-blocked" role="alert">
      <h3>{PROMOTION_COPY.blockedHeadline}</h3>
      <p>{blockReasonCopy(status.reason)}</p>
      <a href={status.runUrl} target="_blank" rel="noopener noreferrer">
        {PROMOTION_COPY.blockedRunLink}
      </a>
      {status.pr === null ? null : (
        <a href={status.pr.url} target="_blank" rel="noopener noreferrer">
          {PROMOTION_COPY.pullRequestLink}
        </a>
      )}
    </div>
  )
}
