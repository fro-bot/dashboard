/**
 * Guard: no file under `web/src` may carry key material or reach the write path.
 *
 * The client is a display and edit surface. GitHub credentials, the Fro Bot App key,
 * Octokit, the shared wiki core, the write client, and everything under the server's
 * `src/wiki/` belong to the server. This scan fails if a web source file imports
 * any of them or names a key-loading symbol.
 */
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join, relative} from 'node:path'
import {describe, expect, it} from 'vitest'

const WEB_SRC_ROOT = join(import.meta.dirname, '..')
const SELF_PATH = import.meta.filename

interface WebFile {
  readonly path: string
  readonly source: string
}

const IMPORT_SPECIFIER_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/gu

const FORBIDDEN_SPECIFIERS: readonly {readonly label: string; readonly test: (specifier: string) => boolean}[] = [
  {label: 'an @octokit package', test: specifier => specifier.startsWith('@octokit/') || specifier === '@octokit'},
  {label: 'the wiki core package', test: specifier => specifier === '@fro.bot/wiki-write-core' || specifier.startsWith('@fro.bot/wiki-write-core/')},
  {label: 'the write client', test: specifier => /(?:^|\/)fro-bot-app-client(?:\.ts)?$/u.test(specifier)},
  {label: 'the server wiki modules', test: specifier => /(?:^|\/)src\/wiki(?:\/|$)/u.test(specifier)},
]

const FORBIDDEN_SYMBOLS: readonly {readonly label: string; readonly pattern: RegExp}[] = [
  {label: 'key-loading symbol readMultilineSecret', pattern: /\breadMultilineSecret\b/u},
  {label: 'key-loading symbol readOptionalMultilineSecret', pattern: /\breadOptionalMultilineSecret\b/u},
  {label: 'key-loading symbol readOptionalSecret', pattern: /\breadOptionalSecret\b/u},
  {label: 'App auth symbol createAppAuth', pattern: /\bcreateAppAuth\b/u},
  {label: 'write client symbol createFroBotAppClient', pattern: /\bcreateFroBotAppClient\b/u},
  {label: 'write token provider', pattern: /\bWriteTokenProvider\b/u},
  {label: 'write token symbol getWriteToken', pattern: /\bgetWriteToken\b/u},
  {label: 'data client symbol createWikiDataClient', pattern: /\bcreateWikiDataClient\b/u},
  {label: 'transport symbol createWriteTransport', pattern: /\bcreateWriteTransport\b/u},
  {label: 'token source symbol writeTokenSource', pattern: /\bwriteTokenSource\b/u},
  {label: 'App credential setting DASHBOARD_FRO_BOT_APP', pattern: /\bDASHBOARD_FRO_BOT_APP/u},
  {label: 'App credential setting DASHBOARD_GITHUB_APP', pattern: /\bDASHBOARD_GITHUB_APP/u},
  {label: 'a private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u},
  {label: 'a privateKey identifier', pattern: /\bprivateKey\b/u},
]

function findKeyMaterialViolations(files: readonly WebFile[]): string[] {
  const violations: string[] = []
  for (const file of files) {
    for (const match of file.source.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      for (const rule of FORBIDDEN_SPECIFIERS) {
        if (rule.test(specifier)) violations.push(`${file.path}: imports ${rule.label} (${specifier})`)
      }
    }
    for (const rule of FORBIDDEN_SYMBOLS) {
      if (rule.pattern.test(file.source)) violations.push(`${file.path}: names ${rule.label}`)
    }
  }
  return violations
}

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    if (statSync(fullPath).isDirectory()) files.push(...walk(fullPath))
    else if (/\.(?:ts|tsx)$/u.test(entry)) files.push(fullPath)
  }
  return files
}

function readWebSources(): WebFile[] {
  return walk(WEB_SRC_ROOT)
    .filter(path => path !== SELF_PATH)
    .map(path => ({path: relative(WEB_SRC_ROOT, path), source: readFileSync(path, 'utf8')}))
}

describe('web/src carries no key material and never reaches the write path', () => {
  it('passes on the current tree', () => {
    const files = readWebSources()

    expect(files.length).toBeGreaterThan(30)
    expect(findKeyMaterialViolations(files)).toEqual([])
  })
})

describe('web key-material scan (rules)', () => {
  // Built at runtime so this file's own source holds no relative specifier into the server tree.
  const UP = ['..', '..', '..'].join('/')
  const scan = (source: string) => findKeyMaterialViolations([{path: 'x.ts', source}])

  it('accepts ordinary client imports and a client wiki module path', () => {
    expect(scan("import {useState} from 'react'\nimport {api} from './wiki/api.ts'\nimport {x} from '../wiki/draft'\n")).toEqual([])
  })

  it.each([
    ['an Octokit core import', "import {Octokit} from '@octokit/core'"],
    ['an Octokit auth import', "import {createAppAuth} from '@octokit/auth-app'"],
    ['an Octokit side-effect import', "import '@octokit/rest'"],
    ['a dynamic Octokit import', "const o = await import('@octokit/core')"],
    ['an Octokit require', "const o = require('@octokit/core')"],
    ['the wiki core package', "import {parseCorrections} from '@fro.bot/wiki-write-core'"],
    ['a wiki core subpath', "import {x} from '@fro.bot/wiki-write-core/dist/x.js'"],
    ['the write client', `import {createFroBotAppClient} from '${UP}/src/github/fro-bot-app-client.ts'`],
    ['the write client without an extension', `import {x} from '${UP}/src/github/fro-bot-app-client'`],
    ['a server wiki module', `import {pages} from '${UP}/src/wiki/pages.ts'`],
    ['the server wiki directory', `import {x} from '${UP}/src/wiki'`],
    ['a re-export of a server wiki module', `export {x} from '${UP}/src/wiki/paths.ts'`],
  ])('flags %s', (_label, source) => {
    expect(scan(source).length).toBeGreaterThan(0)
  })

  it.each([
    ['readMultilineSecret', "const key = readMultilineSecret('K')"],
    ['readOptionalMultilineSecret', "readOptionalMultilineSecret('K')"],
    ['readOptionalSecret', "readOptionalSecret('K')"],
    ['createAppAuth', 'createAppAuth({appId, privateKey})'],
    ['WriteTokenProvider', 'let tokens: WriteTokenProvider'],
    ['getWriteToken', 'await tokens.getWriteToken()'],
    ['createWikiDataClient', 'createWikiDataClient(transport)'],
    ['writeTokenSource', 'writeTokenSource(fn)'],
    ['the Fro Bot App setting', "process.env.DASHBOARD_FRO_BOT_APP_KEY"],
    ['the read App setting', "process.env.DASHBOARD_GITHUB_APP_KEY"],
    ['a PEM block', 'const k = "-----BEGIN RSA PRIVATE KEY-----"'],
    ['privateKey', 'const privateKey = 1'],
  ])('flags the symbol %s', (_label, source) => {
    expect(scan(source).length).toBeGreaterThan(0)
  })

  it('names the file and the rule in each violation', () => {
    expect(scan("import {Octokit} from '@octokit/core'")).toEqual(["x.ts: imports an @octokit package (@octokit/core)"])
  })

  it('does not flag a similarly named client path', () => {
    expect(scan("import {x} from './wiki/fro-bot-client-view.ts'\nimport {y} from './wiki-src/wiki.ts'\n")).toEqual([])
  })
})
