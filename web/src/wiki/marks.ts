/**
 * Marks: the spans of a draft that the operator calls corrections.
 *
 * A mark is a UTF-16 start and end plus a quote anchor, the exact text with a short prefix and
 * suffix. The text is the load-bearing field: it is what the server stores, and it decides where a
 * mark is. The offsets are hints that the editor keeps fresh as the draft changes, so a mark
 * survives typing before it, after it and inside it. A mark whose text has gone from the draft is
 * detached. It is kept, so undoing the edit brings it back, but it blocks Save until it is
 * removed.
 *
 * A mark can also carry a needs-review flag, set by a later merge when it cannot place the mark with
 * confidence. A flagged mark blocks Save until it is kept or removed.
 *
 * Offsets are UTF-16 code units, the unit of `textarea.selectionStart` and of the wire format.
 * A selection that splits a surrogate pair is widened to the whole code point. Combining
 * characters are not widened: the text of a mark is exactly what was selected.
 */

import type {SaveMark} from '../api/wiki.ts'

/** How much text on each side a mark records. */
export const MARK_CONTEXT_LENGTH = 24

/** The server refuses a save with more marks than this, or a mark with longer text. */
export const MAX_MARKS = 100
export const MAX_MARK_TEXT_LENGTH = 4096

/** A search that finds more candidates than this gives up on the rest. */
const MAX_CANDIDATES = 5000

export interface Mark {
  /** Local to the draft. Never sent. The server mints the correction ID. */
  readonly id: string
  /**
   * UTF-16 offsets into the draft. An unplaced mark carries sentinel offsets (see `unplaceMark`),
   * so read them only after `isPlaced` holds.
   */
  readonly start: number
  readonly end: number
  readonly text: string
  readonly prefix: string
  readonly suffix: string
  readonly needsReview: boolean
}

export interface Range {
  readonly start: number
  readonly end: number
}

export type MarkRefusal = 'empty' | 'too-long' | 'too-many' | 'duplicate'

export type CreatedMark =
  | {readonly ok: true; readonly mark: Mark}
  | {readonly ok: false; readonly reason: MarkRefusal}

/** `ok`: in the draft and settled. `review`: flagged. `detached`: its text is not in the draft. */
export type MarkState = 'ok' | 'review' | 'detached'

// ---------------------------------------------------------------------------
// Code points
// ---------------------------------------------------------------------------

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

/** Widen a range that starts or ends between the halves of a surrogate pair. Clamps to the text. */
export function snapToCodePoints(text: string, start: number, end: number): Range {
  let from = Math.min(Math.max(start, 0), text.length)
  let to = Math.min(Math.max(end, 0), text.length)
  if (from > 0 && from < text.length && isLowSurrogate(text.charCodeAt(from)) && isHighSurrogate(text.charCodeAt(from - 1))) {
    from -= 1
  }
  if (to > 0 && to < text.length && isLowSurrogate(text.charCodeAt(to)) && isHighSurrogate(text.charCodeAt(to - 1))) {
    to += 1
  }
  return {start: from, end: to}
}

/** The text on each side of a range, trimmed so neither side begins or ends in half a pair. */
function contextAround(text: string, start: number, end: number): {readonly prefix: string; readonly suffix: string} {
  let prefix = text.slice(Math.max(0, start - MARK_CONTEXT_LENGTH), start)
  if (prefix !== '' && isLowSurrogate(prefix.charCodeAt(0))) prefix = prefix.slice(1)
  let suffix = text.slice(end, end + MARK_CONTEXT_LENGTH)
  if (suffix !== '' && isHighSurrogate(suffix.charCodeAt(suffix.length - 1))) suffix = suffix.slice(0, -1)
  return {prefix, suffix}
}

// ---------------------------------------------------------------------------
// Create, keep, remove
// ---------------------------------------------------------------------------

