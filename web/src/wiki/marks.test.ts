import {describe, expect, it} from 'vitest'
import {
  createMark,
  keepMark,
  locateMark,
  MARK_CONTEXT_LENGTH,
  MAX_MARK_TEXT_LENGTH,
  MAX_MARKS,
  markState,
  parseMarks,
  rebaseMarks,
  removeMark,
  saveMarksOf,
  snapToCodePoints,
  type Mark,
} from './marks.ts'

function created(text: string, start: number, end: number, existing: readonly Mark[] = []): Mark {
  const result = createMark(text, {start, end}, existing)
  if (!result.ok) throw new Error(`test setup: ${result.reason}`)
  return result.mark
}

function markOn(text: string, quoted: string, existing: readonly Mark[] = []): Mark {
  const start = text.indexOf(quoted)
  if (start < 0) throw new Error(`test setup: ${JSON.stringify(quoted)} is not in the text`)
  return created(text, start, start + quoted.length, existing)
}

describe('createMark', () => {
  it('keeps the exact text with UTF-16 offsets and a short prefix and suffix', () => {
    const text = 'Alpha builds widgets for factories.'
    const mark = created(text, 6, 12)
    expect(mark).toMatchObject({text: 'builds', start: 6, end: 12, prefix: 'Alpha ', suffix: ' widgets for factories.'})
    expect(mark.needsReview).toBe(false)
  })

  it('limits the prefix and suffix to the context length', () => {
    const text = `${'a'.repeat(100)}MARK${'b'.repeat(100)}`
    const mark = created(text, 100, 104)
    expect(mark.prefix).toBe('a'.repeat(MARK_CONTEXT_LENGTH))
    expect(mark.suffix).toBe('b'.repeat(MARK_CONTEXT_LENGTH))
  })

  it('keeps the exact text of a span with emoji, and counts offsets in UTF-16 code units', () => {
    const text = 'Say 👍🏽 and 😀 now.'
    const quoted = '👍🏽 and 😀'
    const mark = markOn(text, quoted)
    expect(mark.text).toBe(quoted)
    expect(mark.start).toBe(4)
    expect(mark.end - mark.start).toBe(quoted.length)
    expect(text.slice(mark.start, mark.end)).toBe(quoted)
    // Emoji take two UTF-16 units, so the offsets are not code point counts.
    expect([...quoted].length).toBeLessThan(quoted.length)
  })

  it('keeps combining characters in the text', () => {
    const text = 'Un cafe\u0301 au lait.'
    const quoted = 'cafe\u0301'
    const mark = markOn(text, quoted)
    expect(mark.text).toBe(quoted)
    expect(mark.text).toHaveLength(5)
    expect(mark.end - mark.start).toBe(5)
  })

  it('keeps astral-plane text', () => {
    const text = 'name: 𝒜𝒷𝒸 end'
    const mark = markOn(text, '𝒜𝒷𝒸')
    expect(mark.text).toBe('𝒜𝒷𝒸')
    expect(mark.end - mark.start).toBe(6)
  })

  it('never splits a surrogate pair in the prefix or the suffix', () => {
    const text = `${'👍'.repeat(20)}MARK${'👎'.repeat(20)}`
    const start = text.indexOf('MARK')
    const mark = created(text, start, start + 4)
    expect(mark.prefix).not.toMatch(/^[\u{DC00}-\u{DFFF}]/u)
    expect(mark.suffix).not.toMatch(/[\u{D800}-\u{DBFF}]$/u)
    expect([...mark.prefix].every(char => char === '👍')).toBe(true)
    expect([...mark.suffix].every(char => char === '👎')).toBe(true)
  })

  it('moves a selection that splits a surrogate pair out to the whole code point', () => {
    const text = 'a👍b'
    // [2, 3) covers only the low half of the emoji; [1, 2) only the high half.
    expect(snapToCodePoints(text, 2, 3)).toEqual({start: 1, end: 3})
    expect(snapToCodePoints(text, 1, 2)).toEqual({start: 1, end: 3})
    expect(created(text, 2, 4).text).toBe('👍b')
  })

  it('does not move a selection that already falls on code point boundaries', () => {
    expect(snapToCodePoints('a👍b', 1, 3)).toEqual({start: 1, end: 3})
    expect(snapToCodePoints('abc', 0, 3)).toEqual({start: 0, end: 3})
  })

  it('clamps a selection to the text', () => {
    expect(snapToCodePoints('abc', -4, 99)).toEqual({start: 0, end: 3})
  })

  it('numbers the marks so an ID is never reused after one is removed', () => {
    const text = 'one two three'
    const first = markOn(text, 'one')
    const second = markOn(text, 'two', [first])
    const third = markOn(text, 'three', [first, second])
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)

    const afterRemoval = removeMark([first, second, third], second.id)
    const fourth = created(text, 0, 7, afterRemoval)
    expect(new Set([...afterRemoval.map(mark => mark.id), fourth.id]).size).toBe(3)
  })

  it('refuses an empty selection', () => {
    expect(createMark('abc', {start: 1, end: 1}, [])).toEqual({ok: false, reason: 'empty'})
    expect(createMark('abc', {start: 2, end: 1}, [])).toEqual({ok: false, reason: 'empty'})
  })

  it('refuses a span longer than the server accepts', () => {
    const text = 'x'.repeat(MAX_MARK_TEXT_LENGTH + 1)
    expect(createMark(text, {start: 0, end: MAX_MARK_TEXT_LENGTH + 1}, [])).toEqual({ok: false, reason: 'too-long'})
    expect(createMark(text, {start: 0, end: MAX_MARK_TEXT_LENGTH}, []).ok).toBe(true)
  })

  it('refuses a mark over the limit the server accepts', () => {
    const text = 'x'.repeat(MAX_MARKS + 5)
    let marks: Mark[] = []
    for (let i = 0; i < MAX_MARKS; i += 1) marks = [...marks, created(text, i, i + 1, marks)]
    expect(createMark(text, {start: MAX_MARKS, end: MAX_MARKS + 1}, marks)).toEqual({ok: false, reason: 'too-many'})
  })

  it('refuses the same span marked twice', () => {
    const text = 'one two'
    const first = markOn(text, 'one')
    expect(createMark(text, {start: 0, end: 3}, [first])).toEqual({ok: false, reason: 'duplicate'})
  })
})

