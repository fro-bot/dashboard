/**
 * Measurement of marked-span detection on a 512 KB document with scattered edits (U12).
 *
 * The plan builds the simple path first and adds a "marked-span detection unavailable" state only
 * if this measurement fails a bound. The bound is one second: detection runs once, when the operator
 * presses Save, and a press that takes longer than that reads as a hang. Measured on the
 * development machine (Node 24), the scattered cases below take 40 to 100 ms warm and up to
 * about 200 ms on a cold run, so the bound has headroom for a slow CI machine.
 *
 * Two other shapes never finish without a guard: a whole-page rewrite that also adds or removes a
 * line, and a single 512 KB line (neither completed in 100 s). The block-size guard in `unmarked.ts`
 * answers `unavailable` for them before any word-level diff runs, and the editor then says detection
 * is unavailable and still asks for the confirmation. This file checks that those shapes are caught
 * quickly and that no scattered-edit case is.
 *
 * It is a guard as well as a measurement: it fails if the algorithm slows by an order of magnitude.
 */

import {describe, expect, it} from 'vitest'
import type {SaveMark} from '../api/wiki.ts'
import {checkUnmarkedChanges} from './unmarked.ts'

/** The most a detection may take on these documents, in milliseconds. */
const BOUND_MS = 1000

/** What a caught case may take: the line-level diff and the sizing, with no word-level diff. */
const CAUGHT_MS = 500

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

function documentLines(): string[] {
  const random = generator(12_345)
  const lines: string[] = []
  let size = 0
  for (let index = 0; size < DOCUMENT_BYTES; index += 1) {
    const count = 8 + Math.floor(random() * 8)
    const words = Array.from({length: count}, () => VOCABULARY[Math.floor(random() * VOCABULARY.length)])
    const line = `${index % 50 === 0 ? '## ' : ''}${words.join(' ')} ${String(index)}.`
    lines.push(line)
    size += line.length + 1
  }
  return lines
}

/** Edit one word on each of `edits` lines spread through the document, and mark each edited line. */
function scatteredEdits(base: readonly string[], edits: number): {draftText: string; marks: SaveMark[]} {
  const random = generator(edits)
  const draft = [...base]
  const edited = new Set<number>()
  const step = Math.floor(draft.length / edits)
  for (let k = 0; k < edits; k += 1) {
    const index = k * step + Math.floor(random() * step)
    draft[index] = (draft[index] as string).replace(/\b\w+\b/u, 'EDITED')
    edited.add(index)
  }

  const draftText = `${draft.join('\n')}\n`
  const marks: SaveMark[] = []
  let offset = 0
  draft.forEach((line, index) => {
    if (edited.has(index)) marks.push({text: line, start: offset, end: offset + line.length})
    offset += line.length + 1
  })
  return {draftText, marks}
}

function timed<T>(run: () => T): {result: T; ms: number} {
  const started = performance.now()
  const result = run()
  return {result, ms: performance.now() - started}
}

