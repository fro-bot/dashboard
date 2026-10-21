/**
 * The wiki fixture target exists only while the fixture harness is active.
 *
 * A module-load spy proves the fake is never imported when the harness is off,
 * including when the harness is requested in an environment that must refuse it.
 */

import {Buffer} from 'node:buffer'
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, relative, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const loads = vi.hoisted(() => ({count: 0}))

vi.mock('../src/wiki/fixture-target.ts', async importOriginal => {
  loads.count += 1
  return importOriginal()
})

const TEST_KEY = Buffer.from('testkey-ABCDEFGHIJKLMNOPQRSTUV12', 'utf8')
const LOGIN = 'fixture-operator'
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
let shellRoot = ''

beforeEach(() => {
  loads.count = 0
  vi.resetModules()
  shellRoot = mkdtempSync(join(tmpdir(), 'wiki-absence-shell-'))
  mkdirSync(shellRoot, {recursive: true})
  writeFileSync(join(shellRoot, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(shellRoot, {recursive: true, force: true})
})

async function loadServer() {
  const server = await import('../src/server.ts')
  server.resetRateLimitForTesting()
  return server
}

async function sessionCookie(): Promise<string> {
  const {SessionManager} = await import('../src/session.ts')
  return `session=${new SessionManager(TEST_KEY).sign(LOGIN)}`
}

function walk(directory: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) files.push(...walk(path))
    else if (/\.(?:ts|tsx|js|mjs)$/u.test(name)) files.push(path)
  }
  return files
}

describe('fixture target absence', () => {
  it('is not loaded when the harness is off, and the wiki routes use only injected wiring', async () => {
    const {buildDashboardApp} = await loadServer()
    const listPages = vi.fn(async () => ({success: true as const, data: {headSha: 'real-head', pages: []}}))
    const app = await buildDashboardApp({
      operatorLogin: LOGIN,
      cookieKey: TEST_KEY,
      fixtureHarnessEnabled: false,
      webDistRoot: shellRoot,
      wiki: {
        pages: {listPages, readPage: vi.fn()},
        write: null,
        policy: {capability: {enabled: false, reason: 'app-credentials-absent'}, fixtureOperatorLogin: null},
      },
    })

    const res = await app.request('/api/wiki/pages', {headers: {cookie: await sessionCookie()}})

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({headSha: 'real-head', pages: [], canWrite: false})
    expect(listPages).toHaveBeenCalledTimes(1)
    expect(loads.count).toBe(0)
  })

  it('is not loaded when the harness flag is absent from the environment', async () => {
    vi.stubEnv('DASHBOARD_FIXTURE_HARNESS_ENABLED', undefined)
    const {buildDashboardApp} = await loadServer()
    const app = await buildDashboardApp({operatorLogin: LOGIN, cookieKey: TEST_KEY, webDistRoot: shellRoot})

    const res = await app.request('/api/wiki/pages', {headers: {cookie: await sessionCookie()}})

    expect(res.status).toBe(503)
    expect(loads.count).toBe(0)
  })

  it('serves nothing from the fake when no wiki wiring is given', async () => {
    const {buildDashboardApp} = await loadServer()
    const app = await buildDashboardApp({operatorLogin: LOGIN, cookieKey: TEST_KEY, webDistRoot: shellRoot})
    const headers = {cookie: await sessionCookie(), origin: 'http://127.0.0.1:3000', 'content-type': 'application/json'}

    const list = await app.request('/api/wiki/pages', {headers})
    const save = await app.request('/api/wiki/pages/repos.fixture--plain/save', {method: 'POST', headers, body: '{}'})

    expect(list.status).toBe(503)
    expect(save.status).toBe(403)
    expect(loads.count).toBe(0)
  })

  it('throws at startup in a production environment, before loading the fake', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const {buildDashboardApp} = await loadServer()

    await expect(
      buildDashboardApp({
        operatorLogin: LOGIN,
        cookieKey: TEST_KEY,
        fixtureHarnessEnabled: true,
        fixtureBindHost: '127.0.0.1',
        webDistRoot: shellRoot,
      }),
    ).rejects.toThrow(/FIXTURE_HARNESS_ENABLED refused/u)
    expect(loads.count).toBe(0)
  })

  it('throws at startup when the flag comes from the environment in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DASHBOARD_FIXTURE_HARNESS_ENABLED', 'true')
    vi.stubEnv('DASHBOARD_HOST', '127.0.0.1')
    const {buildDashboardApp} = await loadServer()

    await expect(buildDashboardApp({operatorLogin: LOGIN, cookieKey: TEST_KEY, webDistRoot: shellRoot})).rejects.toThrow(
      /refused/u,
    )
    expect(loads.count).toBe(0)
  })

  it('throws at startup on a non-loopback bind, before loading the fake', async () => {
    const {buildDashboardApp} = await loadServer()

    await expect(
      buildDashboardApp({
        operatorLogin: LOGIN,
        cookieKey: TEST_KEY,
        fixtureHarnessEnabled: true,
        fixtureBindHost: '0.0.0.0',
        webDistRoot: shellRoot,
      }),
    ).rejects.toThrow(/loopback/u)
    expect(loads.count).toBe(0)
  })

  it('is loaded exactly once when the harness is active (positive control for the spy)', async () => {
    const {buildDashboardApp} = await loadServer()

    await buildDashboardApp({
      operatorLogin: LOGIN,
      cookieKey: TEST_KEY,
      devAutoLogin: true,
      fixtureHarnessEnabled: true,
      fixtureBindHost: '127.0.0.1',
      webDistRoot: shellRoot,
    })

    expect(loads.count).toBe(1)
  })
})

