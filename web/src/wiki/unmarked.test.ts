import {describe, expect, it} from 'vitest'
import {hasUnmarkedChanges} from './unmarked.ts'

describe('hasUnmarkedChanges', () => {
  it('an unchanged draft has no unmarked changes', () => {
    expect(hasUnmarkedChanges({baseText: 'Alpha.\n', draftText: 'Alpha.\n'})).toBe(false)
  })

  it('a changed draft is unmarked: until marking exists, every change is', () => {
    expect(hasUnmarkedChanges({baseText: 'Alpha.\n', draftText: 'Alpha, changed.\n'})).toBe(true)
  })

  it.each([
    ['a trailing newline', 'Alpha.', 'Alpha.\n'],
    ['whitespace only', 'Alpha. Beta.', 'Alpha.  Beta.'],
    ['case only', 'Alpha.', 'alpha.'],
    ['an emptied draft', 'Alpha.', ''],
  ])('%s is a change', (_label, baseText, draftText) => {
    expect(hasUnmarkedChanges({baseText, draftText})).toBe(true)
  })

  it('compares text exactly, with no normalization', () => {
    expect(hasUnmarkedChanges({baseText: 'a\r\nb', draftText: 'a\nb'})).toBe(true)
  })
})
