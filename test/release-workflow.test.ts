/**
 * Pins the trusted controller and publisher in .github/workflows/held-release.yaml and the
 * wake-only signal in held-release-review.yaml, and that no other workflow can release.
 *
 * The publication token is minted from a GitHub App whose installation is broader than the
 * release needs, so the mint-time `permission-*` inputs, and the omitted `owner` and
 * `repositories`, are the only thing that narrows it. These tests keep that from being dropped.
 *
 * The held workflow's shell steps are executed here with fake `gh`/`node` binaries, so the
 * wrong-source, no-input, attempt and readback outcomes are behavior, not string matches.
 */
/* eslint-disable no-template-curly-in-string -- GitHub Actions expressions are literal strings under test */
import {spawnSync} from 'node:child_process'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import process from 'node:process'
import {afterEach, describe, expect, it} from 'vitest'
import {parse} from 'yaml'
import {parsePublishInput} from '../scripts/release/publisher.ts'

// ---------------------------------------------------------------------------------------------
// held-release.yaml: trusted controller and publisher, disabled by a static startup baseline.
// ---------------------------------------------------------------------------------------------

interface HeldStep {
  readonly id?: string
  readonly name?: string
  readonly if?: string
  readonly uses?: string
  readonly with?: Record<string, unknown>
  readonly env?: Record<string, string>
  readonly run?: string
}

interface HeldJob {
  readonly if?: string
  readonly needs?: string | readonly string[]
  readonly permissions?: Record<string, string>
  readonly environment?: string
  readonly 'continue-on-error'?: boolean
  readonly outputs?: Record<string, string>
  readonly steps: readonly HeldStep[]
}

interface HeldWorkflow {
  readonly on: Record<string, unknown>
  readonly env?: Record<string, string>
  readonly concurrency?: Record<string, unknown>
  readonly permissions: Record<string, string>
  readonly jobs: Record<string, HeldJob>
}

const heldText = readFileSync(resolve(process.cwd(), '.github/workflows/held-release.yaml'), 'utf8')
const held = parse(heldText) as HeldWorkflow
const reviewText = readFileSync(resolve(process.cwd(), '.github/workflows/held-release-review.yaml'), 'utf8')
const review = parse(reviewText) as {name: string; on: Record<string, unknown>; permissions: unknown; jobs: Record<string, {permissions?: unknown; steps: {uses?: string; run?: string; env?: unknown; with?: unknown}[]}>}

const SOURCE = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const VERSION = '2026.11.3'
const DIGEST = `sha256:${'2'.repeat(64)}`
const PREDECESSOR = {version: '2026.11.2', digest: `sha256:${'1'.repeat(64)}`}
const NOTES = '## Release\n\n- Add held releases (#1)\n'

const heldJob = (name: string): HeldJob => {
  const job = held.jobs[name]
  if (job === undefined) throw new Error(`job ${name} not found`)
  return job
}
const heldStep = (job: string, id: string): HeldStep => {
  const step = heldJob(job).steps.find(candidate => candidate.id === id)
  if (step === undefined) throw new Error(`step ${id} not found in job ${job}`)
  return step
}
const condition = (job: HeldJob) => (job.if ?? '').replaceAll(/^\$\{\{\s*|\s*\}\}$/gu, '').trim()
const needsOf = (job: HeldJob): string[] => (job.needs === undefined ? [] : typeof job.needs === 'string' ? [job.needs] : [...job.needs])
const secretsIn = (value: unknown): string[] => [...new Set([...JSON.stringify(value).matchAll(/secrets\.(\w+)/gu)].map(match => match[1] ?? ''))].sort()
const permissionKeys = (step: HeldStep) => Object.keys(step.with ?? {}).filter(name => name.startsWith('permission-'))
const downstream = Object.keys(held.jobs).filter(name => name !== 'controller')

function closure(name: string, seen = new Set<string>()): Set<string> {
  for (const need of needsOf(heldJob(name))) {
    if (!seen.has(need)) {
      seen.add(need)
      closure(need, seen)
    }
  }
  return seen
}

describe('release workflows — only the held workflow can release', () => {
  const dir = resolve(process.cwd(), '.github/workflows')
  const files = readdirSync(dir).filter(name => /\.ya?ml$/u.test(name)).sort()
  const read = (name: string) => readFileSync(join(dir, name), 'utf8')

  it('has retired the unconditional legacy release workflow', () => {
    expect(existsSync(join(dir, 'release.yaml'))).toBe(false)
    expect(existsSync(join(dir, 'release.yml'))).toBe(false)
    expect(files).toContain('held-release.yaml')
    expect(files).toContain('held-release-review.yaml')
    // No remaining workflow is named Release, so nothing can wake on it or re-run it by name.
    for (const name of files) expect(parse(read(name)) as {name?: string}, name).not.toMatchObject({name: 'Release'})
  })

  it('leaves image publication, release writes and infra dispatch to the held workflow alone', () => {
    for (const name of files.filter(file => file !== 'held-release.yaml')) {
      expect(read(name), name).not.toMatch(/deploy-dashboard|docker\/build-push-action|gh release|git\/refs|imagetools|permission-contents: write|packages: write/u)
    }
  })

  it('wakes only the held workflow from other workflows, and offers it no pull-request route', () => {
    for (const name of files) {
      const on = (parse(read(name)) as {on?: Record<string, {workflows?: string[]} | null>}).on ?? {}
      if (name !== 'held-release.yaml') expect(on.workflow_run?.workflows ?? [], name).not.toContain('Held Release')
    }
    expect(Object.keys(held.on)).not.toEqual(expect.arrayContaining(['pull_request']))
    expect(heldText).not.toMatch(/pull_request_target|\bfork\b/u)
  })
})

