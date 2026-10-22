/**
 * Operator-facing copy for the wiki views, in one place.
 *
 * Reason codes from the server map to short, plain sentences. The text is fixed: no raw
 * response body, status code, URL, token, or stack trace reaches the screen, and an
 * unknown code falls back to a generic sentence rather than being echoed.
 */

import type {BlockReason, CorrectionStatus, ReadFailureKind, TransportError, WikiPageType} from '../api/wiki.ts'

export interface StateCopy {
  readonly headline: string
  readonly detail: string
}

// ---------------------------------------------------------------------------
// Page types
// ---------------------------------------------------------------------------

export const PAGE_TYPE_LABEL: Readonly<Record<WikiPageType, string>> = {
  repos: 'Repositories',
  topics: 'Topics',
  entities: 'Entities',
  comparisons: 'Comparisons',
}

// ---------------------------------------------------------------------------
// Read failures
// ---------------------------------------------------------------------------

export type ReadFailureCopyKey = ReadFailureKind | TransportError['kind']

const READ_FAILURE_COPY: Readonly<Record<ReadFailureCopyKey, StateCopy>> = {
  'not-found': {headline: 'Page not found', detail: 'This page does not exist in the wiki.'},
  'page-invalid': {
    headline: 'This page cannot be shown',
    detail: 'The page is stored in a form the dashboard does not recognise.',
  },
  'corrections-corrupt': {
    headline: 'Corrections cannot be shown',
    detail: 'The corrections file is damaged, so pages cannot be shown right now.',
  },
  unavailable: {
    headline: 'The wiki is unavailable',
    detail: 'The wiki could not be reached. Nothing was changed. Try again in a moment.',
  },
  forbidden: {
    headline: 'Access denied',
    detail: 'This session is not allowed to read the wiki.',
  },
  'session-lost': {
    headline: 'Your session has ended',
    detail: 'Sign in again to continue.',
  },
  network: {
    headline: 'No connection',
    detail: 'The dashboard could not be reached. Check your connection, then try again.',
  },
  timeout: {
    headline: 'The request timed out',
    detail: 'The wiki took too long to answer. Try again.',
  },
  'rate-limited': {
    headline: 'Too many requests',
    detail: 'The wiki is limiting requests for a moment. Wait a little, then try again.',
  },
  'contract-drift': {
    headline: 'Unexpected response',
    detail: 'The dashboard received a reply it does not understand. Reload the page and try again.',
  },
}

export function readFailureCopy(kind: ReadFailureCopyKey): StateCopy {
  return READ_FAILURE_COPY[kind]
}

/** Failures where asking again cannot help. */
export function isRetryable(kind: ReadFailureCopyKey): boolean {
  return kind !== 'forbidden' && kind !== 'not-found' && kind !== 'session-lost'
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

const BLOCK_REASON_COPY: Readonly<Record<BlockReason, string>> = {
  'private-page': 'A page marked private is in the change set.',
  'private-repo-name': 'A private repository name appears in the change set.',
  'promotion-diff': 'The change set differs from what the promotion expected.',
  'privacy-check': 'The privacy check failed.',
  merge: 'The change could not be merged.',
  'open-pr': 'An earlier promotion pull request is still open.',
  unknown: 'The promotion stopped for a reason the dashboard cannot name.',
}

export function blockReasonCopy(reason: BlockReason): string {
  return Object.hasOwn(BLOCK_REASON_COPY, reason) ? BLOCK_REASON_COPY[reason] : BLOCK_REASON_COPY.unknown
}

export const PROMOTION_COPY = {
  blockedHeadline: 'Promotion is blocked',
  blockedRunLink: 'View the blocked run',
  pendingHeadline: 'Promotion is pending',
  pendingDetail: 'Saved changes are waiting to be promoted to the main branch.',
  pullRequestLink: 'View the pull request',
  unavailableNote: 'Promotion status is unavailable right now. Pages are still listed below.',
} as const

// ---------------------------------------------------------------------------
// Write capability
// ---------------------------------------------------------------------------

const CAN_WRITE_REASON_COPY: Readonly<Record<string, string>> = {
  'not-operator': 'This session is not the operator, so pages open read-only.',
  'session-not-supported': 'This kind of session cannot edit the wiki, so pages open read-only.',
  'app-credentials-absent': 'Wiki editing is not set up on this server, so pages open read-only.',
  'app-credentials-incomplete': 'Wiki editing is only partly set up on this server, so pages open read-only.',
  'operator-id-unset': 'Wiki editing is not set up on this server, so pages open read-only.',
}

const CAN_WRITE_FALLBACK = 'Editing is not available for this session, so pages open read-only.'

export function canWriteReasonCopy(reason: string | null): string {
  return reason !== null && Object.hasOwn(CAN_WRITE_REASON_COPY, reason)
    ? (CAN_WRITE_REASON_COPY[reason] as string)
    : CAN_WRITE_FALLBACK
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export const CORRECTION_STATUS_LABEL: Readonly<Record<CorrectionStatus, string>> = {
  active: 'Active',
  superseded: 'Superseded',
  retired: 'Retired',
  'needs-reconfirmation': 'Needs reconfirmation',
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const LIST_COPY = {
  heading: 'Wiki',
  loading: 'Loading wiki pages…',
  emptyHeadline: 'No pages yet',
  emptyDetail: 'The wiki has no pages to show.',
  retry: 'Try again',
  signIn: 'Sign in',
  draftMarker: 'Local draft',
  draftMarkerDetail: 'This page has an unsaved draft on this device.',
  updatedLabel: 'Updated',
  noDate: 'No date',
  orphanHeading: 'Drafts without a page',
  orphanDetail: 'These drafts are kept on this device, but their pages are no longer in the wiki.',
  orphanOpen: 'Open draft',
  orphanSaved: 'Draft saved',
  draftsUnavailable: 'Local drafts are unavailable in this browser, so drafts are not shown.',
  draftsUnreadable: 'Some drafts on this device could not be read. They have not been deleted.',
} as const

export const PAGE_COPY = {
  loading: 'Loading page…',
  back: 'Back to the wiki list',
  bodyHeading: 'Page text',
  bodyNote: 'Raw Markdown, shown as stored.',
  correctionsHeading: 'Corrections',
  noCorrections: 'No corrections recorded for this page.',
  readOnlyHeading: 'Read-only',
  stale: 'Out of date',
  spanLabel: 'Corrected text',
  reasonLabel: 'Reason',
  recordedLabel: 'Recorded',
  supersededByLabel: 'Replaced by',
  retry: 'Try again',
  signIn: 'Sign in',
  notFoundHeadline: 'Page not found',
  notFoundDetail: 'No page has this ID. It may have been renamed or removed.',
} as const

export const ORPHAN_COPY = {
  heading: 'Draft without a page',
  detail: 'This page is no longer in the wiki. Your draft is still on this device and is shown read-only.',
  textHeading: 'Draft text',
  copy: 'Copy draft',
  copied: 'Draft copied.',
  copyFailed: 'The draft could not be copied. Select the text and copy it by hand.',
  discard: 'Discard draft',
  discardConfirmHeading: 'Discard this draft?',
  discardConfirmDetail: 'The draft is deleted from this device. This cannot be undone.',
  discardConfirm: 'Discard draft',
  discardCancel: 'Keep draft',
  discarded: 'Draft discarded.',
  discardFailed: 'The draft could not be discarded. It is still on this device.',
  loadFailed: 'The draft could not be read from this device.',
} as const
