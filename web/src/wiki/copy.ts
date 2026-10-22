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

export const EDITOR_COPY = {
  edit: 'Edit',
  resume: 'Resume draft',
  save: 'Save',
  saveAgain: 'Save again',
  cancel: 'Cancel',
  textLabel: 'Page text (raw Markdown)',
  frontmatterNote: 'Frontmatter is managed by the system. It is not shown here and cannot be edited.',
  savingAnnouncement: 'Saving…',
  checkingAnnouncement: 'Checking the save status…',
  draftBaseLabel: 'Started from page version',
  draftStaleLead: 'The page has changed since this draft started. It is now at version',
  draftStaleTail: 'Saving will compare the two and ask you to resolve any conflict.',
  draftNotStoredLocally:
    'Draft not saved locally. Your edits are still here, but they will be lost if you leave this page.',
  draftUnreadable:
    'A draft for this page could not be read from this device. It is left in place until you edit the page, which replaces it, or you discard it.',
  draftUnreadableReplaced: 'The draft that could not be read was replaced by your edits.',
  discardUnreadable: 'Discard unreadable draft',
  discardUnreadableHeading: 'Discard the unreadable draft?',
  discardUnreadableDetail: 'It is deleted from this device. This cannot be undone.',
  discardUnreadableConfirm: 'Yes, discard it',
  discardUnreadableCancel: 'Keep it',
  discardUnreadableDone: 'The unreadable draft was discarded.',
  unreadableAlreadyReplaced: 'That draft was already replaced by another tab, so it was left alone.',
  discardKeptStored:
    'Your edits were discarded. The draft already stored on this device could not be removed and is still there.',
  discardUnreadableFailed: 'The unreadable draft could not be discarded. It is still on this device.',
  draftReadFailed:
    'The draft stored for this page could not be read. Your edits will not be stored on this device, and that draft is left as it is.',
  draftKept: 'Your draft is kept on this device.',
  cancelHeading: 'Keep or discard your draft?',
  cancelDetail: 'You have changes that are not saved to the wiki.',
  cancelPendingDetail: 'Discarding also forgets the save that is still unconfirmed.',
  keepDraft: 'Keep draft',
  discardDraft: 'Discard draft',
  keepEditing: 'Keep editing',
  discardFailed: 'The draft could not be discarded. It is still on this device.',
  checkStatus: 'Check save status',
  retryDispatch: 'Retry dispatch',
  retryingDispatch: 'Sending…',
  signIn: 'Sign in',
  copyDraft: 'Copy draft',
  copied: 'Draft copied.',
  copyFailed: 'The draft could not be copied. Select the text and copy it by hand.',
  contractUnreadableNotice: 'The wiki checks could not be read, so saving may fail. Try again.',
  retry: 'Try again',
  refreshing: 'Updating the page after your save…',
  refreshFailed: 'The page could not be reloaded after your save. Try again before editing.',
  conflictCurrentHeading: 'Current version',
  conflictDraftHeading: 'Your draft',
  conflictLoading: 'Loading the current version…',
  conflictLoadFailed: 'The current version could not be loaded.',
  conflictRemoved: 'The page is no longer in the wiki.',
  conflictCorrectionsBaseHeading: 'Corrections when your draft started',
  conflictCorrectionsCurrentHeading: 'Corrections now',
  noCorrections: 'No corrections.',
  overwrite: 'Overwrite with my draft',
  overwriteConfirmHeading: 'Overwrite the current version?',
  overwriteConfirmDetail:
    'Your draft will replace the current version when you save next. Changes made since your draft started are lost from the page.',
  overwriteConfirm: 'Yes, overwrite',
  overwriteCancel: 'Keep comparing',
  rebased: 'Your draft now starts from the current version. Review it, then save.',
  findingShow: 'Show in text',
  findingPageLevel: 'About the page as a whole',
  findingsHeading: 'Findings',
  savedRetrySent: 'The publication request was sent.',
  promotionPrLink: 'View the pull request',
  promotionRunLink: 'View the blocked run',
  guardStored: 'You have unsaved changes. Your draft is kept on this device. Leave this page?',
  guardNotStored: 'You have unsaved changes that are not stored on this device. Leave this page and lose them?',
  guardUnknown: 'Your last save is unconfirmed. Leave this page anyway?',
} as const

/**
 * Only marked corrections survive the next regeneration of a page (KTD16). Marking is not
 * available yet, so every change is unmarked. A page without a `node_id` cannot be marked at all.
 */
export const UNMARKED_COPY = {
  noticeMarkedOnly:
    'Only marked corrections survive the next regeneration of this page. Marking is not available yet, so changes made here will be lost then.',
  noticeNoNodeId:
    'Edits to this page do not survive regeneration. This page cannot be marked, so changes made here will be lost the next time it is regenerated.',
  confirmHeading: 'Save unmarked changes?',
  confirmMarkedOnly:
    'Your changes are not marked as corrections. Unmarked changes will be lost at the next regeneration of this page.',
  confirmNoNodeId:
    'This page cannot be marked. Your changes will be saved, but edits to this page do not survive the next regeneration. Unmarked changes will be lost at the next regeneration.',
  confirm: 'Confirm save',
  cancel: 'Back to editing',
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