describe('held release workflow — triggers and startup', () => {
  it('has only the trusted default-branch triggers, none with source, version or window authority', () => {
    expect(Object.keys(held.on).sort()).toEqual(['push', 'schedule', 'workflow_dispatch', 'workflow_run'])
    // The push spec itself (main, no path filter) is pinned with the classifier in should-release.test.ts.
    expect(Object.keys(held.on.push as object)).toEqual(['branches'])
    // Two separate strings, so a slot is identifiable from the cron that fired and never from a rerun date.
    expect(held.on.schedule).toEqual([{cron: '0 15 * * 0'}, {cron: '0 15 * * 3'}])
    expect(held.on.workflow_run).toEqual({workflows: [review.name], types: ['completed']})
    expect(held.on.workflow_dispatch).toEqual({inputs: {'prepare-only': {description: expect.any(String) as string, type: 'boolean', default: false}}})
    expect(held.permissions).toEqual({contents: 'read'})
  })

  it('is not a reusable workflow and takes no inherited secrets', () => {
    expect(heldText).not.toMatch(/workflow_call|secrets: inherit|\bqueue\b/u)
    expect(JSON.stringify(held.on)).not.toContain('workflow_call')
  })

  it('starts disabled from a checked-in constant, not from a repository variable', () => {
    expect(held.env).toEqual({HELD_RELEASE_ACTIVE: 'false'})
    expect(heldText).not.toMatch(/\bvars\./u)
  })

  it('serializes the controller and the publisher under one group without cancelling', () => {
    expect(held.concurrency).toEqual({group: 'held-release', 'cancel-in-progress': false})
    for (const [name, job] of Object.entries(held.jobs)) expect(JSON.stringify(job), name).not.toContain('concurrency')
  })

  it('states only the controller output contract and gives no caller advice', () => {
    expect(heldText).not.toMatch(/outputs\.notes|steps\.prove\.outputs/u)
    const header = heldText.slice(0, heldText.indexOf('\nname: Held Release'))
    expect(header.split('\n').length).toBeLessThanOrEqual(16)
  })

  it('carries no issue-number pointer', () => {
    expect(heldText).not.toMatch(/#\d/u)
  })

  it('takes no source, version, window or approval from the event or any input but the rehearsal flag', () => {
    expect(heldText.replaceAll('inputs.prepare-only', '')).not.toMatch(/\binputs\./u)
    expect(heldText).not.toMatch(/github\.(?:sha|ref_name|head_ref|base_ref|event\.(?:inputs|client_payload|pull_request|review|workflow_run|head_commit|before|after|schedule))/u)
    // Only the controller reads the ref, to refuse anything but main.
    for (const name of downstream) expect(JSON.stringify(heldJob(name)), name).not.toMatch(/github\.ref\b/u)
  })

  it('ignores everything the triggering run carried', () => {
    expect(heldText).not.toMatch(/download-artifact|actions\/cache|workflow_run\./u)
  })
})

describe('held release workflow — review signal', () => {
  it('only wakes the controller: no checkout, artifact, cache, secret or write context', () => {
    expect(review.name).toBe('Held Release Review')
    expect(Object.keys(review.on)).toEqual(['pull_request_review'])
    expect(review.on.pull_request_review).toEqual({types: ['submitted', 'dismissed']})
    expect(review.permissions).toEqual({})
    expect(Object.keys(review.jobs)).toHaveLength(1)
    for (const job of Object.values(review.jobs)) {
      expect(job.permissions).toEqual({})
      for (const step of job.steps) {
        expect(step.uses).toBeUndefined()
        expect(step.env).toBeUndefined()
        expect(step.with).toBeUndefined()
        expect(step.run).not.toMatch(/\$|`/u)
      }
    }
    expect(reviewText).not.toMatch(/\$\{\{|secrets|checkout|artifact|cache|token|workflow_dispatch/iu)
  })
})

describe('held release workflow — controller', () => {
  const ids = () => heldJob('controller').steps.map(step => step.id)

  it('runs only for this repository on main, with read access and nothing more', () => {
    const controller = heldJob('controller')
    expect(condition(controller)).toBe("github.repository == 'fro-bot/dashboard' && github.ref == 'refs/heads/main'")
    expect(controller.permissions).toEqual({contents: 'read', actions: 'read', checks: 'read', statuses: 'read', 'pull-requests': 'read', issues: 'read', packages: 'read'})
    expect(ids()).toEqual(['trusted', 'trusted-head', 'mode', 'node', 'app-token', 'inspect', 'upload', 'finish', 'emit'])
  })

  it('checks out the exact trusted workflow revision with full history, without credentials', () => {
    expect(heldStep('controller', 'trusted').uses).toMatch(/^actions\/checkout@[0-9a-f]{40}\b/u)
    expect(heldStep('controller', 'trusted').with).toEqual({ref: '${{ github.workflow_sha }}', 'fetch-depth': 0, 'persist-credentials': false})
    expect(heldStep('controller', 'trusted-head').env).toEqual({
      WORKFLOW_SHA: '${{ github.workflow_sha }}', REPOSITORY: '${{ github.repository }}', REF: '${{ github.ref }}', WORKFLOW_REF: '${{ github.workflow_ref }}',
    })
    expect(ids().indexOf('trusted-head')).toBe(ids().indexOf('trusted') + 1)
    expect(ids().indexOf('trusted-head')).toBeLessThan(ids().indexOf('app-token'))
    expect(heldStep('controller', 'node').with).toEqual(heldStep('publish', 'node').with)
    expect(heldStep('controller', 'node').uses).toBe(heldStep('publish', 'node').uses)
  })

  it('mints the controller token last, current repository only, contents and pull-requests write only', () => {
    const mint = heldStep('controller', 'app-token')
    expect(mint.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}\b/u)
    expect(mint.if).toBe("${{ steps.mode.outputs.credentials == 'true' }}")
    expect(mint.with).toEqual({'app-id': '${{ secrets.APPLICATION_ID }}', 'private-key': '${{ secrets.APPLICATION_PRIVATE_KEY }}', 'permission-contents': 'write', 'permission-pull-requests': 'write'})
    expect(ids().indexOf('app-token')).toBeGreaterThan(ids().indexOf('node'))
    expect(ids().indexOf('app-token')).toBeLessThan(ids().indexOf('inspect'))
  })

  it('hands the CLI only named context and holds each credential in the CLI steps alone', () => {
    const common = {
      RELEASE_READ_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      RELEASE_APP_TOKEN: '${{ steps.app-token.outputs.token }}',
      RELEASE_APP_ID: "${{ steps.app-token.outcome == 'success' && secrets.APPLICATION_ID || '' }}",
      RELEASE_APP_SLUG: '${{ steps.app-token.outputs.app-slug }}',
      RELEASE_WORKFLOW_SHA: '${{ github.workflow_sha }}',
      RELEASE_WORKFLOW_REF: '${{ github.workflow_ref }}',
      RELEASE_PREPARE_ONLY: "${{ github.event_name == 'workflow_dispatch' && inputs.prepare-only == true }}",
      RELEASE_ACTOR_ID: '${{ github.actor_id }}',
    }
    expect(heldStep('controller', 'inspect').env).toEqual(common)
    expect(heldStep('controller', 'finish').env).toEqual({...common, ARTIFACT_ID: '${{ steps.upload.outputs.artifact-id }}'})
    const holders = heldJob('controller').steps.filter(step => /secrets\.GITHUB_TOKEN|app-token\.outputs\.token/u.test(JSON.stringify(step)))
    expect(holders.map(step => step.id)).toEqual(['inspect', 'finish'])
    expect(heldStep('controller', 'inspect').run).toBe('node scripts/release/run-controller.ts inspect\n')
  })

  it('uploads one immutable authorization artifact, only for an active run that asked for it', () => {
    const upload = heldStep('controller', 'upload')
    expect(upload.uses).toBe(heldStep('build', 'stage').uses)
    expect(upload.if).toBe("${{ steps.mode.outputs.release == 'true' && steps.inspect.outputs.authorize == 'true' }}")
    expect(upload.with).toEqual({
      name: 'release-authorization-${{ github.run_id }}-${{ github.run_attempt }}',
      path: '${{ runner.temp }}/release-authorization.json',
      'if-no-files-found': 'error',
    })
  })

  it('finishes only after a successful upload in an active run, with a bounded artifact id', () => {
    const finish = heldStep('controller', 'finish')
    expect(finish.if).toBe("${{ steps.mode.outputs.release == 'true' && steps.inspect.outputs.authorize == 'true' && steps.upload.outcome == 'success' }}")
    expect(finish.run).toContain('node scripts/release/run-controller.ts finish "$ARTIFACT_ID"')
    expect(finish.run).not.toContain('${{')
  })

  it('exposes the verified source contract only through the exclusive emit step', () => {
    const controller = heldJob('controller')
    expect(Object.keys(controller.outputs ?? {}).sort()).toEqual([
      'action', 'original-attempt', 'original-digest', 'original-run-id', 'original-verified', 'predecessor-digest', 'predecessor-version', 'recovery', 'source', 'version',
    ])
    for (const [name, expression] of Object.entries(controller.outputs ?? {})) expect(expression, name).toBe(`\${{ steps.emit.outputs.${name} }}`)
    expect(heldStep('controller', 'emit').env).toMatchObject({
      INSPECT_OUTPUTS: '${{ toJSON(steps.inspect.outputs) }}',
      FINISH_OUTPUTS: '${{ toJSON(steps.finish.outputs) }}',
      UPLOAD_OUTCOME: '${{ steps.upload.outcome }}',
      RELEASE: '${{ steps.mode.outputs.release }}',
    })
  })

  it('makes every other job need the controller directly and require its success', () => {
    expect(downstream.length).toBeGreaterThan(0)
    for (const name of downstream) {
      const job = heldJob(name)
      expect(needsOf(job), name).toContain('controller')
      expect(condition(job), name).toContain("needs.controller.result == 'success'")
      // Status functions are explicit and intentional: see the status-function test below.
      expect(/\balways\(\)/u.test(condition(job)), name).toBe(name === 'deploy-report')
    }
  })

  it('pins the intentional status-function bypass and the direct dependency gates', () => {
    // build and the no-write report aside, every job opts out of implicit success() with
    // !cancelled(), then names each direct dependency it needs; none may run without the controller.
    expect(condition(heldJob('build'))).not.toMatch(/\b(?:always|cancelled|failure)\(\)/u)
    const bypassing = downstream.filter(name => name !== 'build' && name !== 'deploy-report')
    expect(bypassing.sort()).toEqual(['candidate', 'dispatch-deploy', 'publish', 'seal', 'smoke', 'trivy'])
    for (const name of bypassing) {
      const text = condition(heldJob(name))
      expect(text.startsWith('!cancelled() && needs.controller.result'), name).toBe(true)
      expect(text, name).not.toMatch(/\balways\(\)|\bfailure\(\)/u)
      for (const need of needsOf(heldJob(name)).filter(dep => dep !== 'build')) expect(text, `${name} -> ${need}`).toContain(`needs.${need}.result == 'success'`)
    }
    // Only the candidate resolver tolerates a skipped ancestor, and only for a recovered `gate`.
    const candidate = condition(heldJob('candidate'))
    expect(candidate).toContain("needs.build.result == 'success'")
    expect(candidate).toContain("(needs.build.result == 'skipped' && needs.controller.outputs.action == 'gate')")
    for (const name of bypassing.filter(dep => dep !== 'candidate')) expect(condition(heldJob(name)), name).not.toContain('skipped')
    expect(condition(heldJob('deploy-report'))).toBe("always() && needs.controller.result == 'success' && needs.controller.outputs.source != ''")
  })

  it('has no write-bearing job reachable without the controller', () => {
    const writes = (job: HeldJob) => {
      const text = JSON.stringify(job)
      return /"(?:packages|security-events|contents)":"write"|permission-contents|app-token|GH_TOKEN|environment/u.test(text)
    }
    const bearing = downstream.filter(name => writes(heldJob(name)))
    expect(bearing.sort()).toEqual(['build', 'dispatch-deploy', 'publish', 'trivy'])
    for (const name of bearing) {
      expect(closure(name).has('controller'), name).toBe(true)
      expect(needsOf(heldJob(name)), name).toContain('controller')
    }
  })

  it('names every job whose success the publisher and the dispatch depend on', () => {
    expect(needsOf(heldJob('publish')).sort()).toEqual(['candidate', 'controller', 'seal', 'smoke', 'trivy'])
    expect(condition(heldJob('publish'))).toContain("needs.seal.result == 'success'")
    expect(needsOf(heldJob('dispatch-deploy')).sort()).toEqual(['controller', 'publish'])
  })
})

describe('held release workflow — controller (behavior)', () => {
  const trustedHead = () => heldStep('controller', 'trusted-head')
  const mode = () => heldStep('controller', 'mode')
  const emit = () => heldStep('controller', 'emit')
  const WF = 'fro-bot/dashboard/.github/workflows/held-release.yaml@refs/heads/main'

  it('accepts only this repository, the main ref and workflow, and the exact checked-out revision', () => {
    const r = makeRepo([NOTES, '## Later\n'])
    const [first, second] = r.shas
    const env = {WORKFLOW_SHA: second ?? '', REPOSITORY: 'fro-bot/dashboard', REF: 'refs/heads/main', WORKFLOW_REF: WF}
    expect(runStep(trustedHead, env, {}, r.path).status).toBe(0)
    for (const bad of [
      {WORKFLOW_SHA: first ?? ''}, {WORKFLOW_SHA: ''}, {WORKFLOW_SHA: 'main'}, {WORKFLOW_SHA: 'A'.repeat(40)}, {REPOSITORY: 'someone/dashboard'},
      {REF: 'refs/heads/feature'}, {REF: 'refs/pull/1/merge'}, {WORKFLOW_REF: WF.replace('refs/heads/main', 'refs/heads/feature')}, {WORKFLOW_REF: WF.replace('held-release', 'other')},
    ]) {
      expect(runStep(trustedHead, {...env, ...bad}, {}, r.path).status, JSON.stringify(bad)).not.toBe(0)
    }
  })

  const OWNER = '831617'
  const dispatch = (active: string, prepare: string, who = OWNER, attempt = '1') => ({HELD_RELEASE_ACTIVE: active, EVENT_NAME: 'workflow_dispatch', PREPARE_ONLY: prepare, GITHUB_ACTOR_ID: who, GITHUB_RUN_ATTEMPT: attempt})
  const other = (active: string, event: string, attempt = '1') => ({HELD_RELEASE_ACTIVE: active, EVENT_NAME: event, PREPARE_ONLY: 'false', GITHUB_ACTOR_ID: '49699333', GITHUB_RUN_ATTEMPT: attempt})
  const none = {release: 'false', credentials: 'false'}

  it.each([
    ['the checked-in baseline on a push', other('false', 'push'), none],
    ['the baseline on a schedule', other('false', 'schedule'), none],
    ['the baseline on a plain owner dispatch', dispatch('false', 'false'), none],
    ['the baseline on an owner prepare-only dispatch', dispatch('false', 'true'), {release: 'false', credentials: 'true'}],
    ['an active push', other('true', 'push'), {release: 'true', credentials: 'true'}],
    ['an active review wake-up', other('true', 'workflow_run'), {release: 'true', credentials: 'true'}],
    ['an active schedule rerun, whoever triggered it', other('true', 'schedule', '3'), {release: 'true', credentials: 'true'}],
    ['an active owner dispatch', dispatch('true', 'false'), {release: 'true', credentials: 'true'}],
    ['an active owner prepare-only dispatch', dispatch('true', 'true'), {release: 'false', credentials: 'true'}],
    ['a prepare flag on another event', {...other('false', 'schedule'), PREPARE_ONLY: 'true'}, none],
    ['an unrecognized activation value', other('yes', 'push'), none],
  ])('decides the mode for %s', (_name, env, expected) => {
    const ran = runStep(mode, env)
    expect(ran.status).toBe(0)
    expect(ran.outputs).toEqual(expected)
  })

  it.each([
    ['a non-owner', {who: '49699333'}],
    ['an unset actor', {who: ''}],
    ['a lookalike actor ID', {who: '8316170'}],
    ['an attempt after the first', {attempt: '2'}],
    ['an unset attempt', {attempt: ''}],
    ['a non-numeric attempt', {attempt: '1x'}],
    ['a non-owner on a later attempt', {who: '49699333', attempt: '2'}],
  ])('lets %s neither mint a token nor authorize, in every dispatch mode', (_name, {who, attempt}: {who?: string; attempt?: string}) => {
    for (const [active, prepare] of [['false', 'true'], ['true', 'true'], ['true', 'false'], ['false', 'false']] as const) {
      const ran = runStep(mode, dispatch(active, prepare, who ?? OWNER, attempt ?? '1'))
      expect(ran.status, `${active}/${prepare}`).toBe(0)
      expect(ran.outputs, `${active}/${prepare}`).toEqual(none)
    }
  })

  it('fixes the owner and takes the actor and attempt from the runner, not from an input', () => {
    const step = heldStep('controller', 'mode')
    expect(step.run).toContain('OWNER_ID=831617')
    expect(step.env).toEqual({EVENT_NAME: '${{ github.event_name }}', PREPARE_ONLY: "${{ github.event_name == 'workflow_dispatch' && inputs.prepare-only == true }}"})
    expect(step.run).toContain('${GITHUB_ACTOR_ID:-}')
    expect(step.run).toContain('${GITHUB_RUN_ATTEMPT:-}')
  })

  const fresh = {source: SOURCE, version: VERSION, action: 'build', 'predecessor-version': PREDECESSOR.version, 'predecessor-digest': PREDECESSOR.digest, recovery: 'false'}
  const recovered = {...fresh, recovery: 'true'}
  const gate = {action: 'gate', 'original-digest': DIGEST, 'original-run-id': '12345600321', 'original-attempt': '2', 'original-verified': 'true'}
  const emitEnv = (o: {inspect?: Record<string, string>; finish?: Record<string, string>; release?: string; upload?: string; event?: string}) => ({
    EVENT_NAME: o.event ?? 'push', RELEASE: o.release ?? 'true', UPLOAD_OUTCOME: o.upload ?? 'skipped',
    INSPECT_OUTPUTS: JSON.stringify(o.inspect ?? {}), FINISH_OUTPUTS: JSON.stringify(o.finish ?? {}),
  })

  it('emits the fresh source only from finish, after an upload', () => {
    const ran = runStep(emit, emitEnv({inspect: {authorize: 'true'}, finish: fresh, upload: 'success'}))
    expect(ran.status).toBe(0)
    expect(ran.outputs).toEqual({...fresh, 'original-digest': '', 'original-run-id': '', 'original-attempt': '', 'original-verified': ''})
  })

  it('emits a fresh gate source with its verified original attempt', () => {
    const ran = runStep(emit, emitEnv({inspect: {authorize: 'true'}, finish: {...fresh, ...gate}, upload: 'success'}))
    expect(ran.status).toBe(0)
    expect(ran.outputs).toMatchObject({action: 'gate', recovery: 'false', 'original-digest': DIGEST, 'original-run-id': '12345600321', 'original-attempt': '2', 'original-verified': 'true'})
  })

  it('emits an owner recovery source only from inspect, on a dispatch', () => {
    const ran = runStep(emit, emitEnv({inspect: {...recovered, ...gate}, event: 'workflow_dispatch'}))
    expect(ran.status).toBe(0)
    expect(ran.outputs).toMatchObject({source: SOURCE, recovery: 'true', action: 'gate'})
  })

  it.each([
    ['a disabled run that somehow reports a source', {release: 'false', inspect: fresh}],
    ['a run that prepared a PR', {inspect: {prepared: 'true'}}],
    ['a skipped decision', {inspect: {skip: 'hold'}}],
    ['an authorization whose upload failed', {inspect: {authorize: 'true'}, finish: fresh, upload: 'failure'}],
    ['an authorization whose finish found no squash', {inspect: {authorize: 'true'}, upload: 'success'}],
  ])('emits nothing, and succeeds, for %s', (_name, o) => {
    const ran = runStep(emit, emitEnv(o))
    expect(ran.status).toBe(0)
    expect(ran.outputs).toEqual({})
  })

  it.each([
    ['both paths supplying a source', {inspect: {authorize: 'true', ...fresh}, finish: fresh, upload: 'success'}],
    ['finish output without an authorization', {inspect: {}, finish: fresh}],
    ['a recovery source from a non-dispatch event', {inspect: recovered, event: 'schedule'}],
    ['a recovery source flagged fresh', {inspect: fresh, event: 'workflow_dispatch'}],
    ['a fresh source flagged recovery', {inspect: {authorize: 'true'}, finish: recovered, upload: 'success'}],
    ['a source that is not a commit SHA', {inspect: {authorize: 'true'}, finish: {...fresh, source: 'main'}, upload: 'success'}],
    ['a version that is not a CalVer', {inspect: {authorize: 'true'}, finish: {...fresh, version: 'latest'}, upload: 'success'}],
    ['no predecessor', {inspect: {authorize: 'true'}, finish: {...fresh, 'predecessor-digest': ''}, upload: 'success'}],
    ['no planned action', {inspect: {authorize: 'true'}, finish: {...fresh, action: ''}, upload: 'success'}],
    ['a build that carries original evidence', {inspect: {authorize: 'true'}, finish: {...fresh, 'original-digest': DIGEST}, upload: 'success'}],
    ['a gate whose original attempt is unverified', {inspect: {authorize: 'true'}, finish: {...fresh, ...gate, 'original-verified': 'false'}, upload: 'success'}],
    ['a gate with an overflowing original run ID', {inspect: {authorize: 'true'}, finish: {...fresh, ...gate, 'original-run-id': '1000000000000000'}, upload: 'success'}],
  ])('refuses %s and emits nothing', (_name, o) => {
    const ran = runStep(emit, emitEnv(o))
    expect(ran.status).not.toBe(0)
    expect(ran.outputs).toEqual({})
  })
})

describe('held release workflow — candidate build and gates', () => {
  const stepIndex = (job: string, id: string) => heldJob(job).steps.findIndex(step => step.id === id)

  it('pins every action to a full commit SHA', () => {
    for (const job of Object.values(held.jobs)) {
      for (const step of job.steps) if (step.uses !== undefined) expect(step.uses).toMatch(/^[\w./-]+@[0-9a-f]{40}\b/u)
    }
  })

  it('builds the proved source with the allocated version, linux/amd64, and stages the allocation first', () => {
    expect(heldStep('build', 'checkout').with).toMatchObject({ref: '${{ needs.controller.outputs.source }}', 'persist-credentials': false})
    const image = heldStep('build', 'image')
    expect(image.with).toMatchObject({platforms: 'linux/amd64', push: true})
    expect(String(image.with?.['build-args'])).toContain('DASHBOARD_VERSION=${{ needs.controller.outputs.version }}')
    expect(String(image.with?.tags)).toBe('ghcr.io/${{ github.repository }}:ci-${{ github.run_id }}-${{ github.run_attempt }}')
    const stage = heldStep('build', 'stage')
    expect(stage.uses).toMatch(/^actions\/upload-artifact@/u)
    expect(String(stage.with?.name)).toBe('release-allocation-${{ github.run_id }}-${{ github.run_attempt }}')
    expect(stepIndex('build', 'stage')).toBeLessThan(stepIndex('build', 'image'))
    expect(stepIndex('build', 'allocation')).toBeLessThan(stepIndex('build', 'stage'))
    const record = heldStep('build', 'allocation').run ?? ''
    for (const field of ['runId', 'attempt', 'version', 'source']) expect(record).toContain(field)
  })

  it('smokes the exact candidate digest with every preserved check', () => {
    const smoke = heldStep('smoke', 'smoke')
    expect(smoke.env?.DIGEST).toBe('${{ needs.candidate.outputs.digest }}')
    const script = smoke.run ?? ''
    expect(script).toContain('IMG="ghcr.io/${REPOSITORY}@${DIGEST}"')
    for (const check of ['api/healthz', 'dashboard-smoke:3000', 'manifest.webmanifest', "script-src 'self'", 'process.getuid()', 'process.env.NODE_ENV', 'npm npx pnpm pnpx corepack yarn yarnpkg bun bunx', '/root/.bun', 'package_managers=absent']) {
      expect(script, check).toContain(check)
    }
    const cleanup = heldJob('smoke').steps.find(step => step.if === 'always()')
    expect(cleanup?.run).toContain('docker rm -f dashboard-smoke')
  })

  it('reports Trivy SARIF and enforces fixed HIGH/CRITICAL on the same digest', () => {
    const trivy = heldJob('trivy')
    const image = 'ghcr.io/${{ github.repository }}@${{ needs.candidate.outputs.digest }}'
    expect(heldStep('trivy', 'report').with).toMatchObject({'image-ref': image, format: 'sarif', severity: 'HIGH,CRITICAL', 'exit-code': '0', 'limit-severities-for-sarif': true})
    expect(heldStep('trivy', 'enforce').with).toMatchObject({'image-ref': image, severity: 'HIGH,CRITICAL', 'ignore-unfixed': true, 'exit-code': '1'})
    expect(heldStep('trivy', 'sarif').with).toMatchObject({category: 'trivy/release-image'})
    expect(heldStep('trivy', 'artifact').uses).toMatch(/^actions\/upload-artifact@/u)
    expect(stepIndex('trivy', 'report')).toBeLessThan(stepIndex('trivy', 'sarif'))
    expect(stepIndex('trivy', 'sarif')).toBeLessThan(stepIndex('trivy', 'enforce'))
    expect(trivy.steps.at(-1)?.id).toBe('enforce')
  })

  it('seals gate evidence only after both gates succeed, bound to version, source, digest and candidate run', () => {
    const seal = heldJob('seal')
    expect(needsOf(seal).sort()).toEqual(['candidate', 'controller', 'smoke', 'trivy'])
    expect(condition(seal)).toContain("needs.smoke.result == 'success'")
    expect(condition(seal)).toContain("needs.trivy.result == 'success'")
    const script = heldStep('seal', 'record').run ?? ''
    for (const field of ['version', 'source', 'digest', 'candidate', 'smoke', 'trivy']) expect(script).toContain(field)
    expect(heldStep('seal', 'upload').uses).toMatch(/^actions\/upload-artifact@/u)
    expect(stepIndex('seal', 'record')).toBeLessThan(stepIndex('seal', 'upload'))
  })

  it('keeps the gate jobs on the resolved candidate, not on the build job directly', () => {
    for (const name of ['smoke', 'trivy', 'seal', 'publish']) expect(needsOf(heldJob(name)), name).toContain('candidate')
    expect(JSON.stringify(heldJob('smoke'))).not.toContain('needs.build')
    expect(JSON.stringify(heldJob('trivy'))).not.toContain('needs.build')
  })
})

describe('held release workflow — credential boundaries', () => {
  it('grants each job only its own permissions', () => {
    const expected: Record<string, Record<string, string>> = {
      controller: {contents: 'read', actions: 'read', checks: 'read', statuses: 'read', 'pull-requests': 'read', issues: 'read', packages: 'read'},
      build: {contents: 'read', packages: 'write'},
      candidate: {},
      smoke: {packages: 'read'},
      trivy: {contents: 'read', packages: 'read', 'security-events': 'write'},
      seal: {},
      publish: {contents: 'read', packages: 'write'},
      'dispatch-deploy': {contents: 'read'},
      'deploy-report': {},
    }
    expect(Object.keys(held.jobs).sort()).toEqual(Object.keys(expected).sort())
    for (const [name, permissions] of Object.entries(expected)) expect(heldJob(name).permissions, name).toEqual(permissions)
  })

  it('reaches each secret from one job only; build and gate jobs never see an App credential', () => {
    expect(Object.fromEntries(Object.keys(held.jobs).map(name => [name, secretsIn(heldJob(name))]))).toEqual({
      controller: ['APPLICATION_ID', 'APPLICATION_PRIVATE_KEY', 'GITHUB_TOKEN'],
      build: ['GITHUB_TOKEN'],
      candidate: [],
      smoke: ['GITHUB_TOKEN'],
      trivy: ['GITHUB_TOKEN'],
      seal: [],
      publish: ['APPLICATION_ID', 'APPLICATION_PRIVATE_KEY', 'GITHUB_TOKEN'],
      'dispatch-deploy': ['INFRA_DISPATCH_APP_ID', 'INFRA_DISPATCH_APP_PRIVATE_KEY'],
      'deploy-report': [],
    })
  })

  it('mints the publication token last, scoped to this repository with contents:write only', () => {
    const publish = heldJob('publish')
    const mint = heldStep('publish', 'app-token')
    expect(mint.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}\b/u)
    expect(permissionKeys(mint)).toEqual(['permission-contents'])
    expect(mint.with?.['permission-contents']).toBe('write')
    // Omitting BOTH owner and repositories scopes the token to the current repository; an explicit
    // owner with no repositories would widen it to the whole installation.
    expect(Object.keys(mint.with ?? {}).sort()).toEqual(['app-id', 'permission-contents', 'private-key'])
    const at = publish.steps.findIndex(step => step.id === 'app-token')
    // Nothing third-party runs once the token exists, and only the single publisher step holds it.
    expect(publish.steps.slice(at + 1).filter(step => step.uses !== undefined)).toEqual([])
    expect(publish.steps.filter(step => step.env?.GH_TOKEN !== undefined).map(step => step.id)).toEqual(['publish'])
    expect(heldStep('publish', 'publish').env?.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}')
    expect(heldStep('publish', 'publish').env?.RELEASE_APP_SLUG).toBe('${{ steps.app-token.outputs.app-slug }}')
    expect(publish.steps[at + 1]?.id).toBe('publish')
  })

  it('logs in to GHCR with the job GITHUB_TOKEN in every job that touches the registry', () => {
    for (const name of ['build', 'smoke', 'trivy', 'publish']) {
      const login = heldStep(name, 'ghcr')
      expect(login.uses, name).toMatch(/^docker\/login-action@[0-9a-f]{40}\b/u)
      expect(login.with, name).toMatchObject({registry: 'ghcr.io', password: '${{ secrets.GITHUB_TOKEN }}'})
    }
  })

  it('runs the publisher once, from the trusted workflow revision, never from candidate source', () => {
    const publish = heldJob('publish')
    const checkouts = publish.steps.filter(step => step.uses?.startsWith('actions/checkout@') === true)
    expect(checkouts).toHaveLength(1)
    expect(checkouts[0]?.with).toMatchObject({ref: '${{ github.workflow_sha }}', 'persist-credentials': false, 'fetch-depth': 0})
    // Straight after checkout and before anything privileged: the revision must be exactly the workflow SHA.
    const ids = publish.steps.map(step => step.id)
    expect(ids.indexOf('trusted-head')).toBe(ids.indexOf('trusted') + 1)
    expect(heldStep('publish', 'trusted-head').env?.WORKFLOW_SHA).toBe('${{ github.workflow_sha }}')
    expect(ids.indexOf('trusted-head')).toBeLessThan(ids.indexOf('input'))
    expect(ids.indexOf('trusted-head')).toBeLessThan(ids.indexOf('app-token'))
    // Notes come from the proved commit as data; no squash code is checked out or executed.
    const input = heldStep('publish', 'input').run ?? ''
    expect(input).toContain('git show "$CTRL_SOURCE:docs/releases/batch.md"')
    expect(input).toContain('--rawfile notes')
    expect(JSON.stringify(publish)).not.toMatch(/git (?:checkout|switch|worktree|archive|reset|merge|pull|fetch)|\bsource\//u)
    expect(publish.steps.filter(step => step.with?.ref !== undefined)).toEqual(checkouts)
    expect(heldText.match(/scripts\/release\/publisher\.ts/gu)).toHaveLength(1)
    expect(heldStep('publish', 'publish').run).toMatch(/node scripts\/release\/publisher\.ts "\$INPUT_PATH"/u)
    expect(heldStep('publish', 'publish').env?.INPUT_PATH).toBe('${{ steps.input.outputs.path }}')
    expect(heldJob('publish').steps.findIndex(step => step.id === 'input')).toBeLessThan(heldJob('publish').steps.findIndex(step => step.id === 'app-token'))
  })

  it('exposes complete version, digest and deploy only from the read-back step', () => {
    expect(heldJob('publish').outputs).toEqual({
      version: '${{ steps.result.outputs.version }}',
      digest: '${{ steps.result.outputs.digest }}',
      deploy: '${{ steps.result.outputs.deploy }}',
    })
  })
})

describe('held release workflow — infra dispatch', () => {
  const lazy = () => heldJob('dispatch-deploy')

  it('is fresh-attempt only, eligible only, on the existing release environment', () => {
    const job = lazy()
    expect(job.environment).toBe('release')
    expect(job['continue-on-error']).toBe(true)
    expect(condition(job)).toContain("needs.publish.result == 'success'")
    expect(condition(job)).toContain("needs.publish.outputs.deploy == 'eligible'")
    expect(condition(job)).toContain("github.run_attempt == '1'")
    // A recovery source never offers a deploy request automatically.
    expect(condition(job)).toContain("needs.controller.outputs.recovery == 'false'")
  })

  it('keeps the scoped infra token and the exact payload, with no retry', () => {
    const mint = heldStep('dispatch-deploy', 'dispatch-token')
    expect(permissionKeys(mint)).toEqual(['permission-actions'])
    expect(mint.with).toMatchObject({'permission-actions': 'write', owner: 'marcusrbrown', repositories: 'infra'})
    const send = heldStep('dispatch-deploy', 'send').run ?? ''
    expect(send.match(/gh workflow run/gu)).toHaveLength(1)
    expect(send).toContain('gh workflow run deploy-dashboard.yaml --repo marcusrbrown/infra --ref main -f version="$VERSION" -f digest="$DIGEST"')
    expect(send).not.toMatch(/\bwhile\b|\buntil\b|\bsleep\b|\bfor \w+ in\b|retry/u)
  })

  it('reports non-delivery or unknown delivery in a job that does not depend on dispatch success', () => {
    const report = heldJob('deploy-report')
    expect(condition(report)).toContain('always()')
    expect(needsOf(report).sort()).toEqual(['controller', 'dispatch-deploy', 'publish'])
    expect(lazy().outputs?.state).toBe('${{ steps.send.outputs.state || steps.mint-failed.outputs.state || steps.validate.outputs.state }}')
  })
})

// ---------------------------------------------------------------------------------------------
// Behavior: execute the workflow's own shell steps with fake binaries.
// ---------------------------------------------------------------------------------------------

interface Ran {status: number | null; stdout: string; stderr: string; outputs: Record<string, string>; summary: string; log: string; files: (name: string) => string; dir: string}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, {recursive: true, force: true})
  }
})

function runStep(lookup: HeldStep | (() => HeldStep), env: Record<string, string>, fakes: Record<string, string> = {}, cwd?: string): Ran {
  const step = typeof lookup === 'function' ? lookup() : lookup
  const dir = mkdtempSync(join(tmpdir(), 'held-release-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(fakes)) {
    const path = join(bin, name)
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(path, 0o755)
  }
  const script = join(dir, 'step.sh')
  writeFileSync(script, step.run ?? '')
  const log = join(dir, 'calls.log')
  const outputFile = join(dir, 'output')
  const summaryFile = join(dir, 'summary')
  writeFileSync(outputFile, '')
  writeFileSync(summaryFile, '')
  writeFileSync(log, '')
  const result = spawnSync('bash', ['-Eeuo', 'pipefail', script], {
    cwd: cwd ?? dir,
    encoding: 'utf8',
    env: {PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: dir, RUNNER_TEMP: dir, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile, CALL_LOG: log, ...env},
  })
  const outputs = Object.fromEntries(readFileSync(outputFile, 'utf8').split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  return {status: result.status, stdout: result.stdout, stderr: result.stderr, outputs, summary: readFileSync(summaryFile, 'utf8'), log: readFileSync(log, 'utf8'), files: name => readFileSync(join(dir, name), 'utf8'), dir}
}

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {cwd, encoding: 'utf8'})
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** A small repo standing in for the trusted checkout: one commit per entry, each writing the notes file. */
function makeRepo(notes: readonly (string | null)[]): {path: string; shas: string[]} {
  const path = mkdtempSync(join(tmpdir(), 'held-release-repo-'))
  dirs.push(path)
  git(path, 'init', '-q')
  const shas: string[] = []
  notes.forEach((text, index) => {
    mkdirSync(join(path, 'docs/releases'), {recursive: true})
    if (text === null) rmSync(join(path, 'docs/releases/batch.md'), {force: true})
    else writeFileSync(join(path, 'docs/releases/batch.md'), text)
    writeFileSync(join(path, 'other.txt'), `${index}\n`)
    git(path, 'add', '-A')
    git(path, 'commit', '-q', '--allow-empty', '-m', `c${index}`)
    shas.push(git(path, 'rev-parse', 'HEAD'))
  })
  return {path, shas}
}

// Live repository run IDs already have 11 digits; attempts stay small.
const RUN = '12345678901'
const MAX_RUN = '999999999999999'
const OVERFLOW_RUN = '1000000000000000'

const candidateEnv = (overrides: Record<string, string> = {}): Record<string, string> => ({
  ACTION: 'build', CTRL_SOURCE: SOURCE, CTRL_VERSION: VERSION, BUILD_RESULT: 'success', BUILD_DIGEST: DIGEST, BUILD_VERSION: VERSION, BUILD_SOURCE: SOURCE,
  BUILD_RUN_ID: RUN, BUILD_ATTEMPT: '1', ORIG_DIGEST: '', ORIG_RUN_ID: '', ORIG_ATTEMPT: '', ORIG_VERIFIED: '', RUN_ID: RUN, RUN_ATTEMPT: '2', ...overrides,
})

describe('held release workflow — candidate basis (behavior)', () => {
  const resolveStep = () => heldStep('candidate', 'resolve')

  it('resolves one candidate from this run’s build of the proved source', () => {
    const ran = runStep(resolveStep, candidateEnv())
    expect(ran.status).toBe(0)
    expect(ran.outputs).toEqual({digest: DIGEST, version: VERSION, source: SOURCE, 'run-id': RUN, attempt: '1', origin: 'build'})
  })

  it('accepts the largest run ID that is exact in JavaScript and rejects anything beyond it', () => {
    const ran = runStep(resolveStep, candidateEnv({RUN_ID: MAX_RUN, BUILD_RUN_ID: MAX_RUN}))
    expect(ran.status).toBe(0)
    expect(ran.outputs['run-id']).toBe(MAX_RUN)
    expect(Number.isSafeInteger(Number(MAX_RUN))).toBe(true)
    for (const bad of [OVERFLOW_RUN, '0', '012345678901', '1234567890a', '-5']) {
      const refused = runStep(resolveStep, candidateEnv({RUN_ID: bad, BUILD_RUN_ID: bad}))
      expect(refused.status, bad).not.toBe(0)
      expect(refused.outputs).toEqual({})
    }
  })

  it.each([
    ['a build of another source', {BUILD_SOURCE: OTHER}],
    ['a build of another version', {BUILD_VERSION: '2026.11.4'}],
    ['a build from another run', {BUILD_RUN_ID: '12345678900'}],
    ['a build attempt from the future', {BUILD_ATTEMPT: '3'}],
    ['a build attempt that is not a small integer', {BUILD_ATTEMPT: '1234567890'}],
    ['a build that did not succeed', {BUILD_RESULT: 'failure'}],
    ['a malformed digest', {BUILD_DIGEST: 'sha256:abc'}],
    ['a controller source that is not a commit SHA', {CTRL_SOURCE: 'main', BUILD_SOURCE: 'main'}],
    ['no planned action', {ACTION: ''}],
    ['an unknown planned action', {ACTION: 'publish'}],
  ])('rejects %s and emits nothing', (_name, overrides) => {
    const ran = runStep(resolveStep, candidateEnv(overrides))
    expect(ran.status).not.toBe(0)
    expect(ran.outputs).toEqual({})
  })

  const recovery = {ACTION: 'gate', BUILD_RESULT: 'skipped', BUILD_DIGEST: '', BUILD_VERSION: '', BUILD_SOURCE: '', BUILD_RUN_ID: '', BUILD_ATTEMPT: '', ORIG_DIGEST: DIGEST, ORIG_RUN_ID: '12345600321', ORIG_ATTEMPT: '1', ORIG_VERIFIED: 'true'}

  it('recovers a known digest without a rebuild only with controller-verified original evidence', () => {
    const ran = runStep(resolveStep, candidateEnv(recovery))
    expect(ran.status).toBe(0)
    expect(ran.outputs).toEqual({digest: DIGEST, version: VERSION, source: SOURCE, 'run-id': '12345600321', attempt: '1', origin: 'recovered'})
    for (const bad of [{ORIG_VERIFIED: ''}, {ORIG_VERIFIED: 'false'}, {ORIG_DIGEST: ''}, {ORIG_RUN_ID: ''}, {ORIG_RUN_ID: OVERFLOW_RUN}, {ORIG_ATTEMPT: '0'}, {BUILD_RESULT: 'success'}]) {
      const refused = runStep(resolveStep, candidateEnv({...recovery, ...bad}))
      expect(refused.status, JSON.stringify(bad)).not.toBe(0)
      expect(refused.outputs).toEqual({})
    }
  })

  it('lets a new run attempt 1 re-gate another run’s later attempt, but not its own future attempt', () => {
    const other = runStep(resolveStep, candidateEnv({...recovery, RUN_ATTEMPT: '1', ORIG_ATTEMPT: '2'}))
    expect(other.status).toBe(0)
    expect(other.outputs).toMatchObject({'run-id': '12345600321', attempt: '2', origin: 'recovered'})
    const own = runStep(resolveStep, candidateEnv({...recovery, ORIG_RUN_ID: RUN, ORIG_ATTEMPT: '3'}))
    expect(own.status).not.toBe(0)
    expect(own.outputs).toEqual({})
  })
})

const inputEnv = (source: string, overrides: Record<string, string> = {}): Record<string, string> => ({
  REPOSITORY: 'fro-bot/dashboard', CTRL_SOURCE: source, CTRL_VERSION: VERSION, PREDECESSOR_VERSION: PREDECESSOR.version, PREDECESSOR_DIGEST: PREDECESSOR.digest,
  CANDIDATE_SOURCE: source, CANDIDATE_VERSION: VERSION, CANDIDATE_DIGEST: DIGEST, CANDIDATE_RUN_ID: RUN, CANDIDATE_ATTEMPT: '1', CANDIDATE_ORIGIN: 'build',
  SEALED: 'true', SEAL_SOURCE: source, SEAL_VERSION: VERSION, SEAL_DIGEST: DIGEST, SEAL_RUN_ID: RUN, SEAL_ATTEMPT: '1',
  SMOKE_RESULT: 'success', TRIVY_RESULT: 'success', RUN_ID: RUN, GITHUB_RUN_ID: RUN, RUN_ATTEMPT: '2', GITHUB_RUN_ATTEMPT: '2', ...overrides,
})

describe('held release workflow — publisher input (behavior)', () => {
  const inputStep = () => heldStep('publish', 'input')
  const typed = (ran: Ran) => parsePublishInput(JSON.parse(readFileSync(ran.outputs.path ?? '', 'utf8')))
  /** Runs the input step in a trusted-checkout stand-in whose proved source commit carries `notes`. */
  const run = (overrides: Record<string, string> = {}, notes: readonly (string | null)[] = [NOTES]) => {
    const repo = makeRepo(notes)
    const source = repo.shas[0] ?? ''
    return {ran: runStep(inputStep, inputEnv(source, overrides), {}, repo.path), source, repo}
  }

  it('writes a typed input that the real publisher CLI accepts, from same-run facts only', () => {
    const {ran, source} = run()
    expect(ran.status).toBe(0)
    expect((ran.outputs.path ?? '').startsWith(ran.dir)).toBe(true)
    expect(typed(ran)).toEqual({
      repo: 'fro-bot/dashboard',
      source,
      notes: NOTES,
      predecessor: PREDECESSOR,
      builds: {state: 'present', value: [{runId: Number(RUN), attempt: 1, version: VERSION, source, digest: DIGEST, verified: true}]},
      evidence: {state: 'present', value: [{runId: Number(RUN), attempt: 1, version: VERSION, source, digest: DIGEST, verified: true, smoke: 'pass', trivy: {enforced: true, result: 'pass'}}]},
    })
  })

  it('carries the proved commit’s notes exactly, multiline with its trailing newline', () => {
    for (const notes of ['## v\n\n- one (#12)\n- two\n\n```sh\nx\n```\n', 'no trailing newline', 'trailing blanks\n\n\n']) {
      const {ran} = run({}, [notes])
      expect(ran.status, JSON.stringify(notes)).toBe(0)
      expect((JSON.parse(readFileSync(ran.outputs.path ?? '', 'utf8')) as {notes: string}).notes).toBe(notes)
    }
  })

  it('reads the notes committed at the proved source, not the checkout’s current file', () => {
    const repo = makeRepo([NOTES, '## Later notes\n'])
    const source = repo.shas[0] ?? ''
    const ran = runStep(inputStep, inputEnv(source), {}, repo.path)
    expect(ran.status).toBe(0)
    expect(typed(ran)?.notes).toBe(NOTES)
  })

  it.each([
    ['a proved source commit that the trusted history does not contain', {CTRL_SOURCE: SOURCE, CANDIDATE_SOURCE: SOURCE, SEAL_SOURCE: SOURCE}],
    ['a proved source that is a ref, not a commit SHA', {CTRL_SOURCE: 'HEAD', CANDIDATE_SOURCE: 'HEAD', SEAL_SOURCE: 'HEAD'}],
  ])('stops before any input exists for %s', (_name, overrides) => {
    const {ran} = run(overrides)
    expect(ran.status).not.toBe(0)
    expect(ran.outputs).toEqual({})
  })

  it.each([
    ['no notes file at the proved commit', [null]],
    ['an empty notes file', ['']],
    ['a notes file with only whitespace', [' \n\n\t\n']],
  ])('stops before any input exists for %s', (_name, notes) => {
    const {ran, repo} = run({}, notes)
    expect(ran.status).not.toBe(0)
    expect(ran.outputs).toEqual({})
    expect(() => readFileSync(join(ran.dir, 'publish-input.json'))).toThrow()
    expect(repo.shas).toHaveLength(1)
  })

  it('does not need a notes value from the controller', () => {
    expect(heldStep('publish', 'input').env).not.toHaveProperty('CTRL_NOTES')
  })

  it('carries the largest exact run ID through to the typed input', () => {
    const {ran} = run({RUN_ID: MAX_RUN, GITHUB_RUN_ID: MAX_RUN, CANDIDATE_RUN_ID: MAX_RUN, SEAL_RUN_ID: MAX_RUN})
    expect(ran.status).toBe(0)
    expect(typed(ran)?.builds).toMatchObject({value: [{runId: Number(MAX_RUN)}]})
  })

  it('accepts a recovered candidate from another run’s later attempt in a new run’s first attempt', () => {
    const other = {RUN_ID: '12345699999', GITHUB_RUN_ID: '12345699999', RUN_ATTEMPT: '1', GITHUB_RUN_ATTEMPT: '1', CANDIDATE_ORIGIN: 'recovered', CANDIDATE_ATTEMPT: '2', SEAL_ATTEMPT: '2'}
    const {ran} = run(other)
    expect(ran.status).toBe(0)
    expect(typed(ran)?.evidence).toMatchObject({value: [{runId: Number(RUN), attempt: 2}]})
  })

  it.each([
    ['a candidate of another source than the proved squash', {CANDIDATE_SOURCE: OTHER, SEAL_SOURCE: OTHER}],
    ['a seal of another source', {SEAL_SOURCE: OTHER}],
    ['a seal of another digest', {SEAL_DIGEST: `sha256:${'3'.repeat(64)}`}],
    ['a seal of another version', {SEAL_VERSION: '2026.11.4'}],
    ['a seal of another candidate run', {SEAL_RUN_ID: '12345678902'}],
    ['an unsealed gate', {SEALED: ''}],
    ['a smoke gate that did not pass', {SMOKE_RESULT: 'failure'}],
    ['a Trivy gate that was skipped', {TRIVY_RESULT: 'skipped'}],
    ['no proved source', {CTRL_SOURCE: ''}],
    ['no predecessor', {PREDECESSOR_DIGEST: ''}],
    ['a runner attempt that differs from the workflow attempt', {GITHUB_RUN_ATTEMPT: '1'}],
    ['a runner run that differs from the workflow run', {GITHUB_RUN_ID: '12345678902'}],
    ['an attempt that is not a positive integer', {RUN_ATTEMPT: '0', GITHUB_RUN_ATTEMPT: '0'}],
    ['a run ID with more than 15 digits', {RUN_ID: OVERFLOW_RUN, GITHUB_RUN_ID: OVERFLOW_RUN, CANDIDATE_RUN_ID: OVERFLOW_RUN, SEAL_RUN_ID: OVERFLOW_RUN}],
    ['a run ID with a leading zero', {CANDIDATE_RUN_ID: '012345678901', SEAL_RUN_ID: '012345678901'}],
    ['a same-run candidate attempt later than this one', {CANDIDATE_ATTEMPT: '3', SEAL_ATTEMPT: '3'}],
    ['a brand-new build from another run', {CANDIDATE_RUN_ID: '12345678900', SEAL_RUN_ID: '12345678900'}],
    ['no candidate origin', {CANDIDATE_ORIGIN: ''}],
    ['a repository that is not owner/name', {REPOSITORY: 'dashboard'}],
  ])('stops before any input exists for %s', (_name, overrides) => {
    const {ran} = run(overrides)
    expect(ran.status).not.toBe(0)
    expect(ran.outputs).toEqual({})
    expect(ran.log).toBe('')
  })
})

describe('held release workflow — trusted checkout (behavior)', () => {
  const head = () => heldStep('publish', 'trusted-head')
  const repo = () => makeRepo([NOTES, '## Later\n'])

  it('accepts only the checkout whose HEAD is the trusted workflow SHA', () => {
    const r = repo()
    const [first, second] = r.shas
    expect(runStep(head, {WORKFLOW_SHA: second ?? ''}, {}, r.path).status).toBe(0)
    const stale = runStep(head, {WORKFLOW_SHA: first ?? ''}, {}, r.path)
    expect(stale.status).not.toBe(0)
  })

  it.each([
    ['a blank workflow SHA', ''],
    ['a malformed workflow SHA', 'main'],
    ['an abbreviated workflow SHA', 'abc1234'],
    ['an upper-case workflow SHA', 'A'.repeat(40)],
  ])('refuses %s even though a default-branch checkout would succeed', (_name, value) => {
    const r = repo()
    expect(runStep(head, {WORKFLOW_SHA: value}, {}, r.path).status).not.toBe(0)
  })
})

describe('held release workflow — gate seal (behavior)', () => {
  const record = () => heldStep('seal', 'record')
  const env = (overrides: Record<string, string> = {}) => ({
    VERSION, SOURCE, DIGEST, CANDIDATE_RUN_ID: RUN, CANDIDATE_ATTEMPT: '1', SMOKE_RESULT: 'success', TRIVY_RESULT: 'success', GATE_RUN_ID: '12345699999', GATE_ATTEMPT: '1', ...overrides,
  })

  it('seals the candidate run and a separate gating run, with 11-digit run IDs', () => {
    const ran = runStep(record, env())
    expect(ran.status).toBe(0)
    expect(ran.outputs).toEqual({sealed: 'true', version: VERSION, source: SOURCE, digest: DIGEST, 'run-id': RUN, attempt: '1'})
    expect(JSON.parse(ran.files('release-gate.json'))).toMatchObject({candidate: {runId: Number(RUN), attempt: 1}, gate: {runId: 12_345_699_999, attempt: 1}, smoke: 'pass', trivy: {enforced: true, result: 'pass'}})
  })

  it.each([
    ['a failed gate', {SMOKE_RESULT: 'failure'}],
    ['an overflowing candidate run ID', {CANDIDATE_RUN_ID: OVERFLOW_RUN}],
    ['a malformed gating run ID', {GATE_RUN_ID: '12x'}],
    ['a malformed attempt', {CANDIDATE_ATTEMPT: '0'}],
  ])('seals nothing for %s', (_name, overrides) => {
    const ran = runStep(record, env(overrides))
    expect(ran.status).not.toBe(0)
    expect(ran.outputs).toEqual({})
  })
})

describe('held release workflow — publish and read-back (behavior)', () => {
  const publishStep = () => heldStep('publish', 'publish')
  const resultStep = () => heldStep('publish', 'result')
  const complete = {kind: 'complete', version: VERSION, source: SOURCE, digest: DIGEST, deploy: 'eligible'}
  const fakeNode = (rc: number, out: string) => ({node: `printf '%s\\n' "$*" >> "$CALL_LOG"\nprintf '%s\\n' '${out}'\nexit ${rc}`})

  it('invokes the publisher exactly once on the trusted input file and keeps its result', () => {
    const ran = runStep(publishStep, {INPUT_PATH: '/trusted/input.json', GH_TOKEN: 'x'}, fakeNode(0, JSON.stringify(complete)))
    expect(ran.status).toBe(0)
    expect(ran.log).toBe('scripts/release/publisher.ts /trusted/input.json\n')
    expect(JSON.parse(ran.files('publish-result.json'))).toEqual(complete)
  })

  it('fails the job on a stopped publication and surfaces only a stable reason', () => {
    const ran = runStep(publishStep, {INPUT_PATH: '/trusted/input.json', GH_TOKEN: 'x'}, fakeNode(1, JSON.stringify({kind: 'stop', reason: 'candidate-missing'})))
    expect(ran.status).not.toBe(0)
    expect(ran.log.split('\n').filter(Boolean)).toHaveLength(1)
    expect(ran.summary).toContain('candidate-missing')
    const leaky = runStep(publishStep, {INPUT_PATH: '/trusted/input.json', GH_TOKEN: 'x'}, fakeNode(1, JSON.stringify({kind: 'stop', reason: 'ghs_SECRET leaked https://x'})))
    expect(leaky.status).not.toBe(0)
    expect(leaky.summary).not.toContain('ghs_SECRET')
    expect(leaky.stdout + leaky.stderr).not.toContain('ghs_SECRET')
  })

  const read = (result: string, overrides: Record<string, string> = {}) => {
    const ran = runStep(
      {run: `printf '%s\\n' '${result}' > "$RUNNER_TEMP/publish-result.json"\n${resultStep().run ?? ''}`},
      {EXPECT_VERSION: VERSION, EXPECT_SOURCE: SOURCE, EXPECT_DIGEST: DIGEST, ...overrides},
    )
    return ran
  }

  it('returns version, digest and deploy only from a complete result for the verified identity', () => {
    const ran = read(JSON.stringify(complete))
    expect(ran.status).toBe(0)
    expect(ran.outputs).toEqual({version: VERSION, digest: DIGEST, deploy: 'eligible'})
  })

  it.each([
    ['a stop', {kind: 'stop', reason: 'superseded'}],
    ['another digest', {...complete, digest: `sha256:${'3'.repeat(64)}`}],
    ['another source', {...complete, source: OTHER}],
    ['another version', {...complete, version: '2026.11.4'}],
    ['an unknown deploy state', {...complete, deploy: 'sent'}],
    ['an extra field', {...complete, token: 'x'}],
  ])('exposes nothing for %s', (_name, result) => {
    const ran = read(JSON.stringify(result))
    expect(ran.status).not.toBe(0)
    expect(ran.outputs).toEqual({})
  })

  it('exposes nothing for output that is not JSON', () => {
    const ran = read('not json')
    expect(ran.status).not.toBe(0)
    expect(ran.outputs).toEqual({})
  })
})

describe('held release workflow — dispatch and report (behavior)', () => {
  const validate = () => heldStep('dispatch-deploy', 'validate')
  const send = () => heldStep('dispatch-deploy', 'send')
  const mintFailed = () => heldStep('dispatch-deploy', 'mint-failed')
  const env = {VERSION, DIGEST, GH_TOKEN: 'x'}
  const gh = (rc: number, stderr: string) => ({gh: `printf '%s\\n' "$*" >> "$CALL_LOG"\nprintf '%s\\n' '${stderr}' >&2\nexit ${rc}`})

  it('dispatches the exact payload once and records acceptance', () => {
    const ran = runStep(send, env, gh(0, ''))
    expect(ran.status).toBe(0)
    expect(ran.log).toBe(`workflow run deploy-dashboard.yaml --repo marcusrbrown/infra --ref main -f version=${VERSION} -f digest=${DIGEST}\n`)
    expect(ran.outputs.state).toBe('accepted')
  })

  it('records a confirmed rejection for an HTTP 4xx and sends nothing again', () => {
    const ran = runStep(send, env, gh(1, 'could not create workflow dispatch event: HTTP 422: Unexpected inputs provided'))
    expect(ran.status).not.toBe(0)
    expect(ran.outputs.state).toBe('rejected')
    expect(ran.stderr).toContain('rejected')
    expect(ran.log.split('\n').filter(Boolean)).toHaveLength(1)
  })

  it.each(['HTTP 502: Bad Gateway', 'Post "https://api.github.com": context deadline exceeded', ''])('leaves delivery unknown for %j', stderr => {
    const ran = runStep(send, env, gh(1, stderr))
    expect(ran.status).not.toBe(0)
    expect(ran.outputs.state).toBe('uncertain')
    // Unknown delivery must not be reported as non-acceptance.
    expect(ran.stderr).toContain('not confirmed')
    expect(ran.stderr).not.toMatch(/rejected|not accepted|not delivered/iu)
    expect(ran.log.split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('refuses to start for a malformed version or digest and records non-delivery', () => {
    for (const bad of [{VERSION: '2026.11'}, {VERSION: ''}, {DIGEST: 'sha256:abc'}, {DIGEST: ''}]) {
      const ran = runStep(validate, {...env, ...bad})
      expect(ran.status, JSON.stringify(bad)).not.toBe(0)
      expect(ran.outputs.state).toBe('not-sent')
    }
    expect(runStep(validate, env).status).toBe(0)
    expect(runStep(mintFailed, {}).outputs.state).toBe('not-sent')
  })

  const report = () => heldStep('deploy-report', 'report')
  const reportEnv = (overrides: Record<string, string>) => ({RECOVERY: 'false', PUBLISH_RESULT: 'success', DEPLOY: 'eligible', VERSION, DIGEST, DISPATCH_RESULT: 'success', DISPATCH_STATE: 'accepted', ...overrides})

  it.each([
    ['accepted', {}, 'accepted'],
    ['confirmed rejection', {DISPATCH_STATE: 'rejected'}, 'NOT delivered'],
    ['validation refusal', {DISPATCH_STATE: 'not-sent'}, 'NOT delivered'],
    ['lost response', {DISPATCH_STATE: 'uncertain'}, 'UNKNOWN'],
    ['no recorded state', {DISPATCH_STATE: ''}, 'UNKNOWN'],
    ['cancelled job', {DISPATCH_RESULT: 'cancelled', DISPATCH_STATE: ''}, 'UNKNOWN'],
    ['skipped dispatch', {DISPATCH_RESULT: 'skipped', DISPATCH_STATE: ''}, 'not requested'],
    ['earlier uncertain dispatch', {DEPLOY: 'uncertain', DISPATCH_RESULT: 'skipped', DISPATCH_STATE: ''}, 'UNKNOWN'],
    ['unreadable dispatch record', {DEPLOY: 'unreadable', DISPATCH_RESULT: 'skipped', DISPATCH_STATE: ''}, 'UNKNOWN'],
    ['earlier rejection', {DEPLOY: 'not-delivered', DISPATCH_RESULT: 'skipped', DISPATCH_STATE: ''}, 'NOT delivered'],
    ['not fresh', {DEPLOY: 'not-fresh', DISPATCH_RESULT: 'skipped', DISPATCH_STATE: ''}, 'not requested'],
  ])('summarizes %s without resending', (_name, overrides, expected) => {
    const ran = runStep(report, reportEnv(overrides))
    expect(ran.status).toBe(0)
    expect(ran.summary).toContain(expected)
    expect(ran.summary).toContain(VERSION)
    expect(ran.summary).toContain(DIGEST)
  })

  it('never reports an eligible deploy as requested for a recovery source', () => {
    const ran = runStep(report, reportEnv({RECOVERY: 'true', DEPLOY: 'eligible', DISPATCH_RESULT: 'skipped', DISPATCH_STATE: ''}))
    expect(ran.status).toBe(0)
    expect(ran.summary).toContain('Deploy not requested')
    expect(ran.summary).not.toContain('accepted')
    const unrecognized = runStep(report, reportEnv({RECOVERY: '', DEPLOY: 'eligible', DISPATCH_RESULT: 'skipped', DISPATCH_STATE: ''}))
    expect(unrecognized.summary).toContain('Deploy not requested')
  })

  it('reports an unresolved publication with no deploy request and no identity claim', () => {
    const ran = runStep(report, reportEnv({PUBLISH_RESULT: 'failure', DEPLOY: '', VERSION: '', DIGEST: '', DISPATCH_RESULT: 'skipped', DISPATCH_STATE: ''}))
    expect(ran.status).toBe(0)
    expect(ran.summary).toContain('Publication did not complete')
    expect(ran.summary).toContain('No deploy was requested')
    expect(ran.summary).not.toContain(DIGEST)
  })
})
