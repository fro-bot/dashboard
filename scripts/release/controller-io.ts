import {Buffer} from 'node:buffer'
import {execFile} from 'node:child_process'
import {access} from 'node:fs/promises'
import {resolve} from 'node:path'
import process from 'node:process'

export interface CommandResult {status: number | null; stdout: string; stderr: string}
export type Runner = (command: string, args: readonly string[]) => Promise<CommandResult>
export type ImageObservation = {state: 'present'; value: {digest: string}} | {state: 'absent'} | {state: 'unknown'; reason: 'malformed' | 'read-failed'}
export type LocalObservation<T> = {state: 'present'; value: T} | {state: 'unknown'; reason: 'malformed' | 'read-failed'}
export interface CommitFacts {sha: string; parents: string[]; tree: string; message: string; paths: string[]}
export interface ControllerRunOptions {cwd: string; env: NodeJS.ProcessEnv; timeout: number}
export type ControllerRunner = (command: string, args: readonly string[], options: ControllerRunOptions) => Promise<CommandResult>
export interface CandidatePushInput {repoDir: string; head: string; ref: 'refs/heads/release/pending'; expected: string | null; args: string[]}
export interface ControllerIo {
  syncMain: (expectSha: string, candidateSha: string | null) => Promise<void>
  pushCandidate: (input: CandidatePushInput) => Promise<void>
  nextVersion: () => Promise<LocalObservation<string>>
}

const shaPattern = /^[a-f0-9]{40}$/u
const localEnv = {PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C'}

const controllerRunner: ControllerRunner = async (command, args, options) => new Promise(resolveResult => {
  execFile(command, [...args], {...options, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
    resolveResult({status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr})
  })
})

/** Repo-bound, fail-closed release runner. No command uses a shell or exposes raw errors. */
export function createControllerIo(input: {repoDir: string; appToken: string}, run: ControllerRunner = controllerRunner): ControllerIo {
  const repoDir = resolve(input.repoDir)
  const remote = 'https://github.com/fro-bot/dashboard'
  const env: NodeJS.ProcessEnv = {
    ...localEnv,
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'http.proxy', GIT_CONFIG_VALUE_3: '',
  }
  let synced: string | null = null
  const invoke = async (command: string, args: string[], commandEnv = env) => {
    try {
      return await run(command, args, {cwd: repoDir, env: commandEnv, timeout: 30_000})
    } catch {
      throw new Error('refused')
    }
  }
  const gitRun = async (args: string[], commandEnv = env) => invoke('git', ['--no-replace-objects', ...args], commandEnv)
  const required = async (args: string[], commandEnv = env) => {
    const result = await gitRun(args, commandEnv)
    if (result.status !== 0) throw new Error('refused')
    return result.stdout
  }
  const verify = async () => {
    const pushurl = await gitRun(['config', '--local', '--no-includes', '--get-all', 'remote.origin.pushurl'])
    if (pushurl.status !== 1 || pushurl.stdout !== '') throw new Error('refused')
    const origin = await required(['config', '--local', '--no-includes', '--get-all', 'remote.origin.url'])
    if (origin !== `${remote}\n` && origin !== `${remote}.git\n`) throw new Error('refused')
    const config = await required(['config', '--local', '--no-includes', '--null', '--list'])
    if (config !== '' && !config.endsWith('\0')) throw new Error('refused')
    const safeKey = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|remote\.origin\.(?:url|fetch)|user\.(?:name|email)|branch\.[^.]+\.(?:remote|merge))$/u
    if (config.split('\0').filter(Boolean).some(entry => entry !== 'gc.auto\n0' && !safeKey.test(entry.split('\n', 1)[0] ?? ''))) throw new Error('refused')
    if ((await required(['rev-parse', '--is-shallow-repository'])) !== 'false\n') throw new Error('refused')
    const grafts = (await required(['rev-parse', '--git-path', 'info/grafts'])).trim()
    try {
      await access(resolve(repoDir, grafts))
      throw new Error('refused')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('refused')
    }
  }
  return {
    async syncMain(expectSha, candidateSha) {
      synced = null
      if (!shaPattern.test(expectSha) || (candidateSha !== null && !shaPattern.test(candidateSha))) throw new Error('refused')
      await verify()
      const refs = ['+refs/heads/main:refs/held-release/main']
      if (candidateSha !== null) refs.push('+refs/heads/release/pending:refs/held-release/candidate')
      await required(['fetch', '--tags', '--no-recurse-submodules', '--no-auto-maintenance', remote, ...refs])
      if (await required(['rev-parse', 'refs/held-release/main^{commit}']) !== `${expectSha}\n`) throw new Error('refused')
      if (candidateSha !== null && await required(['rev-parse', 'refs/held-release/candidate^{commit}']) !== `${candidateSha}\n`) throw new Error('refused')
      synced = expectSha
    },
    async pushCandidate(push) {
      const ref = 'refs/heads/release/pending'
      if (resolve(push.repoDir) !== repoDir || push.ref !== ref || !shaPattern.test(push.head) || (push.expected !== null && !shaPattern.test(push.expected))) throw new Error('refused')
      const expectedArgs = ['push', `--force-with-lease=${ref}:${push.expected ?? ''}`, 'origin', `${push.head}:${ref}`]
      if (push.args.length !== expectedArgs.length || !push.args.every((arg, index) => arg === expectedArgs[index])) throw new Error('refused')
      if (input.appToken.length === 0 || /[\r\n\0]/u.test(input.appToken)) throw new Error('refused')
      await verify()
      const authEnv = {...env, GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_4: `http.${remote}.extraheader`, GIT_CONFIG_VALUE_4: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.appToken}`).toString('base64')}`}
      await required(['push', `--force-with-lease=${ref}:${push.expected ?? ''}`, remote, `${push.head}:${ref}`], authEnv)
    },
    async nextVersion() {
      if (synced === null) return {state: 'unknown', reason: 'read-failed'}
      try {
        await verify()
        if (await required(['rev-parse', 'refs/held-release/main^{commit}']) !== `${synced}\n`) return {state: 'unknown', reason: 'read-failed'}
        await required(['ls-files', '--error-unmatch', 'scripts/compute-release-tag.ts'])
        const tracked = await required(['rev-parse', 'refs/held-release/main:scripts/compute-release-tag.ts'])
        const actual = await required(['hash-object', '--no-filters', 'scripts/compute-release-tag.ts'])
        if (!shaPattern.test(tracked.trim()) || actual !== tracked) return {state: 'unknown', reason: 'read-failed'}
        const result = await invoke(process.execPath, [resolve(repoDir, 'scripts/compute-release-tag.ts')])
        if (result.status !== 0 || !/^\d{4}\.(?:0[1-9]|1[0-2])\.\d+\n$/u.test(result.stdout)) return {state: 'unknown', reason: 'read-failed'}
        return {state: 'present', value: result.stdout.slice(0, -1)}
      } catch {
        return {state: 'unknown', reason: 'read-failed'}
      }
    },
  }
}
const git = async (cwd: string, args: string[]): Promise<string> => new Promise((resolveResult, reject) => {
  execFile('git', ['--no-replace-objects', ...args], {cwd, env: localEnv, encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024}, (error, stdout) => {
    if (error) reject(new Error('git failed'))
    else {
      try {
        resolveResult(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(stdout))
      } catch {
        reject(new Error('git failed'))
      }
    }
  })
})

