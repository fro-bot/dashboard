/**
 * Carry the marks of a draft through a three-way merge.
 *
 * A mark is placed by its text, so the remap moves it only when it can show that the text came
 * through. A mark that lies inside one run of text the merge carried from the draft, whether the draft
 * changed it or left it as the base had it, moves with that run. The text is then read back at the new
 * position, and a mark whose text is not there is flagged.
 *
 * Every other mark is left unplaced: flagged, with the text it was made on and no position. That
 * covers a mark that touches text taken from the page, one whose lines the merge dropped, one whose
 * text does not verify at the new position, and one that was already off the draft. An unplaced mark
 * is never moved to another place where its text happens to stand, and it cannot be kept. The operator
 * removes it and marks the text again, and Save waits until then. A mark that was already unplaced
 * stays so.
 */

import {anchorMark, isPlaced, locateMark, markState, unplaceMark, type Mark} from './marks.ts'
import type {MergeOutput} from './merge.ts'

/** A stretch of the draft carried into the merged text unbroken, in both texts. */
interface Run {
  readonly mineStart: number
  readonly mineEnd: number
  readonly outStart: number
}

/** The stretches the merge took from the draft or left as the base had them, joined where they touch. */
function carriedRuns(output: MergeOutput): Run[] {
  const runs: Run[] = []
  for (const stretch of output.stretches) {
    if (typeof stretch.mineStart !== 'number') continue
    const length = stretch.outEnd - stretch.outStart
    const last = runs.at(-1)
    if (last !== undefined && last.mineEnd === stretch.mineStart && last.outStart + (last.mineEnd - last.mineStart) === stretch.outStart) {
      runs[runs.length - 1] = {...last, mineEnd: stretch.mineStart + length}
    } else {
      runs.push({mineStart: stretch.mineStart, mineEnd: stretch.mineStart + length, outStart: stretch.outStart})
    }
  }
  return runs
}

/** The run holding `offset`, if any. The runs are in draft order. */
function runAt(runs: readonly Run[], offset: number): Run | undefined {
  let low = 0
  let high = runs.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const run = runs[middle] as Run
    if (offset < run.mineStart) high = middle - 1
    else if (offset >= run.mineEnd) low = middle + 1
    else return run
  }
  return undefined
}

/**
 * Remap `marks`, which are placed on `mineText`, onto `output.text`. The result has one mark for each
 * mark given, in the same order.
 */
export function remapMarks(marks: readonly Mark[], mineText: string, output: MergeOutput): Mark[] {
  const runs = carriedRuns(output)

  return marks.map(mark => {
    // A mark with no place, one whose text is not in the draft, and a flagged one that is not at its
    // own offsets have nothing to carry. The last must not be taken to wherever its text is found.
    if (!isPlaced(mark) || markState(mineText, mark) === 'detached') return unplaceMark(mark)
    const found = locateMark(mineText, mark)
    if (found === null) return unplaceMark(mark)

    const run = runAt(runs, found.start)
    if (run !== undefined && found.end <= run.mineEnd) {
      const offset = run.outStart + (found.start - run.mineStart)
      const range = {start: offset, end: offset + (found.end - found.start)}
      if (output.text.slice(range.start, range.end) === mark.text) {
        return {...anchorMark(output.text, mark, range), needsReview: mark.needsReview}
      }
    }
    return unplaceMark(mark)
  })
}
