import {Buffer} from 'node:buffer'
import {spawnSync} from 'node:child_process'
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs'
import process from 'node:process'

import {renderReleaseBatch} from './release-batch.ts'

interface Review {user: {id: number}; state: string; commit_id: string}
interface HoldEvent {event: string; actor: {id: number}}
interface Decision {head: string; held: boolean; previousUnheld: boolean; holdEvents: HoldEvent[]; reviews: Review[]}

export function baselineFromRelease(release: {tag_name: string; body: string}, tagSha: string): {source: string; digest: string} {
  const tag = /^\d{4}\.(\d{2})\.(?:0|[1-9]\d*)$/.exec(release.tag_name)
  const sources = [...release.body.matchAll(/^Source: ([^\r\n]*)\r?$/gm)]
  const digests = [...release.body.matchAll(/^Digest: ([^\r\n]*)\r?$/gm)]
  const source = sources[0]?.[1]
  const digest = /^ghcr\.io\/fro-bot\/dashboard@(sha256:[0-9a-f]{64})$/.exec(digests[0]?.[1] ?? '')?.[1]
  if (!tag || Number(tag[1]) < 1 || Number(tag[1]) > 12 ||
    sources.length !== 1 || source === undefined || !/^[0-9a-f]{40}$/.test(source) ||
    digests.length !== 1 || digest === undefined || source !== tagSha) {
    throw new Error('Latest release is incomplete or does not match its tag; investigate publication before continuing.')
  }
  return {source, digest}
}

// Arrays must be complete and in GitHub chronological order, oldest first.
export function canRelease(mode: 'review' | 'schedule', input: Decision): boolean {
  if (mode === 'review') {
    const review = input.reviews.findLast(r => r.user.id === 831617 && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    return review?.state === 'APPROVED' && review.commit_id === input.head
  }
  if (input.held) return false
  const event = input.holdEvents.findLast(e => e.event === 'labeled' || e.event === 'unlabeled')
  return event ? event.event === 'unlabeled' && event.actor.id === 831617 : input.previousUnheld
}

// slot must come from the trusted scheduled invocation; null means no predecessor.
export function scheduleAttemptAllowed(attempt: string, slot: string, lastMergedAt: string | null): boolean {
  const start = Date.parse(slot)
  const last = lastMergedAt === null ? null : Date.parse(lastMergedAt)
  return attempt === '1' && Number.isFinite(start) && (last === null || (Number.isFinite(last) && last < start))
}

export function mergeArguments(repo: string, number: number, sha: string): string[] {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('Invalid merge target')
  }
  return ['api', '--method', 'PUT', `repos/${repo}/pulls/${number}/merge`, '-f', 'merge_method=squash', '-f', `sha=${sha}`]
}

interface Pull {
  number: number
  state: string
  merged_at: string | null
  merge_commit_sha: string | null
  merged?: boolean
  merged_by?: {type: string; id: number; login: string} | null
  user: {id: number; login: string}
  head: {sha: string; ref: string; repo: {full_name: string}}
  base: {ref: string; repo: {full_name: string}}
  labels: {name: string}[]
}
type Runner = (command: string, args: string[], write?: boolean) => string
const objectId = /^[0-9a-f]{40}$/

