/**
 * Pins token scoping, ref gating, and listener smoke coverage in .github/workflows/release.yaml.
 *
 * The publication token is minted from a GitHub App whose installation is broader than the
 * release needs, so the mint-time `permission-*` and `repositories` inputs are the only thing
 * that narrows it. These tests keep that narrowing from being dropped by a later edit.
 */
import {spawnSync} from 'node:child_process'
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import process from 'node:process'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

interface Step {
  readonly name?: string
  readonly id?: string
  readonly uses?: string
  readonly with?: Record<string, unknown>
  readonly run?: string
  readonly env?: Record<string, string>
}

interface Job {
  readonly if?: string
  readonly steps: readonly Step[]
  readonly permissions?: Record<string, string>
}

const workflow = parse(readFileSync(resolve(process.cwd(), '.github/workflows/release.yaml'), 'utf8')) as {
  readonly on: Record<string, unknown>
  readonly jobs: Record<string, Job>
}

function mintStep(job: string, id: string): Step {
  const step = workflow.jobs[job]?.steps.find(candidate => candidate.id === id)
  if (step === undefined) throw new Error(`step ${id} not found in job ${job}`)
  return step
}

function permissionInputs(step: Step): Record<string, unknown> {
  return Object.fromEntries(Object.entries(step.with ?? {}).filter(([name]) => name.startsWith('permission-')))
}

describe('release workflow — listener smoke test', () => {
  it('enables the listener and requires an unsigned ingest request to return 401', () => {
    const step = workflow.jobs.release?.steps.find(candidate => candidate.name === '🧪 Smoke-test candidate image by digest')
    const script = step?.run ?? ''
    const request = script.split('\n').find(line => line.includes('/api/listener/ingest')) ?? ''
    expect(script).toMatch(/DASHBOARD_LISTENER_INGEST_KEY=\$\(openssl rand -hex 32\)/u)
    expect(script).toMatch(/export DASHBOARD_LISTENER_INGEST_KEY/u)
    expect(script).toMatch(/-e DASHBOARD_LISTENER_DB=:memory:/u)
    expect(script).toMatch(/-e DASHBOARD_LISTENER_INGEST_KEY(?:\s|\\)/u)
    expect(request).toContain('curl ')
    expect(request).toContain('--max-time 5')
    expect(request).toContain('-X POST')
    expect(request).toContain("-d '{}'")
    expect(request).toContain('http://127.0.0.1:8080/api/listener/ingest')
    expect(script).toMatch(/\[ "\$listener_status" != 401 \]/u)
  })
})

describe('release workflow — publication token', () => {
  const step = mintStep('release', 'app-token')

  it('is minted with a pinned create-github-app-token', () => {
    expect(step.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}\b/u)
  })

  it('requests contents:write and nothing else', () => {
    // Uses: git ref create/delete, release create/view/edit/delete.
    expect(permissionInputs(step)).toEqual({'permission-contents': 'write'})
  })

  it('is limited to this repository by name', () => {
    expect(step.with?.owner).toMatch(/github\.repository_owner/u)
    expect(step.with?.repositories).toMatch(/github\.event\.repository\.name/u)
  })
})

describe('release workflow — infra dispatch token', () => {
  it('stays limited to the infra repository with actions:write only', () => {
    const step = mintStep('dispatch-deploy', 'dispatch-token')
    expect(permissionInputs(step)).toEqual({'permission-actions': 'write'})
    expect(step.with?.repositories).toBe('infra')
  })
})

describe('release workflow — ref gate', () => {
  it('the release job runs only on main, independent of the guard script', () => {
    const condition = workflow.jobs.release?.if ?? ''
    expect(condition).toContain("needs.guard.outputs.should-release == 'true'")
    expect(condition).toContain("github.ref == 'refs/heads/main'")
  })
})

