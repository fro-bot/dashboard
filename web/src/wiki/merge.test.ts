import {describe, expect, it} from 'vitest'
import {diff3MergeRegions, diffIndices} from 'node-diff3'
import {
  applyResolutions,
  MAX_MERGE_WORK,
  mergeTexts,
  mergeWork,
  splitLines,
  type MergeOutput,
  type Resolution,
} from './merge.ts'

const BASE = 'a\nb\nc\nd\ne\n'

function resolved(output: MergeOutput | null): MergeOutput {
  if (output === null) throw new Error('the merge is not complete')
  return output
}

function sourcesOf(output: MergeOutput) {
  return output.stretches.map(stretch => [stretch.source, output.text.slice(stretch.outStart, stretch.outEnd)])
}

describe('splitLines', () => {
  it('keeps each line terminator, so the lines join back to the text', () => {
    for (const text of ['', 'a', 'a\n', 'a\nb', 'a\n\nb\n', 'a\r\nb\r\n', '\n']) {
      expect(splitLines(text).join('')).toBe(text)
    }
    expect(splitLines('a\nb')).toEqual(['a\n', 'b'])
    expect(splitLines('')).toEqual([])
  })
})

describe('mergeTexts — a page too costly to compare line by line', () => {
  // A run of identical lines makes the line diff cost grow with the cube of the run.
  const BLANKS = '\n'.repeat(2000)

  it('sizes the work from the lines the versions share', () => {
    expect(mergeWork('a\nb\n', 'a\nb\n', 'a\nc\n')).toBeLessThan(100)
    expect(mergeWork(`${BLANKS}x\n`, BLANKS, `${BLANKS}y\n`)).toBeGreaterThan(MAX_MERGE_WORK)
    expect(mergeWork('\n'.repeat(500), '\n'.repeat(500), '\n'.repeat(500))).toBeLessThanOrEqual(MAX_MERGE_WORK)
  })

  it('makes the whole page one change, with the three versions as they are', () => {
    const mine = `${BLANKS}mine\n`
    const theirs = `${BLANKS}theirs\n`
    const merge = mergeTexts(mine, BLANKS, theirs)

    expect(merge.coarse).toBe(true)
    expect(merge.hunks).toEqual([{mine, base: BLANKS, theirs}])
    const asMine = resolved(applyResolutions(merge, ['mine']))
    expect(asMine.text).toBe(mine)
    expect(asMine.stretches).toEqual([{source: 'mine', outStart: 0, outEnd: mine.length, mineStart: 0}])
    const asTheirs = resolved(applyResolutions(merge, ['theirs']))
    expect(asTheirs.text).toBe(theirs)
    expect(asTheirs.stretches).toEqual([{source: 'theirs', outStart: 0, outEnd: theirs.length, mineStart: null}])
  })

  it('takes the current page without a change when the draft is its base', () => {
    const theirs = `${BLANKS}theirs\n`
    const merge = mergeTexts(BLANKS, BLANKS, theirs)
    expect(merge.coarse).toBe(true)
    expect(merge.hunks).toEqual([])
    expect(resolved(applyResolutions(merge, [])).text).toBe(theirs)
  })

  it('keeps the draft without a change when the page is its base, or the same as it', () => {
    const mine = `${BLANKS}mine\n`
    expect(resolved(applyResolutions(mergeTexts(mine, BLANKS, BLANKS), [])).text).toBe(mine)
    expect(mergeTexts(mine, BLANKS, mine).hunks).toEqual([])
  })

  it('compares line by line when the cost is within the budget', () => {
    const blanks = '\n'.repeat(500)
    const merge = mergeTexts(`${blanks}mine\n`, blanks, `${blanks}theirs\n`)
    expect(merge.coarse).toBe(false)
    expect(merge.hunks).toEqual([{mine: 'mine\n', base: '', theirs: 'theirs\n'}])
  })
})

