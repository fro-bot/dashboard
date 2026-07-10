---
title: "feat: OpenCode Impeccable plugin"
type: feat
status: active
date: 2026-07-10
origin: docs/brainstorms/2026-07-10-opencode-impeccable-plugin-requirements.md
---

# feat: OpenCode Impeccable plugin

## Overview

Add a repo-local OpenCode plugin that runs Impeccable's design detector after file-mutating tool calls and surfaces any findings back to the agent in the same turn. It mirrors the existing Copilot hook (`.github/hooks/impeccable.json`) by bridging OpenCode's `tool.execute.after` event into the same shared `hook.mjs` brain, so it stays advisory and keeps working across `npx impeccable update`.

## Problem Frame

Impeccable ships interactive post-tool-use hooks for four harnesses (Claude Code, Codex, Cursor, GitHub Copilot); OpenCode is not one of them. An operator building UI in OpenCode gets no in-session design signal — findings only appear later at the CI `impeccable detect` gate or in review, after the work is assembled. The other harnesses catch it at the moment of the edit. This plan gives OpenCode the same immediacy without forking Impeccable's detection logic. (See origin: docs/brainstorms/2026-07-10-opencode-impeccable-plugin-requirements.md.)

## Requirements Trace

- R1-R5. Repo-local plugin fires after file-mutating tool calls, surfaces findings the same turn, stays advisory, and stays silent when out of scope.
- R6. Bound each detector run with a timeout (~5s) and degrade to no-op.
- R7-R8. Reuse `hook.mjs` as a thin adapter; make `hook.mjs` recognize the bridged events as a supported harness shape.
- R9. Survive `npx impeccable update` (verify, not assume).
- R10. Respect `.impeccable/config.json` via `hook.mjs`.
- R11. Fail loud, not silent, on bridge/parse failure.
- R12-R14. Register the plugin, prompt restart, verify end-to-end in a live session.

## Scope Boundaries

- Advisory only — no hard gate, no blocking a tool call.
- No change to the CI `impeccable detect` gate.
- No new detector rules or `.impeccable/config.json` edits.

### Deferred to Separate Tasks

- Upstreaming first-class OpenCode support into Impeccable (a `hook-admin` target + generator): separate effort, external repo.

## Context & Research

### Relevant Code and Patterns

- `.github/hooks/impeccable.json` — the Copilot hook this plugin mirrors: `postToolUse`, `matcher: "edit|create|apply_patch"`, runs `node .agents/skills/impeccable/scripts/hook.mjs`, `timeoutSec: 5`.
- `.agents/skills/impeccable/scripts/hook.mjs` — the shared brain. Reads an event JSON on **stdin**, does its own file filtering / `.impeccable/config.json` loading / detection / dedup, writes an ack payload to **stdout**, and **always exits 0** (advisory). Recognizes `claude`/`cursor`/`github` event shapes and an `IMPECCABLE_HOOK_HARNESS` env override; honors `IMPECCABLE_HOOK_DEPTH`.
- `.impeccable/config.json` — detector ignore rules/values; consumed by `hook.mjs`, not by this plugin.
- AFT is loaded as an OpenCode **plugin** (`@cortexkit/aft-opencode`), so this repo's edits surface as tool names to match at runtime — exact name resolved live (see Deferred).

### Institutional Learnings

- `docs/solutions/workflow-issues/impeccable-skill-shared-agents-install-2026-06-25.md` — the agent skill's `hook.mjs` is distinct from the CI detector; install/reuse it in place under `.agents/skills/`, do not reimplement detection.

### External References

- OpenCode plugin API (opencode.ai/docs/plugins, opencode.ai/docs/config): `tool.execute.after(input: {tool, sessionID, callID, args}, output: {title, output, metadata})`; feedback the model sees is appended to `output.output` for native tools; MCP tools may surface a raw `content[]` result instead. A custom-path plugin needs an explicit `plugin` entry in `opencode.json`; `.opencode/plugin/` files are auto-discovered. Shell via the injected `$` (Bun).

## Key Technical Decisions

- Thin adapter over `hook.mjs` (not `impeccable detect` directly, not upstreaming): reuses Impeccable's filtering/config/dedup and rides its update maintenance via the stable stdin/stdout contract.
- Advisory + fail-loud: never block a tool; but if the bridge itself can't run or parse, emit a one-time visible warning so a dead bridge can't masquerade as "clean."
- Match both bare (`edit`/`write`/`apply_patch`) and suffixed (`*_edit`/`*_write`/`*_apply_patch`) tool names, so the hook fires whether edits come from OpenCode built-ins or an AFT-namespaced tool.
- Register via `.opencode/impeccable/plugin.ts` + a new repo `opencode.json` `plugin` entry (per the original brief), keeping the plugin at a self-documenting path.

