import {execFileSync, spawnSync} from 'node:child_process'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'

/** Render release-eligible first-parent changes without consulting the worktree. */
export function renderReleaseBatch(repoDir: string, baseline: string, main: string): string | null {
  const env: NodeJS.ProcessEnv = {...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1'}
  delete env.GH_TOKEN
  delete env.RELEASE_APP_TOKEN
  const git = (...args: string[]) => execFileSync('git', ['-C', repoDir, ...args], {encoding: 'utf8', env, stdio: 'pipe'})
  const format = git('rev-parse', '--show-object-format').trim()
  const length = format === 'sha1' ? 40 : format === 'sha256' ? 64 : 0
  for (const id of [baseline, main]) {
    if (!length || !new RegExp(`^[0-9a-f]{${length}}$`).test(id) || git('cat-file', '-t', id).trim() !== 'commit') {
      throw new Error('Expected full commit object IDs')
    }
  }
  if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') throw new Error('Shallow repository')
  // Check all reachable objects locally, including parents not on the first-parent chain.
  git('rev-list', '--objects', '--quiet', '--missing=error', main, '--')
  const history = git('rev-list', '--first-parent', main).trim().split('\n')
  const end = history.indexOf(baseline)
  if (end === -1) throw new Error('Baseline is not in first-parent history')
  const commits = history.slice(0, end).reverse()
  if (!commits.length) return null

  const temp = mkdtempSync(join(tmpdir(), 'release-batch-'))
  const entries: {id: string; subject: string}[] = []
  try {
    let parent = baseline
    for (const id of commits) {
      const paths = git('diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', parent, id, '--').split('\0').filter(Boolean)
      if (paths.some(path => path.includes('\n') || path.includes('\r') || path.trim() !== path)) {
        throw new Error('Cannot classify ambiguous Git path')
      }
      const basePkg = join(temp, 'base.json')
      const headPkg = join(temp, 'head.json')
      writeFileSync(basePkg, git('show', `${parent}:package.json`))
      writeFileSync(headPkg, git('show', `${id}:package.json`))
      const result = spawnSync('node', [join(import.meta.dirname, 'should-release.ts'), '--changed-files', paths.join('\n'), '--base-pkg', basePkg, '--head-pkg', headPkg], {encoding: 'utf8', env})
      if (result.status === 0) {
        const subject = [...git('show', '-s', '--format=%s', id).trim()]
          .map(char => {
            const code = char.codePointAt(0) ?? 0
            if (code < 32 || code === 127) return ' '
            return '\\`*_[]<>'.includes(char) ? `\\${char}` : char
          })
          .join('')
        entries.push({id, subject})
      } else if (result.status !== 1 || result.error || result.signal) {
        throw new Error(`Release classifier failed: ${result.stderr || result.error || result.signal || result.status}`)
      }
      parent = id
    }
  } finally {
    rmSync(temp, {recursive: true, force: true})
  }
  if (!entries.length) return null
  return `# Release changes\n\n${entries.map(({id, subject}) => {
    let size = 12
    while (size < id.length && entries.some(other => other.id !== id && other.id.slice(0, size) === id.slice(0, size))) size++
    return `- ${subject} (${id.slice(0, size)})`
  }).join('\n')}\n`
}
