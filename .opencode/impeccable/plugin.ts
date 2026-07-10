/**
 * OpenCode plugin registration for the Impeccable design hook bridge.
 *
 * The OpenCode plugin loader iterates this module's exports and treats each
 * as a candidate plugin factory, so this file exports ONLY the plugin
 * function — all pure logic (helpers, `createHook`) lives in
 * `./hook-bridge.ts`, which stays Bun-free and Node-testable. This file is
 * Bun-only at runtime (uses the injected `$`) and is never imported by tests.
 */

import type { Plugin, PluginInput } from '@opencode-ai/plugin'

import { createHook, HOOK_SCRIPT_RELATIVE_PATH, IMPECCABLE_HOOK_HARNESS, type DetectorRunner } from './hook-bridge.ts'

/** Default subprocess runner: pipes the payload JSON to `hook.mjs` via the injected Bun `$`, cwd at the worktree. Bun-only — never imported/called under Node tests. */
function createDefaultRunner(input: PluginInput): DetectorRunner {
  return async (payload, opts) => {
    const scriptPath = `${opts.worktree}/${HOOK_SCRIPT_RELATIVE_PATH}`
    const stdinBody = new Response(JSON.stringify(payload))
    const proc = await input.$`node ${scriptPath} < ${stdinBody}`
      .cwd(opts.worktree)
      // Note: do NOT set IMPECCABLE_HOOK_DEPTH — hook.mjs treats any depth value
      // as a re-entrancy signal and no-ops. The bridge runs hook.mjs as a plain
      // subprocess (not a tool call), so it cannot re-trigger tool.execute.after;
      // hook.mjs manages depth for its own child processes itself.
      .env({
        ...process.env,
        IMPECCABLE_HOOK_HARNESS,
        // Suppress hook.mjs's clean/pending acks — findings still emit (they
        // return before the quiet check in hook-lib.mjs).
        IMPECCABLE_HOOK_QUIET: '1',
      })
      .nothrow()
      .quiet()
    return {
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      // A null/undefined exitCode means the subprocess was cancelled or never
      // ran — fall back to -1 (not 0) so createHook's nonzero-exit fail-loud
      // branch fires instead of silently treating it as a clean success.
      exitCode: proc.exitCode ?? -1,
    }
  }
}

export const ImpeccablePlugin: Plugin = async (input) => ({
  'tool.execute.after': createHook({ runDetector: createDefaultRunner(input), worktree: input.worktree }),
})