describe('marked-span detection on a 512 KB document', () => {
  const base = documentLines()
  const baseText = `${base.join('\n')}\n`

  it('is a 512 KB document', () => {
    expect(baseText.length).toBeGreaterThanOrEqual(DOCUMENT_BYTES)
  })

  it.each([10, 200, 1000])('finds %i scattered edits, all marked, within the bound', edits => {
    const {draftText, marks} = scatteredEdits(base, edits)
    const {result, ms} = timed(() => checkUnmarkedChanges({baseText, draftText, marks}))

    expect(result).toBe('marked')
    expect(ms).toBeLessThan(BOUND_MS)
  })

  it('finds a scattered edit that is not marked, within the bound', () => {
    const {draftText, marks} = scatteredEdits(base, 200)
    const {result, ms} = timed(() => checkUnmarkedChanges({baseText, draftText, marks: marks.slice(1)}))

    expect(result).toBe('unmarked')
    expect(ms).toBeLessThan(BOUND_MS)
  })

  it('handles a run of consecutive edited lines within the bound', () => {
    const draft = [...base]
    for (let index = 1000; index < 1400; index += 1) {
      draft[index] = (draft[index] as string).replace(/\b\w+\b/u, 'EDITED')
    }
    const draftText = `${draft.join('\n')}\n`
    const {result, ms} = timed(() =>
      checkUnmarkedChanges({baseText, draftText, marks: [{text: draftText, start: 0, end: draftText.length}]}),
    )

    expect(result).toBe('marked')
    expect(ms).toBeLessThan(BOUND_MS)
  })

  it('handles a page with the same line count rewritten throughout, within the bound', () => {
    const draft = base.map(line => line.replace(/\b\w+\b/u, 'EDITED'))
    const draftText = `${draft.join('\n')}\n`
    const {result, ms} = timed(() =>
      checkUnmarkedChanges({baseText, draftText, marks: [{text: draftText, start: 0, end: draftText.length}]}),
    )

    expect(result).toBe('marked')
    expect(ms).toBeLessThan(BOUND_MS)
  })

  // The cases that hang without the guard.
  describe('the block-size guard', () => {
    const whole = (text: string): SaveMark[] => [{text, start: 0, end: text.length}]

    it('catches a whole-page rewrite that also adds a line, well under the bound', () => {
      const draft = base.map(line => line.replace(/\b\w+\b/u, 'EDITED'))
      draft.splice(100, 0, 'an extra line')
      const draftText = `${draft.join('\n')}\n`
      const {result, ms} = timed(() => checkUnmarkedChanges({baseText, draftText, marks: whole(draftText)}))

      expect(result).toBe('unavailable')
      expect(ms).toBeLessThan(CAUGHT_MS)
    })

    it('catches a 400-line run of edited lines that also adds a line (about 3 s unguarded)', () => {
      const draft = [...base]
      for (let index = 1000; index < 1400; index += 1) draft[index] = (draft[index] as string).replace(/\b\w+\b/u, 'EDITED')
      draft.splice(1003, 0, 'an extra line inside the block')
      const draftText = `${draft.join('\n')}\n`
      const {result, ms} = timed(() => checkUnmarkedChanges({baseText, draftText, marks: whole(draftText)}))

      expect(result).toBe('unavailable')
      expect(ms).toBeLessThan(CAUGHT_MS)
    })

    it('catches a 512 KB single line with scattered edits, well under the bound', () => {
      const words = base.join(' ').split(' ')
      const bigBase = words.join(' ')
      const edited = [...words]
      for (let k = 0; k < edited.length; k += 400) edited[k] = 'EDITED'
      const draftText = edited.join(' ')
      const marks: SaveMark[] = []
      let offset = 0
      edited.forEach((word, index) => {
        if (index % 400 === 0) marks.push({text: word, start: offset, end: offset + word.length})
        offset += word.length + 1
      })
      const {result, ms} = timed(() => checkUnmarkedChanges({baseText: bigBase, draftText, marks}))

      expect(bigBase.length).toBeGreaterThanOrEqual(DOCUMENT_BYTES)
      expect(result).toBe('unavailable')
      expect(ms).toBeLessThan(CAUGHT_MS)
    })

    it.each([10, 200, 1000])('does not trip on %i scattered edits', edits => {
      const {draftText, marks} = scatteredEdits(base, edits)
      expect(checkUnmarkedChanges({baseText, draftText, marks})).not.toBe('unavailable')
    })

    it('does not trip on 5% inserted lines, or on a 400-line run of edited lines with the line count unchanged', () => {
      const inserted: string[] = []
      base.forEach((line, index) => {
        inserted.push(line)
        if (index % 20 === 0) inserted.push(`inserted ${String(index)}`)
      })
      const insertedText = `${inserted.join('\n')}\n`
      expect(checkUnmarkedChanges({baseText, draftText: insertedText, marks: whole(insertedText)})).not.toBe('unavailable')

      const run = [...base]
      for (let index = 1000; index < 1400; index += 1) run[index] = (run[index] as string).replace(/\b\w+\b/u, 'EDITED')
      const runText = `${run.join('\n')}\n`
      expect(checkUnmarkedChanges({baseText, draftText: runText, marks: whole(runText)})).not.toBe('unavailable')
    })
  })
})
