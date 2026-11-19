import type {ControllerPorts, Observation} from '../scripts/release/controller.ts'
import {Buffer} from 'node:buffer'
import {execFileSync, spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {describe, expect, it, vi} from 'vitest'
import {verifyReleaseChecks, type CheckEvidence} from '../scripts/release/checks.ts'
import {decideRelease, type GateInput, type MergeFacts} from '../scripts/release/gate.ts'
import {nodeControllerDependencies, runController} from '../scripts/release/run-controller.ts'

const sha = 'a'.repeat(40)
const source = 'b'.repeat(40)
const digest = `sha256:${'c'.repeat(64)}`
const repo = 'fro-bot/dashboard'
const workflow = '.github/workflows/held-release.yaml'
const env = () => ({GITHUB_REPOSITORY: repo, GITHUB_REF: 'refs/heads/main', RELEASE_WORKFLOW_REF: `${repo}/${workflow}@refs/heads/main`, RELEASE_WORKFLOW_SHA: sha, GITHUB_RUN_ID: '12345678901', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY_ID: '123', GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_ACTOR_ID: '831617', RUNNER_TEMP: '/runner/temp', GITHUB_OUTPUT: '/runner/output', RELEASE_READ_TOKEN: 'secret-read', RELEASE_APP_TOKEN: 'secret-app', RELEASE_APP_ID: '9', RELEASE_APP_SLUG: 'fro-bot'})

function fixture() {
  const gate: GateInput = {expected: {repo, pr: 1, branch: 'release', baseBranch: 'main', ownerId: 831617, workflow, trustedRevision: sha}, activeSince: '2026-11-01T00:00:00Z', priorAttempt: 'resolved', candidate: {repo, pr: 1, headRepo: repo, headBranch: 'release', baseBranch: 'main', state: 'open', head: 'head', base: 'base', currentBase: 'base', parents: ['base'], tree: 'tree', expectedTree: 'tree'}, run: {repo, workflow, revision: sha, runId: 12345678901, attempt: 1, verified: true}, checks: {verified: true, ready: true, head: 'head', base: 'base', applicableRevision: sha, checks: [{name: 'CI', revision: sha, disposition: 'pass'}]}, trigger: {kind: 'dispatch', actorId: 831617, ref: 'refs/heads/main', refVerified: true, reviewsVerified: true, reviews: [{id: 3, userId: 831617, state: 'approved', head: 'head', submittedAt: '2026-11-02T00:00:00Z'}]}}
  const decision = decideRelease(gate)
  if (decision.kind !== 'authorize') throw new Error('bad fixture')
  const record = {origin: {...gate.run, artifactId: 11}, authorization: decision.authorization}
  const facts: MergeFacts = {verified: true, repo, pr: 1, merged: true, actorAppId: 9, head: 'head', base: 'base', squashSha: source, commit: {verified: true, sha: source, parents: ['base'], tree: 'tree', authorizationArtifactId: 11}, association: {verified: true, sha: source, prs: [1]}}
  let observation: Observation = {mode: 'active', activation: gate.activeSince, trusted: {repo, workflow, revision: sha, appId: 9}, run: gate.run, trigger: gate.trigger, ownerId: 831617, baseBranch: 'main', predecessor: 'verified', prior: {state: 'clear'}, candidate: {state: 'ready', gate}}
  const ports: ControllerPorts = {observe: vi.fn(async () => structuredClone(observation)), prepare: vi.fn(async () => {}), authorization: vi.fn(async () => record), recoveryRevision: vi.fn(async () => true), merge: vi.fn(async () => {}), mergeFacts: vi.fn(async () => facts)}
  const handoff = vi.fn(async (s: string, recovery: boolean) => ({kind: 'handoff' as const, source: s, predecessor: {source: 'd'.repeat(40), version: '2026.11.1', digest}, recovery, version: '2026.11.2', action: 'gate' as const, original: {runId: 123, attempt: 1, digest}}))
  const deps = {head: vi.fn(async () => sha), settings: vi.fn(async (): Promise<{active: boolean | null; activation: string | null}> => ({active: true, activation: gate.activeSince})), ownerId: vi.fn(async () => 831617), schedule: vi.fn(async () => null as string | null), start: vi.fn(async () => ({ports, handoff})), write: vi.fn(async (_path: string, _data: string) => {}), output: vi.fn(async (_data: string) => {}), summary: vi.fn(async (_data: string) => {})}
  return {deps, ports, record, handoff, set: (o: Observation) => {
    observation = o
  }, observation}
}

async function run(args: string[], e: Record<string, string>, deps: ReturnType<typeof fixture>['deps']) {
  return runController(args, e, deps)
}

describe('release command boundary', () => {
  it('runs the disabled workflow CLI without authorizing anything', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'held-cli-')))
    try {
      const summary = join(directory, 'summary')
      const output = join(directory, 'output')
      writeFileSync(summary, '')
      writeFileSync(output, '')
      mkdirSync(join(directory, '.github/workflows'), {recursive: true})
      writeFileSync(join(directory, workflow), 'env:\n  HELD_RELEASE_ACTIVE: false\n')
      const gitEnv = {...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid'}
      const git = (...args: string[]) => execFileSync('git', args, {cwd: directory, env: gitEnv, encoding: 'utf8'}).trim()
      git('init', '-q')
      git('add', workflow)
      git('commit', '--no-gpg-sign', '-qm', 'disabled')
      const revision = git('rev-parse', 'HEAD')
      execFileSync(process.execPath, [join(process.cwd(), 'scripts/release/run-controller.ts'), 'inspect'], {
        cwd: directory,
        env: {...env(), PATH: process.env.PATH, RELEASE_WORKFLOW_SHA: revision, HELD_RELEASE_ACTIVE: 'false', RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary},
        timeout: 10_000,
      })
      expect(readFileSync(summary, 'utf8')).toContain('Skipped.')
      expect(readFileSync(output, 'utf8')).toBe('')
      const bad = spawnSync(process.execPath, [join(process.cwd(), 'scripts/release/run-controller.ts'), 'finish', '0'], {
        cwd: directory,
        env: {...env(), PATH: process.env.PATH, RELEASE_WORKFLOW_SHA: revision, HELD_RELEASE_ACTIVE: 'false', RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary},
        timeout: 10_000,
      })
      expect(bad.status).toBe(1)
      expect(readFileSync(summary, 'utf8')).toContain('Stopped: invalid-command.')
    } finally {
      rmSync(directory, {recursive: true, force: true})
    }
  })

  it('does not start in default-off or invalid contexts', async () => {
    for (const change of [{GITHUB_REF: 'refs/heads/other'}, {RELEASE_ACTOR_ID: '1'}, {GITHUB_RUN_ID: '1234567890123456'}, {RELEASE_WORKFLOW_SHA: 'bad'}]) {
      const f = fixture()
      await run(['inspect'], {...env(), ...change}, f.deps)
      expect(f.deps.start).not.toHaveBeenCalled()
      expect(f.deps.output).not.toHaveBeenCalled()
    }
    const f = fixture()
    f.deps.settings.mockResolvedValue({active: false, activation: null})
    await run(['inspect'], env(), f.deps)
    expect(f.deps.start).not.toHaveBeenCalled()
  })
  it('writes only the real authorization to the fixed artifact path', async () => {
    const f = fixture()
    await run(['inspect'], env(), f.deps)
    expect(f.deps.write).toHaveBeenCalledExactlyOnceWith('/runner/temp/release-authorization.json', `${JSON.stringify(f.record.authorization)}\n`)
    expect(f.deps.output).toHaveBeenCalledExactlyOnceWith('authorize=true\n')
    expect(f.ports.merge).not.toHaveBeenCalled()
  })
  it('prepare cannot produce authorization or publication output', async () => {
    const f = fixture()
    f.set({...f.observation, mode: 'prepare', candidate: {state: 'absent'}})
    await run(['inspect'], {...env(), RELEASE_PREPARE_ONLY: 'true'}, f.deps)
    expect(f.ports.prepare).toHaveBeenCalledOnce()
    expect(f.deps.output).not.toHaveBeenCalled()
    expect(f.deps.write).not.toHaveBeenCalled()
  })
  it('finishes one exact artifact through merge proof and emits a safe handoff', async () => {
    const f = fixture()
    await run(['finish', '11'], env(), f.deps)
    expect(f.ports.authorization).toHaveBeenCalledExactlyOnceWith(11)
    expect(f.ports.merge).toHaveBeenCalledExactlyOnceWith('head', 11)
    expect(f.deps.output).toHaveBeenCalledExactlyOnceWith(`source=${source}\nversion=2026.11.2\naction=gate\npredecessor-version=2026.11.1\npredecessor-digest=${digest}\noriginal-run-id=123\noriginal-attempt=1\noriginal-digest=${digest}\noriginal-verified=true\nrecovery=false\n`)
  })
  it('carries recovery through a proved source and never merges again', async () => {
    const f = fixture()
    f.set({...f.observation, prior: {state: 'unresolved', artifactId: 11}})
    await run(['inspect'], env(), f.deps)
    expect(f.handoff).toHaveBeenCalledExactlyOnceWith(source, true)
    expect(f.deps.output.mock.calls[0]?.[0]).toContain('recovery=true\n')
    expect(f.ports.merge).not.toHaveBeenCalled()
  })
  it('rejects bad commands, unverified owner and invalid static settings before runtime', async () => {
    for (const args of [['finish', '0'], ['finish', '11', 'extra'], ['inspect', 'extra'], ['other']]) {
      const f = fixture()
      await run(args, env(), f.deps)
      expect(f.deps.start).not.toHaveBeenCalled()
    }
    const f = fixture()
    f.deps.ownerId.mockResolvedValue(9)
    await run(['inspect'], env(), f.deps)
    expect(f.deps.start).not.toHaveBeenCalled()
    f.deps.ownerId.mockResolvedValue(831617)
    f.deps.settings.mockResolvedValue({active: null, activation: null})
    await run(['inspect'], env(), f.deps)
    expect(f.deps.start).not.toHaveBeenCalled()
  })
  it('rejects a forged handoff and sanitizes runtime failures', async () => {
    const f = fixture()
    f.handoff.mockImplementationOnce(async () => {
      throw new Error('secret-app')
    })
    await run(['finish', '11'], env(), f.deps)
    expect(f.deps.output).not.toHaveBeenCalled()
    expect(JSON.stringify(f.deps.summary.mock.calls)).not.toContain('secret-app')
  })
  it('does not let a non-dispatch prepare flag bypass activation', async () => {
    const f = fixture()
    f.deps.settings.mockResolvedValue({active: false, activation: null})
    await run(['inspect'], {...env(), GITHUB_EVENT_NAME: 'push', RELEASE_PREPARE_ONLY: 'true'}, f.deps)
    expect(f.deps.start).not.toHaveBeenCalled()
  })
  it('reports the stable driver skip reason without publishing', async () => {
    const f = fixture()
    f.set({...f.observation, predecessor: 'unknown'})
    expect(await run(['inspect'], env(), f.deps)).toBe(1)
    expect(f.deps.summary).toHaveBeenCalledExactlyOnceWith('### Held release\n\nStopped: predecessor.\n')
    expect(f.deps.output).not.toHaveBeenCalled()
  })
  it('distinguishes normal waits from malformed and untrusted execution', async () => {
    const disabled = fixture()
    disabled.deps.settings.mockResolvedValue({active: false, activation: null})
    expect(await run(['inspect'], env(), disabled.deps)).toBe(0)
    const blocked = fixture()
    blocked.set({...blocked.observation, candidate: {state: 'blocked'}})
    expect(await run(['inspect'], env(), blocked.deps)).toBe(1)
    const unknown = fixture()
    unknown.set({...unknown.observation, candidate: {state: 'unknown'}})
    expect(await run(['inspect'], env(), unknown.deps)).toBe(1)
    const invalid = fixture()
    expect(await run(['finish', '0'], env(), invalid.deps)).toBe(1)
    const failed = fixture()
    failed.deps.head.mockRejectedValue(new Error('secret'))
    expect(await run(['inspect'], env(), failed.deps)).toBe(1)
    expect(JSON.stringify(failed.deps.summary.mock.calls)).not.toContain('secret')
  })
  it('classifies review and check uncertainty separately from verified waits', async () => {
    const review = fixture()
    review.set({...review.observation, trigger: {kind: 'dispatch', actorId: 831617, ref: 'refs/heads/main', refVerified: true, reviewsVerified: true, reviews: []}})
    expect(await run(['inspect'], env(), review.deps)).toBe(0)
    review.set({...review.observation, trigger: {kind: 'dispatch', actorId: 831617, ref: 'refs/heads/main', refVerified: true, reviewsVerified: false, reviews: []}})
    expect(await run(['inspect'], env(), review.deps)).toBe(1)
    const checks = fixture()
    const candidate = checks.observation.candidate
    if (candidate.state !== 'ready' || candidate.gate.checks === null) throw new Error('invalid fixture')
    checks.set({...checks.observation, candidate: {...candidate, gate: {...candidate.gate, checks: {...candidate.gate.checks, checks: [{name: 'CI', revision: sha, disposition: 'nonpassing'}]}}}})
    expect(await run(['inspect'], env(), checks.deps)).toBe(0)
    checks.set({...checks.observation, candidate: {...candidate, gate: {...candidate.gate, checks: null}}})
    expect(await run(['inspect'], env(), checks.deps)).toBe(1)
  })
  it.each(['missing', 'queued', 'wrong-provider', 'bad-rules', 'incomplete'] as const)('classifies production check evidence %s through the CLI', async state => {
    const f = fixture()
    const candidate = f.observation.candidate
    if (candidate.state !== 'ready') throw new Error('invalid fixture')
    const evidence: CheckEvidence = {
      candidate: {verified: true, head: 'head', base: 'base', generatedAppPr: true},
      merge: {verified: true, sha, parents: ['base', 'head']},
      realCi: {verified: true, checks: [{name: 'CI', integrationId: 17}]},
      effectiveRules: {complete: true, noBypass: true, rules: [
        {type: 'pull_request', parameters: {allowed_merge_methods: ['squash']}},
        {type: 'required_status_checks', parameters: {strict_required_status_checks_policy: true, required_status_checks: [{context: 'CI', integration_id: 17}, {context: 'Other', integration_id: 18}]}},
        {type: 'code_scanning', parameters: {code_scanning_tools: [{tool: 'CodeQL', alerts_threshold: 'none', security_alerts_threshold: 'high_or_higher'}]}},
      ]},
      head: {complete: true, checks: [], statuses: []},
      testMerge: {complete: true, checks: [{id: 1, name: 'CI', head_sha: sha, app: {id: 17}, status: 'completed', conclusion: 'success'}], statuses: []},
    }
    if (state === 'queued') evidence.testMerge.checks.push({id: 2, name: 'Other', head_sha: sha, app: {id: 18}, status: 'queued', conclusion: null})
    if (state === 'wrong-provider') evidence.testMerge.checks.push({id: 2, name: 'Other', head_sha: sha, app: {id: 99}, status: 'queued', conclusion: null})
    if (state === 'bad-rules') evidence.effectiveRules.rules.pop()
    if (state === 'incomplete') evidence.testMerge.complete = false
    const checks = verifyReleaseChecks(evidence)
    f.set({...f.observation, candidate: {...candidate, gate: {...candidate.gate, checks}}})
    expect(await run(['inspect'], env(), f.deps)).toBe(state === 'missing' || state === 'queued' ? 0 : 1)
    expect(f.deps.output).not.toHaveBeenCalled()
    expect(f.deps.write).not.toHaveBeenCalled()
    expect(f.ports.merge).not.toHaveBeenCalled()
    if (state === 'missing' || state === 'queued') {
      expect(await run(['finish', '11'], env(), f.deps)).toBe(1)
      expect(f.ports.merge).not.toHaveBeenCalled()
    }
  })
  it('preserves a proved source on failed handoff without emitting outputs', async () => {
    for (const handoff of [
      async () => ({kind: 'stop' as const, reason: 'draft-unknown'}),
      async () => ({kind: 'handoff' as const, source: 'invalid', predecessor: {source, version: '2026.11.1', digest}, recovery: false, version: '2026.11.2', action: 'build' as const, original: null}),
      async () => { throw new Error('secret-app') },
    ]) {
      const f = fixture()
      const deps = {...f.deps, start: async () => ({ports: f.ports, handoff})}
      expect(await runController(['finish', '11'], env(), deps)).toBe(1)
      expect(f.deps.output).not.toHaveBeenCalled()
      expect(f.deps.write).not.toHaveBeenCalled()
      expect(JSON.stringify(f.deps.summary.mock.calls)).toContain(source)
      expect(JSON.stringify(f.deps.summary.mock.calls)).not.toContain('secret-app')
    }
  })
})

