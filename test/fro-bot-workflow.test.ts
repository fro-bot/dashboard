/**
 * Pins the trust gates in .github/workflows/fro-bot.yaml.
 *
 * The workflow runs an agent with a write-capable token. Anyone can open or edit an issue, so
 * issue-triggered runs must be limited to trusted authors, the checkout must never persist its
 * credential in the workspace, and the agent step must run isolated. These tests keep a later
 * edit from dropping any guard.
 */
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import process from 'node:process'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

interface Step {
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
