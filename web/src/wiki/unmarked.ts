/**
 * Unmarked-change detection (KTD16, second stage).
 *
 * Only marked corrections survive the next regeneration of a page. This is the one place
 * that decides whether a draft holds changes that are not marked.
 *
 * 1. A line-level diff of the base text against the draft finds the changed blocks.
 * 2. A word-level diff inside each block finds the changed ranges, in draft coordinates.
 * 3. A changed range is marked when the union of the marked spans covers all of it. A range
 *    outside every span is unmarked. A deletion has no text left in the draft to cover, so it
 *    is marked only when a span surrounds the gap where the text was removed, with marked text on
 *    both sides of it. A span that only touches one edge of the gap does not cover the deletion.
 *
 * A diff of a very large input would hang the tab: its cost grows much faster than the input. So
 * each stage is sized before it runs, and a draft over any budget is answered `unavailable`
 * without diffing anything. The line-level diff is sized by its work, matching line pairs times
 * lines (`MAX_LINE_WORK`). The word-level diffs are sized by area, base characters times draft
 * characters: each block against `MAX_DIFF_AREA`, and all of them together against
 * `MAX_TOTAL_DIFF_AREA`. The caller must treat `unavailable` as unmarked changes it cannot rule
 * out, never as no changes.
 *
 * The word-level diff runs over the words and punctuation only. Whitespace is left out of the
 * diff and compared between the words that match: a whitespace run repeats so often that, as
 * diff tokens, it makes a plain longest-common-subsequence diff cubic in the size of a block. Text is compared exactly, with no normalization, so a change in whitespace is still a
 * change. Offsets are UTF-16 code units, as in the textarea and on the wire. The diff primitive is
 * `diffIndices` from `node-diff3`, a plain longest-common-subsequence diff.
 */

import {diffIndices} from 'node-diff3'
import type {SaveMark} from '../api/wiki.ts'

/**
 * The most a single word-level diff may cost: base characters times draft characters of the block
 * (or the line pair) it compares. A diff costs about 0.1 s at an area of 100 million and about
 * 0.3 s at 200 million, and grows faster than the area beyond that. 200 million is about 14,000
 * characters on each side. A scattered edit is a line of about a hundred characters, an area near
 * ten thousand.
 */
export const MAX_DIFF_AREA = 200_000_000

/**
 * The most the comparisons of one draft may cost together: the sum of the areas of every block and
 * line pair the word-level diff would run on. Cost is about 1 ms per million of area, so this bound
 * keeps detection near half a second however the area is split among blocks.
 */
export const MAX_TOTAL_DIFF_AREA = 400_000_000

/**
 * The most work the line-level diff may do on a draft: matching line pairs times the larger line
 * count. A pair is a base line and a draft line with the same text, so blank lines and repeated
 * separators make many: for each distinct line, its count in the base times its count in the draft.
 * The diff scans the pairs for every line, so its cost follows pairs times lines: about 0.4 ms per
 * million. This bound keeps the line diff near half a second. A page of distinct lines has about as
 * many pairs as lines, so its work is the square of its line count, and a paragraph page with a
 * blank line after every three content lines has pairs growing with the square of its length.
 */
export const MAX_LINE_WORK = 1_000_000_000

/**
 * `marked`: every change is inside a marked span, or nothing changed. `unmarked`: a change is outside
 * the marks. `unavailable`: a changed block is too large to check, so nothing is known.
 */
export type UnmarkedResult = 'marked' | 'unmarked' | 'unavailable'

export interface UnmarkedInput {
  /** The text of the page version the draft started from. */
  readonly baseText: string
  readonly draftText: string
  /** The draft's marks, as spans of the draft text. */
  readonly marks?: readonly SaveMark[]
}

/**
 * A changed range of the draft. With `start < end` it is text that is new or replaced. With
 * `start === end` it is a deletion. The text was removed somewhere in the gap between the words
 * on each side of it, `[gapStart, gapEnd]`.
 */
interface Change {
  readonly start: number
  readonly end: number
  readonly gapStart: number
  readonly gapEnd: number
}

