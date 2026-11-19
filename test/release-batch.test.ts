import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {discoverBatch} from '../scripts/release/batch.ts'

let dir: string
let baseline: string

function git(...args: string[]): string {
  return execFileSync('git', args, {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()
}

function commit(subject: string, changes: Record<string, string>): string {
  for (const [path, contents] of Object.entries(changes)) {
    mkdirSync(dirname(join(dir, path)), {recursive: true})
    writeFileSync(join(dir, path), contents)
  }
  git('add', '--all')
  git('commit', '--no-gpg-sign', '--quiet', '-m', subject)
  return git('rev-parse', 'HEAD')
}

function discover(base = baseline, head = git('rev-parse', 'HEAD')) {
  return discoverBatch({repoDir: dir, baseline: base, main: head})
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-batch-'))
  git('init', '--quiet', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  baseline = commit('initial', {'package.json': '{"dependencies":{"hono":"1"},"devDependencies":{"vitest":"1"}}', 'bun.lock': 'old'})
})

afterEach(() => rmSync(dir, {recursive: true, force: true}))

describe('release batch discovery', () => {
  it('has no batch for no intervals, docs, excluded tests, and generated notes alone', () => {
    expect(discover()).toBeNull()
    commit('docs', {'README.md': 'docs', 'web/src/panel.test.ts': 'test'})
    commit('generated', {'docs/releases/batch.md': 'notes'})
    expect(discover()).toBeNull()
  })

  it('includes hard paths and mixed generated changes in chronological deterministic notes', () => {
    commit('first (#12)', {'src/server.ts': 'one'})
    commit('mixed', {'docs/releases/batch.md': 'generated', 'public/app.js': 'two'})
    const before = git('status', '--porcelain')
    const result = discover()
    expect(result).not.toBeNull()
    expect(result?.notes).toContain('first')
    expect(result?.notes).toContain('https://github.com/fro-bot/dashboard/pull/12')
    expect(result?.notes.indexOf('first')).toBeLessThan(result?.notes.indexOf('mixed') ?? -1)
    expect(discover()).toEqual(result)
    expect(git('status', '--porcelain')).toBe(before)
  })

  it('keeps a lock-only interval followed by allowlisted dev changes eligible', () => {
    commit('lock update', {'bun.lock': 'new'})
    commit('tooling', {'package.json': '{"dependencies":{"hono":"1"},"devDependencies":{"vitest":"2"}}', 'bun.lock': 'newer'})
    const notes = discover()?.notes
    expect(notes).toContain('lock update')
    expect(notes).not.toContain('tooling')
  })

  it('classifies runtime and artifact dev dependencies but not allowlisted tooling', () => {
    commit('tooling', {'package.json': '{"dependencies":{"hono":"1"},"devDependencies":{"vitest":"2"}}'})
    commit('runtime', {'package.json': '{"dependencies":{"hono":"2"},"devDependencies":{"vitest":"2"}}'})
    commit('browser', {'package.json': '{"dependencies":{"hono":"2"},"devDependencies":{"vitest":"2","react":"1"}}'})
    const notes = discover()?.notes
    expect(notes).not.toContain('tooling')
    expect(notes).toContain('runtime')
    expect(notes).toContain('browser')
  })

  it('counts both a qualifying change and its revert', () => {
    const change = commit('feature', {'src/a.ts': 'hello'})
    git('revert', '--no-gpg-sign', '--no-edit', change)
    const notes = discover()?.notes
    expect(notes).toContain('feature')
    expect(notes).toContain('Revert')
  })

  it('rejects missing, unrelated, and second-parent-only baselines', () => {
    expect(() => discover('not-a-revision')).toThrow()
    git('checkout', '--quiet', '-b', 'side')
    const side = commit('side', {'src/side.ts': 'side'})
    git('checkout', '--quiet', 'main')
    commit('main', {'README.md': 'main'})
    git('merge', '--no-gpg-sign', '--quiet', '--no-ff', 'side', '-m', 'merge side')
    expect(() => discover(side)).toThrow('Baseline is not on first-parent history')
    git('checkout', '--quiet', '--orphan', 'unrelated')
    git('rm', '-rf', '--quiet', '.')
    const unrelated = commit('unrelated', {'package.json': '{}'})
    expect(() => discover(unrelated, git('rev-parse', 'main'))).toThrow('Baseline is not on first-parent history')
  })

  it('requires explicit full object IDs rather than resolving mutable refs', () => {
    expect(() => discover('HEAD')).toThrow('full commit SHA')
    expect(() => discover(baseline, '')).toThrow('full commit SHA')
  })

  it('rejects annotated tag object IDs rather than peeling them to commits', () => {
    git('tag', '-a', 'release', '-m', 'release', baseline)
    const tagObject = git('rev-parse', 'release^{tag}')
    expect(() => discover(tagObject, baseline)).toThrow('exact commit SHA')
    expect(() => discover(baseline, tagObject)).toThrow('exact commit SHA')
    expect(discover(baseline.toUpperCase(), baseline)).toBeNull()
  })

  it('fails closed on invalid manifests even after a qualifying interval', () => {
    commit('feature', {'src/a.ts': 'hello'})
    commit('invalid', {'package.json': '{invalid'})
    expect(() => discover()).toThrow(SyntaxError)
  })

  it('renders hostile subjects as text, not executable markdown or HTML', () => {
    commit('<script>alert(1)</script> [click](javascript:alert(1)) $(touch PWNED)', {'src/a.ts': 'a'})
    const notes = discover()?.notes ?? ''
    expect(notes).not.toContain('<script>')
    expect(notes).not.toContain('[click](javascript:')
    expect(git('status', '--porcelain')).toBe('')
  })

  it('rejects incomplete shallow history', () => {
    commit('feature', {'src/a.ts': 'a'})
    const shallow = mkdtempSync(join(tmpdir(), 'release-batch-shallow-'))
    try {
      execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${dir}`, shallow])
      expect(() => discoverBatch({repoDir: shallow, baseline: 'HEAD', main: 'HEAD'})).toThrow('shallow history')
    } finally {
      rmSync(shallow, {recursive: true, force: true})
    }
  })
})
