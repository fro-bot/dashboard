import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {BATCH_NOTES_PATH, candidateTree, createCandidate} from '../scripts/release/candidate.ts'

let dir: string
let base: string

function git(...args: string[]): string {
  return execFileSync('git', args, {cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()
}

function put(path: string, contents: string): void {
  mkdirSync(dirname(join(dir, path)), {recursive: true})
  writeFileSync(join(dir, path), contents)
}

function commit(): string {
  git('add', '--all')
  git('commit', '--no-gpg-sign', '--quiet', '-m', 'base')
  return git('rev-parse', 'HEAD')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-candidate-test-'))
  git('init', '--quiet', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  put('src/app.ts', 'keep\n')
  put('docs/releases/batch.md', 'old\n')
  base = commit()
})

afterEach(() => rmSync(dir, {recursive: true, force: true}))

describe('release candidate', () => {
  it('computes the independently staged notes-only tree without changing the index, worktree, or refs', () => {
    const notes = '# Pending\n\n- café\n\n'
    put(BATCH_NOTES_PATH, notes)
    git('add', BATCH_NOTES_PATH)
    const expected = git('write-tree')
    git('reset', '--quiet', '--hard', base)
    put('src/app.ts', 'unstaged work\n')
    put('staged.txt', 'staged work\n')
    git('add', 'staged.txt')
    const status = git('status', '--porcelain=v1')
    const index = readFileSync(join(dir, '.git/index'))
    const refs = git('show-ref')

    const input = {repoDir: dir, base, notes}
    const tree = candidateTree(input)
    expect(tree).toBe(expected)
    expect(candidateTree(input)).toBe(tree)
    expect(git('status', '--porcelain=v1')).toBe(status)
    expect(readFileSync(join(dir, '.git/index'))).toEqual(index)
    expect(git('show-ref')).toBe(refs)
    expect(readFileSync(join(dir, BATCH_NOTES_PATH), 'utf8')).toBe('old\n')
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toBe('unstaged work\n')
    expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', base, tree)).toBe(BATCH_NOTES_PATH)
    expect(git('show', `${tree}:src/app.ts`)).toBe('keep')
    expect(execFileSync('git', ['show', `${tree}:${BATCH_NOTES_PATH}`], {cwd: dir, encoding: 'utf8'})).toBe(notes)
    expect(git('ls-tree', tree, BATCH_NOTES_PATH)).toMatch(/^100644 blob /)
  })

  it('creates an unreferenced commit with exactly the base parent and expected tree', () => {
    const input = {repoDir: dir, base, notes: 'release\n'}
    const refs = git('show-ref')
    const candidate = createCandidate(input)
    expect(candidate).toEqual({head: candidate.head, parent: base, tree: candidateTree(input)})
    expect(git('rev-list', '--parents', '-n', '1', candidate.head)).toBe(`${candidate.head} ${base}`)
    expect(git('rev-parse', `${candidate.head}^{tree}`)).toBe(candidate.tree)
    expect(git('show', '-s', '--format=%an|%cn', candidate.head)).toBe('Dashboard release|Dashboard release')
    expect(git('config', '--local', 'user.name')).toBe('Test')
    expect(git('show-ref')).toBe(refs)
    expect(git('status', '--porcelain')).toBe('')
  })

  it('rejects empty notes and inputs that are not exact existing commit IDs', () => {
    git('tag', '-a', 'annotated', '-m', 'tag', base)
    for (const invalid of ['HEAD', base.slice(0, 12), '0'.repeat(base.length), git('rev-parse', 'annotated^{tag}'), git('rev-parse', `${base}^{tree}`)]) {
      expect(() => candidateTree({repoDir: dir, base: invalid, notes: 'notes\n'})).toThrow()
    }
    expect(() => candidateTree({repoDir: dir, base, notes: ''})).toThrow()
    expect(() => candidateTree({repoDir: dir, base, notes: ' \t\n\r\n'})).toThrow()
  })

  it('refuses directory and symlink conflicts at the fixed path or its ancestors', () => {
    rmSync(join(dir, BATCH_NOTES_PATH))
    symlinkSync('../../src/app.ts', join(dir, BATCH_NOTES_PATH))
    const leafSymlinkBase = commit()
    expect(() => candidateTree({repoDir: dir, base: leafSymlinkBase, notes: 'notes'})).toThrow()
    rmSync(join(dir, 'docs'), {recursive: true})
    symlinkSync('src', join(dir, 'docs'))
    const symlinkBase = commit()
    expect(() => candidateTree({repoDir: dir, base: symlinkBase, notes: 'notes'})).toThrow()
    rmSync(join(dir, 'docs'))
    put('docs/releases/batch.md/nested', 'conflict')
    const directoryBase = commit()
    expect(() => candidateTree({repoDir: dir, base: directoryBase, notes: 'notes'})).toThrow()
  })

  it('creates missing directories and ignores replace refs when reading the exact base', () => {
    rmSync(join(dir, 'docs'), {recursive: true})
    const withoutNotes = commit()
    const original = candidateTree({repoDir: dir, base: withoutNotes, notes: 'notes\n'})
    git('replace', withoutNotes, base)
    expect(candidateTree({repoDir: dir, base: withoutNotes, notes: 'notes\n'})).toBe(original)
    expect(git('show', `${original}:${BATCH_NOTES_PATH}`)).toBe('notes')
  })
})
