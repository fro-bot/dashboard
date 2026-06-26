---
title: Running the dev server for live verification — background it, drop --watch, kill orphans, or it hangs the agent
date: 2026-06-25
module: dashboard
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - An agent or subagent needs to start the dashboard dev server for real-browser verification
  - Running `pnpm dev` (or `node --watch src/server.ts`) for verification, a smoke test, or debugging
  - The bound port shows EADDRINUSE, or the server "looks alive but never serves"
  - A previous agent run was aborted and the port may still be held
tags: [dev-server, pnpm-dev, node-watch, orphaned-process, eaddrinuse, browser-verification, agent-workflow]
---

# Running the dev server for live verification — background it, drop --watch, kill orphans, or it hangs the agent

## Context

During the PWA browser verification (#107), agents and subagents repeatedly "hung" trying to start the dashboard for live testing. The caller blocked indefinitely; the run looked frozen even when the server was either dead-on-arrival or already running. At one point **six stray `node --watch src/server.ts` processes** were squatting port 3333. The fix is purely operational — no repo change — and the recipe is now the documented way to stand up the server for verification.

## Guidance

The hang is not the server failing to boot — it's two compounding mistakes in *how the caller invokes it*, plus orphans from prior runs:

1. **Foreground long-runner.** `pnpm dev` runs a server that never exits on its own, so any foreground call (`bash` without `&`) blocks until killed.
2. **`--watch` masks crashes.** The `dev` script is `node --env-file-if-exists=.env --watch src/server.ts` (`package.json:9`). On `EADDRINUSE` or any boot throw, Node's `--watch` prints `Failed running 'src/server.ts'. Waiting for file changes before restarting...` and **parks** — indistinguishable from a healthy server to the caller. A crash becomes a hang.
3. **Orphans hold the port.** Each aborted run leaves a `--watch` process on the port; the next start hits `EADDRINUSE` → (2) → another "hang." Six orphans poison six ports.

### The recipe: background it, no `--watch`, fresh port, kill orphans first, verify, clean up

```sh
# 1. Kill orphans first (always)
lsof -ti :<PORT> | xargs -r kill -9
pkill -9 -f 'node --watch src/server.ts'

# 2. Start backgrounded, NO --watch, fresh port, autologin on loopback
DASHBOARD_DEV_AUTOLOGIN=true DASHBOARD_HOST=127.0.0.1 DASHBOARD_PORT=<FRESH_PORT> \
  node --env-file-if-exists=.env src/server.ts > /tmp/dev.log 2>&1 &

# 3. Wait ~7s, then confirm boot from the log + a 200 (do NOT retry blindly — read the log on failure)
sleep 7
grep -F 'Dashboard listening on' /tmp/dev.log
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<FRESH_PORT>/   # expect 200

# 4. Clean up when done (always) — kill the server + close the browser
lsof -ti :<FRESH_PORT> | xargs -r kill -9
```

Grounding in `src/server.ts`: `node src/server.ts` (no `--watch`) makes crashes `process.exit(1)` loudly instead of parking (entry-point catch ~L1048). `DASHBOARD_HOST=127.0.0.1` is required for the autologin guard (loopback + `NODE_ENV != production`, ~L329-352); the default bind is `0.0.0.0` (~L953), which refuses autologin. The boot log line is `Dashboard listening on http://${host}:${port}` (~L1019).

### Preferred for agent verification: the orchestrator owns the server

The single biggest leverage point: **the orchestrator starts the backgrounded server, confirms the boot line + 200, then hands the already-running URL to the verification subagent.** The subagent never manages server lifecycle — no orphans, no `--watch` exposure, no foreground block. Stop letting verification subagents start their own servers.

## Why This Matters

The failure mode is invisible: the process is alive, "Waiting for file changes..." reads as a normal `--watch` status, and there's no way to distinguish "crashed and parking" from "up and serving." It silently burns an agent's whole turn and leaves orphans that poison the next run.

## When to Apply

- Any agent/subagent that must start the dashboard for real-browser verification, a smoke test, or debugging.
- Any time `pnpm dev` is being reached for as a verification tool — its `--watch` is a developer-loop convenience, not a verification tool.
- Any EADDRINUSE / "alive but not serving" symptom, or after an aborted run that may have left the port held.

## Related

- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md` — *why* browser verification is required (this doc is *how* you stand up the server for it). Bidirectional sibling.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — the parent "verify the assembled surface" lesson.
- Verification context: PR #107 (the PWA).
