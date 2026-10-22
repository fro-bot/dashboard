import type {SaveError, SavedCommit, WikiResult} from '../api/wiki.ts'
import {describe, expect, it} from 'vitest'
import {
  describeDispatchFailure,
  describeLookup,
  describePreSendFailure,
  describePromotion,
  describeSaveResult,
  RATE_LIMIT_FALLBACK_SECONDS,
} from './outcomes.ts'

const saved = (state: SavedCommit['state']): WikiResult<SavedCommit, SaveError> => ({
  ok: true,
  value: {state, operationId: 'op-1', commitSha: 'c1', committedAt: '2026-10-21T10:00:00Z'},
})

const failed = (error: object): WikiResult<SavedCommit, SaveError> => ({ok: false, error: error as SaveError})

const describeFailure = (error: object, persisted = true) => describeSaveResult(failed(error), {persisted})

// One test per row of the outcome contract table (plan, "Outcome contract").
describe('describeSaveResult — the outcome contract', () => {
  it('Saved, pending publication: draft cleared, no action needed', () => {
    const display = describeSaveResult(saved('saved'), {persisted: true})
    expect(display.kind).toBe('saved')
    expect(display.headline).toBe('Saved, pending publication')
    expect(display.draft).toBe('cleared')
    expect(display.actions).toEqual([])
    expect(display.saveDisabled).toBe(false)
    expect(display.urgency).toBe('status')
  })

  it('Saved, not promoted: draft cleared, offers retry dispatch', () => {
    const display = describeSaveResult(saved('saved-not-promoted'), {persisted: true})
    expect(display.kind).toBe('saved-not-promoted')
    expect(display.headline).toBe('Saved, not promoted')
    expect(display.draft).toBe('cleared')
    expect(display.actions).toEqual(['retry-dispatch'])
    expect(display.detail).toMatch(/no new commit|not saved again|does not save again/iu)
  })

  it('Rejected: lists the findings, keeps the draft, nothing else to do but fix and save', () => {
    const findings = [
      {kind: 'gate', path: 'wiki/a.md', message: 'Broken link.', target: '[[nope]]'},
      {kind: 'gate', path: 'wiki/a.md', message: 'Page-level problem.'},
    ]
    const display = describeFailure({kind: 'rejected', reason: 'gate', findings})
    expect(display.kind).toBe('rejected')
    expect(display.draft).toBe('kept')
    expect(display.findings).toEqual(findings)
    expect(display.actions).toEqual([])
    expect(display.saveDisabled).toBe(false)
    expect(display.detail).toMatch(/nothing was saved/iu)
  })

  it('Rejected without findings still says why, from the reason', () => {
    const display = describeFailure({kind: 'rejected', reason: 'no-change', findings: []})
    expect(display.findings).toEqual([])
    expect(display.detail).toMatch(/no changes|nothing to save/iu)
  })

  it('Conflict, page kind: names the kind, keeps the draft, offers overwrite', () => {
    const display = describeFailure({kind: 'conflict', conflict: {kind: 'page', currentBlobSha: 'blob-2'}})
    expect(display.kind).toBe('conflict-page')
    expect(display.headline).toMatch(/page changed/iu)
    expect(display.draft).toBe('kept')
    expect(display.actions).toEqual(['overwrite'])
    expect(display.saveDisabled).toBe(true)
  })

  it('Conflict, corrections kind: names the kind, keeps the draft, offers overwrite', () => {
    const display = describeFailure({
      kind: 'conflict',
      conflict: {kind: 'corrections', currentCorrections: [], correctionsBase: 'digest-2'},
    })
    expect(display.kind).toBe('conflict-corrections')
    expect(display.headline).toMatch(/corrections changed/iu)
    expect(display.draft).toBe('kept')
    expect(display.actions).toEqual(['overwrite'])
    expect(display.saveDisabled).toBe(true)
  })

  it('Conflict, page removed: disables Save, keeps the draft, lets the text be copied out, no overwrite', () => {
    const display = describeFailure({kind: 'conflict', conflict: {kind: 'page-removed'}})
    expect(display.kind).toBe('conflict-page-removed')
    expect(display.draft).toBe('kept')
    expect(display.saveDisabled).toBe(true)
    expect(display.actions).toEqual(['copy-draft'])
    expect(display.urgency).toBe('alert')
  })

  it('Failed, retryable: nothing committed, draft kept, Save again', () => {
    const display = describeFailure({kind: 'failed', operationId: 'op-1', retryable: true})
    expect(display.kind).toBe('failed')
    expect(display.draft).toBe('kept')
    expect(display.actions).toEqual(['save-again'])
    expect(display.saveDisabled).toBe(false)
    expect(display.detail).toMatch(/nothing was saved/iu)
  })

  it('Failed, not retryable: a configuration message and no retry', () => {
    const display = describeFailure({kind: 'failed', operationId: 'op-1', retryable: false})
    expect(display.kind).toBe('failed-configuration')
    expect(display.draft).toBe('kept')
    expect(display.actions).toEqual([])
    expect(display.saveDisabled).toBe(true)
    expect(display.urgency).toBe('alert')
    expect(display.detail).toMatch(/configur/iu)
  })

  it('Gate-contract rejected, mismatch: the dashboard needs a deploy, Save disabled, draft kept', () => {
    const display = describeFailure({kind: 'contract-rejected', reason: 'mismatch', retry: false})
    expect(display.kind).toBe('contract-mismatch')
    expect(display.detail).toMatch(/dashboard needs a deploy/iu)
    expect(display.saveDisabled).toBe(true)
    expect(display.draft).toBe('kept')
    expect(display.actions).toEqual([])
    expect(display.urgency).toBe('alert')
  })

  it('Gate-contract rejected, unreadable: retryable, Save again, draft kept', () => {
    const display = describeFailure({kind: 'contract-rejected', reason: 'unreadable', retry: true})
    expect(display.kind).toBe('contract-unreadable')
    expect(display.actions).toEqual(['save-again'])
    expect(display.saveDisabled).toBe(false)
    expect(display.draft).toBe('kept')
  })

  it('Save status unknown: no retry, the pending operation stays, offers Check save status', () => {
    const display = describeFailure({kind: 'status-unknown', cause: 'timeout'})
    expect(display.kind).toBe('status-unknown')
    expect(display.headline).toBe('Save status unknown')
    expect(display.draft).toBe('kept-with-pending')
    expect(display.actions).toEqual(['check-status'])
    expect(display.saveDisabled).toBe(true)
    expect(display.detail).not.toMatch(/try again|save again/iu)
  })

  it.each(['indeterminate', 'session-lost', 'network', 'timeout'] as const)(
    'Save status unknown for cause %s is not a failure',
    cause => {
      const display = describeFailure({kind: 'status-unknown', cause})
      expect(display.kind).toBe('status-unknown')
      expect(display.headline).toBe('Save status unknown')
    },
  )

  it('Save status unknown after a lost session also offers sign-in', () => {
    const display = describeFailure({kind: 'status-unknown', cause: 'session-lost'})
    expect(display.actions).toEqual(['sign-in', 'check-status'])
  })

  it('a save contract-drift is Save status unknown, never a retry', () => {
    const display = describeFailure({kind: 'contract-drift'})
    expect(display.kind).toBe('status-unknown')
    expect(display.actions).toEqual(['check-status'])
    expect(display.saveDisabled).toBe(true)
  })

  it('Save status unknown says resolution works only in this session when the operation was not persisted', () => {
    const persisted = describeFailure({kind: 'status-unknown', cause: 'network'}, true)
    const volatile = describeFailure({kind: 'status-unknown', cause: 'network'}, false)
    expect(persisted.detail).not.toMatch(/only until you leave|only in this session/iu)
    expect(volatile.detail).toMatch(/only until you leave or reload/iu)
  })

  it('Rate-limited: its own message with the retry hint, draft kept', () => {
    const display = describeFailure({kind: 'rate-limited', retryAfterSeconds: 42})
    expect(display.kind).toBe('rate-limited')
    expect(display.draft).toBe('kept')
    expect(display.detail).toContain('42 seconds')
    expect(display.saveDisabled).toBe(false)
  })

  it('Rate-limited without a hint falls back to a fixed wait', () => {
    const display = describeFailure({kind: 'rate-limited', retryAfterSeconds: null})
    expect(display.detail).toContain(`${RATE_LIMIT_FALLBACK_SECONDS} seconds`)
  })

  it('Rate-limited with one second says "1 second"', () => {
    expect(describeFailure({kind: 'rate-limited', retryAfterSeconds: 1}).detail).toContain('1 second.')
  })
})

