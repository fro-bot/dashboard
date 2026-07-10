---
date: 2026-07-10
topic: opencode-impeccable-plugin
---

# OpenCode Impeccable Plugin

## Summary

Add a repo-local OpenCode plugin that runs Impeccable's design detector after file-mutating tool calls and feeds any findings back to the agent mid-session. It mirrors the existing Copilot hook by wrapping the same shared `hook.mjs` brain, staying advisory and continuing to work across `npx impeccable update`.

---

## Problem Frame

Impeccable is set up in this repo as a CI gate (`npx impeccable detect`) and an installed skill, but the *interactive* design-feedback loop only exists for harnesses Impeccable natively supports — Claude Code, Codex, Cursor, and GitHub Copilot each get a post-tool-use hook that lints edits as they happen. OpenCode is not one of Impeccable's four supported harnesses, so an operator building UI in OpenCode gets no in-session signal; design-slop findings only surface later at the CI gate or in review, after the work is already assembled. The other harnesses catch it at the moment of the edit. OpenCode should get the same immediacy.

---

## Actors

- A1. OpenCode agent: performs file-mutating tool calls during a session; the recipient of detector feedback.
- A2. The plugin: a repo-local OpenCode plugin that observes tool calls and bridges them to Impeccable.
- A3. `hook.mjs`: Impeccable's shared, harness-agnostic detection brain (file filtering, config, detection, dedup).

---

## Key Flows

- F1. Edit-time detection
  - **Trigger:** the agent completes a file-mutating tool call.
  - **Actors:** A1, A2, A3.
  - **Steps:** plugin sees the tool result → if the tool is a file-mutator, translates the event into the stdin shape `hook.mjs` expects → invokes `hook.mjs` → `hook.mjs` filters/detects/dedups → plugin takes any returned findings and attaches them to the tool result the agent sees.
  - **Outcome:** the agent sees design findings for the file it just changed, in the same turn; clean or out-of-scope edits produce nothing.
  - **Covered by:** R1, R2, R3, R5, R7.

---

## Requirements