## Open Questions

### Resolved During Planning

- Run detection via `hook.mjs` or `impeccable detect`? → `hook.mjs` (thin adapter; reuses filtering/config/dedup, survives update).
- Blocking or advisory? → advisory, matching `hook.mjs`'s always-exit-0 contract.

### Deferred to Implementation

- Exact feedback attachment field for this repo's edit tools (`output.output` for native vs `content[]` for MCP-shaped results) — resolve by observing a live session; implement native-path first, add the MCP-content path if the live tool delivers that shape.
- Exact tool name AFT file edits surface as (`edit` vs `aft_edit` vs other) — resolve from a live session / the loaded plugin's tool set; the dual bare+suffixed matcher covers both pending confirmation.
- How to signal the OpenCode harness to `hook.mjs` — `IMPECCABLE_HOOK_HARNESS` override vs emitting a recognized (`github`-shaped) event; pick whichever `hook.mjs` normalizes cleanly when exercised.

## Output Structure

    opencode.json                         # new: repo config with plugin entry
    .opencode/
      impeccable/
        plugin.ts                         # new: the plugin
        plugin.test.ts                    # new: unit tests for pure helpers

## Implementation Units

- [ ] **Unit 1: Registration + pure helpers**

**Goal:** Register a repo-local plugin OpenCode will load, and implement the pure, side-effect-free helpers the runtime hook depends on.

**Requirements:** R12, R2 (partial), R5 (partial)

**Dependencies:** None

**Files:**
- Create: `opencode.json`
- Create: `.opencode/impeccable/plugin.ts` (export skeleton + helpers)
- Create: `.opencode/impeccable/plugin.test.ts`

**Approach:**
- Add `opencode.json` with `$schema` and `plugin: ["./.opencode/impeccable/plugin.ts"]`.
- Export a `Plugin` factory returning a `tool.execute.after` hook (body stubbed in Unit 2).
- Implement pure helpers: `isMutatingTool(name)` (matches bare + suffixed edit/write/apply_patch), `extractTouchedPaths(tool, args)` (handles `filePath` and `apply_patch` marker lines), and `buildHookPayload(input)` (shapes the stdin JSON `hook.mjs` expects).

**Patterns to follow:**
- The Copilot matcher set `edit|create|apply_patch` (`.github/hooks/impeccable.json`), widened for OpenCode's `write` and MCP suffixes.

**Test scenarios:**
- Happy path: `isMutatingTool` returns true for `edit`, `write`, `apply_patch`, `aft_edit`, `x_write`; false for `read`, `bash`, `grep`.
- Edge case: `extractTouchedPaths` pulls `filePath` from edit/write args; parses Add/Update/Delete/Move marker lines from an `apply_patch` `patchText`; returns `[]` for missing/empty args.
- Happy path: `buildHookPayload` produces the exact field names `hook.mjs` reads (tool name, file path) for a representative edit event.

**Verification:**
- `opencode.json` validates against the schema; helper unit tests pass.

---

- [ ] **Unit 2: hook.mjs bridge runtime**

**Goal:** Implement the `tool.execute.after` body — invoke `hook.mjs` on the touched file with a timeout, identify the OpenCode harness, and capture its stdout.

**Requirements:** R1, R3 (produce), R4, R6, R7, R8, R10

**Dependencies:** Unit 1

**Files:**
- Modify: `.opencode/impeccable/plugin.ts`
- Modify: `.opencode/impeccable/plugin.test.ts`

**Approach:**
- On a mutating tool, shape the payload (Unit 1) and pipe it to `node .agents/skills/impeccable/scripts/hook.mjs` via the injected `$`, `cwd` at the worktree, `.nothrow().quiet()`.
- Wrap the invocation in a ~5s timeout; on timeout, abandon and continue (no-op, logged).
- Set the harness signal (`IMPECCABLE_HOOK_HARNESS`) and a defensive `IMPECCABLE_HOOK_DEPTH` guard so nested runs can't recurse.
- Return early (no work) for non-mutating tools.

**Execution note:** Resolve the harness-signal and exact-tool-name questions against a live session here (see Deferred to Implementation) before finalizing the matcher and env.

**Patterns to follow:**
- `hook.mjs`'s stdin-JSON contract and `IMPECCABLE_HOOK_HARNESS` override.
- The Copilot hook's `timeoutSec: 5`.

