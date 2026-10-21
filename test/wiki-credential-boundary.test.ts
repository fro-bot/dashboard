/**
 * Credential boundary scan.
 *
 * The write-token client is reachable only from the server wiring and the two
 * wiki modules that perform writes. Any other production module that imports
 * the client module, or names the provider type, fails the scan.
 */

import {readdir, readFile} from 'node:fs/promises'
import {join, relative, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const CLIENT_MODULE_PATH = 'src/github/fro-bot-app-client.ts'

const ALLOWED_IMPORTERS: ReadonlySet<string> = new Set([
  'src/wiki/wiring.ts',
  'src/wiki/write-operation.ts',
])

/**
 * The client-side scan names the forbidden symbols as test data to prove it catches
 * them. It holds no import of them, and it is exempt by exact path only.
 */
const SCAN_FIXTURE_PATHS: ReadonlySet<string> = new Set(['web/src/wiki/no-key-material.test.ts'])

const FORBIDDEN_REFERENCES = [
  {label: 'fro-bot-app-client import', pattern: /fro-bot-app-client/u},
  {label: 'WriteTokenProvider', pattern: /\bWriteTokenProvider\b/u},
] as const

interface SourceFile {
  readonly path: string
  readonly source: string
}

function findBoundaryViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = []
  for (const file of files) {
    if (file.path === CLIENT_MODULE_PATH || ALLOWED_IMPORTERS.has(file.path) || SCAN_FIXTURE_PATHS.has(file.path)) continue
    for (const reference of FORBIDDEN_REFERENCES) {
      if (reference.pattern.test(file.source)) {
        violations.push(`${file.path}: ${reference.label}`)
      }
    }
  }
  return violations
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true})
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...(await listSourceFiles(entryPath)))
    } else if (entry.isFile() && /\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) {
      files.push(entryPath)
    }
  }
  return files
}

async function readProductionSources(): Promise<SourceFile[]> {
  const roots = ['src', 'web/src', 'scripts'].map(root => join(repositoryRoot, root))
  const paths = (await Promise.all(roots.map(async root => listSourceFiles(root).catch(() => [])))).flat().sort()
  return Promise.all(
    paths.map(async path => ({
      path: relative(repositoryRoot, path).split(sep).join('/'),
      source: await readFile(path, 'utf8'),
    })),
  )
}

describe('write credential boundary', () => {
  it('keeps the write-token client out of every module except the allowed importers', async () => {
    const files = await readProductionSources()

    expect(files.length).toBeGreaterThan(50)
    expect(files.some(file => file.path === CLIENT_MODULE_PATH)).toBe(true)
    expect(findBoundaryViolations(files)).toEqual([])
  })

  describe('scan rules', () => {
    const ok = {path: 'src/wiki/pages.ts', source: "import {x} from './y.ts'\n"}

    it.each([
      ['a static import of the client module', "import {createFroBotAppClient} from '../github/fro-bot-app-client.ts'"],
      ['a dynamic import of the client module', "const m = await import('../github/fro-bot-app-client.ts')"],
      ['a re-export from the client module', "export {x} from '../github/fro-bot-app-client.ts'"],
      ['a type import of the provider', "import type {WriteTokenProvider} from './tokens.ts'"],
      ['a bare mention of the provider type', 'function save(tokens: WriteTokenProvider) {}'],
    ])('flags %s', (_label, source) => {
      const violations = findBoundaryViolations([ok, {path: 'src/wiki/pages-read.ts', source}])

      expect(violations.length).toBeGreaterThan(0)
      expect(violations.every(violation => violation.startsWith('src/wiki/pages-read.ts:'))).toBe(true)
    })

    it.each([
      'src/server.ts',
      'src/wiki/fixture-target.ts',
      'src/github/installations.ts',
      'src/github/aggregator.ts',
      'src/wiki/config.ts',
      'src/wiki/pages.ts',
    ])(
      'flags a violation in %s',
      path => {
        const violations = findBoundaryViolations([{path, source: "import '../github/fro-bot-app-client.ts'"}])

        expect(violations).toEqual([`${path}: fro-bot-app-client import`])
      },
    )

    it.each(['src/wiki/wiring.ts', 'src/wiki/write-operation.ts'])(
      'allows %s to import the client',
      path => {
        const violations = findBoundaryViolations([
          {path, source: "import {createFroBotAppClient} from '../github/fro-bot-app-client.ts'\nlet p: WriteTokenProvider"},
        ])

        expect(violations).toEqual([])
      },
    )

    it('exempts the client-side scan by exact path only', () => {
      const source = "import {x} from '../github/fro-bot-app-client.ts'"

      expect(findBoundaryViolations([{path: 'web/src/wiki/no-key-material.test.ts', source}])).toEqual([])
      expect(findBoundaryViolations([{path: 'web/src/wiki/other.test.ts', source}])).toHaveLength(1)
      expect(findBoundaryViolations([{path: 'web/src/wiki/no-key-material.test.tsx', source}])).toHaveLength(1)
    })

    it('does not allow a look-alike path', () => {
      const violations = findBoundaryViolations([
        {path: 'src/wiki/write-operation-extra.ts', source: "import '../github/fro-bot-app-client.ts'"},
      ])

      expect(violations).toHaveLength(1)
    })
  })
})
