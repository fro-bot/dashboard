/**
 * OpenCode plugin registration for the Impeccable design hook bridge.
 *
 * The OpenCode plugin loader iterates this module's exports and treats each
 * as a candidate plugin factory, so this file exports ONLY the plugin
 * function — all logic, including the subprocess runner, lives in
 * `./hook-bridge.ts`, which is Node-testable without a running OpenCode host.
 */

import type { Plugin } from '@opencode-ai/plugin'

import { createHook, createLauncherRunner, HOOK_LAUNCHER_RELATIVE_PATH } from './hook-bridge.ts'

export const ImpeccablePlugin: Plugin = async (input) => ({
  'tool.execute.after': createHook({
    runDetector: createLauncherRunner(`${input.worktree}/${HOOK_LAUNCHER_RELATIVE_PATH}`),
    worktree: input.worktree,
  }),
})