interface Span {
  readonly start: number
  readonly end: number
}

/** A word or a punctuation mark, with its place in the text it came from. */
interface Word {
  readonly text: string
  readonly start: number
  readonly end: number
}

/** Lines keep their terminator, so the offset of a line is the sum of the lengths before it. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? []
}

/** `offsets[i]` is the offset of item `i`; the last entry is the total length. */
function offsetsOf(items: readonly string[]): number[] {
  const offsets = [0]
  let total = 0
  for (const item of items) {
    total += item.length
    offsets.push(total)
  }
  return offsets
}

/**
 * Word runs (letters, combining marks, digits, underscore) and single other code points, with
 * whitespace skipped. Every character that is not whitespace falls in one of the two.
 */
function wordsOf(text: string): Word[] {
  const words: Word[] = []
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu)) {
    words.push({text: match[0], start: match.index, end: match.index + match[0].length})
  }
  return words
}

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char)

/**
 * The part of `draft` that differs from `base`, where both are the text between two matched words.
 * Only whitespace common to both ends is set aside, so a changed word is never split.
 */
function changedPart(base: string, draft: string): {readonly head: number; readonly tail: number} {
  let head = 0
  while (head < base.length && head < draft.length && base[head] === draft[head] && isSpace(draft[head])) head += 1
  let tail = 0
  while (
    tail < base.length - head &&
    tail < draft.length - head &&
    base[base.length - 1 - tail] === draft[draft.length - 1 - tail] &&
    isSpace(draft[draft.length - 1 - tail])
  ) {
    tail += 1
  }
  return {head, tail}
}

/** The changes inside one block, as ranges of the draft (the draft block starts at `draftOffset`). */
function* blockChanges(baseBlock: string, draftBlock: string, draftOffset: number): Generator<Change> {
  const baseWords = wordsOf(baseBlock)
  const draftWords = wordsOf(draftBlock)

  // The words the two blocks share, in order. They anchor the comparison of what lies between them.
  const anchors: {readonly base: number; readonly draft: number}[] = []
  let baseAt = 0
  let draftAt = 0
  const takeShared = (baseUntil: number, draftUntil: number) => {
    for (; baseAt < baseUntil && draftAt < draftUntil; baseAt += 1, draftAt += 1) anchors.push({base: baseAt, draft: draftAt})
  }
  for (const chunk of diffIndices(
    baseWords.map(word => word.text),
    draftWords.map(word => word.text),
  )) {
    takeShared(chunk.buffer1[0], chunk.buffer2[0])
    baseAt = chunk.buffer1[0] + chunk.buffer1[1]
    draftAt = chunk.buffer2[0] + chunk.buffer2[1]
  }
  takeShared(baseWords.length, draftWords.length)

  // Between each pair of neighbouring anchors (and the block's ends), the base and draft text either
  // match or they do not. What does not match is a change.
  for (let k = -1; k < anchors.length; k += 1) {
    const before = anchors[k]
    const after = anchors[k + 1]
    const baseFrom = before === undefined ? 0 : (baseWords[before.base] as Word).end
    const baseTo = after === undefined ? baseBlock.length : (baseWords[after.base] as Word).start
    const draftFrom = before === undefined ? 0 : (draftWords[before.draft] as Word).end
    const draftTo = after === undefined ? draftBlock.length : (draftWords[after.draft] as Word).start

    const baseGap = baseBlock.slice(baseFrom, baseTo)
    const draftGap = draftBlock.slice(draftFrom, draftTo)
    if (baseGap === draftGap) continue

    const {head, tail} = changedPart(baseGap, draftGap)
    yield {
      start: draftOffset + draftFrom + head,
      end: draftOffset + draftTo - tail,
      gapStart: draftOffset + draftFrom,
      gapEnd: draftOffset + draftTo,
    }
  }
}

/** One word-level comparison: a block of base text against the draft text it became. */
interface Problem {
  readonly base: string
  readonly draft: string
  /** Where the draft text starts in the draft. */
  readonly offset: number
}

