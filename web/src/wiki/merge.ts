/**
 * Three-way merge of a draft with a page that changed under it.
 *
 * The inputs are mine (the draft), base (the page text the draft started from) and theirs (the page
 * text now). They are compared line by line, and a line keeps its terminator, so the lines of a text
 * join back to exactly that text.
 *
 * - A change made by one side only is applied without asking.
 * - A change both sides made identically is applied once.
 * - Where both sides changed the same lines differently, the change is a hunk. It holds the draft's
 *   lines, the base's and the page's, and waits for the operator to take mine or theirs.
 *
 * The merge is complete when every hunk has a choice. `applyResolutions` then returns the merged text
 * and its stretches: which output ranges came from mine, base or theirs, and where the carried ones
 * stood in the draft. The mark remap uses the stretches to follow each mark through the merge.
 *
 * The line diff is `diff3MergeRegions` from `node-diff3`, with `diffIndices` to place unchanged
 * base lines in the draft.
 *
 * A line diff costs about the number of matching line pairs times the number of lines, and a page
 * with many identical lines, such as blank ones, has pairs that grow with the square of its length.
 * The cost is sized before the diff runs (`mergeWork`). A page over `MAX_MERGE_WORK` is not compared:
 * the whole page is one change, and the operator takes their draft or the current page. At 512 KB
 * only a page whose lines average about 23 bytes or more stays under the bound, so short-line and
 * blank-line-heavy pages are one change. Paragraph prose with a blank line between paragraphs is
 * one change above about 140 KB.
 */

import {diff3MergeRegions, diffIndices} from 'node-diff3'

export type Resolution = 'mine' | 'theirs'

/** Where a stretch of the merged text came from. `base` is text neither side changed. */
export type MergeSource = 'base' | 'mine' | 'theirs'

/** An overlapping change: what each version holds where the two sides disagree. */
export interface MergeHunk {
  readonly mine: string
  readonly base: string
  readonly theirs: string
}

type Piece =
  | {readonly kind: 'text'; readonly source: MergeSource; readonly text: string; readonly mineStart: number | null}
  | {readonly kind: 'hunk'; readonly index: number; readonly mineStart: number}

export interface ThreeWayMerge {
  /** The overlapping changes, in text order. */
  readonly hunks: readonly MergeHunk[]
  readonly pieces: readonly Piece[]
  /** The page was too costly to compare line by line, so the whole page is one change. */
  readonly coarse: boolean
}

/** A range of the merged text and where it came from. */
export interface MergeStretch {
  readonly source: MergeSource
  readonly outStart: number
  readonly outEnd: number
  /** Where this text stood in the draft. Null for text taken from theirs. */
  readonly mineStart: number | null
}

export interface MergeOutput {
  readonly text: string
  /** End to end over the whole text, in order. */
  readonly stretches: readonly MergeStretch[]
}

/** The lines of a text, each with its terminator. The last line has none when the text does not end in one. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? []
}

/** Start offset of each line of `lines`, plus the end of the text. */
function offsetsOf(lines: readonly string[]): number[] {
  const offsets = [0]
  for (const line of lines) offsets.push((offsets.at(-1) as number) + line.length)
  return offsets
}

interface IndexChunk {
  readonly buffer1: readonly [number, number]
  readonly buffer2: readonly [number, number]
}

/** For each base line the draft left alone, the index of the same line in the draft. Otherwise -1. */
function baseToMine(baseLength: number, baseVersusMine: readonly IndexChunk[]): Int32Array {
  const map = new Int32Array(baseLength).fill(-1)
  let baseAt = 0
  let mineAt = 0
  for (const chunk of baseVersusMine) {
    while (baseAt < chunk.buffer1[0]) map[baseAt++] = mineAt++
    baseAt += chunk.buffer1[1]
    mineAt += chunk.buffer2[1]
  }
  while (baseAt < baseLength) map[baseAt++] = mineAt++
  return map
}

/** A run of lines neither side changed (`o`), or only the draft changed (`a`), or only the page (`b`). */
interface StableRegion {
  readonly stable: true
  readonly buffer: 'o' | 'a' | 'b'
  readonly bufferStart: number
  readonly bufferContent: string[]
}

/** Lines both sides changed. `aStart` is where the draft's lines start in the draft. */
interface ChangeRegion {
  readonly stable: false
  readonly aStart: number
  readonly aContent: string[]
  readonly oContent: string[]
  readonly bContent: string[]
}

type Region = StableRegion | ChangeRegion

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index])
}

/**
 * The most work the line diffs of one merge may do, in matching line pairs times lines, summed over
 * the three diffs a merge runs. A merge costs roughly 0.4 to 1 ns per unit across shapes, so the
 * bound is about 0.6 to 1.5 s on the measuring machine. A page of distinct lines has about as many
 * pairs as lines, so its work is the square of its line count: 512 KB of lines averaging about 23
 * bytes or more stays under the bound, and shorter lines do not.
 */
export const MAX_MERGE_WORK = 1_500_000_000

