#!/usr/bin/env node
// scripts/should-release.ts
//
// Guard script: decides whether a push event should trigger a release.
//
// Usage:
//   node scripts/should-release.ts \
//     --changed-files <newline-separated list of changed file paths> \
//     --base-pkg <path to base package.json> \
//     --head-pkg <path to head package.json>
//
// Exit codes:
//   0 = should release  (prints "release: <reason>" to stdout)
//   1 = skip release    (prints "skip: <reason>" to stdout)
//   2 = usage/parse error (prints error to stderr)
//
// Decision logic:
//   1. If any changed file matches a "hard release" pattern (src/**, Dockerfile,
//      .github/workflows/release.yaml, scripts/should-release.ts, tsconfig*.json) => release.
//   2. If package.json is in the changed set, diff the runtime fields
//      (dependencies, engines, packageManager, overrides, pnpm.overrides,
//       scripts, type, exports, imports) between base and head.
//      If any runtime field changed => release.
//      If only devDependencies changed => skip.
//   3. If only pnpm-lock.yaml changed (no package.json diff) => release.
//      Rationale: a lockfile-only update can change the exact package versions
//      installed into the Docker image even when package.json semver ranges are
//      unchanged. We cannot cheaply prove the change is dev-only without parsing
//      the full lockfile diff, so we fail open and release.
//   4. No matched files => skip.
//
// Node 24 strip-only TypeScript constraints:
//   - no enums, namespaces, parameter properties, TS import aliases, decorators, `any`
//   - stdlib only

import {readFileSync} from 'node:fs'
import process from 'node:process'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PnpmConfig {
  overrides?: Record<string, string>
}

interface PkgJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
  packageManager?: string
  overrides?: Record<string, string>
  pnpm?: PnpmConfig
  scripts?: Record<string, string>
  type?: string
  exports?: Record<string, unknown> | string
  imports?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  changedFiles: string[]
  basePkgPath: string
  headPkgPath: string
} | {error: string} {
  const args = argv.slice(2) // strip node + script path

  let changedFilesRaw: string | undefined
  let basePkgPath: string | undefined
  let headPkgPath: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--changed-files') {
      changedFilesRaw = args[++i]
    } else if (arg === '--base-pkg') {
      basePkgPath = args[++i]
    } else if (arg === '--head-pkg') {
      headPkgPath = args[++i]
    }
  }

  if (changedFilesRaw === undefined) {
    return {error: 'Missing required flag: --changed-files'}
  }
  if (basePkgPath === undefined) {
    return {error: 'Missing required flag: --base-pkg'}
  }
  if (headPkgPath === undefined) {
    return {error: 'Missing required flag: --head-pkg'}
  }

  const changedFiles = changedFilesRaw
    .split('\n')
    .map(f => f.trim())
    .filter(f => f.length > 0)

  return {changedFiles, basePkgPath, headPkgPath}
}

// ---------------------------------------------------------------------------
// Package.json loading
// ---------------------------------------------------------------------------

type LoadResult = {ok: true; pkg: PkgJson} | {ok: false; error: string}

function loadPkg(path: string, label: string): LoadResult {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {ok: false, error: `Failed to read ${label} at '${path}': ${msg}`}
  }

  try {
    return {ok: true, pkg: JSON.parse(raw) as PkgJson}
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {ok: false, error: `Failed to parse JSON in ${label} at '${path}': ${msg}`}
  }
}

// ---------------------------------------------------------------------------
// File pattern matching
// ---------------------------------------------------------------------------

/**
 * Returns true if the file path matches a "hard release" pattern:
 *   - src/**
 *   - Dockerfile
 *   - .github/workflows/release.yaml
 *   - scripts/should-release.ts
 *   - scripts/compute-release-tag.ts
 *   - tsconfig*.json (root-level only, not nested paths)
 */
function isHardReleasePath(filePath: string): boolean {
  if (filePath.startsWith('src/') || filePath === 'src') return true
  if (filePath === 'Dockerfile') return true
  if (filePath === '.github/workflows/release.yaml') return true
  if (filePath === 'scripts/should-release.ts') return true
  if (filePath === 'scripts/compute-release-tag.ts') return true
  // tsconfig*.json: root-level only (no path separator in the name)
  if (
    !filePath.includes('/') &&
    filePath.startsWith('tsconfig') &&
    filePath.endsWith('.json')
  )
    return true
  return false
}

// ---------------------------------------------------------------------------
// Runtime field diffing
// ---------------------------------------------------------------------------

/**
 * Compares two plain string-valued records in an order-insensitive way.
 * Returns true if they differ (different keys or different values for any key).
 */
function recordsDiffer(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const aObj = a ?? {}
  const bObj = b ?? {}
  const aKeys = Object.keys(aObj).sort()
  const bKeys = Object.keys(bObj).sort()
  if (aKeys.length !== bKeys.length) return true
  for (const key of aKeys) {
    if (aObj[key] !== bObj[key]) return true
  }
  return false
}

/**
 * Produces a canonical JSON string for an arbitrary value by recursively
 * sorting object keys before serialising. This makes the comparison
 * insensitive to key-insertion order at every nesting level, which matters
 * for package.json `exports`/`imports` maps whose nested condition objects
 * may be written in different orders across commits.
 *
 * Arrays are preserved as-is (order is semantically significant in exports
 * conditions arrays).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value)
  }
  const obj = value as Record<string, unknown>
  const sortedKeys = Object.keys(obj).sort()
  const parts = sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
  return `{${parts.join(',')}}`
}

/**
 * Compares two unknown-valued records in a deterministic, key-order-insensitive
 * way by canonicalising each value recursively before comparing.
 * Returns true if they differ.
 */