**Plugin behavior & trigger**
- R1. Provide a repo-local OpenCode plugin that runs after file-mutating tool calls in an OpenCode session.
- R2. Trigger detection on the file-mutating tools actually used in this repo: OpenCode built-ins (`edit`, `write`, `apply_patch`) and the AFT MCP equivalents (e.g. `aft_edit`/`aft_write` and `_edit`/`_write`/`apply_patch`-suffixed MCP names). Non-mutating tools must not trigger detection.
- R3. When the detector returns findings for a changed file, surface them into the agent's context so the model sees them in the same turn.
- R4. Stay advisory: never block, deny, or fail a tool call, matching the always-exit-0 contract of the other harnesses.
- R5. When the change is out of the detector's scope (unsupported extension, ignored path, or clean result), add nothing to the agent's context.
- R6. Bound each detector invocation with a timeout (~5s, matching the Copilot hook's `timeoutSec: 5`); on timeout, degrade to a no-op with a logged warning so edits stay responsive.

**Impeccable integration & resilience**
- R7. Reuse the shared `.agents/skills/impeccable/scripts/hook.mjs` brain rather than reimplementing file-filtering, config loading, detection, or dedup. The plugin is a thin translation layer from OpenCode's tool event to `hook.mjs`'s stdin contract.
- R8. Ensure `hook.mjs` recognizes the bridged OpenCode events as a supported harness shape, so its file extraction and config normalization apply correctly.
- R9. Keep working across `npx impeccable update`: the plugin lives outside Impeccable's four managed harness targets, so current update behavior is not expected to modify it — an expectation to verify (AE4), not a guarantee. The plugin depends only on `hook.mjs`'s stdin/stdout contract, which update maintains.
- R10. Respect the existing `.impeccable/config.json` (ignore rules/values). Reusing `hook.mjs` provides this; the plugin must not bypass it.
- R11. Fail loud, not silent: if the plugin cannot normalize an OpenCode tool event or cannot invoke/parse `hook.mjs` output, emit a one-time non-blocking warning into the session rather than silently doing nothing — so a broken bridge can't masquerade as "no findings."

**Setup & verification**
- R12. Register the plugin so OpenCode loads it from a repo-local location. The exact mechanism (an `opencode.json` `plugin` entry vs. an auto-discovered plugin directory) is settled in planning.
- R13. Prompt the operator to restart OpenCode to load the new repo-local plugin, then verify.
- R14. Verify end-to-end in a real OpenCode session: an edit introducing a detectable design issue surfaces Impeccable feedback to the agent; a clean edit does not.

---

## Acceptance Examples

- AE1. **Covers R2, R3.** Given the plugin is loaded, when the agent edits a file introducing a detectable design issue, then Impeccable findings appear in the agent's tool-result context that same turn.
- AE2. **Covers R4, R5.** Given the agent edits a file with no findings, when the tool completes, then the tool result is unchanged and the edit is never blocked.
- AE3. **Covers R2.** Given the agent uses an AFT MCP edit tool rather than the built-in `edit`, when it mutates a file, then detection still runs.
- AE4. **Covers R9.** Given `npx impeccable update` runs and regenerates the four managed harness hooks, when it finishes, then the OpenCode plugin file and its registration remain intact and functional.
- AE5. **Covers R11.** Given the plugin cannot parse a tool event or `hook.mjs` output, when the tool completes, then a one-time non-blocking warning surfaces and the edit is not blocked.
- AE6. **Covers R6.** Given the detector exceeds the timeout, when the tool completes, then the plugin degrades to a no-op with a logged warning and the edit is not stalled.

---

## Success Criteria

- Operators using OpenCode get the same in-session design feedback that Copilot/Claude/Cursor/Codex users already get.
- A downstream implementer can confirm the plugin fires on the repo's real edit tools, surfaces findings to the agent, and stays advisory.
- The integration continues to work after `npx impeccable update` (verified, not assumed).

---

## Scope Boundaries

- Upstreaming first-class OpenCode support into Impeccable (a `hook-admin` target + generator) is deferred; this is a repo-local plugin only.
- No hard gate or blocking behavior — advisory only.
- No change to the CI `impeccable detect` gate; this complements the interactive dev loop, it does not replace CI enforcement.
- No new detector rules or `.impeccable/config.json` changes.

---

## Key Decisions

- Thin adapter over `hook.mjs`, not `impeccable detect` directly and not upstreaming: reuses Impeccable's filtering/config/dedup and survives `impeccable update` via the stable `hook.mjs` contract.
- Match both built-in and AFT-MCP mutation tool names: this repo's edits go through AFT MCP tools, so matching only built-ins would make the hook never fire — the load-bearing correctness point for this repo.
- Advisory, never blocking: matches `hook.mjs`'s always-exit-0 semantics and the other harnesses.

---

## Dependencies / Assumptions

- Depends on `.agents/skills/impeccable/scripts/hook.mjs` and its stdin-JSON → stdout-ack contract.
- Depends on OpenCode's `tool.execute.after` plugin hook and the `plugin` config key (repo currently has no `opencode.json`; it will be created).
- Assumes `node` and `npx impeccable` are available in the session environment (already true — CI and the Copilot hook rely on them).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] For AFT MCP tools, `tool.execute.after` may deliver a raw MCP result (`content[]`) rather than `output.output`. Planning must verify which shape AFT tools deliver and where to attach feedback so the model actually sees it.
- [Affects R8][Technical] Confirm how `hook.mjs` should be told the harness is OpenCode — an `IMPECCABLE_HOOK_HARNESS` override versus emitting one of its recognized event shapes (claude/cursor/github). Pick the mapping `hook.mjs` normalizes cleanly.
- [Affects R2][Needs research] Confirm the exact tool name AFT file edits surface as to the hook (`aft_edit` vs other) by observing a live session or the MCP catalog.
- [Affects R12][Technical] Choose the plugin registration mechanism: an explicit `plugin` entry in a new `opencode.json` (required for a custom path like `.opencode/impeccable/plugin.ts`) vs. an auto-discovered `.opencode/plugin/` file.

---

## Sources / Research

- Copilot hook `/.github/hooks/impeccable.json`: a `postToolUse` command matching `edit|create|apply_patch` that runs `node .agents/skills/impeccable/scripts/hook.mjs` — the pattern this plugin mirrors.
- `hook.mjs` contract: reads event JSON on **stdin**, writes an ack/reminder payload to **stdout**, always exits 0 (advisory). Does its own file filtering, `.impeccable/config.json` loading, detection, and dedup. Recognizes `claude`/`cursor`/`github` event shapes and an `IMPECCABLE_HOOK_HARNESS` override.
- Impeccable manages hooks for four harnesses only (Claude/Codex/Cursor/Copilot); no OpenCode target exists, so `impeccable update` will not clobber a repo-local `.opencode/` plugin.
- OpenCode plugin API: `tool.execute.after` hook `(input: {tool, sessionID, callID, args}, output: {title, output, metadata})`; feedback reaches the model by appending to `output.output` for native tools; MCP tools surface as `sanitize(server)_sanitize(tool)` (e.g. `aft_edit`) and may need `content[]` mutation instead. A custom-path plugin (`.opencode/impeccable/plugin.ts`) needs an explicit `plugin` entry in `opencode.json`; files in `.opencode/plugin/` are auto-discovered. Docs: opencode.ai/docs/plugins, opencode.ai/docs/config.