describe('describeSaveResult — refusals that commit nothing', () => {
  it.each([['forbidden'], ['not-found']] as const)('%s blocks Save and keeps the draft', kind => {
    const display = describeFailure({kind})
    expect(display.draft).toBe('kept')
    expect(display.saveDisabled).toBe(true)
    expect(display.urgency).toBe('alert')
  })

  it.each([['bad-request'], ['unsupported-media-type']] as const)('%s asks for a reload and blocks Save', kind => {
    const display = describeFailure({kind})
    expect(display.detail).toMatch(/reload/iu)
    expect(display.saveDisabled).toBe(true)
  })

  it('payload-too-large asks for a shorter page and leaves Save enabled', () => {
    const display = describeFailure({kind: 'payload-too-large'})
    expect(display.detail).toMatch(/too large/iu)
    expect(display.saveDisabled).toBe(false)
  })

  it.each(['session-lost', 'network', 'timeout'] as const)('a bare %s transport error is Save status unknown', kind => {
    expect(describeFailure({kind}).kind).toBe('status-unknown')
  })

  it('shows no raw status code or error code', () => {
    const display = describeFailure({kind: 'bad-request'})
    expect(`${display.headline} ${display.detail}`).not.toMatch(/\b(?:400|415|413|bad-request)\b/u)
  })
})

