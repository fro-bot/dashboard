/**
 * Test suite for scripts/compute-release-tag.ts
 *
 * Tests create isolated temporary git repositories, seed commits/tags there,
 * and run the script with the temp repo as the working directory.
 * The real repository's tag state is never part of the unit test fixture.
 *
 * Covers:
 * - Happy path: fresh month (no tags) → YYYY.MM.0
 * - Happy path: existing patches → max + 1
 * - Edge case: numeric ordering (9, 10 → 11), not lexical
 * - Edge case: transition-month legacy day tags as patch candidates
 * - Edge case: higher same-month tag wins
 * - Edge case: other-month tags are ignored
 * - Error/hygiene: non-numeric/nested suffixes ignored
 * - Error/hygiene: output must match ^[0-9]+\.[0-9]+\.[0-9]+$
 */

import {execFileSync, spawnSync} from 'node:child_process'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import process from 'node:process'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCRIPT = resolve(import.meta.dirname, '../scripts/compute-release-tag.ts')

/**
 * Create a minimal isolated git repository in a temp directory.
 * Returns the path to the temp dir.
 */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'calver-test-'))
  execFileSync('git', ['init', '-b', 'main'], {cwd: dir})
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {cwd: dir})
  execFileSync('git', ['config', 'user.name', 'Test'], {cwd: dir})
  // Need at least one commit to tag
  writeFileSync(join(dir, 'README.md'), 'test\n')
  execFileSync('git', ['add', 'README.md'], {cwd: dir})
  execFileSync('git', ['commit', '-m', 'init'], {cwd: dir})
  return dir
}

/**
 * Add a lightweight tag to the repo.
 */
function addTag(dir: string, tag: string): void {
  execFileSync('git', ['tag', tag], {cwd: dir})
}

/**
 * Run the script in the given directory with an optional CALVER_MONTH override.
 * Returns { stdout, stderr, exitCode }.
 *
 * When calverMonth is omitted, CALVER_MONTH is explicitly removed from the
 * child env so the parent process's CALVER_MONTH cannot leak into the test.
 */
function runScript(
  dir: string,
  calverMonth?: string,
  extraEnv?: Record<string, string | undefined>,
  nodeBin?: string,
): {stdout: string; stderr: string; exitCode: number} {
  // Build env: start from parent, strip CALVER_MONTH, then apply overrides.
  const {CALVER_MONTH, ...parentEnv} = process.env
  const result = spawnSync(nodeBin ?? 'node', [SCRIPT], {
    cwd: dir,
    env: {
      ...parentEnv,
      ...(calverMonth === undefined ? {} : {CALVER_MONTH: calverMonth}),
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    exitCode: result.status ?? 1,
  }
}

// ---------------------------------------------------------------------------
// Fixture management
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = makeTempRepo()
})

afterEach(() => {
  rmSync(tmpDir, {recursive: true, force: true})
})

// ---------------------------------------------------------------------------
// Happy path: fresh month
// ---------------------------------------------------------------------------

describe('compute-release-tag — fresh month (no tags)', () => {
  it('emits YYYY.MM.0 when no tags exist for the current month', () => {
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.07.0')
  })

  it('ignores tags from other months and still emits YYYY.MM.0', () => {
    addTag(tmpDir, '2026.06.15')
    addTag(tmpDir, '2026.05.3')
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.07.0')
  })
})

// ---------------------------------------------------------------------------
// Happy path: existing patches → max + 1
// ---------------------------------------------------------------------------

describe('compute-release-tag — existing patches', () => {
  it('emits max+1 when patches exist: 2026.07.0 and 2026.07.2 → 2026.07.3', () => {
    addTag(tmpDir, '2026.07.0')
    addTag(tmpDir, '2026.07.2')
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.07.3')
  })

  it('emits 2026.07.1 when only 2026.07.0 exists', () => {
    addTag(tmpDir, '2026.07.0')
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.07.1')
  })
})

// ---------------------------------------------------------------------------
// Edge case: numeric ordering (not lexical)
// ---------------------------------------------------------------------------

describe('compute-release-tag — numeric ordering', () => {
  it('handles 2026.07.9 and 2026.07.10 in any listing order → 2026.07.11', () => {
    // Add in reverse order to ensure listing order doesn't matter
    addTag(tmpDir, '2026.07.10')
    addTag(tmpDir, '2026.07.9')
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.07.11')
  })

  it('handles 2026.07.9 and 2026.07.10 in forward order → 2026.07.11', () => {
    addTag(tmpDir, '2026.07.9')
    addTag(tmpDir, '2026.07.10')
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.07.11')
  })
})

// ---------------------------------------------------------------------------
// Edge case: transition-month legacy day tags as patch candidates
// ---------------------------------------------------------------------------

