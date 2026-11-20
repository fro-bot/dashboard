import {describe, expect, it, vi} from 'vitest'

import {baselineFromRelease, canRelease, mergeArguments, runPending, scheduleAttemptAllowed} from '../scripts/release-pending.ts'

const sha = 'a'.repeat(40)
const other = 'b'.repeat(40)

describe('release baseline', () => {
  const release = {tag_name: '2026.11.1', body: `Source: ${sha}\nDigest: ghcr.io/fro-bot/dashboard@sha256:${'c'.repeat(64)}`}

  it('requires matching tag and complete metadata', () => {
    expect(baselineFromRelease(release, sha)).toEqual({source: sha, digest: `sha256:${'c'.repeat(64)}`})
    expect(() => baselineFromRelease(release, other)).toThrow()
    expect(() => baselineFromRelease({...release, body: `Source: ${sha}`}, sha)).toThrow()
    expect(() => baselineFromRelease({...release, body: `${release.body}\nSource: ${sha}`}, sha)).toThrow()
  })
})

it('prepares a held PR and reuses its unchanged head', () => {
  const main = 'b'.repeat(40)
  let ref = ''
  let open = false
  let held = false
  let committed = false
  let notes = '# Release changes\n\n- Fix release\n'
  let unrelated = false
  let predecessor = 'human'
  let version = '2026.11.2'
  let title = ''
  let body = ''
  let nextHead = sha
  let readbackHeads: string[] = []
  const commands: string[] = []
  const writes: string[][] = []
  const pr = () => ({number: 42, state: 'open', merged_at: null, title, body, user: {id: 109017866, login: 'fro-bot[bot]'}, head: {sha: ref || sha, ref: 'release/pending', repo: {full_name: 'fro-bot/dashboard'}}, base: {ref: 'main', repo: {full_name: 'fro-bot/dashboard'}}, labels: held ? [{name: 'release-hold'}] : []})
  const prior = (number: number, mergeSha: string, mergedAt: string) => ({...pr(), number, state: 'closed', merged_at: mergedAt, merge_commit_sha: mergeSha, labels: []})
  const human = () => prior(873, sha, '2026-11-18T15:00:00Z')
  const app = () => prior(872, main, '2026-11-17T15:00:00Z')
  const run = (cmd: string, args: string[], write = false): string => {
    commands.push(`${cmd} ${args.join(' ')}`)
    if (write) writes.push([cmd, ...args])
    if (cmd === 'node' && args[0] === 'scripts/compute-release-tag.ts') return `${version}\n`
    if (cmd === 'docker') return `sha256:${'c'.repeat(64)}\n`
    if (cmd === 'git') {
      if (args[0] === 'rev-parse' && args[1]?.startsWith('refs/tags/')) return main
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'false'
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return committed ? nextHead : main
      if (args[0] === 'ls-remote') return ref ? `${ref}\trefs/heads/release/pending\n` : ''
      if (args[0] === 'remote') return 'https://github.com/fro-bot/dashboard.git'
      if (args[0] === 'rev-list') return `${args[4]} ${main}`
      if (args[0] === 'show') return args[1] === '-s' ? '109017866+fro-bot[bot]@users.noreply.github.com\n' : '# Release changes\n\n- Fix release\n'
      if (args[0] === 'diff') return unrelated ? 'other.txt' : 'docs/releases/batch.md'
      if (args[0] === 'status') return ''
      if (args.includes('commit')) {
        committed = true
        return ''
      }
      if (args[0] === 'add') return ''
      if (args[0] === 'push') {
        ref = nextHead
        return ''
      }
      throw new Error(`Unexpected git: ${args.join(' ')}`)
    }
    const path = args.find(arg => arg.startsWith('repos/')) ?? ''
    if (write && path.endsWith('/pulls')) {
      open = true
      title = args.find(arg => arg.startsWith('title='))?.slice(6) ?? ''
      body = args.find(arg => arg.startsWith('body='))?.slice(5) ?? ''
      return JSON.stringify(pr())
    }
    if (write && path.endsWith('/pulls/42')) {
      title = args.find(arg => arg.startsWith('title='))?.slice(6) ?? ''
      body = args.find(arg => arg.startsWith('body='))?.slice(5) ?? ''
      return JSON.stringify(pr())
    }
    if (write && path.endsWith('/issues/42/labels')) {
      held = true
      return JSON.stringify([{name: 'release-hold'}])
    }
    if (path.includes('/pulls?')) return JSON.stringify([[...(open ? [pr()] : []), human(), app()]])
    if (path.endsWith('/pulls/42')) {
      const value = readbackHeads.shift() ?? ref
      if (value === 'failure') throw new Error('GET failed')
      const current = pr()
      if (value === 'identity') current.user.id = 1
      if (value === 'closed') current.state = 'closed'
      return JSON.stringify({...current, labels: value === 'labels' ? null : current.labels, head: {...current.head, sha: ['identity', 'closed', 'labels'].includes(value) ? sha : value}})
    }
    if (path.endsWith('/pulls/873')) return JSON.stringify({...human(), merged: true, merge_commit_sha: predecessor === 'mismatch' ? main : sha, merged_by: predecessor === 'missing' ? null : predecessor === 'app' ? {type: 'Bot', id: 109017866, login: 'fro-bot[bot]'} : predecessor === 'other-bot' ? {type: 'Bot', id: 123, login: 'other[bot]'} : {type: 'User', id: 831617, login: 'marcusrbrown'}})
    if (path.endsWith('/pulls/872')) return JSON.stringify({...app(), merged: true, merged_by: {type: 'Bot', id: 109017866, login: 'fro-bot[bot]'}})
    if (path.endsWith('/git/ref/heads/main')) return JSON.stringify({object: {sha: main}})
    if (path.endsWith('/releases/latest')) return JSON.stringify({tag_name: '2026.11.1', body: `Source: ${main}\nDigest: ghcr.io/fro-bot/dashboard@sha256:${'c'.repeat(64)}`})
    if (path.includes('/issues/42/events?')) return JSON.stringify([[]])
    throw new Error(`Unexpected gh: ${args.join(' ')}`)
  }
  const env = {GITHUB_REPOSITORY: 'fro-bot/dashboard'}
  const files: string[] = []
  const prepare = () => runPending('prepare', env, run, () => notes, text => files.push(text))
  predecessor = 'app'
  expect(prepare()).toMatch(/publication.*not settled/i)
  expect(files).toEqual([])
  predecessor = 'missing'
  expect(() => prepare()).toThrow(/predecessor|merger/i)
  predecessor = 'other-bot'
  expect(() => prepare()).toThrow(/predecessor|merger/i)
  predecessor = 'mismatch'
  expect(() => prepare()).toThrow(/predecessor/i)
  expect(files).toEqual([])
  expect(commands.some(line => line.startsWith('git push') || line.includes('--method POST'))).toBe(false)
  predecessor = 'human'
  notes = ''
  expect(prepare()).toMatch(/no release notes/i)
  expect(commands.some(line => line.startsWith('node '))).toBe(false)
  notes = '# Release changes\n\n- Fix release\n'
  version = 'not-calver'
  expect(() => prepare()).toThrow(/calver/i)
  expect(writes).toEqual([])
  expect(files).toEqual([])
  version = '2026.11.2'
  expect(prepare()).toMatch(/prepared/i)
  expect(held).toBe(true)
  expect(files).toEqual(['# Release changes\n\n- Fix release\n'])
  const instruction = '**Approve to release:** When the required checks pass, submit an **Approve** review. The App merges the pull request and starts Release. Do not click **Merge**.'
  expect.soft(writes).toContainEqual(['gh', 'api', '--method', 'POST', 'repos/fro-bot/dashboard/pulls', '-f', 'title=chore: release 2026.11.2', '-f', 'head=release/pending', '-f', 'base=main', '-f', `body=Release 2026.11.2.\n\n${notes}\n${instruction}`])
  expect(commands.some(line => line.includes('--force-with-lease=refs/heads/release/pending:'))).toBe(true)
  commands.length = 0
  committed = false
  version = '2026.12.0'
  writes.length = 0
  expect(prepare()).toMatch(/up.to.date/i)
  expect(commands.some(line => line.startsWith('git push'))).toBe(false)
  expect.soft(writes).toEqual([['gh', 'api', '--method', 'PATCH', 'repos/fro-bot/dashboard/pulls/42', '-f', 'title=chore: release 2026.12.0', '-f', `body=Release 2026.12.0.\n\n${notes}\n${instruction}`]])
  writes.length = 0
  expect(prepare()).toMatch(/up.to.date/i)
  expect(writes).toEqual([])
  commands.length = 0
  notes = 'updated notes\n'
  nextHead = 'd'.repeat(40)
  readbackHeads = [sha, nextHead]
  const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
  expect(prepare()).toMatch(/prepared/i)
  expect(wait).toHaveBeenCalledTimes(1)
  expect(wait.mock.calls[0]?.[3]).toBe(2000)
  expect(readbackHeads).toEqual([])
  expect(commands.filter(line => line === 'gh api repos/fro-bot/dashboard/pulls/42')).toHaveLength(2)
  expect(commands.some(line => line.includes(`--force-with-lease=refs/heads/release/pending:${sha}`))).toBe(true)
  expect(writes).toEqual([
    ['git', 'push', `--force-with-lease=refs/heads/release/pending:${sha}`, 'origin', `${nextHead}:refs/heads/release/pending`],
    ['gh', 'api', '--method', 'PATCH', 'repos/fro-bot/dashboard/pulls/42', '-f', 'title=chore: release 2026.12.0', '-f', `body=Release 2026.12.0.\n\n${notes}\n${instruction}`],
  ])
  expect(commands.some(line => line.includes('--method POST repos/fro-bot/dashboard/pulls'))).toBe(false)
  ref = sha
  committed = false
  readbackHeads = [nextHead]
  writes.length = 0
  wait.mockClear()
  expect(prepare()).toMatch(/prepared/i)
  expect(wait).not.toHaveBeenCalled()
  expect(writes).toEqual([['git', 'push', `--force-with-lease=refs/heads/release/pending:${sha}`, 'origin', `${nextHead}:refs/heads/release/pending`]])
  for (const [reads, expectedGets, expectedWaits, error] of [
    [[sha, sha, sha, sha, sha], 5, 4, /readback mismatch/i],
    [['identity'], 1, 0, /readback mismatch/i],
    [[sha, 'closed'], 2, 1, /readback mismatch/i],
    [['labels'], 1, 0, /readback mismatch/i],
    [[sha, 'e'.repeat(40)], 2, 1, /readback mismatch/i],
    [[sha, 'failure'], 2, 1, /GET failed/i],
  ] as const) {
    ref = sha
    committed = false
    readbackHeads = [...reads]
    commands.length = 0
    writes.length = 0
    wait.mockClear()
    expect(() => prepare()).toThrow(error)
    expect(commands.filter(line => line === 'gh api repos/fro-bot/dashboard/pulls/42')).toHaveLength(expectedGets)
    expect(wait).toHaveBeenCalledTimes(expectedWaits)
    expect(writes).toEqual([['git', 'push', `--force-with-lease=refs/heads/release/pending:${sha}`, 'origin', `${nextHead}:refs/heads/release/pending`]])
  }
  wait.mockRestore()
  committed = false
  unrelated = true
  commands.length = 0
  expect(() => prepare()).toThrow(/unknown|reconcile/i)
  expect(commands.some(line => line.startsWith('git push'))).toBe(false)
})

