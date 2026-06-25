/**
 * Test suite for scripts/should-release.ts
 *
 * The guard script decides whether a push event should trigger a release.
 * It is invoked as:
 *
 *   node scripts/should-release.ts \
 *     --changed-files <newline-separated list> \
 *     --base-pkg <path-to-base-package.json> \
 *     --head-pkg <path-to-head-package.json>
 *
 * Exit codes:
 *   0 = should release
 *   1 = skip release
 *   2 = usage/parse error
 *
 * The test harness writes temporary package.json fixtures to disk and passes
 * their paths to the script. No git operations are performed.
 *
 * Covered scenarios:
 * - src/** changes => release
 * - bare `src` path changed => release
 * - web/** changes => release (SPA source built into image)
 * - bare `web` path changed => release
 * - Dockerfile change => release
 * - release workflow change => release
 * - tsconfig change => release
 * - custom tsconfig.ci.json change => release
 * - nested path with tsconfig basename => no release (root-level only)
 * - scripts/should-release.ts change => release
 * - scripts/compute-release-tag.ts change => release
 * - package.json `dependencies` change => release
 * - package.json `engines` change => release
 * - package.json `packageManager` change => release
 * - package.json `overrides` change => release
 * - package.json `pnpm.overrides` change => release
 * - package.json `scripts` change => release
 * - package.json `type` change => release
 * - package.json `exports` change => release
 * - package.json `exports` reordered nested keys => no release
 * - package.json `imports` change => release
 * - package.json `imports` reordered nested keys => no release
 * - reordered dependency keys with same values => no release
 * - hard-release path + package.json no-op => release (hard-release wins)
 * - package.json `devDependencies`-only change => no release
 * - pnpm-lock.yaml-only change (no package.json diff) => release (fail open: may affect runtime graph)
 * - pnpm-lock.yaml + devDependencies-only package.json change => no release
 * - pnpm-lock.yaml + dependencies change => release
 * - no changed files => no release
 * - first-push (empty base {}) with runtime fields in head => release
 * - missing --changed-files flag => error (exit 2)
 * - missing --base-pkg flag => error (exit 2)
 * - missing --head-pkg flag => error (exit 2)
 * - unreadable pkg file => error (exit 2)
 * - invalid JSON in pkg file => error (exit 2)
 */

import {spawnSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import process from 'node:process'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCRIPT = resolve(import.meta.dirname, '../scripts/should-release.ts')

interface PkgShape {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
  packageManager?: string
  overrides?: Record<string, string>
  pnpm?: {overrides?: Record<string, string>}
  scripts?: Record<string, string>
  type?: string
  exports?: Record<string, unknown> | string
  imports?: Record<string, unknown>
}

function writePkg(dir: string, name: string, pkg: PkgShape): string {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(pkg, null, 2))
  return p
}

/**
 * Run the guard script.
 *
 * @param changedFiles  Newline-separated list of changed file paths (or undefined to omit the flag).
 * @param basePkgPath   Path to the base package.json (or undefined to omit the flag).
 * @param headPkgPath   Path to the head package.json (or undefined to omit the flag).
 * @param extraArgs     Additional raw CLI args appended after the standard flags.
 */
function runGuard(
  changedFiles: string | undefined,
  basePkgPath: string | undefined,
  headPkgPath: string | undefined,
  extraArgs: string[] = [],
): {stdout: string; stderr: string; exitCode: number} {
  const args: string[] = [SCRIPT]
  if (changedFiles !== undefined) {
    args.push('--changed-files', changedFiles)
  }
  if (basePkgPath !== undefined) {
    args.push('--base-pkg', basePkgPath)
  }
  if (headPkgPath !== undefined) {
    args.push('--head-pkg', headPkgPath)
  }
  args.push(...extraArgs)

  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 15_000,
  })
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    exitCode: result.status ?? 2,
  }
}

// ---------------------------------------------------------------------------
// Fixture management
// ---------------------------------------------------------------------------

let tmpDir: string

const BASE_PKG: PkgShape = {
  dependencies: {hono: '^4.7.11', yaml: '2.9.0'},
  devDependencies: {vitest: '4.1.4', typescript: '6.0.3'},
  engines: {node: '>=24'},
  packageManager: 'pnpm@11.5.0',
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'should-release-test-'))
})