describe('no /__fixture/ path reaches the wiki fixture', () => {
  it.each([
    '/__fixture/operator/api/wiki/pages',
    '/__fixture/operator/wiki/pages',
    '/__fixture/operator/pages',
    '/__fixture/wiki/pages',
    '/__fixture/api/wiki/pages',
    '/__fixture/operator/promotion/status',
  ])('answers 404 for %s while the harness is active', async path => {
    const {buildDashboardApp} = await loadServer()
    const app = await buildDashboardApp({
      operatorLogin: LOGIN,
      cookieKey: TEST_KEY,
      devAutoLogin: true,
      fixtureHarnessEnabled: true,
      fixtureBindHost: '127.0.0.1',
      webDistRoot: shellRoot,
    })

    for (const method of ['GET', 'POST']) {
      const res = await app.request(path, {method, headers: {'content-type': 'application/json'}, body: method === 'POST' ? '{}' : undefined})
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(await res.text()).not.toContain('fixture--plain')
    }
  })

  it('keeps the wiki routes at /api/wiki only', async () => {
    const {buildDashboardApp} = await loadServer()
    const app = await buildDashboardApp({
      operatorLogin: LOGIN,
      cookieKey: TEST_KEY,
      devAutoLogin: true,
      fixtureHarnessEnabled: true,
      fixtureBindHost: '127.0.0.1',
      webDistRoot: shellRoot,
    })

    expect((await app.request('/api/wiki/pages')).status).toBe(200)
    expect((await app.request('/wiki/pages')).status).toBe(404)
  })
})

describe('fixture target import graph', () => {
  const sources = [
    ...walk(join(repositoryRoot, 'src')),
    ...walk(join(repositoryRoot, 'web', 'src')),
    ...walk(join(repositoryRoot, 'scripts')),
  ].map(path => ({path: relative(repositoryRoot, path).split(sep).join('/'), source: readFileSync(path, 'utf8')}))

  it('is imported statically by no source module', () => {
    const staticImport = /\bfrom\s+['"][^'"]*fixture-target[^'"]*['"]|(?:^|\n)\s*import\s+['"][^'"]*fixture-target/u

    const offenders = sources.filter(file => staticImport.test(file.source)).map(file => file.path)

    expect(offenders).toEqual([])
  })

  it('is imported dynamically by src/server.ts alone', () => {
    const dynamic = /import\(\s*['"][^'"]*fixture-target(?:\.ts)?['"]\s*\)/u

    const importers = sources.filter(file => dynamic.test(file.source)).map(file => file.path)

    expect(importers).toEqual(['src/server.ts'])
  })

  it('is not referenced by the fixture harness router, the production wiring, or the web client', () => {
    for (const path of ['src/routes/operator-fixture-harness.ts', 'src/routes/wiki.ts']) {
      expect(sources.find(file => file.path === path)?.source, path).not.toMatch(/fixture-target/u)
    }
    for (const file of sources.filter(item => item.path.startsWith('web/src/'))) {
      expect(file.source, file.path).not.toMatch(/fixture-target/u)
    }
    const wiring = sources.find(file => file.path === 'src/wiki/wiring.ts')?.source ?? ''
    const start = wiring.indexOf('export function buildWikiAppDeps')
    const buildWikiAppDeps = wiring.slice(start, wiring.indexOf('\n}\n', start))
    expect(start).toBeGreaterThan(-1)
    expect(buildWikiAppDeps).not.toMatch(/fixture-target|buildFixture|FIXTURE_|fixtureHarness/u)
    // The production wiring never confers a fixture identity.
    const identities = [...buildWikiAppDeps.matchAll(/fixtureOperatorLogin:\s*([^,}\n]+)/gu)].map(match => match[1]?.trim())
    expect(identities.length).toBeGreaterThan(0)
    expect(new Set(identities)).toEqual(new Set(['null']))
  })

  it('never names the Fro Bot credential seam, so it needs no key', () => {
    const source = sources.find(file => file.path === 'src/wiki/fixture-target.ts')?.source ?? ''

    expect(source.length).toBeGreaterThan(1000)
    expect(source).not.toMatch(/WriteTokenProvider|fro-bot-app-client|createFroBotAppClient|writeTokenSource|readTokenSource/u)
  })
})