function nextId(existing: readonly Mark[]): string {
  let highest = 0
  for (const mark of existing) {
    const match = /^m(\d+)$/u.exec(mark.id)
    if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]))
  }
  return `m${Math.max(highest, existing.length) + 1}`
}

/** Mark a selection of the draft. The selection is widened to whole code points first. */
export function createMark(text: string, selection: Range, existing: readonly Mark[]): CreatedMark {
  const {start, end} = snapToCodePoints(text, selection.start, selection.end)
  if (end <= start) return {ok: false, reason: 'empty'}
  if (end - start > MAX_MARK_TEXT_LENGTH) return {ok: false, reason: 'too-long'}
  if (existing.length >= MAX_MARKS) return {ok: false, reason: 'too-many'}

  const quoted = text.slice(start, end)
  if (existing.some(mark => mark.start === start && mark.end === end && mark.text === quoted)) {
    return {ok: false, reason: 'duplicate'}
  }
  return {
    ok: true,
    mark: {id: nextId(existing), start, end, text: quoted, ...contextAround(text, start, end), needsReview: false},
  }
}

export function removeMark(marks: readonly Mark[], id: string): Mark[] {
  return marks.filter(mark => mark.id !== id)
}

/**
 * The end offset of a mark that has no place in the text. It is the largest safe integer, so no text
 * has a position there and the stored mark still reads back as a valid mark.
 */
const UNPLACED_END = Number.MAX_SAFE_INTEGER

/**
 * The mark with no place in the text: it keeps its text, is flagged, and cannot be kept or sent. A merge
 * that cannot carry a mark leaves it so, because the draft's offsets mean nothing in the merged text.
 */
export function unplaceMark(mark: Mark): Mark {
  return {...mark, start: UNPLACED_END - mark.text.length, end: UNPLACED_END, needsReview: true}
}

export function isPlaced(mark: Mark): boolean {
  return mark.end !== UNPLACED_END
}

/** Whether the mark's text stands at the offsets the mark records, and a search for it finds that place. */
function standsAtOwnOffsets(text: string, mark: Mark): boolean {
  const found = locateMark(text, mark)
  return found !== null && found.start === mark.start && found.end === mark.end
}

/**
 * Keep a flagged mark: clear its flag. A mark is kept only where its text stands at its own offsets,
 * so a kept mark is the span the operator marked and never another occurrence of the same words.
 */
export function keepMark(marks: readonly Mark[], id: string, text: string): Mark[] {
  return marks.map(mark => (mark.id === id && standsAtOwnOffsets(text, mark) ? {...mark, needsReview: false} : mark))
}

// ---------------------------------------------------------------------------
// Locate
// ---------------------------------------------------------------------------

function commonSuffixLength(a: string, b: string): number {
  let length = 0
  while (length < a.length && length < b.length && a[a.length - 1 - length] === b[b.length - 1 - length]) length += 1
  return length
}

function commonPrefixLength(a: string, b: string): number {
  let length = 0
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1
  return length
}

/**
 * Where a mark is in the text now, or null when its text is gone. The text decides: a mark whose
 * offsets are right is taken as they say. Otherwise the occurrences of its text are compared by how
 * much of the recorded prefix and suffix they share, and ties go to the one nearest the offsets.
 */
export function locateMark(text: string, mark: Mark): Range | null {
  const quoted = mark.text
  if (quoted === '') return null

  // The offsets are right when the text and both surroundings are where they say.
  if (
    text.startsWith(quoted, mark.start) &&
    text.slice(Math.max(0, mark.start - mark.prefix.length), mark.start) === mark.prefix &&
    text.startsWith(mark.suffix, mark.start + quoted.length)
  ) {
    return {start: mark.start, end: mark.start + quoted.length}
  }

  let best: {readonly start: number; readonly score: number; readonly distance: number} | null = null
  let candidates = 0
  for (let at = text.indexOf(quoted); at >= 0 && candidates < MAX_CANDIDATES; at = text.indexOf(quoted, at + 1)) {
    candidates += 1
    const before = text.slice(Math.max(0, at - mark.prefix.length), at)
    const after = text.slice(at + quoted.length, at + quoted.length + mark.suffix.length)
    const score = commonSuffixLength(before, mark.prefix) + commonPrefixLength(after, mark.suffix)
    const distance = Math.abs(at - mark.start)
    if (best === null || score > best.score || (score === best.score && distance < best.distance)) {
      best = {start: at, score, distance}
    }
  }
  return best === null ? null : {start: best.start, end: best.start + quoted.length}
}