describe('compute-release-tag — transition-month legacy day tags', () => {
  it('treats 2026.06.15, 2026.06.15.1, 2026.06.15.2 as patch candidates → 2026.06.16', () => {
    // Legacy day tags: 2026.06.15 → patch 15; nested 2026.06.15.1 and 2026.06.15.2 are ignored
    // (non-numeric third component after stripping month prefix)
    // So max numeric patch is 15 → next is 16
    addTag(tmpDir, '2026.06.15')
    addTag(tmpDir, '2026.06.15.1')
    addTag(tmpDir, '2026.06.15.2')
    const {stdout, exitCode} = runScript(tmpDir, '2026.06')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.06.16')
  })

  it('higher same-month tag wins: 2026.06.20 → 2026.06.21', () => {
    addTag(tmpDir, '2026.06.15')
    addTag(tmpDir, '2026.06.15.1')
    addTag(tmpDir, '2026.06.15.2')
    addTag(tmpDir, '2026.06.20')
    const {stdout, exitCode} = runScript(tmpDir, '2026.06')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.06.21')
  })
})

// ---------------------------------------------------------------------------
// Edge case: other-month tags are ignored
// ---------------------------------------------------------------------------

describe('compute-release-tag — other-month tags ignored', () => {
  it('does not count tags from other months toward the patch', () => {
    addTag(tmpDir, '2026.05.99')
    addTag(tmpDir, '2026.08.50')
    addTag(tmpDir, '2025.07.5')
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.07.0')
  })
})

// ---------------------------------------------------------------------------
// Error/hygiene: non-numeric/nested suffixes ignored
// ---------------------------------------------------------------------------

describe('compute-release-tag — non-numeric suffixes ignored', () => {
  it('ignores tags with non-numeric third component (e.g. 2026.07.alpha)', () => {
    addTag(tmpDir, '2026.07.alpha')
    addTag(tmpDir, '2026.07.0')
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.07.1')
  })

  it('ignores nested four-part tags (e.g. 2026.07.0.1) — does not produce four-part output', () => {
    addTag(tmpDir, '2026.07.0')
    addTag(tmpDir, '2026.07.0.1')
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.07.1')
    // Must be exactly three numeric components
    expect(stdout).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('ignores tags with trailing non-numeric suffix (e.g. 2026.07.0-rc1)', () => {
    addTag(tmpDir, '2026.07.0-rc1')
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('2026.07.0')
  })
})

// ---------------------------------------------------------------------------
// Default CALVER_MONTH: currentUtcMonth() path
// ---------------------------------------------------------------------------

describe('compute-release-tag — default currentUtcMonth fallback', () => {
  it('uses current UTC month when CALVER_MONTH is not set and emits YYYY.MM.0 in a fresh repo', () => {
    // No CALVER_MONTH override — exercises the currentUtcMonth() code path.
    // Parent env CALVER_MONTH is stripped by runScript when calverMonth is omitted.
    const {stdout, exitCode} = runScript(tmpDir)
    expect(exitCode).toBe(0)
    // Output must be a valid three-part CalVer tag for the current month.
    expect(stdout).toMatch(/^\d{4}\.\d{2}\.\d+$/)
    // In a fresh repo with no tags the patch must be 0.
    expect(stdout).toMatch(/^\d{4}\.\d{2}\.0$/)
  })
})

// ---------------------------------------------------------------------------
// Error paths: git failures
// ---------------------------------------------------------------------------

describe('compute-release-tag — git non-zero exit', () => {
  it('exits nonzero and stderr contains "ERROR: git tag exited with status" when run outside a git repo', () => {
    // A plain temp directory (not a git repo) causes `git tag -l` to exit nonzero.
    const nonGitDir = mkdtempSync(join(tmpdir(), 'calver-nogit-'))
    try {
      const {stderr, exitCode} = runScript(nonGitDir, '2026.07')
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('ERROR: git tag failed with status')
    } finally {
      rmSync(nonGitDir, {recursive: true, force: true})
    }
  })
})

describe('compute-release-tag — git spawn failure (git not on PATH)', () => {
  it('exits nonzero and stderr contains "ERROR: failed to run git tag" when git is not on PATH', () => {
    // Invoke node via its absolute path so node itself is still reachable,
    // but strip PATH so the shell cannot find the `git` binary.
    // Use process.execPath so node is reachable even with an empty PATH.
    // An empty PATH means the script's spawnSync('git', ...) will ENOENT,
    // triggering the "failed to run git tag" error branch.
    const {stderr, exitCode} = runScript(
      tmpDir,
      '2026.07',
      {PATH: ''},
      process.execPath,
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('ERROR: failed to run git tag')
  })
})

// ---------------------------------------------------------------------------
// Output format validation
// ---------------------------------------------------------------------------

describe('compute-release-tag — output format', () => {
  it(String.raw`output always matches ^[0-9]+\.[0-9]+\.[0-9]+$`, () => {
    addTag(tmpDir, '2026.07.5')
    const {stdout, exitCode} = runScript(tmpDir, '2026.07')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('exits nonzero and stderr contains "invalid month" when CALVER_MONTH is invalid', () => {
    // An invalid month like "not-a-month" is caught by the early month-format
    // validation before any git call or tag computation.
    const {stderr, exitCode} = runScript(tmpDir, 'not-a-month')
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('invalid month')
  })
})
