/**
 * Guard: no file under `web/src` may import from the server tree (`src/`).
 *
 * The Docker builder stage copies ONLY `web/` into the image (not `src/`), so
 * any `web/src` import resolving into `../src/` fails to resolve at build
 * time — this is what broke the production Docker build. This test scans all
 * web source files and fails loudly if the boundary is re-crossed.
 */
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join, relative} from 'node:path'
import ts from 'typescript'
import {describe, expect, it} from 'vitest'

const WEB_SRC_ROOT = join(import.meta.dirname, '..')
const SELF_PATH = import.meta.filename

function walk(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...walk(fullPath))
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(fullPath)
    }
  }
  return files
}

function findViolations(files: readonly {path: string; source: string}[]): string[] {
  const violations: string[] = []
  for (const file of files) {
    const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true,
      file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    function visit(node: ts.Node): void {
      const moduleSpecifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined
      // Computed specifiers are outside this scan's scope.
      if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
        const specifier = moduleSpecifier.text
        if (/(^|\/)src\//.test(specifier) && specifier.startsWith('.')) {
          violations.push(`${file.path} -> ${specifier}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return violations
}

describe('web/src must not import from the server tree', () => {
  it('contains no import specifier resolving into src/', () => {
    const files = walk(WEB_SRC_ROOT)
      .filter(path => path !== SELF_PATH)
      .map(path => ({path: relative(WEB_SRC_ROOT, path), source: readFileSync(path, 'utf8')}))
    expect(files.length).toBeGreaterThan(30)
    expect(findViolations(files)).toEqual([])
  })

  it('detects literal dynamic imports alongside static and side-effect imports', () => {
    const serverPath = ['..', '..', '..', 'src', 'example.ts'].join('/')
    const source = `import {x} from '${serverPath}'\nimport '${serverPath}'\nconst x = import('${serverPath}')\nconst y = import ( "${serverPath}" )`
    expect(findViolations([{path: 'example.ts', source}])).toEqual(
      Array.from({length: 4}, () => `example.ts -> ${serverPath}`),
    )
  })

  it('allows a web-local dynamic import', () => {
    expect(findViolations([{path: 'example.ts', source: "const x = import('./local.ts')"}])).toEqual([])
  })

  it('detects a literal dynamic import with an inline comment in TSX', () => {
    const serverPath = ['..', '..', '..', 'src', 'example.ts'].join('/')
    const source = `const view = <div>{import(/* explanation */ '${serverPath}')}</div>`
    expect(findViolations([{path: 'example.tsx', source}])).toEqual([`example.tsx -> ${serverPath}`])
  })

  it('ignores import examples in comments and ordinary strings', () => {
    const serverPath = ['..', '..', '..', 'src', 'example.ts'].join('/')
    const source = `// import '${serverPath}'\n/* export {x} from '${serverPath}' */\nconst example = "import '${serverPath}'"`
    expect(findViolations([{path: 'example.ts', source}])).toEqual([])
  })

  it('detects re-exports and permits computed dynamic imports', () => {
    const serverPath = ['..', '..', '..', 'src', 'example.ts'].join('/')
    const source = `export {x} from '${serverPath}'\nconst path = '${serverPath}'\nimport(path)`
    expect(findViolations([{path: 'example.ts', source}])).toEqual([`example.ts -> ${serverPath}`])
  })
})
