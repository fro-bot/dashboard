import {execFileSync} from 'node:child_process'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'

export const BATCH_NOTES_PATH = 'docs/releases/batch.md'

interface Input {repoDir: string; base: string; notes: string}

function gitRunner(repoDir: string) {
  // Ambient Git routing and object overrides must not redirect this operation.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, {GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0'})
  const git = (args: string[], stdin?: string) => execFileSync('git', args, {
    cwd: repoDir, encoding: 'utf8', env, input: stdin, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })
  return {env, git}
}

export function candidateTree(input: Input): string {
  if (!input.notes.trim()) throw new Error('Batch notes must be nonempty')
  const {env, git} = gitRunner(input.repoDir)
  const format = git(['rev-parse', '--show-object-format']).trim()
  const length = format === 'sha1' ? 40 : format === 'sha256' ? 64 : 0
  const oid = (value: string) => value.length === length && /^[\da-f]+$/.test(value)
  if (!oid(input.base) || git(['cat-file', '-t', input.base]).trim() !== 'commit') throw new Error('Base must be an exact full commit SHA')

  for (const path of ['docs', 'docs/releases', BATCH_NOTES_PATH]) {
    const entry = git(['ls-tree', '-z', input.base, '--', path])
    if (!entry) continue
    const match = /^(\d{6}) (\w+) ([\da-f]+)\t([^\0]+)\0$/.exec(entry)
    if (!match || match[4] !== path || !oid(match[3] ?? '') ||
      (path === BATCH_NOTES_PATH ? !['100644', '100755'].includes(match[1] ?? '') || match[2] !== 'blob' : match[1] !== '040000' || match[2] !== 'tree')) {
      throw new Error(`Conflicting candidate path: ${path}`)
    }
  }

  const temp = mkdtempSync(join(tmpdir(), 'release-candidate-index-'))
  try {
    env.GIT_INDEX_FILE = join(temp, 'index')
    git(['read-tree', input.base])
    const blob = git(['hash-object', '-w', '--stdin'], input.notes).trim()
    if (!oid(blob)) throw new Error('Unexpected blob ID')
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${BATCH_NOTES_PATH}`])
    const tree = git(['write-tree']).trim()
    if (!oid(tree)) throw new Error('Unexpected tree ID')
    const changed = git(['diff-tree', '--no-commit-id', '--no-renames', '-r', '--name-only', '-z', input.base, tree])
    if (changed !== '' && changed !== `${BATCH_NOTES_PATH}\0`) throw new Error('Unexpected candidate tree changes')
    return tree
  } finally {
    rmSync(temp, {recursive: true, force: true})
  }
}

export function createCandidate(input: Input): {head: string; parent: string; tree: string} {
  const tree = candidateTree(input)
  const {git} = gitRunner(input.repoDir)
  const head = git(['-c', 'user.name=Dashboard release', '-c', 'user.email=dashboard-release@users.noreply.github.com', 'commit-tree', '--no-gpg-sign', tree, '-p', input.base], 'Prepare release batch\n').trim()
  if (!new RegExp(`^[0-9a-f]{${input.base.length}}$`).test(head) ||
    git(['rev-list', '--parents', '-n', '1', head]).trim() !== `${head} ${input.base}` ||
    git(['rev-parse', `${head}^{tree}`]).trim() !== tree) throw new Error('Unexpected candidate commit')
  return {head, parent: input.base, tree}
}
