/**
 * Integration coverage for the real `node:child_process` subprocess runner.
 * Exercises actual child processes via ephemeral fixture scripts written to
 * a temp dir at test runtime — no fixture files are tracked in the repo.
 *
 * Runs under Vitest on Node. The runner spawns a literal `node`, so every test
 * here depends on the host being Node and fails loudly otherwise.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  buildHookPayload,
  createEngineWarmup,
  createHook,
  createLauncherRunner,
  createSpawnRunner,
  ENGINE_WARMUP_TIMEOUT_MS,
  HOOK_LAUNCHER_RELATIVE_PATH,
  type DetectorRunner,
} from './hook-bridge.ts'

// Split across two literals so this test source does not itself trip the
// per-line detector; the written fixture line carries both on one line.
const GRADIENT_TEXT_LINE = ['.gradient-heading { background-clip: text;', 'background-image: linear-gradient(red, blue); }'].join(' ')

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let tmpDir: string | undefined
const trackedPidFiles: string[] = []
const trackedProcessMarkers: string[] = []

function worktree(): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), 'impeccable-bridge-'))
  return tmpDir
}

function fixture(script: string): string {
  const path = join(worktree(), `${randomUUID()}.mjs`)
  writeFileSync(path, script, 'utf-8')
  return path
}

/** Writes an executable `sh` launcher stand-in and returns its path. */
function launcherFixture(body: string): string {
  const path = join(worktree(), `launcher-${randomUUID()}`)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { encoding: 'utf-8', mode: 0o755 })
  return path
}

/** Returns a path inside the temp dir that fixtures write a child PID or marker to. */
function trackedFile(prefix: string): string {
  const path = join(worktree(), `${prefix}-${randomUUID()}.txt`)
  trackedPidFiles.push(path)
  return path
}

