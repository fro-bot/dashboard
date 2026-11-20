import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {renderReleaseBatch} from '../scripts/release-batch.ts'

let repo: string
function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {encoding: 'utf8'}).trim()
}
function commit(subject: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), {recursive: true})
    writeFileSync(join(repo, path), content)
  }
  git('add', '--all')
  git('commit', '--no-gpg-sign', '-m', subject)
  return git('rev-parse', 'HEAD')
}
async function render(baseline: string, main: string): Promise<string | null> {
  return renderReleaseBatch(repo, baseline, main)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'release-batch-test-'))
  git('init', '-q')
})
afterEach(() => rmSync(repo, {recursive: true, force: true}))

describe('release batch', () => {
  it('renders eligible first-parent intervals in order, preserving a lock-only change', async () => {
    const base = commit('baseline', {'package.json': '{"devDependencies":{"vitest":"1"}}', 'bun.lock': '1'})
    const lock = commit('Update runtime lock', {'bun.lock': '2'})
    commit('Update test tooling', {'package.json': '{"devDependencies":{"vitest":"2"}}', 'bun.lock': '3'})
    const source = commit('Improve server', {'src/index.ts': 'hello'})
    const notes = await render(base, source)
    expect(notes).toContain('Update runtime lock')
    expect(notes).toContain('Improve server')
    expect(notes).not.toContain('Update test tooling')
    expect(notes?.indexOf('Update runtime lock')).toBeLessThan(notes?.indexOf('Improve server') ?? -1)
    expect(notes).toContain(lock.slice(0, 12))
    expect(notes).toContain(source.slice(0, 12))
    expect(notes?.endsWith('\n')).toBe(true)
    expect(await render(base, source)).toBe(notes)
  })

  it('skips documentation and generated release notes', async () => {
    const base = commit('baseline', {'package.json': '{}'})
    commit('docs', {'README.md': 'docs'})
    const head = commit('generated', {'docs/releases/batch.md': 'notes'})
    expect(await render(base, head)).toBeNull()
    expect(await render(head, head)).toBeNull()
  })

  it('classifies changes without passing release credentials to the child process', () => {
    const base = commit('baseline', {'package.json': '{}'})
    const head = commit('Update server', {'src/index.ts': 'content'})
    const probe = join(repo, 'check-env.cjs')
    writeFileSync(probe, 'if ("GH_TOKEN" in process.env || "RELEASE_APP_TOKEN" in process.env) { console.error("Release credentials inherited"); process.exit(42) }')
    vi.stubEnv('NODE_OPTIONS', `--require ${JSON.stringify(probe)}`)
    vi.stubEnv('GH_TOKEN', 'test-token')
    vi.stubEnv('RELEASE_APP_TOKEN', 'test-app-token')
    try {
      expect(renderReleaseBatch(repo, base, head)).toContain('Update server')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('renders a merge subject and its own ref, not its side-parent ref', async () => {
    const base = commit('baseline', {'package.json': '{}'})
    git('checkout', '-qb', 'side')
    const side = commit('side change', {'src/side.ts': 'side'})
    git('checkout', '-q', '-')
    commit('docs', {'README.md': 'docs'})
    git('merge', '--no-ff', '--no-gpg-sign', 'side', '-m', 'Merge useful change')
    const head = git('rev-parse', 'HEAD')
    const notes = await render(base, head)
    expect(notes).toContain('Merge useful change')
    expect(notes).toContain(head.slice(0, 12))
    expect(notes).not.toContain(side.slice(0, 12))
  })

  it('rejects malformed, non-commit and non-first-parent inputs', async () => {
    const base = commit('baseline', {'package.json': '{}'})
    git('checkout', '-qb', 'side')
    const side = commit('side', {'src/side.ts': 'side'})
    git('checkout', '-q', '-')
    commit('main', {'README.md': 'main'})
    git('merge', '--no-ff', '--no-gpg-sign', 'side', '-m', 'Merge side')
    const head = git('rev-parse', 'HEAD')
    const tree = git('rev-parse', `${head}^{tree}`)
    for (const invalid of [base.slice(0, 8), 'HEAD', tree, side, '0'.repeat(40)]) {
      await expect(render(invalid, head)).rejects.toThrow()
    }
  })

  it('rejects shallow repositories and classifier errors', async () => {
    const base = commit('baseline', {'package.json': '{}'})
    const head = commit('bad manifest', {'package.json': 'invalid'})
    await expect(render(base, head)).rejects.toThrow()
    const shallow = join(repo, '.git', 'shallow')
    writeFileSync(shallow, `${base}\n`)
    await expect(render(base, head)).rejects.toThrow()
  })

  it('rejects incomplete local object history', async () => {
    const base = commit('baseline', {'package.json': '{}'})
    const head = commit('change', {'src/index.ts': 'content'})
    rmSync(join(repo, '.git', 'objects', base.slice(0, 2), base.slice(2)))
    await expect(render(head, head)).rejects.toThrow()
  })
})
