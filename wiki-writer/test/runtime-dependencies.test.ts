import {readdir, readFile} from 'node:fs/promises'
import {join} from 'node:path'
import ts from 'typescript'
import {describe, expect, it} from 'vitest'

describe('wiki-writer runtime dependencies', () => {
  it('declares every external source import in runtime dependencies', async () => {
    const packagePath = new URL('../package.json', import.meta.url)
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {dependencies?: Record<string, string>}
    const sourceFiles = await listTypeScriptFiles(filePath('../src'))
    const imports = new Map<string, string>()

    for (const filePath of sourceFiles) {
      const source = await readFile(filePath, 'utf8')
      const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
      visit(sourceFile, specifier => {
        const packageName = runtimePackageName(specifier)
        if (packageName !== undefined && !imports.has(packageName)) imports.set(packageName, filePath)
      })
    }

    for (const [packageName, filePath] of imports) {
      expect(packageJson.dependencies?.[packageName], `Missing runtime dependency ${packageName} imported by ${filePath}`).toBeDefined()
    }
  })
})

function filePath(relativePath: string): string {
  return new URL(relativePath, import.meta.url).pathname
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true})
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(entryPath))
    else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(entryPath)
  }
  return files
}

function visit(node: ts.Node, onImport: (specifier: string) => void): void {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) onImport(node.moduleSpecifier.text)
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
    onImport(node.moduleReference.expression.text)
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
    const argument = node.arguments[0]
    if (argument !== undefined && ts.isStringLiteral(argument)) onImport(argument.text)
  }
  node.forEachChild(child => visit(child, onImport))
}

function runtimePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('node:') || specifier.startsWith('.')) return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}
