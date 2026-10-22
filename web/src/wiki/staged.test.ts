import {describe, expect, it} from 'vitest'
import type {CorrectionStatus, WikiCorrection} from '../api/wiki.ts'
import {
  availableActions,
  parseStaged,
  reconcileStaged,
  stageAction,
  transitionsOf,
  undoStaged,
  type StagedAction,
} from './staged.ts'

function correction(id: string, status: CorrectionStatus = 'active', text = `span of ${id}`): WikiCorrection {
  return {id, status, span: {text}, attribution: null, reason: null, supersededBy: null, stale: false}
}

describe('availableActions', () => {
  it.each([
    ['active', ['retire', 'flag']],
    ['needs-reconfirmation', ['reconfirm']],
    ['retired', []],
    ['superseded', []],
  ] as const)('offers %s corrections %j', (status, expected) => {
    expect(availableActions(correction('c1', status))).toEqual(expected)
  })
})

describe('stageAction', () => {
  it('stages an action with the status and text the correction had', () => {
    const staged = stageAction([], correction('c1'), 'retire')
    expect(staged).toEqual([{correctionId: 'c1', action: 'retire', from: 'active', spanText: 'span of c1'}])
  })

  it('replaces the action already staged for the same correction', () => {
    const first = stageAction([], correction('c1'), 'retire')
    const second = stageAction(first, correction('c1'), 'flag')
    expect(second).toEqual([{correctionId: 'c1', action: 'flag', from: 'active', spanText: 'span of c1'}])
  })

  it('keeps actions staged for other corrections', () => {
    const staged = stageAction(stageAction([], correction('c1'), 'retire'), correction('c2'), 'flag')
    expect(staged.map(action => action.correctionId)).toEqual(['c1', 'c2'])
  })

  it('does not stage an action the status does not allow', () => {
    expect(stageAction([], correction('c1', 'active'), 'reconfirm')).toEqual([])
    expect(stageAction([], correction('c1', 'needs-reconfirmation'), 'retire')).toEqual([])
    expect(stageAction([], correction('c1', 'retired'), 'retire')).toEqual([])
  })

  it('stages a reconfirm for a flagged correction', () => {
    expect(stageAction([], correction('c1', 'needs-reconfirmation'), 'reconfirm')).toEqual([
      {correctionId: 'c1', action: 'reconfirm', from: 'needs-reconfirmation', spanText: 'span of c1'},
    ])
  })
})

describe('undoStaged', () => {
  it('removes the action staged for that correction only', () => {
    const staged = stageAction(stageAction([], correction('c1'), 'retire'), correction('c2'), 'flag')
    expect(undoStaged(staged, 'c1').map(action => action.correctionId)).toEqual(['c2'])
    expect(undoStaged(staged, 'nope')).toEqual(staged)
  })
})

describe('transitionsOf', () => {
  it('lists the staged actions as the transitions a save sends', () => {
    const staged = stageAction(stageAction([], correction('c1'), 'retire'), correction('c2'), 'flag')
    expect(transitionsOf(staged)).toEqual([
      {id: 'c1', action: 'retire'},
      {id: 'c2', action: 'flag'},
    ])
    expect(transitionsOf([])).toEqual([])
  })
})

describe('reconcileStaged', () => {
  const staged = (...ids: string[]): StagedAction[] => ids.reduce<StagedAction[]>((all, id) => stageAction(all, correction(id), 'retire'), [])

  it('keeps an action whose correction is unchanged', () => {
    const result = reconcileStaged(staged('c1', 'c2'), [correction('c1'), correction('c2')])
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toEqual([])
  })

  it('drops an action whose correction has vanished', () => {
    const result = reconcileStaged(staged('c1', 'c2'), [correction('c2')])
    expect(result.kept.map(action => action.correctionId)).toEqual(['c2'])
    expect(result.dropped.map(action => action.correctionId)).toEqual(['c1'])
  })

  it('drops an action whose correction changed status', () => {
    const result = reconcileStaged(staged('c1'), [correction('c1', 'retired')])
    expect(result.kept).toEqual([])
    expect(result.dropped).toHaveLength(1)
  })

  it('drops an action whose correction changed text', () => {
    const result = reconcileStaged(staged('c1'), [correction('c1', 'active', 'a different span')])
    expect(result.kept).toEqual([])
    expect(result.dropped).toHaveLength(1)
  })

  it('has nothing to drop for nothing staged', () => {
    expect(reconcileStaged([], [])).toEqual({kept: [], dropped: []})
  })
})

describe('parseStaged', () => {
  const good = {correctionId: 'c1', action: 'retire', from: 'active', spanText: 'x'}

  it('accepts well-formed actions', () => {
    expect(parseStaged([good])).toEqual([good])
    expect(parseStaged([])).toEqual([])
  })

  it.each([
    ['not an array', 'x'],
    ['a non-object', [1]],
    ['an empty ID', [{...good, correctionId: ''}]],
    ['an unknown action', [{...good, action: 'delete'}]],
    ['an unknown status', [{...good, from: 'weird'}]],
    ['a missing text', [{...good, spanText: undefined}]],
    ['two actions for one correction', [good, {...good, action: 'flag'}]],
  ])('refuses %s', (_label, value) => {
    expect(parseStaged(value)).toBeNull()
  })

  it('refuses more actions than the server accepts', () => {
    const many = Array.from({length: 101}, (_unused, index) => ({...good, correctionId: `c${index}`}))
    expect(parseStaged(many)).toBeNull()
  })
})