describe('describePreSendFailure', () => {
  it('says nothing was sent and keeps the draft', () => {
    const display = describePreSendFailure()
    expect(display.kind).toBe('not-sent')
    expect(display.draft).toBe('kept')
    expect(display.detail).toMatch(/nothing was sent/iu)
    expect(display.actions).toEqual(['save-again'])
  })
})

describe('describeLookup — resolving an unknown save', () => {
  it('found: Saved, publication unknown, because the dispatch outcome is unknown; retry dispatch is safe', () => {
    const display = describeLookup({ok: true, value: {state: 'found', commitSha: 'c1', committedAt: null}})
    expect(display.kind).toBe('lookup-found')
    expect(display.headline).toBe('Saved, publication unknown')
    expect(display.draft).toBe('cleared')
    expect(display.actions).toEqual(['retry-dispatch'])
    expect(display.detail).toMatch(/safe/iu)
  })

  it('missing: the save did not land, the draft is restored, Save again', () => {
    const display = describeLookup({ok: true, value: {state: 'missing'}})
    expect(display.kind).toBe('lookup-missing')
    expect(display.draft).toBe('kept')
    expect(display.actions).toEqual(['save-again'])
    expect(display.saveDisabled).toBe(false)
  })

  it('missing: warns that a save made just now may not be listed yet, so check the page before overwriting', () => {
    const display = describeLookup({ok: true, value: {state: 'missing'}})
    expect(display.detail).toMatch(/just made/iu)
    expect(display.detail).toMatch(/conflict/iu)
    expect(display.detail).toMatch(/check the page before/iu)
  })

  it('unknown: shows the conflict view with the newer version labeled "possibly your save"', () => {
    const display = describeLookup({ok: true, value: {state: 'unknown'}})
    expect(display.kind).toBe('lookup-unknown')
    expect(display.draft).toBe('kept-with-pending')
    expect(display.versionLabel).toBe('Current version (possibly your save)')
    expect(display.actions).toEqual(['overwrite', 'check-status'])
  })

  it('rate-limited: stays unknown, says to wait, offers the check again', () => {
    const display = describeLookup({ok: false, error: {kind: 'rate-limited', retryAfterSeconds: 20}})
    expect(display.kind).toBe('lookup-failed')
    expect(display.detail).toContain('20 seconds')
    expect(display.actions).toEqual(['check-status'])
  })

  it('session lost: offers sign-in and the check again', () => {
    const display = describeLookup({ok: false, error: {kind: 'session-lost'}})
    expect(display.actions).toEqual(['sign-in', 'check-status'])
  })

  it.each(['network', 'timeout', 'contract-drift'] as const)('%s: could not check, try again', kind => {
    const display = describeLookup({ok: false, error: {kind}})
    expect(display.kind).toBe('lookup-failed')
    expect(display.actions).toEqual(['check-status'])
  })

  it.each(['invalid-request', 'forbidden'] as const)('%s: could not check, no raw code shown', kind => {
    const display = describeLookup({ok: false, error: {kind}})
    expect(display.kind).toBe('lookup-failed')
    expect(display.detail).not.toContain(kind)
  })
})

