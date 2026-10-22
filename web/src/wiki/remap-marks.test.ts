import {describe, expect, it} from 'vitest'
import {createMark, locateMark, markState, type Mark} from './marks.ts'
import {applyResolutions, mergeTexts, type MergeOutput, type Resolution} from './merge.ts'
import {remapMarks} from './remap-marks.ts'

const BASE = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'

/** Mark the first occurrence of `quoted` in `text`. */
function markOf(text: string, quoted: string, existing: readonly Mark[] = []): Mark {
  const start = text.indexOf(quoted)
  if (start < 0) throw new Error(`"${quoted}" is not in the text`)
  const created = createMark(text, {start, end: start + quoted.length}, existing)
  if (!created.ok) throw new Error(`cannot mark: ${created.reason}`)
  return created.mark
}

function merged(mine: string, base: string, theirs: string, choices: readonly Resolution[] = []) {
  const output = applyResolutions(mergeTexts(mine, base, theirs), choices)
  if (output === null) throw new Error('the merge is not complete')
  return output
}

describe('remapMarks — text the draft keeps', () => {
  it('moves a mark with its text when upstream inserts lines above it', () => {
    const mine = BASE
    const theirs = `new top\nanother\n${BASE}`
    const mark = markOf(mine, 'three')
    const output = merged(mine, BASE, theirs)

    const [remapped] = remapMarks([mark], mine, output)

    expect(remapped).toMatchObject({id: mark.id, text: 'three', needsReview: false})
    expect(remapped?.start).toBe(output.text.indexOf('three'))
    expect(remapped?.end).toBe((remapped?.start ?? 0) + 'three'.length)
    expect(output.text.slice(remapped?.start, remapped?.end)).toBe('three')
    expect(markState(output.text, remapped as Mark)).toBe('ok')
  })

  it('moves a mark inside text the draft added', () => {
    const mine = 'one\ntwo\nmy NEW words\nthree\nfour\nfive\nsix\nseven\n'
    const theirs = `top\n${BASE}`
    const mark = markOf(mine, 'NEW words')
    const output = merged(mine, BASE, theirs)

    const [remapped] = remapMarks([mark], mine, output)

    expect(remapped?.needsReview).toBe(false)
    expect(remapped?.start).toBe(output.text.indexOf('NEW words'))
  })

  it('refreshes the context around the mark from the merged text', () => {
    const mine = BASE
    const theirs = `top\n${BASE}`
    const mark = markOf(mine, 'three')
    const output = merged(mine, BASE, theirs)
    const [remapped] = remapMarks([mark], mine, output)
    expect(remapped?.prefix).toBe('top\none\ntwo\n')
    expect(remapped?.suffix).toBe('\nfour\nfive\nsix\nseven\n')
  })

  it('keeps a mark on a line after an upstream deletion above it', () => {
    const mine = BASE
    const theirs = 'one\nthree\nfour\nfive\nsix\nseven\n'
    const mark = markOf(mine, 'five')
    const output = merged(mine, BASE, theirs)
    const [remapped] = remapMarks([mark], mine, output)
    expect(remapped?.start).toBe(output.text.indexOf('five'))
    expect(remapped?.needsReview).toBe(false)
  })

  it('keeps a mark that spans several lines the draft kept', () => {
    const mine = BASE
    const theirs = `top\n${BASE}bottom\n`
    const mark = markOf(mine, 'two\nthree\nfour')
    const output = merged(mine, BASE, theirs)
    const [remapped] = remapMarks([mark], mine, output)
    expect(remapped?.needsReview).toBe(false)
    expect(remapped?.start).toBe(output.text.indexOf('two\nthree'))
  })

  it('keeps a mark in a hunk resolved as mine', () => {
    const mine = 'one\ntwo\nMY three here\nfour\nfive\nsix\nseven\n'
    const theirs = 'one\ntwo\nTHEIR three\nfour\nfive\nsix\nseven\n'
    const mark = markOf(mine, 'three here')
    const output = merged(mine, BASE, theirs, ['mine'])
    const [remapped] = remapMarks([mark], mine, output)
    expect(remapped?.needsReview).toBe(false)
    expect(remapped?.start).toBe(output.text.indexOf('three here'))
  })

  it('keeps a mark where both sides made the same change', () => {
    const mine = 'one\ntwo\nthree\nfour\nfive\nsame six\nseven\n'
    const mark = markOf(mine, 'same six')
    const output = merged(mine, BASE, mine)
    const [remapped] = remapMarks([mark], mine, output)
    expect(remapped?.needsReview).toBe(false)
    expect(remapped?.start).toBe(output.text.indexOf('same six'))
  })

  it('leaves the marks alone when the merge changed nothing around them', () => {
    const mine = 'one\ntwo\nmine three\nfour\nfive\nsix\nseven\n'
    const mark = markOf(mine, 'mine three')
    const output = merged(mine, BASE, BASE)
    expect(remapMarks([mark], mine, output)).toEqual([mark])
  })
})

