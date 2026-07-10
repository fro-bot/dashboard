---
title: OpenCode plugin hooks need live verification — loader and subprocess contracts are invisible to unit tests
date: 2026-07-10
category: workflow-issues
module: impeccable-opencode-plugin
problem_type: workflow_issue
component: tooling
severity: high
tags:
  - opencode
  - plugin
  - impeccable
  - live-verification
  - subprocess
  - runtime-contract
applies_when:
  - Building or changing an OpenCode plugin (or any agent-harness plugin loaded once at host startup)
  - The plugin shells out to a subprocess or depends on the host loader's export semantics
  - Unit tests, typecheck, and lint all pass but the plugin still does nothing in a real session
---

# OpenCode plugin hooks need live verification — loader and subprocess contracts are invisible to unit tests

## Context

A repo-local OpenCode plugin (`.opencode/impeccable/plugin.ts`) bridges OpenCode's `tool.execute.after` hook to Impeccable's shared design detector (`.agents/skills/impeccable/scripts/hook.mjs`) so file-mutating edits get in-session design feedback. Building it surfaced **four** distinct silent-failure bugs — and every one passed the full unit suite, `tsc`, and `eslint` clean. Each was caught only by live-session verification, and each cost its own OpenCode restart cycle.

Three surfaces of the plugin's real contract sit outside the unit-test boundary:

- **The host loader's export semantics** — how OpenCode decides a module is a valid plugin.
- **The subprocess boundary** — the `env` / stdin / stdout contract with `hook.mjs`.
- **Host startup behavior** — plugins load once, so code changes need a restart to take effect.

Unit tests with an injected fake runner prove the bridge *state machine* (tool matching, path extraction, timeout, fail-loud) — and nothing else.

## Guidance

Treat live-session verification as mandatory for plugin work, and make it efficient with these rules:

**1. Restart OpenCode after any plugin code change.** Plugins load once at host startup; in-session edits do not hot-reload. Every fix needs a restart before it can be tested.

**2. Confirm the plugin actually loaded** — read the host log, not a test:

```bash
grep -n "failed to load plugin" ~/.local/share/opencode/log/opencode.log
```

A non-function export is the classic trap: OpenCode iterates a plugin module's exports and treats each as a candidate factory, so a single helper `const`/function exported alongside the plugin makes it reject the **whole** module with `"Plugin export is not a function"`.

**3. Keep the plugin module's export surface to exactly one function.** Move helpers, constants, and types into a sibling module the plugin imports:

```ts
// plugin.ts — the ONLY runtime export is the factory
export const ImpeccablePlugin: Plugin = async (input) => ({
  'tool.execute.after': createHook({ runDetector: createDefaultRunner(input), worktree: input.worktree }),
})
```

**4. Cross-check side-effect evidence, not just the visible tool result.** A hook can fire and still no-op silently. Prove the subprocess actually ran by checking a side effect it owns — e.g. its dedup cache mtime:

```bash
stat -f '%Sm %N' .impeccable/hook.cache.json   # unchanged mtime ⇒ hook.mjs bailed without scanning
```

**5. Probe at the subprocess boundary directly** to isolate plugin-vs-detector bugs without a restart per hypothesis. Run the exact invocation the plugin would, with the same env, standalone:

```bash
printf '{"tool_name":"write","tool_input":{"file_path":"/abs/probe.css"},"cwd":"'"$PWD"'","session_id":"probe"}' \
  | IMPECCABLE_HOOK_HARNESS=claude node .agents/skills/impeccable/scripts/hook.mjs
```

This is how the `IMPECCABLE_HOOK_DEPTH` bug was found in one shell command instead of one restart: the standalone run scanned correctly, so the difference had to be an env var the plugin added.

**6. Do not add "defensive" env vars you have not verified against the subprocess's own logic.** `hook.mjs` treats *any* `IMPECCABLE_HOOK_DEPTH` value as a re-entrancy signal and returns empty (exit 0). Setting it "just in case" made the detector silently bail on every call. The bridge runs `hook.mjs` as a plain subprocess, which cannot re-enter the tool hook — there was nothing to guard against.

**7. Design a fail-loud path that can actually fire.** `hook.mjs` is contractually always-exit-0, which defeats exit-code-only fail-loud logic. A broken bridge must be detectable by *other* signals — surface a warning on nonzero exit *and* treat empty/unparseable output as suspect, rather than assuming "no output = clean."

**8. Match the subprocess's output contract to what the agent should see.** `hook.mjs` writes a JSON envelope (`{"hookSpecificOutput":{"additionalContext":"…"}}`) and emits a "scanned, no issues" ack on clean files. Extract the inner text (don't leak the wire JSON) and silence clean acks (`IMPECCABLE_HOOK_QUIET=1`) so a clean edit adds nothing.

## Why This Matters

1. **Non-function export** → loader rejected the whole module (`"Plugin export is not a function"`).
2. **`IMPECCABLE_HOOK_DEPTH=1`** → re-entrancy guard made the detector no-op (exit 0, no scan, no warning).
3. **Clean-ack noise** → clean edits surfaced a "no issues" message, violating "clean → add nothing."
4. **Raw JSON envelope** → the agent saw `{"hookSpecificOutput":…}` instead of the human-readable finding.

Each surface is *individually* invisible to tests, so one "run it for real" pass is not enough — verify loading, the real interaction, and the side effects, and probe the boundary directly when the visible result is ambiguous.

## When to Apply

- Any OpenCode plugin — or any agent-harness plugin loaded once at host startup — that shells out to a subprocess, depends on env/stdin/stdout shape, or relies on host-loader semantics.
- Any time unit tests + typecheck + lint are green but the plugin "does nothing" in a real session: assume a loader or subprocess-contract failure and verify live before touching the state-machine logic.

## Examples

**Before** — multi-export module, defensive depth var, raw stdout surfaced:

```ts
export const isMutatingTool = ...        // extra export → loader rejects the module
export const ImpeccablePlugin = ...
// runner env:
IMPECCABLE_HOOK_DEPTH: '1'               // trips hook.mjs re-entrancy guard → silent no-op
// surfacing:
output.output += proc.stdout.toString()  // leaks the raw JSON envelope
```

**After** — single-function export, no depth var, quiet + extracted:

```ts
// plugin.ts: exactly one runtime export
export const ImpeccablePlugin: Plugin = async (input) => ({
  'tool.execute.after': createHook({ runDetector: createDefaultRunner(input), worktree: input.worktree }),
})

// runner env: harness signal + quiet clean-acks; deliberately NO depth var
.env({ ...process.env, IMPECCABLE_HOOK_HARNESS, IMPECCABLE_HOOK_QUIET: '1' })

// surfacing: inner human text only
const feedback = extractFeedbackText(result.stdout ?? '')
```

## Related

- [Unit-green is not feature-done — verify the assembled surface](./unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md) — the umbrella lesson; this is its OpenCode-plugin-loader instance.
- [PWA service worker registration is invisible to unit tests](./pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md) — the same "tests lied, live run proved it" pattern at the service-worker boundary.
- [Dev server hang — background, no --watch, kill orphans](./dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md) — live-verification ops discipline (restart, real run, clean up).
- [Local fixture harness must mirror the wire contract](../best-practices/local-fixture-harness-must-mirror-wire-contract-2026-07-03.md) — boundary-realism sibling.
- Shipped in PR #191 (repo-local Impeccable design-hook plugin).