describe('describePromotion', () => {
  it('pending: says the weekly schedule also promotes and saving again is not needed', () => {
    const display = describePromotion({state: 'pending', pr: {number: 7, url: 'https://github.com/o/r/pull/7'}})
    expect(display.kind).toBe('pending')
    expect(display.detail).toMatch(/weekly schedule/iu)
    expect(display.detail).toMatch(/saving again is not needed/iu)
    expect(display.prUrl).toBe('https://github.com/o/r/pull/7')
    expect(display.runUrl).toBeNull()
  })

  it('pending with no PR yet has no link', () => {
    expect(describePromotion({state: 'pending', pr: null}).prUrl).toBeNull()
  })

  it('no status yet is treated as pending, because the save response means the dispatch was accepted', () => {
    expect(describePromotion(null).kind).toBe('pending')
  })

  it('settled: done, no more polling', () => {
    const display = describePromotion({state: 'settled', pr: null})
    expect(display.kind).toBe('settled')
    expect(display.settles).toBe(true)
  })

  it('blocked: the reason, the run link, and edit-and-save-again', () => {
    const display = describePromotion({
      state: 'blocked',
      reason: 'private-page',
      runUrl: 'https://github.com/o/r/actions/runs/9',
      pr: null,
    })
    expect(display.kind).toBe('blocked')
    expect(display.detail).toMatch(/private/iu)
    expect(display.runUrl).toBe('https://github.com/o/r/actions/runs/9')
    expect(display.hint).toMatch(/edit and save again/iu)
    expect(display.settles).toBe(true)
  })

  it('pending does not settle', () => {
    expect(describePromotion({state: 'pending', pr: null}).settles).toBe(false)
  })
})

describe('describeDispatchFailure', () => {
  it('dispatch-failed: still not promoted, try again', () => {
    expect(describeDispatchFailure({kind: 'dispatch-failed'})).toMatch(/not promoted|try again/iu)
  })

  it('rate-limited carries the wait', () => {
    expect(describeDispatchFailure({kind: 'rate-limited', retryAfterSeconds: 9})).toContain('9 seconds')
  })

  it('shows no raw codes', () => {
    const message = describeDispatchFailure({kind: 'forbidden'})
    expect(message).toBe('This session is not allowed to send the publication request.')
    expect(message).not.toContain('forbidden')
  })
})