async function completeLocalHistory(cwd: string): Promise<boolean> {
  if ((await git(cwd, ['rev-parse', '--is-shallow-repository'])).trim() !== 'false') return false
  const grafts = (await git(cwd, ['rev-parse', '--git-path', 'info/grafts'])).trim()
  try {
    await access(resolve(cwd, grafts))
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/** Newest first, including the root. Input must be an exact object id, never a revision expression. */
export async function readFirstParentHistory(cwd: string, sha: string): Promise<LocalObservation<string[]>> {
  if (!shaPattern.test(sha)) return {state: 'unknown', reason: 'malformed'}
  try {
    if (!await completeLocalHistory(cwd)) return {state: 'unknown', reason: 'read-failed'}
    const lines = (await git(cwd, ['rev-list', '--first-parent', sha])).trim().split('\n')
    if (lines[0] !== sha || !lines.every(line => shaPattern.test(line))) return {state: 'unknown', reason: 'read-failed'}
    return {state: 'present', value: lines}
  } catch {
    return {state: 'unknown', reason: 'read-failed'}
  }
}

/** Read an exact commit, comparing paths to its first parent (or the empty tree for a root). */
export async function readCommitFacts(cwd: string, sha: string): Promise<LocalObservation<CommitFacts>> {
  if (!shaPattern.test(sha)) return {state: 'unknown', reason: 'malformed'}
  try {
    if (!await completeLocalHistory(cwd)) return {state: 'unknown', reason: 'read-failed'}
    const raw = await git(cwd, ['cat-file', 'commit', sha])
    const split = raw.indexOf('\n\n')
    if (split === -1) return {state: 'unknown', reason: 'read-failed'}
    const headers = raw.slice(0, split).split('\n')
    const tree = headers.find(line => line.startsWith('tree '))?.slice(5)
    const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7))
    if (tree === undefined || !shaPattern.test(tree) || !parents.every(parent => shaPattern.test(parent))) return {state: 'unknown', reason: 'read-failed'}
    const parent = parents[0]
    const diff = parent === undefined ? ['--root', sha] : [parent, sha]
    const output = await git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', ...diff, '--'])
    if (output !== '' && !output.endsWith('\0')) return {state: 'unknown', reason: 'read-failed'}
    const paths = output === '' ? [] : output.slice(0, -1).split('\0')
    return {state: 'present', value: {sha, parents, tree, message: raw.slice(split + 2), paths}}
  } catch {
    return {state: 'unknown', reason: 'read-failed'}
  }
}

const runCommand: Runner = async (command, args) => new Promise(resolve => {
  execFile(command, [...args], {encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024}, (error, stdout, stderr) => {
    resolve({status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr})
  })
})

/** An exact manifest absence only; all transport and malformed results fail closed. */
export async function inspectImage(tag: string, run: Runner = runCommand): Promise<ImageObservation> {
  if (!/^(?:\d{4}\.(?:0[1-9]|1[0-2])\.\d+|sha-[a-f0-9]{7}|latest|ci-[1-9]\d*-[1-9]\d*)$/u.test(tag)) return {state: 'unknown', reason: 'malformed'}
  const ref = `ghcr.io/fro-bot/dashboard:${tag}`
  try {
    const result = await run('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', '{{.Manifest.Digest}}'])
    if (result.status !== 0) {
      const lines = result.stderr.split('\n').map(line => line.trim()).filter(Boolean)
      return result.stdout.trim() === '' && lines.length > 0 && lines.every(line => line === `${ref}: not found` || line === `ERROR: ${ref}: not found`)
        ? {state: 'absent'}
        : {state: 'unknown', reason: 'read-failed'}
    }
    const digest = result.stdout.trim()
    return /^sha256:[a-f0-9]{64}$/u.test(digest) ? {state: 'present', value: {digest}} : {state: 'unknown', reason: 'malformed'}
  } catch {
    return {state: 'unknown', reason: 'read-failed'}
  }
}
