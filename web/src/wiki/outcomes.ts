/**
 * Save outcomes, as the operator sees them.
 *
 * The server answers a save with one of the outcomes in the plan's outcome contract. This
 * module maps each answer to a display model: the message, what happens to the draft, and
 * which actions are on offer. The editor renders the model and does what its actions say.
 * Copy lives here, as in `operator/copy.ts`: plain, short, and fixed. No response body,
 * status code, or error code reaches the screen.
 *
 * The mapping is pure. It never touches the draft store or the network.
 */

import type {
  DispatchError,
  GateFinding,
  LookupError,
  LookupOutcome,
  PromotionStatus,
  RejectReason,
  SaveError,
  SavedCommit,
  TransportError,
  WikiResult,
} from '../api/wiki.ts'

import {blockReasonCopy} from './copy.ts'

/** Shown when the server gives no wait hint with a rate limit. */
export const RATE_LIMIT_FALLBACK_SECONDS = 60

/** What happens to the local draft once this outcome is shown. */
export type DraftDisposition =
  /** The save landed. The draft is deleted. */
  | 'cleared'
  /** Nothing landed. The draft stays, and nothing is pending. */
  | 'kept'
  /** The save may have landed. The draft and its pending operation stay. */
  | 'kept-with-pending'

export type OutcomeAction =
  | 'save-again'
  | 'retry-dispatch'
  | 'check-status'
  | 'overwrite'
  | 'sign-in'
  | 'copy-draft'

export type OutcomeKind =
  | 'saved'
  | 'saved-not-promoted'
  | 'rejected'
  | 'conflict-page'
  | 'conflict-corrections'
  | 'conflict-page-removed'
  | 'failed'
  | 'failed-configuration'
  | 'contract-mismatch'
  | 'contract-unreadable'
  | 'status-unknown'
  | 'rate-limited'
  | 'refused'
  | 'not-sent'
  | 'lookup-found'
  | 'lookup-missing'
  | 'lookup-unknown'
  | 'lookup-failed'

export interface OutcomeDisplay {
  readonly kind: OutcomeKind
  readonly headline: string
  readonly detail: string
  readonly draft: DraftDisposition
  readonly actions: readonly OutcomeAction[]
  /** True when saving again cannot help until something else changes. */
  readonly saveDisabled: boolean
  /** `alert` is for blocking errors only. Everything else is announced politely. */
  readonly urgency: 'status' | 'alert'
  /** The gate's findings, for a rejection. Empty otherwise. */
  readonly findings: readonly GateFinding[]
  /** Labels the newer version in a comparison view, when the outcome has one. */
  readonly versionLabel: string | null
}

type Draftable = Pick<OutcomeDisplay, 'kind' | 'headline' | 'detail' | 'draft'> & Partial<OutcomeDisplay>