describe('locateMark', () => {
  it('finds a mark where its offsets say', () => {
    const text = 'Alpha builds widgets.'
    const mark = markOn(text, 'widgets')
    expect(locateMark(text, mark)).toEqual({start: mark.start, end: mark.end})
  })

  it('finds a mark by its text when the offsets are stale', () => {
    const text = 'Alpha builds widgets.'
    const mark = markOn(text, 'widgets')
    const moved = `Preamble line.\n${text}`
    expect(locateMark(moved, mark)).toEqual({start: moved.indexOf('widgets'), end: moved.indexOf('widgets') + 7})
  })

  it('picks the occurrence whose surroundings match when the text repeats', () => {
    const text = 'red apple, green apple, blue apple'
    const mark = markOn(text, 'apple', []) // the first one
    const second = created(text, text.indexOf('apple', 10), text.indexOf('apple', 10) + 5, [mark])
    expect(second.prefix.endsWith('green ')).toBe(true)

    const edited = `NEW ${text}`
    expect(locateMark(edited, second)).toEqual({
      start: edited.indexOf('green apple') + 6,
      end: edited.indexOf('green apple') + 11,
    })
  })

  it('prefers the occurrence nearest the offsets when the surroundings match equally', () => {
    const text = 'xx apple yy\nxx apple yy\n'
    const second = created(text, text.lastIndexOf('apple'), text.lastIndexOf('apple') + 5)
    const shifted = `.${text}`
    expect(locateMark(shifted, second)?.start).toBe(shifted.lastIndexOf('apple'))
  })

  it('returns null when the text is gone', () => {
    const text = 'Alpha builds widgets.'
    const mark = markOn(text, 'widgets')
    expect(locateMark('Alpha builds gadgets.', mark)).toBeNull()
  })

  it('finds emoji and combining text by its exact code units', () => {
    const text = 'Say 👍🏽 and cafe\u0301 now.'
    const mark = markOn(text, '👍🏽 and cafe\u0301')
    const moved = `>> ${text}`
    const found = locateMark(moved, mark)
    expect(found).not.toBeNull()
    expect(moved.slice(found?.start, found?.end)).toBe('👍🏽 and cafe\u0301')
  })
})

