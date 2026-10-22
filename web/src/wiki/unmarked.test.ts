import {describe, expect, it} from 'vitest'
import type {SaveMark} from '../api/wiki.ts'
import {
  checkUnmarkedChanges,
  MAX_DIFF_AREA,
  MAX_LINE_WORK,
  MAX_TOTAL_DIFF_AREA,
  type UnmarkedInput,
} from './unmarked.ts'

/** True when the draft holds a change outside every mark. The unavailable result is its own tests'. */
function hasUnmarkedChanges(input: UnmarkedInput): boolean {
  const result = checkUnmarkedChanges(input)
  if (result === 'unavailable') throw new Error('test setup: detection was unavailable')
  return result === 'unmarked'
}

/** A mark on the first occurrence of `text` in `draft`, with UTF-16 offsets as the editor sends them. */
function markOf(draft: string, text: string, from = 0): SaveMark {
  const start = draft.indexOf(text, from)
  if (start < 0) throw new Error(`test setup: ${JSON.stringify(text)} is not in the draft`)
  return {text, start, end: start + text.length}
}

interface Row {
  readonly label: string
  readonly base: string
  readonly draft: string
  /** Texts to mark in the draft, in order. A repeated text marks its next occurrence. */
  readonly marked: readonly string[]
  readonly unmarked: boolean
}

function marksFor(row: Row): SaveMark[] {
  const marks: SaveMark[] = []
  let from = 0
  for (const text of row.marked) {
    const mark = markOf(row.draft, text, from)
    marks.push(mark)
    from = mark.end
  }
  return marks
}