**Test scenarios:**
- Happy path: a mutating tool event triggers one `hook.mjs` invocation with the file path in the piped payload (subprocess stubbed/faked).
- Edge case: a non-mutating tool triggers no invocation.
- Error path: a `hook.mjs` invocation exceeding the timeout is abandoned and the hook returns without throwing.

**Verification:**
- With the subprocess faked, mutating events invoke the bridge once with the correct payload; non-mutating events don't; timeout degrades to no-op.

---

- [ ] **Unit 3: Surface feedback + fail-loud guard**

**Goal:** Attach `hook.mjs` findings to what the agent sees, and emit a one-time visible warning when the bridge can't run or parse — never fail silently.

**Requirements:** R3 (surface), R5, R9 (partial), R11

**Dependencies:** Unit 2

**Files:**
- Modify: `.opencode/impeccable/plugin.ts`
- Modify: `.opencode/impeccable/plugin.test.ts`

**Approach:**
- When `hook.mjs` returns findings, append them to the native tool result (`output.output`); if the live tool delivers an MCP `content[]` shape instead, push a text item there (resolve which path applies live, see Deferred).
- When there is no finding (clean / out-of-scope), leave the result untouched.
- Fail-loud: if payload normalization throws, the subprocess errors, or stdout can't be parsed, surface a one-time non-blocking warning (session-scoped guard so it fires once, not per edit) and continue.

**Test scenarios:**
- Happy path: given a findings payload, the tool output gains the feedback text; the model-visible field is the one mutated.
- Edge case: given a clean/empty payload, the tool output is byte-unchanged.
- Error path: given an unparseable `hook.mjs` output, a warning is emitted once and the edit is not blocked; a second failure in the same session does not re-warn.

**Verification:**
- Feedback appears only on findings; clean edits are untouched; a simulated bridge failure warns once and never throws.

---

- [ ] **Unit 4: Live verification + update-survival check**

**Goal:** Prove the assembled plugin works in a real OpenCode session and survives `npx impeccable update`.

**Requirements:** R13, R14, R9

**Dependencies:** Units 1-3

**Files:**
- None (verification unit; no new code unless live findings require a fix)

**Approach:**
- Prompt the operator to restart OpenCode to load the repo-local plugin.
- In a live session: make an edit that introduces a detectable design issue and confirm the finding surfaces to the agent that turn; make a clean edit and confirm nothing surfaces and nothing is blocked.
- Run `npx impeccable update` and confirm `opencode.json` and `.opencode/impeccable/plugin.ts` are unchanged and still functional.
- If the live session reveals the wrong tool name, attachment field, or harness signal, fold the fix back into Units 2/3.

**Test expectation:** none — live-session verification; the code-level behavior is covered by Units 1-3 unit tests.

**Verification:**
- Detectable edit → finding surfaces; clean edit → silent, unblocked; post-`update` the plugin file and registration are intact.

## System-Wide Impact

- **Interaction graph:** the plugin observes every `tool.execute.after`; only mutating tools do work, everything else returns immediately.
- **Error propagation:** bridge/detector failures never propagate to the tool — they degrade to a one-time warning (R11) or silent no-op on timeout (R6).
- **Re-entrancy:** detection runs as a subprocess, outside the tool system, so it cannot re-trigger `tool.execute.after`; a depth-guard env is set defensively.
- **Unchanged invariants:** the CI `impeccable detect` gate, `.impeccable/config.json`, and the four Impeccable-managed harness hooks are untouched; this only adds an OpenCode-local surface.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Wrong edit-tool name → hook never fires (silent) | Dual bare+suffixed matcher; live-session verification (Unit 4); fail-loud guard surfaces a dead bridge. |
| Feedback attached to a field the model doesn't see | Resolve the native-vs-`content[]` attachment path live before finalizing (Unit 3 / Deferred). |
| Slow detector stalls edits | ~5s timeout with no-op fallback (R6), matching the Copilot hook. |
| Future `impeccable update` changes `hook.mjs`'s contract or starts targeting `.opencode/` | Depend only on the documented stdin/stdout contract; Unit 4 re-checks survival; contract break would surface as a fail-loud warning, not a silent break. |

## Sources & References

- **Origin document:** docs/brainstorms/2026-07-10-opencode-impeccable-plugin-requirements.md
- Related code: `.github/hooks/impeccable.json`, `.agents/skills/impeccable/scripts/hook.mjs`, `.impeccable/config.json`
- External docs: opencode.ai/docs/plugins, opencode.ai/docs/config
