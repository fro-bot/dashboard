import {cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'
import type {MergeOutput} from '../wiki/merge.ts'
import {WikiMerge} from './WikiMerge.tsx'

afterEach(cleanup)

const BASE = '1\nx\n2\ny\n3\nz\n4\n'
const MINE = '1\nmx\n2\nmy\n3\nz\n4\n'
const THEIRS = '1\ntx\n2\nty\n3\nz\nT4\n'

function renderMerge(props: Partial<React.ComponentProps<typeof WikiMerge>> = {}) {
  const onUse = vi.fn<(output: MergeOutput) => void>()
  render(<WikiMerge mine={MINE} base={BASE} theirs={THEIRS} busy={false} onUse={onUse} {...props} />)
  return {onUse}
}

const hunks = () => screen.queryAllByTestId('wiki-merge-hunk')
const status = () => screen.getByTestId('wiki-merge-status')
const useMerged = () => screen.getByRole('button', {name: 'Use merged text'})

function acceptIn(index: number, choice: 'mine' | 'theirs') {
  const hunk = hunks()[index] as HTMLElement
  fireEvent.click(within(hunk).getByRole('button', {name: choice === 'mine' ? 'Accept mine' : 'Accept theirs'}))
}

describe('WikiMerge — hunks', () => {
  it('gives each overlapping change a heading with both versions as plain text', () => {
    renderMerge()

    expect(hunks()).toHaveLength(2)
    const first = hunks()[0] as HTMLElement
    expect(within(first).getByRole('heading', {name: 'Change 1 of 2'})).toBeInTheDocument()
    expect(within(first).getByTestId('wiki-merge-mine').textContent).toBe('mx\n')
    expect(within(first).getByTestId('wiki-merge-mine').tagName).toBe('PRE')
    expect(within(first).getByTestId('wiki-merge-theirs').textContent).toBe('tx\n')
    expect(within(hunks()[1] as HTMLElement).getByRole('heading', {name: 'Change 2 of 2'})).toBeInTheDocument()
  })

  it('shows both versions as text, never as markup', () => {
    renderMerge({mine: 'a\n<img src=x onerror=alert(1)>\nc\n', base: 'a\nb\nc\n', theirs: 'a\n<script>alert(2)</script>\nc\n'})
    expect(document.querySelector('img, script')).toBeNull()
    expect(screen.getByTestId('wiki-merge-theirs').textContent).toBe('<script>alert(2)</script>\n')
  })

  it('says so when a version removes the lines', () => {
    renderMerge({mine: 'a\nc\n', base: 'a\nb\nc\n', theirs: 'a\nB\nc\n'})
    expect(within(screen.getByTestId('wiki-merge-mine-block')).getByText('This version removes these lines.')).toBeInTheDocument()
    expect(screen.getByTestId('wiki-merge-theirs').textContent).toBe('B\n')
  })

  it('offers native buttons for the two choices, reachable by Tab', () => {
    renderMerge()
    for (const hunk of hunks()) {
      for (const name of ['Accept mine', 'Accept theirs']) {
        const choice = within(hunk).getByRole('button', {name})
        expect(choice.tagName).toBe('BUTTON')
        expect(choice).toHaveAttribute('type', 'button')
        expect(choice).not.toHaveAttribute('tabindex')
        expect(choice).toBeEnabled()
      }
    }
  })

  it('marks the chosen version on the hunk and on its button', () => {
    renderMerge()
    const hunk = hunks()[0] as HTMLElement
    expect(hunk).toHaveAttribute('data-resolution', 'unresolved')

    acceptIn(0, 'mine')

    expect(hunk).toHaveAttribute('data-resolution', 'mine')
    expect(within(hunk).getByRole('button', {name: 'Accept mine'})).toHaveAttribute('aria-pressed', 'true')
    expect(within(hunk).getByRole('button', {name: 'Accept theirs'})).toHaveAttribute('aria-pressed', 'false')
    expect(hunks()[1]).toHaveAttribute('data-resolution', 'unresolved')

    acceptIn(0, 'theirs')
    expect(hunk).toHaveAttribute('data-resolution', 'theirs')
  })
})

describe('WikiMerge — announcements and focus', () => {
  it('announces each resolution in one polite status region', () => {
    renderMerge()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(status()).toHaveAttribute('aria-live', 'polite')
    expect(status().textContent).toBe('')

    acceptIn(1, 'mine')
    expect(status().textContent).toBe('Change 2 of 2: kept yours')

    acceptIn(0, 'theirs')
    expect(status().textContent).toBe('Change 1 of 2: took theirs. All changes are resolved.')
  })

  it('announces a change of mind, and does not announce the same choice again', () => {
    renderMerge()
    acceptIn(0, 'mine')
    const observer = new MutationObserver(() => {})
    observer.observe(status(), {childList: true, characterData: true, subtree: true})

    acceptIn(0, 'mine')
    expect(observer.takeRecords()).toHaveLength(0)

    acceptIn(0, 'theirs')
    expect(status().textContent).toBe('Change 1 of 2: took theirs')
    observer.disconnect()
  })

  it('never moves focus', () => {
    renderMerge()
    const accept = within(hunks()[0] as HTMLElement).getByRole('button', {name: 'Accept mine'})
    accept.focus()
    expect(document.activeElement).toBe(accept)

    fireEvent.click(accept)
    expect(document.activeElement).toBe(accept)

    acceptIn(1, 'theirs')
    expect(document.activeElement).toBe(accept)
  })

  it('reaches every control in document order', () => {
    renderMerge()
    const names = Array.from(document.querySelectorAll<HTMLElement>('button')).map(element => element.textContent)
    expect(names).toEqual(['Accept mine', 'Accept theirs', 'Accept mine', 'Accept theirs', 'Use merged text'])
  })
})

describe('WikiMerge — using the merged text', () => {
  it('waits for every change to be resolved', () => {
    const {onUse} = renderMerge()
    expect(useMerged()).toBeDisabled()
    expect(screen.getByTestId('wiki-merge-progress')).toHaveTextContent('0 of 2 resolved')

    acceptIn(0, 'mine')
    expect(useMerged()).toBeDisabled()
    expect(screen.getByTestId('wiki-merge-progress')).toHaveTextContent('1 of 2 resolved')

    acceptIn(1, 'theirs')
    expect(useMerged()).toBeEnabled()
    expect(screen.getByTestId('wiki-merge-progress')).toHaveTextContent('2 of 2 resolved')
    expect(onUse).not.toHaveBeenCalled()
  })

  it('hands over the text built from the choices, with its stretches', () => {
    const {onUse} = renderMerge()
    acceptIn(0, 'mine')
    acceptIn(1, 'theirs')
    fireEvent.click(useMerged())

    expect(onUse).toHaveBeenCalledTimes(1)
    const output = onUse.mock.calls[0]?.[0] as MergeOutput
    expect(output.text).toBe('1\nmx\n2\nty\n3\nz\nT4\n')
    expect(output.stretches.map(stretch => stretch.source)).toEqual(['base', 'mine', 'base', 'theirs', 'base', 'theirs'])
  })

  it('uses the choice made last', () => {
    const {onUse} = renderMerge()
    acceptIn(0, 'mine')
    acceptIn(0, 'theirs')
    acceptIn(1, 'theirs')
    fireEvent.click(useMerged())
    expect((onUse.mock.calls[0]?.[0] as MergeOutput).text).toBe('1\ntx\n2\nty\n3\nz\nT4\n')
  })

  it('cannot be used while busy, even with every change resolved', () => {
    const onUse = vi.fn<(output: MergeOutput) => void>()
    const props = {mine: MINE, base: BASE, theirs: THEIRS, onUse}
    const view = render(<WikiMerge {...props} busy={false} />)
    acceptIn(0, 'mine')
    acceptIn(1, 'theirs')
    expect(useMerged()).toBeEnabled()

    view.rerender(<WikiMerge {...props} busy />)

    expect(useMerged()).toBeDisabled()
    fireEvent.click(useMerged())
    expect(onUse).not.toHaveBeenCalled()
    expect(within(hunks()[0] as HTMLElement).getByRole('button', {name: 'Accept mine'})).toBeDisabled()
    expect(within(hunks()[1] as HTMLElement).getByRole('button', {name: 'Accept theirs'})).toBeDisabled()

    view.rerender(<WikiMerge {...props} busy={false} />)
    expect(useMerged()).toBeEnabled()
  })
})

describe('WikiMerge — a page too large to compare line by line', () => {
  const BLANKS = '\n'.repeat(2000)

  it('offers the whole page as one change, and says why', () => {
    const {onUse} = renderMerge({mine: `${BLANKS}mine\n`, base: BLANKS, theirs: `${BLANKS}theirs\n`})

    expect(screen.getByTestId('wiki-merge')).toHaveAttribute('data-coarse', 'true')
    expect(screen.getByTestId('wiki-merge-summary')).toHaveTextContent(/too large to compare line by line/iu)
    expect(hunks()).toHaveLength(1)
    expect(within(hunks()[0] as HTMLElement).getByRole('heading', {name: 'Change 1 of 1'})).toBeInTheDocument()

    acceptIn(0, 'theirs')
    fireEvent.click(useMerged())
    expect((onUse.mock.calls[0]?.[0] as MergeOutput).text).toBe(`${BLANKS}theirs\n`)
  })

  it('does not say so for an ordinary page', () => {
    renderMerge()
    expect(screen.getByTestId('wiki-merge')).toHaveAttribute('data-coarse', 'false')
    expect(screen.getByTestId('wiki-merge-summary')).not.toHaveTextContent(/too large/iu)
  })
})

describe('WikiMerge — nothing to resolve', () => {
  it('still shows the merge, with no changes to resolve, and applies in one step', () => {
    const {onUse} = renderMerge({mine: 'A\nb\nc\n', base: 'a\nb\nc\n', theirs: 'a\nb\nC\n'})

    expect(screen.getByTestId('wiki-merge')).toHaveAttribute('data-hunks', '0')
    expect(hunks()).toHaveLength(0)
    expect(screen.getByTestId('wiki-merge-summary')).toHaveTextContent('There is nothing to resolve.')
    expect(screen.queryByTestId('wiki-merge-progress')).toBeNull()
    expect(useMerged()).toBeEnabled()

    fireEvent.click(useMerged())
    expect((onUse.mock.calls[0]?.[0] as MergeOutput).text).toBe('A\nb\nC\n')
  })

  it('takes the current version when the draft did not change from its base', () => {
    const {onUse} = renderMerge({mine: BASE, base: BASE, theirs: THEIRS})
    expect(hunks()).toHaveLength(0)
    fireEvent.click(useMerged())
    expect((onUse.mock.calls[0]?.[0] as MergeOutput).text).toBe(THEIRS)
  })
})