const ROWS: readonly Row[] = [
  // Nothing changed.
  {label: 'an unchanged draft', base: 'Alpha.\n', draft: 'Alpha.\n', marked: [], unmarked: false},

  // With no marks every change is unmarked, exactly as before marking existed.
  {label: 'a changed draft with no marks', base: 'Alpha.\n', draft: 'Alpha, changed.\n', marked: [], unmarked: true},
  {label: 'a trailing newline with no marks', base: 'Alpha.', draft: 'Alpha.\n', marked: [], unmarked: true},
  {label: 'whitespace only with no marks', base: 'Alpha. Beta.', draft: 'Alpha.  Beta.', marked: [], unmarked: true},
  {label: 'case only with no marks', base: 'Alpha.', draft: 'alpha.', marked: [], unmarked: true},
  {label: 'an emptied draft with no marks', base: 'Alpha.', draft: '', marked: [], unmarked: true},
  {label: 'a CRLF to LF change with no marks', base: 'a\r\nb', draft: 'a\nb', marked: [], unmarked: true},
  {label: 'moved lines with no marks', base: 'A\nB\n', draft: 'B\nA\n', marked: [], unmarked: true},

  // A change inside a marked span is marked.
  {
    label: 'a word replaced inside a marked span',
    base: 'Alpha builds widgets.\n',
    draft: 'Alpha builds gadgets.\n',
    marked: ['gadgets'],
    unmarked: false,
  },
  {
    label: 'two adjacent words replaced inside one marked span',
    base: 'The quick brown fox.\n',
    draft: 'The slow red fox.\n',
    marked: ['slow red'],
    unmarked: false,
  },
  {
    label: 'a changed range that fills the whole marked span',
    base: 'Alpha builds widgets.\n',
    draft: 'Alpha builds gadgets.\n',
    marked: ['Alpha builds gadgets.'],
    unmarked: false,
  },

  // A change outside every marked span is unmarked.
  {
    label: 'a change outside the only marked span',
    base: 'Alpha builds widgets.\n',
    draft: 'Omega builds gadgets.\n',
    marked: ['gadgets'],
    unmarked: true,
  },
  {
    label: 'a changed word that is only partly inside the marked span',
    base: 'Alpha builds widgets.\n',
    draft: 'Alpha builds gadgets.\n',
    marked: ['gad'],
    unmarked: true,
  },
  {
    label: 'one changed range inside a span and one outside',
    base: 'one two three\n',
    draft: 'ONE two THREE\n',
    marked: ['THREE'],
    unmarked: true,
  },
  {
    label: 'every scattered edit marked',
    base: 'a one\nb two\nc three\nd four\n',
    draft: 'a ONE\nb two\nc THREE\nd four\n',
    marked: ['ONE', 'THREE'],
    unmarked: false,
  },
  {
    label: 'one of several scattered edits unmarked',
    base: 'a one\nb two\nc three\nd four\n',
    draft: 'a ONE\nb TWO\nc THREE\nd four\n',
    marked: ['ONE', 'THREE'],
    unmarked: true,
  },
  {
    label: 'a changed range covered by two adjacent marks',
    base: 'abc\n',
    draft: 'xyz\n',
    marked: ['xy', 'z'],
    unmarked: false, // the newline is unchanged; the range 'xyz' is covered by the union of the marks
  },

  // Insertions.
  {
    label: 'an inserted line that a mark covers, newline included',
    base: 'A\nB\n',
    draft: 'A\nNew line\nB\n',
    marked: ['New line\n'],
    unmarked: false,
  },
  {
    label: 'an inserted line whose newline falls outside the mark',
    base: 'A\nB\n',
    draft: 'A\nNew line\nB\n',
    marked: ['New line'],
    unmarked: true,
  },
  {
    label: 'text added to an empty page, all of it marked',
    base: '',
    draft: 'New\n',
    marked: ['New\n'],
    unmarked: false,
  },
  {label: 'a trailing newline that a mark covers', base: 'Alpha.', draft: 'Alpha.\n', marked: ['.\n'], unmarked: false},

  // Deletions need a mark on the surrounding text.
  {
    label: 'a deletion inside a marked span',
    base: 'Alpha builds old widgets.\n',
    draft: 'Alpha builds widgets.\n',
    marked: ['builds widgets'],
    unmarked: false,
  },
  {
    label: 'a deletion with a mark that only touches the gap, on the word before it',
    base: 'Alpha builds old widgets.\n',
    draft: 'Alpha builds widgets.\n',
    marked: ['builds'],
    unmarked: true,
  },
  {
    label: 'a deletion with a mark that only touches the gap, on the word after it',
    base: 'Alpha builds old widgets.\n',
    draft: 'Alpha builds widgets.\n',
    marked: ['widgets'],
    unmarked: true,
  },
  {
    label: 'a deletion with marked text on both sides of the gap',
    base: 'Alpha builds old widgets.\n',
    draft: 'Alpha builds widgets.\n',
    marked: ['Alpha builds widgets.'],
    unmarked: false,
  },
  {
    label: 'a long clause deleted after a mark on one word',
    base: 'Paris is the capital of France, a city of art, food and long history. Beta ships.\n',
    draft: 'Paris. Beta ships.\n',
    marked: ['Paris'],
    unmarked: true,
  },
  {
    label: 'a long clause deleted inside a mark that spans the gap',
    base: 'Paris is the capital of France, a city of art, food and long history. Beta ships.\n',
    draft: 'Paris. Beta ships.\n',
    marked: ['Paris. Beta'],
    unmarked: false,
  },
  {
    label: 'a deleted space with no mark',
    base: 'Alpha.  Beta.\n',
    draft: 'Alpha. Beta.\n',
    marked: [],
    unmarked: true,
  },
  {
    label: 'a deleted space beside a marked word that only touches the gap',
    base: 'Alpha.  Beta.\n',
    draft: 'Alpha. Beta.\n',
    marked: ['Beta.'],
    unmarked: true,
  },
  {
    label: 'a deleted space inside a mark that spans it',
    base: 'Alpha.  Beta.\n',
    draft: 'Alpha. Beta.\n',
    marked: ['Alpha. Beta.'],
    unmarked: false,
  },
  {
    label: 'a deleted space far from the only mark',
    base: 'Alpha.  Beta. Gamma delta.\n',
    draft: 'Alpha. Beta. Gamma delta.\n',
    marked: ['delta.'],
    unmarked: true,
  },
  {
    label: 'a space added inside a marked span',
    base: 'one two three\n',
    draft: 'one  two three\n',
    marked: ['one  two'],
    unmarked: false,
  },
  {
    label: 'a deletion with no mark',
    base: 'Alpha builds old widgets.\n',
    draft: 'Alpha builds widgets.\n',
    marked: [],
    unmarked: true,
  },
  {
    label: 'a deletion far from the only mark',
    base: 'Alpha builds old widgets. Beta ships.\n',
    draft: 'Alpha builds widgets. Beta ships.\n',
    marked: ['Beta ships.'],
    unmarked: true,
  },
  {
    label: 'a deleted line with a mark only on the line after it',
    base: 'A\nB\nC\n',
    draft: 'A\nC\n',
    marked: ['C'],
    unmarked: true,
  },
  {
    label: 'a deleted line with a mark only on the line before it',
    base: 'A\nB\nC\n',
    draft: 'A\nC\n',
    marked: ['A\n'],
    unmarked: true,
  },
  {
    label: 'a deleted line with one mark across the lines on both sides of it',
    base: 'A\nB\nC\n',
    draft: 'A\nC\n',
    marked: ['A\nC'],
    unmarked: false,
  },
  {
    label: 'a deleted line with the only mark on a line that is not next to it',
    base: 'A\nB\nC\nD\n',
    draft: 'A\nC\nD\n',
    marked: ['D'],
    unmarked: true,
  },
  {
    label: 'every line deleted, with no mark',
    base: 'A\nB\n',
    draft: '',
    marked: [],
    unmarked: true,
  },

  // Text that is not plain ASCII.
  {
    label: 'a changed emoji inside a marked span',
    base: 'x 👍 y\n',
    draft: 'x 👎 y\n',
    marked: ['👎'],
    unmarked: false,
  },
  {
    label: 'a changed emoji outside the marked span',
    base: 'x 👍 y\n',
    draft: 'x 👎 z\n',
    marked: ['z'],
    unmarked: true,
  },
  {
    label: 'a combining character changed inside a marked word',
    base: 'cafe\u0301 au lait\n',
    draft: 'cafe\u0300 au lait\n',
    marked: ['cafe\u0300'],
    unmarked: false,
  },
  {
    label: 'a combining character changed with the mark ending before it',
    base: 'cafe\u0301 au lait\n',
    draft: 'cafe\u0300 au lait\n',
    marked: ['caf'],
    unmarked: true,
  },
  {
    label: 'an astral-plane word inside a marked span',
    base: 'name: 𝒜lpha\n',
    draft: 'name: 𝒜mega\n',
    marked: ['𝒜mega'],
    unmarked: false,
  },

  // Line endings.
  {
    label: 'a CRLF line edited inside a marked span',
    base: 'a\r\nb\r\n',
    draft: 'a\r\nB\r\n',
    marked: ['B'],
    unmarked: false,
  },
]

