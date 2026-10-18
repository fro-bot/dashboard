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

A repo-local OpenCode plugin (`.opencode/impeccable/plugin.ts`) bridges OpenCode's `tool.execute.after` hook to Impeccable's design hook so file-mutating edits get in-session design feedback. The bridge runs the skill's `.agents/skills/impeccable/scripts/impeccable hook` launcher directly, with no Node and no shell. The launcher is a POSIX shell script that execs the native engine binary for the host platform. That binary is gitignored: the launcher fetches it into `~/.impeccable/bin/<version>/` on first use and verifies its sha256. Building it surfaced **four** distinct silent-failure bugs — and every one passed the full unit suite, `tsc`, and `eslint` clean. Each was caught only by live-session verification, and each cost its own OpenCode restart cycle.

Three surfaces of the plugin's real contract sit outside the unit-test boundary:

- **The host loader's export semantics** — how OpenCode decides a module is a valid plugin.
- **The subprocess boundary** — the `env` / stdin / stdout contract with the hook, and the engine binary being present on the machine.
- **Host startup behavior** — plugins load once, so code changes need a restart to take effect.

Unit tests with an injected fake runner prove the bridge *state machine* (tool matching, path extraction, fail-loud) — and nothing else. Timeouts, kill behavior, and pipe handling live in the real runner, so they need a test against a real subprocess.

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
export const ImpeccablePlugin: Plugin = async (input) => {
  const launcher = `${input.worktree}/${HOOK_LAUNCHER_RELATIVE_PATH}`
  return {
    'tool.execute.after': createHook({
      runDetector: createLauncherRunner(launcher),
      warmEngine: createEngineWarmup(launcher, input.worktree),
      worktree: input.worktree,
    }),
  }
}
```

**4. Cross-check side-effect evidence, not just the visible tool result.** A hook can fire and still no-op silently. Prove the subprocess actually ran by checking a side effect it owns — e.g. its dedup cache mtime:

```bash
stat -f '%Sm %N' .impeccable/hook.cache.json   # unchanged mtime ⇒ the hook bailed without scanning
```

**5. Probe at the subprocess boundary directly** to isolate plugin-vs-detector bugs without a restart per hypothesis. Run the exact invocation the plugin would, with the same env, standalone:

```bash
printf '{"tool_name":"write","tool_input":{"file_path":"/abs/probe.css"},"cwd":"'"$PWD"'","session_id":"probe"}' \
  | IMPECCABLE_HOOK_HARNESS=claude .agents/skills/impeccable/scripts/impeccable hook
```

This is how the `IMPECCABLE_HOOK_DEPTH` bug was found in one shell command instead of one restart: the standalone run scanned correctly, so the difference had to be an env var the plugin added.

**6. Do not add "defensive" env vars you have not verified against the subprocess's own logic.** The hook treats *any* `IMPECCABLE_HOOK_DEPTH` value as a re-entrancy signal and returns empty (exit 0). Setting it "just in case" made the detector silently bail on every call. The bridge runs the launcher as a plain subprocess, which cannot re-enter the tool hook, so there is nothing to guard against. The runner never forwards `IMPECCABLE_HOOK_DEPTH` or `CLAUDE_HOOK_DEPTH` and never sets one. It builds the child's environment from one allow-list (`CHILD_ENV_ALLOWLIST`): `PATH`, `HOME`, `TMPDIR`, `USER`, `LOGNAME`, `LANG`, `LC_*` and `IMPECCABLE_*`, the proxy and CA variables by exact name (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, their lowercase forms, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`), plus the harness and quiet signals. Tokens and other host secrets never reach the engine, and the real-hook suite runs on that reduced environment. The proxy and CA names are forwarded so the launcher's first-use download works behind a proxy or a TLS-intercepting CA. The trade-off is accepted: a proxy URL with embedded credentials reaches the binary.

**7. Design a fail-loud path that can actually fire.** The hook is contractually always-exit-0, which defeats exit-code-only fail-loud logic. A broken bridge must be detectable by *other* signals. Warn once per kind on timeout, spawn failure, nonzero exit, output overflow, unrecognized stdout, stderr output on an otherwise clean exit, and a fault inside the bridge itself. Only exit 0 with empty stdout and empty stderr counts as a clean scan and stays silent.