/**
 * `review` is a flagged mark that can be kept, which is one whose text stands at its own offsets. A
 * flagged mark whose text stands only somewhere else, or that has no place, is `detached`: it can
 * only be removed, and the text marked again.
 */
export function markState(text: string, mark: Mark): MarkState {
  if (locateMark(text, mark) === null) return 'detached'
  if (!mark.needsReview) return 'ok'
  return standsAtOwnOffsets(text, mark) ? 'review' : 'detached'
}

/** The marks that go on the wire: each attached mark with its current text and offsets, in text order. */
export function saveMarksOf(text: string, marks: readonly Mark[]): SaveMark[] {
  const located: SaveMark[] = []
  for (const mark of marks) {
    if (!isPlaced(mark)) continue
    const range = locateMark(text, mark)
    if (range !== null) located.push({text: text.slice(range.start, range.end), start: range.start, end: range.end})
  }
  return located.sort((a, b) => a.start - b.start)
}

// ---------------------------------------------------------------------------
// Rebase through an edit
// ---------------------------------------------------------------------------

interface Change {
  /** The first changed offset, the same in the old and the new text. */
  readonly start: number
  /** Where the changed region ends in the old text, and in the new text. */
  readonly oldEnd: number
  readonly newEnd: number
}

/** The one region that differs: the old text without its common head and tail. */
function changeBetween(oldText: string, newText: string): Change {
  const shortest = Math.min(oldText.length, newText.length)
  let head = 0
  while (head < shortest && oldText.charCodeAt(head) === newText.charCodeAt(head)) head += 1
  // Do not end the common head between the halves of a pair.
  if (head > 0 && head < oldText.length && isHighSurrogate(oldText.charCodeAt(head - 1)) && isLowSurrogate(oldText.charCodeAt(head))) {
    head -= 1
  }

  let tail = 0
  while (
    tail < shortest - head &&
    oldText.charCodeAt(oldText.length - 1 - tail) === newText.charCodeAt(newText.length - 1 - tail)
  ) {
    tail += 1
  }
  const tailStart = oldText.length - tail
  if (tail > 0 && tailStart > 0 && isLowSurrogate(oldText.charCodeAt(tailStart)) && isHighSurrogate(oldText.charCodeAt(tailStart - 1))) {
    tail -= 1
  }
  return {start: head, oldEnd: oldText.length - tail, newEnd: newText.length - tail}
}

/**
 * Where the browser says an input event happened: `caret`, the textarea's caret after the event, and
 * `inserted`, the length of the text it inserted when the browser reports one (typing and
 * composition do; a paste does not). The caret is the end of what was inserted, or the point of a
 * deletion.
 */
export interface EditHint {
  readonly caret: number
  readonly inserted?: number | undefined
}

/**
 * Place the change where the browser says it happened. The minimal region can lie a few characters
 * away from the real edit when the typed or deleted text repeats the text around it: typing "r" over
 * "right suff" in "left right suffix." leaves "left rix.", and the diff reads that as "ght suffi"
 * deleted after "left ri", or as a deletion after "left r" with the typed "r" absorbed into the old
 * one. The real edit ends at the caret, and replaced `inserted` characters with the removed text. The
 * region is moved there when that gives the same new text, and otherwise stays where the diff put it.
 */