/** Matching line pairs: for each distinct line, its count in `a` times its count in `b`. */
function matchingLinePairs(a: readonly string[], b: readonly string[]): number {
  const countsInB = new Map<string, number>()
  for (const line of b) countsInB.set(line, (countsInB.get(line) ?? 0) + 1)
  const countsInA = new Map<string, number>()
  for (const line of a) countsInA.set(line, (countsInA.get(line) ?? 0) + 1)
  let pairs = 0
  for (const [line, count] of countsInA) pairs += count * (countsInB.get(line) ?? 0)
  return pairs
}

/** What the merge of these versions would cost, in the unit of `MAX_MERGE_WORK`. */
export function mergeWork(mine: string, base: string, theirs: string): number {
  const mineLines = splitLines(mine)
  const baseLines = splitLines(base)
  const theirsLines = splitLines(theirs)
  // The draft is compared with the base twice, and the page once.
  return (
    2 * matchingLinePairs(baseLines, mineLines) * Math.max(baseLines.length, mineLines.length) +
    matchingLinePairs(baseLines, theirsLines) * Math.max(baseLines.length, theirsLines.length)
  )
}

/** The merge of versions that need no line comparison: the draft or the page stands whole. */
function settledMerge(mine: string, theirs: string, source: 'mine' | 'theirs'): ThreeWayMerge {
  return {
    hunks: [],
    pieces: [
      source === 'mine'
        ? {kind: 'text', source: 'mine', text: mine, mineStart: 0}
        : {kind: 'text', source: 'theirs', text: theirs, mineStart: null},
    ],
    coarse: false,
  }
}

/** The whole page as one change, for a page too costly to compare line by line. */
function wholePageMerge(mine: string, base: string, theirs: string): ThreeWayMerge {
  // A draft that is its base changed nothing, so the current page stands without asking.
  if (mine === base) return {...settledMerge(mine, theirs, 'theirs'), coarse: true}
  return {hunks: [{mine, base, theirs}], pieces: [{kind: 'hunk', index: 0, mineStart: 0}], coarse: true}
}

export function mergeTexts(mine: string, base: string, theirs: string): ThreeWayMerge {
  // The page did not change, or both sides made the same change: the draft stands.
  if (mine === theirs || theirs === base) return settledMerge(mine, theirs, 'mine')
  if (mergeWork(mine, base, theirs) > MAX_MERGE_WORK) return wholePageMerge(mine, base, theirs)

  const mineLines = splitLines(mine)
  const baseLines = splitLines(base)
  const theirsLines = splitLines(theirs)
  const mineOffsets = offsetsOf(mineLines)
  const mineOfBase = baseToMine(baseLines.length, diffIndices(baseLines, mineLines) as IndexChunk[])
  const mineOffsetAt = (line: number | undefined): number => {
    const offset = line === undefined ? undefined : mineOffsets[line]
    if (offset === undefined) throw new Error(`the diff placed a line outside the draft: ${String(line)}`)
    return offset
  }

  const hunks: MergeHunk[] = []
  const pieces: Piece[] = []
  for (const region of diff3MergeRegions(mineLines, baseLines, theirsLines) as Region[]) {
    if (region.stable) {
      const text = region.bufferContent.join('')
      if (region.buffer === 'o') {
        // Lines neither side changed stand in the draft where the draft's diff against the base puts them.
        const mineLine = mineOfBase[region.bufferStart]
        if (mineLine === undefined || mineLine < 0) {
          throw new Error(`the base line ${String(region.bufferStart)} has no place in the draft`)
        }
        pieces.push({kind: 'text', source: 'base', text, mineStart: mineOffsetAt(mineLine)})
      } else if (region.buffer === 'a') {
        pieces.push({kind: 'text', source: 'mine', text, mineStart: mineOffsetAt(region.bufferStart)})
      } else {
        pieces.push({kind: 'text', source: 'theirs', text, mineStart: null})
      }
      continue
    }

    const mineStart = mineOffsetAt(region.aStart)
    if (sameLines(region.aContent, region.bContent)) {
      // Both sides made this change.
      pieces.push({kind: 'text', source: 'mine', text: region.aContent.join(''), mineStart})
      continue
    }
    pieces.push({kind: 'hunk', index: hunks.length, mineStart})
    hunks.push({mine: region.aContent.join(''), base: region.oContent.join(''), theirs: region.bContent.join('')})
  }
  return {hunks, pieces, coarse: false}
}

/**
 * The merged text and its stretches, or null while a hunk has no choice. `resolutions[i]` is the choice
 * for `hunks[i]`.
 */
export function applyResolutions(
  merge: ThreeWayMerge,
  resolutions: readonly (Resolution | undefined)[],
): MergeOutput | null {
  let text = ''
  const stretches: MergeStretch[] = []
  const add = (source: MergeSource, piece: string, mineStart: number | null) => {
    if (piece === '') return
    stretches.push({source, outStart: text.length, outEnd: text.length + piece.length, mineStart})
    text += piece
  }

  for (const piece of merge.pieces) {
    if (piece.kind === 'text') {
      add(piece.source, piece.text, piece.mineStart)
      continue
    }
    const choice = resolutions[piece.index]
    const hunk = merge.hunks[piece.index] as MergeHunk
    if (choice === 'mine') add('mine', hunk.mine, piece.mineStart)
    else if (choice === 'theirs') add('theirs', hunk.theirs, null)
    else return null
  }
  return {text, stretches}
}
