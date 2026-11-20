/**
 * Pins the trust gates in .github/workflows/fro-bot.yaml.
 *
 * The workflow runs an agent with a write-capable token. Anyone can open or edit an issue, so
 * issue-triggered runs must be limited to trusted authors, the checkout must never persist its
 * credential in the workspace, and the agent step must run isolated. These tests keep a later
 * edit from dropping any guard.
 */
import {spawnSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import process from 'node:process'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

interface Step {
  readonly id?: string
  readonly if?: string
  readonly run?: string
  readonly uses?: string
  readonly with?: Record<string, unknown>
  readonly env?: Record<string, string>
}

interface Job {
  readonly if?: string
  readonly steps: readonly Step[]
}

const workflow = parse(readFileSync(resolve(process.cwd(), '.github/workflows/fro-bot.yaml'), 'utf8')) as {
  readonly on: Record<string, unknown>
  readonly permissions: Record<string, string>
  readonly env: Record<string, string>
  readonly jobs: Record<string, Job>
}

const job = workflow.jobs['fro-bot']
if (job === undefined) throw new Error('job fro-bot not found')

function squash(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim()
}

function clauseFor(condition: string, event: string, nextEvent: string): string {
  const start = condition.indexOf(`github.event_name == '${event}'`)
  const end = condition.indexOf(`github.event_name == '${nextEvent}'`, start)
  if (start === -1 || end === -1) throw new Error(`could not isolate the ${event} clause`)
  return condition.slice(start, end)
}

describe('fro-bot workflow — issues trust gate', () => {
  const condition = squash(job.if ?? '')

  it('limits issue-triggered runs to owner, member and collaborator authors, denying a missing value', () => {
    const clause = clauseFor(condition, 'issues', 'pull_request')
    expect(clause).toContain(
      `contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.issue.author_association || '')`,
    )
  })

  it('uses the same trust set for comment-triggered runs', () => {
    expect(condition).toContain(
      `contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association || '')`,
    )
  })
})

describe('fro-bot workflow — checkout credential', () => {
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'))

  it('never persists the checkout credential, using a literal rather than an expression', () => {
    // A literal boolean applies to every trigger; an expression could silently exempt one.
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  })

  it('declares the review-path and delivery triggers the literal covers', () => {
    const triggers = Object.keys(workflow.on)
    for (const trigger of ['pull_request_review_comment', 'issue_comment', 'schedule', 'workflow_dispatch']) {
      expect(triggers, `workflow does not declare ${trigger}`).toContain(trigger)
    }
  })
})

describe('fro-bot workflow — agent isolation', () => {
  const agent = job.steps.find(step => step.uses?.startsWith('fro-bot/agent@'))

  it('enables isolate-agent on the agent step', () => {
    expect(agent?.with?.['isolate-agent']).toBe('true')
  })

  it('still passes the explicit token to the agent step', () => {
    expect(squash(String(agent?.with?.['github-token'] ?? ''))).toMatch(/^\$\{\{ secrets\.FRO_BOT_PAT \}\}$/u)
  })
})

function execute(script: string, env: Record<string, string>, gh = '') {
  const dir = mkdtempSync(join(tmpdir(), 'fro-bot-workflow-'))
  try {
    writeFileSync(join(dir, 'gh'), `#!/bin/bash\n${gh}\n`, {mode: 0o755})
    writeFileSync(join(dir, 'git'), '#!/bin/bash\nprintf "%s\\n" "$TEST_HEAD"\n', {mode: 0o755})
    const output = join(dir, 'output')
    writeFileSync(output, '')
    const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], {
      encoding: 'utf8', env: {PATH: `${dir}:/usr/bin:/bin:/opt/homebrew/bin`, GITHUB_OUTPUT: output, ...env},
    })
    return {status: result.status, stdout: result.stdout, stderr: result.stderr, output: readFileSync(output, 'utf8')}
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

describe('fro-bot workflow — trusted PR comment head', () => {
  const sha = 'a'.repeat(40)
  const pr = {
    state: 'open', user: {type: 'User', login: 'author'},
    head: {sha, ref: 'fix/example', repo: {full_name: 'fro-bot/dashboard', fork: false}},
    base: {ref: 'main', repo: {full_name: 'fro-bot/dashboard'}},
  }
  const resolver = job.steps.find(step => step.id === 'prehead')
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'))
  const setup = job.steps.find(step => step.uses === './.github/actions/setup')
  const check = job.steps.find(step => step.id === 'verify-head')
  const agent = job.steps.find(step => step.uses?.startsWith('fro-bot/agent@'))

  function resolveHead(changes: {pr?: unknown; permission?: string; commenter?: string; commenterType?: string; fail?: string} = {}) {
    expect(resolver?.run, 'trusted precheckout resolver must exist').toBeTruthy()
    return execute(resolver?.run ?? '', {
      EVENT_NAME: 'issue_comment', PR_NUMBER: '42', REPOSITORY: 'fro-bot/dashboard', DEFAULT_BRANCH: 'main',
      COMMENTER: changes.commenter ?? 'writer', COMMENTER_TYPE: changes.commenterType ?? 'User',
      TEST_PR: JSON.stringify(changes.pr ?? pr), TEST_PERMISSION: changes.permission ?? 'write', TEST_FAIL: changes.fail ?? '',
    }, `if [[ "$#" == 2 && "$1" == api && "$2" == repos/fro-bot/dashboard/collaborators/writer/permission ]]; then\n  [[ "$TEST_FAIL" != permission ]] || { echo 'private response' >&2; exit 1; }\n  printf '{"permission":"%s"}' "$TEST_PERMISSION"\nelif [[ "$#" == 2 && "$1" == api && "$2" == repos/fro-bot/dashboard/pulls/42 ]]; then\n  [[ "$TEST_FAIL" != pr ]] || { echo 'private response' >&2; exit 1; }\n  printf '%s' "$TEST_PR"\nelse\n  exit 1\nfi`)
  }

  it.each(['write', 'admin'])('resolves an open same-repository human PR for live %s permission', permission => {
    const result = resolveHead({permission})
    expect(result.status).toBe(0)
    expect(result.output).toBe(`ref=${sha}\n`)
    expect(result.stdout + result.stderr).toBe('')
  })

  it.each([
    ['fork', {...pr, head: {...pr.head, repo: {...pr.head.repo, fork: true}}}],
    ['head repository mismatch', {...pr, head: {...pr.head, repo: {...pr.head.repo, full_name: 'other/repo'}}}],
    ['base repository mismatch', {...pr, base: {...pr.base, repo: {full_name: 'other/repo'}}}],
    ['closed', {...pr, state: 'closed'}],
    ['wrong base branch', {...pr, base: {...pr.base, ref: 'other'}}],
    ['same branch', {...pr, head: {...pr.head, ref: 'main'}}],
    ['reserved release head', {...pr, head: {...pr.head, ref: 'release/pending'}}],
    ['bot author', {...pr, user: {type: 'Bot', login: 'robot'}}],
    ['Fro Bot author', {...pr, user: {type: 'User', login: 'fro-bot'}}],
    ['malformed SHA', {...pr, head: {...pr.head, sha: 'A'.repeat(40)}}],
    ['SHA with newline', {...pr, head: {...pr.head, sha: `${sha}\n`}}],
    ['empty SHA', {...pr, head: {...pr.head, sha: ''}}],
  ])('falls back without an anchor for %s', (_name, candidate) => {
    const result = resolveHead({pr: candidate})
    expect(result.status).toBe(0)
    expect(result.output).toBe('')
    expect(result.stdout + result.stderr).toBe('')
  })

  it.each([
    ['read permission', {permission: 'read'}], ['unknown permission', {permission: 'unknown'}],
    ['bot commenter', {commenterType: 'Bot'}], ['Fro Bot commenter', {commenter: 'fro-bot'}],
    ['Fro Bot commenter with different case', {commenter: 'Fro-Bot'}],
  ])('falls back without an anchor on %s', (_name, changes) => {
    const result = resolveHead(changes)
    expect(result.status).toBe(0)
    expect(result.output).toBe('')
    expect(result.stdout + result.stderr).toBe('')
  })

  it.each([
    ['permission', '::warning::Permission lookup failed; using reply-only fallback\n'],
    ['pr', '::warning::PR lookup failed; using reply-only fallback\n'],
  ])('warns safely and falls back when the %s lookup fails', (fail, warning) => {
    const result = resolveHead({fail})
    expect(result.status).toBe(0)
    expect(result.output).toBe('')
    expect(result.stdout).toBe(warning)
    expect(result.stderr).toBe('')
  })

  it('uses one anchor for checkout and broker and suppresses setup only for that route', () => {
    expect(job.steps.findIndex(step => step.id === 'prehead')).toBeLessThan(job.steps.findIndex(step => step.uses?.startsWith('actions/checkout@')))
    expect(checkout?.with?.ref).toBe(`\${{ steps.prehead.outputs.ref }}`)
    expect(agent?.with?.['trusted-head-sha']).toBe(checkout?.with?.ref)
    expect(agent?.with?.['brokered-push-extra-paths']).toBe('web/src,test')
    expect(setup?.if).toBe(`\${{ steps.prehead.outputs.ref == '' }}`)
    expect(check?.if).toBe(`\${{ steps.prehead.outputs.ref != '' }}`)
    expect(job.steps.findIndex(step => step.id === 'verify-head')).toBeLessThan(job.steps.findIndex(step => step.uses?.startsWith('fro-bot/agent@')))
    expect(resolver?.if).toContain("github.event_name == 'issue_comment'")
    expect(resolver?.if).toContain('github.event.issue.pull_request')
    expect(resolver?.env).toEqual({
      GH_TOKEN: `\${{ secrets.FRO_BOT_PAT }}`,
      EVENT_NAME: `\${{ github.event_name }}`,
      PR_NUMBER: `\${{ github.event.issue.number }}`,
      REPOSITORY: `\${{ github.repository }}`,
      DEFAULT_BRANCH: `\${{ github.event.repository.default_branch }}`,
      COMMENTER: `\${{ github.event.comment.user.login }}`,
      COMMENTER_TYPE: `\${{ github.event.comment.user.type }}`,
    })
    expect(resolver?.run).not.toContain('${{')
    expect(workflow.permissions).toEqual({contents: 'read'})
  })

  it('fails before the agent if checked out HEAD does not match the anchor', () => {
    expect(check?.run).toBeTruthy()
    expect(execute(check?.run ?? '', {TRUSTED_HEAD_SHA: sha, TEST_HEAD: sha}).status).toBe(0)
    expect(execute(check?.run ?? '', {TRUSTED_HEAD_SHA: sha, TEST_HEAD: 'b'.repeat(40)}).status).not.toBe(0)
  })
})

describe('fro-bot workflow — daily report', () => {
  const prompt = squash(workflow.env.SCHEDULE_PROMPT ?? '')
  const agent = job.steps.find(step => step.uses?.startsWith('fro-bot/agent@'))

  it('publishes substantive findings for all six categories without report-only PRs', () => {
    for (const section of ['Errored PRs', 'Security', 'Code Quality', 'Workflow Integrity', 'Progressive Improvement', 'Cross-Project Intelligence']) {
      expect(prompt).toContain(`### ${section}`)
    }
    expect(prompt).toMatch(/substantive.+findings.+next steps/iu)
    expect(prompt).toMatch(/no actual scoped fix.+(?:branches|branch).+commits.+PRs/iu)
    expect(prompt).toMatch(/do not write reports (?:into|to) docs\/reports/iu)
    expect(prompt).not.toMatch(/links only/iu)
  })

  it('fails closed when identifying reports and safely migrates legacy reports', () => {
    expect(prompt).toContain('<!-- fro-bot-daily-report-v1 -->')
    expect(prompt).toContain('fro-bot-run-summary')
    expect(prompt).toMatch(/paginated/iu)
    expect(prompt).toMatch(/exclude (?:pull requests|PRs)/iu)
    expect(prompt).toMatch(/exact title.+any state/iu)
    expect(prompt).toMatch(/(?:failed|fails).+(?:partial|unparseable).+no report mutations/iu)
    expect(prompt).toMatch(/verified Fro Bot authorship/iu)
    expect(prompt).toMatch(/read back.+before closing/iu)
    expect(prompt).toMatch(/do not reopen/iu)
  })

  it('publishes only confirmed-public cross-repo information and distinguishes unavailable checks', () => {
    expect(prompt).toMatch(/visibility.+PUBLIC/iu)
    expect(prompt).toMatch(/omit.+identifying details.+(?:nonpublic|unknown)/iu)
    expect(prompt).toMatch(/(?:unavailable|failed).+never.+(?:clean|✅)/iu)
  })

  it('preserves manual prompt precedence and branch-pr delivery for fixes', () => {
    const taskPrompt = squash(agent?.env?.TASK_PROMPT ?? '')
    const outputMode = squash(String(agent?.with?.['output-mode'] ?? ''))
    const expectedTaskPrompt = `\${{ (github.event_name == 'workflow_dispatch' && github.event.inputs.prompt) || ((github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && env.SCHEDULE_PROMPT) || (github.event_name == 'pull_request' && env.PR_REVIEW_PROMPT) || '' }}`
    const expectedOutputMode = `\${{ (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && 'branch-pr' || 'auto' }}`
    expect(taskPrompt).toBe(expectedTaskPrompt)
    expect(outputMode).toBe(expectedOutputMode)

    expect(prompt).toMatch(/real (?:code|scoped).+remediation/iu)
  })
})