/** Matching line pairs: for each distinct line, its count in the base times its count in the draft. */
function matchingLinePairs(baseLines: readonly string[], draftLines: readonly string[]): number {
  const draftCounts = new Map<string, number>()
  for (const line of draftLines) draftCounts.set(line, (draftCounts.get(line) ?? 0) + 1)
  const baseCounts = new Map<string, number>()
  for (const line of baseLines) baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1)
  let pairs = 0
  for (const [line, count] of baseCounts) pairs += count * (draftCounts.get(line) ?? 0)
  return pairs
}

/** The line-level diff, as the comparisons the word-level diff has to make. Cheap: no words yet. */
function problemsOf(baseText: string, draftText: string): Problem[] | 'unavailable' {
  const baseLines = splitLines(baseText)
  const draftLines = splitLines(draftText)
  // The line diff scans the matching pairs for every line, so it is sized before it runs.
  if (matchingLinePairs(baseLines, draftLines) * Math.max(baseLines.length, draftLines.length) > MAX_LINE_WORK) {
    return 'unavailable'
  }
  const lineOffsets = offsetsOf(draftLines)
  const problems: Problem[] = []

  for (const block of diffIndices(baseLines, draftLines)) {
    const [baseIndex, baseLength] = block.buffer1
    const [draftIndex, draftLength] = block.buffer2

    if (baseLength === draftLength) {
      // The same number of lines changed on both sides: each line became its counterpart. Comparing
      // them in pairs keeps every word-level diff to one line, however long the run of edited lines.
      for (let k = 0; k < baseLength; k += 1) {
        problems.push({
          base: baseLines[baseIndex + k] as string,
          draft: draftLines[draftIndex + k] as string,
          offset: lineOffsets[draftIndex + k] as number,
        })
      }
      continue
    }

    problems.push({
      base: baseLines.slice(baseIndex, baseIndex + baseLength).join(''),
      draft: draftLines.slice(draftIndex, draftIndex + draftLength).join(''),
      offset: lineOffsets[draftIndex] as number,
    })
  }
  return problems
}

/** The marked spans merged into disjoint spans, so a range lies in the union only if it lies in one. */
function mergedSpans(marks: readonly SaveMark[], length: number): Span[] {
  const spans = marks
    .map(mark => ({start: Math.max(0, mark.start), end: Math.min(length, mark.end)}))
    .filter(span => span.end > span.start)
    .sort((a, b) => a.start - b.start)

  const merged: Span[] = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last !== undefined && span.start <= last.end) merged[merged.length - 1] = {start: last.start, end: Math.max(last.end, span.end)}
    else merged.push(span)
  }
  return merged
}

function isMarked(change: Change, spans: readonly Span[]): boolean {
  return spans.some(span =>
    change.start === change.end
      ? // A deletion: only a span that surrounds the gap, with marked text on both sides, covers it.
        span.start < change.gapStart && span.end > change.gapEnd
      : span.start <= change.start && change.end <= span.end,
  )
}

export function checkUnmarkedChanges(input: UnmarkedInput): UnmarkedResult {
  const {baseText, draftText} = input
  if (draftText === baseText) return 'marked'

  const marks = input.marks ?? []
  // With no marks every change is unmarked, so there is nothing to compare and nothing to size.
  if (marks.length === 0) return 'unmarked'

  const problems = problemsOf(baseText, draftText)
  if (problems === 'unavailable') return 'unavailable'

  // One block over the limit is enough, and is the fast path. Blocks that each fit can still add up.
  let totalArea = 0
  for (const problem of problems) {
    const area = problem.base.length * problem.draft.length
    if (area > MAX_DIFF_AREA) return 'unavailable'
    totalArea += area
  }
  if (totalArea > MAX_TOTAL_DIFF_AREA) return 'unavailable'

  const spans = mergedSpans(marks, draftText.length)
  for (const problem of problems) {
    for (const change of blockChanges(problem.base, problem.draft, problem.offset)) {
      if (!isMarked(change, spans)) return 'unmarked'
    }
  }
  return 'marked'
}
