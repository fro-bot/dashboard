/**
 * Guards the production image boundary in the Dockerfile.
 *
 * The runtime image holds only the root package's production dependencies. Two
 * Dockerfile properties enforce that:
 * - the prod-deps stage installs with `--production`, so no dev dependency or
 *   build tool reaches the image;
 * - no stage copies the whole build context, so nothing enters an image unnamed.
 *
 * Stages are found by their `FROM ... AS <name>` lines, never by line number. The
 * runtime stage is the last stage.
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {describe, expect, it} from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

const PROD_DEPS_STAGE = 'prod-deps'

interface Instruction {
  readonly keyword: string
  readonly args: string
}

interface Stage {
  readonly name: string | undefined
  readonly instructions: readonly Instruction[]
}

/** Joins `\` line continuations, drops comments and blank lines, and splits `KEYWORD args`. */
function parseInstructions(dockerfile: string): Instruction[] {
  const instructions: Instruction[] = []
  let pending = ''
  for (const rawLine of dockerfile.split('\n')) {
    const line = rawLine.trim()
    if (pending === '' && (line === '' || line.startsWith('#'))) continue
    if (pending !== '' && line.startsWith('#')) continue
    const continued = line.endsWith('\\')
    pending += `${continued ? line.slice(0, -1) : line} `
    if (continued) continue
    const statement = pending.trim()
    const split = statement.search(/\s/)
    const keyword = split === -1 ? statement : statement.slice(0, split)
    instructions.push({keyword: keyword.toUpperCase(), args: split === -1 ? '' : statement.slice(split).trim()})
    pending = ''
  }
  return instructions
}

function parseStages(dockerfile: string): Stage[] {
  const stages: {name: string | undefined; instructions: Instruction[]}[] = []
  for (const instruction of parseInstructions(dockerfile)) {
    if (instruction.keyword === 'FROM') {
      const alias = /\sAS\s+(\S+)\s*$/i.exec(instruction.args)
      stages.push({name: alias?.[1], instructions: []})
    } else {
      stages.at(-1)?.instructions.push(instruction)
    }
  }
  return stages
}

interface CopySource {
  readonly path: string
  readonly fromStage: boolean
}

/** COPY/ADD source paths, without flags or the destination. */
function copySources(instruction: Instruction): CopySource[] {
  if (instruction.keyword !== 'COPY' && instruction.keyword !== 'ADD') return []
  const tokens = instruction.args.split(/\s+/).filter(token => token !== '')
  const flags = tokens.filter(token => token.startsWith('--'))
  const operands = tokens.filter(token => !token.startsWith('--'))
  const fromStage = flags.some(flag => flag.startsWith('--from='))
  return operands.slice(0, -1).map(path => ({path, fromStage}))
}

function findBoundaryViolations(dockerfile: string): string[] {
  const violations: string[] = []
  const stages = parseStages(dockerfile)
  const label = (stage: Stage) => stage.name ?? 'runtime'

  const prodDeps = stages.find(stage => stage.name === PROD_DEPS_STAGE)
  if (prodDeps === undefined) {
    violations.push(`no ${PROD_DEPS_STAGE} stage found`)
  } else {
    const installs = prodDeps.instructions.filter(i => i.keyword === 'RUN' && /\bbun\s+install\b/.test(i.args))
    if (installs.length === 0) violations.push(`${PROD_DEPS_STAGE} stage has no bun install`)
    for (const {args} of installs) {
      if (!/(?:^|\s)--production(?:\s|$)/.test(args)) violations.push(`${PROD_DEPS_STAGE} bun install lacks --production: ${args}`)
    }
  }

  for (const stage of stages) {
    for (const instruction of stage.instructions) {
      for (const {path, fromStage} of copySources(instruction)) {
        if (!fromStage && ['.', './', '*'].includes(path)) {
          violations.push(`${label(stage)} stage copies the whole build context: ${path}`)
        }
      }
    }
  }

  if (stages.length === 0) violations.push('no stages found')

  return violations
}

const validDockerfile = [
  'FROM node:24 AS builder',
  'COPY package.json bun.lock bunfig.toml ./',
  'RUN bun install --frozen-lockfile',
  '',
  'FROM node:24 AS prod-deps',
  'COPY package.json bun.lock bunfig.toml ./',
  'RUN bun install --production --frozen-lockfile --ignore-scripts',
  '',
  'FROM node:24',
  'COPY --from=prod-deps /app/node_modules/ ./node_modules/',
  'COPY src/ ./src/',
  'COPY --from=builder /app/web/dist/ ./web/dist/',
  '',
].join('\n')

describe('Dockerfile production image boundary', () => {
  it('reports no violations for the real Dockerfile', () => {
    const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8')
    expect(findBoundaryViolations(dockerfile)).toEqual([])
  })

  it('finds the named stages and the unnamed runtime stage', () => {
    const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8')
    const names = parseStages(dockerfile).map(stage => stage.name)
    expect(names).toContain('builder')
    expect(names).toContain(PROD_DEPS_STAGE)
    expect(names.at(-1)).toBeUndefined()
  })
})

describe('Dockerfile boundary checker (error paths)', () => {
  it('accepts a conforming Dockerfile', () => {
    expect(findBoundaryViolations(validDockerfile)).toEqual([])
  })

  it('rejects a prod-deps install without --production', () => {
    const mutated = validDockerfile.replace('--production ', '')
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining('lacks --production')])
  })

  it('does not take a --production-like flag for --production', () => {
    const mutated = validDockerfile.replace('--production ', '--production-mode ')
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining('lacks --production')])
  })

  it('reads a prod-deps install split across continuation lines', () => {
    const mutated = validDockerfile.replace('--production --frozen-lockfile', '\\\n  --production \\\n  --frozen-lockfile')
    expect(findBoundaryViolations(mutated)).toEqual([])
  })

  it('rejects a continued prod-deps install that drops --production', () => {
    const mutated = validDockerfile.replace('--production --frozen-lockfile', '\\\n  --frozen-lockfile')
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining('lacks --production')])
  })

  it('rejects a whole-context copy in a build stage', () => {
    const mutated = validDockerfile.replace('FROM node:24 AS prod-deps', 'COPY . .\nFROM node:24 AS prod-deps')
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining('builder stage copies the whole build context')])
  })

  it('rejects a whole-context copy in the runtime stage', () => {
    const mutated = `${validDockerfile}COPY ./ ./\n`
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining('runtime stage copies the whole build context')])
  })

  it('rejects a wildcard copy in the prod-deps stage', () => {
    const mutated = validDockerfile.replace(
      'RUN bun install --production',
      'COPY * ./\nRUN bun install --production',
    )
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining('prod-deps stage copies the whole build context')])
  })

  it('allows copying a whole earlier stage', () => {
    const mutated = `${validDockerfile}COPY --from=builder /app/ ./\n`
    expect(findBoundaryViolations(mutated)).toEqual([])
  })

  it('ignores commented-out whole-context copies', () => {
    const mutated = `${validDockerfile}# COPY . .\n`
    expect(findBoundaryViolations(mutated)).toEqual([])
  })

  it('reports a Dockerfile with no prod-deps stage', () => {
    expect(findBoundaryViolations('FROM node:24\n')).toEqual([`no ${PROD_DEPS_STAGE} stage found`])
  })

  it('reports a prod-deps stage with no install', () => {
    const mutated = validDockerfile.replace(/RUN bun install --production[^\n]*\n/u, '')
    expect(findBoundaryViolations(mutated)).toEqual([`${PROD_DEPS_STAGE} stage has no bun install`])
  })
})
