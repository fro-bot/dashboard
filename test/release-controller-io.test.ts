import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {describe, expect, it} from 'vitest'
import * as io from '../scripts/release/controller-io.ts'

describe('release controller image inspection', () => {
  it('accepts only an exact digest for a fixed safe image tag', async () => {
    const calls: string[][] = []
    const run = async (_command: string, args: readonly string[]) => {
      calls.push([...args])
      return {status: 0, stdout: `sha256:${'a'.repeat(64)}\n`, stderr: ''}
    }
    expect(await io.inspectImage('2026.11.1', run)).toEqual({state: 'present', value: {digest: `sha256:${'a'.repeat(64)}`}})
    expect(calls).toEqual([['buildx', 'imagetools', 'inspect', 'ghcr.io/fro-bot/dashboard:2026.11.1', '--format', '{{.Manifest.Digest}}']])
    expect(await io.inspectImage('../evil', run)).toEqual({state: 'unknown', reason: 'malformed'})
    expect(calls).toHaveLength(1)
  })

  it('treats only an exact manifest-not-found response as absent', async () => {
    const run = async (_command: string, _args: readonly string[]) => ({status: 1, stdout: '', stderr: 'ERROR: ghcr.io/fro-bot/dashboard:latest: not found\n'})
    expect(await io.inspectImage('latest', run)).toEqual({state: 'absent'})
    expect(await io.inspectImage('sha-1234567', run)).toEqual({state: 'unknown', reason: 'read-failed'})
  })

  it('fails closed on malformed digests and runner failures', async () => {
    expect(await io.inspectImage('ci-123-4', async () => ({status: 0, stdout: 'sha256:abc', stderr: ''}))).toEqual({state: 'unknown', reason: 'malformed'})
    expect(await io.inspectImage('latest', async () => {
      throw new Error('secret')
    })).toEqual({state: 'unknown', reason: 'read-failed'})
    expect(await io.inspectImage('latest', async () => ({status: 1, stdout: 'unexpected', stderr: 'ERROR: ghcr.io/fro-bot/dashboard:latest: not found'}))).toEqual({state: 'unknown', reason: 'read-failed'})
  })
})

describe('release controller local history', () => {
  it('reads complete ordered first-parent history and exact commit facts without checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'u4-io-git-'))
    const git = (...args: string[]) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'}).trim()
    try {
      git('init', '-q')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.invalid')
      writeFileSync(join(dir, 'a file'), 'one')
      git('add', '.')
      git('commit', '--no-gpg-sign', '-qm', 'first')
      const first = git('rev-parse', 'HEAD')
      writeFileSync(join(dir, 'a file'), 'two')
      git('commit', '--no-gpg-sign', '-qam', 'second')
      const second = git('rev-parse', 'HEAD')
      const tree = git('rev-parse', 'HEAD^{tree}')
      expect(await io.readFirstParentHistory(dir, second)).toEqual({state: 'present', value: [second, first]})
      expect(await io.readCommitFacts(dir, second)).toEqual({state: 'present', value: {sha: second, parents: [first], tree, message: 'second\n', paths: ['a file']}})
      expect(git('rev-parse', 'HEAD')).toBe(second)
      expect(await io.readCommitFacts(dir, 'HEAD')).toEqual({state: 'unknown', reason: 'malformed'})
      writeFileSync(join(dir, '.git', 'info', 'grafts'), `${second}\n`)
      expect(await io.readFirstParentHistory(dir, second)).toEqual({state: 'unknown', reason: 'read-failed'})
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('rejects non-UTF-8 paths rather than returning a normalized replacement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'u4-io-git-'))
    const git = (args: string[], input?: Uint8Array) => execFileSync('git', args, {cwd: dir, encoding: 'utf8', input}).trim()
    try {
      git(['init', '-q'])
      git(['config', 'user.name', 'Fixture'])
      git(['config', 'user.email', 'fixture@example.invalid'])
      const blob = git(['hash-object', '-w', '--stdin'], Buffer.from('data'))
      const tree = git(['mktree', '-z'], Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xFF, 0])]))
      const commit = git(['commit-tree', tree], Buffer.from('fixture\n'))
      expect(await io.readCommitFacts(dir, commit)).toEqual({state: 'unknown', reason: 'read-failed'})
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('preserves an initial UTF-8 BOM in a changed filename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'u4-io-git-'))
    const git = (...args: string[]) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'}).trim()
    try {
      git('init', '-q')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.invalid')
      writeFileSync(join(dir, '\uFEFFnotes.md'), 'data')
      git('add', '.')
      git('commit', '--no-gpg-sign', '-qm', 'fixture')
      const facts = await io.readCommitFacts(dir, git('rev-parse', 'HEAD'))
      expect(facts.state === 'present' && facts.value.paths).toEqual(['\uFEFFnotes.md'])
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })
})