afterEach(() => {
  rmSync(tmpDir, {recursive: true, force: true})
})

// ---------------------------------------------------------------------------
// Release triggers: non-package.json file changes
// ---------------------------------------------------------------------------

describe('should-release — src/** changes trigger release', () => {
  it('releases when a src/ file changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('src/server.ts', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when multiple src/ files change', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('src/server.ts\nsrc/routes/index.ts', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when bare src path is listed as changed', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('src', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — web/** changes trigger release', () => {
  it('releases when a web/ source file changes (SPA built into image)', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('web/src/App.tsx', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when bare web path is listed as changed', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('web', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — public/** changes trigger release', () => {
  it('releases when a public/ asset changes (baked into the image)', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('public/operator-stream.js', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when bare public path is listed as changed', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('public', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — workflow path filter parity', () => {
  // GitHub Actions filters on.push.paths BEFORE the guard script runs, so any
  // directory that the guard treats as a hard-release path must also appear in
  // the release workflow's paths filter — otherwise the workflow never starts and
  // the guard never executes. This pins the two in sync to prevent drift.
  it('release.yaml on.push.paths includes every directory-glob hard-release path', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/release.yaml'),
      'utf8',
    )
    for (const dir of ['src/**', 'web/**', 'public/**']) {
      expect(workflow).toContain(`'${dir}'`)
    }
  })
})

describe('should-release — Dockerfile change triggers release', () => {
  it('releases when Dockerfile changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('Dockerfile', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — release workflow change triggers release', () => {
  it('releases when .github/workflows/release.yaml changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('.github/workflows/release.yaml', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — tsconfig change triggers release', () => {
  it('releases when tsconfig.json changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('tsconfig.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when tsconfig.build.json changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('tsconfig.build.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when custom tsconfig.ci.json changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('tsconfig.ci.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('does NOT release when a nested path has a tsconfig-like basename (root-level only)', () => {
    // e.g. packages/foo/tsconfig.json should NOT trigger release — only root-level tsconfig*.json
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('packages/foo/tsconfig.json', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })
})

describe('should-release — guard script itself triggers release', () => {
  it('releases when scripts/should-release.ts changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('scripts/should-release.ts', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when scripts/compute-release-tag.ts changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('scripts/compute-release-tag.ts', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

// ---------------------------------------------------------------------------
// Hard-release path wins even when package.json has no runtime changes
// ---------------------------------------------------------------------------

describe('should-release — hard-release path wins over package.json no-op', () => {
  it('releases and reason indicates hard-release path when src changes + package.json unchanged', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    // head has identical runtime fields — only devDependencies changed
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      devDependencies: {...BASE_PKG.devDependencies, vitest: '4.1.8'},
    })
    const {exitCode, stdout} = runGuard('src/server.ts\npackage.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
    expect(stdout).toContain('hard-release path changed')
  })
})

// ---------------------------------------------------------------------------
// Release triggers: package.json runtime field changes
// ---------------------------------------------------------------------------

describe('should-release — dependencies change triggers release', () => {
  it('releases when a runtime dependency version changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      dependencies: {...BASE_PKG.dependencies, hono: '^4.8.0'},
    })
    const {exitCode, stdout} = runGuard('package.json\npnpm-lock.yaml', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when a new runtime dependency is added', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      dependencies: {...BASE_PKG.dependencies, 'new-lib': '1.0.0'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when a runtime dependency is removed', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const depsWithoutYaml = {...(BASE_PKG.dependencies as Record<string, string>)}
    delete depsWithoutYaml.yaml
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      dependencies: depsWithoutYaml,
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('does NOT release when dependency keys are reordered but values are identical', () => {
    const base = writePkg(tmpDir, 'base.json', {
      ...BASE_PKG,
      dependencies: {hono: '^4.7.11', yaml: '2.9.0'},
    })
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      dependencies: {yaml: '2.9.0', hono: '^4.7.11'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })
})

describe('should-release — engines change triggers release', () => {
  it('releases when engines.node changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      engines: {node: '>=26'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — packageManager change triggers release', () => {
  it('releases when packageManager changes', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      packageManager: 'pnpm@12.0.0',
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — overrides change triggers release', () => {
  it('releases when top-level overrides are added', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      overrides: {'some-dep': '1.2.3'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when top-level overrides change value', () => {
    const base = writePkg(tmpDir, 'base.json', {...BASE_PKG, overrides: {'some-dep': '1.0.0'}})
    const head = writePkg(tmpDir, 'head.json', {...BASE_PKG, overrides: {'some-dep': '2.0.0'}})
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — pnpm.overrides change triggers release', () => {
  it('releases when pnpm.overrides are added', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      pnpm: {overrides: {'some-dep': '1.2.3'}},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when pnpm.overrides change value', () => {
    const base = writePkg(tmpDir, 'base.json', {
      ...BASE_PKG,
      pnpm: {overrides: {'some-dep': '1.0.0'}},
    })
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      pnpm: {overrides: {'some-dep': '2.0.0'}},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — scripts change triggers release', () => {
  it('releases when a script entry is added', () => {
    const base = writePkg(tmpDir, 'base.json', {...BASE_PKG, scripts: {start: 'node src/index.ts'}})
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      scripts: {start: 'node src/index.ts', prestart: 'echo hi'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when a script entry value changes', () => {
    const base = writePkg(tmpDir, 'base.json', {...BASE_PKG, scripts: {start: 'node src/index.ts'}})
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      scripts: {start: 'node --experimental-strip-types src/index.ts'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — type change triggers release', () => {
  it('releases when type field is added', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {...BASE_PKG, type: 'module'})
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when type field changes', () => {
    const base = writePkg(tmpDir, 'base.json', {...BASE_PKG, type: 'commonjs'})
    const head = writePkg(tmpDir, 'head.json', {...BASE_PKG, type: 'module'})
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — exports change triggers release', () => {
  it('releases when exports field is added (string form)', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {...BASE_PKG, exports: './src/index.ts'})
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when exports map changes', () => {
    const base = writePkg(tmpDir, 'base.json', {
      ...BASE_PKG,
      exports: {'.': './src/index.ts'},
    })
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      exports: {'.': './src/index.ts', './utils': './src/utils.ts'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('does NOT release when exports map has reordered top-level keys with identical values', () => {
    const base = writePkg(tmpDir, 'base.json', {
      ...BASE_PKG,
      exports: {'.': './src/index.ts', './utils': './src/utils.ts'},
    })
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      exports: {'./utils': './src/utils.ts', '.': './src/index.ts'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })

  it('does NOT release when exports map has reordered nested condition keys with identical values', () => {
    // Nested condition objects like { import: '...', require: '...' } may be written
    // in different orders across commits — semantically identical, should not release.
    const base = writePkg(tmpDir, 'base.json', {
      ...BASE_PKG,
      exports: {
        '.': {import: './src/index.mjs', require: './src/index.cjs'},
      },
    })
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      exports: {
        '.': {require: './src/index.cjs', import: './src/index.mjs'},
      },
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })
})

describe('should-release — imports change triggers release', () => {
  it('releases when imports field is added', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      imports: {'#utils': './src/utils.ts'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('releases when imports field changes', () => {
    const base = writePkg(tmpDir, 'base.json', {
      ...BASE_PKG,
      imports: {'#utils': './src/utils.ts'},
    })
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      imports: {'#utils': './src/utils-v2.ts'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('does NOT release when imports map has reordered nested condition keys with identical values', () => {
    const base = writePkg(tmpDir, 'base.json', {
      ...BASE_PKG,
      imports: {'#utils': {import: './src/utils.mjs', require: './src/utils.cjs'}},
    })
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      imports: {'#utils': {require: './src/utils.cjs', import: './src/utils.mjs'}},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })
})

// ---------------------------------------------------------------------------
// No-release: devDependencies-only changes
// ---------------------------------------------------------------------------

describe('should-release — devDependencies-only change skips release', () => {
  it('skips when only devDependencies changed (vitest bump)', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      devDependencies: {...BASE_PKG.devDependencies, vitest: '4.1.8'},
    })
    const {exitCode, stdout} = runGuard('package.json\npnpm-lock.yaml', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })

  it('skips when a new devDependency is added', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      devDependencies: {...BASE_PKG.devDependencies, 'new-dev-tool': '1.0.0'},
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })

  it('skips when a devDependency is removed', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const devWithoutTs = {...(BASE_PKG.devDependencies as Record<string, string>)}
    delete devWithoutTs.typescript
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      devDependencies: devWithoutTs,
    })
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })
})

// ---------------------------------------------------------------------------
// Release: pnpm-lock.yaml-only changes (fail open — may affect runtime graph)
// ---------------------------------------------------------------------------

describe('should-release — pnpm-lock.yaml-only change triggers release (fail open)', () => {
  it('releases when only pnpm-lock.yaml changed and package.json is identical', () => {
    // A lockfile-only update can change the exact package versions installed into
    // the Docker image even when package.json semver ranges are unchanged. We
    // cannot cheaply prove the change is dev-only, so we fail open and release.
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('pnpm-lock.yaml', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

describe('should-release — pnpm-lock.yaml + devDependencies-only change skips release', () => {
  it('skips when lock + devDependencies changed but no runtime fields changed', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      devDependencies: {...BASE_PKG.devDependencies, vitest: '4.1.8'},
    })
    const {exitCode, stdout} = runGuard('package.json\npnpm-lock.yaml', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })
})

describe('should-release — pnpm-lock.yaml + dependencies change triggers release', () => {
  it('releases when lock changed alongside a runtime dependency bump', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', {
      ...BASE_PKG,
      dependencies: {...BASE_PKG.dependencies, hono: '^4.8.0'},
    })
    const {exitCode, stdout} = runGuard('package.json\npnpm-lock.yaml', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })
})

// ---------------------------------------------------------------------------
// No-release: no changed files
// ---------------------------------------------------------------------------

describe('should-release — no changed files skips release', () => {
  it('skips when changed-files list is empty', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })
})

// ---------------------------------------------------------------------------
// First-push coverage: empty base ({}) with runtime fields in head
// ---------------------------------------------------------------------------
//
// On the very first push to a branch, the workflow uses `{}` as the base
// package.json (no parent commit). This test documents that an empty base
// paired with a head that has runtime fields correctly triggers a release
// when package.json is in the changed set.

describe('should-release — first-push empty base ({}) triggers release when runtime fields present', () => {
  it('releases when base is {} and head has dependencies + package.json changed', () => {
    // Simulate the workflow's first-push path: base is an empty object.
    const base = writePkg(tmpDir, 'base.json', {})
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^release:/)
  })

  it('skips when base is {} and head is also {} with package.json changed', () => {
    // Both sides empty — no runtime fields differ, so no release.
    const base = writePkg(tmpDir, 'base.json', {})
    const head = writePkg(tmpDir, 'head.json', {})
    const {exitCode, stdout} = runGuard('package.json', base, head)
    expect(exitCode).toBe(1)
    expect(stdout).toMatch(/^skip:/)
  })
})

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('should-release — missing required flags produce exit 2', () => {
  it('exits 2 when --changed-files is omitted', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stderr} = runGuard(undefined, base, head)
    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/--changed-files/i)
  })

  it('exits 2 when --base-pkg is omitted', () => {
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stderr} = runGuard('src/server.ts', undefined, head)
    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/--base-pkg/i)
  })

  it('exits 2 when --head-pkg is omitted', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const {exitCode, stderr} = runGuard('src/server.ts', base, undefined)
    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/--head-pkg/i)
  })
})

describe('should-release — unreadable or invalid pkg files produce exit 2', () => {
  it('exits 2 when base-pkg path does not exist', () => {
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stderr} = runGuard('src/server.ts', '/nonexistent/base.json', head)
    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/base-pkg/i)
  })

  it('exits 2 when head-pkg path does not exist', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const {exitCode, stderr} = runGuard('src/server.ts', base, '/nonexistent/head.json')
    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/head-pkg/i)
  })

  it('exits 2 when base-pkg contains invalid JSON', () => {
    const badBase = join(tmpDir, 'bad-base.json')
    writeFileSync(badBase, 'not json {{{')
    const head = writePkg(tmpDir, 'head.json', BASE_PKG)
    const {exitCode, stderr} = runGuard('src/server.ts', badBase, head)
    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/base-pkg/i)
  })

  it('exits 2 when head-pkg contains invalid JSON', () => {
    const base = writePkg(tmpDir, 'base.json', BASE_PKG)
    const badHead = join(tmpDir, 'bad-head.json')
    writeFileSync(badHead, 'not json {{{')
    const {exitCode, stderr} = runGuard('src/server.ts', base, badHead)
    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/head-pkg/i)
  })
})
