/**
 * Every package `src/` imports must be a root runtime dependency.
 *
 * The production image installs the root package's `dependencies` only, so a
 * server import of a package that is missing there, or that sits in
 * `devDependencies`, boots in development and fails in the image.
 */

import {readdir, readFile} from 'node:fs/promises'
import {join, relative, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {describe, expect, it} from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

interface SourceFile {
  readonly path: string
  readonly source: string
}

/** The package name of a bare import specifier, or undefined for relative and `node:` specifiers. */
function runtimePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/')) return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function visit(node: ts.Node, onImport: (specifier: string) => void): void {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) onImport(node.moduleSpecifier.text)
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    onImport(node.moduleSpecifier.text)
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    onImport(node.moduleReference.expression.text)
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
    const argument = node.arguments[0]
    if (argument !== undefined && ts.isStringLiteral(argument)) onImport(argument.text)
  }
  node.forEachChild(child => {
    visit(child, onImport)
  })
}

/** Packages imported by the files, with the first file that imports each. */
function importedPackages(files: readonly SourceFile[]): Map<string, string> {
  const imports = new Map<string, string>()
  for (const file of files) {
    const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true)
    visit(sourceFile, specifier => {
      const packageName = runtimePackageName(specifier)
      if (packageName !== undefined && !imports.has(packageName)) imports.set(packageName, file.path)
    })
  }
  return imports
}

function findUndeclaredImports(files: readonly SourceFile[], dependencies: Readonly<Record<string, string>>): string[] {
  return [...importedPackages(files)]
    .filter(([packageName]) => dependencies[packageName] === undefined)
    .map(([packageName, path]) => `${packageName} (imported by ${path})`)
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true})
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(entryPath)))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(entryPath)
  }
  return files
}

async function readServerSources(): Promise<SourceFile[]> {
  const paths = await listTypeScriptFiles(join(repositoryRoot, 'src'))
  return Promise.all(
    paths.map(async path => ({path: relative(repositoryRoot, path).split(sep).join('/'), source: await readFile(path, 'utf8')})),
  )
}

describe('server runtime dependencies', () => {
  it('declares every external package src/ imports as a root runtime dependency', async () => {
    const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const files = await readServerSources()

    expect(files.length).toBeGreaterThan(50)
    expect(importedPackages(files).size).toBeGreaterThan(5)
    expect(findUndeclaredImports(files, packageJson.dependencies ?? {})).toEqual([])
  })

  it('finds the wiki core package among the imports, so the scan reads the wiki modules', async () => {
    expect([...importedPackages(await readServerSources()).keys()]).toContain('@fro.bot/wiki-write-core')
  })
})

describe('server runtime dependencies (scan rules)', () => {
  const declared = {hono: '1', '@scope/pkg': '1'}

  it('accepts declared packages, scoped packages with subpaths, and node: and relative imports', () => {
    const files = [
      {
        path: 'src/a.ts',
        source: [
          "import {Hono} from 'hono'",
          "import {x} from '@scope/pkg/sub/path'",
          "import {readFileSync} from 'node:fs'",
          "import {y} from './b.ts'",
          "import {z} from '../c.ts'",
        ].join('\n'),
      },
    ]

    expect(findUndeclaredImports(files, declared)).toEqual([])
  })

  it.each([
    ['a static import', "import {x} from 'undeclared'"],
    ['a side-effect import', "import 'undeclared'"],
    ['a type import', "import type {X} from 'undeclared'"],
    ['a re-export', "export {x} from 'undeclared'"],
    ['a dynamic import', "const m = await import('undeclared')"],
    ['a subpath import', "import {x} from 'undeclared/sub'"],
    ['an import-equals require', "import x = require('undeclared')"],
  ])('flags %s of an undeclared package', (_label, source) => {
    expect(findUndeclaredImports([{path: 'src/leak.ts', source}], declared)).toEqual([
      'undeclared (imported by src/leak.ts)',
    ])
  })

  it('flags a scoped package by its scope and name', () => {
    const files = [{path: 'src/leak.ts', source: "import {x} from '@other/pkg/deep'"}]

    expect(findUndeclaredImports(files, declared)).toEqual(['@other/pkg (imported by src/leak.ts)'])
  })

  it('reports each undeclared package once, at its first importer', () => {
    const files = [
      {path: 'src/a.ts', source: "import 'undeclared'"},
      {path: 'src/b.ts', source: "import 'undeclared'"},
    ]

    expect(findUndeclaredImports(files, declared)).toEqual(['undeclared (imported by src/a.ts)'])
  })

  it('treats a package missing from dependencies as undeclared even if it is a dev dependency', () => {
    const files = [{path: 'src/a.ts', source: "import {x} from 'dev-only'"}]

    expect(findUndeclaredImports(files, declared)).toEqual(['dev-only (imported by src/a.ts)'])
  })

  it('ignores specifiers that only appear in comments and strings', () => {
    const files = [{path: 'src/a.ts', source: "// import 'undeclared'\nconst note = \"import 'undeclared'\"\n"}]

    expect(findUndeclaredImports(files, declared)).toEqual([])
  })
})