describe('mergeTexts', () => {
  it('is not coarse for an ordinary page', () => {
    expect(mergeTexts('A\nb\n', 'a\nb\n', 'a\nB\n').coarse).toBe(false)
  })

  it('merges edits that do not overlap without a hunk', () => {
    const merge = mergeTexts('A\nb\nc\nd\ne\n', BASE, 'a\nb\nc\nd\nE\n')
    expect(merge.hunks).toEqual([])
    const output = resolved(applyResolutions(merge, []))
    expect(output.text).toBe('A\nb\nc\nd\nE\n')
    expect(sourcesOf(output)).toEqual([
      ['mine', 'A\n'],
      ['base', 'b\nc\nd\n'],
      ['theirs', 'E\n'],
    ])
  })

  it('reports each overlapping change as a hunk with all three versions', () => {
    const merge = mergeTexts('a\nMINE\nc\nd\ne\n', BASE, 'a\nTHEIRS\nc\nd\ne\n')
    expect(merge.hunks).toEqual([{mine: 'MINE\n', base: 'b\n', theirs: 'THEIRS\n'}])
  })

  it('is complete only when every hunk is resolved, and builds the text from the choices', () => {
    const base = '1\nx\n2\ny\n3\nz\n4\n'
    const mine = '1\nmx\n2\nmy\n3\nz\n4\n'
    const theirs = '1\ntx\n2\nty\n3\nz\nT4\n'
    const merge = mergeTexts(mine, base, theirs)
    expect(merge.hunks.map(hunk => [hunk.mine, hunk.theirs])).toEqual([
      ['mx\n', 'tx\n'],
      ['my\n', 'ty\n'],
    ])

    expect(applyResolutions(merge, [])).toBeNull()
    expect(applyResolutions(merge, ['mine'])).toBeNull()
    expect(applyResolutions(merge, ['mine', undefined])).toBeNull()

    const choices: readonly Resolution[] = ['mine', 'theirs']
    const output = resolved(applyResolutions(merge, choices))
    expect(output.text).toBe('1\nmx\n2\nty\n3\nz\nT4\n')
    expect(sourcesOf(output).map(([source]) => source)).toEqual(['base', 'mine', 'base', 'theirs', 'base', 'theirs'])
  })

  it('resolves every hunk as mine to the draft where theirs changed nothing else, and as theirs to theirs', () => {
    const merge = mergeTexts('a\nMINE\nc\nd\ne\n', BASE, 'a\nTHEIRS\nc\nd\ne\n')
    expect(resolved(applyResolutions(merge, ['mine'])).text).toBe('a\nMINE\nc\nd\ne\n')
    expect(resolved(applyResolutions(merge, ['theirs'])).text).toBe('a\nTHEIRS\nc\nd\ne\n')
  })

  it('takes theirs wholesale when the draft is unchanged from the base', () => {
    const theirs = 'new first\nb\nc\nchanged\ne\nadded\n'
    const merge = mergeTexts(BASE, BASE, theirs)
    expect(merge.hunks).toEqual([])
    expect(resolved(applyResolutions(merge, [])).text).toBe(theirs)
  })

  it('keeps the draft when the page did not change', () => {
    const mine = 'a\nmine\nc\nd\ne\n'
    const merge = mergeTexts(mine, BASE, BASE)
    expect(merge.hunks).toEqual([])
    expect(resolved(applyResolutions(merge, [])).text).toBe(mine)
  })

  it('does not raise a hunk when both sides made the same change', () => {
    const merge = mergeTexts('a\nsame\nc\nd\ne\n', BASE, 'a\nsame\nc\nd\ne\n')
    expect(merge.hunks).toEqual([])
    expect(resolved(applyResolutions(merge, [])).text).toBe('a\nsame\nc\nd\ne\n')
  })

  it('applies a change both sides made once, next to a hunk', () => {
    const merge = mergeTexts('a\nSAME\nc\nd\nX\n', BASE, 'a\nSAME\nc\nd\nY\n')
    expect(merge.hunks).toEqual([{mine: 'X\n', base: 'e\n', theirs: 'Y\n'}])
    const output = resolved(applyResolutions(merge, ['theirs']))
    expect(output.text).toBe('a\nSAME\nc\nd\nY\n')
    expect(output.text.split('SAME\n')).toHaveLength(2)
  })

  it('handles an empty base, draft and page', () => {
    expect(resolved(applyResolutions(mergeTexts('', '', ''), [])).text).toBe('')
    expect(resolved(applyResolutions(mergeTexts('', '', 'theirs\n'), [])).text).toBe('theirs\n')
    expect(resolved(applyResolutions(mergeTexts('mine\n', '', ''), [])).text).toBe('mine\n')
  })

  it('treats a deletion by one side against an edit by the other as a hunk', () => {
    const merge = mergeTexts('a\nc\nd\ne\n', BASE, 'a\nB\nc\nd\ne\n')
    expect(merge.hunks).toEqual([{mine: '', base: 'b\n', theirs: 'B\n'}])
    expect(resolved(applyResolutions(merge, ['mine'])).text).toBe('a\nc\nd\ne\n')
    expect(resolved(applyResolutions(merge, ['theirs'])).text).toBe('a\nB\nc\nd\ne\n')
  })

  it('treats a final line with and without a newline as different lines', () => {
    const merge = mergeTexts('a\nb\nc\nd\ne', BASE, 'a\nb\nc\nd\ne\nf\n')
    expect(merge.hunks).toHaveLength(1)
  })

  it('records where each carried stretch sits in the draft', () => {
    const output = resolved(applyResolutions(mergeTexts('A\nb\nc\nd\ne\n', BASE, 'a\nb\nc\nd\nE\n'), []))
    expect(output.stretches.map(stretch => [stretch.source, stretch.mineStart])).toEqual([
      ['mine', 0],
      ['base', 2],
      ['theirs', null],
    ])
    expect(output.stretches.map(stretch => [stretch.outStart, stretch.outEnd])).toEqual([
      [0, 2],
      [2, 8],
      [8, 10],
    ])
  })

  it('records the draft position of a hunk resolved as mine', () => {
    const merge = mergeTexts('a\nMINE\nc\nd\ne\n', BASE, 'a\nTHEIRS\nc\nd\ne\n')
    const mine = resolved(applyResolutions(merge, ['mine']))
    expect(mine.stretches.find(stretch => stretch.source === 'mine')?.mineStart).toBe(2)
    const theirs = resolved(applyResolutions(merge, ['theirs']))
    expect(theirs.stretches.find(stretch => stretch.source === 'theirs')?.mineStart).toBeNull()
  })

  it('lays the stretches end to end over the whole merged text', () => {
    const merge = mergeTexts('a\nMINE\nc\nd\nE\n', BASE, 'x\nTHEIRS\nc\nd\ne\nf\n')
    const output = resolved(applyResolutions(merge, merge.hunks.map(() => 'theirs' as const)))
    let at = 0
    for (const stretch of output.stretches) {
      expect(stretch.outStart).toBe(at)
      expect(stretch.outEnd).toBeGreaterThan(stretch.outStart)
      at = stretch.outEnd
    }
    expect(at).toBe(output.text.length)
  })
})

