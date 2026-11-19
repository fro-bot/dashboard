import {execFileSync} from 'node:child_process'
import process from 'node:process'

import {decide} from '../should-release.ts'

/** Discovers notes only; the caller must independently verify release identity. */
export function discoverBatch(input: {repoDir: string; baseline: string; main: string}): {notes: string} | null {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: input.repoDir,
    encoding: 'utf8',
    env: {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1'},
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') {
    throw new Error('Cannot discover a batch from shallow history')
  }
  if (![input.baseline, input.main].every(sha => /^(?:[\da-f]{40}|[\da-f]{64})$/i.test(sha))) {
    throw new Error('Both inputs must be a full commit SHA')
  }
  const resolveCommit = (revision: string) => {
    const commit = git('rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`).trim()
    if (commit !== revision.toLowerCase()) throw new Error('Input is not an exact commit SHA')
    return commit
  }
  const baseline = resolveCommit(input.baseline)
  const main = resolveCommit(input.main)
  const history = git('rev-list', '--first-parent', main).trim().split('\n')
  const baseIndex = history.indexOf(baseline)
  if (baseIndex === -1) throw new Error('Baseline is not on first-parent history')

  const commits = history.slice(0, baseIndex).reverse()
  let parent = baseline
  const entries: string[] = []
  for (const commit of commits) {
    const files = git('diff', '--no-renames', '--name-only', '-z', parent, commit, '--').split('\0').filter(Boolean)
    // Match the CLI's behavior: both manifests must be readable and parseable,
    // even when a hard-release path would otherwise decide the interval.
    const basePkg = JSON.parse(git('show', `${parent}:package.json`)) as Parameters<typeof decide>[1]
    const headPkg = JSON.parse(git('show', `${commit}:package.json`)) as Parameters<typeof decide>[2]
    if (decide(files, basePkg, headPkg).shouldRelease) {
      const subject = git('show', '-s', '--format=%s', commit).trimEnd()
      const pr = subject.match(/\(#([1-9]\d*)\)$/)?.[1]
      const escaped = subject.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll(/([\\`*_{}[\]()#!|])/g, String.raw`\$1`)
      entries.push(`- ${escaped}${pr === undefined ? '' : ` (https://github.com/fro-bot/dashboard/pull/${pr})`}`)
    }
    parent = commit
  }
  return entries.length ? {notes: `# Pending release\n\n${entries.join('\n')}\n`} : null
}