// The caller supplies only environment from a trusted main workflow and a local, full checkout.
export function runPending(mode: 'prepare' | 'review' | 'schedule', env: NodeJS.ProcessEnv, run: Runner, render = renderReleaseBatch, write = (text: string) => {
  mkdirSync('docs/releases', {recursive: true})
  writeFileSync('docs/releases/batch.md', text)
}): string {
  const repo = env.GITHUB_REPOSITORY
  if (repo !== 'fro-bot/dashboard') throw new Error('Unexpected repository')
  const api = (path: string, paginate = false): unknown => JSON.parse(run('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), `repos/${repo}/${path}`]))
  const pages = (value: unknown): unknown[] => {
    if (!Array.isArray(value) || !value.every(Array.isArray)) throw new Error('Invalid paginated response')
    return value.flat()
  }
  const identity = (p: Pull): boolean => p.user?.id === 109017866 && p.user.login === 'fro-bot[bot]' &&
    p.head?.ref === 'release/pending' && p.head.repo?.full_name === repo &&
    p.base?.ref === 'main' && p.base.repo?.full_name === repo
  const all = pages(api('pulls?state=all&head=fro-bot%3Arelease%2Fpending&base=main&per_page=100', true)) as Pull[]
  if (all.some(p => !identity(p) || !Number.isSafeInteger(p.number) || p.number <= 0)) throw new Error('Ambiguous generated pull requests')
  const open = all.filter(p => p.state === 'open')
  if (open.length > 1) throw new Error('Ambiguous open pull requests')
  if (!open.length && mode !== 'prepare') return 'No pending release PR.'
  const merged = all.filter(p => p.merged_at !== null && p.merged_at !== undefined)
  if (merged.some(p => !Number.isFinite(Date.parse(p.merged_at ?? '')) || !objectId.test(p.merge_commit_sha ?? '') || !Array.isArray(p.labels))) throw new Error('Invalid merged predecessor')
  merged.sort((a, b) => Date.parse(b.merged_at ?? '') - Date.parse(a.merged_at ?? ''))
  if (merged.length > 1 && merged[0]?.merged_at === merged[1]?.merged_at) throw new Error('Ambiguous merged predecessor')
  let previous: Pull | undefined
  let newestHuman = false
  for (const row of merged) {
    const detail = api(`pulls/${row.number}`) as Pull
    if (!identity(detail) || detail.number !== row.number || detail.state !== 'closed' || detail.merged !== true ||
      detail.merge_commit_sha !== row.merge_commit_sha || detail.merged_at !== row.merged_at || !Array.isArray(detail.labels)) {
      throw new Error('Invalid merged predecessor detail')
    }
    const merger = detail.merged_by
    if (merger?.type === 'Bot' && merger.id === 109017866 && merger.login === 'fro-bot[bot]') {
      previous = detail
      break
    }
    if (merger?.type !== 'User' || !Number.isSafeInteger(merger.id) || merger.id <= 0 || merger.id === 109017866 ||
      typeof merger.login !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(merger.login)) {
      throw new Error('Unknown merged predecessor merger')
    }
    if (row === merged[0]) newestHuman = true
  }
  const previousUnheld = !newestHuman && previous !== undefined && !previous.labels.some(label => label.name === 'release-hold')

  if (mode === 'schedule') {
    if (env.GITHUB_EVENT_NAME !== 'schedule' || env.GITHUB_RUN_ATTEMPT !== '1' || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')) return 'Not a first scheduled attempt.'
    const workflowRun = api(`actions/runs/${env.GITHUB_RUN_ID}`) as {created_at?: string; event?: string}
    const created = new Date(workflowRun.created_at ?? '')
    const now = new Date()
    if (workflowRun.event !== 'schedule' || !Number.isFinite(created.getTime()) || ![0, 3].includes(created.getUTCDay()) ||
      created.getUTCHours() !== 15 || now.getUTCHours() !== 15 || created.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) return 'Scheduled run is outside its UTC slot.'
    const slot = `${created.toISOString().slice(0, 10)}T15:00:00Z`
    if (!scheduleAttemptAllowed(env.GITHUB_RUN_ATTEMPT, slot, merged[0]?.merged_at ?? null)) return 'Release already merged in this slot.'
  }

  const release = api('releases/latest') as {tag_name: string; body: string}
  if (typeof release.tag_name !== 'string' || typeof release.body !== 'string' || !/^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/.test(release.tag_name)) throw new Error('Invalid latest release')
  const tagSha = run('git', ['rev-parse', `refs/tags/${release.tag_name}^{commit}`]).trim()
  const {source, digest} = baselineFromRelease(release, tagSha)
  if (previous && previous.merge_commit_sha !== source) return 'Previous batch publication has not settled; no action taken.'
  for (const tag of [release.tag_name, 'latest']) {
    const actual = run('docker', ['buildx', 'imagetools', 'inspect', `ghcr.io/fro-bot/dashboard:${tag}`, '--format', '{{.Manifest.Digest}}']).trim()
    if (actual !== digest) throw new Error(`Published image digest mismatch for ${tag}; no action taken.`)
  }

  if (mode === 'prepare') {
    const main = (api('git/ref/heads/main') as {object?: {sha?: string}}).object?.sha
    if (main === undefined || !objectId.test(main)) throw new Error('Invalid main ref')
    if (run('git', ['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new Error('Full Git history required')
    if (run('git', ['rev-parse', 'HEAD']).trim() !== main) return 'Main checkout is stale; preparation skipped.'
    const notes = render(process.cwd(), source, main)
    if (notes === null) return 'No release notes to prepare.'
    const remote = run('git', ['remote', 'get-url', 'origin']).trim()
    if (remote !== 'https://github.com/fro-bot/dashboard' && remote !== 'https://github.com/fro-bot/dashboard.git') throw new Error('Unexpected origin; reconcile manually')
    const ref = 'refs/heads/release/pending'
    const remoteLine = run('git', ['ls-remote', '--refs', 'origin', ref]).trim()
    const parts = remoteLine === '' ? [] : remoteLine.split(/\s+/)
    if (parts.length !== 0 && (parts.length !== 2 || !objectId.test(parts[0] ?? '') || parts[1] !== ref)) throw new Error('Ambiguous pending ref; reconcile manually')
    const old = parts[0] ?? ''
    const existing = open[0]
    if (existing && (old !== existing.head.sha || !objectId.test(existing.head.sha))) throw new Error('Pending PR and branch disagree; reconcile manually')
    let unchanged = false
    if (old !== '') {
      try {
        unchanged = run('git', ['rev-list', '--parents', '-n', '1', old]).trim() === `${old} ${main}` &&
          run('git', ['diff', '--no-renames', '--name-only', main, old]).trim() === 'docs/releases/batch.md' &&
          run('git', ['show', `${old}:docs/releases/batch.md`]) === notes
      } catch { /* An unknown object is not safe to overwrite. */ }
      if (existing && !unchanged) {
        const parents = run('git', ['rev-list', '--parents', '-n', '1', old]).trim().split(' ')
        if (parents.length !== 2 || parents[0] !== old || !objectId.test(parents[1] ?? '') ||
          run('git', ['diff', '--no-renames', '--name-only', parents[1] ?? '', old]).trim() !== 'docs/releases/batch.md' ||
          run('git', ['show', '-s', '--format=%ae', old]).trim() !== '109017866+fro-bot[bot]@users.noreply.github.com') {
          throw new Error('Unknown pending PR head; reconcile manually')
        }
      }
      if (!existing && !unchanged && !all.some(p => p.state === 'closed' && p.head.sha === old)) throw new Error('Unknown pending branch; reconcile manually')
    }
    let head = old
    if (!unchanged) {
      if (run('git', ['status', '--porcelain']).trim() !== '') throw new Error('Checkout is not clean; preparation stopped')
      if ((api('git/ref/heads/main') as {object?: {sha?: string}}).object?.sha !== main) return 'Main advanced; preparation skipped.'
      write(notes)
      run('git', ['add', '--', 'docs/releases/batch.md'])
      if (run('git', ['diff', '--cached', '--name-only']).trim() !== 'docs/releases/batch.md') throw new Error('Expected a notes-only change')
      run('git', ['-c', 'user.name=fro-bot[bot]', '-c', 'user.email=109017866+fro-bot[bot]@users.noreply.github.com', 'commit', '--no-gpg-sign', '-m', 'chore: prepare release notes'])
      head = run('git', ['rev-parse', 'HEAD']).trim()
      if (!objectId.test(head) || run('git', ['rev-list', '--parents', '-n', '1', head]).trim() !== `${head} ${main}`) throw new Error('Generated commit has unexpected parent')
      run('git', ['push', `--force-with-lease=${ref}:${old}`, 'origin', `${head}:${ref}`], true)
    }
    let pr = existing
    if (!pr) {
      pr = JSON.parse(run('gh', ['api', '--method', 'POST', `repos/${repo}/pulls`, '-f', 'title=chore: prepare release notes', '-f', 'head=release/pending', '-f', 'base=main', '-f', 'body=Generated release notes.\n\n**Approve to release:** When the required checks pass, submit an **Approve** review. The App merges the pull request and starts Release. Do not click **Merge**.'], true)) as Pull
    }
    if (!identity(pr) || !Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error('Unexpected created PR; reconcile manually')
    let current = api(`pulls/${pr.number}`) as Pull
    if (!identity(current) || current.state !== 'open' || current.number !== pr.number || current.head.sha !== head || !Array.isArray(current.labels)) throw new Error('Pending PR readback mismatch')
    const requiredHold = !previousUnheld
    if (requiredHold && !current.labels.some(label => label.name === 'release-hold')) {
      const events = pages(api(`issues/${pr.number}/events?per_page=100`, true)) as (HoldEvent & {label?: {name: string}})[]
      const last = events.findLast(event => event.label?.name === 'release-hold')
      if (!(last?.event === 'unlabeled' && last.actor.id === 831617)) {
        run('gh', ['api', '--method', 'POST', `repos/${repo}/issues/${pr.number}/labels`, '-f', 'labels[]=release-hold'], true)
        current = api(`pulls/${pr.number}`) as Pull
        if (!identity(current) || current.head.sha !== head || !current.labels.some(label => label.name === 'release-hold')) throw new Error('Hold label initialization failed')
      }
    }
    return unchanged ? 'Pending release PR is up to date.' : 'Pending release PR prepared.'
  }

  const pr = api(`pulls/${open[0]?.number}`) as Pull
  const main = (api('git/ref/heads/main') as {object?: {sha?: string}}).object?.sha
  if (!identity(pr) || pr.number !== open[0]?.number || pr.state !== 'open' || !objectId.test(pr.head.sha) || main === undefined || !objectId.test(main) || !Array.isArray(pr.labels)) throw new Error('Invalid pending PR')
  const reserved = (api('git/ref/heads/release/pending') as {object?: {sha?: string}}).object?.sha
  if (reserved !== pr.head.sha) throw new Error('Reserved branch ref does not match PR head')
  if (run('git', ['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new Error('Full Git history required')
  if (run('git', ['rev-parse', 'HEAD']).trim() !== main) return 'Main checkout is stale; merge skipped.'
  run('git', ['cat-file', '-e', `${pr.head.sha}^{commit}`])
  if (run('git', ['rev-list', '--parents', '-n', '1', pr.head.sha]).trim() !== `${pr.head.sha} ${main}` ||
    run('git', ['diff', '--no-renames', '--name-only', main, pr.head.sha]).trim() !== 'docs/releases/batch.md') throw new Error('Pending head is not a notes-only child of main')
  const checks = JSON.parse(run('gh', ['pr', 'checks', String(pr.number), '--repo', repo, '--required', '--json', 'state'])) as {state: string}[]
  if (!Array.isArray(checks)) throw new Error('Invalid required checks')
  if (checks.length === 0 || checks.some(check => !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.state))) return 'Required checks are not green.'
  const current = api(`pulls/${pr.number}`) as Pull
  if (!identity(current) || current.number !== pr.number || current.state !== 'open' || current.head.sha !== pr.head.sha || !Array.isArray(current.labels)) throw new Error('Pending PR changed during preflight')
  const held = current.labels.some(label => label.name === 'release-hold')
  const decision: Decision = {head: pr.head.sha, held, previousUnheld, holdEvents: [], reviews: []}
  if (!held) {
    const events = pages(api(`issues/${pr.number}/events?per_page=100`, true)) as (HoldEvent & {label?: {name: string}})[]
    decision.holdEvents = events.filter(event => event.label?.name === 'release-hold')
    if (!canRelease('schedule', decision)) return 'Hold initialization or owner removal is unproven; prepare must reconcile it.'
  }
  if (mode === 'review') decision.reviews = pages(api(`pulls/${pr.number}/reviews?per_page=100`, true)) as Review[]
  if (!canRelease(mode, decision)) return mode === 'review' ? 'No current owner approval.' : 'Release is held or hold removal is unproven.'
  const result = JSON.parse(run('gh', mergeArguments(repo, pr.number, pr.head.sha), true)) as {merged?: boolean}
  if (result.merged !== true) throw new Error('GitHub did not merge the release PR')
  return 'Release PR merged; publication is handled by Release.'
}

if (import.meta.main) {
  try {
    const mode = process.argv[2]
    if (mode !== 'prepare' && mode !== 'review' && mode !== 'schedule') throw new Error('Expected prepare, review, or schedule.')
    const run: Runner = (command, args, write = false) => {
      const env = {...process.env}
      delete env.RELEASE_APP_TOKEN
      if (command === 'git' && args.includes('commit')) {
        env.GIT_AUTHOR_NAME = 'fro-bot[bot]'
        env.GIT_COMMITTER_NAME = 'fro-bot[bot]'
        env.GIT_AUTHOR_EMAIL = '109017866+fro-bot[bot]@users.noreply.github.com'
        env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL
      }
      if (write) {
        if ((process.env.RELEASE_APP_TOKEN?.length ?? 0) === 0) throw new Error('Missing release App token')
        env.GH_TOKEN = process.env.RELEASE_APP_TOKEN
        if (command === 'git') {
          const origin = spawnSync('git', ['remote', 'get-url', 'origin'], {encoding: 'utf8', env: {...env, GH_TOKEN: ''}})
          const url = origin.stdout.trim()
          if (origin.status !== 0 || !['https://github.com/fro-bot/dashboard', 'https://github.com/fro-bot/dashboard.git'].includes(url)) throw new Error('Unexpected origin for authenticated push')
          env.GIT_CONFIG_COUNT = '1'
          env.GIT_CONFIG_KEY_0 = `http.${url}.extraheader`
          env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.RELEASE_APP_TOKEN}`).toString('base64')}`
        }
      }
      const result = spawnSync(command, args, {encoding: 'utf8', env})
      if (result.error || result.status !== 0) {
        // gh returns nonzero for valid non-green check JSON; malformed output remains an error.
        if (command === 'gh' && args[0] === 'pr' && result.stdout) {
          const parsed: unknown = JSON.parse(result.stdout)
          if (Array.isArray(parsed) && parsed.length > 0) return result.stdout
        }
        throw new Error(`${command} failed: ${result.stderr || (result.error?.message ?? String(result.status))}`)
      }
      return result.stdout
    }
    const note = runPending(mode, process.env, run)
    console.log(note)
    if (typeof process.env.GITHUB_STEP_SUMMARY === 'string' && process.env.GITHUB_STEP_SUMMARY.length > 0) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${note}\n`)
  } catch (error) {
    const note = `Release pending stopped: ${error instanceof Error ? error.message : String(error)}`
    console.error(note)
    if (typeof process.env.GITHUB_STEP_SUMMARY === 'string' && process.env.GITHUB_STEP_SUMMARY.length > 0) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${note}\n`)
    process.exitCode = 1
  }
}
