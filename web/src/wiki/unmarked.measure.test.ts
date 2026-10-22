/**
 * Detection of marked spans on a 512 KB document (U12).
 *
 * The check runs once, when the operator presses Save, and has to finish quickly enough not to read
 * as a hang: under about a second. Scattered edits on a page this size are well inside that. A diff's
 * cost grows much faster than its input, so some shapes are not: a whole-page rewrite that also adds
 * or removes a line, a single 512 KB line, a page dense with blank lines (the line diff scans every
 * matching line pair for every line), a page of tens of thousands of short lines, and many changed
 * blocks that each fit but add up. The guards in `unmarked.ts` size each stage before it runs and
 * answer `unavailable`, and the editor then asks for the confirmation as if the changes were unmarked.
 *
 * This file does not assert elapsed time, which is not stable on a loaded machine. It asserts the
 * outcome of the guards: the shapes above are answered `unavailable`, and no scattered-edit case is.
 * The budgets are documented beside each constant in `unmarked.ts`.
 */

import {describe, expect, it} from 'vitest'
import type {SaveMark} from '../api/wiki.ts'
import {checkUnmarkedChanges} from './unmarked.ts'

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

describe('marked-span detection on a 512 KB document', () => {
  const base = documentLines()
  const baseText = `${base.join('\n')}\n`
  const whole = (text: string): SaveMark[] => [{text, start: 0, end: text.length}]
  const joined = (lines: readonly string[]): string => `${lines.join('\n')}\n`

  it('is a 512 KB document', () => {
    expect(baseText.length).toBeGreaterThanOrEqual(DOCUMENT_BYTES)
  })

  describe('scattered edits are compared', () => {
    it.each([10, 200, 1000])('finds %i scattered edits, all marked', edits => {
      const {draftText, marks} = scatteredEdits(base, edits)
      expect(checkUnmarkedChanges({baseText, draftText, marks})).toBe('marked')
    })

    it('finds a scattered edit that is not marked', () => {
      const {draftText, marks} = scatteredEdits(base, 200)
      expect(checkUnmarkedChanges({baseText, draftText, marks: marks.slice(1)})).toBe('unmarked')
    })

    it('compares 5% inserted lines', () => {
      const inserted: string[] = []
      base.forEach((line, index) => {
        inserted.push(line)
        if (index % 20 === 0) inserted.push(`inserted ${String(index)}`)
      })
      const draftText = joined(inserted)
      expect(checkUnmarkedChanges({baseText, draftText, marks: whole(draftText)})).toBe('marked')
    })

    it('compares a 400-line run of edited lines when the line count is unchanged', () => {
      const draft = [...base]
      for (let index = 1000; index < 1400; index += 1) draft[index] = (draft[index] as string).replace(/\b\w+\b/u, 'EDITED')
      const draftText = joined(draft)
      expect(checkUnmarkedChanges({baseText, draftText, marks: whole(draftText)})).toBe('marked')
    })

    it('compares a page rewritten throughout when the line count is unchanged', () => {
      const draftText = joined(base.map(line => line.replace(/\b\w+\b/u, 'EDITED')))
      expect(checkUnmarkedChanges({baseText, draftText, marks: whole(draftText)})).toBe('marked')
    })
  })

  describe('the guards answer unavailable', () => {
    it('for a whole-page rewrite that also adds a line', () => {
      const draft = base.map(line => line.replace(/\b\w+\b/u, 'EDITED'))
      draft.splice(100, 0, 'an extra line')
      const draftText = joined(draft)
      expect(checkUnmarkedChanges({baseText, draftText, marks: whole(draftText)})).toBe('unavailable')
    })

    it('for a 400-line run of edited lines that also adds a line', () => {
      const draft = [...base]
      for (let index = 1000; index < 1400; index += 1) draft[index] = (draft[index] as string).replace(/\b\w+\b/u, 'EDITED')
      draft.splice(1003, 0, 'an extra line inside the block')
      const draftText = joined(draft)
      expect(checkUnmarkedChanges({baseText, draftText, marks: whole(draftText)})).toBe('unavailable')
    })

    it('for a 512 KB single line with scattered edits', () => {
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

      expect(bigBase.length).toBeGreaterThanOrEqual(DOCUMENT_BYTES)
      expect(checkUnmarkedChanges({baseText: bigBase, draftText, marks})).toBe('unavailable')
    })

    it.each([10, 3])('for a page with one line in %i blank', blankEvery => {
      const dense = base.map((line, index) => (index % blankEvery === 0 ? '' : line))
      const baseDense = joined(dense)
      const draftText = joined(dense.map((line, index) => (index === 500 ? 'EDITED' : line)))
      expect(checkUnmarkedChanges({baseText: baseDense, draftText, marks: whole(draftText)})).toBe('unavailable')
    })

    it('for a page of 35,000 unique short lines, which have few matching pairs but many lines', () => {
      const lines = Array.from({length: 35_000}, (_unused, index) => `row ${String(index)}`)
      const draftText = joined(lines.map((line, index) => (index === 500 ? 'EDITED' : line)))
      expect(checkUnmarkedChanges({baseText: joined(lines), draftText, marks: whole(draftText)})).toBe('unavailable')
    })

    it('for many changed blocks that each fit the per-block limit but add up', () => {
      const lines: string[] = []
      const edited: string[] = []
      for (let block = 0; block < 40; block += 1) {
        const body = Array.from({length: 300}, (_unused, index) => `block ${String(block)} line ${String(index)} with some words in it`)
        lines.push(`separator ${String(block)} a`, `separator ${String(block)} b`, ...body)
        edited.push(`separator ${String(block)} a`, `separator ${String(block)} b`, ...body.map(line => `${line} EDITED`), 'one more line')
      }
      const draftText = joined(edited)
      expect(checkUnmarkedChanges({baseText: joined(lines), draftText, marks: whole(draftText)})).toBe('unavailable')
    })
  })
})
