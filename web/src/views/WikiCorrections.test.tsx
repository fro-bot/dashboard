import {cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'
import type {CorrectionStatus, WikiCorrection} from '../api/wiki.ts'
import type {Mark, MarkState} from '../wiki/marks.ts'
import type {StagedAction} from '../wiki/staged.ts'
import {WikiCorrections, type WikiCorrectionsProps} from './WikiCorrections.tsx'

afterEach(cleanup)

function correction(id: string, status: CorrectionStatus = 'active', overrides: Partial<WikiCorrection> = {}): WikiCorrection {
  return {
    id,
    status,
    span: {text: `span of ${id}`},
    attribution: null,
    reason: null,
    supersededBy: null,
    stale: false,
    ...overrides,
  }
}

function markRow(id: string, state: MarkState = 'ok', text = `marked ${id}`): {mark: Mark; state: MarkState} {
  return {mark: {id, start: 0, end: text.length, text, prefix: '', suffix: '', needsReview: state === 'review'}, state}
}

function renderPanel(overrides: Partial<WikiCorrectionsProps> = {}) {
  const props: WikiCorrectionsProps = {
    corrections: [],
    staged: [],
    marks: [],
    actions: true,
    droppedNotice: null,
    onStage: vi.fn(),
    onUndo: vi.fn(),
    onJumpToMark: vi.fn(),
    onKeepMark: vi.fn(),
    onRemoveMark: vi.fn(),
    ...overrides,
  }
  render(<WikiCorrections {...props} />)
  return props
}

const item = (id: string) => {
  const found = document.querySelector<HTMLElement>(`[data-correction-id="${id}"]`)
  if (found === null) throw new Error(`no correction ${id}`)
  return found
}

describe('the corrections list', () => {
  it('shows an empty state for a page with no corrections', () => {
    renderPanel()
    expect(screen.getByTestId('wiki-corrections')).toHaveTextContent('No corrections recorded for this page.')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('lists each correction with its status, text, reason, attribution and replacement', () => {
    renderPanel({
      corrections: [
        correction('c1', 'active', {
          reason: 'Was wrong',
          attribution: {actor: 'marcus', recordedAt: '2026-10-01T10:00:00Z'},
        }),
        correction('c2', 'superseded', {supersededBy: 'c3'}),
      ],
    })

    expect(item('c1')).toHaveAttribute('data-status', 'active')
    expect(item('c1')).toHaveTextContent('Active')
    expect(item('c1')).toHaveTextContent('span of c1')
    expect(item('c1')).toHaveTextContent('Was wrong')
    expect(item('c1')).toHaveTextContent('marcus')
    expect(item('c1')).toHaveTextContent('2026-10-01')
    expect(item('c2')).toHaveAttribute('data-status', 'superseded')
    expect(item('c2')).toHaveTextContent('c3')
  })

  it('shows a correction whose span no longer matches the page as stale', () => {
    renderPanel({corrections: [correction('c1'), correction('c2', 'active', {stale: true})]})

    expect(item('c1')).not.toHaveAttribute('data-stale', 'true')
    expect(item('c1')).not.toHaveTextContent('Out of date')
    expect(item('c2')).toHaveAttribute('data-stale', 'true')
    expect(item('c2')).toHaveTextContent('Out of date')
    expect(item('c2')).toHaveTextContent(/no longer matches the page/iu)
  })
})

describe('staging correction actions', () => {
  it('offers Retire and Flag for reconfirmation on an active correction', () => {
    renderPanel({corrections: [correction('c1')]})
    expect(within(item('c1')).getByRole('button', {name: 'Retire'})).toBeEnabled()
    expect(within(item('c1')).getByRole('button', {name: 'Flag for reconfirmation'})).toBeEnabled()
    expect(within(item('c1')).queryByRole('button', {name: 'Reconfirm'})).toBeNull()
  })

  it('offers Reconfirm on a flagged correction, and nothing else', () => {
    renderPanel({corrections: [correction('c1', 'needs-reconfirmation')]})
    expect(within(item('c1')).getByRole('button', {name: 'Reconfirm'})).toBeEnabled()
    expect(within(item('c1')).queryByRole('button', {name: 'Retire'})).toBeNull()
    expect(within(item('c1')).queryByRole('button', {name: 'Flag for reconfirmation'})).toBeNull()
  })

  it.each(['retired', 'superseded'] as const)('offers nothing on a %s correction', status => {
    renderPanel({corrections: [correction('c1', status)]})
    expect(within(item('c1')).queryByRole('button')).toBeNull()
  })

  it('stages the action that was chosen, for that correction', () => {
    const props = renderPanel({corrections: [correction('c1'), correction('c2')]})
    fireEvent.click(within(item('c2')).getByRole('button', {name: 'Flag for reconfirmation'}))
    expect(props.onStage).toHaveBeenCalledWith(expect.objectContaining({id: 'c2'}), 'flag')

    fireEvent.click(within(item('c1')).getByRole('button', {name: 'Retire'}))
    expect(props.onStage).toHaveBeenLastCalledWith(expect.objectContaining({id: 'c1'}), 'retire')
  })

  it('names the correction each action is for, so identical buttons can be told apart', () => {
    renderPanel({corrections: [correction('c1'), correction('c2')]})
    const [retire] = within(item('c1')).getAllByRole('button', {name: 'Retire'})
    expect(retire?.getAttribute('aria-describedby')).toBe('wiki-correction-span-c1')
    expect(retire).toHaveAccessibleDescription(/span of c1/u)
  })

  const retireStaged: StagedAction = {correctionId: 'c1', action: 'retire', from: 'active', spanText: 'span of c1'}

  it('shows a staged action as staged, with Undo in place of the actions', () => {
    renderPanel({corrections: [correction('c1')], staged: [retireStaged]})

    expect(item('c1')).toHaveAttribute('data-staged', 'retire')
    expect(within(item('c1')).getByTestId('wiki-correction-staged')).toHaveTextContent(/retired when you save/iu)
    expect(within(item('c1')).getByRole('button', {name: 'Undo'})).toBeEnabled()
    expect(within(item('c1')).queryByRole('button', {name: 'Retire'})).toBeNull()
    expect(within(item('c1')).queryByRole('button', {name: 'Flag for reconfirmation'})).toBeNull()
  })

  it('undoes a staged action', () => {
    const props = renderPanel({corrections: [correction('c1')], staged: [retireStaged]})
    fireEvent.click(within(item('c1')).getByRole('button', {name: 'Undo'}))
    expect(props.onUndo).toHaveBeenCalledWith('c1')
  })

  it('says what each staged action will do', () => {
    renderPanel({
      corrections: [correction('c1'), correction('c2', 'needs-reconfirmation')],
      staged: [
        {...retireStaged, action: 'flag'},
        {correctionId: 'c2', action: 'reconfirm', from: 'needs-reconfirmation', spanText: 'span of c2'},
      ],
    })
    expect(item('c1')).toHaveTextContent(/flagged for reconfirmation when you save/iu)
    expect(item('c2')).toHaveTextContent(/reconfirmed when you save/iu)
  })

  it('shows no actions, and no Undo, without the edit surface, but still shows what is staged', () => {
    renderPanel({corrections: [correction('c1'), correction('c2')], staged: [retireStaged], actions: false})

    expect(screen.queryByRole('button')).toBeNull()
    expect(item('c1')).toHaveAttribute('data-staged', 'retire')
    expect(item('c2')).not.toHaveAttribute('data-staged')
  })

  it('shows a notice when staged actions were dropped', () => {
    renderPanel({corrections: [correction('c1')], droppedNotice: 'One staged change was dropped.'})
    const notice = screen.getByTestId('wiki-staged-dropped')
    expect(notice).toHaveTextContent('One staged change was dropped.')
    expect(notice).toHaveAttribute('role', 'status')
  })

  it('shows a status when an action could not be staged', () => {
    renderPanel({corrections: [correction('c1')], stageStatus: 'Too many staged.'})
    const status = screen.getByTestId('wiki-stage-status')
    expect(status).toHaveTextContent('Too many staged.')
    expect(status).toHaveAttribute('role', 'status')
  })

  it('shows no staging status by default', () => {
    renderPanel({corrections: [correction('c1')]})
    expect(screen.queryByTestId('wiki-stage-status')).toBeNull()
  })

  it('shows no notice by default', () => {
    renderPanel()
    expect(screen.queryByTestId('wiki-staged-dropped')).toBeNull()
  })
})

describe('the marks in the draft', () => {
  it('shows no marks section when nothing is marked', () => {
    renderPanel()
    expect(screen.queryByTestId('wiki-marks')).toBeNull()
  })

  it('lists each mark with its text, Jump to span, and Remove', () => {
    const props = renderPanel({marks: [markRow('m1'), markRow('m2')]})

    const first = within(screen.getByTestId('wiki-marks')).getAllByTestId('wiki-mark-item')[0] as HTMLElement
    expect(first).toHaveAttribute('data-mark-id', 'm1')
    expect(first).toHaveAttribute('data-mark-state', 'ok')
    expect(first).toHaveTextContent('marked m1')
    expect(within(first).queryByRole('button', {name: 'Keep'})).toBeNull()

    fireEvent.click(within(first).getByRole('button', {name: 'Jump to span'}))
    expect(props.onJumpToMark).toHaveBeenCalledWith('m1')
    fireEvent.click(within(first).getByRole('button', {name: 'Remove'}))
    expect(props.onRemoveMark).toHaveBeenCalledWith('m1')
  })

  it('lists a flagged mark as needing review, with Keep and Remove, and says Save waits', () => {
    const props = renderPanel({marks: [markRow('m1', 'review')]})

    const row = screen.getByTestId('wiki-mark-item')
    expect(row).toHaveAttribute('data-mark-state', 'review')
    expect(row).toHaveTextContent(/needs review/iu)
    fireEvent.click(within(row).getByRole('button', {name: 'Keep'}))
    expect(props.onKeepMark).toHaveBeenCalledWith('m1')
    expect(within(row).getByRole('button', {name: 'Remove'})).toBeEnabled()
    expect(screen.getByTestId('wiki-marks-blocking')).toHaveTextContent(/before you can save/iu)
  })

  it('lists a mark whose text is gone as missing, and offers only Remove', () => {
    renderPanel({marks: [markRow('m1', 'detached')]})

    const row = screen.getByTestId('wiki-mark-item')
    expect(row).toHaveAttribute('data-mark-state', 'detached')
    expect(row).toHaveTextContent(/no longer in the text/iu)
    expect(within(row).queryByRole('button', {name: 'Jump to span'})).toBeNull()
    expect(within(row).queryByRole('button', {name: 'Keep'})).toBeNull()
    expect(within(row).getByRole('button', {name: 'Remove'})).toBeEnabled()
    expect(screen.getByTestId('wiki-marks-blocking')).toBeInTheDocument()
  })

  it('says nothing about review when every mark is settled', () => {
    renderPanel({marks: [markRow('m1')]})
    expect(screen.queryByTestId('wiki-marks-blocking')).toBeNull()
  })

  it('shows the mark text exactly, with emoji and combining characters', () => {
    renderPanel({marks: [markRow('m1', 'ok', '👍🏽 cafe\u0301')]})
    expect(screen.getByTestId('wiki-mark-item').querySelector('q')?.textContent).toBe('👍🏽 cafe\u0301')
  })

  it('disables the mark buttons when the panel is busy', () => {
    renderPanel({marks: [markRow('m1', 'review')], corrections: [correction('c1')], busy: true})
    expect(screen.getByRole('button', {name: 'Remove'})).toBeDisabled()
    expect(screen.getByRole('button', {name: 'Keep'})).toBeDisabled()
    expect(screen.getByRole('button', {name: 'Retire'})).toBeDisabled()
    expect(screen.getByRole('button', {name: 'Flag for reconfirmation'})).toBeDisabled()
  })
})