describe('review transport', () => {
  it('rechecks an exact-head approval before one pinned App merge and refuses ambiguous PRs', () => {
    const main = 'b'.repeat(40)
    const pr = {number: 42, state: 'open', merged_at: null, user: {id: 109017866, login: 'fro-bot[bot]'}, head: {sha, ref: 'release/pending', repo: {full_name: 'fro-bot/dashboard'}}, base: {ref: 'main', repo: {full_name: 'fro-bot/dashboard'}}, labels: [{name: 'release-hold'}]}
    const calls: {cmd: string; args: string[]; write: boolean}[] = []
    let ambiguous = false
    let unsettled = false
    let refSha = sha
    let mismatch = false
    let checks = [{state: 'SUCCESS'}]
    const run = (cmd: string, args: string[], write = false): string => {
      calls.push({cmd, args, write})
      if (cmd === 'docker') return `sha256:${(mismatch && args[3]?.endsWith(':latest') ? 'd' : 'c').repeat(64)}\n`
      if (cmd === 'git') {
        if (args[0] === 'rev-parse' && args[1]?.startsWith('refs/tags/')) return main
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return main
        if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'false'
        if (args[0] === 'rev-list') return `${sha} ${main}`
        if (args[0] === 'diff') return 'docs/releases/batch.md'
        if (args[0] === 'cat-file') return ''
        throw new Error(`Unexpected git: ${args.join(' ')}`)
      }
      if (write) return JSON.stringify({merged: true})
      if (args[0] === 'pr') return JSON.stringify(checks)
      const path = args.find(arg => arg.startsWith('repos/')) ?? ''
      if (path.includes('/pulls?')) return JSON.stringify([[pr, ...(ambiguous ? [{...pr, number: 43}] : []), ...(unsettled ? [{...pr, number: 44, state: 'closed', merged_at: '2026-11-18T15:00:00Z', merge_commit_sha: sha}] : [])]])
      if (path.endsWith('/pulls/42')) return JSON.stringify(pr)
      if (path.endsWith('/pulls/44')) return JSON.stringify({...pr, number: 44, state: 'closed', merged: true, merged_at: '2026-11-18T15:00:00Z', merge_commit_sha: sha, merged_by: {type: 'Bot', id: 109017866, login: 'fro-bot[bot]'}})
      if (path.endsWith('/git/ref/heads/main')) return JSON.stringify({object: {sha: main}})
      if (path.endsWith('/git/ref/heads/release/pending')) return JSON.stringify({object: {sha: refSha}})
      if (path.endsWith('/releases/latest')) return JSON.stringify({tag_name: '2026.11.1', body: `Source: ${main}\nDigest: ghcr.io/fro-bot/dashboard@sha256:${'c'.repeat(64)}`})
      if (path.endsWith('/pulls/42/reviews?per_page=100')) return JSON.stringify([[{user: {id: 831617}, state: 'APPROVED', commit_id: sha}]])
      if (path.endsWith('/issues/42/events?per_page=100')) return JSON.stringify([[]])
      throw new Error(`Unexpected gh: ${args.join(' ')}`)
    }
    const env = {GITHUB_REPOSITORY: 'fro-bot/dashboard', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1'}
    expect(runPending('review', env, run)).toMatch(/merged/i)
    expect(calls.filter(call => call.cmd === 'docker').map(call => call.args)).toEqual([
      ['buildx', 'imagetools', 'inspect', 'ghcr.io/fro-bot/dashboard:2026.11.1', '--format', '{{.Manifest.Digest}}'],
      ['buildx', 'imagetools', 'inspect', 'ghcr.io/fro-bot/dashboard:latest', '--format', '{{.Manifest.Digest}}'],
    ])
    const writes = calls.filter(call => call.write)
    expect(writes).toEqual([{cmd: 'gh', args: mergeArguments('fro-bot/dashboard', 42, sha), write: true}])
    expect(calls.at(-2)?.args.join(' ')).toContain('/reviews?')
    for (const result of [[], [{state: 'PENDING'}], [{state: 'FAILURE'}]]) {
      checks = result
      calls.length = 0
      expect(runPending('review', env, run)).toBe('Required checks are not green.')
      expect(calls.some(call => call.write)).toBe(false)
    }
    checks = [{state: 'SUCCESS'}]
    calls.length = 0
    pr.labels = []
    expect(runPending('review', env, run)).toMatch(/hold.*unproven/i)
    expect(calls.some(call => call.write)).toBe(false)
    pr.labels = [{name: 'release-hold'}]
    calls.length = 0
    mismatch = true
    expect(() => runPending('review', env, run)).toThrow(/digest/i)
    expect(calls.some(call => call.write)).toBe(false)
    mismatch = false
    calls.length = 0
    refSha = main
    expect(() => runPending('review', env, run)).toThrow(/ref/i)
    expect(calls.some(call => call.write)).toBe(false)
    refSha = sha
    calls.length = 0
    unsettled = true
    expect(runPending('review', env, run)).toMatch(/publication|settle/i)
    expect(calls.some(call => call.write)).toBe(false)
    unsettled = false
    calls.length = 0
    ambiguous = true
    expect(() => runPending('review', env, run)).toThrow(/ambiguous/i)
    expect(calls.some(call => call.write)).toBe(false)
  })
})

describe('merge decisions', () => {
  const approval = {user: {id: 831617}, state: 'APPROVED', commit_id: sha}
  const input = {head: sha, held: true, previousUnheld: false, holdEvents: [], reviews: [approval]}

  it('requires the latest decisive owner approval on the exact head for review', () => {
    expect(canRelease('review', input)).toBe(true)
    expect(canRelease('review', {...input, head: other})).toBe(false)
    expect(canRelease('review', {...input, reviews: [approval, {...approval, state: 'DISMISSED'}]})).toBe(false)
    expect(canRelease('review', {...input, reviews: [approval, {...approval, state: 'CHANGES_REQUESTED'}]})).toBe(false)
  })

  it('fails closed on schedule without proof of hold removal', () => {
    expect(canRelease('schedule', input)).toBe(false)
    expect(canRelease('schedule', {...input, held: false})).toBe(false)
    expect(canRelease('schedule', {...input, held: false, previousUnheld: true})).toBe(true)
    expect(canRelease('schedule', {...input, held: false, holdEvents: [{event: 'unlabeled', actor: {id: 831617}}]})).toBe(true)
    expect(canRelease('schedule', {...input, held: false, holdEvents: [{event: 'unlabeled', actor: {id: 99}}]})).toBe(false)
    expect(canRelease('schedule', {...input, held: false, previousUnheld: true, holdEvents: [{event: 'labeled', actor: {id: 831617}}]})).toBe(false)
  })

  it('skips schedule retries and a merge already made in the slot', () => {
    const slot = '2026-11-18T15:00:00Z'
    expect(scheduleAttemptAllowed('1', slot, null)).toBe(true)
    expect(scheduleAttemptAllowed('2', slot, null)).toBe(false)
    expect(scheduleAttemptAllowed('1', slot, '2026-11-18T15:01:00Z')).toBe(false)
    expect(scheduleAttemptAllowed('1', slot, '2026-11-18T14:59:00Z')).toBe(true)
    expect(scheduleAttemptAllowed('1', slot, 'unknown')).toBe(false)
  })

  it('pins the exact head and squash method in the merge request', () => {
    expect(mergeArguments('fro-bot/dashboard', 42, sha)).toEqual([
      'api', '--method', 'PUT', 'repos/fro-bot/dashboard/pulls/42/merge', '-f', 'merge_method=squash', '-f', `sha=${sha}`,
    ])
    expect(() => mergeArguments('fro-bot/dashboard', 42, 'main')).toThrow()
  })
})
