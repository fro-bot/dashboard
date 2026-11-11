/**
 * Pins the trust gates in .github/workflows/fro-bot.yaml.
 *
 * The workflow runs an agent with a write-capable token. Anyone can open or edit an issue, so
 * issue-triggered runs must be limited to trusted authors, and every review-path trigger must
 * withhold the checkout credential from the workspace. These tests keep a later edit from
 * dropping either guard.
 */
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import process from 'node:process'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

interface Step {
  readonly uses?: string
  readonly with?: Record<string, unknown>
}

interface Job {
  readonly if?: string
  readonly steps: readonly Step[]
}

const workflow = parse(readFileSync(resolve(process.cwd(), '.github/workflows/fro-bot.yaml'), 'utf8')) as {
  readonly on: Record<string, unknown>
  readonly jobs: Record<string, Job>
}

const job = workflow.jobs['fro-bot']
if (job === undefined) throw new Error('job fro-bot not found')

function squash(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim()
}

// Triggers that deliver through a caller-side push and therefore keep the credential.
const CREDENTIAL_KEEPING_TRIGGERS = new Set(['schedule', 'workflow_dispatch'])

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
  const expression = squash(String(checkout?.with?.['persist-credentials'] ?? ''))
  const listMatch = /fromJSON\('(?<list>\[[^\]]*\])'\)/u.exec(expression)

  it('negates a fixed list of event names', () => {
    expect(expression).toMatch(/^\$\{\{ !contains\(fromJSON\('\[.*\]'\), github\.event_name\) \}\}$/u)
    expect(listMatch?.groups?.list).toBeDefined()
  })

  it('withholds the credential on every declared trigger except schedule and dispatch', () => {
    const withheld = JSON.parse(listMatch?.groups?.list ?? '[]') as string[]
    const reviewPathTriggers = Object.keys(workflow.on).filter(trigger => !CREDENTIAL_KEEPING_TRIGGERS.has(trigger))
    expect(reviewPathTriggers).toContain('pull_request_review_comment')
    for (const trigger of reviewPathTriggers) {
      expect(withheld, `persist-credentials list is missing ${trigger}`).toContain(trigger)
    }
  })

  it('keeps the credential for schedule and dispatch runs, which deliver by pushing', () => {
    const withheld = JSON.parse(listMatch?.groups?.list ?? '[]') as string[]
    for (const trigger of CREDENTIAL_KEEPING_TRIGGERS) expect(withheld).not.toContain(trigger)
  })
})