describe('markState', () => {
  it('is ok for a mark whose text is in the draft', () => {
    const mark = markOn('one two', 'two')
    expect(markState('one two', mark)).toBe('ok')
  })

  it('is review for a flagged mark, even when its text is in the draft', () => {
    const mark = {...markOn('one two', 'two'), needsReview: true}
    expect(markState('one two', mark)).toBe('review')
  })

  it('is detached for a mark whose text is no longer in the draft', () => {
    const mark = markOn('one two', 'two')
    expect(markState('one three', mark)).toBe('detached')
  })
})

describe('keepMark and removeMark', () => {
  it('keeping a flagged mark clears the flag and leaves the rest alone', () => {
    const text = 'one two'
    const flagged = {...markOn(text, 'one'), needsReview: true}
    const other = markOn(text, 'two', [flagged])
    const kept = keepMark([flagged, other], flagged.id)
    expect(kept[0]).toEqual({...flagged, needsReview: false})
    expect(kept[1]).toBe(other)
  })

  it('removes only the named mark', () => {
    const text = 'one two'
    const a = markOn(text, 'one')
    const b = markOn(text, 'two', [a])
    expect(removeMark([a, b], a.id)).toEqual([b])
    expect(removeMark([a, b], 'nope')).toEqual([a, b])
  })
})

describe('rebaseMarks', () => {
  const text = 'Alpha builds widgets for factories.'

  it('leaves marks alone when the text is the same', () => {
    const marks = [markOn(text, 'widgets')]
    expect(rebaseMarks(marks, text, text)).toBe(marks)
  })

  it('shifts a mark when text is inserted before it', () => {
    const mark = markOn(text, 'widgets')
    const next = `Intro. ${text}`
    const [moved] = rebaseMarks([mark], text, next)
    expect(moved).toMatchObject({text: 'widgets', start: mark.start + 7, end: mark.end + 7})
    expect(next.slice(moved?.start, moved?.end)).toBe('widgets')
  })

  it('shifts a mark back when text is deleted before it', () => {
    const mark = markOn(text, 'widgets')
    const next = text.slice(6)
    const [moved] = rebaseMarks([mark], text, next)
    expect(next.slice(moved?.start, moved?.end)).toBe('widgets')
  })

  it('leaves a mark in place when text is inserted after it', () => {
    const mark = markOn(text, 'widgets')
    const [same] = rebaseMarks([mark], text, `${text} More.`)
    expect(same).toMatchObject({start: mark.start, end: mark.end, text: 'widgets'})
  })

  it('leaves a mark in place when text is typed right at its end', () => {
    const mark = markOn(text, 'widgets')
    const next = `${text.slice(0, mark.end)}!${text.slice(mark.end)}`
    const [same] = rebaseMarks([mark], text, next)
    expect(same).toMatchObject({start: mark.start, end: mark.end, text: 'widgets'})
  })

  it('moves a mark when text is typed right at its start', () => {
    const mark = markOn(text, 'widgets')
    const next = `${text.slice(0, mark.start)}!${text.slice(mark.start)}`
    const [moved] = rebaseMarks([mark], text, next)
    expect(moved).toMatchObject({text: 'widgets', start: mark.start + 1, end: mark.end + 1})
  })

  it('grows a mark when text is typed inside it, and keeps the new text', () => {
    const mark = markOn(text, 'widgets')
    const next = `${text.slice(0, mark.start + 3)}XYZ${text.slice(mark.start + 3)}`
    const [grown] = rebaseMarks([mark], text, next)
    expect(grown).toMatchObject({text: 'widXYZgets', start: mark.start, end: mark.end + 3})
  })

  it('follows a word replaced inside the mark', () => {
    const mark = markOn(text, 'builds widgets')
    const next = text.replace('widgets', 'gadgets')
    const [edited] = rebaseMarks([mark], text, next)
    expect(edited).toMatchObject({text: 'builds gadgets'})
    expect(markState(next, edited as Mark)).toBe('ok')
  })

  it('follows text that replaces the whole marked span', () => {
    const mark = markOn(text, 'widgets')
    const next = text.replace('widgets', 'gadgets')
    const [replaced] = rebaseMarks([mark], text, next)
    expect(replaced).toMatchObject({text: 'gadgets'})
  })

  it('detaches a mark whose text is deleted, and keeps what it said', () => {
    const withTag = 'Alpha [KEEP] tail'
    const mark = markOn(withTag, '[KEEP]')
    const next = withTag.replace('[KEEP]', '')
    const [gone] = rebaseMarks([mark], withTag, next)
    expect(gone).toMatchObject({text: '[KEEP]'})
    expect(markState(next, gone as Mark)).toBe('detached')
  })

  it('attaches a detached mark again when its text comes back', () => {
    const withTag = 'Alpha [KEEP] tail'
    const mark = markOn(withTag, '[KEEP]')
    const removed = withTag.replace('[KEEP]', '')
    const [gone] = rebaseMarks([mark], withTag, removed)
    const [back] = rebaseMarks([gone as Mark], removed, withTag)
    expect(back).toMatchObject({text: '[KEEP]', start: mark.start, end: mark.end})
    expect(markState(withTag, back as Mark)).toBe('ok')
  })

  it('keeps every mark attached through an edit between and around them', () => {
    const a = markOn(text, 'Alpha')
    const b = markOn(text, 'factories', [a])
    const next = text.replace('builds widgets for', 'ships things to')
    const [movedA, movedB] = rebaseMarks([a, b], text, next)
    expect(next.slice(movedA?.start, movedA?.end)).toBe('Alpha')
    expect(next.slice(movedB?.start, movedB?.end)).toBe('factories')
  })

  it('keeps emoji marks on code point boundaries when text is inserted before them', () => {
    const emoji = 'Say 👍🏽 now.'
    const mark = markOn(emoji, '👍🏽')
    const next = `😀 ${emoji}`
    const [moved] = rebaseMarks([mark], emoji, next)
    expect(next.slice(moved?.start, moved?.end)).toBe('👍🏽')
  })

  it('does not change the flag', () => {
    const flagged = {...markOn(text, 'widgets'), needsReview: true}
    const [moved] = rebaseMarks([flagged], text, `x${text}`)
    expect(moved?.needsReview).toBe(true)
  })

  it('refreshes the surroundings of a mark that moved', () => {
    const mark = markOn(text, 'widgets')
    const next = text.replace('builds', 'assembles')
    const [moved] = rebaseMarks([mark], text, next)
    expect(moved?.prefix).toContain('assembles')
  })
})