describe('remapMarks — text from theirs', () => {
  it('flags a mark when upstream changes text inside it, and does not move it', () => {
    const mine = BASE
    const theirs = 'one\ntwo\nTHREE changed\nfour\nfive\nsix\nseven\n'
    const mark = markOf(mine, 'three')
    const output = merged(mine, BASE, theirs)

    const [remapped] = remapMarks([mark], mine, output)

    expect(remapped?.needsReview).toBe(true)
    expect(remapped?.text).toBe('three')
    expect(remapped?.start).toBe(mark.start)
    // Its text is gone, so it waits to be removed.
    expect(markState(output.text, remapped as Mark)).toBe('detached')
  })

  it('flags a mark whose span a hunk resolved as theirs removes', () => {
    const mine = 'one\ntwo\nMY three\nfour\nfive\nsix\nseven\n'
    const theirs = 'one\ntwo\nfour\nfive\nsix\nseven\n'
    const mark = markOf(mine, 'MY three')
    const output = merged(mine, BASE, theirs, ['theirs'])

    const [remapped] = remapMarks([mark], mine, output)

    expect(remapped?.needsReview).toBe(true)
    expect(remapped?.text).toBe('MY three')
    expect(markState(output.text, remapped as Mark)).toBe('detached')
  })

  it('flags a mark when upstream deletes lines inside its span', () => {
    const mine = BASE
    const theirs = 'one\ntwo\nfour\nfive\nsix\nseven\n'
    const mark = markOf(mine, 'two\nthree\nfour')
    const output = merged(mine, BASE, theirs)
    const [remapped] = remapMarks([mark], mine, output)
    expect(remapped?.needsReview).toBe(true)
  })

  it('flags a mark when upstream deletes the whole line it is on', () => {
    const mine = BASE
    const theirs = 'one\ntwo\nfour\nfive\nsix\nseven\n'
    const mark = markOf(mine, 'three')
    const output = merged(mine, BASE, theirs)
    const [remapped] = remapMarks([mark], mine, output)
    expect(remapped?.needsReview).toBe(true)
    expect(markState(output.text, remapped as Mark)).toBe('detached')
  })

  it('never moves a flagged mark to another occurrence of its text', () => {
    const mine = 'target here\nfiller\ntarget there\nmore\n'
    const theirs = 'target ELSEWHERE\nfiller\ntarget there\nmore\ntarget here\n'
    const mark = markOf(mine, 'target here')
    const output = merged(mine, mine, theirs)
    const elsewhere = output.text.lastIndexOf('target here')
    expect(elsewhere).toBeGreaterThan(0)

    const [remapped] = remapMarks([mark], mine, output)

    expect(remapped?.needsReview).toBe(true)
    expect(remapped?.start).toBe(mark.start)
    expect(remapped?.start).not.toBe(elsewhere)
  })

  it('flags a mark inside a hunk resolved as theirs, even where the same word stands in the page text', () => {
    const mine = 'one\ntwo\nMINE three\nfour\nfive\nsix\nseven\n'
    const theirs = 'one\ntwo\nTHEIRS three\nfour\nfive\nsix\nseven\n'
    const mark = markOf(mine, 'three')
    const output = merged(mine, BASE, theirs, ['theirs'])
    const [remapped] = remapMarks([mark], mine, output)
    // The same word stands in the page's version, but it is theirs, not the marked text.
    expect(remapped?.needsReview).toBe(true)
    expect(remapped?.start).toBe(mark.start)
  })

  it('keeps a flag that was already set', () => {
    const mine = BASE
    const theirs = `top\n${BASE}`
    const flagged = {...markOf(mine, 'three'), needsReview: true}
    const output = merged(mine, BASE, theirs)
    const [remapped] = remapMarks([flagged], mine, output)
    expect(remapped?.needsReview).toBe(true)
    expect(remapped?.start).toBe(output.text.indexOf('three'))
  })

  it('flags a mark whose text was not in the draft to begin with', () => {
    const mine = BASE
    const detached: Mark = {...markOf(mine, 'three'), text: 'not in the draft', end: 3 + 'not in the draft'.length}
    const output = merged(mine, BASE, `top\n${BASE}`)
    const [remapped] = remapMarks([detached], mine, output)
    expect(remapped?.needsReview).toBe(true)
    expect(remapped?.text).toBe('not in the draft')
  })

  it('flags a mark when the quote does not verify at the new position', () => {
    const mine = BASE
    const mark = markOf(mine, 'three')
    // Stretches that claim the draft's text moved to a place that holds other text.
    const output: MergeOutput = {
      text: 'X'.repeat(mine.length),
      stretches: [{source: 'mine', outStart: 0, outEnd: mine.length, mineStart: 0}],
    }
    const [remapped] = remapMarks([mark], mine, output)
    expect(remapped?.needsReview).toBe(true)
    expect(remapped?.text).toBe('three')
  })
})