**8. Match the subprocess's output contract to what the agent should see.** The hook writes a JSON envelope (`{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`) and emits a "scanned, no issues" ack on clean files. Parse only that envelope: accept it only when `hookEventName` is `PostToolUse` and `additionalContext` is a non-empty string, and surface just that inner text. Raw stdout and stderr never reach the agent. Silence clean acks (`IMPECCABLE_HOOK_QUIET=1`) so a clean edit adds nothing. Appended feedback is capped at 64 KiB (UTF-16 code units, cut without splitting a surrogate pair) and ends with a `[impeccable] feedback truncated` marker line inside the wrapper when it is cut.

**9. Warm the engine once, outside the hook timeout.** The engine binary is not in git. On first use the launcher downloads it for the host platform into `~/.impeccable/bin/<version>/` and checks its sha256. That takes several seconds on a fast link, and the launcher's `curl` has no time limit of its own, so a download inside the hook's 5 s timeout is killed and the cache is never written. The bridge therefore warms the engine separately (`createEngineWarmup`): the first hook call that needs a scan runs `scripts/impeccable engine-probe` once through the same spawn runner, with a 120 s budget and the same process-group kill. Ready means a clean exit whose stdout starts with `impeccable-engine`. Every call waits for that shared warm-up for at most the normal hook budget:

- Still pending: the call skips the scan, warns `engine-pending`, and spawns no hook. The warm-up keeps running; the hook timeout does not kill it. After one call has seen it pending, later calls skip at once with no wait until it settles, so a long download does not add the hook budget to every edit.
- Failed: the call warns `engine-unavailable` and skips the scan. A later call retries no sooner than 60 s after the failure. A failed or timed-out warm-up also removes the `.impeccable.part.<pid>` staging files its killed download left in `~/.impeccable/bin/<version>/` (regular files only, never a symlink, never a file of a process that is still running).
- Warm cache: the probe answers in under 100 ms and nothing is skipped.

The integration suite warms the cache with the same function in a `beforeAll`, against the real HOME cache, so no timeout-bound test pays for a download. CI restores `~/.impeccable/bin` with `actions/cache`, keyed on the runner and the hash of the skill's `scripts/VERSION`, so a runner downloads the engine once per skill version. The restored engine runs without being verified again; that is acceptable for a read-only test job. If it fails, the suite fails with a fixed message that names the cause. A machine with a cold cache and no network cannot run the real hook; set `IMPECCABLE_BIN` to an installed engine there. Two risks remain: the engine is downloaded at runtime and checked only against a sha256 sidecar from the same host, and a warm-up that is still running when OpenCode exits can outlive it.

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
IMPECCABLE_HOOK_DEPTH: '1'               // trips the hook's re-entrancy guard → silent no-op
// surfacing:
output.output += proc.stdout.toString()  // leaks the raw JSON envelope
```

**After** — single-function export, no depth var, quiet + extracted:

```ts
// plugin.ts: exactly one runtime export
export const ImpeccablePlugin: Plugin = async (input) => {
  const launcher = `${input.worktree}/${HOOK_LAUNCHER_RELATIVE_PATH}`
  return {
    'tool.execute.after': createHook({
      runDetector: createLauncherRunner(launcher),
      warmEngine: createEngineWarmup(launcher, input.worktree),
      worktree: input.worktree,
    }),
  }
}

// runner env (node:child_process spawn of the launcher, no shell):
// allow-listed names only, never a depth var, plus the harness signal and quiet clean-acks
const env = buildChildEnv(process.env)

// surfacing: the PostToolUse envelope's additionalContext only; anything else warns once
const feedback = extractFeedbackText(result.stdout)
```

The runner owns the timeout: SIGTERM at 5 s, SIGKILL after a 2 s grace, and a final deadline 0.5 s later that resolves even if the pipes stay open. On POSIX the child is spawned with `detached: true` so it leads its own process group, and each signal, including the final-deadline SIGKILL, goes to the group (`process.kill(-pid, …)`, falling back to the direct child). Grandchildren such as the launcher's `curl` die with it. A grandchild that calls `setsid` or detaches escapes the group; the integration suite pins that limit. On Windows only the direct child is signalled. `createHook` adds no timer of its own.

## Related

- [Unit-green is not feature-done — verify the assembled surface](./unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md) — the umbrella lesson; this is its OpenCode-plugin-loader instance.
- [PWA service worker registration is invisible to unit tests](./pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md) — the same "tests lied, live run proved it" pattern at the service-worker boundary.
- [Dev server hang — background, no --watch, kill orphans](./dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md) — live-verification ops discipline (restart, real run, clean up).
- [Local fixture harness must mirror the wire contract](../best-practices/local-fixture-harness-must-mirror-wire-contract-2026-07-03.md) — boundary-realism sibling.
- Shipped in PR #191 (repo-local Impeccable design-hook plugin).