describe('hasUnmarkedChanges', () => {
  it.each(ROWS)('$label', row => {
    expect(hasUnmarkedChanges({baseText: row.base, draftText: row.draft, marks: marksFor(row)})).toBe(row.unmarked)
  })

  it('treats a missing marks list as no marks', () => {
    expect(hasUnmarkedChanges({baseText: 'Alpha.\n', draftText: 'Beta.\n'})).toBe(true)
  })

  it('compares text exactly, with no normalization', () => {
    expect(hasUnmarkedChanges({baseText: 'a\r\nb', draftText: 'a\nb', marks: []})).toBe(true)
  })

  it('ignores marks when the draft is unchanged', () => {
    const draft = 'Alpha builds widgets.\n'
    expect(hasUnmarkedChanges({baseText: draft, draftText: draft, marks: [markOf(draft, 'widgets')]})).toBe(false)
  })

  it('leaves its input alone', () => {
    const marks: readonly SaveMark[] = Object.freeze([Object.freeze(markOf('x 👎 y\n', '👎'))])
    expect(() => hasUnmarkedChanges({baseText: 'x 👍 y\n', draftText: 'x 👎 y\n', marks})).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// The block-size guard
// ---------------------------------------------------------------------------

/** Distinct words, so a diff of them is cheap and only the guard decides. */
const wordsText = (count: number, edit?: number): string =>
  Array.from({length: count}, (_unused, index) => (index === edit ? 'EDITED' : `w${String(index)}`)).join(' ')

// Words of five or six characters each, so this line is about 1.4 times the side of the threshold.
const WIDE = Math.ceil(Math.sqrt(MAX_DIFF_AREA) / 4)

describe('checkUnmarkedChanges', () => {
  it('answers marked when nothing changed, or every change is marked', () => {
    expect(checkUnmarkedChanges({baseText: 'a\n', draftText: 'a\n'})).toBe('marked')
    expect(checkUnmarkedChanges({baseText: 'a b\n', draftText: 'a B\n', marks: [markOf('a B\n', 'B')]})).toBe('marked')
  })

  it('answers unmarked when a change is outside the marks', () => {
    expect(checkUnmarkedChanges({baseText: 'a b\n', draftText: 'A b\n', marks: [markOf('A b\n', 'b')]})).toBe('unmarked')
  })
})

describe('the block-size guard', () => {
  it('says unavailable for a single line too wide to compare, without comparing it', () => {
    const baseText = wordsText(WIDE)
    const draftText = wordsText(WIDE, 3)
    expect(checkUnmarkedChanges({baseText, draftText, marks: [markOf(draftText, 'EDITED')]})).toBe('unavailable')
  })

  it('compares a line just under the threshold', () => {
    const count = Math.floor(Math.sqrt(MAX_DIFF_AREA) / 8) // about 8 characters a word, well under
    const baseText = wordsText(count)
    const draftText = wordsText(count, 3)
    expect(checkUnmarkedChanges({baseText, draftText, marks: [markOf(draftText, 'EDITED')]})).toBe('marked')
    expect(checkUnmarkedChanges({baseText, draftText, marks: [markOf(draftText, 'w10')]})).toBe('unmarked')
  })

  it('says unavailable for a block of lines too large when the line counts differ', () => {
    const lines = Array.from({length: 300}, (_unused, index) => `${wordsText(70)} line${String(index)}`)
    const baseText = `${lines.join('\n')}\n`
    const draftLines = lines.map(line => line.replace('w1 ', 'EDITED '))
    draftLines.splice(5, 0, 'an extra line')
    const draftText = `${draftLines.join('\n')}\n`

    expect(baseText.length).toBeGreaterThan(Math.sqrt(MAX_DIFF_AREA))
    expect(checkUnmarkedChanges({baseText, draftText, marks: [{text: draftText, start: 0, end: draftText.length}]})).toBe(
      'unavailable',
    )
  })

  it('does not trip on the same run of edited lines when the line counts are equal, because lines compare in pairs', () => {
    const lines = Array.from({length: 300}, (_unused, index) => `${wordsText(70)} line${String(index)}`)
    const baseText = `${lines.join('\n')}\n`
    const draftText = `${lines.map(line => line.replace('w1 ', 'EDITED ')).join('\n')}\n`

    expect(checkUnmarkedChanges({baseText, draftText, marks: [{text: draftText, start: 0, end: draftText.length}]})).toBe(
      'marked',
    )
  })

  it('trips on one oversize change among small ones anywhere in the draft', () => {
    const small = Array.from({length: 40}, (_unused, index) => `line ${String(index)}`)
    const baseText = `${[...small, wordsText(WIDE), ...small].join('\n')}\n`
    const draftText = `${[...small, wordsText(WIDE, 2), ...small].join('\n')}\n`

    expect(checkUnmarkedChanges({baseText, draftText, marks: [{text: draftText, start: 0, end: draftText.length}]})).toBe(
      'unavailable',
    )
  })

  it('is not about size alone: a large text with a small change is compared', () => {
    const big = Array.from({length: 20_000}, (_unused, index) => `row ${String(index)}`)
    const baseText = `${big.join('\n')}\n`
    const edited = [...big]
    edited[10_000] = 'row EDITED'
    const draftText = `${edited.join('\n')}\n`

    expect(checkUnmarkedChanges({baseText, draftText, marks: [markOf(draftText, 'EDITED')]})).toBe('marked')
  })

  it('does not call a large change unavailable when nothing is marked: every change is unmarked then', () => {
    const baseText = wordsText(WIDE)
    const draftText = wordsText(WIDE, 3)
    expect(checkUnmarkedChanges({baseText, draftText, marks: []})).toBe('unmarked')
    expect(checkUnmarkedChanges({baseText, draftText})).toBe('unmarked')
  })

  it('compares a large block that is only added or only removed, since nothing is matched against it', () => {
    const added = wordsText(WIDE)
    expect(checkUnmarkedChanges({baseText: '', draftText: added, marks: [{text: added, start: 0, end: added.length}]})).toBe('marked')
    expect(checkUnmarkedChanges({baseText: added, draftText: '', marks: [{text: 'x', start: 0, end: 1}]})).toBe('unmarked')
  })
})

describe('the line-work budget', () => {
  /** Lines of distinct prose, with a blank line after every `content` lines. */
  const paragraphPage = (count: number, content = 3): string[] =>
    Array.from({length: count}, (_unused, index) =>
      index % (content + 1) === content ? '' : `paragraph line ${String(index)} with some ordinary prose words in it`,
    )
  /** `count` lines of distinct text, with every `blankEvery`th line blank. */
  const pageWithBlanks = (count: number, blankEvery: number): string[] =>
    Array.from({length: count}, (_unused, index) => (index % blankEvery === 0 ? '' : `line ${String(index)} of the page`))
  const joined = (lines: readonly string[]): string => `${lines.join('\n')}\n`
  const wholeMark = (text: string) => [{text, start: 0, end: text.length}]
  const edited = (lines: readonly string[]): string[] => lines.map((line, index) => (index === 11 ? 'EDITED' : line))
  const check = (lines: readonly string[]) => {
    const draftText = joined(edited(lines))
    return checkUnmarkedChanges({baseText: joined(lines), draftText, marks: wholeMark(draftText)})
  }

  /** Matching pairs times lines, the work the line diff does. */
  function lineWork(lines: readonly string[]): number {
    const counts = new Map<string, number>()
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
    let pairs = 0
    for (const count of counts.values()) pairs += count * count
    return pairs * lines.length
  }

  it.each([999, 1599])('compares a %i-line paragraph page with a blank line after every three content lines', count => {
    const lines = paragraphPage(count)
    expect(lineWork(lines)).toBeLessThan(MAX_LINE_WORK)
    expect(check(lines)).toBe('marked')
  })

  it('says unavailable for a 3,199-line paragraph page, before the line diff', () => {
    const lines = paragraphPage(3199)
    expect(lineWork(lines)).toBeGreaterThan(MAX_LINE_WORK)
    expect(check(lines)).toBe('unavailable')
  })

  it('says unavailable for a page of 35,000 unique short lines, which have few pairs but many lines', () => {
    const lines = Array.from({length: 35_000}, (_unused, index) => `row ${String(index)}`)
    expect(lineWork(lines)).toBeGreaterThan(MAX_LINE_WORK)
    expect(check(lines)).toBe('unavailable')
  })

  it('says unavailable for a page dense with blank lines', () => {
    const lines = pageWithBlanks(3000, 3)
    expect(lineWork(lines)).toBeGreaterThan(MAX_LINE_WORK)
    expect(check(lines)).toBe('unavailable')
  })

  it('counts repeated non-blank lines the same way', () => {
    const lines = Array.from({length: 3000}, (_unused, index) => (index % 2 === 0 ? '---' : `row ${String(index)}`))
    expect(lineWork(lines)).toBeGreaterThan(MAX_LINE_WORK)
    expect(check(lines)).toBe('unavailable')
  })

  it('compares a small page however dense its blank lines are', () => {
    expect(check(pageWithBlanks(150, 3))).toBe('marked')
  })

  it('does not trip on a long page of distinct lines', () => {
    const lines = Array.from({length: 8000}, (_unused, index) => `row ${String(index)}`)
    expect(check(lines)).toBe('marked')
  })

  it('uses the larger of the two line counts', () => {
    // 30,000 shared lines: 30,000 pairs. Times the larger count (35,000) is over the budget; times the smaller is not.
    const base = Array.from({length: 35_000}, (_unused, index) => `row ${String(index)}`)
    const draft = base.slice(0, 30_000)
    draft[11] = 'EDITED'
    const draftText = joined(draft)
    expect(30_000 * 30_000).toBeLessThan(MAX_LINE_WORK)
    expect(30_000 * 35_000).toBeGreaterThan(MAX_LINE_WORK)
    expect(checkUnmarkedChanges({baseText: joined(base), draftText, marks: wholeMark(draftText)})).toBe('unavailable')
  })

  it('does not size anything when nothing is marked', () => {
    const lines = pageWithBlanks(3000, 3)
    expect(checkUnmarkedChanges({baseText: joined(lines), draftText: joined(edited(lines)), marks: []})).toBe('unmarked')
  })
})

describe('the total-area budget', () => {
  /** A changed block of `lines` lines whose draft has one more line, so it is compared as one block. */
  function pageWithBlocks(blocks: number, lines: number): {baseText: string; draftText: string} {
    const base: string[] = []
    const draft: string[] = []
    for (let block = 0; block < blocks; block += 1) {
      const body = Array.from({length: lines}, (_unused, index) => `block ${String(block)} line ${String(index)} with some words in it`)
      base.push(`separator ${String(block)} a`, `separator ${String(block)} b`, ...body)
      draft.push(`separator ${String(block)} a`, `separator ${String(block)} b`, ...body.map(line => `${line} EDITED`), 'one more line')
    }
    return {baseText: `${base.join('\n')}\n`, draftText: `${draft.join('\n')}\n`}
  }

  it('says unavailable when many blocks each under the per-block limit add up to more than the total budget', () => {
    const {baseText, draftText} = pageWithBlocks(3, 300)
    const side = baseText.length / 3
    expect(side * side).toBeLessThan(MAX_DIFF_AREA)
    expect(3 * side * side).toBeGreaterThan(MAX_TOTAL_DIFF_AREA)

    expect(checkUnmarkedChanges({baseText, draftText, marks: [{text: draftText, start: 0, end: draftText.length}]})).toBe(
      'unavailable',
    )
  })

  it('compares the same blocks when they fit the total budget', () => {
    const {baseText, draftText} = pageWithBlocks(1, 300)
    expect(checkUnmarkedChanges({baseText, draftText, marks: [{text: draftText, start: 0, end: draftText.length}]})).toBe(
      'marked',
    )
  })
})