function readPid(pidFile: string): number {
  return Number(readFileSync(pidFile, 'utf-8'))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Polls until the PID is gone, up to a bounded budget beyond the runner's own grace period. */
async function expectProcessGone(pid: number, budgetMs = 1000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(() => process.kill(pid, 0)).toThrow()
}

/** True when a process whose command line contains `marker` is running. */
function markerProcessAlive(marker: string): boolean {
  try {
    execFileSync('pgrep', ['-f', marker], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Polls until no process carries `marker`, up to a bounded budget. */
async function expectMarkerProcessesGone(marker: string, budgetMs = 1000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (markerProcessAlive(marker) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(markerProcessAlive(marker)).toBe(false)
}

/** Polls until `condition` holds, up to a bounded budget, so a slow process start is not mistaken for a missing one. */
async function waitUntil(condition: () => boolean, budgetMs = 1000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!condition() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

afterEach(() => {
  // Safety net: no test may leave a child behind, even when an assertion fails first.
  for (const marker of trackedProcessMarkers.splice(0)) {
    try {
      execFileSync('pkill', ['-f', marker], { stdio: 'ignore' })
    } catch {
      // Nothing matched.
    }
  }
  for (const file of trackedPidFiles.splice(0)) {
    if (!existsSync(file)) continue
    const pid = Number(readFileSync(file, 'utf-8'))
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

const payload = buildHookPayload({
  tool: 'edit',
  args: { filePath: '/repo/src/App.tsx' },
  cwd: '/repo',
  sessionID: 'sess-1',
})

describe('test runtime', () => {
  it('runs under Node, because the runner spawns a literal node', () => {
    expect(process.versions.node).toMatch(/^\d+\.\d+\.\d+/)
    expect(process.versions.bun).toBeUndefined()
  })
})

describe('createSpawnRunner', () => {
  it('resolves ok for a quiet-clean child: exit 0, empty stdout, empty stderr', async () => {
    const scriptPath = fixture('process.exit(0);\n')
    const runner = createSpawnRunner({ scriptPath })
    const result = await runner(payload, { worktree: worktree() })
    expect(result).toEqual({ kind: 'ok', stdout: '', stderr: '' })
  })

  it('resolves ok with the well-formed Claude PostToolUse envelope on stdout', async () => {
    const envelope = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'found: gradient-text' },
    })
    // No trailing process.exit(): writes to a pipe are async, and exiting
    // immediately after a write can truncate it before the OS pipe flushes.
    const scriptPath = fixture(`process.stdout.write(${JSON.stringify(envelope)});\n`)
    const runner = createSpawnRunner({ scriptPath })
    const result = await runner(payload, { worktree: worktree() })
    expect(result).toEqual({ kind: 'ok', stdout: envelope, stderr: '' })
  })

  it('resolves nonzero-exit with the exit code', async () => {
    const scriptPath = fixture('process.exit(3);\n')
    const runner = createSpawnRunner({ scriptPath })
    const result = await runner(payload, { worktree: worktree() })
    expect(result).toEqual({ kind: 'nonzero-exit', exitCode: 3, stdout: '', stderr: '' })
  })

  it("surfaces malformed non-empty stdout as-is (parsing is createHook's job)", async () => {
    const scriptPath = fixture('process.stdout.write("not json");\nprocess.exit(0);\n')
    const runner = createSpawnRunner({ scriptPath })
    const result = await runner(payload, { worktree: worktree() })
    expect(result).toEqual({ kind: 'ok', stdout: 'not json', stderr: '' })
  })

  it('surfaces stderr alongside an exit-0, empty-stdout child', async () => {
    const scriptPath = fixture('process.stderr.write("diagnostic noise");\nprocess.exit(0);\n')
    const runner = createSpawnRunner({ scriptPath })
    const result = await runner(payload, { worktree: worktree() })
    expect(result).toEqual({ kind: 'ok', stdout: '', stderr: 'diagnostic noise' })
  })

  it('sets harness=claude and quiet=1 and strips both inherited depth env vars', async () => {
    const scriptPath = fixture(
      [
        'process.stdout.write(JSON.stringify({',
        '  harness: process.env.IMPECCABLE_HOOK_HARNESS,',
        '  quiet: process.env.IMPECCABLE_HOOK_QUIET,',
        '  impeccableDepth: process.env.IMPECCABLE_HOOK_DEPTH ?? null,',
        '  claudeDepth: process.env.CLAUDE_HOOK_DEPTH ?? null,',
        '}));',
        'process.exit(0);',
      ].join('\n'),
    )
    const runner = createSpawnRunner({ scriptPath })
    const prev = { impeccable: process.env.IMPECCABLE_HOOK_DEPTH, claude: process.env.CLAUDE_HOOK_DEPTH }
    process.env.IMPECCABLE_HOOK_DEPTH = '1'
    process.env.CLAUDE_HOOK_DEPTH = '1'
    try {
      const result = await runner(payload, { worktree: worktree() })
      expect(result.kind).toBe('ok')
      expect(JSON.parse(result.kind === 'ok' ? result.stdout : '')).toEqual({
        harness: 'claude',
        quiet: '1',
        impeccableDepth: null,
        claudeDepth: null,
      })
      // The bridge only removes inherited depth vars; it never mutates its own env.
      expect(process.env.IMPECCABLE_HOOK_DEPTH).toBe('1')
      expect(process.env.CLAUDE_HOOK_DEPTH).toBe('1')
    } finally {
      if (prev.impeccable === undefined) delete process.env.IMPECCABLE_HOOK_DEPTH
      else process.env.IMPECCABLE_HOOK_DEPTH = prev.impeccable
      if (prev.claude === undefined) delete process.env.CLAUDE_HOOK_DEPTH
      else process.env.CLAUDE_HOOK_DEPTH = prev.claude
    }
  })

  it('passes the child only the allow-listed environment', async () => {
    const scriptPath = fixture('process.stdout.write(JSON.stringify(process.env));\nprocess.exit(0);\n')
    const runner = createSpawnRunner({ scriptPath })

    await withEnv(
      {
        GITHUB_TOKEN: 'ghp_not-for-the-engine',
        FAKE_SECRET: 'not-for-the-engine',
        NODE_OPTIONS: '--max-old-space-size=64',
        LC_ALL: 'C',
        LANG: 'en_US.UTF-8',
        IMPECCABLE_HOME: '/tmp/impeccable-home',
        IMPECCABLE_HOOK_DEPTH: '1',
        CLAUDE_HOOK_DEPTH: '1',
        HTTPS_PROXY: 'http://proxy.invalid:3128',
        https_proxy: 'http://proxy.invalid:3128',
        NO_PROXY: 'localhost',
        SSL_CERT_FILE: '/tmp/ca.pem',
        CURL_CA_BUNDLE: '/tmp/ca.pem',
      },
      async () => {
        const result = await runner(payload, { worktree: worktree() })
        expect(result.kind).toBe('ok')
        if (result.kind !== 'ok') return
        const env = JSON.parse(result.stdout) as Record<string, string | undefined>

        for (const name of ['GITHUB_TOKEN', 'FAKE_SECRET', 'NODE_OPTIONS', 'IMPECCABLE_HOOK_DEPTH', 'CLAUDE_HOOK_DEPTH']) {
          expect(env).not.toHaveProperty(name)
        }
        expect(env.PATH).toBe(process.env.PATH)
        expect(env.HOME).toBe(process.env.HOME)
        expect(env.LC_ALL).toBe('C')
        expect(env.LANG).toBe('en_US.UTF-8')
        expect(env.IMPECCABLE_HOME).toBe('/tmp/impeccable-home')
        // The launcher's curl needs these behind a proxy or a TLS-intercepting CA.
        expect(env.HTTPS_PROXY).toBe('http://proxy.invalid:3128')
        expect(env.https_proxy).toBe('http://proxy.invalid:3128')
        expect(env.NO_PROXY).toBe('localhost')
        expect(env.SSL_CERT_FILE).toBe('/tmp/ca.pem')
        expect(env.CURL_CA_BUNDLE).toBe('/tmp/ca.pem')
        expect(env.IMPECCABLE_HOOK_HARNESS).toBe('claude')
        expect(env.IMPECCABLE_HOOK_QUIET).toBe('1')
        // Nothing outside the allow-list and the IMPECCABLE_ prefix gets through. macOS adds
        // __CF_USER_TEXT_ENCODING to every process it starts, so it is not the bridge's doing.
        const unexpected = Object.keys(env).filter(
          name =>
            name !== '__CF_USER_TEXT_ENCODING' &&
            !/^(PATH|HOME|TMPDIR|USER|LOGNAME|LANG|LC_.*|IMPECCABLE_.*)$/.test(name) &&
            !/^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|http_proxy|https_proxy|no_proxy|all_proxy|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE)$/.test(name),
        )
        expect(unexpected).toEqual([])
      },
    )
  })

  it('sends the payload over stdin without cross-contaminating stdout/stderr', async () => {
    const scriptPath = fixture(
      [
        'const chunks = [];',
        'for await (const chunk of process.stdin) chunks.push(chunk);',
        'const body = Buffer.concat(chunks).toString("utf-8");',
        'const parsed = JSON.parse(body);',
        'process.stderr.write("stderr-marker");',
        'process.stdout.write(JSON.stringify({toolFromStdin: parsed.tool_name}));',
      ].join('\n'),
    )
    const runner = createSpawnRunner({ scriptPath })
    const result = await runner(payload, { worktree: worktree() })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(JSON.parse(result.stdout)).toEqual({ toolFromStdin: 'edit' })
    expect(result.stderr).toBe('stderr-marker')
  })

  it('resolves spawn-error, without throwing, when the script file does not exist', async () => {
    const runner = createSpawnRunner({ scriptPath: join(tmpdir(), `does-not-exist-${randomUUID()}.mjs`) })
    const result = await runner(payload, { worktree: worktree() })
    expect(result.kind).toBe('spawn-error')
  })

  it('resolves spawn-error, without throwing, when the node executable does not exist', async () => {
    const scriptPath = fixture('process.exit(0);\n')
    const runner = createSpawnRunner({ scriptPath, command: `/does-not-exist-${randomUUID()}/node` })
    const result = await runner(payload, { worktree: worktree() })
    expect(result.kind).toBe('spawn-error')
  })

  it('resolves spawn-error, without throwing, when the worktree cwd does not exist', async () => {
    const scriptPath = fixture('process.exit(0);\n')
    const runner = createSpawnRunner({ scriptPath })
    const result = await runner(payload, { worktree: join(tmpdir(), `no-such-cwd-${randomUUID()}`) })
    expect(result.kind).toBe('spawn-error')
  })

  it('resolves timeout, without SIGKILL, when the child exits during the grace period', async () => {
    const markerFile = trackedFile('sigterm-marker')
    const scriptPath = fixture(
      [
        `import {writeFileSync} from 'node:fs';`,
        // Exits cleanly shortly after SIGTERM, well inside the grace period.
        // The marker is only written if SIGKILL did not arrive first.
        `process.on('SIGTERM', () => { setTimeout(() => { writeFileSync(${JSON.stringify(markerFile)}, 'graceful'); process.exit(0); }, 100); });`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    )
    const runner = createSpawnRunner({ scriptPath, timeoutMs: 500, killGraceMs: 2000 })
    const start = Date.now()
    const result = await runner(payload, { worktree: worktree() })
    const elapsedMs = Date.now() - start

    expect(result.kind).toBe('timeout')
    expect(existsSync(markerFile)).toBe(true)
    // Resolved on the child's own exit, not after waiting out the full grace period.
    expect(elapsedMs).toBeLessThan(500 + 2000)
  }, 15_000)

  it('escalates SIGTERM to SIGKILL after the grace period and resolves timeout with the child gone', async () => {
    const pidFile = trackedFile('pid')
    const scriptPath = fixture(
      [
        `import {writeFileSync} from 'node:fs';`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `process.on('SIGTERM', () => {});`, // ignore the graceful signal
        `setInterval(() => {}, 1000);`, // stay alive
      ].join('\n'),
    )
    // Allow cold Node startup and PID-file creation under contention; this test
    // is about SIGKILL/reaping, not making startup latency part of the fixture.
    const runner = createSpawnRunner({ scriptPath, timeoutMs: 1000, killGraceMs: 100 })
    const start = Date.now()
    const result = await runner(payload, { worktree: worktree() })
    const elapsedMs = Date.now() - start

    expect(result.kind).toBe('timeout')
    // Bounded: timeout + grace + slack.
    expect(elapsedMs).toBeLessThan(2500)
    await expectProcessGone(readPid(pidFile))
  }, 15_000)

  it('kills the whole process group on timeout: a grandchild in the child\'s group is gone, even when both ignore SIGTERM', async () => {
    const childPidFile = trackedFile('child-pid')
    const grandchildPidFile = trackedFile('grandchild-pid')
    const grandchildCode = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`
    const scriptPath = fixture(
      [
        `import {spawn} from 'node:child_process';`,
        `import {writeFileSync} from 'node:fs';`,
        `writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
        // A plain spawn: the grandchild stays in this process's group and holds the pipes.
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], {stdio: ['ignore', 'inherit', 'inherit']});`,
        `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
        `process.on('SIGTERM', () => {});`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    )
    const runner = createSpawnRunner({ scriptPath, timeoutMs: 1000, killGraceMs: 100 })
    const result = await runner(payload, { worktree: worktree() })

    expect(result.kind).toBe('timeout')
    await expectProcessGone(readPid(childPidFile))
    await expectProcessGone(readPid(grandchildPidFile))
  }, 15_000)

  it('kills a grandchild in the child\'s group that outlives an exited child and holds the pipes', async () => {
    const grandchildPidFile = trackedFile('grandchild-pid')
    const grandchildCode = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`
    const scriptPath = fixture(
      [
        `import {spawn} from 'node:child_process';`,
        `import {writeFileSync} from 'node:fs';`,
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], {stdio: ['ignore', 'inherit', 'inherit']});`,
        `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
        `process.exit(0);`,
      ].join('\n'),
    )
    const runner = createSpawnRunner({ scriptPath, timeoutMs: 400, killGraceMs: 100 })
    const start = Date.now()
    const result = await runner(payload, { worktree: worktree() })
    const elapsedMs = Date.now() - start

    expect(result.kind).toBe('timeout')
    expect(elapsedMs).toBeLessThan(400 + 100 + 2000)
    await expectProcessGone(readPid(grandchildPidFile))
  }, 15_000)

  it('resolves timeout at the final deadline when an exited child leaves stdout open through a grandchild', async () => {
    const grandchildPidFile = trackedFile('grandchild-pid')
    const scriptPath = fixture(
      [
        `import {spawn} from 'node:child_process';`,
        `import {writeFileSync} from 'node:fs';`,
        // The detached grandchild leads its own process group and inherits
        // stdout/stderr, so the pipes stay open after this process exits 0
        // and 'close' never fires on its own.
        `const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: ['ignore', 'inherit', 'inherit']});`,
        `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
        `grandchild.unref();`,
        `process.exit(0);`,
      ].join('\n'),
    )
    const runner = createSpawnRunner({ scriptPath, timeoutMs: 400, killGraceMs: 100 })
    const start = Date.now()
    const result = await runner(payload, { worktree: worktree() })
    const elapsedMs = Date.now() - start

    expect(result.kind).toBe('timeout')
    // Resolved by the deadline, not by waiting for the grandchild to release the pipes.
    expect(elapsedMs).toBeLessThan(400 + 100 + 2000)
    // A grandchild that leaves the child's process group is outside the group kill's reach; the afterEach safety net reaps it.
    expect(isAlive(readPid(grandchildPidFile))).toBe(true)
  }, 15_000)

  it('resolves overflow, keeping at most the cap, when stdout exceeds the bounded capture size', async () => {
    const scriptPath = fixture('process.stdout.write("x".repeat(200));\n')
    const runner = createSpawnRunner({ scriptPath, maxOutputBytes: 64 })
    const result = await runner(payload, { worktree: worktree() })
    expect(result.kind).toBe('overflow')
    if (result.kind !== 'overflow') return
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(64)
    expect(result.stdout.length).toBeLessThan(200)
  })

  it('resolves overflow when stderr exceeds the bounded capture size', async () => {
    const scriptPath = fixture('process.stderr.write("y".repeat(200));\n')
    const runner = createSpawnRunner({ scriptPath, maxOutputBytes: 64 })
    const result = await runner(payload, { worktree: worktree() })
    expect(result.kind).toBe('overflow')
    if (result.kind !== 'overflow') return
    expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(64)
  })

  it('does not report overflow for output exactly at the cap', async () => {
    const scriptPath = fixture('process.stdout.write("x".repeat(64));\n')
    const runner = createSpawnRunner({ scriptPath, maxOutputBytes: 64 })
    const result = await runner(payload, { worktree: worktree() })
    expect(result).toEqual({ kind: 'ok', stdout: 'x'.repeat(64), stderr: '' })
  })

  it('measures the cap in UTF-8 bytes, never decoded string length', async () => {
    // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes, so a length-based cap would
    // let about twice the intended byte budget through.
    const scriptPath = fixture(`process.stdout.write('é'.repeat(50));\n`)
    const runner = createSpawnRunner({ scriptPath, maxOutputBytes: 20 })
    const result = await runner(payload, { worktree: worktree() })
    expect(result.kind).toBe('overflow')
    if (result.kind !== 'overflow') return
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(20)
  })

  it('never re-expands a multibyte character split at the cap boundary', async () => {
    // 21 is odd and 'é' is 2 bytes, so the 21-byte prefix ends mid-character.
    // A naive Buffer#toString would turn the dangling lead byte into U+FFFD
    // (3 bytes) and push the string back over the cap.
    const scriptPath = fixture(`process.stdout.write('é'.repeat(50));\n`)
    const runner = createSpawnRunner({ scriptPath, maxOutputBytes: 21 })
    const result = await runner(payload, { worktree: worktree() })
    expect(result.kind).toBe('overflow')
    if (result.kind !== 'overflow') return
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(21)
    expect(result.stdout).not.toContain('\uFFFD')
    expect(result.stdout).toBe('é'.repeat(10))
  })

  it('never spawns a child when the script check settles after the run has already resolved', async () => {
    const markerFile = trackedFile('ran-marker')
    const scriptPath = fixture(
      [`import {writeFileSync} from 'node:fs';`, `writeFileSync(${JSON.stringify(markerFile)}, 'ran');`].join('\n'),
    )
    const runner = createSpawnRunner({
      scriptPath,
      timeoutMs: 100,
      killGraceMs: 50,
      deadlineSlackMs: 50,
      // Settles successfully, but only after the 200 ms deadline.
      checkScript: () => new Promise<void>((resolve) => setTimeout(resolve, 350)),
    })
    const result = await runner(payload, { worktree: worktree() })

    expect(result).toEqual({ kind: 'spawn-error' })
    // Wait past the late settle plus ample time for a wrongly spawned node to write its marker.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(existsSync(markerFile)).toBe(false)
  }, 15_000)

  it('resolves spawn-error, without throwing, when the script check rejects or throws', async () => {
    const scriptPath = fixture('process.exit(0);\n')
    const rejecting = createSpawnRunner({ scriptPath, checkScript: () => Promise.reject(new Error('stalled mount')) })
    const throwing = createSpawnRunner({
      scriptPath,
      checkScript: () => {
        throw new Error('sync fault')
      },
    })
    expect(await rejecting(payload, { worktree: worktree() })).toEqual({ kind: 'spawn-error' })
    expect(await throwing(payload, { worktree: worktree() })).toEqual({ kind: 'spawn-error' })
  })

  it('resolves overflow, not timeout, at the final deadline when the child overflowed and a grandchild holds the pipes', async () => {
    const grandchildPidFile = trackedFile('grandchild-pid')
    const scriptPath = fixture(
      [
        `import {spawn} from 'node:child_process';`,
        `import {writeFileSync} from 'node:fs';`,
        `process.stdout.write("x".repeat(200));`,
        // The detached grandchild leads its own process group and inherits
        // stdout/stderr, so the pipes stay open after this process exits and
        // 'close' never fires on its own.
        `const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: ['ignore', 'inherit', 'inherit']});`,
        `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
        `grandchild.unref();`,
        `process.exit(0);`,
      ].join('\n'),
    )
    const runner = createSpawnRunner({ scriptPath, timeoutMs: 400, killGraceMs: 100, maxOutputBytes: 64 })
    const start = Date.now()
    const result = await runner(payload, { worktree: worktree() })
    const elapsedMs = Date.now() - start

    expect(result.kind).toBe('overflow')
    if (result.kind !== 'overflow') return
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(64)
    // Resolved by the deadline, not by waiting for the grandchild to release the pipes.
    expect(elapsedMs).toBeLessThan(400 + 100 + 2000)
    // A grandchild that leaves the child's process group is outside the group kill's reach; the afterEach safety net reaps it.
    expect(isAlive(readPid(grandchildPidFile))).toBe(true)
  }, 15_000)

  it('caps at 1 MiB by default', async () => {
    const scriptPath = fixture('process.stdout.write("x".repeat(1024 * 1024 + 1));\n')
    const runner = createSpawnRunner({ scriptPath })
    const result = await runner(payload, { worktree: worktree() })
    expect(result.kind).toBe('overflow')
    if (result.kind !== 'overflow') return
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(1024 * 1024)
  })
})

describe('createSpawnRunner + createHook end-to-end', () => {
  it('appends only additionalContext to tool output for a real child producing the Claude envelope', async () => {
    const envelope = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'found: gradient-text at L3' },
    })
    const scriptPath = fixture(`process.stdout.write(${JSON.stringify(envelope)});\nprocess.exit(0);\n`)
    const hook = createHook({ runDetector: createSpawnRunner({ scriptPath }), worktree: worktree() })
    const output = { title: 't', output: 'ok', metadata: {} }
    await hook({ tool: 'edit', sessionID: 's', callID: 'c', args: { filePath: '/repo/src/App.tsx' } }, output)
    expect(output.output).toContain('found: gradient-text at L3')
    expect(output.output).not.toContain('hookSpecificOutput')
  })

  it('warns once on timeout and does not resolve while a SIGTERM-resistant child is still alive', async () => {
    const pidFile = trackedFile('pid')
    const scriptPath = fixture(
      [
        `import {writeFileSync} from 'node:fs';`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `process.on('SIGTERM', () => {});`, // ignore the graceful signal
        `setInterval(() => {}, 1000);`, // stay alive
      ].join('\n'),
    )
    const runner = createSpawnRunner({ scriptPath, timeoutMs: 1000, killGraceMs: 100 })
    const hook = createHook({ runDetector: runner, worktree: worktree() })
    const output = { title: 't', output: 'ok', metadata: {} }

    await hook({ tool: 'edit', sessionID: 's', callID: 'c', args: { filePath: '/repo/src/App.tsx' } }, output)

    expect(output.output).toContain('[impeccable]')
    expect(output.output).toContain('timed out')
    await expectProcessGone(readPid(pidFile))
  }, 15_000)

  it('warns overflow and appends no partial envelope for a real child that floods stdout', async () => {
    const scriptPath = fixture(
      [
        `process.stdout.write('{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"PARTIAL-FINDING ');`,
        `process.stdout.write("x".repeat(2 * 1024 * 1024));`,
        `process.stdout.write('"}}');`,
      ].join('\n'),
    )
    const hook = createHook({ runDetector: createSpawnRunner({ scriptPath }), worktree: worktree() })
    const output = { title: 't', output: 'ok', metadata: {} }
    await hook({ tool: 'edit', sessionID: 's', callID: 'c', args: { filePath: '/repo/src/App.tsx' } }, output)
    expect(output.output).toContain('[impeccable]')
    expect(output.output).toContain('more output than')
    expect(output.output).not.toContain('PARTIAL-FINDING')
    expect(output.output.length).toBeLessThan(1000)
  }, 15_000)

  it('never surfaces stderr text from a real child that exits nonzero', async () => {
    const scriptPath = fixture('process.stderr.write("RAW-STDERR secret");\nprocess.exit(2);\n')
    const hook = createHook({ runDetector: createSpawnRunner({ scriptPath }), worktree: worktree() })
    const output = { title: 't', output: 'ok', metadata: {} }
    await hook({ tool: 'edit', sessionID: 's', callID: 'c', args: { filePath: '/repo/src/App.tsx' } }, output)
    expect(output.output).toContain('did not run cleanly')
    expect(output.output).not.toContain('RAW-STDERR')
  })

  it('warns without throwing when the script cannot be spawned', async () => {
    const runner = createSpawnRunner({ scriptPath: join(tmpdir(), `does-not-exist-${randomUUID()}.mjs`) })
    const hook = createHook({ runDetector: runner, worktree: worktree() })
    const output = { title: 't', output: 'ok', metadata: {} }
    await expect(
      hook({ tool: 'edit', sessionID: 's', callID: 'c', args: { filePath: '/repo/src/App.tsx' } }, output),
    ).resolves.toBeUndefined()
    expect(output.output).toContain('[impeccable]')
  })
})

/** Runs `body` with the given process env overrides (`undefined` deletes a name), then restores the previous values. */
async function withEnv(overrides: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await body()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

interface StalledDownload {
  /** A copy of the vendored launcher with no engine binary beside it. */
  launcher: string
  /** A string unique to this download's URL, for `pgrep -f`. */
  marker: string
  /** How many download requests the server has accepted. */
  requests: () => number
  /** The launcher's staging directory for this download, `<cache>/bin/<version>`. */
  stagingDir: string
}

/**
 * Runs `body` against a launcher whose first-use engine download never
 * finishes: the server accepts the request and never answers, so the
 * launcher's curl waits. Only the launcher and its VERSION file are copied, so
 * the sibling engine binary is absent and the launcher takes its download
 * path. HOME and the cache root are temporary so a cached engine on this
 * machine is not used.
 */
async function withStalledDownload(body: (download: StalledDownload) => Promise<void>): Promise<void> {
  const marker = `cold-download-${randomUUID()}`
  trackedProcessMarkers.push(marker)

  let requestCount = 0
  const server: Server = createServer(() => {
    requestCount += 1
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  const scriptsDir = join(worktree(), 'cold-skill', 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  const launcher = join(scriptsDir, 'impeccable')
  copyFileSync(join(REPO_ROOT, HOOK_LAUNCHER_RELATIVE_PATH), launcher)
  writeFileSync(join(scriptsDir, 'VERSION'), '0.0.0\n', 'utf-8')
  const home = join(worktree(), 'cold-home')
  mkdirSync(home, { recursive: true })

  const overrides: Record<string, string | undefined> = {
    HOME: home,
    IMPECCABLE_HOME: join(home, '.impeccable'),
    IMPECCABLE_DOWNLOAD_BASE: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${marker}`,
    IMPECCABLE_BIN: undefined,
    IMPECCABLE_LAUNCHER_PROBE: undefined,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  }

  try {
    await withEnv(overrides, () =>
      body({ launcher, marker, requests: () => requestCount, stagingDir: join(home, '.impeccable', 'bin', '0.0.0') }),
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('createLauncherRunner', () => {
  it('runs the launcher directly with the hook subcommand and the claude harness and quiet env', async () => {
    const launcher = launcherFixture(
      'printf \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"argv=%s harness=%s quiet=%s"}}\' "$*" "$IMPECCABLE_HOOK_HARNESS" "$IMPECCABLE_HOOK_QUIET"',
    )
    const result = await createLauncherRunner(launcher)(payload, { worktree: worktree() })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.stdout).toContain('argv=hook harness=claude quiet=1')
  })

  it('hands the payload to the launcher over stdin', async () => {
    const launcher = launcherFixture('cat')
    const result = await createLauncherRunner(launcher)(payload, { worktree: worktree() })

    expect(result).toEqual({ kind: 'ok', stdout: JSON.stringify(payload), stderr: '' })
  })

  it('leaves no curl behind when the launcher times out during a first-use engine download', async () => {
    await withStalledDownload(async ({ launcher, marker, requests }) => {
      const runner = createSpawnRunner({
        scriptPath: launcher,
        command: launcher,
        args: ['hook'],
        timeoutMs: 1500,
        killGraceMs: 200,
      })
      const result = await runner(payload, { worktree: worktree() })

      expect(result.kind).toBe('timeout')
      // The download really started, so the assertion below is not vacuous.
      expect(requests()).toBeGreaterThan(0)
      await expectMarkerProcessesGone(marker)
    })
  }, 15_000)

  it('resolves spawn-error, without throwing, when the launcher does not exist', async () => {
    const result = await createLauncherRunner(join(tmpdir(), `no-launcher-${randomUUID()}`))(payload, { worktree: worktree() })

    expect(result).toEqual({ kind: 'spawn-error' })
  })
})

describe('createEngineWarmup', () => {
  const warmupOptions = { timeoutMs: 1000, killGraceMs: 100 }

  it('is ready when the launcher answers engine-probe with the engine handshake', async () => {
    const launcher = launcherFixture('[ "$1" = engine-probe ] && printf "impeccable-engine 1.2.3\\n"')
    expect(await createEngineWarmup(launcher, worktree(), warmupOptions)()).toBe(true)
  })

  it('is not ready for output that is not the engine handshake', async () => {
    const launcher = launcherFixture('printf "something else\\n"')
    expect(await createEngineWarmup(launcher, worktree(), warmupOptions)()).toBe(false)
  })

  it('is not ready when the launcher exits nonzero or does not exist', async () => {
    const failing = launcherFixture('printf "impeccable-engine 1.2.3\\n"; exit 3')
    expect(await createEngineWarmup(failing, worktree(), warmupOptions)()).toBe(false)
    expect(await createEngineWarmup(join(tmpdir(), `no-launcher-${randomUUID()}`), worktree(), warmupOptions)()).toBe(false)
  })

  describe('staging files of a failed warm-up', () => {
    const PART = '.impeccable.part.'

    /** A skill dir whose launcher fails, a cache root, and the staging dir the launcher would use. */
    function failingSkill(): { launcher: string; stagingDir: string; cacheRoot: string } {
      const scriptsDir = join(worktree(), 'staging-skill', 'scripts')
      mkdirSync(scriptsDir, { recursive: true })
      const launcher = join(scriptsDir, 'impeccable')
      writeFileSync(launcher, '#!/bin/sh\nexit 7\n', { encoding: 'utf-8', mode: 0o755 })
      writeFileSync(join(scriptsDir, 'VERSION'), '9.9.9\n', 'utf-8')
      const cacheRoot = join(worktree(), 'staging-cache')
      const stagingDir = join(cacheRoot, 'bin', '9.9.9')
      mkdirSync(stagingDir, { recursive: true })
      return { launcher, stagingDir, cacheRoot }
    }

    function deadPid(): number {
      const pid = spawnSync('true').pid
      expect(pid).toBeGreaterThan(0)
      return pid
    }

    it('removes leftover .impeccable.part files of dead processes and leaves everything else alone', async () => {
      const { launcher, stagingDir, cacheRoot } = failingSkill()
      const dead = deadPid()
      const victim = join(worktree(), 'victim.txt')
      writeFileSync(victim, 'keep me', 'utf-8')

      writeFileSync(join(stagingDir, `${PART}${dead}`), 'partial', 'utf-8')
      writeFileSync(join(stagingDir, `${PART}${dead}.sha256`), 'abc', 'utf-8')
      // Left alone: a staging file of a live process, a symlink with a matching name, a directory, and non-matching names.
      writeFileSync(join(stagingDir, `${PART}${process.pid}`), 'in flight', 'utf-8')
      symlinkSync(victim, join(stagingDir, `${PART}${dead + 1}`))
      mkdirSync(join(stagingDir, `${PART}${dead + 2}`))
      writeFileSync(join(stagingDir, `${PART}notes.txt`), 'x', 'utf-8')
      writeFileSync(join(stagingDir, 'impeccable'), 'engine', 'utf-8')
      writeFileSync(join(stagingDir, `other${PART}${dead}`), 'x', 'utf-8')

      await withEnv({ IMPECCABLE_HOME: cacheRoot }, async () => {
        expect(await createEngineWarmup(launcher, worktree(), warmupOptions)()).toBe(false)
      })

      expect(readdirSync(stagingDir).sort()).toEqual(
        [
          `${PART}${dead + 1}`,
          `${PART}${dead + 2}`,
          `${PART}notes.txt`,
          `${PART}${process.pid}`,
          'impeccable',
          `other${PART}${dead}`,
        ].sort(),
      )
      expect(lstatSync(join(stagingDir, `${PART}${dead + 1}`)).isSymbolicLink()).toBe(true)
      expect(readFileSync(victim, 'utf-8')).toBe('keep me')
    })

    it('uses $HOME/.impeccable when IMPECCABLE_HOME is not set', async () => {
      const { launcher } = failingSkill()
      const home = join(worktree(), 'staging-home')
      const stagingDir = join(home, '.impeccable', 'bin', '9.9.9')
      mkdirSync(stagingDir, { recursive: true })
      writeFileSync(join(stagingDir, `${PART}${deadPid()}`), 'partial', 'utf-8')

      await withEnv({ HOME: home, IMPECCABLE_HOME: undefined }, async () => {
        expect(await createEngineWarmup(launcher, worktree(), warmupOptions)()).toBe(false)
      })

      expect(readdirSync(stagingDir)).toEqual([])
    })

    it('falls back to $HOME/.impeccable when IMPECCABLE_HOME is set but empty, as the launcher does', async () => {
      const { launcher } = failingSkill()
      const home = join(worktree(), 'staging-empty-home')
      const stagingDir = join(home, '.impeccable', 'bin', '9.9.9')
      mkdirSync(stagingDir, { recursive: true })
      writeFileSync(join(stagingDir, `${PART}${deadPid()}`), 'partial', 'utf-8')

      await withEnv({ HOME: home, IMPECCABLE_HOME: '' }, async () => {
        expect(await createEngineWarmup(launcher, worktree(), warmupOptions)()).toBe(false)
      })

      expect(readdirSync(stagingDir)).toEqual([])
    })

    it('never throws when the staging directory or the VERSION file is missing', async () => {
      const { launcher, cacheRoot } = failingSkill()
      rmSync(join(cacheRoot, 'bin'), { recursive: true })
      await withEnv({ IMPECCABLE_HOME: cacheRoot }, async () => {
        expect(await createEngineWarmup(launcher, worktree(), warmupOptions)()).toBe(false)
      })

      rmSync(join(launcher, '..', 'VERSION'))
      await withEnv({ IMPECCABLE_HOME: cacheRoot }, async () => {
        expect(await createEngineWarmup(launcher, worktree(), warmupOptions)()).toBe(false)
      })
    })

    it('does not clean up after a warm-up that succeeds', async () => {
      const { stagingDir, cacheRoot } = failingSkill()
      const launcher = launcherFixture('printf "impeccable-engine 1.2.3\\n"')
      writeFileSync(join(launcher, '..', 'VERSION'), '9.9.9\n', 'utf-8')
      const part = join(stagingDir, `${PART}${deadPid()}`)
      writeFileSync(part, 'partial', 'utf-8')

      await withEnv({ IMPECCABLE_HOME: cacheRoot }, async () => {
        expect(await createEngineWarmup(launcher, worktree(), warmupOptions)()).toBe(true)
      })

      expect(existsSync(part)).toBe(true)
    })
  })

  it('is not ready, and leaves no child behind, when the launcher stalls past the warm-up budget', async () => {
    const pidFile = trackedFile('stalled-child-pid')
    // The launcher's own child stays in its process group, as the real launcher's curl does.
    const launcher = launcherFixture(`sleep 60 &\necho $! > ${JSON.stringify(pidFile)}\nwait`)
    const start = Date.now()
    expect(await createEngineWarmup(launcher, worktree(), warmupOptions)()).toBe(false)

    expect(Date.now() - start).toBeLessThan(5000)
    await expectProcessGone(readPid(pidFile))
  }, 15_000)
})

describe('engine warm-up through createHook, with a stalled first-use download', () => {
  it('skips the scan with engine-pending without spawning the hook, then reports engine-unavailable once the warm-up times out, with no curl left', async () => {
    await withStalledDownload(async ({ launcher, marker, requests, stagingDir }) => {
      let hookSpawns = 0
      const spawnCounting: DetectorRunner = (hookPayload, opts) => {
        hookSpawns += 1
        return createSpawnRunner({ scriptPath: launcher, command: launcher, args: ['hook'] })(hookPayload, opts)
      }
      const hook = createHook({
        runDetector: spawnCounting,
        worktree: worktree(),
        warmEngine: createEngineWarmup(launcher, worktree(), { timeoutMs: 1500, killGraceMs: 200 }),
        engineReadyWaitMs: 300,
      })
      const edit = { tool: 'edit', sessionID: 's', callID: 'c', args: { filePath: '/repo/src/App.tsx' } }

      const first = { title: 't', output: 'ok', metadata: {} }
      const start = Date.now()
      await hook(edit, first)

      expect(Date.now() - start).toBeLessThan(1500)
      expect(first.output).toContain('design engine is still downloading')
      expect(hookSpawns).toBe(0)
      // The download starts in the background; under load the first hook call can return before curl connects.
      await waitUntil(() => requests() > 0)
      expect(requests()).toBeGreaterThan(0)
      // The launcher has begun staging the download.
      expect(readdirSync(stagingDir).some(name => name.startsWith('.impeccable.part.'))).toBe(true)

      // The warm-up keeps running past the hook's wait, and its group is killed at its own timeout.
      await expectMarkerProcessesGone(marker, 5000)

      const second = { title: 't', output: 'ok', metadata: {} }
      await hook(edit, second)
      expect(second.output).toContain('design engine could not be fetched or started')
      expect(hookSpawns).toBe(0)
      // The failed warm-up removed its staging files.
      expect(readdirSync(stagingDir).filter(name => name.startsWith('.impeccable.part.'))).toEqual([])

      const third = { title: 't', output: 'ok', metadata: {} }
      await hook(edit, third)
      expect(third.output).toBe('ok')
    })
  }, 20_000)
})

/**
 * The launcher fetches the engine binary for the host platform into
 * `~/.impeccable/bin/<version>/` the first time it runs, and verifies its sha256.
 * A cold machine would spend that download inside the 5 s hook timeout, so the
 * suites below fetch it first through the bridge's own warm-up, with its long
 * budget. The cache is the real HOME cache, because that is what the launcher
 * uses in production.
 */
async function warmEngineCache(): Promise<void> {
  const ready = await createEngineWarmup(join(REPO_ROOT, HOOK_LAUNCHER_RELATIVE_PATH), worktree())()
  if (!ready) {
    throw new Error(
      'The Impeccable engine could not be fetched or started. The launcher needs network access to download the engine into ~/.impeccable/bin on first use, or IMPECCABLE_BIN pointing at an installed engine.',
    )
  }
}

describe('real vendored hook', () => {
  beforeAll(warmEngineCache, ENGINE_WARMUP_TIMEOUT_MS + 10_000)

  // The vendored detector flags `background-clip: text` together with a gradient
  // on one line as `gradient-text`. A crash inside the hook library that exits 0
  // with no output would look like a clean scan at runtime, so this canary pins
  // that the real script still emits a finding for a known anti-pattern.
  it('emits a PostToolUse envelope containing the gradient-text finding for a known anti-pattern', async () => {
    const projectDir = join(worktree(), 'canary-project')
    mkdirSync(join(projectDir, 'src'), { recursive: true })
    writeFileSync(join(projectDir, 'package.json'), '{}', 'utf-8')
    writeFileSync(join(projectDir, 'src', 'App.tsx'), `${GRADIENT_TEXT_LINE}\n`, 'utf-8')

    const hookPayload = buildHookPayload({
      tool: 'edit',
      args: { filePath: join(projectDir, 'src', 'App.tsx') },
      cwd: projectDir,
      sessionID: `canary-${randomUUID()}`,
    })
    const runner = createLauncherRunner(join(REPO_ROOT, HOOK_LAUNCHER_RELATIVE_PATH))
    const result = await runner(hookPayload, { worktree: projectDir })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
    }
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    expect(parsed.hookSpecificOutput?.additionalContext).toContain('gradient-text')
    expect(parsed.hookSpecificOutput?.additionalContext).toContain('src/App.tsx')
  }, 15_000)

  it('stays silent for a clean file', async () => {
    const projectDir = join(worktree(), 'clean-project')
    mkdirSync(join(projectDir, 'src'), { recursive: true })
    writeFileSync(join(projectDir, 'package.json'), '{}', 'utf-8')
    writeFileSync(join(projectDir, 'src', 'App.tsx'), 'export const App = () => null\n', 'utf-8')

    const hookPayload = buildHookPayload({
      tool: 'edit',
      args: { filePath: join(projectDir, 'src', 'App.tsx') },
      cwd: projectDir,
      sessionID: `clean-${randomUUID()}`,
    })
    const runner = createLauncherRunner(join(REPO_ROOT, HOOK_LAUNCHER_RELATIVE_PATH))
    const result = await runner(hookPayload, { worktree: projectDir })

    expect(result).toEqual({ kind: 'ok', stdout: '', stderr: '' })
  }, 15_000)

  it('scans the Move-to destination of a rename, and names it in the finding, not the pre-move path', async () => {
    const projectDir = join(worktree(), 'rename-project')
    mkdirSync(join(projectDir, 'new'), { recursive: true })
    writeFileSync(join(projectDir, 'package.json'), '{}', 'utf-8')
    // Only the destination exists on disk, so a finding can only come from the Move-to marker.
    writeFileSync(join(projectDir, 'new', 'name.tsx'), `${GRADIENT_TEXT_LINE}\n`, 'utf-8')

    const patchText = ['*** Begin Patch', '*** Update File: old/name.tsx', '*** Move to: new/name.tsx', '*** End Patch'].join('\n')
    const sessionID = `rename-${randomUUID()}`
    const hookPayload = buildHookPayload({ tool: 'apply_patch', args: { patchText }, cwd: projectDir, sessionID })
    const runner = createLauncherRunner(join(REPO_ROOT, HOOK_LAUNCHER_RELATIVE_PATH))
    const result = await runner(hookPayload, { worktree: projectDir })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } }
    const context = parsed.hookSpecificOutput?.additionalContext ?? ''
    expect(context).toContain('gradient-text')
    expect(context).toContain('new/name.tsx')
    expect(context).not.toContain('old/name.tsx')
  }, 15_000)

  it('surfaces the rename-destination finding through createHook for a real apply_patch call', async () => {
    const projectDir = join(worktree(), 'rename-e2e-project')
    mkdirSync(join(projectDir, 'new'), { recursive: true })
    writeFileSync(join(projectDir, 'package.json'), '{}', 'utf-8')
    writeFileSync(join(projectDir, 'new', 'name.tsx'), `${GRADIENT_TEXT_LINE}\n`, 'utf-8')

    const hook = createHook({
      runDetector: createLauncherRunner(join(REPO_ROOT, HOOK_LAUNCHER_RELATIVE_PATH)),
      worktree: projectDir,
    })
    const output = { title: 't', output: 'ok', metadata: {} }
    const patchText = ['*** Begin Patch', '*** Update File: old/name.tsx', '*** Move to: new/name.tsx', '*** End Patch'].join('\n')
    await hook({ tool: 'apply_patch', sessionID: `rename-e2e-${randomUUID()}`, callID: 'c', args: { patchText } }, output)

    expect(output.output).toContain('gradient-text')
    expect(output.output).toContain('new/name.tsx')
  }, 15_000)

  it('scans both the added and the updated file of a patch that adds, updates and deletes files', async () => {
    const projectDir = join(worktree(), 'multi-project')
    mkdirSync(join(projectDir, 'src'), { recursive: true })
    writeFileSync(join(projectDir, 'package.json'), '{}', 'utf-8')
    writeFileSync(join(projectDir, 'src', 'Added.tsx'), `${GRADIENT_TEXT_LINE}\n`, 'utf-8')
    writeFileSync(join(projectDir, 'src', 'Updated.tsx'), `${GRADIENT_TEXT_LINE}\n`, 'utf-8')

    const patchText = [
      '*** Begin Patch',
      '*** Add File: src/Added.tsx',
      '+x',
      '*** Update File: src/Updated.tsx',
      '*** Delete File: src/Gone.tsx',
      '*** End Patch',
    ].join('\n')
    const hookPayload = buildHookPayload({ tool: 'apply_patch', args: { patchText }, cwd: projectDir, sessionID: `multi-${randomUUID()}` })
    const runner = createLauncherRunner(join(REPO_ROOT, HOOK_LAUNCHER_RELATIVE_PATH))
    const result = await runner(hookPayload, { worktree: projectDir })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.stdout).toContain('src/Added.tsx')
    expect(result.stdout).toContain('src/Updated.tsx')
  }, 15_000)
})

describe('plugin module and registration', () => {
  it('plugin.ts exports exactly one runtime export, and it is a function', async () => {
    const mod: Record<string, unknown> = await import('./plugin.ts')
    const exportNames = Object.keys(mod)
    expect(exportNames).toEqual(['ImpeccablePlugin'])
    expect(typeof mod.ImpeccablePlugin).toBe('function')
  })

  it('root opencode.json registers plugin.ts by the exact relative path', () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'opencode.json'), 'utf-8')) as { plugin?: unknown }
    expect(config.plugin).toEqual(['./.opencode/impeccable/plugin.ts'])
  })

  it('returns a callable tool.execute.after that leaves non-mutating tool output untouched', async () => {
    const { ImpeccablePlugin } = await import('./plugin.ts')
    const wt = worktree()
    // Only `worktree` is read by the factory; the rest of PluginInput is irrelevant here.
    const input = { worktree: wt, directory: wt } as unknown as Parameters<typeof ImpeccablePlugin>[0]

    const hooks = await ImpeccablePlugin(input)
    expect(typeof hooks['tool.execute.after']).toBe('function')

    const output = { title: 't', output: 'ok', metadata: {} }
    await hooks['tool.execute.after']?.({ tool: 'read', sessionID: 's', callID: 'c', args: {} }, output)
    expect(output.output).toBe('ok')
  })
})
