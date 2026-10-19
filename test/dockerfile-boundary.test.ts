/**
 * Guards the wiki-writer boundary in the Dockerfile.
 *
 * The runtime image holds only the root package's production dependencies and none
 * of the wiki-writer workspace. Two Dockerfile properties enforce that:
 * - the prod-deps stage installs with `--filter './'` and `--production`;
 * - no stage copies wiki-writer source, and the runtime stage copies nothing from
 *   `wiki-writer/` at all. The only allowed wiki-writer path is its manifest, which
 *   the build stages need so the lockfile matches the workspace.
 *
 * Stages are found by their `FROM ... AS <name>` lines, never by line number. The
 * runtime stage is the last stage.
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {describe, expect, it} from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

const ALLOWED_WRITER_PATH = 'wiki-writer/package.json'
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

function normalizePath(path: string): string {
  return path.replace(/^(?:\.\/)+/, '')
}

function mentionsWriter(path: string): boolean {
  return normalizePath(path).startsWith('wiki-writer')
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
      if (!/--filter[\s=]['"]?\.\/['"]?(?:\s|$)/.test(args)) violations.push(`${PROD_DEPS_STAGE} bun install lacks --filter './': ${args}`)
      if (!/(?:^|\s)--production(?:\s|$)/.test(args)) violations.push(`${PROD_DEPS_STAGE} bun install lacks --production: ${args}`)
    }
  }

  for (const stage of stages) {
    for (const instruction of stage.instructions) {
      for (const {path, fromStage} of copySources(instruction)) {
        if (mentionsWriter(path) && normalizePath(path) !== ALLOWED_WRITER_PATH) {
          violations.push(`${label(stage)} stage copies wiki-writer source: ${path}`)
        }
        // A whole-context copy pulls wiki-writer in without naming it.
        if (!fromStage && ['.', './', '*'].includes(path)) {
          violations.push(`${label(stage)} stage copies the whole build context: ${path}`)
        }
      }
    }
  }

  const runtime = stages.at(-1)
  if (runtime === undefined) {
    violations.push('no stages found')
  } else {
    for (const instruction of runtime.instructions) {
      for (const {path} of copySources(instruction)) {
        if (mentionsWriter(path)) violations.push(`runtime stage copies from wiki-writer/: ${path}`)
      }
    }
  }

  return violations
}

const validDockerfile = [
  'FROM node:24 AS builder',
  'COPY package.json bun.lock bunfig.toml ./',
  'COPY wiki-writer/package.json ./wiki-writer/package.json',
  'RUN bun install --frozen-lockfile',
  '',
  'FROM node:24 AS prod-deps',
  'COPY package.json bun.lock bunfig.toml ./',
  'COPY wiki-writer/package.json ./wiki-writer/package.json',
  "RUN bun install --filter './' --production --frozen-lockfile --ignore-scripts",
  '',
  'FROM node:24',
  'COPY --from=prod-deps /app/node_modules/ ./node_modules/',
  'COPY src/ ./src/',
  'COPY --from=builder /app/web/dist/ ./web/dist/',
  '',
].join('\n')

describe('Dockerfile wiki-writer boundary', () => {
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

  it('rejects a prod-deps install without --filter', () => {
    const mutated = validDockerfile.replace("--filter './' ", '')
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining("lacks --filter './'")])
  })

  it('rejects a prod-deps install without --production', () => {
    const mutated = validDockerfile.replace('--production ', '')
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining('lacks --production')])
  })

  it('reads a prod-deps install split across continuation lines', () => {
    const mutated = validDockerfile.replace("--filter './' --production", "\\\n  --filter './' \\\n  --production")
    expect(findBoundaryViolations(mutated)).toEqual([])
  })

  it('rejects wiki-writer source copied into a build stage', () => {
    const mutated = validDockerfile.replace(
      'FROM node:24 AS prod-deps',
      'COPY wiki-writer/src ./wiki-writer/src\nFROM node:24 AS prod-deps',
    )
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining('builder stage copies wiki-writer source')])
  })

  it('rejects wiki-writer source copied into the runtime stage', () => {
    const mutated = `${validDockerfile}COPY ./wiki-writer/src ./wiki-writer/src\n`
    expect(findBoundaryViolations(mutated)).toEqual([
      expect.stringContaining('runtime stage copies wiki-writer source'),
      expect.stringContaining('runtime stage copies from wiki-writer/'),
    ])
  })

  it('rejects even the wiki-writer manifest in the runtime stage', () => {
    const mutated = `${validDockerfile}COPY wiki-writer/package.json ./\n`
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining('runtime stage copies from wiki-writer/')])
  })

  it('rejects a whole-context copy in a build stage', () => {
    const mutated = validDockerfile.replace('FROM node:24 AS prod-deps', 'COPY . .\nFROM node:24 AS prod-deps')
    expect(findBoundaryViolations(mutated)).toEqual([expect.stringContaining('builder stage copies the whole build context')])
  })

  it('ignores commented-out wiki-writer copies', () => {
    const mutated = `${validDockerfile}# COPY wiki-writer/src ./wiki-writer/src\n`
    expect(findBoundaryViolations(mutated)).toEqual([])
  })

  it('reports a Dockerfile with no prod-deps stage', () => {
    expect(findBoundaryViolations('FROM node:24\n')).toEqual([`no ${PROD_DEPS_STAGE} stage found`])
  })
})
