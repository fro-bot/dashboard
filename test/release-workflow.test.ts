/**
 * Pins the token scoping and ref gating in .github/workflows/release.yaml.
 *
 * The publication token is minted from a GitHub App whose installation is broader than the
 * release needs, so the mint-time `permission-*` and `repositories` inputs are the only thing
 * that narrows it. These tests keep that narrowing from being dropped by a later edit.
 */
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import process from 'node:process'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

interface Step {
  readonly id?: string
  readonly uses?: string
  readonly with?: Record<string, unknown>
}

interface Job {
  readonly if?: string
  readonly steps: readonly Step[]
}

const workflow = parse(readFileSync(resolve(process.cwd(), '.github/workflows/release.yaml'), 'utf8')) as {
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