function alignToHint(oldText: string, newText: string, change: Change, hint: EditHint | undefined): Change {
  if (hint === undefined || !Number.isSafeInteger(hint.caret) || hint.caret < 0 || hint.caret > newText.length) return change
  const {caret} = hint
  const splits = (text: string, at: number) =>
    at > 0 && at < text.length && isHighSurrogate(text.charCodeAt(at - 1)) && isLowSurrogate(text.charCodeAt(at))

  const candidate = (inserted: number, removed: number): Change | null => {
    const start = caret - inserted
    const oldEnd = start + removed
    if (inserted < 0 || removed < 0 || start < 0 || oldEnd > oldText.length) return null
    if (newText.slice(0, start) !== oldText.slice(0, start) || newText.slice(caret) !== oldText.slice(oldEnd)) return null
    if (splits(newText, start) || splits(newText, caret) || splits(oldText, start) || splits(oldText, oldEnd)) return null
    return {start, oldEnd, newEnd: caret}
  }

  if (hint.inserted !== undefined) {
    const exact = candidate(hint.inserted, hint.inserted - (newText.length - oldText.length))
    if (exact !== null) return exact
  }
  return candidate(change.newEnd - change.start, change.oldEnd - change.start) ?? change
}

function anchored(text: string, mark: Mark, range: Range): Mark {
  return {...mark, ...range, text: text.slice(range.start, range.end), ...contextAround(text, range.start, range.end)}
}

/** The mark placed on `range` of `text`, with its text and the context around it read from there. */
export const anchorMark = anchored

/**
 * Whether an insertion is, as far as the text can tell, at `floor`. The same text results from
 * inserting at any offset the inserted run can slide to: typing "c" before "cat" gives "ccat",
 * which is also "c" inserted after the first "c". The diff places the insertion as far right as it
 * can, so it can only look inside a mark when the insertion could equally sit at the mark's start.
 */
function insertionCouldStartAt(newText: string, start: number, length: number, floor: number): boolean {
  let at = start
  while (at > floor && newText.charCodeAt(at - 1) === newText.charCodeAt(at - 1 + length)) at -= 1
  return at <= floor
}

function rebaseOne(mark: Mark, oldText: string, newText: string, change: Change): Mark {
  // An unplaced mark has no place to carry, and an edit does not give it one.
  if (!isPlaced(mark)) return mark
  const wasAttached = oldText.startsWith(mark.text, mark.start) && mark.end === mark.start + mark.text.length
  if (!wasAttached) {
    // A flagged mark is never found again by searching for its text: it stays where it is if its text
    // stands there now, as when an undo brings the text back, and otherwise it has no place.
    if (mark.needsReview) return standsAtOwnOffsets(newText, mark) ? mark : unplaceMark(mark)
    // Detached before this edit: the edit may have brought its text back.
    const found = locateMark(newText, mark)
    return found === null ? mark : anchored(newText, mark, found)
  }

  const {start: a, end: b} = mark
  const delta = change.newEnd - change.oldEnd
  if (b <= change.start) {
    // The change is after the mark, or begins exactly where it ends.
    return anchored(newText, mark, {start: a, end: b})
  }
  if (a >= change.oldEnd) {
    // The change is before the mark, or ends exactly where it begins.
    return anchored(newText, mark, {start: a + delta, end: b + delta})
  }
  const insertion = change.start === change.oldEnd
  if (insertion && insertionCouldStartAt(newText, change.start, change.newEnd - change.start, a)) {
    // An insertion that could be at the start of the mark is at its start: the mark shifts.
    return anchored(newText, mark, {start: a + delta, end: b + delta})
  }
  if (change.start >= a && change.oldEnd <= b) {
    // The change lies inside the mark: the mark follows what is there now.
    // A change that deletes the whole mark leaves nothing of it. It keeps its text and is flagged.
    return b + delta <= a ? {...mark, needsReview: true} : anchored(newText, mark, {start: a, end: b + delta})
  }

  // The change crosses an edge of the mark. Only what survives of the original span outside the
  // changed region stays marked, and the operator is asked to keep it or remove it.
  const before = change.start > a ? {start: a, end: change.start} : null
  const after = change.oldEnd < b ? {start: change.oldEnd + delta, end: b + delta} : null
  // Not both: a change that leaves text on both sides of itself lies inside the mark, handled above.
  const survivor = before ?? after
  if (survivor === null) return {...mark, needsReview: true}
  return {...anchored(newText, mark, survivor), needsReview: true}
}

