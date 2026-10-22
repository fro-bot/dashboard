/**
 * Unmarked-change detection (KTD16).
 *
 * Only marked corrections survive the next regeneration of a page. This is the one place
 * that decides whether a draft holds changes that are not marked.
 *
 * In this unit marking does not exist, so every change is unmarked: the draft is unmarked
 * whenever its text differs from the base text, compared exactly. Span marking replaces the
 * rule behind this function and passes the draft's marks in `marks`; the callers do not change.
 */

import type {SaveMark} from '../api/wiki.ts'

export interface UnmarkedInput {
  /** The text of the page version the draft started from. */
  readonly baseText: string
  readonly draftText: string
  /** The draft's marks. Not consulted yet: marking is not available. */
  readonly marks?: readonly SaveMark[]
}

export function hasUnmarkedChanges(input: UnmarkedInput): boolean {
  return input.draftText !== input.baseText
}