function unknownRecordsDiffer(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  const aObj = a ?? {}
  const bObj = b ?? {}
  const aKeys = Object.keys(aObj).sort()
  const bKeys = Object.keys(bObj).sort()
  if (aKeys.length !== bKeys.length) return true
  for (const key of aKeys) {
    if (canonicalJson(aObj[key]) !== canonicalJson(bObj[key])) return true
  }
  return false
}

/**
 * Returns true if any runtime-affecting field changed between base and head.
 * Runtime fields: dependencies, engines, packageManager, overrides,
 *   pnpm.overrides, scripts, type, exports, imports.
 */
function runtimeFieldsChanged(base: PkgJson, head: PkgJson): boolean {
  // String-keyed record fields (order-insensitive key/value comparison)
  if (recordsDiffer(base.dependencies, head.dependencies)) return true
  if (recordsDiffer(base.engines, head.engines)) return true
  if (recordsDiffer(base.overrides, head.overrides)) return true
  if (recordsDiffer(base.pnpm?.overrides, head.pnpm?.overrides)) return true
  if (recordsDiffer(base.scripts, head.scripts)) return true

  // Scalar field
  if (base.packageManager !== head.packageManager) return true
  if (base.type !== head.type) return true

  // exports: may be a string or a record
  const exportsA = base.exports
  const exportsB = head.exports
  if (typeof exportsA !== typeof exportsB) return true
  if (typeof exportsA === 'string' && exportsA !== exportsB) return true
  else if (
    typeof exportsA !== 'string' &&
    typeof exportsB !== 'string' &&
    unknownRecordsDiffer(exportsA, exportsB)
  )
    return true

  // imports: always a record
  if (unknownRecordsDiffer(base.imports, head.imports)) return true

  return false
}

// ---------------------------------------------------------------------------
// Main decision logic
// ---------------------------------------------------------------------------

function decide(
  changedFiles: string[],
  base: PkgJson,
  head: PkgJson,
): {shouldRelease: boolean; reason: string} {
  // 1. Hard release triggers (non-package.json files)
  for (const f of changedFiles) {
    if (isHardReleasePath(f)) {
      return {shouldRelease: true, reason: `hard-release path changed: ${f}`}
    }
  }

  const hasPkgChange = changedFiles.includes('package.json')
  const hasLockChange = changedFiles.includes('pnpm-lock.yaml')

  // 2. package.json in changed set — inspect runtime fields
  if (hasPkgChange) {
    if (runtimeFieldsChanged(base, head)) {
      return {
        shouldRelease: true,
        reason: 'package.json runtime fields changed (dependencies/engines/packageManager/overrides/scripts/type/exports/imports)',
      }
    }
    // Only devDependencies (or other non-runtime fields) changed
    return {
      shouldRelease: false,
      reason: 'package.json changed but only devDependencies (or non-runtime fields) differ',
    }
  }

  // 3. pnpm-lock.yaml only (no package.json diff) — release (fail open)
  // A lockfile-only update can change the exact package versions installed into
  // the Docker image even when package.json semver ranges are unchanged. We
  // cannot cheaply prove the change is dev-only without parsing the full lockfile
  // diff, so we fail open and release.
  if (hasLockChange) {
    return {
      shouldRelease: true,
      reason:
        'pnpm-lock.yaml changed without a package.json runtime diff — releasing ' +
        '(lockfile-only may affect installed runtime dependency graph)',
    }
  }

  // 4. No matched files
  return {shouldRelease: false, reason: 'no release-triggering files changed'}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
//
// IMPORTANT: exit code semantics
//   0 = should release
//   1 = intentional skip (the workflow treats 1 as "skip")
//   2 = error (usage/parse/IO)
//
// Node.js also exits with code 1 on uncaught exceptions, which the workflow
// would silently misinterpret as an intentional skip. We therefore wrap all
// main logic in a try/catch and re-exit with code 2 on unexpected errors so
// the workflow's `if [ "$EXIT" -eq 1 ]` branch is never taken for crashes.

try {
  const parsed = parseArgs(process.argv)

  if ('error' in parsed) {
    process.stderr.write(`ERROR: ${parsed.error}\n`)
    process.exit(2)
  }

  const {changedFiles, basePkgPath, headPkgPath} = parsed

  const baseResult = loadPkg(basePkgPath, 'base-pkg')
  if (!baseResult.ok) {
    process.stderr.write(`ERROR: ${baseResult.error}\n`)
    process.exit(2)
  }

  const headResult = loadPkg(headPkgPath, 'head-pkg')
  if (!headResult.ok) {
    process.stderr.write(`ERROR: ${headResult.error}\n`)
    process.exit(2)
  }

  const {shouldRelease, reason} = decide(changedFiles, baseResult.pkg, headResult.pkg)

  if (shouldRelease) {
    process.stdout.write(`release: ${reason}\n`)
    process.exit(0)
  } else {
    process.stdout.write(`skip: ${reason}\n`)
    process.exit(1)
  }
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error)
  process.stderr.write(`ERROR: unexpected exception: ${msg}\n`)
  process.exit(2)
}