/**
 * Carry the marks through an edit from `oldText` to `newText`. The edit is taken as one region, the
 * text between the common head and the common tail, which is exact for typing, pasting and deleting.
 * The editor calls this for every input event, so a keystroke is one edit. `hint` says where the
 * browser saw the edit; it places the edit when the diff alone cannot tell where it was.
 *
 * - A mark outside the region moves with the text.
 * - An insertion at the start or the end of a mark does not grow it. The mark keeps its text and
 *   moves as an edit before or after it would move it. An insertion that could equally sit at the
 *   start of the mark, such as a repeated character, counts as at the start.
 * - A mark grows or shrinks only when the region lies inside it: an insertion strictly inside the
 *   mark, or a replacement or deletion within its span, including a replacement of exactly its text.
 * - When the region crosses an edge of a mark, the mark is clipped to the part of its original span
 *   that survives outside the region and is flagged for review, so unmarked text is never taken into
 *   a mark.
 * - A mark whose whole span lies in the region keeps its text and is flagged for review. It is
 *   detached where that text no longer stands. Where the same text stands elsewhere, the mark is not
 *   at its own offsets there, so it is detached too and can only be removed. A later edit does not
 *   find it there: a flagged mark whose text does not stand at its own offsets is left unplaced.
 */
export function rebaseMarks(
  marks: readonly Mark[],
  oldText: string,
  newText: string,
  hint?: EditHint,
): readonly Mark[] {
  if (oldText === newText || marks.length === 0) return marks
  const change = alignToHint(oldText, newText, changeBetween(oldText, newText), hint)
  return marks.map(mark => rebaseOne(mark, oldText, newText, change))
}

/**
 * Rebase the marks, then drop any whose text has grown past what the server accepts. A mark that long
 * could not be stored in the draft or sent in a save, so it must not outlive the edit that made it.
 * `dropped` counts the marks removed, for the notice.
 */
export function rebaseAndLimit(
  marks: readonly Mark[],
  oldText: string,
  newText: string,
  hint?: EditHint,
): {readonly marks: readonly Mark[]; readonly dropped: number} {
  const rebased = rebaseMarks(marks, oldText, newText, hint)
  const kept = rebased.filter(mark => mark.text.length <= MAX_MARK_TEXT_LENGTH)
  return kept.length === rebased.length ? {marks: rebased, dropped: 0} : {marks: kept, dropped: rebased.length - kept.length}
}

// ---------------------------------------------------------------------------
// Draft storage
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMark(value: unknown): Mark | null {
  if (!isRecord(value)) return null
  const {id, start, end, text, prefix, suffix, needsReview} = value
  if (typeof id !== 'string' || id === '' || typeof text !== 'string' || text === '') return null
  if (text.length > MAX_MARK_TEXT_LENGTH) return null
  if (typeof prefix !== 'string' || typeof suffix !== 'string' || typeof needsReview !== 'boolean') return null
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null
  return {id, start, end, text, prefix, suffix, needsReview}
}

/** Parse the marks of a stored draft. Null means the record cannot be read. */
export function parseMarks(value: unknown): Mark[] | null {
  if (!Array.isArray(value) || value.length > MAX_MARKS) return null
  const marks: Mark[] = []
  const seen = new Set<string>()
  for (const item of value as unknown[]) {
    const mark = parseMark(item)
    if (mark === null || seen.has(mark.id)) return null
    seen.add(mark.id)
    marks.push(mark)
  }
  return marks
}