describe('Node controller dependencies', () => {
  it('preserves activation past more than 128 workflow changes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'u4-cli-long-history-'))
    try {
      execFileSync('git', ['init', '-q'], {cwd: directory})
      const makeCommit = (n: number) => {
        const body = `env:\n  HELD_RELEASE_ACTIVE: ${n === 0 ? 'false' : 'true'}\n# revision ${n}\n`
        return `commit refs/heads/main\ncommitter Test <test@example.invalid> 1767225600 +0000\ndata 1\nx\nM 100644 inline ${workflow}\ndata ${Buffer.byteLength(body)}\n${body}\n`
      }
      const history = `${Array.from({length: 132}, (_, n) => makeCommit(n)).join('')}done\n`
      execFileSync('git', ['fast-import', '--quiet'], {cwd: directory, input: history})
      execFileSync('git', ['checkout', '-q', 'main'], {cwd: directory})
      const f = fixture()
      const deps = nodeControllerDependencies({...env(), HELD_RELEASE_ACTIVE: 'true'}, f.deps.start, {cwd: directory})
      expect(await deps.settings(await deps.head())).toEqual({active: true, activation: '2026-01-01T00:00:00Z'})
    } finally {
      rmSync(directory, {recursive: true, force: true})
    }
  }, 120_000)
  it('tracks the current uninterrupted active segment in real first-parent Git history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'u4-cli-git-'))
    let clock = '2026-01-01T00:00:00Z'
    const git = (...args: string[]) => execFileSync('git', args, {cwd: directory, encoding: 'utf8', env: {...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_AUTHOR_DATE: clock, GIT_COMMITTER_DATE: clock}}).trim()
    const commit = (text: string, date: string) => {
      clock = date
      writeFileSync(join(directory, workflow), text)
      git('add', workflow)
      git('commit', '--no-gpg-sign', '-qm', 'workflow')
      return git('rev-parse', 'HEAD')
    }
    try {
      git('init', '-q')
      mkdirSync(join(directory, '.github/workflows'), {recursive: true})
      const yaml = (active: string, comment = '') => `name: Held\nenv:\n  HELD_RELEASE_ACTIVE: ${active}\n${comment}`
      commit(yaml('false'), '2026-01-01T00:00:00Z')
      commit(yaml('true'), '2026-01-02T00:00:00Z')
      const revision = commit(yaml('true', '# unrelated\n'), '2026-01-03T00:00:00Z')
      const deps = nodeControllerDependencies({...env(), HELD_RELEASE_ACTIVE: 'true'}, fixture().deps.start, {cwd: directory})
      expect(await deps.head()).toBe(revision)
      expect(await deps.settings(revision)).toEqual({active: true, activation: '2026-01-02T00:00:00Z'})
      commit(yaml('false'), '2026-01-04T00:00:00Z')
      const reactivated = commit(yaml('true'), '2026-01-05T00:00:00Z')
      expect(await deps.settings(reactivated)).toEqual({active: true, activation: '2026-01-05T00:00:00Z'})
      expect((await deps.settings(revision)).active).toBe(null)
      const mismatch = nodeControllerDependencies({...env(), HELD_RELEASE_ACTIVE: 'false'}, fixture().deps.start, {cwd: directory})
      expect((await mismatch.settings(reactivated)).active).toBe(null)
      const f = fixture()
      const mismatchRuntime = nodeControllerDependencies({...env(), HELD_RELEASE_ACTIVE: 'false'}, f.deps.start, {cwd: directory})
      await runController(['inspect'], {...env(), RELEASE_WORKFLOW_SHA: reactivated}, mismatchRuntime)
      expect(f.deps.start).not.toHaveBeenCalled()
      const invalid = commit(yaml('true', '  HELD_RELEASE_ACTIVE: true\n'), '2026-01-06T00:00:00Z')
      expect((await deps.settings(invalid)).active).toBe(null)
      const duplicate = commit(`${yaml('true')}env: {}\n`, '2026-01-07T00:00:00Z')
      expect((await deps.settings(duplicate)).active).toBe(null)
    } finally {
      rmSync(directory, {recursive: true, force: true})
    }
  })
  it('bounds identity and event reads and writes only to runner files', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'u4-cli-io-')))
    try {
      const eventPath = join(directory, 'event.json')
      const output = join(directory, 'output')
      const summary = join(directory, 'summary')
      writeFileSync(eventPath, JSON.stringify({schedule: '0 15 * * 0', payload: {ignore: 'untrusted'}}))
      writeFileSync(output, '')
      writeFileSync(summary, '')
      const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({login: 'marcusrbrown', id: 831617, type: 'User'})))
      const deps = nodeControllerDependencies({...env(), RUNNER_TEMP: directory, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary}, fixture().deps.start, {fetch: fetcher})
      expect(await deps.ownerId()).toBe(831617)
      expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.github.com/users/marcusrbrown')
      expect(JSON.stringify(fetcher.mock.calls)).not.toContain('secret-')
      expect(await deps.schedule(eventPath)).toBe('0 15 * * 0')
      expect(await deps.schedule(join(directory, 'other'))).toBe(null)
      await deps.write(join(directory, 'release-authorization.json'), '{}\n')
      expect(statSync(join(directory, 'release-authorization.json')).mode & 0o777).toBe(0o600)
      await expect(deps.write(join(directory, 'other'), '{}')).rejects.toThrow()
      await expect(deps.write(join(directory, 'release-authorization.json'), '{}')).rejects.toThrow()
      await deps.output('authorize=true\n')
      await deps.summary('Skipped.\n')
      expect(readFileSync(output, 'utf8')).toBe('authorize=true\n')
      expect(readFileSync(summary, 'utf8')).toBe('Skipped.\n')
      writeFileSync(eventPath, 'x'.repeat(65537))
      expect(await deps.schedule(eventPath)).toBe(null)
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({login: 'other', id: 831617, type: 'User'})))
      expect(await deps.ownerId()).toBe(null)
    } finally {
      rmSync(directory, {recursive: true, force: true})
    }
  })
})
