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

const IMPORT_SPECIFIER_RE = /(?:from|import)\s*['"]([^'"]+)['"]/g

describe('web/src must not import from the server tree', () => {
  it('contains no import specifier resolving into src/', () => {
    const violations: string[] = []
    for (const filePath of walk(WEB_SRC_ROOT)) {
      if (filePath === SELF_PATH) continue
      const content = readFileSync(filePath, 'utf8')
      for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
        const specifier = match[1]
        if (specifier === undefined) continue
        if (/(^|\/)src\//.test(specifier) && specifier.startsWith('.')) {
          violations.push(`${relative(WEB_SRC_ROOT, filePath)} -> ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