describe('saveMarksOf', () => {
  it('sends each attached mark with its current text and offsets, in text order', () => {
    const text = 'one two three'
    const two = markOn(text, 'two')
    const one = markOn(text, 'one', [two])
    expect(saveMarksOf(text, [two, one])).toEqual([
      {text: 'one', start: 0, end: 3},
      {text: 'two', start: 4, end: 7},
    ])
  })

  it('leaves out a mark that is detached', () => {
    const mark = markOn('one two', 'two')
    expect(saveMarksOf('one three', [mark])).toEqual([])
  })
})

describe('parseMarks', () => {
  const good = {id: 'm1', start: 0, end: 3, text: 'one', prefix: '', suffix: ' two', needsReview: false}

  it('accepts a list of well-formed marks', () => {
    expect(parseMarks([good])).toEqual([good])
    expect(parseMarks([])).toEqual([])
  })

  it.each([
    ['not an array', 'x'],
    ['a non-object mark', [1]],
    ['an empty ID', [{...good, id: ''}]],
    ['an empty text', [{...good, text: ''}]],
    ['text over the limit', [{...good, text: 'x'.repeat(MAX_MARK_TEXT_LENGTH + 1)}]],
    ['a fractional start', [{...good, start: 0.5}]],
    ['a negative start', [{...good, start: -1}]],
    ['an end before the start', [{...good, end: 0}]],
    ['a missing prefix', [{...good, prefix: undefined}]],
    ['a non-boolean flag', [{...good, needsReview: 'yes'}]],
    ['a repeated ID', [good, good]],
  ])('refuses %s', (_label, value) => {
    expect(parseMarks(value)).toBeNull()
  })

  it('refuses a list longer than the server accepts', () => {
    const many = Array.from({length: MAX_MARKS + 1}, (_unused, index) => ({...good, id: `m${index}`}))
    expect(parseMarks(many)).toBeNull()
  })
})