describe('remapMarks — several marks', () => {
  it('remaps each mark on its own', () => {
    const mine = BASE
    const theirs = 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\nnew tail\n'
    const first = markOf(mine, 'one')
    const second = markOf(mine, 'three', [first])
    const third = markOf(mine, 'six', [first, second])
    const output = merged(mine, BASE, theirs)

    const remapped = remapMarks([first, second, third], mine, output)

    expect(remapped.map(mark => [mark.id, mark.needsReview])).toEqual([
      [first.id, false],
      [second.id, true],
      [third.id, false],
    ])
    expect(remapped[2]?.start).toBe(output.text.indexOf('six'))
  })

  it('returns no marks for no marks', () => {
    expect(remapMarks([], BASE, merged(BASE, BASE, BASE))).toEqual([])
  })
})

describe('remapMarks — UTF-16 offsets', () => {
  const EMOJI = '👩‍👩‍👧' // woman, ZWJ, woman, ZWJ, girl: several surrogate pairs

  it('counts a mark after emoji in UTF-16 code units', () => {
    const base = `${EMOJI} first\nsecond\n${EMOJI}${EMOJI} third\n`
    const mine = base
    const theirs = `${EMOJI}${EMOJI}${EMOJI} inserted above\n${base}`
    const mark = markOf(mine, `${EMOJI} third`)
    const output = merged(mine, base, theirs)

    const [remapped] = remapMarks([mark], mine, output)

    expect(remapped?.needsReview).toBe(false)
    expect(remapped?.start).toBe(output.text.indexOf(`${EMOJI} third`))
    expect(output.text.slice(remapped?.start, remapped?.end)).toBe(`${EMOJI} third`)
    expect(remapped?.end).toBe((remapped?.start ?? 0) + mark.text.length)
  })

  it('moves a mark that is a single astral character', () => {
    const base = 'before\n😀\nafter\n'
    const theirs = '🎉 party\nbefore\n😀\nafter\n'
    const mark = markOf(base, '😀')
    expect(mark.end - mark.start).toBe(2)
    const output = merged(base, base, theirs)
    const [remapped] = remapMarks([mark], base, output)
    expect(remapped?.needsReview).toBe(false)
    expect(remapped?.start).toBe(output.text.indexOf('😀'))
    expect(remapped?.end).toBe((remapped?.start ?? 0) + 2)
  })

  it('moves a mark on text with combining characters, whole or cut after the base letter', () => {
    const word = 'cafe\u0301 re\u0301sume\u0301'
    const base = `intro\n${word}\noutro\n`
    const theirs = `x\u0301 top\n${base}`
    const whole = markOf(base, 'cafe\u0301')
    const cut = markOf(base, 'cafe', [whole])
    const output = merged(base, base, theirs)

    const [remappedWhole, remappedCut] = remapMarks([whole, cut], base, output)

    expect(remappedWhole?.needsReview).toBe(false)
    expect(remappedWhole?.start).toBe(output.text.indexOf('cafe\u0301'))
    expect(remappedWhole?.text).toBe('cafe\u0301')
    expect(remappedCut?.needsReview).toBe(false)
    expect(remappedCut?.start).toBe(output.text.indexOf('cafe'))
    expect(remappedCut?.text).toBe('cafe')
  })

  it('flags a mark on emoji text that upstream rewrote', () => {
    const base = `a\n${EMOJI} family\nz\n`
    const theirs = `a\n${EMOJI} FAMILY\nz\n`
    const mark = markOf(base, `${EMOJI} family`)
    const output = merged(base, base, theirs)
    const [remapped] = remapMarks([mark], base, output)
    expect(remapped?.needsReview).toBe(true)
    expect(locateMark(output.text, remapped as Mark)).toBeNull()
  })

  it('keeps a mark after a CRLF edit above it', () => {
    const base = 'one\r\ntwo\r\nthree\r\n'
    const theirs = 'zero\r\none\r\ntwo\r\nthree\r\n'
    const mark = markOf(base, 'two')
    const output = merged(base, base, theirs)
    const [remapped] = remapMarks([mark], base, output)
    expect(remapped?.needsReview).toBe(false)
    expect(remapped?.start).toBe(output.text.indexOf('two'))
  })
})
