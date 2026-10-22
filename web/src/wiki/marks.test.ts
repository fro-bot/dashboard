import {describe, expect, it} from 'vitest'
import {
  createMark,
  isPlaced,
  keepMark,
  locateMark,
  MARK_CONTEXT_LENGTH,
  MAX_MARK_TEXT_LENGTH,
  MAX_MARKS,
  markState,
  parseMarks,
  rebaseAndLimit,
  rebaseMarks,
  removeMark,
  saveMarksOf,
  snapToCodePoints,
  unplaceMark,
  type Mark,
} from './marks.ts'
import {checkUnmarkedChanges} from './unmarked.ts'

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

  it('trims a prefix window that starts on the low half of a pair', () => {
    // 'a', 12 emoji, 'x', then the mark: the 24-unit window before the mark starts on a low surrogate.
    const text = `a${'👍'.repeat(12)}xMARK`
    const start = text.indexOf('MARK')
    const window = text.slice(start - MARK_CONTEXT_LENGTH, start)
    expect(window.charCodeAt(0)).toBeGreaterThanOrEqual(0xdc00)
    expect(window.charCodeAt(0)).toBeLessThanOrEqual(0xdfff)

    const mark = created(text, start, start + 4)
    expect(mark.prefix).toBe(window.slice(1))
    expect(mark.prefix).toHaveLength(MARK_CONTEXT_LENGTH - 1)
    expect(mark.prefix.charCodeAt(0)).toBeGreaterThanOrEqual(0xd800)
    expect(mark.prefix.charCodeAt(0)).toBeLessThanOrEqual(0xdbff)
    expect(mark.prefix.endsWith('x')).toBe(true)
  })

  it('trims a suffix window that ends on the high half of a pair', () => {
    // The mark, 'x', then 20 emoji: the 24-unit window after the mark is 'x', 11 emoji, and a high surrogate.
    const text = `MARK${'x'}${'👍'.repeat(20)}`
    const window = text.slice(4, 4 + MARK_CONTEXT_LENGTH)
    const last = window.charCodeAt(window.length - 1)
    expect(last).toBeGreaterThanOrEqual(0xd800)
    expect(last).toBeLessThanOrEqual(0xdbff)

    const mark = created(text, 0, 4)
    expect(mark.suffix).toBe(window.slice(0, -1))
    expect(mark.suffix).toBe(`x${'👍'.repeat(11)}`)
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

  it('is detached for a flagged mark whose text stands elsewhere than its own offsets', () => {
    const text = 'one two, two again'
    const stale = {...markOn(text, 'two'), start: 10, end: 13, needsReview: true}
    expect(locateMark(text, stale)).not.toBeNull()
    expect(markState(text, stale)).toBe('detached')
  })

  it('is detached for an unplaced mark, even when its text is in the draft', () => {
    const text = 'one two, two again'
    const unplaced = unplaceMark(markOn(text, 'two'))
    expect(locateMark(text, unplaced)).not.toBeNull()
    expect(markState(text, unplaced)).toBe('detached')
  })
})

describe('an unplaced mark', () => {
  it('keeps its text and is flagged, with offsets no text can have', () => {
    const mark = markOn('one two', 'two')
    const unplaced = unplaceMark(mark)
    expect(unplaced).toMatchObject({id: mark.id, text: 'two', needsReview: true})
    expect(isPlaced(mark)).toBe(true)
    expect(isPlaced(unplaced)).toBe(false)
    expect(unplaced.end - unplaced.start).toBe('two'.length)
  })

  it('is stored and read back as an unplaced mark', () => {
    const unplaced = unplaceMark(markOn('one two', 'two'))
    const [read] = parseMarks(JSON.parse(JSON.stringify([unplaced])) as unknown) ?? []
    expect(read).toEqual(unplaced)
    expect(isPlaced(read as Mark)).toBe(false)
  })

  it('is never sent with a save', () => {
    const text = 'one two, two again'
    expect(saveMarksOf(text, [unplaceMark(markOn(text, 'two'))])).toEqual([])
  })

  it('stays unplaced through an edit that leaves its text in the draft', () => {
    const text = 'one two, two again'
    const unplaced = unplaceMark(markOn(text, 'two'))
    const next = `Intro. ${text}`
    expect(rebaseMarks([unplaced], text, next)).toEqual([unplaced])
    const typed = `${text} two`
    expect(rebaseMarks([unplaced], text, typed)).toEqual([unplaced])
  })
})

