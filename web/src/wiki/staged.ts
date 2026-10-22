/**
 * Staged correction actions (KTD10): retire, flag for reconfirmation, and reconfirm.
 *
 * An action is staged in the draft, shown as staged, can be undone, and is committed with Save as
 * a transition. It records the status and text its correction had when it was staged, so a refresh
 * that finds the correction gone or changed can drop it instead of sending it
 * (see `docs/solutions/best-practices/operator-approval-channel-consumption-2026-06-22.md`).
 */

import type {CorrectionStatus, SaveTransition, WikiCorrection} from '../api/wiki.ts'

export type StagedKind = SaveTransition['action']

export interface StagedAction {
  readonly correctionId: string
  readonly action: StagedKind
  /** The status the correction had when the action was staged. */
  readonly from: CorrectionStatus
  /** The text of the correction's span when the action was staged. */
  readonly spanText: string
}

/** The server refuses a save with more transitions than this. */
export const MAX_STAGED = 100

const KINDS: Readonly<Record<StagedKind, true>> = {retire: true, flag: true, reconfirm: true}
const STATUSES: Readonly<Record<CorrectionStatus, true>> = {
  active: true,
  superseded: true,
  retired: true,
  'needs-reconfirmation': true,
}

function isStagedKind(value: unknown): value is StagedKind {
  return typeof value === 'string' && Object.hasOwn(KINDS, value)
}

function isCorrectionStatus(value: unknown): value is CorrectionStatus {
  return typeof value === 'string' && Object.hasOwn(STATUSES, value)
}

/** An active correction can be retired or flagged. A flagged one can be reconfirmed. */
export function availableActions(correction: WikiCorrection): readonly StagedKind[] {
  if (correction.status === 'active') return ['retire', 'flag']
  if (correction.status === 'needs-reconfirmation') return ['reconfirm']
  return []
}

/**
 * No more actions can be staged: a draft with more than `MAX_STAGED` could not be read back, and the
 * server would refuse the save. Replacing the action staged for the same correction is still allowed.
 */
export function stagingFull(staged: readonly StagedAction[], correctionId: string): boolean {
  return staged.length >= MAX_STAGED && !staged.some(item => item.correctionId === correctionId)
}

/** Stage an action for a correction, replacing any action already staged for it. A full list refuses a new one. */
export function stageAction(staged: readonly StagedAction[], correction: WikiCorrection, action: StagedKind): StagedAction[] {
  if (!availableActions(correction).includes(action) || stagingFull(staged, correction.id)) return [...staged]
  return [
    ...staged.filter(item => item.correctionId !== correction.id),
    {correctionId: correction.id, action, from: correction.status, spanText: correction.span.text},
  ]
}

export function undoStaged(staged: readonly StagedAction[], correctionId: string): StagedAction[] {
  return staged.filter(item => item.correctionId !== correctionId)
}

export function transitionsOf(staged: readonly StagedAction[]): SaveTransition[] {
  return staged.map(item => ({id: item.correctionId, action: item.action}))
}

/**
 * Check the staged actions against the corrections as they are now. An action stays only if its
 * correction is still there with the status and text it had when the action was staged.
 */
export function reconcileStaged(
  staged: readonly StagedAction[],
  corrections: readonly WikiCorrection[],
): {readonly kept: StagedAction[]; readonly dropped: StagedAction[]} {
  const kept: StagedAction[] = []
  const dropped: StagedAction[] = []
  for (const item of staged) {
    const current = corrections.find(correction => correction.id === item.correctionId)
    if (current !== undefined && current.status === item.from && current.span.text === item.spanText) kept.push(item)
    else dropped.push(item)
  }
  return {kept, dropped}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the staged actions of a stored draft. Null means the record cannot be read. */
export function parseStaged(value: unknown): StagedAction[] | null {
  if (!Array.isArray(value) || value.length > MAX_STAGED) return null
  const staged: StagedAction[] = []
  const seen = new Set<string>()
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return null
    const {correctionId, action, from, spanText} = item
    if (typeof correctionId !== 'string' || correctionId === '' || seen.has(correctionId)) return null
    if (!isStagedKind(action) || !isCorrectionStatus(from) || typeof spanText !== 'string') return null
    seen.add(correctionId)
    staged.push({correctionId, action, from, spanText})
  }
  return staged
}