describe('the node-diff3 shapes the merge relies on', () => {
  const lines = (text: string) => splitLines(text)

  it('diffIndices returns, per differing chunk, [start, length] tuples for both buffers', () => {
    const chunks = diffIndices(lines('a\nb\nc\n'), lines('a\nX\nY\nc\n')) as unknown[]
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({buffer1: [1, 1], buffer2: [1, 2]})
  })

  it('diff3MergeRegions returns stable regions tagged o, a or b with their start and content', () => {
    const regions = diff3MergeRegions(lines('A\nb\nc\nd\ne\n'), lines(BASE), lines('a\nb\nc\nd\nE\n')) as unknown[]
    expect(regions).toEqual([
      expect.objectContaining({stable: true, buffer: 'a', bufferStart: 0, bufferContent: ['A\n']}),
      expect.objectContaining({stable: true, buffer: 'o', bufferStart: 1, bufferContent: ['b\n', 'c\n', 'd\n']}),
      expect.objectContaining({stable: true, buffer: 'b', bufferStart: 4, bufferContent: ['E\n']}),
    ])
  })

  it('diff3MergeRegions returns an unstable region with the three versions and where the draft side starts', () => {
    const regions = diff3MergeRegions(lines('a\nMINE\nc\nd\ne\n'), lines(BASE), lines('a\nTHEIRS\nc\nd\ne\n')) as unknown[]
    expect(regions).toContainEqual(
      expect.objectContaining({stable: false, aStart: 1, aContent: ['MINE\n'], oContent: ['b\n'], bContent: ['THEIRS\n']}),
    )
  })
})