describe('controller shell seam', () => {
  const main = 'a'.repeat(40)
  const result = (stdout = '', status = 0) => ({status, stdout, stderr: ''})
  const goodRunner = (calls: {command: string; args: readonly string[]; options: io.ControllerRunOptions}[]): io.ControllerRunner => async (command, args, options) => {
    calls.push({command, args, options})
    if (args.includes('--is-shallow-repository')) return result('false\n')
    if (args.includes('remote.origin.pushurl')) return result('', 1)
    if (args.includes('remote.origin.url')) return result('https://github.com/fro-bot/dashboard\n')
    if (args.includes('--list')) return result('remote.origin.url\nhttps://github.com/fro-bot/dashboard\0')
    if (args.includes('--git-path')) return result('/nonexistent/u4-io-grafts\n')
    if (args.includes('refs/held-release/main^{commit}')) return result(`${main}\n`)
    if (args.includes('refs/held-release/main:scripts/compute-release-tag.ts') || args.includes('hash-object')) return result(`${main}\n`)
    if (command === process.execPath) return result('2026.11.2\n')
    return result()
  }

  it('fetches fixed refs and checks both observed object ids without checkout', async () => {
    const main = 'a'.repeat(40)
    const candidate = 'b'.repeat(40)
    const calls: {command: string; args: readonly string[]; options: io.ControllerRunOptions}[] = []
    const runner: io.ControllerRunner = async (command, args, options) => {
      calls.push({command, args, options})
      if (args.includes('--is-shallow-repository')) return {status: 0, stdout: 'false\n', stderr: ''}
      if (args.includes('--get-all') && args.includes('remote.origin.pushurl')) return {status: 1, stdout: '', stderr: ''}
      if (args.includes('--get-all') && args.includes('remote.origin.url')) return {status: 0, stdout: 'https://github.com/fro-bot/dashboard.git\n', stderr: ''}
      if (args.includes('--list')) return {status: 0, stdout: 'remote.origin.url\nhttps://github.com/fro-bot/dashboard.git\0', stderr: ''}
      if (args.includes('--git-path')) return {status: 0, stdout: '/nonexistent/u4-io-grafts\n', stderr: ''}
      if (args.includes('refs/held-release/main^{commit}')) return {status: 0, stdout: `${main}\n`, stderr: ''}
      if (args.includes('refs/held-release/candidate^{commit}')) return {status: 0, stdout: `${candidate}\n`, stderr: ''}
      return {status: 0, stdout: '', stderr: ''}
    }
    const controller = io.createControllerIo({repoDir: '/fixture', appToken: 'fixture-token'}, runner)
    await controller.syncMain(main, candidate)
    const fetch = calls.find(call => call.args.includes('fetch'))
    expect(fetch?.args).toContain('https://github.com/fro-bot/dashboard')
    expect(fetch?.args).toContain('+refs/heads/main:refs/held-release/main')
    expect(fetch?.args).toContain('+refs/heads/release/pending:refs/held-release/candidate')
    expect(calls.some(call => call.args.includes('checkout'))).toBe(false)
  })

  it('pushes only the exact candidate lease with a process-local scoped header', async () => {
    const calls: {command: string; args: readonly string[]; options: io.ControllerRunOptions}[] = []
    const controller = io.createControllerIo({repoDir: '/fixture', appToken: 'private-token'}, goodRunner(calls))
    const input = {repoDir: '/fixture', head: main, ref: 'refs/heads/release/pending' as const, expected: null, args: ['push', '--force-with-lease=refs/heads/release/pending:', 'origin', `${main}:refs/heads/release/pending`]}
    await controller.pushCandidate(input)
    const push = calls.find(call => call.args.includes('push'))
    expect(push?.args).toContain('https://github.com/fro-bot/dashboard')
    expect(JSON.stringify(push?.args)).not.toContain('private-token')
    expect(Object.values(push?.options.env ?? {}).join('\n')).toContain(Buffer.from('x-access-token:private-token').toString('base64'))
    await expect(controller.pushCandidate({...input, args: [...input.args, '--mirror']})).rejects.toThrow('refused')
  })

  it('does not compute a version without a complete successful sync', async () => {
    const calls: {command: string; args: readonly string[]; options: io.ControllerRunOptions}[] = []
    const controller = io.createControllerIo({repoDir: '/fixture', appToken: 'private-token'}, goodRunner(calls))
    expect(await controller.nextVersion()).toEqual({state: 'unknown', reason: 'read-failed'})
    await controller.syncMain(main, null)
    expect(await controller.nextVersion()).toEqual({state: 'present', value: '2026.11.2'})
    const invocation = calls.find(call => call.command === process.execPath)
    expect(invocation?.options.env.CALVER_MONTH).toBeUndefined()
  })

  it('does not execute a compute script that differs from synced main', async () => {
    const calls: {command: string; args: readonly string[]; options: io.ControllerRunOptions}[] = []
    const base = goodRunner(calls)
    const runner: io.ControllerRunner = async (command, args, options) => args.includes('hash-object') ? result(`${'b'.repeat(40)}\n`) : base(command, args, options)
    const controller = io.createControllerIo({repoDir: '/fixture', appToken: 'private-token'}, runner)
    await controller.syncMain(main, null)
    expect(await controller.nextVersion()).toEqual({state: 'unknown', reason: 'read-failed'})
    expect(calls.some(call => call.command === process.execPath)).toBe(false)
  })

  it('fails closed before network for pushurl overrides, rewritten URLs, and shallow checkouts', async () => {
    for (const failure of ['pushurl', 'rewrite', 'shallow', 'origin']) {
      const calls: {command: string; args: readonly string[]; options: io.ControllerRunOptions}[] = []
      const base = goodRunner(calls)
      const runner: io.ControllerRunner = async (command, args, options) => {
        if (failure === 'pushurl' && args.includes('remote.origin.pushurl')) return result('https://evil.invalid\n')
        if (failure === 'rewrite' && args.includes('--list')) return result('url.https://evil.invalid.insteadof\nhttps://github.com/\0')
        if (failure === 'shallow' && args.includes('--is-shallow-repository')) return result('true\n')
        if (failure === 'origin' && args.includes('remote.origin.url')) return result('https://evil.invalid\n')
        return base(command, args, options)
      }
      const controller = io.createControllerIo({repoDir: '/fixture', appToken: 'private-token'}, runner)
      await expect(controller.syncMain(main, null)).rejects.toThrow('refused')
      expect(calls.some(call => call.args.includes('fetch'))).toBe(false)
    }
  })

  it('rejects mismatched fetched refs and hides raw subprocess errors', async () => {
    const calls: {command: string; args: readonly string[]; options: io.ControllerRunOptions}[] = []
    const base = goodRunner(calls)
    const runner: io.ControllerRunner = async (command, args, options) => {
      if (args.includes('refs/held-release/candidate^{commit}')) return result(`${'c'.repeat(40)}\n`)
      return base(command, args, options)
    }
    const controller = io.createControllerIo({repoDir: '/fixture', appToken: 'private-token'}, runner)
    await expect(controller.syncMain(main, 'b'.repeat(40))).rejects.toThrow('refused')
    expect(await controller.nextVersion()).toEqual({state: 'unknown', reason: 'read-failed'})
    const failing = io.createControllerIo({repoDir: '/fixture', appToken: 'private-token'}, async () => {
      throw new Error('private-token')
    })
    await expect(failing.syncMain(main, null)).rejects.toThrow(/^refused$/u)
  })

  it('rejects a main ref that changed after fetch before invoking the version script', async () => {
    const calls: {command: string; args: readonly string[]; options: io.ControllerRunOptions}[] = []
    const base = goodRunner(calls)
    let reads = 0
    const runner: io.ControllerRunner = async (command, args, options) => {
      if (args.includes('refs/held-release/main^{commit}') && ++reads > 1) return result(`${'b'.repeat(40)}\n`)
      return base(command, args, options)
    }
    const controller = io.createControllerIo({repoDir: '/fixture', appToken: 'private-token'}, runner)
    await controller.syncMain(main, null)
    expect(await controller.nextVersion()).toEqual({state: 'unknown', reason: 'read-failed'})
    expect(calls.some(call => call.command === process.execPath)).toBe(false)
  })

  it('works with real local Git config and objects while faking the fetch only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'u4-io-git-'))
    const git = (...args: string[]) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'}).trim()
    try {
      git('init', '-q')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.invalid')
      git('remote', 'add', 'origin', 'https://github.com/fro-bot/dashboard.git')
      git('config', '--local', 'gc.auto', '0')
      mkdirSync(join(dir, 'scripts'))
      writeFileSync(join(dir, 'scripts', 'compute-release-tag.ts'), "process.stdout.write('2026.11.2\\n')\n")
      git('add', '.')
      git('commit', '--no-gpg-sign', '-qm', 'fixture')
      const head = git('rev-parse', 'HEAD')
      git('update-ref', 'refs/held-release/main', head)
      const runner: io.ControllerRunner = async (command, args, options) => {
        if (args.includes('fetch')) return result()
        try {
          return result(execFileSync(command, [...args], {...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}))
        } catch {
          return result('', 1)
        }
      }
      const controller = io.createControllerIo({repoDir: dir, appToken: 'private-token'}, runner)
      await controller.syncMain(head, null)
      expect(await controller.nextVersion()).toEqual({state: 'present', value: '2026.11.2'})
      expect(git('rev-parse', 'HEAD')).toBe(head)
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })
})