describe('keepMark and removeMark', () => {
  it('keeping a flagged mark clears the flag and leaves the rest alone', () => {
    const text = 'one two'
    const flagged = {...markOn(text, 'one'), needsReview: true}
    const other = markOn(text, 'two', [flagged])
    const kept = keepMark([flagged, other], flagged.id, text)
    expect(kept[0]).toEqual({...flagged, needsReview: false})
    expect(kept[1]).toBe(other)
  })

  it('refuses to keep a flagged mark whose text does not stand at its own offsets', () => {
    const text = 'one two, two again'
    const stale = {...markOn(text, 'two'), start: 10, end: 13, needsReview: true}
    const marks = [stale]
    expect(keepMark(marks, stale.id, text)).toEqual(marks)
    expect(keepMark(marks, stale.id, text)[0]?.needsReview).toBe(true)
  })

  it('refuses to keep an unplaced mark', () => {
    const text = 'one two, two again'
    const unplaced = unplaceMark(markOn(text, 'two'))
    expect(keepMark([unplaced], unplaced.id, text)).toEqual([unplaced])
  })

  it('refuses when the quote around the mark no longer matches and the text stands elsewhere', () => {
    const text = 'aaa two bbb. ccc two ddd.'
    const flagged = {...markOn(text, 'two'), needsReview: true}
    // The words around the mark changed, and the other occurrence now has the mark's context.
    const changed = 'xxx two yyy. aaa two bbb.'
    expect(markState(changed, flagged)).toBe('detached')
    expect(keepMark([flagged], flagged.id, changed)[0]?.needsReview).toBe(true)
  })

  it('keeps a flagged mark that the edit clipped, at the offsets it has', () => {
    const page = 'The cat sat on the mat.'
    const mark = markOn(page, 'cat sat')
    const next = page.replace('sat on the mat', 'ran')
    const [clipped] = rebaseMarks([mark], page, next)
    expect(markState(next, clipped as Mark)).toBe('review')
    const [kept] = keepMark([clipped as Mark], (clipped as Mark).id, next)
    expect(kept).toMatchObject({text: 'cat ', needsReview: false})
    expect(markState(next, kept as Mark)).toBe('ok')
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

  it('follows text that replaces exactly the marked span: the change lies inside the mark', () => {
    const mark = markOn(text, 'widgets')
    const next = text.replace('widgets', 'XYZ')
    const [replaced] = rebaseMarks([mark], text, next)
    expect(replaced).toMatchObject({text: 'XYZ', start: mark.start, end: mark.start + 3, needsReview: false})
  })

  it('replaces an emoji inside a mark and stays on whole code points', () => {
    const emoji = 'Say 👍 and 😀 now.'
    const mark = markOn(emoji, '👍 and 😀')
    const next = emoji.replace('👍', '👎')
    const [moved] = rebaseMarks([mark], emoji, next)
    expect(moved).toMatchObject({text: '👎 and 😀'})
    expect(next.slice(moved?.start, moved?.end)).toBe('👎 and 😀')
    expect(next.slice(moved?.start, moved?.end)).not.toMatch(/[\u{D800}-\u{DBFF}](?![\u{DC00}-\u{DFFF}])|(?<![\u{D800}-\u{DBFF}])[\u{DC00}-\u{DFFF}]/u)
  })

  it('replaces an emoji that is the whole mark and keeps whole code points', () => {
    const emoji = 'Say 👍 now.'
    const mark = markOn(emoji, '👍')
    const next = emoji.replace('👍', '👎')
    const [moved] = rebaseMarks([mark], emoji, next)
    expect(moved).toMatchObject({text: '👎', start: mark.start, end: mark.end, needsReview: false})
  })

  describe('an emoji replaced at the edge of a mark', () => {
    const lone = /[\u{D800}-\u{DBFF}](?![\u{DC00}-\u{DFFF}])|(?<![\u{D800}-\u{DBFF}])[\u{DC00}-\u{DFFF}]/u

    it('clips to whole code points when the common head ends inside the pair', () => {
      // The two emoji share their high surrogate, so the common head would end between the halves.
      const base = 'x👍y'
      const mark = markOn(base, 'x👍')
      const next = 'x👎z'
      const [rebased] = rebaseMarks([mark], base, next)
      expect(rebased).toMatchObject({text: 'x', needsReview: true})
      expect(lone.test(rebased?.text ?? '')).toBe(false)
      expect(lone.test(next.slice(rebased?.start, rebased?.end))).toBe(false)
    })

    it('leaves no half of a pair when the common tail starts inside the pair', () => {
      // The two characters share their low surrogate, so the common tail would start between the halves.
      const base = 'ab👍y'
      const mark = markOn(base, '👍')
      const next = 'aQ\u{2F44D}y'
      const [rebased] = rebaseMarks([mark], base, next)
      expect(lone.test(rebased?.text ?? '')).toBe(false)
      expect(lone.test(next.slice(rebased?.start, rebased?.end))).toBe(false)
    })
  })

  describe('a change that crosses the edge of a mark', () => {
    const page = 'The cat sat on the mat. Dogs bark loudly at night.'

    it('clips the mark to what survives, flags it, and does not cover the new text (adversarial paste)', () => {
      const mark = markOn(page, 'cat')
      const next = 'The dog'
      // One paste replaces everything from "cat" to the end with "dog".
      const [rebased] = rebaseMarks([mark], page, next)
      expect(rebased).toBeDefined()
      expect(markState(next, rebased as Mark)).toBe('detached')
      const range = locateMark(next, rebased as Mark)
      expect(range).toBeNull()
    })

    it('keeps the part of the mark before the change, flagged for review', () => {
      const mark = markOn(page, 'cat sat')
      // "sat on the mat" is replaced: the change starts inside the mark and runs past its end.
      const next = page.replace('sat on the mat', 'ran')
      const [rebased] = rebaseMarks([mark], page, next)
      expect(rebased).toMatchObject({text: 'cat ', needsReview: true})
      expect(next.slice(rebased?.start, rebased?.end)).toBe('cat ')
      expect(markState(next, rebased as Mark)).toBe('review')
    })

    it('keeps the clipped offsets through an unrelated edit, and the mark can still be kept', () => {
      const mark = markOn(page, 'cat sat')
      const clipped = page.replace('sat on the mat', 'ran')
      const [flagged] = rebaseMarks([mark], page, clipped)
      expect(flagged).toMatchObject({text: 'cat ', needsReview: true})

      const before = `Intro. ${clipped}`
      const [shifted] = rebaseMarks([flagged as Mark], clipped, before)
      expect(shifted).toMatchObject({text: 'cat ', needsReview: true, start: (flagged?.start ?? 0) + 7})
      expect(before.slice(shifted?.start, shifted?.end)).toBe('cat ')
      expect(markState(before, shifted as Mark)).toBe('review')

      const after = `${before} Outro.`
      const [still] = rebaseMarks([shifted as Mark], before, after)
      expect(still).toMatchObject({start: shifted?.start, end: shifted?.end, needsReview: true})
      expect(markState(after, still as Mark)).toBe('review')
      const [kept] = keepMark([still as Mark], (still as Mark).id, after)
      expect(kept).toMatchObject({needsReview: false})
      expect(markState(after, kept as Mark)).toBe('ok')
    })

    it('keeps the part of the mark after the change, flagged for review', () => {
      const mark = markOn(page, 'cat sat')
      // "The cat" is replaced: the change starts before the mark and ends inside it.
      const next = page.replace('The cat', 'A dog')
      const [rebased] = rebaseMarks([mark], page, next)
      expect(rebased).toMatchObject({text: ' sat', needsReview: true})
      expect(next.slice(rebased?.start, rebased?.end)).toBe(' sat')
    })

    it('detaches a mark the change covers entirely', () => {
      const mark = markOn(page, 'cat')
      const next = page.replace('The cat sat', 'One')
      const [rebased] = rebaseMarks([mark], page, next)
      expect(markState(next, rebased as Mark)).toBe('detached')
    })

    it('does not stretch a mark over a deletion at one end and an insertion at the other', () => {
      const base = 'alpha beta gamma delta'
      const mark = markOn(base, 'beta')
      const next = 'beta gamma delta!'
      const [rebased] = rebaseMarks([mark], base, next)
      expect(rebased?.needsReview).toBe(true)
      // The one edit region is the whole text, so the mark keeps its old offsets, which the text no
      // longer has. The same word stands at the start, but the mark is not at its own offsets there.
      expect(markState(next, rebased as Mark)).toBe('detached')
      const range = locateMark(next, rebased as Mark)
      expect(range).toEqual({start: 0, end: 4})
      expect(next.slice(range?.start, range?.end)).toBe('beta')
      // The "!" is not inside the mark, whatever the mark's state.
      expect(range?.end).toBeLessThan(next.indexOf('!'))
    })

    describe('a change that covers the whole mark while the same text stands elsewhere', () => {
      const twice = 'Alpha builds widgets. Beta builds widgets.'

      it('flags the mark when one edit deletes exactly its text, and never settles it on the other occurrence', () => {
        const mark = markOn(twice, 'widgets')
        const next = twice.replace('widgets', '')
        const [rebased] = rebaseMarks([mark], twice, next)

        expect(rebased).toMatchObject({text: 'widgets', needsReview: true})
        // Its text stands at the other occurrence, but the mark is not at its own offsets there.
        expect(markState(next, rebased as Mark)).toBe('detached')
      })

      it('flags the mark when one edit replaces a range wider than it on both sides', () => {
        const mark = markOn(twice, 'widgets')
        // " widgets." becomes "XX": the range runs past the mark at both ends.
        const next = twice.replace(' widgets.', 'XX')
        const [rebased] = rebaseMarks([mark], twice, next)

        expect(next.startsWith('Alpha buildsXX Beta builds widgets.')).toBe(true)
        expect(rebased).toMatchObject({text: 'widgets', needsReview: true})
        expect(markState(next, rebased as Mark)).toBe('detached')
      })

      it('is unplaced by a later unrelated edit, and never moves to the other occurrence', () => {
        const mark = markOn(twice, 'widgets')
        const deleted = twice.replace('widgets', '')
        const [flagged] = rebaseMarks([mark], twice, deleted)
        const other = deleted.indexOf('widgets')
        expect(other).toBeGreaterThan(0)

        const later = `Intro. ${deleted}`
        const [after] = rebaseMarks([flagged as Mark], deleted, later)

        expect(after).toMatchObject({text: 'widgets', needsReview: true})
        expect(isPlaced(after as Mark)).toBe(false)
        expect(markState(later, after as Mark)).toBe('detached')
        expect(keepMark([after as Mark], (after as Mark).id, later)[0]?.needsReview).toBe(true)
        expect(saveMarksOf(later, [after as Mark])).toEqual([])
      })

      it('is unplaced by an unrelated edit after it, too', () => {
        const mark = markOn(twice, 'widgets')
        const deleted = twice.replace('widgets', '')
        const [flagged] = rebaseMarks([mark], twice, deleted)
        const [after] = rebaseMarks([flagged as Mark], deleted, `${deleted} More.`)
        expect(isPlaced(after as Mark)).toBe(false)
        expect(markState(`${deleted} More.`, after as Mark)).toBe('detached')
      })

      it('is detached, and flagged, when the text stands nowhere else', () => {
        const once = 'Alpha builds widgets.'
        const mark = markOn(once, 'widgets')
        const next = once.replace('widgets', '')
        const [rebased] = rebaseMarks([mark], once, next)
        expect(rebased?.needsReview).toBe(true)
        expect(markState(next, rebased as Mark)).toBe('detached')
      })
    })

    it('does not mark unmarked text through the whole check: the pasted text stays unmarked or Save waits', () => {
      const mark = markOn(page, 'cat')
      const next = 'The dog'
      const [rebased] = rebaseMarks([mark], page, next)
      const sent = saveMarksOf(next, [rebased as Mark])
      expect(sent).toEqual([])
    })
  })

  it('grows a mark only when the change lies entirely inside it', () => {
    const mark = markOn(text, 'builds widgets for')
    const next = text.replace('widgets', 'WIDGETS AND MORE')
    const [grown] = rebaseMarks([mark], text, next)
    expect(grown).toMatchObject({text: 'builds WIDGETS AND MORE for', needsReview: false})
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
    expect(back).toMatchObject({text: '[KEEP]', start: mark.start, end: mark.end, needsReview: true})
    expect(markState(withTag, back as Mark)).toBe('review')
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

describe('rebaseAndLimit', () => {
  const hundred = 'x'.repeat(100)
  const page = `Start ${hundred} end.`

  it('drops a mark that grew past the length the server accepts', () => {
    const mark = markOn(page, hundred)
    const pasted = 'y'.repeat(MAX_MARK_TEXT_LENGTH - 50)
    const next = `${page.slice(0, mark.start + 50)}${pasted}${page.slice(mark.start + 50)}`

    const plain = rebaseMarks([mark], page, next)
    expect((plain[0] as Mark).text.length).toBeGreaterThan(MAX_MARK_TEXT_LENGTH)

    const limited = rebaseAndLimit([mark], page, next)
    expect(limited.marks).toEqual([])
    expect(limited.dropped).toBe(1)
  })

  it('keeps a mark that grew but is still within the limit, and the others', () => {
    const mark = markOn(page, hundred)
    const other = markOn(page, 'Start', [mark])
    const next = `${page.slice(0, mark.start + 50)}${'y'.repeat(500)}${page.slice(mark.start + 50)}`

    const limited = rebaseAndLimit([mark, other], page, next)
    expect(limited.marks.map(item => item.id)).toEqual([mark.id, other.id])
    expect(limited.dropped).toBe(0)
  })

  it('counts several dropped marks', () => {
    const a = markOn(page, hundred)
    const next = `${page.slice(0, a.start + 10)}${'z'.repeat(MAX_MARK_TEXT_LENGTH)}${page.slice(a.start + 10)}`
    expect(rebaseAndLimit([a, {...a, id: 'm9'}], page, next)).toMatchObject({marks: [], dropped: 2})
  })

  it('returns the marks untouched for an unchanged text', () => {
    const marks = [markOn(page, hundred)]
    expect(rebaseAndLimit(marks, page, page)).toEqual({marks, dropped: 0})
  })
})

// ---------------------------------------------------------------------------
// One keystroke at a time
// ---------------------------------------------------------------------------

/**
 * The editor rebases the marks on every input event, and a textarea fires one per keystroke. These
 * tests do the same: the first keystroke replaces `replacing` characters at `at`, and each later one
 * inserts a character at the caret.
 */
function keystrokes(
  text: string,
  marks: readonly Mark[],
  at: number,
  typed: string,
  replacing = 0,
): {readonly text: string; readonly marks: readonly Mark[]; readonly steps: readonly (readonly Mark[])[]} {
  let current = text
  let rebased = marks
  let caret = at
  const steps: (readonly Mark[])[] = []
  for (const [index, char] of [...typed].entries()) {
    const next = current.slice(0, caret) + char + current.slice(caret + (index === 0 ? replacing : 0))
    // The browser reports the caret after the input, at the end of what was typed.
    rebased = rebaseAndLimit(rebased, current, next, {caret: caret + char.length, inserted: char.length}).marks
    steps.push(rebased)
    current = next
    caret += char.length
  }
  return {text: current, marks: rebased, steps}
}

describe('typing one character at a time', () => {
  const page = 'The cat sat on the mat.'

  it('does not grow a mark when text is typed after it, and the check reports the typed text unmarked', () => {
    const mark = markOn(page, 'cat')
    const typed = keystrokes(page, [mark], mark.end, ' sat')

    expect(typed.text).toBe('The cat sat sat on the mat.')
    for (const step of typed.steps) expect(step[0]).toMatchObject({text: 'cat', start: 4, end: 7, needsReview: false})
    expect(
      checkUnmarkedChanges({baseText: page, draftText: typed.text, marks: saveMarksOf(typed.text, typed.marks)}),
    ).toBe('unmarked')
  })

  it('does not grow a mark when text is typed after it at the end of the page', () => {
    const end = 'The cat'
    const mark = markOn(end, 'cat')
    const typed = keystrokes(end, [mark], mark.end, ' sat')
    expect(typed.marks[0]).toMatchObject({text: 'cat', start: 4, end: 7})
    expect(
      checkUnmarkedChanges({baseText: end, draftText: typed.text, marks: saveMarksOf(typed.text, typed.marks)}),
    ).toBe('unmarked')
  })

  it('does not grow a mark when text is typed at its start; the mark shifts along', () => {
    const mark = markOn(page, 'cat')
    const typed = keystrokes(page, [mark], mark.start, 'big ')

    expect(typed.text).toBe('The big cat sat on the mat.')
    expect(typed.marks[0]).toMatchObject({text: 'cat', start: 8, end: 11, needsReview: false})
    for (const step of typed.steps) expect(step[0]?.text).toBe('cat')
  })

  it('does not grow a mark when the typed character repeats the first character of the mark', () => {
    const mark = markOn(page, 'cat')
    const typed = keystrokes(page, [mark], mark.start, 'ccc')

    expect(typed.text).toBe('The ccccat sat on the mat.')
    expect(typed.marks[0]).toMatchObject({text: 'cat', start: 7, end: 10, needsReview: false})
    for (const step of typed.steps) expect(step[0]?.text).toBe('cat')
  })

  it('does not grow a mark when a character that repeats its text is typed inside it, since it could equally be at an edge', () => {
    const run = 'x aaa y'
    const mark = markOn(run, 'aaa')
    const typed = keystrokes(run, [mark], mark.start + 2, 'a')
    expect(typed.text).toBe('x aaaa y')
    expect(typed.marks[0]).toMatchObject({text: 'aaa', needsReview: false})
  })

  it('does not grow a mark when the typed character repeats the last character of the mark', () => {
    const mark = markOn(page, 'cat')
    const typed = keystrokes(page, [mark], mark.end, 'ttt')
    expect(typed.marks[0]).toMatchObject({text: 'cat', start: 4, end: 7, needsReview: false})
  })

  it('clips a mark when text is selected from inside it to past its end, and typing over it adds nothing to it', () => {
    const mark = markOn(page, 'cat sat')
    // Select "sat on" (from inside the mark to past its end) and type over it.
    const at = page.indexOf('sat')
    const typed = keystrokes(page, [mark], at, 'replacement', 'sat on'.length)

    expect(typed.text).toBe('The cat replacement the mat.')
    expect(typed.steps[0]?.[0]).toMatchObject({text: 'cat ', needsReview: true})
    for (const step of typed.steps) expect(step[0]).toMatchObject({text: 'cat ', start: 4, end: 8, needsReview: true})
    expect(typed.marks[0]?.text).not.toContain('replacement')
  })

  it('clips the same way when the text after the selection starts like what is typed', () => {
    const left = 'left over item'
    const mark = markOn(left, 'left over')
    const typed = keystrokes(left, [mark], left.indexOf('over'), 'replacement', 'over i'.length)
    for (const step of typed.steps) expect(step[0]?.text.length).toBeLessThanOrEqual('left '.length)
    expect(typed.marks[0]).toMatchObject({text: 'left ', needsReview: true})
  })

  it('still grows a mark when text is typed strictly inside it', () => {
    const mark = markOn(page, 'cat sat')
    const typed = keystrokes(page, [mark], page.indexOf('sat'), 'very ')

    expect(typed.text).toBe('The cat very sat on the mat.')
    expect(typed.marks[0]).toMatchObject({text: 'cat very sat', start: 4, end: 16, needsReview: false})
    expect(typed.steps.map(step => step[0]?.text)).toEqual([
      'cat vsat',
      'cat vesat',
      'cat versat',
      'cat verysat',
      'cat very sat',
    ])
  })

  it('keeps the mark on its text when a character is typed into the middle of a word it holds', () => {
    const widgets = 'Alpha builds widgets.'
    const mark = markOn(widgets, 'widgets')
    const typed = keystrokes(widgets, [mark], widgets.indexOf('dg'), 'XYZ')
    expect(typed.marks[0]).toMatchObject({text: 'wiXYZdgets'})
  })

  describe('selecting exactly the marked text and retyping it', () => {
    it('replaces the marked text with the first keystroke, and what follows is not part of the mark', () => {
      const mark = markOn(page, 'cat')
      const typed = keystrokes(page, [mark], mark.start, 'cat', mark.end - mark.start)

      expect(typed.text).toBe(page)
      // The first keystroke, "c", leaves "c" marked. "a" and "t" are typed at its end.
      expect(typed.steps[0]?.[0]).toMatchObject({text: 'c', start: 4, end: 5, needsReview: false})
      expect(typed.marks[0]).toMatchObject({text: 'c', start: 4, end: 5, needsReview: false})
    })

    it('leaves only the first typed character marked when the replacement is different text', () => {
      const mark = markOn(page, 'cat')
      const typed = keystrokes(page, [mark], mark.start, 'dog', mark.end - mark.start)

      expect(typed.text).toBe('The dog sat on the mat.')
      expect(typed.marks[0]).toMatchObject({text: 'd', needsReview: false})
      // The rest of the typed text is outside the mark, so the check reports it.
      expect(
        checkUnmarkedChanges({baseText: page, draftText: typed.text, marks: saveMarksOf(typed.text, typed.marks)}),
      ).toBe('unmarked')
    })
  })
})

describe('typing over a selection that crosses the edge of a mark', () => {
  const lead = 'p'.repeat(212 - '\n\n\nAn extra sentence.\n\n\n'.length) + '\n\n\nAn extra sentence.\n\n\n'
  const page = `${lead}left right suffix.`

  it('replays the browser case: "right suff" selected inside "left right", then "replacement" typed', () => {
    expect(page.indexOf('left right')).toBe(212)
    const mark = created(page, 212, 222)
    expect(page.slice(217, 227)).toBe('right suff')

    const typed = keystrokes(page, [mark], 217, 'replacement', 10)

    expect(typed.text.slice(212)).toBe('left replacementix.')
    // The first typed character, "r", is also the first selected character. The browser says one
    // character was inserted at the caret, so the edit replaced the whole selection and only
    // "left " survives.
    for (const step of typed.steps) expect(step[0]).toMatchObject({text: 'left ', start: 212, end: 217, needsReview: true})
    expect(typed.marks[0]?.text).not.toContain('replacement')
    expect(typed.marks[0]?.text).not.toContain('r')
    expect(typed.marks[0]?.text).not.toContain('i')
  })

  // The typed text begins with the character the selection begins with, or ends with the one after it.
  const original = 'left right'
  const text = 'xx left right suffix.'
  const cases: readonly {
    readonly label: string
    readonly select: readonly [number, number]
    readonly typed: string
    /** What must survive of the mark's original text, as a prefix (right clip) or a suffix (left clip). */
    readonly survives: 'prefix' | 'suffix'
  }[] = [
    {label: 'same first character at a selection that starts inside the mark', select: [5, 15], typed: 'right again', survives: 'prefix'},
    {label: 'same first character, a longer run of the same letter', select: [5, 15], typed: 'rrrrright', survives: 'prefix'},
    {label: 'typed text that begins like the text after the selection', select: [5, 15], typed: 'iii', survives: 'prefix'},
    {label: 'typed text that ends like the text after the selection', select: [5, 15], typed: 'stuffi', survives: 'prefix'},
    {label: 'a selection that starts before the mark, same first character', select: [0, 8], typed: 'xx lines', survives: 'suffix'},
    {label: 'a selection that starts before the mark, ending like the mark', select: [0, 8], typed: 'xx left', survives: 'suffix'},
    {label: 'a selection that starts before the mark, ending like the text it keeps', select: [0, 8], typed: 'xx rt', survives: 'suffix'},
  ]

  it.each(cases)('keeps only surviving original text: $label', ({select, typed, survives}) => {
    const mark = markOn(text, original)
    const result = keystrokes(text, [mark], select[0], typed, select[1] - select[0])
    expect(result.text.startsWith(text.slice(0, select[0]) + typed)).toBe(true)

    for (const step of result.steps) {
      const kept = step[0]
      expect(kept?.needsReview).toBe(true)
      // Exactly the part of the original that lies outside the selection.
      const outside = survives === 'prefix' ? select[0] - mark.start : mark.end - select[1]
      expect(kept?.text.length).toBe(outside)
      expect(survives === 'prefix' ? original.startsWith(kept?.text ?? '?') : original.endsWith(kept?.text ?? '?')).toBe(true)
    }
    // And it does not change once it is clipped: later keystrokes leave its text alone.
    expect(new Set(result.steps.map(step => step[0]?.text)).size).toBe(1)
  })

  // Pages where a typed character repeats the text beside it, so the diff alone puts the edit in
  // the wrong place. Each fails if the browser's caret and inserted length are ignored.
  const ambiguous: readonly {
    readonly page: string
    readonly marked: string
    readonly at: number
    readonly select: readonly [number, number]
    readonly typed: string
    readonly survives: 'prefix' | 'suffix'
  }[] = [
    {page: 'aibbabaiii ab', marked: 'ibba', at: 1, select: [3, 6], typed: 'b ai ', survives: 'prefix'},
    {page: 'iaibaiabiii  ', marked: 'iaibaiabi', at: 0, select: [1, 10], typed: 'aab i', survives: 'prefix'},
    {page: 'ib bbaia ia', marked: 'baia', at: 4, select: [5, 9], typed: 'abaiiab', survives: 'prefix'},
    {page: 'ii ibaaba abb', marked: 'ibaab', at: 3, select: [5, 10], typed: 'ai bb', survives: 'prefix'},
    {page: 'i a aaaa  ', marked: 'a ', at: 2, select: [0, 3], typed: 'ab a aa', survives: 'suffix'},
    {page: 'ba aaaaaaiaibba', marked: 'aaa', at: 5, select: [2, 7], typed: 'abaabbb', survives: 'suffix'},
    {page: 'bb aii abi ', marked: 'abi', at: 7, select: [6, 9], typed: 'bibb', survives: 'suffix'},
    {page: 'aaa ibib i ', marked: 'bib ', at: 5, select: [2, 6], typed: 'bai ', survives: 'suffix'},
  ]

  it.each(ambiguous)('keeps only surviving original text when the diff is ambiguous: $page', row => {
    expect(row.page.slice(row.at, row.at + row.marked.length)).toBe(row.marked)
    const mark = created(row.page, row.at, row.at + row.marked.length)
    const result = keystrokes(row.page, [mark], row.select[0], row.typed, row.select[1] - row.select[0])

    const outside = row.survives === 'prefix' ? row.select[0] - mark.start : mark.end - row.select[1]
    for (const step of result.steps) {
      expect(step[0]?.needsReview).toBe(true)
      expect(step[0]?.text.length).toBe(outside)
      expect(row.survives === 'prefix' ? row.marked.startsWith(step[0]?.text ?? '?') : row.marked.endsWith(step[0]?.text ?? '?')).toBe(true)
    }
    expect(new Set(result.steps.map(step => step[0]?.text)).size).toBe(1)
  })

  it('falls back to the diff when the hint does not describe the edit', () => {
    const text = 'The cat sat on the mat.'
    const mark = markOn(text, 'cat')
    const next = `Intro. ${text}`
    // A caret that does not match the text, as after an undo or a drop, is ignored.
    expect(rebaseMarks([mark], text, next, {caret: 3, inserted: 1})).toEqual(rebaseMarks([mark], text, next))
    expect(rebaseMarks([mark], text, next, {caret: 9999, inserted: 1})).toEqual(rebaseMarks([mark], text, next))
    expect(rebaseMarks([mark], text, next, {caret: 7})).toEqual(rebaseMarks([mark], text, next))
  })
})