describe('release workflow — batch push guard', () => {
  it('only triggers for batch notes on main and uses scoped read permissions', () => {
    expect(workflow.on).toEqual({push: {branches: ['main'], paths: ['docs/releases/batch.md']}})
    expect(workflow.jobs.guard?.permissions).toEqual({contents: 'read', 'pull-requests': 'read'})
    const checkout = workflow.jobs.guard?.steps.find(step => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.ref).toBe(`\${{ github.sha }}`)
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  })

  it('executes the real shell against a squash commit and fails closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-guard-'))
    try {
      const git = (...args: string[]): string => {
        const result = spawnSync('git', args, {cwd: dir, encoding: 'utf8'})
        if (result.status !== 0) throw new Error(result.stderr)
        return result.stdout.trim()
      }
      git('init', '-q')
      git('config', 'user.email', 'fixture@example.test')
      git('config', 'user.name', 'Fixture')
      mkdirSync(join(dir, 'docs/releases'), {recursive: true})
      writeFileSync(join(dir, 'docs/releases/batch.md'), 'before\n')
      git('add', '.')
      git('commit', '--no-gpg-sign', '-qm', 'base')
      writeFileSync(join(dir, 'docs/releases/batch.md'), 'after\n')
      git('commit', '--no-gpg-sign', '-qam', 'squash')
      const sha = git('rev-parse', 'HEAD')
      const bot = {login: 'fro-bot[bot]', id: 109017866, type: 'Bot'}
      const pr = {number: 42, state: 'closed', merged: true, merge_commit_sha: sha, user: bot, merged_by: bot,
        head: {ref: 'release/pending', repo: {full_name: 'fro-bot/dashboard'}},
        base: {ref: 'main', repo: {full_name: 'fro-bot/dashboard'}}}
      writeFileSync(join(dir, 'list.json'), JSON.stringify([[{number: 42}]]))
      writeFileSync(join(dir, 'detail.json'), JSON.stringify(pr))
      mkdirSync(join(dir, 'bin'))
      const gh = join(dir, 'bin/gh')
      writeFileSync(gh, '#!/bin/bash\nset -eu\nif [ "$FAIL_GH" = 1 ]; then echo "fixture API failure" >&2; exit 1; fi\ncase "$*" in *"/commits/"*) /bin/cat "$FIXTURE_DIR/list.json" ;; *"/pulls/42"*) /bin/cat "$FIXTURE_DIR/detail.json" ;; *) echo "unexpected gh arguments: $*" >&2; exit 1 ;; esac\n')
      chmodSync(gh, 0o755)
      const run = (extra: Record<string, string> = {}) => {
        const output = join(dir, 'output')
        writeFileSync(output, '')
        const script = mintStep('guard', 'check').run
        expect(script).toBeTruthy()
        const result = spawnSync('bash', ['-Eeuo', 'pipefail', '-c', script ?? ''], {cwd: dir, encoding: 'utf8', env: {
          ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FIXTURE_DIR: dir,
          GITHUB_OUTPUT: output, EVENT_NAME: 'push', EVENT_REF: 'refs/heads/main', EVENT_SHA: sha,
          REPOSITORY: 'fro-bot/dashboard', GH_TOKEN: 'inert', FAIL_GH: '', ...extra,
        }})
        return {status: result.status, output: readFileSync(output, 'utf8'), stdout: result.stdout, stderr: result.stderr}
      }
      const qualified = run()
      expect(qualified).toMatchObject({status: 0, output: 'should-release=true\n'})
      writeFileSync(join(dir, 'detail.json'), JSON.stringify({...pr, merged_by: {...bot, id: 1}}))
      const wrongMerger = run()
      expect(wrongMerger).toMatchObject({status: 0, output: 'should-release=false\n'})
      writeFileSync(join(dir, 'detail.json'), JSON.stringify({...pr, user: {...bot, id: 1}}))
      expect(run()).toMatchObject({status: 0, output: 'should-release=false\n'})
      writeFileSync(join(dir, 'detail.json'), JSON.stringify({...pr, merged_by: {...bot, id: null}}))
      expect(run()).toMatchObject({status: 0, output: 'should-release=false\n'})
      writeFileSync(join(dir, 'detail.json'), JSON.stringify({...pr, merge_commit_sha: '0'.repeat(40)}))
      expect(run()).toMatchObject({status: 0, output: 'should-release=false\n'})
      writeFileSync(join(dir, 'detail.json'), JSON.stringify({...pr, head: {...pr.head, ref: 'other'}}))
      expect(run()).toMatchObject({status: 0, output: 'should-release=false\n'})
      expect(run({EVENT_REF: 'refs/heads/other'})).toMatchObject({status: 0, output: 'should-release=false\n'})
      const failed = run({FAIL_GH: '1'})
      expect(failed.status).not.toBe(0)
      expect(failed.output).not.toContain('should-release=true')
      expect(`${failed.stdout}${failed.stderr}`).toMatch(/API|failed/i)
      writeFileSync(join(dir, 'list.json'), '[]')
      const unassociated = run()
      expect(unassociated).toMatchObject({status: 0, output: 'should-release=false\n'})
      expect(unassociated.stdout).toContain('rerun')
      writeFileSync(join(dir, 'list.json'), JSON.stringify([[{number: 42}, {number: 43}]]))
      expect(run().status).not.toBe(0)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })
})
