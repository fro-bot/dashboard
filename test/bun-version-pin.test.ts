/**
 * Guards the Bun toolchain pin in the Dockerfile.
 *
 * The Dockerfile pulls Bun from `oven/bun:<version>@sha256:<digest>`. The bare
 * version tag must equal the `packageManager` version in package.json so CI,
 * local development and the image build all use the same Bun.
 *
 * Covers:
 * - Happy path: every `oven/bun` tag equals the `packageManager` version
 * - Happy path: every `oven/bun` reference carries a 64-hex `@sha256:` digest
 * - Error path: a reference without a digest is rejected
 * - Error path: a mismatched tag is rejected
 */

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {describe, expect, it} from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

interface BunImageReference {
  readonly tag: string
  readonly digest: string | undefined
}

function readPackageManagerBunVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {packageManager?: unknown}
  const match = typeof manifest.packageManager === 'string' ? /^bun@(.+)$/.exec(manifest.packageManager) : null
  if (match === null) {
    throw new Error(`package.json packageManager is not bun@<version>: ${String(manifest.packageManager)}`)
  }
  return match[1] as string
}

function parseBunImageReferences(dockerfile: string): BunImageReference[] {
  const references: BunImageReference[] = []
  for (const line of dockerfile.split('\n')) {
    if (line.trimStart().startsWith('#')) continue
    for (const match of line.matchAll(/oven\/bun:([^\s@]+)(?:@(\S+))?/g)) {
      references.push({tag: match[1] as string, digest: match[2]})
    }
  }
  return references
}

function findPinViolations(references: readonly BunImageReference[], expectedVersion: string): string[] {
  const violations: string[] = []
  if (references.length === 0) violations.push('no oven/bun reference found')
  for (const {tag, digest} of references) {
    if (tag !== expectedVersion) violations.push(`tag ${tag} does not equal packageManager version ${expectedVersion}`)
    if (digest === undefined || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      violations.push(`oven/bun:${tag} is not pinned to a sha256 digest`)
    }
  }
  return violations
}

describe('Dockerfile Bun pin', () => {
  const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8')
  const references = parseBunImageReferences(dockerfile)

  it('references oven/bun at least once', () => {
    expect(references.length).toBeGreaterThan(0)
  })

  it('uses a tag equal to the packageManager version', () => {
    const expected = readPackageManagerBunVersion()
    for (const {tag} of references) {
      expect(tag).toBe(expected)
    }
  })

  it('pins every oven/bun reference to a sha256 digest', () => {
    for (const {digest} of references) {
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
  })

  it('reports no violations for the real Dockerfile', () => {
    expect(findPinViolations(references, readPackageManagerBunVersion())).toEqual([])
  })
})

describe('Bun pin checker (error paths)', () => {
  const digest = `sha256:${'a'.repeat(64)}`

  it('rejects a reference with no digest', () => {
    const inline = 'FROM oven/bun:9.9.9 AS bun\nCOPY --from=bun /usr/local/bin/bun /usr/local/bin/bun\n'
    const violations = findPinViolations(parseBunImageReferences(inline), '9.9.9')
    expect(violations).toEqual(['oven/bun:9.9.9 is not pinned to a sha256 digest'])
  })

  it('rejects a digest that is not 64 hex characters', () => {
    const inline = 'FROM oven/bun:9.9.9@sha256:abc123 AS bun\n'
    expect(findPinViolations(parseBunImageReferences(inline), '9.9.9')).toHaveLength(1)
  })

  it('rejects a tag that differs from the expected version', () => {
    const inline = `FROM oven/bun:9.9.8@${digest} AS bun\n`
    const violations = findPinViolations(parseBunImageReferences(inline), '9.9.9')
    expect(violations).toEqual(['tag 9.9.8 does not equal packageManager version 9.9.9'])
  })

  it('ignores commented-out references', () => {
    const inline = `# FROM oven/bun:0.0.1 AS old\nFROM oven/bun:9.9.9@${digest} AS bun\n`
    expect(parseBunImageReferences(inline)).toEqual([{tag: '9.9.9', digest}])
  })

  it('reports a Dockerfile with no oven/bun reference', () => {
    expect(findPinViolations(parseBunImageReferences('FROM node:24\n'), '9.9.9')).toEqual([
      'no oven/bun reference found',
    ])
  })
})
