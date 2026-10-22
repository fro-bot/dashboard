/**
 * The merge and the mark remap on a 512 KB page (U13).
 *
 * The merge runs when the operator opens the merge view, and the remap when they use the merged text.
 * This file measures `mergeTexts`, `applyResolutions` and `remapMarks`, not the render.
 *
 * It does not assert elapsed time, which is not stable on a loaded machine. It asserts the outcome of
 * each shape: scattered, dense and alternating edits merge line by line, and a page whose line diff
 * would cost more than `MAX_MERGE_WORK` is answered as one whole-page change without diffing anything.
 * Set `MEASURE_MERGE=1` and pass `--silent=false` to print the timings behind the bound.
 */

import {describe, expect, it} from 'vitest'
import {createMark, MAX_MARKS, type Mark} from './marks.ts'
import {applyResolutions, MAX_MERGE_WORK, mergeTexts, mergeWork, splitLines, type Resolution} from './merge.ts'
import {remapMarks} from './remap-marks.ts'

const DOCUMENT_BYTES = 512 * 1024

/** A deterministic generator, so a failure reproduces. */
function generator(seed: number) {
  let state = seed
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

const VOCABULARY = 'alpha beta gamma delta widget factory builds ships reads writes cache queue stream parse render token index'.split(' ')

/**
 * Distinct lines of 60 to 120 bytes up to `bytes`. With `paragraph`, a blank line follows every
 * fourth line, as in prose. With `blanks`, one follows every line.
 */
function baseLines(bytes: number, shape: 'plain' | 'paragraph' | 'blanks' = 'plain'): string[] {
  const random = generator(12_345)
  const lines: string[] = []
  let size = 0
  for (let index = 0; size < bytes; index += 1) {
    const count = 8 + Math.floor(random() * 8)
    const words = Array.from({length: count}, () => VOCABULARY[Math.floor(random() * VOCABULARY.length)])
    const line = `${words.join(' ')} ${String(index)}.\n`
    lines.push(line)
    size += line.length
    if (shape === 'blanks' || (shape === 'paragraph' && index % 4 === 3)) {
      lines.push('\n')
      size += 1
    }
  }
  return lines
}

/** Add a tag to every line `select` picks. */
function edited(lines: readonly string[], select: (index: number) => boolean, tag: string): string[] {
  return lines.map((line, index) => (select(index) ? line.replace(/\.\n$/u, ` ${tag}.\n`) : line))
}

/** Mark ten characters at the start of each selected line, up to the most a draft can hold. */
function markLines(text: string, select: (index: number) => boolean): Mark[] {
  const marks: Mark[] = []
  let at = 0
  for (const [index, line] of splitLines(text).entries()) {
    if (select(index) && marks.length < MAX_MARKS) {
      const created = createMark(text, {start: at, end: at + 10}, marks)
      if (created.ok) marks.push(created.mark)
    }
    at += line.length
  }
  return marks
}

function run(
  mine: readonly string[],
  base: readonly string[],
  theirs: readonly string[],
  options: {readonly markSelect: (index: number) => boolean; readonly pick?: (hunk: number) => Resolution},
) {
  const mineText = mine.join('')
  const pick = options.pick ?? ((hunk: number) => (hunk % 2 === 0 ? 'mine' : 'theirs'))

  const started = performance.now()
  const merge = mergeTexts(mineText, base.join(''), theirs.join(''))
  const output = applyResolutions(
    merge,
    merge.hunks.map((_, hunk) => pick(hunk)),
  )
  const merged = performance.now()
  if (output === null) throw new Error('the merge did not complete')

  const marks = markLines(mineText, options.markSelect)
  const remapStarted = performance.now()
  const remapped = remapMarks(marks, mineText, output)
  const remapEnded = performance.now()

  if (process.env.MEASURE_MERGE === '1') {
    console.info(
      `[merge] lines=${String(mine.length)} work=${mergeWork(mineText, base.join(''), theirs.join('')).toExponential(2)} hunks=${String(merge.hunks.length)} coarse=${String(merge.coarse)} merge=${(merged - started).toFixed(0)}ms remap=${(remapEnded - remapStarted).toFixed(0)}ms marks=${String(marks.length)}`,
    )
  }
  return {merge, output, marks: remapped}
}

/** Every mark is accounted for: at its text in the merged text, or flagged. */
function everyMarkIsVerifiedOrFlagged(text: string, marks: readonly Mark[]) {
  for (const mark of marks) {
    expect(text.slice(mark.start, mark.end) === mark.text || mark.needsReview).toBe(true)
  }
}

describe('merge and remap on 512 KB', () => {
  it('scattered edits on both sides, over a thousand hunks: merges line by line and keeps every mark it can verify', () => {
    const base = baseLines(DOCUMENT_BYTES)
    // Period 6: mine alone, theirs alone, both differently, with unchanged lines between.
    const mine = edited(base, index => index % 6 === 0 || index % 6 === 4, 'mine')
    const theirs = edited(base, index => index % 6 === 2 || index % 6 === 4, 'theirs')
    expect(mergeWork(mine.join(''), base.join(''), theirs.join(''))).toBeLessThanOrEqual(MAX_MERGE_WORK)

    // Marks sit on lines the draft alone changed, which the merge carries.
    const result = run(mine, base, theirs, {markSelect: index => index % 36 === 0})

    expect(result.merge.coarse).toBe(false)
    expect(result.merge.hunks).toHaveLength(Math.floor((base.length - 5) / 6) + 1)
    expect(result.marks.length).toBeGreaterThan(50)
    for (const mark of result.marks) {
      expect(mark.needsReview).toBe(false)
      expect(result.output.text.slice(mark.start, mark.end)).toBe(mark.text)
    }
  })

  it('edits on alternating lines on both sides: one large change, resolved as mine', () => {
    const base = baseLines(DOCUMENT_BYTES)
    const mine = edited(base, index => index % 2 === 0, 'mine')
    const theirs = edited(base, index => index % 2 === 1, 'theirs')

    const result = run(mine, base, theirs, {markSelect: index => index % 40 === 0})

    expect(result.merge.coarse).toBe(false)
    expect(result.merge.hunks).toHaveLength(1)
    expect(result.output.text).toBe(mine.join(''))
    expect(result.marks.filter(mark => mark.needsReview)).toHaveLength(0)
    everyMarkIsVerifiedOrFlagged(result.output.text, result.marks)
  })

  it('every line edited differently on both sides: one whole-page change', () => {
    const base = baseLines(DOCUMENT_BYTES)
    const mine = edited(base, () => true, 'mine')
    const theirs = edited(base, () => true, 'theirs')

    const asTheirs = run(mine, base, theirs, {markSelect: index => index % 40 === 0, pick: () => 'theirs'})

    expect(asTheirs.merge.hunks).toHaveLength(1)
    expect(asTheirs.output.text).toBe(theirs.join(''))
    // The page's lines replaced the draft's, so none of the marks is carried.
    expect(asTheirs.marks.length).toBeGreaterThan(50)
    expect(asTheirs.marks.every(mark => mark.needsReview)).toBe(true)
  })

  it('one 512 KB line edited on both sides: one change', () => {
    const line = `${'abcdefghij'.repeat(Math.ceil(DOCUMENT_BYTES / 10))}\n`
    const result = run([line.replace('a', 'M')], [line], [line.replace('j\n', 'T\n')], {markSelect: () => true})
    expect(result.merge.hunks).toHaveLength(1)
    everyMarkIsVerifiedOrFlagged(result.output.text, result.marks)
  })

  it('prose of about 128 KB, with a blank line after every fourth line, still merges line by line', () => {
    const base = baseLines(128 * 1024, 'paragraph')
    const mine = edited(base, index => index % 12 === 0 || index % 12 === 8, 'mine')
    const theirs = edited(base, index => index % 12 === 4 || index % 12 === 8, 'theirs')
    expect(mergeWork(mine.join(''), base.join(''), theirs.join(''))).toBeLessThanOrEqual(MAX_MERGE_WORK)

    const result = run(mine, base, theirs, {markSelect: index => index % 60 === 0})

    expect(result.merge.coarse).toBe(false)
    expect(result.merge.hunks.length).toBeGreaterThan(100)
    everyMarkIsVerifiedOrFlagged(result.output.text, result.marks)
  })

  it('a 512 KB page of prose with blank lines is over the budget: one whole-page change, marks carried when the draft wins', () => {
    const base = baseLines(DOCUMENT_BYTES, 'paragraph')
    const mine = edited(base, index => index % 12 === 0 || index % 12 === 8, 'mine')
    const theirs = edited(base, index => index % 12 === 4 || index % 12 === 8, 'theirs')
    expect(mergeWork(mine.join(''), base.join(''), theirs.join(''))).toBeGreaterThan(MAX_MERGE_WORK)

    const keptDraft = run(mine, base, theirs, {markSelect: index => index % 60 === 0, pick: () => 'mine'})
    expect(keptDraft.merge.coarse).toBe(true)
    expect(keptDraft.merge.hunks).toHaveLength(1)
    expect(keptDraft.output.text).toBe(mine.join(''))
    expect(keptDraft.marks.length).toBeGreaterThan(50)
    expect(keptDraft.marks.filter(mark => mark.needsReview)).toHaveLength(0)
    everyMarkIsVerifiedOrFlagged(keptDraft.output.text, keptDraft.marks)

    const tookPage = run(mine, base, theirs, {markSelect: index => index % 60 === 0, pick: () => 'theirs'})
    expect(tookPage.output.text).toBe(theirs.join(''))
    expect(tookPage.marks.every(mark => mark.needsReview)).toBe(true)
  })

  it('a 512 KB page of lines with a blank after each is over the budget too, however few lines changed', () => {
    const base = baseLines(DOCUMENT_BYTES, 'blanks')
    const mine = edited(base, index => index === 10, 'mine')
    const theirs = edited(base, index => index === 4000, 'theirs')
    const result = run(mine, base, theirs, {markSelect: index => index % 500 === 0})
    expect(result.merge.coarse).toBe(true)
    expect(result.merge.hunks).toHaveLength(1)
  })
})