function display(base: Draftable): OutcomeDisplay {
  return {
    actions: [],
    saveDisabled: false,
    urgency: 'status',
    findings: [],
    versionLabel: null,
    ...base,
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const OUTCOME_COPY = {
  savedHeadline: 'Saved, pending publication',
  savedNotPromotedHeadline: 'Saved, not promoted',
  savedNotPromotedDetail: 'The change was saved but not sent for publication. Retrying sends only the publication request. It makes no new commit.',
  rejectedHeadline: 'The change was rejected',
  conflictPageHeadline: 'The page changed',
  conflictPageDetail:
    'The page changed since your draft started. Your draft is kept. Resolve the changes that overlap and use the merged text, or overwrite, or keep editing.',
  conflictCorrectionsHeadline: 'The corrections changed',
  conflictCorrectionsDetail:
    'The corrections for this page changed since your draft started. Your draft is kept. Compare the two, then overwrite or keep editing.',
  conflictRemovedHeadline: 'The page was removed',
  conflictRemovedDetail:
    'This page is no longer in the wiki, so it cannot be saved. Your draft is kept on this device. Copy the text out if you need it.',
  failedHeadline: 'Save failed',
  failedDetail: 'Nothing was saved. Your draft is kept. Save again.',
  failedConfigurationHeadline: 'Saving is not set up',
  failedConfigurationDetail:
    'Nothing was saved. The dashboard’s wiki connection needs configuration, and trying again will not help. Your draft is kept.',
  contractMismatchHeadline: 'The dashboard needs a deploy',
  contractMismatchDetail:
    'The wiki checks changed on the server. The dashboard needs a deploy before it can save. Nothing was saved. Your draft is kept.',
  contractUnreadableHeadline: 'The wiki checks could not be read',
  contractUnreadableDetail: 'Nothing was saved. Your draft is kept. Save again.',
  statusUnknownHeadline: 'Save status unknown',
  statusUnknownDetail:
    'The dashboard could not confirm whether your save landed. It may or may not have been saved. Nothing is sent again automatically. Use Check save status to find out. Your draft is kept.',
  statusUnknownVolatile:
    'The record of this save could not be stored on this device, so checking works only until you leave or reload this page.',
  rateLimitedHeadline: 'Too many saves',
  notSentHeadline: 'Save not sent',
  notSentDetail: 'This device could not record the save first, so nothing was sent. Your draft is kept. Save again.',
  forbiddenHeadline: 'Not allowed to save',
  forbiddenDetail: 'This session is not allowed to save to the wiki. Your draft is kept. Copy the text out if you need it.',
  notFoundHeadline: 'The page is gone',
  notFoundDetail:
    'The wiki does not have this page, so it cannot be saved. Your draft is kept. Copy the text out if you need it.',
  badRequestHeadline: 'The save could not be sent',
  badRequestDetail:
    'The dashboard and the server disagree about the request. Nothing was saved. Reload the page. Your draft is kept.',
  tooLargeHeadline: 'The page is too large',
  tooLargeDetail: 'The page is too large to save. Shorten it, then save. Your draft is kept.',
  lookupFoundHeadline: 'Saved, publication unknown',
  lookupFoundDetail:
    'Your earlier save landed. Whether it was sent for publication is unknown. Sending the publication request again is safe and makes no new commit.',
  lookupMissingHeadline: 'That save did not land',
  lookupMissingDetail:
    'Nothing was saved. Your draft is restored. Save again. If a save was just made, it may not be listed yet: saving again may show a conflict with it, so check the page before overwriting.',
  lookupUnknownHeadline: 'Still not sure',
  lookupUnknownDetail:
    'The history could not settle whether your save landed. The page now has a newer version, which may be your save. Compare it with your draft, then overwrite or check again.',
  lookupUnknownVersionLabel: 'Current version (possibly your save)',
  lookupFailedHeadline: 'Could not check the save',
  lookupFailedDetail: 'The check did not complete. Your draft and the unconfirmed save are kept. Check again.',
  lookupForbiddenDetail: 'This session is not allowed to check saves. Your draft and the unconfirmed save are kept.',
  lookupSessionLostDetail:
    'Your session has ended. Sign in, then check again. Your draft and the unconfirmed save are kept.',
} as const

const REJECT_DETAIL: Readonly<Record<RejectReason, string>> = {
  gate: 'The wiki checks refused this change. Nothing was saved. Fix the findings, then save.',
  'no-change': 'There are no changes to save. Nothing was saved.',
  'invalid-request': 'The save request was not valid. Nothing was saved. Your draft is kept.',
  'invalid-session': 'This session could not be verified for the save. Nothing was saved. Sign in again.',
  'content-too-large': 'The page is too large to save. Nothing was saved. Shorten it, then save.',
  'mark-unavailable': 'Marking is not available for this page. Nothing was saved.',
  'invalid-transition': 'A staged correction change is not valid. Nothing was saved.',
}

function secondsPhrase(seconds: number | null): string {
  const value = seconds === null ? RATE_LIMIT_FALLBACK_SECONDS : seconds
  return value === 1 ? '1 second' : `${value} seconds`
}

function rateLimitHint(seconds: number | null): string {
  return `Try again in ${secondsPhrase(seconds)}.`
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function unknownSave(persisted: boolean, extraActions: readonly OutcomeAction[] = []): OutcomeDisplay {
  return display({
    kind: 'status-unknown',
    headline: OUTCOME_COPY.statusUnknownHeadline,
    detail: persisted
      ? OUTCOME_COPY.statusUnknownDetail
      : `${OUTCOME_COPY.statusUnknownDetail} ${OUTCOME_COPY.statusUnknownVolatile}`,
    draft: 'kept-with-pending',
    actions: [...extraActions, 'check-status'],
    saveDisabled: true,
  })
}

function describeSaveError(error: SaveError | TransportError, persisted: boolean): OutcomeDisplay {
  switch (error.kind) {
    case 'rejected':
      return display({
        kind: 'rejected',
        headline: OUTCOME_COPY.rejectedHeadline,
        detail: REJECT_DETAIL[error.reason],
        draft: 'kept',
        findings: error.findings,
      })

    case 'conflict': {
      const {conflict} = error
      if (conflict.kind === 'page') {
        return display({
          kind: 'conflict-page',
          headline: OUTCOME_COPY.conflictPageHeadline,
          detail: OUTCOME_COPY.conflictPageDetail,
          draft: 'kept',
          actions: ['overwrite'],
          saveDisabled: true,
        })
      }
      if (conflict.kind === 'corrections') {
        return display({
          kind: 'conflict-corrections',
          headline: OUTCOME_COPY.conflictCorrectionsHeadline,
          detail: OUTCOME_COPY.conflictCorrectionsDetail,
          draft: 'kept',
          actions: ['overwrite'],
          saveDisabled: true,
        })
      }
      return display({
        kind: 'conflict-page-removed',
        headline: OUTCOME_COPY.conflictRemovedHeadline,
        detail: OUTCOME_COPY.conflictRemovedDetail,
        draft: 'kept',
        actions: ['copy-draft'],
        saveDisabled: true,
        urgency: 'alert',
      })
    }

    case 'failed':
      if (error.retryable) {
        return display({
          kind: 'failed',
          headline: OUTCOME_COPY.failedHeadline,
          detail: OUTCOME_COPY.failedDetail,
          draft: 'kept',
          actions: ['save-again'],
        })
      }
      return display({
        kind: 'failed-configuration',
        headline: OUTCOME_COPY.failedConfigurationHeadline,
        detail: OUTCOME_COPY.failedConfigurationDetail,
        draft: 'kept',
        saveDisabled: true,
        urgency: 'alert',
      })

    case 'contract-rejected':
      if (error.reason === 'mismatch') {
        return display({
          kind: 'contract-mismatch',
          headline: OUTCOME_COPY.contractMismatchHeadline,
          detail: OUTCOME_COPY.contractMismatchDetail,
          draft: 'kept',
          saveDisabled: true,
          urgency: 'alert',
        })
      }
      return display({
        kind: 'contract-unreadable',
        headline: OUTCOME_COPY.contractUnreadableHeadline,
        detail: OUTCOME_COPY.contractUnreadableDetail,
        draft: 'kept',
        actions: ['save-again'],
      })

    case 'status-unknown':
      return unknownSave(persisted, error.cause === 'session-lost' ? ['sign-in'] : [])

    // The save request may have been sent. A transport error or a reply the client cannot
    // read is never a failure to retry: the stored pending operation decides.
    case 'session-lost':
      return unknownSave(persisted, ['sign-in'])
    case 'network':
    case 'timeout':
    case 'contract-drift':
      return unknownSave(persisted)

    case 'rate-limited':
      return display({
        kind: 'rate-limited',
        headline: OUTCOME_COPY.rateLimitedHeadline,
        detail: `Nothing was saved. Your draft is kept. ${rateLimitHint(error.retryAfterSeconds)}`,
        draft: 'kept',
      })

    case 'forbidden':
      return display({
        kind: 'refused',
        headline: OUTCOME_COPY.forbiddenHeadline,
        detail: OUTCOME_COPY.forbiddenDetail,
        draft: 'kept',
        actions: ['copy-draft'],
        saveDisabled: true,
        urgency: 'alert',
      })
    case 'not-found':
      return display({
        kind: 'refused',
        headline: OUTCOME_COPY.notFoundHeadline,
        detail: OUTCOME_COPY.notFoundDetail,
        draft: 'kept',
        actions: ['copy-draft'],
        saveDisabled: true,
        urgency: 'alert',
      })
    case 'bad-request':
    case 'unsupported-media-type':
      return display({
        kind: 'refused',
        headline: OUTCOME_COPY.badRequestHeadline,
        detail: OUTCOME_COPY.badRequestDetail,
        draft: 'kept',
        saveDisabled: true,
        urgency: 'alert',
      })
    case 'payload-too-large':
      return display({
        kind: 'refused',
        headline: OUTCOME_COPY.tooLargeHeadline,
        detail: OUTCOME_COPY.tooLargeDetail,
        draft: 'kept',
      })
  }
}

/**
 * Map a save answer to its display model. `persisted` says whether the pending operation
 * reached the draft store; when it did not, an unknown save can be resolved only until the
 * page is left or reloaded, and the copy says so.
 */
export function describeSaveResult(
  result: WikiResult<SavedCommit, SaveError>,
  context: {readonly persisted: boolean},
): OutcomeDisplay {
  if (result.ok) {
    if (result.value.state === 'saved') {
      return display({
        kind: 'saved',
        headline: OUTCOME_COPY.savedHeadline,
        detail: PROMOTION_OUTCOME_COPY.pendingDetail,
        draft: 'cleared',
      })
    }
    return display({
      kind: 'saved-not-promoted',
      headline: OUTCOME_COPY.savedNotPromotedHeadline,
      detail: OUTCOME_COPY.savedNotPromotedDetail,
      draft: 'cleared',
      actions: ['retry-dispatch'],
    })
  }
  return describeSaveError(result.error, context.persisted)
}

/** The local store refused the pending operation, so the save request never went out. */
export function describePreSendFailure(): OutcomeDisplay {
  return display({
    kind: 'not-sent',
    headline: OUTCOME_COPY.notSentHeadline,
    detail: OUTCOME_COPY.notSentDetail,
    draft: 'kept',
    actions: ['save-again'],
  })
}

// ---------------------------------------------------------------------------
// Resolving an unknown save
// ---------------------------------------------------------------------------

type LookupAnswer = WikiResult<LookupOutcome, LookupError>

function lookupFailure(error: LookupError | TransportError): OutcomeDisplay {
  let detail: string = OUTCOME_COPY.lookupFailedDetail
  let actions: readonly OutcomeAction[] = ['check-status']

  if (error.kind === 'rate-limited') {
    detail = `Too many requests. ${rateLimitHint(error.retryAfterSeconds)} Your draft and the unconfirmed save are kept.`
  } else if (error.kind === 'session-lost') {
    detail = OUTCOME_COPY.lookupSessionLostDetail
    actions = ['sign-in', 'check-status']
  } else if (error.kind === 'forbidden') {
    detail = OUTCOME_COPY.lookupForbiddenDetail
  }

  return display({
    kind: 'lookup-failed',
    headline: OUTCOME_COPY.lookupFailedHeadline,
    detail,
    draft: 'kept-with-pending',
    actions,
    saveDisabled: true,
  })
}

/**
 * Map one lookup answer to a display model. A found commit is Saved, publication unknown,
 * because the dispatch outcome of a save that landed late is unknown. A missing commit restores the
 * draft. An undecidable lookup shows the newer version labeled as possibly the operator's.
 */
export function describeLookup(result: LookupAnswer): OutcomeDisplay {
  if (!result.ok) return lookupFailure(result.error)

  switch (result.value.state) {
    case 'found':
      return display({
        kind: 'lookup-found',
        headline: OUTCOME_COPY.lookupFoundHeadline,
        detail: OUTCOME_COPY.lookupFoundDetail,
        draft: 'cleared',
        actions: ['retry-dispatch'],
      })
    case 'missing':
      return display({
        kind: 'lookup-missing',
        headline: OUTCOME_COPY.lookupMissingHeadline,
        detail: OUTCOME_COPY.lookupMissingDetail,
        draft: 'kept',
        actions: ['save-again'],
      })
    case 'unknown':
      return display({
        kind: 'lookup-unknown',
        headline: OUTCOME_COPY.lookupUnknownHeadline,
        detail: OUTCOME_COPY.lookupUnknownDetail,
        draft: 'kept-with-pending',
        actions: ['overwrite', 'check-status'],
        saveDisabled: true,
        versionLabel: OUTCOME_COPY.lookupUnknownVersionLabel,
      })
  }
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

export const PROMOTION_OUTCOME_COPY = {
  pendingDetail:
    'The change is waiting to be promoted to the main branch. Promotion also runs on the weekly schedule, and saving again is not needed.',
  settledHeadline: 'Saved and published',
  settledDetail: 'The change has been promoted.',
  blockedHint: 'Read the reason, then edit and save again to re-check.',
  unavailable: 'Promotion status is unavailable right now.',
  dispatchedHeadline: 'Sent for publication',
} as const

export interface PromotionDisplay {
  readonly kind: 'pending' | 'settled' | 'blocked'
  readonly headline: string
  readonly detail: string
  readonly hint: string | null
  readonly prUrl: string | null
  readonly runUrl: string | null
  /** True when polling can stop. */
  readonly settles: boolean
}

/**
 * Map a promotion status to its display. No status yet counts as pending: a save answered
 * `saved` only after the dispatch was accepted.
 */
export function describePromotion(status: PromotionStatus | null): PromotionDisplay {
  if (status === null || status.state === 'pending') {
    return {
      kind: 'pending',
      headline: OUTCOME_COPY.savedHeadline,
      detail: PROMOTION_OUTCOME_COPY.pendingDetail,
      hint: null,
      prUrl: status?.pr?.url ?? null,
      runUrl: null,
      settles: false,
    }
  }
  if (status.state === 'settled') {
    return {
      kind: 'settled',
      headline: PROMOTION_OUTCOME_COPY.settledHeadline,
      detail: PROMOTION_OUTCOME_COPY.settledDetail,
      hint: null,
      prUrl: status.pr?.url ?? null,
      runUrl: null,
      settles: true,
    }
  }
  return {
    kind: 'blocked',
    headline: 'Promotion is blocked',
    detail: blockReasonCopy(status.reason),
    hint: PROMOTION_OUTCOME_COPY.blockedHint,
    prUrl: status.pr?.url ?? null,
    runUrl: status.runUrl,
    settles: true,
  }
}

/** A retry dispatch that did not go through. The save itself is untouched. */
export function describeDispatchFailure(error: DispatchError | TransportError): string {
  switch (error.kind) {
    case 'rate-limited':
      return `Too many requests. ${rateLimitHint(error.retryAfterSeconds)}`
    case 'forbidden':
      return 'This session is not allowed to send the publication request.'
    case 'session-lost':
      return 'Your session has ended. Sign in, then try again.'
    default:
      return 'The publication request did not go through. The change is still not promoted. Try again.'
  }
}
